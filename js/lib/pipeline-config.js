/**
 * lib/pipeline-config.js
 * ----------------------
 * Centralized configuration and parameter resolution system for all TMCP modules.
 *
 * This module is the *only* place where:
 *   - CLI arguments (via minimist)
 *   - environment variables (via dotenv)
 *   - JSON configuration files
 * are parsed, merged, validated, and exposed.
 *
 * Core concepts:
 *
 * 1) PARAMETERS (CLI/ENV/POSITIONALS)
 *    - Declared via registerParam() and registerPositionals()
 *    - Loaded via loadCLI()
 *    - Accessed via the returned accessor object:
 *        const cli = loadCLI();
 *        cli.get("param.intervalMs");
 *        cli.get("positionals.0");
 *        cli.get("positionals.config_file");
 *
 * 2) CONFIG FILE
 *    - Declared via registerConfigField()
 *    - Loaded via loadConfigFile(pathOrPositionalRef)
 *    - Supports $env indirection (eagerly resolved at load time):
 *        { "$env": "ENV_NAME" }
 *    - Accessed via returned accessor object:
 *        const cfg = loadConfigFile("positionals.config_file");
 *        cfg.get("zaptec.api.baseUrl");
 *
 * 3) MUTABLE RUNTIME LAYER (Decorator)
 *    - Both CLI and config accessors are runtime-mutable via:
 *        overrideValue(path, value)
 *        clearOverride(path)
 *    - Mutability is controlled by spec.mutable for params (default true).
 *    - Positionals may also be overridden (no spec required).
 *    - `get(path, { original: true })` bypasses runtime overrides.
 *      `get(path, { original: false })` returns overridden value if present,
 *      otherwise falls back to the original/base value.
 *
 * Enforcement rules:
 *   - Modules must not read process.argv directly
 *   - Modules must not read process.env directly
 *   - Modules must call loadCLI() to access parameters
 *   - Modules must call loadConfigFile() to access config
 *
 * Notes:
 *   - All lookups are case-insensitive for registered keys and dotted paths.
 *   - This module is intentionally duck-typed: no value typing is imposed.
 */

import "dotenv/config";

import fs from "fs";
import path from "path";
import minimist from "minimist";

/* ------------------------------------------------------------------------- */
/*  Registries                                                               */
/* ------------------------------------------------------------------------- */

const paramRegistry = new Map(); // keyLower -> ParamSpecNormalized
const configRegistry = new Map(); // pathLower -> ConfigFieldSpecNormalized
const shortParamsRegistry = new Map(); // short -> key

let positionalsSchema = null;

/* ------------------------------------------------------------------------- */
/*  CLI resolved base state                                                  */
/* ------------------------------------------------------------------------- */

const cliBase = {
  params: Object.create(null),      // keyLower -> value
  positionals: [],                  // array
  namedPositionals: {}              // named properties
};

const cliStatus = {
  isDirty:true,
  isError:false,
  showHelp:false
}
let cliRuntime = null;

/* ------------------------------------------------------------------------- */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------- */

function cfgErr(msg) {
  console.error(`[pipeline-config] ERROR: ${msg}`);
}

function cfgWarn(msg) {
  console.error(`[pipeline-config] WARN: ${msg}`);
}

function normalizeKey(s) {
  return String(s).trim().toLowerCase();
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function normalizeNameToken(s) {
  return String(s).replace(/^-+/, "");
}

/**
 * Case-insensitive property access for configuration objects.
 * Prefers exact match, otherwise scans keys for case-insensitive match.
 */
function getPropCaseInsensitive(obj, wantedKey) {
  if (!isPlainObject(obj)) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, wantedKey)) return obj[wantedKey];

  const wantedLower = normalizeKey(wantedKey);
  for (const k of Object.keys(obj)) {
    if (normalizeKey(k) === wantedLower) return obj[k];
  }
  return undefined;
}

/**
 * Case-insensitive "has" check for configuration objects.
 */
