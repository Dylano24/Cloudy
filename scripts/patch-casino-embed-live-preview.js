import fs from 'node:fs';

const path = 'src/services/embedManagerService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

const oldBlock = `            if (String(stableTemplateKey || '').startsWith('game:')) {
                representative = {
                    ...catalogRepresentative,
                    snapshot: liveSnapshot,
                    saveSnapshot,
                    stableTemplateKey,
                };
            }`;

const newBlock = `            if (String(stableTemplateKey || '').startsWith('game:')) {
                // Keep these session-only snapshots on the actual catalog record
                // too. The select menu stores only messageId/embedIndex, so the
                // later selection lookup must be able to recover the live preview
                // while still saving to the canonical catalog message.
                catalogRepresentative.snapshot = liveSnapshot;
                catalogRepresentative.saveSnapshot = saveSnapshot;
                catalogRepresentative.stableTemplateKey = stableTemplateKey;
                representative = catalogRepresentative;
            }`;

if (!text.includes(newBlock)) {
  if (!text.includes(oldBlock)) throw new Error('[CASINO_EMBEDS] live-preview catalog representative marker was not found.');
  text = text.replace(oldBlock, newBlock);
}

if (text !== before) fs.writeFileSync(path, text);
console.log(`[CASINO_EMBEDS] ${text === before ? 'live casino preview already current' : 'kept live casino preview on canonical Save target'}`);

// Older catalog rows can contain the former default title with an animated
// emoji injected into the text. Only normalize those known legacy defaults;
// genuinely custom administrator titles remain untouched.
const catalogPath = 'src/services/systemEmbedCatalogService.js';
const catalogBefore = fs.readFileSync(catalogPath, 'utf8');
let catalogText = catalogBefore;

const oldTitleValue = `function isLegacyDefaultGameTitle(title, key) {
  const value = normalize(title);`;
const newTitleValue = `function isLegacyDefaultGameTitle(title, key) {
  const value = normalize(String(title || '').replace(/<a?:[^:>]+:\\d+>/g, ' '));`;
if (!catalogText.includes(newTitleValue)) {
  if (!catalogText.includes(oldTitleValue)) throw new Error('[CASINO_EMBEDS] legacy title normalization marker was not found.');
  catalogText = catalogText.replace(oldTitleValue, newTitleValue);
}

catalogText = catalogText.replace(
  `    return ['roulette — you won!', 'roulette - you won!', 'roulette win', 'you won', 'won', 'win'].includes(value);`,
  `    return ['roulette — you won!', 'roulette - you won!', 'roulette you won!', 'roulette you won', 'roulet you won', 'roulette won', 'roulette win', 'you won', 'won', 'win'].includes(value);`,
);
catalogText = catalogText.replace(
  `    return ['roulette — you lost', 'roulette - you lost', 'roulette loss', 'you lost', 'lost', 'loss'].includes(value);`,
  `    return ['roulette — you lost', 'roulette - you lost', 'roulette you lost', 'roulet you lost', 'roulette lost', 'roulette loss', 'you lost', 'lost', 'loss'].includes(value);`,
);

if (catalogText !== catalogBefore) fs.writeFileSync(catalogPath, catalogText);
console.log(`[CASINO_EMBEDS] ${catalogText === catalogBefore ? 'legacy casino titles already current' : 'normalized only known legacy casino outcome titles'}`);
