import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, Embed, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { db } from '../src/utils/database/wrapper.js';
import builder from '../src/commands/Tools/embedbuilder.js';
import '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { applyEmbedColorPickerSession, flushPendingEmbedEditorUpdates } from '../src/services/embedColorPickerSessionService.js';
import { createEmbedManagerChannelPager } from '../src/services/embedManagerService.js';
import { loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { prewarmEmbedBuilderSearch, loadEmbedBuilderSearchSelection } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import fullResponseCatalog from '../src/events/fullResponseCatalogReady.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

let serial = 0;
function fixture(t, { hidden = false, readOnly = false } = {}) {
  const guildId = String(900000000000000000n + BigInt(++serial));
  const owner = { id: 'owner' };
  const bot = { id: 'bot' };
  const member = { id: owner.id, user: owner };
  const publicPayloads = [];
  const privatePayloads = [];
  const childPayloads = [];
  const childMessages = [];
  function message(id, payload = {}) {
    return {
      id, guildId, channelId: '100000000000000001',
      embeds: (payload.embeds || []).map(embed => new Embed(embed.toJSON?.() || embed)),
      components: payload.components || [], edits: [],
      async edit(next) {
        this.edits.push(next);
        if (next.embeds) this.embeds = next.embeds.map(embed => new Embed(embed.toJSON?.() || embed));
        this.components = next.components || this.components;
        return this;
      },
      async delete() {},
      createMessageComponentCollector(options) {
        const collector = new EventEmitter();
        collector.options = options;
        collector.ended = false;
        collector.resetTimer = () => {};
        collector.stop = reason => { if (!collector.ended) { collector.ended = true; collector.emit('end', [], reason); } };
        this.collector = collector;
        return collector;
      },
    };
  }
  const guild = {
    id: guildId, emojis: { cache: new Collection() }, roles: { everyone: { id: 'everyone' } },
    members: { me: bot }, channels: { cache: new Collection(), async fetch(id) { return this.cache.get(id) || this.cache; } },
  };
  const client = { user: bot, guilds: { cache: new Collection([[guildId, guild]]) } };
  guild.client = client;
  const channel = {
    id: '100000000000000001', guildId, guild, type: 0, name: 'public', rawPosition: 0,
    messages: { async fetch() { return new Collection(); } },
    permissionsFor(actor) {
      return { has(requested) {
        const values = Array.isArray(requested) ? requested : [requested];
        return actor?.id === bot.id || values.every(value => value !== PermissionFlagsBits.ViewChannel || !hidden)
          && values.every(value => value !== PermissionFlagsBits.SendMessages || !readOnly);
      } };
    },
    async send(payload) { publicPayloads.push(payload); this.lastMessage = message('dashboard', payload); return this.lastMessage; },
    toString() { return '#public'; },
  };
  guild.channels.cache.set(channel.id, channel);
  const preview = message('preview');
  const interaction = {
    id: 'builder-access-' + guildId, createdTimestamp: Date.now(),
    user: owner, member, guild, guildId, channel, client,
    options: { getString: () => null },
    webhook: {
      async deleteMessage() {},
      async editMessage(messageId, payload) {
        if (String(messageId) === String(preview.id)) return preview.edit(payload);
        if (String(messageId) === String(this.lastDashboard?.id)) return this.lastDashboard.edit(payload);
        return null;
      },
    },
    async deleteReply() {}, async fetchReply() { return preview; },
    async reply(payload) {
      privatePayloads.push(payload); this.replied = true; preview.embeds = payload.embeds || [];
      return { resource: { message: preview } };
    },
    async followUp(payload) {
      privatePayloads.push(payload);
      this.lastDashboard = message('dashboard', payload);
      return this.lastDashboard;
    },
  };
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async key => { storage.delete(key); return true; });
  function component(customId, user = owner) {
    return {
      ...interaction, user, customId, replied: false, deferred: false,
      isButton: () => true, isStringSelectMenu: () => false,
      async deferUpdate() { this.deferred = true; },
      async reply(payload) { childPayloads.push(payload); this.replied = true; return { resource: { message: message('child') } }; },
      async followUp(payload) { childPayloads.push(payload); const result = message('child', payload); childMessages.push(result); return result; },
      async update() {}, async editReply() {},
    };
  }
  return { guild, member, channel, client, preview, interaction, publicPayloads, privatePayloads, childPayloads, childMessages, component, storage };
}
function buttons(payload) { return (payload.components || []).flatMap(row => (row.toJSON?.() || row).components || []); }
async function open(t, options) {
  const f = fixture(t, options);
  await builder.execute(f.interaction);
  // Both preview and dashboard stay private to the Builder owner.
  const dashboard = f.privatePayloads.find(payload => buttons(payload).some(button => button.label === 'Edit title and message'));
  assert.ok(dashboard);
  t.after(() => f.interaction.lastDashboard?.collector.stop('test-ended'));
  return { ...f, dashboard };
}

