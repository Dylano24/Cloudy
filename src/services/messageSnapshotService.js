import { MessageFlags, SnowflakeUtil } from 'discord.js';
import { redisDelete, redisGetJson, redisSetJson } from '../utils/redisCache.js';
import { OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID } from './messageLogDestination.js';
import { AUTOMOD_LOG_CHANNEL_ID, isBotActionFeedback } from './deletionAttributionService.js';

// A deleted message that Discord no longer has in Cloudy's memory (after a
// restart, or beyond discord.js' per-channel cache) arrives as an empty
// partial. This compact copy lets the deletion log still show its author,
// creation time, full text and attachments. Stored in Redis with a TTL and
// removed as soon as the deletion has been logged.
const SNAPSHOT_TTL_MS = Math.max(1, Number(process.env.MESSAGE_SNAPSHOT_TTL_HOURS) || 72) * 60 * 60_000;
const MEMORY_LIMIT = 2_000;
const MAX_CONTENT = 4_000;
const MAX_EMBED_TEXT = 2_000;
const MAX_ATTACHMENTS = 10;
const LOG_CHANNEL_IDS = new Set([OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID]);

const memory = new Map();

function snapshotKey(guildId, messageId) {
  return `msgsnap:${guildId}:${messageId}`;
}

function remember(key, snapshot) {
  memory.delete(key);
  memory.set(key, snapshot);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

export function embedText(embeds = []) {
  return embeds.map(embed => {
    const data = embed?.toJSON?.() || embed?.data || embed || {};
    return [
      data.author?.name,
      data.title,
      data.description,
      ...(data.fields || []).map(field => `${field.name}: ${field.value}`),
      data.footer?.text,
    ].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
}

export function attachmentSummary(attachment) {
  return {
    id: String(attachment.id || ''),
    name: String(attachment.name || 'file'),
    url: attachment.url || null,
    proxyURL: attachment.proxyURL || attachment.proxy_url || null,
    contentType: attachment.contentType || attachment.content_type || null,
    size: Number(attachment.size) || 0,
    description: attachment.description || null,
  };
}

export function shouldSnapshotMessage(message) {
  if (!message?.guildId || !message.id || message.partial) return false;
  if (LOG_CHANNEL_IDS.has(String(message.channelId))) return false;
  if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;
  // Join/pin/boost notices have no content worth restoring; Cloudy's own
  // status replies are never logged when deleted.
  if (message.system || isBotActionFeedback(message)) return false;
  return Boolean(message.content || message.attachments?.size || message.embeds?.length || message.stickers?.size);
}

export function buildMessageSnapshot(message) {
  return {
    v: 1,
    id: String(message.id),
    guildId: String(message.guildId),
    channelId: String(message.channelId),
    authorId: message.author?.id ? String(message.author.id) : null,
    authorBot: message.author?.bot === true,
    webhookId: message.webhookId ? String(message.webhookId) : null,
    content: String(message.content || '').slice(0, MAX_CONTENT),
    createdTimestamp: Number(message.createdTimestamp) || SnowflakeUtil.timestampFrom(message.id),
    attachments: [...(message.attachments?.values?.() || [])].slice(0, MAX_ATTACHMENTS).map(attachmentSummary),
    embedText: embedText(message.embeds || []).slice(0, MAX_EMBED_TEXT),
    stickers: [...(message.stickers?.values?.() || [])].map(sticker => String(sticker.name || '')).filter(Boolean),
  };
}

export async function captureMessageSnapshot(message) {
  if (!shouldSnapshotMessage(message)) return false;
  const snapshot = buildMessageSnapshot(message);
  const key = snapshotKey(snapshot.guildId, snapshot.id);
  remember(key, snapshot);
  return redisSetJson(key, snapshot, SNAPSHOT_TTL_MS).catch(() => false);
}

export async function getMessageSnapshot(guildId, messageId) {
  if (!guildId || !messageId) return null;
  const key = snapshotKey(guildId, messageId);
  const local = memory.get(key);
  if (local) return local;
  const stored = await redisGetJson(key).catch(() => null);
  return stored?.v === 1 && String(stored.id) === String(messageId) ? stored : null;
}

export async function forgetMessageSnapshot(guildId, messageId) {
  if (!guildId || !messageId) return;
  const key = snapshotKey(guildId, messageId);
  memory.delete(key);
  await redisDelete(key).catch(() => false);
}

// Test helper.
export function clearMessageSnapshotMemory() {
  memory.clear();
}
