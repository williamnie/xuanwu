# Third-party release compliance gate

Xuanwu release archives contain more than the project binary: they include compiled backend dependencies, built frontend assets, Pi package assets, a target-specific Claude Agent SDK executable, and a Qoder CLI runtime bundle. Every archive must carry generated evidence under `compliance/`:

- `sbom.cdx.json`: CycloneDX 1.6 inventory for the installed backend production graph and frontend production lock set. Target-native adjacent payloads are called out separately; host-only optional packages that are not copied into an archive are excluded.
- `THIRD_PARTY_NOTICES.md`: package versions, declared licenses, copied license paths, and unresolved review points.
- `third-party-licenses/`: license/NOTICE files found in installed packages plus the Pi monorepo MIT text omitted from its npm packages.
- `bundled-components.json`: mapping from Pi, Claude and Qoder payload paths to resolved packages.
- `legal-review.json`: machine-readable release decision.

Generate and validate the evidence without claiming release readiness:

```sh
node scripts/generate-release-compliance.mjs --output dist/compliance-review
node scripts/verify-release-compliance.mjs dist/compliance-review
```

`scripts/package-release.sh` additionally runs `--require-release-ready` before creating an archive and verifies the archived files afterward. The gate is deliberately fail-closed while `third_party/release-redistribution-policy.json` contains `requires-legal-review` entries or an installed package lacks an authoritative license text. Standard Apache-2.0 packages share the full Apache text; Pi packages share the upstream monorepo MIT text. Other missing texts remain explicit blockers.

As of this review, two legal confirmations remain:

1. Anthropic's packaged notice reserves all rights and links to service terms; obtain explicit authorization to redistribute the Claude Agent SDK native executable and compiled SDK code in public Xuanwu archives.
2. Qoder Agent SDK licensing delegates to Product Service Terms, whose reviewed license is limited, non-transferable and non-sublicensable; obtain explicit authorization to redistribute SDK code compiled into Xuanwu. The Qoder CLI package itself includes Apache-2.0, but use of the service remains subject to Qoder terms.

An authorized reviewer may change a status only with a durable approval reference and an exact version/scope review. Do not treat npm availability, installation success, or an SPDX label on a different companion package as redistribution approval.

Dependency audit policy is separate: `security/dependency-audit-policy.json` permits only the exact `@qoder-ai/qodercli > sharp` advisory that has no compatible upstream fix. `scripts/dependency-security-audit.mjs` fails on any new advisory or on a stale exception after upstream fixes become available.
