import { EmbedBuilder } from 'discord.js';

export const CLOUDY_BRANDING = '© Cloudy Inc. • Quality. Innovation. Performance.';

const CLOUDY_BRANDING_LINE_PATTERN = /(?:^|\n)[ \t]*(?:-#[ \t]*)?(?:\*\*|__|\*|_)?[ \t]*©[ \t]*Cloudy[ \t]+Inc\.?[ \t]*•[ \t]*Quality\.?[ \t]*Innovation\.?[ \t]*Performance\.?(?:\*\*|__|\*|_)?[ \t]*(?=\n|$)/gi;
const CLOUDY_BRANDING_INLINE_PATTERN = /(?:\*\*|__|\*|_)?[ \t]*©[ \t]*Cloudy[ \t]+Inc\.?[ \t]*•[ \t]*Quality\.?[ \t]*Innovation\.?[ \t]*Performance\.?(?:\*\*|__|\*|_)?/gi;

function containsCloudyBranding(value) {
  if (!value) return false;
  return /©\s*Cloudy\s+Inc\.?\s*•\s*Quality\.?\s*Innovation\.?\s*Performance\.?/i.test(String(value));
}

function cleanBrandingText(value) {
  if (!value) return value;

  return String(value)
    .replace(CLOUDY_BRANDING_LINE_PATTERN, match => (match.startsWith('\n') ? '\n' : ''))
    .replace(CLOUDY_BRANDING_INLINE_PATTERN, '')
    .replace(/(^|\n)[ \t]*-#[ \t]*(?=\n|$)/g, '$1')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeCloudyEmbed(embed) {
  const source = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...embed };

  // Discord-generated link/media embeds cannot safely be re-sent as normal bot embeds.
  if (source.type && source.type !== 'rich') {
    return { embed, changed: false };
  }

  let changed = source.footer?.text !== CLOUDY_BRANDING;

  if (source.description) {
    const description = cleanBrandingText(source.description);
    if (description !== source.description) changed = true;
    if (description) source.description = description;
    else delete source.description;
  }

  if (Array.isArray(source.fields)) {
    const fields = [];

    for (const field of source.fields) {
      const originalValue = field.value || '';
      const originalName = field.name || '';
      const value = cleanBrandingText(originalValue);
      const name = cleanBrandingText(originalName);
      const hadBranding = containsCloudyBranding(originalValue) || containsCloudyBranding(originalName);

      if (value !== originalValue || name !== originalName) changed = true;

      // Remove old fake-footer fields and their spacer fields completely.
      if (hadBranding || ((field.name === '\u200B' || field.name?.trim() === '') && (field.value === '\u200B' || field.value?.trim() === ''))) {
        changed = true;
        continue;
      }

      fields.push({
        ...field,
        name: name || originalName,
        value: value || originalValue,
      });
    }

    source.fields = fields;
  }

  // Always keep exactly one native Discord footer, matching ticket-log format.
  source.footer = { text: CLOUDY_BRANDING };

  return {
    embed: new EmbedBuilder(source),
    changed,
  };
}

export async function normalizeCloudyMessage(message) {
  if (!message?.editable || !message.embeds?.length) return false;

  let changed = false;
  const embeds = message.embeds.map(embed => {
    const normalized = normalizeCloudyEmbed(embed);
    if (normalized.changed) changed = true;
    return normalized.embed;
  });

  if (!changed) return false;

  await message.edit({ embeds }).catch(() => null);
  return true;
}
