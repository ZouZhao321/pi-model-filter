# Contributing

## Development workflow

1. Create a topic branch: `git checkout -b feat/your-change`
2. Commit with the message format described below
3. Push the branch and open a pull request

## Commit messages

Subject format: `type(scope): 中文描述`. The description is written in Chinese; the scope is optional.

| Type     | Meaning                         |
| -------- | ------------------------------- |
| feat     | New feature                     |
| fix      | Bug fix                         |
| refactor | Refactoring, no behavior change |
| test     | Tests                           |
| docs     | Documentation                   |
| chore    | Maintenance                     |
| perf     | Performance                     |

The description must contain Chinese characters. `scripts/check-commit-msg.mjs` enforces both the format and the type list; subjects starting with `Merge `, `Revert `, `fixup! `, `squash! ` or `amend! ` are passed through untouched.

The hooks are managed by husky: `npm install` runs the `prepare` script, which installs them into `.husky/`, so a clone is ready as soon as the dependencies are installed. `.husky/commit-msg` runs `node scripts/check-commit-msg.mjs "$1"` to validate the subject of every commit.

## Before you push

```bash
npm ci
npm run typecheck     # tsc --noEmit
npm run lint          # eslint . --ext .ts
npm test              # vitest run
npm run format:check  # prettier --check .
npm run check:pack    # assert the npm tarball contents
```

`npm test` runs the vitest suite in `src/index.test.ts`. `npm run check:pack` runs `npm pack --dry-run --json` and asserts that the entry declared in `pi.extensions`, `package.json`, `README.md`, `README.zh.md`, `LICENSE` and `CHANGELOG.md` are inside the tarball, and that `node_modules/`, `.github/`, `.husky/`, `tmp/`, `.worktrees/`, `docs/adr/`, `CONTEXT.md`, `HANDOFF.md` and `SPEC.md` are not.

## Continuous integration

`.github/workflows/ci.yml` runs the same six commands on `ubuntu-latest` with Node 22 and 24 and on `windows-latest` with Node 22, plus a `commit-msg` job that validates the subjects of the pushed commits (it is skipped for dependabot). `.github/workflows/gitleaks.yml` scans the repository and the pushed commits for secrets. Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which runs `prepublishOnly` and publishes to npm with provenance.

## Pull requests

- One logical change per pull request
- Fill in every section of the pull request template
- State what changed and how you verified it

## Issues and security reports

Use the [issue tracker](/issues) for bugs and feature requests. Report security problems through the repository's Security tab; see [SECURITY.md](./SECURITY.md).

By contributing you agree that your changes are released under the MIT license, see [LICENSE](./LICENSE).
