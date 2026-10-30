// Embed Builder canonical-identity regression suite.
//
// Drives the real /embedbuilder command, Search autocomplete, Search
// selection, Save, Delete, Repost, Reappear and the generic MESSAGE_CREATE /
// MESSAGE_DELETE registry listeners against a simulated Discord guild and an
// in-memory database. One physical Discord message must always map to exactly
// one current registry identity: guildId + channelId + messageId + embedIndex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database/wrapper.js';
import { getFromDb, setInDb, deleteFromDb } from '../src/utils/database.js';
import { logger } from '../src/utils/logger.js';
import builder, { scheduleBuilderChildMessageRemoval } from '../src/commands/Tools/embedbuilder.js';
import {
  loadEmbedBuilderSearchSelection,
  prewarmEmbedBuilderSearch,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import {
  applyEmbedColorPickerSession,
  flushPendingEmbedEditorUpdates,
} from '../src/services/embedColorPickerSessionService.js';
import {
  beginEmbedRegistryMove,
  getEmbedRegistry,
  moveEmbedRegistryMessage,
  reconcileEmbedRegistry,
  registerCloudyEmbedMessage,
  removeEmbedRegistryMessage,
} from '../src/services/embedRegistryService.js';
import { loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import brandingMessageCreate from '../src/events/cloudyBrandingMessageCreate.js';
import { acquireEmbedBuilderMessageMutation } from '../src/services/embedBuilderMutationLock.js';
import { rememberBuilderOwnedMessage, withBuilderOwnedNonce } from '../src/utils/builderOwnedSends.js';
import { deleteMessageForMove } from '../src/services/deletionAttributionService.js';

const BOT = { id: '1500000000000000001' };
const OWNER = { id: '1500000000000000002' };
const PINK = 0xFF69B4;
const GIF_URL = 'https://media.cloudy.test/embed/pop-party.gif';
const DARK_LOGO = 'https://cdn.discordapp.com/attachments/1/2/cloudy-c-logo.png';
let snowflake = 1720000000000000000n;
const nextId = () => String(++snowflake);
let guildSerial = 0;

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => { setImmediate(resolve); });
}

function unknownMessage() {
  const error = new Error('Unknown Message');
  error.code = 10008;
  return error;
}

function rows(payload) {
  return (payload?.components || []).flatMap(row => (row.toJSON?.() || row).components || []);
}

// ---------------------------------------------------------------------------
// Simulated Discord guild + gateway
// ---------------------------------------------------------------------------
function createWorld(t, { gatewayFirst = true } = {}) {
  const guildId = String(1730000000000000000n + BigInt(++guildSerial));
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async key => { storage.delete(key); return true; });
  const gatewayWork = [];
  const deletedPrivate = [];

  const guild = {
    id: guildId, name: 'Cloudy QA', emojis: { cache: new Collection() },
    roles: { everyone: { id: guildId } }, members: { me: BOT },
    channels: {
      cache: new Collection(),
      async fetch(id) {
        if (id === undefined) return this.cache;
        const channel = this.cache.get(String(id));
        if (!channel) { const error = new Error('Unknown Channel'); error.code = 10003; throw error; }
        return channel;
      },
    },
  };
  const client = { user: BOT, guilds: { cache: new Collection([[guildId, guild]]) }, isReady: () => true };
  guild.client = client;

  function physicalMessage(channel, id, payload) {
    const message = {
      id, guildId, guild, channelId: channel.id, channel, client, author: BOT,
      nonce: payload.nonce ?? null, content: payload.content || '',
      editable: true, deletable: true, partial: false,
      flags: { has: () => false }, createdAt: new Date(), createdTimestamp: Date.now(),
      embeds: (payload.embeds || []).map(embed => new Embed(embed?.toJSON?.() || embed)),
      components: (payload.components || []).map(row => row?.toJSON?.() || row),
      attachments: new Collection(),
      edits: 0,
      async edit(next) {
        if (!channel.messages.cache.has(id)) throw unknownMessage();
        this.edits += 1;
        if (next.embeds) this.embeds = next.embeds.map(embed => new Embed(embed?.toJSON?.() || embed));
        if (next.components) this.components = next.components.map(row => row?.toJSON?.() || row);
        return this;
      },
      async delete() {
        if (!channel.messages.cache.has(id)) throw unknownMessage();
        channel.messages.cache.delete(id);
        // MESSAGE_DELETE gateway event -> messageDelete.js registry cleanup.
        gatewayWork.push(removeEmbedRegistryMessage(guildId, channel.id, id));
        return this;
      },
    };
    return message;
  }

  function textChannel(name) {
    const id = nextId();
    const channel = {
      id, guildId, guild, client, name, type: 0, rawPosition: guild.channels.cache.size,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      toString: () => '#' + name,
    };
    const store = new Collection();
    channel.messages = {
      cache: store,
      async fetch(query) {
        const messageId = typeof query === 'string' ? query : query?.message;
        if (messageId) {
          const found = store.get(String(messageId));
          if (!found) throw unknownMessage();
          return found;
        }
        const ordered = [...store.values()].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
        return new Collection(ordered.slice(0, query?.limit || 100).map(message => [message.id, message]));
      },
      async edit(messageId, payload) {
        const found = store.get(String(messageId));
        if (!found) throw unknownMessage();
        return found.edit(payload);
      },
    };
    channel.send = async payload => {
      const message = physicalMessage(channel, nextId(), payload);
      store.set(message.id, message);
      // Production race: Discord's MESSAGE_CREATE is often handled before
      // channel.send() has resolved for the Builder.
      const gateway = brandingMessageCreate.execute(message);
      if (gatewayFirst) await gateway;
      else gatewayWork.push(gateway);
      return message;
    };
    guild.channels.cache.set(id, channel);
    return channel;
  }

  const general = textChannel('general');
  const announcements = textChannel('announcements');

  function privateMessage(kind, payload = {}, webhook = null) {
    const message = {
      id: nextId(), kind, guildId, channelId: general.id,
      embeds: (payload.embeds || []).map(embed => new Embed(embed?.toJSON?.() || embed)),
      components: payload.components || [],
      edits: [],
      async edit(next) {
        this.edits.push(next);
        if (next.embeds) this.embeds = next.embeds.map(embed => new Embed(embed?.toJSON?.() || embed));
        if (next.components) this.components = next.components;
        return this;
      },
      async delete() { deletedPrivate.push(this.id); },
      createMessageComponentCollector(options) {
        const collector = new EventEmitter();
        collector.options = options;
        collector.ended = false;
        collector.resetTimer = () => {};
        collector.stop = reason => {
          if (collector.ended) return;
          collector.ended = true;
          collector.emit('end', new Collection(), reason);
        };
        this.collector = collector;
        return collector;
      },
    };
    if (webhook) webhook.messages.set(message.id, message);
    return message;
  }

  function webhook() {
    return {
      messages: new Map(),
      async deleteMessage(id) { deletedPrivate.push(String(id)); this.messages.delete(String(id)); },
      async editMessage(id, payload) { return this.messages.get(String(id))?.edit(payload) ?? null; },
    };
  }

  return { guildId, guild, client, general, announcements, storage, gatewayWork, deletedPrivate, privateMessage, webhook };
}

