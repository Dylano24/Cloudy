# Cloudy code and release audit

Audit date: 8 October 2026. Base: `1d285df8ef8ea26b21d26a5db75b477fcc87c490`. Scope: the current `Dylano24/Cloudy` repository, preserving previous workspace copies and saved Discord content.

## Verified changes

- Removed proven unused bindings, unexported helper trees, duplicate branches, and two obsolete ready-event migrations. Dynamic command and interaction modules are retained. Startup no longer runs the completed inventory hook or rewrites ZORP guide spacing.
- Serialized conflicting warning, birthday, giveaway, welcome/settings and moderation-history changes in the current process. Strict authoritative reads and rejected-write checks prevent several default-overwrite and false-success paths. Birthday/giveaway PostgreSQL replacement writes now use a dedicated transaction with rollback.
- Prevented transient Discord lookup failures from deleting birthdays, applications, reaction-role panels or Join to Create configuration. Only confirmed missing Discord resources trigger the existing cleanup behavior.
- Corrected modal field access, hex validation, password category coverage/randomness, Windows dynamic imports, currency-config escaping, legacy ticket feedback and overlapping ticket deletion.
- Isolated embed catalog cache state by guild, protected newer manual registry saves against stale background refreshes, and retained existing saved source content.
- After the user's specific go-ahead, removed public editor bearer URLs from Builder controls. The owner receives the link privately with one extra click. Search/Modify/Post/Save enforce member channel access, including backing/source channels. Dashboard rows, saved embeds, preview formatting and expiry durations are retained.
- Added a monitor webhook secret and configured the corresponding Railway delivery URL before release. Unauthorized webhook calls fail before body parsing. Public read-only status endpoints and the 60-second polling interval are retained.
- Reduced diagnostic exposure of message contents and database URLs, avoided shell interpretation in backup tools, aligned migration TLS configuration with runtime, and run the container as the existing non-root Node user.
- Corrected stale setup instructions and removed unsupported numeric speedup and blanket production-security claims.

## Verification

| Check | Result |
| --- | --- |
| Baseline complete suite | 660 passed, 0 failed |
| Final local complete suite | 792 passed, 0 failed/cancelled/skipped |
| Final local ESLint | 635 JS/MJS files, 0 errors, 390 warnings (baseline: 519 warnings) |
| Dependency audit | 0 reported vulnerabilities across 271 installed dependencies; no dependency changes |
| Dynamic-loader smoke | 96 commands, 66 buttons, 7 select menus, 15 modals loaded |
| Independent integration review | All 60 then-current non-command tracked diffs reviewed; 58 additional focused tests passed, no actionable regression found |
| Builder repair | 8 new behavioral regressions; 152 related tests passed in the isolated proposal, subsequently included in the final full suite |
| Welcome mutation repair | 3 failing regressions before repair; all 4 dedicated tests passed afterward |

Regression tests use real project functions with controlled Discord/storage doubles. They prove the covered behavior, not live Discord latency or end-to-end persistence under every failure. PostgreSQL migrations, native backup/restore and non-root container permissions are checked by pull-request CI. Release/deployment results are recorded in the pull request after those checks finish.

## Coverage

Every repository folder is inventoried with current file hashes and physical line counts in [code-inventory.json](docs/audit/code-inventory.json). Dependency/generated folders, ignored secrets and archived workspace exports are outside that inventory. ESLint parses all included JavaScript/MJS; the full suite exercises all retained tests.

Manual runtime source reads include all 194 command/handler/interaction files, all 100 service files, all 93 baseline event/web/monitor files, and core utilities/configuration/scripts. Detailed domain coverage and findings are retained in [review evidence](docs/audit/review-evidence.md). Tests, binary assets and the complete inventory are not mislabeled as individually read source code.

## Commercial operating limits and outstanding findings

This is a reliability/security improvement for the existing configured single-guild, single-bot-process deployment. It is not unconditional commercial certification or validation of a generic multi-tenant paid bot service.

- Cross-account economy transfers/rollback and application record/index changes still span separate writes. A process crash or multiple concurrent replicas can leave partial state. Existing process-local queues do not provide distributed transactions; retain one bot replica until these operations are redesigned and tested.
- Some caller-built whole-config replacements can overwrite concurrent unrelated settings. The repaired facade merges protect the tested paths, not every legacy caller across the repository.
- Full ticket transcripts retain full history in memory. Video conversion has existing input/output limits but no process deadline. Long-running workloads and load capacity need separate live measurements.
- Selected legacy ticket cleanup/retry maps can retain objects longer than necessary. Unreproduced collector and cache concerns are recorded in the domain evidence; they were not changed speculatively.
- Local Docker/PostgreSQL binaries were unavailable. PR CI supplies isolated real-service checks. A passing restore drill against CI data does not establish that production backups, off-site retention and recovery objectives are configured.
- Read-only Railway inspection showed Cloudy, Monitor, PostgreSQL and Redis online with no recent failed deployments. PostgreSQL still had one warning and one critical notification, whose causes are not established by this code audit. Do not treat an online service as proof that those notifications are resolved.
- Existing license attribution is preserved. This code audit does not evaluate business contracts, privacy policy, billing or regulatory requirements.

No measured 10× speedup, zero-warning claim, blanket OAuth-security claim or 100% monitoring guarantee is made. Remaining warnings and operating limits are explicit so release decisions use actual evidence.
