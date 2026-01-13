#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-sink-csv.js
 * -----------------
 * TMCPL CSV sink module.
 *
 * Enhancements:
 *   • filenamePrefix: prefix applied before <filenameField> when generating filenames.
 *   • truncateOnOpen: when true, output files are truncated on first open (flags="w")
 *                     instead of appended (flags="a").
 *
 * Resulting filename:
 *   <outputDir>/<filenamePrefix><filenameField>.csv
 */

import fs from "fs";
import path from "path";
import {
  safeRead,
  loadConfigFile,
  logError,
  logInfo,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  POSITIONALS                                                               */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "config_file",
    "required": true,
    "description": "Write incoming TMCP messages to CSV files based on a config-mapped schema."
  }
]);

/* -------------------------------------------------------------------------- */
/*  Load config                                                                */
/* -------------------------------------------------------------------------- */
let cli = loadCLI();
const config = loadConfigFile("positionals.config_file", { defaultScope: "csvSink"});

if (!config.csvSink) {
  logError("Missing required 'csvSink' section in config.");
  process.exit(1);
}

const {
  filenameField = "sid",
  filenameDefault = "unknown",
  filenamePrefix = "",
  truncateOnOpen = false,
  columns = {},
  outputDir = "."
} = config.csvSink;

/* -------------------------------------------------------------------------- */
/*  Validate column mapping                                                    */
/* -------------------------------------------------------------------------- */

const columnEntries = Object.entries(columns);
if (columnEntries.length === 0) {
  logError("csvSink.columns mapping is empty; at least one column is required.");
  process.exit(1);
}

let maxColumnIndex = -1;
for (const [fieldName, idx] of columnEntries) {
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0) {
    logError(`csvSink.columns['${fieldName}'] must be a non-negative integer index.`);
    process.exit(1);
  }
  if (n > maxColumnIndex) maxColumnIndex = n;
}
const rowWidth = maxColumnIndex + 1;

/* -------------------------------------------------------------------------- */
/*  Ensure output directory exists                                             */
/* -------------------------------------------------------------------------- */

try {
  fs.mkdirSync(outputDir, { recursive: true });
} catch (err) {
  logError(`Failed to create output directory '${outputDir}': ${err.message}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  CSV formatting helper                                                      */
/* -------------------------------------------------------------------------- */

function toCsvRow(values) {
  return values
    .map((v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (
        s.includes('"') ||
        s.includes(",") ||
        s.includes("\n") ||
        s.includes("\r")
      ) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(",");
}

/* -------------------------------------------------------------------------- */
/*  File management                                                            */
/* -------------------------------------------------------------------------- */

const writers = new Map();

function getWriterForSid(sid) {
  let writer = writers.get(sid);
  if (writer) return writer;

  const filename = `${filenamePrefix}${sid}.csv`;
  const fullPath = path.join(outputDir, filename);

  const flags = truncateOnOpen ? "w" : "a";

  try {
    writer = fs.createWriteStream(fullPath, { flags });
  } catch (err) {
    logError(`Failed to open CSV file '${fullPath}': ${err.message}`);
    return null;
  }

  writers.set(sid, writer);

  logInfo(
    `tmcp-sink-csv: opening CSV sink sid='${sid}' → '${fullPath}'` +
      (truncateOnOpen ? " (truncate)" : " (append)")
  );

  return writer;
}

function closeAllWriters() {
  for (const [sid, writer] of writers.entries()) {
    try {
      writer.end();
    } catch {}
    logInfo(`tmcp-sink-csv: closed CSV sink for sid='${sid}'`);
  }
  writers.clear();
}

/* -------------------------------------------------------------------------- */
/*  Main handler                                                               */
/* -------------------------------------------------------------------------- */

safeRead((record) => {
  if (!record || typeof record !== "object") return;

  const data = record.data || {};
  let sidValue = data[filenameField];

  if (sidValue === undefined || sidValue === null || String(sidValue) === "") {
    sidValue = filenameDefault;
  }

  const sid = String(sidValue);
  const writer = getWriterForSid(sid);
  if (!writer) return;

  const row = new Array(rowWidth).fill("");

  for (const [fieldName, colIndexRaw] of columnEntries) {
    const colIndex = Number(colIndexRaw);
    const value = data[fieldName];
    if (value === undefined || value === null) continue;
    row[colIndex] = value;
  }

  writer.write(toCsvRow(row) + "\n");
});

/* -------------------------------------------------------------------------- */
/*  Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

process.stdin.on("end", () => {
  closeAllWriters();
  process.exit(0);
});

process.stdin.on("error", (err) => {
  logError(`stdin error: ${err.message}`);
  closeAllWriters();
  process.exit(1);
});
