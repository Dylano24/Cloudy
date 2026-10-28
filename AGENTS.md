# Cloudy Codex handoff

This file is the persistent working context for every Codex session that edits this repository.

## Required workflow

- Work on `Dylano24/Cloudy` and Railway service `Cloudy` in project `sweet-kindness`.
- Before every change, fetch the current `main` HEAD and current file SHAs. Never build on an assumed or stale commit.
- Make only the smallest change explicitly requested. Do not make unrelated cleanup, visual, behavior, timing, or refactor changes.
- Preserve user changes and do not reset or overwrite a dirty worktree.
- Run focused tests, deploy through GitHub `main`, and verify Railway reports `SUCCESS` and the Discord bot reaches `ONLINE`.
- If a one-time migration is explicitly required, remove it immediately after it runs. It must never remain in startup.

## Embed preservation

- Existing embeds must never change automatically because of deploy, restart, sync, normalization, catalog refresh, template refresh, branding, or avatar sync.
- An embed may change only after an explicit user request or a manual Embed Builder Save.
- The ZORP Guide must remain intact and is protected from every automatic rewrite.
- The Embed Builder currently works. Do not alter it unless the user specifically requests an Embed Builder change.
- Preview and Discord output should retain manually saved text and spacing as closely as Discord permits.

## Embed Builder identity model

- One physical Discord embed (`guildId + channelId + messageId + embedIndex`) has exactly one registry row. Title, colour, logo or text changes never change that identity.
- A Builder post is `source: 'embed-builder'`. Only explicit Builder writes (Post, Save, exact live re-read) may change it; gateway events, history scans and catalog passes never replace or reclassify it. Builder posts carry a send nonce/footer marker and are skipped by automatic template/branding passes.
- Every committed registry write publishes its result to the in-memory Search views at once; never add a cache that is not refreshed by those commits.
- Save edits the same message ID. Repost creates a new message ID and retires the old one (one identity remains). After Post the Builder edits the posted message.
- Reappear moves the same identity to the new message (live content, registry row follows, rule remembers all former IDs). It takes the same per-message lock as Save.
- Delete removes the row, its Reappear chain and active copy permanently (persistent tombstone).
- A manual Discord deletion removes a post that was only published (`explicitSave: false`); an explicitly Saved one stays as a detached template and is never reposted automatically.
- `node scripts/embed-registry-audit.js --guild <id> [--title pop] [--verify-discord]` writes a backup and reports duplicates read-only.

## Staff/Member/AutoMod message logs

- Deletion log lines, in order: Deleted by, Type, Channel (`<#id>` only), Message ID, Message author, Message created (`<t:X:f>`), Author type (the message author's type, also for AutoMod removals).
- `deletionAttributionService` never guesses: Cloudy's own deletions are recorded at the REST call; another person's deletion must match a NEW audit `extra.count` increment for that channel and author; a self-deletion is named only after the last audit check (~0.8 s) against a startup baseline. Ambiguous bursts stay `Unknown`.
- Uncached deletions use `messageSnapshotService` (Redis, `MESSAGE_SNAPSHOT_TTL_HOURS`, default 72; removed once logged).
- These channels are styled in `logEvent` (Cloudy footer at send) and skipped by the generic branding listeners. The registry keeps only the newest automatic row per log channel and log type.

## Current non-ticket log rules

Ticket logs are excluded from all rules in this section and must remain unchanged.

- Every non-ticket log uses the Cloudy logo as its thumbnail, never a member/user avatar.
- Cloudy logo URL:
  `https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif`
- Kick and timeout logs, including AutoMod: `#FCFFA1`.
- Unban and untimeout logs, including AutoMod: `#00C49D`.
- `Invite created`: `#FFFFFF`.
- `Member joined using invite`: `#00C49D`.
- AutoMod timeouts use title `Automod timeout`.
- Actual timeout removal uses title `Untime-out log`.
- Never send visible `Member ... · Case #...` moderation embeds. Cases may remain stored internally.
- Dedicated non-ticket logs are styled in their own send paths. Generic response-catalog/template listeners must not rewrite them afterward.

## Transient replies

- Small status replies such as Success, Warning, Error, Invalid, Information, Wrong channel, Not enough, Expired, Failed, and similar acknowledgements must delete automatically after exactly 10 seconds.
- Permanent logs, normal content embeds, games, guides, panels, and ticket logs are not transient status replies.

## Default embed colors and dashboard lifetime

- Ticket logs, fixed non-ticket log rules above, manually saved Embed Builder colors, and explicitly user-selected color previews are excluded from default color normalization.
- For every other newly generated embed, green defaults normalize to `#00C49D`; any non-green default color normalizes to `#FFFFFF`.
- Interactive configuration/dashboard messages (including Ticket Dashboard, Join to Create, and Embed Builder) delete after five minutes of inactivity. Activity resets the five-minute window.

## Current verified state

- Baseline before this handoff: `61fad81ced310c2860ffa6b68d3b702f446917a7`.
- Permanent non-ticket log protection was introduced in `cfbce39701f317c44f5a3a18dbc6e91997c9be3e`.
- Moderation identity/transient reply fixes were introduced in `f82455a75fd630c4c07e8d7874d7dab59b97e1d8`.
- Railway project: `cdfc01a5-81dc-412d-bd0e-27321529ea39`.
- Railway production environment: `91a30755-f4b4-4fa0-ba92-f932168c1065`.
- Railway service: `b853c72c-bee0-4ac9-9824-573ff6a84988`.


## Cross-chat production monitor

- Cloudy has an isolated Railway service named `Cloudy Monitor`.
- It does not run inside the Discord bot process and must not be used to rewrite or mutate Cloudy bot state.
- Monitor handoff endpoint:
  `https://cloudy-monitor-production.up.railway.app/handoff`
- Monitor status endpoint:
  `https://cloudy-monitor-production.up.railway.app/status`
- Incident history endpoint:
  `https://cloudy-monitor-production.up.railway.app/incidents`
- The monitor polls Cloudy health/readiness and GitHub release-check badges every 60 seconds.
- Railway deployment failures, crashes, OOM events, monitor triggers and recoveries are also forwarded to it by a Railway project webhook, so those events can be captured immediately rather than waiting for the next poll.
- Before a new Cloudy ChatGPT chat diagnoses a production problem, read the handoff endpoint together with current GitHub `main`, Railway production state, this AGENTS.md and Linear DYL-6.
- A monitor incident is evidence to investigate, not permission to change code automatically. Root cause must still be verified from the matching commit, deployment and logs.
- Never claim 100% monitoring coverage: client-side Discord behavior, upstream Discord failures, semantic/data-correctness bugs and code paths that neither fail a monitored health check nor emit observable errors may still require explicit instrumentation.
