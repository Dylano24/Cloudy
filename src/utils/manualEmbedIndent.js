// Only called while preparing an explicit Embed Builder Save. Use real glyphs
// for leading indentation so Discord does not collapse Markdown whitespace.
// Font metrics and line wrapping can still differ between Discord clients.
export function normalizeManualIndent(value) {
  let fence = null;
  return String(value ?? '').split('\n').map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/^(?:\u2063[\u2002\u2009]|[ \t\u00a0\u2002\u2009\u2800])+/, indent =>
      indent.replace(/\u2063[\u2002\u2009]|[ \u00a0\u2002\u2009\u2800]|\t/g,
        token => '\u2800'.repeat(token === '\t' ? 4 : 1)),
    );
  }).join('\n');
}
