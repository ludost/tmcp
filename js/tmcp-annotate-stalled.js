#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-annotate-stalled.js (outputs-based)
 * ----------------------------------------
 * Sliding-window stalled detector.
 */

import {
  // config API
  registerPositionals,
  loadConfigFile,
  loadCLI,

  // pipeline ops
  appendTag,
  safeWrite,
  safeRead,

  // logging
  logError
} from "./lib/pipeline-utils.js";

/* ------------------------------------------------------------------------- */
/*  Declare positionals                                                      */
/* ------------------------------------------------------------------------- */

registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to configuration file"
  }
]);

/* ------------------------------------------------------------------------- */
/*  Load configuration                                                       */
/* ------------------------------------------------------------------------- */
loadCLI();

const rawCfg = loadConfigFile("positionals.config_file", { defaultScope: "stalled"});
const stCfg = rawCfg.stalled || {};
const outCfg = stCfg.outputs || {};

const outputFields = Object.keys(outCfg);
if (outputFields.length === 0) {
  logError("[tmcp-annotate-stalled] ERROR: No outputs configured.");
  process.exit(1);
}

const history = Object.create(null);
const tag = "stl";

/* ------------------------------------------------------------------------- */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------- */

function ensureHist(k) {
  if (!history[k]) history[k] = [];
}

/* ------------------------------------------------------------------------- */
/*  Main Loop                                                                */
/* ------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj) return;

  const ts = obj.meta?.timestamp ?? Date.now();
  const inData = obj.data || {};
  const outData = { ...inData };

  for (const outField of outputFields) {
    const cfg = outCfg[outField];
    const inField = cfg.input;
    const windowMs = typeof cfg.windowMs === "number" ? cfg.windowMs : 500;
    const deadband = typeof cfg.deadband === "number" ? cfg.deadband : 0.5;

    const val = inData[inField];
    if (typeof val !== "number") {
      outData[outField] = false;
      continue;
    }

    ensureHist(inField);
    history[inField].push({ t: ts, v: val });

    const cutoff = ts - windowMs;
    while (history[inField].length > 0 && history[inField][0].t < cutoff) {
      history[inField].shift();
    }

    let min = Infinity;
    let max = -Infinity;

    for (const s of history[inField]) {
      if (s.v < min) min = s.v;
      if (s.v > max) max = s.v;
    }

    outData[outField] = (max - min) < deadband;
  }

  obj.data = outData;
  appendTag(obj.meta, tag);
  safeWrite(obj);
});
