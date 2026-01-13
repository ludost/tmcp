#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-annotate-inject.js
 * ------------------------
 * Inject constant labeled values into incoming records.
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

const rawCfg = loadConfigFile("positionals.config_file", { defaultScope: "inject" });
const injectCfg = rawCfg.inject || {};
const injectValues = injectCfg.values || {};
const override = injectCfg.override !== false; // default true

const tag = "inj";

/* ------------------------------------------------------------------------- */
/*  Main Loop                                                                 */
/* ------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj || typeof obj !== "object") return;

  const data = obj.data || {};

  for (const [label, val] of Object.entries(injectValues)) {
    if (override || !(label in data)) {
      data[label] = val;
    }
  }

  obj.data = data;
  appendTag(obj.meta, tag);
  safeWrite(obj);
});
