import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { getOrCreateGiveawayNumber } from '../src/services/giveawayNumberService.js';
import {
  buildGiveawayClaimLog, GIVEAWAY_CLAIM_LOG_CHANNEL_ID, GIVEAWAY_CLAIM_LOG_FOOTER,
  replaceClosedClaimChannelMentions, refreshHistoricalGiveawayClaimNumbersAndDates,
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
  assert.equal(field(base('closed'), 'Action'), 'Close');
  assert.equal(field(base('expired'), 'Action'), 'Automatic · 24-hour expiry');
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

test('one-time migration updates historical links, original dates and automatic action in place', async () => {
  const w = world();
  const claims = { [first + ':' + winner]: { messageId: first, userId: winner,
    channelId: privateChannel, closedAt: actionTime } };
  w.records.set('guild:' + guildId + ':giveaway-claim:records', claims);
  const old = buildGiveawayClaimLog({
    event: 'expired', guildId, messageId: first, userId: winner,
    claimChannelId: privateChannel, giveaway: { prize: 'Lifetime access', channelId: publicChannel },
  }).embeds[0];
  old.fields = old.fields.filter(item => item.name !== 'Date').map(item =>
    item.name === 'Action' ? { ...item, value: 'Automatic close (24 hours)' }
      : item.name === 'Giveaway'
        ? { ...item, value: '[Go to giveaway](' + originalLink(first) + ')' } : item);
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
  assert.equal(field(archived.embeds[0], 'Action'), 'Automatic · 24-hour expiry');
  assert.equal(field(archived.embeds[0], 'Date'), '<t:1793754780:F>');
  assert.deepEqual(archived.embeds[0].thumbnail, old.thumbnail);
  assert.equal(archived.embeds[0].footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
  await refreshHistoricalGiveawayClaimNumbersAndDates(w.client);
  assert.equal(edits, 1);
  assert.equal(w.records.get('guild:' + guildId + ':giveaway-claim:number-date-v1'), true);
});