function hasPropCaseInsensitive(obj, wantedKey) {
  if (!isPlainObject(obj)) return false;
  if (Object.prototype.hasOwnProperty.call(obj, wantedKey)) return true;

  const wantedLower = normalizeKey(wantedKey);
  for (const k of Object.keys(obj)) {
    if (normalizeKey(k) === wantedLower) return true;
  }
  return false;
}

/**
 * Resolve {"$env":"NAME"} indirection eagerly.
 */
function resolveEnvObject(value) {
  if (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value.$env === "string"
  ) {
    return process.env[value.$env];
  }
  return value;
}

/* ------------------------------------------------------------------------- */
/*  Positionals                                                              */
/* ------------------------------------------------------------------------- */

/**
 * registerPositionals(schema)
 * schema: Array of descriptors:
 *   { name: string, required?: boolean, varargs?: boolean, description?: string }
 *
 * Rules:
 *   - At most one entry with varargs === true and it needs to be the last entry.
 */
export function registerPositionals(schema) {
  if (!Array.isArray(schema)) {
    throw new Error("registerPositionals: schema must be an array");
  }
  if (positionalsSchema !== null) {
    throw new Error("registerPositionals: schema already registered");
  }

  positionalsSchema = schema.map((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`registerPositionals: invalid entry at index ${idx}`);
    }
    if (typeof entry.name !== "string") {
      throw new Error(
        `registerPositionals: entry at index ${idx} missing string 'name'`
      );
    }

    if (entry.varargs && idx !== schema.length - 1) {
      throw new Error(
        "registerPositionals: varargs entry must be the last positional"
      );
    }

    return {
      name: entry.name,
      required: !!entry.required,
      varargs: !!entry.varargs,
      description: entry.description || ""
    };
  });
  cliStatus.isDirty = true
}

function applyPositionalsSchema(positionalsArr) {
  let namedPositionals = {}
  if (!positionalsSchema || positionalsSchema.length === 0) return namedPositionals;

  let idx = 0;

  for (let i = 0; i < positionalsSchema.length; i++) {
    const spec = positionalsSchema[i];
    const name = spec.name;

    if (spec.varargs) {

      const rest = positionalsArr.slice(idx);
      namedPositionals[name] = rest;

      if (spec.required && rest.length === 0) {
        cfgErr(`Missing required positional argument "${name}".`);
        cliStatus.showHelp = true
        cliStatus.isError = true
      }
      return namedPositionals;  //early exit, as varargs are always the last positionals
    }

    const value = idx < positionalsArr.length ? positionalsArr[idx] : undefined;
    namedPositionals[name] = value;

    if (spec.required && value === undefined) {
      cfgErr(`Missing required positional argument "${name}".`);
      cliStatus.showHelp = true
      cliStatus.isError = true
    }

    idx++;
  }
  return namedPositionals;
}

/* ------------------------------------------------------------------------- */
/*  Param registry                                                           */
/* ------------------------------------------------------------------------- */

/**
 * registerParam(spec)
 * spec:
 * {
 *   longname: string,
 *   shortname?: character,
 *   envname?: string,
 *   default?: any,
 *   description?: string,
 *   expectsValue?: boolean (default false),
 *   generateNegative?: boolean (default: !expectsValue),
 *   required?: boolean (default false),
 *   mutable?: boolean (default true)
 * }
 */
export function registerParam(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("registerParam: invalid spec");
  }
  if (!spec.longname || typeof spec.longname !== "string") {
    throw new Error("registerParam: spec.longname must be a string");
  }

  const longname = normalizeNameToken(spec.longname);
  const keyLower = normalizeKey(longname);

  if (paramRegistry.has(keyLower)) {
    throw new Error(`registerParam: duplicate longname "${longname}"`);
  }

  let shortname = spec.shortname;
  if (shortname !== undefined) {
    if (typeof shortname !== "string" || shortname.length !== 1) {
      throw new Error(`registerParam("${longname}"): shortname must be a single character`);
    }
    shortname = shortname.toLowerCase();

    if (shortname === "h" && keyLower !== "help") {
      throw new Error(`registerParam("${longname}"): shortname "-h" is reserved for help`);
    }
    if (shortParamsRegistry.has(shortname)) {
      throw new Error(
        `registerParam("${longname}"): shortname "-${shortname}" already used`
      );
    }
  }

  const expectsValue = spec.expectsValue === true;
  const generateNegative =
    spec.generateNegative !== undefined ? !!spec.generateNegative : !expectsValue;

  const normalized = {
    longname,
    longnameLower: keyLower,
    shortname,
    envname: spec.envname ? String(spec.envname) : undefined,
    default: Object.prototype.hasOwnProperty.call(spec, "default")
      ? spec.default
      : undefined,
    description: spec.description ? String(spec.description) : "",
    expectsValue,
    generateNegative,
    required: spec.required === true,
    mutable: spec.mutable !== undefined ? !!spec.mutable : true
  };

  paramRegistry.set(keyLower, normalized);
  if (shortname) {
    shortParamsRegistry.set(shortname, keyLower);
  }
  cliStatus.isDirty = true
}

