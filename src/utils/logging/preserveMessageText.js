// Preserve real Unicode graphemes and <:custom:id> / <a:animated:id>
// tokens when Discord's Message Log text limits require truncation.
const customEmoji = /<a?:[a-zA-Z0-9_~]{1,64}:\d{17,20}>/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function truncateMessageLogText(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  if (!Number.isInteger(limit) || limit < 4) throw new RangeError('Invalid Message Log text limit');
  const max = limit - 3;
  let output = '';
  let position = 0;
  function appendFragment(fragment) {
    for (const { segment } of graphemes.segment(fragment)) {
      if (output.length + segment.length > max) return false;
      output += segment;
    }
    return true;
  }
  for (const match of text.matchAll(customEmoji)) {
    if (!appendFragment(text.slice(position, match.index))) return output + '...';
    if (output.length + match[0].length > max) return output + '...';
    output += match[0];
    position = match.index + match[0].length;
  }
  appendFragment(text.slice(position));
  return output + '...';
}
