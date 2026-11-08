import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js';
import { FAQ_AI_CHANNEL_ID } from '../services/faqAiService.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const CONTACT_SUPPORT_CHANNEL_ID = '1533197784725852181';
export const STAFF_CONTACT_EMOJI = Object.freeze({ id: '1543303628159320165', name: 'W92mailmessage' });

export function updateStaffContactButtonEmoji(rows) {
  const components = (rows || []).map(row => structuredClone(row.toJSON?.() || row));
  let updated = false;
  for (const row of components) {
    for (const button of row.components || []) {
      if (button.type !== 2 || button.style !== 5 || button.label !== 'Contact us') continue;
      if (button.emoji?.id === STAFF_CONTACT_EMOJI.id) continue;
      button.emoji = { ...STAFF_CONTACT_EMOJI };
      updated = true;
    }
  }
  return { components, updated };
}

function buildStaffEmbed(guild) {
  const staffRole = guild.roles.cache.find(role => role.name.toLowerCase() === 'staff');
  const staffMention = staffRole ? `<@&${staffRole.id}>` : '@Staff';

  return new EmbedBuilder()
    .setTitle('Staff team')
    .setDescription(
      `Here are the people currently managing the server: ${staffMention}\n\n`
      + 'Our staff team can be contacted directly through the **contact us** section, which has been specifically created for this purpose.\n\n'
      + 'Before contacting the staff team, please make sure that the answer to your question cannot already be found in our **FAQ** section.\n\n'
      + 'Please note that staff members will not handle support requests through private messages. Friend requests may also not be accepted.',
    )
    .setColor(0xFFFFFF)
    .setFooter({ text: FOOTER });
}

function buildButtons(guildId, contactChannelId = CONTACT_SUPPORT_CHANNEL_ID, faqChannelId = FAQ_AI_CHANNEL_ID) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Contact us')
      .setEmoji(STAFF_CONTACT_EMOJI)
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${contactChannelId}`),
    new ButtonBuilder()
      .setLabel('❔FAQ')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${faqChannelId}`),
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const channel = await resolveCloudyChannel(client, 'staffList', { textOnly: true });
      if (!channel?.isSendable?.() || !channel.guild) return;

      const [contactChannel, faqChannel] = await Promise.all([
        resolveCloudyChannel(client, 'contactSupport', { guild: channel.guild, textOnly: true }),
        resolveCloudyChannel(client, 'faq', { guild: channel.guild, textOnly: true }),
      ]);

      const payload = {
        embeds: [buildStaffEmbed(channel.guild)],
        components: [buildButtons(
          channel.guild.id,
          contactChannel?.id || CONTACT_SUPPORT_CHANNEL_ID,
          faqChannel?.id || FAQ_AI_CHANNEL_ID,
        )],
      };

      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const existing = recent?.find(message =>
        message.author?.id === client.user?.id
        && message.embeds?.[0]?.title === 'Staff team',
      );

      if (existing) {
        // Preserve the original Staff team embed and every other control.
        const { components, updated } = updateStaffContactButtonEmoji(existing.components);
        if (updated) await existing.edit({ components }).catch(() => {});
      } else {
        await channel.send(payload).catch(() => {});
      }
    }, 2500);

    timer.unref?.();
  },
};
