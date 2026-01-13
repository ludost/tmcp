#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-sink-channel.js
 * ---------------------
 * TMCPL sink module that forwards every received message to a FIFO or file.
 *
 *   • Reads full TMCP NDJSON from stdin via safeRead().
 *   • Adds its pipeline tag ("chs").
 *   • Writes full {meta, data} objects to a specified FIFO/file.
 *   • Never forwards anything to stdout.
 *
 * Notes:
 *   – Never blocks pipeline pace.
 *   – Write errors are logged, not fatal.
 *   – FIFO open is write-only; missing reader yields EPIPE warnings but no exit.
 */

import fs from "fs";
import {
  appendTag,
  safeRead,
  logError,
  logWarn,
  logInfo,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

const TAG = "chs";

/* ------------------------------------------------------------------------- */
/*  POSITIONALS                                                               */
/* ------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "fifo_path",
    "required": true,
    "description": "Write all received pipeline objects to a FIFO/file as NDJSON"
  }
]);

let cli = loadCLI();

const fifoPath = cli.get("positionals.fifo_path");

/* ------------------------------------------------------------------------- */
/*  FIFO HANDLE                                                               */
/* ------------------------------------------------------------------------- */

let fifoStream = null;

try {
  fifoStream = fs.createWriteStream(fifoPath, {
    flags: "w",
    encoding: "utf8",
    autoClose: false
  });

  fifoStream.on("error", (err) => {
    logWarn(`tmcp-sink-channel: write error: ${err.message}`);
  });

  fifoStream.on("close", () => {
    logWarn("tmcp-sink-channel: FIFO was closed by downstream reader");
  });

  logInfo(`tmcp-sink-channel: opened ${fifoPath} for writing`);
} catch (err) {
  logError(`tmcp-sink-channel: unable to open FIFO: ${err.message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------------- */
/*  FORWARDING                                                               */
/* ------------------------------------------------------------------------- */

function forwardToFifo(obj) {
  if (!obj) return;

  try {
    appendTag(obj.meta, TAG);
    fifoStream.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    logWarn(`tmcp-sink-channel: failed to write: ${err.message}`);
  }
}

/* ------------------------------------------------------------------------- */
/*  MAIN LOOP                                                                 */
/* ------------------------------------------------------------------------- */

safeRead((obj) => {
  forwardToFifo(obj);
});

// Pure sink: nothing is sent to stdout.
