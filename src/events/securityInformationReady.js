import { EmbedBuilder, Events } from 'discord.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const SECURITY_CHANNEL_ID = '1533197569495142551';
const CONTACT_CHANNEL_ID = '1533197784725852181';

function buildSecurityEmbed() {
  return new EmbedBuilder()
    .setTitle('Security information')
    .setDescription(
      'This server is protected by multiple security systems, including **anti-raid, anti-nuke, automod, and anti-spam** measures to help prevent bot attacks and malicious activity.\n\n'
      + '**Additional security tools** monitor suspicious links and potentially harmful content to help keep all members safe.\n\n'
      + `If you’re experiencing an issue, have noticed something unusual, or have something to report, please contact us here <#${CONTACT_CHANNEL_ID}>\n\n`
      + FOOTER,
    )
    .setColor(0xFFFFFF);
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      const securityChannel = await client.channels.fetch(SECURITY_CHANNEL_ID).catch(() => null);
      if (!securityChannel?.isSendable?.()) return;

      const recent = await securityChannel.messages.fetch({ limit: 50 }).catch(() => null);
      const existing = recent?.find(message =>
        message.author?.id === client.user?.id
        && message.embeds?.[0]?.title === 'Security information',
      );

      const payload = { embeds: [buildSecurityEmbed()] };

      if (existing) {
        await existing.edit(payload).catch(() => {});
      } else {
        await securityChannel.send(payload).catch(() => {});
      }
    }, 2500);

    timer.unref?.();
  },
};