/* ------------------------------------------------------------------------- */
/*  Config field registry                                                    */
/* ------------------------------------------------------------------------- */

/**
 * registerConfigField(spec)
 * spec:
 * {
 *   path: string,
 *   default?: any,
 *   description?: string,
 *   required?: boolean (default false)
 * }
 */
export function registerConfigField(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("registerConfigField: invalid spec");
  }
  if (!spec.path || typeof spec.path !== "string") {
    throw new Error("registerConfigField: spec.path must be a string");
  }

  const p = String(spec.path).trim();
  const pLower = normalizeKey(p);

  if (configRegistry.has(pLower)) {
    throw new Error(`registerConfigField: duplicate path "${p}"`);
  }

  configRegistry.set(pLower, {
    path: p,
    pathLower: pLower,
    description: spec.description ? String(spec.description) : "",
    required: spec.required === true,
    default: Object.prototype.hasOwnProperty.call(spec, "default") ? spec.default : undefined
  });
}

/* ------------------------------------------------------------------------- */
/*  Decorator runtime layer                                                  */
/* ------------------------------------------------------------------------- */

/**
 * createRuntimeLayer(baseLayer, opts)
 *
 * baseLayer:
 * {
 *   get:  (path, options?) => any,
 *   spec: (path) => specOrUndefined
 * }
 *
 * The runtime layer adds:
 *   - overrideValue(path, value)
 *   - clearOverride(path)
 *   - get(path, {original}) with override support
 *   - spec(path) passthrough
 */
function createRuntimeLayer(baseLayer, opts = {}) {
  const overrides = new Map(); // pathLower -> value
  const layerName = opts.name ? String(opts.name) : "runtime";

  function normalizePathKey(p) {
    return normalizeKey(p);
  }

  function canMutate(path) {
    const s = baseLayer.spec ? baseLayer.spec(path) : undefined;

    // If spec exists and is explicitly immutable -> reject
    if (s && Object.prototype.hasOwnProperty.call(s, "mutable") && s.mutable === false) {
      return false;
    }

    // If no spec, allow (this is important for positionals and unregistered paths)
    return true;
  }

  function get(path, options = {}) {
    const p = String(path);
    const original = options && options.original === true;

    if (!original) {
      const k = normalizePathKey(p);
      if (overrides.has(k)) return overrides.get(k);
    }

    return baseLayer.get(p, options);
  }

  function spec(path) {
    if (!baseLayer.spec) return undefined;
    return baseLayer.spec(String(path));
  }

  function overrideValue(path, value) {
    const p = String(path);
    if (!canMutate(p)) {
      cfgErr(`[${layerName}] Attempt to override immutable field: ${p}`);
      process.exit(1);
    }
    overrides.set(normalizePathKey(p), value);
  }

  function clearOverride(path) {
    overrides.delete(normalizePathKey(String(path)));
  }

  return { get, spec, overrideValue, clearOverride };
}

/* ------------------------------------------------------------------------- */
/*  CLI parsing and access                                                   */
/* ------------------------------------------------------------------------- */

