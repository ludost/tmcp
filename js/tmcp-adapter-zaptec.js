#!/usr/bin/env -S stdbuf -oL node
/**
 * tmcp-adapter-zaptec.js
 * ----------------------
 * TMCP adapter module for Zaptec (ZapCloud API): combined source + sink.
 *
 * Reads:
 *   • Polls charger state observations (GET /api/chargers/{id}/state)
 *   • Emits mapped fields as TMCP NDJSON objects
 *
 * Writes:
 *   • Applies mapped pipeline fields to installation settings
 *     (POST /api/installation/{id}/update)
 *   • Rate-limited write engine with optional change detection
 */

import {
  registerParam,
  registerPositionals,
  registerConfigField,
  loadConfigFile,
  loadCLI,

  createMeta,
  appendTag,
  safeWrite,
  safeRead,

  logWarn
} from "./lib/pipeline-utils.js";

const TAG = "zpt";

/* ------------------------------------------------------------------------- */
/*  CLI                                                                       */
/* ------------------------------------------------------------------------- */

registerParam({
  longname: "dry-run",
  envname: "TMCP_ZAPTEC_DRYRUN",
  default: false,
  generateNegative: true
});

registerParam({
  longname: "dry-run-read",
  envname: "TMCP_ZAPTEC_DRYRUN_READ",
  default: false,
  generateNegative: true
});

registerPositionals([
  { name: "config_file", required: true }
]);

/* ------------------------------------------------------------------------- */
/*  Config schema registration                                               */
/* ------------------------------------------------------------------------- */

registerConfigField({
  path: "api.baseUrl",
  description: "Base URL of the Zaptec REST API",
  default: "https://api.zaptec.com/api"
});

registerConfigField({
  path: "api.oauthUrl",
  description: "OAuth endpoint base URL for Zaptec authentication",
  default: "https://api.zaptec.com/oauth"
});

registerConfigField({
  path: "api.username",
  description: "Zaptec account username",
  required: true
});

registerConfigField({
  path: "api.password",
  description: "Zaptec account password",
  required: true
});

registerConfigField({
  path: "api.chargerId",
  description: "Zaptec charger UUID",
  required: true
});

registerConfigField({
  path: "api.installationId",
  description: "Zaptec installation UUID",
  required: true
});

/* ---- Read side ---- */

registerConfigField({
  path: "read.intervalMs",
  description: "Polling interval for reading charger state (milliseconds)",
  default: 15000
});

registerConfigField({
  path: "read.mapping",
  description: "Mapping from TMCP output fields to Zaptec StateId values"
});

/* ---- Write side ---- */

registerConfigField({
  path: "write.mapping",
  description: "Mapping from TMCP input fields to Zaptec writable setting names"
});

registerConfigField({
  path: "write.minIntervalMs",
  description: "Minimum interval between consecutive writes (milliseconds)",
  default: 15000
});

registerConfigField({
  path: "write.maxIntervalMs",
  description: "Maximum enforced interval between writes (milliseconds)",
  default: 45000
});

registerConfigField({
  path: "write.detectChanges",
  description: "Suppress writes when desired payload is unchanged",
  default: true
});

/* ------------------------------------------------------------------------- */
/*  Config                                                                    */
/* ------------------------------------------------------------------------- */
const cli=loadCLI();

const dryRun = cli.get("flag.dry-run");
const dryRunRead = cli.get("flag.dry-run-read");

const cfg = loadConfigFile("positionals.config_file", { defaultScope: "zaptec" });

const baseUrl        = cfg.get("api.baseUrl");
const oauthUrl       = cfg.get("api.oauthUrl");
const username       = cfg.get("api.username");
const password       = cfg.get("api.password");
const chargerId      = cfg.get("api.chargerId");
const installationId = cfg.get("api.installationId");

const readIntervalMs = cfg.get("read.intervalMs");

const readMapping  = cfg.get("read.mapping");
const writeMapping = cfg.get("write.mapping");

const minWriteIntervalMs = cfg.get("write.minIntervalMs", { "default": 15000});
const maxWriteIntervalMs = cfg.get("write.maxIntervalMs", { "default": 45000});

const changeDetection = cfg.get("write.detectChanges", { "default": true});

