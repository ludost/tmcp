#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-transformer-highpass-gain.js
 * ---------------------------------
 * Applies a configured high-pass threshold and gain per numeric field.
 *
 * Configuration file must contain:
 *   {
 *     "highPass": { "<field>": <threshold>, ... },
 *     "gain":     { "<field>": <gainFactor>, ... }
 *   }
 */

import {
  safeRead,
  appendTag,
  safeWrite,
  logError,
  loadConfigFile,
  loadCLI,
  registerPositionals
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  POSITIONALS                                                               */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "config_file",
    "required": true,
    "description": "High-pass + gain transformer; requires exactly one config file."
  }
]);

/* -------------------------------------------------------------------------- */
/*  LOAD CONFIG                                                               */
/* -------------------------------------------------------------------------- */
loadCLI();

const tag = "hpg";

const config = loadConfigFile("positionals.config_file",{ defaultScope: "highPass" });
const highPass = config.highPass || {};
const gainMap  = config.gain     || {};

/* -------------------------------------------------------------------------- */
/*  MAIN LOOP                                                                 */
/* -------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj) return;

  const data = obj.data || {};

  for (const [key, val] of Object.entries(data)) {
    if (typeof val !== "number") continue;

    const threshold = highPass[key] ?? 0;
    const gain = gainMap[key] ?? 1;

    data[key] = val < threshold ? 0 : (val - threshold) * gain;
  }

  appendTag(obj.meta, tag);
  safeWrite(obj);
});
