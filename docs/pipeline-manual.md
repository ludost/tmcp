
# **POSIX Terminal-Based Modular Control Pipeline (tmcp / tmcpl)**

# **Pipeline Manual**

---

# **0. Purpose and Scope**

This manual describes the **practical usage, composition patterns, operational behavior, and concrete applications** of the POSIX Terminal-Based Modular Control Pipeline (tmcp).
It is the authoritative, implementation-focused reference for engineers constructing, extending, or debugging TMCP-based pipelines.

The TMCP design is intentionally **domain-neutral**:
modules contain no semantic knowledge of sensors, actuators, robotics, or any specific plant.
Domain behavior emerges entirely from:

* declarative JSON configuration,
* shell-level orchestration,
* module composition,
* and the NDJSON data stream.

This manual is **not** the architectural specification.
The architectural principles, invariants, and theoretical foundations are documented separately in the **Architectural Guidelines**, which define the conceptual substrate.
Where this pipeline strictly adheres to those principles (the default), this manual simply assumes them.
Where practical constraints force a deviation (rare and explicitly documented), the deviation is stated clearly and justified.

This document therefore serves two roles:

1. **Developer Manual** – describing how TMCP modules behave, how they connect, and how to build repeatable real-time pipelines.
2. **Application Manual** – documenting existing reference systems (the robotic-hand controller and the seat-sensor classifier), explaining how they instantiate the generic TMCP model.

All content in this manual is implementation-centric, derived from canonical module behavior as implemented in the repository.

---

# **1. Relationship to the Architectural Guidelines**

TMCP is an implementation of the architectural principles defined in the Architectural Guidelines, not an independent or alternative design.
This section summarizes how the pipeline **adheres to** those architectural principles in practice, and lists the **few intentional deviations** enforced by real-world constraints.

## **1.1 Architectural Adherence**

The pipeline fully adheres to the following fundamental principles:

### **NDJSON-First Substrate**

Every module reads and writes exactly one NDJSON object per line.
This guarantees composability, file-based replay, FIFO-based loop construction, and deterministic transport semantics.

### **Domain-Neutral Modules**

No module embeds domain knowledge:
no sensor names, no actuator semantics, no task rules, no plant-specific constants.
Everything domain-specific is expressed externally in configuration files.

### **Deterministic, POSIX-Pipe Execution Model**

Modules are single-threaded Node.js processes using line-buffered stdin/stdout, guaranteeing:

* deterministic ordering,
* no hidden buffering,
* stable loop timing,
* transparent behavior in debugging.

### **Unknown-Field Preservation**

Modules must preserve all fields they do not explicitly read or write, except where documented otherwise.
This ensures free reordering of many module categories and maintains open-world compatibility.

### **Configuration as Sole Source of Semantics**

All mapping, scaling, timing, thresholds, state names, merging rules, and downstream meanings are defined only in JSON configuration files.
Modules enforce no implicit domain semantics.

### **Idempotent Desired-State Signaling**

Upstream processes express desired target state, not imperative commands.
Even in control-oriented pipelines, downstream responses remain stable under repetition or replay.

### **Extensibility by Addition**

New behaviors are added through new modules or new configuration—not by modifying existing modules beyond their conceptual scope.

### **Preference for Duck Typing**

Modules interpret fields only by name and structure, not by type declarations or schemas.
This supports emergent holonic behavior and cross-domain reuse.

## **1.2 Practical Deviations from Architectural Principles**

Although the pipeline strives for strict adherence, a few pragmatic exceptions exist:

### **Adapter Modules Combining Source and Sink Behavior**

`tmcp-adapter-modbus.js` *must* read and write hardware registers within the same process due to Modbus RTU timing constraints.
This is an intentional, fully documented exception and does not introduce domain semantics—only protocol mechanics.

### **Field Reconstruction in `tmcp-transformer-reduce.js`**

Under `forward_policy: "known"`, this module reconstructs the `data` object from declared outputs only.
This is not a divergence from architectural intent: it is a controlled, declarative projection used to reduce bandwidth or enforce strict field sets.

### **Replay-Driven Timing via `tmcp-source-file.js`**

Replay sources override timestamps and timing; this makes the system deterministic under replay rather than wall-clock time.
This is desirable, matches architectural expectations, and is explicitly documented.

## **1.3 Why This Section Exists**

This manual keeps Section 1 brief on purpose:
the full architectural rationale, theoretical model, and systemic constraints are in the Architectural Guidelines, which by themselves are a summary of the available whitepaper.

The goal of Section 1 is simply to:

* confirm that the pipeline implementation matches the architecture,
* document the few allowed exceptions,
* and clarify that the remainder of this document focuses on practical operation rather than architectural theory.

---

# **2 — Shared Library and Data Contract (`js/lib/`)**

TMCP modules rely on a unified shared-library layer that defines the NDJSON contract, logging system, CLI/ENV parameter handling, transport behavior, and metadata/tagging policy.
This section documents the *actual* behavior of the shared library as implemented in the codebase.

The shared library is composed of the following modules:

| File                  | Role                                         |
| --------------------- | -------------------------------------------- |
| `pipeline-utils.js`   | Public façade; stable import surface         |
| `pipeline-stream.js`  | NDJSON/MsgPack transport, safeRead/safeWrite |
| `pipeline-core.js`    | Normalization, meta/tagging                  |
| `pipeline-logging.js` | Logging, verbose metrics, prefixing          |
| `pipeline-config.js`  | Global CLI/ENV-driven configuration          |
| `pipeline-cli.js`     | Generic flag/parameter parsing               |

`pipeline-utils.js` re-exports all public APIs, giving modules a single stable import path:

```js
import {
  loadConfig,
  parseLine,
  safeRead,
  safeWrite,
  createMeta,
  appendTag,
  logError,
  logWarning,
  logWarn,
  logInfo,
  logPrefix,
  parseParams,
} from "./lib/pipeline-utils.js";
```

---

# **2.1 — Purpose and Design Role**

The shared library provides:

### **1. Canonical data structure**

All pipeline objects are normalized to:

```json
{
  "meta": { "timestamp": <ms>, "pipeline": ["tag", ...] },
  "data": { ... }
}
```

### **2. Deterministic transport**

`safeRead` and `safeWrite` handle:

* NDJSON or MsgPack
* raw stream parsing
* channel policies (exitOnClose, retry)
* EOF behavior
* broken-pipe behavior
* per-channel CLI overrides
* verbose input/output tracing
* statistics gathering

Modules never call `JSON.stringify` or `msgpack.encode` directly.

### **3. Unified logging & diagnostics**

All modules share:

* consistent `logPrefix`
* structured error/warn/info output
* optional per-second throughput/delay metrics

### **4. Unified CLI & ENV parsing**

All verbose/tag/protocol behavior originates in `pipeline-config.js`,
and `parseParams()` provides schema-driven argument handling for module-specific flags.

### **5. Single public façade**

`pipeline-utils.js` centralizes exports so module code remains stable even if underlying implementation files evolve.

---

# **2.2 — Data Model: Canonical NDJSON Object**

All pipeline messages must conform to the canonical shape enforced by `normalizeObject()` in `pipeline-core.js`.

### **Normalization rules**

* If the incoming value is not an object, wrap it into `{data:{value:…}}`.
* `meta` must exist as an object.
* `data` must exist as an object.
* `meta.pipeline` must be an array; if missing, it becomes `[]`.
* Timestamps are always numeric `Date.now()` millisecond values.

Modules may pass incomplete objects into `safeWrite()`; normalization always fixes them before emission.

### **Tagging rules**

* `createMeta(tag)` builds `{ meta:{ pipeline:[tag], timestamp:now }, data:{} }`, unless tagging is disabled.
* `appendTag(meta, tag)` appends `tag` to `meta.pipeline` in place (if tagging enabled).
* Tagging can be globally disabled with `--no-tag` or `TMCP_TAG`.

Tagging is purely diagnostic and does not carry semantics.

---

# **2.3 — Configuration and CLI Flag System (`pipeline-config.js`)**

Configuration is determined by:

1. **CLI flags** (highest precedence)
2. **Environment variables**
3. **Defaults** (lowest precedence)

### **2.3.1 Tagging**

```
--do-tag
--no-tag
TMCP_TAG=1|0
```

Defaults to **enabled**.
Disabling tags removes the `pipeline` array but leaves timestamps untouched.

### **2.3.2 Verbose modes**

```
--verbose
--verbose-input
--verbose-output
TMCP_VERBOSE=1|0
TMCP_VERBOSE_INPUT
TMCP_VERBOSE_OUTPUT
```

`--verbose` activates per-second rate/delay statistics.
The other flags echo NDJSON or MsgPack input/output to stderr.

### **2.3.3 Log level**

```
--verbose-log-level=none|error|warn|info
TMCP_VERBOSE_LOG_LEVEL
```

Controls `logError`, `logWarning`, and `logInfo`.

Default: **warn**

### **2.3.4 Transport protocol**

Both inbound and outbound protocols are configurable:

```
--in-protocol=ndjson|msgpack
--out-protocol=ndjson|msgpack
TMCP_IN_PROTOCOL
TMCP_OUT_PROTOCOL
```

Defaults: **ndjson** for both directions.

### **2.3.5 Generic parameter parser (`parseParams`)**

Modules use:

```js
const { params, errors, positional } = parseParams(schema, opts)
```

Features:

* boolean/number/string types
* number min/max bounds
* allowed lists
* required fields
* CLI > ENV > default
* automatic handling of `--key`, `--key=value`, `--key value`
* optional positional argument collection

This is the recommended way for modules to implement CLI flags.

---

# **2.4 — Logging and Verbose Statistics (`pipeline-logging.js`)**

Every log message is prefixed by:

```
scriptName(confPath)
```

as computed in `logPrefix`.

### **Severity levels**

* `none` → no logs
* `error` → only errors
* `warn` → errors & warnings (default)
* `info` → info, warnings, errors

### **Verbose statistics (`--verbose`)**

When enabled, a timer prints every 1000 ms:

```
rate: <msg/s>, avg delay: <ms>, last pipeline: a→b→c
```

Counters reset each interval.

### **Verbose input/output**

* `--verbose-input` logs raw input NDJSON/MsgPack lines before parsing.
* `--verbose-output` logs serialized output just before write.

All logging goes to **stderr** exclusively; transport never blocks waiting for logs.

---

# **2.5 — Meta and Tagging (`pipeline-core.js`)**

### **`normalizeObject(value)`**

Ensures the object meets the NDJSON contract.
Used implicitly by `safeRead` and `safeWrite`.

### **`createMeta(tag)`**

Creates a fresh `{meta, data}` with:

* `timestamp = Date.now()`
* `pipeline = ["tag"]` (unless tagging disabled)

### **`appendTag(meta, tag)`**

Appends a tag in place; no-ops if tagging disabled.

The tag chain is used only for diagnostics and verbose metrics.

---

# **2.6 — Transport Layer: NDJSON / MsgPack (`pipeline-stream.js`)**

This is the most complex part of the shared library.
`pipeline-stream.js` defines the **actual** transport behavior for the whole pipeline.

It provides:

* `parseLine()` (NDJSON-only parser)
* `safeRead(onRecord, fdOrStream, options)`
* `safeWrite(obj, fdOrStream, options)`

and a sophisticated channel-policy system.

## **2.6.1 parseLine(line)**

* Logs input if `verboseInput`.
* `JSON.parse` with warnings instead of throwing.
* Normalizes into `{meta, data}`.
* Updates verbose statistics (`verboseTick`).

Used by NDJSON mode in `safeRead`.

---

# **2.6.2 safeRead(onRecord, fdOrStream, options)**

`safeRead` streams incoming data and invokes:

```
onRecord(obj)
```

for each **normalized** pipeline object.

safeRead(fdOrStream) accepts:
* undefined / null       → process.stdin
* a Node stream object   → used directly as the input source
* a number               → treated as an existing file descriptor
* a string path          → treated as a filesystem path (FIFO or regular file),
                           opened via fs.createReadStream(path, {autoClose:false})

It supports:

### **Protocols**

* **NDJSON** (default)

  * *new default implementation*: raw streaming parser using manual newline splitting
  * fallback: readline interface
* **MsgPack**

  * uses `decodeMultiStream`

### **Channel inference**

`channelId` is derived from:

* explicit option
* CLI overrides
* stream identity (stdin, FIFO, file, FD)

### **Channel policies**

```
exitOnClose  (per channel, with CLI overrides)
retry        (per channel, write-side meaning only)
linger       (legacy)
```

Defaults:

* stdin → exitOnClose = true
* stdout/stderr → exitOnClose = true
* side channels → exitOnClose = false

### **EOF behavior**

If a channel with `exitOnClose=true` reaches EOF:

* If `--exit-instead-of-kill` → `process.exit(0)`
* Else → `process.kill(SIGTERM)` (workaround for Node FIFO issues)

### **Error behavior**

* JSON parse errors ⇒ warning + skip
* MsgPack decode errors ⇒ error log
* Stream errors ⇒ error log
* No exception escapes into module code.

---

# **2.6.3 safeWrite(obj, fdOrStream, options)**

Writes **normalized** objects with NDJSON/MsgPack encoding.

### **Channel inference**

Same as `safeRead`.

### **Protocol behavior**

* **ndjson** → `JSON.stringify(obj) + "\n"`
* **msgpack** → `encode(obj)`

### **Verbose output**

If `--verbose-output`, logs the serialized payload.

### **Broken pipe behavior**

* If writing to stdout/stderr and `exitOnClose=true`, a broken pipe triggers process termination (SIGTERM or process.exit).
* If retry=true and writing to side channels, certain errors (EPIPE, EAGAIN, ENXIO) are suppressed.
* Otherwise, errors propagate (after warnings if exitOnClose=false).

### **Normalization**

All objects are normalized before encoding.
Modules may pass incomplete objects; `safeWrite` guarantees valid structure.

---

# **2.7 — JSON Configuration Loader (`loadConfig`)**

Kept in `pipeline-utils.js` for legacy compatibility.

Behavior:

