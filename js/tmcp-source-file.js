#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-source-file.js
 * -------------------
 * NDJSON replay source (TMCPL "source" module).
 *
 * Pausing semantics, EOF semantics, and timing behavior unchanged.
 */

import fs from "fs";
import readline from "readline";
import {
  parseLine,
  appendTag,
  safeWrite,
  safeRead,
  logError,
  logInfo,
  registerPositionals,
  registerParam,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  DECLARE POSITIONALS & OVERRIDES                                           */
/* -------------------------------------------------------------------------- */

registerParam({
  longname: "interval-ms",
  envname: "TMCP_INTERVAL_MS",
  default: 100,
  expectsValue: true,
  description: "Replay pacing in milliseconds (default 100)."
});

registerParam({
  longname: "pausing",
  envname: "TMCP_PAUSING",
  default: false,
  generateNegative: true,
  description: "Enable pausing mode; stdin becomes a pause/unpause side-channel."
});

registerParam({
  longname: "exit-on-eof",
  envname: "TMCP_EXIT_ON_EOF",
  default: false,
  generateNegative: true,
  description: "If true, exit immediately after last unpaused record."
});

registerPositionals([
  {
    "name": "replay_file",
    "required": true,
    "description": "NDJSON file replay source with optional pausing control channel."
  }
]);

/* -------------------------------------------------------------------------- */
/*  LOAD CONFIG                                                               */
/* -------------------------------------------------------------------------- */
let cli=loadCLI();

const replayPath = cli.get("positionals.replay_file");

const pausedIntervalMs = cli.get("param.interval-ms");
const pausingMode      = cli.get("param.pausing");
const exitOnEof        = cli.get("param.exitOnEof");

const tag = "fsp";

/* -------------------------------------------------------------------------- */
/*  STATE                                                                     */
/* -------------------------------------------------------------------------- */

const fileRecords = [];
let fileLoaded = false;

let paused = false;
let eof = false;
let nextIdx = 0;
let lastFileTsEmitted = null;
let lastSentMsg = null;

let timer = null;

/* -------------------------------------------------------------------------- */
/*  HELPERS                                                                   */
/* -------------------------------------------------------------------------- */

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function emitRecord(rec) {
  const out = {
    meta: { ...(rec.meta || {}), timestamp: Date.now() },
    data: structuredClone(rec.data),
  };

  appendTag(out.meta, tag);
  safeWrite(out);

  lastSentMsg = out;
  lastFileTsEmitted = rec.ts;

  if (pausingMode) paused = true;
}

function emitPausedClone() {
  if (!lastSentMsg) return;

  const clone = structuredClone(lastSentMsg);
  clone.meta.timestamp = Date.now();
  appendTag(clone.meta, tag);
  safeWrite(clone);
}

function schedulePausedTick() {
  clearTimer();
  timer = setTimeout(() => {
    emitPausedClone();
    schedulePausedTick();
  }, pausedIntervalMs);
}

function scheduleNextFileEmission(afterMs) {
  if (!fileLoaded) return;

  clearTimer();
  timer = setTimeout(() => {

    if (eof) {
      if (pausingMode) return schedulePausedTick();
      return process.exit(0);
    }

    if (pausingMode && paused) return schedulePausedTick();

    if (nextIdx >= fileRecords.length) {
      eof = true;
      if (pausingMode) return schedulePausedTick();
      return process.exit(0);
    }

    const rec = fileRecords[nextIdx++];
    emitRecord(rec);

    if (nextIdx >= fileRecords.length) {
      eof = true;
      if (pausingMode) return schedulePausedTick();
      return process.exit(0);
    }

    const nr = fileRecords[nextIdx];
    const delta = Math.max(0, nr.ts - lastFileTsEmitted);
    scheduleNextFileEmission(delta);

  }, Math.max(0, afterMs));
}

function startOrResumePlayback() {
  if (!fileLoaded) return;

  if (eof) {
    if (pausingMode) return schedulePausedTick();
    return process.exit(0);
  }

  if (nextIdx >= fileRecords.length) {
    eof = true;
    if (pausingMode) return schedulePausedTick();
    return process.exit(0);
  }

  if (lastFileTsEmitted === null) {
    const first = fileRecords[nextIdx++];
    emitRecord(first);

    if (nextIdx >= fileRecords.length) {
      eof = true;
      if (pausingMode) return schedulePausedTick();
      return process.exit(0);
    }

    const nr = fileRecords[nextIdx];
    const delta = Math.max(0, nr.ts - lastFileTsEmitted);
    scheduleNextFileEmission(delta);
  } else {
    const nr = fileRecords[nextIdx];
    const delta = Math.max(0, nr.ts - lastFileTsEmitted);
    scheduleNextFileEmission(delta);
  }
}

/* -------------------------------------------------------------------------- */
/*  LOAD REPLAY FILE                                                          */
/* -------------------------------------------------------------------------- */

const rl = readline.createInterface({
  input: fs.createReadStream(replayPath),
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const obj = parseLine(line);
  if (!obj) return;

  const ts = obj.meta?.timestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return;

  fileRecords.push({ ts, meta: obj.meta, data: obj.data });
});

rl.on("close", () => {
  fileLoaded = true;
  logInfo(`tmcp-source-file: loaded ${fileRecords.length} records from ${replayPath}`);

  if (fileRecords.length === 0) {
    eof = true;
    if (pausingMode) return schedulePausedTick();
    return process.exit(0);
  }

  fileRecords.sort((a, b) => a.ts - b.ts);

  if (!pausingMode) {
    startOrResumePlayback();
    return;
  }

  const first = fileRecords[nextIdx++];
  emitRecord(first);

  if (nextIdx >= fileRecords.length) eof = true;
  schedulePausedTick();
});

/* -------------------------------------------------------------------------- */
/*  CONTROL CHANNEL (stdin → pause/unpause)                                   */
/* -------------------------------------------------------------------------- */

if (pausingMode) {
  safeRead(
    (obj) => {
      if (!obj) return;

      const ctrl = obj?.data?.paused;
      if (typeof ctrl !== "boolean") return;
      if (ctrl === paused) return;

      paused = ctrl;
      clearTimer();

      if (paused) {
        if (!lastSentMsg && fileLoaded && nextIdx < fileRecords.length) {
          const prime = fileRecords[nextIdx++];
          emitRecord(prime);
          if (nextIdx >= fileRecords.length) eof = true;
        }
        schedulePausedTick();
      } else {
        if (fileLoaded && lastSentMsg && eof && exitOnEof) {
          return process.exit(0);
        }
        startOrResumePlayback();
      }
    },
    undefined,
    {
      channelId: "stdin",
      exitOnClose: false,
      retry: false
    }
  );
}
