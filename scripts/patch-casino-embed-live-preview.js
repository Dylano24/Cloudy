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

// A custom emoji in a saved title is administrator decoration. It must never
// be mistaken for an old default title and removed during catalog cleanup.
const catalogPath = 'src/services/systemEmbedCatalogService.js';
const catalogBefore = fs.readFileSync(catalogPath, 'utf8');
let catalogText = catalogBefore;

const oldTitleValue = `function isLegacyDefaultGameTitle(title, key) {
  const value = normalize(title);`;
const formerTitleValue = `function isLegacyDefaultGameTitle(title, key) {
  const value = normalize(String(title || '').replace(/<a?:[^:>]+:\\d+>/g, ' '));`;
const newTitleValue = `function isLegacyDefaultGameTitle(title, key) {
  const rawTitle = String(title || '');
  // An emoji in an administrator-saved title is intentional decoration. Never
  // rewrite that title to a default game name or the emoji disappears on Save.
  if (/<a?:[^:>]+:\\d+>/.test(rawTitle)) return false;
  const value = normalize(rawTitle);`;
if (!catalogText.includes(newTitleValue)) {
  if (catalogText.includes(formerTitleValue)) {
    catalogText = catalogText.replace(formerTitleValue, newTitleValue);
  } else if (catalogText.includes(oldTitleValue)) {
    catalogText = catalogText.replace(oldTitleValue, newTitleValue);
  } else {
    throw new Error('[CASINO_EMBEDS] legacy title normalization marker was not found.');
  }
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
console.log(`[CASINO_EMBEDS] ${catalogText === catalogBefore ? 'saved casino emoji titles already protected' : 'protected saved casino emoji titles'}`);
