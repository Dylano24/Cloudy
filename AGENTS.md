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
- Reappear counts member messages (text or media) and Cloudy Feed photo/video posts (sent with a `cfeed` nonce, `isCloudyFeedPost`). Other Cloudy or bot messages, including Reappear's own moved copy, never count.
- Delete removes the row, its Reappear chain and active copy permanently (persistent tombstone).
- A manual Discord deletion removes a post that was only published (`explicitSave: false`); an explicitly Saved one stays as a detached template and is never reposted automatically.
- `node scripts/embed-registry-audit.js --guild <id> [--title pop] [--verify-discord]` writes a backup and reports duplicates read-only.
- In a server the Builder (preview and controls) is a normal message in the channel: the `/embedbuilder` command's own reply and follow-up, not private (owner's choice, `builderBotManaged`). Discord never hides it and Cloudy edits and removes it as a normal message at any time (no 15-minute limit). Everyone in the channel sees it (also an embed opened via Search); only its owner can use its controls: anyone else's click gets a 10-second private notice (`isForeignBuilderClick`). "Edit title and message" and "Set side color" open the editor directly as link buttons, as before (owner's choice: no private link message, even though the link is visible in the channel). Helpers (channel picker, Modify embed, notices) stay private. Builder UI is recognised from its first gateway event by the command's interaction id (`registerBuilderInteraction`, `isBuilderUiMessage`) and is never restyled by branding/templates, never a Search item, never a 10-second status and never logged when removed; after a restart the startup sweep removes leftover controls and the preview above them. Outside a server the Builder stays private as before.
- Discord itself removes private (ephemeral) messages from the screen after a while or when the app reloads (e.g. during a long editor session); Cloudy still holds the Builder. While Cloudy still holds the Builder and nothing was Posted/Saved from it yet, or while the editor page is open or up to 5 minutes after leaving it, `/embedbuilder` without Search brings back the SAME Builder in new messages: same draft, picture and settings, the editor link stays connected (`wasEmbedEditorRecentlyUsed`, old collector ends with reason `resumed`, which keeps the draft and editor). Otherwise, and with Search, it opens a new Builder as before.
- The Builder preview lives exactly as long as its control panel (`linkBuilderSessionPreview`): activity on the panel keeps the preview alive; it has no buttons of its own.
- Add media starts the banner's permanent copy at once (`prefetchDiscordEmbedMedia`); Post/Save reuse that same copy (one download per upload link). Pictures Cloudy cannot store as-is are converted first: iPhone HEIC/HEIF to JPG with `heic-convert` in a worker thread, other formats (AVIF, BMP, TIFF, ...) to PNG with local ffmpeg (`embedMediaImageConvert.js`).
- After Post/Save of a newly uploaded banner the private preview keeps showing Discord's own upload link (`builderPreviewBanner.js`), so it appears at once; the posted message always uses Cloudy's permanent media link.
- Every Builder form (title/message, footer, picture, add link, edit button) gets a unique custom id per opening, so a form that was closed and opened again never answers one submit twice.

## Staff/Member/AutoMod message logs

