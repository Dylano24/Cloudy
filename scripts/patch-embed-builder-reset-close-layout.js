import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
let source = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

function buttonBlock(customId) {
  const idNeedle = `.setCustomId('${customId}')`;
  const idIndex = source.indexOf(idNeedle);
  if (idIndex < 0) throw new Error(`[BUILDER_BUTTON_LAYOUT] Missing ${customId}`);

  const start = source.lastIndexOf('new ButtonBuilder()', idIndex);
  if (start < 0) throw new Error(`[BUILDER_BUTTON_LAYOUT] Missing button start for ${customId}`);

  const nextButton = source.indexOf('\n        new ButtonBuilder()', idIndex);
  const rowEnd = source.indexOf('\n    );', idIndex);
  const candidates = [nextButton, rowEnd].filter(index => index > idIndex);
  if (!candidates.length) throw new Error(`[BUILDER_BUTTON_LAYOUT] Missing button end for ${customId}`);

  return { start, end: Math.min(...candidates) };
}

const reset = buttonBlock('simple_embed_reset');
const close = buttonBlock('simple_embed_close');

if (reset.start === close.start) {
  throw new Error('[BUILDER_BUTTON_LAYOUT] Reset and Close resolved to the same button');
}

const resetBlock = source.slice(reset.start, reset.end);
const closeBlock = source.slice(close.start, close.end);

if (reset.start < close.start) {
  source = source.slice(0, reset.start)
    + closeBlock
    + source.slice(reset.end, close.start)
    + resetBlock
    + source.slice(close.end);
} else {
  source = source.slice(0, close.start)
    + resetBlock
    + source.slice(close.end, reset.start)
    + closeBlock
    + source.slice(reset.end);
}

fs.writeFileSync(path, source);
console.log('[BUILDER_BUTTON_LAYOUT] Reset and Close message positions swapped.');