async function drainGateway(world) {
  while (world.gatewayWork.length) await world.gatewayWork.shift();
  await settle();
}

// ---------------------------------------------------------------------------
// Builder driver
// ---------------------------------------------------------------------------
async function openBuilder(t, world, { search = null } = {}) {
  const rootWebhook = world.webhook();
  const member = { id: OWNER.id, user: OWNER };
  let preview = null;
  let dashboard = null;
  const interaction = {
    id: nextId(), createdTimestamp: Date.now(), user: OWNER, member,
    guild: world.guild, guildId: world.guildId, channel: world.general, channelId: world.general.id,
    client: world.client, commandName: 'embedbuilder',
    options: { getString: name => (name === 'search' ? search : null) },
    webhook: rootWebhook,
    async deleteReply() { if (preview) world.deletedPrivate.push(preview.id); },
    async fetchReply() { return preview; },
    async editReply(payload) { return preview?.edit(payload); },
    async deferReply() { this.deferred = true; },
    async reply(payload) {
      this.replied = true;
      preview = world.privateMessage('preview', payload, rootWebhook);
      return { resource: { message: preview } };
    },
    async followUp(payload) {
      dashboard = world.privateMessage('dashboard', payload, rootWebhook);
      return dashboard;
    },
  };
  await builder.execute(interaction);
  assert.ok(dashboard?.collector, 'Builder dashboard opened');
  t.after(() => dashboard.collector.stop('test-ended'));
  // The Builder is a normal message in the channel: its editor button sends
  // the editor link (it carries the session) to the owner privately.
  const contentButton = rows(dashboard).find(button => button.label === 'Edit title and message');
  assert.equal(contentButton.url, undefined, 'the public Builder never shows the editor link');
  const opened = await click('simple_embed_open_content');
  const editorLink = rows(opened.children[0]).find(button => button.url)?.url;
  const token = new URL(editorLink).searchParams.get('session');

  function component(customId, extra = {}) {
    const hook = world.webhook();
    const children = [];
    const self = {
      id: nextId(), createdTimestamp: Date.now(), user: OWNER, member,
      guild: world.guild, guildId: world.guildId, channel: world.general, channelId: world.general.id,
      client: world.client, customId, values: extra.values, message: extra.message || dashboard,
      replied: false, deferred: false, webhook: hook, children,
      isButton: () => !extra.values, isStringSelectMenu: () => Boolean(extra.values),
      async deferUpdate() { this.deferred = true; },
      async update(payload) { this.replied = true; await this.message?.edit?.(payload); },
      async editReply(payload) { await this.message?.edit?.(payload); return this.message; },
      async reply(payload) {
        this.replied = true;
        const message = world.privateMessage('reply', payload, hook);
        children.push(message);
        return { resource: { message } };
      },
      async followUp(payload) {
        const message = world.privateMessage('followup', payload, hook);
        children.push(message);
        return message;
      },
      async showModal(modal) { this.modal = modal; },
      async awaitModalSubmit(options) {
        if (extra.awaitModalSubmit) return extra.awaitModalSubmit.call(this, options);
        const submit = extra.modalSubmit || null;
        // The submit belongs to the form this click opened.
        if (submit && submit.customId === undefined) submit.customId = this.modal?.toJSON?.().custom_id;
        return submit && (!options?.filter || options.filter(submit)) ? submit : null;
      },
    };
    return self;
  }

  async function click(customId, extra) {
    const interactionForClick = component(customId, extra);
    await dashboard.collector.listeners('collect')[0](interactionForClick);
    await settle();
    return interactionForClick;
  }

  async function edit(field, value) {
    await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field, value }));
    await flushPendingEmbedEditorUpdates(token);
    await settle();
  }

  async function color(hex) {
    await applyEmbedColorPickerSession(token, hex);
    await settle();
  }

  async function addGif(url = GIF_URL) {
    const submit = {
      user: OWNER,
      fields: { getUploadedFiles: () => new Collection([['gif', { url, name: 'pop-party.gif', contentType: 'image/gif' }]]) },
      async deferUpdate() { this.deferred = true; },
      async reply() {}, async followUp() {},
    };
    return click('simple_embed_media', { modalSubmit: submit });
  }

  async function post(channel = world.general) {
    const opener = await click('simple_embed_post_new');
    const picker = opener.children.at(-1);
    assert.ok(picker?.collector, 'channel picker opened');
    const select = component('simple_embed_post_channel:0:0', { values: [channel.id], message: picker });
    await picker.collector.listeners('collect')[0](select);
    await settle();
    return { opener, picker, select };
  }

  return {
    interaction, token, component, click, edit, color, addGif, post,
    get dashboard() { return dashboard; },
    get preview() { return preview; },
    dashboardText: () => dashboard.embeds[0]?.toJSON?.().description || '',
    save: () => click('simple_embed_post'),
    close: () => click('simple_embed_close'),
  };
}

async function searchChoices(world, query) {
  let choices = [];
  await builder.autocomplete({
    guildId: world.guildId, guild: world.guild, client: world.client, user: OWNER,
    member: { id: OWNER.id, user: OWNER },
    options: { getFocused: () => ({ name: 'search', value: query }) },
    async respond(value) { choices = value; },
  });
  return choices;
}

async function selectSearch(world, value) {
  return loadEmbedBuilderSearchSelection({
    id: nextId(), guildId: world.guildId, guild: world.guild, client: world.client,
    user: OWNER, member: { id: OWNER.id, user: OWNER },
    options: { getString: () => value },
    deferred: true,
  });
}

// Rows written by an earlier release, followed by Cloudy's ClientReady warmup.
async function seedLegacyRegistry(world, records) {
  world.storage.set('cloudy:embed-registry:' + world.guildId, records);
  await getEmbedRegistry(world.guildId);
  await prewarmEmbedBuilderSearch(world.guild);
}

function registry(world) {
  return world.storage.get('cloudy:embed-registry:' + world.guildId) || [];
}

function physical(world, channel = world.general) {
  return [...channel.messages.cache.values()];
}

