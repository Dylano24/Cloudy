import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Collection, ChannelType } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import {
  deleteMessageForMove, resetDeletionAttributionState, wasDeletedForMove,
} from '../src/services/deletionAttributionService.js';
import { createStickyGuideManager } from '../src/services/stickyGuideService.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

function world() {
  resetDeletionAttributionState();
  const values = new Map([[`guild:${CLOUDY_GUILD_ID}:config`, { logging: { enabled: false } }]]);
  const storage = { get: async key => values.get(key) || null, set: async (key, value) => { values.set(key, value); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner', name: 'Cloudy', client,
    members: { me: {}, cache: new Collection(), fetch: async () => null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(guild.id, guild);
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID]) {
    guild.channels.cache.set(id, { id, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
      send: async payload => { sent.push({ id, embed: payload.embeds?.[0]?.toJSON?.() }); return { id: 'log', attachments: new Collection() }; } });
  }
  const botMessage = (id, { deleteError = null } = {}) => ({ id, guild, guildId: guild.id, client,
    author: { id: 'bot', bot: true }, createdTimestamp: 1000, content: '',
    embeds: [{ title: 'Server rules', description: 'Be kind' }],
    channelId: 'general', channel: { id: 'general' }, attachments: new Collection(),
    delete: async () => { if (deleteError) throw deleteError; } });
  return { guild, sent, botMessage };
}

test('a Reappear or sticky guide move is not logged as a deleted message', async () => {
  const w = world();
  const message = w.botMessage('moved-1');
  await deleteMessageForMove(message);
  assert.equal(await wasDeletedForMove('moved-1'), true);
  await logDeletedMessage(message, { deletedBy: { id: 'bot', label: '<@bot>', source: 'cloudy', bot: true } });
  assert.deepEqual(w.sent, []);
});

test('the gateway event may arrive before Cloudy\'s delete request finishes', async () => {
  const w = world();
  let finish;
  const message = w.botMessage('moved-2');
  message.delete = () => new Promise(resolve => { finish = resolve; });
  const deletion = deleteMessageForMove(message);
  const logging = logDeletedMessage(message, { deletedBy: { id: 'bot', label: '<@bot>', source: 'cloudy', bot: true } });
  finish();
  await deletion;
  await logging;
  assert.deepEqual(w.sent, []);
});

test('a move whose delete failed (someone else removed it first) is still logged', async () => {
  const w = world();
  const message = w.botMessage('moved-3', { deleteError: Object.assign(new Error('Unknown Message'), { code: 10008 }) });
  await assert.rejects(deleteMessageForMove(message), /Unknown Message/);
  assert.equal(await wasDeletedForMove('moved-3'), false);
  await logDeletedMessage(message, { deletedBy: { id: 'mod', label: '<@mod>', source: 'audit', bot: false } });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].id, OWNER_MOD_MESSAGE_LOG_ID);
});

test('every other deletion of a Cloudy message is still logged in the Staff log', async () => {
  const w = world();
  const message = w.botMessage('removed-1');
  await message.delete();
  await logDeletedMessage(message, { deletedBy: { id: 'bot', label: '<@bot>', source: 'cloudy', bot: true } });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].id, OWNER_MOD_MESSAGE_LOG_ID);
  assert.match(JSON.stringify(w.sent[0].embed), /Server rules/);
});

test('Reappear deletes the old copy through the move deletion', async () => {
  resetDeletionAttributionState();
  const source = readFileSync('src/events/messageCreate.js', 'utf8');
  assert.match(source, /deleteForMove: deleteMessageForMove,/);
  const start = source.indexOf('async function handleEmbedReappear');
  const values = new Map([
    ['cloudy:embed-reappear-index:g:c', ['original']],
    ['cloudy:embed-reappear:g:c:original', { every: 1, count: 0, messageId: 'old', embed: { title: 'Rules' }, components: [] }],
  ]);
  const identity = {
    lock: async () => () => {}, beginMove: () => () => {}, move: async () => true,
    ownedPayload: payload => payload, rememberOwned: () => {}, deleteForMove: deleteMessageForMove,
  };
  const handle = new Function('getFromDb', 'setInDb', 'deleteFromDb', 'logger', 'setTimeout', 'reappearIdentity', 'canonicalGamblingGuideEmbedData',
    `const reappearQueues = new Map(); ${source.slice(start)}; return handleEmbedReappear;`)(
    async (key, fallback) => structuredClone(values.get(key) ?? fallback),
    async (key, value) => { values.set(key, structuredClone(value)); return true; },
    async key => values.delete(key), { error() {}, warn() {}, info() {} }, callback => callback(), identity, embed => embed);
  const channel = { id: 'c', name: 'general',
    messages: { fetch: async id => (id === 'old' ? { id: 'old', embeds: [], components: [], delete: async () => {} } : null) },
    send: async () => ({ id: 'new', delete: async () => {} }) };
  await handle({ guild: { id: 'g' }, channel });
  assert.equal(await wasDeletedForMove('old'), true);
  assert.equal(await wasDeletedForMove('new'), false);
  assert.equal(values.get('cloudy:embed-reappear:g:c:original').messageId, 'new');
});

test('sticky guides delete their old copy through the move deletion', async () => {
  resetDeletionAttributionState();
  const bot = { id: 'bot', bot: true };
  const history = new Map();
  let nextId = 10;
  let state = null;
  const channel = { id: 'channel', client: { user: bot }, guild: { id: 'guild' }, lastMessageId: null };
  const add = (author, guide) => {
    const message = { id: String(++nextId), author, embeds: guide ? [{ title: 'Guide' }] : [],
      delete: async () => { history.delete(message.id); } };
    history.set(message.id, message);
    channel.lastMessageId = message.id;
    return message;
  };
  channel.messages = { fetch: async options => {
    if (options.message) return history.get(options.message);
    const list = new Map([...history.entries()].reverse());
    list.first = () => list.values().next().value;
    return list;
  } };
  channel.send = async payload => { const message = add(bot, true); message.embeds = payload.embeds; return message; };
  const manager = createStickyGuideManager({
    loadState: async () => state, saveState: async (_channel, value) => { state = value; return true; },
    buildPayload: async () => ({ embeds: [{ title: 'Guide' }] }),
    isGuide: message => message.embeds.some(embed => embed.title === 'Guide'), onError: () => {},
  });
  const old = add(bot, true);
  add({ id: 'user' }, false);
  await manager.refresh(channel);
  assert.equal(history.has(old.id), false);
  assert.equal(await wasDeletedForMove(old.id), true);
  assert.equal(await wasDeletedForMove(state.messageId), false);
});
