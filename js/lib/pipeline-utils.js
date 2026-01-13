/**
 * lib/pipeline-utils.js
 * ---------------------
 * Public facade for the TMCP utility layer.
 *
 * This file deliberately exposes a *curated*, *stable*, and *semantically
 * constrained* API surface for all TMCP modules.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * TMCP utilities are intentionally split across multiple internal modules
 * (pipeline-config, pipeline-stream, pipeline-core, pipeline-logging, …).
 *
 * Those files are *implementation detail*.
 *
 * This file exists to:
 *   • provide a single, authoritative import surface
 *   • enforce architectural boundaries
 *   • prevent accidental coupling to internal semantics
 *   • allow internal refactors without touching module code
 *
 * If a symbol is not exported from this file, it is *not* part of the TMCP API.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MENTAL MODEL (IMPORTANT)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Think of this file as a *semantic contract*, not a convenience barrel.
 *
 * Each exported symbol belongs to exactly one of these conceptual layers:
 *
 *   1. LOGGING
 *      - Structured, module-safe logging
 *      - Prefixing is a presentation concern, not identity
 *      - Logging never mutates pipeline data
 *
 *   2. META / TAGGING
 *      - Meta objects describe *where data came from*
 *      - Tags are debugging / tracing aids
 *      - Tags are NOT part of the TMCP data contract
 *
 *   3. STREAM I/O
 *      - safeRead / safeWrite define the *only* legal I/O boundary
 *      - Modules must never JSON.stringify, encode, or write directly
 *      - Backpressure, framing, and transport are handled internally
 *
 *   4. PARAMETERS (CLI / ENV)
 *      - Declared via registerFlag / registerOverride / registerPositionals
 *      - Loaded explicitly via loadCLI()
 *      - Accessed via the returned accessor object
 *
 *   5. CONFIG (JSON files)
 *      - Declared via registerConfigField
 *      - Loaded explicitly via loadConfigFile()
 *      - Accessed via config.get(path, options)
 *
 * These layers are intentionally orthogonal.
 * Confusing them leads to subtle but serious architectural bugs.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ENFORCEMENT RULES
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   • TMCP modules MUST import utilities only from this file
 *   • TMCP modules MUST NOT import from:
 *       - pipeline-config
 *       - pipeline-stream
 *       - pipeline-core
 *       - pipeline-logging
 *     directly
 *
 *   • TMCP modules MUST:
 *       - call loadCLI() before accessing parameters
 *       - call loadConfigFile() before accessing config
 *
 *   • This facade re-exports *capabilities*, not internal structure
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DESIGN INTENT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This file is optimized for:
 *   • correctness over convenience
 *   • explicitness over magic
 *   • long-term maintainability
 *
 * When in doubt:
 *   - assume the separation is intentional
 *   - assume symmetry does NOT imply interchangeability
 *   - re-read the pipeline-config and pipeline-stream headers
 *
 * This file has no logic of its own.
 * Its correctness lies entirely in *what it does not expose*.
 */

//
// ── Logging (module-safe) ───────────────────────────────────────────────────
//
import {
  logError,
  logWarning,
  logWarn,
  logInfo,
  logPrefix
} from "./pipeline-logging.js";

//
// ── Meta & Tag helpers ──────────────────────────────────────────────────────
//
import {
  createMeta,
  appendTag,
} from "./pipeline-core.js";

//
// ── Stream APIs (safeRead / safeWrite / parseLine) ──────────────────────────
//
import {
  safeRead,
  safeWrite,
  parseLine
} from "./pipeline-stream.js";

//
// ── Global configuration registry & accessor ────────────────────────────────
//
import {
  //backwards compatibility:
  registerFlag,
  registerOverride,
  getConfig,

  registerParam,
  registerPositionals,
  registerConfigField,
  loadConfigFile,
  loadCLI
} from "./pipeline-config.js";

//
//
// ── Public facade exports ───────────────────────────────────────────────────
//
export {
  // Logging
  logError,
  logWarning,
  logWarn,
  logInfo,
  logPrefix,

  // Meta / Tagging
  createMeta,
  appendTag,

  // Stream operations
  safeRead,
  safeWrite,
  parseLine,

  // Backwards compatibility
  registerFlag,
  registerOverride,
  getConfig,

  // Global config registry
  registerParam,
  registerPositionals,
  registerConfigField,
  loadConfigFile,
  loadCLI
};
