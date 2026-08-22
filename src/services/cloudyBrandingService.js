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

  if (source.type && source.type !== 'rich') {
    return { embed, changed: false };
  }

  // Only clean embeds that ALREADY have the correct ticket-log footer.
  // This prevents adding/changing branding on otherwise-good existing formats.
  if (source.footer?.text !== CLOUDY_BRANDING) {
    return { embed, changed: false };
  }

  let changed = false;

  if (source.description && containsCloudyBranding(source.description)) {
    const description = cleanBrandingText(source.description);
    changed = true;
    if (description) source.description = description;
    else delete source.description;
  }

  if (Array.isArray(source.fields)) {
    const fields = [];
    let removedLegacyBranding = false;

    for (const field of source.fields) {
      const originalValue = field.value || '';
      const originalName = field.name || '';
      const hadBranding = containsCloudyBranding(originalValue) || containsCloudyBranding(originalName);

      if (hadBranding) {
        removedLegacyBranding = true;
        changed = true;
        continue;
      }

      // Only remove a spacer when it directly belongs to an old fake footer.
      if (
        removedLegacyBranding
        && (field.name === '\u200B' || field.name?.trim() === '')
        && (field.value === '\u200B' || field.value?.trim() === '')
      ) {
        changed = true;
        continue;
      }

      fields.push(field);
    }

    if (changed) source.fields = fields;
  }

  if (!changed) {
    return { embed, changed: false };
  }

  // Preserve the already-correct native ticket-log footer exactly as-is.
  source.footer = { ...source.footer, text: CLOUDY_BRANDING };

  return {
    embed: new EmbedBuilder(source),
    changed: true,
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
