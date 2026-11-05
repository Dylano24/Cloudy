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
- An embed removed with the Embed Builder's Delete (the post, its Reappear copy and a linked log post) is tagged `embed-builder` at the delete call and logged in the Embed log (`EMBED_LOG_CHANNEL_ID` 1565544310588317716, owner's choice), with the staff member who confirmed Delete as Deleted by. Every other deleted Cloudy embed post (panels, guides, Builder posts deleted in Discord) also goes to the Embed log, never the AutoMod or Staff log. That log shows the deleted embed itself under its details (`deletedEmbedCopies`: exact colour, banner via the uploaded copy, thumbnail, fields, footer without the Builder marker; no buttons) instead of the Message text; above ~4500 characters it falls back to the text log. In message log channels the registry indexes only embed 0, so a shown copy never becomes a Search item.
- Cloudy removing one of its own messages that it no longer has cached and has no stored copy of (no author, no content; e.g. a Builder left over from before a deploy) is never logged. Deletions with a reason (AutoMod, Embed Builder Delete, staff) still are.
- Cloudy's private (ephemeral) replies never arrive as normal messages, so their deletion has no content or author. Their IDs are remembered from Discord's responses and from Cloudy's own interaction-link deletes (`rememberInteractionMessage`, 20 minutes), and such deletions are never logged (no "Unknown / not cached" entries).
- Uncached deletions use `messageSnapshotService` (Redis, `MESSAGE_SNAPSHOT_TTL_HOURS`, default 72; removed once logged).
- These channels (Staff, Member, AutoMod and Embed logs) are styled in `logEvent` (Cloudy footer at send) and skipped by the generic branding and response-catalog listeners (no post-send edit). The registry keeps only the newest automatic row per log channel and log type.

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

## Giveaways

