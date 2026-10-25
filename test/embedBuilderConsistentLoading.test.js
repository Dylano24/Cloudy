import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry, peekEmbedRegistry, removeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';
import { openEmbedManager, prepareEmbedManager } from '../src/services/embedManagerService.js';
import { loadEmbedBuilderSearchSelection } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import * as latency from '../src/utils/interactionLatency.js';

const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function savedRecord(guildId, manualSaved = true) {
  return {
    guildId, channelId: '111111111111111111', messageId: '222222222222222222',
    embedIndex: 0, source: 'embed-builder', manualSaved,
    title: 'Rules panel', name: 'Rules panel',
    snapshot: {
      title: 'Rules panel', description: 'Exact saved body', color: 0x123456,
      fields: [{ name: 'Rules', value: 'Every field remains available', inline: true }],
      footer: { text: 'Exact footer' }, image: { url: 'https://example.com/rules.gif' },
      thumbnail: { url: 'https://example.com/logo.png' },
    },
    components: [{ type: 1, components: [
      { type: 2, style: 2, label: 'Rules', custom_id: 'same_rules_action' },
    ] }],
  };
}
function managerFixture(t, record) {
  const collector = new EventEmitter();
  collector.stop = reason => {
    if (collector.ended) return;
    collector.ended = true;
    collector.emit('end', [], reason);
  };
  const message = {
    id: record.messageId, guildId: record.guildId, channelId: record.channelId,
    author: { id: 'cloudy' }, flags: { has: () => false }, embeds: [record.snapshot],
    components: record.components, createdAt: new Date('2026-10-25T00:00:00Z'),
  };
  let pageGate = null;
  let messageGate = null;
  let messageReads = 0;
  const channel = {
    id: record.channelId, guildId: record.guildId, name: 'rules', type: 0,
    rawPosition: 0, toString: () => '#rules', permissionsFor: () => ({ has: () => true }),
    messages: {
      cache: new Collection(),
      fetch: async options => {
        if (options?.limit) {
          if (pageGate) return pageGate.promise;
          channel.messages.cache.set(message.id, message);
          const page = new Collection([[message.id, message]]);
          return page;
        }
        messageReads++;
        if (messageGate) return messageGate.promise;
        return message;
      },
    },
  };
  const guild = {
    id: record.guildId, client: { user: { id: 'cloudy' } },
    channels: { cache: new Collection([[channel.id, channel]]) },
  };
  const manager = { id: 'manager-' + record.guildId, delete: async () => {},
    createMessageComponentCollector: () => collector };
  const paints = [];
  const state = {};
  let preview;
  const opening = {
    guildId: guild.id, guild, client: guild.client,
    member: { id: 'owner' }, user: { id: 'owner' },
    async reply(payload) { paints.push(payload); this.replied = true; return { resource: { message: manager } }; },
    async deferUpdate() { this.deferred = true; },
    webhook: { deleteMessage: async () => {}, editMessage: async (_id, payload) => { paints.push(payload); } },
  };
  t.after(() => collector.stop('test-completed'));
  const click = (customId, value) => {
    const payloads = [];
    const interaction = {
      guild, guildId: guild.id, member: { id: 'owner' }, user: { id: 'owner' },
      customId, values: value == null ? [] : [value], deferred: false, replied: false,
      isStringSelectMenu: () => value != null,
      async deferUpdate() { this.deferred = true; },
      async update(payload) { this.replied = true; payloads.push(payload); },
      async editReply(payload) { payloads.push(payload); },
    };
    collector.emit('collect', interaction);
    return payloads;
  };
  return {
    state, channel, guild, opening, paints, message,
    refresh: async () => { preview = structuredClone({
      title: state.title, message: state.message, fields: state.embedFields,
      footer: state.bottomLine, media: state.mediaUrl, components: state.componentRows,
      target: state.modifyTarget?.channelId,
    }); },
    preview: () => preview,
    messageReads: () => messageReads,
    stallPage: gate => { pageGate = gate; },
    stallMessage: gate => { messageGate = gate; },
    chooseChannel: () => click('simple_embed_modify_channel:0', channel.id),
    chooseEmbed: () => click('simple_embed_modify_embed:' + channel.id + ':0', message.id + ':0'),
    back: () => click('simple_embed_modify_back'),
  };
}
function embedChoices(payload) {
  return (payload?.components || []).flatMap(row => {
    const data = row.toJSON?.() || row;
    return (data.components || []).flatMap(component =>
      component.custom_id?.startsWith('simple_embed_modify_embed:') ? component.options || [] : []);
  });
}

test('warm manager renders complete saved choices while an unrelated preload read is stalled', async t => {
  const record = savedRecord('manager-warm-stalled-preload');
  t.mock.method(db, 'get', async () => [record]);
  await getEmbedRegistry(record.guildId);
  const fixture = managerFixture(t, record);
  const gate = deferred();
  t.mock.method(db, 'get', async () => gate.promise);
  prepareEmbedManager(fixture.guild, fixture.state);
  const opening = openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  t.after(async () => { gate.resolve([record]); await opening; fixture.state.activeEmbedManager?.collector.stop(); });
  await settle();
  assert.equal(fixture.paints.length, 1, 'a verified in-memory registry must paint before the stalled preload resolves');
  assert.equal(fixture.paints[0].components[0].toJSON().components[0].options[0].description, '1 embed');
});

