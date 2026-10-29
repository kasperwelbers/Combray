# ADR 0001: Server language

- **Status:** proposed
- **Date:** 2026-10-29

## Context

The server must be easy to deploy (one small binary or one small Docker image, no runtime to install), secure, and capable of fetching a lot of URL metadata quickly. It should do as little as possible. Node and Electron are ruled out because of install size and dependency surface. The two candidates are Rust and Go.

What the server does (see [architecture.md](../architecture.md#server)): serve static files, sessions and auth, a key wrapping service, an enrichment fetch queue with a cache, donation intake to disk or S3, and an optional AI proxy. It also ships alongside a researcher CLI that generates keys and decrypts donations.

## Options

### A. Rust (axum, tokio, reqwest, rusqlite/sqlx)

- **Deployment:** single static binary (musl), typically 10 to 20 MB with the SPA embedded. Tiny distroless or scratch Docker image.
- **Security:** memory safety without a GC, strong type system for protocol code, mature crypto (RustCrypto, `libcrux-ml-kem` which is formally verified, `hpke` crates, `x-wing`).
- **Scraping:** tokio handles thousands of concurrent requests comfortably; `reqwest` with HTTP/2 and connection pooling; `lol_html` (Cloudflare's streaming HTML rewriter) can extract `<meta>` tags and stop at `</head>` without building a DOM, which is ideal for metadata. Ergonomics are a bit heavier than Go's, but this is a well-trodden path.
- **Code sharing:** the decisive point. `combray-core` (tree model, path language, shape extraction, aggregation) and `combray-crypto` (envelope format) compile to WASM for the browser and natively for the server and CLI. One implementation, one set of test vectors.
- **Costs:** steeper learning curve for contributors from social science research software; slower compile times.

### B. Go (net/http, goquery or x/net/html, modernc sqlite)

- **Deployment:** single static binary, similarly small. Very easy cross-compilation.
- **Security:** memory safe with a GC; standard library includes `crypto/mlkem` (ML-KEM-768/1024, since Go 1.24) and `crypto/ecdh` (X25519), so hybrid KEM is available with no third-party code.
- **Scraping:** goroutines and `net/http` make concurrent fetching very simple; Colly exists. Streaming HTML tokenising via `x/net/html` works well.
- **Code sharing:** Go compiles to WASM, but binaries are large (several MB minimum) and slower; TinyGo is smaller but limited. In practice the browser core would be a separate TypeScript or Rust implementation, so formats would be implemented twice.
- **Costs:** less expressive types for protocol code; the client core would need a second language anyway.

### C. Split: Rust core and server, Go scraper service

Possible, but two toolchains, two images and a network boundary for a component that is not hard to write in Rust. Not worth it at this size.

## Recommendation

**Rust**, for the server, the CLI and the shared core. Go's scraping ergonomics are a real advantage but a small one compared to sharing the core and crypto code with the browser through WASM. The scraper's hard problems (politeness, caching, privacy of requests, parsing only the `<head>`) are design problems, not language problems; see [enrichment.md](../enrichment.md).

To keep the contributor barrier low:

- Keep the server code plain: axum handlers, no macros beyond derive, no exotic async patterns.
- Importers are YAML plus optional JavaScript, so most researchers never touch Rust.
- If the enrichment fetcher ever needs a headless browser (JavaScript-rendered pages), run it as an optional separate container (e.g. Playwright/Chromium) behind a small interface, in whatever language suits it.

## Consequences

- The workspace layout in [architecture.md](../architecture.md#monorepo-layout) is a Cargo workspace plus pnpm workspaces.
- CI needs the Rust toolchain, `wasm32-unknown-unknown` target and `wasm-bindgen`.
- We should time-box an early spike: fetch metadata for 10,000 TikTok and YouTube URLs through the Rust fetcher and measure throughput, to confirm the choice.
