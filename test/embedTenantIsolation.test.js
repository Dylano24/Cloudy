import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database/wrapper.js';
import { getSystemEmbedTemplateKey, primeSystemEmbedTemplateData, applyRuntimeEmbedTemplateData, applyTicketMainTemplateData, applyPlainResponseTemplate } from '../src/services/systemEmbedCatalogService.js';
import { reconcileEmbedRegistry, registerCloudyEmbedMessage, getEmbedRegistry, getEmbedRegistrySnapshot } from '../src/services/embedRegistryService.js';

test('saved runtime templates apply only within their guild', () => {
  const context = 'utility/tenant-isolation';
  const runtime = { title: 'Customer notice', description: 'Your notice' };
  const key = getSystemEmbedTemplateKey('embed', runtime.title, runtime.description, context);
  primeSystemEmbedTemplateData(key, context, { title: 'Guild A private policy', footer: { text: 'Private footer' } }, 'guild-a');
  assert.equal(applyRuntimeEmbedTemplateData(runtime, { guildId: 'guild-a', channel: { name: context } }).title, 'Guild A private policy');
  assert.deepEqual(applyRuntimeEmbedTemplateData(runtime, { guildId: 'guild-b', channel: { name: context } }), runtime);
});

test('saved ticket templates apply only within their guild', () => {
  primeSystemEmbedTemplateData('ticket-main', 'tickets/main', { title: 'A ticket #{dynamic}', description: 'Private policy' }, 'guild-a');
  assert.equal(applyTicketMainTemplateData({ title: 'Default' }, { guildId: 'guild-a', ticketNumber: '7' }).title, 'A ticket #7');
  assert.deepEqual(applyTicketMainTemplateData({ title: 'Default' }, { guildId: 'guild-b' }), { title: 'Default' });
});

test('saved plain responses apply only within their guild', () => {
  const context = 'utility/plain-isolation';
  const content = 'Your notice';
  const key = getSystemEmbedTemplateKey('content', '', content, context);
  primeSystemEmbedTemplateData(key, context, { title: 'Notice', description: 'Private response' }, 'guild-a');
  assert.equal(applyPlainResponseTemplate(content, { guildId: 'guild-a', channel: { name: context } }), 'Private response');
  assert.equal(applyPlainResponseTemplate(content, { guildId: 'guild-b', channel: { name: context } }), content);
});

test('background reconciliation cannot replace a manual Save made during its Discord fetch', async t => {
  const guildId = 'registry-save-race';
  const key = `cloudy:embed-registry:${guildId}`;
  const oldEmbed = new Embed({ title: 'Original title', description: 'old body' });
  const record = { guildId, channelId: 'channel', messageId: 'message', embedIndex: 0, source: 'embed-builder', manualSaved: true, title: 'Original title', name: 'Original title', snapshot: oldEmbed.toJSON(), createdAt: new Date().toISOString() };
  const store = new Map([[key, [record]]]);
  t.mock.property(db, 'initialized', true);
  t.mock.method(db, 'get', async storageKey => structuredClone(store.get(storageKey) ?? null));
  t.mock.method(db, 'set', async (storageKey, value) => { store.set(storageKey, structuredClone(value)); return true; });
  let releaseFetch;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseFetch = resolve; });
  const client = { user: { id: 'bot' } };
  const message = { guildId, channelId: 'channel', id: 'message', author: client.user, client, content: '', embeds: [oldEmbed], createdAt: new Date() };
  const channel = { id: 'channel', name: 'local', messages: { fetch: async () => { markStarted(); await gate; return message; } } };
  const guild = { id: guildId, client, channels: { cache: new Collection([['channel', channel]]) } };
  const reconciliation = reconcileEmbedRegistry(guild);
  await started;
  try {
    assert.equal(await registerCloudyEmbedMessage({ ...message, embeds: [new Embed({ title: 'Manually saved newer title', description: 'new body' })] }, 'embed-builder', { manualSave: true }), true);
  } finally {
    releaseFetch();
  }
  await reconciliation;
  const saved = (await getEmbedRegistry(guildId))[0];
  assert.equal(saved.snapshot.title, 'Manually saved newer title');
  assert.equal(getEmbedRegistrySnapshot(saved).description, 'new body');
});

test('an unavailable registry read cannot erase saved embeds during registration', async t => {
  t.mock.method(db, 'get', async (_key, _fallback, options) => {
    assert.deepEqual(options, { strict: true });
    throw new Error('registry read unavailable');
  });
  const writes = t.mock.method(db, 'set', async () => true);
  const client = { user: { id: 'bot' } };
  const message = { guildId: 'registry-read-failure', channelId: 'channel', id: 'message', client, author: client.user, embeds: [new Embed({ title: 'Saved policy', description: 'Private policy' })] };
  assert.equal(await registerCloudyEmbedMessage(message, 'embed-builder'), false);
  assert.equal(writes.mock.callCount(), 0);
});
