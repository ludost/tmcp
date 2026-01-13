/**
 * lib/pipeline-stream.js
 * ----------------------
 * Stream I/O helpers: safeRead / safeWrite and related utilities.
 *
 * Architectural contract:
 *   • Modules MUST treat safeRead/safeWrite as object-level APIs.
 *   • safeRead(callback, ...) always delivers normalized {meta, data} objects.
 *   • safeWrite(obj, ...) always accepts plain JS objects and handles transport
 *     (NDJSON / MsgPack) internally, including encoding and low-level write() calls.
 *
 * No module should ever JSON.stringify or msgpack.encode pipeline payloads itself.
 *
 * Channel-aware behavior:
 *   • Both safeRead and safeWrite accept:
 *       { channelId, exitOnClose, retry, linger }
 *
 *     - channelId:
 *         "stdin" | "stdout" | "stderr" | <any string>
 *       If omitted, it is inferred from fdOrStream:
 *         • safeRead:  undefined → "stdin"
 *         • safeWrite: undefined → "stdout"
 *         • fdOrStream === process.stdin or 0  → "stdin"
 *         • fdOrStream === process.stdout or 1 → "stdout"
 *         • fdOrStream === process.stderr or 2 → "stderr"
 *
 *     - exitOnClose:
 *         explicit per-channel exit policy for EOF (read) or EPIPE-like errors (write).
 *
 *     - retry:
 *         write-side hint: suppress certain errors so caller can reopen/retry.
 *         read-side: present only for API symmetry, not used internally yet.
 *
 *     - linger (legacy):
 *         preserved for backwards compatibility:
 *           exitOnClose := !linger  when exitOnClose is not explicitly set.
 *
 *   • System defaults (before module/CLI overrides):
 *       safeRead:
 *         channelId === "stdin"  → exitOnClose = true
 *         otherwise              → exitOnClose = false
 *
 *       safeWrite:
 *         channelId === "stdout" or "stderr" → exitOnClose = true
 *         otherwise                          → exitOnClose = false
 *
 *   • Global overrides (highest precedence, via unified config):
 *       Overrides (string, ENV/CLI):
 *         --in-protocol=<ndjson|msgpack>,  env=TMCP_IN_PROTOCOL
 *         --out-protocol=<ndjson|msgpack>, env=TMCP_OUT_PROTOCOL
 *         --exit-on-close="stdin=true,stdout=false,side:0=true"
 *             env=TMCP_EXIT_ON_CLOSE
 *         --retry="side:0=true,side:1=false"
 *             env=TMCP_RETRY
 *
 *       Flags (boolean):
 *         --exit-instead-of-kill / --no-exit-instead-of-kill
 *             env=TMCP_EXIT_INSTEAD_OF_KILL
 *
 *   • Process termination policy (for channels where exitOnClose === true):
 *       Default: process.kill(SIGTERM)       // FIFO bug workaround
 *       Override: --exit-instead-of-kill     // use process.exit(0) instead
 */

import whyIsNodeRunning from "why-is-node-running"; // optional diagnostics; unused in normal runs
import fs from "fs";
import readline from "readline";
import { encode, decodeMultiStream } from "@msgpack/msgpack";

import {
  registerParam,
  loadCLI
} from "./pipeline-config.js";

import {
  logError,
  logWarning,
  logWarn,
  logInfo,
  logPrefix,
  verboseTick
} from "./pipeline-logging.js";

import { normalizeObject } from "./pipeline-core.js";

/* ------------------------------------------------------------------------- */
/*  NDJSON implementation selector                                           */
/* ------------------------------------------------------------------------- */

const NDJSON_IMPL = process.env.TMCP_NDJSON_IMPL || "stream";

/* ------------------------------------------------------------------------- */
/*  Unified configuration registration                                       */
/* ------------------------------------------------------------------------- */

/**
 * IN/OUT protocol selection:
 *
 *   --in-protocol=<ndjson|msgpack>   (env=TMCP_IN_PROTOCOL, default="ndjson")
 *   --out-protocol=<ndjson|msgpack>  (env=TMCP_OUT_PROTOCOL, default="ndjson")
 */
registerParam({
  longname: "in-protocol",
  envname: "TMCP_IN_PROTOCOL",
  default: "ndjson",
  expectsValue: true,
  description: "Input protocol for safeRead: 'ndjson' (default) or 'msgpack'."
});

