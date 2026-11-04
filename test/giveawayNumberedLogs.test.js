import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { getOrCreateGiveawayNumber } from '../src/services/giveawayNumberService.js';
import {
  buildGiveawayClaimLog, GIVEAWAY_CLAIM_LOG_CHANNEL_ID, GIVEAWAY_CLAIM_LOG_FOOTER,
  replaceClosedClaimChannelMentions, refreshHistoricalGiveawayClaimNumbersAndDates,
  refreshGiveawayAutoExpiryLogAction, refreshGiveawayClaimTitlesWithoutAction,
} from '../src/services/giveawayClaimLogService.js';

const guildId = '156000000000000001';
const first = '156000000000000002';
const second = '156000000000000003';
const publicChannel = '156000000000000080';
const privateChannel = '156000000000000090';
const winner = '156000000000000004';
const actionTime = '2026-11-04T01:13:00.000Z';
const originalLink = id => 'https://discord.com/channels/' + guildId + '/' + publicChannel + '/' + id;

function world() {
  const records = new Map([['guild:' + guildId + ':giveaways', {
    [first]: { messageId: first, createdAt: '2026-11-01T10:00:00Z', channelId: publicChannel },
  }]]);
  const client = {
    user: { id: 'cloudy-manager' },
    db: {
      get: async (key, fallback) => structuredClone(records.get(key) ?? fallback),
      set: async (key, value) => { records.set(key, structuredClone(value)); return true; },
    },
  };
  return { client, records };
}
const field = (embed, name) => embed.fields.find(item => item.name === name)?.value;
const base = (event, number = 1) => buildGiveawayClaimLog({
  event, guildId, messageId: first, userId: winner,
  claimChannelId: privateChannel, giveawayNumber: number,
  occurredAt: actionTime, giveaway: { prize: 'Lifetime access', channelId: publicChannel },
}).embeds[0];

test('giveaway numbers increase by guild, survive deletion/restart and are stable across all claim actions', async () => {
  const w = world();
  assert.equal(await getOrCreateGiveawayNumber(w.client, guildId, first), 1);
  assert.equal(await getOrCreateGiveawayNumber(w.client, guildId, first), 1);
  assert.equal(await getOrCreateGiveawayNumber(w.client, guildId, second), 2);
  // Once a post has gone, its number must not be available for reuse.
  w.records.set('guild:' + guildId + ':giveaways', {});
  const anotherClient = { ...w.client, db: { ...w.client.db } };
  assert.equal(await getOrCreateGiveawayNumber(anotherClient, guildId, first), 1);
  assert.equal(await getOrCreateGiveawayNumber(anotherClient, guildId, '156000000000000005'), 3);
});

test('Claim and Reveal link to exact giveaway #N; Close and expiry retain #N with no URL', () => {
  for (const event of ['opened', 'revealed']) {
    const embed = base(event, 7);
    assert.equal(field(embed, 'Giveaway'), '[#7](' + originalLink(first) + ')');
    assert.equal(field(embed, 'Private channel'), '<#' + privateChannel + '>');
    const names = embed.fields.map(item => item.name);
    assert.equal(names[names.indexOf('Private channel') + 1], 'Date');
    assert.equal(field(embed, 'Date'), '<t:1793754780:F>');
    assert.equal(embed.timestamp, undefined);
  }
  for (const event of ['closed', 'expired']) {
    const embed = base(event, 7);
    assert.equal(field(embed, 'Giveaway'), '#7');
    assert.equal(field(embed, 'Private channel'), '`' + privateChannel + '`');
    assert.equal(field(embed, 'Date'), '<t:1793754780:F>');
    assert.doesNotMatch(JSON.stringify(embed), /discord\.com\/channels/);
  }
  for (const event of ['opened', 'revealed', 'closed', 'expired']) {
    assert.equal(base(event).fields.some(field => field.name === 'Action'), false,
      event + ' must not duplicate its title with an Action field');
  }
  assert.equal(base('closed').title, 'Giveaway claim closed');
  assert.equal(base('expired').title, 'Giveaway auto expiry');
  assert.equal(base('closed').color, 0xFF7A00, 'manual Close keeps the existing orange line');
  assert.equal(base('expired').color, 0x7A1712, 'automatic expiry uses the standard Cloudy red line');
});

test('Close strips prior Claim/Reveal links only for that private claim, not other winners', () => {
  const opened = base('opened', 2);
  const result = replaceClosedClaimChannelMentions(opened, new Set([privateChannel]));
  assert.equal(result.changed, true);
  assert.equal(field(result.embed, 'Giveaway'), '#2');
  assert.equal(field(result.embed, 'Private channel'), '`' + privateChannel + '`');
  assert.equal(field(result.embed, 'Date'), field(opened, 'Date'));
  assert.equal(result.embed.color, opened.color);
  assert.deepEqual(result.embed.thumbnail, opened.thumbnail);
  assert.deepEqual(result.embed.footer, opened.footer);
  assert.equal(replaceClosedClaimChannelMentions(result.embed, new Set([privateChannel])).changed, false);
  assert.equal(replaceClosedClaimChannelMentions(opened, new Set(['156000000000000999'])).changed, false);
});

