#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-source-channel.js
 * ----------------------
 * TMCP source that promotes a side-channel (FIFO, file, pipe)
 * to the primary timing/pace-setting stream.
 *
 * New configuration API:
 *   • registerPositionals() for declaring one required argument
 *   • getConfig("positionals.0") for retrieving it
 *
 * No semantic changes.
 */

import {
  appendTag,
  safeWrite,
  safeRead,
  logError,
  logInfo,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  POSITIONAL ARGUMENTS                                                      */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "channel_path",
    "required": true,
    "description": "Promote a side-channel to primary stream; stdin is ignored."
  }
]);

let cli = loadCLI();
const channelPath = cli.get("positionals.channel_path");

/* -------------------------------------------------------------------------- */
/*  MAIN LOGIC                                                                */
/* -------------------------------------------------------------------------- */

const tag = "sch";

logInfo(`tmcp-source-channel: reading from channel "${channelPath}" (stdin ignored)`);

/**
 * Forward one parsed object to stdout.
 */
function forwardObject(obj) {
  if (!obj) return;

  const out = {
    meta: obj.meta ? { ...obj.meta } : {},
    data: obj.data
  };

  appendTag(out.meta, tag);
  safeWrite(out);  // channelId="stdout" inferred
}

/* -------------------------------------------------------------------------- */
/*  safeRead: read from <channelPath>, never from stdin                       */
/* -------------------------------------------------------------------------- */

safeRead(
  forwardObject,
  channelPath,
  {
    channelId: `chan:${channelPath}`,
    exitOnClose: true,   // EOF of channel closes this module
    retry: true          // retry FIFO open if writer missing
  }
);