* Synchronous `fs.readFileSync`
* Returns `{}` on error
* Writes errors directly to stderr (not via logging API) to avoid circular imports

Used by modules that require a single config file per run.

---

# **2.8 — Summary of the Shared-Library Contract**

1. **Modules must treat `safeRead` and `safeWrite` as the only transport APIs**.
   No manual JSON.stringify or stream writes.

2. **Every incoming or outgoing object is normalized**.
   Modules can emit partial objects; the library fixes structure.

3. **Logging, verbose tracing, tag behavior, and transport protocols** are entirely centralized.
   Modules should not re-implement them.

4. **Channel policies** (exitOnClose, retry, termination action) are controlled via CLI + env and apply uniformly across all modules.

5. **Configuration and CLI flags** follow a uniform schema-based parsing model.

6. **The shared-library layer contains zero domain semantics**.
   All domain meaning must remain in configuration and orchestration.

---

# **SECTION 3 — APPLICATION MODULE LAYER**

## **3.1 — Introduction**

The **Application Module Layer** consists of all executable TMCP processes that operate on NDJSON streams using the architectural contract defined in Sections 1 and 2.
Each module is an independent Node.js process, line-buffered, deterministic, and composable in arbitrary POSIX pipelines using standard shell primitives.

Every module conforms to the **shared library contract**:

* Input: exactly one NDJSON object per line (via `safeRead()` or `parseLine()`).
* Output: exactly one NDJSON object per line (via `safeWrite()`).
* Metadata: `{ meta: { timestamp, pipeline }, data: {} }` enforced through `normalizeObject()`.
* Tagging: applied via `createMeta()` and `appendTag()` according to the global `TAG_ENABLED` flag.
* Logging: through `logError`, `logWarn`, `logWarning`, `logInfo`, governed by `LOG_LEVEL`.

### **3.1.1 — Module Categories**

Modules fall into six architectural categories. These categories define each module’s semantic role and permissible operations on the NDJSON object.

1. **Source Modules**
   *Create* NDJSON objects from external data streams (files, serial ports, sensors, CSV logs).
   They do not forward arbitrary upstream fields; instead they define new `data` objects from the incoming external data.
   Sources are allowed to introduce domain-specific mapping logic when driven by engineering constraints (e.g., Arduino line format, CSV column maps).

2. **Sink Modules**
   Consume NDJSON streams and write them to disk, files, FIFOs, terminals, or visualization tools.
   They never alter `data`, except for pipeline-tag updates.

3. **Adapter Modules**
   Bridge between NDJSON streams and bidirectional hardware interfaces (e.g., Modbus RTU).
   They perform both reads (source-like) and writes (sink-like) under a single process, constrained by hardware semantics.

4. **Control-Flow Modules**
   Modify the *timing*, *topology*, or *gating* of NDJSON streams without altering data semantics.
   Examples: merge-streams, split-streams, gate, minrate.

5. **Transformer Modules**
   Perform numeric or logical transformations of existing data fields, always in-place unless explicitly configured otherwise.
   The most general form is `tmcp-transformer-reduce.js`, supporting declarative multi-pass arithmetic and conditional logic.

6. **Annotation Modules**
   Add new, higher-level semantic fields to the NDJSON object without modifying existing fields.
   Examples: derivative, stalled, state-machine.

### **3.1.2 — Category Contract**

Each category imposes strict behavioral constraints:

* **Sources** construct `data` objects from scratch → never forward unknown fields.
* **Transformers** modify configured fields in-place → preserve all unconfigured fields (unless using a projection policy like `forward_policy:"known"`).
* **Annotation modules** add fields but never change existing ones.
* **Control-flow** modules must not mutate `data` at all.
* **Adapters** may read and write hardware values and thus behave as both source and sink, but must not encode domain semantics.

### **3.1.3 — Extensibility**

New modules may be introduced at any time as long as they obey:

* The NDJSON contract
* The I/O and timing invariants
* The module-category behavioral rules
* The shared-library API (`safeRead`, `safeWrite`, metadata, tagging, logging)

Future source modules (e.g., UDP sources, IPC feeds, ROS bridges) may follow the patterns below and should be documented using the same Section 3.2 structure.

---

## **3.2 — Source Modules**

Source modules **produce** canonical NDJSON objects from external inputs.
They are the beginning of most TMCP pipelines, and their upstream data format is determined by hardware or data files rather than by TMCP.

The repository currently contains three source modules:

1. `tmcp-source-file.js` — NDJSON replay with optional pausing
2. `tmcp-source-arduino.js` — live Arduino sensor source with filter-index handshake
3. `tmcp-source-csv.js` — CSV file source with timestamp normalization and pacing

Each module is described fully below.

---

# **3.2.1 — `tmcp-source-file.js`**

### **Functional Summary**

`tmcp-source-file.js` replays NDJSON files with **real-time timing reconstruction** and optional **interactive pausing**.
It reads one NDJSON file, buffers the parsed messages internally, and then emits them at the original inter-record intervals.
In pausing mode, stdin acts as a *side-channel control stream* where frames `{ data:{ paused:true|false } }` toggle emission.

Key behaviors:

* Without `--pausing`: stdin is ignored; the module exits at EOF.
* With `--pausing`: stdin never terminates the process; it only toggles pausing.
* When paused: the module emits periodic “paused clones” of the last message to keep downstream pipelines alive.
* Real-time replay uses the original timestamps in the file to reproduce Δt delays.

### **CLI Interface**

```
node tmcp-source-file.js <replay_file> \
  [--interval-ms N] \
  [--pausing] \
  [--exit-on-eof]
```

| Argument          | Meaning                                      |
| ----------------- | -------------------------------------------- |
| `<replay_file>`   | Path to NDJSON file to replay                |
| `--interval-ms N` | Pause-clone tick interval (ms) while paused  |
| `--pausing`       | Enable side-channel control via stdin        |
| `--exit-on-eof`   | In pausing mode, exit after unpausing at EOF |

### **Configuration Schema**

No JSON config file is used.
Configuration is provided exclusively via CLI flags, parsed through `parseParams()`.

### **Runtime Behavior**

#### **File Loading**

* Each line is parsed with `parseLine()`, normalized, and stored as `{ ts, meta, data }`.
* Messages lacking a numeric `meta.timestamp` are discarded.
* Records are sorted by timestamp after loading.

#### **Replay Mechanics**

* First record is emitted immediately.
* For each subsequent record, inter-record delay = difference in file timestamps.
* Timestamps in outgoing messages are updated to current wall-clock time (`Date.now()`).

#### **Pausing Mode**

When `--pausing` is enabled:

* stdin is treated as a **side-channel** using:

  ```js
  safeRead(callback, undefined, {
    channelId: "stdin",
    exitOnClose: false,
    retry: false
  });
  ```

  This ensures **stdin EOF never terminates the replay process**.

* The side-channel listens for:

  ```json
  { "data": { "paused": true | false } }
  ```

* Upon pausing:

  * Emit paused clones at fixed intervals (`--interval-ms`).
  * Clone timestamps are fresh (`Date.now()`).
  * Clone data payload is identical.

* Upon unpausing:

  * Move to next file record and resume real-time replay.
  * If at EOF and `--exit-on-eof` is set → exit immediately.

#### **EOF Handling**

* Non-pausing mode: exit at EOF.
* Pausing mode: remain alive emitting paused clones unless `--exit-on-eof` and unpaused at EOF.

### **Integration with Shared Library**

| Function              | Role                                                   |
| --------------------- | ------------------------------------------------------ |
| `parseLine()`         | Parse input file lines into pipeline objects           |
| `appendTag()`         | Tag outgoing messages with `"fsp"`                     |
| `safeWrite()`         | Emit NDJSON respecting OUT_PROTOCOL and channel policy |
| `safeRead()`          | Control-channel listener for pausing                   |
| `logError`, `logInfo` | Diagnostics                                            |

### **Example Pipeline Usage**

```
tmcp-source-file.js session.ndjson \
  --pausing --interval-ms 50 \
  | tmcp-transformer-reduce.js conf.json \
  | tmcp-sink-file.js replay-output.ndjson
```

### **Operational Notes**

* stdin is never a “main stream”; it is always side-channel control.
* Channel policy is critical: `exitOnClose:false` prevents accidental termination.
* Ideal for replay-based debugging, limit-stream reconstruction, or synthetic command feeds.

---

# **3.2.2 — `tmcp-source-arduino.js`**

### **Functional Summary**

`tmcp-source-arduino.js` is a live sensor source for **serial-connected Arduino devices**.
It reads delimited numeric data lines, optionally uploads a “filter index list” to the device via a brief handshake, and emits normalized TMCP NDJSON frames.

This module **is intentionally domain-specific**, optimized for the current glove prototype.
Its structure reflects an engineering tradeoff: keeping the module simple and robust while delegating mapping and semantics to configuration.

Features:

* Automatic serial-port connection
* Optional filter-index upload (per device protocol)
* Two decoding modes:

  * **Filtered mode** (device returns only mapped columns)
  * **Unfiltered mode** (full row, needs column indexing)
* Emission of TMCP objects with fresh `meta.timestamp` and pipeline tag `"asrc"`

### **CLI Interface**

```
node tmcp-source-arduino.js <serial_port> <config_file>
```

### **Configuration Schema**

The config file must contain:

```json
{
  "arduinoSource": {
    "baudRate": 9600,
    "fieldMap": { "<label>": <columnIndex>, ... },
    "enableFilterUpload": true,
    "handshakeRetries": 3
  }
}
```

| Field                | Meaning                                         |
| -------------------- | ----------------------------------------------- |
| `baudRate`           | Serial baud rate                                |
| `fieldMap`           | Map of output field names → data column indices |
| `enableFilterUpload` | Whether to upload filter indexes to device      |
| `handshakeRetries`   | Retry attempts for `#` pause command            |

### **Runtime Behavior**

#### **Serial Initialization**

* Opens the serial port at configured baud.
* Wraps it in a line-oriented parser (`ReadlineParser`).
* Begins handshake if enabled.

#### **Filter Handshake**

The module performs:

1. Send `#` commands to pause device output.
2. Wait for `#PAUSED`.
3. Send `#FILTER <indices...> @`.
4. Wait for `#FILTER-OK`.
5. Send `#CONTINUE`.
6. Wait for `#CONTINUE-OK`.

This handshake is entirely domain-provided; TMCP imposes no semantics on it.

#### **Data Parsing**

Depending on whether the filter was acknowledged:

* **Filtered mode:**
  The device sends exactly the mapped fields in order → parse by index.

* **Unfiltered mode:**
  Parse full parts array and extract fields using `fieldMap` column indices.

All parsed values are `parseInt()` validated and dropped if not numeric.

#### **NDJSON Emission**

Each message emitted as:

```
{
  meta: createMeta("asrc"),
  data: { <fields...> }
}
```

Timestamps are from `Date.now()`.

### **Integration with Shared Library**

| Function              | Purpose                                |
| --------------------- | -------------------------------------- |
| `createMeta()`        | Assigns tag `"asrc"` and timestamp     |
| `safeWrite()`         | Emits NDJSON according to OUT_PROTOCOL |
| `loadConfig()`        | Reads config file safely               |
| `logInfo`, `logError` | Diagnostics for serial events          |

### **Example Pipeline Usage**

```
tmcp-source-arduino.js /dev/ttyUSB0 conf-arduino.json \
  | tmcp-transformer-kalman.js conf-filter.json \
  | tmcp-sink-viewer.js conf-view.json
```

### **Operational Notes**

* If the device never acknowledges filter upload, the module falls back to unfiltered mode.
* Serial errors are logged and do not terminate the module.
* This module reflects a tuned implementation for the BrighterSignals glove, not a fully generic TMCP serial-source framework.

---

# **3.2.3 — `tmcp-source-csv.js`**

### **Functional Summary**

`tmcp-source-csv.js` converts CSV files into TMCP NDJSON streams with optional pacing.
It is used for offline seat-sensor data replay, multi-session mining, and any workflow requiring stable timestamp normalization.

This module is **deliberately domain-specific**:
it assumes a timestamp column in `HH:MM:SS.mmm` format and maps CSV columns into numeric TMCP fields.

Features:

* Column mapping into named TMCP fields
* Session ID injection (filename without extension)
* High-fidelity timestamp normalization: absolute → relative → wall-clock anchored
* Optional pacing: fixed interval or rate (records/sec)
* Pure NDJSON source (no stdin control)

### **CLI Interface**

```
node tmcp-source-csv.js <config_file> <csv_file> \
  [--interval-ms N] \
  [--rate R]
```

Configuration is via JSON file + CLI parameters parsed by `parseParams()`.

### **Configuration Schema**

```
{
  "csvSource": {
    "delimiter": ",",
    "timeColumn": 0,
    "timeField": "t_ms",
    "fieldMap": { "<name>": <columnIndex>, ... },
    "filenameField": "sid"
  }
}
```

| Field           | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| `delimiter`     | CSV delimiter (`,` or tab; module uses regex supporting both) |
| `timeColumn`    | Column index containing HH:MM:SS.mmm timestamp                |
| `timeField`     | Output field name for the relative timestamp                  |
| `fieldMap`      | Map of output names → column indices                          |
| `filenameField` | Field under which to store session ID                         |

### **Runtime Behavior**

#### **CSV Parsing**

* Streamed line-by-line using `fs.createReadStream()` + `readline`.
* Each line split using mixed delimiter regex (`/[,\t]/`).
* `HH:MM:SS.mmm` timestamp is parsed into **absolute milliseconds**.

#### **Timing Model (detailed)**

1. Read timestamp string, convert to absolute time in ms:

   ```
   absoluteMs = h*3600000 + m*60000 + s*1000 + ms
   ```
2. Determine session start (`t0`) as absoluteMs of first row.
3. Compute **session-relative** time:

   ```
   t_ms = absoluteMs - t0
   ```
4. Anchor wall-clock time:

   * Record current wall-clock (`anchorWallClock = Date.now()`) at module startup.
   * Derive pipeline timestamp as:

     ```
     meta.timestamp = anchorWallClock + t_ms
     ```

   This ensures replay time aligns with pipeline timing without disturbing global wall-clock semantics.

