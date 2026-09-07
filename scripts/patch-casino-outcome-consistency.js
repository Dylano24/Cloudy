import fs from 'node:fs';

const CLOUDY_LOGO_IMPORT = "import { CLOUDY_LOGO_URL } from '../../services/cloudyLogoService.js';";

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(path, after);
  return after !== before;
}

function ensureLogoImport(text) {
  if (text.includes(CLOUDY_LOGO_IMPORT)) return text;
  const marker = "import { createEmbed } from '../../utils/embeds.js';";
  if (!text.includes(marker)) throw new Error('[CASINO_OUTCOMES] createEmbed import marker not found');
  return text.replace(marker, `${marker}\n${CLOUDY_LOGO_IMPORT}`);
}

const blackjackChanged = patchFile('src/commands/Economy/blackjack.js', source => {
  let text = ensureLogoImport(source);

  const constantsMarker = "const isBlackjack = cards => cards.length === 2 && score(cards) === 21;";
  if (!text.includes('const BLACKJACK_OUTCOME_COLORS = {')) {
    if (!text.includes(constantsMarker)) throw new Error('[CASINO_OUTCOMES] blackjack constants marker not found');
    text = text.replace(constantsMarker, `${constantsMarker}\n\nconst BLACKJACK_OUTCOME_COLORS = {\n  win: 0x00C49D,\n  loss: 0x670102,\n  bust: 0x670102,\n  push: 0x336699,\n};`);
  }

  const legacyResult = "  const result = { title: outcomes.join(' / '), color: payout > state.totalBet ? 'success' : payout === state.totalBet ? 'primary' : 'error', text: `Payout: **${money(payout)}**\\nCash balance: **${money(state.data.wallet)}**` };";
  const authoritativeResult = "  const allBust = state.hands.length > 0 && state.hands.every(hand => score(hand.cards) > 21);\n  const outcome = allBust ? 'bust' : payout > state.totalBet ? 'win' : payout === state.totalBet ? 'push' : 'loss';\n  const result = { title: outcome, text: `Payout: **${money(payout)}**\\nCash balance: **${money(state.data.wallet)}**` };";
  const priorAuthoritativeResult = "  const allBust = state.hands.length > 0 && state.hands.every(hand => score(hand.cards) > 21);\n  const outcome = allBust ? 'bust' : payout > state.totalBet ? 'win' : payout === state.totalBet ? 'push' : 'loss';\n  const result = { title: outcome, color: outcome === 'win' ? 'success' : outcome === 'push' ? 'primary' : 'error', text: `Payout: **${money(payout)}**\\nCash balance: **${money(state.data.wallet)}**` };";
  if (!text.includes(authoritativeResult)) {
    if (text.includes(priorAuthoritativeResult)) text = text.replace(priorAuthoritativeResult, authoritativeResult);
    else if (text.includes(legacyResult)) text = text.replace(legacyResult, authoritativeResult);
    else throw new Error('[CASINO_OUTCOMES] blackjack settlement marker not found');
  }

  const legacyRuntime = "  gameEmbed.data.fields = fields;\n  return gameEmbed;";
  const previousRuntime = "  gameEmbed.data.fields = fields;\n  const outcome = String(result?.title || '').trim().toLowerCase();\n  if (BLACKJACK_OUTCOME_COLORS[outcome] != null) {\n    gameEmbed.setTitle(`Blackjack ${outcome}`);\n    setPreservedEmbedColor(gameEmbed, BLACKJACK_OUTCOME_COLORS[outcome]);\n    gameEmbed.data.description = result?.text || '';\n  }\n  return gameEmbed;";
  const authoritativeRuntime = "  gameEmbed.data.fields = fields;\n  const outcome = String(result?.title || '').trim().toLowerCase();\n  if (BLACKJACK_OUTCOME_COLORS[outcome] != null) {\n    return {\n      title: `Blackjack ${outcome}`,\n      description: result?.text || '',\n      color: BLACKJACK_OUTCOME_COLORS[outcome],\n      author: { name: state.user.username, icon_url: state.user.displayAvatarURL() },\n      fields,\n      thumbnail: { url: CLOUDY_LOGO_URL },\n    };\n  }\n  gameEmbed.setThumbnail(CLOUDY_LOGO_URL);\n  return gameEmbed;";
  if (!text.includes(authoritativeRuntime)) {
    if (text.includes(previousRuntime)) text = text.replace(previousRuntime, authoritativeRuntime);
    else if (text.includes(legacyRuntime)) text = text.replace(legacyRuntime, authoritativeRuntime);
    else throw new Error('[CASINO_OUTCOMES] blackjack runtime marker not found');
  }

  return text;
});

