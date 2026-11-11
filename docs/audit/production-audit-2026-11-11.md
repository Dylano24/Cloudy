# Cloudy production audit — 11 November 2026

Base: `main` at `954fcfc35cd936253e4574bcd29dc214a0d271f1`. Work branch: `claude/cloudy-bot-audit-lha72h`.
Nothing was deployed, no pull request was opened, no Discord message was posted or edited, and no production setting was changed. Railway was only read (HTTP status counts, logs, service configuration with variable **names**, never values).

## 1. What this audit did and did not cover

| Area | How it was checked |
| --- | --- |
| Reports and moderation | Read in full; numbering verified against a real PostgreSQL 16 (sequential, 60 concurrent reservations from two simulated processes, lost counter row, second server) |
| Votes, Manage vote, automatic votes | Read in full |
| Giveaways, automatic and Rust wipe giveaways, `/wipe sync` | Read in full; new query verified against real PostgreSQL through Cloudy's own database layer |
| Footer on PC and phone | Read in full; the footer picture measured pixel by pixel |
| Web server and APIs (dashboard, game feed, appeals, editor) | Authentication, signing, rate limiting and proxy handling read |
| Media tools (ffmpeg, yt-dlp, gallery-dl), SSRF guards | Read in full; tested with real child processes and real ffmpeg |
| Startup, shutdown, schedulers, database layer, schema, indexes | Read; migrations and the three PostgreSQL integration tests run locally |
| Production state | Railway: 7 days of HTTP status counts, 4xx/5xx request log, error log, build log, service configuration |
| Embed Builder (about 10 000 lines) | **Not changed.** Identity, write queue and caches read; its 668 tests in 128 files run and pass. Not reviewed line by line |
| Tickets, economy, leveling, music, verification, welcome, reaction roles | Covered by the test suite only; not re-read in this audit |

Not available, so **not done**:

- **The video.** No video was attached to this session and none is in the repository. Nothing in this report is based on it.
- **A real Discord client.** Nothing here was seen in Discord on PC or on a phone, and nothing was tested in the Dylano server. Every statement about appearance comes from the payloads Cloudy sends.
- Linear DYL-6 and the monitor's handoff endpoint were not read.

## 2. Problems found, root cause, correction

Severity is my own estimate of impact on a live server.

### Fixed in this branch

**A. Reports could not be submitted in any server other than Cloudy Inc. (high, for those servers)**
Root cause: `nextReportNumber` reads two archive channels to recover the highest number ever used. Those channels exist only in Cloudy Inc. In another server the same bot can still read them, so discord.js does not answer "Unknown Channel" but throws `GuildChannelUnowned`. Only codes 10003 and 50001 were handled, so the error stopped every report (this includes the Dylano test server when the same bot account is in it).
Correction: that answer is treated like a missing channel, in numbering and in the report destination lookup. Any other Discord failure still stops numbering, so a number is never reused.
Numbering itself is sound: verified on real PostgreSQL that numbers are unique and gapless under 60 concurrent reservations, continue from 114 when the counter row is lost while report 113 is stored, and are independent per server.

**B. A giveaway's winners could be drawn and never announced (high)**
Root cause: `finishGiveaway` saved the draw and then looked the giveaway message up with a helper that turned *every* failure into "not found". A Discord error, a timeout, or a restart between those two steps was treated as "someone deleted the giveaway": the giveaway stayed ended, the winners were never tagged, got no Claim button and no claim deadline, and nothing retried. The automatic reroll of unclaimed prizes switched itself off permanently the same way. A manual Reroll saved the new winner before checking that the message could be reached, so a failed attempt used up a winner.
Correction: lookups distinguish Unknown Channel/Message from "could not be checked". A saved draw carries `resultPending` until Discord shows it; the per-minute check shows it again with the same winners (never a new draw), at most 30 times. The announcement is sent at most once (that it is being sent is saved first; only an answer in which Discord refused it is retried). Reroll looks the message up before drawing.
Why this matters here: production restarts on every push to `main` (see H), so "a restart at the wrong moment" is routine, not rare.