- Deletion log lines, in this order (owner's choice): Deleted by, Type, Channel (`<#id>` only), Message ID, Message author, Message created (`<t:X:f>`, always last). `Type` is the type of the one who DELETED it: Staff, Bot (Cloudy/AutoMod/other bots) or Member (only a member deleting their own message); `Unknown` when the deleter cannot be verified. There is no "Author type" line and no action-type line. Attachment names go in the Message block; the first photo is the embed image; videos are NOT uploaded to Discord: `deletedMediaService` stores them on the media volume (`CLOUDY_EMBED_MEDIA_DIR/deleted-media`, unguessable token, `DELETED_MEDIA_RETENTION_DAYS` default 30) and the log's `Video` field links to `/deleted-media/<token>`, a noindex page that plays it. Without the volume the video stays attached to the log.
- `deletionAttributionService` never guesses: Cloudy's own deletions are recorded at the REST call; another person's deletion must match a NEW audit `extra.count` increment for that channel and author; a self-deletion is named only after the last audit check (~0.8 s) against a startup baseline. Ambiguous bursts stay `Unknown`.
- Cloudy deleting its own old copy to move a message to the bottom (Reappear, sticky guides, via `deleteMessageForMove`) is not logged; only a delete request Cloudy itself completed counts as a move.
- Cloudy's own replies to an action are never logged when deleted (`isBotActionFeedback`): command/button/modal replies (public or private), replies to a prefix command, 10-second status notices and status titles. Logs keep member messages, AutoMod, purges and posted embeds (Builder posts, panels, guides). Such replies are snapshotted only as a `feedback` marker so this holds after a restart.
- An embed removed with the Embed Builder's Delete (the post, its Reappear copy and a linked log post) is tagged `embed-builder` at the delete call and logged in the AutoMod log, with the staff member who confirmed Delete as Deleted by. That log shows the deleted embed itself under its details (`deletedEmbedCopies`: exact colour, banner via the uploaded copy, thumbnail, fields, footer without the Builder marker; no buttons) instead of the Message text; above ~4500 characters it falls back to the text log. In message log channels the registry indexes only embed 0, so a shown copy never becomes a Search item.
- Cloudy's private (ephemeral) replies never arrive as normal messages, so their deletion has no content or author. Their IDs are remembered from Discord's responses and from Cloudy's own interaction-link deletes (`rememberInteractionMessage`, 20 minutes), and such deletions are never logged (no "Unknown / not cached" entries).
- Uncached deletions use `messageSnapshotService` (Redis, `MESSAGE_SNAPSHOT_TTL_HOURS`, default 72; removed once logged).
- These channels are styled in `logEvent` (Cloudy footer at send) and skipped by the generic branding and response-catalog listeners (no post-send edit). The registry keeps only the newest automatic row per log channel and log type.

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
- Interactive configuration/dashboard messages (including Ticket Dashboard and Join to Create) delete after five minutes of inactivity. Activity resets the five-minute window.
- The Embed Builder (controls, preview, Modify embed) closes after 30 minutes of inactivity (owner's choice, `BUILDER_SESSION_IDLE_MS`); activity resets the 30 minutes. In a server the Builder is a normal message, so Cloudy removes it at exactly that moment. Discord only lets Cloudy remove a private message while the link of its last click works (15 minutes), so an expired private Builder (or private Modify embed) stays on screen until Discord drops it; Cloudy remembers it (`rememberExpiredBuilderMessage`, also an old copy left by a resume) and a click on it is answered and removes it (`removeExpiredBuilderMessage`, never "This interaction failed", never logged as a deletion).
- While the Embed Builder's browser editor (content/footer/colour page) is open it holds the whole Builder (controls and the preview above them) with no timer, even when nothing is typed: every page contact (20-second heartbeat, typing, colour) restarts a 14-minute idle window (owner's choice, as in PR #451; switching apps on the phone is not a close); closing the page starts the Builder's normal 30 minutes. In a server the preview is a normal message and keeps updating the whole time. Only a private Builder (outside a server) has Discord's 15-minute edit limit after `/embedbuilder`; after that its preview is marked paused (the editor session is NOT deleted), the editor keeps saving into the Builder, and Save/Post in Discord apply everything. The editor page looks exactly as before (owner's choice: no extra preview or CSS).

## Cloudy Feed

- Add/Edit feed form (owner's choice, in this order): Feed name, Website URL, Auto message, Start time, 18+ content. Media type is not in the form: for Add it is chosen on the channel step (the form opens once both media type and channel are chosen); for an existing feed it is the select on the Manage screen, saved at once.
- Start time is optional EU/Netherlands time (`Europe/Amsterdam`), placeholder `00:00` (owner's choice): `20:00` (today, or tomorrow once passed), `30-10 20:00` or `30-10-2026 20:00`, within one year. The first post waits for it (`startAt`), then the Auto message interval applies; empty means the old behaviour. Edit shows a future Start time and keeps it when unchanged; Pause/Resume keeps it.
- Every feed video is a 10-second clip from the middle (`cloudyFeedVideoClip.js`); videos of 10 s or shorter stay as they are. Long website videos download only their middle (yt-dlp `--download-sections`, ffmpeg through the guarded proxy, HTTPS only via `-protocol_whitelist`, size capped); Cloudy's own ffmpeg only reads local files.

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
