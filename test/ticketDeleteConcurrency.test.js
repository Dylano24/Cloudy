import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getTicketData } from '../src/utils/database.js';
import { DELETE_DELAY_MS, deleteTicketSafely } from '../src/services/ticketDeleteService.js';

test('overlapping deletes recheck persisted state instead of reusing a stale ticket snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const guildId = 'delete-concurrency-guild';
  const channelId = 'delete-concurrency-channel';
  const ticket = { id: channelId, userId: 'creator', status: 'closed', transcriptArchivedAt: '2026-10-08T00:00:00.000Z' };
  const values = new Map([
    [`guild:${guildId}:ticket:${channelId}`, structuredClone(ticket)],
    [`guild:${guildId}:config`, { ticketLogsChannelId: 'logs', ticketTranscriptChannelId: 'transcripts' }],
  ]);
  t.mock.property(db, 'initialized', true);
  t.mock.method(db, 'get', async key => structuredClone(values.get(key) ?? null));
  t.mock.method(db, 'set', async (key, value) => { values.set(key, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async key => { values.delete(key); return true; });
  const notices = [];
  let deletions = 0;
  const client = { db: { get: key => db.get(key), isAvailable: () => true }, user: { id: 'cloudy' } };
  const guild = { id: guildId, channels: { cache: new Map(), fetch: async () => null } };
  client.guilds = { cache: new Map([[guildId, guild]]) };
  const channel = {
    id: channelId, guild, client,
    send: async payload => { notices.push(payload); return { id: `notice-${notices.length}`, delete: async () => {} }; },
    delete: async () => { deletions += 1; },
  };

  const results = await Promise.allSettled([
    deleteTicketSafely(channel, { id: 'staff' }, ticket),
    deleteTicketSafely(channel, { id: 'staff' }, ticket),
  ]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'TICKET_ALREADY_DELETED');
  assert.equal(notices.length, 1);
  assert.equal((await getTicketData(guildId, channelId)).status, 'deleted');
  t.mock.timers.tick(DELETE_DELAY_MS);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(deletions, 1);
});