// Runs the Reappear handler from messageCreate.js with the real registry,
// database facade and identity hooks (only its 2-second wait is skipped).
function reappearHandler() {
  const source = readFileSync('src/events/messageCreate.js', 'utf8');
  const start = source.indexOf('async function handleEmbedReappear');
  const identity = {
    lock: acquireEmbedBuilderMessageMutation,
    beginMove: beginEmbedRegistryMove,
    move: moveEmbedRegistryMessage,
    ownedPayload: withBuilderOwnedNonce,
    rememberOwned: rememberBuilderOwnedMessage,
    deleteForMove: deleteMessageForMove,
  };
  return new Function('getFromDb', 'setInDb', 'deleteFromDb', 'logger', 'setTimeout', 'reappearIdentity',
    `const reappearQueues = new Map(); ${source.slice(start)}; return handleEmbedReappear;`)(
    getFromDb, setInDb, deleteFromDb, logger, callback => callback(), identity,
  );
}

async function userMessage(world, handle, channel = world.general) {
  await handle({ guild: world.guild, channel, author: { id: OWNER.id, bot: false } });
  await drainGateway(world);
}

// ---------------------------------------------------------------------------
// The 12-step lifecycle required by the repair request
// ---------------------------------------------------------------------------
test('Test -> Yess lifecycle keeps one physical identity through Save, Search, restart, Delete and Repost', async t => {
  const world = createWorld(t, { gatewayFirst: true });

  // 1. A new embed "Test" is posted.
  const session = await openBuilder(t, world);
  await session.edit('title', 'Test');
  await session.edit('message', 'Original body');
  const { picker } = await session.post();
  await drainGateway(world);
  let messages = physical(world);
  assert.equal(messages.length, 1, 'exactly one physical message');
  const messageId = messages[0].id;
  let records = registry(world);
  assert.equal(records.length, 1, 'exactly one registry identity, despite the gateway registering first');
  assert.equal(records[0].messageId, messageId);
  assert.equal(records[0].source, 'embed-builder', 'Builder identity wins over the earlier "automatic" event');
  assert.equal(records[0].manualSaved, true);
  assert.equal(records[0].explicitSave, false, 'Post alone is not an explicit Save');
  assert.match(picker.embeds[0].toJSON().title, /Message sent/);
  assert.equal(picker.components.length, 0, 'the picker became a clean confirmation');
  assert.match(session.dashboardText(), /Editing existing embed/, 'the Builder now edits the posted message');
  const testChoices = await searchChoices(world, 'test');
  assert.deepEqual(testChoices.map(choice => choice.value), [`${world.general.id}:${messageId}:0`],
    'Search shows the new post immediately');

  // 2-4. Title -> Yess, pink side colour, logo removed and re-added, GIF added.
  await session.edit('title', 'Yess');
  await session.edit('message', 'Updated party body');
  await session.color('#FF69B4');
  await session.click('simple_embed_remove_logo');
  await session.click('simple_embed_logo');
  await session.addGif();

  // 5. Save edits the same physical message ID.
  await session.save();
  await drainGateway(world);
  messages = physical(world);
  assert.equal(messages.length, 1, 'Save never creates a second Discord message');
  assert.equal(messages[0].id, messageId, 'Save edits the same physical message ID');
  const live = messages[0].embeds[0].toJSON();
  assert.equal(live.title, 'Yess');
  assert.equal(live.description, 'Updated party body');
  assert.equal(live.color, PINK);
  assert.equal(live.image?.url, GIF_URL);
  assert.ok(live.thumbnail?.url, 'logo present');
  records = registry(world);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, messageId);
  assert.deepEqual(records[0].snapshot, live, 'registry snapshot equals the Discord embed exactly');
  assert.equal(records[0].explicitSave, true, 'Save is recorded as an explicit Save');
  assert.equal(world.storage.has('cloudy:embed-template:' + world.guildId + ':__global__'), false,
    'a Builder post never becomes a shared bot-response template');

  // 6. Search immediately shows only the current registration.
  assert.deepEqual(await searchChoices(world, 'test'), [], 'the old title is gone from Search');
  const yess = await searchChoices(world, 'yess');
  assert.deepEqual(yess.map(choice => choice.value), [`${world.general.id}:${messageId}:0`]);
  const selected = await selectSearch(world, yess[0].value);
  assert.equal(selected.record.messageId, messageId);
  assert.deepEqual(selected.record.snapshot, live, 'Search preview equals the saved Discord embed');

  // 7. A fresh process (bot restart, empty in-memory and Redis caches) reads
  // the same durable state and still shows only Yess.
  const restarted = runInFreshProcess(world, ['test', 'yess']);
  assert.deepEqual(restarted.records.map(record => [record.messageId, record.title]), [[messageId, 'Yess']]);
  assert.deepEqual(restarted.search.test, []);
  assert.deepEqual(restarted.search.yess, [`${world.general.id}:${messageId}:0`]);

  // 8. Saving again (no change, then a change) never creates a duplicate.
  await session.save();
  await session.edit('message', 'Second save body');
  await session.save();
  await drainGateway(world);
  assert.equal(physical(world).length, 1);
  records = registry(world);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, messageId);
  assert.equal(records[0].snapshot.description, 'Second save body');
  assert.equal(records[0].snapshot.color, PINK, 'colour retained by a text-only Save');
  assert.equal(records[0].snapshot.image?.url, GIF_URL, 'GIF retained by a text-only Save');

  // 9. A second concurrent Save (another Builder session) and a late stale
  // gateway/history snapshot never restore an older version.
  const baseline = registry(world)[0];
  const sessionA = {}; const sessionB = {};
  loadRecordSnapshotIntoState(sessionA, world.guild, baseline);
  loadRecordSnapshotIntoState(sessionB, world.guild, baseline);
  sessionA.title = 'Yess!';
  sessionB.message = 'Concurrent body';
  const [savedA, savedB] = await Promise.all([saveModifiedEmbed(world.guild, sessionA), saveModifiedEmbed(world.guild, sessionB)]);
  assert.equal(savedA.ok && savedB.ok, true);
  const staleTest = { ...messages[0], embeds: [new Embed({ title: 'Test', description: 'Original body', color: 0xFFFFFF })] };
  await registerCloudyEmbedMessage(staleTest, 'automatic-update');
  await registerCloudyEmbedMessage(staleTest, 'bot-history');
  await drainGateway(world);
  const concurrentLive = physical(world)[0].embeds[0].toJSON();
  assert.equal(concurrentLive.title, 'Yess!', 'first concurrent Save kept');
  assert.equal(concurrentLive.description, 'Concurrent body', 'second concurrent Save merged, not reverted');
  assert.equal(concurrentLive.color, PINK);
  records = registry(world);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].snapshot, concurrentLive, 'stale gateway/history snapshots are ignored');

  // 12 (before Delete). A deliberate Repost publishes a new physical identity.
  const reposting = await openBuilder(t, world, { search: `${world.general.id}:${messageId}:0` });
  assert.match(reposting.dashboardText(), /Editing existing embed/);
  await reposting.post(world.general);
  await drainGateway(world);
  messages = physical(world);
  assert.equal(messages.length, 1, 'Repost leaves exactly one live copy');
  const repostedId = messages[0].id;
  assert.notEqual(repostedId, messageId, 'Repost receives a new message ID');
  assert.deepEqual(messages[0].embeds[0].toJSON().title, 'Yess!');
  records = registry(world);
  assert.deepEqual(records.map(record => record.messageId), [repostedId], 'one registry identity, on the new ID');
  assert.equal(records[0].explicitSave, true, 'the Saved state moves with the Repost');
  assert.deepEqual((await searchChoices(world, 'yess')).map(choice => choice.value),
    [`${world.general.id}:${repostedId}:0`]);

  // 10. Delete + Confirm delete is one definitive operation.
  const choicesBeforeDelete = await searchChoices(world, 'yess');
  const deleting = await openBuilder(t, world, { search: choicesBeforeDelete[0].value });
  await deleting.click('simple_embed_delete_from_builder');
  await deleting.save(); // "Confirm delete"
  await drainGateway(world);
  assert.equal(physical(world).length, 0, 'the Discord message is deleted');
  assert.deepEqual(registry(world), [], 'the registry identity is deleted');
  assert.deepEqual(await searchChoices(world, 'yess'), []);
  assert.ok((world.storage.get('cloudy:embed-registry-deleted:' + world.guildId) || [])
    .includes(`${world.general.id}:${repostedId}`), 'the Delete is permanent across restarts');

  // 11. Old asynchronous results restore nothing.
  const deletedMessage = { ...messages[0], embeds: [new Embed(records[0].snapshot)] };
  await registerCloudyEmbedMessage(deletedMessage, 'embed-builder', { manualSave: true });
  await registerCloudyEmbedMessage(deletedMessage, 'automatic');
  await registerCloudyEmbedMessage(deletedMessage, 'bot-history');
  await reconcileEmbedRegistry(world.guild);
  assert.deepEqual(registry(world), []);
  assert.equal(await selectSearch(world, choicesBeforeDelete[0].value), null,
    'an old autocomplete choice cannot reopen the deleted embed');
  assert.deepEqual(await searchChoices(world, 'yess'), []);
  const afterRestart = runInFreshProcess(world, ['yess', 'test']);
  assert.deepEqual(afterRestart.records, []);
  assert.deepEqual(afterRestart.search.yess, []);
});

