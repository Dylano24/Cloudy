# Cloudy: whole repository review — 28 October 2026

## Current audited revision

GitHub `main` at start of review: `fe9a63c3d64d3bbfbe41fa2ec31498553efea055`.
Scope is the **entire Cloudy Discord Bot** repository, not just the Embed Builder.
No production deployment or database migration is included in this draft PR.

## Inventory and verification performed

- GitHub recursive tree: 910 entries, including directories; 814 tracked file paths.
- Source checkout: 754 tracked `.js`/`.mjs` file paths, including application, scripts, tests and other tracked code.
- Automated `node --check` syntax pass: 751 JavaScript files under `src`, `scripts`, `test` and `monitor`, **0 syntax errors**.
- Inspected application HTTP middleware ordering, bot startup, Economy transfer path, package scripts, quality workflow, and prior audit evidence.
- Dependencies were installed in a separate audit checkout. Full ESLint and full test suite attempts hit a remote tool execution limit and therefore **are not reported as passing**.
- Older audit documentation reports historical suite/lint results, which do not establish the current revision's status.
- At review time, Railway reported Cloudy, Redis and PostgreSQL online. PostgreSQL had one active warning, without a verified cause. An online deployment is not proof of correctness.
- Existing unmerged Pull Requests #403 and #404 both address Embed Builder media; do not blindly combine their changes with this review.

## Verified finding repaired in this PR

**HTTP route registration bypassed the global limiter:** `registerAppealsApi`, `registerWebsiteAssistantApi`, and `registerEmbedMediaRoutes` ran before the Express limiter was installed. As a result these routes could handle requests before the limiter ever ran. The registrations now occur after the existing limiter. Route URLs, response formatting, limits, API implementations, and handlers are unchanged. Added a narrow regression test for middleware ordering.

## Additional risk requiring separately designed changes

**Money transfer is not atomic:** `EconomyService.transferMoney` writes the sender, then the receiver, and attempts a second sender write on failure. A process crash between writes, or failure of the rollback write, can leave balances inconsistent. A correct fix requires a PostgreSQL transaction across both accounts with appropriate concurrent-update handling, including compatibility with the existing storage key layout and any other account writers. Do not replace this with only an in-memory mutex: that would not ensure durable atomicity.

**Data and behavior risks noted in earlier full audit:** account changes made by multiple modules and whole configuration replacements may conflict under concurrency; ticket transcript memory and cleanup maps may grow; and live Discord/API latency must be measured rather than inferred from local test timings. The source-level review here does not independently re-prove every historical claim.

## Comprehensive review areas and safety requirements

| Area | Required scope for follow-up corrective work |
| --- | --- |
| Commands | All 142 source command modules, including moderation, economy, games, tickets, welcome, verification, music, search, utility, Join to Create and Embed Builder |
| Interaction handlers | All buttons, modals, select menus, autocomplete, permission checks, response lifecycles, and callbacks |
| Events | All 88 source event files, including ready, message, channel, member and deletion events |
| Services | All 112 service modules; distributed state, transactional integrity, caching, registry, catalog, and session management |
| Data and cache | PostgreSQL and Redis, key layout, migrations, synchronization, lost updates, indexes and safe recovery |
| Runtime | Bootstrap, startup, command registration, health/readiness, monitoring, scheduled tasks, API routes, logs and security |
| Frontend-facing messages | Exact embeds, titles, saved media, colors, logos, footers, buttons, Search previews and Discord message identities |
| Tests/automation | All 252 tracked test files and GitHub workflows, targeted regressions, latency traces, deployment rollback |

These are scope/inventory counts, **not a claim of line-by-line manual verification or end-to-end live Discord coverage**.

## Guardrails

Do not mutate existing saved embeds, logs, templates, server channels, game balances or database data as part of cleanup. Preserve the ZORP Guide, canonical Embed Builder Save/Delete/Search behavior, ticket logs, permission policies, and all Discord-facing copy. No merge or production deploy without explicit approval and a verified preview. The full suite, clean lint output and Railway verification are release requirements, not assumed facts.

## Follow-up release gate

Run `npm ci`, `npm run lint`, `npm test`, migrations check and a production-like Discord/Redis/PostgreSQL smoke test on the candidate revision, then inspect PR diff and compare current main HEAD. Only merge/deploy after explicit owner approval.