registerParam({
  longname: "out-protocol",
  envname: "TMCP_OUT_PROTOCOL",
  default: "ndjson",
  expectsValue: true,
  description: "Output protocol for safeWrite: 'ndjson' (default) or 'msgpack'."
});

/**
 * Per-channel exitOnClose and retry policy:
 *
 *   --exit-on-close="stdin=true,stdout=true,side:0=false"
 *       env=TMCP_EXIT_ON_CLOSE
 *
 *   --retry="side:0=true,side:1=false"
 *       env=TMCP_RETRY
 *
 * Values are comma-separated key=value pairs where:
 *   key   = channelId (e.g. "stdin", "stdout", "side:0")
 *   value = boolean ("true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off")
 */
registerParam({
  longname: "exit-on-close",
  envname: "TMCP_EXIT_ON_CLOSE",
  default: "",
  expectsValue: true,
  description:
    "Comma-separated per-channel exitOnClose policy, e.g. stdin=true,stdout=false,side:0=true."
});

registerParam({
  longname: "retry",
  envname: "TMCP_RETRY",
  default: "",
  expectsValue: true,
  description:
    "Comma-separated per-channel retry policy, e.g. side:0=true,side:1=false."
});

/**
 * Termination behavior when exitOnClose triggers:
 *
 *   --exit-instead-of-kill / --no-exit-instead-of-kill
 *       env=TMCP_EXIT_INSTEAD_OF_KILL
 *
 * Default: false (use SIGTERM).
 */
registerParam({
  longname: "exit-instead-of-kill",
  envname: "TMCP_EXIT_INSTEAD_OF_KILL",
  default: false,
  generateNegative: true,
  description:
    "When true, use process.exit(0) instead of SIGTERM when exitOnClose triggers on stdout/stderr."
});

/* ------------------------------------------------------------------------- */
/*  Protocol + verbosity resolution via unified config (lazy)                */
/* ------------------------------------------------------------------------- */

let cli = loadCLI()

function resolveInProtocol() {
  const v = cli.get("param.in-protocol");
  return v === "msgpack" ? "msgpack" : "ndjson";
}

function resolveOutProtocol() {
  const v = cli.get("param.out-protocol");
  return v === "msgpack" ? "msgpack" : "ndjson";
}

function resolveVerboseInput() {
  return cli.get("param.verbose-input") === true;
}

function resolveVerboseOutput() {
  return cli.get("param.verbose-output") === true;
}

function resolveExitInsteadOfKill() {
  return cli.get("param.exit-instead-of-kill") === true;
}

/* ------------------------------------------------------------------------- */
/*  Per-channel policy parsing (from overrides)                              */
/* ------------------------------------------------------------------------- */

const channelExitOnCloseOverrides = new Map(); // channelId -> boolean
const channelRetryOverrides = new Map();       // channelId -> boolean
let channelPoliciesLoaded = false;

function parseBooleanLike(raw) {
  if (typeof raw === "boolean") return raw;
  if (raw == null) return undefined;
  const v = String(raw).toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return undefined;
}

function parseChannelPoliciesOnce() {
  if (channelPoliciesLoaded) return;
  channelPoliciesLoaded = true;

  const exitSpec = cli.get("param.exit-on-close");
  const retrySpec = cli.get("param.retry");

  function parseSpec(spec, targetMap, label) {
    if (!spec || typeof spec !== "string") return;
    const parts = spec.split(",");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const [rawName, rawVal] = trimmed.split("=", 2);
      const name = rawName && rawName.trim();
      if (!name) continue;

      const parsedBool =
        rawVal === undefined
          ? true
          : parseBooleanLike(rawVal.trim());

      if (parsedBool === undefined) {
        logWarning(
          `[${logPrefix}] Invalid ${label} policy entry "${trimmed}" (expected channelId=true|false).`
        );
        continue;
      }

      targetMap.set(name, parsedBool);
    }
  }

  parseSpec(exitSpec, channelExitOnCloseOverrides, "exit-on-close");
  parseSpec(retrySpec, channelRetryOverrides, "retry");
}

/* ------------------------------------------------------------------------- */
/*  Process termination helper                                               */
/* ------------------------------------------------------------------------- */

function terminateProcess(channelLabel, reason) {
  const label = channelLabel || "?";
  const useExitInsteadOfKill = resolveExitInsteadOfKill();

  if (useExitInsteadOfKill) {
    logInfo(`terminateProcess(${label}): process.exit(0) (${reason})`);
    process.exit(0);
  } else {
    logInfo(`terminateProcess(${label}): process.kill(SIGTERM) (${reason})`);
    try {
      process.kill(process.pid, "SIGTERM");
    } catch (err) {
      logError(
        `terminateProcess(${label}): SIGTERM failed (${err && err.message ? err.message : String(
          err
        )}) → falling back to process.exit(0)`
      );
      process.exit(0);
    }
  }
}