test('private Builder keeps its layout with direct content and color links', async t => {
  const f = await open(t);
  assert.equal(f.publicPayloads.length, 0);
  assert.equal(f.privatePayloads.length, 2);
  assert.ok(f.privatePayloads.every(payload => Number(payload.flags || 0) & MessageFlags.Ephemeral));
  assert.equal(f.dashboard.components.length, 5);
  const launchButtons = buttons(f.dashboard).filter(button => ['Edit title and message', 'Set side color'].includes(button.label));
  assert.equal(launchButtons.length, 2);
  assert.ok(launchButtons.find(button => button.label === 'Edit title and message').url);
  assert.ok(launchButtons.find(button => button.label === 'Set side color').url);
});

test('direct content and color editors still update the preview without private launch replies', async t => {
  const f = fixture(t);
  await builder.execute(f.interaction);
  const rootCollector = f.interaction.lastDashboard.collector;
  t.after(() => rootCollector.stop('test-ended'));
  assert.equal(f.publicPayloads.length, 0);
  assert.equal(rootCollector.options.filter(f.component('simple_embed_open_content', { id: 'another-viewer' })), false);
  assert.equal(f.childPayloads.length, 0);
  const contentUrl = new URL(buttons(f.interaction.lastDashboard).find(button => button.label === 'Edit title and message').url);
  const colorUrl = new URL(buttons(f.interaction.lastDashboard).find(button => button.label === 'Set side color').url);
  assert.equal(contentUrl.searchParams.get('mode'), 'content');
  assert.equal(contentUrl.searchParams.get('session'), colorUrl.searchParams.get('session'));
  const token = contentUrl.searchParams.get('session');
  const options = { editorInstanceId: 'owner-document' };
  assert.equal((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_OPEN__:owner-document', options)).ok, true);
  assert.equal((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'message', value: 'Owner draft' }), options)).ok, true);
  await flushPendingEmbedEditorUpdates(token);
  assert.equal(JSON.parse((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__', options)).color).message, 'Owner draft');
  assert.equal((await applyEmbedColorPickerSession(token, '#123456', options)).ok, true);
  assert.ok(f.preview.edits.some(payload => payload.embeds?.some(embed => embed.toJSON().description === 'Owner draft')));
});

test('autocomplete does not reveal a bot-readable channel denied to the invoking member', async t => {
  const f = fixture(t, { hidden: true });
  const record = { guildId: f.guild.id, channelId: f.channel.id, messageId: '100000000000000009', embedIndex: 0, source: 'embed-builder', snapshot: { title: 'Confidential case', description: 'Private draft' } };
  t.mock.method(db, 'get', async (key, fallback) => key === `cloudy:embed-registry:${f.guild.id}` ? [record] : fallback);
  let choices;
  await builder.autocomplete({ ...f.interaction, options: { getFocused: () => ({ name: 'search', value: 'confidential' }) }, async respond(value) { choices = value; } });
  assert.deepEqual(choices, []);
});

test('editing a new embed enables Save and saving twice creates one private durable Builder record', async t => {
  const f = await open(t);
  const dashboard = f.interaction.lastDashboard;
  const content = buttons(dashboard).find(button => button.label === 'Edit title and message');
  const token = new URL(content.url).searchParams.get('session');
  const options = { editorInstanceId: 'draft-owner-editor' };
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_OPEN__:draft-owner-editor', options);
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'My saved draft' }), options);
  await flushPendingEmbedEditorUpdates(token);
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(buttons(dashboard).find(button => button.label === 'Save changes').disabled, false);
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post'));
  let records = f.storage.get('cloudy:embed-registry:' + f.guild.id) || [];
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.title, 'My saved draft');
  assert.equal(records[0].manualSaved, true);
  assert.equal(records[0].detached, true);
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'message', value: 'Second saved contents' }), options);
  await flushPendingEmbedEditorUpdates(token);
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post'));
  records = f.storage.get('cloudy:embed-registry:' + f.guild.id) || [];
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.description, 'Second saved contents');
  assert.equal(f.publicPayloads.length, 0, 'only Post may publish a Discord message');
});

