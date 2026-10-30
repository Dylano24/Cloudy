import test from 'node:test';
import assert from 'node:assert/strict';
import { REST } from '@discordjs/rest';
import { Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { installCloudyFooterOutput, CLOUDY_STANDARD_FOOTER } from '../src/utils/cloudyFooter.js';
import { normalizeCloudyEmbed } from '../src/services/cloudyBrandingService.js';
import { ensureAppealActions, appealReviewKey, buildAppealActions, handledAppealFields } from '../src/services/appealActionService.js';

const APPEAL_CHANNEL = '1554538665068200039';
const REVIEWED = Date.parse('2026-10-30T05:46:10Z');
const HANDLED_AT = `<t:${Math.floor(REVIEWED / 1000)}:F>`;
const answer = (value = 'Sjsj') => ({ name: 'Additional information', value, inline: false });
const decision = { name: 'Handled by', value: '<@staff>\nThe member has been unmuted.', inline: false };
const oldDecision = { name: 'Staff decision', value: 'Unmuted by <@staff>', inline: false };
const reason = { name: 'Reason', value: 'rwyhtegr', inline: false };
const handledAt = { name: 'Appeal handled at', value: HANDLED_AT, inline: false };

test('appeal embeds always leave with the normal Cloudy footer and no time', async t => {
  const prototype = REST.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'request');
  const captured = [];
  Object.defineProperty(prototype, 'request', { ...original, value: async options => { captured.push(options); return options; } });
  t.after(() => Object.defineProperty(prototype, 'request', original));
  installCloudyFooterOutput();
  const rest = new REST();
  const appeal = { title: 'Discord appeal — Mute', fields: [answer()] };
  for (const footer of [{ text: '© Cloudy Inc.' }, { text: '© Cloudy Inc. • Today at 06:46' }, { text: CLOUDY_STANDARD_FOOTER }, undefined]) {
    for (const [route, method] of [[`/channels/${APPEAL_CHANNEL}/messages`, 'POST'], [`/channels/${APPEAL_CHANNEL}/messages/1554538665068200040`, 'PATCH']]) {
      await rest.request({ fullRoute: route, method, body: { embeds: [{ ...appeal, footer, timestamp: new Date(REVIEWED).toISOString() }] } });
      const sent = captured.at(-1).body.embeds[0];
      assert.deepEqual(sent.footer, { text: CLOUDY_STANDARD_FOOTER });
      assert.equal(sent.timestamp, undefined);
      assert.deepEqual(sent.fields, appeal.fields);
      assert.equal(normalizeCloudyEmbed(sent, { ensureFooter: true }).changed, false);
    }
  }
});

test('handled layout: Appeal handled at sits where the handled notice was, before Handled by', () => {
  const expected = [answer(), handledAt, decision, reason];
  // Older layouts: notice merged with Staff decision, notice alone, separate notice field.
  assert.deepEqual(handledAppealFields([answer('Sjsj\n\n**This appeal has been handled**\n\n**Staff decision**\nUnmuted by <@staff>'), reason], REVIEWED), expected);
  assert.deepEqual(handledAppealFields([answer('Sjsj\n\n**This appeal has been handled**'), oldDecision, reason], REVIEWED), expected);
  assert.deepEqual(handledAppealFields([answer(), { name: 'This appeal has been handled', value: '​', inline: false }, oldDecision, reason], REVIEWED), expected);
  // Already converted stays the same; the earlier Handled at label is renamed.
  assert.deepEqual(handledAppealFields(expected, REVIEWED), expected);
  assert.deepEqual(handledAppealFields([answer(), { ...handledAt, name: 'Handled at' }, oldDecision, reason], REVIEWED), expected);
  // Staff decision becomes Handled by with the outcome below the tag.
  assert.deepEqual(handledAppealFields([answer(), handledAt, oldDecision, reason], REVIEWED), expected);
  assert.deepEqual(handledAppealFields([answer(), handledAt, { ...oldDecision, value: 'Unbanned by <@staff>' }, reason], REVIEWED)[2],
    { name: 'Handled by', value: '<@staff>\nThe member has been unbanned.', inline: false });
  assert.deepEqual(handledAppealFields([answer(), handledAt, { ...oldDecision, value: 'Denied by <@staff>' }, reason], REVIEWED)[2],
    { name: 'Handled by', value: "<@staff>\nThe member's appeal has been denied.", inline: false });
});

function startupFixture(embedData, record) {
  const values = new Map([[appealReviewKey(record.guildId, record.id), record]]);
  const storage = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); return true; } };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const edits = [];
  const message = {
    id: 'm', author: { id: 'bot' },
    components: record.status === 'pending' ? buildAppealActions(record).map(row => ({ components: row.toJSON().components.map(button => ({ customId: button.custom_id })) })) : [],
    embeds: [{ title: 'Discord appeal — Mute', description: `**Appeal ID:** ${record.id}`, fields: [], toJSON: () => structuredClone(embedData) }],
    edit: async payload => { edits.push(payload); embedData = payload.embeds?.[0] || embedData; },
  };
  const channel = { id: APPEAL_CHANNEL, guild: { id: record.guildId }, isTextBased: () => true, messages: { fetch: async () => new Collection([['m', message]]) } };
  const client = { user: { id: 'bot' }, db: storage, channels: { cache: new Collection([[APPEAL_CHANNEL, channel]]) } };
  return { client, edits };
}

test('restart moves existing appeals to the new layout once, with the saved review time', async () => {
  const base = { title: 'Discord appeal — Mute', description: '**Appeal ID:** CLD-TEST' };
  const handled = { id: 'CLD-TEST', guildId: 'appeal-layout-guild', channelId: APPEAL_CHANNEL, messageId: 'm', action: 'Mute', scope: 'discord', status: 'approved', reviewedAt: new Date(REVIEWED).toISOString() };
  const { client, edits } = startupFixture({ ...base, footer: { text: '© Cloudy Inc. • Today at 06:46' },
    fields: [answer('Sjsj\n\n**This appeal has been handled**\n\n**Staff decision**\nUnmuted by <@staff>'), reason] }, handled);
  await ensureAppealActions(client);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].embeds[0].footer, { text: CLOUDY_STANDARD_FOOTER });
  assert.deepEqual(edits[0].embeds[0].fields, [answer(), handledAt, decision, reason]);
  assert.equal(edits[0].components, undefined);
  // The next restart finds nothing left to change.
  await ensureAppealActions(client);
  assert.equal(edits.length, 1);

  // Pending appeals only get the footer; without a saved review time nothing is guessed.
  for (const record of [{ ...handled, status: 'pending' }, { ...handled, reviewedAt: undefined }]) {
    const fields = [answer('Sjsj\n\n**This appeal has been handled**')];
    const run = startupFixture({ ...base, footer: { text: '© Cloudy Inc.' }, timestamp: new Date(REVIEWED).toISOString(), fields }, record);
    await ensureAppealActions(run.client);
    assert.equal(run.edits.length, 1);
    assert.deepEqual(run.edits[0].embeds[0].footer, { text: CLOUDY_STANDARD_FOOTER });
    assert.equal(run.edits[0].embeds[0].timestamp, undefined);
    assert.deepEqual(run.edits[0].embeds[0].fields, fields);
  }
});
