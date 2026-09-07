// Only called while preparing an explicit Embed Builder Save. Existing
// published embeds are never migrated by this helper.
const BLANK = '\u2800';
const THIN = '\u2063\u2009';
const BULLET_WRAP_COLUMNS = 38;

function normalizeLeadingIndent(line) {
  return line.replace(/^(?:\u2063[\u2002\u2009]|[ \t\u00a0\u2002\u2009\u2800])+/, indent =>
    indent.replace(/\u2063[\u2002\u2009]|[ \u00a0\u2002\u2009\u2800]|\t/g,
      token => BLANK.repeat(token === '\t' ? 4 : 1)),
  );
}

function bulletParts(line) {
  const standard = line.match(/^(\s*)([•◦▪▫‣⁃●○])\s+(.*)$/u);
  if (standard) return { indent: standard[1], marker: standard[2], body: standard[3] };

  const custom = line.match(/^(\s*)(<a?:([^:>]+):\d+>)\s+(.*)$/u);
  if (custom && /(?:glowing)?dot|bullet/i.test(custom[3])) {
    return { indent: custom[1], marker: custom[2], body: custom[4] };
  }

  return null;
}

function stripContinuationIndent(line) {
  return String(line || '').replace(/^(?:\u2063[\u2002\u2009]|[ \t\u00a0\u2002\u2009\u2800])+/, '').trim();
}

function isContinuationLine(line) {
  if (!line || !String(line).trim()) return false;
  if (bulletParts(line)) return false;
  return /^(?:\u2063[\u2002\u2009]|[ \t\u00a0\u2002\u2009\u2800])+/u.test(String(line));
}

function wrapWords(text, columns) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > columns) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function renderBullet(parts, continuationBodies = []) {
  const normalizedPrefix = normalizeLeadingIndent(parts.indent);
  const fullBody = [parts.body, ...continuationBodies]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
  const wrapped = wrapWords(fullBody, BULLET_WRAP_COLUMNS);
  if (wrapped.length <= 1) return [`${normalizedPrefix}${parts.marker} ${wrapped[0]}`];

  // Fine-tuned Discord-visible hanging indent: one braille blank plus one
  // preserved thin space. This sits between the too-narrow one-blank offset
  // and the too-wide two-blank offset, while leaving the marker untouched.
  const continuation = normalizedPrefix + BLANK + THIN;
  return [
    `${normalizedPrefix}${parts.marker} ${wrapped[0]}`,
    ...wrapped.slice(1).map(text => `${continuation}${text}`),
  ];
}

export function normalizeManualIndent(value) {
  let fence = null;
  const source = String(value ?? '').split('\n');
  const output = [];

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const fenceMarker = line.match(/^\s*(`{3,}|~{3,})/);
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

    const parts = bulletParts(line);
    if (!parts) {
      output.push(normalizeLeadingIndent(line));
      continue;
    }

    const continuationBodies = [];
    let cursor = index + 1;
    while (cursor < source.length && isContinuationLine(source[cursor])) {
      continuationBodies.push(stripContinuationIndent(source[cursor]));
      cursor += 1;
    }

    output.push(...renderBullet(parts, continuationBodies));
    index = cursor - 1;
  }

  return output.join('\n');
}
