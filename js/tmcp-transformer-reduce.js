#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-transformer-reduce.js
 * --------------------------
 * Declarative reducer / aggregator / conditional evaluator for NDJSON pipelines.
 *
 * Updated for the new TMCP configuration system:
 *   • registerPositionals()
 *   • loadConfigFile()
 *   • getConfig()
 */

import vm from "vm";
import {
  safeRead,
  appendTag,
  safeWrite,
  logError,
  logWarn,
  logInfo,
  loadConfigFile,
  loadCLI,
  registerPositionals
} from "./lib/pipeline-utils.js";

const tag = "red";

/* -------------------------------------------------------------------------- */
/*  POSITIONALS                                                               */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "config_file",
    "required": true,
    "description": "Reducer requires exactly one config file path."
  }
]);

/* -------------------------------------------------------------------------- */
/*  CONFIG LOADING                                                            */
/* -------------------------------------------------------------------------- */
loadCLI();

const config = loadConfigFile("positionals.config_file", { defaultScope: "reduce" });
const reduceCfg = config.reduce || { outputs: {} };

const passes        = Math.max(1, parseInt(reduceCfg.passes || 1, 10));
const missingMode   = reduceCfg.missing || "ignore";
const forwardPolicy = reduceCfg.forward_policy || "all";

const rules = reduceCfg.outputs || {};
const fieldProps = Object.create(null);

/* -------------------------------------------------------------------------- */
/*  SAFE EVAL                                                                 */
/* -------------------------------------------------------------------------- */

