// Dedicated audit trail for giveaway prize claims. Never include the actual
// activation code, encrypted code, demo code or interaction response contents.
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { logger } from '../utils/logger.js';

export const GIVEAWAY_CLAIM_LOG_CHANNEL_ID = '1566390264291917874';
export const GIVEAWAY_CLAIM_LOG_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

const EVENTS = Object.freeze({
  opened: { title: 'Giveaway claim opened', color: 0x00C49D, action: 'Claim' },
  accessed: { title: 'Giveaway claim accessed', color: 0xFFFFFF, action: 'Claim' },
  denied: { title: 'Giveaway claim denied', color: 0x7A1712, action: 'Claim' },
  revealed: { title: 'Giveaway code revealed', color: 0xFFFFFF, action: 'Reveal my code' },
  closed: { title: 'Giveaway claim closed', color: 0xFFFFFF, action: 'Close' },
  expired: { title: 'Giveaway claim expired', color: 0x7A1712, action: 'Automatic close (24 hours)' },
});

function safeValue(value, limit = 1024) {
  return String(value || 'Not specified').slice(0, limit);
}

export function buildGiveawayClaimLog({ event, guildId, messageId, userId,
  claimChannelId = null, giveaway = null } = {}) {
  const definition = EVENTS[event];
  if (!definition) throw new Error('Unsupported giveaway claim log event: ' + event);
  const sourceChannelId = giveaway?.channelId;
  const originalLink = sourceChannelId && /^\d{17,20}$/.test(String(sourceChannelId))
    ? '[Go to giveaway](https://discord.com/channels/' + guildId + '/'
      + sourceChannelId + '/' + messageId + ')'
    : 'Message ID: `' + safeValue(messageId, 24) + '`';
  const fields = [
    { name: 'Member', value: '<@' + userId + '> (\`' + userId + '\`)', inline: false },
    { name: 'Prize', value: safeValue(giveaway?.prize, 500), inline: true },
    { name: 'Action', value: definition.action, inline: true },
    { name: 'Giveaway', value: originalLink, inline: false },
  ];
  if (claimChannelId) {
    fields.push({
      name: 'Private channel',
      value: '<#' + claimChannelId + '> (\`' + claimChannelId + '\`)',
      inline: false,
    });
  }
  if (event === 'denied') {
    fields.push({ name: 'Result', value: 'Not eligible or claim window expired', inline: false });
  }
  if (event === 'expired') {
    fields.push({ name: 'Reason', value: 'The private claim channel reached its 24-hour deadline', inline: false });
  }
  return {
    embeds: [{
      title: definition.title,
      color: definition.color,
      thumbnail: { url: CLOUDY_C_LOGO_URL },
      fields,
      footer: { text: GIVEAWAY_CLAIM_LOG_FOOTER },
    }],
    allowedMentions: { parse: [] },
  };
}

export async function sendGiveawayClaimLog(client, guild, detail) {
  const target = guild?.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
    || await guild?.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
  if (!target?.send) throw new Error('Giveaway claim log channel unavailable');
  return target.send(buildGiveawayClaimLog({ ...detail, guildId: guild.id }));
}

// One-time, in-place correction of already posted claim logs. Only remove
// their embed timestamp. Preserve the message, logo, fields and exact footer.
export async function removeExistingClaimLogTimestamps(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:no-timestamp-v1';
    try {
      if (await client.db?.get?.(marker, false)) continue;
      const channel = guild.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
        || await guild.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
      if (!channel?.messages?.fetch) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const message of messages?.values?.() || []) {
        if (message.author?.id !== client.user?.id || !message.edit) continue;
        let changed = false;
        const embeds = message.embeds.map(embed => {
          const data = embed.toJSON?.() || { ...embed };
          if (!data.timestamp || !Object.values(EVENTS).some(item => item.title === data.title)
            || data.footer?.text !== GIVEAWAY_CLAIM_LOG_FOOTER) return data;
          changed = true;
          const { timestamp, ...withoutTimestamp } = data;
          return withoutTimestamp;
        });
        if (changed) await message.edit({ embeds });
      }
      if (client.db?.set) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not remove old giveaway claim log timestamps in ' + guild.id, error);
    }
  }
}
