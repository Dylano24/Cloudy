import test from 'node:test';
import assert from 'node:assert/strict';
import { REST } from '@discordjs/rest';
import { Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { installCloudyFooterOutput, formatAppealFooter, snowflakeTimestamp } from '../src/utils/cloudyFooter.js';
import { normalizeCloudyEmbed } from '../src/services/cloudyBrandingService.js';
import { ensureAppealActions, appealReviewKey, buildAppealActions } from '../src/services/appealActionService.js';

const APPEAL_CHANNEL = '1554538665068200039';
// 30-10-2026 06:28 in Amsterdam (CET).
const POSTED = Date.parse('2026-10-30T05:28:30Z');
const snowflakeAt = ms => String(BigInt(ms - 1420070400000) << 22n);

function captureRest(t) {
  const prototype = REST.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'request');
  const captured = [];
  Object.defineProperty(prototype, 'request', { ...original, value: async options => { captured.push(options); return options; } });
  t.after(() => Object.defineProperty(prototype, 'request', original));
  installCloudyFooterOutput();
  return { rest: new REST(), captured };
}

test('message ID gives the original post time', () => {
  assert.equal(snowflakeTimestamp(snowflakeAt(POSTED)), POSTED);
  assert.ok(Number.isNaN(snowflakeTimestamp('@original')));
  assert.equal(formatAppealFooter(POSTED, POSTED + 60_000), '© Cloudy Inc. • Today at 06:28');
  assert.equal(formatAppealFooter(POSTED, POSTED + 86_400_000), '© Cloudy Inc. • 30/10/2026 06:28');
  assert.equal(formatAppealFooter(NaN), '© Cloudy Inc.');
});

test('appeal footer keeps the original time through post, repeated edits and a reset footer', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: POSTED + 5 * 60_000 });
  const { rest, captured } = captureRest(t);
  const messageId = snowflakeAt(POSTED);
  const route = `/channels/${APPEAL_CHANNEL}/messages/${messageId}`;
  const appeal = { title: 'Discord appeal — Ban', footer: { text: '© Cloudy Inc.' }, fields: [{ name: 'Evidence', value: 'None' }] };

  // New post: the embed timestamp is the post time.
  await rest.request({ fullRoute: `/channels/${APPEAL_CHANNEL}/messages`, method: 'POST', body: { embeds: [{ ...appeal, timestamp: new Date(POSTED).toISOString() }] } });
  const posted = captured.at(-1).body.embeds[0];
  assert.equal(posted.footer.text, '© Cloudy Inc. • Today at 06:28');
  assert.equal(posted.timestamp, undefined);
  assert.equal(normalizeCloudyEmbed(posted).changed, false);

  // An edit of the posted embed (no timestamp left) keeps the same footer.
  await rest.request({ fullRoute: route, method: 'PATCH', body: { embeds: [posted], components: [] } });
  assert.equal(captured.at(-1).body.embeds[0].footer.text, '© Cloudy Inc. • Today at 06:28');

  // Another layer reset the footer and dropped the time: the message ID restores it.
  await rest.request({ fullRoute: route, method: 'PATCH', body: { embeds: [{ ...appeal }] } });
  const restored = captured.at(-1).body.embeds[0];
  assert.equal(restored.footer.text, '© Cloudy Inc. • Today at 06:28');
  assert.equal(restored.timestamp, undefined);
  assert.deepEqual(restored.fields, appeal.fields);

  // A later timestamp on an edit never replaces the original post time.
  await rest.request({ fullRoute: route, method: 'PATCH', body: { embeds: [{ ...appeal, timestamp: new Date().toISOString() }] } });
  assert.equal(captured.at(-1).body.embeds[0].footer.text, '© Cloudy Inc. • Today at 06:28');

  // An edit on a later day shows the original date instead of a stale "Today".
  t.mock.timers.setTime(POSTED + 86_400_000);
  await rest.request({ fullRoute: route, method: 'PATCH', body: { embeds: [restored] } });
  assert.equal(captured.at(-1).body.embeds[0].footer.text, '© Cloudy Inc. • 30/10/2026 06:28');

  // An interaction-token edit without a known time keeps a footer that shows one.
  const token = { fullRoute: '/webhooks/123456789012345678/token/messages/@original', method: 'PATCH', body: { embeds: [restored] } };
  await rest.request(token);
  assert.equal(captured.at(-1).body.embeds[0].footer.text, '© Cloudy Inc. • Today at 06:28');
});

function startupFixture(embedData, createdTimestamp = POSTED) {
  const record = { id: 'CLD-TEST-FOOTER', guildId: 'appeal-footer-guild', channelId: APPEAL_CHANNEL, messageId: 'm', action: 'Ban', scope: 'discord', status: 'pending' };
  const values = new Map([[appealReviewKey(record.guildId, record.id), record]]);
  const storage = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); return true; } };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const edits = [];
  const message = {
    id: 'm', createdTimestamp, author: { id: 'bot' },
    components: buildAppealActions(record).map(row => ({ components: row.toJSON().components.map(button => ({ customId: button.custom_id })) })),
    embeds: [{ title: 'Discord appeal — Ban', description: `**Appeal ID:** ${record.id}`, fields: [], toJSON: () => structuredClone(embedData) }],
    edit: async payload => { edits.push(payload); },
  };
  const channel = { id: APPEAL_CHANNEL, guild: { id: record.guildId }, isTextBased: () => true, messages: { fetch: async () => new Collection([['m', message]]) } };
  const client = { user: { id: 'bot' }, db: storage, channels: { cache: new Collection([[APPEAL_CHANNEL, channel]]) } };
  return { client, edits };
}

test('restart repairs an appeal footer without time from the message creation time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: POSTED + 60_000 });
  const base = { title: 'Discord appeal — Ban', description: '**Appeal ID:** CLD-TEST-FOOTER', fields: [{ name: 'Evidence', value: 'None' }] };
  for (const broken of [{ footer: { text: '© Cloudy Inc.' } }, { footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }, { footer: { text: '© Cloudy Inc.' }, timestamp: new Date(POSTED).toISOString() }, {}]) {
    const { client, edits } = startupFixture({ ...base, ...broken });
    await ensureAppealActions(client);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].embeds[0].footer.text, '© Cloudy Inc. • Today at 06:28');
    assert.equal(edits[0].embeds[0].timestamp, undefined);
    assert.deepEqual(edits[0].embeds[0].fields, base.fields);
    assert.equal(edits[0].components, undefined);
  }
  // A footer that already shows the original time is not edited again.
  for (const text of ['© Cloudy Inc. • Today at 06:28', '© Cloudy Inc. • 30/10/2026 06:28']) {
    const { client, edits } = startupFixture({ ...base, footer: { text } });
    await ensureAppealActions(client);
    assert.equal(edits.length, 0);
  }
});
