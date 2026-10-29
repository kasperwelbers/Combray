# ADR 0003: TypeScript core first, a small local key tool, MIT licence

- **Status:** accepted
- **Date:** 2026-10-29
- **Amends:** [ADR 0002](0002-modular-components.md) (the researcher tool) and open questions 2, 6b and 13

## Context

Building started with the first roadmap milestone. Three questions had to be settled first: in which language the tree core (parsing, paths, shapes) is written, how much of the researcher tool has to run locally, and under which licence the code is published.

## Decision

1. **The core is TypeScript.** Parsing data download packages into the tree, the path language, shape extraction and tree queries are implemented in TypeScript (`packages/core`) and run in a web worker in the participant's browser. A Rust/WASM layer is only added for a hot path once measurements show TypeScript is a bottleneck. The server stays Rust ([ADR 0001](0001-server-language.md)).
2. **The researcher UI runs in the browser; only key handling is local.** Instead of a full local Studio application, researchers get a small local tool that does what must not happen in a page served by a shared server: create the project key pair (and back it up), sign project configs, and decrypt donations. Everything else a researcher does (configuring importers, views and questions, managing participants) can be a browser UI.
3. **Licence: MIT.**

## Consequences

- One language for everything that runs in the browser, which the maintainers know best; contributors do not need a Rust toolchain to work on importers or views.
- Formats (tree, paths, shapes) are defined by the TypeScript implementation and its tests. If a Rust version is added later, it is tested against the same cases.
- `packages/core-js` and `crates/combray-core` from the proposed layout become `packages/core`; there is no `crates/combray-core` for now.
- The local key tool is much smaller than Studio, so it is easier to review, sign and ship for three platforms. It never needs a UI framework.
- The browser researcher UI must never receive a private key. Signed configs are produced by the key tool and uploaded through the browser UI or the tool itself; the exact flow is designed in Phase 2.
- Large-file parsing (multi-gigabyte Takeouts, huge HTML files) is the most likely place where TypeScript runs out of road. That is where to measure first.

## Alternatives considered

- **Rust core from the start, compiled to WASM.** Exact agreement between browser, server and Studio, and better performance for very large inputs, but slower to build and harder to contribute to. Kept as an option for hot paths.
- **A full local Studio** (ADR 0002 as proposed). Keeps every researcher action local, but most of them do not touch keys, and a local app is more work to build, sign and support.