function buildUsageFromSchema() {
  const prog = path.basename(process.argv[1] || "tmcp-module");

  if (!positionalsSchema || positionalsSchema.length === 0) {
    return `${prog} [options]`;
  }

  const parts = [];
  for (const spec of positionalsSchema) {
    if (spec.varargs) parts.push(`${spec.name}...`);
    else if (spec.required) parts.push(`<${spec.name}>`);
    else parts.push(`[${spec.name}]`);
  }

  return `${prog} [options] ${parts.join(" ")}`;
}

function generateHelpText() {
  const lines = [];
  lines.push(`Usage: ${buildUsageFromSchema()}`);
  lines.push("");
  lines.push("TMCP Parameters (CLI / ENV):");
  lines.push("");

  if (paramRegistry.size === 0) {
    lines.push("  (no registered parameters)");
    lines.push("");
  } else {
    const params = Array.from(paramRegistry.values()).sort((a, b) =>
      a.longnameLower.localeCompare(b.longnameLower)
    );

    for (const p of params) {
      const forms = [];

      if (p.shortname) {
        forms.push(p.expectsValue ? `-${p.shortname} <value>` : `-${p.shortname}`);
      }

      if (p.expectsValue) {
        forms.push(`--${p.longname} <value>`);
      } else {
        forms.push(`--${p.longname}`);
        if (p.generateNegative) forms.push(`--no-${p.longname}`);
      }

      lines.push(`  ${forms.join(", ")}`);

      const bits = [];
      if (p.envname) bits.push(`env=${p.envname}`);
      if (Object.prototype.hasOwnProperty.call(p, "default")) {
        bits.push(`default=${JSON.stringify(p.default)}`);
      } else {
        bits.push("default=undefined");
      }
      if (p.required) bits.push("required");
      if (p.mutable) bits.push("mutable");
      else bits.push("immutable");

      lines.push(`      (${bits.join(", ")})`);
      if (p.description) lines.push(`      ${p.description}`);
      lines.push("");
    }
  }

  lines.push("Positionals:");
  lines.push("");

  if (positionalsSchema && positionalsSchema.length > 0) {
    for (const spec of positionalsSchema) {
      let head;
      if (spec.varargs) head = `${spec.name}...`;
      else if (spec.required) head = `<${spec.name}>`;
      else head = `[${spec.name}]`;
      lines.push(`  ${head}`);
      if (spec.description) lines.push(`      ${spec.description}`);
    }
    lines.push("");
  } else {
    lines.push("  (no positional schema registered)");
    lines.push("");
  }

  if (configRegistry.size > 0) {
    lines.push("Config File Structure (JSON-like):");
    lines.push("");
    lines.push(renderConfigSchemaSkeleton());
    lines.push("");
    lines.push("Note: This is not strict JSON (comments are for documentation).");
    lines.push("");
  }

  return lines.join("\n");
}


function parseCLIOnce() {
  if (!cliStatus.isDirty) return;
  cliStatus.isDirty = false;

  // ---- 1. Build minimist configuration from registry ----

  const boolean = ["help"];
  const string = [];
  const alias = {"help":"h"};

  for (const p of paramRegistry.values()) {
    if (p.expectsValue) {
      string.push(p.longname);
    } else {
      boolean.push(p.longname);
      if (p.generateNegative) {
        boolean.push(`no-${p.longname}`);
      }
    }

    if (p.shortname) {
      alias[p.longname] = p.shortname;
    }
  }

  // ---- 2. Parse argv ----
  const parsedArgs = minimist(process.argv.slice(2), {
    boolean,
    string,
    alias,
    "--": true,
    stopEarly: false
  });

  // ---- 3. Resolve params ----

  for (const p of paramRegistry.values()) {
    let value;
    let hasCliValue = false;

    // 3.1 CLI long / short (minimist alias already handles both)
    if (Object.prototype.hasOwnProperty.call(parsedArgs, p.longname)) {
      value = parsedArgs[p.longname];
      hasCliValue = true;
    }

    // 3.2 CLI negative
    if (!p.expectsValue && p.generateNegative) {
      if (parsedArgs[`no-${p.longname}`] === true) {
        value = false;
        hasCliValue = true;
      }
    }

    // 3.3 STRICT expectsValue enforcement
    if (hasCliValue && p.expectsValue) {
      if (value === true || value === undefined) {
        cfgErr(`Missing value for --${p.longname}`);
        cliStatus.showHelp = true
        cliStatus.isError = true
      }
    }

    // 3.4 ENV
    if (!hasCliValue && p.envname && process.env[p.envname] !== undefined) {
      value = process.env[p.envname];
    }

    // 3.5 Default
    if (value === undefined && Object.prototype.hasOwnProperty.call(p, "default")) {
      value = p.default;
    }

    // 3.6 Required
    if (p.required && value === undefined) {
      cfgErr(`Missing required parameter --${p.longname}`);
      cliStatus.showHelp = true
      cliStatus.isError = true
    }

    cliBase.params[p.longnameLower] = value;
  }

  // ---- 4. Positionals ----
  cliBase.positionals = Array.isArray(parsedArgs._) ? parsedArgs._.slice() : [];
  cliBase.namedPositionals = applyPositionalsSchema(cliBase.positionals);

  // Checking for help tag:
  if (parsedArgs["help"]) {
    cliStatus.showHelp = true;
  }
}