// ---------------------------------------------------------------------------
// Pop / Pop 57: which physical messages do the results belong to?
// ---------------------------------------------------------------------------
test('"Pop" and "Pop 57" as two real posts are two results, each bound to its own message ID', async t => {
  const world = createWorld(t);
  const first = await openBuilder(t, world);
  await first.edit('title', 'Pop 57');
  await first.edit('message', 'Numbered pop');
  await first.post();
  const second = await openBuilder(t, world);
  await second.edit('title', 'Pop');
  await second.edit('message', 'Plain pop');
  await second.post();
  await drainGateway(world);
  const [pop57, pop] = physical(world).sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
  assert.equal(pop57.embeds[0].title, 'Pop 57');
  assert.equal(pop.embeds[0].title, 'Pop');
  const choices = await searchChoices(world, 'pop');
  assert.deepEqual(choices.map(choice => [choice.name, choice.value]).sort(), [
    ['Pop', `${world.general.id}:${pop.id}:0`],
    ['Pop 57', `${world.general.id}:${pop57.id}:0`],
  ].sort());
  assert.equal(registry(world).length, 2, 'two different physical messages, two identities');
});

test('Reappear moves the saved "Pop" identity and never resurrects the old "Pop 57" version', async t => {
  const world = createWorld(t);
  const handle = reappearHandler();
  const session = await openBuilder(t, world);
  await session.edit('title', 'Pop 57');
  await session.edit('message', 'Party starts');
  const reappear = {
    customId: 'simple_embed_reappear_modal', user: OWNER,
    fields: { getTextInputValue: () => '1' },
    async deferUpdate() {}, async reply() {},
  };
  const reappearClick = session.component('simple_embed_reappear');
  reappearClick.showModal = async modal => { reappear.customId = modal.data.custom_id; };
  reappearClick.awaitModalSubmit = async () => reappear;
  await session.dashboard.collector.listeners('collect')[0](reappearClick);
  await settle();
  await session.post();
  await drainGateway(world);
  const originalId = physical(world)[0].id;

  // The owner renames it to "Pop", pink, with a GIF, and saves.
  await session.edit('title', 'Pop');
  await session.color('#FF69B4');
  await session.addGif();
  await session.save();
  await drainGateway(world);

  // A member writes in the channel: Reappear moves the embed to the bottom.
  await userMessage(world, handle);
  let messages = physical(world);
  assert.equal(messages.length, 1, 'never two copies in the channel');
  const movedId = messages[0].id;
  assert.notEqual(movedId, originalId, 'the embed moved to a new message');
  const moved = messages[0].embeds[0].toJSON();
  assert.equal(moved.title, 'Pop', 'the saved title is reposted, not the old Pop 57');
  assert.equal(moved.color, PINK);
  assert.equal(moved.image?.url, GIF_URL);
  let records = registry(world);
  assert.equal(records.length, 1, 'no detached ghost of the old message and no extra automatic row');
  assert.equal(records[0].messageId, movedId);
  assert.equal(records[0].source, 'embed-builder');
  assert.equal(records[0].explicitSave, true);
  assert.deepEqual(await searchChoices(world, 'pop 57'), []);
  assert.deepEqual((await searchChoices(world, 'pop')).map(choice => choice.value), [`${world.general.id}:${movedId}:0`]);

  // The Builder that was open during the move still targets the old ID.
  // Its next Save follows the same identity to the moved message.
  await session.edit('message', 'Edited after the move');
  await session.save();
  await drainGateway(world);
  messages = physical(world);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, movedId, 'Save edited the moved message, no extra copy');
  assert.equal(messages[0].embeds[0].toJSON().description, 'Edited after the move');
  assert.equal(messages[0].embeds[0].toJSON().title, 'Pop');
  records = registry(world);
  assert.deepEqual(records.map(record => record.messageId), [movedId]);
  assert.equal(records[0].snapshot.description, 'Edited after the move');

  // A second move still keeps one identity and carries the latest Save.
  await userMessage(world, handle);
  messages = physical(world);
  assert.equal(messages.length, 1);
  records = registry(world);
  assert.deepEqual(records.map(record => record.messageId), [messages[0].id]);
  assert.equal(messages[0].embeds[0].toJSON().description, 'Edited after the move');

  // Delete from the Builder ends the whole Reappear chain permanently.
  const deleting = await openBuilder(t, world, { search: `${world.general.id}:${messages[0].id}:0` });
  await deleting.click('simple_embed_delete_from_builder');
  await deleting.save();
  await drainGateway(world);
  await userMessage(world, handle);
  await userMessage(world, handle);
  assert.equal(physical(world).length, 0, 'a deleted embed never reappears');
  assert.deepEqual(registry(world), []);
  assert.deepEqual(await searchChoices(world, 'pop'), []);
});

