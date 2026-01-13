#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-sink-influxdb.js
 * --------------------
 * TMCP sink module writing NDJSON pipeline data into InfluxDB (v2).
 *
 * Contract:
 *   • Pure sink (stdin → external side-effect)
 *   • No downstream emission
 *   • Semantics fully configuration-driven
 *   • Uses meta.timestamp (ms) as InfluxDB timestamp
 *   • All data fields written as InfluxDB fields by default
 *   • Optional explicit tag fields (string-only)
 *   • FIFO buffering with bounded size
 *   • Connection retries allowed; data may be dropped on overflow
 */

import {
  safeRead,
  registerPositionals,
  loadCLI,
  loadConfigFile,
  logError,
  logWarn,
  logInfo,
} from "./lib/pipeline-utils.js";

import { InfluxDB, Point } from "@influxdata/influxdb-client";

/* -------------------------------------------------------------------------- */
/*  CONFIG LOADING                                                             */
/* -------------------------------------------------------------------------- */

registerPositionals([
  {
    name: "config_file",
    required: true,
    description: "Path to DSMR source configuration JSON."
  }
  ]);
let cli = loadCLI();

const cfg = loadConfigFile("positionals.config_file", { defaultScope: "influxdbSink"});
const sinkCfg = cfg?.influxdbSink;

if (!sinkCfg) {
  logError("Missing 'influxdbSink' block in config.");
  process.exit(1);
}

const {
  url,
  token,
  org,
  bucket,
  measurement,
  tagFields = [],
  buffer = {},
} = sinkCfg;

if (!url || !token || !org || !bucket || !measurement) {
  logError("InfluxDB sink config missing required connection fields.");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  BUFFERING (FIFO, bounded)                                                   */
/* -------------------------------------------------------------------------- */

const maxBufferSize = buffer.maxPoints ?? 1000;
const flushIntervalMs = buffer.flushIntervalMs ?? 1000;

const queue = [];

function enqueue(point) {
  if (queue.length >= maxBufferSize) {
    queue.shift(); // drop oldest
  }
  queue.push(point);
}

/* -------------------------------------------------------------------------- */
/*  INFLUXDB CLIENT                                                            */
/* -------------------------------------------------------------------------- */

let writeApi = null;

function connect() {
  try {
    const influx = new InfluxDB({ url, token });
    writeApi = influx.getWriteApi(org, bucket, "ms");
    logInfo("Connected to InfluxDB.");
  } catch (err) {
    writeApi = null;
    logWarn("Failed to connect to InfluxDB; will retry.", err);
  }
}

connect();

/* -------------------------------------------------------------------------- */
/*  POINT CONSTRUCTION                                                         */
/* -------------------------------------------------------------------------- */

function buildPoint(obj) {
  const { meta, data } = obj;
  if (!meta || typeof meta.timestamp !== "number") return null;
  if (!data || typeof data !== "object") return null;

  const point = new Point(measurement).timestamp(meta.timestamp);

  for (const [key, value] of Object.entries(data)) {
    if (tagFields.includes(key)) {
      if (typeof value === "string") {
        point.tag(key, value);
      }
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      point.floatField(key, value);
    } else if (typeof value === "boolean") {
      point.booleanField(key, value);
    } else if (typeof value === "string") {
      point.stringField(key, value);
    }
  }

  return point;
}

/* -------------------------------------------------------------------------- */
/*  WRITE LOOP                                                                 */
/* -------------------------------------------------------------------------- */

function flushQueue() {
  if (!writeApi) {
    connect();
    return;
  }

  while (queue.length > 0) {
    const p = queue.shift();
    try {
      writeApi.writePoint(p);
    } catch (err) {
      logWarn("InfluxDB write failed; reconnecting.", err);
      writeApi = null;
      break;
    }
  }
}

setInterval(flushQueue, flushIntervalMs);

/* -------------------------------------------------------------------------- */
/*  PIPELINE INPUT                                                             */
/* -------------------------------------------------------------------------- */

safeRead((obj) => {
  const point = buildPoint(obj);
  if (point) {
    enqueue(point);
  }
});

/* -------------------------------------------------------------------------- */
/*  SHUTDOWN                                                                   */
/* -------------------------------------------------------------------------- */

process.on("SIGINT", async () => {
  try {
    if (writeApi) {
      await writeApi.close();
    }
  } catch (_) {}
  process.exit(0);
});
