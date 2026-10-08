import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const CONTACT_CHANNEL_ID = '1533197784725852181';

function buildSecurityEmbed() {
  return new EmbedBuilder()
    .setTitle('Security information')
    .setDescription(
      'This server is protected by multiple security systems, including **anti-raid, anti-nuke, automod, and anti-spam** measures to help prevent bot attacks and malicious activity.\n\n'
      + '**Additional security tools** monitor suspicious links and potentially harmful content to help keep all members safe.\n\n'
      + 'If you’re experiencing an issue, have noticed something unusual, or have something to report, please use the button below to get assistance.\n\n'
      + FOOTER,
    )
    .setColor(0xFFFFFF);
}

function buildContactButton(guildId, contactChannelId = CONTACT_CHANNEL_ID) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Contact us')
      .setEmoji('✉️')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${contactChannelId}`),
  );
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      const securityChannel = await resolveCloudyChannel(client, 'security', { textOnly: true });
      if (!securityChannel?.isSendable?.()) return;

      const recent = await securityChannel.messages.fetch({ limit: 50 }).catch(() => null);
      const existing = recent?.find(message =>
        message.author?.id === client.user?.id
        && message.embeds?.[0]?.title === 'Security information',
      );

      const contactChannel = await resolveCloudyChannel(client, 'contactSupport', {
        guild: securityChannel.guild,
        textOnly: true,
      });

      const payload = {
        embeds: [buildSecurityEmbed()],
        components: [buildContactButton(securityChannel.guildId, contactChannel?.id || CONTACT_CHANNEL_ID)],
      };

      if (!existing) {
        await securityChannel.send(payload).catch(() => {});
      }
    }, 2500);

    timer.unref?.();
  },
};
