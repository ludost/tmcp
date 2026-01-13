#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-adapter-modbus.js
 * ----------------------
 * TMCPL Modbus RTU adapter: combined source + sink.
 *
 * This version supports separate read/write mappings:
 *
 *   modbus.write_mapping   → pipeline → Modbus write registers
 *   modbus.read_mapping    → Modbus read registers → pipeline
 *
 * Backward compatibility:
 *   • If write_mapping is absent, falls back to "mapping" for writing.
 *   • If read_mapping is absent, falls back to "mapping" for reading.
 *
 * Both mappings must be dense 0..N index blocks relative to their base registers.
 */

import ModbusRTU from "modbus-serial";
import {
  // config
  registerParam,
  registerPositionals,
  loadConfigFile,
  loadCLI,

  // pipeline ops
  createMeta,
  appendTag,
  safeWrite,
  safeRead,

  // logging
  logError,
  logWarn,
  logInfo
} from "./lib/pipeline-utils.js";

/* ------------------------------------------------------------------------- */
/*  Declare expected positional arguments & flags                             */
/* ------------------------------------------------------------------------- */

// Flags: booleans
registerParam({
  longname: "dry-run",
  envname: "TMCP_MODBUS_DRYRUN",
  default: false,
  generateNegative: true,
  description: "Enable dry-run mode for Modbus writes (no hardware I/O)."
});

registerParam({
  longname: "dry-run-read",
  envname: "TMCP_MODBUS_DRYRUN_READ",
  default: false,
  generateNegative: true,
  description: "Enable dry-run mode for Modbus reads (no hardware I/O)."
});

// Positional: config_file is required, device_path is optional
registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to Modbus configuration file"
  },
  {
    name: "device_path",
    required: false,
    description: "Optional path to Modbus serial/TCP device"
  }
]);

/* ------------------------------------------------------------------------- */
/*  Resolve configuration, positionals, flags                                 */
/* ------------------------------------------------------------------------- */
let cli = loadCLI();

const deviceOverride = cli.get("positionals.device_path");

const dryRun     = cli.get("param.dry-run");
const dryRunRead = cli.get("param.dry-run-read");

const tag = "mbx";

/* ------------------------------------------------------------------------- */
/*  Load config file                                                          */
/* ------------------------------------------------------------------------- */

const config = loadConfigFile("positionals.config_file", { defaultScope: "modbus" });
const modbusCfg = config.modbus || {};

const device  = deviceOverride || modbusCfg.device || "/dev/ttyUSB0";
const baud    = modbusCfg.baud || 115200;
const slaveId = modbusCfg.slaveId || 1;

/* ------------------------------------------------------------------------- */
/*  Rate and mapping configuration                                            */
/* ------------------------------------------------------------------------- */

const writeBase     = modbusCfg.writeBaseRegister ?? 1486;
const minWriteRate  = modbusCfg.minWriteRate ?? 200;
const maxWriteRate  = modbusCfg.maxWriteRate ?? 20;

const readBase      = modbusCfg.readBaseRegister ?? 1546;
const readRate      = modbusCfg.readRate ?? 50;

// Dense field mappings with fallback
const writeMapping = modbusCfg.write_mapping || modbusCfg.mapping || {};
const readMapping  = modbusCfg.read_mapping  || modbusCfg.mapping || {};

const registerCountWrite = Math.max(
  ...Object.values(writeMapping).map(i => (typeof i === "number" ? i : -1)),
  -1
) + 1;

const registerCountRead = Math.max(
  ...Object.values(readMapping).map(i => (typeof i === "number" ? i : -1)),
  -1
) + 1;

/* ------------------------------------------------------------------------- */
/*  Debug mapping logs                                                        */
/* ------------------------------------------------------------------------- */

logInfo(`[tmcp-adapter-modbus] writeMapping fields: ${Object.keys(writeMapping).join(", ")}`);
logInfo(`[tmcp-adapter-modbus] readMapping fields: ${Object.keys(readMapping).join(", ")}`);
logInfo(`[tmcp-adapter-modbus] registerCountWrite=${registerCountWrite}, registerCountRead=${registerCountRead}`);

/* ------------------------------------------------------------------------- */
/*  Modbus client setup                                                       */
/* ------------------------------------------------------------------------- */

const client    = new ModbusRTU();
let connected   = false;

let currentValues  = Array(registerCountWrite).fill(0);
let writtenValues  = Array(registerCountWrite).fill(0);

let haveReceivedInput = false;
let lastWriteTs       = 0;
let pendingWrite      = false;

/* ------------------------------------------------------------------------- */
/*  Async lock                                                                */
/* ------------------------------------------------------------------------- */

let lockQueue = Promise.resolve();
function withLock(fn) {
  const next = lockQueue.finally(() => fn().catch(() => {}));
  lockQueue = next.catch(() => {});
  return next;
}