test('strict registry peek rejects snapshots invalidated by deletion and returns copies', async t => {
  const record = savedRecord('manager-cache-delete-generation');
  let stored = [record];
  t.mock.method(db, 'get', async () => structuredClone(stored));
  t.mock.method(db, 'set', async (_key, value) => { stored = value; return true; });
  await getEmbedRegistry(record.guildId);
  const first = peekEmbedRegistry(record.guildId, { current: true });
  first[0].snapshot.title = 'Local draft';
  assert.equal(peekEmbedRegistry(record.guildId, { current: true })[0].snapshot.title, 'Rules panel');
  await removeEmbedRegistryRecord(record.guildId, record.channelId, record.messageId);
  assert.equal(peekEmbedRegistry(record.guildId, { current: true }), null,
    'a pre-delete cache cannot satisfy a fresh channel browser');
  await getEmbedRegistry(record.guildId);
  assert.equal(peekEmbedRegistry(record.guildId, { current: true })[0].detached, true,
    'the deliberately saved template survives physical message deletion');
});

test('returning to a channel keeps verified live choices visible while Discord refresh is stalled', async t => {
  const record = savedRecord('manager-live-channel-revisit', false);
  t.mock.method(db, 'get', async () => []);
  t.mock.method(db, 'set', async () => assert.fail('browsing must not save records'));
  const fixture = managerFixture(t, record);
  await openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  fixture.chooseChannel();
  await settle();
  const gate = deferred();
  fixture.stallPage(gate);
  t.after(() => gate.resolve(new Collection()));
  const payloads = fixture.chooseChannel();
  await settle();
  assert.ok(embedChoices(payloads[0]).some(option => option.value === record.messageId + ':0'),
    'the first channel update must retain current cached physical messages');
});

test('channel preview uses the current Discord cache with full fields and buttons before another REST round trip', async t => {
  const record = savedRecord('manager-live-message-preview', false);
  t.mock.method(db, 'get', async () => []);
  t.mock.method(db, 'set', async () => assert.fail('previewing must not save records'));
  const fixture = managerFixture(t, record);
  await openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  fixture.chooseChannel();
  await settle();
  const gate = deferred();
  fixture.stallMessage(gate);
  t.after(() => gate.resolve(fixture.message));
  fixture.chooseEmbed();
  await settle();
  assert.equal(fixture.preview()?.title, 'Rules panel');
  assert.equal(fixture.preview().message, 'Exact saved body');
  assert.deepEqual(fixture.preview().fields, record.snapshot.fields);
  assert.deepEqual(fixture.preview().components, record.components);
  assert.equal(fixture.preview().footer, 'Exact footer');
  assert.equal(fixture.preview().media, 'https://example.com/rules.gif');
  assert.equal(fixture.preview().target, record.channelId);
  assert.equal(fixture.messageReads(), 0, 'the already cached message supplies the complete first preview');
});

test('an unsaved message removed from the Discord cache is not revived on channel revisit', async t => {
  const record = savedRecord('manager-deleted-live-message', false);
  t.mock.method(db, 'get', async () => []);
  const fixture = managerFixture(t, record);
  await openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  fixture.chooseChannel();
  await settle();
  fixture.channel.messages.cache.delete(record.messageId);
  const gate = deferred();
  fixture.stallPage(gate);
  t.after(() => gate.resolve(new Collection()));
  const payloads = fixture.chooseChannel();
  await settle();
  assert.deepEqual(embedChoices(payloads[0]), []);
});

test('an older pending preview cannot overwrite a newer manager selection', async t => {
  const record = savedRecord('manager-preview-selection-race', false);
  t.mock.method(db, 'get', async () => []);
  const fixture = managerFixture(t, record);
  await openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  fixture.chooseChannel();
  await settle();
  fixture.channel.messages.cache.clear();
  const gate = deferred();
  fixture.stallMessage(gate);
  fixture.chooseEmbed();
  await settle();
  fixture.back();
  fixture.state.title = 'Newer draft';
  gate.resolve(fixture.message);
  await settle();
  assert.equal(fixture.state.title, 'Newer draft');
});

test('complete saved Search preview does not wait for cold template scopes or scan unrelated previews', async t => {
  const record = savedRecord('search-saved-cold-scopes');
  t.mock.method(db, 'get', async () => [record]);
  await getEmbedRegistry(record.guildId);
  const gate = deferred();
  t.after(() => gate.resolve({}));
  t.mock.method(db, 'get', async () => gate.promise);
  t.mock.method(db, 'set', async () => assert.fail('Search preview must not save data'));
  const fixture = managerFixture(t, record);
  const pending = loadEmbedBuilderSearchSelection({
    ...fixture.opening, options: { getString: () => record.channelId + ':' + record.messageId + ':0' },
  });
  let selection;
  pending.then(value => { selection = value; });
  await settle();
  assert.ok(selection, 'the authoritative complete Save needs no template-scope database read');
  assert.deepEqual(selection.record.snapshot, record.snapshot);
  assert.deepEqual(selection.previewRecord.components, record.components);
});

test('Builder stage telemetry includes fast samples in p50/p95 and records each stage once', () => {
  assert.equal(typeof latency.createBuilderPerformanceTracker, 'function');
  const reports = [];
  let time = 0;
  for (let elapsed = 1; elapsed <= 20; elapsed++) {
    time = 0;
    const mark = latency.createBuilderPerformanceTracker('performance-test', {
      now: () => time, report: report => reports.push(report),
    });
    time = elapsed;
    mark('first_visible');
    mark('first_visible');
  }
  assert.equal(reports.length, 20);
  assert.equal(reports[19].sampleCount, 20);
  assert.equal(reports[19].p50Ms, 10);
  assert.equal(reports[19].p95Ms, 19);
});
