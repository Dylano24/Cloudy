// Reads the music player card (components V2) in tests.
function walk(items, visit) {
  for (const item of items || []) {
    const data = item?.toJSON ? item.toJSON() : item?.data || item;
    visit(data);
    walk(data?.components, visit);
    if (data?.accessory) visit(data.accessory);
  }
}

export function cardTexts(payload) {
  const texts = [];
  walk(payload?.components, data => { if (typeof data?.content === 'string') texts.push(data.content); });
  return texts;
}

export function cardButtons(payload) {
  const ids = [];
  walk(payload?.components, data => { if (data?.type === 2 && data.custom_id) ids.push(data.custom_id); });
  return ids;
}

export function cardHeading(payload) {
  for (const text of cardTexts(payload)) {
    const match = /^-# ([^\n]+)\n### /.exec(text);
    if (match) return match[1];
  }
  return null;
}

export function cardCover(payload) {
  let url = null;
  walk(payload?.components, data => { if (data?.type === 12 && !url) url = data.items?.[0]?.media?.url || null; });
  return url;
}

// The card's timer uses Unicode monospace digits (fixedWidthDigits); read them as 0-9.
export function plainDigits(text) {
  return String(text).replace(/[\u{1D7F6}-\u{1D7FF}]/gu, digit => String(digit.codePointAt(0) - 0x1D7F6));
}
