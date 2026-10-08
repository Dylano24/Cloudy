import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import feedbackHandlers from '../src/interactions/buttons/ticket/ticketFeedback.js';
import { db } from '../src/utils/database.js';

const handler = feedbackHandlers.find(candidate => candidate.name === 'ticket_feedback');
let sequence = 0;

function fixture(t, { writeFails = false } = {}) {
  const guildId = `legacy-feedback-guild-${++sequence}`;
  const channelId = 'legacy-ticket';
  const ownerId = 'feedback-owner';
  const originalInitialization = db.initialized;
  db.initialized = true;
  t.after(() => { db.initialized = originalInitialization; });
  let stored = { id: '42', userId: ownerId, status: 'closed', feedback: { comment: 'Helpful staff' } };
  let writes = 0;
  let logLookups = 0;
  const payloads = [];
  t.mock.method(db, 'get', async key => {
    assert.equal(key, `guild:${guildId}:ticket:${channelId}`);
    return structuredClone(stored);
  });
  t.mock.method(db, 'set', async (_key, value) => {
    writes++;
    if (writeFails) return false;
    stored = structuredClone(value);
    return true;
  });
  const client = { guilds: { cache: new Collection(), fetch: async () => { logLookups++; return null; } } };
  const interaction = () => ({
    id: `feedback-interaction-${sequence}`, user: { id: ownerId }, client,
    createdTimestamp: Date.now(), deferred: false,
    deferUpdate: async function () { this.deferred = true; },
    editReply: async payload => { payloads.push(payload); },
  });
  return { guildId, channelId, client, interaction, payloads,
    stored: () => stored, writes: () => writes, logLookups: () => logLookups };
}

test('legacy feedback button never reports or logs success after a rejected save', async t => {
  const f = fixture(t, { writeFails: true });
  await handler.execute(f.interaction(), f.client, [f.guildId, f.channelId, '5']);
  assert.equal(f.stored().feedback.rating, undefined);
  assert.equal(f.logLookups(), 0);
  assert.equal(f.payloads[0].embeds[0].toJSON().title, 'Feedback Not Saved');
});

test('concurrent legacy feedback buttons save once and preserve an existing comment', async t => {
  const f = fixture(t);
  await Promise.all([
    handler.execute(f.interaction(), f.client, [f.guildId, f.channelId, '4']),
    handler.execute(f.interaction(), f.client, [f.guildId, f.channelId, '5']),
  ]);
  assert.equal(f.writes(), 1);
  assert.equal(f.stored().feedback.comment, 'Helpful staff');
  assert.equal(f.stored().feedback.rating, 4);
  assert.equal(f.logLookups(), 1);
  const titles = f.payloads.map(payload => payload.embeds[0].toJSON().title);
  assert.deepEqual(titles.sort(), ['Already Submitted', 'Thanks for your feedback!'].sort());
  const successful = f.payloads.find(payload => payload.embeds[0].toJSON().title === 'Thanks for your feedback!');
  assert.equal(successful.embeds[0].toJSON().description,
    'You rated your support experience ** 4 — Good**.\n\nYour feedback has been recorded and helps us improve!');
});