**C. A vote could end without losing its buttons or getting a result (medium to high)**
Same pattern as B: ended in storage first, message looked up with errors swallowed, no retry. Also: the random winner of a tie was saved in a separate, unchecked write after it was chosen (it could differ from what was stored), and closing wrote an old copy of the vote back, which could bring back a vote deleted meanwhile.
Correction: an ended vote carries `closePending` until its buttons are removed and its result posted; the minute check finishes it (at most 30 attempts). Exactly one closer posts the result. The tie winner is chosen with the end, in the same save, with the cryptographic generator already used for giveaways. Closing updates the stored vote in place.

**D. Report moderation form validated input before checking permission (medium)**
Root cause: PR #734 put the duration check ahead of the authorization check. A member without report access got "Invalid duration" instead of being refused. No action could be performed, but the order was wrong and one test documented the intended order (it was one of the ten failing tests).
Correction: authorization first, then validation; both before anything changes.

**E. Media tools received Cloudy's credentials (medium, hardening)**
Root cause: ffmpeg, ffprobe, yt-dlp and gallery-dl handle files and pages from outside Cloudy and were started with the whole environment (bot token, database address, API keys). The extractor's own comment said credentials must not be inherited.
Correction: they get the environment without credential variables. PATH, HOME, language, certificate and Python settings are kept. Verified with real child processes and with the existing ffmpeg tests.

**F. A temporary wipe role could stay forever (low to medium)**
Root cause: when the role had to be removed and Discord could not be asked about the member, the member was treated as gone.
Correction: only Unknown Member/User counts as gone; anything else stays queued for the next wipe.

**G. `/report file` accepted an empty or one-letter reason (low)**
The "Cloudy report" form requires three characters; the slash command did not. It now applies the same rule, before a report number is reserved.

### Found, deliberately not changed (decision or measurement needed)

**H. `main` is red in CI and production deploys anyway (high, process)**
"Fast Quality Check" failed on every recent push to `main`: ten tests failed on an unchanged checkout. Railway has "wait for CI" off, so each push deployed regardless. Nine of the ten tests still asserted behaviour that later approved changes replaced; one was regression D. All ten are resolved in this branch (section 5).
Related: about 500 commits reached `main` between 3 and 11 November, and every push that touches `src`, `scripts`, `assets` or the package files deploys. The service has a volume, so the old and the new container never overlap. The request log shows the monitor unable to reach the service for about a minute at a time, once for four minutes in a row (9 Nov, 12:16–12:19 UTC); each of those gaps names a different deployment instance, which points to restarts. Every restart ends all Embed Builder sessions, open editors, dashboards and waiting forms, because they live in memory.
Recommendation (your decision): turn "wait for CI" on for the Cloudy service, and group changes into fewer deploys.

**I. The web server's rate limit is 100 requests per 15 minutes and is not per visitor (medium, latent)**
`src/app.js` counts requests per `req.ip`. Behind Railway's proxy, Express reports the proxy's address unless told to trust it, so visitors share buckets. The Embed Builder editor alone sends a heartbeat every 20 seconds (45 per 15 minutes) and one request per edit; the monitor adds 30. `/health` and `/ready` are behind the same limit.
Evidence it is **not** biting today: zero HTTP 429 answers in the last 7 days of production logs.
Why I did not change it: making the limit truly per visitor would make it *effective* against the editor, which sends far more than 100 requests in an active session. That needs a design (a separate, higher limit for the editor; health checks exempt) and a measurement in production first. It is described here instead of guessed at.

**J. The footer of the vote card looks larger on PC than on a phone — cause found (section 3)**

**K. A report case channel deleted by hand in Discord is logged as "24-hour expiry"**
When the channel is already gone at expiry, the log says the automatic deletion removed it. The rule is that "deleted" means only the automatic 24-hour deletion. What the log should say instead (nothing, or a different line) is a wording decision, so it is left as it is.

**L. Live data: the game feeds are not connected in production**
The Cloudy service has no `CLOUDY_GAME_FEED_SECRET` and no `POPULATION_BOT_TOKENS` variable. The feed endpoint therefore answers 503 and kill feed, server status, population, leaderboard and the "before wipe" mode of automatic giveaways and votes receive no live data. This matches AGENTS.md ("not linked yet"). The code path itself is real (no placeholder data is posted).
There is no payment-log system in this repository; "payment" exists only as the economy `/pay` notification.

