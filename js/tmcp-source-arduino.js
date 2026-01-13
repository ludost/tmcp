#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-source-arduino.js
 * ----------------------
 * TMCPL NDJSON source for delimited sensor data from an Arduino.
 *
 * Updated for new TMCP configuration API:
 *   • registerPositionals() drives CLI validation
 *   • getConfig() used instead of process.argv
 *   • loadConfigFile() replaces old loadConfig()
 *
 * No semantic changes.
 */

import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

import {
  loadConfigFile,
  createMeta,
  safeWrite,
  logInfo,
  logError,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  CONFIG REGISTRATION                                                        */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    "name": "config_file",
    "required": true,
    "description": "Config file"
  },
  {
    "name": "serial_port",
    "required": true,
    "description": "Serial device file path"
  }
]);

/* -------------------------------------------------------------------------- */
/*  RESOLVE POSITIONALS + LOAD CONFIG FILE                                    */
/* -------------------------------------------------------------------------- */
let cli = loadCLI();

const tag = "asrc";

let cfg = loadConfigFile("positionals.config_file", { defaultScope: "arduinoSource" });
const srcCfg = cfg.arduinoSource || {};
const baud = srcCfg.baudRate || 9600;
const fieldMap = srcCfg.fieldMap || {};
const enableFilterUpload = srcCfg.enableFilterUpload ?? true;
const handshakeRetries = srcCfg.handshakeRetries ?? 3;

/* -------------------------------------------------------------------------- */
/*  SERIAL PORT SETUP                                                          */
/* -------------------------------------------------------------------------- */
const portPath = cli.get("positionals.serial_port");
const port = new SerialPort({ path: portPath, baudRate: baud });
const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

let activeFilterApplied = false;
let pausedAck = false;
let pauseAttempts = 0;
let handshakeComplete = false;

port.on("open", () => {
  logInfo(`Connected: ${portPath} @ ${baud} baud`);
  if (enableFilterUpload && Object.keys(fieldMap).length > 0) {
    setTimeout(startFilterHandshake, 150);
  }
});

port.on("error", (err) => {
  logError(`Serial error: ${err.message}`);
});

/* -------------------------------------------------------------------------- */
/*  FILTER HANDSHAKE                                                           */
/* -------------------------------------------------------------------------- */

function startFilterHandshake() {
  logInfo("Initiating filter handshake...");
  sendPauseCommand();
}

function sendPauseCommand() {
  if (handshakeComplete || pauseAttempts >= handshakeRetries) return;

  pauseAttempts++;
  const delay = 10 + Math.floor(Math.random() * 90);
  setTimeout(() => {
    if (handshakeComplete) return;
    logInfo(`Sending # (pause) attempt ${pauseAttempts}/${handshakeRetries}`);
    port.write("#\n");
  }, delay);
}

function sendFilterDefinition() {
  const indices = Object
    .values(fieldMap)
    .filter(v => typeof v === "number" && !isNaN(v))
    .map(v => Math.floor(v));

  if (indices.length === 0) return;

  const cmd = `#FILTER ${indices.join(",")} @\n`;
  logInfo(`Uploading ${indices.length} filter indices.`);
  logInfo(`Command: ${cmd.trim()}`);
  port.write(cmd);
}

/* -------------------------------------------------------------------------- */
/*  MAIN DATA LOOP                                                             */
/* -------------------------------------------------------------------------- */

parser.on("data", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  /* ---- Handshake messages ---- */

  if (trimmed === "#PAUSED") {
    pausedAck = true;
    handshakeComplete = true;
    logInfo("Device paused. Sending filter definition...");
    sendFilterDefinition();
    return;
  }

  if (trimmed.startsWith("#FILTER-OK")) {
    activeFilterApplied = true;
    handshakeComplete = true;
    logInfo("Filter acknowledged by device. Resuming stream...");
    port.write("#CONTINUE\n");
    return;
  }

  if (trimmed === "#CONTINUE-OK") {
    pausedAck = false;
    logInfo("Device resumed streaming.");
    return;
  }

  if (!handshakeComplete && enableFilterUpload && pauseAttempts < handshakeRetries) {
    sendPauseCommand();
    return;
  }

  if (trimmed.startsWith("#")) return;

  /* ---- NDJSON decode ---- */

  const parts = trimmed
    .replace(/\r/g, "")
    .trim()
    .split(",")
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const data = {};

  if (activeFilterApplied) {
    const labels = Object.keys(fieldMap);
    const n = Math.min(labels.length, parts.length);
    for (let i = 0; i < n; i++) {
      const val = parseInt(parts[i], 10);
      if (!isNaN(val)) data[labels[i]] = val;
    }
  } else {
    for (const [label, idx] of Object.entries(fieldMap)) {
      const val = parseInt(parts[idx], 10);
      if (!isNaN(val)) data[label] = val;
    }
  }

  const obj = { meta: createMeta(tag), data };
  safeWrite(obj);
});

/* -------------------------------------------------------------------------- */
/*  SHUTDOWN                                                                   */
/* -------------------------------------------------------------------------- */

process.on("SIGINT", () => {
  logInfo("Closing serial port...");
  port.close(() => process.exit(0));
});
