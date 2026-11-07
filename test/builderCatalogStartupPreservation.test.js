import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import diagnostic from '../src/events/gamingCatalogDiagnosticReady.js';
import { ensureSystemEmbedCatalogs } from '../src/services/systemEmbedCatalogService.js';

const settle = () => new Promise(resolve => { setImmediate(resolve); });

test('startup diagnostics never delete a saved orphan or overwrite a concurrent registry Save', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const record = {source: 'system-catalog', messageId: 'old-id', explicitSave: true,
    snapshot: {title: 'My panel', description: 'Keep  my spacing', image: {url: 'https://example.test/original.gif'}}};
  const storage = new Map([['cloudy:embed-registry:diagnostic-preserve', [record]],
    ['cloudy:system-embed-catalog:diagnostic-preserve', ['current-id']]]);
  const writes = [];
  t.mock.method(db, 'get', async key => structuredClone(storage.get(key) ?? null));
  t.mock.method(db, 'set', async (key, value) => {writes.push(key); storage.set(key, structuredClone(value)); return true;});
  const guild = {id: 'diagnostic-preserve', channels: {cache: new Map()}};
  diagnostic.execute({guilds: {cache: new Map([[guild.id, guild]])}});
  const concurrent = {source: 'embed-builder', messageId: 'new-save', explicitSave: true, snapshot: {title: 'Just saved'}};
  storage.get('cloudy:embed-registry:' + guild.id).push(concurrent);
  t.mock.timers.tick(40000);
  await settle();
  await settle();
  assert.deepEqual(writes, [], 'diagnostics are read-only even when catalog IDs look orphaned');
  assert.deepEqual(storage.get('cloudy:embed-registry:' + guild.id), [record, concurrent]);
});

test('a failed catalog history read aborts initialization without replacing stored catalog IDs', async t => {
  const id = 'startup-read-failure';
  const storage = new Map([['cloudy:system-embed-catalog:' + id, ['1532882647838228723']]]);
  const writes = [];
  t.mock.method(db, 'get', async key => structuredClone(storage.get(key) ?? null));
  t.mock.method(db, 'set', async (key, value) => {writes.push(key); storage.set(key, structuredClone(value)); return true;});
  let sends = 0;
  const channel = {id: 'botlog', name: 'botlog', position: 0, isTextBased: () => true, isSendable: () => true,
    messages: {fetch: async () => {throw new Error('Discord temporarily unavailable');}},
    send: async () => {sends++; throw new Error('Must not create a replacement catalog');}};
  const guild = {id, channels: {cache: new Map([[channel.id, channel]])}};
  await assert.rejects(ensureSystemEmbedCatalogs({guilds: {cache: new Map([[id, guild]])}}), /Discord temporarily unavailable/);
  assert.deepEqual(storage.get('cloudy:system-embed-catalog:' + id), ['1532882647838228723']);
  assert.equal(writes.includes('cloudy:system-embed-catalog:' + id), false);
  assert.equal(sends, 0);
});