test('a Save and a Reappear move at the same moment keep the saved version on one identity', async t => {
  const world = createWorld(t);
  const handle = reappearHandler();
  const session = await openBuilder(t, world);
  await session.edit('title', 'Pop 57');
  const reappear = {
    customId: 'simple_embed_reappear_modal', user: OWNER,
    fields: { getTextInputValue: () => '1' },
    async deferUpdate() {}, async reply() {},
  };
  const reappearClick = session.component('simple_embed_reappear');
  reappearClick.showModal = async modal => { reappear.customId = modal.data.custom_id; };
  reappearClick.awaitModalSubmit = async () => reappear;
  await session.dashboard.collector.listeners('collect')[0](reappearClick);
  await settle();
  await session.post();
  await drainGateway(world);
  await session.edit('title', 'Pop');
  await session.color('#FF69B4');
  await Promise.all([session.save(), userMessage(world, handle)]);
  await drainGateway(world);
  const messages = physical(world);
  assert.equal(messages.length, 1, 'never two copies');
  const live = messages[0].embeds[0].toJSON();
  assert.equal(live.title, 'Pop', 'the concurrent Save is not reverted by the move');
  assert.equal(live.color, PINK);
  const records = registry(world);
  assert.deepEqual(records.map(record => record.messageId), [messages[0].id]);
  assert.deepEqual(records[0].snapshot, live);
  assert.deepEqual(await searchChoices(world, 'pop 57'), []);
});

test('a legacy Pop 57 Reappear copy is deleted together with the Builder record that owns its rule', async t => {
  const world = createWorld(t);
  const handle = reappearHandler();
  // Legacy state from before this repair: Reappear already moved the post
  // once, leaving a detached saved "Pop" and a live "automatic" "Pop 57".
  const live = await world.general.send({
    embeds: [{ title: 'Pop 57', description: 'Old frozen copy', footer: { text: 'Cloudy footer​' } }],
  });
  const originId = nextId();
  world.storage.set(`cloudy:embed-reappear-index:${world.guildId}:${world.general.id}`, [originId]);
  world.storage.set(`cloudy:embed-reappear:${world.guildId}:${world.general.id}:${originId}`, {
    every: 1, count: 0, messageId: live.id, originMessageId: originId, embedIndex: 0,
    embed: { title: 'Pop 57', description: 'Old frozen copy' }, components: [],
  });
  await seedLegacyRegistry(world, [
    { guildId: world.guildId, channelId: world.general.id, messageId: originId, embedIndex: 0,
      source: 'embed-builder', manualSaved: true, detached: true, title: 'Pop', name: 'Pop',
      snapshot: { title: 'Pop', description: 'Saved', footer: { text: 'Cloudy footer​' } }, components: [] },
    { guildId: world.guildId, channelId: world.general.id, messageId: live.id, embedIndex: 0,
      source: 'automatic', manualSaved: false, title: 'Pop 57', name: 'Pop 57',
      snapshot: live.embeds[0].toJSON(), components: [] },
  ]);
  await drainGateway(world);

  // The live legacy copy is recognised as the Builder post it is.
  const popChoices = await searchChoices(world, 'pop 57');
  assert.deepEqual(popChoices.map(choice => choice.value), [`${world.general.id}:${live.id}:0`]);
  const deleting = await openBuilder(t, world, { search: popChoices[0].value });
  await deleting.click('simple_embed_delete_from_builder');
  await deleting.save();
  await drainGateway(world);
  await userMessage(world, handle);
  assert.equal(physical(world).length, 0, 'the frozen Pop 57 is not reposted after Delete');
  assert.deepEqual(registry(world).filter(record => !record.detached), []);
});

// ---------------------------------------------------------------------------
// Existing (pre-repair) misclassified posts: logo, colour, GIF preserved
// ---------------------------------------------------------------------------
test('a legacy post stored as "automatic" is edited as a Builder post: same logo, colour and GIF, no shared template', async t => {
  const world = createWorld(t);
  const message = await world.general.send({
    embeds: [{
      title: 'Test', description: 'Body', color: PINK,
      thumbnail: { url: DARK_LOGO }, image: { url: GIF_URL },
      footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.​' },
    }],
  });
  await seedLegacyRegistry(world, [{
    guildId: world.guildId, channelId: world.general.id, messageId: message.id, embedIndex: 0,
    source: 'automatic', manualSaved: true, title: 'Test', name: 'Test',
    snapshot: message.embeds[0].toJSON(), components: [],
  }]);
  const [choice] = await searchChoices(world, 'test');
  const session = await openBuilder(t, world, { search: choice.value });
  await session.edit('title', 'Yess');
  await session.save();
  await drainGateway(world);
  const live = physical(world)[0].embeds[0].toJSON();
  assert.equal(live.title, 'Yess');
  assert.equal(live.thumbnail?.url, DARK_LOGO, 'the existing dark logo is never replaced by the white C');
  assert.equal(live.color, PINK);
  assert.equal(live.image?.url, GIF_URL);
  assert.equal(world.storage.has('cloudy:embed-template:' + world.guildId + ':__global__'), false);
  const [record] = registry(world);
  assert.equal(record.source, 'embed-builder');
  assert.deepEqual(record.snapshot, live);
});

test('generic template/branding passes never restyle a fresh Builder post', async t => {
  const world = createWorld(t);
  // A shared bot-response template that happens to use the same title.
  world.storage.set('cloudy:embed-template:' + world.guildId + ':__global__', {
    test: { title: 'Test', color: 0xFFFFFF, applyThumbnail: true, thumbnail: { url: 'https://example.com/white-c.gif' }, schemaVersion: 3 },
  });
  const session = await openBuilder(t, world);
  await session.edit('title', 'Test');
  await session.edit('message', 'Body');
  await session.color('#FF69B4');
  await session.post();
  await drainGateway(world);
  const [message] = physical(world);
  assert.equal(message.edits, 0, 'no automatic edit after Post');
  assert.equal(message.embeds[0].toJSON().color, PINK);
});

