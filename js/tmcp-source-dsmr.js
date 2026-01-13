#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-source-dsmr.js
 * ------------------
 * TMCP source module for DSMR (Dutch smart meter) P1 telegrams.
 *
 * Emits one TMCP-normalized NDJSON message per complete telegram:
 *   { meta: { timestamp: 0, tag: "dsmr" }, data: { grid_import_w: 0 } }
 *
 * CLI:
 *   tmcp-source-dsmr <config_file> [serial_port]
 *
 * Config (in <config_file>):
 *   {
 *     "dsmrSource": {
 *       "device": "/dev/ttyUSB0",
 *       "baudRate": 115200,
 *       "parity": "none",
 *       "dataBits": 8,
 *       "stopBits": 1,
 *       "lineDelimiter": "\n",
 *       "sendRequestOnConnect": false,
 *       "requestString": "/?!\r\n",
 *       "controlLines": { "dtr": true, "rts": true },
 *
 *       "crcCheck": false,
 *       "emitRawTelegram": false,
 *       "emitObisMap": true,
 *       "minEmitIntervalMs": 0,
 *
 *       "extract": {
 *         "grid_import_w": { "obis": "1-0:1.7.0", "group": 0, "as": "number", "targetUnit": "W" },
 *         "grid_export_w": { "obis": "1-0:2.7.0", "group": 0, "as": "number", "targetUnit": "W" },
 *         "meter_timestamp": { "obis": "0-0:1.0.0", "group": 0, "as": "timestamp" }
 *       }
 *     }
 *   }
 *
 * Notes:
 *   • This module keeps domain semantics out of code by making field extraction
 *     configurable (OBIS-to-field mapping).
 *   • CRC checking is optional and defaults to off because P1 adapters/meter
 *     variants can differ in framing/CRC conventions.
 */

import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

import {
  loadConfigFile,
  createMeta,
  appendTag,
  safeWrite,
  logInfo,
  logWarn,
  logError,
  registerPositionals,
  loadCLI
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  POSITIONALS                                                               */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to DSMR source configuration JSON."
  },
  {
    name: "serial_port",
    required: false,
    description: "Optional serial device path override (default from config or /dev/ttyUSB0)."
  }
]);

let cli = loadCLI();

const cfg = loadConfigFile("positionals.config_file", { defaultScope: "dsmrSource" });
const srcCfg = cfg.dsmrSource || {};

const deviceOverride = cli.get("positions.serial_port");

const tag = "dsmr";

/* -------------------------------------------------------------------------- */
/*  CONFIG RESOLUTION                                                         */
/* -------------------------------------------------------------------------- */

const device = deviceOverride || srcCfg.device || "/dev/ttyUSB0";

const baudRate = Number(srcCfg.baudRate ?? 115200);
const parity = String(srcCfg.parity ?? "none");
const dataBits = Number(srcCfg.dataBits ?? 8);
const stopBits = Number(srcCfg.stopBits ?? 1);

const lineDelimiter = srcCfg.lineDelimiter ?? "\n";

const sendRequestOnConnect = Boolean(srcCfg.sendRequestOnConnect ?? false);
const requestString = String(srcCfg.requestString ?? "/?!\r\n");
const controlLines = (srcCfg.controlLines && typeof srcCfg.controlLines === "object")
  ? srcCfg.controlLines
  : null;

const crcCheck = Boolean(srcCfg.crcCheck ?? false);
const emitRawTelegram = Boolean(srcCfg.emitRawTelegram ?? false);
const emitObisMap = Boolean(srcCfg.emitObisMap ?? true);
const minEmitIntervalMs = Number(srcCfg.minEmitIntervalMs ?? 0);

const extractCfg = (srcCfg.extract && typeof srcCfg.extract === "object") ? srcCfg.extract : null;

/* -------------------------------------------------------------------------- */
/*  DEFAULT EXTRACTION                                                        */
/* -------------------------------------------------------------------------- */

const defaultExtract = {
  grid_import_w:   { obis: "1-0:1.7.0", group: 0, as: "number", targetUnit: "W" },
  grid_export_w:   { obis: "1-0:2.7.0", group: 0, as: "number", targetUnit: "W" },
  meter_timestamp: { obis: "0-0:1.0.0", group: 0, as: "timestamp" },
};

