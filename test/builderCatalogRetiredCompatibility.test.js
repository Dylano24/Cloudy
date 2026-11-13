import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { loadCommands } from '../src/handlers/loaders/commandLoader.js';
import { ensureUsedBuilderCatalogLoaded, getBuilderRecordPolicy, getSystemEmbedTemplateKey } from '../src/services/systemEmbedCatalogService.js';

// Exact deployed command contract before removal: the retired files were
// already skipped. Every currently loaded route must survive the cleanup.
const deployedNames = [
  "Cloudy report",
  "app-admin",
  "apply",
  "auto",
  "autorole",
  "autoverify",
  "avatar",
  "baccarat",
  "balance",
  "ban",
  "baseconvert",
  "beg",
  "blackjack",
  "botprofile",
  "buy",
  "calculate",
  "cases",
  "changelog",
  "claim",
  "close",
  "commands",
  "configwizard",
  "countdown",
  "creator-notify",
  "crime",
  "daily",
  "dashboard",
  "deposit",
  "dm",
  "economy",
  "embedbuilder",
  "firstmsg",
  "gamble",
  "game",
  "gamefeed",
  "generatepassword",
  "give",
  "giveaway",
  "goodbye",
  "greet",
  "help",
  "hexcolor",
  // /honeypot got its own command after this list was written (9b9a490).
  "honeypot",
  "inventory",
  "join",
  "jointocreate",
  "kick",
  "leaderboard",
  "lock",
  "logging",
  "massban",
  "masskick",
  "music",
  "now",
  "nowplaying",
  "pay",
  "ping",
  "play",
  "priority",
  "purge",
  "queue",
  "randomuser",
  "reactroles",
  "report",
  "rob",
  "roulette",
  // /rustcommunity was added with the optional Rust community tools (4e3ed48).
  "rustcommunity",
  "say",
  "search",
  "serverinfo",
  "serverstats",
  "shop",
  "shop-config",
  "shorten",
  "stats",
  "support",
  "ticket",
  "time",
  "timeout",
  "todo",
  "unban",
  "unixtime",
  "unlock",
  "untimeout",
  "uptime",
  "userinfo",
  "usernotes",
  "verification",
  "verify",
  "vote",
  "warn",
  "warnings",
  "weather",
  "welcome",
  "wipe",
  "withdraw",
  "work"
];

test('all 96 deployed routes (incl. /now, /wipe, /honeypot and /rustcommunity) survive removal of the 12 retired implementation files', async () => {
  const client = {};
  await loadCommands(client);
  assert.deepEqual([...client.commands.keys()].sort(), deployedNames);
  assert.equal(client.commands.get('gamble').filePath.endsWith('/Economy/gambling.js'), true);
  assert.equal(client.commands.get('jointocreate').filePath.endsWith('/00Overrides/jointocreate.js'), true);
  assert.deepEqual(client.commands.get('giveaway').data.toJSON().options.map(option => option.name), ['create', 'manage']);
});

test('a cold process archives an unchanged retired template but retains its owner edits and historical use', async t => {
  const id = 'cold-retired-template';
  t.mock.method(db, 'get', async () => []);
  await ensureUsedBuilderCatalogLoaded(id);
  const title = 'Giveaway Deleted';
  const description = 'The giveaway and its message were removed.';
  const key = getSystemEmbedTemplateKey('embed', title, description, 'giveaway/gdelete');
  const record = {guildId: id, source: 'system-catalog', channelId: 'botlog', messageId: 'catalog', embedIndex: 0,
    snapshot: {title, description, color: 0xFFFFFF, footer: {text: '© Cloudy Inc. • Quality. Innovation. Performance.'},
      author: {name: `Cloudy template key: ${key} || Cloudy context: giveaway/gdelete || Cloudy kind: embed`}}};
  assert.equal(getBuilderRecordPolicy(record).decision, 'archive');
  const custom = structuredClone(record);
  custom.snapshot.image = {url: 'https://example.test/my-original.gif'};
  assert.equal(getBuilderRecordPolicy(custom).decision, 'review');
  assert.equal(getBuilderRecordPolicy({...record, explicitSave: true}).decision, 'show');
});
