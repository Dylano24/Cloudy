import { Events, EmbedBuilder } from 'discord.js';

const LEGACY_NAMES = new Set([
  'cloudy-c-logo.png',
  'cloudy-dynamic-banner.gif',
]);
const CLOUDY_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
const CLOUDY_BANNER_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-dynamic-banner.gif';

function isWelcomeEmbed(embed) {
  const data = embed?.toJSON?.() || embed || {};
  const title = String(data.title || '').replace(/\s+/g, ' ').trim();
  if (/^welcome to cloudy(?:\s+inc\.?)?$/i.test(title)) return true;

  const fieldNames = (data.fields || [])
    .map(field => String(field?.name || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase());
  return fieldNames.some(name => name.startsWith('rules'))
    && fieldNames.some(name => name.startsWith('link your account'))
    && fieldNames.some(name => name.startsWith('subscriptions & purchases'))
    && fieldNames.some(name => name.startsWith('support & help'));
}

function attachmentUsedByUrl(url, attachment) {
  const value = String(url || '');
  if (!value || !attachment) return false;
  return value.includes(String(attachment.id))
    || value.includes(encodeURIComponent(String(attachment.name || '')))
    || value.endsWith(`/${attachment.name}`);
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(_oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;

    if (!message?.client?.user?.id) return;
    if (message.author?.id !== message.client.user.id) return;
    if (!message.editable || !message.embeds?.some(isWelcomeEmbed)) return;

    const attachments = [...message.attachments.values()];
    const legacyAttachments = attachments.filter(attachment => LEGACY_NAMES.has(String(attachment.name || '')));
    if (!legacyAttachments.length) return;

    const legacyLogo = legacyAttachments.find(attachment => attachment.name === 'cloudy-c-logo.png');
    const legacyBanner = legacyAttachments.find(attachment => attachment.name === 'cloudy-dynamic-banner.gif');

    const embeds = message.embeds.map(embed => {
      if (!isWelcomeEmbed(embed)) return embed;
      const data = embed.toJSON();

      if (legacyLogo && attachmentUsedByUrl(data.thumbnail?.url, legacyLogo)) {
        data.thumbnail = { url: CLOUDY_LOGO_URL };
      }
      if (legacyBanner && attachmentUsedByUrl(data.image?.url, legacyBanner)) {
        data.image = { url: CLOUDY_BANNER_URL };
      }

      return new EmbedBuilder(data);
    });

    const keepAttachmentIds = attachments
      .filter(attachment => !LEGACY_NAMES.has(String(attachment.name || '')))
      .map(attachment => attachment.id);

    await message.edit({
      embeds,
      attachments: keepAttachmentIds,
    }).catch(() => null);
  },
};