#### **Session Identity**

`sid = basename(csvFile without extension)` is injected as a normal data field.

#### **Emission Modes**

* **Immediate mode:** (default when no pacing flags)
  Emit rows as fast as possible in order.

* **Paced mode:**

  * `--interval-ms N`: one record every N ms
  * `--rate R`: one record every (1000/R) ms

Internally:

* Parsed rows enter a buffer immediately.
* A timer drains the buffer according to pacing parameters.
* When both `doneReading` and `buffer.length === 0`, the process exits.

### **Integration with Shared Library**

| Function               | Purpose                                |
| ---------------------- | -------------------------------------- |
| `createMeta("csvsrc")` | Assigns timestamp and tag              |
| `safeWrite()`          | Emits NDJSON depending on OUT_PROTOCOL |
| `parseParams()`        | Resolves CLI arguments for pacing      |
| `logError`, `logInfo`  | Diagnostics                            |

### **Example Pipeline Usage**

```
tmcp-source-csv.js conf-seat.json seat01.csv --rate 20 \
  | tmcp-transformer-reduce.js conf-cleaning.json \
  | tmcp-sink-file.js seat01-processed.ndjson
```

### **Operational Notes**

* This module is intentionally tailored for offline seat-sensor datasets.
* Timestamp parsing is strict; malformed timestamps are skipped.
* Since it calculates meta timestamps using an anchored wall clock, replay speed and downstream modules behave correctly.
* No stdin or control messages are interpreted.

---

# **3.2.4 — `tmcp-source-dsmr.js` — DSMR (Dutch Smart Meter) P1 Telegram Source**

### **Functional Summary**

`tmcp-source-dsmr.js` is a **domain-specific TMCP source module** that reads and parses DSMR (Dutch Smart Meter) P1 telegrams from a serial interface (typically a USB-to-serial P1 cable). It extracts configurable OBIS (Object Identification System) data points, performs optional CRC validation, and emits TMCP-normalized NDJSON objects with extracted fields such as power, energy, timestamps, and gas consumption.

This module is intentionally **semantic-free in code**: all field extraction, unit conversion, and OBIS mapping is defined in a JSON configuration file, adhering to the TMCP principle of externalizing domain knowledge.

### **CLI Interface**

```bash
node tmcp-source-dsmr.js <config_file> [serial_port]
```

*   `<config_file>` — Required JSON configuration file containing a `dsmrSource` block.
*   `[serial_port]` — Optional override for the serial device path (e.g., `/dev/ttyUSB0`). If omitted, the path from the config file is used.

### **Configuration Schema**

Configuration is loaded via `loadConfigFile()` and expects a `dsmrSource` object:

```json
{
  "dsmrSource": {
    "device": "/dev/ttyUSB0",
    "baudRate": 115200,
    "parity": "none",
    "dataBits": 8,
    "stopBits": 1,
    "lineDelimiter": "\n",
    "sendRequestOnConnect": false,
    "requestString": "/?!\r\n",
    "controlLines": { "dtr": true, "rts": true },
    "crcCheck": false,
    "emitRawTelegram": false,
    "emitObisMap": true,
    "minEmitIntervalMs": 0,
    "extract": {
      "grid_import_w": {
        "obis": "1-0:1.7.0",
        "group": 0,
        "as": "number",
        "targetUnit": "W"
      },
      "meter_timestamp": {
        "obis": "0-0:1.0.0",
        "group": 0,
        "as": "timestamp"
      }
    }
  }
}
```

**Key Configuration Fields:**

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `device` | string | `/dev/ttyUSB0` | Serial port path. |
| `baudRate` | number | 115200 | Baud rate. |
| `lineDelimiter` | string | `"\n"` | Line delimiter for the DSMR telegram. |
| `sendRequestOnConnect` | boolean | false | Send a request string to initiate meter transmission. |
| `crcCheck` | boolean | false | Enable CRC-16 validation of the telegram. |
| `emitRawTelegram` | boolean | false | Include the raw telegram text in the output under `raw_telegram`. |
| `emitObisMap` | boolean | true | Include the full parsed OBIS map in the output under `obis`. |
| `minEmitIntervalMs` | number | 0 | Minimum milliseconds between emitted messages (throttling). |
| `extract` | object | *(See defaults in code)* | Mapping of output field names to OBIS extraction rules. |

**Extraction Rule Schema (`extract`):**
Each key defines an output field. The value is an object with:
*   `obis` (string): The OBIS code (e.g., `"1-0:1.7.0"`).
*   `group` (number): The data group index within the OBIS line (usually 0).
*   `as` (string): Processing type: `"number"`, `"timestamp"`, or `"raw"`.
*   `targetUnit` (string, optional): Target unit for numeric conversion (e.g., `"W"` for Watts). Supports `kW`↔`W`, `kWh`↔`Wh`.
*   `default` (any, optional): Fallback value if the OBIS code is missing.

### **Runtime Behavior**

#### **Serial Initialization**
* Opens the specified serial port with the configured parameters (baud, parity, etc.).
* Applies optional `controlLines` (DTR/RTS) if specified.
* If `sendRequestOnConnect` is true, sends the `requestString` to the meter.

#### **Telegram Accumulation & Parsing**
* Reads lines using the configured `lineDelimiter`.
* Accumulates lines starting with `/` until a line starting with `!` (end of telegram).
* Parses the accumulated telegram:
    1.  Splits each OBIS line into `key` and data `groups`.
    2.  Builds an internal OBIS map: `{ "1-0:1.7.0": ["0.0.0*kW", ...], ... }`.

#### **Field Extraction & Output**
For each field defined in the `extract` configuration:
*   Locates the corresponding `groups` using the `obis` code.
*   Selects the data at the specified `group` index.
*   Processes according to the `as` type:
    *   `"number"`: Parses numeric value and optional unit (e.g., `0.456*kW`), applies `targetUnit` scaling if needed.
    *   `"timestamp"`: Converts DSMR timestamp string (e.g., `240518120000W`) to ISO 8601 format.
    *   `"raw"`: Returns the string value unchanged.
*   If the field is missing and a `default` is provided, uses that value.
*   Constructs the final `data` object with all successfully extracted fields.

#### **Optional Features**
*   **CRC Validation**: If `crcCheck` is true, validates the telegram's CRC-16 checksum and adds `crc_ok`, `crc_expected`, `crc_computed` fields to the output. A mismatch logs a warning but does not stop emission.
*   **Diagnostic Output**: If `emitObisMap` is true, the full parsed OBIS map is added under the `obis` field. If `emitRawTelegram` is true, the raw telegram text is added under `raw_telegram`.

#### **NDJSON Emission**
Each successfully parsed telegram results in one TMCP NDJSON object:
```json
{
  "meta": { "timestamp": 1716223142000, "pipeline": ["dsmr"] },
  "data": {
    "grid_import_w": 456.0,
    "meter_timestamp": "2024-05-20T12:00:00+01:00",
    "obis": { ... },
    "crc_ok": true
  }
}
```
*   Tag: `"dsmr"`
*   Timestamp: `Date.now()` at the moment of emission.

### **Integration with Shared Library**

| Function | Role |
| :--- | :--- |
| `loadConfigFile()` | Loads the `dsmrSource` configuration. |
| `createMeta("dsmr")` | Creates the output object's metadata with the correct tag. |
| `safeWrite()` | Emits the NDJSON object according to `OUT_PROTOCOL`. |
| `logInfo`, `logError`, `logWarn` | Diagnostics for serial events, parsing errors, and CRC mismatches. |

### **Example Pipeline Usage**

```bash
# Basic usage with config
tmcp-source-dsmr.js sc_confs/conf-read-smartmeter.json

# Override serial port
tmcp-source-dsmr.js sc_confs/conf-read-smartmeter.json /dev/ttyACM0

# Pipe to a file sink for logging
tmcp-source-dsmr.js sc_confs/conf-read-smartmeter.json | tmcp-sink-file.js power-log.ndjson

# Pipe to a real-time viewer (requires a compatible viewer config)
tmcp-source-dsmr.js sc_confs/conf-read-smartmeter.json | tmcp-sink-viewer.js conf-grid-view.json
```

### **Operational Notes**

*   This module is **tailored for DSMR P1 telegrams** (commonly used in the Netherlands and Belgium). It is not a generic serial or Modbus source.
*   The extraction configuration (`extract`) provides the necessary **domain semantics**. The module itself contains no hardcoded knowledge of specific meters or OBIS codes.
*   For reliable operation, ensure the serial port parameters (baud rate, parity) match the meter's specifications. A `baudRate` of 115200 is typical for DSMR 4.0/5.0 meters.
*   CRC validation is off by default (`crcCheck: false`) due to variations in meter implementations and P1 adapter framing. Enable it for additional data integrity verification where supported.

---

# **3.3 — Sink Modules**

Sink modules consume NDJSON streams and write them to files, visualization outputs, or other terminal-based representations.
They **never modify the semantic contents** of `data`, except for tagging, and they never drive control logic or gating.
All sinks read from stdin via `safeRead()` unless explicitly noted.

The repository contains three sink modules:

1. **`tmcp-sink-file.js`** — append-only NDJSON file sink
2. **`tmcp-sink-viewer.js`** — real-time terminal grid viewer
3. **`tmcp-sink-csv.js`** — structured CSV sink with per-session file management

Each is documented below using the canonical module structure.

---

# **3.3.1 — `tmcp-sink-file.js`**

### **Functional Summary**

`tmcp-sink-file.js` appends every incoming NDJSON object to a given output file.
It is the simplest possible sink: it performs no filtering, transformation, or formatting beyond adding a pipeline tag (`"fsnk"`) unless tagging is disabled.

Characteristics:

* Always writes NDJSON (MsgPack output is not supported by this sink).
* Safe for long-running pipelines.
* Appends indefinitely unless terminated.

### **CLI Interface**

```
node tmcp-sink-file.js <output_file>
```

* `<output_file>` — path to file written in append mode (`flags:"a"`).

### **Configuration Schema**

No JSON configuration is used.
All configuration is via CLI.

### **Runtime Behavior**

* The sink opens `output_file` as an append-only writable stream.
* Uses `safeRead()` to process stdin as NDJSON or MsgPack (depending on global IN_PROTOCOL).
* For each incoming object:

  * Appends `"fsnk"` to `meta.pipeline` via `appendTag`.
  * Serializes the object as NDJSON using `JSON.stringify(obj)` + newline.
  * Writes to the file; warnings are logged with `logWarn` on write errors.

### **Integration With Shared Library**

| Function              | Purpose                             |
| --------------------- | ----------------------------------- |
| `safeRead()`          | Read stdin in protocol-agnostic way |
| `appendTag()`         | Apply `"fsnk"` tag                  |
| `logError`, `logWarn` | Diagnostics                         |

### **File Handling and Shutdown**

* On SIGINT: file stream is cleanly closed before exit.
* Does not handle per-session file splitting; always writes to a single file.

### **Example Usage**

```
tmcp-source-file.js session.ndjson \
  | tmcp-transformer-reduce.js conf-clean.json \
  | tmcp-sink-file.js cleaned.ndjson
```

### **Operational Notes**

* NDJSON-only output is intentional and canonical; MsgPack output is reserved for future development.
* Synchronous FS semantics are avoided; Node stream handles backpressure.
* Does not support truncation; always append.

---

# **3.3.2 — `tmcp-sink-viewer.js`**

### **Functional Summary**

`tmcp-sink-viewer.js` is a **terminal-based visual sink** for rendering TMCP fields onto a 2D grid.
It is intended for live inspection of sensor arrays, state machines, boolean patterns, or compact summaries.

This sink is intentionally **domain-neutral**:
all display mapping comes from the configuration file.

Capabilities:

* Renders a grid of configurable size (`gridWidth × gridHeight`).
* Supports per-cell label display.
* Color-coded numeric and boolean values.
* Enumerated value display via `enumMap`.
* Full-screen terminal redraw per frame (using ANSI clear).

### **CLI Interface**

```
node tmcp-sink-viewer.js <config_file>
```

### **Configuration Schema**

Example:

```json
{
  "gridViewer": {
    "gridWidth": 11,
    "gridHeight": 8,
    "gridMap": { "fl": [0,0], "fr": [0,1], ... },
    "enumMap": { "state": { "0": "idle", "1": "contact" } },
    "showLabels": true,
    "cellWidth": 4,
    "booleanColors": false
  }
}
```

Where:

* `gridMap[label] = [y, x]` maps a field to a grid cell.
* `enumMap[label][value] = "display_string"` replaces raw values with human-readable names.
* If `showLabels = true`:

  * each cell uses height 2 (label row + value row)
  * else height 1.

### **Runtime Behavior**

* Uses `safeRead()` with `linger:true` to keep the viewer alive until upstream closes.
* For each incoming object:

  * Append tag `"vsnk"`.
  * Generate a text grid based on config.
  * Use chalk to colorize numeric, boolean, and enum values.
  * Clear the terminal (`"\x1Bc"`) and redraw the entire grid.

### **Integration With Shared Library**

| Function       | Purpose                       |
| -------------- | ----------------------------- |
| `safeRead()`   | Protocol-agnostic ingestion   |
| `appendTag()`  | Adds `"vsnk"` tag             |
| `loadConfig()` | Loads mapping & visual layout |
| `logError`     | Diagnostics                   |

### **Example Usage**

```
tmcp-source-arduino.js /dev/ttyUSB0 conf-arduino.json \
  | tmcp-transformer-kalman.js conf-kalman.json \
  | tmcp-sink-viewer.js conf-viewer.json
```

### **Operational Notes**

* Clears screen every frame; optimized for ~5–30 FPS typical TMCP pipeline rates.
* Values outside the grid map are ignored.
* Safe for mixed numeric, boolean, and enumerated fields.
* Does not write files; this is a pure interactive sink.

---

# **3.3.3 — `tmcp-sink-csv.js`**

### **Functional Summary**

