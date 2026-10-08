import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { db } from '../src/utils/database/wrapper.js';
import builder from '../src/commands/Tools/embedbuilder.js';
import '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { applyEmbedColorPickerSession, flushPendingEmbedEditorUpdates } from '../src/services/embedColorPickerSessionService.js';
import { createEmbedManagerChannelPager } from '../src/services/embedManagerService.js';

let serial = 0;
function fixture(t, { hidden = false, readOnly = false } = {}) {
  const guildId = String(900000000000000000n + BigInt(++serial));
  const owner = { id: 'owner' };
  const bot = { id: 'bot' };
  const member = { id: owner.id, user: owner };
  const publicPayloads = [];
  const childPayloads = [];
  const childMessages = [];
  function message(id, payload = {}) {
    return {
      id, guildId, channelId: '100000000000000001', embeds: payload.embeds || [],
      components: payload.components || [], edits: [],
      async edit(next) { this.edits.push(next); this.embeds = next.embeds || this.embeds; return this; },
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
    user: owner, member, guild, guildId, channel, client,
    options: { getString: () => null },
    webhook: { async deleteMessage() {}, async editMessage() {} },
    async deleteReply() {}, async fetchReply() { return preview; },
    async reply(payload) {
      publicPayloads.push(payload); this.replied = true; preview.embeds = payload.embeds || [];
      return { resource: { message: preview } };
    },
  };
  t.mock.method(db, 'get', async (_key, fallback) => fallback);
  t.mock.method(db, 'set', async () => true);
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
  return { guild, member, channel, client, preview, interaction, publicPayloads, childPayloads, childMessages, component };
}
function buttons(payload) { return (payload.components || []).flatMap(row => (row.toJSON?.() || row).components || []); }
async function open(t, options) {
  const f = fixture(t, options);
  await builder.execute(f.interaction);
  // The root dashboard is the last public send, and owns every owner-gated control.
  const dashboard = f.publicPayloads.find(payload => buttons(payload).some(button => button.label === 'Edit title & message'));
  assert.ok(dashboard);
  t.after(() => f.channel.lastMessage.collector.stop('test-ended'));
  return { ...f, dashboard };
}

test('public Builder keeps its layout with a direct content link and private color launch', async t => {
  const f = await open(t);
  assert.equal(f.publicPayloads.length, 2);
  assert.ok(f.publicPayloads.every(payload => !(Number(payload.flags || 0) & MessageFlags.Ephemeral)));
  assert.equal(f.dashboard.components.length, 5);
  const launchButtons = buttons(f.dashboard).filter(button => ['Edit title & message', 'Set side color'].includes(button.label));
  assert.equal(launchButtons.length, 2);
  assert.ok(launchButtons.find(button => button.label === 'Edit title & message').url);
  assert.ok(launchButtons.find(button => button.label === 'Set side color').custom_id);
});

test('direct content editor and private color editor still update the preview', async t => {
  const f = fixture(t);
  let rootCollector;
  const originalSend = f.channel.send;
  f.channel.send = async payload => {
    const dashboard = await originalSend.call(f.channel, payload);
    const originalCreate = dashboard.createMessageComponentCollector;
    dashboard.createMessageComponentCollector = options => { rootCollector = originalCreate.call(dashboard, options); return rootCollector; };
    return dashboard;
  };
  await builder.execute(f.interaction);
  t.after(() => rootCollector.stop('test-ended'));
  assert.equal(rootCollector.options.filter(f.component('simple_embed_open_content', { id: 'another-viewer' })), false);
  await rootCollector.listeners('collect')[0](f.component('simple_embed_open_color'));
  assert.equal(f.childPayloads.length, 1, 'only color launch returns a private link');
  assert.ok(f.childPayloads.every(payload => Number(payload.flags) & MessageFlags.Ephemeral));
  const contentUrl = new URL(buttons(f.channel.lastMessage).find(button => button.label === 'Edit title & message').url);
  const colorUrl = new URL(buttons(f.childPayloads[0])[0].url);
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
    t.after(() => f.channel.lastMessage.collector.stop('test-ended'));
    assert.ok(f.publicPayloads.every(payload => (payload.embeds || []).every(embed => !JSON.stringify(embed.toJSON()).includes('Private draft'))));
  }
});

test('forged Post selection cannot use bot-only permissions, while an allowed channel still posts', async t => {
  const f = fixture(t);
  await builder.execute(f.interaction);
  const rootCollector = f.channel.lastMessage.collector;
  t.after(() => rootCollector.stop('test-ended'));
  await rootCollector.listeners('collect')[0](f.component('simple_embed_open_content'));
  const launchPayload = f.childPayloads.at(-1) || f.publicPayloads.find(payload => buttons(payload).some(button => button.label === 'Edit title & message'));
  const token = new URL(buttons(launchPayload).find(button => button.url)?.url).searchParams.get('session');
  await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'message', value: 'Owner post' }));
  await flushPendingEmbedEditorUpdates(token);
  let deniedSends = 0;
  const denied = { ...f.channel, id: '100000000000000002', name: 'private', async send() { deniedSends++; }, permissionsFor: actor => ({ has: () => actor.id === 'bot' }) };
  f.guild.channels.cache.set(denied.id, denied);
  await rootCollector.listeners('collect')[0](f.component('simple_embed_post'));
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
  const collector = f.channel.lastMessage.collector;
  t.after(() => collector.stop('test-ended'));
  f.channel.permissionsFor = actor => ({ has: () => actor.id === 'bot' });
  let fetches = 0;
  f.channel.messages.fetch = async () => { fetches++; return null; };
  await collector.listeners('collect')[0](f.component('simple_embed_post'));
  assert.equal(fetches, 0, 'revoked access must stop Save before bot-only REST lookup');
});
