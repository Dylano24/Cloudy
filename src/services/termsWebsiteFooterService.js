// Match the legal last-updated line shown on both Cloudy website terms pages.
// It is intentionally a fixed published revision, not the current date.
export const WEBSITE_TERMS_FOOTER = 'Last updated 20.03.2026 at 13h42';

// Only change the native footer of the existing Discord terms embed.
// Never send a second message, replace its fields/text, or edit other embeds.
export async function syncExistingTermsFooter(message, expectedTitle) {
  const current = Array.isArray(message?.embeds) ? message.embeds : [];
  let changed = false;
  const embeds = current.map(embed => {
    const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...embed };
    if (typeof data.title !== 'string'
        || !data.title.toLowerCase().endsWith(expectedTitle.toLowerCase())) return data;
    if (data.footer?.text === WEBSITE_TERMS_FOOTER) return data;
    changed = true;
    return { ...data, footer: { ...(data.footer || {}), text: WEBSITE_TERMS_FOOTER } };
  });
  if (!changed) return false;
  await message.edit({ embeds });
  return true;
}
