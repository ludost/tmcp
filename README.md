
# POSIX Terminal-based Modular Control Pipeline

### (The Pipeline — tmcpl / tmcp)

This repository contains **The Pipeline**, a POSIX-terminal-based modular NDJSON processing architecture for real-time control tasks.
It is currently used to control the *Inspire Robotics hand* using the *Brighter Signals Sensor Glove*, but the architecture itself is general-purpose.

---

## ⚠ ChatGPT Priming Instructions (verbatim, as requested)

How to "prime" ChatGPT: Upload a (run "tar -czf git-repo.tgz .git" to create it) tarball of the .git folder of this repository containing the `pipeline-manual.md` and ask the following question:



This project depends on consistency and a clear effective workflow. For that purpose, we've written two documents to help you understand the workflow and style of this project, the architectural principles that govern the code, and a project manual that documents the actual implementation of the project. 

To prepare for working on the TMCP, please apply the workflow marked 8A as described in the Guidelines-merged.md project file for unpacking and deploying the /mnt/data/repo folder.

Please read and follow the LLM-Guideline document, as a workflow and style, for the most effective collaboration with me, for as long as I suggest that we're still working on the TMCP-pipeline. Please give a concise 2-sentence summary of the Architectural principles as described in the Guidelines.

Please prime your working context/state with the entire /mnt/data/repo/pipeline-manual.md, read it carefully.

To make sure you've read the manual thoroughly, here are a couple of questions. Please answer them each with a single, concise sentence: 
1: How do we ensure the NDJSON is handled identically by all modules? 
2: Which module is the most complex to use, from a configuration perspective? 
3: Where is the message rate controlled? (=trick question!) 
4: How would we visualize an earlier captured data trace? 
5: Where is the domain knowledge of our robotic hand encoded?

Give a concise 3–4 sentence summary of the project: its development goal, the design constraints defined in the manual.




To provide the entire code base:

find ./js/ -maxdepth 2 -name "*.js" -print -exec cat "{}" \;


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
**[pipeline-manual.md](pipeline-manual.md)**
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

pipeline-manual.md
README.md
```

---

## Contributing

Contributions that preserve:

* deterministic, reproducible stream semantics
* minimal module surface area
* compatibility with POSIX shell pipelines

are welcome.