- Layout (owner's choice): everything in the embed description with the custom emojis (gift, prize, timer): "Giveaway time !", personal description (default "Cloudy Inc. is giving you the chance to win something special!"), prize, Requirements (default None), Winners, Giveaway ends, "Good luck to everyone!". Always a white side line, also once ended and in winner announcements (owner's choice). Ended: winners tagged, ended time. Manage: End and Delete red, View participants blue, the rest grey.
- `/giveaway create` (and `/gcreate`) opens the private Giveaway Builder (owner's choice, like the Embed Builder): live preview, tag picker (@everyone, Role, No tag; "Role" opens a small form with the role picker, placeholder "Choose the role", so the controls fit Discord's 5 rows), channel picker, then buttons in this order (owner's choice): Edit text, Edit claim / Duration & winners, Code / Post giveaway (green), Cancel (red). In the text form only Prize shows an example ("1 month vip"). It closes after 30 minutes of inactivity; nothing is posted before Post.
- Code (owner's choice): "No code" (default) means hosted outside the website: Enter giveaway (`giveaway_enter:country`) first opens a private list of every country in English (202, `giveawayCountries.js`), 25 per page (Discord's limit) with Previous, Next and "Type my country" (owner's choice); it closes after 5 minutes without activity. A typed country is searched in the list with common local names/short forms: one match enters at once, several show those countries, and a country that is not in the list is saved as typed (owner's choice). Discord only offers search-while-typing in slash commands, never behind a button. The country is saved per participant (`participantCountries`). Other choices: generate a code (Standard `CLOUDY-1893-1839`, Kit `CLOUDY-K678-3890`, Credit card `CLOUDY-€678-3890`, Discount `CLOUDY-REDUC10-1047-3048`; Cloudy makes a new one per winner when they open their claim) or "Add existing code" (staff paste their own codes, one per line; each winner takes the next unused one and keeps it; Manage > Code shows only unused codes, given-out codes stay with their winner; a winner without a code yet gets it on Reveal once staff add more). Reveal my code shows the code (`giveawayCodeService.js`, encrypted with `GIVEAWAY_CLAIM_ENCRYPTION_KEY` when set). A no-code claim has only Close and its default claim text never mentions a code. Giveaways saved before this (no `codeType`) keep their old behaviour.
- Claim channels are named `giveaway-claim-<giveaway number>` (the same #N as in #giveaway-logs).
- The private "Claim successful!" reply has no Cloudy timer (owner's choice, PR #526): it is removed when its claim channel closes (Close, 24-hour expiry or a staff deletion of the channel). "Claim denied" disappears after 20 seconds.
- #giveaway-logs (found by name, else the claim log channel) gets "Giveaway created" and "Giveaway ended" logs (`giveawayLogService.js`, Cloudy logo and footer), and for a no-code giveaway a "Giveaway winner country" log for the winners only, tagging the Owner role.
- Buttons: "Enter giveaway" and "Leave giveaway". `/giveaway manage` (Owner role) is private: choose a status (Active giveaways / Ended giveaways), then a giveaway. Manage panel text has one empty line between prize, participants and the end line. Active (owner's order): Edit text, Edit claim, Edit timer / Code, View participants / End, Delete (no Reroll; Discord has no yellow button, so End is red). Ended: Reroll (never redraws earlier winners), Code / View participants, Delete (with confirm).
- When winners are drawn (automatic every minute, End, Reroll) Cloudy replies to the giveaway with a message that tags only the winners and shows "How to claim your prize". The result is saved before anything is shown; a giveaway whose message was removed is closed without tagging anyone. Old giveaway buttons (`giveaway_join`, `giveaway_end`, `giveaway_reroll`, `giveaway_view`) keep working.
- Every giveaway and Giveaway Builder notice (Success/Warning, also after End/Reroll/Delete/Post/Cancel) removes itself after exactly 10 seconds (`removeAfterTenSeconds`); it never removes the giveaway message itself. Notices use the Warning title with a red side line (`giveawayWarning`, `CLOUDY_RED_COLOR`, owner's choice: never yellow), not the generic error embed (a saved response template rewrote its title). The View participants list also disappears after 10 seconds (owner's choice). The private Manage panel follows the 5-minute dashboard rule. Every giveaway button acknowledges Discord before any database work.

## Patchbot

- Patchbot (owner's choice, like the PatchBot bot) posts game updates in the channel a server chooses on the website: dashboard module `patchbot` (`enabled`, `channelId`, optional `roleId` to tag, `games`; Rust only for now) and action `postlatest` ("Post latest update"). `patchbotService.js` reuses the Rust update post (`buildRustPatchPayload`) and runs after each Rust feed check.
- Only updates that appear after Patchbot is switched on (or its channel changes) are posted; each server/channel remembers the last one. Patchbot never posts in Cloudy's own #rust-patch-notes, which keeps its built-in poster unchanged.

## Music

- Music embeds (owner's choice): sentence-case titles ("Now playing", "Music queue", "Loop updated", ...), the Cloudy logo as thumbnail and the Cloudy footer; on "Now playing" the track cover is the image and Paused/Playing is the Status field. A new player panel (Now playing with controls) is posted in #music when the server has it; an existing panel keeps its message.

## Vote

- `/vote` replaces `/poll` (owner's choice): question, 2 to 10 options and an optional duration. The embed ("Vote", "Vote ended") shows each option with a bar, percentage and count, total votes and the end time, with the Cloudy logo and footer; one button per option (`vote_cast:<index>`). One vote per member: another option changes it, the same option removes it; only counts are shown, never who voted. Votes are stored per guild (`guild:<id>:votes`) and closed every minute when their time passes (winner or tie shown, buttons disabled). Notices disappear after 10 seconds.

## Game server feeds

- The "feeds" channels #pvp, #player, #zorp, #raids, #ban and #wipe-feed get one embed per game event (`gameFeedService.js`, owner's choice: classic layout): title (Player killed, LOGIN / LOGOUT / Kit claimed, ZORP, Raid alert, BAN/UNBAN, Wipe incoming / Server wiped), labelled lines with player names in code, Server and Time, the big Cloudy logo as thumbnail and the plain Cloudy footer (no footer icon, no timestamp). Login and logout show Platform as an emoji only (Xbox or console), ZORP off shows Protected for, kills show Killstreak. Colours: kill, logout, ZORP off, raid and ban red; login, ZORP on and unban green; kit and wipe white. Killstreak (🎯 N) and ZORP protection time are tracked in memory per server. "Top killers of the day" (top 3, classic layout) is posted in #leaderboard at 00:00 Amsterdam. Feed and board embeds skip every response-template layer (`gameFeedTitles.js`). Channels come from Cloudy's cache (no Discord request per event): first the owner's channel IDs (#pvp `1555124201688670269`, #player `1555124202825191516`, #zorp `1555124204008116274`, #raids `1555124205391970395`, #ban `1555124206495207445`), else by name (#wipe-feed only by name) and embeds are batched per channel (up to 10 per message).
- Custom emojis (owner's choice) on Player killed (also Weapon), login/logout, ban/unban and ZORP only: titles are "<emoji> LOGIN", "<emoji> LOGOUT", "<hammer emoji> BAN", "<emoji> UNBAN" (emoji first) (arrow emojis, cropped, enlarged and without their dark shadow when Cloudy uploads them; Player: name line shown), "<on or off emoji> ZORP" (the title check ignores the emoji); on LOGIN, LOGOUT, ZORP and BAN/UNBAN the emoji is only in the title; Player killed keeps emojis after the colon (Killer: <emoji> `Dyn`) on killer, victim, distance, headshot, server and weapon; Killstreak uses 🔥 (`feedEmojiService.js`).
- "Server wiped" (owner's choice, like the PatchBot wipe post in Cloudy style): "<server> has just wiped!", Wipe/Map, "How to play on this server?" (community tab, search the server name in code), "Current wipe" with Start and End (`next`) and an optional https `store` link; no banner. Its bullets, the Wipe and Map lines and the Time line use the white dot emoji, dates are one short tag (`<t:X:s>`) and the gap under the two headings is a small-text empty line (owner's choice).
- The game server is not linked yet (owner's choice: prepare first, link later). Link point: `POST /api/game/v1/events` with `Authorization: Bearer <CLOUDY_GAME_FEED_SECRET>` (at least 32 characters) and `{ "events": [...] }` (max 50). Without the secret it answers 503. Game-server text is cleaned (no mentions or markdown).
- `/gamefeed embeds` shows every feed embed and the three boards privately; `/gamefeed status` shows which channels were found and whether the link is set.
- Live boards (`gameServerBoardsService.js`), one message each, edited in place at most every 30 seconds and only posted after the first event: #server-status ("Server status": the name with Online or Offline next to it, then Players, Queue, Map and Next wipe each on their own line with the white dot emoji in front; `status` events), #population (one message per server, sent and edited by a channel webhook named "Cloudy Population" under the server's name with the still Cloudy logo as avatar, showing only "<dot> 87/100" or "<dot> Offline"; the old single Population embed is removed) and #leaderboard ("Leaderboard": top 10 by kills per server from `pvp` events, kills only (no deaths or K/D); a `wipe` with state `done` starts that server again). A server that sends no status for 5 minutes shows as offline. Max 20 servers.
- Population bots (owner's choice, like the "EU 6x" bot): optional, one extra Discord bot per game server (`populationBotService.js`). Its token is in `POPULATION_BOT_TOKENS`, a JSON object {"<game server name>": "<bot token>"}; Cloudy logs it in, sets its custom status to "🟢 87/100" (or "🔴 Offline", status dnd) and gives it a hoisted "Population" role. A server with a working bot in the guild gets no webhook message; the others keep theirs. The bots log in at startup and show "🔴 Offline" (red dnd dot, still listed under Population) until their game server sends a status.
- `/changelog` (staff, Manage Server) opens a form (Server, Changes one per line, Note) and posts "Server changes" in #change-logs with bullets, Changed by and time.

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
