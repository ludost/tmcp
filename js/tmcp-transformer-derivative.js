#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-transformer-derivative.js
 * -------------------------------
 * Computes time derivatives for numeric NDJSON fields.
 *
 * No configuration or CLI arguments.
 * Fully compatible with the new pipeline-config API.
 */

import {
  safeRead,
  appendTag,
  safeWrite,
  logError,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  DECLARE POSITIONALS                                                       */
/* -------------------------------------------------------------------------- */

registerPositionals([]);
loadCLI();

/* -------------------------------------------------------------------------- */
/*  RUNTIME STATE                                                             */
/* -------------------------------------------------------------------------- */

const tag = "drv";
const state = Object.create(null);   // per-key: { prevVal, prevTime }

/* -------------------------------------------------------------------------- */
/*  MAIN LOOP                                                                 */
/* -------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj) return;

  const ts = obj.meta?.timestamp ?? Date.now();
  const data = obj.data || {};

  for (const [key, val] of Object.entries(data)) {
    if (typeof val !== "number") continue;

    const prev = state[key];
    if (prev && ts > prev.prevTime) {
      const dtSec = (ts - prev.prevTime) / 1000;
      data[key] = (val - prev.prevVal) / dtSec;
    } else {
      data[key] = 0;
    }

    state[key] = { prevVal: val, prevTime: ts };
  }

  appendTag(obj.meta, tag);
  safeWrite(obj);
});
