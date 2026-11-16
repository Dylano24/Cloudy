# Cloudy for Rust Console Edition

Cloudy connects to Rust Console Edition (RCE) community servers over WebRCON and brings the game into Discord: kill feeds, joins, chat, world events, player statistics and leaderboards, account linking, an economy with rewards and a shop with in-game delivery, emote kits and teleports, bounties, ZORP offline raid protection, automatic in-game messages, a live status board and store deliveries in the KAOSBOT format.

The module works in every Discord server Cloudy is in. Outside Cloudy's own servers it needs **Cloudy Bot Premium** (owner grant or Cloudy Store); without Premium, settings can be prepared but no game server connects.

## 1. Connect a game server

You need three details from your host's control panel (G-Portal or Nitrado): the server **IP**, the **RCON port** and the **RCON password**.

```
/rce server add name:Cloudy Rust host:51.38.10.20 port:28016 password:••••••
```

Cloudy tests the connection right away and then keeps it open, reconnecting by itself after restarts (5 seconds, then growing pauses up to 5 minutes). The password is stored encrypted. Up to 10 game servers per Discord server.

- `/rce server list`: every server, its number (used by store deliveries) and connection state
- `/rce server edit`: change name, address, port or password, or switch a server off
- `/rce server reconnect`, `/rce server remove`

Only public addresses are accepted: Cloudy never connects to private or internal networks.

## 2. Choose the feed channels

```
/rce channel set feed:Kill feed channel:#killfeed
```

| Feed | What is posted |
|---|---|
| Kill feed | Player kills with killstreaks and claimed bounties (`/rceconfig settings killfeed:All deaths` also shows NPC, trap and natural deaths) |
| Joins and leaves | Login and logout with time played and players online |
| In-game chat | Quick chat lines (local, team, server) as readable text |
| World events | Cargo ship, patrol helicopter, Chinook, airdrop and seasonal events |
| Admin log | Kits and items given, bans, roles, staff commands, account links, emote actions, connection lost/back |
| ZORP | Zones created, protected, back online, removed or expired |
| Shop and deliveries | Shop purchases and store deliveries |
| Server status | One live message per server: players, queue, map, game time, uptime, FPS (updated every minute) |

`/rce channel list` shows all of them, `/rce channel clear` turns one off.

## 3. Players link their account

Players run `/rust link gamertag:<name>` and prove in game that the gamertag is theirs within 10 minutes, in one of two ways:

1. use three quick chat emotes in the order Cloudy shows, or
2. write the shown code (`CLOUDY-123456`) on a note.

Only the player with that gamertag can complete it. One gamertag belongs to one member; staff can link by hand with `/rceconfig link set` (or remove with `/rceconfig link remove`). Optional: `/rceconfig settings linked-role:@Linked` gives linked members a role.

## 4. Economy, rewards, shop and bounties

Cloudy uses the server's existing economy (`/balance`, `/pay`, ...).

- `/rceconfig rewards kill:50 npc-kill:10 playtime-hour:100`: money for linked players
- `/rceconfig shop add`: items (`rifle.ak` x1), kits, VIP (with days) or a custom console command with `{player}`; price, cooldown and the server it is sold on
- Players: `/rust shop`, `/rust buy item:<item>`. The player must be linked and online; if the server refuses the delivery the money goes back. If the server does not answer in time the purchase is posted for staff to check (never sent twice).
- Bounties: `/rust bounty place player:<name> amount:<n>`, `/rust bounty list`. The linked player who kills the target gets the bounty; teammates cannot claim each other's bounty. `/rceconfig settings bounties:false bounty-min:<n>`.

## 5. Emote actions: kits, items and teleports

Console players use quick chat, so Cloudy turns emotes into actions:

```
/rceconfig location add name:Outpost x:-120 y:22 z:430
/rceconfig emote add emote:Hello action:Kit value:starter cooldown:60
/rceconfig emote add emote:Follow me action:Teleport value:Outpost cooldown:30 price:250
```

Options per action: cooldown per player, price, linked players only (default), kit list only (KAOS `KITLIST`), once per wipe, and the server. Cloudy answers in game (for example when a cooldown is still running). `/rce game wipe` starts a new wipe: leaderboard, once-per-wipe claims and ZORP zones are reset.

## 6. ZORP (Zone Offline Raid Protection)

