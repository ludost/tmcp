#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-source-csv.js
 * ------------------
 * TMCPL CSV source module with optional pacing.
 *
 * New configuration API:
 *   • registerPositionals()
 *   • registerOverride()
 *   • getConfig()
 *
 * Semantics unchanged.
 */

import fs from "fs";
import path from "path";
import readline from "readline";

import {
  safeWrite,
  createMeta,
  logError,
  logInfo,
  registerPositionals,
  registerParam,
  loadConfigFile,
  loadCLI,
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  DECLARE POSITIONALS & OVERRIDES                                           */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "config_file",
    "required": true,
    "description": "Config file containing csvSource field."
  },
  {
    "name": "csv_file",
    "required": true,
    "description": "CSV replay source file."
  }
]);

registerParam({
  longname: "interval-ms",
  envname: "TMCP_INTERVAL_MS",
  default: 0,
  expectsValue: true,
  description: "Emit one record every N milliseconds."
});

registerParam({
  longname: "rate",
  envname: "TMCP_RATE",
  default: 0,
  expectsValue: true,
  description: "Emit R records per second (ignored if interval-ms is set)."
});

/* -------------------------------------------------------------------------- */
/*  LOAD CONFIG                                                               */
/* -------------------------------------------------------------------------- */
let cli = loadCLI();

const {
  delimiter = ",",
  timeColumn = 0,
  timeField = "t_ms",
  fieldMap = {},
  filenameField = "sid"
} = loadConfigFile("positionals.config_file",{ defaultScope: "csvSource"}).csvSource;

/* -------------------------------------------------------------------------- */
/*  PACING: interval-ms or rate                                               */
/* -------------------------------------------------------------------------- */

let intervalMs = Number(cli.get("param.interval-ms"));
const rate     = Number(cli.get("param.rate"));

if (intervalMs > 0) {
  // OK
} else if (rate > 0) {
  intervalMs = 1000 / rate;
} else {
  intervalMs = 0;  // immediate mode
}

/* -------------------------------------------------------------------------- */
/*  TIMING MODEL                                                              */
/* -------------------------------------------------------------------------- */

function parseTimestamp(tsStr) {
  const trimmed = tsStr.trim();
  const parts = trimmed.split(":");
  if (parts.length !== 3) return NaN;

  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const secParts = parts[2].split(".");

  if (secParts.length !== 2) return NaN;

  const s = Number(secParts[0]);
  const ms = Number(secParts[1]);

  if (
    !Number.isFinite(h) ||
    !Number.isFinite(m) ||
    !Number.isFinite(s) ||
    !Number.isFinite(ms)
  ) {
    return NaN;
  }

  return h * 3600000 + m * 60000 + s * 1000 + ms;
}

let t0 = null;
const anchorWallClock = Date.now();

/* -------------------------------------------------------------------------- */
/*  SESSION ID                                                                */
/* -------------------------------------------------------------------------- */
const csvFile    = cli.get("positionals.csv_file");
const sessionId = path.parse(csvFile).name;

/* -------------------------------------------------------------------------- */
/*  CSV INPUT                                                                 */
/* -------------------------------------------------------------------------- */

let rl;
try {
  rl = readline.createInterface({
    input: fs.createReadStream(csvFile, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
} catch (err) {
  logError(`Failed to open CSV file '${csvFile}': ${err.message}`);
  process.exit(1);
}

const splitRegex = /[,\t]/;
const buffer = [];
let doneReading = false;
let timer = null;

function checkExit() {
  if (doneReading && buffer.length === 0) {
    if (intervalMs > 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    process.exit(0);
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const parts = trimmed.split(splitRegex);
  if (parts.length === 0) return;

  const tsStr = parts[timeColumn] ?? "";
  const absoluteMs = parseTimestamp(tsStr);
  if (!Number.isFinite(absoluteMs)) return;

  if (t0 === null) t0 = absoluteMs;
  const tMs = absoluteMs - t0;

  const data = {};
  data[timeField] = tMs;

  for (const [key, col] of Object.entries(fieldMap)) {
    const raw = parts[col];
    if (raw === undefined) continue;
    const v = Number(raw.trim());
    if (Number.isFinite(v)) data[key] = v;
  }

  data[filenameField] = sessionId;

  const meta = createMeta("csvsrc");
  meta.timestamp = anchorWallClock + tMs;

  buffer.push({ meta, data });
});

rl.on("close", () => {
  doneReading = true;
  checkExit();
});

/* -------------------------------------------------------------------------- */
/*  EMISSION                                                                  */
/* -------------------------------------------------------------------------- */

if (intervalMs > 0) {
  // paced mode
  timer = setInterval(() => {
    if (buffer.length > 0) {
      safeWrite(buffer.shift());
    }
    checkExit();
  }, intervalMs);
} else {
  // immediate mode
  const flush = () => {
    while (buffer.length > 0) {
      safeWrite(buffer.shift());
    }
    if (doneReading) process.exit(0);
    setImmediate(flush);
  };
  flush();
}