/* ------------------------------------------------------------------------- */
/*  Helpers to detect stdio / infer channelId                                */
/* ------------------------------------------------------------------------- */

function isStdoutLike(target) {
  return (
    target === undefined ||
    target === null ||
    target === process.stdout ||
    target === 1
  );
}

function isStderrLike(target) {
  return target === process.stderr || target === 2;
}

function isStdinLike(target) {
  return (
    target === undefined ||
    target === null ||
    target === process.stdin ||
    target === 0
  );
}

function inferChannelId(fdOrStream, explicitChannelId, direction) {
  if (explicitChannelId && typeof explicitChannelId === "string") {
    return explicitChannelId;
  }

  if (direction === "read") {
    if (isStdinLike(fdOrStream)) return "stdin";
    return undefined;
  }

  if (isStdoutLike(fdOrStream)) return "stdout";
  if (isStderrLike(fdOrStream)) return "stderr";
  return undefined;
}

/* ------------------------------------------------------------------------- */
/*  Resolve final channel policies                                           */
/* ------------------------------------------------------------------------- */

function resolveChannelPolicies(direction, fdOrStream, options = {}) {
  // Ensure per-channel maps are initialized from config
  parseChannelPoliciesOnce();

  const {
    channelId: explicitChannelId,
    exitOnClose: optExitOnClose,
    retry: optRetry,
    linger
  } = options ?? {};

  let channelId = inferChannelId(fdOrStream, explicitChannelId, direction);

  // Default exitOnClose / retry
  let exitOnClose;
  if (direction === "read") {
    exitOnClose = channelId === "stdin";
  } else {
    exitOnClose = channelId === "stdout" || channelId === "stderr";
  }

  let retry = false;

  // Module-level overrides
  if (typeof optExitOnClose === "boolean") {
    exitOnClose = optExitOnClose;
  } else if (typeof linger === "boolean") {
    exitOnClose = !linger;
  }

  if (typeof optRetry === "boolean") {
    retry = optRetry;
  }

  // Global per-channel overrides (highest precedence)
  if (channelId && channelExitOnCloseOverrides.has(channelId)) {
    exitOnClose = channelExitOnCloseOverrides.get(channelId);
  }
  if (channelId && channelRetryOverrides.has(channelId)) {
    retry = channelRetryOverrides.get(channelId);
  }

  return { channelId, exitOnClose, retry };
}

/* ------------------------------------------------------------------------- */
/*  Low-level helpers + write error handling                                 */
/* ------------------------------------------------------------------------- */

/**
 * Turn various fdOrStream forms into a readable stream:
 *   • undefined / null / process.stdin / 0  → process.stdin
 *   • Node stream (object with .on)        → that stream
 *   • number                               → fs.createReadStream(null, { fd })
 *   • string                               → fs.createReadStream(path)
 */
function getReadableFromArg(fdOrStream) {
  if (fdOrStream === undefined || fdOrStream === null) {
    return process.stdin;
  }

  if (typeof fdOrStream === "object" && typeof fdOrStream.on === "function") {
    return fdOrStream;
  }

  if (typeof fdOrStream === "number") {
    return fs.createReadStream(null, { fd: fdOrStream, autoClose: false });
  }

  if (typeof fdOrStream === "string") {
    // Treat as path: FIFO, regular file, etc.
    return fs.createReadStream(fdOrStream, { autoClose: false });
  }

  // Fallback: stdin
  return process.stdin;
}

/**
 * Shared write-error handler used by both:
 *   • synchronous safeWrite try/catch (sync=true)
 *   • asynchronous stream 'error' handlers (sync=false)
 */
