#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-control-merge-streams.js
 * ------------------------------
 * Multi-stream merge module.
 *
 * Primary input:  stdin      (via safeRead)
 * Side channels:  N paths    (via safeRead on fs streams)
 *
 * Function:
 *   • For each main-stream record:
 *       – Time-align side-channel records
 *       – Merge side-channel fields with postfixes
 *   • Supports interpolation (bounded mode)
 *   • Supports hold-last-value semantics (unbounded mode)
 *
 * NOTE on unbounded mode:
 *   • Config `allowUnboundedDelay[i] = true` means:
 *       – Ignore matchToleranceMs
 *       – Do NOT interpolate
 *       – Always use the latest NDJSON sample seen on that side-channel
 *       – Even if timestamps go backwards, or FIFO closes/reopens
 *
 * This module implements absolute robustness for real-world FIFO churn.
 */

import fs from "fs";
import {
  safeRead,
  safeWrite,
  appendTag,
  loadConfigFile,
  logWarn,
  logError,
  logInfo,
  loadCLI,
  registerParam,
  registerPositionals
} from "./lib/pipeline-utils.js";

const MODULE_TAG = "mrg";

/* ------------------------------------------------------------------------- *
 * GLOBAL CONFIG REGISTRATION
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * GLOBAL CONFIG REGISTRATION
 * ------------------------------------------------------------------------- */

/**
 * Boolean flag:
 *   --suppress-fifo-warning
 *   TMCP_SUPPRESS_FIFO_WARNING
 */
registerParam({
  longname: "suppress-fifo-warning",
  envname: "TMCP_SUPPRESS_FIFO_WARNING",
  default: false,
  generateNegative: true,
  description:
    "If true, suppress warnings when side-channel paths are regular files instead of FIFOs."
});

/**
 * Positional arguments:
 *   0: <config_file>
 *   1..N: <side paths>
 */
registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to merge configuration JSON file"
  },
  {
    name: "side_path",
    required: true,
    varargs: true,
    description: "One or more FIFO / file side-channel paths"
  }
]);


/* ------------------------------------------------------------------------- *
 * EXTRACT CONFIG (flags + positionals)
 * ------------------------------------------------------------------------- */
let cli = loadCLI();

const SUPPRESS_FIFO_WARNING = cli.get("param.suppress-fifo-warning");
const sidePaths = cli.get("positionals.side_path");

/* ------------------------------------------------------------------------- *
 * CONFIG LOADING
 * ------------------------------------------------------------------------- */

const config = loadConfigFile("positionals.config_file",{ defaultScope:"merge" });
const mergeCfg = config.merge || {};

const MATCH_TOLERANCE_MS = mergeCfg.matchToleranceMs ?? 100;
const MAX_BUFFER_MS      = mergeCfg.maxBufferMs      ?? 2000;

const postfixes = Array.isArray(mergeCfg.postfixes)
  ? mergeCfg.postfixes
  : sidePaths.map((_, i) => `_${i + 1}`);

const rawUnbounded = Array.isArray(mergeCfg.allowUnboundedDelay)
  ? mergeCfg.allowUnboundedDelay
  : [];

const allowUnbounded = sidePaths.map((_, i) => !!rawUnbounded[i]);

const SIDE_RECONNECT_DELAY_MS = mergeCfg.sideReconnectDelayMs ?? 200;

/* ------------------------------------------------------------------------- *
 * SIDE-CHANNEL VALIDATION
 * ------------------------------------------------------------------------- */

sidePaths.forEach((path) => {
  try {
    const st = fs.statSync(path);
    if (st.isFIFO()) return;
    if (!SUPPRESS_FIFO_WARNING && st.isFile()) {
      logWarn(
        `Side-channel "${path}" is a regular file, not a FIFO. ` +
          `For correct timing: writer → FIFO → this module.`
      );
    }
  } catch (err) {
    logWarn(`Could not stat side-channel "${path}": ${err.message}`);
  }
});

/* ------------------------------------------------------------------------- *
 * BUFFERS
 * ------------------------------------------------------------------------- */

const mainBuffer = [];                        // full history (bounded behavior)
const sideBuffers = sidePaths.map(() => []);  // history per channel
const sideLastUnbounded = sidePaths.map(() => null); // last-record-only mode

/* ------------------------------------------------------------------------- *
 * UTILS
 * ------------------------------------------------------------------------- */

function pushMain(obj) {
  mainBuffer.push(obj);
  const cutoff = Date.now() - MAX_BUFFER_MS;
  while (
    mainBuffer.length &&
    (mainBuffer[0].meta?.timestamp ?? 0) < cutoff
  ) {
    mainBuffer.shift();
  }
}