const effectiveExtract = extractCfg || defaultExtract;

/* -------------------------------------------------------------------------- */
/*  SERIAL PORT SETUP                                                         */
/* -------------------------------------------------------------------------- */

const port = new SerialPort({
  path: device,
  baudRate,
  parity,
  dataBits,
  stopBits,
  autoOpen: true
});

const parser = port.pipe(new ReadlineParser({ delimiter: lineDelimiter }));

port.on("open", async () => {
  logInfo(`connected to ${device} @ ${baudRate} (${dataBits}${(parity[0] || "n").toUpperCase()}${stopBits})`);

  if (controlLines) {
    try {
      const ctl = {};
      if (typeof controlLines.dtr === "boolean") ctl.dtr = controlLines.dtr;
      if (typeof controlLines.rts === "boolean") ctl.rts = controlLines.rts;
      if (Object.keys(ctl).length > 0) {
        await port.set(ctl);
        logInfo(`applied control lines: ${JSON.stringify(ctl)}`);
      }
    } catch (err) {
      logWarn(`failed to apply control lines: ${String(err.message || err)}`);
    }
  }

  if (sendRequestOnConnect) {
    try {
      port.write(requestString);
      logInfo("request string sent to meter");
    } catch (err) {
      logWarn(`failed to send request string: ${String(err.message || err)}`);
    }
  }
});

port.on("error", (err) => {
  logError(`serial error: ${String(err.message || err)}`);
});

port.on("close", () => {
  logWarn("serial port closed");
});

/* -------------------------------------------------------------------------- */
/*  TELEGRAM ACCUMULATION                                                     */
/* -------------------------------------------------------------------------- */

let collecting = false;
let telegramLines = [];
let lastEmitTs = 0;

parser.on("data", (line) => {
  const rawLine = String(line ?? "");
  const trimmed = rawLine.replace(/\r/g, "").trimEnd();

  if (!trimmed) return;

  if (trimmed.startsWith("/")) {
    collecting = true;
    telegramLines = [trimmed];
    return;
  }

  if (!collecting) return;

  telegramLines.push(trimmed);

  if (trimmed.startsWith("!")) {
    collecting = false;
    const lines = telegramLines;
    telegramLines = [];
    handleTelegram(lines);
  }
});

/* -------------------------------------------------------------------------- */
/*  PARSING                                                                   */
/* -------------------------------------------------------------------------- */

function parseNumericWithUnit(valueStr) {
  const s = String(valueStr ?? "").trim();
  if (!s) return null;

  const starIdx = s.indexOf("*");
  const numPart = (starIdx >= 0) ? s.slice(0, starIdx) : s;
  const unitPart = (starIdx >= 0) ? s.slice(starIdx + 1) : null;

  const num = Number(numPart);
  if (Number.isNaN(num)) return null;

  return { value: num, unit: unitPart ? String(unitPart) : null };
}

function parseDsmrTimestamp(ts) {
  const s = String(ts ?? "").trim();
  if (!/^\d{12}[SW]$/.test(s)) return null;

  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  const hh = Number(s.slice(6, 8));
  const mi = Number(s.slice(8, 10));
  const ss = Number(s.slice(10, 12));
  const season = s.slice(12, 13);

  const year = 2000 + yy;
  const offset = (season === "S") ? "+02:00" : "+01:00";

  const pad2 = (n) => String(n).padStart(2, "0");
  return `${year}-${pad2(mm)}-${pad2(dd)}T${pad2(hh)}:${pad2(mi)}:${pad2(ss)}${offset}`;
}

function parseObisLines(lines) {
  const obis = {};

  for (const line of lines) {
    const s = String(line ?? "").trim();
    if (!s) continue;

    if (s.startsWith("/")) continue;
    if (s.startsWith("!")) continue;

    const firstParen = s.indexOf("(");
    if (firstParen <= 0) continue;

    const key = s.slice(0, firstParen).trim();
    if (!key) continue;

    const groups = [];
    const re = /\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      groups.push(m[1]);
    }
    if (groups.length === 0) continue;

    obis[key] = groups;
  }

  return obis;
}

/* -------------------------------------------------------------------------- */
/*  OPTIONAL CRC16 (best-effort)                                              */
/* -------------------------------------------------------------------------- */

