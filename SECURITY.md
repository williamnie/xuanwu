# Security policy

## Supported versions

Security fixes are applied to the latest `v0.2.x` release and the default branch. Older release
lines may not receive patches.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting flow:

<https://github.com/williamnie/xuanwu/security/advisories/new>

Include:

- the affected version or revision and operating system;
- a minimal reproduction and the expected security boundary;
- impact, prerequisites, and whether the issue has been exploited;
- redacted logs or artifacts that help reproduce the issue.

Never send real API keys, bearer tokens, cookies, private repository contents, or a production
database. Replace secrets with unmistakable placeholders and provide only the minimum data
needed to reproduce the problem.

The maintainer will acknowledge the report when practical, validate the affected boundary, and
coordinate a fix and disclosure. Please avoid public disclosure until a patched release or an
agreed disclosure date is available.

## Deployment guidance

Xuanwu executes coding agents and tools on the host. It should run as a non-privileged user on a
trusted machine with access only to intended repositories.

- Bind to `127.0.0.1` unless LAN access is intentionally required.
- Keep bearer authentication enabled for every non-loopback deployment.
- Use an SSH tunnel or a TLS-terminating reverse proxy; do not expose the built-in HTTP service
  directly to the public internet.
- Treat provider, connector, skill, MCP, and project instructions as untrusted until reviewed.
- Store credentials in restricted files or supported provider stores, never in Git, issues,
  prompts, logs, or screenshots.
- Back up and test-restore `runner.db` before upgrades or maintenance.

Xuanwu `v0.2.x` is not a hardened multi-tenant isolation boundary.
