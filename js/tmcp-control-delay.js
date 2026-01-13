#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-control-delay.js
 * ---------------------
 * Delay an NDJSON stream by a fixed amount of LOGICAL time.
 *
 * Use-case:
 *   - Buffer a sensor stream so it can be merged later (e.g. via tmcp-control-merge-streams).
 *   - Provides deterministic timestamp shifting: meta.timestamp is moved forward by delayMs.
 *
 * Configuration:
 *   --delay-ms=<number>         (env: TMCP_DELAY_MS)          required
 *   --max-delay-ms=<number>     (env: TMCP_MAX_DELAY_MS)      optional, default 10000
 *
 * Constraints:
 *   - delayMs must be within [0, maxDelayMs].
 *
 * Timestamp semantics:
 *   - On ingestion, determine an input logical timestamp:
 *       tsIn = obj.meta.timestamp if finite number else Date.now().
 *   - On emission, set:
 *       obj.meta.timestamp = tsIn + delayMs
 *     This updates the header timestamp to the new (delayed) logical time,
 *     which improves synchronization when merged with other streams.
 *
 * Logical-time semantics:
 *   - Messages are buffered and emitted only when the input stream's moving timestamp window
 *     reaches their delayed timestamp.
 *
 *     Definitions:
 *       tsIn      := input meta.timestamp (ms since epoch; number). If missing/invalid: Date.now().
 *       tsOut     := tsIn + delayMs
 *       watermark := max(tsIn) observed so far.
 *
 *     Emission rule:
 *       Emit buffered items in increasing tsOut order while tsOut <= watermark.
 *
 *     This provides a pure logical delay for replays and deterministically-time-stamped streams,
 *     independent of wall-clock processing speed.
 *
 * EOF semantics:
 *   - By default, stdin EOF will NOT immediately exit (exitOnClose=false default), so buffered
 *     items can be flushed.
 *   - On stdin close/end, the module flushes any remaining items (even if watermark has not
 *     advanced far enough) and then exits.
 */

import {
  appendTag,
  safeWrite,
  safeRead,
  logError,
  logInfo,
  registerParam,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* ------------------------------------------------------------------------- */
/*  CONFIGURATION REGISTRATION                                               */
/* ------------------------------------------------------------------------- */

registerParam({
  longname: "delay-ms",
  envname: "TMCP_DELAY_MS",
  required: true,
  expectsValue: true,
  description: "Fixed logical delay in milliseconds to apply to the stream (timestamp shift + buffered emission)."
});

registerParam({
  longname: "max-delay-ms",
  envname: "TMCP_MAX_DELAY_MS",
  default: 10000,
  expectsValue: true,
  description: "Maximum allowed delay in milliseconds. Defaults to 10000 (10 seconds)."
});

/* ------------------------------------------------------------------------- */
/*  LOAD CONFIG VALUES                                                       */
/* ------------------------------------------------------------------------- */

let cli = loadCLI();

const delayMsRaw = cli.get("param.delay-ms");
const maxDelayMsRaw = cli.get("param.max-delay-ms");

const delayMs = Number(delayMsRaw);
const maxDelayMs = Number(maxDelayMsRaw);

if (delayMs < 0) {
  logError("tmcp-control-delay: --delay-ms must be >= 0.");
  process.exit(1);
}

if (delayMs > maxDelayMs) {
  logError(
    `tmcp-control-delay: --delay-ms (${delayMs}) exceeds --max-delay-ms (${maxDelayMs}).`
  );
  process.exit(1);
}

/* ------------------------------------------------------------------------- */
/*  INTERNAL STATE                                                           */
/* ------------------------------------------------------------------------- */

const TAG = "dly";

/**
 * Queue elements:
 *   {
 *     outTs: number,  // logical timestamp to stamp into meta.timestamp
 *     obj:   object   // normalized pipeline object {meta, data}
 *   }
 */
const queue = [];

let inputClosed = false;

// Moving watermark of input logical time.
let watermarkTs = Number.NEGATIVE_INFINITY;

/* ------------------------------------------------------------------------- */
/*  QUEUE HELPERS                                                            */
/* ------------------------------------------------------------------------- */

function insertSorted(item) {
  // Keep the queue sorted by outTs ascending.
  let lo = 0;
  let hi = queue.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (queue[mid].outTs <= item.outTs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  queue.splice(lo, 0, item);
}

function maybeExit() {
  if (inputClosed && queue.length === 0) {
    logInfo("tmcp-control-delay: stdin closed and buffer drained; exiting.");
    process.exit(0);
  }
}

/* ------------------------------------------------------------------------- */
/*  EMISSION                                                                 */
/* ------------------------------------------------------------------------- */

function emitItem(item) {
  const out = item.obj;

  const metaIn = (out && out.meta && typeof out.meta === "object") ? out.meta : {};
  const pipelineIn = Array.isArray(metaIn.pipeline) ? metaIn.pipeline : [];

  out.meta = {
    ...metaIn,
    pipeline: [...pipelineIn],
    timestamp: item.outTs
  };

  appendTag(out.meta, TAG);
  safeWrite(out);
}

function flushReady() {
  while (queue.length > 0 && queue[0].outTs <= watermarkTs) {
    const item = queue.shift();
    emitItem(item);
  }
}

function flushAll() {
  while (queue.length > 0) {
    const item = queue.shift();
    emitItem(item);
  }
}

/* ------------------------------------------------------------------------- */
/*  INPUT                                                                    */
/* ------------------------------------------------------------------------- */

safeRead(
  (obj) => {
    if (!obj) return;

    const now = Date.now();
    const tsInRaw = obj.meta?.timestamp;
    const tsIn = (typeof tsInRaw === "number" && Number.isFinite(tsInRaw)) ? tsInRaw : now;

    // Update watermark from observed input timestamps.
    if (tsIn > watermarkTs) watermarkTs = tsIn;

    const outTs = tsIn + delayMs;

    // Clone so downstream mutations cannot affect buffered items.
    const stored = structuredClone(obj);

    insertSorted({ outTs, obj: stored });
    flushReady();
  },
  undefined,
  {
    // Important: do not auto-exit on EOF, so we can drain the buffered queue.
    exitOnClose: false
  }
);

// Track end-of-input so we can exit after draining.
process.stdin.on("end", () => {
  inputClosed = true;
  flushAll();
  maybeExit();
});

process.stdin.on("close", () => {
  inputClosed = true;
  flushAll();
  maybeExit();
});