test('Post publishes a saved new draft once and replaces its private draft identity', async t => {
  const f = await open(t);
  const dashboard = f.interaction.lastDashboard;
  const token = new URL(buttons(dashboard).find(button => button.label === 'Edit title and message').url).searchParams.get('session');
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'message', value: 'Saved then posted' }));
  await flushPendingEmbedEditorUpdates(token);
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post'));
  assert.equal(f.publicPayloads.length, 0);
  const key = 'cloudy:embed-registry:' + f.guild.id;
  const draftId = f.storage.get(key)[0].messageId;
  assert.ok(draftId.startsWith('draft-'));
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post_new'));
  const picker = f.childMessages.at(-1);
  await picker.collector.listeners('collect')[0]({ ...f.component('simple_embed_post_channel:0:0'), values: [f.channel.id] });
  assert.equal(picker.collector.ended, true);
  assert.equal(f.publicPayloads.length, 1);
  const records = f.storage.get(key);
  assert.equal(records.length, 1, 'posting a saved new draft must not leave a duplicate in Search');
  assert.equal(records[0].detached, false);
  assert.notEqual(records[0].messageId, draftId);
  assert.equal(records[0].snapshot.description, 'Saved then posted');
  assert.equal(records[0].draftData, undefined);
});

test('Delete removes only the saved private draft without requesting a Discord message', async t => {
  const f = await open(t);
  const dashboard = f.interaction.lastDashboard;
  const token = new URL(buttons(dashboard).find(button => button.label === 'Edit title and message').url).searchParams.get('session');
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'Private draft to delete' }));
  await flushPendingEmbedEditorUpdates(token);
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post'));
  let fetches = 0;
  f.channel.messages.fetch = async () => { fetches++; throw new Error('A private draft has no Discord message'); };
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_delete_from_builder'));
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post'));
  assert.equal((f.storage.get('cloudy:embed-registry:' + f.guild.id) || []).length, 0);
  assert.equal(fetches, 0);
  assert.equal(f.publicPayloads.length, 0);
});

test('a failed Post relink preserves the saved private draft and rolls back its public message', async t => {
  const f = await open(t);
  const dashboard = f.interaction.lastDashboard;
  const token = new URL(buttons(dashboard).find(button => button.label === 'Edit title and message').url).searchParams.get('session');
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'message', value: 'Keep my saved draft' }));
  await flushPendingEmbedEditorUpdates(token);
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post'));
  const key = 'cloudy:embed-registry:' + f.guild.id;
  const draftId = f.storage.get(key)[0].messageId;
  t.mock.method(db, 'set', async (name, value) => {
    if (name === key && !value.some(record => record.messageId === draftId)) return false;
    f.storage.set(name, structuredClone(value));
    return true;
  });
  let deleted = 0;
  const send = f.channel.send;
  f.channel.send = async payload => {
    const message = await send.call(f.channel, payload);
    message.delete = async () => { deleted++; };
    return message;
  };
  await dashboard.collector.listeners('collect')[0](f.component('simple_embed_post_new'));
  const picker = f.childMessages.at(-1);
  await picker.collector.listeners('collect')[0]({ ...f.component('simple_embed_post_channel:0:0'), values: [f.channel.id] });
  assert.equal(picker.collector.ended, false);
  assert.equal(deleted, 1);
  const records = f.storage.get(key);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, draftId);
  assert.equal(records[0].snapshot.description, 'Keep my saved draft');
});

test('Modify channel navigation excludes channels without member ViewChannel or SendMessages', t => {
  const hidden = fixture(t, { hidden: true });
  const readOnly = fixture(t, { readOnly: true });
  assert.equal(createEmbedManagerChannelPager(hidden.guild, hidden.member)([], 0).components.length, 0);
  assert.equal(createEmbedManagerChannelPager(readOnly.guild, readOnly.member)([], 0).components.length, 0);
});