// ---------------------------------------------------------------------------
// Post confirmation lifecycle (no broken Discord references)
// ---------------------------------------------------------------------------
test('Close removes the Post confirmation before the dashboard it refers to', async t => {
  const world = createWorld(t);
  const session = await openBuilder(t, world);
  await session.edit('title', 'Test');
  const { picker } = await session.post();
  const dashboardId = session.dashboard.id;
  await session.close();
  const pickerIndex = world.deletedPrivate.indexOf(picker.id);
  const dashboardIndex = world.deletedPrivate.indexOf(dashboardId);
  assert.ok(pickerIndex >= 0, 'confirmation removed');
  assert.ok(dashboardIndex >= 0, 'dashboard removed');
  assert.ok(pickerIndex < dashboardIndex, 'no "Original message was deleted" reference is left behind');
});

test('the Post confirmation is a 10-second status reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deleted = [];
  const state = { builderChildMessages: new Map() };
  const confirmation = { id: 'confirmation-1', async delete() { deleted.push('message.delete'); } };
  const interaction = { webhook: { async deleteMessage(id) { deleted.push('webhook:' + id); } } };
  scheduleBuilderChildMessageRemoval(interaction, state, confirmation);
  t.mock.timers.tick(9_999);
  await settle(2);
  assert.deepEqual(deleted, []);
  t.mock.timers.tick(1);
  await settle(4);
  assert.deepEqual(deleted, ['webhook:confirmation-1']);
  assert.equal(state.builderChildMessages.size, 0);
});

// ---------------------------------------------------------------------------
// Manual deletion in Discord
// ---------------------------------------------------------------------------
test('a manual Discord deletion removes a posted-only embed but keeps an explicitly Saved one as a template', async t => {
  const world = createWorld(t);
  const postedOnly = await openBuilder(t, world);
  await postedOnly.edit('title', 'Only posted');
  await postedOnly.post();
  const saved = await openBuilder(t, world);
  await saved.edit('title', 'Explicitly saved');
  await saved.post();
  await saved.edit('message', 'Saved body');
  await saved.save();
  await drainGateway(world);
  for (const message of physical(world)) await message.delete();
  await drainGateway(world);
  const records = registry(world);
  assert.deepEqual(records.map(record => [record.title, record.detached]), [['Explicitly saved', true]]);
  assert.equal(physical(world).length, 0, 'a saved template is never reposted automatically');
  assert.deepEqual(await searchChoices(world, 'only posted'), []);
});

