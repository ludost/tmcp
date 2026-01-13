#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-annotate-state-machine.js
 * -------------------------------
 * Generic configuration-driven finite state machine annotator.
 *
 * Optional multi-pass evaluation:
 *   - stateMachine.passes (default: 1)
 *   - When >1, the module may apply multiple consecutive transitions on a single
 *     input record for each instance (up to N passes), enabling patterns like:
 *       state -> unknown -> reclassified_state
 *     within the same record.
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
    description: "Path to configuration file for this module."
  }
]);

/* ------------------------------------------------------------------------- */
/*  Load configuration                                                       */
/* ------------------------------------------------------------------------- */
loadCLI();

const fullConfig = loadConfigFile("positionals.config_file",{ defaultScope: "stateMachine" });
const smCfg = fullConfig.stateMachine || {};

/* ------------------------------------------------------------------------- */
/*  Extract configuration sections                                           */
/* ------------------------------------------------------------------------- */

const statesCfg    = smCfg.states     || {};
const instancesCfg = smCfg.instances  || {};
const constantsCfg = smCfg.constants  || {};

const passesRaw = smCfg.passes ?? 1;
const passes = Number(passesRaw);
if (!Number.isFinite(passes) || !Number.isInteger(passes) || passes < 1) {
  logError(
    `[tmcp-annotate-state-machine] ERROR: stateMachine.passes must be an integer >= 1 (got: ${JSON.stringify(passesRaw)}).`
  );
  process.exit(1);
}

const stateNames = Object.keys(statesCfg);
if (stateNames.length === 0) {
  logError("[tmcp-annotate-state-machine] ERROR: stateMachine.states is missing or empty.");
  process.exit(1);
}

const instanceNames = Object.keys(instancesCfg);
if (instanceNames.length === 0) {
  logError("[tmcp-annotate-state-machine] ERROR: stateMachine.instances is missing or empty.");
  process.exit(1);
}

function resolveInitialState(instanceName) {
  const instCfg = instancesCfg[instanceName] || {};
  if (typeof instCfg.initialState === "string") {
    if (!statesCfg[instCfg.initialState]) {
      logError(
        `[tmcp-annotate-state-machine] ERROR: instance "${instanceName}" has unknown initialState "${instCfg.initialState}".`
      );
    }
    return instCfg.initialState;
  }
  return stateNames[0];
}

/* ------------------------------------------------------------------------- */
/*  Expression Compiler                                                      */
/* ------------------------------------------------------------------------- */

function tokenize(expr) {
  const tokens = [];
  const s = expr.trim();
  const len = s.length;
  let i = 0;

  while (i < len) {
    const ch = s[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++; continue;
    }

    if (i + 1 < len) {
      const pair = ch + s[i + 1];
      if (["&&","||","==","!=", "<=" ,">="].includes(pair)) {
        tokens.push({ type: "op", value: pair });
        i += 2; continue;
      }
    }

    if (["!","<",">","(",")"].includes(ch)) {
      tokens.push({ type: ch === "(" || ch === ")" ? "paren" : "op", value: ch });
      i++; continue;
    }

    if ((ch >= "0" && ch <= "9") || ch === ".") {
      let j = i + 1;
      while (j < len && ((s[j] >= "0" && s[j] <= "9") || s[j] === ".")) j++;
      tokens.push({ type: "number", value: Number(s.slice(i, j)) });
      i = j; continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let str = "";
      let closed = false;
      while (j < len) {
        if (s[j] === quote) { closed = true; j++; break; }
        str += s[j];
        j++;
      }
      if (!closed) {
        logError(`[tmcp-annotate-state-machine] ERROR: Unterminated string literal in expression: ${expr}`);
        return [];
      }
      tokens.push({ type: "string", value: str });
      i = j;
      continue;
    }

    if ((ch >= "A" && ch <= "Z") ||
        (ch >= "a" && ch <= "z") ||
        ch === "_" || ch === "$") {
      let j = i + 1;
      while (j < len &&
        ((s[j] >= "A" && s[j] <= "Z") ||
         (s[j] >= "a" && s[j] <= "z") ||
         (s[j] >= "0" && s[j] <= "9") ||
         s[j] === "_" || s[j] === "." || s[j] === "$")) {
        j++;
      }
      const ident = s.slice(i, j);
      tokens.push(
        ident === "true" || ident === "false"
          ? { type: "boolean", value: ident === "true" }
          : { type: "identifier", value: ident }
      );
      i = j;
      continue;
    }

    logError(`[tmcp-annotate-state-machine] ERROR: Unknown token "${ch}" in expression: ${expr}`);
    return [];
  }
  return tokens;
}

function resolveValueRef(ref, ctx) {
  if (ref.startsWith("data.")) {
    const alias = ref.slice(5);
    const field = (ctx.instanceCfg.inputs || {})[alias];
    const v = ctx.data[field];
    return v === undefined ? null : v;
  }
  if (ref === "instance.state") return ctx.stateName;
  if (ref === "instance.timeInStateMs") return ctx.timeInStateMs;

  if (ref.startsWith("instancesInState.")) {
    const st = ref.slice("instancesInState.".length);
    return ctx.instancesInState[st] || 0;
  }

  if (ref.startsWith("constant.")) {
    const c = ref.slice(9);
    return ctx.constants[c] ?? null;
  }

  return null;
}