test('access checks fail closed and protect logical, backing and preview channels', async t => {
  const { canUseEmbedBuilderChannel, canAccessEmbedBuilderRecord } = await import('../src/utils/embedBuilderAccess.js');
  const f = fixture(t);
  const record = { guildId: f.guild.id, channelId: f.channel.id };
  assert.equal(canUseEmbedBuilderChannel(f.guild, f.member, f.channel, { requireSend: true }), true);
  assert.equal(canUseEmbedBuilderChannel(f.guild, null, f.channel), false);
  assert.equal(canAccessEmbedBuilderRecord(f.guild, f.member, { ...record, guildId: 'foreign' }), false);
  assert.equal(canAccessEmbedBuilderRecord(f.guild, f.member, { ...record, backingChannelId: 'missing' }), false);
  assert.equal(canAccessEmbedBuilderRecord(f.guild, f.member, { ...record, previewRecord: { ...record, channelId: 'missing' } }), false);
  const hidden = fixture(t, { hidden: true });
  assert.equal(canUseEmbedBuilderChannel(hidden.guild, hidden.member, hidden.channel, { requireSend: true }), false);
  const readOnly = fixture(t, { readOnly: true });
  assert.equal(canUseEmbedBuilderChannel(readOnly.guild, readOnly.member, readOnly.channel, { requireSend: true }), false);
});

test('selected or stale pending private search records never enter the public preview', async t => {
  for (const pending of [false, true]) {
    const f = fixture(t, { hidden: true });
    const record = { guildId: f.guild.id, channelId: f.channel.id, messageId: '100000000000000009', embedIndex: 0, source: 'embed-builder', snapshot: { title: 'Confidential case', description: 'Private draft' } };
    t.mock.method(db, 'get', async (key, fallback) => key === `cloudy:embed-registry:${f.guild.id}` ? [record] : fallback);
    if (pending) f.interaction.__cloudyInitialBuilderSelection = { record };
    else f.interaction.options.getString = () => `${record.channelId}:${record.messageId}:0`;
    await builder.execute(f.interaction);
    t.after(() => f.interaction.lastDashboard?.collector.stop('test-ended'));
    assert.equal(f.publicPayloads.length, 0);
    assert.ok(f.privatePayloads.every(payload => (payload.embeds || []).every(embed => !JSON.stringify(embed.toJSON()).includes('Private draft'))));
  }
});

test('forged Post selection cannot use bot-only permissions, while an allowed channel still posts', async t => {
  const f = fixture(t);
  await builder.execute(f.interaction);
  const rootCollector = f.interaction.lastDashboard.collector;
  t.after(() => rootCollector.stop('test-ended'));
  await rootCollector.listeners('collect')[0](f.component('simple_embed_open_content'));
  const launchPayload = f.childPayloads.at(-1) || f.privatePayloads.find(payload => buttons(payload).some(button => button.label === 'Edit title and message'));
  const token = new URL(buttons(launchPayload).find(button => button.url)?.url).searchParams.get('session');
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'message', value: 'Owner post' }));
  await flushPendingEmbedEditorUpdates(token);
  let deniedSends = 0;
  const denied = { ...f.channel, id: '100000000000000002', name: 'private', async send() { deniedSends++; }, permissionsFor: actor => ({ has: () => actor.id === 'bot' }) };
  f.guild.channels.cache.set(denied.id, denied);
  await rootCollector.listeners('collect')[0](f.component('simple_embed_post_new'));
  const picker = f.childMessages.at(-1);
  assert.ok(picker.collector);
  assert.ok(buttons(f.childPayloads.at(-1)).flatMap(item => item.options || []).every(option => option.value !== denied.id));
  const deniedSelection = { ...f.component('simple_embed_post_channel:0:0'), values: [denied.id] };
  await picker.collector.listeners('collect')[0](deniedSelection);
  assert.equal(deniedSends, 0);
  assert.equal(picker.collector.ended, false);
  const previousSends = f.publicPayloads.length;
  await picker.collector.listeners('collect')[0]({ ...f.component('simple_embed_post_channel:0:0'), values: [f.channel.id] });
  assert.equal(f.publicPayloads.length, previousSends + 1);
  assert.equal(f.publicPayloads.at(-1).embeds[0].toJSON().description, 'Owner post');
  assert.equal(picker.collector.ended, true);
});

