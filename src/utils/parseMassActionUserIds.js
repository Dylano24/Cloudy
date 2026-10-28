// Shared input parser for mass moderation commands. Keep one action per
// distinct Discord account, in the order that staff supplied the IDs.
export function parseMassActionUserIds(input, limit = 20) {
  const normalized = String(input ?? '').replace(/<@!?(\d+)>/g, '$1');
  const ids = normalized.split(/[\s,]+/).filter(id => /^\d{17,20}$/.test(id));
  return [...new Set(ids)].slice(0, limit);
}