`tmcp-sink-csv.js` is a structured CSV sink for TMCP pipelines.
Unlike `tmcp-sink-file.js`, which writes one NDJSON line per object, this sink:

* Extracts selected fields from each object,
* Places them into fixed column indices,
* and writes them as CSV rows.

It supports **per-session file splitting**, determined by a data field (e.g. `sid`), and optionally truncates output files on first write.

Intended primarily for seat-sensor pipelines and offline analysis workflows.

### **CLI Interface**

```
node tmcp-sink-csv.js <config_file>
```

### **Configuration Schema**

The config must contain a `csvSink` block:

```
{
  "csvSink": {
    "filenameField": "sid",
    "filenameDefault": "unknown",
    "filenamePrefix": "",
    "truncateOnOpen": false,
    "columns": { "<fieldName>": <columnIndex>, ... },
    "outputDir": "."
  }
}
```

Field meanings:

* **`filenameField`** — data field used to choose output filename (per-session).
* **`filenameDefault`** — fallback when session ID missing or empty.
* **`filenamePrefix`** — prepended to session ID for the output file.
* **`truncateOnOpen`** — if true → open files with `"w"`; else append (`"a"`).
* **`columns`** — required mapping of TMCP data fields → CSV column indices.
* **`outputDir`** — directory where session CSV files are created.

### **Runtime Behavior**

#### **Column Mapping Validation**

* `columns` must be non-empty.
* Every index must be a non-negative integer.
* Highest index determines row width.

#### **Per-Session File Management**

* Maintains a `writers` map from `sid` → open file stream.
* On first use of an `sid`:

  * Creates directory (if needed).
  * Opens `filenamePrefix + sid + ".csv"` in `"w"` or `"a"` mode.
  * Logs file creation via `logInfo`.
* On termination (`stdin` end or error), closes all writers gracefully.

#### **CSV Row Generation**

* Builds an array of `rowWidth` blank strings.
* For each `<fieldName, colIndex>` in `columns`:

  * Looks up `data[fieldName]`.
  * Writes sanitized CSV value at the appropriate index.
* Quotes fields containing `"`, `,`, newlines, or CR characters (CSV spec).

#### **Record Routing**

* For each incoming record:

  * Extract `sid` from `data[filenameField]` (or use default).
  * Obtain writer via `getWriterForSid()`.
  * Serialize row and write.

### **Integration With Shared Library**

| Function              | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `safeRead()`          | Protocol-agnostic read of upstream NDJSON/MsgPack |
| `parseParams()`       | CLI parsing for config file                       |
| `logError`, `logInfo` | Diagnostics                                       |

### **Example Workflow**

```
tmcp-source-csv.js conf-seat.json data/sessionA.csv --rate 25 \
  | tmcp-transformer-reduce.js conf-clean.json \
  | tmcp-sink-csv.js conf-sink.json
```

Produces:

```
outputDir/
  prefixA.csv
  prefixB.csv
  prefixC.csv
```

(each derived from different `sid` values in the input stream)

### **Operational Notes**

* This sink is **deliberately domain-specific** to handle structured row output for seat-sensor pipelines.
* It is not intended as a general TMCP table-sink module; additional sinks can be added as needed.
* Because filenames depend on `sid`, changing the `filenameField` introduces new file-splitting behavior.
* The module never writes headers; downstream tools should know column order.

---

# **3.4 — Adapter Modules**

Adapter modules are *bidirectional* TMCP components that act simultaneously as:

* **Sources** (emit NDJSON objects from hardware), and
* **Sinks** (consume NDJSON objects from the upstream pipeline).

Unlike pure sources or pure sinks, adapters must coordinate real-time I/O with external devices.
They therefore combine responsibilities normally separated in TMCP architectures.

Adapter modules must still obey the architectural guarantees:

* No domain semantics beyond direct hardware mappings.
* No mutation of unconfigured fields.
* No reinterpretation of upstream `data` fields beyond the declared mapping.
* A single NDJSON object per write, fully normalized.
* Full use of shared-library facilities (`safeRead`, `safeWrite`, tagging, logging).

The repository currently contains one adapter module:

1. `tmcp-adapter-modbus.js` — Modbus RTU adapter for glove-controller hardware

---

# **3.4.1 — `tmcp-adapter-modbus.js`**

### **Functional Summary**

`tmcp-adapter-modbus.js` implements a **combined Modbus RTU source + sink** used to interface with the glove’s microcontroller board.
It periodically *reads* a block of Modbus registers and emits them as TMCP NDJSON objects, while also *writing* to a configurable block of registers based on incoming NDJSON fields.

This module is *almost* domain-agnostic:
the only domain constraint is that it uses one contiguous array of Modbus holding registers for both reading and writing — sufficient for the current glove controller, but not a general Modbus framework.

Capability summary:

* Read a configured block of holding registers at `readRate` interval
* Write to a configured block of holding registers with rate throttling
* Fully safe concurrent RTU access using an internal async lock
* Tagging: `"mbx"`
* Supports `--dry-run` and `--dry-run-read` for simulation/testing
* Uses `safeRead()` for pipeline input and `safeWrite()` for outbound NDJSON

### **CLI Interface**

```
node tmcp-adapter-modbus.js <config_file> [device_path] \
  [--dry-run] [--dry-run-read]
```

Where:

* `<config_file>` — required JSON configuration
* `[device_path]` — optional override for serial device path
* `--dry-run` — suppresses actual Modbus writes
* `--dry-run-read` — suppresses all Modbus connection attempts

### **Configuration Schema**

The config file must contain a `modbus` block:

```json
{
  "modbus": {
    "device": "/dev/ttyUSB0",
    "baud": 115200,
    "slaveId": 1,

    "writeBaseRegister": 1486,
    "minWriteRate": 200,
    "maxWriteRate": 20,

    "readBaseRegister": 1546,
    "readRate": 50,

    "registerCount": 6,

    "mapping": {
      "<dataFieldName>": <registerIndex>,
      ...
    }
  }
}
```

Field meaning:

| Field               | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `device`            | Serial path for Modbus RTU                                  |
| `baud`              | Baud rate                                                   |
| `slaveId`           | Modbus address                                              |
| `writeBaseRegister` | First register written when sending outputs                 |
| `minWriteRate`      | Minimum ms between consecutive writes                       |
| `maxWriteRate`      | Maximum ms since input-triggered write before forcing write |
| `readBaseRegister`  | First register to poll                                      |
| `readRate`          | Interval in ms between polls                                |
| `registerCount`     | Number of contiguous registers to read/write                |
| `mapping`           | Mapping of TMCP data fields ↔ register indices              |

### **Runtime Behavior**

#### **Modbus Connection**

* On startup, attempts asynchronous connection with retries.
* Connection parameters (`baud`, parity, bits) come directly from config.
* On serial error (CRC, Timeout, EIO, EPIPE, EBUSY), client is closed and reconnection scheduled.

`--dry-run-read` disables all attempts to connect.

#### **Register Reading**

Driven by:

```js
setInterval(pollRegisters, readRate);
```

The read loop:

1. Reads `registerCount` holding registers starting at `readBaseRegister`.

2. Constructs:

   ```
   { meta: createMeta("mbx"), data:{...mapped fields...} }
   ```

3. `safeWrite(obj)` emits the object to stdout following OUT_PROTOCOL.

4. Errors trigger reconnection logic but do not crash the module.

In `--dry-run-read` mode it emits zero-filled values.

#### **Upstream NDJSON Input**

Inbound messages from the pipeline are consumed using:

```js
safeRead(callback)
```

For each incoming object:

* Tag `"mbx"` is appended.
* For each `<label, registerIndex>` in `mapping`, if `record.data[label]` is a finite number, it updates `currentValues[registerIndex]`.

This module never modifies fields that are not part of the Modbus mapping.

#### **Write Engine and Rate Control**

The module implements two-rate control semantics using:

* `minWriteRate` — ensures baseline write frequency
* `maxWriteRate` — ensures responsiveness if input changes rapidly

Tracking variables:

* `currentValues[]` — desired next register contents
* `writtenValues[]` — last written register contents
* `pendingWrite` flag
* `lastWriteTs` timestamp

Writes happen via:

```js
client.writeRegisters(writeBase, regs)
```

Where values:

* are rounded
* are clamped to `[0, 1000]`
* come from `currentValues[]`

The logic ensures:

* If upstream input changes and enough time (`maxWriteRate`) has passed, write immediately.
* Otherwise, schedule writes with a 5 ms high-resolution timer.
* Periodically enforce `minWriteRate` writes even if unchanged.

`--dry-run` logs intended writes but does not perform hardware operations.

#### **Concurrency Protection**

All Modbus operations run under a shared async lock:

```js
withLock(async () => { ... })
```

This enforces:

* No interleaving of read/write commands
* No overlapping RTU traffic
* Stable behavior even under heavy input load

### **Integration With Shared Library**

| Function                       | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `safeRead()`                   | Read upstream NDJSON/MsgPack controlling write values |
| `safeWrite()`                  | Emit Modbus register snapshots                        |
| `createMeta()`                 | Build source-side packets                             |
| `appendTag()`                  | Add `"mbx"` tag to inbound packets                    |
| `loadConfig()`                 | Fetch Modbus settings                                 |
| `logError`/`logWarn`/`logInfo` | Diagnostics and error handling                        |

### **Example Pipeline Usage**

```
tmcp-source-arduino.js /dev/ttyUSB0 conf-arduino.json \
  | tmcp-transformer-reduce.js conf-actuation.json \
  | tmcp-adapter-modbus.js conf-modbus.json
```

### **Operational Notes**

* This module is **simple by design**: it assumes one contiguous register block each for read and write.
* It imposes **no domain semantics**, only raw Modbus register access.
* In dry-run modes, upstream commands still drive rate logic but no hardware communication occurs.

---

## 3.5 Control-flow modules

Control-flow modules operate *on the timing and selection* of messages, rather than on their domain content.
They never introduce domain semantics themselves; instead they:

* block or release flow based on configurable conditions,
* drop uninteresting messages (deduplication),
* enforce minimum output rates via cloning,
* tee a stream into side channels, and
* merge multiple time-aligned streams into a single composite stream.

All control-flow modules:

* Consume a single primary input stream from **stdin** via `safeRead()`.
* Preserve the pipeline object model `{ meta, data }` and tagging rules.
* Append their own short tag to `meta.pipeline` (if tagging is enabled).
* Emit to **stdout** via `safeWrite()` with the usual pipeline exit-on-close behavior (unless explicitly documented otherwise for side channels).

The subsections below document the currently implemented control-flow modules:

* `tmcp-control-gate.js` – conditional startup gate.
* `tmcp-control-minrate.js` – minimum-rate cloning.
* `tmcp-control-dedup.js` – data-based deduplication.
* `tmcp-control-split-streams.js` – non-blocking tee to side channels.
* `tmcp-control-merge-streams.js` – time-aligned multi-stream merge.

---

### 3.5.1 `tmcp-control-gate.js` — conditional startup gate

**Purpose**

`tmcp-control-gate.js` blocks all incoming messages until a configurable set of activation conditions is satisfied.
Once the gate opens, every subsequent message is passed through unconditionally.

This is typically used to:

* wait for “system ready” conditions from upstream modules, or
* ensure that recorded streams only start once a certain state has been reached.

**CLI**

```bash
tmcp-control-gate.js <config_file>
```

* `<config_file>` – JSON configuration file read via `loadConfig()`.

If the argument is missing, the module prints a usage error via `logError()` and exits with code `1`.

**Configuration**

The module expects a `gate` block in the config. This may be:

* a single object:

  ```json
  {
    "gate": {
      "must_have": ["fieldA", "fieldB"],
      "min_values": { "fieldA": 10 },
      "bool_equal": { "ready": true },
      "str_equal": { "mode": "run" },
      "max_age_ms": 250,
      "timeout_ms": 2000
    }
  }
  ```

* or an array of objects:

  ```json
  {
    "gate": [
      { ...block1... },
      { ...block2... }
    ]
  }
  ```

If `gate` is omitted or empty, the normalized block list is empty and the gate will open on the **first** message (effectively disabled).

For each block:

* `must_have` (array of strings, optional)

  * All listed keys **must** be present in `obj.data`.
* `min_values` (object: field → number, optional)

  * For each entry, `data[field]` must be numeric and ≥ the configured `min_values[field]`.
* `bool_equal` (object: field → boolean, optional)

  * If the configured value is `true`:

    * the field must exist in `data` and be strictly `true`.
  * If the configured value is `false`:

    * if the field exists, it must be strictly `false`;
      if it is missing, that **does not** fail the block.
* `str_equal` (object: field → string, optional)

  * Each field must exist and its value must strictly equal the given string.
* `max_age_ms` (number, optional)

  * If set, the input object must have a numeric `meta.timestamp`.
  * The message age `Date.now() - meta.timestamp` must be ≤ `max_age_ms`.
  * Missing or non-numeric timestamps cause this check to fail.
* `timeout_ms` (number, optional; default `2000`)

  * For logging only: if the gate has not activated after the max of all `timeout_ms` values, the module logs a one-time warning:

    * `tmcp-control-gate: still blocked after <maxTimeout> ms; waiting for activation conditions.`
  * The timeout does **not** open the gate; it is purely informational.

**Runtime behavior**

* The module uses `safeRead()` on stdin.

* For each incoming object:

  1. If the gate is **not yet activated**:

     * It evaluates all configured blocks on the **current** message:

       * `allBlocksSatisfied(obj)` returns true only if **every** block is satisfied by that **same** message.
     * If not satisfied, the message is dropped silently (no tagging, no forwarding).
     * If satisfied:

       * `activated` is set to `true`.
       * The activating message is tagged:

         * `appendTag(obj.meta, "gat")`.
       * The message is forwarded via `safeWrite(obj)`.
  2. If the gate **is activated**:

     * Every subsequent message is tagged with `"gat"` and forwarded as-is.

* Once activated, the gate never closes again.

**Failure modes & diagnostics**