function safeEval(expr, vars = {}, ruleName = "<expr>") {
  const sandbox = Object.assign({}, vars, { Math });
  const context = vm.createContext(sandbox);
  try {
    return vm.runInContext(expr, context, { timeout: 50 });
  } catch (err) {
    logError(
      `[tmcp-transformer-reduce] safeEval error in rule "${ruleName}": ${err?.message || err}`
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  NUMERIC OPS                                                               */
/* -------------------------------------------------------------------------- */

const op_sum   = (v) => v.reduce((a, b) => a + b, 0);
const op_sub   = (v) => (v.length ? v.slice(1).reduce((a, b) => a - b, v[0]) : 0);
const op_avg   = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const op_max   = (v) => (v.length ? Math.max(...v) : 0);
const op_min   = (v) => (v.length ? Math.min(...v) : 0);
const op_range = (v) => (v.length ? Math.max(...v) - Math.min(...v) : 0);

function op_weighted_avg(weightMap, data, missingMode) {
  let sum = 0;
  let total = 0;

  for (const [k, w] of Object.entries(weightMap)) {
    const v = data[k];

    if (typeof v === "number") {
      sum += v * w;
      total += w;
    } else if (missingMode === "zero") {
      total += w;
    } else if (missingMode === "fail") {
      return null;
    }
  }

  return total ? sum / total : 0;
}

/* -------------------------------------------------------------------------- */
/*  MAIN RULE COMPUTATION                                                     */
/* -------------------------------------------------------------------------- */

function computeOutput(ruleName, rule, data, missingMode) {
  const { op, inputs, expr } = rule;
  if (!op) return null;

  // "copy"
  if (op === "copy" && typeof inputs === "object" && inputs.src) {
    const v = data[inputs.src];
    if (v !== undefined) return v;
    if (missingMode === "zero") return 0;
    if (missingMode === "fail") return null;
    return null; // ignore
  }

  let values = [];

  // array → numeric ops
  if (Array.isArray(inputs)) {
    for (const name of inputs) {
      const v = data[name];
      if (typeof v === "number") values.push(v);
      else if (missingMode === "zero") values.push(0);
      else if (missingMode === "fail") return null;
    }
  }

  // object inputs → locals for expr, condition, passthrough
  else if (inputs && typeof inputs === "object") {
    if (op === "weighted_avg") {
      return op_weighted_avg(inputs, data, missingMode);
    }

    const entries = rule._localEntries || Object.entries(inputs);
    const locals = {};
    let hasMissing = false;

    for (const [local, src] of entries) {
      const v = data[src];
      if (
        typeof v === "number" ||
        typeof v === "boolean" ||
        typeof v === "string"
      ) {
        locals[local] = v;
      } else if (missingMode === "zero") {
        locals[local] = 0;
      } else if (missingMode === "fail") {
        return null;
      } else {
        hasMissing = true;
      }
    }

    if ((op === "expr" || op === "condition") && hasMissing && missingMode === "ignore") {
      logInfo(
        `[tmcp-transformer-reduce] Missing input(s) for ${op} rule "${ruleName}" (missingMode=ignore); returning null.`
      );
      return null;
    }

    if (op === "expr" && expr) {
      try {
        if (typeof rule._compiled === "function") {
          return rule._compiled(locals, Math);
        }
        return safeEval(expr, locals, ruleName);
      } catch (err) {
        logError(
          `[tmcp-transformer-reduce] expr runtime error in rule "${ruleName}": ${err?.message || err}`
        );
        return null;
      }
    }

    if (op === "condition" && expr) {
      try {
        if (typeof rule._compiled === "function") {
          return !!rule._compiled(locals, Math);
        }
        return !!safeEval(expr, locals, ruleName);
      } catch (err) {
        logError(
          `[tmcp-transformer-reduce] condition runtime error in rule "${ruleName}": ${err?.message || err}`
        );
        return null;
      }
    }

    if (op === "passthrough") {
      const firstKey =
        (Array.isArray(entries) && entries.length > 0 && entries[0][0]) ||
        Object.keys(locals)[0];
      return firstKey ? locals[firstKey] ?? null : null;
    }

    values = Object.values(locals);
  }

  // numeric aggregations
  switch (op) {
    case "sum":   return op_sum(values);
    case "sub":   return op_sub(values);
    case "avg":   return op_avg(values);
    case "max":   return op_max(values);
    case "min":   return op_min(values);
    case "range": return op_range(values);
    default:      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  FIELD PROPERTIES (temp, retain)                                           */
/* -------------------------------------------------------------------------- */

for (const [name, rule] of Object.entries(rules)) {
  if (!fieldProps[name]) fieldProps[name] = { temp: false, retain: false };
  if (rule && rule.temp === true) fieldProps[name].temp = true;
  if (rule && rule.retain === true) fieldProps[name].retain = true;
}

/* -------------------------------------------------------------------------- */
/*  PRECOMPUTE HELPERS                                                        */
/* -------------------------------------------------------------------------- */

for (const rule of Object.values(rules)) {
  if (!rule || typeof rule !== "object") continue;

  if (rule.inputs && typeof rule.inputs === "object" && rule.op !== "weighted_avg") {
    rule._localEntries = Object.entries(rule.inputs);
  }

  if (typeof rule.expr === "string" && (rule.op === "expr" || rule.op === "condition")) {
    try {
      // eslint-disable-next-line no-new-func
      rule._compiled = new Function(
        "locals",
        "Math",
        `with (locals) { return (${rule.expr}); }`
      );
    } catch (err) {
      rule._compiled = null;
      logError(
        `[tmcp-transformer-reduce] Failed to precompile expr for rule: ${rule.expr} (${err?.message || err})`
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  RETAINED STATE                                                            */
/* -------------------------------------------------------------------------- */

const retained = Object.create(null);
let startWallTime = null;

function ensurePrevInitialized(name, workingData) {
  const prevKey = `${name}__prev`;
  if (prevKey in workingData) return;
  if (name in workingData) {
    workingData[prevKey] = workingData[name];
  } else if (missingMode === "zero") {
    workingData[prevKey] = 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  MAIN LOOP                                                                 */
/* -------------------------------------------------------------------------- */

safeRead((obj) => {
  if (!obj) return;

  const input = obj.data || {};
  const now = Date.now();
  if (startWallTime === null) startWallTime = now;

  const workingData = { ...retained, ...input };
  workingData.__timestamp = obj.meta?.timestamp ?? null;
  workingData.__now       = now;
  workingData.__start     = startWallTime;

  // multi-pass reduction
  for (let pass = 0; pass < passes; pass++) {
    for (const [name, rule] of Object.entries(rules)) {
      if (!rule || typeof rule !== "object") continue;

      const value = computeOutput(name, rule, workingData, missingMode);

      if (value === null && missingMode === "fail") {
        logError(
          `[tmcp-transformer-reduce] Missing required input or expr failure for '${name}' (missingMode=fail)`
        );
        return; // drop record
      }

      workingData[name] = value;

      if (rule.retain === true) {
        ensurePrevInitialized(name, workingData);
        retained[`${name}__prev`] = value;
      }
    }
  }

  // remove temp fields and internals
  const entries = Object.entries(workingData).filter(([key]) => {
    if (key.includes("__")) return false;
    if (fieldProps[key]?.temp === true) return false;
    return true;
  });

  if (forwardPolicy === "known") {
    const known = new Set(Object.keys(rules));
    obj.data = Object.fromEntries(entries.filter(([k]) => known.has(k)));
  } else {
    obj.data = Object.fromEntries(entries);
  }

  appendTag(obj.meta, tag);
  safeWrite(obj);
});
