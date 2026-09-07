import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(path, after);
  return after !== before;
}

function addPreservedColorImport(text, marker) {
  if (text.includes("setPreservedEmbedColor")) return text;
  if (!text.includes(marker)) throw new Error('[CASINO_OUTCOMES] import marker not found');
  return text.replace(marker, `${marker}\nimport { setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';`);
}

const blackjackChanged = patchFile('src/commands/Economy/blackjack.js', source => {
  let text = addPreservedColorImport(source, "import { createEmbed } from '../../utils/embeds.js';");

  const constantsMarker = "const isBlackjack = cards => cards.length === 2 && score(cards) === 21;";
  if (!text.includes('const BLACKJACK_OUTCOME_COLORS = {')) {
    if (!text.includes(constantsMarker)) throw new Error('[CASINO_OUTCOMES] blackjack constants marker not found');
    text = text.replace(constantsMarker, `${constantsMarker}\n\nconst BLACKJACK_OUTCOME_COLORS = {\n  win: 0x00C49D,\n  loss: 0x670102,\n  bust: 0x670102,\n  push: 0x336699,\n};`);
  }

  const oldResult = "  const result = { title: outcomes.join(' / '), color: payout > state.totalBet ? 'success' : payout === state.totalBet ? 'primary' : 'error', text: `Payout: **${money(payout)}**\\nCash balance: **${money(state.data.wallet)}**` };";
  const newResult = "  const allBust = state.hands.length > 0 && state.hands.every(hand => score(hand.cards) > 21);\n  const outcome = allBust ? 'bust' : payout > state.totalBet ? 'win' : payout === state.totalBet ? 'push' : 'loss';\n  const result = { title: outcome, color: outcome === 'win' ? 'success' : outcome === 'push' ? 'primary' : 'error', text: `Payout: **${money(payout)}**\\nCash balance: **${money(state.data.wallet)}**` };";
  if (!text.includes(newResult)) {
    if (!text.includes(oldResult)) throw new Error('[CASINO_OUTCOMES] blackjack settlement marker not found');
    text = text.replace(oldResult, newResult);
  }

  const oldRuntime = "  gameEmbed.data.fields = fields;\n  return gameEmbed;";
  const newRuntime = "  gameEmbed.data.fields = fields;\n  const outcome = String(result?.title || '').trim().toLowerCase();\n  if (BLACKJACK_OUTCOME_COLORS[outcome] != null) {\n    gameEmbed.setTitle(`Blackjack ${outcome}`);\n    setPreservedEmbedColor(gameEmbed, BLACKJACK_OUTCOME_COLORS[outcome]);\n    gameEmbed.data.description = result?.text || '';\n  }\n  return gameEmbed;";
  if (!text.includes(newRuntime)) {
    if (!text.includes(oldRuntime)) throw new Error('[CASINO_OUTCOMES] blackjack runtime marker not found');
    text = text.replace(oldRuntime, newRuntime);
  }

  return text;
});

const baccaratChanged = patchFile('src/commands/Economy/baccarat.js', source => {
  let text = addPreservedColorImport(source, "import { createEmbed } from '../../utils/embeds.js';");

  const constantsMarker = "const score = cards => cards.reduce((total, card) => total + value(card), 0) % 10;";
  if (!text.includes('const BACCARAT_OUTCOME_COLORS = {')) {
    if (!text.includes(constantsMarker)) throw new Error('[CASINO_OUTCOMES] baccarat constants marker not found');
    text = text.replace(constantsMarker, `${constantsMarker}\n\nconst BACCARAT_OUTCOME_COLORS = {\n  win: 0x00C49D,\n  loss: 0x670102,\n  push: 0x336699,\n};`);
  }

  text = text.replace("        outcome = 'tie';", "        outcome = 'push';");

  const oldRuntime = "  // Preserve exact application-emoji markup in Discord while the complete fields\n  // are also registered in the automatic system embed catalog / embed builder.\n  if (fields.length) game.data.fields = fields;\n  return game;";
  const newRuntime = "  // Runtime result semantics are authoritative. Saved templates may style the\n  // message, but they must never turn a win into a loss/push or vice versa.\n  const normalizedOutcome = String(outcome || '').trim().toLowerCase();\n  if (BACCARAT_OUTCOME_COLORS[normalizedOutcome] != null) {\n    game.setTitle(`Baccarat ${normalizedOutcome}`);\n    setPreservedEmbedColor(game, BACCARAT_OUTCOME_COLORS[normalizedOutcome]);\n  }\n  if (result) game.data.description = result;\n  game.data.fields = fields;\n  return game;";
  if (!text.includes(newRuntime)) {
    if (!text.includes(oldRuntime)) throw new Error('[CASINO_OUTCOMES] baccarat runtime marker not found');
    text = text.replace(oldRuntime, newRuntime);
  }

  return text;
});

const rouletteChanged = patchFile('src/commands/Economy/roulette.js', source => {
  let text = addPreservedColorImport(source, "import { createEmbed } from '../../utils/embeds.js';");

  const oldBlock = `    const embed = createEmbed({\n      title: won ? 'Roulette win' : 'Roulette loss',\n      description: \`The wheel landed on \${tile}\\n**\${number} • \${color.charAt(0).toUpperCase() + color.slice(1)}**\`,\n      color: won ? 'success' : 'warning',\n      fields: [\n        { name: 'Your bet', value: \`**\${money(amount)}** on **\${choice}**\`, inline: true },\n        {\n          name: won ? 'Payout' : 'Result',\n          value: won ? \`**\${money(result.payout)}**\` : \`Lost **\${money(amount)}**\`,\n          inline: true,\n        },\n        { name: 'Cash balance', value: \`**\${money(result.balance)}**\`, inline: true },\n      ],\n    });`;

  const newBlock = `    const title = won ? 'Roulette win' : 'Roulette loss';\n    const description = \`The wheel landed on \${tile}\\n**\${number} • \${color.charAt(0).toUpperCase() + color.slice(1)}**\`;\n    const fields = [\n      { name: 'Your bet', value: \`**\${money(amount)}** on **\${choice}**\`, inline: true },\n      {\n        name: won ? 'Payout' : 'Result',\n        value: won ? \`**\${money(result.payout)}**\` : \`Lost **\${money(amount)}**\`,\n        inline: true,\n      },\n      { name: 'Cash balance', value: \`**\${money(result.balance)}**\`, inline: true },\n    ];\n    const embed = createEmbed({\n      title,\n      description,\n      color: won ? 'success' : 'error',\n      fields,\n    });\n    embed.setTitle(title);\n    setPreservedEmbedColor(embed, won ? 0x00C49D : 0x670102);\n    embed.data.description = description;\n    embed.data.fields = fields;`;

  if (!text.includes(newBlock)) {
    if (!text.includes(oldBlock)) throw new Error('[CASINO_OUTCOMES] roulette result block not found');
    text = text.replace(oldBlock, newBlock);
  }

  return text;
});

console.log(`[CASINO_OUTCOMES] blackjack=${blackjackChanged ? 'patched' : 'current'} baccarat=${baccaratChanged ? 'patched' : 'current'} roulette=${rouletteChanged ? 'patched' : 'current'}`);