test('historical migration keeps #numbers/dates; title-only migration drops legacy Action', async () => {
  const w = world();
  const claims = { [first + ':' + winner]: { messageId: first, userId: winner,
    channelId: privateChannel, closedAt: actionTime } };
  w.records.set('guild:' + guildId + ':giveaway-claim:records', claims);
  const old = buildGiveawayClaimLog({
    event: 'expired', guildId, messageId: first, userId: winner,
    claimChannelId: privateChannel, giveaway: { prize: 'Lifetime access', channelId: publicChannel },
  }).embeds[0];
  old.title = 'Giveaway claim expired';
  old.color = 0xED4245;
  old.fields = old.fields.filter(item => item.name !== 'Date').map(item =>
    item.name === 'Giveaway'
      ? { ...item, value: '[Go to giveaway](' + originalLink(first) + ')' } : item);
  old.fields.splice(2, 0, { name: 'Action', value: 'Automatic close (24 hours)', inline: true });
  let edits = 0;
  const archived = {
    id: '156000000000000300', createdTimestamp: Date.parse(actionTime),
    author: { id: w.client.user.id }, embeds: [old],
    edit: async function(payload) { edits++; this.embeds = payload.embeds; },
  };
  const unrelated = {
    id: '156000000000000301', author: { id: w.client.user.id },
    embeds: [{ title: 'Other log', footer: { text: GIVEAWAY_CLAIM_LOG_FOOTER } }],
    edit: async () => { throw new Error('Unrelated log must stay untouched'); },
  };
  const audit = { messages: { fetch: async () =>
    new Collection([[archived.id, archived], [unrelated.id, unrelated]]) } };
  const guild = { id: guildId, channels: { cache: new Map([[GIVEAWAY_CLAIM_LOG_CHANNEL_ID, audit]]) } };
  w.client.guilds = { cache: new Map([[guildId, guild]]) };
  await refreshHistoricalGiveawayClaimNumbersAndDates(w.client);
  assert.equal(edits, 1);
  assert.equal(field(archived.embeds[0], 'Giveaway'), '#1');
  assert.equal(field(archived.embeds[0], 'Date'), '<t:1793754780:F>');
  await refreshGiveawayClaimTitlesWithoutAction(w.client);
  assert.equal(edits, 2);
  assert.equal(archived.embeds[0].title, 'Giveaway auto expiry');
  assert.equal(archived.embeds[0].color, 0x7A1712);
  assert.equal(archived.embeds[0].fields.some(item => item.name === 'Action'), false);
  assert.equal(field(archived.embeds[0], 'Giveaway'), '#1');
  assert.equal(field(archived.embeds[0], 'Date'), '<t:1793754780:F>');
  assert.deepEqual(archived.embeds[0].thumbnail, old.thumbnail);
  assert.equal(archived.embeds[0].footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
  await refreshHistoricalGiveawayClaimNumbersAndDates(w.client);
  await refreshGiveawayClaimTitlesWithoutAction(w.client);
  assert.equal(edits, 2);
  assert.equal(w.records.get('guild:' + guildId + ':giveaway-claim:number-date-v1'), true);
  assert.equal(w.records.get('guild:' + guildId + ':giveaway-claim:title-only-v1'), true);
});

test('older 24-hour auto-expiry logs update Action and red line in place without touching Close', async () => {
  const w = world();
  const archive = [];
  function message(event, color, authorId = w.client.user.id) {
    const data = base(event, 3);
    data.color = color;
    if (event === 'expired') {
      data.title = 'Giveaway claim expired';
      data.fields.splice(2, 0, { name: 'Action', value: 'Automatic · 24-hour expiry', inline: true });
    }
    const item = {
      id: String(156000000000000300n + BigInt(archive.length)),
      author: { id: authorId }, embeds: [data], edits: [],
      edit: async function(payload) {
        this.edits.push(payload);
        this.embeds = structuredClone(payload.embeds);
      },
    };
    archive.push(item);
    return item;
  }
  const expired = message('expired', 0xED4245);
  const manual = message('closed', 0xFF7A00);
  const active = message('opened', 0x00C49D);
  const anotherBot = message('expired', 0xED4245, 'another-bot');
  const original = structuredClone(expired.embeds[0]);
  const audit = { messages: { fetch: async () =>
    new Collection(archive.map(item => [item.id, item])) } };
  const guild = { id: guildId, channels: { cache: new Map([[GIVEAWAY_CLAIM_LOG_CHANNEL_ID, audit]]) } };
  w.client.guilds = { cache: new Map([[guildId, guild]]) };
  await refreshGiveawayAutoExpiryLogAction(w.client);
  assert.equal(expired.edits.length, 1);
  assert.equal(expired.embeds[0].color, 0x7A1712);
  assert.equal(field(expired.embeds[0], 'Action'), 'giveaway auto expiry');
  assert.deepEqual(expired.embeds[0].fields.filter(field => field.name !== 'Action'),
    original.fields.filter(field => field.name !== 'Action'));
  assert.deepEqual(expired.embeds[0].thumbnail, original.thumbnail);
  assert.deepEqual(expired.embeds[0].footer, original.footer);
  for (const item of [manual, active, anotherBot]) assert.equal(item.edits.length, 0);
  assert.equal(manual.embeds[0].title, 'Giveaway claim closed');
  assert.equal(manual.embeds[0].fields.some(item => item.name === 'Action'), false);
  await refreshGiveawayAutoExpiryLogAction(w.client);
  assert.equal(expired.edits.length, 1, 'the startup migration never repeats completed edits');
  assert.equal(w.records.get('guild:' + guildId + ':giveaway-claim:auto-expiry-action-v1'), true);
});
