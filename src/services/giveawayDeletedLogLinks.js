// When a giveaway message is deleted, its #N in every giveaway log links to
// the log of that deletion (owner's choice: "I must find it back when I click
// the #link"): the Embed log entry after /giveaway manage Delete, the Staff
// log entry after a deletion in Discord. That entry shows the deleted giveaway.
import { logger } from '../utils/logger.js';
import { findGiveawayNumber, isDiscordMessageUrl, rememberDeletedGiveawayLogUrl } from './giveawayNumberService.js';
import { isGiveawayLogEmbed } from './giveawayLogTitles.js';
import { GIVEAWAY_CLAIM_LOG_CHANNEL_ID } from './giveawayClaimLogService.js';
import { giveawayLogChannels } from './giveawayLogService.js';

// At most 500 recent messages per log channel, only when a giveaway is deleted.
const PAGES = 5;
const GIVEAWAY_LINK = /^\[([^\]]+)\]\(https:\/\/discord\.com\/channels\/(\d{17,20})\/\d{17,20}\/(\d{17,20})\)$/;

// Only the Giveaway field of a giveaway log of this giveaway changes: its link
// to the deleted message, or a plain #N (claim logs closed before #808).
export function relinkDeletedGiveaway(embed, { guildId, messageId, number, url }) {
  const data = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
  if (!isGiveawayLogEmbed(data)) return { embed: data, changed: false };
  let changed = false;
  const fields = (data.fields || []).map(field => {
    if (field.name !== 'Giveaway') return field;
    const value = String(field.value || '');
    const link = GIVEAWAY_LINK.exec(value);
    const label = link && link[2] === String(guildId) && link[3] === String(messageId) ? link[1]
      : value === '#' + number ? value : null;
    if (!label) return field;
    changed = true;
    return { ...field, value: '[' + label + '](' + url + ')' };
  });
  return { embed: changed ? { ...data, fields } : data, changed };
}

async function claimLogChannel(guild) {
  return guild?.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
    || await guild?.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID).catch(() => null);
}

export async function linkDeletedGiveawayLogs(client, guild, messageId, url) {
  if (!guild?.id || !isDiscordMessageUrl(url)) return 0;
  const number = await findGiveawayNumber(client, guild.id, messageId);
  if (!number) return 0;
  await rememberDeletedGiveawayLogUrl(client, guild.id, messageId, url);
  const channels = new Map();
  for (const channel of [...await giveawayLogChannels(guild), await claimLogChannel(guild)]) {
    if (channel?.id && channel.messages?.fetch) channels.set(channel.id, channel);
  }
  let edited = 0;
  for (const channel of channels.values()) {
    try {
      let before;
      for (let page = 0; page < PAGES; page++) {
        const list = [...(await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 })).values()];
        for (const message of list) {
          if (message.author?.id !== client.user?.id || !message.edit) continue;
          const results = (message.embeds || []).map(embed =>
            relinkDeletedGiveaway(embed, { guildId: guild.id, messageId, number, url }));
          if (!results.some(result => result.changed)) continue;
          await message.edit({ embeds: results.map(result => result.embed) });
          edited++;
        }
        if (list.length < 100 || !list.at(-1)?.id) break;
        before = list.at(-1).id;
      }
    } catch (error) {
      logger.warn(`Could not link giveaway #${number} logs in ${channel.id} to its deletion log: ${error?.message || error}`);
    }
  }
  return edited;
}
