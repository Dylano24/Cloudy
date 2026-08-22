import { ChannelType, EmbedBuilder, Events } from 'discord.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const SECURITY_CHANNEL_NAME = 'security-information';
const CONTACT_CHANNEL_NAME = 'contact-support';

function findTextChannel(guild, name) {
  return guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText
    && String(channel.name || '').toLowerCase() === name,
  ) || null;
}

function buildSecurityEmbed(contactChannelId) {
  return new EmbedBuilder()
    .setTitle('Security information')
    .setDescription(
      'This server is protected by multiple security systems, including **anti-raid, anti-nuke, automod, and anti-spam** measures to help prevent bot attacks and malicious activity.\n\n'
      + '**Additional security tools** monitor suspicious links and potentially harmful content to help keep all members safe.\n\n'
      + `If you’re experiencing an issue, have noticed something unusual, or have something to report, please contact us here <#${contactChannelId}>`,
    )
    .setColor(0xFFFFFF)
    .setFooter({ text: FOOTER });
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        const securityChannel = findTextChannel(guild, SECURITY_CHANNEL_NAME);
        const contactChannel = findTextChannel(guild, CONTACT_CHANNEL_NAME);
        if (!securityChannel || !contactChannel || !securityChannel.isSendable?.()) continue;

        const recent = await securityChannel.messages.fetch({ limit: 50 }).catch(() => null);
        const existing = recent?.find(message =>
          message.author?.id === client.user?.id
          && message.embeds?.[0]?.title === 'Security information',
        );

        const payload = { embeds: [buildSecurityEmbed(contactChannel.id)] };

        if (existing) {
          await existing.edit(payload).catch(() => {});
        } else {
          await securityChannel.send(payload).catch(() => {});
        }
      }
    }, 2500);

    timer.unref?.();
  },
};
