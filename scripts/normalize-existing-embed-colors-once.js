import { ChannelType, REST, Routes } from 'discord.js';
import { normalizeDefaultEmbedColor } from '../src/utils/embedColorPolicy.js';
import { getTicketLogTemplate } from '../src/utils/ticket/ticketLogTemplates.js';

const token = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.GUILD_ID || '1532882647838228723';
const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';
const BUILDER_FOOTER_MARKER = '\u200B';

if (!token || !guildId) {
  console.log('[EMBED_COLOR_MIGRATION_ONCE] skipped: missing Discord token or guild id');
  process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(token);
const bot = await rest.get(Routes.user('@me'));
const channels = await rest.get(Routes.guildChannels(guildId));
const channelById = new Map(channels.map(channel => [String(channel.id), channel]));

const stats = {
  channels: 0,
  checked: 0,
  updated: 0,
  protectedTicket: 0,
  protectedFixedLog: 0,
  protectedBuilder: 0,
  protectedPreview: 0,
  protectedCatalog: 0,
  failed: 0,
};

function cleanTitle(value = '') {
  return String(value)
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isTicketHistoryChannel(channel) {
  const parent = channelById.get(String(channel?.parent_id || ''));
  const text = `${channel?.name || ''} ${parent?.name || ''}`.toLowerCase();
  return /ticket[^a-z0-9]*(?:logs?|transcripts?)|(?:logs?|transcripts?)[^a-z0-9]*ticket/.test(text);
}

function isFixedNonTicketLog(embed) {
  const title = cleanTitle(embed?.title);
  if (!title) return false;

  if (/^(?:kick|ban|unban|report)\s+log\b/.test(title)) return true;
  if (/^(?:time[-\s]?out|timeout|un[-\s]?time[-\s]?out|untimeout)\s+log\b/.test(title)) return true;
  if (/^automod\s+(?:kick|ban|unban|timeout|time[-\s]?out|untimeout|un[-\s]?time[-\s]?out)\b/.test(title)) return true;
  if (/^(?:invite created|member joined using invite)$/.test(title)) return true;
  return false;
}

function isBuilderSavedEmbed(embed) {
  return String(embed?.footer?.text || '').endsWith(BUILDER_FOOTER_MARKER);
}

function isExplicitColorPreview(embed) {
  return /color information$/i.test(String(embed?.title || '').trim());
}

function sanitizeEmbed(raw, color) {
  const out = {};
  if (raw.title != null) out.title = raw.title;
  if (raw.description != null) out.description = raw.description;
  if (raw.url != null) out.url = raw.url;
  if (raw.timestamp != null) out.timestamp = raw.timestamp;
  out.color = color;

  if (raw.footer) {
    out.footer = { text: raw.footer.text || '' };
    if (raw.footer.icon_url) out.footer.icon_url = raw.footer.icon_url;
  }
  if (raw.image?.url) out.image = { url: raw.image.url };
  if (raw.thumbnail?.url) out.thumbnail = { url: raw.thumbnail.url };
  if (raw.author?.name) {
    out.author = { name: raw.author.name };
    if (raw.author.url) out.author.url = raw.author.url;
    if (raw.author.icon_url) out.author.icon_url = raw.author.icon_url;
  }
  if (Array.isArray(raw.fields)) {
    out.fields = raw.fields.map(field => ({
      name: field.name,
      value: field.value,
      ...(field.inline != null ? { inline: Boolean(field.inline) } : {}),
    }));
  }
  return out;
}

for (const channel of channels) {
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) continue;
  stats.channels += 1;
  const protectedTicketChannel = isTicketHistoryChannel(channel);
  let before;

  do {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);

    let messages;
    try {
      messages = await rest.get(`${Routes.channelMessages(channel.id)}?${query}`);
    } catch (error) {
      stats.failed += 1;
      console.warn(`[EMBED_COLOR_MIGRATION_ONCE] could not read channel ${channel.id}: ${error?.message || error}`);
      break;
    }

    for (const message of messages) {
      if (String(message.author?.id) !== String(bot.id) || !Array.isArray(message.embeds) || !message.embeds.length) continue;
      stats.checked += 1;

      if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) {
        stats.protectedCatalog += 1;
        continue;
      }

      if (protectedTicketChannel) {
        stats.protectedTicket += 1;
        continue;
      }

      let changed = false;
      let protectedMessage = false;
      const nextEmbeds = [];

      for (const raw of message.embeds) {
        if (getTicketLogTemplate(raw)) {
          stats.protectedTicket += 1;
          protectedMessage = true;
          break;
        }
        if (isFixedNonTicketLog(raw)) {
          stats.protectedFixedLog += 1;
          protectedMessage = true;
          break;
        }
        if (isBuilderSavedEmbed(raw)) {
          stats.protectedBuilder += 1;
          protectedMessage = true;
          break;
        }
        if (isExplicitColorPreview(raw)) {
          stats.protectedPreview += 1;
          protectedMessage = true;
          break;
        }

        const targetColor = normalizeDefaultEmbedColor(raw.color);
        if (raw.color !== targetColor) changed = true;
        nextEmbeds.push(sanitizeEmbed(raw, targetColor));
      }

      if (protectedMessage || !changed) continue;

      try {
        await rest.patch(Routes.channelMessage(channel.id, message.id), { body: { embeds: nextEmbeds } });
        stats.updated += 1;
      } catch (error) {
        stats.failed += 1;
        console.warn(`[EMBED_COLOR_MIGRATION_ONCE] failed message ${message.id} in ${channel.id}: ${error?.message || error}`);
      }
    }

    before = messages.length === 100 ? messages.at(-1)?.id : null;
  } while (before);
}

console.log(`[EMBED_COLOR_MIGRATION_ONCE] complete guild=${guildId} channels=${stats.channels} checked=${stats.checked} updated=${stats.updated} protectedTicket=${stats.protectedTicket} protectedFixedLog=${stats.protectedFixedLog} protectedBuilder=${stats.protectedBuilder} protectedPreview=${stats.protectedPreview} protectedCatalog=${stats.protectedCatalog} failed=${stats.failed}`);
