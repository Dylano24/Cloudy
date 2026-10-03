// Embed Builder saves preserve editor text byte-for-byte by default.
// ZORP is the one explicit exception: custom glowing-dot lines use the
// previously calibrated Discord hanging indent so wrapped text stays aligned.
const HANG = '\u2800\u2800\u2800';
const ZORP_WRAP_COLUMNS = 38;

function customDotParts(line) {
  const match = String(line || '').match(/^(\s*)(<a?:([^:>]+):\d+>)\s+(.*)$/u);
  if (!match || !/(?:glowing)?dot|bullet/i.test(match[3])) return null;
  return { indent: match[1], marker: match[2], body: match[4] };
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

function stripZorpContinuation(line) {
  return String(line || '').startsWith(HANG)
    ? String(line).slice(HANG.length).trim()
    : null;
}

export function normalizeManualIndent(value, { zorp = false } = {}) {
  const original = String(value ?? '');
  if (!zorp) return original;

  const source = original.split('\n');
  const output = [];
  let fence = null;

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
    const wrapped = wrapWords(fullBody, ZORP_WRAP_COLUMNS);

    output.push(`${parts.indent}${parts.marker} ${wrapped[0]}`);
    output.push(...wrapped.slice(1).map(text => `${parts.indent}${HANG}${text}`));
    index = cursor - 1;
  }

  return output.join('\n');
}
