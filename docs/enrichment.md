# Enrichment and scraping

## Why enrichment matters here

DDPs are often thin. TikTok gives video links and usernames; YouTube gives titles but no thumbnails; browser history gives URLs. In a qualitative session that is not enough: a participant recognises a face or a thumbnail long before they recognise `tiktok.com/@xyz/video/7234...`. Enrichment turns traces into something that can evoke memory.

The problem with existing tools is timing: enrichment takes long, so either the participant waits, or exploration happens on unenriched data. Combray treats enrichment as **progressive**: the participant starts exploring immediately, and titles, names and thumbnails fill in as they arrive.

## Flow

```
 dataset in browser
   │  importer declares enrichable fields (e.g. url → tiktok-video)
   ▼
 candidate selection (local)        e.g. "top 25 profiles by watch count", "videos from March 2024"
   │
   ▼
 sanitise (local)                   strip tracking params, drop non-matching URLs, dedupe
   │
   ▼
 consent preview                    participant sees the exact list, can remove items
   │
   ▼
 POST /enrich (batch, shuffled)  ──► server: per-enricher queue ─► fetch ─► parse <head> / oEmbed
   │                                     │
   │  SSE stream of results  ◄───────────┘  shared cache (url → public metadata)
   ▼
 merged into the encrypted local store; views update live
```

## What gets sent

The participant consents to a **concrete, bounded selection**, not to "enrichment" in general. project configs define selection presets, for example:

- the top *N* items by count (profiles watched, channels, domains)
- items in a time window the participant is looking at
- items the participant selected manually in a view

Before anything is sent, the client sanitises:

- **Enricher allowlist.** Each enricher declares URL patterns it accepts (`https://www.tiktok.com/@{user}`, `https://www.youtube.com/watch?v={id}`). URLs that match no enabled enricher are never sent.
- **Canonicalisation.** URLs are rebuilt from their extracted ids (`youtube.com/watch?v={id}`), which drops tracking parameters, timestamps, session tokens and personal query strings. Arbitrary browsing URLs (with possible tokens, document ids, search queries) are not enrichable unless a study adds a specific enricher, and even then only the canonical form is sent.
- **Denylist.** Internal hosts, IP addresses, `localhost`, intranet suffixes, cloud document hosts, and URLs containing anything that looks like an email address or token are dropped.
- **Deduplication and shuffling.** Each unique URL is sent once, in random order, without counts or timestamps. The server learns *that* these URLs were of interest, not how often or when.

## What the server keeps

- The **cache** maps a canonical URL (or an HMAC of it, see below) to public metadata: title, description, author name, thumbnail URL or a small re-encoded thumbnail, fetch time, status. It does not store which session, participant or study requested it. Popular items (well-known creators) are shared across all participants, which makes enrichment faster for everyone.
- Cache keys are `HMAC(server_secret, canonical_url)`, so a database dump without the server secret does not directly list URLs. (The metadata itself is public and may still reveal them; this is a defence in depth, not a guarantee.)
- No request logs with URLs. Job state (which URLs belong to which batch) lives in memory only and is dropped when the stream ends.
- No cache-hit timing tricks: cache freshness timestamps are coarse (day), and no per-entry request counters are stored.
- Rate limiting is per session token, in memory.

For studies with stricter requirements, the server can run in **no-cache mode** (fetch, return, forget), or enrichment can be disabled entirely.

## Fetching lots of metadata quickly

Most of the speed comes from not doing more than needed.

1. **Use structured endpoints first.** Many platforms offer **oEmbed** (YouTube, TikTok, Vimeo, SoundCloud, Spotify and others): one small JSON request that returns title, author and thumbnail. Enrichers prefer oEmbed or similar public JSON over HTML.
2. **Read only the head.** For HTML pages, fetch with a byte limit and parse Open Graph, Twitter Card and `<title>` tags with a streaming parser (`lol_html` in Rust) that stops at `</head>`. Most pages give everything needed in the first 30 to 100 KB.
3. **High concurrency, polite per host.** An async fetcher (tokio + reqwest, HTTP/2, connection pooling) can run hundreds of requests in parallel overall, while a per-host token bucket keeps each platform at a configured rate. Backoff on 429 and 5xx; respect `Retry-After`.
4. **Cache aggressively.** Shared cache as above, plus thumbnail caching so the browser does not have to contact the platform itself (which would leak the participant's IP and viewing interest to the platform).
5. **Stream results.** Results return through server-sent events as soon as each one is ready, so the UI updates progressively. The client can reprioritise: items currently on screen are fetched first.
6. **Optional headless browser.** Some pages only render with JavaScript. A separate, optional container (Chromium via Playwright) can handle a small set of enrichers that need it. It is slow and heavy, so it is off by default.

A rough target to validate in the first spike: enrich 1,000 unique URLs in under a minute from a cold cache on a normal university connection, and instantly from a warm cache.

### Thumbnails

Thumbnails are where the participant's browser would otherwise contact the platform's CDN directly. Combray proxies them: the server fetches, re-encodes to a small WebP, strips metadata, and returns them; the client stores them encrypted with the rest of the data. A strict Content Security Policy prevents the client from loading images from third-party origins at all.

## Enricher definitions

Enrichers are small, declarative definitions shipped with platform packs, executed by the server:

```yaml
id: tiktok-profile
match: "https://www.tiktok.com/@{user}"
canonical: "https://www.tiktok.com/@{user}"
strategy:
  - oembed: "https://www.tiktok.com/oembed?url={canonical}"
  - html_head:
      fields: [og:title, og:description, og:image]
rate: { per_host: 5/s, burst: 10 }
returns: [title, author_name, thumbnail]
```

Enrichers cannot run arbitrary code on the server; new strategies require a code change and review.

## Terms of service and ethics

Fetching public metadata at small scale for consenting participants is a different activity from bulk scraping, but platform terms differ and change. Each enricher documents what it fetches and how. Studies choose which enrichers to enable, and the ethics documentation explains the trade-off. Where a platform offers an official API with researcher access, an enricher can use it with credentials held by the server.

## Open questions

- Should the client mix in decoy URLs (e.g. popular items) to make batches less identifying, or is shuffling plus not logging enough? Decoys cost fetches but mostly hit the cache.
- Is a shared cache across studies acceptable for all ethics committees, or should caches be per study by default?
- Should enrichment be possible in browser-only mode through a public Combray enrichment service run by the team, or is that a trust boundary we do not want?
- How do we keep enrichers working as platforms change oEmbed and HTML? A scheduled CI job that tests each enricher against a few public URLs?