/* ------------------------------------------------------------------------- */
/*  OAuth token handling (single-flight, non-reentrant)                       */
/* ------------------------------------------------------------------------- */

let accessToken = "";
let tokenExpiresAtMs = 0;
let tokenRefreshPromise = null;

function nowMs() {
  return Date.now();
}

function tokenValid() {
  return accessToken && (tokenExpiresAtMs - nowMs() > 10_000);
}

async function fetchToken() {
  const tokenUrl = `${oauthUrl.replace(/\/+$/, "")}/token`;

  const body = new URLSearchParams();
  body.set("grant_type", "password");
  body.set("username", username);
  body.set("password", password);
  body.set("scope", "openid");

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`oauth failed (${resp.status}): ${txt.slice(0, 200)}`);
  }

  const json = await resp.json();
  accessToken = json.access_token;
  tokenExpiresAtMs = nowMs() + (json.expires_in ?? 3600) * 1000;
}

async function ensureToken() {
  if (tokenValid()) return;

  if (!tokenRefreshPromise) {
    tokenRefreshPromise = (async () => {
      try {
        await fetchToken();
      } finally {
        tokenRefreshPromise = null;
      }
    })();
  }

  await tokenRefreshPromise;
}

async function apiRequest(method, url, body = null) {
  await ensureToken();

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json"
  };

  const opts = { method, headers };

  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let resp = await fetch(url, opts);

  if (resp.status === 401) {
    accessToken = "";
    await ensureToken();
    headers.Authorization = `Bearer ${accessToken}`;
    resp = await fetch(url, opts);
  }

  return resp;
}

/* ------------------------------------------------------------------------- */
/*  Read loop                                                                 */
/* ------------------------------------------------------------------------- */

function parseNumeric(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function pollStateOnce() {
  if (dryRunRead || !baseUrl || !chargerId) return;

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/chargers/${chargerId}/state`;
    const resp = await apiRequest("GET", url);

    if (!resp.ok) return;

    const arr = await resp.json();
    if (!Array.isArray(arr)) return;

    const map = new Map(arr.map(i => [i.StateId, i]));

    const out = {};
    for (const [field, id] of Object.entries(readMapping)) {
      const v = map.get(id)?.ValueAsString;
      const n = parseNumeric(v);
      if (n !== null) out[field] = n;
    }

    safeWrite({ meta: createMeta(TAG), data: out });
  } catch (err) {
    logWarn(`zaptec read error: ${err.message}`);
  }
}

setInterval(pollStateOnce, Math.max(250, readIntervalMs));
pollStateOnce();

/* ------------------------------------------------------------------------- */
/*  Write engine                                                              */
/* ------------------------------------------------------------------------- */

let haveReceivedInput = false;
let lastWriteTs = 0;
let desiredPayload = null;
let lastSentPayload = null;
let writeInProgress = false;

function shallowEqual(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildPayload(obj) {
  const out = {};
  for (const [src, dst] of Object.entries(writeMapping)) {
    const v = obj.data?.[src];
    if (typeof v === "number" && Number.isFinite(v)) out[dst] = v;
  }
  return Object.keys(out).length ? out : null;
}

async function performWrite() {
  if (writeInProgress || !haveReceivedInput || !desiredPayload) return;
  if (changeDetection && shallowEqual(desiredPayload, lastSentPayload)) return;

  if (nowMs() - lastWriteTs < maxWriteIntervalMs) return;

  writeInProgress = true;

  try {
    if (!dryRun) {
      const url = `${baseUrl.replace(/\/+$/, "")}/installation/${installationId}/update`;
      const resp = await apiRequest("POST", url, desiredPayload);
      if (!resp.ok) throw new Error(`write failed (${resp.status})`);
    }

    lastSentPayload = { ...desiredPayload };
    lastWriteTs = nowMs();
  } catch (err) {
    logWarn(`zaptec write error: ${err.message}`);
  } finally {
    writeInProgress = false;
  }
}

setInterval(performWrite, 50);

/* ------------------------------------------------------------------------- */
/*  NDJSON input                                                              */
/* ------------------------------------------------------------------------- */

safeRead(obj => {
  haveReceivedInput = true;
  appendTag(obj.meta, TAG);
  const payload = buildPayload(obj);
  if (payload) desiredPayload = payload;
});
