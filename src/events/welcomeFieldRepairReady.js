import { Events, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getWelcomeConfig } from '../utils/database.js';
import { getEmbedRegistry } from '../services/embedRegistryService.js';
import { refreshManualBuilderSearchRecord } from '../services/embedBuilderPhysicalSearchService.js';
import { withEmbedBuilderMessageMutation } from '../services/embedBuilderMutationLock.js';

// ONE-TIME REPAIR (owner's request, 7 Nov 2026). Remove this file once it has run.
// A Builder Save wrote Cloudy's code copy ({dynamic}, a literal "\u200b" text, the
// code's field names) into the fields of a real welcome message. Each broken
// welcome message gets the fields of the newest intact welcome message in the
// same channel; its own text, picture, logo and footer stay as they are.
const DONE_KEY = 'global:cloudy:welcome-field-repair-20261107';
const START_DELAY_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const WELCOME_TITLE = /^welcome to cloudy(?:\s+inc\.?)?$/i;
const BROKEN_TEXT = /\{dynamic\}|\\u200b/i;

const firstEmbed = message => message?.embeds?.[0]?.toJSON?.() || message?.embeds?.[0] || null;

function isWelcomeMessage(message, botId) {
  const embed = firstEmbed(message);
  // Builder previews are the /embedbuilder command's own reply: never touched.
  return Boolean(embed)
    && String(message.author?.id || '') === String(botId)
    && !message.interaction && !message.interactionMetadata && !message.webhookId
    && WELCOME_TITLE.test(String(embed.title || '').trim())
    && Array.isArray(embed.fields) && embed.fields.length > 0;
}

export function hasBrokenWelcomeFields(message) {
  return (firstEmbed(message)?.fields || [])
    .some(field => BROKEN_TEXT.test(`${field?.name || ''}\n${field?.value || ''}`));
}

async function recentMessages(channel) {
  const messages = [];
  let before;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await channel.messages.fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) });
    messages.push(...batch.values());
    if (batch.size < PAGE_SIZE) break;
    before = batch.last()?.id;
    if (!before) break;
  }
  return messages.sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
}

/** Repairs the broken welcome messages of one channel. Returns the repaired message IDs. */
export async function repairWelcomeChannel(guild, channel, botId) {
  const welcome = (await recentMessages(channel)).filter(message => isWelcomeMessage(message, botId));
  const broken = welcome.filter(hasBrokenWelcomeFields);
  if (!broken.length) return { repaired: [], broken: 0 };
  const intact = welcome.find(message => !hasBrokenWelcomeFields(message));
  if (!intact) {
    logger.warn(`[WELCOME_REPAIR] ${broken.length} broken welcome message(s) in #${channel.name}, but no intact one to copy from.`);
    return { repaired: [], broken: broken.length };
  }
  const fields = structuredClone(firstEmbed(intact).fields);
  const repaired = [];
  for (const message of broken) {
    // Same per-message lock as a Builder Save.
    const edited = await withEmbedBuilderMessageMutation(guild.id, channel.id, message.id, async () => {
      const fresh = await channel.messages.fetch(message.id, { force: true }).catch(() => null);
      if (!fresh || !hasBrokenWelcomeFields(fresh)) return null;
      const embeds = fresh.embeds.map((embed, index) => {
        const data = embed.toJSON?.() || { ...embed };
        if (index === 0) data.fields = structuredClone(fields);
        return data;
      });
      return fresh.edit({ embeds });
    });
    if (!edited) continue;
    repaired.push(String(edited.id));
    // Search and the Builder reopen the repaired message as it is now.
    const records = await getEmbedRegistry(guild.id, { cached: true }).catch(() => []);
    const record = records.find(item => String(item.messageId) === String(edited.id)
      && Number(item.embedIndex || 0) === 0);
    if (record) await refreshManualBuilderSearchRecord(guild, record).catch(() => null);
  }
  logger.warn(`[WELCOME_REPAIR] #${channel.name}: repaired ${repaired.length}/${broken.length} welcome message(s) `
    + `with the fields of ${intact.id}: ${repaired.join(', ') || 'none'}.`);
  return { repaired, broken: broken.length };
}

async function welcomeChannels(client, guild) {
  const me = guild.members?.me;
  const config = await getWelcomeConfig(client, guild.id).catch(() => null);
  const channels = new Map();
  const configured = config?.channelId
    ? guild.channels.cache.get(config.channelId) || await guild.channels.fetch(config.channelId).catch(() => null)
    : null;
  if (configured) channels.set(configured.id, configured);
  for (const channel of guild.channels.cache.values()) {
    if (/welcome/i.test(String(channel?.name || ''))) channels.set(channel.id, channel);
  }
  return [...channels.values()].filter(channel => channel?.isTextBased?.() && channel.messages?.fetch
    && (!me || channel.permissionsFor?.(me)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages,
    ])));
}

export async function runWelcomeFieldRepair(client) {
  if (await client.db?.get?.(DONE_KEY, false).catch(() => false)) {
    logger.warn('[WELCOME_REPAIR] Already done.');
    return;
  }
  let completed = true;
  for (const guild of client.guilds.cache.values()) {
    for (const channel of await welcomeChannels(client, guild)) {
      try {
        await repairWelcomeChannel(guild, channel, client.user.id);
      } catch (error) {
        completed = false;
        logger.error(`[WELCOME_REPAIR] #${channel.name} failed:`, error);
      }
    }
  }
  if (completed) await client.db?.set?.(DONE_KEY, true).catch(() => null);
}

export default {
  name: Events.ClientReady,
  once: true,
  execute(readyClient) {
    const timer = setTimeout(() => {
      runWelcomeFieldRepair(readyClient).catch(error => logger.error('[WELCOME_REPAIR] Failed:', error));
    }, START_DELAY_MS);
    timer.unref?.();
  },
};
