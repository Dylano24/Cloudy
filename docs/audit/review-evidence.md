# Detailed runtime review evidence

Reviewed on 8 October 2026 against main 1d285df8ef8ea26b21d26a5db75b477fcc87c490. These domain ledgers capture the reviewers' source-read and test snapshots. Final integrated results supersede intermediate test counts and are in CODE_QUALITY_AUDIT.md.

The Builder was initially kept unchanged under AGENTS.md. After the concrete tested proposal and specific approval question, the user said to continue and finish; its access-boundary repair is now applied. No public editor URL remains in its two public controls. Root additionally repaired welcome mutations (four dedicated tests) and adapted one existing manager test fixture to provide member permissions.

All tracked/current repository files have a separate hash/line inventory. This does not imply manual reads of every test, binary or generated artifact. Original exported/archived workspace copies are preserved.


---

# Command, handler and interaction commercial audit

Baseline: `1d285df8ef8ea26b21d26a5db75b477fcc87c490`. Owned paths: `src/commands/**`, `src/handlers/**`, `src/interactions/**`, dedicated new tests. Git fetch was attempted before edits; sandbox networking could not connect to github.com:443. Root verified the current HEAD externally. Existing baseline file SHA inventory is in `command-read-coverage.json`.

## Coverage

All 194 JavaScript files (32,119 baseline physical lines including final-newline split entries) have now received full manual source reads, in addition to complete-file ESLint parser and lexical-scope analysis. Exact file inventory, baseline SHAs, baseline line counts and reviewer attribution are tracked in `.tmp/command-read-coverage.json` (194/194 `manuallyRead: true`). Command audit read 192 files (29,299 baseline lines). The security/events reviewer fully read the protected `src/commands/Tools/embedbuilder.js` (source lines 1–1989; 1990 baseline split entries) and `src/commands/Tools/zz_embedbuilderLiveSearchPatch.js` (source lines 1–829; 830 baseline split entries), read-only. This is actual source review, not a relabeling of automated lint coverage. Every dynamic plugin/override/patch module is retained; the schema patch was also read fully. All handlers, interactions, small commands and large dashboards were covered. Temporary tool-output truncation was handled by rereading missing sections before marking the corresponding file complete.

## Implemented and reproduced fixes

- Event and help command imports now use `pathToFileURL`, preventing startup/help failures for Windows paths and names containing spaces, `#`, `%`. Fixture modules execute through real loader/help code. Both affected paths failed before correction.
- Reaction-role self assignment now rejects any single protected permission, instead of requiring the whole permission mask. Seven standalone protected-bit fixtures were wrongly assigned before correction; ordinary roles remain assignable.
- Upcoming birthday fallback retains stored birthdays on Discord network/permission failures; only a successful missing-member result or Discord `Unknown Member` confirms departure. `ECONNRESET` and permission-error regressions deleted records before correction; confirmed departure still removes its record.
- Calculator modal uses the actual Discord `ModalSubmitFields.fields` collection. A real modal class reproduced `fields.first is not a function`; the arithmetic result and context cleanup now succeed.
- Password generation reserves requested character categories and securely shuffles them using native `crypto.randomInt`. A deterministic collision fixture produced `!aaaaaaa` before correction, omitting requested uppercase and numeric characters. Excluded categories/length stay respected. Response messages/schema remain intact.
- The clear-warnings modal opens immediately without awaiting an unused user lookup. A deferred Discord lookup reproduced a blocked modal; confirmation text/custom ID remain intact.
- Hex colors accept exactly 3 or 6 digits. Four-/five-digit codes formerly reached Discord `ColorConvert` errors; now the existing invalid-input response handles them.
- Legacy ticket feedback buttons now use existing `mutateTicketFeedback`, retaining comments and serializing once-only ratings. Rejected writes formerly logged success and showed recorded confirmation. Concurrent buttons formerly made two writes. The real legacy handler now fails closed and saves/logs once. Existing success/already-submitted text and the successful log invocation/payload remain unchanged. New failure presentation matches the existing newer feedback routes.
- `/app-admin list` retains applications after transient Discord member fetch or permission errors; only confirmed `Unknown Member` (10007) removes a departed applicant. Both transient-error tests formerly deleted the actual stored application. Confirmed departure still removes it with the existing response.
- Join to Create setup preserves trigger/temporary-channel configuration when existing-channel lookup fails for network or permission reasons. Both error regressions previously removed stored trigger data and attempted duplicate channel creation. Only confirmed `Unknown Channel` (10003) permits stale-trigger cleanup; existing behavior for a successful missing result is preserved.
- Currency symbol/name saving now escapes literal values with `JSON.stringify` and callback replacements, including escaped existing literals. Real dashboard modal tests mocked only filesystem effects and reproduced invalid JavaScript for quote/backslash/newline values and `$&` replacement expansion. Modal fields, success wording and normal saved values remain the same.
- Reaction-role dashboard recovery persists a cloned canonical record before mutating the cached panel ID or deleting the legacy key. An actual public dashboard path reproduced old-record deletion after a false write; false/throw retain the original record, successful migration still removes it.
- Giveaway creation removes its orphaned posted panel and surfaces a typed database error when the initial save fails. All three reroll routes check saved results before changing messages, announcing winners or claiming success. Both manual-end save phases also check persistence before logging/claiming success. Existing giveaway deletion already checks rejected writes; a dedicated regression verifies that guard. Successful payloads and UI are preserved.

## Proven obsolete code removed

Unused imported bindings in fully read command/handler files, one discarded deposit local, unused calculator modal bindings, identical redundant error/parse branches, two unexported/unreferenced ticket helper functions (`escapeHtml`, `ensureTicketPermission`), and unused reopen-result/message construction. No dynamic command/interaction/plugin/patch files were deleted. No Embed Builder UI code, saved embeds, ZORP guide, ticket log styling, colors, response lifetime or timers were changed.

## Verification evidence