/**
 * Base layer for CLI access (used by the runtime decorator).
 */
function createCliBaseLayer() {
  function get(pathStr) {
    const p = String(pathStr);
    const parts = p.split(".");

    if (parts.length === 0) return undefined;

    const head = normalizeKey(parts[0]);

    if (head === "param" || head === "override" || head === "flag") {
      if (parts.length < 2) return undefined;
      const keyLower = normalizeKey(parts.slice(1).join("."));
      return cliBase.params[keyLower];
    }

    if (head === "positionals") {
      if (parts.length == 1) return cliBase.positionals;
      if (parts.length < 2) return undefined;
      const tail = parts[1];

      // positionals.<index>
      if (/^[0-9]+$/.test(tail)) {
        const idx = Number(tail);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cliBase.positionals.length) return undefined;
        return cliBase.positionals[idx];
      }

      // positionals.<name>
      const wantedLower = normalizeKey(tail);
      for (const k of Object.keys(cliBase.namedPositionals)) {
        if (normalizeKey(k) === wantedLower) return cliBase.namedPositionals[k];
      }

      return undefined;
    }

    return undefined;
  }

  function spec(pathStr) {
    const p = String(pathStr);
    const parts = p.split(".");
    if (parts.length < 2) return undefined;

    const head = normalizeKey(parts[0]);

    if (head === "param" || head === "override" || head === "flag") {
      const keyLower = normalizeKey(parts.slice(1).join("."));
      return paramRegistry.get(keyLower);
    }

    // Positionals may not have a dedicated spec entry here; schema exists globally.
    return undefined;
  }

  return { get, spec };
}

function _loadCLI() {

  parseCLIOnce();

  if (cliRuntime) return cliRuntime;

  const baseLayer = createCliBaseLayer();
  cliRuntime = createRuntimeLayer(baseLayer, { name: "cli" });

  return cliRuntime;
}

/**
 * loadCLI() => runtime accessor
 * {
 *   get(path, {original?:boolean}) => value,
 *   spec(path) => spec|undefined,
 *   overrideValue(path, value),
 *   clearOverride(path)
 * }
 */
export function loadCLI() {

  let cliRuntime = _loadCLI()
  if (cliStatus.showHelp) {
      console.log(generateHelpText())
      process.exit(cliStatus.isError? -1: 0)
  }
  return cliRuntime
}

/* ------------------------------------------------------------------------- */
/*  Config file loading and access                                           */
/* ------------------------------------------------------------------------- */

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function getConfigRawValue(selectedRoot, dottedPath) {
  const parts = String(dottedPath).split(".");
  let cur = selectedRoot;

  for (const part of parts) {
    if (!isPlainObject(cur)) return undefined;
    if (!hasPropCaseInsensitive(cur, part)) return undefined;
    cur = getPropCaseInsensitive(cur, part);
  }

  return cur;
}

/**
 * Validates registered config fields at load time:
 * - applies defaults
 * - enforces required
 *
 * Returns a Map of pathLower -> resolvedValue (after defaults/env resolution)
 * for registered fields. This does not prevent access to unregistered paths.
 */
