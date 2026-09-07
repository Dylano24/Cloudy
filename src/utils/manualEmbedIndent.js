// Only called while preparing an explicit Embed Builder Save. Use real glyphs
// for leading indentation so Discord does not collapse Markdown whitespace.
// Font metrics and line wrapping can still differ between Discord clients.
const BLANK = '\u2800';
const BULLET_WRAP_COLUMNS = 42;

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

function applyBulletHangingIndent(line) {
  const parts = bulletParts(line);
  if (!parts) return [normalizeLeadingIndent(line)];

  const normalizedPrefix = normalizeLeadingIndent(parts.indent);
  const wrapped = wrapWords(parts.body, BULLET_WRAP_COLUMNS);
  if (wrapped.length <= 1) return [`${normalizedPrefix}${parts.marker} ${wrapped[0]}`];

  // Use Discord-visible blank glyphs for continuation indentation. Explicit
  // newlines make the logical layout the same on desktop and mobile instead
  // of relying on each Discord client's automatic wrapping width.
  const continuation = normalizedPrefix + BLANK.repeat(2);
  return [
    `${normalizedPrefix}${parts.marker} ${wrapped[0]}`,
    ...wrapped.slice(1).map(text => `${continuation}${text}`),
  ];
}

export function normalizeManualIndent(value) {
  let fence = null;
  const output = [];

  for (const line of String(value ?? '').split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }

    output.push(...applyBulletHangingIndent(line));
  }

  return output.join('\n');
}
