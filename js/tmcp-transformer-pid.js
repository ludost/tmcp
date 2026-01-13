#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-transformer-pid.js
 * ------------------------
 * Per-field PID control term computation for NDJSON pipelines.
 *
 * Updated to use the new configuration system:
 *   • registerPositionals()
 *   • loadConfigFile()
 *   • getConfig()
 */

import {
  loadConfigFile,
  safeRead,
  appendTag,
  safeWrite,
  logError,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  POSITIONALS                                                               */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "config_file",
    "required": true,
    "description": "PID transformer requires exactly one config file."
  }
]);

const tag = "pid";

/* -------------------------------------------------------------------------- */
/*  CONFIG LOADING                                                            */
/* -------------------------------------------------------------------------- */
loadCLI();
const config = loadConfigFile("positionals.config_file", { defaultScope: "pid" });
const pidCfg = config.pid || {};

/* -------------------------------------------------------------------------- */
/*  PID CORE                                                                  */
/* -------------------------------------------------------------------------- */

class PIDCore {
  constructor(P = 0, I = 0, D = 0) {
    this.P = P;
    this.I = I;
    this.D = D;
    this.integral = 0;
    this.prevError = 0;
    this.lastTime = null;
  }

  update(error, timestamp) {
    let dt;

    if (this.lastTime !== null) {
      dt = (timestamp - this.lastTime) / 1000;
      if (dt <= 0) dt = 1e-3;
    } else {
      dt = 1e-3;
    }

    this.integral += error * dt;
    const derivative = (error - this.prevError) / dt;

    this.prevError = error;
    this.lastTime = timestamp;

    return this.P * error + this.I * this.integral + this.D * derivative;
  }
}

/* -------------------------------------------------------------------------- */
/*  INITIALIZE CONTROLLERS                                                    */
/* -------------------------------------------------------------------------- */

const controllers = {};
for (const [key, cfg] of Object.entries(pidCfg)) {
  controllers[key] = new PIDCore(cfg.P ?? 0, cfg.I ?? 0, cfg.D ?? 0);
}

/* -------------------------------------------------------------------------- */
/*  PROCESSING LOOP                                                           */
/* -------------------------------------------------------------------------- */

safeRead((obj) => {
  if (!obj) return;

  const ts = obj.meta?.timestamp ?? Date.now();
  const data = obj.data || {};

  for (const [key, val] of Object.entries(data)) {
    const pid = controllers[key];
    if (pid && typeof val === "number") {
      data[key] = pid.update(val, ts);
    }
  }

  appendTag(obj.meta, tag);
  safeWrite(obj);
});
