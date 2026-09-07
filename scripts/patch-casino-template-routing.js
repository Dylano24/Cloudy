import fs from 'node:fs';

const path = 'src/services/systemEmbedCatalogService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

const marker = "  const normalizedTitle = dynamicParts(title).pattern;";
const authority = `  const normalizedTitle = dynamicParts(title).pattern;\n\n  // Casino result identity is determined from the live game outcome before any\n  // saved Embed Builder styling is applied. This prevents a saved loss template\n  // from ever being reused for a win/push/bust result.\n  if (normalizedKind === 'embed' && normalizedContext === 'gambling/roulette') {\n    if (/^roulette\\s+win$/.test(normalizedTitle)) return 'game:roulette:won';\n    if (/^roulette\\s+loss$/.test(normalizedTitle)) return 'game:roulette:lost';\n  }\n  if (normalizedKind === 'embed' && normalizedContext === 'gambling/blackjack') {\n    const result = canonicalBlackjackResult(normalizedTitle);\n    if (result) return \`game:blackjack:result:\${result}\`;\n  }\n  if (normalizedKind === 'embed' && normalizedContext === 'gambling/baccarat') {\n    const match = normalizedTitle.match(/^baccarat\\s+(win|loss|push)$/);\n    if (match) return \`game:baccarat:\${match[1]}\`;\n  }`;

if (!text.includes("Casino result identity is determined from the live game outcome")) {
  if (!text.includes(marker)) throw new Error('[CASINO_TEMPLATE_ROUTING] template-key marker not found');
  text = text.replace(marker, authority);
}

// Baccarat ties where the player's stake is returned are a push everywhere in
// the catalog too. Keep the gameplay bet option named "tie"; only result-state
// identities are changed here.
text = text.replaceAll('game:baccarat:(?:win|loss|tie|expired)', 'game:baccarat:(?:win|loss|push|expired)');
text = text.replaceAll('game:baccarat:(?:win|loss|tie)', 'game:baccarat:(?:win|loss|push)');
text = text.replaceAll("'game:baccarat:tie'", "'game:baccarat:push'");
text = text.replaceAll('`Baccarat ${normalizedKey.split(\':\').at(-1)}`', '`Baccarat ${normalizedKey.split(\':\').at(-1)}`');
text = text.replace(
  "    if (titleMatch[1] === 'lost') return 'loss';\n    return titleMatch[1];",
  "    if (titleMatch[1] === 'lost') return 'loss';\n    if (titleMatch[1] === 'tie') return 'push';\n    return titleMatch[1];",
);
text = text.replace(
  "  if (/\\btie\\b.*\\breturned\\b/.test(body)) return 'tie';",
  "  if (/\\btie\\b.*\\breturned\\b/.test(body)) return 'push';",
);
text = text.replace(
  "      || value === outcome;",
  "      || value === outcome\n      || (outcome === 'push' && value === 'tie');",
);
text = text.replace(
  "      : 'Tie — your **{dynamic}** bet was returned.';",
  "      : 'Tie — your **{dynamic}** bet was returned.';",
);

if (text !== before) fs.writeFileSync(path, text);
console.log(`[CASINO_TEMPLATE_ROUTING] ${text === before ? 'current' : 'patched'} outcome-specific template keys + baccarat push routing`);
