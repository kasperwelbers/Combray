# ADR 0008: Participant links under `/p/{project}/`

- **Status:** accepted
- **Date:** 2026-11-03
- **Amends:** [ADR 0005](0005-projects-scope-stores.md) (decision 1, the participant URL)

## Context

ADR 0005 put each project at the top level of the site: `/{project}/`. The web client also has its own pages there (`/studio/`, `/assets/`, and the API under `/api/`), so the server kept a list of reserved names that projects could not use. Every new top-level page would have to join that list, and once a project had taken a name (`docs`, `help`), that page could not be added without breaking the project's links. Participant links end up in consent forms, invitations and printed cards, so they must not change once a study runs.

## Decision

Participants open **`/p/{project}/`** (questions and answers at `/p/{project}/faq`). The fragment carries the same things as before (`#id=…`, `#reset=…`, `#k=…`). The short prefix matches the participant API (`/api/v1/p/{project}/…`) and keeps links easy to type from paper. Project ids no longer need reserved names.

Old top-level links (`/{project}/`) are not redirected: no study had used them yet.

## Consequences

- New top-level pages can be added at any time without checking existing project ids.
- Links are two characters longer.
- The key page, `reset-link` and the web client all build links with the prefix; the route parser only finds projects under `/p/`.