* Missing config or malformed JSON → `logError()` and exit with non-zero status.
* Overly strict conditions (e.g. impossible combinations) will keep the gate closed indefinitely; the module will only log the timeout warning once.
* If `meta.timestamp` is missing while `max_age_ms` is used, those messages will never satisfy the gate; this must be considered when designing the pipeline.

**Typical usage**

* As the first control stage after a source or adapter, to ensure downstream modules only see “steady-state” traffic.
* Combined with `tmcp-control-minrate` and sinks to gate recording or visualization until a hardware handshake has finished.

---

### 3.5.2 `tmcp-control-minrate.js` — minimum output rate

**Purpose**

`tmcp-control-minrate.js` ensures a *minimum* output frequency by cloning the most recent message when upstream traffic is too sparse.
It **never** drops real messages and does **not** attempt to enforce a maximum rate.

**CLI**

```bash
tmcp-control-minrate.js --interval-ms <ms>
tmcp-control-minrate.js --rate <hz>
```

Parameters are parsed via `parseParams()` with this schema:

* `--interval-ms <ms>`

  * Type: number
  * Env: `TMCP_INTERVAL_MS`
  * Minimum: `1` ms
* `--rate <hz>`

  * Type: number
  * Env: `TMCP_RATE`
  * Minimum: `0.001` Hz (1 mHz)

Constraints:

* **Exactly one** of `--interval-ms` or `--rate` must be provided.
* Using both causes an error via `logError()` and an immediate exit.
* Using neither also results in a usage error and exit.

The effective interval is:

* `intervalMs = <interval-ms>` if provided, or
* `intervalMs = 1000 / rate` otherwise.

**Runtime behavior**

* `safeRead()` on stdin receives upstream objects.

* For each *real* input object:

  1. Determine logical timestamp `ts`:

     * If `meta.timestamp` is a finite number, use it.
     * Otherwise, use `Date.now()`.
  2. `lastLogicalTs = ts`.
  3. Construct a fresh `meta`:

     * `...metaIn`
     * `timestamp: ts`.
  4. Tag:

     * `appendTag(outMeta, "minr")`.
  5. Clone data via `structuredClone(dataIn)` and emit `{ meta: outMeta, data: outData }` through `safeWrite()`.
  6. Store the fully tagged output as `lastMessage` and update `lastEmitWall = Date.now()`.

* A background timer (`setInterval`) runs at `max(5 ms, intervalMs / 4)` and:

  * If `lastMessage` is set and `now - lastEmitWall >= intervalMs`, it emits a **clone**:

    1. If `lastLogicalTs` is not finite, initialize it to `Date.now()`.
    2. `lastLogicalTs += intervalMs`.
    3. Build new `meta` from `lastMessage.meta`:

       * Copy the entire meta object.
       * Copy `meta.pipeline` (or use `[ "minr" ]` if missing).
       * Set `meta.timestamp = lastLogicalTs`.
    4. Deep-clone `lastMessage.data`.
    5. Emit this cloned object via `safeWrite()` and update `lastEmitWall`.

* Clones therefore:

  * Preserve existing pipeline tags, including `"minr"`.
  * Advance the logical timestamp in *forward-only* steps of `intervalMs`.
  * Avoid backward time jumps in replay scenarios.

**Semantics summary**

* No messages are dropped.
* When upstream is faster than the configured minimum rate:

  * The module acts as a tagged passthrough (no clones emitted; only “real” messages).
* When upstream is slower or intermittent:

  * The module injects regularly spaced clones between messages, maintaining at least one output every `intervalMs` milliseconds.

**Typical usage**

* Before adapters or sinks that require steady timing (e.g. hardware that expects continuous updates).
* In replay pipelines where continuous time coverage is needed for downstream interpolation or visualization.

---

### 3.5.3 `tmcp-control-dedup.js` — data-based deduplication

**Purpose**

`tmcp-control-dedup.js` drops messages whose **data payload** has not changed meaningfully since the last emitted message, according to configurable rules.
Meta differences (including timestamps) are **ignored**; only `obj.data` participates in deduplication.

**CLI**

```bash
tmcp-control-dedup.js <config_file>
```

* `<config_file>` – JSON configuration loaded via `loadConfig()`.

If the argument is missing, the module prints a usage error and exits with code `1`.

**Configuration**

The module expects a `dedup` block:

```json
{
  "dedup": {
    "ignore_fields": ["t_ms"],
    "check_fields": ["lc", "bc"],
    "numeric_tolerance": 0,
    "debug": false
  }
}
```

Fields:

* `ignore_fields` (array of strings, optional)

  * Data keys to exclude from comparison.
  * Typical usage: time fields like `"t_ms"` that always change.
* `check_fields` (array of strings, optional)

  * If provided, deduplication is restricted to this whitelist of fields.
  * If omitted, **all** data keys participate (except those in `ignore_fields`).
* `numeric_tolerance` (number, optional; default `0`)

  * Threshold used when comparing numeric values:

    * Two numbers are considered equal if `|a - b| ≤ numeric_tolerance`.
* `debug` (boolean, optional; default `false`)

  * When `true`, the module logs a message via `logInfo()` whenever a frame is dropped:

    * `"tmcp-control-dedup: dropped frame (no significant change)"`.

**Runtime behavior**

State:

* `lastData`: the data block (`obj.data`) of the last **emitted** message.
* `haveLast`: boolean flag indicating whether `lastData` is valid.

Comparison logic:

1. If `haveLast` is `false`, the current message is considered a meaningful change and is always emitted.
2. `computeComparisonFields(curr)`:

   * Let `base` be:

     * `CHECK_FIELDS` if configured, else `Object.keys(curr)`.
   * Remove any keys present in `IGNORE_FIELDS`.
3. Presence check:

   * If a field in the comparison list is *not* present in `lastData`, this is considered a meaningful change.
4. For each comparison field:

   * If either value is a primitive (non-object) or `null`:

     * Compare using `isEqualWithTolerance()` (numeric tolerance or strict equality).
   * If both values are non-null objects:

     * Perform a shallow object comparison:

       * If the sets of keys differ → meaningful change.
       * For each sub-key:

         * If missing in the previous value → meaningful change.
         * If value differs (with numeric tolerance) → meaningful change.

If **no** differences are detected, the message is treated as a duplicate.

Processing pipeline:

* `safeRead()` on stdin receives each object.
* For each message with a defined `obj.data`:

  * If `hasMeaningfulChange(curr)` returns `false`:

    * If `DEBUG` is enabled, log a drop message.
    * Drop the frame (do not tag, do not forward).
  * Otherwise:

    * Tag the message: `appendTag(obj.meta, "dup")`.
    * Emit via `safeWrite(obj)`.
    * Update `lastData = structuredClone(curr)` and `haveLast = true`.

**Semantics summary**

* Deduplication is **purely data-based**:

  * Changes to `meta` (e.g. timestamps) do not affect the decision.
* Fields listed in `ignore_fields` never influence deduplication decisions.
* If `check_fields` is provided:

  * Only those fields matter (minus `ignore_fields`).
* Nested objects are compared **shallowly** (one level of keys).

**Typical usage**

* Immediately after an adapter or control module to reduce traffic when most values are static.
* Before `tmcp-control-minrate` and sinks, so that clones reflect only meaningful changes and noise is suppressed.

---

### 3.5.4 `tmcp-control-split-streams.js` — non-blocking tee to side channels

**Purpose**

`tmcp-control-split-streams.js` implements a multi-channel tee:

* All messages are forwarded to **stdout** (primary pipeline).
* The same messages are mirrored to one or more side channels (files or FIFOs).
* Side channel failures must **not** affect the main pipeline.

**CLI**

```bash
tmcp-control-split-streams.js <side_output_1> [side_output_2 ...]
```

* At least one `<side_output>` path is required.
* On missing arguments, the module logs a usage error and exits.

Each `side_output` path represents either:

* a FIFO used as a side pipeline, or
* a regular file used as a tap / log.

**Path initialization**

For each configured side path:

* `ensureSidePath(path)`:

  * If `fs.statSync(path)` succeeds:

    * The path is used as-is (FIFO or regular file).
  * If the path does not exist (`ENOENT`):

    * The module creates an empty regular file with mode `0644`.
    * Logs a warning indicating the path was created as a regular file.
  * On any other error:

    * Logs an error and exits.

**Channel state**

Each side channel is represented as:

* `path`: file or FIFO path.
* `fd`: file descriptor (or `null` if not open).
* `retryTimer`: timer handle for ENXIO reopen attempts.
* `channelId`: string of the form `"side:<index>"` used for logging and `safeWrite()` options.

**Opening and writing**

* `tryOpenChannel(ch)`:

  * Attempts to `fs.openSync()` the path with:

    * `O_RDWR | O_NONBLOCK`.
  * If `ENXIO` is returned (no reader on FIFO):

    * Schedule a retry after a fixed delay (500 ms).
    * Leave `fd` as `null`.
  * For other errors:

    * Log a warning and keep `fd = null` (no further attempts beyond logging and future retries).

* `writeSide(ch, obj)`:

  * If `ch.fd === null`, does nothing.

  * Otherwise, writes via:

    ```js
    safeWrite(obj, ch.fd, {
      channelId: ch.channelId,
      retry: true,
      exitOnClose: false
    });
    ```

  * Any unexpected errors are logged via `logWarn()` and do not propagate.

**Main loop**

* `safeRead()` on stdin receives objects.
* For each object:

  1. Tag with `"spl"`:

     * `appendTag(obj.meta, "spl")`.

  2. Emit to stdout:

     ```js
     safeWrite(obj, undefined, { /* stdout with default exitOnClose=true */ });
     ```

  3. For each configured side channel:

     * Call `writeSide(ch, obj)`.

**Semantics summary**

* The **primary stream** (stdin → stdout) is unaffected by side-channel failures.
* Side channels:

  * May temporarily fail or lag without impacting the main pipeline.
  * Use `retry: true` and `exitOnClose: false` to tolerate FIFO churn.
* All outputs (main and side) see the same object instance with the `"spl"` tag appended.

**Typical usage**

* Tapping a live stream for:

  * local logging to file,
  * forwarding to a separate visualization pipeline,
  * side-band recording or analysis.

* As a simple fan-out primitive between a single source and multiple downstream processing pipelines.

---

### 3.5.5 `tmcp-control-merge-streams.js` — time-aligned multi-stream merge

**Purpose**

`tmcp-control-merge-streams.js` merges one primary pipeline stream with one or more **side streams**, using timestamp-based alignment.
For each primary (main) message, it produces **exactly one** output message, enriching it with data from the side channels.

Two side-channel modes are supported:

* **Bounded interpolation** (default):

  * Uses recent history within a bounded buffer.
  * Applies timestamp tolerance and optional interpolation.
* **Unbounded hold-last**:

  * Always uses the most recently seen value on that side channel, regardless of delay.

**CLI**

```bash
tmcp-control-merge-streams.js <config_file> <side1> [<side2> ...] [--suppress-fifo-warning] [--verbose-log-level=<level>]
```

Parameters are parsed via `parseParams()` with:

* `suppressFifoWarning` (boolean flag):

  * CLI: `--suppress-fifo-warning`
  * Default: `false`
* `verboseLogLevel` (string, default `null`):

  * CLI: `--verbose-log-level`
  * **Currently not used** in the implementation; reserved for future extensions.

Positional arguments:

* `<config_file>` – configuration file passed to `loadConfig()`.
* `<sideN>` – one or more paths to side channels (files or FIFOs).

If no side paths are provided, the module logs a usage error and exits.

**Side-channel validation**

For each `sideN` path:

* If `fs.statSync(path)` succeeds and `isFIFO()` is true:

  * The path is accepted as a FIFO.
* If it is a regular file and `--suppress-fifo-warning` is **not** set:

  * The module logs a warning that the side channel is a regular file and suggests using FIFOs for proper timing.
* On errors, the module logs a warning but continues.

**Configuration**

The module expects a `merge` block:

```json
{
  "merge": {
    "matchToleranceMs": 100,
    "maxBufferMs": 2000,
    "postfixes": ["_a", "_b"],
    "allowUnboundedDelay": [false, true],
    "sideReconnectDelayMs": 200
  }
}
```

Fields:

* `matchToleranceMs` (number, optional; default `100`)

  * Maximum allowed absolute difference in milliseconds between a main message’s timestamp and the matched side-message timestamp in bounded mode.
* `maxBufferMs` (number, optional; default `2000`)

  * Window size for both main and side buffers:

    * Messages older than `Date.now() - maxBufferMs` are dropped from the buffers.
* `postfixes` (array of strings, optional)

  * Suffixes appended to side-channel field names in the merged output:

    * For side index `i`, the postfix is `postfixes[i]`, or `_" + (i+1)` if missing.
  * Example:

    * Side0 field `temp` → `temp_a` (if postfix `_a`).
* `allowUnboundedDelay` (array of booleans, optional)

  * Per-side switch:

    * `true` → enable unbounded hold-last mode for that side.
    * `false` or missing entry → bounded interpolation mode for that side.
* `sideReconnectDelayMs` (number, optional; default `200`)

  * Currently passed into `safeRead()` options but not acted upon by `safeRead()` itself.
    It is reservered for future reconnection logic and has **no effect** in the present implementation.

**Buffers and state**

* `mainBuffer`: array of recent main messages.
* `sideBuffers[i]`: array of recent messages for side channel `i` (bounded mode).
* `sideLastUnbounded[i]`: last seen message for side channel `i` in unbounded mode.

`pushMain(obj)`:

* Adds the main message to `mainBuffer`.
* Drops older entries with `meta.timestamp < Date.now() - maxBufferMs`.

`pushSide(i, obj)`:

* In **unbounded mode** for side `i`:

  * If `obj.meta.timestamp` is numeric:

    * `sideLastUnbounded[i] = obj`.
  * Also appends to `sideBuffers[i]` for diagnostics only (not used in selection).
  * If timestamp is missing or invalid:

    * Logs a warning and ignores the record for state updates.
* In **bounded mode**:

  * Appends to `sideBuffers[i]`.
  * Drops old entries with timestamp older than `Date.now() - maxBufferMs`.

