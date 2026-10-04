// Embed Builder saves preserve editor text byte-for-byte by default.
// ZORP is the one explicit exception: custom glowing-dot lists are wrapped
// against a calibrated Discord-mobile text width and get a visual-width
// hanging indent matching the rendered emoji + gap.
const INVISIBLE_SEPARATOR = '\u2063';
const ZORP_TEXT_WIDTH_PX = 283;
const ZORP_BODY_INDENT_PX = 14;

const INDENT_GLYPHS = Object.freeze([
  { text: INVISIBLE_SEPARATOR + '\u2002', px: 8.0 },
  { text: INVISIBLE_SEPARATOR + '\u2009', px: 3.2 },
  { text: INVISIBLE_SEPARATOR + '\u200A', px: 1.6 },
]);

function calibratedIndent(targetPx) {
  let best = { text: '', error: Number.POSITIVE_INFINITY, glyphs: Number.POSITIVE_INFINITY };
  for (let en = 0; en <= 3; en += 1) {
    for (let thin = 0; thin <= 4; thin += 1) {
      for (let hair = 0; hair <= 6; hair += 1) {
        const px = (en * INDENT_GLYPHS[0].px) + (thin * INDENT_GLYPHS[1].px) + (hair * INDENT_GLYPHS[2].px);
        const error = Math.abs(px - targetPx);
        const glyphs = en + thin + hair;
        if (error < best.error || (error === best.error && glyphs < best.glyphs)) {
          best = {
            text: INDENT_GLYPHS[0].text.repeat(en) + INDENT_GLYPHS[1].text.repeat(thin) + INDENT_GLYPHS[2].text.repeat(hair),
            error,
            glyphs,
          };
        }
      }
    }
  }
  return best.text;
}

const ZORP_HANG = calibratedIndent(ZORP_BODY_INDENT_PX);

function customDotParts(line) {
  const match = String(line || '').match(/^(\s*)(<a?:([^:>]+):\d+>)\s+(.*)$/u);
  if (!match || !/(?:glowing)?dot|bullet/i.test(match[3])) return null;
  return { indent: match[1], marker: match[2], body: match[4] };
}

function plainTextWidthPx(text) {
  let width = 0;
  for (const char of String(text || '')) {
    if (char === ' ') width += 4.2;
    else if (/^[ilI.,'’\x60:;!|]$/u.test(char)) width += 3.8;
    else if (/^[mwMW]$/u.test(char)) width += 11;
    else if (/^[A-Z]$/u.test(char)) width += 9;
    else if (/^[0-9]$/u.test(char)) width += 8;
    else if (/^[-–—()]$/u.test(char)) width += 5.5;
    else width += 7.5;
  }
  return width;
}

function discordTextWidthPx(text) {
  const source = String(text || '');
  let width = 0;
  let cursor = 0;
  for (const match of source.matchAll(/\x60([^\x60]*)\x60/g)) {
    width += plainTextWidthPx(source.slice(cursor, match.index));
    width += 8 + (String(match[1] || '').length * 8.4);
    cursor = match.index + match[0].length;
  }
  width += plainTextWidthPx(source.slice(cursor));
  return width;
}

function wrapWordsByWidth(text, maxPx) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (current && discordTextWidthPx(candidate) > maxPx) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function stripZorpContinuation(line) {
  const value = String(line || '');
  if (value.startsWith(ZORP_HANG)) return value.slice(ZORP_HANG.length).trim();
  const withoutProtectedSpaces = value.replace(/^(?:\u2063[\u2002\u2009\u200A])+/u, '');
  if (withoutProtectedSpaces !== value) return withoutProtectedSpaces.trim();
  const withoutLegacyBraille = value.replace(/^\u2800+/u, '');
  if (withoutLegacyBraille !== value) return withoutLegacyBraille.trim();
  return null;
}

export function normalizeManualIndent(value, { zorp = false } = {}) {
  const original = String(value ?? '');
  if (!zorp) return original;
  const source = original.split('\n');
  const output = [];
  let fence = null;
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const fenceMarker = line.match(/^\s*(\x60{3,}|~{3,})/);
    if (fenceMarker) {
      if (!fence) fence = fenceMarker[1];
      else if (fenceMarker[1][0] === fence[0] && fenceMarker[1].length >= fence.length) fence = null;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }
    const parts = customDotParts(line);
    if (!parts) {
      output.push(line);
      continue;
    }
    const continuationBodies = [];
    let cursor = index + 1;
    while (cursor < source.length) {
      const continuation = stripZorpContinuation(source[cursor]);
      if (continuation === null) break;
      continuationBodies.push(continuation);
      cursor += 1;
    }
    const fullBody = [parts.body, ...continuationBodies]
      .map(part => String(part || '').trim())
      .filter(Boolean)
      .join(' ');
    const wrapped = wrapWordsByWidth(fullBody, ZORP_TEXT_WIDTH_PX);
    output.push(parts.indent + parts.marker + ' ' + wrapped[0]);
    output.push(...wrapped.slice(1).map(text => parts.indent + ZORP_HANG + text));
    index = cursor - 1;
  }
  return output.join('\n');
}
