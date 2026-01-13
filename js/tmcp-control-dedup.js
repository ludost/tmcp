#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-control-dedup.js
 * ----------------------
 * Drops incoming messages when their *data* fields have not changed
 * compared to the previous emitted message.
 *
 * Extensions:
 *   • ignore_fields: list of data keys to exclude from consideration.
 *   • check_fields: optional explicit whitelist of fields to compare.
 *        - If provided, dedup compares only these fields (minus ignore_fields).
 *        - If omitted, all fields (minus ignore_fields) participate.
 *   • numeric_tolerance: optional threshold for numeric comparisons.
 *   • debug: if true, logs dropped messages.
 */

import {
  // config
  registerPositionals,
  loadConfigFile,
  loadCLI,

  // pipeline infrastructure
  appendTag,
  safeWrite,
  safeRead,

  // logging
  logWarn,
  logInfo,
  logError
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  Declare positionals                                                       */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to configuration file for this module."
  }
]);

/* -------------------------------------------------------------------------- */
/*  Load configuration                                                        */
/* -------------------------------------------------------------------------- */
loadCLI();

const rawCfg = loadConfigFile("positionals.config_file",{ defaultScope: "dedup" });
const dedupCfg = rawCfg.dedup || {};

const IGNORE_FIELDS =
  Array.isArray(dedupCfg.ignore_fields) ? dedupCfg.ignore_fields : [];

const CHECK_FIELDS =
  Array.isArray(dedupCfg.check_fields) ? dedupCfg.check_fields : null;

const NUM_TOL =
  Number.isFinite(dedupCfg.numeric_tolerance) ? dedupCfg.numeric_tolerance : 0;

const DEBUG = dedupCfg.debug === true;

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let lastData = null;
let haveLast = false;

/* -------------------------------------------------------------------------- */
/*  Utilities                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compute effective comparison field list for the current data object.
 * If CHECK_FIELDS is provided → restrict to those.
 * Then remove IGNORE_FIELDS.
 */
function computeComparisonFields(curr) {
  let base;
  if (CHECK_FIELDS) {
    base = CHECK_FIELDS;
  } else {
    base = Object.keys(curr);
  }
  return base.filter(k => !IGNORE_FIELDS.includes(k));
}

function isEqualWithTolerance(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= NUM_TOL;
  }
  return a === b;
}

/**
 * Returns true if a significant change is detected.
 */
function hasMeaningfulChange(curr) {
  if (!haveLast) return true;

  const fields = computeComparisonFields(curr);

  // Missing field in lastData
  for (const k of fields) {
    if (!(k in lastData)) return true;
  }

  // Check per-field differences
  for (const k of fields) {
    const vCurr = curr[k];
    const vPrev = lastData[k];

    // Missing field in previous
    if (!(k in lastData)) return true;

    // Primitive or value-type comparison
    if (
      typeof vCurr !== "object" ||
      vCurr === null ||
      typeof vPrev !== "object" ||
      vPrev === null
    ) {
      if (!isEqualWithTolerance(vCurr, vPrev)) return true;
      continue;
    }

    // Object shallow comparison
    const keysC = Object.keys(vCurr);
    const keysP = Object.keys(vPrev);

    if (keysC.length !== keysP.length) return true;

    for (const sub of keysC) {
      if (!(sub in vPrev)) return true;
      if (!isEqualWithTolerance(vCurr[sub], vPrev[sub])) return true;
    }
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*  Main loop                                                                 */
/* -------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj || !obj.data) return;

  const curr = obj.data;

  if (!hasMeaningfulChange(curr)) {
    if (DEBUG) {
      logInfo("tmcp-control-dedup: dropped frame (no significant change)");
    }
    return;
  }

  appendTag(obj.meta, "dup");
  safeWrite(obj);

  lastData = structuredClone(curr);
  haveLast = true;
});