**Interpolation and matching**

For bounded mode, the module uses two functions:

1. `findClosest(buf, ts)`:

   * Searches `buf` for the record whose `meta.timestamp` is closest to `ts`.
   * If the best difference exceeds `matchToleranceMs`:

     * Logs a warning with details and returns `null`.
   * Otherwise, returns the closest record.

2. `interpolateBounded(buf, ts)`:

   * First tries `findClosest()`.
   * If a nearest neighbor is found within tolerance, it is used as-is.
   * Otherwise:

     * Finds the last record with timestamp `≤ ts` (`before`) and the first with `> ts` (`after`).
     * If both exist and `after.meta.timestamp > before.meta.timestamp`:

       * Computes a linear interpolation factor `ratio` between `[t1, t2]`.
       * Builds a new object:

         * `structuredClone(before)`, with `meta.timestamp = ts`.
         * For each numeric field in `before.data` that is also numeric in `after.data`:

           * Linearly interpolates:

             * `out.data[k] = v1 + (v2 - v1) * ratio`.
         * Non-numeric fields are taken from `before`.
     * If only `before` or only `after` exists:

       * Returns that record directly.
     * If neither exists:

       * Returns `null`.

For unbounded mode:

* `interpolateSide(i, ts)` simply returns `sideLastUnbounded[i]` (or `null` if none).
* It *never* falls back to bounded interpolation.

**Emission**

There is always **one output per main-stream input**:

* `safeRead()` on stdin receives main messages:

  ```js
  safeRead(obj => {
    pushMain(obj);
    tryEmit();
  }, undefined, { channelId: "stdin", exitOnClose: true });
  ```

* `tryEmit()` operates on the latest main message:

  1. Let `mainObj` be `mainBuffer.at(-1)`.

  2. If `mainObj.meta.timestamp` is not a valid number:

     * Emit a passthrough:

       ```js
       const out = {
         meta: { ...(mainObj.meta || {}) },
         data: { ...(mainObj.data || {}) }
       };
       appendTag(out.meta, "mrg");
       safeWrite(out, undefined, { channelId: "stdout", exitOnClose: true });
       ```

  3. Otherwise:

     * Construct a merged object:

       ```js
       const merged = {
         meta: { ...(mainObj.meta || {}), timestamp: ts },
         data: { ...(mainObj.data || {}) }
       };
       ```

     * For each side index `i`:

       * `rec = interpolateSide(i, ts)`.
       * If `rec` and `rec.data` exist:

         * For each `[key, val]` in `rec.data`:

           * Add `merged.data[key + postfixes[i]] = val`.

     * Tag `merged.meta` with `"mrg"` and emit via `safeWrite()`.

**Side-channel input**

Each `sidePath` is read via `safeRead()`:

```js
safeRead(
  (obj) => pushSide(idx, obj),
  path,
  { channelId, exitOnClose: false, retry: true, reconnectDelayMs: SIDE_RECONNECT_DELAY_MS }
);
```

* `exitOnClose: false` ensures side-channel EOF or closure does **not** terminate the process.
* `retry: true` is currently informational for read-side semantics; no explicit reconnection loop is implemented beyond the initial `createReadStream(path)`.

**Semantics summary**

* One merged output message is produced for **every** main input message.
* The main stream’s fields are preserved and **never overwritten**:

  * Side-channel fields are added under postfix-extended names.
* For each side channel:

  * **Bounded mode**:

    * Uses closest or interpolated message within `matchToleranceMs` and `maxBufferMs`.
    * If no suitable candidate exists, contributes no fields for that side.
  * **Unbounded mode**:

    * Always uses the last seen message (if any), regardless of age.
* Missing or invalid timestamps on main messages yield a simple tagged passthrough (no merging).

**Typical usage**

* Merging:

  * high-rate sensor streams with lower-rate control/annotation streams,
  * multiple spatial segments into a single vector, or
  * real-time hardware readouts with recorded or simulated data.

* Combined with `tmcp-control-split-streams` to build complex multi-branch pipelines where some branches are merged back into a single consolidated stream.

---

# **3.6 Transformer Modules**

Transformer modules modify the **content** of a pipeline stream without changing its timing or control structure.
Unlike control-flow modules (Section 3.5), transformers operate only on:

* `obj.data` — the field payload
* `obj.meta.timestamp` (occasionally used for temporal filtering)
* attached tags (`appendTag`)

They do **not** drop messages (except where explicitly documented), do not duplicate the stream (except cloning behavior implicit in operations such as minrate, which is a control module), and do not impose domain semantics.
Transformers are *stateless in their API*, though they may maintain internal state for filtering or smoothing.

Current transformer modules:

1. `tmcp-transformer-derivative.js` — time derivative of numeric fields
2. `tmcp-transformer-highpass-gain.js` — threshold + gain
3. `tmcp-transformer-kalman.js` — 1-D Kalman smoothing
4. `tmcp-transformer-pid.js` — PID controller
5. `tmcp-transformer-reduce.js` — declarative reduction / aggregation engine

Each subsection below follows the canonical documentation pattern:

* Functional Summary
* CLI Interface
* Configuration Schema
* Runtime Behavior
* Integration with Shared Library
* Example Usage
* Operational Notes

---

## **3.6.1 `tmcp-transformer-derivative.js` — time derivative transformer**

### **Functional Summary**

Computes per-field derivatives:

[
\frac{d}{dt} (value) = \frac{\Delta value}{\Delta t}
]

for every numeric field in the pipeline stream.
Each field has its own independent state `{ prevVal, prevTime }`.

Derived values replace the original numeric values in `obj.data`.

### **CLI Interface**

```bash
tmcp-transformer-derivative.js
```

No configuration options.
Any additional CLI arguments cause a usage error via `logError()`.

### **Configuration Schema**

None.
The module is intentionally simple and fully auto-configuring.

### **Runtime Behavior**

* `safeRead()` ingests all objects.
* For each numeric field:

  * If the field was seen before:

    * Uses `meta.timestamp` (or `Date.now()` if missing) to compute `dt` in seconds.
    * If `dt > 0`, substitutes:

      * `data[key] = (val - prevVal) / dt`
    * If `dt <= 0`, sets derivative to `0`.
  * If first occurrence:

    * Sets derivative to `0`.
* Updates internal state for each numeric field.
* Attaches tag `"drv"` and forwards via `safeWrite()`.

### **Integration with Shared Library**

* Uses `safeRead`, `safeWrite`, and `appendTag`.
* Uses normalized `{meta, data}` objects.
* Always writes to stdout with default exit-on-close behavior.

### **Example Usage**

```bash
<sensor-source> | tmcp-transformer-derivative.js | <next-module>
```

### **Operational Notes**

* Suitable for velocity or rate-of-change computation.
* Sensitive to timestamp accuracy; recommended to provide valid `meta.timestamp`.
* Does not drop or clone messages.
* All numeric fields are processed; filtering must be performed upstream if needed.

---

## **3.6.2 `tmcp-transformer-highpass-gain.js` — threshold + gain**

### **Functional Summary**

Applies two operations per numeric field:

1. **High-pass threshold**:
   If `val < threshold`, replace with `0`.
2. **Gain scaling**:
   Otherwise output:
   [
   (val - threshold) \times gain
   ]

Useful for removing background noise and scaling signals.

### **CLI Interface**

```bash
tmcp-transformer-highpass-gain.js <config_file>
```

Missing `config_file` triggers a usage error.

### **Configuration Schema**

Configuration is loaded via `loadConfig(config_file)` and expects:

```json
{
  "highPass": { "fieldA": 10, "fieldB": 3 },
  "gain":     { "fieldA": 1.2, "fieldB": 4.0 }
}
```

* `highPass[key]` — threshold; default `0`
* `gain[key]` — multiplicative gain; default `1`

Unknown fields fall back to defaults.

### **Runtime Behavior**

* Reads objects with `safeRead()`.
* For each numeric field:

  * If `val < threshold` → set to `0`
  * Else → `(val – threshold) * gain`
* Tag with `"hpg"` and forward via `safeWrite()`.

### **Integration with Shared Library**

* Uses safeRead / safeWrite / appendTag.
* No additional state.

### **Example Usage**

```bash
<source> | tmcp-transformer-highpass-gain.js config.json
```

### **Operational Notes**

* High-pass behavior is non-linear; derivative or Kalman should precede or follow depending on desired effect.
* Useful before reducers or control loops.

---

## **3.6.3 `tmcp-transformer-kalman.js` — 1-D Kalman filtering**

### **Functional Summary**

Performs independent 1-D Kalman filtering for **each numeric field**, smoothing noisy streams.

Each field gets its own Kalman filter with:

* process noise `Q`
* measurement noise `R`
* internal state `{ x, P }`
* initialized on first sample

### **CLI Interface**

```bash
tmcp-transformer-kalman.js <config_file>
```

Missing config causes a usage error.

### **Configuration Schema**

Loaded via:

```json
{
  "kalman": {
    "default": { "Q": 1.0, "R": 5.0 },
    "fieldA":  { "Q": 0.1, "R": 2.0 },
    "fieldB":  { "Q": 0.5 }
  }
}
```

Rules:

* `default.Q`, `default.R`: fallback values
* For each field:

  * Per-field `Q` and `R` override defaults

### **Runtime Behavior**

* For each numeric field:

  * Instantiate `Kalman1D(Q, R)` on first use.
  * Call `update(val)`:

    * If first update: `x = z`, `P = 1`
    * Else update `P`, compute Kalman gain, update estimate, reduce covariance.
  * Replace `obj.data[key]` with smoothed value.
* Tag with `"kmf"`.
* Forward via `safeWrite()`.

### **Integration with Shared Library**

* Uses safeRead / safeWrite / appendTag.
* Maintains internal filters keyed by field name.

### **Example Usage**

```bash
<source> \
  | tmcp-transformer-kalman.js kalman.json \
  | <visualizer>
```

### **Operational Notes**

* Completely time-independent — does not use timestamps.
* Works well upstream of reducers or state machines.
* Not appropriate for differentiating; derivative should come *after* Kalman filtering.

---

## **3.6.4 `tmcp-transformer-pid.js` — per-field PID**

### **Functional Summary**

Computes a PID (Proportional + Integral + Derivative) control value for each configured field.
Each field receives its own independent PID state.

PID input is the **current field value** (treated as “error”).
PID output replaces the field value.

### **CLI Interface**

```bash
tmcp-transformer-pid.js <config_file>
```

Missing config triggers a usage error.

### **Configuration Schema**

```json
{
  "pid": {
    "errorA": { "P": 1.0, "I": 0.1, "D": 0.05 },
    "errorB": { "P": 2.0, "I": 0.0, "D": 0.0 }
  }
}
```

For each field:

* `P` — proportional gain
* `I` — integral gain
* `D` — derivative gain

### **Runtime Behavior**

For each incoming object:

* Determine timestamp (`meta.timestamp` or `Date.now()`).

* For each numeric field that has a PID entry:

  * Compute error = current field value.
  * Let `dt = (timestamp - lastTime) / 1000`, fallback `1e-3` if invalid.
  * Update:

    * `integral += error * dt`
    * `derivative = (error - prevError) / dt`
    * Output = `P*error + I*integral + D*derivative`
  * Store output back into the field.

* Tag with `"pid"` and forward.

### **Integration with Shared Library**

* Fully protocol-agnostic via safeRead/safeWrite.
* Maintains PID state objects in memory.

### **Example Usage**

```bash
<error-signal-stream> | tmcp-transformer-pid.js pid.json
```

### **Operational Notes**

* Must be placed after timestamp-producing modules if realistic `dt` is required.
* Does not clamp integral or derivative; saturation must be handled downstream.
* Outputs can be fed to Modbus adapter or actuator modules.

---

## **3.6.5 `tmcp-transformer-reduce.js` — declarative reducer / aggregator**

### **Functional Summary**

This is the most sophisticated transformer in the TMCP toolkit.
It implements a declarative reduction engine with support for:

* arithmetic aggregations (sum, avg, range, etc.)
* weighted averages
* copy / passthrough mappings
* boolean and string conditionals
* arbitrary expressions
* multi-pass evaluation
* persistent retained state
* missing-value policies
* forward policies (all or known fields)

It is the basis for many higher-level processing pipelines, including contact detection and baseline drift control in the glove controller.

### **CLI Interface**

```bash
tmcp-transformer-reduce.js <config_file>
```

Missing config produces a usage error.

### **Configuration Schema**

The reducer expects a `reduce` block:

```json
{
  "reduce": {
    "passes": 2,
    "missing": "ignore",
    "forward_policy": "all",
    "outputs": {
      "sumFlFr": { "op": "sum", "inputs": ["fl", "fr"] },
      "rangeCap": { "op": "range", "inputs": ["lc", "bc"] },
      "lean": {
        "op": "expr",
        "inputs": { "x": "fl", "y": "fr" },
        "expr": "Math.abs(x - y)"
      },
      "human_present": {
        "op": "condition",
        "inputs": { "v1": "lc", "v2": "bc" },
        "expr": "(v1 > 20) && (v2 > 20)"
      }
    }
  }
}
```

Config fields:

* `passes`

  * Number of evaluation passes over all outputs.
  * Allows chained dependencies where outputX depends on outputY computed earlier.
* `missing`
  One of:

  * `"ignore"` — skip missing fields; for expr/condition, missing locals produce a warning and the rule returns `null`
  * `"zero"` — treat missing fields as zero
  * `"fail"` — abort rule (drop message from reducer)
* `forward_policy`

  * `"all"` — forward all non-temp / non-internal fields
  * `"known"` — forward only fields declared in `outputs`
* `outputs` — map of output-field → rule

Each rule has:

* `op` — operation type
* `inputs` — list or map
* `expr` — JS expression (if applicable)
* `temp` — exclude this field from output
* `retain` — store previous value under `<name>__prev`

Supported ops:

* `"copy"`
* `"sum"`, `"sub"`, `"avg"`, `"max"`, `"min"`, `"range"`
* `"weighted_avg"`
* `"expr"` — JS expression
* `"condition"` — JS expression, result converted to boolean
* `"passthrough"` — output the specified input directly

