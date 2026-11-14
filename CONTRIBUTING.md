# Contributing to Skald

## Where things live

Source and CI are on GitLab: [dunn.dev/skald.md](https://gitlab.com/dunn.dev/skald.md). The public mirror, releases and issues are on GitHub: [andrewdunndev/skald.md](https://github.com/andrewdunndev/skald.md).

- **Issues:** GitHub. Use the issue templates; they ask for what is needed to triage. There is no feature roadmap.
- **Pull requests:** welcome on GitHub or GitLab. GitHub PRs get CI from `.github/workflows/ci.yml`; GitLab MRs run the full pipeline including e2e.

## Support level

Maintained as time allows. Bug reports with a repro get priority. There is no feature roadmap, so for anything large, open an issue before writing code.

## Licence

Contributions are accepted under the repository's [MIT](LICENSE) license.

## LLM-assisted contributions

PRs written with an LLM are welcome if you have run the tests and can explain the change.

## Dev setup

```
pnpm install
```

Node comes from `.node-version`; pnpm from `packageManager` in `package.json`.

**Monorepo layout:**

- `packages/plugin` -- the Obsidian plugin
- `packages/e2e` -- end-to-end tests (`specs/`) that drive the built plugin in desktop Obsidian via wdio-obsidian-service against a mock provider (`lib/`) and a fixture vault (`vault/`). Run with `pnpm test:e2e`.

**Check gates (all must be green before merge):**

| Command | What it checks |
|---|---|
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Unit tests via Vitest |
| `pnpm lint` | Obsidian review lint (eslint-plugin-obsidianmd) |
| `pnpm --filter @skald/plugin build` | Plugin bundle compiles |

**Dev vault workflow:** see the "Develop" section in [README.md](README.md).
