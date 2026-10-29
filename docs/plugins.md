# Local processing plugins

Researchers often need processing that should happen **before** data leaves the device: removing names, hashing identifiers, classifying video titles into topics, detecting language, estimating sentiment. Combray supports this with two kinds of sandboxed code, both run in the sandbox worker.

| | QuickJS scripts | WASM modules |
| --- | --- | --- |
| Written in | JavaScript | Rust, C, Go (TinyGo), AssemblyScript, or anything targeting WASM |
| Typical use | Small field transforms in importers | Anonymisers, classifiers, heavy aggregation |
| Size | Bytes to kilobytes | Kilobytes to tens of megabytes (models) |
| Where defined | Inline in importer YAML or a `.js` file | Plugin package with a manifest |

QuickJS scripts are described in [universal-importer.md](universal-importer.md#scripts-in-quickjs). This document covers WASM modules.

## Sandbox guarantees

A WASM module can only do what its imports allow. Combray gives plugins **no imports that reach the outside world**: no network, no DOM, no filesystem, no clock beyond a coarse one, no randomness unless declared. A module that receives data and returns data cannot exfiltrate it. This is a stronger and simpler guarantee than reviewing JavaScript, and it is the main reason for using WASM here.

Additional limits:

- Memory cap per instance (configurable, e.g. 256 MB) and a time budget per call (via fuel metering or worker termination).
- Modules are loaded from the study config or a platform pack, pinned by hash, and their manifest is shown to the researcher when configuring a study.

## Interface

Version 1 uses a deliberately simple ABI so plugins are easy to write in any language:

- The module exports `combray_alloc(len) -> ptr`, `combray_process(ptr, len) -> ptr_len`, and `combray_free(ptr, len)`.
- Input and output are MessagePack (or JSON) documents: a batch of rows or a subtree, plus plugin options.
- A manifest declares the plugin's id, version, input fields, output fields, and resource limits.

```yaml
id: anonymise-names
version: 0.1.0
kind: transform            # transform | classify | aggregate
input:  [text]
output: [text]             # same field, with names replaced by [NAME]
limits: { memory_mb: 128, time_ms_per_batch: 2000 }
safe_labels: []            # classify plugins: labels that may be shown to the AI helper
wasm: anonymise_names.wasm
sha256: "…"
```

Later, the WebAssembly Component Model with a WIT interface (`combray:plugin/process`) would give typed bindings for many languages. We should adopt it when browser tooling (jco) is mature enough for our use, and keep the simple ABI as a compatibility layer.

## Plugin kinds

- **transform**: rewrites fields (redact names and emails in message text, hash usernames with a study salt, coarsen locations).
- **classify**: adds fields (topic of a video title, language, music genre of an artist). Small models (e.g. ONNX models run via a WASM runtime, or compact rule-based classifiers) fit here.
- **aggregate**: computes summaries that are donated instead of raw data (e.g. "minutes per category per week").

## Where plugins run in the flow

1. After import, to add fields used in views (classification).
2. Before donation, as part of the donation pipeline defined by the study (anonymisation, aggregation). The donation preview shows the data **after** these plugins have run, so the participant consents to what is actually sent.

## Open questions

- Which model runtime for classifiers: ONNX Runtime Web (WASM backend), a Rust inference crate (e.g. `candle`, `tract`) compiled into the plugin, or both?
- Should plugins be allowed to use WebGPU for larger models? That would need a host import, which weakens the "no imports" guarantee slightly.
- Do we ship a default name-anonymiser for Dutch and English, and how good does it need to be before we recommend it?
