# Cloudy commercial readiness implementation plan

> **For agentic workers:** Execute the user's authorized audit and local fixes continuously, with parallel domain reviews and final independent review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review the current repository, remove proven redundant code, and correct reliability and performance defects while preserving every existing function and presentation.

**Architecture:** Work from GitHub main `1d285df8ef8ea26b21d26a5db75b477fcc87c490` on a separate local branch. Domain owners review complete files, make minimal changes, and verify substantive fixes with failing regression tests before implementation. Root integrates and reviews all changes.

**Tech stack:** Node.js 24, Discord.js, PostgreSQL, Express, Railway, Node test runner, ESLint.

**Spec:** User request in this conversation and repository `AGENTS.md`.

## Global constraints

- Preserve command names, functionality, embeds, saved content, branding, colors, spacing and reply lifetimes.
- Preserve unrelated user commits and all old working copies; they are not production dead code.
- Preserve the Embed Builder and ZORP Guide. The user subsequently authorized the concrete Builder access-boundary repair after reviewing its extra private-link click and channel-access restrictions; that narrow exception is applied.
- Remove code only after checking static imports, dynamic loaders and persisted identifiers.
- Do not claim complete commercial certification from automated tests alone.

## Review focus

- Concurrent Discord operations must retain per-guild state and ownership checks.
- Caches, collectors and timers must release state without changing their visible lifetimes.
- Database retries and transactions must not duplicate economic or moderation actions.
- HTTP endpoints must not leak credentials, permit unauthorized changes or expose private data.
- Deployment, dependencies and backup procedures must remain reproducible.

## Tasks

- [x] Establish baseline: full lint/test suite, current Git revision and dependency audit.
- [x] Review and fix commands, handlers and interactions; record full-file coverage and focused verification.
- [x] Review and fix services; record full-file coverage and focused verification.
- [x] Review events, web pages and monitor; assess security boundaries and record verification.
- [x] Review core, utilities, configuration, scripts, CI, assets and documentation; remove only proven obsolete code and verify fixes.
- [x] Integrate results, review the patch independently, run full local quality gates and record commercial limitations in an updated audit report.
- [ ] Confirm pull-request CI, deploy through main and verify Railway SUCCESS plus Discord ONLINE.

Local combined verification: 792/792 tests passed; ESLint 0 errors, 390 warnings (519 baseline). The monitor delivery secret is configured without restarting production, ready for the new authenticated handler.

Execution is already authorized by the user. Routine reversible decisions do not require another approval. Production changes will be made only after the reviewed patch passes its release checks.