Built-in locals:

* `__timestamp` — meta timestamp
* `__now` — current wall clock time
* `__start` — wall-clock timestamp of first message in stream

Retained values:

* Setting `retain:true` stores `<name>__prev`

### **Runtime Behavior**

* `safeRead()` receives messages.
* Builds `workingData = { ...retained, ...input }`.
* Injects internal fields:

  * `__timestamp`
  * `__now`
  * `__start`
* Evaluates all rules for `passes` rounds.
* Each rule computes a value:

  * `null` may be ignored or fatal depending on `missingMode`
* Updates retained state for rules with `retain:true`
* Removes internal (`__*`) and `temp:true` fields.
* Applies `forward_policy` to produce final `obj.data`.
* Tags `"red"` and writes via `safeWrite()`.

### **Integration with Shared Library**

* Heavy user of safeRead/safeWrite; uses vm module for expression evaluation.
* Logging uses `logError`, `logWarn`, and `logInfo`.

### **Example Usage**

```bash
<source> | tmcp-transformer-reduce.js reduce.json | <next>
```

Example reduce.json:

```json
{
  "reduce": {
    "outputs": {
      "pressure": { "op": "avg", "inputs": ["fl", "fr", "bl", "br"] },
      "lean_side": {
        "op": "expr",
        "inputs": { "L": "fl", "R": "fr" },
        "expr": "Math.sign(L - R)"
      }
    }
  }
}
```

### **Operational Notes**

* The reducer is intentionally flexible and therefore requires careful config design.
* Expression rules must reference only declared locals.
* `"passes"` is extremely useful in pipelines involving sequential reductions (e.g. baseline drift + conditional state detection).
* Retained state survives between messages and must not be used for domain semantics unless explicitly designed.

---

# **3.7 Annotation Modules**

Annotation modules enrich a pipeline by **adding new semantic fields** to the existing data.
They do **not** modify or replace existing fields (except in the case of `override:true` in the injection module, see below).
Their purpose is to derive *higher-level* signals, labels, or states from low-level numeric measurements.

The annotation category is conceptually distinct from transformer modules:

* **Transformers** adjust existing fields (e.g., applying gain, filtering, reduction).
* **Annotators** compute *additional outputs*—semantic information layered on top of raw sensor data.
* This separation reinforces TMCP’s principle of predictable, composable, observable transformations.

Current annotation modules:

1. `tmcp-annotate-derivative.js` — configurable per-field derivative outputs
2. `tmcp-annotate-inject.js` — constant-value injection
3. `tmcp-annotate-stalled.js` — stalled detector with sliding windows
4. `tmcp-annotate-state-machine.js` — finite-state-machine evaluator

Each is documented below.

---

## **3.7.1 `tmcp-annotate-derivative.js` — derivative annotation (outputs-based)**

### **Functional Summary**

Adds *new fields* representing the time derivative of configured input fields.
Unlike the transformer derivative module:

* This annotator computes derivatives **only for specified fields**,
* and **adds** derivative outputs under new names (e.g. `"velocityX"`),
* while **keeping the original fields unchanged**.

It also enforces a minimum Δt window (`windowMs`) to prevent excessive noise.

### **CLI Interface**

```bash
tmcp-annotate-derivative.js <config_file>
```

Missing config produces a usage error.

### **Configuration Schema**

Configuration expects:

```json
{
  "derivative": {
    "outputs": {
      "outField": {
        "input": "inField",
        "windowMs": 40
      }
    }
  }
}
```

For each output field:

* `"input"` — name of the input field to differentiate
* `"windowMs"` — minimum milliseconds between samples (default: 40 ms)

  * If `Δt` is too small or non-positive, derivative = `0`.

### **Runtime Behavior**

* Reads input via `safeRead()`.

* Computes timestamp: uses `meta.timestamp` if numeric, else `Date.now()`.

* For each configured output field:

  * If value or previous state missing → output `0`.
  * If Δt < window or Δt ≤ 0 → output `0`.
  * Else compute:

    [
    \text{derivative} = \frac{v - v_{\text{prev}}}{\Delta t / 1000}
    ]

* Writes outputs into a fresh `outData = { ...inData }`, preserving originals.

* Attaches tag `"drv"`.

* Emits via `safeWrite()`.

### **Integration with Shared Library**

* Uses safeRead, safeWrite, appendTag, loadConfig.
* Per-input state stored as `{ prevVal, prevTime }` keyed by input field.

### **Example Usage**

```bash
tmcp-annotate-derivative.js derivative.json
```

`derivative.json`:

```json
{
  "derivative": {
    "outputs": {
      "vel": { "input": "pos", "windowMs": 20 },
      "accel": { "input": "vel", "windowMs": 30 }
    }
  }
}
```

### **Operational Notes**

* Suitable for contact detection, motion analysis, or sensor trend extraction.
* Should run **after** timestamp-producing modules (sources).
* Does not modify `inField` values—always adds new outputs.

---

## **3.7.2 `tmcp-annotate-inject.js` — constant-value injection**

### **Functional Summary**

Injects constant, statically configured values into pipeline messages under specified field names.
This is the simplest annotation module and is often used to add domain labels, metadata, session flags, or experiment markers.

### **CLI Interface**

```bash
tmcp-annotate-inject.js <config_file>
```

### **Configuration Schema**

Expected format:

```json
{
  "inject": {
    "values": {
      "labelA": 123,
      "experiment": "test-run"
    },
    "override": true
  }
}
```

* `values` — map of field → constant value
* `override`:

  * `true` (default) — existing values are replaced
  * `false` — injection only happens for missing fields

### **Runtime Behavior**

* Reads input via `safeRead()`.
* For each label in `values`:

  * If `override == true`:

    * Always set `data[label] = value`.
  * Else:

    * Set only if `data[label]` does not already exist.
* Tag `"inj"` is added.
* Emit via `safeWrite()`.

### **Integration with Shared Library**

* Uses loadConfig, safeRead, safeWrite, appendTag.

### **Example Usage**

```bash
{
  "inject": {
    "values": { "session_id": 42, "mode": "calibration" },
    "override": false
  }
}
```

### **Operational Notes**

* Only annotator permitted to “override” existing fields, and only when explicitly configured.
* Useful for adding **experiment labels**, **session metadata**, and **flags**.

---

## **3.7.3 `tmcp-annotate-stalled.js` — sliding-window stall detection**

### **Functional Summary**

Detects whether a numeric field has remained within a small range (deadband) over a sliding time window.
This module adds **boolean outputs** (e.g. `motor_stalled: true`).

Stall detection is based on:

* a history of `(timestamp, value)` pairs,
* kept within a configurable time window,
* computing `max - min < deadband`.

### **CLI Interface**

```bash
tmcp-annotate-stalled.js <config_file>
```

### **Configuration Schema**

```json
{
  "stalled": {
    "outputs": {
      "stallFlag": {
        "input": "sensorField",
        "windowMs": 500,
        "deadband": 0.5
      }
    }
  }
}
```

Fields:

* `"input"` — numeric source field
* `"windowMs"` — time span of sliding history (default: 500 ms)
* `"deadband"` — threshold for deciding “little motion” (default: 0.5)

### **Runtime Behavior**

For each message:

* Compute timestamp (meta.timestamp or Date.now).

* Maintain history list: array of `{ t, v }` entries.

* Drop history entries older than `ts - windowMs`.

* Determine:

  [
  stalled = (max(history.v) - min(history.v)) < deadband
  ]

* Write `outData[outField] = stalled`.

* Original fields remain untouched.

* Attach tag `"stl"` and forward.

### **Integration with Shared Library**

* Uses safeRead / safeWrite / appendTag / loadConfig.
* Keeps per-input history arrays.

### **Example Usage**

```json
{
  "stalled": {
    "outputs": {
      "isSteady": { "input": "force", "windowMs": 200, "deadband": 2.0 }
    }
  }
}
```

### **Operational Notes**

* For heavier-duty analysis, consider running after smoothing filters.
* History can grow if timestamps go backward; ensure upstream timestamps are monotonic.
* Works well in grasp detection, seating dynamics, machine drift detection.

---

## **3.7.4 `tmcp-annotate-state-machine.js` — configurable finite-state machine**

### **Functional Summary**

This is the most feature-rich annotator.
It evaluates a **configuration-driven finite-state machine (FSM)** per configured “instance,” adds fields representing the current state, and updates state transitions based on Boolean expressions referencing:

* input data fields,
* current FSM state,
* time in current state,
* other instance states,
* configured constants.

Transitions are evaluated on every incoming message.

### **CLI Interface**

```bash
tmcp-annotate-state-machine.js <config_file>
```

Missing or malformed configuration exits with errors.

### **Configuration Schema**

Expected structure:

```json
{
  "stateMachine": {
    "constants": { "threshold": 30 },
    "states": {
      "idle": {
        "transitions": [
          { "when": "data.pos > constant.threshold", "action": { "goto": "active" } }
        ]
      },
      "active": {
        "transitions": [
          { "when": "data.pos <= constant.threshold", "action": { "goto": "idle" } }
        ]
      }
    },
    "instances": {
      "detector1": {
        "initialState": "idle",
        "inputs": { "pos": "force" },
        "outputs": { "stateField": "state1" }
      }
    }
  }
}
```

Main sections:

* **constants**
  arbitrary static values referenced as `constant.<name>`.

* **states**
  Each state has a list of transition blocks:

  ```json
  {
    "transitions": [
      { "when": "EXPR", "action": { "goto": "nextState" } }
    ]
  }
  ```

* **instances**
  Each instance defines:

  * field mappings (`inputs`)
  * output field name (`outputs.stateField`)
  * `initialState` (optional)

### **Expression Language**

Expressions use a small internal parser:

