import { EmbedBuilder } from 'discord.js';
import {
  getEmbedRegistry,
  getEmbedRegistrySnapshot,
  registerCloudyEmbedMessage,
  removeEmbedRegistryMessage,
} from './embedRegistryService.js';
import { logger } from '../utils/logger.js';

const SYNC_CONCURRENCY = 6;
const RECENT_SYNC_TTL_MS = 3_000;
const DEFINITIVE_MISSING_CODES = new Set([10003, 10008, 50001, 50013]);
const avatarSyncQueues = new Map();
const recentAvatarSyncs = new Map();

function normalizeAvatarUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const url = new URL(text);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return text.split('?')[0].split('#')[0].replace(/\/$/, '').toLowerCase();
  }
}

function avatarUrlContainsUserId(value, userId) {
  const url = normalizeAvatarUrl(value);
  const id = String(userId || '');
  if (!url || !id) return false;

  return url.includes(`/avatars/${id}/`)
    || url.includes(`/users/${id}/avatars/`);
}

export function embedReferencesUser(embed, userId) {
  const id = String(userId || '');
  if (!embed || !id) return false;

  const data = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  const parts = [
    data?.title,
    data?.description,
    data?.author?.name,
    data?.footer?.text,
    ...(Array.isArray(data?.fields)
      ? data.fields.flatMap(field => [field?.name, field?.value])
      : []),
  ];

  return parts.some(part => String(part || '').includes(id));
}

export function shouldSyncProfileThumbnail(embed, userId, oldAvatarUrl) {
  const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
  const thumbnailUrl = data?.thumbnail?.url;
  if (!thumbnailUrl || !userId) return false;

  if (avatarUrlContainsUserId(thumbnailUrl, userId)) {
    return true;
  }

  const oldNormalized = normalizeAvatarUrl(oldAvatarUrl);
  return Boolean(
    oldNormalized
    && normalizeAvatarUrl(thumbnailUrl) === oldNormalized
    && embedReferencesUser(data, userId)
  );
}

function hasAvatarActuallyChanged(oldAvatarUrl, newAvatarUrl) {
  const oldNormalized = normalizeAvatarUrl(oldAvatarUrl);
  const newNormalized = normalizeAvatarUrl(newAvatarUrl);
  return Boolean(newNormalized && oldNormalized !== newNormalized);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
    () => run(),
  );
  await Promise.all(workers);
  return results;
}

async function withAvatarSyncLock(key, task) {
  const previous = avatarSyncQueues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(task);

  avatarSyncQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (avatarSyncQueues.get(key) === current) {
      avatarSyncQueues.delete(key);
    }
  }
}

function shouldSkipDuplicateSync(key, newAvatarUrl) {
  const fingerprint = normalizeAvatarUrl(newAvatarUrl);
  const now = Date.now();
  const previous = recentAvatarSyncs.get(key);

  if (previous?.fingerprint === fingerprint && now - previous.at < RECENT_SYNC_TTL_MS) {
    return true;
  }

  recentAvatarSyncs.set(key, { fingerprint, at: now });
  return false;
}

function groupCandidateRecords(records, userId, oldAvatarUrl) {
  const groups = new Map();

  for (const record of records) {
    const snapshot = getEmbedRegistrySnapshot(record);
    if (snapshot && !shouldSyncProfileThumbnail(snapshot, userId, oldAvatarUrl)) {
      continue;
    }

    const key = `${record.channelId}:${record.messageId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  return [...groups.values()];
}

async function updateMessageGroup(guild, records, userId, oldAvatarUrl, newAvatarUrl) {
  const first = records[0];
  if (!first) return 0;

  let channel = guild.channels.cache.get(first.channelId) || null;
  if (!channel) {
    try {
      channel = await guild.channels.fetch(first.channelId);
    } catch (error) {
      if (DEFINITIVE_MISSING_CODES.has(error?.code)) {
        await removeEmbedRegistryMessage(guild.id, first.channelId, first.messageId);
      }
      return 0;
    }
  }

  if (!channel?.messages?.fetch || !channel?.messages?.edit) return 0;

  let message = channel.messages.cache?.get?.(first.messageId) || null;
  if (!message) {
    try {
      message = await channel.messages.fetch(first.messageId);
    } catch (error) {
      if (DEFINITIVE_MISSING_CODES.has(error?.code)) {
        await removeEmbedRegistryMessage(guild.id, first.channelId, first.messageId);
      }
      return 0;
    }
  }

  if (!message?.embeds?.length) return 0;

  let changed = false;
  const embeds = message.embeds.map(embed => {
    if (!shouldSyncProfileThumbnail(embed, userId, oldAvatarUrl)) {
      return embed;
    }

    changed = true;
    return EmbedBuilder.from(embed).setThumbnail(newAvatarUrl);
  });

  if (!changed) return 0;

  try {
    const edited = await channel.messages.edit(message.id, { embeds });
    await registerCloudyEmbedMessage(edited, 'profile-avatar-sync');
    return 1;
  } catch (error) {
    logger.warn(`Could not refresh historical avatar in message ${message.id}: ${error.message}`);
    return 0;
  }
}

export async function syncProfileAvatarInGuild(guild, { userId, oldAvatarUrl, newAvatarUrl }) {
  if (!guild?.id || !userId || !hasAvatarActuallyChanged(oldAvatarUrl, newAvatarUrl)) {
    return { scannedMessages: 0, updatedMessages: 0 };
  }

  const queueKey = `${guild.id}:${userId}`;
  if (shouldSkipDuplicateSync(queueKey, newAvatarUrl)) {
    return { scannedMessages: 0, updatedMessages: 0 };
  }

  return withAvatarSyncLock(queueKey, async () => {
    const records = await getEmbedRegistry(guild.id);
    const groups = groupCandidateRecords(records, userId, oldAvatarUrl);
    if (!groups.length) {
      return { scannedMessages: 0, updatedMessages: 0 };
    }

    const results = await mapWithConcurrency(
      groups,
      SYNC_CONCURRENCY,
      group => updateMessageGroup(guild, group, userId, oldAvatarUrl, newAvatarUrl),
    );

    return {
      scannedMessages: groups.length,
      updatedMessages: results.reduce((total, value) => total + Number(value || 0), 0),
    };
  });
}

export async function syncGlobalUserAvatar(client, oldUser, newUser) {
  if (!client || !oldUser?.id || oldUser.id !== newUser?.id) return;

  const oldAvatarUrl = oldUser.displayAvatarURL({ size: 256 });
  const newAvatarUrl = newUser.displayAvatarURL({ size: 256 });
  if (!hasAvatarActuallyChanged(oldAvatarUrl, newAvatarUrl)) return;

  await Promise.all([...client.guilds.cache.values()].map(guild =>
    syncProfileAvatarInGuild(guild, {
      userId: newUser.id,
      oldAvatarUrl,
      newAvatarUrl,
    }),
  ));
}

export async function syncGuildMemberAvatar(oldMember, newMember) {
  if (!oldMember?.guild?.id || oldMember.id !== newMember?.id) return;

  const oldAvatarUrl = oldMember.displayAvatarURL({ size: 256 });
  const newAvatarUrl = newMember.displayAvatarURL({ size: 256 });
  if (!hasAvatarActuallyChanged(oldAvatarUrl, newAvatarUrl)) return;

  await syncProfileAvatarInGuild(newMember.guild, {
    userId: newMember.id,
    oldAvatarUrl,
    newAvatarUrl,
  });
}
