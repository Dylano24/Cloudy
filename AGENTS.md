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

## Current non-ticket log rules

Ticket logs are excluded from all rules in this section and must remain unchanged.

- Every non-ticket log uses the Cloudy logo as its thumbnail, never a member/user avatar.
- Cloudy logo URL:
  `https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif`
- Kick and timeout logs, including AutoMod: `#A9AF00`.
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

## Current verified state

- Baseline before this handoff: `61fad81ced310c2860ffa6b68d3b702f446917a7`.
- Permanent non-ticket log protection was introduced in `cfbce39701f317c44f5a3a18dbc6e91997c9be3e`.
- Moderation identity/transient reply fixes were introduced in `f82455a75fd630c4c07e8d7874d7dab59b97e1d8`.
- Railway project: `cdfc01a5-81dc-412d-bd0e-27321529ea39`.
- Railway production environment: `91a30755-f4b4-4fa0-ba92-f932168c1065`.
- Railway service: `b853c72c-bee0-4ac9-9824-573ff6a84988`.
