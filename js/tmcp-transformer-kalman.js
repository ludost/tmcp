#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-transformer-kalman.js
 * ---------------------------
 * 1-D Kalman filter for pipeline messages.
 * Applies independent smoothing filters to selected numeric fields.
 *
 * Features:
 *   • Per-field configurable process (Q) and measurement (R) noise.
 *   • Mode-based field selection: "all" or "known".
 *   • Optional per-field and default output rounding.
 *   • Stateless I/O; internal temporal continuity is retained.
 *
 * Notes:
 *   • Uses pipeline-utils.js safeRead/safeWrite abstraction
 *     so this module is fully protocol-agnostic (NDJSON/MsgPack).
 */

import {
  appendTag,
  safeWrite,
  safeRead,
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
    "description": "Kalman transformer requires exactly one config file."
  }
]);

const tag = "kmf";

/* -------------------------------------------------------------------------- */
/*  LOAD CONFIG                                                               */
/* -------------------------------------------------------------------------- */

loadCLI();

const config = loadConfigFile("positionals.config_file",{ defaultScope: "kalman"});
const kalmanConfig = config.kalman || {};

const mode = kalmanConfig.mode === "known" ? "known" : "all";
const excludeList = Array.isArray(kalmanConfig.exclude) ? kalmanConfig.exclude : [];

const defaultCfg = kalmanConfig.default || {};
const defaultQ = typeof defaultCfg.Q === "number" ? defaultCfg.Q : 1.0;
const defaultR = typeof defaultCfg.R === "number" ? defaultCfg.R : 5.0;
const defaultRound = Number.isInteger(defaultCfg.round) ? defaultCfg.round : undefined;

const fieldsCfg = kalmanConfig.fields || {};

/* -------------------------------------------------------------------------- */
/*  KALMAN FILTER CLASS                                                       */
/* -------------------------------------------------------------------------- */

class Kalman1D {
  constructor(Q, R) {
    this.Q = Q;
    this.R = R;
    this.x = 0;
    this.P = 1;
    this.init = false;
  }

  update(z) {
    if (!this.init) {
      this.x = z;
      this.init = true;
      return this.x;
    }

    this.P += this.Q;
    const K = this.P / (this.P + this.R);
    this.x += K * (z - this.x);
    this.P *= (1 - K);
    return this.x;
  }
}

/* -------------------------------------------------------------------------- */
/*  FIELD CONFIG RESOLUTION                                                   */
/* -------------------------------------------------------------------------- */

function isExcluded(key) {
  return excludeList.includes(key);
}

function resolveFieldConfig(key) {
  if (mode === "all") {
    if (isExcluded(key)) {
      return { active: false };
    }
    const fieldSpec = fieldsCfg[key] || {};
    const Q = typeof fieldSpec.Q === "number" ? fieldSpec.Q : defaultQ;
    const R = typeof fieldSpec.R === "number" ? fieldSpec.R : defaultR;
    const round = Number.isInteger(fieldSpec.round)
      ? fieldSpec.round
      : defaultRound;
    return { active: true, Q, R, round };
  }

  if (mode === "known") {
    const fieldSpec = fieldsCfg[key];
    if (!fieldSpec) {
      return { active: false };
    }
    const Q = typeof fieldSpec.Q === "number" ? fieldSpec.Q : defaultQ;
    const R = typeof fieldSpec.R === "number" ? fieldSpec.R : defaultR;
    const round = Number.isInteger(fieldSpec.round)
      ? fieldSpec.round
      : defaultRound;
    return { active: true, Q, R, round };
  }

  return { active: false };
}

/* -------------------------------------------------------------------------- */
/*  RUNTIME FILTER STATE                                                      */
/* -------------------------------------------------------------------------- */

const filters = {};
const fieldPlans = {};

/* -------------------------------------------------------------------------- */
/*  MAIN PROCESSING LOOP                                                      */
/* -------------------------------------------------------------------------- */

safeRead((obj) => {
  if (!obj || typeof obj.data !== "object" || typeof obj.meta !== "object") {
    return;
  }

  const data = obj.data;

  for (const [key, val] of Object.entries(data)) {
    if (typeof val !== "number") {
      continue;
    }

    let plan = fieldPlans[key];
    if (!plan) {
      plan = resolveFieldConfig(key);
      fieldPlans[key] = plan;
    }

    if (!plan.active) {
      continue;
    }

    if (!filters[key]) {
      filters[key] = new Kalman1D(plan.Q, plan.R);
    }

    let filtered = filters[key].update(val);

    if (Number.isInteger(plan.round)) {
      const factor = Math.pow(10, plan.round);
      filtered = Math.round(filtered * factor) / factor;
    }

    data[key] = filtered;
  }

  appendTag(obj.meta, tag);
  safeWrite(obj);
});