- First command regressions: 11 failing assertions before fixes; `.tmp/command-safety-red.txt`.
- Additional test-first failures: `.tmp/calculator-red.txt`, `.tmp/password-red.txt`, `.tmp/warning-modal-red.txt`, `.tmp/hexcolor-red.txt`, `.tmp/legacy-feedback-red.txt`, `.tmp/application-list-red.txt`, `.tmp/jtc-lookup-red.txt`, `.tmp/currency-config-red.txt`, `.tmp/reaction-migration-red.txt`, `.tmp/giveaway-persistence-red.txt`, `.tmp/giveaway-end-red.txt`.
- Dedicated tests now pass 39/39 across `commercialCommandSafety`, `commercialLegacyFeedback`, `commercialApplicationList`, `commercialCurrencyConfig`, `commercialJoinToCreateLookup`, `commercialReactionMigration`, and `commercialGiveawayPersistence`; `.tmp/command-final-focused.txt`, exit 0, 1.87 seconds.
- Complete `npm test` passed 697/697, exit 0, 35.6 seconds at the 17-regression snapshot; `.tmp/command-full-suite.txt`. Root will run the final combined suite after subsequent edits.
- Owned lint before cleanup: 0 errors, 320 warnings, 240 unused-variable warnings. Final focused lint including all seven dedicated test files: 0 errors, 246 warnings, 167 unused-variable warnings (74 fewer total warnings and 73 fewer unused-variable warnings). Remaining complexity/unused-argument and other warnings are retained transparently; unused arguments were not renamed merely to hide warnings.
- Dynamic loader smoke succeeded: 96 commands, 66 button handlers, 7 select-menu handlers, 15 modal handlers; `.tmp/command-runtime-imports.txt`. Every loaded command/override is preserved.
- Owned `git diff --check` passed. Combined whitespace findings in root-owned PostgreSQL edits were reported to root.

## Independent integration review

Read every changed hunk in all 60 tracked diffs outside the owned commands/handlers/interactions paths, with contextual reads around substantive changes. The exact file ledger and independently executed test command are in `.tmp/command-independent-review.json`. No actionable regression was found. Independently ran 12 focused integration regression files: 58 tests passed, 0 failed, exit 0, 3.14 seconds. Coverage included strict authoritative mutation reads, warning serialization/write failures, collection rollback and concurrency, response coordination, memory counters, shared dashboard inactivity, monitor authentication, migration TLS policy, restore argument/privacy behavior, guild template isolation and overlapping ticket deletion. Full working-tree `git diff --check` also passed. Docker config files are copied with node ownership and app/log parent paths are writable for the node user; actual Docker execution, real PostgreSQL transaction/TLS behavior, installed native Windows PostgreSQL programs and live Discord remain unverified.

## Remaining considerations

- The protected Builder review found public bearer editor links and missing requesting-member channel-access checks; evidence and recommendations are with root/security reviewer. Protected Builder source was left unchanged by this agent. This audit cannot be described as unconditional commercial-readiness approval while those findings remain unresolved.
- The application dashboard calls dashboard setup again after toggles without visibly stopping old collectors, using the same custom IDs. Duplicate handling is a source-level concern pending a concrete collector/event repro; no speculative change was made.
- Ordinary economy robbery still updates two account objects through sequential storage calls; an interrupted second write can leave inconsistent balances. Cross-process transaction/locking architecture belongs outside this owned patch and needs coordinated service-level work. Shared todo/usernotes writes likewise merit explicit same-record concurrent-action tests.
- Some legacy giveaway actions do storage/Discord work before acknowledgement. A delete may remove a Discord message before a failed database update, and reroll's new announcement ID is not subsequently persisted. Automated scheduled giveaway persistence is in services and needs coordinated follow-up. Manual-command false-success paths addressed above are covered.
- Some configured-role flows (AutoRole/AutoVerify/verification/level reward/application roles) rely on Manage Server permission plus the bot hierarchy. A role privileged above the requesting manager deserves a coordinated permission-policy review; this is recorded as a review concern, not a validated exploit claim.
- Full reads found minor legacy validation/display defects (e.g. `parseInt` accepting suffixes and stale read-only Join to Create limit-expression precedence). They were retained to avoid speculative behavior/UI changes during this authorized cleanup.
- Live Discord and Railway behavior is unverified; no commit, push or deployment was performed.


---

# Service commercial audit notes