function resolveRegisteredConfigFields(selectedRoot) {
  const resolvedMap = new Map(); // pathLower -> resolvedValue

  for (const spec of configRegistry.values()) {
    let v = getConfigRawValue(selectedRoot, spec.path);
    v = resolveEnvObject(v);

    if (v === undefined && Object.prototype.hasOwnProperty.call(spec, "default")) {
      v = spec.default;
    }

    if (spec.required && (v === undefined || v === null || v === "")) {
      cfgErr(`Missing required config field: ${spec.path}`);
      cliStatus.showHelp = true
      cliStatus.isError = true
    }

    resolvedMap.set(spec.pathLower, v);
  }

  return resolvedMap;
}

/**
 * Creates a base layer for config access, with eager env resolution.
 * Registered fields use the resolvedMap (defaults applied, required enforced).
 * Unregistered fields are read directly from the selectedRoot (env objects resolved on read).
 */
function createConfigBaseLayer(selectedRoot, resolvedRegisteredMap) {
  function get(pathStr) {
    const p = String(pathStr).trim();
    const pLower = normalizeKey(p);

    if (resolvedRegisteredMap.has(pLower)) {
      return resolvedRegisteredMap.get(pLower);
    }

    // Unregistered: read from object and resolve env indirection
    return resolveEnvObject(getConfigRawValue(selectedRoot, p));
  }

  function spec(pathStr) {
    const pLower = normalizeKey(String(pathStr).trim());
    return configRegistry.get(pLower);
  }

  return { get, spec };
}

/**
 * loadConfigFile(pathOrPositionalRef, options?) => config accessor
 *
 * options:
 *   { defaultScope?: string }
 *
 * Behavior:
 *   - Always returns the FILE ROOT object
 *   - Getter is scoped to:
 *       config-tag > defaultScope > null
 *   - If scope === null:
 *       - warn immediately (once per loadConfigFile call)
 *       - getter operates on file root
 */
