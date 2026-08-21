import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

export const ZORP_GUIDE_CHANNEL_ID = '1533212973034770462';

function buildZorpGuideEmbed() {
  return new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle('🛡️ ZORP Guide')
    .setDescription(
      'ZORP is a zone protection system that protects your team’s building area while your team is offline.'
    )
    .addFields(
      {
        name: 'How to Claim a ZORP Zone',
        value: [
          'To create a ZORP zone, the player must:',
          '',
          '• Be part of a team.',
          '• Be the Team Leader.',
          '• Use `Can I build around here?`',
          '• Confirm the zone by selecting `Yes`.',
          '',
          '*You can find `Can I build around here?` and `Yes` in the Emote Wheel.*',
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Important Information',
        value: [
          '• ZORP zones expire after 24 hours.',
          '• The timer is automatically reset while the team is online.',
          '• A team cannot create a ZORP zone that overlaps with another team’s zone.',
          '• If a player switches teams, their existing ZORP zone will be removed to prevent abuse.',
        ].join('\n'),
        inline: false,
      },
      {
        name: 'How to Remove a ZORP Zone',
        value: [
          'To delete an existing ZORP zone:',
          '',
          '• Use `Can I build around here?`',
          '• Select `Good Bye` to confirm the removal.',
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Zone Colors',
        value: [
          '⚪ **White** — Newly created zone that will turn green shortly.',
          '🟢 **Green** — Team is currently online.',
          '🟡 **Yellow** — Team is offline; zone is about to turn red.',
          '🔴 **Red** — Team is offline and the zone is protected.',
        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({ text: '© Cloudy Inc. • ZORP Guide' });
}

async function findExistingGuide(channel, clientUserId) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;

  return messages.find(message =>
    message.author?.id === clientUserId &&
    message.embeds?.some(embed =>
      embed.title === '🛡️ ZORP Guide' ||
      embed.title === 'ZORP Guide' ||
      embed.title?.endsWith(' ZORP Guide')
    )
  ) || null;
}

export async function reconcileZorpGuide(client) {
  try {
    const channel = await client.channels.fetch(ZORP_GUIDE_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) {
      logger.warn(`[ZORP] Channel ${ZORP_GUIDE_CHANNEL_ID} is missing or is not a text channel.`);
      return { ok: false, reason: 'channel_missing' };
    }

    const me = channel.guild?.members?.me;
    const permissions = me ? channel.permissionsFor(me) : null;

    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions?.has(PermissionFlagsBits.SendMessages) ||
      !permissions?.has(PermissionFlagsBits.EmbedLinks)
    ) {
      logger.warn(`[ZORP] Missing View Channel, Send Messages, or Embed Links in ${ZORP_GUIDE_CHANNEL_ID}.`);
      return { ok: false, reason: 'missing_permissions' };
    }

    const embed = buildZorpGuideEmbed();
    const existing = permissions.has(PermissionFlagsBits.ReadMessageHistory)
      ? await findExistingGuide(channel, client.user.id)
      : null;

    if (existing) {
      await existing.edit({ embeds: [embed] });
      logger.info(`[ZORP] Updated ZORP Guide message ${existing.id}.`);
      return { ok: true, action: 'updated', messageId: existing.id };
    }

    const sent = await channel.send({ embeds: [embed] });
    logger.info(`[ZORP] Sent ZORP Guide message ${sent.id}.`);
    return { ok: true, action: 'sent', messageId: sent.id };
  } catch (error) {
    logger.error('[ZORP] Failed to reconcile ZORP Guide:', error);
    return { ok: false, reason: 'error' };
  }
}
