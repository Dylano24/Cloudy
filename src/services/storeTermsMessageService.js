import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getTermsTitleIcon } from './termsIconService.js';

const STORE_TERMS_CHANNEL_ID = '1534786470790037665';

const STORE_TERMS_SECTIONS = [
  {
    name: '1. Introduction',
    value: `These Store terms of sale ("Store terms") govern all purchases made through our online store, including digital products, subscriptions, virtual content, and any other service offered through our platform.\n\nBy making a purchase, you agree to these Store terms.`
  },
  {
    name: '2. Digital products and services',
    value: `All products available through our store are digital services provided online.\n\nThese products may include, but are not limited to:\n\nSubscriptions;\nEquipment, items, or content directly usable in-game;\nDigital rewards;\nAny other virtual service or benefit related to our services.\n\nDigital products are not physical goods and do not involve the delivery of any real-world items.`
  },
  {
    name: '3. Payments and Delivery',
    value: `Payments are processed through the payment providers available on our store.\n\nOnce payment has been successfully completed, the purchased digital product or service is normally delivered immediately through our Services, except in the event of a technical issue, processing error, or any other situation beyond our reasonable control.\n\nDelivery also requires that the user has correctly linked their account or provided the information necessary for the purchased service to function properly.\n\nThe user is responsible for ensuring that the information provided during the purchase is accurate.`
  },
  {
    name: '4. One-time purchases',
    value: `Some products available in our store may be offered as one-time purchases, requiring a single payment without automatic renewal.\n\nThese products may include, without limitation, permanent access, passes, equipment, items, or any other digital content available through our Services.\n\nOnce the purchase has been completed and the product has been delivered, the user retains access to this content according to the conditions defined at the time of purchase, except in cases where changes are necessary for technical, security, maintenance, service evolution reasons, or in cases of abuse, fraud, or violation of our Terms or Rules.\n\nA one-time purchase does not constitute a subscription and does not involve recurring payments.`
  },
  {
    name: '5. Subscriptions and Cancellation',
    value: `Some products may be offered as recurring subscriptions.\n\nSubscriptions are automatically renewed according to the selected billing period unless cancelled by the user before the next renewal date.\n\nThe user may stop their subscription at any time in order to prevent future charges.\n\nStopping a subscription only applies to future renewals and does not remove benefits already granted during the remaining paid period.\n\nWe reserve the right to modify subscription prices, features, or conditions at any time.\n\nAny modification affecting an existing subscription will only apply from the next renewal period and will not affect the current paid period.\n\nThe user remains free to continue their subscription under the new conditions or cancel it before the next renewal.`
  },
  {
    name: '6. Refund policy',
    value: `All purchases made through our store concern digital services provided online.\n\nOne-time purchases as well as subscriptions are delivered electronically through our Services. Once a digital product, content, virtual equipment, benefit, or access has been delivered or activated, refunds are generally not available, except where required by applicable law.\n\nBy completing a purchase, the user acknowledges that the service may begin immediately after payment and accepts that the digital nature of the product may limit the possibility of cancellation or refund.\n\nNothing in these Store Terms limits mandatory consumer rights that cannot legally be excluded.`
  },
  {
    name: '7. Fraud, Abuse and Payment disputes',
    value: `Any attempt to commit fraud, misuse the payment system, or initiate an unjustified payment dispute may result in restrictions or removal of access to our Services.\n\nPurchased benefits may be removed if they were obtained through fraud, payment abuse, or actions that violate our Terms or Rules.`
  },
  {
    name: '8. Changes to store services',
    value: `We reserve the right to modify, replace, or remove certain products, prices, subscriptions, or benefits available in our store at any time.\n\nThese changes will not affect purchases that have already been completed, unless required for legal, technical, or security reasons.`
  },
  {
    name: '9. Limitation of liability',
    value: `We shall not be held responsible for any temporary loss of access to purchased products, services, or benefits resulting from technical issues, server maintenance, game updates, platform-related issues, or circumstances beyond our reasonable control.\n\nWe do not guarantee that certain features, benefits, or content will remain permanently available if changes are required for technical, operational, or security reasons.`
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

function buildStoreTermsEmbed(titleIcon = '') {
  const footerText = `© Cloudy Inc. • Last updated: ${formatLastUpdated()}`;
  const title = titleIcon ? `\u200b\n${titleIcon} Store terms of sale` : '\u200b\nStore terms of sale';

  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(title)
    .addFields(STORE_TERMS_SECTIONS.map(section => ({
      name: `\u200b\n${section.name}`,
      value: section.value,
      inline: false
    })))
    .setFooter({ text: footerText });

  const payload = embed.toJSON();
  payload.footer = { text: footerText };
  return payload;
}

async function findExistingStoreTermsMessage(channel, clientUserId) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;

  return messages.find(message =>
    message.author?.id === clientUserId &&
    message.embeds?.some(embed =>
      embed.title === 'Store terms of sale' ||
      embed.title?.endsWith(' Store terms of sale')
    )
  ) || null;
}

export async function reconcileStoreTermsMessage(client) {
  try {
    const channel = await client.channels.fetch(STORE_TERMS_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) {
      logger.warn(`[STORE_TERMS] Channel ${STORE_TERMS_CHANNEL_ID} is missing or is not a text channel.`);
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
      logger.warn(`[STORE_TERMS] Missing View Channel, Send Messages, or Embed Links in ${STORE_TERMS_CHANNEL_ID}.`);
      return { ok: false, reason: 'missing_permissions' };
    }

    const titleIcon = await getTermsTitleIcon(client);
    const embed = buildStoreTermsEmbed(titleIcon);
    const existing = permissions.has(PermissionFlagsBits.ReadMessageHistory)
      ? await findExistingStoreTermsMessage(channel, client.user.id)
      : null;

    if (existing) {
      await existing.edit({ embeds: [embed] });
      logger.info(`[STORE_TERMS] Updated Store terms of sale message ${existing.id}.`);
      return { ok: true, action: 'updated', messageId: existing.id };
    }

    const sent = await channel.send({ embeds: [embed] });
    logger.info(`[STORE_TERMS] Sent Store terms of sale message ${sent.id}.`);
    return { ok: true, action: 'sent', messageId: sent.id };
  } catch (error) {
    logger.error('[STORE_TERMS] Failed to reconcile Store terms of sale message:', error);
    return { ok: false, reason: 'error' };
  }
}