function pushSide(idx, obj) {
  const ts = obj.meta?.timestamp;
  const isNumberTs = typeof ts === "number";

  if (allowUnbounded[idx]) {
    // --- FIX 2: ALWAYS update last value if ts is valid numeric ---
    if (isNumberTs) {
      sideLastUnbounded[idx] = obj;
    } else {
      logWarn(
        `tmcp-control-merge-streams: unbounded channel[${idx}] record missing timestamp; ignoring`
      );
    }
    // keep history only for diagnostics
    sideBuffers[idx].push(obj);
    return;
  }

  // bounded mode: maintain a timestamp-ordered window
  if (isNumberTs) {
    sideBuffers[idx].push(obj);
    const cutoff = Date.now() - MAX_BUFFER_MS;
    while (
      sideBuffers[idx].length &&
      (sideBuffers[idx][0].meta?.timestamp ?? 0) < cutoff
    ) {
      sideBuffers[idx].shift();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * BOUNDED INTERPOLATION
 * ------------------------------------------------------------------------- */

function findClosest(buf, ts) {
  if (buf.length === 0) return null;

  let best = buf[0];
  let bestDiff = Math.abs(ts - (best.meta?.timestamp ?? 0));

  for (const rec of buf) {
    const diff = Math.abs(ts - (rec.meta?.timestamp ?? 0));
    if (diff < bestDiff) {
      best = rec;
      bestDiff = diff;
    }
  }

  if (bestDiff > MATCH_TOLERANCE_MS) {
    logWarn(
      `Side-stream message far from target: Δ=${bestDiff}ms (tolerance ${MATCH_TOLERANCE_MS}ms), ` +
        `ts=${ts}, msg.ts=${best.meta?.timestamp}`
    );
    return null;
  }

  return best;
}

function interpolateBounded(buf, ts) {
  const nearest = findClosest(buf, ts);
  if (nearest) return nearest;

  const before = buf
    .filter((o) => (o.meta?.timestamp ?? 0) <= ts)
    .at(-1);
  const after = buf.find((o) => (o.meta?.timestamp ?? 0) > ts);

  if (before && after) {
    const t1 = before.meta.timestamp;
    const t2 = after.meta.timestamp;

    if (t2 <= t1) return before;

    const ratio = (ts - t1) / (t2 - t1);
    const out = structuredClone(before);

    for (const [k, v1] of Object.entries(before.data || {})) {
      const v2 = after.data?.[k];
      if (typeof v1 === "number" && typeof v2 === "number") {
        out.data[k] = v1 + (v2 - v1) * ratio;
      } else {
        out.data[k] = v1;
      }
    }

    out.meta.timestamp = ts;
    return out;
  }

  return before || after || null;
}

/* ------------------------------------------------------------------------- *
 * UNBOUNDED VS BOUNDED SELECTION
 *   FIX 1: unbounded NEVER falls back to bounded path
 * ------------------------------------------------------------------------- */

function interpolateSide(idx, ts) {
  if (allowUnbounded[idx]) {
    return sideLastUnbounded[idx] || null; // hold-last-only strictly
  }
  return interpolateBounded(sideBuffers[idx], ts);
}

/* ------------------------------------------------------------------------- *
 * EMISSION
 * ------------------------------------------------------------------------- */

function emitPassthrough(mainObj) {
  const out = {
    meta: { ...(mainObj.meta || {}) },
    data: { ...(mainObj.data || {}) }
  };
  appendTag(out.meta, MODULE_TAG);
  safeWrite(out, undefined, { channelId: "stdout", exitOnClose: true });
}

function tryEmit() {
  if (mainBuffer.length === 0) return;

  const mainObj = mainBuffer.at(-1);
  const ts = mainObj.meta?.timestamp;

  if (typeof ts !== "number") {
    emitPassthrough(mainObj);
    return;
  }

  const merged = {
    meta: { ...(mainObj.meta || {}), timestamp: ts },
    data: { ...(mainObj.data || {}) }
  };

  for (let i = 0; i < sideBuffers.length; i++) {
    const rec = interpolateSide(i, ts);
    if (!rec || !rec.data) continue;

    const postfix = postfixes[i] ?? `_${i + 1}`;
    for (const [key, val] of Object.entries(rec.data)) {
      merged.data[`${key}${postfix}`] = val;
    }
  }

  appendTag(merged.meta, MODULE_TAG);
  safeWrite(merged, undefined, { channelId: "stdout", exitOnClose: true });
}

/* ------------------------------------------------------------------------- *
 * MAIN STREAM (stdin)
 * ------------------------------------------------------------------------- */

safeRead(
  (obj) => {
    pushMain(obj);
    tryEmit();
  },
  undefined,
  {
    channelId: "stdin",
    exitOnClose: true
  }
);

/* ------------------------------------------------------------------------- *
 * SIDE CHANNELS
 * ------------------------------------------------------------------------- */

sidePaths.forEach((path, idx) => {
  const channelId = `side:${idx}`;
  safeRead(
    (obj) => pushSide(idx, obj),
    path,
    {
      channelId,
      exitOnClose: false,
      retry: true,
      reconnectDelayMs: SIDE_RECONNECT_DELAY_MS
    }
  );
});