test('Save rechecks member access before resolving or mutating a previously selected record', async t => {
  const f = fixture(t);
  const record = { guildId: f.guild.id, channelId: f.channel.id, messageId: '100000000000000009', embedIndex: 0, source: 'embed-builder', snapshot: { title: 'Existing title', description: 'Existing text' } };
  f.interaction.__cloudyInitialBuilderSelection = { record };
  await builder.execute(f.interaction);
  const collector = f.interaction.lastDashboard.collector;
  t.after(() => collector.stop('test-ended'));
  f.channel.permissionsFor = actor => ({ has: () => actor.id === 'bot' });
  let fetches = 0;
  f.channel.messages.fetch = async () => { fetches++; return null; };
  await collector.listeners('collect')[0](f.component('simple_embed_post'));
  assert.equal(fetches, 0, 'revoked access must stop Save before bot-only REST lookup');
});

test('Search Save is used by the next real Builder deletion response with exact owner title and emoji', async t => {
  const f = fixture(t);
  fullResponseCatalog.execute({ on() {} });
  const source = { title: 'Removed from Builder', description: 'Original deletion response.', color: 0xffffff,
    author: { name: 'Cloudy template key: builder:removed || Cloudy context: embed-builder/delete || Cloudy kind: embed' } };
  const catalog = { guildId: f.guild.id, channelId: f.channel.id, messageId: '100000000000000029',
    embedIndex: 0, source: 'system-catalog', title: source.title, snapshot: source, components: [] };
  f.storage.set('cloudy:embed-registry:' + f.guild.id, [catalog]);
  const message = { id: catalog.messageId, guildId: f.guild.id, channelId: f.channel.id,
    channel: f.channel, author: { id: 'bot' }, content: 'System & error embed templates',
    embeds: [new Embed(source)], components: [], flags: { has: () => false },
    async edit(payload) { this.embeds = payload.embeds.map(embed => new Embed(embed)); return this; } };
  f.channel.messages.fetch = async () => message;
  await getEmbedRegistry(f.guild.id);
  await prewarmEmbedBuilderSearch(f.guild);
  const search = { ...f.interaction, options: {
    getFocused: () => ({ name: 'search', value: 'removed from builder' }),
    getString: () => `${f.channel.id}:${catalog.messageId}:0`,
  }, async respond(choices) { this.choices = choices; } };
  await builder.autocomplete(search);
  assert.ok(search.choices.some(choice => choice.value === search.options.getString()));
  const selected = await loadEmbedBuilderSearchSelection(search);
  const state = {};
  loadRecordSnapshotIntoState(state, f.guild, selected.record, selected.previewRecord, selected.sourceRecord);
  state.title = 'Removed by builder 🔨 <:cloudy:123456789012345678>';
  state.message = 'The owner saved this exact response.';
  assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);

  const removed = { guildId: f.guild.id, channelId: f.channel.id, messageId: '100000000000000039',
    embedIndex: 0, source: 'embed-builder', manualSaved: true, detached: true,
    title: 'Independent item to remove', snapshot: { title: 'Independent item to remove', description: 'Delete only this item' }, components: [] };
  const key = 'cloudy:embed-registry:' + f.guild.id;
  f.storage.set(key, [...f.storage.get(key), removed]);
  f.interaction.commandName = 'embedbuilder';
  f.interaction.__cloudyInitialBuilderSelection = { record: removed };
  InteractionHelper.patchInteractionResponses(f.interaction);
  await builder.execute(f.interaction);
  const dashboard = f.interaction.lastDashboard;
  t.after(() => dashboard.collector.stop('test-ended'));
  function component(id) {
    const interaction = f.component(id);
    interaction.__cloudyFullResponseCatalogPatched = false;
    interaction.__titanResponsePatched = false;
    InteractionHelper.patchInteractionResponses(interaction);
    return interaction;
  }
  await dashboard.collector.listeners('collect')[0](component('simple_embed_delete_from_builder'));
  await dashboard.collector.listeners('collect')[0](component('simple_embed_post'));
  const notice = f.childPayloads.at(-1).embeds[0];
  const data = notice.toJSON?.() || notice;
  assert.equal(data.title, state.title, 'the actual bot notification must reuse the title saved through Search');
  assert.equal(data.description, state.message);
  assert.equal(f.publicPayloads.length, 0);
  assert.equal(f.storage.get(key).some(record => record.messageId === removed.messageId), false);
});
