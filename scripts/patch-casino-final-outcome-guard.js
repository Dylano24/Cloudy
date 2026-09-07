import fs from 'node:fs';

const path = 'src/services/systemEmbedCatalogService.js';
const marker = '  if (template.thumbnail?.url) next.thumbnail = { ...template.thumbnail };\n  else delete next.thumbnail;\n  if (template.image?.url) next.image = { ...template.image };\n  else delete next.image;\n  return isBlackjackContext(context) ? stripBlackjackCardsRemaining(next) : next;';
const guard = `  if (template.thumbnail?.url) next.thumbnail = { ...template.thumbnail };
  else delete next.thumbnail;
  if (template.image?.url) next.image = { ...template.image };
  else delete next.image;

  // Casino result semantics are runtime-owned. Embed Builder may style the rest,
  // but it must never turn a real win/push/bust into another outcome or color.
  const runtimeTitle = normalize(data.title);
  const casinoMatch = runtimeTitle.match(/^(blackjack|baccarat|roulette)\\s+(win|loss|bust|push)$/);
  if (casinoMatch) {
    const [, game, outcome] = casinoMatch;
    const allowed = (game === 'blackjack' && ['win', 'loss', 'bust', 'push'].includes(outcome))
      || (game === 'baccarat' && ['win', 'loss', 'push'].includes(outcome))
      || (game === 'roulette' && ['win', 'loss'].includes(outcome));
    if (allowed) {
      next.title = \\`\\${game.charAt(0).toUpperCase() + game.slice(1)} \\${outcome}\\`;
      next.color = outcome === 'win' ? 0x00C49D : outcome === 'push' ? 0x336699 : 0x670102;
      if (data.thumbnail?.url) next.thumbnail = { ...data.thumbnail };
    }
  }

  return isBlackjackContext(context) ? stripBlackjackCardsRemaining(next) : next;`;

const before = fs.readFileSync(path, 'utf8');
if (before.includes('Casino result semantics are runtime-owned.')) {
  console.log('[CASINO_FINAL_GUARD] already current');
  process.exit(0);
}
if (!before.includes(marker)) {
  console.log('[CASINO_FINAL_GUARD] marker not found; leaving source untouched');
  process.exit(0);
}

fs.writeFileSync(path, before.replace(marker, guard));
console.log('[CASINO_FINAL_GUARD] patched final runtime title/color/logo authority');