const baccaratChanged = patchFile('src/commands/Economy/baccarat.js', source => {
  let text = ensureLogoImport(source);

  const constantsMarker = "const score = cards => cards.reduce((total, card) => total + value(card), 0) % 10;";
  if (!text.includes('const BACCARAT_OUTCOME_COLORS = {')) {
    if (!text.includes(constantsMarker)) throw new Error('[CASINO_OUTCOMES] baccarat constants marker not found');
    text = text.replace(constantsMarker, `${constantsMarker}\n\nconst BACCARAT_OUTCOME_COLORS = {\n  win: 0x00C49D,\n  loss: 0x670102,\n  push: 0x336699,\n};`);
  }

  text = text.replace("        outcome = 'tie';", "        outcome = 'push';");

  const legacyRuntime = "  // Preserve exact application-emoji markup in Discord while the complete fields\n  // are also registered in the automatic system embed catalog / embed builder.\n  if (fields.length) game.data.fields = fields;\n  return game;";
  const previousRuntime = "  // Runtime result semantics are authoritative. Saved templates may style the\n  // message, but they must never turn a win into a loss/push or vice versa.\n  const normalizedOutcome = String(outcome || '').trim().toLowerCase();\n  if (BACCARAT_OUTCOME_COLORS[normalizedOutcome] != null) {\n    game.setTitle(`Baccarat ${normalizedOutcome}`);\n    setPreservedEmbedColor(game, BACCARAT_OUTCOME_COLORS[normalizedOutcome]);\n  }\n  if (result) game.data.description = result;\n  game.data.fields = fields;\n  return game;";
  const authoritativeRuntime = "  const normalizedOutcome = String(outcome || '').trim().toLowerCase();\n  if (BACCARAT_OUTCOME_COLORS[normalizedOutcome] != null) {\n    return {\n      title: `Baccarat ${normalizedOutcome}`,\n      description: result || '',\n      color: BACCARAT_OUTCOME_COLORS[normalizedOutcome],\n      author: { name: user.username, icon_url: user.displayAvatarURL() },\n      fields,\n      thumbnail: { url: CLOUDY_LOGO_URL },\n    };\n  }\n  if (result) game.data.description = result;\n  game.data.fields = fields;\n  game.setThumbnail(CLOUDY_LOGO_URL);\n  return game;";
  if (!text.includes(authoritativeRuntime)) {
    if (text.includes(previousRuntime)) text = text.replace(previousRuntime, authoritativeRuntime);
    else if (text.includes(legacyRuntime)) text = text.replace(legacyRuntime, authoritativeRuntime);
    else throw new Error('[CASINO_OUTCOMES] baccarat runtime marker not found');
  }

  return text;
});

const rouletteChanged = patchFile('src/commands/Economy/roulette.js', source => {
  let text = ensureLogoImport(source);

  const oldBlock = `    const embed = createEmbed({\n      title: won ? 'Roulette win' : 'Roulette loss',\n      description: \`The wheel landed on \${tile}\\n**\${number} • \${color.charAt(0).toUpperCase() + color.slice(1)}**\`,\n      color: won ? 'success' : 'warning',\n      fields: [\n        { name: 'Your bet', value: \`**\${money(amount)}** on **\${choice}**\`, inline: true },\n        {\n          name: won ? 'Payout' : 'Result',\n          value: won ? \`**\${money(result.payout)}**\` : \`Lost **\${money(amount)}**\`,\n          inline: true,\n        },\n        { name: 'Cash balance', value: \`**\${money(result.balance)}**\`, inline: true },\n      ],\n    });`;

  const previousBlock = `    const title = won ? 'Roulette win' : 'Roulette loss';\n    const description = \`The wheel landed on \${tile}\\n**\${number} • \${color.charAt(0).toUpperCase() + color.slice(1)}**\`;\n    const fields = [\n      { name: 'Your bet', value: \`**\${money(amount)}** on **\${choice}**\`, inline: true },\n      {\n        name: won ? 'Payout' : 'Result',\n        value: won ? \`**\${money(result.payout)}**\` : \`Lost **\${money(amount)}**\`,\n        inline: true,\n      },\n      { name: 'Cash balance', value: \`**\${money(result.balance)}**\`, inline: true },\n    ];\n    const embed = createEmbed({\n      title,\n      description,\n      color: won ? 'success' : 'error',\n      fields,\n    });\n    embed.setTitle(title);\n    setPreservedEmbedColor(embed, won ? 0x00C49D : 0x670102);\n    embed.data.description = description;\n    embed.data.fields = fields;`;

  const authoritativeBlock = `    const title = won ? 'Roulette win' : 'Roulette loss';\n    const description = \`The wheel landed on \${tile}\\n**\${number} • \${color.charAt(0).toUpperCase() + color.slice(1)}**\`;\n    const fields = [\n      { name: 'Your bet', value: \`**\${money(amount)}** on **\${choice}**\`, inline: true },\n      {\n        name: won ? 'Payout' : 'Result',\n        value: won ? \`**\${money(result.payout)}**\` : \`Lost **\${money(amount)}**\`,\n        inline: true,\n      },\n      { name: 'Cash balance', value: \`**\${money(result.balance)}**\`, inline: true },\n    ];\n    const embed = {\n      title,\n      description,\n      color: won ? 0x00C49D : 0x670102,\n      fields,\n      thumbnail: { url: CLOUDY_LOGO_URL },\n    };`;

  if (!text.includes(authoritativeBlock)) {
    if (text.includes(previousBlock)) text = text.replace(previousBlock, authoritativeBlock);
    else if (text.includes(oldBlock)) text = text.replace(oldBlock, authoritativeBlock);
    else throw new Error('[CASINO_OUTCOMES] roulette result block not found');
  }

  return text;
});

console.log(`[CASINO_OUTCOMES] blackjack=${blackjackChanged ? 'patched' : 'current'} baccarat=${baccaratChanged ? 'patched' : 'current'} roulette=${rouletteChanged ? 'patched' : 'current'} mode=authoritative`);
