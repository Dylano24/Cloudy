# Cloudy Store billing and Rust Console kit delivery

Both features are additive and **off until configured**. Nothing here charges money: payments are taken by Tip4Serv on Cloudy Store; this bot only applies what a verified payment bought.

## Connection

The website (server side only) calls the bot over the signed dashboard connection (`src/web/dashboardApi.js`, HMAC with `CLOUDY_DASHBOARD_API_SECRET`, at least 32 characters, the same value on Railway and Vercel). Routes under `/api/dashboard/v1/billing/...` refuse Discord-token requests (403), so not even a signed-in owner can grant paid time by hand through them. While PostgreSQL is unavailable (degraded mode) billing answers 503, so Tip4Serv retries instead of a paid entitlement living only in memory.

## Cloudy Bot Premium (`POST billing/premium`)

Body: `eventKey` (idempotency key), `event` (`grant` | `renew` | `expire` | `refund` | `fail`), `kind` (`one_time` | `subscription`), `guildId`, `paymentRef`, `months` (one-time, 1-36) or `periodDays` (subscription, default 30), `subscriptionId`, optional `buyerDiscordId`.

- Stored in the existing plan record `guild:<id>:dashboard:plan` under `billing` (`paidUntil`, `subscription`, `grants`, `processed`). Owner grants (`premiumUntil`) stay separate, so a refund only removes what that payment added, and the owner's "off" never cancels a paying customer.
- A repeated `eventKey` changes nothing (`duplicate`); a second event for the same `paymentRef` (Tip4Serv sends `payment.success` and `subscription.created` for one checkout) is `already_granted`.
- Subscriptions: active until the paid period end plus a 3-day grace for late renewal webhooks; a renewal continues the cycle from the old period end. `expire` ends it. There is no free trial: without Premium, settings are visible but saving is refused.
- Paying before Cloudy is in the server is allowed (`inGuild: false`); the time is waiting when Cloudy joins.

## Rust Console kit delivery (`billing/rust/...`)

`src/services/rustConsole/`. Environment:

| Variable | Meaning |
|---|---|
| `RUST_CONSOLE_FULFILLMENT` | `off` (default), `mock` (records commands, refuses live payments) or `live` |
| `RUST_CONSOLE_SERVERS` | JSON `{"main": {"host": "…", "port": 28016, "tls": false, "onlineCheckCommand": null}}` |
| `RUST_CONSOLE_RCON_PASSWORD_<NAME>` | RCON password per server (never in the JSON) |
| `RUST_CONSOLE_REQUIRE_VERIFICATION` | `true` (default): kits wait until the buyer proved the gamertag in game |

- Protocol (Rust Console Edition community server spec): WebSocket `ws://host:port/<password>`, frames `{"identifier","name","message"}`, replies matched on `identifier`. Command: `kit givetoplayer "<kit>" "<gamertag>"`. Kit names and gamertags are allow-listed (no quotes, `;`, line breaks).
- One delivery per kit unit with a stable ID (order key + item + unit): retries and resends never deliver twice.
- At most once: if a command may have reached the server but no answer came back (timeout, closed connection, restart while sending), the delivery becomes `needs_review`; staff check in game and then `retry` or `mark-delivered`.
- Unreachable server: backoff up to 60 minutes, kept for 14 days. Server refusal (failure pattern): up to 8 attempts. Offline player (when `onlineCheckCommand` is set): waits without using attempts.
- Refund: undelivered units are cancelled; delivered ones become `refunded_after_delivery` for staff.
- Verification: `verify/start` gives the signed-in customer a code `CLOUDY-XXXXXX` (15 minutes, 5 per hour); typing it in game chat from that gamertag links it; waiting deliveries are released.
- Staff (`deliveries/query`, `deliveries/<id>/retry|cancel|mark-delivered`) require Cloudy's owner (OWNER_IDS or the application owner).

### Needs a real server before going live

Not verified against a real Rust Console server yet: the exact reply text of `kit givetoplayer` (success vs failure), whether the player must be online, whether chat lines are broadcast over RCON and in which format, and whether the chosen host (Nitrado or GPORTAL) exposes RCON to server owners. Real-money kit sales also need the game's and the host's commercial rules checked first.

## Setup message for new servers

`src/services/dashboardOnboarding.js`, called from `guildCreate`: when Cloudy joins a server other than `GUILD_ID`, it posts one embed with an "Open the dashboard" link button (`CLOUDY_DASHBOARD_URL` + `/bot/<server id>`) in the system channel, or else the first text channel it may post in. No mentions. Sent once per server (`guild:<id>:dashboard:onboarding`). Off until `CLOUDY_DASHBOARD_URL` (https) is set.
