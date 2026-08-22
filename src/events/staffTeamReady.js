import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js';
import { FAQ_AI_CHANNEL_ID } from '../services/faqAiService.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const STAFF_CHANNEL_ID = '1533198028733939722';
const CONTACT_SUPPORT_CHANNEL_ID = '1533197784725852181';

function buildStaffEmbed(guild) {
  const ownerRole = guild.roles.cache.find(role => role.name.toLowerCase() === 'owner');
  const ownerMention = ownerRole ? `<@&${ownerRole.id}>` : '@Owner';

  return new EmbedBuilder()
    .setTitle('Staff team')
    .setDescription(
      `Here are the people currently managing the server: ${ownerMention}\n\n`
      + `Our staff team can be contacted directly through the <#${CONTACT_SUPPORT_CHANNEL_ID}> section, which has been specifically created for this purpose.\n\n`
      + 'Before contacting the staff team, please make sure that the answer to your question cannot already be found in our FAQ section.\n\n'
      + 'Please note that staff members will not handle support requests through private messages. Friend requests may also not be accepted.\n\n'
      + 'To ensure your request is properly received and handled, please use the dedicated support section.\n\n'
      + FOOTER,
    )
    .setColor(0xFFFFFF);
}

function buildButtons(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('✉️ Contact Support')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${CONTACT_SUPPORT_CHANNEL_ID}`),
    new ButtonBuilder()
      .setLabel('❔FAQ')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${FAQ_AI_CHANNEL_ID}`),
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const channel = await client.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
      if (!channel?.isSendable?.() || !channel.guild) return;

      const payload = {
        embeds: [buildStaffEmbed(channel.guild)],
        components: [buildButtons(channel.guild.id)],
      };

      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const existing = recent?.find(message =>
        message.author?.id === client.user?.id
        && message.embeds?.[0]?.title === 'Staff team',
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
