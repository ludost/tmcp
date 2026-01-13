
# POSIX Terminal-based Modular Control Pipeline

### (The Pipeline — tmcpl / tmcp)

This repository contains **The Pipeline**, a POSIX-terminal-based modular NDJSON processing architecture for real-time control tasks.

---

## Overview

The Pipeline (tmcpl) is a modular chain of **source**, **transformer**, **control**, **adapter**, and **sink** executables.
Each module reads NDJSON from `stdin`, processes it, and writes NDJSON to `stdout`.
The design emphasizes:

* **strict, predictable CLI semantics**
* **POSIX stream compatibility**
* **stateless surface API, with internal state where needed**
* **transparent metadata tagging and logging**
* **composability through uniform NDJSON structures**

Executable filenames follow:

```
tmcp-<category>-<(sub)function>.js
```

Examples:

* `tmcp-source-file.js`
* `tmcp-control-merge-streams.js`
* `tmcp-transformer-kalman.js`
* `tmcp-sink-file.js`

---

## Documentation

Full manual:
**[docs/pipeline-manual.md](docs/pipeline-manual.md)**
Includes:

* Design principles
* Module taxonomy
* CLI conventions
* Logging policies
* Configuration formats
* Usage examples
* Recommendations for predictable and safe control-loop composition

---

## Quick-start Example

Pipeline example (record → reduce → save):

```bash
node js/tmcp-source-file.js recorded.ndjson \
  | node js/tmcp-transformer-reduce.js reduce-config.json \
  | node js/tmcp-sink-file.js output.ndjson
```

Live control loop example:

```bash
node js/tmcp-source-arduino.js /dev/ttyUSB0 \
  | node js/tmcp-transformer-kalman.js kalman.json \
  | node js/tmcp-control-gate.js control-config.json \
  | node js/tmcp-adapter-modbus.js /dev/ttyUSB1
```

---

## Repository Structure

```
js/
  tmcp-source-*.js
  tmcp-transformer-*.js
  tmcp-control-*.js
  tmcp-adapter-*.js
  tmcp-sink-*.js
  lib/pipeline-utils.js

docs/pipeline-manual.md
README.md
```

---

## Contributing

Contributions that preserve:

* deterministic, reproducible stream semantics
* minimal module surface area
* compatibility with POSIX shell pipelines

are welcome.