export function loadConfigFile(pathOrPositionalRef, options = {}) {
  // Ensure CLI is available (for positionals + config-tag)
  const cli = _loadCLI();

  let filePath = String(pathOrPositionalRef || "").trim();
  if (filePath === "") {
    cfgErr("loadConfigFile called with empty path");
    cliStatus.showHelp = true
    cliStatus.isError = true
  }

  // Allow "positionals.*" references
  if (normalizeKey(filePath).startsWith("positionals.")) {
    const v = cli.get(filePath, { original: true });
    if (typeof v !== "string" || v.trim() === "") {
      cfgErr(
        `loadConfigFile: positional reference "${filePath}" did not resolve to a valid filepath`
      );
      cliStatus.showHelp = true
      cliStatus.isError = true
    }
    filePath = v.trim();
  }

  let fileRoot;
  try {
    fileRoot = readJsonFile(filePath);
  } catch (err) {
    cfgErr(`[${path.basename(filePath)}] read error: ${err.message}`);
      cliStatus.showHelp = true
      cliStatus.isError = true
  }

  /* ------------------------------------------------------------------ */
  /*  Scope selection                                                    */
  /* ------------------------------------------------------------------ */

  const defaultScope =
    options && typeof options.defaultScope === "string"
      ? options.defaultScope
      : undefined;

  const tag = cli.get("param.config-tag", { original: true });

  let scope = null;

  if (tag && isPlainObject(getPropCaseInsensitive(fileRoot, tag))) {
    scope = getPropCaseInsensitive(fileRoot, tag);
  } else if (
    defaultScope &&
    isPlainObject(getPropCaseInsensitive(fileRoot, defaultScope))
  ) {
    scope = getPropCaseInsensitive(fileRoot, defaultScope);
  }

  if (scope === null) {
    cfgWarn(
      "No config scope selected (config-tag/defaultScope missing or invalid); getters will operate on file root:\n"+(printStackTrace().join('\n\n'))
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Base + runtime layer                                               */
  /* ------------------------------------------------------------------ */

  const resolvedRegisteredMap = resolveRegisteredConfigFields(
    scope || fileRoot
  );

  const baseLayer = createConfigBaseLayer(
    scope || fileRoot,
    resolvedRegisteredMap
  );

  const runtime = createRuntimeLayer(baseLayer, { name: "config" });

  /* ------------------------------------------------------------------ */
  /*  Return file root + accessor                                        */
  /* ------------------------------------------------------------------ */

  return Object.assign({}, fileRoot, runtime);
}

/* ------------------------------------------------------------------------- */
/*  Presentation: config schema rendering                                    */
/* ------------------------------------------------------------------------- */

function renderConfigSchemaSkeleton() {
  // Build a nested object tree from dotted paths
  const tree = {};

  for (const spec of configRegistry.values()) {
    const parts = spec.path.split(".");
    let cur = tree;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];

      if (i === parts.length - 1) {
        cur[p] = { __spec: spec };
      } else {
        if (!cur[p]) cur[p] = {};
        cur = cur[p];
      }
    }
  }

  function renderNode(node, indent) {
    const pad = " ".repeat(indent);
    const lines = [];
    lines.push("{");

    const entries = Object.entries(node);
    entries.forEach(([key, value], idx) => {
      const isLast = idx === entries.length - 1;

      if (value && value.__spec) {
        const spec = value.__spec;

        let renderedValue;
        if (Object.prototype.hasOwnProperty.call(spec, "default")) {
          renderedValue = JSON.stringify(spec.default);
        } else {
          renderedValue = `""`;
        }

        const comments = [];
        if (spec.required) comments.push("required");
        if (spec.description) comments.push(spec.description);

        const commentSuffix =
          comments.length > 0 ? ` // (${comments.join(") (")})` : "";

        lines.push(
          `${pad}  "${key}": ${renderedValue}${isLast ? "" : ","}${commentSuffix}`
        );
      } else {
        const child = renderNode(value, indent + 2);
        const childLines = child.split("\n").map(l => pad + "  " + l);
        childLines[0] = `${pad}  "${key}": ${childLines[0].trimStart()}`;
        if (!isLast) {
          childLines[childLines.length - 1] += ",";
        }
        lines.push(...childLines);
      }
    });

    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  return renderNode(tree, 0);
}

/* ------------------------------------------------------------------------- */
/*  Compatibility export (scheduled for removal)                             */
/* ------------------------------------------------------------------------- */

/**
 * Backward-compatibility export.
 * Prefer: const cli = loadCLI(); cli.get("param.foo")
 */
export function getConfig(pathStr, fallback = undefined) {
  const cli = _loadCLI();
  const v = cli.get(String(pathStr), { original: false });
  return v === undefined ? fallback : v;
}

export function registerOverride(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("registerOverride: invalid spec");
  }
  if (!spec.key || typeof spec.key !== "string") {
    throw new Error("registerOverride: spec.key must be a string");
  }

  if (spec.cli != spec.key){
	cfgWarn("deprecated spec.cli given and different from spec.key, this will most likely fail: cli:" + spec.cli + " key:" + spec.key)
  }

  registerParam({
    longname: spec.cli || spec.key,
    shortname: spec.short,
    envname: spec.env,
    default: Object.prototype.hasOwnProperty.call(spec, "default")
      ? spec.default
      : undefined,
    description: spec.description,
    expectsValue: true,
    generateNegative: false,
    required: spec.required === true,
    mutable: spec.mutable !== undefined ? !!spec.mutable : true
  });
}

export function registerFlag(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("registerFlag: invalid spec");
  }
  if (!spec.key || typeof spec.key !== "string") {
    throw new Error("registerFlag: spec.key must be a string");
  }

  if (spec.cli != spec.key){
	cfgWarn("deprecated spec.cli given and different from spec.key, this will most likely fail: cli:" + spec.cli + " key:" + spec.key)
  }

  registerParam({
    longname: spec.cli || spec.key,
    shortname: spec.short,
    envname: spec.env,
    default: Object.prototype.hasOwnProperty.call(spec, "default")
      ? spec.default
      : false,
    description: spec.description,
    expectsValue: false,
    generateNegative: true,
    required: false,
    mutable: spec.mutable !== undefined ? !!spec.mutable : true
  });
}