function crc16Arc(buf) {
  let crc = 0x0000;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      const lsb = crc & 1;
      crc >>= 1;
      if (lsb) crc ^= 0xA001;
    }
  }
  return crc & 0xFFFF;
}

function tryValidateCrc(lines) {
  const endLine = String(lines[lines.length - 1] ?? "").trim();
  if (!endLine.startsWith("!")) return { ok: null, expected: null, computed: null };

  const expectedHex = endLine.slice(1).trim();
  if (!/^[0-9A-Fa-f]{4}$/.test(expectedHex)) {
    return { ok: null, expected: null, computed: null };
  }

  const crcTextLines = [...lines];
  crcTextLines[crcTextLines.length - 1] = "!";
  const crcText = crcTextLines.join("\n") + "\n";
  const buf = Buffer.from(crcText, "ascii");

  const computed = crc16Arc(buf);
  const expected = parseInt(expectedHex, 16);

  return {
    ok: computed === expected,
    expected: expectedHex.toUpperCase(),
    computed: computed.toString(16).toUpperCase().padStart(4, "0")
  };
}

/* -------------------------------------------------------------------------- */
/*  EXTRACTION                                                                */
/* -------------------------------------------------------------------------- */

function scaleToTargetUnit(value, unit, targetUnit) {
  if (typeof value !== "number" || !isFinite(value)) return null;
  if (!targetUnit || !unit) return value;

  const u = String(unit);
  const t = String(targetUnit);

  if (u === "kW" && t === "W") return value * 1000;
  if (u === "W" && t === "kW") return value / 1000;

  if (u === "kWh" && t === "Wh") return value * 1000;
  if (u === "Wh" && t === "kWh") return value / 1000;

  return value;
}

function extractOneField(obisMap, spec) {
  if (!spec) return undefined;

  if (typeof spec === "string") {
    const groups = obisMap[spec];
    return groups ? groups[0] : undefined;
  }

  if (typeof spec !== "object") return undefined;

  const obis = spec.obis;
  const group = Number(spec.group ?? 0);
  const as = String(spec.as ?? "raw");

  if (!obis || typeof obis !== "string") return undefined;

  const groups = obisMap[obis];
  const raw = (groups && group >= 0 && group < groups.length) ? groups[group] : undefined;

  if (raw === undefined) {
    return (spec.default !== undefined) ? spec.default : undefined;
  }

  if (as === "raw") return raw;

  if (as === "timestamp") {
    const iso = parseDsmrTimestamp(raw);
    return iso || raw;
  }

  if (as === "number") {
    const parsed = parseNumericWithUnit(raw);
    if (!parsed) {
      return (spec.default !== undefined) ? spec.default : undefined;
    }
    const scaled = scaleToTargetUnit(parsed.value, parsed.unit, spec.targetUnit);
    return (scaled === null) ? ((spec.default !== undefined) ? spec.default : undefined) : scaled;
  }

  return raw;
}

function extractFields(obisMap) {
  const out = {};
  for (const [field, spec] of Object.entries(effectiveExtract)) {
    const val = extractOneField(obisMap, spec);
    if (val !== undefined) out[field] = val;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  EMISSION                                                                  */
/* -------------------------------------------------------------------------- */

function handleTelegram(lines) {
  const now = Date.now();
  if (minEmitIntervalMs > 0 && (now - lastEmitTs) < minEmitIntervalMs) return;
  lastEmitTs = now;

  const obisMap = parseObisLines(lines);
  const data = extractFields(obisMap);

  if (emitObisMap) data.obis = obisMap;

  if (emitRawTelegram) {
    data.raw_telegram = lines.join("\n") + "\n";
  }

  if (crcCheck) {
    const crc = tryValidateCrc(lines);
    if (crc.ok !== null) {
      data.crc_ok = crc.ok;
      data.crc_expected = crc.expected;
      data.crc_computed = crc.computed;
      if (crc.ok === false) {
        logWarn(`CRC mismatch expected=${crc.expected} computed=${crc.computed}`);
      }
    }
  }

  const obj = { meta: createMeta(tag), data };
  safeWrite(obj);
}

/* -------------------------------------------------------------------------- */
/*  SHUTDOWN                                                                  */
/* -------------------------------------------------------------------------- */

process.on("SIGINT", () => {
  logInfo("closing serial port");
  try {
    port.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
});
