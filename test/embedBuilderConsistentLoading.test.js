import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, Embed } from 'discord.js';
import { performance } from 'node:perf_hooks';
import { db } from '../src/utils/database.js';
import { logger } from '../src/utils/logger.js';
import {
  getEmbedRegistry, peekEmbedRegistry, removeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';
import { openEmbedManager, prepareEmbedManager, applyInitialSearchSelectionToState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { warmSavedEmbedTemplateScopes } from '../src/services/embedTemplateService.js';
import { loadEmbedBuilderSearchSelection, loadFastEmbedBuilderSearchRecords } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
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
  let updateGate = null;
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
      async update(payload) {
        this.replied = true; payloads.push(payload);
        const gate = updateGate; updateGate = null;
        if (gate) await gate.promise;
      },
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
    stallUpdate: gate => { updateGate = gate; },
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
  assert.ok(fixture.paints.length >= 1, 'a verified in-memory registry must paint before the stalled preload resolves');
  assert.ok(fixture.paints[0].components[0].toJSON().components[0].options.some(option => option.value === record.channelId));
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
  // The removal publishes its own committed result: the pre-delete live row
  // can never satisfy a fresh channel browser, and no extra read is needed.
  assert.equal(peekEmbedRegistry(record.guildId, { current: true })[0].detached, true,
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

test('cold and warm saved Search selections preserve the exact manual Save without stale family overlays', async t => {
  const record = savedRecord('search-cold-family-authority');
  t.mock.method(db, 'get', async key =>
    key.startsWith('cloudy:embed-registry-deleted:') ? [] : [record]);
  await getEmbedRegistry(record.guildId);
  const scopeGate = deferred();
  t.after(() => scopeGate.resolve({}));
  const obsoleteFamily = {
    schemaVersion: 3, title: 'Rules panel', description: 'Old shared family body',
    color: 0x654321, fields: [{ name: 'Rules', value: 'Old shared field', inline: true }],
  };
  t.mock.method(db, 'get', async key =>
    key.endsWith(':__global__') ? scopeGate.promise : {});
  t.mock.method(db, 'set', async () => assert.fail('Search preview must not save data'));
  const fixture = managerFixture(t, record);
  const interaction = {
    ...fixture.opening, options: { getString: () => record.channelId + ':' + record.messageId + ':0' },
  };
  let coldResolved = false;
  const pending = loadEmbedBuilderSearchSelection(interaction).then(value => {
    coldResolved = true;
    return value;
  });
  await settle();
  assert.equal(coldResolved, true,
    'manual saved snapshots must not wait for unrelated shared-template storage');
  // A previous template family can arrive later; it must never replace what
  // the user manually saved on this exact physical Discord message.
  scopeGate.resolve({ 'rules panel': obsoleteFamily });
  const cold = await pending;
  const coldState = {};
  applyInitialSearchSelectionToState({ ...interaction, __cloudyInitialBuilderSelection: cold }, coldState);
  assert.equal(coldState.message, 'Exact saved body');
  assert.equal(coldState.sideColor, 0x123456);
  assert.deepEqual(coldState.embedFields, record.snapshot.fields);
  assert.equal(coldState.mediaUrl, record.snapshot.image.url);
  t.mock.method(db, 'get', async () => assert.fail('warm selection must not repeat storage reads'));
  const warm = await loadEmbedBuilderSearchSelection(interaction);
  const warmState = {};
  applyInitialSearchSelectionToState({ ...interaction, __cloudyInitialBuilderSelection: warm }, warmState);
  assert.equal(warmState.message, coldState.message);
  assert.equal(warmState.sideColor, coldState.sideColor);
  assert.deepEqual(warmState.embedFields, coldState.embedFields);
  assert.equal(warmState.mediaUrl, coldState.mediaUrl);
});

test('independent runtime preview and saved-scope reads start together for one selected source', async t => {
  const record = {
    ...savedRecord('search-independent-preview-reads'), source: 'system-catalog', manualSaved: false,
    snapshot: { title: 'Parallel preview example', description: 'Complete source content',
      author: { name: 'Cloudy template key: performance-parallel || Cloudy context: general/notices || Cloudy kind: embed' } },
  };
  t.mock.method(db, 'get', async () => [record]);
  await getEmbedRegistry(record.guildId);
  const scopeGate = deferred();
  const runtimeGate = deferred();
  t.after(() => { scopeGate.resolve({}); runtimeGate.resolve(null); });
  let runtimeStarted = false;
  t.mock.method(db, 'get', async key => {
    if (key.startsWith('cloudy:builder-runtime-preview:')) {
      runtimeStarted = true;
      return runtimeGate.promise;
    }
    return scopeGate.promise;
  });
  const fixture = managerFixture(t, record);
  const pending = loadEmbedBuilderSearchSelection({
    ...fixture.opening, options: { getString: () => record.channelId + ':' + record.messageId + ':0' },
  });
  await settle();
  assert.equal(runtimeStarted, true, 'runtime fallback must not wait for independent saved-scope storage');
  scopeGate.resolve({});
  runtimeGate.resolve(null);
  assert.ok(await pending);
});

test('a message deleted during the first channel update is absent after fresh history resolves', async t => {
  const record = savedRecord('manager-delete-during-update', false);
  t.mock.method(db, 'get', async () => []);
  const fixture = managerFixture(t, record);
  await openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  fixture.chooseChannel();
  await settle();
  const updateGate = deferred();
  const pageGate = deferred();
  t.after(() => { updateGate.resolve(); pageGate.resolve(new Collection()); });
  fixture.stallUpdate(updateGate);
  fixture.stallPage(pageGate);
  const payloads = fixture.chooseChannel();
  await settle();
  assert.ok(embedChoices(payloads[0]).some(option => option.value === record.messageId + ':0'));
  fixture.channel.messages.cache.delete(record.messageId);
  pageGate.resolve(new Collection());
  updateGate.resolve();
  await settle();
  assert.ok(payloads.length > 1, 'fresh Discord history must repaint the channel');
  assert.deepEqual(embedChoices(payloads.at(-1)), [],
    'a retained cache row cannot survive a fresh response after its deletion');
});

test('first Save preserves another embed after selected message cache replacement', async t => {
  const record = savedRecord('manager-save-cache-replacement', false);
  t.mock.method(db, 'get', async () => []);
  t.mock.method(db, 'set', async () => true);
  const fixture = managerFixture(t, record);
  const oldSibling = { title: 'Sibling panel', description: 'Old sibling body' };
  const newSibling = { title: 'Sibling panel', description: 'New legitimate sibling body' };
  const edits = [];
  Object.assign(fixture.message, {
    channel: fixture.channel, client: fixture.guild.client,
    embeds: [new Embed(record.snapshot), new Embed(oldSibling)],
    async edit(payload) {
      edits.push(structuredClone(payload));
      this.embeds = payload.embeds.map(data => new Embed(data));
      return this;
    },
  });
  await openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  fixture.chooseChannel();
  await settle();
  fixture.chooseEmbed();
  await settle();
  assert.equal(fixture.state.modifyTarget?.messageId, record.messageId);
  const current = { ...fixture.message, embeds: [new Embed(record.snapshot), new Embed(newSibling)] };
  fixture.channel.messages.cache.delete(record.messageId);
  fixture.channel.messages.cache.set(record.messageId, current);
  t.mock.method(fixture.channel.messages, 'fetch', async options =>
    options?.limit ? new Collection([[current.id, current]]) : current);
  fixture.state.message = 'Administrator edited selected body';
  assert.equal((await saveModifiedEmbed(fixture.guild, fixture.state)).ok, true);
  assert.equal(edits[0].embeds[0].description, 'Administrator edited selected body');
  assert.deepEqual(edits[0].embeds[1], newSibling);
});

test('warm saved Search retains 3000 results while one selected preview avoids stalled storage', async t => {
  const record = savedRecord('search-large-complete-warm-index');
  const records = Array.from({ length: 3000 }, (_, index) => ({
    ...record, messageId: String(222222222222220000n + BigInt(index)),
  }));
  t.mock.method(db, 'get', async key => key.startsWith('cloudy:embed-registry:') ? records : {});
  await getEmbedRegistry(record.guildId);
  await warmSavedEmbedTemplateScopes(record.guildId, [record.channelId]);
  const fixture = managerFixture(t, record);
  const selected = records.at(-1);
  const interaction = {
    ...fixture.opening, options: { getString: () => record.channelId + ':' + selected.messageId + ':0' },
  };
  const complete = await loadFastEmbedBuilderSearchRecords(interaction);
  const ids = new Set(complete.map(item => item.messageId));
  assert.ok(records.every(item => ids.has(item.messageId)), 'the complete catalog must remain available');
  const gate = deferred();
  t.after(() => gate.resolve({}));
  t.mock.method(db, 'get', async () => gate.promise);
  const durations = [];
  for (let index = 0; index < 20; index++) {
    const started = performance.now();
    let selection;
    const pending = loadEmbedBuilderSearchSelection(interaction).then(value => { selection = value; return value; });
    await settle();
    assert.equal(selection?.record.messageId, selected.messageId);
    assert.deepEqual(selection.previewRecord.components, record.components);
    await pending;
    durations.push(performance.now() - started);
  }
  const sorted = durations.sort((a, b) => a - b);
  t.diagnostic('Controlled warm saved Search: 3000 records, 20 samples, p50='
    + sorted[9].toFixed(2) + 'ms, p95=' + sorted[18].toFixed(2)
    + 'ms; excludes Discord transport and cold storage.');
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

test('abandoned queued channel updates are excluded from visible latency samples', async t => {
  const record = savedRecord('manager-abandoned-visibility-samples');
  t.mock.method(db, 'get', async () => [record]);
  const visible = [];
  t.mock.method(logger, 'warn', message => {
    if (typeof message !== 'string' || !message.startsWith('[BUILDER_PERFORMANCE] ')) return;
    const sample = JSON.parse(message.slice(message.indexOf('{')));
    if (sample.action === 'channel_list' && sample.phase === 'first_visible') visible.push(sample);
  });
  const fixture = managerFixture(t, record);
  await openEmbedManager(fixture.opening, fixture.state, fixture.refresh);
  await settle();
  const updateGate = deferred();
  const pageGate = deferred();
  t.after(() => { updateGate.resolve(); pageGate.resolve(new Collection()); });
  fixture.stallUpdate(updateGate);
  fixture.stallPage(pageGate);
  const first = fixture.chooseChannel();
  await settle();
  const abandoned = fixture.chooseChannel();
  await settle();
  const latest = fixture.chooseChannel();
  await settle();
  updateGate.resolve();
  await settle();
  assert.equal(abandoned.length, 0, 'a superseded queued selection must not reach Discord');
  assert.equal(first.length + latest.length, 2);
  assert.equal(visible.length, 2, 'only the two delivered paints count toward p50/p95');
});

test('a current manual Search selection opens immediately without slow full-record lookups', async t => {
  const record = savedRecord('manual-search-current-generation-fast-path');
  t.mock.method(db, 'get', async key =>
    key.startsWith('cloudy:embed-registry:') ? [record] : {});
  await getEmbedRegistry(record.guildId);
  const fixture = managerFixture(t, record);
  const gate = deferred();
  t.after(() => gate.resolve([]));
  t.mock.method(db, 'get', async () => gate.promise);
  const interaction = {
    ...fixture.opening,
    options: { getString: () => record.channelId + ':' + record.messageId + ':0' },
  };
  let selected = null;
  const pending = loadEmbedBuilderSearchSelection(interaction)
    .then(value => { selected = value; return value; });
  await settle();
  assert.equal(selected?.record.messageId, record.messageId,
    'a current saved physical post must not wait for a slow template DB read');
  assert.equal(selected.previewRecord.snapshot.description, 'Exact saved body');
  gate.resolve([]);
  await pending;
});
