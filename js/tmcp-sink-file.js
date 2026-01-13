#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-sink-file.js
 * ------------------
 * TMCP sink that writes each incoming object to a file (append mode).
 *
 * Behavior:
 *   • Reads objects from stdin via safeRead() (NDJSON or msgpack).
 *   • Normalizes objects via parseLine() inside pipeline-utils.
 *   • Appends module tag ("fsnk") unless global tagging is disabled.
 *   • Always writes NDJSON lines to the output file (no msgpack yet).
 */

import fs from "fs";
import {
  appendTag,
  logError,
  logWarn,
  safeRead,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  POSITIONALS                                                               */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "output_file",
    "required": true,
    "description": "Append each incoming TMCP object as NDJSON to <output_file>."
  }
]);

let cli = loadCLI();

const outPath = cli.get("positionals.output_file", null);
if (!outPath) {
  logError("tmcp-sink-file: missing <output_file> positional.");
  process.exit(1);
}

const tag = "fsnk";

/* -------------------------------------------------------------------------- */
/*  File Stream                                                                */
/* -------------------------------------------------------------------------- */

let stream;
try {
  stream = fs.createWriteStream(outPath, { flags: "a" });
} catch (err) {
  logError(`tmcp-sink-file: failed to open file '${outPath}': ${err.message}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  Main Loop via safeRead                                                    */
/* -------------------------------------------------------------------------- */

safeRead((obj) => {
  if (!obj) return;

  appendTag(obj.meta, tag);

  try {
    stream.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    logWarn(`tmcp-sink-file: write error: ${err.message}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

process.on("SIGINT", () => {
  try {
    stream.end(() => process.exit(0));
  } catch {
    process.exit(0);
  }
});
