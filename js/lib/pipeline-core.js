/**
 * lib/pipeline-core.js
 * --------------------
 * Core object helpers shared by all modules.
 *
 * Updated for the unified configuration system:
 *   - TAG_ENABLED is now a registered boolean flag
 *   - No module is allowed to import protocol or low-level config
 *   - All global settings come through loadCLI()
 *
 * No semantic changes to normalizeObject / createMeta / appendTag.
 */

import { registerParam, loadCLI } from "./pipeline-config.js";

/* ------------------------------------------------------------------------- */
/* Register global tag flag                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Tagging is now a standard boolean flag:
 *   --do-tag / --no-do-tag
 *   env: TMCP_DO_TAG
 *
 * Default remains `true` (preserves existing behavior).
 */
registerParam({
  longname: "do-tag",
  envname: "TMCP_DO_TAG",
  default: true,
  description: "Enable or disable pipeline tag annotations."
});

let cli = loadCLI()
/* Small helper: resolved tag-enabled state */
function tagEnabled() {
  return cli.get("param.do-tag") === true;
}

/* ------------------------------------------------------------------------- */
/* Core Pipeline Object Helpers                                              */
/* ------------------------------------------------------------------------- */

/**
 * normalizeObject:
 *   Ensures any JS value becomes a canonical pipeline object:
 *     {
 *       meta: { timestamp?, pipeline: [] },
 *       data: { ... }
 *     }
 */
export function normalizeObject(value) {
  let obj = value;

  if (typeof obj !== "object" || obj === null) {
    obj = { meta: {}, data: { value: obj } };
  }

  if (!obj.meta || typeof obj.meta !== "object") {
    obj.meta = {};
  }
  if (!obj.data || typeof obj.data !== "object") {
    obj.data = {};
  }
  if (!Array.isArray(obj.meta.pipeline)) {
    obj.meta.pipeline = [];
  }

  return obj;
}

/**
 * createMeta(tag):
 *   Produces a fresh meta block with timestamp and pipeline tag.
 */
export function createMeta(tag) {
  return {
    timestamp: Date.now(),
    pipeline: tagEnabled() ? [tag] : []
  };
}

/**
 * appendTag(meta, tag):
 *   Append a tag to the pipeline-internal trace.
 *   No-op when tagging is disabled.
 */
export function appendTag(meta, tag) {
  if (!tagEnabled()) return;
  if (!meta || typeof meta !== "object") return;

  if (!Array.isArray(meta.pipeline)) {
    meta.pipeline = [];
  }
  meta.pipeline.push(tag);
}