/* ------------------------------------------------------------------------- */
/*  Connection handling                                                       */
/* ------------------------------------------------------------------------- */

async function connectClient() {
  if (dryRunRead) {
    logWarn("--dry-run-read: skipping hardware connection");
    connected = false;
    return;
  }

  if (connected) return;
  try {
    await client.connectRTUBuffered(device, {
      baudRate: baud,
      parity:   modbusCfg.parity  || "none",
      dataBits: modbusCfg.dataBits || 8,
      stopBits: modbusCfg.stopBits || 1
    });
    client.setID(slaveId);
    connected = true;
    logInfo(`Connected to ${device} @ ${baud} baud`);
  } catch (err) {
    connected = false;
    logError(`Connection failed: ${err.message}`);
    setTimeout(connectClient, 2000);
  }
}
connectClient();

function handleModbusError(context, err) {
  const msg = String(err.message || err);
  logError(`${context} error: ${msg}`);

  if (/CRC|Timeout|EIO|EPIPE|EBUSY/i.test(msg)) {
    connected = false;
    try { client.close(); } catch {}
    logWarn("Disconnected after error, retrying soon...");
    setTimeout(connectClient, 2000);
  }
}

/* ------------------------------------------------------------------------- */
/*  Read loop                                                                 */
/* ------------------------------------------------------------------------- */

async function pollRegisters() {
  if (dryRunRead) {
    const fake = {};
    for (const [label] of Object.entries(readMapping)) fake[label] = 0;
    safeWrite({ meta: createMeta(tag), data: fake });
    return;
  }

  if (!connected) return;

  await withLock(async () => {
    try {
      const resp = await client.readHoldingRegisters(readBase, registerCountRead);
      const vals = resp.data || resp.buffer || resp;

      const obj = { meta: createMeta(tag), data: {} };
      for (const [label, idx] of Object.entries(readMapping)) {
        if (typeof idx === "number" && idx < vals.length) {
          obj.data[label] = vals[idx];
        }
      }
      safeWrite(obj);
    } catch (err) {
      handleModbusError("read", err);
    }
  });
}

/* ------------------------------------------------------------------------- */
/*  Change detection                                                          */
/* ------------------------------------------------------------------------- */

function valuesChanged() {
  for (let i = 0; i < registerCountWrite; i++) {
    if (Math.round(currentValues[i]) !== Math.round(writtenValues[i])) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------- */
/*  Write engine                                                              */
/* ------------------------------------------------------------------------- */

async function performWrite() {
  if (!haveReceivedInput) return;

  if (dryRun) {
    logWarn(`${new Date().toISOString()} --dry-run would write @${writeBase}: [${currentValues.join(", ")}]`);
    writtenValues = [...currentValues];
    lastWriteTs = Date.now();
    return;
  }

  if (!connected) return;

  await withLock(async () => {
    try {
      const regs = currentValues.map(v =>
        Math.min(Math.max(Math.round(v), 0), 1000)
      );
      await client.writeRegisters(writeBase, regs);
      writtenValues = [...currentValues];
      lastWriteTs = Date.now();
    } catch (err) {
      handleModbusError("write", err);
    }
  });
}

/* ------------------------------------------------------------------------- */
/*  Rate logic                                                                */
/* ------------------------------------------------------------------------- */

function tryScheduleWrite(triggeredByInput = false) {
  const now  = Date.now();
  const since = now - lastWriteTs;

  if (triggeredByInput) {
    if (!valuesChanged()) return;
    if (since >= maxWriteRate) {
      pendingWrite = false;
      performWrite();
    } else {
      pendingWrite = true;
    }
    return;
  }

  if (since >= minWriteRate) {
    pendingWrite = false;
    performWrite();
  }
}

/* ------------------------------------------------------------------------- */
/*  High-resolution write scheduler                                           */
/* ------------------------------------------------------------------------- */

setInterval(() => {
  const now  = Date.now();
  const since = now - lastWriteTs;

  if (pendingWrite && since >= maxWriteRate) {
    pendingWrite = false;
    performWrite();
    return;
  }

  if (since >= minWriteRate) {
    performWrite();
  }
}, 5);

/* ------------------------------------------------------------------------- */
/*  NDJSON input via safeRead                                                 */
/* ------------------------------------------------------------------------- */

safeRead(obj => {
  if (!obj) return;

  haveReceivedInput = true;
  appendTag(obj.meta, tag);

  const data = obj.data || {};
  for (const [label, idx] of Object.entries(writeMapping)) {
    const v = data[label];
    if (typeof v === "number" && idx >= 0 && idx < registerCountWrite) {
      currentValues[idx] = Math.round(v);
    }
  }

  tryScheduleWrite(true);
});

/* ------------------------------------------------------------------------- */
/*  Read scheduling                                                           */
/* ------------------------------------------------------------------------- */

setInterval(pollRegisters, readRate);