function handleWriteError(err, policy) {
  const {
    channelLabel,
    exitOnClose,
    retry,
    isFD,
    sync
  } = policy || {};

  const code = err && err.code;

  // Main pipeline stdout/stderr: broken pipe with exitOnClose=true → terminate
  if (
    exitOnClose &&
    (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") &&
    (channelLabel === "stdout" || channelLabel === "stderr")
  ) {
    logInfo(
      `safeWrite(${channelLabel}): channel closed (${code}) → terminating process.`
    );
    terminateProcess(channelLabel, code || "EPIPE");
    return;
  }

  // Side-channel / FD writes: retry enabled
  if (
    isFD &&
    retry &&
    (code === "EPIPE" || code === "EAGAIN" || code === "ENXIO")
  ) {
    logInfo(
      `safeWrite(${channelLabel}): side-channel write error suppressed for retry (${code}).`
    );
    return;
  }

  // Side-channel or stdout/stderr with exitOnClose=false: log but do not crash
  if (!exitOnClose && (code === "EPIPE" || code === "ERR_STREAM_DESTROYED")) {
    logWarn(
      `safeWrite(${channelLabel}): broken pipe (${code}) with exitOnClose=false; error suppressed.`
    );
    return;
  }

  // Other errors:
  //   • In sync path, preserve previous behavior by rethrowing.
  //   • In async path (stream 'error' handler), we must NOT throw.
  if (sync) {
    throw err;
  } else {
    logError(
      `safeWrite(${channelLabel}): async write error (${code || "unknown"}): ${err.message || String(
        err
      )}`
    );
  }
}

/**
 * For stream targets, we attach a single 'error' handler per target so that
 * EPIPE/ERR_STREAM_DESTROYED/EAGAIN/ENXIO do not surface as unhandled errors.
 *
 * Policy is stored per-stream; first writer wins. This is sufficient for
 * our TMCP usage where a given stream has a stable role (stdout, fifo, etc.).
 */
const streamWritePolicies = new WeakMap();

function attachStreamErrorHandler(target, policy) {
  if (!target || typeof target.on !== "function") return;

  if (!streamWritePolicies.has(target)) {
    streamWritePolicies.set(target, policy);

    target.on("error", (err) => {
      const stored = streamWritePolicies.get(target) || policy;
      // async path: sync=false
      handleWriteError(err, { ...stored, sync: false });
    });
  } else {
    // Keep first policy; do not override to avoid flickering semantics.
  }
}

/**
 * Low-level raw writer.
 *
 * For numeric FDs: use fs.writeSync.
 * For streams: use .write() and rely on attached 'error' handler
 *              to normalize EPIPE, etc.
 */
function writeRaw(fdOrStream, payload, policy) {
  const target = fdOrStream ?? process.stdout;

  if (typeof target === "number") {
    // Numeric FD: let safeWrite's try/catch see any synchronous error.
    fs.writeSync(target, payload);
    return;
  }

  if (target && typeof target.on === "function" && typeof target.write === "function") {
    // Stream-like: attach error handler once, then write.
    attachStreamErrorHandler(target, {
      channelLabel: policy.channelLabel,
      exitOnClose: policy.exitOnClose,
      retry: policy.retry,
      isFD: false
    });
    target.write(payload);
    return;
  }

  // Fallback: assume stdout-like stream
  (target || process.stdout).write(payload);
}

/* ------------------------------------------------------------------------- */
/*  NDJSON parseLine                                                         */
/* ------------------------------------------------------------------------- */

export function parseLine(line) {
  const verboseInput = resolveVerboseInput();

  if (verboseInput) {
    console.error(`[${logPrefix}][input-ndjson] ${line}`);
  }

  let raw;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    logWarning(`Failed to parse NDJSON line: ${err.message}`);
    return null;
  }

  const obj = normalizeObject(raw);
  verboseTick(obj);
  return obj;
}

/* ------------------------------------------------------------------------- */
/*  safeRead                                                                 */
/* ------------------------------------------------------------------------- */

const safeReadStreams = new Set();

