import { ButtonBuilder, Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const COMPACT_LABELS = new Map([
  ['ticket_claim', 'Cʟᴀɪᴍ'],
  ['ticket_unclaim', 'Uɴᴄʟᴀɪᴍ'],
  ['ticket_pin', 'Pɪɴ'],
  ['ticket_priority_menu', 'Pʀɪᴏʀɪᴛʏ'],
  ['ticket_close', 'Cʟᴏsᴇ'],
]);

function compactRows(rows = []) {
  return rows.map(row => {
    const raw = typeof row?.toJSON === 'function' ? row.toJSON() : { ...row };
    raw.components = (raw.components || []).map(component => {
      const compact = COMPACT_LABELS.get(component.custom_id);
      return compact ? { ...component, label: compact } : component;
    });
    return raw;
  });
}

async function compactTicketMessage(message) {
  if (!message?.embeds?.[0]?.title?.startsWith('Ticket #')) return;
  if (!message.components?.length) return;
  await message.edit({ components: compactRows(message.components) });
}

function patchFutureTicketButtons() {
  if (ButtonBuilder.prototype.__cloudyCompactTicketLabels) return;

  const originalSetLabel = ButtonBuilder.prototype.setLabel;
  ButtonBuilder.prototype.setLabel = function setCompactTicketLabel(label) {
    const customId = this?.data?.custom_id;
    const compact = COMPACT_LABELS.get(customId);
    return originalSetLabel.call(this, compact || label);
  };

  Object.defineProperty(ButtonBuilder.prototype, '__cloudyCompactTicketLabels', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    patchFutureTicketButtons();

    for (const guild of client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (!channel?.isTextBased?.() || channel.isThread?.()) continue;
        if (!/ticket-\d+/i.test(String(channel.name || ''))) continue;
        if (!channel.messages?.fetch) continue;

        const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
        if (!messages) continue;

        for (const message of messages.values()) {
          if (message.author?.id !== client.user?.id) continue;
          await compactTicketMessage(message).catch(error => {
            logger.warn('Could not compact ticket buttons', {
              guildId: guild.id,
              channelId: channel.id,
              messageId: message.id,
              error: error.message,
            });
          });
        }
      }
    }
  },
};
