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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
  const contentButton = rows(dashboard).find(button => button.label === 'Edit title and message');
  const token = new URL(contentButton.url).searchParams.get('session');

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
      async awaitModalSubmit() { return extra.modalSubmit || null; },
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
      customId: 'simple_embed_media_modal', user: OWNER,
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
