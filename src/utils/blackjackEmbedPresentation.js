function embedData(embed) {
  return embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
}

export function isBlackjackEmbed(embed) {
  const data = embedData(embed);
  if (/\bblackjack\b/i.test(String(data.title || ''))) return true;

  const names = new Set((data.fields || []).map(field => String(field?.name || '').trim().toLowerCase()));
  return names.has('your hand') && names.has('dealer hand');
}

// This is presentation-only. It deliberately does not touch the saved
// template or any dynamic game data; it makes sure an old stored template can
// never render the retired line back into a Blackjack response.
export function stripBlackjackCardsRemaining(embed) {
  const data = embedData(embed);
  if (!isBlackjackEmbed(data) || typeof data.description !== 'string') return data;

  const lines = data.description.split('\n');
  const visibleLines = lines.filter(line => !/^\s*cards\s+remaining\s*:/i.test(line));
  while (visibleLines.length && !visibleLines[0].trim()) visibleLines.shift();
  while (visibleLines.length && !visibleLines.at(-1).trim()) visibleLines.pop();

  const description = visibleLines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (description === data.description) return data;

  const next = { ...data };
  if (description) next.description = description;
  else delete next.description;
  return next;
}
