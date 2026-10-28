import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { resolveUpdatedMessage } from '../src/utils/updatedMessage.js';
import { clearKnownMissingKeys, db, deleteFromDb, getFromDb, setInDb } from '../src/utils/database/wrapper.js';
import { enforceProtectedIdentityProfile } from '../src/services/protectedIdentityService.js';
import { enforceAutomodProtection } from '../src/services/automodProtectionService.js';

test('edited partial messages are fetched once for all listeners, and never for a member\'s message in Cloudy-only listeners', async () => {
  let fetches = 0;
  const client = { user: { id: 'cloudy' } };
  const partial = { id: '1300000000000000701', partial: true, client,
    fetch: async () => { fetches += 1; await new Promise(resolve => { setTimeout(resolve, 5); }); return { id: '1300000000000000701', partial: false, client, author: { id: 'cloudy' } }; } };
  const results = await Promise.all([
    resolveUpdatedMessage(partial, { cloudyOnly: true }),
    resolveUpdatedMessage(partial, { cloudyOnly: true }),
    resolveUpdatedMessage(partial),
  ]);
  assert.equal(fetches, 1, 'six listeners used to fetch the same message six times');
  assert.ok(results.every(message => message?.author?.id === 'cloudy'));

  // Author already known to be a member: Cloudy-only listeners do not fetch.
  const member = { id: '1300000000000000702', partial: true, client, author: { id: 'member' }, fetch: async () => { fetches += 1; } };
  assert.equal(await resolveUpdatedMessage(member, { cloudyOnly: true }), null);
  assert.equal(fetches, 1);

  // Unknown author that turns out to be a member: not handed to Cloudy-only listeners.
  const unknown = { id: '1300000000000000703', partial: true, client, fetch: async () => ({ id: '1300000000000000703', client, author: { id: 'member' } }) };
  assert.equal(await resolveUpdatedMessage(unknown, { cloudyOnly: true }), null);
  assert.equal((await resolveUpdatedMessage(unknown))?.author?.id, 'member');
});

test('a channel without Reappear rules no longer costs a database read on every message', async t => {
  clearKnownMissingKeys();
  const values = new Map();
  let reads = 0;
  const storage = {
    get: async (key, fallback) => { reads += 1; return values.has(key) ? values.get(key) : fallback ?? null; },
    set: async (key, value) => { values.set(key, value); return true; },
    delete: async key => values.delete(key),
  };
  const previous = { db: db.db, initialized: db.initialized, useFallback: db.useFallback, connectionType: db.connectionType };
  db.db = storage; db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  t.after(() => Object.assign(db, previous));
  const key = 'cloudy:embed-reappear-index:guild:quiet-channel';

  for (let index = 0; index < 5; index += 1) assert.deepEqual(await getFromDb(key, []), []);
  assert.equal(reads, 1, 'absent index is remembered');

  // A rule is created: the very next message sees it.
  await setInDb(key, ['1300000000000000801']);
  assert.deepEqual(await getFromDb(key, []), ['1300000000000000801']);
  await deleteFromDb(key);
  const readsBeforeDelete = reads;
  assert.deepEqual(await getFromDb(key, []), []);
  assert.equal(reads - readsBeforeDelete, 1, 'a delete is read through again, never served from stale memory');

  // A write that lands while a read is in flight never leaves "absent" behind.
  clearKnownMissingKeys();
  const raceKey = 'cloudy:embed-reappear-index:guild:race-channel';
  let releaseRead;
  storage.get = async (readKey, fallback) => {
    reads += 1;
    if (readKey === raceKey && !values.has(raceKey)) await new Promise(resolve => { releaseRead = resolve; });
    return values.has(readKey) ? values.get(readKey) : fallback ?? null;
  };
  const slowRead = getFromDb(raceKey, []);
  await new Promise(resolve => { setImmediate(resolve); });
  values.set(raceKey, ['racing']);
  await setInDb(raceKey, ['1300000000000000802']);
  values.delete(raceKey);
  releaseRead();
  await slowRead;
  values.set(raceKey, ['1300000000000000802']);
  assert.deepEqual(await getFromDb(raceKey, []), ['1300000000000000802']);

  // Ordinary keys are untouched by this cache.
  const readsBeforeOrdinary = reads;
  await getFromDb('guild:other:something', null);
  await getFromDb('guild:other:something', null);
  assert.equal(reads - readsBeforeOrdinary, 2);
});

test('a protected-identity ban is logged in the current ban-logs channel when the old channel ID is gone', async () => {
  const sent = [];
  const banLogs = { id: 'new-ban-logs', name: 'ban-logs', type: ChannelType.GuildText, rawPosition: 1,
    isTextBased: () => true, send: async payload => { sent.push(payload); return payload; } };
  const guild = {
    id: '1532882647838228723', ownerId: 'owner',
    channels: {
      cache: new Collection([[banLogs.id, banLogs]]),
      fetch: async id => (id ? null : new Collection([[banLogs.id, banLogs]])),
    },
    members: { me: { permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers) } },
  };
  const client = { user: { id: 'cloudy' }, channels: { fetch: async () => null }, guilds: { cache: new Collection([[guild.id, guild]]) } };
  let banned = false;
  const member = {
    id: 'impostor', guild, client, bannable: true, displayName: 'Dylano Piazzini', nickname: null,
    user: { id: 'impostor', tag: 'impostor#0001', username: 'impostor', globalName: 'Dylano Piazzini', displayAvatarURL: () => null },
    ban: async () => { banned = true; },
  };
  assert.equal(await enforceProtectedIdentityProfile(member), true);
  assert.equal(banned, true);
  assert.equal(sent.length, 1, 'the ban log must not be lost when the legacy channel ID no longer exists');
  assert.equal(sent[0].embeds[0].toJSON().title, 'Automod account banned');
});

test('image moderation pauses after an invalid API key instead of failing on every image', async t => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'expired-key';
  t.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('{}', { status: 401 }); });
  const message = id => ({
    id, guild: { id: 'auth-guild' }, channel: { id: 'images' }, client: { user: { id: 'cloudy' } }, author: { id: `poster-${id}` },
    member: { permissions: new PermissionsBitField() }, content: '', embeds: [],
    attachments: new Collection([['a', { url: `https://cdn.discordapp.com/attachments/1/2/${id}.png`, contentType: 'image/png', name: `${id}.png` }]]),
  });
  assert.equal(await enforceAutomodProtection(message('one')), false);
  assert.equal(await enforceAutomodProtection(message('two')), false);
  assert.equal(calls, 1);
});
