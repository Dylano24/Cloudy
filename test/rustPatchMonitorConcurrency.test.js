import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, Events } from 'discord.js';
import { startRustPatchNotes } from '../src/services/rustPatchNotesService.js';

const CHANNEL_ID = '1533886914459861103';
const POLL_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const feed = '<rss><channel><item><title>Test official patch</title><link>https://rust.facepunch.com/news/test-official-patch</link><category>devblog</category><description>Official patch text</description></item></channel></rss>';
const response = () => ({ ok: true, text: async () => feed });
const settle = () => new Promise(resolve => { setImmediate(resolve); });

function fixture({ ready = true, channelPresent = true } = {}) {
  const history = new Collection();
  const stored = new Map();
  const sent = [];
  const reads = [];
  const client = new EventEmitter();
  const channel = {
    id: CHANNEL_ID,
    isTextBased: () => true,
    messages: { fetch: async () => history },
    send: async payload => {
      sent.push(payload);
      const embeds = payload.embeds.map(embed => ({ ...embed.toJSON(), toJSON: () => embed.toJSON() }));
      const message = { id: `patch-${sent.length}`, author: { id: client.user.id }, embeds };
      history.set(message.id, message);
      return message;
    },
  };
  client.user = { id: 'cloudy' };
  client.isReady = () => ready;
  client.channels = {
    cache: new Collection(channelPresent ? [[CHANNEL_ID, channel]] : []),
    fetch: async () => null,
  };
  client.guilds = { cache: new Collection() };
  client.db = {
    get: async key => { reads.push(key); return stored.get(key); },
    set: async (key, value) => { stored.set(key, value); },
  };
  return { client, sent, reads, channel };
}

test('concurrent ready and app starts share one initial check, post and interval', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let releaseFetch;
  const fetchMock = t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { releaseFetch = resolve; }));
  const f = fixture();

  startRustPatchNotes(f.client);
  startRustPatchNotes(f.client);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 1);
  releaseFetch(response());
  await settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.reads.length, 1);

  fetchMock.mock.mockImplementation(async () => response());
  t.mock.timers.tick(POLL_MS - 1);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(f.reads.length, 2);
  assert.equal(f.sent.length, 1);
});

test('repeated starts before readiness register one ready callback', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());
  const f = fixture({ ready: false });

  startRustPatchNotes(f.client);
  startRustPatchNotes(f.client);
  assert.equal(f.client.listenerCount(Events.ClientReady), 1);
  assert.equal(fetchMock.mock.callCount(), 0);
  f.client.emit(Events.ClientReady);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(f.sent.length, 1);
});

test('slow interval checks share their in-flight request and resume after completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());
  const f = fixture();
  startRustPatchNotes(f.client);
  await settle();

  let releaseFetch;
  fetchMock.mock.mockImplementation(() => new Promise(resolve => { releaseFetch = resolve; }));
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 2);
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 2);
  releaseFetch(response());
  await settle();

  fetchMock.mock.mockImplementation(async () => response());
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 3);
  assert.equal(f.sent.length, 1);
});

test('failed startup keeps the one-minute retry and shares it with an overlapping poll', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());
  const f = fixture({ channelPresent: false });
  startRustPatchNotes(f.client);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 1);

  let releaseFetch;
  fetchMock.mock.mockImplementation(() => new Promise(resolve => { releaseFetch = resolve; }));
  f.client.channels.cache.set(CHANNEL_ID, f.channel);
  t.mock.timers.tick(RETRY_MS - 1);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 2);
  t.mock.timers.tick(POLL_MS - RETRY_MS);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 2);
  releaseFetch(response());
  await settle();
  assert.equal(f.sent.length, 1);
});

test('a separate client gets its own monitor instead of sharing another client state', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());
  const a = fixture();
  const b = fixture();
  startRustPatchNotes(a.client);
  startRustPatchNotes(b.client);
  await settle();
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
});
