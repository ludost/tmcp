#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-control-split-streams.js
 * ------------------------------
 * TMCP “split” primitive: multi-channel non-blocking side-channel tee.
 *
 * Updated to new TMCP configuration API:
 *   • Positionals define side-channel output paths.
 *   • No CLI parsing via process.argv.
 *   • Behavior unchanged.
 *
 * Semantics:
 *   • stdin drives the pipeline (safeRead channelId="stdin").
 *   • stdout gets the normal stream.
 *   • All side-channels are written independently, non-blocking,
 *     with retry=true and exitOnClose=false.
 */

import fs from "fs";
import {
  safeRead,
  safeWrite,
  appendTag,
  logInfo,
  logWarn,
  logError,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

const TAG = "spl";

/* ------------------------------------------------------------------------- */
/*  POSITIONALS (side channel paths)                                         */
/* ------------------------------------------------------------------------- */

/**
 * Positional schema:
 *   positionals[0..N] = <side_path>
 *
 * At least one side-path is required; additional ones are allowed (variadic).
 */
registerPositionals([
  {
    name: "side_path",
    required: true,
    varargs: true,
    description:
      "One or more side-channel output paths (FIFO or regular file)."
  }
]);

let cli = loadCLI();

const sidePaths = cli.get("positionals");
if (!Array.isArray(sidePaths) || sidePaths.length === 0) {
  logError(
    "tmcp-control-split-streams: requires at least one side-channel positional argument."
  );
  process.exit(1);
}

/* ------------------------------------------------------------------------- */
/*  Per-channel setup                                                        */
/* ------------------------------------------------------------------------- */

const RETRY_MS = 500;

const channels = sidePaths.map((path, index) => ({
  path,
  fd: null,
  retryTimer: null,
  channelId: `side:${index}`
}));

function ensureSidePath(path) {
  try {
    fs.statSync(path);
    return;
  } catch (err) {
    if (err.code === "ENOENT") {
      try {
        fs.writeFileSync(path, "", { mode: 0o644 });
        logWarn(
          `Side-channel path ${path} did not exist; created regular file (0644).`
        );
      } catch (e) {
        logError(`Failed to create side-channel file ${path}: ${e.message}`);
        process.exit(1);
      }
      return;
    }
    logError(`Cannot stat ${path}: ${err.message}`);
    process.exit(1);
  }
}

function tryOpenChannel(ch) {
  if (ch.retryTimer) return;

  try {
    ch.fd = fs.openSync(
      ch.path,
      fs.constants.O_RDWR | fs.constants.O_NONBLOCK
    );
    ch.retryTimer = null;
    logInfo(`Opened side channel ${ch.path}`);
  } catch (err) {
    if (err.code === "ENXIO") {
      ch.retryTimer = setTimeout(() => {
        ch.retryTimer = null;
        tryOpenChannel(ch);
      }, RETRY_MS);
      ch.fd = null;
      return;
    }

    logWarn(`Failed to open side-channel ${ch.path}: ${err.message}`);
    ch.fd = null;
  }
}

function writeSide(ch, obj) {
  if (ch.fd === null) return;

  try {
    safeWrite(obj, ch.fd, {
      channelId: ch.channelId,
      retry: true,         // FIFO may lack reader temporarily
      exitOnClose: false   // FIFO closure never terminates module
    });
  } catch (err) {
    logWarn(`Unexpected side write error (${ch.path}): ${err.message}`);
  }
}

/* ------------------------------------------------------------------------- */
/*  Initialize all side-channel FDs                                          */
/* ------------------------------------------------------------------------- */

for (const ch of channels) {
  ensureSidePath(ch.path);
  tryOpenChannel(ch);
}

/* ------------------------------------------------------------------------- */
/*  Main stream: read stdin, copy to stdout + all side-channels              */
/* ------------------------------------------------------------------------- */

safeRead(
  (obj) => {
    appendTag(obj.meta, TAG);

    // Main pipeline output → stdout
    safeWrite(obj, undefined, {
      // Defaults: channelId="stdout", exitOnClose=true
    });

    // Side-channel outputs
    for (const ch of channels) writeSide(ch, obj);
  },
  undefined,
  {
    channelId: "stdin",
    // exitOnClose defaults to true for stdin → pipeline dies if upstream does
  }
);
