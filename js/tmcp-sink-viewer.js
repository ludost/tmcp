#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-sink-viewer.js
 * --------------------
 * Visual sink for grid-mapped sensor/state data.
 *
 * Updated for:
 *   • New TMCP configuration API (registerPositionals + registerOverride).
 *   • safeRead() protocol-agnostic ingestion.
 *   • No behavioral changes.
 */

import fs from "fs";
import chalk from "chalk";
import {
  appendTag,
  safeRead,
  logError,
  registerPositionals,
  registerParam,
  loadCLI,
  loadConfigFile
} from "./lib/pipeline-utils.js";

/* -------------------------------------------------------------------------- */
/*  CONFIG REGISTRATION                                                        */
/* -------------------------------------------------------------------------- */

// These config keys are read from JSON, so no CLI overrides except optional ones:
registerParam({
  longname: "linger",
  default: true,
  generateNegative: true,
  description: "Keep viewer running when stdin closes."
});

registerPositionals([
  {
    "name": "config_file",
    "required": true,
    "description": "Render real-time data in a configurable grid."
  }
]);


/* -------------------------------------------------------------------------- */
/*  RESOLVE POSITIONALS + CONFIG FILE                                          */
/* -------------------------------------------------------------------------- */
let cli = loadCLI();

let cfgFile = loadConfigFile("positionals.config_file", { defaultScope: "gridViewer" });
const viewerCfg = cfgFile.gridViewer || {};

const gridWidth     = viewerCfg.gridWidth  || 11;
const gridHeight    = viewerCfg.gridHeight || 8;
const gridMap       = viewerCfg.gridMap    || {};
const showLabels    = viewerCfg.showLabels === true;
const enumMap       = viewerCfg.enumMap    || {};
const cellWidth     = viewerCfg.cellWidth  || 4;
const booleanColors = viewerCfg.booleanColors || false;

const viewerLinger  = cli.get("param.linger");
const cellHeight    = showLabels ? 2 : 1;

const tag = "vsnk";

/* -------------------------------------------------------------------------- */
/*  TEXT HELPERS                                                               */
/* -------------------------------------------------------------------------- */

function center(text, width) {
  const len = text.length;
  if (len >= width) return text.slice(0, width);
  const left = Math.floor((width - len) / 2);
  const right = width - len - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function trimLabel(label) {
  return label.length <= 6 ? label : label.slice(0, 6) + "..";
}

function valueToColor(v) {
  const val = Math.min(Math.max(v, 0), 1023);
  const t = val / 1023;
  const r = Math.round(255 * t);
  const g = Math.round(80 + 80 * (1 - Math.abs(t - 0.5) * 2));
  const b = Math.round(255 * (1 - t));
  return chalk.rgb(r, g, b).bold;
}

function renderValue(label, val) {
  if (enumMap[label] && enumMap[label][String(val)] !== undefined) {
    return chalk.white(center(String(enumMap[label][String(val)]), cellWidth));
  }

  if (typeof val === "number" && Number.isFinite(val)) {
    return valueToColor(val)(center(String(Math.round(val)), cellWidth));
  }

  if (typeof val === "boolean") {
    if (booleanColors) {
      return val
        ? chalk.greenBright(center("true", cellWidth))
        : chalk.redBright(center("false", cellWidth));
    }
    return chalk.yellowBright(center(val ? "true" : "false", cellWidth));
  }

  if (val != null) {
    return chalk.white(center(String(val).slice(0, cellWidth), cellWidth));
  }

  return chalk.hex("#AA8800")(center("----", cellWidth));
}

/* -------------------------------------------------------------------------- */
/*  GRID RENDERING                                                             */
/* -------------------------------------------------------------------------- */

function renderGrid(obj) {
  appendTag(obj.meta, tag);

  const data = obj.data || {};
  const totalRows = gridHeight * cellHeight;

  const grid = Array.from({ length: totalRows }, (_, rowIdx) =>
    Array.from({ length: gridWidth }, () =>
      showLabels && (rowIdx % cellHeight === 0)
        ? " ".repeat(cellWidth)
        : chalk.hex("#AA8800")(center("----", cellWidth))
    )
  );

  for (const [label, pos] of Object.entries(gridMap)) {
    if (!Array.isArray(pos) || pos.length < 2) continue;
    const [y, x] = pos;

    if (y < 0 || x < 0 || y >= gridHeight || x >= gridWidth) continue;

    const baseRow = y * cellHeight;
    const valueTxt = renderValue(label, data[label]);

    if (showLabels) {
      const lbl =
        data[label] === undefined || data[label] === null
          ? " ".repeat(cellWidth)
          : chalk.cyan(center(trimLabel(label), cellWidth));
      grid[baseRow][x] = lbl;
      grid[baseRow + 1][x] = valueTxt;
    } else {
      grid[baseRow][x] = valueTxt;
    }
  }

  process.stdout.write("\x1Bc");
  console.log(chalk.cyanBright("=== Sensor Grid ==="));
  for (const row of grid) console.log(row.join(" "));
}

/* -------------------------------------------------------------------------- */
/*  MAIN LOOP                                                                  */
/* -------------------------------------------------------------------------- */

safeRead(
  obj => { if (obj) renderGrid(obj); },
  undefined,
  { channelId: "stdin", exitOnClose: !viewerLinger }
);