function compareValues(op, a, b) {
  if (a == null || b == null) return false;
  switch (op) {
    case "==": return a === b;
    case "!=": return a !== b;
    case "<":  return a <  b;
    case "<=": return a <= b;
    case ">":  return a >  b;
    case ">=": return a >= b;
  }
  return false;
}

function compileExpression(expr) {
  const trimmed = (expr || "").trim();
  if (!trimmed) return () => false;

  const tokens = tokenize(trimmed);
  if (!tokens.length) return () => false;

  let pos = 0;
  const peek = () => tokens[pos] || null;
  const consume = () => tokens[pos++] || null;

  function parseValue() {
    const t = peek();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.type === "number" || t.type === "boolean" || t.type === "string") {
      consume(); return () => t.value;
    }
    if (t.type === "identifier") {
      consume();
      const ref = t.value;
      return ctx => resolveValueRef(ref, ctx);
    }
    throw new Error(`Unexpected token in value: ${t.type}`);
  }

  function parseComparison() {
    const left = parseValue();
    const t = peek();
    if (!t || t.type !== "op" ||
        !["==","!=","<","<=",">",">="].includes(t.value))
      return ctx => !!left(ctx);
    consume();
    const op = t.value;
    const right = parseValue();
    return ctx => compareValues(op, left(ctx), right(ctx));
  }

  function parsePrimary() {
    const t = peek();
    if (t && t.type === "paren" && t.value === "(") {
      consume();
      const fn = parseExpr();
      if (!peek() || peek().value !== ")") throw new Error("Missing ')'");
      consume();
      return fn;
    }
    return parseComparison();
  }

  function parseNot() {
    const t = peek();
    if (t && t.type === "op" && t.value === "!") {
      consume();
      const fn = parseNot();
      return ctx => !fn(ctx);
    }
    return parsePrimary();
  }

  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().type === "op" && peek().value === "&&") {
      consume();
      const right = parseNot();
      const L = left;
      left = ctx => L(ctx) && right(ctx);
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === "op" && peek().value === "||") {
      consume();
      const right = parseAnd();
      const L = left;
      left = ctx => L(ctx) || right(ctx);
    }
    return left;
  }

  function parseExpr() { return parseOr(); }

  let fn;
  try {
    fn = parseExpr();
    if (pos < tokens.length) throw new Error("Trailing tokens");
  } catch (e) {
    logError(`[tmcp-annotate-state-machine] ERROR: Failed to compile expression "${expr}": ${e.message}`);
    return () => false;
  }
  return fn;
}

/* ------------------------------------------------------------------------- */
/*  Transition Table                                                         */
/* ------------------------------------------------------------------------- */

const compiledStates = Object.create(null);

for (const s of stateNames) {
  const st = statesCfg[s] || {};
  const trs = st.transitions || [];
  compiledStates[s] = {
    transitions: trs.map(tr => {
      const expr = typeof tr.when === "string" ? tr.when : "";
      return {
        when: compileExpression(expr),
        target: tr.action?.goto
      };
    })
  };
}

/* ------------------------------------------------------------------------- */
/*  Runtime State                                                            */
/* ------------------------------------------------------------------------- */

const instanceRuntime = Object.create(null);
for (const inst of instanceNames) {
  instanceRuntime[inst] = {
    state: resolveInitialState(inst),
    enteredAtMs: 0
  };
}

/* ------------------------------------------------------------------------- */
/*  Main Loop                                                                */
/* ------------------------------------------------------------------------- */

const tag = "sm";

safeRead(obj => {
  if (!obj) return;

  const meta = obj.meta || {};
  const data = obj.data || {};

  const out = { ...data };
  const nowMs =
    typeof meta.timestamp === "number" ? meta.timestamp : Date.now();

  const instancesInState = Object.create(null);
  for (const inst of instanceNames) {
    const st = instanceRuntime[inst].state;
    instancesInState[st] = (instancesInState[st] || 0) + 1;
  }

  for (const inst of instanceNames) {
    const cfg = instancesCfg[inst];
    const rt = instanceRuntime[inst];

    // Multi-pass transition application: each pass may apply at most one transition.
    // If no transition occurs in a pass, we stop early.
    for (let pass = 0; pass < passes; pass++) {
      const current = rt.state;
      const entered = rt.enteredAtMs || nowMs;
      const timeIn = nowMs - entered;

      const ctx = {
        data,
        instanceCfg: cfg,
        instanceName: inst,
        stateName: current,
        timeInStateMs: timeIn,
        instancesInState,
        constants: constantsCfg
      };

      let next = current;
      for (const tr of compiledStates[current].transitions) {
        let cond = false;
        try { cond = tr.when(ctx); }
        catch { cond = false; }
        if (cond && typeof tr.target === "string") {
          next = tr.target;
          break;
        }
      }

      if (next !== current) {
        rt.state = next;
        rt.enteredAtMs = nowMs;
        // Continue to the next pass, enabling state -> intermediate -> reclassify.
        continue;
      }

      // No transition; remaining passes would do nothing.
      break;
    }

    const outCfg = cfg.outputs || {};
    const stField = outCfg.stateField;
    if (stField) out[stField] = rt.state;
  }

  obj.data = out;
  appendTag(meta, tag);
  safeWrite(obj);
});
