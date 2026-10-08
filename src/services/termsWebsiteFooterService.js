// Match the legal last-updated line shown on both Cloudy website terms pages.
// It is intentionally a fixed published revision, not the current date.
export const WEBSITE_TERMS_FOOTER = 'Last updated 20.03.2026 at 13h42';

const MANUAL_TERMS_FOOTER = /^© Cloudy Inc\. • Last updated \d{2} [A-Za-z]+ \d{4} • \d{2}:\d{2}$/;
const TERMS_TITLE = /(?:store )?terms of (?:sale|service)$/i;
const TERMS_CHANNEL_IDS = new Set(['1533191366190829768', '1534786470790037665']);

export function stampTermsFooterOnSave(previous, next, { channelId, now = new Date() } = {}) {
  const isTerms = TERMS_TITLE.test(String(previous?.title || ''))
    || TERMS_TITLE.test(String(next?.title || ''))
    || (TERMS_CHANNEL_IDS.has(String(channelId)) && MANUAL_TERMS_FOOTER.test(String(previous?.footer?.text || '')));
  if (!isTerms) return next;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return {
    ...next,
    footer: {
      ...(next.footer || {}),
      text: `© Cloudy Inc. • Last updated ${value('day')} ${value('month')} ${value('year')} • ${value('hour')}:${value('minute')}`,
    },
  };
}

// Only change the native footer of the existing Discord terms embed.
// Never send a second message, replace its fields/text, or edit other embeds.
export async function syncExistingTermsFooter(message, expectedTitle) {
  const current = Array.isArray(message?.embeds) ? message.embeds : [];
  let changed = false;
  const embeds = current.map(embed => {
    const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...embed };
    if (typeof data.title !== 'string'
        || !data.title.toLowerCase().endsWith(expectedTitle.toLowerCase())) return data;
    if (MANUAL_TERMS_FOOTER.test(String(data.footer?.text || ''))) return data;
    if (data.footer?.text === WEBSITE_TERMS_FOOTER) return data;
    changed = true;
    return { ...data, footer: { ...(data.footer || {}), text: WEBSITE_TERMS_FOOTER } };
  });
  if (!changed) return false;
  await message.edit({ embeds });
  return true;
}
