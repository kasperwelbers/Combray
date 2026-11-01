# Importers

Platform packs, in two forms while we move from one to the other:

- **Project trees** (`importer.json` and `structure.json` per platform), as described in
  [docs/tree-decisions.md](../docs/tree-decisions.md). `structure.json` is the union of the
  platform's fixtures; `importer.json` holds labels, aliases, conversions, row filters and
  decisions, and is what the researcher workspace (`/studio/`) opens and saves. Projects start
  from these.
- **YAML importer specs**, one per file, as described in
  [docs/importer-spec.md](../docs/importer-spec.md). These are what participants' clients run
  today for projects without upload points; they are retired once nothing uses them.

```
importers/
├── google-takeout/importer.json, structure.json, *.yaml
├── tiktok/importer.json, structure.json, *.yaml
└── fixtures/<name>/
    ├── input/          a synthetic data download package, as unpacked files
    └── expected.json   the rows each matching YAML importer must produce
```

`test/packs.test.ts` checks that each `structure.json` is the union of its platform's fixtures
(fixtures named `<platform>-…`, merged in name order with the pack's aliases), that every
setting in `importer.json` finds its node, and that the tables derived through the pack give
the same rows as the YAML importers' `expected.json`.

Every importer must be exercised by at least one fixture. Fixtures are **synthetic**: never
commit real exports, not even your own (CLAUDE.md, rule 5).

```sh
pnpm --filter @combray/importers test             # check all fixtures
pnpm --filter @combray/importers update-expected  # rewrite expected.json after a deliberate change
```

Review the diff of `expected.json` carefully after `update-expected`: it is the test.
`update-expected` also rewrites each pack's `structure.json`.

Vitest caches transformed modules, including the list of pack files `packs.ts` finds. After
adding a new platform folder, clear it with `rm -rf node_modules/.vitest-cache`.
