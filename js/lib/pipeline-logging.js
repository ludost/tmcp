/**
 * lib/pipeline-logging.js
 * -----------------------
 * Common logging + pipeline statistics.
 *
 * Uses the central configuration system:
 *   • Flags and overrides registered here
 *
 * No semantic changes to logging behavior.
 */

import path from "path";
import { registerParam, loadCLI } from "./pipeline-config.js";

/* ------------------------------------------------------------------------- */
/* Flag + Override Registration                                              */
/* ------------------------------------------------------------------------- */

/**
 * LOG LEVEL override
 *   --verbose-log-level <none|error|warn|info>
 *   env: TMCP_VERBOSE_LOG_LEVEL
 *   default: "warn"
 */
registerParam({
  longname: "verbose-log-level",
  envname: "TMCP_VERBOSE_LOG_LEVEL",
  default: "warn",
  description: "Global logging level for TMCP modules. ('none','error','warn','info')"
});

/**
 * Verbose flags
 *   --verbose / --no-verbose
 *   --verbose-input / --no-verbose-input
 *   --verbose-output / --no-verbose-output
 */
registerParam({
  longname: "verbose",
  envname: "TMCP_VERBOSE",
  default: false,
  generateNegative: true,
  description: "Enable verbose aggregated pipeline stats."
});

registerParam({
  longname: "verbose-input",
  envname: "TMCP_VERBOSE_INPUT",
  default: false,
  generateNegative: true,
  description: "Log every decoded input object."
});

registerParam({
  longname: "verbose-output",
  envname: "TMCP_VERBOSE_OUTPUT",
  default: false,
  generateNegative: true,
  description: "Log every encoded output object."
});

let cli = loadCLI()

/* ------------------------------------------------------------------------- */
/* Resolved Configuration Accessors                                          */
/* ------------------------------------------------------------------------- */

function getLogLevel() {
  return cli.get("param.verbose-log-level") ?? "warn";
}

function verboseEnabled() {
  return cli.get("param.verbose") === true;
}

function verboseInputEnabled() {
  return cli.get("param.verbose-input") === true;
}

function verboseOutputEnabled() {
  return cli.get("param.verbose-output") === true;
}

/* ------------------------------------------------------------------------- */
/* Prefix                                                                    */
/* ------------------------------------------------------------------------- */

export const logPrefix =
  path.basename(process.argv[1] || "unknown") +
  "(" + (process.argv[2] || "no-conf") + ")";

/* ------------------------------------------------------------------------- */
/* Logging API                                                               */
/* ------------------------------------------------------------------------- */

export function logError(msg) {
  const lvl = getLogLevel();
  if (lvl === "none") return;
  console.error(`[${logPrefix}] ERROR: ${msg}`);
}

export function logWarning(msg) {
  const lvl = getLogLevel();
  if (lvl === "none" || lvl === "error") return;
  console.error(`[${logPrefix}] WARN: ${msg}`);
}
export const logWarn = logWarning;

export function logInfo(msg) {
  const lvl = getLogLevel();
  if (lvl !== "info") return;
  console.error(`[${logPrefix}] ${msg}`);
}

/* ------------------------------------------------------------------------- */
/* Verbose Tick (unchanged behavior)                                         */
/* ------------------------------------------------------------------------- */

let verboseCount = 0;
let verboseDelaySum = 0;
let verboseDelayCount = 0;
let lastPipeline = "(none)";
let lastWindowStart = Date.now();

if (verboseEnabled()) {
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastWindowStart;
    if (elapsed <= 0) return;

    const rate = (verboseCount * 1000) / elapsed;
    const avgDelay =
      verboseDelayCount > 0
        ? (verboseDelaySum / verboseDelayCount).toFixed(1)
        : "n/a";

    console.error(
      `[${logPrefix}] rate: ${rate.toFixed(2)} msg/s, avg delay: ${avgDelay} ms, last pipeline: ${lastPipeline}`
    );

    verboseCount = 0;
    verboseDelaySum = 0;
    verboseDelayCount = 0;
    lastWindowStart = now;
  }, 1000);

  process.on("exit", () => clearInterval(timer));
}

export function verboseTick(obj) {
  if (!verboseEnabled() || !obj?.meta) return;

  verboseCount++;

  if (typeof obj.meta.timestamp === "number") {
    verboseDelaySum += (Date.now() - obj.meta.timestamp);
    verboseDelayCount++;
  }

  if (Array.isArray(obj.meta.pipeline) && obj.meta.pipeline.length > 0) {
    lastPipeline = obj.meta.pipeline.join("→");
  }
}

/* ------------------------------------------------------------------------- */
/* Export verbose-mode helpers                                               */
/* ------------------------------------------------------------------------- */

export {
  verboseInputEnabled as verboseInput,
  verboseOutputEnabled as verboseOutput
};
