#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-control-gate.js
 * ---------------------
 * Flow-control gate. Drops all incoming messages until all configured
 * activation conditions are satisfied. After activation, all messages pass.
 */

import {
  // new configuration API
  registerPositionals,
  loadConfigFile,
  loadCLI,

  // pipeline helpers
  appendTag,
  safeWrite,
  safeRead,

  // logging
  logWarn,
  logInfo,
  logError
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  Positionals                                                               */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to configuration file"
  }
]);

/* -------------------------------------------------------------------------- */
/*  Load configuration                                                        */
/* -------------------------------------------------------------------------- */
loadCLI();

const rawCfg = loadConfigFile("positionals.config_file", { defaultScope: "gate" });

// Accept `gate:` or array-of-gate-blocks
const gateBlocks = Array.isArray(rawCfg.gate)
  ? rawCfg.gate
  : rawCfg.gate
  ? [rawCfg.gate]
  : [];

/* -------------------------------------------------------------------------- */
/*  Normalize gate blocks                                                     */
/* -------------------------------------------------------------------------- */

const normalizedBlocks = gateBlocks.map(block => ({
  mustHave: Array.isArray(block.must_have) ? block.must_have : [],

  minValues:
    block.min_values && typeof block.min_values === "object"
      ? block.min_values
      : {},

  boolEqual:
    block.bool_equal && typeof block.bool_equal === "object"
      ? block.bool_equal
      : {},

  strEqual:
    block.str_equal && typeof block.str_equal === "object"
      ? block.str_equal
      : {},

  maxAgeMs: Number.isFinite(block.max_age_ms)
    ? block.max_age_ms
    : null,

  timeoutMs: Number.isFinite(block.timeout_ms)
    ? block.timeout_ms
    : 2000
}));

/* -------------------------------------------------------------------------- */
/*  Internal state                                                            */
/* -------------------------------------------------------------------------- */

let activated = false;
let warnedTimeout = false;
let gateOpenedReported = false;
const startTime = Date.now();

/* -------------------------------------------------------------------------- */
/*  Boolean + string equality helpers                                         */
/* -------------------------------------------------------------------------- */

function booleanCheck(data, boolMap) {
  for (const [field, target] of Object.entries(boolMap)) {
    const present = Object.prototype.hasOwnProperty.call(data, field);

    if (target === true) {
      if (!present) return false;
      if (data[field] !== true) return false;
    }

    if (target === false) {
      if (present && data[field] !== false) return false;
    }
  }
  return true;
}

function stringEqualCheck(data, strMap) {
  for (const [field, expected] of Object.entries(strMap)) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) return false;
    if (data[field] !== expected) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Block evaluation                                                          */
/* -------------------------------------------------------------------------- */

function blockSatisfied(block, obj) {
  const data = obj.data || {};

  // must_have means: field must exist AND not be null/undefined
  for (const k of block.mustHave) {
    if (!(k in data)) return false;
    const v = data[k];
    if (v === null || v === undefined) return false;
  }

  for (const [k, minV] of Object.entries(block.minValues)) {
    const v = data[k];
    if (typeof v !== "number" || v < minV) return false;
  }

  if (!booleanCheck(data, block.boolEqual)) return false;
  if (!stringEqualCheck(data, block.strEqual)) return false;

  if (block.maxAgeMs !== null) {
    const ts = obj.meta?.timestamp;
    if (typeof ts !== "number") return false;
    if (Date.now() - ts > block.maxAgeMs) return false;
  }

  return true;
}

function allBlocksSatisfied(obj) {
  for (const block of normalizedBlocks) {
    if (!blockSatisfied(block, obj)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Main loop                                                                 */
/* -------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj) return;

  const now = Date.now();

  // One-time timeout warning
  if (!activated && !warnedTimeout) {
    const dt = now - startTime;
    const maxTimeout = Math.max(...normalizedBlocks.map(b => b.timeoutMs));
    if (dt > maxTimeout) {
      logWarn(
        `tmcp-control-gate: still blocked after ${maxTimeout} ms; waiting for activation conditions.`
      );
      warnedTimeout = true;
    }
  }

  // Activation
  if (!activated) {
    if (allBlocksSatisfied(obj)) {
      activated = true;
      if (!gateOpenedReported) {
        logInfo("tmcp-control-gate: activation conditions satisfied; stream now passing");
        gateOpenedReported = true;
      }
      appendTag(obj.meta, "gat");
      safeWrite(obj);
    }
    return;
  }

  // Post-activation forward
  appendTag(obj.meta, "gat");
  safeWrite(obj);
});
