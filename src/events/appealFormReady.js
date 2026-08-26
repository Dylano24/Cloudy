import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const APPEAL_FORM_CHANNEL_ID = '1539407865318477844';

function getAppealUrl() {
  const raw = String(process.env.CORS_ORIGIN || '').trim();
  if (!raw || raw === '*') return null;

  const base = raw.split(',')[0]?.trim()?.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}/appeal`;
}

function buildAppealEmbed(appealUrl) {
  const appealLink = appealUrl
    ? `\[[Submit an Appeal](${appealUrl})\]`
    : '[Submit an Appeal]';

  return new EmbedBuilder()
    .setTitle('Appeal form')
    .setDescription(
      'If you believe you received a ban or timeout unfairly, believe it was issued by mistake, or simply wish to provide an explanation regarding the situation, you are always welcome to contact our staff team and submit an appeal.\n\n'
      + 'We will review your case and may restore your access if deemed appropriate. However, submitting an appeal does not guarantee that the punishment will be removed or your access restored.\n\n'
      + '*The appeal form is also available directly on our website.*\n\n'
      + `**Appeal here:** ${appealLink}\n\n`
      + FOOTER,
    )
    .setColor(0xFFFFFF);
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      const channel = await client.channels.fetch(APPEAL_FORM_CHANNEL_ID).catch(() => null);
      if (!channel?.isSendable?.()) return;

      const appealUrl = getAppealUrl();
      const components = appealUrl
        ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('Submit an Appeal')
              .setStyle(ButtonStyle.Link)
              .setURL(appealUrl),
          ),
        ]
        : [];

      const payload = {
        embeds: [buildAppealEmbed(appealUrl)],
        components,
      };

      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const existing = recent?.find(message =>
        message.author?.id === client.user?.id
        && message.embeds?.[0]?.title === 'Appeal form',
      );

      if (existing) {
        await existing.edit(payload).catch(() => {});
      } else {
        await channel.send(payload).catch(() => {});
      }
    }, 2500);

    timer.unref?.();
  },
};
