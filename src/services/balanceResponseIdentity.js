export const BALANCE_RESPONSE_KEY = 'response:economy:balance';

// The owner requested lowercase balance. Older Saves could be reset to the
// source's capitalized default. Recover that specific legacy value on read;
// a new Save uses revision 4 and may intentionally choose any capitalization.
export function readLegacyBalanceTemplate(alias, template = {}) {
  const identity = String(template.canonicalIdentity || '').toLowerCase();
  const balanceAlias = ['balance', "{dynamic}'s balance", BALANCE_RESPONSE_KEY].includes(String(alias).toLowerCase());
  const balanceIdentity = ['balance', 'dynamic s balance', BALANCE_RESPONSE_KEY].includes(identity);
  if (template.schemaVersion >= 4 || (!balanceAlias && !balanceIdentity)) return template;
  const title = String(template.title || '');
  if (!/^(?:.+?'s\s+)?Balance$/.test(title)) return template;
  return { ...template, title: title.replace(/Balance$/, 'balance') };
}

function metadata(data) {
  const author = String(data?.author?.name || '');
  return {
    key: author.match(/^Cloudy template key:\s*([^|]+)/i)?.[1]?.trim(),
    context: author.match(/Cloudy context:\s*([^|]+)/i)?.[1]?.trim().toLowerCase(),
  };
}

export function isLegacyBalanceParserArtifact(data = {}) {
  return metadata(data).context === 'gambling/balance'
    && /^(?:success|information|error|warning)$/i.test(String(data.title || '').trim())
    && /^balance$/i.test(String(data.description || '').trim())
    && !data.fields?.length;
}

export function balanceResponseIdentity(data = {}, source = null) {
  const meta = metadata(data);
  if (meta.key === BALANCE_RESPONSE_KEY) return BALANCE_RESPONSE_KEY;
  if (isLegacyBalanceParserArtifact(data)) return null;
  const title = String(data.title || '').trim();
  if (/^(?:success|information|error|warning|invalid(?: input)?|too fast|wrong channel|not enough(?: money)?|failed|expired)$/i.test(title)) return null;
  const fieldNames = (data.fields || []).map(field => String(field.name || '').replace(/[^a-z]/gi, '').toLowerCase());
  const balanceFields = ['cash', 'bank', 'total'].every(name => fieldNames.includes(name));
  const balanceTitle = /^(?:.+?'s\s+)?balance$/i.test(title);
  const context = typeof source === 'string' ? source : meta.context;
  const command = String(source?.commandName || '').toLowerCase();
  const owned = context === 'gambling/balance' || command === 'balance';
  return (owned && (balanceTitle || data.fields?.length)) || (balanceTitle && balanceFields)
    ? BALANCE_RESPONSE_KEY : null;
}