export function safeRead(onRecord, fdOrStream, options = {}) {
  if (typeof onRecord !== "function") {
    logError(
      "safeRead(callback, fdOrStream?, options?) requires a function callback"
    );
    return;
  }

  const { channelId, exitOnClose } = resolveChannelPolicies(
    "read",
    fdOrStream,
    options
  );

  const inProtocol = resolveInProtocol();
  const stream = getReadableFromArg(fdOrStream);
  const effectiveChannelId =
    channelId || inferChannelId(stream, undefined, "read") || "?";

  if (safeReadStreams.has(stream)) {
    logWarn("safeRead(): multiple readers registered for the same stream/fd.");
  } else {
    safeReadStreams.add(stream);
  }

  const handleEOF = () => {
    logInfo(`handleEOF called for stream:${effectiveChannelId}`);
    if (exitOnClose) {
      logInfo(`handleEOF exiting due to stream:${effectiveChannelId}`);
      setImmediate(() => {
        terminateProcess(effectiveChannelId, "EOF");
      });
    }
  };

  /* --------------------------------------------------------------------- */
  /*  NDJSON input (new default: raw-stream parser)                        */
  /* --------------------------------------------------------------------- */

  if (inProtocol === "ndjson") {
    if (NDJSON_IMPL === "stream") {
      let buffer = "";
      stream.setEncoding("utf8");

      stream.on("data", (chunk) => {
        if (typeof chunk !== "string") {
          chunk = chunk.toString("utf8");
        }

        buffer += chunk;

        for (;;) {
          const idx = buffer.indexOf("\n");
          if (idx === -1) break;

          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);

          const obj = parseLine(line);
          if (obj) onRecord(obj);
        }
      });

      stream.on("error", (err) => {
        logError(`NDJSON stream error: ${err.message}`);
      });

      stream.on("end", () => {
        const tail = buffer.trim();
        if (tail.length > 0) {
          const obj = parseLine(tail);
          if (obj) onRecord(obj);
        }
        handleEOF();
      });

      stream.on("close", handleEOF);
      return;
    }

    /* ------------------------------------------------------------------- */
    /*  Legacy NDJSON path: readline (kept for diffing / fallback)         */
    /* ------------------------------------------------------------------- */

    {
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
      });

      rl.on("line", (line) => {
        const obj = parseLine(line);
        if (obj) onRecord(obj);
      });

      rl.on("error", (err) =>
        logError(`NDJSON readline error: ${err.message}`)
      );

      rl.on("close", handleEOF);
      stream.on("end", handleEOF);
      stream.on("close", handleEOF);

      return;
    }
  }

  /* --------------------------------------------------------------------- */
  /*  MsgPack input                                                        */
  /* --------------------------------------------------------------------- */

  if (inProtocol === "msgpack") {
    const verboseInput = resolveVerboseInput();

    (async () => {
      try {
        for await (const value of decodeMultiStream(stream)) {
          const obj = normalizeObject(value);

          if (verboseInput) {
            try {
              console.error(
                `[${logPrefix}][input-msgpack] ${JSON.stringify(obj)}`
              );
            } catch {
              console.error(
                `[${logPrefix}][input-msgpack] [unstringifiable]`
              );
            }
          }

          verboseTick(obj);
          onRecord(obj);
        }
        handleEOF();
      } catch (err) {
        logError(`MessagePack decode error: ${err.message}`);
      }
    })();
    return;
  }

  logError(`Unknown IN_PROTOCOL: ${inProtocol}`);
}

/* ------------------------------------------------------------------------- */
/*  safeWrite                                                                */
/* ------------------------------------------------------------------------- */

export function safeWrite(obj, fdOrStream, options = {}) {
  const { channelId, exitOnClose, retry } = resolveChannelPolicies(
    "write",
    fdOrStream,
    options
  );
  const channelLabel =
    channelId || inferChannelId(fdOrStream, undefined, "write") || "?";

  const outProtocol = resolveOutProtocol();
  const verboseOutput = resolveVerboseOutput();
  const isFD = typeof fdOrStream === "number";

  try {
    const canonical = normalizeObject(obj);
    verboseTick(canonical);

    if (outProtocol === "ndjson") {
      const line = JSON.stringify(canonical);

      if (verboseOutput) {
        console.error(
          `[${logPrefix}][output-ndjson][${channelLabel}] ${line}`
        );
      }

      writeRaw(fdOrStream, line + "\n", {
        channelLabel,
        exitOnClose,
        retry,
        isFD
      });
      return;
    }

    if (outProtocol === "msgpack") {
      const buf = Buffer.from(encode(canonical));

      if (verboseOutput) {
        try {
          console.error(
            `[${logPrefix}][output-msgpack][${channelLabel}] ${JSON.stringify(
              canonical
            )}`
          );
        } catch {
          console.error(
            `[${logPrefix}][output-msgpack][${channelLabel}] [unstringifiable]`
          );
        }
      }

      writeRaw(fdOrStream, buf, {
        channelLabel,
        exitOnClose,
        retry,
        isFD
      });
      return;
    }

    logError(`Unknown OUT_PROTOCOL: ${outProtocol}`);
  } catch (err) {
    // Synchronous path (numeric FDs, or immediate stream errors)
    handleWriteError(err, {
      channelLabel,
      exitOnClose,
      retry,
      isFD,
      sync: true
    });
  }
}