Base: fresh main 1d285df8, audit/commercial-readiness-20261008. Ownership src/services/** + dedicated new tests. No remote fetch, commit, push, or deployment.

## Changes / evidence

- automodProtectionService: image moderation fetch lacked cancellation/deadline. Added AbortSignal.timeout(15000). Regression RED -> GREEN. Successful results/text/colors unchanged.
- ticketDeleteService: two overlapping direct delete button actions reused a stale context under the queue and both scheduled deletion. Only the first queued action can reuse provided context; next reads newly saved status. Regression RED -> GREEN. Existing ticket flows pass; delay exactly 10000ms.
- moderation/warningService: simultaneous add/remove/clear lost new warnings or restored cleared history. Per-guild/member Mutex serializes mutations. IDs remain safe numbers max(Date.now(), largest stored numeric ID+1). Strict db.get prevents overwriting history after failed reads. False setInDb now rejects instead of reporting success. Three concurrency regressions + six storage checks pass; new behavior RED -> GREEN (remove failed-read previously rejected with warning-not-found, now verifies strict option).
- moderation/moderationService: unban previously fetched every ban for one member. Fetches one current ban with force:true; only UnknownBan 10026 becomes existing not-banned message. Two regressions RED -> GREEN. Case/log/output shape preserved.
- reactionRoleService: all lookup errors became null, permanently deleting saved reaction-role data on unavailable/permission failures. Root implemented confirmed UnknownGuild 10004 / Channel 10003 / Message 10008 checks. Six tests supplied here: three false deletion RED + three confirmed deletion already GREEN; all six now GREEN.
- Safe dead code removed: verificationService setGuildConfig import; giveawayService MessageFlags; leveling.js addXp circular import + unused XP constants; JoinToCreate unused database imports; musicActions unused guildData destructure; ticket.js unused imports/local/escapeHtml; ticketUiService unused ticket-number/field/message helper tree and getPinnedMessages import. Active functions unchanged.
- Link-import hypothesis disproved: rememberMessageDeleter is imported atEOF, no production bug/change. Keep real wrong-channel/spam deletion+attribution coverage.
- Security/events agent fully read four large embed services and proved cross-guild catalog cache leak plus background registry overwriting newer manual Save. Root supplied fixes/tenant tests, strict registry read/write checks, source-catalog preservation gate, and tiny guild-id propagation. Root owns final patch verification.
- Protected Builder unused modal paths/imports retained. No UI, appearance, color/footer, or deletion-timing changes.

## Substantive remaining risks / retained behavior

- Economy debit/credit/rollback is not an atomic database transaction. commandLoader process-local locks protect current command path; multiple replicas or crash between debit/credit can lose balance consistency. Failed rollback only logs.
- ConfigService.updateSetting/bulkUpdate reads whole config before queued setGuildConfig; simultaneous unrelated updates can overwrite. commandAccess arrays/maps and logging nested settings likewise read-modify-write outside guildConfig write queue. guildConfig 5 m cache explicitly assumes one replica. Dedicated concurrency proof still needed before semantics change.
- Ticket transcripts intentionally read all history, retaining all messages/HTML/buffer. Full transcript functionality preserved; streaming requires separate validation. Legacy ticket.js deletion path remains exported; active buttons use ticketDeleteService.
- Video ffprobe/ffmpeg has no process deadline/bounded stdout/stderr. Download 40 MiB / 60 s, input 1–6 s, output 9 MiB limits exist; temp files cleaned finally. Caller passes Discord uploaded-file URL, not arbitrary text URL.
- ticketUiService rename retry ends only UnknownChannel/Message; permanent 403 can retry every 15 s indefinitely, retaining channel objects.
- ticketReliabilityService cleanup timers are untracked; an older cleanup can remove a newer map entry. Scheduled reconciliation can overlap later mutations. Existing deleted-channel checks and timings retained pending reproduction.
- Private Ticket created confirmation Map retains interaction objects until ticket deletion, including expired webhook references for long-lived tickets.
- Guild-key caches mostly evict lazily and lack guild-removal hooks. Music deleteGuildMusicData has no caller. Full-history embed discovery caches message objects and scans entire history for background/recovery; live preview remains one newest page.
- JoinToCreate update/remove awaits soft save helper without checking false (initialize checks); strict backend writes can still be swallowed by helper. No focused proof added yet.
- Active existing-message transformations retained per root direction: terms-footer sync, gambling legacy description transforms, content creator catalog-author removal, Rust encoded-text repair. Permanent ZORP spacer migration removed by events agent; source-catalog preservation gate added by root.
- Static require-atomic-updates warnings alone are not proof of races.

## Validation

- automodRequestReliability + linkProtectionReliability: 3 pass.
- ticketDeleteConcurrency + ticketReportRequestedFlow: 21 pass.
- warningConcurrency: 9 pass.
- moderationBanLookupReliability + warningConcurrency + reactionRoleReconciliationReliability: 17 pass.
- Final ticket/JoinToCreate/music/warning/unban/tests focused lint: 0 errors, 3 existing warnings (control regex + music state after await).
- git diff --check: no whitespace errors (existing .dockerignore LF/CRLF advisory).
- Imported config emits missing-token diagnostics; no Discord connection. Initial ticket fixture allowed db.initialize accidentally, corrected before RED proof.
- Final combined focused test/lint results will be appended.

## Complete line reads

All 100 files read 1–EOF: 96 personally + four delegated. Current inventory 28,229 lines; personally reviewed files 22,625 lines. Ranges reference current worktree after dead-code deletion; earlier complete source and applicable small diffs were read. No head-only read counted.

### Personally read
- src/services/aiSafety.js:1-113
- src/services/appealActionService.js:1-147
- src/services/appealIdentityService.js:1-23
- src/services/appealPresentationService.js:1-15
- src/services/applicationService.js:1-467
- src/services/automodProtectionService.js:1-279
- src/services/balanceResponseIdentity.js:1-45
- src/services/birthdayService.js:1-359
- src/services/builderRuntimePreviewService.js:1-90
- src/services/cloudyBrandingService.js:1-123
- src/services/cloudyChannelResolver.js:1-145
- src/services/cloudyLogoService.js:1-129
- src/services/cloudyPublicKnowledgeService.js:1-317
- src/services/commandAccessService.js:1-329
- src/services/config/configService.js:1-625
- src/services/config/guildConfig.js:1-210
- src/services/contentCreatorGuideService.js:1-74
- src/services/countingGameService.js:1-350
- src/services/dedicatedChannelPolicy.js:1-41
- src/services/dedicatedChannelService.js:1-238
- src/services/deletedMessageMediaService.js:1-38
- src/services/deletionAttributionService.js:1-43
- src/services/discordGifSearchService.js:1-189
- src/services/economyService.js:1-463
- src/services/embedBuilderButtonEditorService.js:1-809
- src/services/embedColorPickerSessionService.js:1-368
- src/services/embedDefinitionDiscoveryService.js:1-631
- src/services/embedMissingChannelService.js:1-225
- src/services/embedReappearService.js:1-132
- src/services/existingEmbedPolicy.js:1-3
- src/services/explicitAiProvider.js:1-91
- src/services/explicitAiService.js:1-300
- src/services/faqAiService.js:1-130
- src/services/giveawayService.js:1-437
- src/services/inviteTrackingService.js:1-360
- src/services/joinToCreateService.js:1-564
- src/services/leveling/leveling.js:1-464
- src/services/leveling/levelRoleSyncService.js:1-110
- src/services/leveling/xpSystem.js:1-154
- src/services/levelingCommandRuntimeService.js:1-60
- src/services/linkProtectionService.js:1-360
- src/services/loggingService.js:1-645
- src/services/messageLogDestination.js:1-27
- src/services/moderation/moderationService.js:1-460
- src/services/moderation/warningService.js:1-144
- src/services/moderationLogPresentation.js:1-20
- src/services/music/musicActions.js:1-534
- src/services/music/musicEmbeds.js:1-173
- src/services/music/musicVoiceState.js:1-51
- src/services/music/permissions.js:1-14
- src/services/music/playerHandler.js:1-269
- src/services/music/playerStore.js:1-46
- src/services/music/prefixSupport.js:1-10
- src/services/music/riffySetup.js:1-56
- src/services/ownerAssistantProvider.js:1-2
- src/services/ownerAssistantService.js:1-19
- src/services/ownerRoleAccess.js:1-11
- src/services/panelHealthService.js:1-167
- src/services/profileAvatarSyncService.js:1-272
- src/services/protectedIdentityService.js:1-201
- src/services/reactionRoleService.js:1-562
- src/services/recentAuditLogService.js:1-35
- src/services/reportActionService.js:1-394
- src/services/reportCaseLifecycleService.js:1-631
- src/services/reportCaseService.js:1-82
- src/services/rustPatchNotesService.js:1-271
- src/services/serverstatsService.js:1-300
- src/services/staffReviewsService.js:1-281
- src/services/stickyGuideService.js:1-160
- src/services/storeTermsMessageService.js:1-120
- src/services/termsIconService.js:1-38
- src/services/termsMessageService.js:1-117
- src/services/termsWebsiteFooterService.js:1-21
- src/services/ticket.js:1-1035
- src/services/ticketActionPolicy.js:1-21
- src/services/ticketChannelBrowserService.js:1-191
- src/services/ticketClosedAccessService.js:1-67
- src/services/ticketControlLayoutService.js:1-64
- src/services/ticketCreationConfirmationService.js:1-219
- src/services/ticketDashboardRecoveryService.js:1-225
- src/services/ticketDashboardService.js:1-628
- src/services/ticketDashboardViewService.js:1-53
- src/services/ticketDeleteService.js:1-191
- src/services/ticketDestinationAutoConfig.js:1-63
- src/services/ticketFeedbackService.js:1-101
- src/services/ticketHealthService.js:1-328
- src/services/ticketPanelBuilder.js:1-58
- src/services/ticketPanelPresentation.js:1-85
- src/services/ticketReliabilityService.js:1-956
- src/services/ticketStatusBrandingService.js:1-63
- src/services/ticketTranscriptService.js:1-240
- src/services/ticketUiService.js:1-654
- src/services/ticketV2LayoutService.js:1-198
- src/services/verificationService.js:1-686
- src/services/videoGifService.js:1-114
- src/services/zorpGuideService.js:1-202

### Delegated full reads (security/events agent, before subsequent root fixes)
- src/services/embedManagerService.js:1-2325
- src/services/embedRegistryService.js:1-1069
- src/services/systemEmbedCatalogService.js:1-1623
- src/services/embedTemplateService.js:1-554



## Final focused verification

- Combined suite: 70 tests passed, zero failed, including all six new service regression files plus ticket latency/lifetime/status/template flows, JoinToCreate dashboard, and embed tenant isolation.
- Complete src/services plus six new tests ESLint: 106 files checked, zero errors, 64 warnings. Baseline services had 81 warnings; remaining unused symbols belong to protected Builder files and were retained.
- Captured outputs: .tmp/service-final-tests.log and .tmp/service-final-lint.json.
- normalizeCloudyLogoMessage early returns at line 117 while PRESERVE_EXISTING_EMBEDS=true; version-4 startup history scan cannot mutate existing embeds, but still incurs fetch cost if migration marker is absent.

### Dedicated tests fully read/written

- test/automodRequestReliability.test.js:1-31
- test/linkProtectionReliability.test.js:1-62
- test/ticketDeleteConcurrency.test.js:1-43
- test/warningConcurrency.test.js:1-77
- test/moderationBanLookupReliability.test.js:1-42
- test/reactionRoleReconciliationReliability.test.js:1-46

Full-suite run one overlapped commands agent's newly added JoinToCreate RED tests: 757 total, 755 passed, two expected in-progress failures. Fix was subsequently reported ready and final suite rerun.
Final npm test rerun: 757 tests passed, zero failed (33.5s); captured .tmp/service-full-tests.log.


---

# Events, web and monitor audit

Baseline: `1d285df8`, branch `audit/commercial-readiness-20261008`, 2026-10-08. This is a scoped offline code/runtime audit within the general commercial cleanup, not a formal Codex Security scan. Read AGENTS.md and SECURITY.md fully. All 93 tracked baseline files under `src/events/`, `src/web/`, and `monitor/` were inspected in full, including the protected Builder code read-only. No production mutation, remote scan, Discord login, deployment, commit or push occurred. Stubbed monitor network requests and exercised only local loopback ingress.

## Fixed and verified

1. `monitor/index.js`: public POST `/railway-webhook` accepted forged deployment crashes and persisted attacker-controlled incident/handoff evidence. Required `MONITOR_WEBHOOK_TOKEN` now gates writes before reading/parsing the body. Constant-time comparison accepts `Authorization: Bearer ...` or `?token=...` for Railway webhook URL configuration. Missing configuration returns 503; incorrect/missing credentials return 403. Existing public GET endpoints and 60-second poll timing are unchanged. **Do not deploy this monitor patch before configuring the same secret in the monitor environment and Railway webhook URL/header; deploying unconfigured would disable webhook delivery.** No secret appears in state/error output. This is a concrete fail-closed patch with a coordinated rollout prerequisite, not a fail-open optional control.
2. `monitor/index.js`: interpolating untrusted Host into `new URL` caused a rejected async HTTP handler and monitor termination for `Host: [`. Routing now uses a constant local base and returns 400 for an invalid request target. The real monitor survives the malicious Host and serves subsequent health requests.
3. `src/events/guildMemberRemove.js`: a missing goodbye send/view permission returned from the entire event before leave logging, counters, birthday backup, application removal and leveling removal. The permission gate now skips only goodbye delivery; data cleanup proceeds. Authorized goodbye payloads are unchanged.
4. `src/events/messageCreate.js`: message diagnostics persisted complete private channel message bodies, and prefix diagnostics persisted argument values. Both now omit bodies/arguments while retaining safe event/command names, message/guild/channel/user IDs and available trace IDs. Discord output and command execution are unchanged.
5. Removed `src/events/zorpSpacerAlignOnceReady.js`: this unguarded completed one-time migration rewrote manually saved protected ZORP Guide fields and application emoji state on every startup. Regression reproduced a manually saved field being overwritten with fixed migration text. Deletion preserves the current deployed Guide exactly.
6. Removed `src/events/cloudyReadonlyInventoryReady.js`: explicitly temporary inventory hook stopped doing work after 2026-09-29T18:00Z, but still loaded the script at startup. The deadline is hardpassed and the handler has no persistent consumers. Manually invoked inventory script is retained.
7. Removed proven unused locals/imports in monitor, interactionCreate, responseCatalogChannelReady, securityInformationReady, staffReviewsInteraction, staffReviewsReady and staffTeamReady. Renamed two unused voice lifecycle arguments; function arity/callers are unchanged. Protected Builder implementation and its timers were not edited.

## Validation evidence

- `test/monitorRequestSecurity.test.js`: RED 3 failures (unauthorized 200, unconfigured 200, malformed Host connection failure); GREEN 4 checks including valid header/query delivery and no secret in persisted public state.
- `test/memberLeaveCleanupReliability.test.js`: RED denied send permission skipped birthday backup; GREEN 2 checks for denied and permitted delivery paths using real storage helpers.
- `test/eventDiagnosticsPrivacy.test.js`: RED 2 checks exposed private body/argument; GREEN 2 checks retain useful metadata/command name without those values.
- `test/startupMigrationPreservation.test.js`: RED protected manually saved field overwritten and expired hook discovered; GREEN 2 checks after deleting obsolete hooks. Test uses actual old migration when present, with a Discord-shaped local message and no external service calls.
- Combined focused tests: 10 passed / 10, zero failures.
- Full current combined-worktree `npm test`: 704 passed / 704, zero failed/cancelled/skipped, about 40.8 seconds. Output saved in `.tmp/security-events-full-suite.log`. Existing offline import configuration diagnostics (missing token in other files) remain visible in the suite; no live token was required.
- Scoped ESLint (`src/events src/web monitor` plus four new tests): zero errors, 21 warnings. No unused imports in new tests. Protected legacy Builder helpers retain existing warnings intentionally.
- Owned `git diff --check`: clean. Combined worktree check initially found trailing whitespace in another agent's PostgreSQL edits; reported to root rather than modifying someone else's file.

## Boundary observations and remaining commercial limitations

- Appeals API is intentionally public. `x-cloudy-source` is a public marker, not authentication. The endpoint's independent limiter covers sends even though app.js mounts it before the generic limiter: 3 submissions per email/hour, global 30/minute, at most 2,000 tracked keys, expired-key sweeping. Body size is separately bounded by app.js at 32KB. Fields and email are checked, sends have `allowedMentions: { parse: [] }`, and persisted review keys include destination guild. Delivery+review persistence are not transactional: a persistence failure after Discord send can leave an orphan appeal message and retried submissions may duplicate it. No request-controlled channel/guild destination is accepted.
- Web editor uses 32-byte random bearer session tokens, exact browser document identity, bounded field values and fixed leases. No browser token/lease/timer semantics changed. All displayed user field text is inserted with text nodes/input values; dynamic innerHTML contains only internally generated numeric indexes. Emoji image URLs have fixed Discord CDN origin and server-sanitized numeric IDs. This protects against straightforward HTML/JS injection; bearer link sharing remains a trust boundary and no authenticated identity recheck occurs in the HTTP session handler. Root/service owner should assess rollout/authorization policy before changes.
- Monitor fetch destinations come from privileged environment or fixed GitHub URLs, not HTTP input. No user-controlled SSRF path was found in monitor ingress. Public GET handoff/status intentionally disclose bot health, deployment/service identifiers and incident evidence; access/privacy policy remains a product decision. Monitor JSON state writes share one `.tmp` filename and swallow save errors; simultaneous authenticated events/poll writes can race. External responses are timeout-bound but not byte-bound. Deployment-secret coordination remains mandatory.
- `cloudySelfReadPermissionsReady.js` automatically grants bot ViewChannel/ReadMessageHistory in all target-guild text channels when ManageRoles permits it, potentially overriding deliberate denial. Kept read-only because it is an existing protected Builder helper and user requested identical behavior. Commercial isolation/privacy policy needs explicit treatment.
- `voiceStateUpdate.js` ownership transfer changes DB owner/name, but does not revoke original member overwrite or grant replacement owner overwrite. Original creator retains MoveMembers/PrioritySpeaker after ownership transfer. Documented for policy review; changing native Discord grants requires evidence about intended permissions.
- `staffReviewsInteraction.js` selectedOwners map expires only when the same user returns, so stale abandoned selections can accumulate over process lifetime. No new timer or different expiry was introduced. Search sessions in Builder sweep on activity; several global bootstrap history scans are bounded by persisted version, so fresh storage/new guilds may incur broad history reads. Commercial multiple-guild operation should use explicit onboarding and bounded caches.
- Fast ticket dashboard validates ManageChannels but renders before general maintenance/category/command-enable/cooldown policy and sets a flag that makes ticket.execute return. This does not bypass the dashboard ManageChannels gate; policy consistency remains an existing behavior decision.
- Read-only cross-boundary checks inspected permissionGuard, interactionValidator, aiSafety, ownerRoleAccess, cloudyChannelResolver, reportCasePrivacy, guild config/storage key helpers, deleted media transfer, representative say/dm/shorten commands and relevant event-called database helpers. Guild-scoped config/storage and AI forced membership/channel authorization are present. Deleted media transfer restricts HTTPS Discord CDN hosts, disallows redirects, and enforces bytes/timeout. No arbitrary request-input SQL or shell execution found in inspected event/web/monitor paths.

## Complete baseline coverage

Each entry below denotes a full physical line 1–end source read at baseline, including blank lines. Removed obsolete files retain baseline coverage.

- `monitor/index.js`: 1-552.
- `monitor/package.json`: 1-8.
- `src/events/000TicketDashboardFastPath.js`: 1-111.
- `src/events/antiAbuseMessageCreate.js`: 1-16.
- `src/events/antiRaidGuildMemberAdd.js`: 1-16.
- `src/events/appealActionsReady.js`: 1-3.
- `src/events/appealFormReady.js`: 1-11.
- `src/events/channelDelete.js`: 1-109.
- `src/events/cleanupLegacyWelcomeAttachments.js`: 1-73.
- `src/events/cloudyBrandingMessageCreate.js`: 1-81.
- `src/events/cloudyBrandingMessageUpdate.js`: 1-76.
- `src/events/cloudyBrandingReady.js`: 1-149.
- `src/events/cloudyFixGuideInteraction.js`: 1-173.
- `src/events/cloudyLogoMigrationReady.js`: 1-110.
- `src/events/cloudyOwnerAssistantMessageCreate.js`: 1-124.
- `src/events/cloudyOwnerAssistantReady.js`: 1-88.
- `src/events/cloudyReadonlyInventoryReady.js`: 1-14.
- `src/events/cloudySelfReadPermissionsReady.js`: 1-100.
- `src/events/contentCreatorGuidesMessageCreate.js`: 1-4.
- `src/events/contentCreatorGuidesReady.js`: 1-4.
- `src/events/cooldownCleanupReady.js`: 1-15.
- `src/events/dedicatedChannelsMessageCreate.js`: 1-14.
- `src/events/dedicatedChannelsReady.js`: 1-22.
- `src/events/embedBuilderChannelTitleSync.js`: 1-25.
- `src/events/embedBuilderFullHistoryIndexReady.js`: 1-39.
- `src/events/embedBuilderMarkedHistoryRecoveryReady.js`: 1-91.
- `src/events/embedBuilderOrphanCleanupReady.js`: 1-121.
- `src/events/embedBuilderStableUiReady.js`: 1-101.
- `src/events/embedBuilderTargetGuildRecoveryReady.js`: 1-89.
- `src/events/embedManagerSearchControlReady.js`: 1-9.
- `src/events/embedManagerTitleSearchReady.js`: 1-599.
- `src/events/faqAiInteraction.js`: 1-272.
- `src/events/faqAiReady.js`: 1-26.
- `src/events/fullResponseCatalogReady.js`: 1-615.
- `src/events/gamingCatalogDiagnosticReady.js`: 1-141.
- `src/events/giveawayBrandingReady.js`: 1-57.
- `src/events/guildBanAdd.js`: 1-49.
- `src/events/guildBanRemove.js`: 1-40.
- `src/events/guildCreate.js`: 1-29.
- `src/events/guildMemberAdd.js`: 1-343.
- `src/events/guildMemberRemove.js`: 1-184.
- `src/events/guildMemberUpdate.js`: 1-131.
- `src/events/interactionCreate.js`: 1-494.
- `src/events/inviteCreate.js`: 1-16.
- `src/events/inviteDelete.js`: 1-16.
- `src/events/joinToCreateDashboardNameSync.js`: 1-79.
- `src/events/messageCreate.js`: 1-427.
- `src/events/messageDelete.js`: 1-122.
- `src/events/messageDeleteBulk.js`: 1-30.
- `src/events/messageLogsReady.js`: 1-24.
- `src/events/messageUpdate.js`: 1-63.
- `src/events/nitradoPatchNotesReady.js`: 1-403.
- `src/events/plainResponseCaptureReady.js`: 1-38.
- `src/events/profileAvatarGuildMemberUpdate.js`: 1-11.
- `src/events/profileAvatarUserUpdate.js`: 1-11.
- `src/events/ready.js`: 1-150.
- `src/events/reportCasesReady.js`: 1-3.
- `src/events/responseCatalogChannelReady.js`: 1-53.
- `src/events/roleCreate.js`: 1-31.
- `src/events/roleDelete.js`: 1-31.
- `src/events/securityInformationReady.js`: 1-67.
- `src/events/staffReviewsInteraction.js`: 1-290.
- `src/events/staffReviewsReady.js`: 1-106.
- `src/events/staffTeamReady.js`: 1-81.
- `src/events/systemEmbedCaptureReady.js`: 1-39.
- `src/events/systemEmbedCatalogMessageUpdate.js`: 1-19.
- `src/events/systemEmbedCatalogReady.js`: 1-30.
- `src/events/ticketChannelState.js`: 1-32.
- `src/events/ticketControlLayoutCreate.js`: 1-9.
- `src/events/ticketControlLayoutUpdate.js`: 1-13.
- `src/events/ticketDashboardSelectReady.js`: 1-19.
- `src/events/ticketDestinationReady.js`: 1-21.
- `src/events/ticketLegacyLogoCleanup.js`: 1-89.
- `src/events/ticketLogFooterEnforcer.js`: 1-45.
- `src/events/ticketMainMessageCleanup.js`: 1-57.
- `src/events/ticketMessageState.js`: 1-44.
- `src/events/ticketPanelCreate.js`: 1-17.
- `src/events/ticketPanelReady.js`: 1-14.
- `src/events/ticketPanelRecovery.js`: 1-36.
- `src/events/ticketPanelUpdate.js`: 1-23.
- `src/events/ticketStatusMessageCreate.js`: 1-11.
- `src/events/ticketStatusMessageUpdate.js`: 1-11.
- `src/events/ticketSystemReadyRecovery.js`: 1-165.
- `src/events/ticketV2LayoutInteraction.js`: 1-24.
- `src/events/ticketV2LayoutMessageCreate.js`: 1-15.
- `src/events/ticketV2LayoutReady.js`: 1-25.
- `src/events/userUpdate.js`: 1-99.
- `src/events/voiceStateUpdate.js`: 1-347.
- `src/events/zorpGuideReady.js`: 1-11.
- `src/events/zorpSpacerAlignOnceReady.js`: 1-105.
- `src/web/appealRateLimit.js`: 1-17.
- `src/web/appealsApi.js`: 1-118.
- `src/web/embedColorPickerPage.js`: 1-966.

## Full read-only embed-service cross-review

Completed full reads of baseline service content: `src/services/embedManagerService.js` 1-2325, `src/services/embedRegistryService.js` 1-1069, `src/services/systemEmbedCatalogService.js` 1-1623, `src/services/embedTemplateService.js` 1-554. These files were read-only for this agent; root/service owners perform any changes.

Two actionable issues were reproduced entirely offline in `.tmp/embed-service-boundary-proof.mjs` using cloned Map storage and fake Discord objects:

- System catalog cache/pending capture identities omitted guild (baseline catalog lines 26-32, 485-486, 546-558, 654-695, 1317-1326, 1420-1446, 1581-1593, 1606-1620). Priming a Guild A template changed Guild B notice title/footer and ticket body. Captured runtime entries could also be flushed into every guild catalog. Reported to root and service owner; root added guild-scoped cache/capture identities and relevant production caller guild IDs, plus `test/embedTenantIsolation.test.js`. Independently reviewed those changes and ran the new proof tests successfully. The original proof file preserves discovery evidence; its three-argument prime call intentionally reflects the baseline API and does not demonstrate current production leakage (production now supplies guild IDs).
- Registry reconciliation fetched Discord snapshots outside its queue then replaced newer manually saved data (baseline registry lines 946-975). Paused old fetch, persisted a new manual Save (true), resumed fetch, final saved snapshot reverted to old title/body. Reported to root; root checks per-message content freshness before replacement, defers cache updates until successful storage, and rejects persistence failure. Independently verified the new race regression test.

Root also closed the catalog source-sync preservation gap: baseline `syncSourceDefinitionEntries` updated existing catalog records without `PRESERVE_EXISTING_EMBEDS`, unlike append/cleanup. The current path now warms existing templates without modifying their saved Discord payloads.

Other read-only lifecycle observations: manager collectors are bound to initiating user and inactivity; matching template update jobs are scoped by guild/channel/template and coalesce pending work. Registry DB keys/queues and saved template decorations include guild IDs; registry snapshot cache is bounded at 2,000 but template/decorations/canonical history maps have no general eviction. Manager selection uses local guild registry and guild channels, but save helpers rely on trusted state and do not independently validate `target.guildId` or cachedMessage guild ownership. No user-controlled path to forge that state was demonstrated. Per-channel saved decoration overrides are intentionally merged with guild-wide templates; protected Builder UI, parser migrations, aliases and timers were left unchanged by this agent. Completed one-time content migrations still exist in several preserved helper paths and should be retired only with deployment-state evidence.

## Independent review of root's combined fixes

Read-only current patch review focused on PostgreSQL strict reads/transaction lifecycle and wrapper forwarding, birthday/giveaway/warning/moderation collection changes and failure semantics, memory counters, responseCoordinator serialized first response/recovery, catalog guild resolution and all relevant production callers, source-sync preservation and registry freshness. No actionable regression found in the inspected changes.

Fresh command: `node --test test/postgresCollectionsAtomicity.test.js test/strictStorageReads.test.js test/collectionMutationReliability.test.js test/coreConcurrencyReliability.test.js test/embedTenantIsolation.test.js`: 30/30 pass, 0 failed/cancelled/skipped, about 1.2 seconds; `.tmp/independent-root-review-tests.log`. Combined `git diff --check`: exit 0 (CRLF normalization warning for .dockerignore only). Root separately reported full suite 743/743; this agent's earlier 704/704 full-suite record above is a point-in-time combined-worktree result, not the final suite size.

Review limits: no live PostgreSQL connection or transaction isolation testing, actual Railway webhook token/header provisioning, Discord REST verification or deployed guild state inspection. PostgreSQL tests simulate transaction success/rollback with a fake pool. Mutex/queues provide single-process ordering; they do not prove cross-replica collection safety. Other agents own review of unrelated command/service changed hunks. Monitor credential coordination remains a deployment prerequisite.

## Protected Builder full review and unapplied access proposal

Completed read-only manual reads: `src/commands/Tools/embedbuilder.js` 1-1989; `src/commands/Tools/zz_embedbuilderLiveSearchPatch.js` 1-829; `src/commands/Tools/00_embedbuilderSearchSchemaPatch.js` 1-34. Parent and command owner received exact coverage attribution. Read production permission/autocomplete dispatch and target-selection/post paths to validate that guild ManageMessages + bot target permissions do not enforce invoking-member channel access.

Two evidenced commercial blockers remain pending specific protected-Builder approval: public dashboard Link buttons disclose the editor session bearer token to all channel readers; Search/Modify/Save/Post act on bot-readable targets without invoking-member ViewChannel/SendMessages checks. Parent requested a concrete unapplied repair artifact at `docs/audit/embed-builder-access-boundary.patch`. Prepared with only isolated copied-source modifications and proposed tests under `.tmp/builder-access-proposal`; actual protected files and active tests remain unchanged. Patch check succeeds.

Proposal preserves public bot-managed preview/dashboard, their five-row labels/order/emojis, saved/published embed formatting, and existing timers. Only two editor launch controls become owner-gated component buttons; owner receives an ephemeral Link button. Adds native member channel permission checks across search/select/Modify/Save/Post, including backing/preview/source scopes. This introduces one private launch click and intentionally hides inaccessible/deleted-channel records; backing botlog access restrictions require explicit approval too. Full details/evidence in `.tmp/builder-access-proposal/REVIEW.md`.

Offline RED expanded proof: seven behavior tests fail against unchanged sources, shared-helper-only test passes. Copied repair: 8/8 new and 152/152 related tests pass. Proposed-file ESLint: 0 errors/59 warnings. No network, deployment, production calls, commit or push. `git apply --check --whitespace=error` succeeds; protected source working-tree diff empty. These isolated results do not claim a full repository suite or real Discord client verification of the unapplied artifact.


---

# Delegated root utility/script audit

Worktree: C:\Users\dylan\Projects\Cloudy\work\commercial-audit
Branch: audit/commercial-readiness-20261008. Audit date: 2026-10-08.
Scope: root delegated fourteen full manual reads to service_audit. No live Discord/database requests, remote fetch, commit, push, or deployment occurred. The standalone inventory and restore scripts were read, never executed.

## Complete manual coverage

Every listed file was read from line 1 through EOF, not just searched or sampled. database.js was read in contiguous chunks (1–410, 411–810, 811–1194 at first review); all subsequently changed sections were reviewed again. Current line counts below include the approved facade changes and prior root changes. Total: 14 files, 3,685 current lines.

| File | Fully reviewed lines |
| --- | --- |
| src/utils/database.js | 1–1199 |
| src/utils/errorHandler.js | 1–545 |
| src/utils/interactionMessageLifecycle.js | 1–296 |
| src/utils/builderSessionCleanup.js | 1–362 |
| src/utils/transientResponse.js | 1–91 |
| src/utils/ticket/ticketPermissions.js | 1–216 |
| src/utils/ticket/ticketLogging.js | 1–166 |
| src/utils/ticket/ticketLogTemplates.js | 1–71 |
| src/utils/logging/logEmbeds.js | 1–244 |
| src/utils/welcome.js | 1–73 |
| src/utils/constants.js | 1–97 |
| scripts/audit-interaction-latency.js | 1–31 |
| scripts/cloudy-readonly-inventory.mjs | 1–118 |
| scripts/restore-cloudy-server-once.js | 1–176 |

## Approved fixes and evidence

Only database.js was changed in this delegated task, following root approval of reproduced data-loss paths. Earlier birthday strict reads/serialization, unused imports, and dead generateCaseId removal in its diff belong to root's separate review.

- Application cleanup (database.js:744) formerly continued with default 14-day reviewed retention when the settings read failed. An offline fixture with a 60-day-old approved record proved cleanup deleted it despite being unable to read its configured retention. getApplicationSettings now accepts an optional strict read flag; cleanup uses it, so failed settings reads stop cleanup.
- saveApplicationSettings (database.js:790) formerly overwrote defaults plus the submitted patch after failed reads, ignored false writes, and lost independent concurrent patches. It now uses a strict authoritative read, serializes merges by the existing per-key Mutex, and returns false for rejected persistence. The defaults used by ordinary public reads are retained.
- Join to Create facade saves (database.js:1057) formerly merged defaults after failed reads and reported success for false writes. getJoinToCreateConfig now has the same optional strict flag. Save and direct facade mutations use strict reads; save checks persistence, and updateJoinToCreateConfig rejects failed saves. Trigger add/remove and temporary-channel register/unregister stop on failed first reads. Existing display/default reads remain soft.

New test: test/facadeStrictMutationReads.test.js, eight behavioral regressions. RED: 8 tests, 1 pass, 7 fail before production edits (.tmp/facade-strict-red.log). GREEN: 25/25 when combined with collectionMutationReliability, commercialApplicationList, commercialJoinToCreateLookup, and joinToCreateDashboard (.tmp/facade-strict-green.log). Focused ESLint on database.js and the new test exited 0. git diff --check reported no whitespace errors.

## Remaining substantive risks; no unapproved changes

- Application record/index consistency (database.js:719, 855): createApplication writes the record before reading and replacing the user's application-ID array; deleteApplication deletes the record before reading and replacing that array. Soft read failures can discard existing index IDs, concurrent updates can lose references, and false write/delete results are ignored. These are active paths used by applicationService, app dashboard/admin, and guildMemberRemove. Fixing them requires a coordinated record/index transaction or durable mutation design; the narrow approved retention/settings fixes do not claim to resolve this.
- Welcome config mutation (database.js:390–436): active welcome/goodbye/autorole commands and greet_dashboard read via a soft fallback and merge/replace persisted config. A failed read can substitute defaults, false saves are ignored by updateWelcomeConfig, and stale whole-config saves can overwrite concurrent unrelated changes. No public presentation or workflow was changed.
- Legacy leveling and moderation-audit facade helpers (database.js:83–104, 438–536) still use soft reads before writes and ignore false writes. Caller searches found no active external callers of the facade leveling mutations during this review; this is a helper-level risk rather than an asserted current production exploit.
- Application reads perform cleanup (database.js:898, 932, 959). getUserApplications cleans once and invokes getApplication for every ID, which cleans again; larger histories cause repeated full-guild scans and deletion work within a nominal read operation. Cleanup behavior and retention timing were preserved.
- JTC writes remain whole-config replacements and process-local coordination is limited. Strict read failure protection does not provide cross-process atomic updates or prevent concurrent callers from constructing stale full config objects. joinToCreateService still has update/remove paths that ignore facade false save results; this was also recorded in the service ledger.
- Logging embed helper (logging/logEmbeds.js:129–174) caps individual fields but not aggregate field count/combined text, and does not cap description. Oversized caller input can exceed Discord embed limits and lose an audit send; no specific active over-limit fixture was reproduced, so no layout/truncation change was made.
- Ticket permissions use bounded pinned/recent discovery and the existing read-failure gate to avoid recovering over unread authoritative ticket state. Guild-config fallback can still select named default staff roles when configuration cannot be read. Recovery saves are asynchronous and can fail; the existing logging reports this. Permission policy and saved ticket content were preserved.
- restore-cloudy-server-once.js is a manual mutating CLI with a hardcoded guild fallback and named channel layout. It creates missing categories/channels and reparents existing channels matched by normalized name (lines 105–143); repeated execution can move later manual organization, or select an unintended same-name channel. RESTORE_KEY is written after mutations (line 147) but is never read as a completion guard. No repository startup/package caller was found. Do not execute as an audit/inventory command; retained as existing manual functionality.
- cloudy-readonly-inventory.mjs has a clear read-only boundary: Discord GET requests only, bounded retries and request timeouts, bounded audit-log paging, PostgreSQL REPEATABLE READ READ ONLY with statement/connection timeouts, and sensitive-key exclusions in emitted references. It was not run.

## Preservation checks

- All transient/error/dashboard durations were retained, including the existing 10-second error/transient timing and Builder session lifetime.
- interactionMessageLifecycle and builderSessionCleanup were fully reviewed, including persistent-message/Builder guards, timer disposal, interaction reply identity checks, and token/session cleanup. No new evidenced substantial failure warranted edits.
- Ticket log templates, fixed colors/footers, welcome text, constants, public layouts, saved embeds, and permanent guide content were unchanged.
- audit-interaction-latency.js is a local source inspection CLI; no runtime side effects or commercial-boundary issue was found in its complete read.

Full suite after facade edits: npm test exited 0; 780/780 tests passed, no failures/skips, in 29.5 seconds (.tmp/facade-full-tests.log). This includes other agents' concurrent completed fixes. Focused lint and git diff --check remained clean.
