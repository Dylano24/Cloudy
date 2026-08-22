import { Events } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { CLOUDY_TICKET_FOOTER } from '../utils/ticket/ticketBranding.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message, client) {
    if (!message?.guild?.id || message.author?.id !== client.user?.id) return;
    if (!message.embeds?.length || !message.editable) return;

    const config = await getGuildConfig(client, message.guild.id).catch(() => null);
    if (!config) return;

    const isTicketLogChannel =
      message.channelId === config.ticketLogsChannelId
      || message.channelId === config.ticketTranscriptChannelId;

    if (!isTicketLogChannel) return;

    const embeds = message.embeds.map(embed => {
      const raw = embed.toJSON();
      raw.footer = { text: CLOUDY_TICKET_FOOTER };
      return raw;
    });

    const alreadyCorrect = message.embeds.every(
      embed => embed.footer?.text === CLOUDY_TICKET_FOOTER,
    );

    if (alreadyCorrect) return;

    await message.edit({
      embeds,
      components: message.components,
    }).catch(() => {});
  },
};