// ---------------------------------------------------------------------------
// Fresh-process restart check
// ---------------------------------------------------------------------------
function runInFreshProcess(world, queries) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cloudy-restart-'));
  try {
    const stateFile = path.join(dir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({
      guildId: world.guildId,
      channelId: world.general.id,
      storage: [...world.storage.entries()],
      physical: physical(world).map(message => ({
        id: message.id,
        embeds: message.embeds.map(embed => embed.toJSON()),
        components: message.components,
      })),
      queries,
    }));
    const script = path.resolve('test/fixtures/embedBuilderRestartProbe.mjs');
    const result = spawnSync(process.execPath, [script, stateFile], {
      encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'error' }, cwd: path.resolve('.'),
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split('\n').find(entry => entry.startsWith('RESULT '));
    assert.ok(line, result.stdout + result.stderr);
    return JSON.parse(line.slice('RESULT '.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a picture form that was closed and opened again answers the submit only once', async t => {
  const world = createWorld(t);
  const b = await openBuilder(t, world);
  // discord.js gives a submitted form to every open wait of this user.
  const waits = [];
  const awaitModalSubmit = function (options) {
    return new Promise(resolve => { waits.push({ filter: options.filter, resolve }); });
  };
  const collect = b.dashboard.collector.listeners('collect')[0];
  const first = b.component('simple_embed_media', { awaitModalSubmit });
  const second = b.component('simple_embed_media', { awaitModalSubmit });
  const firstRun = collect(first);
  const secondRun = collect(second);
  await settle();
  assert.equal(waits.length, 2, 'the first form was closed without sending, the second is open');
  const firstId = first.modal.toJSON().custom_id;
  const secondId = second.modal.toJSON().custom_id;
  assert.notEqual(firstId, secondId);

  let acknowledgements = 0;
  const submit = {
    customId: secondId, user: OWNER,
    fields: { getUploadedFiles: () => new Collection([['gif', { url: GIF_URL, name: 'pop-party.gif', contentType: 'image/gif' }]]) },
    async deferUpdate() { acknowledgements += 1; this.deferred = true; },
    async reply() {}, async followUp() {},
  };
  for (const wait of waits) wait.resolve(wait.filter(submit) ? submit : null);
  await Promise.all([firstRun, secondRun]);
  await settle();
  assert.equal(acknowledgements, 1, 'Discord gets one answer, never a rejected second one');
  assert.equal(b.preview.embeds[0].toJSON().image?.url, GIF_URL);
});

test('each Builder form id is unique per opening and is routed only to its own wait', async () => {
  const fs = await import('node:fs');
  const router = fs.readFileSync('src/events/interactionCreate.js', 'utf8');
  for (const prefix of ['simple_embed_content_modal:', 'simple_embed_footer_modal:', 'simple_embed_media_modal:']) {
    assert.ok(router.includes(`startsWith('${prefix}')`), prefix + ' is handled by the Builder itself');
  }
  const editor = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  assert.match(editor, /embed_button_add_link_modal:\$\{componentInteraction\.id\}/);
  assert.match(editor, /embed_button_edit_modal:\$\{rowIndex\}:\$\{componentIndex\}:\$\{componentInteraction\.id\}/);
});

test('Add media on a Builder that already has a picture replaces it at once, without Remove media', async t => {
  const world = createWorld(t);
  const b = await openBuilder(t, world);
  await b.addGif('https://cdn.discordapp.com/ephemeral-attachments/1/2/first.png?ex=a');
  assert.equal(b.preview.embeds[0].toJSON().image?.url, 'https://cdn.discordapp.com/ephemeral-attachments/1/2/first.png?ex=a');
  const replaced = await b.addGif('https://cdn.discordapp.com/ephemeral-attachments/1/3/second.gif?ex=b');
  assert.equal(replaced.modal.toJSON().custom_id.startsWith('simple_embed_media_modal:'), true);
  assert.equal(b.preview.embeds[0].toJSON().image?.url, 'https://cdn.discordapp.com/ephemeral-attachments/1/3/second.gif?ex=b');
  assert.match(b.dashboardText(), /Media\*\* › Picture \/ GIF set/);
});

test('saving again and again, re-adding the same picture, keeps one message, one banner and one Search item', async t => {
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'cloudy-repeat-save-'));
  const previous = { dir: process.env.CLOUDY_EMBED_MEDIA_DIR, base: process.env.CLOUDY_EMBED_MEDIA_BASE_URL };
  process.env.CLOUDY_EMBED_MEDIA_DIR = mediaDir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.example.com';
  t.after(() => {
    for (const [key, value] of [['CLOUDY_EMBED_MEDIA_DIR', previous.dir], ['CLOUDY_EMBED_MEDIA_BASE_URL', previous.base]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(mediaDir, { recursive: true, force: true });
  });
  // The same picture, uploaded again each time (Discord gives a new upload link).
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  t.mock.method(globalThis, 'fetch', async () => new Response(png, { status: 200 }));
  const upload = n => `https://cdn.discordapp.com/ephemeral-attachments/1534506224312389863/19${n}0000000000000000/banner.png?ex=${n}`;

  const world = createWorld(t);
  const b = await openBuilder(t, world);
  await b.edit('title', 'Rules');
  await b.edit('message', 'Version 0');
  await b.addGif(upload(1));
  await b.post();
  await drainGateway(world);
  const [posted] = physical(world);
  const permanent = posted.embeds[0].image.url;
  assert.match(permanent, /^https:\/\/cloudy\.example\.com\/cloudy-embed-media\/[a-f0-9]{64}\.png$/);

  for (let round = 1; round <= 3; round += 1) {
    await b.addGif(upload(round + 1));
    await b.edit('message', 'Version ' + round);
    await b.save();
    await drainGateway(world);
    const messages = physical(world);
    assert.equal(messages.length, 1, 'still one message after Save ' + round);
    assert.equal(messages[0].id, posted.id, 'Save edits the same message');
    assert.equal(messages[0].embeds.length, 1, 'no second embed');
    assert.equal(messages[0].embeds[0].image.url, permanent, 'the same picture keeps the same banner link');
    assert.equal(messages[0].embeds[0].description, 'Version ' + round);
    assert.equal(registry(world).filter(row => row.messageId === posted.id).length, 1, 'one Search item');
  }
  assert.equal(registry(world).length, 1);
  assert.equal(readdirSync(mediaDir).filter(name => !name.startsWith('.')).length, 1, 'one stored copy of the picture');
});

test('saving after every kind of change (other picture, no picture, colour, logo, footer, text) never leaves a duplicate', async t => {
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'cloudy-mixed-save-'));
  const previous = { dir: process.env.CLOUDY_EMBED_MEDIA_DIR, base: process.env.CLOUDY_EMBED_MEDIA_BASE_URL };
  process.env.CLOUDY_EMBED_MEDIA_DIR = mediaDir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.example.com';
  t.after(() => {
    for (const [key, value] of [['CLOUDY_EMBED_MEDIA_DIR', previous.dir], ['CLOUDY_EMBED_MEDIA_BASE_URL', previous.base]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(mediaDir, { recursive: true, force: true });
  });
  // Three different pictures; each upload gets its own Discord link.
  const picture = name => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(name)]);
  t.mock.method(globalThis, 'fetch', async url => new Response(picture(new URL(url).pathname.split('/').at(-1)), { status: 200 }));
  let uploads = 0;
  const upload = name => `https://cdn.discordapp.com/ephemeral-attachments/1534506224312389863/1${String(++uploads).padStart(18, '0')}/${name}?ex=${uploads}`;

  const world = createWorld(t);
  const b = await openBuilder(t, world);
  await b.edit('title', 'Rules');
  await b.edit('message', 'Start');
  await b.addGif(upload('a.png'));
  await b.post();
  await drainGateway(world);
  const [posted] = physical(world);
  const linkA = posted.embeds[0].image.url;
  const editPayloads = [];
  const originalEdit = posted.edit.bind(posted);
  posted.edit = async payload => { editPayloads.push(payload); return originalEdit(payload); };

  const PERMANENT = /^https:\/\/cloudy\.example\.com\/cloudy-embed-media\/[a-f0-9]{64}\.png$/;
  async function saveAndCheck(label, expectImage) {
    await b.save();
    await drainGateway(world);
    const messages = physical(world);
    assert.equal(messages.length, 1, label + ': still one message');
    assert.equal(messages[0].id, posted.id, label + ': Save edits the same message');
    assert.equal(messages[0].embeds.length, 1, label + ': one embed');
    const image = messages[0].embeds[0].image?.url ?? null;
    if (expectImage instanceof RegExp) assert.match(image || '', expectImage, label + ': banner');
    else assert.equal(image, expectImage, label + ': banner');
    assert.equal(registry(world).length, 1, label + ': one Search item');
    assert.ok(editPayloads.every(payload => !payload.files?.length), label + ': no extra loose image uploaded');
    return messages[0];
  }

  await b.addGif(upload('b.png'));
  await b.edit('message', 'Other picture');
  let saved = await saveAndCheck('other picture', PERMANENT);
  const linkB = saved.embeds[0].image.url;
  assert.notEqual(linkB, linkA);
  assert.equal(saved.embeds[0].description, 'Other picture');

  await b.color('#FF0000');
  await b.edit('footer', 'New footer');
  saved = await saveAndCheck('colour and footer', linkB);
  assert.equal(saved.embeds[0].color, 0xFF0000);
  assert.match(saved.embeds[0].footer?.text || '', /^New footer/);

  await b.click('simple_embed_remove_logo');
  saved = await saveAndCheck('logo removed', linkB);
  assert.equal(saved.embeds[0].thumbnail ?? null, null);
  await b.click('simple_embed_logo');
  saved = await saveAndCheck('logo added', linkB);
  assert.ok(saved.embeds[0].thumbnail?.url);

  await b.click('simple_embed_clear_media');
  await saveAndCheck('picture removed', null);

  await b.addGif(upload('c.png'));
  saved = await saveAndCheck('new picture after removing', PERMANENT);
  assert.notEqual(saved.embeds[0].image.url, linkB);

  await b.addGif(upload('a.png'));
  await b.edit('title', 'Rules (final)');
  saved = await saveAndCheck('first picture again', linkA);
  assert.equal(saved.embeds[0].title, 'Rules (final)');
});

