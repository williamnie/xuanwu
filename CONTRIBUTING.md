# Contributing to Xuanwu

Thank you for helping improve Xuanwu. Bug reports, design feedback, documentation fixes, and
focused code contributions are welcome.

## Before you start

1. Search existing issues and discussions before opening a new one.
2. For a bug, include the Xuanwu version, operating system, provider, reproduction steps,
   expected behavior, and redacted logs or screenshots.
3. Open an issue before a large feature, public contract change, database migration, or broad
   refactor. The maintainers may ask for a contributor agreement before accepting non-trivial
   code because Xuanwu uses source-available and separate commercial licensing.
4. Do not report security vulnerabilities in a public issue; follow [SECURITY.md](SECURITY.md).

Never include API keys, bearer tokens, cookies, private repository contents, personal paths,
or unredacted provider errors in an issue or pull request.

## Development setup

Install Bun, Node.js/npm, Git, and an authenticated Codex CLI, then run:

```bash
git clone https://github.com/williamnie/xuanwu.git
cd xuanwu
./dev.sh
```

The backend lives in `backend-ts/`, the React frontend in `frontend/`, and current product
contracts under `docs/architecture/xuanwu/`. Start architecture work from the
[canonical index](docs/architecture/README.md); top-level dated design documents are historical
records unless that index says otherwise.

## Change guidelines

- Keep changes focused and preserve compatibility unless the proposal explicitly includes a
  migration and rollback path.
- Do not treat model output as completion evidence. State transitions, approvals, external
  actions, verification, and handoffs must stay on their deterministic authority paths.
- Do not add secrets, runtime databases, logs, generated bundles, or one-off test artifacts to
  Git. Use ignored state or temporary directories.
- Add or update focused tests for behavior changes. Separate fixture/offline evidence from live
  provider, browser, connector, or deployment acceptance.
- Update both `README.md` and `README.zh-CN.md` when public setup, naming, or product behavior
  changes.

## Verification

Run checks proportional to the change. The release baseline is:

```bash
cd backend-ts && bun test --timeout 60000
cd ../frontend && npm run lint && npm run build
cd .. && node scripts/repository-hygiene-audit.mjs --json
git diff --check
```

For end-to-end contract changes, also run:

```bash
bun scripts/run-golden-journeys.ts
```

## Pull requests

Explain the problem, scope, compatibility impact, verification commands and results, and any
remaining live acceptance. Link the relevant issue or ADR. Keep unrelated cleanup out of the
same pull request.

By contributing, you agree that your contribution may be distributed under the repository's
current public license. Any additional commercial or relicensing rights require separate
written terms; do not assume they are granted by a pull request alone.
