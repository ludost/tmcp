#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-annotate-derivative.js (outputs-based)
 * -------------------------------------------
 * Time-derivative annotator for numeric fields.
 */

import {
  // config
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
/*  Declare expected positional(s)                                           */
/* ------------------------------------------------------------------------- */

registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to configuration file"
  }
]);

/* ------------------------------------------------------------------------- */
/*  Resolve configuration                                                    */
/* ------------------------------------------------------------------------- */
loadCLI();

const rawCfg = loadConfigFile("positionals.config_file", { defaultScope: "derivative" });
const derCfg = rawCfg.derivative || {};
const outCfg = derCfg.outputs || {};

const outputFields = Object.keys(outCfg);
if (outputFields.length === 0) {
  logError("[tmcp-annotate-derivative] ERROR: No outputs configured.");
  process.exit(1);
}

/* ------------------------------------------------------------------------- */
/*  Per-input state                                                          */
/* ------------------------------------------------------------------------- */

const state = Object.create(null);
const tag = "drv";

/* ------------------------------------------------------------------------- */
/*  Main Loop via safeRead                                                   */
/* ------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj || typeof obj !== "object") return;
  if (!obj.data || typeof obj.data !== "object") return;

  const ts = obj.meta?.timestamp ?? Date.now();
  const inData = obj.data;
  const outData = { ...inData };

  for (const outField of outputFields) {
    const cfg = outCfg[outField];
    const inField = cfg.input;
    const minDt = typeof cfg.windowMs === "number" ? cfg.windowMs : 40;

    const val = inData[inField];
    if (typeof val !== "number") {
      outData[outField] = 0;
      state[inField] = { prevVal: val, prevTime: ts };
      continue;
    }

    const prev = state[inField];
    if (!prev) {
      outData[outField] = 0;
      state[inField] = { prevVal: val, prevTime: ts };
      continue;
    }

    const dtMs = ts - prev.prevTime;
    if (dtMs <= 0 || dtMs < minDt) {
      outData[outField] = 0;
      state[inField] = { prevVal: val, prevTime: ts };
      continue;
    }

    const derivative = (val - prev.prevVal) / (dtMs / 1000);
    outData[outField] = derivative;

    state[inField] = { prevVal: val, prevTime: ts };
  }

  obj.data = outData;
  appendTag(obj.meta, tag);
  safeWrite(obj);
});