test('/embedbuilder brings back the same open Builder after Discord removed it from the screen; the editor keeps working', async t => {
  const world = createWorld(t);
  const first = await openBuilder(t, world);
  await first.edit('title', 'Long editor session');
  await first.edit('message', 'Written over many minutes');
  await first.addGif();
  // The browser editor is open.
  assert.equal((await applyEmbedColorPickerSession(first.token, '__CLOUDY_EMBED_OPEN__:phone', { editorInstanceId: 'phone' })).ok, true);
  const oldPreview = first.preview;
  const oldDashboard = first.dashboard;

  // Back in Discord the private Builder is gone; the owner runs /embedbuilder.
  const again = await openBuilder(t, world);
  assert.equal(again.token, first.token, 'the same editor stays connected');
  assert.notEqual(again.preview.id, oldPreview.id);
  const preview = again.preview.embeds[0].toJSON();
  assert.equal(preview.title, 'Long editor session');
  assert.equal(preview.description, 'Written over many minutes');
  assert.equal(preview.image?.url, GIF_URL);
  assert.match(again.dashboardText(), /Media\*\* › Picture \/ GIF set/);
  await settle();
  assert.ok(world.deletedPrivate.includes(oldPreview.id), 'the old preview is removed when Discord still allows it');
  assert.ok(world.deletedPrivate.includes(oldDashboard.id), 'the old controls are removed too');

  // Typing in the same editor page updates the new preview.
  assert.equal((await applyEmbedColorPickerSession(again.token, '__CLOUDY_EMBED_HEARTBEAT__', { editorInstanceId: 'phone' })).ok, true);
  const typed = await applyEmbedColorPickerSession(again.token,
    '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'Still the same Builder' }),
    { editorInstanceId: 'phone' });
  assert.equal(typed.ok, true);
  await flushPendingEmbedEditorUpdates(again.token);
  await settle();
  assert.equal(again.preview.embeds[0].toJSON().title, 'Still the same Builder');

  // The open editor holds the new Builder messages (no 5-minute timer).
  const { deleteBuilderSessionMessage } = await import('../src/utils/builderSessionCleanup.js');
  assert.equal(await deleteBuilderSessionMessage(again.dashboard), false, 'held while the editor is open');
});

test('/embedbuilder with a Search still opens the chosen embed instead of the open draft', async t => {
  const world = createWorld(t);
  const first = await openBuilder(t, world);
  await first.edit('title', 'Open draft');
  const searched = await openBuilder(t, world, { search: 'something else' });
  assert.notEqual(searched.token, first.token);
  assert.notEqual(searched.preview.embeds[0].toJSON().title, 'Open draft');
});

test('/embedbuilder within 5 minutes after closing the editor still brings back the same Builder', async t => {
  const world = createWorld(t);
  const first = await openBuilder(t, world);
  assert.equal((await applyEmbedColorPickerSession(first.token, '__CLOUDY_EMBED_OPEN__:page', { editorInstanceId: 'page' })).ok, true);
  const typed = await applyEmbedColorPickerSession(first.token,
    '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'Written in the editor' }), { editorInstanceId: 'page' });
  assert.equal(typed.ok, true);
  await flushPendingEmbedEditorUpdates(first.token);
  // The owner closes the editor; back in Discord the Builder is no longer shown.
  assert.equal((await applyEmbedColorPickerSession(first.token, '__CLOUDY_EMBED_CLOSE__', { editorInstanceId: 'page' })).ok, true);
  const again = await openBuilder(t, world);
  assert.equal(again.token, first.token);
  assert.equal(again.preview.embeds[0].toJSON().title, 'Written in the editor');
  // And the editor can be opened again from the new Builder.
  assert.equal((await applyEmbedColorPickerSession(again.token, '__CLOUDY_EMBED_OPEN__:page2', { editorInstanceId: 'page2' })).ok, true);
});

test('/embedbuilder brings back the same open Builder without the editor, while it has not closed yet', async t => {
  const world = createWorld(t);
  const first = await openBuilder(t, world);
  await first.edit('title', 'Draft without editor');
  await first.addGif();
  const oldDashboard = first.dashboard;
  // Discord removed the private Builder from the screen; the owner runs /embedbuilder.
  const again = await openBuilder(t, world);
  assert.equal(again.token, first.token, 'same Builder session');
  assert.notEqual(again.dashboard.id, oldDashboard.id);
  const preview = again.preview.embeds[0].toJSON();
  assert.equal(preview.title, 'Draft without editor');
  assert.equal(preview.image?.url, GIF_URL);
  await settle();
  assert.ok(world.deletedPrivate.includes(oldDashboard.id), 'the old controls are removed');
});

test('the real Builder: the editor holds controls and preview together; after closing it, clicks restart the 30 minutes; then both close and the posted embed stays', async t => {
  const { registerBuilderSessionCollector, touchBuilderSessionMessage } = await import('../src/utils/builderSessionCleanup.js');
  const world = createWorld(t);
  const b = await openBuilder(t, world);
  await b.edit('title', 'Kept while editing');
  await b.edit('message', 'Posted first');
  await b.post();
  await drainGateway(world);
  const [posted] = physical(world);
  const panel = b.dashboard;
  const preview = b.preview;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  // What installBuilderSessionCleanup does for the real Discord panel.
  assert.equal(registerBuilderSessionCollector(panel, panel.collector), true);
  touchBuilderSessionMessage(panel);
  panel.collector.on('collect', () => touchBuilderSessionMessage(panel));
  const MINUTE = 60_000;
  const gone = () => [panel.id, preview.id].filter(id => world.deletedPrivate.includes(id));

  // Browser editor open, then the owner switches apps: Safari sends nothing for 13 minutes.
  assert.equal((await applyEmbedColorPickerSession(b.token, '__CLOUDY_EMBED_OPEN__:phone', { editorInstanceId: 'phone' })).ok, true);
  t.mock.timers.tick(13 * MINUTE);
  await settle();
  assert.deepEqual(gone(), [], 'controls and preview stay while the editor is open');
  // Back in the editor: its heartbeat arrives at once, then every few minutes for 30 minutes.
  assert.equal((await applyEmbedColorPickerSession(b.token, '__CLOUDY_EMBED_HEARTBEAT__', { editorInstanceId: 'phone' })).ok, true);
  for (let minute = 0; minute < 30; minute += 10) {
    t.mock.timers.tick(10 * MINUTE);
    assert.equal((await applyEmbedColorPickerSession(b.token, '__CLOUDY_EMBED_HEARTBEAT__', { editorInstanceId: 'phone' })).ok, true);
  }
  await settle();
  assert.deepEqual(gone(), []);

  // Closing the editor leaves the Builder usable; each click restarts the 30 minutes.
  assert.equal((await applyEmbedColorPickerSession(b.token, '__CLOUDY_EMBED_CLOSE__', { editorInstanceId: 'phone' })).ok, true);
  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(25 * MINUTE);
    panel.collector.emit('collect', b.component('simple_embed_unknown_noop'));
  }
  await settle();
  assert.deepEqual(gone(), [], 'clicks keep the Builder open');
  assert.equal(panel.collector.ended, false);

  // 30 minutes without any activity: controls and preview close together.
  t.mock.timers.tick(29 * MINUTE);
  await settle();
  assert.deepEqual(gone(), [], 'still open after 29 minutes');
  t.mock.timers.tick(MINUTE);
  await settle();
  assert.deepEqual(gone().sort(), [panel.id, preview.id].sort());
  assert.equal(physical(world).length, 1, 'the posted embed is never part of the cleanup');
  assert.equal(physical(world)[0].id, posted.id);
  assert.equal(registry(world).length, 1, 'its saved data stays');
});
