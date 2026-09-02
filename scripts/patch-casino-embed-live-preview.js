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