```
/rceconfig zorp settings enabled:true radius:30 yellow-minutes:10 expiry-hours:24
```

- The team leader uses **Can I build around here?** and confirms with **Yes**: a zone is created around them. **Can I build around here?** then **Goodbye** removes it.
- White: just created. Green: a team member is online (raidable). Yellow: everyone went offline, protection starts soon. Red: the team is offline and building damage is off.
- No zone after the set hours without anyone of the team online; zones cannot overlap; a leader who leaves the team loses the zone.
- `require-list:true` limits ZORP to members on the ZORP list (`/rceconfig access zorp`, or the store's `[ZORPLIST]`).
- Staff: `/rceconfig zorp zones`, `/rceconfig zorp remove`. Players: `/rust zone`.

## 7. Store deliveries (Tip4Serv, KAOSBOT format)

Point your store's Discord message at a channel and tell Cloudy:

```
/rceconfig delivery channel channel:#store-deliveries
```

Cloudy reads the same lines as KAOSBOT, so an existing Tip4Serv setup works unchanged (`[CLOUDY]` works as well as `[KAOS]`):

```
[KAOS][ADD][<@{discord_id}>][1]=[ITEM][rifle.ak][{quantity}]
[KAOS][ADD][<@{discord_id}>][1]=[KIT][elitekit5][{quantity}]
[KAOS][ADD][<@{discord_id}>][ALL]=[POINTS][{quantity*5000}]
[KAOS][ADD|DEL][<@{discord_id}>][1]=[ZORPLIST]
[KAOS][ADD|DEL][<@{discord_id}>][1]=[KITLIST][elitekit, elitekit2]
[KAOS][ADD|DEL][<@{discord_id}>][1]=[RIDER]
[KAOS][ADD][<@{discord_id}>][1]=[CLAIMWIPE][elitekit]
[KAOS][ADD|DEL][<@{discord_id}>][1]=[VIP]        ([VIP][30] = 30 days)
```

- Servers: `[1]`, `[1,2,3]` (numbers of `/rce server list`), `[ALL]` or a server id.
- Only messages from bots, webhooks or Manage Server members are read; every message is handled once.
- Items and kits wait until the buyer is linked and online, then are delivered once. A command that may have reached the server without an answer is marked "check in game" instead of being sent again: `/rceconfig delivery list`, then `/rceconfig delivery resolve` (send again, or mark delivered).

## 8. Staff tools

| Command | What it does |
|---|---|
| `/rce player kick|ban|unban` | Kick, ban (permanent or minutes) or unban |
| `/rce player give|kit|vip|teleport` | Give an item, a kit, VIP, or teleport to a saved location |
| `/rce game console` | Run any console command and see the answer |
| `/rce game say` | Message in the in-game chat |
| `/rce game players|status|log` | Online players, server status, the last console lines |
| `/rceconfig settings` | In-game kill feed, join messages and event messages, welcome message, linked role, announcements, bounties |
| `/rceconfig automessage add` | Repeat a message in game every N minutes |
| `/rceconfig access zorp|kit|show` | ZORP list and kit lists by hand |

## 9. Player commands

`/rust link`, `/rust unlink`, `/rust profile`, `/rust stats`, `/rust leaderboard` (kills, K/D, playtime, best killstreak, NPC kills), `/rust online`, `/rust status`, `/rust shop`, `/rust buy`, `/rust zone`, `/rust bounty place|list`. Stats, leaderboard, online and status have a `public` option.

## Environment

| Variable | Meaning |
|---|---|
| `RCE_ENCRYPTION_KEY` | Key for stored RCON passwords (at least 16 characters). Without it a key is derived from the bot token, so a new bot token means entering the passwords again. |
| `RCE_REQUIRE_PREMIUM` | `true` (default): other servers need Premium. `false`: free for every server. |
| `RCE_FREE_GUILD_IDS` | Extra Discord servers that never need Premium (comma-separated). |

## What still needs a real server

Built from the RCE community server command reference and the console lines open-source RCE tools read. Check once on a live server: the exact answer of `server.printpos` (ZORP reads the first `(x, y, z)` in it), the output of `relationshipmanager.teaminfoall` (team leader detection; teams are also followed from the team log lines), and that your host lets RCON clients run `global.say`, `kit givetoplayer`, `inventory.giveto`, `global.teleportpos` and `zones.*`. `/rce game console` and `/rce game log` show what the server answers.
