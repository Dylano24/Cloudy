import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from './gameFeedService.js';
import { loadRustCommunityConfig } from './rustCommunityExtrasService.js';
import { isCloudyStaffMember } from './cloudyStaffAccess.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';

const caches = new WeakMap();
const recentHoneypotEvents = new Map();
const key = guildId => 'honeypot:' + guildId;

function cacheFor(client) {
  if (!caches.has(client)) caches.set(client, new Map());
  return caches.get(client);
}

export async function loadHoneypot(client, guildId) {
  const cache = cacheFor(client);
  const cached = cache.get(guildId);
  if (cached?.until > Date.now()) return cached.value;
  return Mutex.runExclusive(key(guildId), async () => {
    const current = cache.get(guildId);
    if (current?.until > Date.now()) return current.value;
    const saved = await client.db.get(key(guildId));
    const legacy = saved == null ? (await loadRustCommunityConfig(client, guildId)).honeypot : null;
    const value = saved ?? (legacy ? { ...legacy, enabled: true } : null);
    cache.set(guildId, { value, until: Date.now() + 30_000 });
    return value;
  });
}

async function saveHoneypot(client, guildId, value) {
  if (await client.db.set(key(guildId), value) === false) throw new Error('Could not save the honeypot settings.');
  cacheFor(client).set(guildId, { value, until: Date.now() + 30_000 });
  return value;
}

export function setHoneypot(client, guildId, channelId, logChannelId, mode = 'monitor') {
  if (!['monitor', 'kick'].includes(mode)) throw new Error('Invalid honeypot mode.');
  if (channelId === logChannelId) throw new Error('Use a separate channel for logs.');
  return Mutex.runExclusive(key(guildId), () => saveHoneypot(client, guildId, { channelId, logChannelId, mode, enabled: true }));
}

export async function setHoneypotEnabled(client, guildId, enabled) {
  await loadHoneypot(client, guildId);
  return Mutex.runExclusive(key(guildId), () => {
    const config = cacheFor(client).get(guildId)?.value;
    if (!config) {
      if (enabled) throw new Error('Run /honeypot setup to choose the channel and alert channel first.');
      return null;
    }
    return saveHoneypot(client, guildId, { ...config, enabled });
  });
}

export function honeypotEmbed(title, description, color = 0xFFFFFF) {
  return {
    title, description, color,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  };
}

export async function handleHoneypotMessage(message) {
  if (!message?.guild || !message.author || message.author.id === message.client.user?.id || message.webhookId) return false;
  const honeypot = await loadHoneypot(message.client, message.guild.id);
  if (!honeypot?.enabled || honeypot.channelId !== message.channelId) return false;
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || isCloudyStaffMember(member, {}, message.guild)
    || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return false;
  const activityKey = message.guild.id + ':' + message.author.id;
  const recent = recentHoneypotEvents.get(activityKey) || 0;
  if (recent > Date.now() - 15_000) return true;
  recentHoneypotEvents.set(activityKey, Date.now());
  // Do not delete messages or punish anyone unless kick mode was explicitly enabled.
  let outcome = 'Detected';
  if (honeypot.mode === 'kick') {
    if (member.kickable) {
      try {
        await member.kick('Posted in the configured honeypot channel');
        outcome = 'Kicked';
      } catch (error) {
        logger.warn('[HONEYPOT] Honeypot kick failed:', error);
        outcome = 'Kick failed';
      }
    } else {
      outcome = 'Cannot kick';
    }
  }
  const log = await message.guild.channels.fetch(honeypot.logChannelId).catch(() => null);
  if (log?.type === ChannelType.GuildText && log.permissionsFor(message.client.user)?.has(PermissionFlagsBits.SendMessages)) {
    await log.send({
      embeds: [honeypotEmbed('Honeypot alert',
        '**Member:** <@' + member.id + '>\n**Channel:** <#' + message.channelId + '>\n**Action:** ' + outcome,
        outcome === 'Kicked' ? 0x7A1712 : 0xFFFFFF)],
      allowedMentions: { parse: [] },
    }).catch(error => logger.warn('[HONEYPOT] Honeypot log failed:', error));
  }
  if (recentHoneypotEvents.size > 5000) recentHoneypotEvents.clear();
  return true;
}
