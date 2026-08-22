import { EmbedBuilder } from 'discord.js';

export const CLOUDY_BRANDING = '© Cloudy Inc. • Quality. Innovation. Performance.';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BRANDING_PATTERN = new RegExp(
  String.raw`(?:\*\*|__|\*|_)?${escapeRegExp(CLOUDY_BRANDING)}(?:\*\*|__|\*|_)?`,
  'gi',
);

function cleanBrandingText(value) {
  if (!value) return value;

  return String(value)
    .replace(BRANDING_PATTERN, '')
    .replace(/(^|\n)\s*-#\s*(?=\n|$)/g, '$1')
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
      const value = cleanBrandingText(field.value);
      if (value !== field.value) changed = true;

      // Remove branding-only fields/spacers that were previously used as a fake footer.
      if (!value && (field.value?.includes(CLOUDY_BRANDING) || field.name === '\u200B')) {
        changed = true;
        continue;
      }

      fields.push({ ...field, value: value || field.value });
    }

    source.fields = fields;
  }

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
