import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getTermsTitleIcon } from './termsIconService.js';

const TERMS_CHANNEL_ID = '1533191366190829768';

const TERMS_SECTIONS = [
  {
    name: '1. Introduction',
    value: `These Terms of Service ("Terms") govern access to and use of our Discord community, Rust game servers, website, online store, and any related services operated by us (collectively referred to as the "Services").\n\nBy accessing or using our Services, you agree to be bound by these Terms.\n\nOur Discord Rules and Rust Server Rules are separate documents that define additional requirements regarding community behavior and gameplay rules. These rules form an integral part of our general operating guidelines.`
  },
  {
    name: '2. Community conduct',
    value: `Users must comply with our Discord Rules and Rust Server Rules available on our official platforms.\n\nAny behavior that negatively impacts the community, the operation of our Services, or the experience of other users may result in administrative action.`
  },
  {
    name: '3. Service availability',
    value: `Our Services are provided "as is" and according to their availability.\n\nWhile we make reasonable efforts to maintain reliable access to our Services, we cannot guarantee permanent and uninterrupted availability.\n\nTemporary interruptions, periods of unavailability, maintenance, or technical issues may occur, including but not limited to:\n\nHosting provider failures;\nServer maintenance;\nDiscord outages;\nPlayStation Network or Xbox Network outages;\nIssues related to Internet infrastructure;\nThird-party service failures;\nPayment provider issues;\nCybersecurity incidents or DDoS attacks.`
  },
  {
    name: '4. Wipes, Rollbacks and Data loss',
    value: `Rust servers may be subject to scheduled wipes, emergency wipes, rollbacks, technical issues, or unexpected data loss.\n\nThese situations may result in the loss of in-game items, bases, inventories, progression, statistics, or any other digital content.\n\nUsers acknowledge that online gaming services may experience technical limitations and that these events may occur despite reasonable measures taken to prevent them.`
  },
  {
    name: '5. Limitation of liability',
    value: `To the extent permitted by applicable law, we shall not be held liable for, including but not limited to:\n\nLoss of in-game content or progression;\nTemporary service interruptions;\nFailures of our hosting provider or third-party platforms;\nData loss;\nIndirect damages resulting from the use of our Services.\n\nAt our sole discretion, and without any obligation on our part, we may decide to provide compensation, extensions, or any other goodwill gesture in exceptional circumstances.\n\nProviding compensation in one situation does not create any obligation to provide compensation in future situations.`
  },
  {
    name: '6. Administrative actions',
    value: `We reserve the right to take appropriate measures whenever necessary to protect our community, our Services, and our users.\n\nDepending on the circumstances, these measures may include restricting access to certain features, removing benefits obtained or used abusively, suspending access, or permanently denying access to our Services.\n\nAdministrative decisions are made based on each individual situation and remain at our reasonable discretion.`
  },
  {
    name: '7. Changes to these terms',
    value: `We reserve the right to modify these Terms at any time.\n\nThe most recent version published on our official website or official Discord server will always be considered the applicable version.\n\nContinued use of our Services after changes to these Terms constitutes acceptance of the updated conditions.`
  },
  {
    name: '8. Governing law',
    value: `These Terms shall be governed and interpreted in accordance with French law.\n\nThese Terms apply to all users worldwide. However, mandatory consumer protection rights provided by the applicable laws of the user's country of residence remain applicable where required by law.`
  }
];

function formatLastUpdated(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).formatToParts(date);

  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('day')} ${get('month')} ${get('year')}`;
}

function buildTermsEmbed(titleIcon = '') {
  const footerText = `© Cloudy Inc. • Last updated: ${formatLastUpdated()}`;
  const title = titleIcon ? `\u200b\n${titleIcon} Terms of service` : '\u200b\nTerms of service';

  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(title)
    .addFields(TERMS_SECTIONS.map(section => ({
      name: `\u200b\n${section.name}`,
      value: `\u200b\n${section.value}`,
      inline: false
    })))
    .setFooter({ text: footerText });

  const payload = embed.toJSON();
  payload.footer = { text: footerText };
  return payload;
}

async function findExistingTermsMessage(channel, clientUserId) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;

  return messages.find(message =>
    message.author?.id === clientUserId &&
    message.embeds?.some(embed =>
      embed.title === 'Terms of Service' ||
      embed.title === 'Terms of service' ||
      embed.title?.endsWith(' Terms of service')
    )
  ) || null;
}

export async function reconcileTermsMessage(client) {
  try {
    const channel = await client.channels.fetch(TERMS_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) {
      logger.warn(`[TERMS] Channel ${TERMS_CHANNEL_ID} is missing or is not a text channel.`);
      return { ok: false, reason: 'channel_missing' };
    }

    const guild = channel.guild;
    const me = guild?.members?.me;
    const permissions = me ? channel.permissionsFor(me) : null;

    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions?.has(PermissionFlagsBits.SendMessages) ||
      !permissions?.has(PermissionFlagsBits.EmbedLinks)
    ) {
      logger.warn(`[TERMS] Missing View Channel, Send Messages, or Embed Links in ${TERMS_CHANNEL_ID}.`);
      return { ok: false, reason: 'missing_permissions' };
    }

    const titleIcon = await getTermsTitleIcon(client);
    const embed = buildTermsEmbed(titleIcon);
    const existing = permissions.has(PermissionFlagsBits.ReadMessageHistory)
      ? await findExistingTermsMessage(channel, client.user.id)
      : null;

    if (existing) {
      await existing.edit({ embeds: [embed] });
      logger.info(`[TERMS] Updated Terms of Service message ${existing.id}.`);
      return { ok: true, action: 'updated', messageId: existing.id };
    }

    const sent = await channel.send({ embeds: [embed] });
    logger.info(`[TERMS] Sent Terms of Service message ${sent.id}.`);
    return { ok: true, action: 'sent', messageId: sent.id };
  } catch (error) {
    logger.error('[TERMS] Failed to reconcile Terms of Service message:', error);
    return { ok: false, reason: 'error' };
  }
}