* Supported logical ops: `&&`, `||`, `!`
* Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`
* Literals: numbers, strings, booleans
* Identifiers allowed:

  * `data.<alias>` referencing instance-specific mapped input fields
  * `instance.state`
  * `instance.timeInStateMs`
  * `instancesInState.<stateName>`
  * `constant.<name>`

The parser is robust and logs descriptive errors.

### **Runtime Behavior**

For each input object:

* Determine timestamp (meta.timestamp or Date.now).

* Compute `instancesInState`: how many instances currently in each state.

* For each FSM instance:

  1. Evaluate all transitions of the current state.
  2. First matching transition (`tr.when(ctx) == true`) is applied:

     * Change state to `tr.target`
     * Update `enteredAtMs = now`
  3. Compute time in state.
  4. Write output field:

     ```
     out[stateField] = <currentStateName>
     ```

* Original data fields remain untouched.

* Tag `"sm"` and emit.

### **Integration with Shared Library**

* Uses loadConfig, safeRead, safeWrite, appendTag.
* Maintains runtime per instance:

  * `{ state, enteredAtMs }`.

### **Example Usage**

```bash
tmcp-annotate-state-machine.js fsm.json
```

Example minimal config:

```json
{
  "stateMachine": {
    "states": {
      "idle":   { "transitions": [{"when": "data.v > 3",   "action": {"goto":"active"}}] },
      "active": { "transitions": [{"when": "data.v <= 3", "action": {"goto":"idle"}}] }
    },
    "instances": {
      "simple": {
        "inputs": { "v": "speed" },
        "outputs": { "stateField": "speedState" }
      }
    }
  }
}
```

### **Operational Notes**

* Powerful enough to encode complex seat occupancy or grip/contact state machines.
* Instances are independent unless transitions reference other instances via `instancesInState.*`.
* Missing timestamps may cause transitional behavior; recommended to run after a source or timestamp stabilizer.

---

# **4. Applications of the TMCP Architecture**

Real-world systems built on the Terminal-based Modular Control Pipeline (TMCP) framework combine the generic module catalog (Section 3) into domain-specific pipelines. This chapter presents currently deployed applications as worked examples. They are not template code, and they intentionally avoid enumerating every numeric threshold or field-specific heuristic. Instead, they illustrate how TMCP compositions become full control architectures: multi-loop, timing-safe, fault-tolerant, self-calibrating, and externally controllable.

Each application is described at the architectural level:

* how TMCP Modules are arranged into one or more **control loops**,
* how **measurement, intent, safety, and actuation** streams flow between them,
* how **external data** enters and how **closed-loop corrections** exit,
* how **timing**, **calibration**, **gating**, and **state machines** shape behavior.

Concrete config files and scripts (such as `run_glove_controller.sh`) belong to the application source tree rather than the manual; readers are expected to interpret them independently. This chapter explains **why the pipeline is structured as it is**, and what guarantees each block provides.

---

## **4.1 Glove Controller**

### **4.1.1 Overview**

The Glove Controller is a dual-loop, closed-loop manipulation system built on TMCP, combining tactile sensing, trajectory following, state inference, safety envelopes, and Modbus actuation.
Conceptually the controller behaves as two cooperating **control holons** (upper sensing loop, lower actuation loop). They exchange positional and state information through FIFOs, and both are externally addressable by command streams.

The system revolves around three data domains:

1. **Raw sensor domain** – High-bandwidth tactile and IR arrays from an Arduino source.
2. **Estimation domain** – Calibrated, filtered, and state-annotated interpretation of contact, load, and motion.
3. **Actuation/goal domain** – Desired trajectories, merged with real feedback, safety-clamped, and ultimately serialized to a Modbus target device.

The controller is structured as two continuously running TMCP pipelines triggered from `scripts/run_glove_controller.sh`:

* **Upper loop:** tactile → calibration → feature extraction → state-machine inference → motion/contact estimation → PID prep → feedforward correction
* **Lower loop:** trajectory/goal programs → merging with feedback → gating conditions → safety and saturation → final command output via Modbus

The two loops communicate via named FIFOs, using TMCP’s robust side-channel semantics (`safeRead` on reconnecting FIFOs, unbounded-delay semantics where appropriate).

This split ensures:

* measurement and actuation can run at different frame rates,
* safety conditions can be enforced before actuation,
* trajectory programs can be replaced without resetting sensor pipelines,
* external agents can inject new commands, making the system addressable and goal-driven.

---

### **4.1.2 Upper Loop: Tactile and Measurement Pipeline**

The upper loop ingests high-frequency tactile/force signals and transforms them into stable, state-annotated, usable quantities for the lower loop. Its stages are:

#### **A. Sensor Acquisition (Source Modules)**

The loop begins with an **Arduino source module** (`tmcp-source-arduino.js`):

* Reads raw ADC packets via serial.
* Applies project-specific field mapping.
* Emits NDJSON messages at sensor rate with timestamps.

This raw stream forms the measurement backbone.

#### **B. Calibration and Local Feature Extraction**

A series of **reductions** and **Kalman filtering** steps transform raw measurements into stable high-level features:

* **Sensor calibration reducers** compute baseline offsets and apply subtraction, optionally driven by a Boolean calibration signal.
* **Kalman filters** smooth individual numerical fields using per-field Q/R settings.
* Additional **reduce** blocks compute aggregate maxima (e.g., tactile channel groups) and prepare fields for downstream logic.

The pipeline uses only transformer and control modules, guaranteeing deterministic one-output-per-input behavior.

#### **C. Feedforward Merging and Measurement Fusion**

Multiple `tmcp-control-merge-streams.js` instances combine:

* tactile-derived maxima,
* previously computed feedforward predictions,
* side-channel positional feedback,
* external limits or program data.

Merge modules here rely heavily on **unbounded-delay** semantics for side channels that update slower or irregularly. Every merge uses explicit postfixes to maintain field provenance.

#### **D. Contact State Detection**

Contact interpretation is performed by two annotation modules:

1. **Sliding-window stalled detector** (`tmcp-annotate-stalled.js`):
   Determines whether each finger segment is “stalled” based on movement deadbands.

2. **Contact state machine** (`tmcp-annotate-state-machine.js`):
   Implements per-finger finite state machines (`open → engage → grasp → …`).
   These FSMs use:

   * per-instance error/stalled inputs,
   * global counts (e.g., how many fingers in “grasp”),
   * dwell times,
   * constants from config.

This stage converts continuous tactile signals into symbolic categorical states, forming the conceptual backbone of grasping inference.

#### **E. Speed-from-Contact State Logic**

A second state-machine annotator maps each finger’s contact state into a discrete motion-speed state (`High/Low/Stop`).
This derived speed domain is used directly by the feedforward module and helps prevent aggressive motion during contact.

#### **F. Calibration Control Split and Enable Signal**

A small **side-channel split** extracts the boolean condition used to enable or disable calibration. This influences the reducer that computes baseline offsets.

#### **G. PID Preparation and Feedforward Term Generation**

Later reduce stages:

* compute **positional differences**,
* pass through PID controllers (`tmcp-transformer-pid.js`),
* compute feedforward corrections for each segment.

The output is an aggregated measurement/control feature set passed to the lower loop using a FIFO.

---

### **4.1.3 Lower Loop: Trajectory and Actuation Pipeline**

The lower loop consumes:

* goals (external commands or prerecorded programs),
* the upper loop’s measurement-based positions and states,
* safety conditions,
* and timing constraints.

Its structure is:

#### **A. Goal Program Intake**

A `tmcp-control-minrate.js` instance stabilizes temporal behavior when upstream goal inputs arrive sporadically.
Goals are merged with additional input streams, typically via `merge-streams` with unbounded-delay semantics.

#### **B. Merging Goal Programs and Feedback Position**

Two merge stages integrate:

1. **Goal program + external program modifications**
2. **Commanded positions + actual positions** (from the upper loop)

Bounded or unbounded detection is chosen based on stream characteristics.

#### **C. Gating and Activation Conditions**

A `tmcp-control-gate.js` instance ensures that actuation only begins when:

* all required goal fields are present,
* calibration conditions are satisfied,
* and no blocking conditions are active.

Only after all configured blocks pass does the command stream begin forwarding.

#### **D. Safety and Saturation Logic**

A group of **reduce** transformers implements:

* error terms,
* clamping envelopes,
* dynamic minimum/maximum envelopes based on contact,
* relaxation rules,
* final saturation of each position/torque field.

This is the “safety clamping” stage: it ensures all actuation values remain within domain-specific, context-aware safe ranges.

#### **E. Command Export to Modbus**

Finally, the prepared command stream is handed to `tmcp-adapter-modbus.js`, which performs:

* register mapping,
* write-rate enforcement,
* structured serialization to the motor controller.

This closes the control loop through the physical actuator.

---

### **4.1.4 Inter-Loop Communication Architecture**

The connection between upper and lower loops consists of:

* **FIFO feedback channels** (`current_pos.fifo`, `enable_calibration.fifo`, `limit_controller_pos.fifo`, etc.),
* `control-split-streams.js` and `control-merge-streams.js` with `exitOnClose=false` to survive FIFO churn,
* clear semantic separation:

  * **upper loop** interprets the world,
  * **lower loop** executes its own goals under safety and state guidance.

Because of this, each loop can restart, stall, or reconfigure independently while the other continues to operate.
This architectural pattern is central to TMCP’s composability: loops behave as **agent-like holons** with stable inputs and outputs.

---

### **4.1.5 External Control and Goal-Driven Behavior**

The Glove Controller is architected for external command injection.
Through FIFOs such as `goal_program.fifo` and `pause_signal.fifo` and through replay scripts like `run_commands.sh`, external agents can:

* request trajectories,
* initiate calibration cycles,
* pause/unpause the controller,
* or run prerecorded command sequences.

This makes each loop **addressable**, aligning with the project’s emerging agent-based view of control compositions.

---

### **4.1.6 Key Architectural Patterns Demonstrated**

The Glove Controller showcases nearly all important TMCP design patterns:

* **Dual-loop control holons** with independent timing and side-channel coupling.
* **Unbounded-delay merges** for slow-changing or event-driven streams.
* **Per-field Kalman smoothing** and staged reduction.
* **Side-channel splits** for calibration and monitoring.
* **Finite state machines** with multi-instance interaction logic.
* **Safety envelopes** implemented via declarative reducers.
* **Min-rate emission** to stabilize asynchronous upstream streams.
* **MessagePack-readiness** via TMCP’s protocol abstraction.
* **Robust FIFO reconnection** ensuring fault tolerance to transient reader/writer churn.

These patterns generalize beyond the glove: Section 4.2 (Seat Classifier) will illustrate the same principles adapted to classification pipelines.

---

# **4.2 Seat Classifier**

### **4.2.1 Overview**

The Seat Classifier pipeline is a TMCP-based data-processing and inference system designed to derive human-presence and seating-condition metrics from pressure/force sensor arrays.
The current implementation performs a robust **human-presence detector**, but the architecture is intentionally general: additional classifiers such as center-of-pressure estimation, weight classification, seating posture detection, and safety-related occupancy states will be added without structural changes.

From the TMCP perspective, the Seat Classifier demonstrates a pure **analysis pipeline** rather than a control pipeline: it reads multi-channel sensor traces, stabilizes them through baseline estimation, applies slow-drift compensation, performs state-machine-based classification, and exports structured CSV suitable for statistical analysis or training future models.

The system is driven by `scripts/run_classifier_pipeline.sh`, which orchestrates the lifecycle of the pipeline, progress reporting, and result visualization.

---

### **4.2.2 High-Level Pipeline Structure**

The seat pipeline is linear, single-loop, and timing-controlled, built around the following stages:

1. **CSV source ingestion (tmcp-source-csv.js)**
   Pulls rows from a test file, maps them into NDJSON data fields, applies timestamp extraction, and adds filename fields to support later sinks.

2. **Baseline merging and estimation**
   A merge stage joins the primary CSV stream with a side-channel FIFO supplying “baseline update allowed” signals, followed by a reduction step that maintains a slow, exponentially weighted baseline for key channels (e.g., `lc`).

3. **State-machine classification for human presence**
   A compact FSM determines whether the seat is “empty” or “occupied”, based on the deviation (`lc_delta`) above a configurable threshold.

4. **Feedback loop of classification signals**
   Using `control-split-streams.js`, the classification signals are fed back into the baseline reducer to gate whether baseline updates should continue (baseline freezes when seat is occupied).

5. **Deduplication and structured CSV export**
   A dedup step removes redundant records (e.g., repeated occupancy states), then one or more CSV sinks generate output files with stable filenames.

The pipeline is explicitly **timing-controlled**: the CSV source emits at a configured interval, ensuring visually consistent plots and predictable downstream behavior even when test files contain irregular timestamps.

---

### **4.2.3 Data Flow and Baseline Adaptation**

The core of the classifier is a **baseline-and-delta** model:

* The reducer in `seat-lc-baseline.json` maintains a slow-moving baseline:

  * Baseline updates occur only if `baseline_update_allowed` is true.
  * When updates are allowed, the baseline follows `lc` via an exponential smoother (`0.999 * prev + 0.001 * lc`).
  * When updates are disabled (seat occupied), the baseline is held constant.

* The delta (`lc_delta`) is the difference between instantaneous load and baseline.
  This delta becomes the primary feature for the FSM.

This approach isolates slow drift (environmental or sensor) from rapid changes (occupancy events).
The delta then drives both detection and the gating of future baseline updates.

---

### **4.2.4 Human Presence Classification**

A compact **state-machine annotator** (`tmcp-annotate-state-machine.js`) implements a binary “empty ↔ occupied” classifier:

* Transition to **occupied** when `lc_delta > threshold`.
* Transition to **empty** when `lc_delta ≤ threshold`.

Each row is annotated with:

* `human_state` – symbolic FSM state,
* `human_detected` – derived Boolean flag,
* `baseline_update_allowed` – Boolean gating signal used upstream.

The FSM is configured with state constants (such as `lc_delta_threshold`) and one instance (`seatPresence`).
This makes the classifier readable, inspectable, and easily extendable with additional states (e.g., “child”, “adult”, “large adult”, “unsafe posture”).

---

### **4.2.5 Feedback Loop via Side Channels**

The classifier uses a **split-stream** pattern to create a small feedback loop:

* A split produces a substream that gets reduced again to extract `baseline_update_allowed`.
* This reduced stream is written to a FIFO (`enable_baseline.fifo`).
* The upstream merge then reads this FIFO, controlling when the baseline reducer updates.

This feedback architecture ensures that baseline learning halts during occupied periods, preventing contamination of the baseline model, and resumes only when the seat is empty.
This approach is general and extensible for future classifiers.

---

### **4.2.6 Deduplication and CSV Output**

Before final export:

* A dedup module selectively removes redundant messages (e.g., repeated identical occupancy states) based on configured `check_fields`.
* Two CSV sinks are used:

  * one writes raw output in a stable row layout (`seat_output/<sid>.csv`),
  * another writes human-only data under a different filename prefix (`human-<sid>.csv`).

This arrangement supports downstream plotting (via Gnuplot), statistical post-processing, and use in supervised learning datasets.

---

### **4.2.7 Planned Extensions**

The architecture is explicitly prepared for more sophisticated classifiers:

* **Center of pressure** features (using multi-sensor geometry).
* **Weight-based class detection** (children, adults, heavy adults).
* **Seat position safety envelope** (e.g., leaning out of zone).
* **Child-seat detection** using known mechanical signatures.
* **Event counting and dwell-time statistics** across long test runs.
* **Cross-file and cross-subject statistical summaries** for model calibration.

All of these can be implemented through additional **reduce**, **annotate**, and state-machine stages without altering pipeline structure.

---

### **4.2.8 Architectural Patterns Demonstrated**

The Seat Classifier showcases:

* pure **analysis pipelines** using CSV sources and sinks,
* **slow baseline tracking** with gated updates,
* **FSM-based classification** of symbolic high-level states,
* **side-channel feedback loops** for adaptive pre-processing,
* **deduplication** of state outputs,
* **file-based batch processing** with progress monitoring,
* automatic multi-file output naming via CSV sink filename rules.

The patterns here generalize to any non-real-time classification or preprocessing problem run under TMCP.

---

# **5. Concluding Remarks and Future Work**

This manual has outlined the structure, semantics, and practical use of the TMCP architecture across two concrete applications: the glove controller and the seat classifier.
Both pipelines demonstrate the same underlying design philosophy—line-buffered shell orchestration, explicit message semantics, declarative configuration, and composable micro-modules—but apply it to two very different domains: real-time actuation versus offline or semi-offline sensor classification.

Although the implementations differ in purpose and scale, they share the following architectural principles:

* **Small orthogonal modules** that each perform a single transformation or decision.
* **Declarative behavior** via JSON configurations rather than embedded logic.
* **Stable message structure** (`meta` + `data`) across all modules.
* **Feedback loops expressed through FIFOs** rather than internal mutable logic.
* **Strict temporal semantics** based on timestamps rather than implicit ordering.
* **Ease of inspection and reproducibility**, with all intermediate streams available for diagnostics.

The glove controller illustrates how TMCP can support **complex bidirectional feedback**, split/merge operations, safety clamping, and multi-instance state machines within a real-time closed-loop controller.
The seat classifier demonstrates how the same toolkit can support **batch or replay-driven analysis**, with slow-drift compensation, binary or multi-class inference, deduplication, and data export suitable for machine learning workflows.

The work presented here forms a baseline for further development.
Upcoming expansions—already anticipated by the architecture—include:

* **Additional seat-based classifiers**, such as center-of-pressure estimation, adult/child weight categorization, posture deviation, and child-seat detection.
* **Higher-level statistical holons**, capable of aggregating multi-session data, tracking dwell times, or learning thresholds.
* **Refined controller interfaces**, allowing the glove controller to receive structured external commands and present itself as an addressable goal-driven agent.
* **Manual consolidation**, separating conceptual guidelines, TMCP architecture, and domain-specific manuals (glove, seat) into clearly scoped documents.

TMCP is intentionally an evolving system.
Its design emphasizes replaceability, incremental refinement, and architectural clarity: modules may change, configurations may improve, but the pipeline semantics remain stable, predictable, and inspectable.


