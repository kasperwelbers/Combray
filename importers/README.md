# Importers

Platform packs: one YAML importer spec per file, grouped by platform. The format is described in
[docs/importer-spec.md](../docs/importer-spec.md).

```
importers/
├── google-takeout/*.yaml
├── tiktok/*.yaml
└── fixtures/<name>/
    ├── input/          a synthetic data download package, as unpacked files
    └── expected.json   the rows each matching importer must produce
```

Every importer must be exercised by at least one fixture. Fixtures are **synthetic**: never
commit real exports, not even your own (CLAUDE.md, rule 5).

```sh
pnpm --filter @combray/importers test             # check all fixtures
pnpm --filter @combray/importers update-expected  # rewrite expected.json after a deliberate change
```

Review the diff of `expected.json` carefully after `update-expected`: it is the test.
