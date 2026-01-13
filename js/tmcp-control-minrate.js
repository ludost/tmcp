#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-control-minrate.js
 * -----------------------
 * Ensures a *minimum* output frequency by cloning the most recent message.
 *
 * Semantics:
 *   • interval-ms: minimum ms between outputs
 *   • rate:        minimum Hz → converted to interval-ms
 *
 * Constraints:
 *   • You may NOT use both --rate and --interval-ms simultaneously.
 *
 * Timestamp semantics:
 *   • Real messages preserve incoming timestamps if valid.
 *   • Clones: timestamp = lastLogicalTs + intervalMs.
 *     Avoids backward jumps in replay pipelines.
 */

import {
  appendTag,
  safeWrite,
  safeRead,
  logError,
  registerParam,
  loadCLI,
  registerPositionals
} from "./lib/pipeline-utils.js";

/* ------------------------------------------------------------------------- */
/*  CONFIGURATION REGISTRATION                                               */
/* ------------------------------------------------------------------------- */

/**
 * interval-ms override
 */
registerParam({
  longname: "interval-ms",
  envname: "TMCP_INTERVAL_MS",
  expectsValue: true,
  description: "Minimum milliseconds between outputs."
});

/**
 * rate override
 */
registerParam({
  longname: "rate",
  envname: "TMCP_RATE",
  expectsValue: true,
  description: "Minimum output frequency in Hz."
});

/* ------------------------------------------------------------------------- */
/*  LOAD CONFIG VALUES                                                       */
/* ------------------------------------------------------------------------- */
let cli = loadCLI();

const intervalFromOverride = cli.get("param.interval-ms");
const rateFromOverride     = cli.get("param.rate");

const haveInterval = intervalFromOverride !== undefined && intervalFromOverride !== null;
const haveRate     = rateFromOverride !== undefined && rateFromOverride !== null;

/* Validate mutual exclusivity */
if (haveInterval && haveRate) {
  logError("tmcp-control-minrate: Provide ONLY one of --interval-ms or --rate.");
  process.exit(1);
}

/* Determine intervalMs */
let intervalMs = null;

if (haveInterval) {
  intervalMs = intervalFromOverride;
} else if (haveRate) {
  intervalMs = 1000 / rateFromOverride;
} else {
  logError("tmcp-control-minrate: Requires --interval-ms <ms> or --rate <hz>.");
  process.exit(1);
}

/* ------------------------------------------------------------------------- */
/*  INTERNAL STATE                                                            */
/* ------------------------------------------------------------------------- */

const TAG = "minr";

let lastMessage = null;     // last fully emitted message
let lastLogicalTs = null;   // logical timestamp for replay friendliness
let lastEmitWall = 0;       // wall-clock timestamp of last emission

/* ------------------------------------------------------------------------- */
/*  CLONE EMISSION                                                            */
/* ------------------------------------------------------------------------- */

function emitClone() {
  if (!lastMessage) return;

  if (!Number.isFinite(lastLogicalTs)) {
    lastLogicalTs = Date.now();
  }

  lastLogicalTs += intervalMs;

  const srcMeta = lastMessage.meta || {};
  const meta = {
    ...srcMeta,
    pipeline: Array.isArray(srcMeta.pipeline)
      ? [...srcMeta.pipeline]
      : [TAG],
    timestamp: lastLogicalTs
  };

  const data = structuredClone(lastMessage.data ?? {});
  const cloned = { meta, data };

  safeWrite(cloned);
  lastEmitWall = Date.now();
}

/* ------------------------------------------------------------------------- */
/*  WATCHDOG (fires clones when needed)                                       */
/* ------------------------------------------------------------------------- */

setInterval(() => {
  if (!lastMessage) return;

  const now = Date.now();
  if (now - lastEmitWall >= intervalMs) {
    emitClone();
  }
}, Math.max(5, Math.floor(intervalMs / 4)));

/* ------------------------------------------------------------------------- */
/*  MAIN STREAM                                                               */
/* ------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj) return;

  const metaIn = obj.meta || {};
  const dataIn = obj.data || {};

  let ts;
  if (typeof metaIn.timestamp === "number" && Number.isFinite(metaIn.timestamp)) {
    ts = metaIn.timestamp;
  } else {
    ts = Date.now();
  }
  lastLogicalTs = ts;

  const outMeta = {
    ...metaIn,
    timestamp: ts
  };

  appendTag(outMeta, TAG);

  const outData = structuredClone(dataIn);
  const out = { meta: outMeta, data: outData };

  safeWrite(out);

  lastMessage = out;
  lastEmitWall = Date.now();
});