**M. Smaller observations**
- Report actions (private case channels, report-logs) use channel IDs of Cloudy Inc. and work only there. In other servers staff now get "The Reports category is unavailable." instead of an internal discord.js message.
- Railway tracing with auto-instrumentation is on; it opens the Node inspector on 127.0.0.1 in the container (the "Debugger attached" lines in the error log). Not reachable from outside. Turn it off if the traces are not used.
- Deletion logs show a deleted photo through its original Discord link (owner's choice). That link stops working some time after deletion, unlike videos, which Cloudy copies.
- Honeypot in kick mode also acts on other bots that post in the channel.
- Votes, giveaways and the embed registry are each one document per server that is rewritten on every click (giveaways: all rows of the server are deleted and inserted again per entry). Fine at today's size; it grows with history. All locking is inside one process: keep exactly one replica.
- An announcement whose outcome is unknown (no answer from Discord at all) is deliberately not retried, so winners are never tagged twice. Staff can use Reroll in that rare case.
- 447 lint warnings (0 errors), unchanged.

## 3. Footer on PC and on a phone

**Cause.** Ordinary embeds have a real footer: Cloudy sends text and Discord draws it in its own small size on every device. Cloudy sends the same text everywhere (more than 30 written-out copies in `src`, all byte-identical; a new test now guards that).

The vote card (and its result card) is different. It uses Discord's newer card layout, which has no footer, and small text in that layout is always grey. The approved white small footer is therefore a **picture**: `assets/vote-footer-small.png`, 450 × 23 pixels, shown in a media gallery. This is the only place in the bot where a footer is a picture.

A picture is sized by the layout, not by a font size:

- On PC the card is wider than 450 pixels, so Discord shows the picture at its natural 450 pixels. The capital letters in it are about 13 pixels tall, slightly larger than normal message text.
- On a phone the card is narrower than 450 points, so Discord shrinks the picture to the card's width (about 330 points on a typical phone). The same letters come out about a quarter smaller.

So the difference comes from both sides: Cloudy's choice to draw the footer as a picture, and Discord's rule that a picture follows the card's width. Cloudy cannot make Discord size a picture like text.

**What Cloudy could do (not done, because each option changes the approved look):**

1. A narrower picture (about 330 pixels). PC would then match a phone, but the footer becomes smaller on PC than it is today, and less sharp on phones.
2. Real small text (`-#`). Identical size on every device, but grey, which was rejected before.
3. Leave it. This is the current state.

Nothing was changed. The picture, its link and its place in the card are now pinned by a test.

## 4. Outstanding work and TODOs

- `TODO`, `FIXME`, `HACK`, `XXX`, deprecated markers in `src`, `scripts`, `monitor`: **none found**.
- Skipped tests: three tests skip themselves only when ffmpeg is missing (they ran here); three PostgreSQL integration tests run only in CI (run here against a local PostgreSQL 16: passed).
- Open issues: none. Open pull requests: one, draft **#706** "Fix Auto Giveaway Schedule placement and Start guidance". It moves buttons in the Auto Giveaway dashboard and was never merged or approved, so it was **not** applied.
- Dependencies: `npm audit` reports 0 vulnerabilities. Minor updates are available (discord.js 14.28, express 5.3, pg 8.23, node-cron 4.6, axios 1.21); not applied.

## 5. Tests

| Check | Before (`main`) | After (this branch) |
| --- | --- | --- |
| Full suite (`node --test`, Node 24) | 1960 tests: 1947 passed, **10 failed**, 3 skipped | 1994 tests: 1991 passed, **0 failed**, 3 skipped |
| ESLint, whole repository | 0 errors, 447 warnings | 0 errors, 447 warnings |
| PostgreSQL integration tests (real PostgreSQL 16, local) | not run in the normal suite | 3 passed |
| Migrations + schema version check (local PostgreSQL 16) | — | passed |
| Repository code-quality script (`scripts/audit-cloudy-code-quality.mjs`) | — | passed, no missing imports |
| `npm audit` | 0 vulnerabilities | 0 vulnerabilities |

New tests (34): report numbering in a second server (2), permission before validation (1), `/report file` reason (5), giveaway result recovery (9), vote close recovery (8), wipe role retry (1), media tool environment (4), footer guard (3), one extra case in the giveaway persistence test.

The nine stale tests were corrected to the current approved behaviour, each traced to the commit that changed it:
deployed command list (`/honeypot`, `/rustcommunity` added later); Add media acknowledgement order; one-step report Close; fixed report log titles (41f80c1); deletion logs without uploaded files (5ddf6d3); Embed log reserved for the Builder's Delete (7a0d0d4).

One existing test changed meaning on purpose: when the second save of a giveaway end is rejected, the winners are now **not** announced (before: announced, then the failure surfaced). A third case was added for the save after the announcement.

Not tested: anything in a real Discord client; real Discord rate limits and outages (simulated with error objects); production data; load.

## 6. Performance

No performance change was made and none is claimed. One extra small query runs per minute (giveaways whose result is still waiting). Vote closing and giveaway ending each make one more database write than before.

## 7. What was preserved

No embed, card, title, text, colour, emoji, emoji ID, button, button order, menu, form or footer was changed. The Embed Builder was not touched. No command was added, removed or renamed. The only new text a user can see appears in rare error situations:

- Reroll while winners are still being announced: "The winners of this giveaway are still being announced. Please try again in a minute."
- Reroll while Discord cannot be reached: "Discord could not be reached, so no new winner was drawn. Please try again."
- `/report file` with a reason under three characters: the same sentence the report form already uses.

## 8. Changed files

Source: `src/services/reportCaseService.js`, `reportCaseLifecycleService.js`, `reportActionService.js`, `giveawayActions.js`, `voteService.js`, `wipeAutomationService.js`, `cloudyFeedExtractorService.js`, `cloudyFeedVideoClip.js`, `videoGifService.js`, `src/utils/database.js`, `src/utils/childProcessEnvironment.js` (new), `src/commands/Utility/modules/report.js`.
Tests: 5 new files, 9 stale tests corrected in 6 files, 4 files extended. Documentation: `AGENTS.md`, this report.

Commits, oldest first:

1. `cf4e146d` number reports in every server; check report permissions first
2. `5452401f` never lose a giveaway result to a Discord outage or a restart
3. `a9b65369` finish closing a vote after a Discord outage or a restart
4. `cc24cc48` keep credentials away from media tools; retry removing a wipe role
5. `742a4bbb` bring nine stale tests in line with approved behaviour; guard the footer
6. validate the `/report file` reason; AGENTS.md; this report

## 9. Ready to deploy, and not

**Ready for your review and approval** (tests green, no visual change): everything in section 2 A–G and the test corrections.

Two things to know before approving:

- New stored fields `resultPending` (giveaways) and `closePending` (votes) are written only by the new code and are ignored by the old code, so going back to the previous version is safe. Giveaways and votes that already ended are never touched.
- After the first deploy, watch one giveaway and one vote end, and one report submitted in the Dylano server. None of that could be checked in Discord from here.

**Not ready, needs your decision first:** H (CI gate and deploy rhythm), I (rate limit), J (footer picture), K (wording for a hand-deleted case channel), draft PR #706.

*Update: I, J and K were implemented later the same day; see section 10.*

No claim of complete coverage is made: section 1 lists what was only tested and not re-read.

## 10. Follow-up on the same day: three open points implemented

After this report was written the owner asked for the open points to be implemented without further questions. Done on the same branch:

- **I, request limits.** Each visitor now has their own budget (one proxy hop is trusted on Railway, so the visitor's own address is used), the Embed Builder's browser editor and hosted media have their own budgets (1200 and 600 per minute), every other endpoint keeps 100 per 15 minutes, and `/health` and `/ready` are never limited. If Railway should not pass the visitor's address as expected, the result is no worse than before the change. Not measured in production.
- **J, vote footer.** The footer picture is now 315 pixels wide (`assets/vote-footer-compact.png`, made from the same master), the width a phone shows, so PC and phone show it at the same size. Text, colour and place are unchanged; on PC it is about 30% smaller than before and on phones slightly less sharp. The 450-pixel picture is kept; going back is one line (`VOTE_FOOTER_URL`). The new link was fetched successfully. **Not seen in Discord.**
- **K, hand-deleted case channel.** Logged as closed with "Closed by: Unknown", never as the automatic deletion. An automatic deletion interrupted by a restart is still logged as "24-hour expiry".

Not done: **H** is a Railway setting, not code, and draft PR **#706** changes an approved button layout.

Final numbers for the branch: 2001 tests, 1998 passed, 0 failed, 3 skipped (the PostgreSQL integration tests, which passed separately against a local PostgreSQL 16). ESLint: 0 errors, 447 warnings.
