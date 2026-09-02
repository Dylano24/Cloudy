import fs from 'node:fs';

// Keep this pass deliberately scoped to the three interactive casino games and
// their Embed Builder identities. Economy math, buttons, cards, logo handling,
// unrelated embeds and ticket/log behaviour are not changed here.

function replaceRequired(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`[CASINO_EMBEDS] ${label} marker was not found.`);
  return text.replace(from, to);
}

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(path, after);
  return after !== before;
}

const rouletteChanged = patchFile('src/commands/Economy/roulette.js', text => replaceRequired(
  text,
  "      title: won ? 'Roulette — You won!' : 'Roulette — You lost',",
  "      title: won ? 'Roulette win' : 'Roulette loss',",
  'roulette outcome title',
));

const blackjackChanged = patchFile('src/commands/Economy/blackjack.js', text => replaceRequired(
  text,
  "function liveTitle(state, result = null) {\n  return result ? `Result: ${result.title}` : `Blackjack — Bet ${money(state.totalBet)}`;\n}",
  "function liveTitle(state, result = null) {\n  if (!result) return `Blackjack — Bet ${money(state.totalBet)}`;\n  return `Blackjack ${String(result.title || '').trim().toLowerCase()}`;\n}",
  'blackjack outcome title',
));

const baccaratChanged = patchFile('src/commands/Economy/baccarat.js', source => {
  let text = source;
  text = replaceRequired(
    text,
    'async function gameEmbed(client, user, amount, player = null, banker = null, result = null) {',
    'async function gameEmbed(client, user, amount, player = null, banker = null, result = null, outcome = null) {',
    'baccarat embed signature',
  );
  text = replaceRequired(
    text,
    "    title: result ? 'Baccarat — Result' : `Baccarat — Bet ${money(amount)}`,",
    "    title: result ? `Baccarat ${outcome || 'result'}` : `Baccarat — Bet ${money(amount)}` ,",
    'baccarat outcome title',
  );
  text = replaceRequired(
    text,
    "      let payout = 0;\n      let outcomeText = '';",
    "      let payout = 0;\n      let outcome = 'loss';\n      let outcomeText = '';",
    'baccarat outcome state',
  );
  text = replaceRequired(
    text,
    "      if (winner === 'tie' && pick !== 'tie') {\n        payout = amount;",
    "      if (winner === 'tie' && pick !== 'tie') {\n        outcome = 'tie';\n        payout = amount;",
    'baccarat tie state',
  );
  text = replaceRequired(
    text,
    "      } else if (pick === winner) {\n        const multiplier = winner === 'tie' ? 9 : winner === 'banker' ? 1.95 : 2;",
    "      } else if (pick === winner) {\n        outcome = 'win';\n        const multiplier = winner === 'tie' ? 9 : winner === 'banker' ? 1.95 : 2;",
    'baccarat win state',
  );
  text = replaceRequired(
    text,
    '      await component.update({ embeds: [await gameEmbed(client, interaction.user, amount, player, banker, result)], components: choices(interaction.id, true), attachments: [] });',
    '      await component.update({ embeds: [await gameEmbed(client, interaction.user, amount, player, banker, result, outcome)], components: choices(interaction.id, true), attachments: [] });',
    'baccarat result render',
  );
  text = replaceRequired(
    text,
    '      await message.edit({ embeds: [await gameEmbed(client, interaction.user, amount, null, null, `Game expired — **${money(amount)}** was returned.`)], components: choices(interaction.id, true), attachments: [] }).catch(() => {});',
    "      await message.edit({ embeds: [await gameEmbed(client, interaction.user, amount, null, null, `Game expired — **${money(amount)}** was returned.`, 'expired')], components: choices(interaction.id, true), attachments: [] }).catch(() => {});",
    'baccarat expired render',
  );
  return text;
});

const catalogChanged = patchFile('src/services/systemEmbedCatalogService.js', source => {
  let text = source;

  text = replaceRequired(
    text,
    "async function registerCatalogMessages(messages) {\n  if (!messages?.length) return;\n  const { registerCloudyEmbedMessages } = await import('./embedRegistryService.js');\n  await registerCloudyEmbedMessages(messages, 'system-catalog');\n}",
    "async function registerCatalogMessages(messages, replace = false) {\n  if (!messages?.length) return;\n  const registry = await import('./embedRegistryService.js');\n  if (replace) {\n    await registry.replaceSystemCatalogEmbedMessages(messages);\n    return;\n  }\n  await registry.registerCloudyEmbedMessages(messages, 'system-catalog');\n}",
    'complete catalog registry replacement',
  );

  if (!text.includes('function renderTitleTemplate(')) {
    const marker = 'function responseSignature(kind, title = \'\', description = \'\') {';
    if (!text.includes(marker)) throw new Error('[CASINO_EMBEDS] title renderer marker was not found.');
    const helper = `function renderTitleTemplate(template, runtime) {
  const emojis = [];
  const protectedTemplate = String(template || '').replace(/<a?:[^:>]+:\\d+>/g, emoji => {
    const index = emojis.push(emoji) - 1;
    return \`CLOUDYEMOJI\${index}TOKEN\`;
  });
  const rendered = renderDynamic(protectedTemplate, runtime, { fallbackToRuntimeOnMismatch: true });
  return rendered.replace(/CLOUDYEMOJI(\\d+)TOKEN/g, (_match, index) => emojis[Number(index)] || '');
}

${marker}`;
    text = text.replace(marker, helper);
  }

  text = replaceRequired(
    text,
    "    return normalizedKey === 'game:baccarat:bet' || normalizedKey === 'game:baccarat:result';",
    "    return normalizedKey === 'game:baccarat:bet'\n      || normalizedKey === 'game:baccarat:result'\n      || /^game:baccarat:(?:win|loss|tie|expired)$/.test(normalizedKey);",
    'baccarat editable keys',
  );

  const formerBlackjackCanonical = "  const result = normalize(value)\n    .replace(/^result\\s*:\\s*/, '')\n    .replace(/^blackjack\\s+/, '');";
  const blackjackCanonical = "  const result = normalize(value)\n    .replace(/^result\\s*:\\s*/, '')\n    .replace(/^blackjack\\s+/, '')\n    .replace(/^you\\s+/, '')\n    .replace(/^won!?$/, 'win')\n    .replace(/^lost$/, 'loss')\n    .replace(/^tie$/, 'push');";
  if (text.includes(formerBlackjackCanonical) && !text.includes(blackjackCanonical)) {
    text = text.replace(formerBlackjackCanonical, blackjackCanonical);
  } else {
    text = replaceRequired(
      text,
      "  const result = normalize(value).replace(/^result\\s*:\\s*/, '');",
      blackjackCanonical,
      'blackjack canonical aliases',
    );
  }

  if (!text.includes('function baccaratOutcomeFromText(')) {
    const marker = '// Game messages change their money, cards and text every time.';
    if (!text.includes(marker)) throw new Error('[CASINO_EMBEDS] catalog game-key helper marker was not found.');
    const helper = `function baccaratOutcomeFromText(title = '', description = '') {
  const normalizedTitle = normalize(String(title || '').replace(/<a?:[^:>]+:\\d+>/g, ' '));
  const titleMatch = normalizedTitle.match(/^(?:baccarat\\s+)?(?:you\\s+)?(win|won|loss|lost|tie|expired)$/);
  if (titleMatch) {
    if (titleMatch[1] === 'won') return 'win';
    if (titleMatch[1] === 'lost') return 'loss';
    return titleMatch[1];
  }

  if (!/^baccarat\\s*[—-]\\s*result\\b/.test(normalizedTitle)) return '';
  const body = normalize(description);
  if (/\\bgame expired\\b/.test(body)) return 'expired';
  if (/\\byou lost\\b/.test(body)) return 'loss';
  if (/\\btie\\b.*\\breturned\\b/.test(body)) return 'tie';
  if (/\\bpayout\\s*:/.test(body)) return 'win';
  return '';
}

function defaultGameTitle(key) {
  const normalizedKey = normalize(key);
  if (normalizedKey === 'game:roulette:won') return 'Roulette win';
  if (normalizedKey === 'game:roulette:lost') return 'Roulette loss';
  if (/^game:baccarat:(?:win|loss|tie|expired)$/.test(normalizedKey)) {
    return \`Baccarat \${normalizedKey.split(':').at(-1)}\`;
  }
  const blackjackPrefix = 'game:blackjack:result:';
  if (normalizedKey.startsWith(blackjackPrefix)) {
    const result = normalizedKey.slice(blackjackPrefix.length).split('-').join(' / ');
    return \`Blackjack \${result}\`;
  }
  return '';
}

function isLegacyDefaultGameTitle(title, key) {
  const rawTitle = String(title || '');
  // An emoji in an administrator-saved title is intentional decoration. Never
  // rewrite that title to a default game name or the emoji disappears on Save.
  if (/<a?:[^:>]+:\\d+>/.test(rawTitle)) return false;
  const value = normalize(rawTitle);
  const normalizedKey = normalize(key);
  if (!value) return false;

  if (normalizedKey === 'game:roulette:won') {
    return ['roulette — you won!', 'roulette - you won!', 'roulette win', 'you won', 'won', 'win'].includes(value);
  }
  if (normalizedKey === 'game:roulette:lost') {
    return ['roulette — you lost', 'roulette - you lost', 'roulette loss', 'you lost', 'lost', 'loss'].includes(value);
  }
  if (/^game:baccarat:(?:win|loss|tie|expired)$/.test(normalizedKey)) {
    const outcome = normalizedKey.split(':').at(-1);
    return value === 'baccarat — result'
      || value === 'baccarat - result'
      || value === 'baccarat result'
      || value === \`baccarat \${outcome}\`
      || value === outcome;
  }
  if (normalizedKey.startsWith('game:blackjack:result:')) {
    const outcome = normalizedKey.slice('game:blackjack:result:'.length).split('-').join(' / ');
    return value === \`result: \${outcome}\`
      || value === \`blackjack \${outcome}\`
      || value === outcome;
  }
  return false;
}

function gameFamilyFromKey(key) {
  const match = normalize(key).match(/^game:(roulette|blackjack|baccarat):/);
  return match?.[1] || '';
}

function gameFamilyFromFields(data) {
  const names = new Set((Array.isArray(data?.fields) ? data.fields : [])
    .map(field => normalize(field?.name))
    .filter(Boolean));
  if (names.has('your hand') && names.has('dealer hand')) return 'blackjack';
  if (names.has('player hand') && names.has('banker hand')) return 'baccarat';
  if (names.has('your bet') && names.has('cash balance') && (names.has('payout') || names.has('result'))) return 'roulette';
  return '';
}

function curatedCasinoContext(metadata, data) {
  const explicitContext = normalize(metadata?.context);
  if (/^gambling\\/(?:roulette|blackjack|baccarat)$/.test(explicitContext)) return explicitContext;

  const title = normalize(String(data?.title || '').replace(/<a?:[^:>]+:\\d+>/g, ' '));
  const description = normalize(data?.description);
  const family = gameFamilyFromKey(metadata?.key)
    || gameFamilyFromFields(data)
    || (/^baccarat\\b/.test(title) || (/\\byou chose\\b/.test(description) && /\\bwinner\\b/.test(description)) ? 'baccarat' : '')
    || (/^blackjack\\b/.test(title) || (/\\bpayout\\b/.test(description) && /\\bcash balance\\b/.test(description)) ? 'blackjack' : '')
    || (/^roulet(?:te)?\\b/.test(title) || /\\bwheel landed on\\b/.test(description) ? 'roulette' : '');
  return family ? \`gambling/\${family}\` : explicitContext;
}

function canonicalGameContent(key) {
  const normalizedKey = normalize(key);
  if (normalizedKey === 'game:roulette:won') return {
    description: 'The wheel landed on {dynamic}\\n**{dynamic} • {dynamic}**',
    fields: [
      { name: 'Your bet', value: '**{dynamic}** on **{dynamic}**', inline: true },
      { name: 'Payout', value: '**{dynamic}**', inline: true },
      { name: 'Cash balance', value: '**{dynamic}**', inline: true },
    ],
  };
  if (normalizedKey === 'game:roulette:lost') return {
    description: 'The wheel landed on {dynamic}\\n**{dynamic} • {dynamic}**',
    fields: [
      { name: 'Your bet', value: '**{dynamic}** on **{dynamic}**', inline: true },
      { name: 'Result', value: 'Lost **{dynamic}**', inline: true },
      { name: 'Cash balance', value: '**{dynamic}**', inline: true },
    ],
  };
  if (normalizedKey.startsWith('game:blackjack:result:')) return {
    description: 'Payout: **{dynamic}**\\nCash balance: **{dynamic}**',
    fields: [
      { name: 'Your Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
      { name: 'Dealer Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
    ],
  };
  if (/^game:baccarat:(?:win|loss|tie)$/.test(normalizedKey)) {
    const outcome = normalizedKey.split(':').at(-1);
    const middle = outcome === 'win'
      ? 'Payout: **{dynamic}**'
      : outcome === 'loss'
        ? 'You lost **{dynamic}**'
        : 'Tie — your **{dynamic}** bet was returned.';
    return {
      description: \`You chose **{dynamic}**. Winner: **{dynamic}**\\n\${middle}\\nCash balance: **{dynamic}**\`,
      fields: [
        { name: 'Player Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
        { name: 'Banker Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
      ],
    };
  }
  if (normalizedKey === 'game:baccarat:expired') return {
    description: 'Game expired — **{dynamic}** was returned.',
    fields: [],
  };
  return null;
}

function normalizeCuratedGameTemplate(data, key) {
  const next = cloneData(data || {});
  const title = defaultGameTitle(key);
  if (title && isLegacyDefaultGameTitle(next.title, key)) next.title = title;

  const expectedFamily = gameFamilyFromKey(key);
  const actualFamily = gameFamilyFromFields(next);
  if (expectedFamily && actualFamily && expectedFamily !== actualFamily) {
    const canonical = canonicalGameContent(key);
    if (canonical) {
      if (canonical.description) next.description = canonical.description;
      else delete next.description;
      if (canonical.fields?.length) next.fields = canonical.fields.map(field => ({ ...field }));
      else delete next.fields;
    }
  }
  return next;
}

function baccaratDecorationFallback(template, runtimeData) {
  if (!template) return null;
  const source = cloneData(template);
  const next = {};
  if (Number.isInteger(source.color)) next.color = source.color;
  if (source.footer?.text) next.footer = { ...source.footer };
  if (source.thumbnail?.url) next.thumbnail = { ...source.thumbnail };
  if (source.image?.url) next.image = { ...source.image };
  if (source.url) next.url = source.url;
  if (source.timestamp) next.timestamp = source.timestamp;
  next.title = runtimeData?.title;
  return next;
}

`;
    text = text.replace(marker, helper + marker);
  }

  text = replaceRequired(
    text,
    "    if (/^roulette\\s*[—-]\\s*you\\s+won!?$/.test(normalizedTitle)) return 'game:roulette:won';\n    if (/^roulette\\s*[—-]\\s*you\\s+lost$/.test(normalizedTitle)) return 'game:roulette:lost';",
    "    if (/^(?:(?:roulette|roulet)\\s*(?:[—-]\\s*)?)?(?:you\\s+)?(?:won!?|win)$/.test(normalizedTitle)) return 'game:roulette:won';\n    if (/^(?:(?:roulette|roulet)\\s*(?:[—-]\\s*)?)?(?:you\\s+)?(?:lost|loss)$/.test(normalizedTitle)) return 'game:roulette:lost';",
    'roulette key aliases',
  );

  text = replaceRequired(
    text,
    "  const normalizedTitle = dynamicParts(title).pattern;",
    "  const normalizedTitle = dynamicParts(String(title || '').replace(/<a?:[^:>]+:\\d+>/g, ' ')).pattern;",
    'custom emoji title identity',
  );

  const formerBlackjackKey = "    if (/^result\\s*:/.test(normalizedTitle) || /^blackjack\\s+/.test(normalizedTitle)) {\n      const result = canonicalBlackjackResult(normalizedTitle);\n      return result ? `game:blackjack:result:${result}` : '';\n    }\n    return '';";
  const blackjackKey = "    const result = canonicalBlackjackResult(normalizedTitle);\n    return result ? `game:blackjack:result:${result}` : '';";
  if (text.includes(formerBlackjackKey) && !text.includes(blackjackKey)) {
    text = text.replace(formerBlackjackKey, blackjackKey);
  } else {
    text = replaceRequired(
      text,
      "    if (/^result\\s*:/.test(normalizedTitle)) {\n      const result = canonicalBlackjackResult(normalizedTitle);\n      return result ? `game:blackjack:result:${result}` : '';\n    }\n    return '';",
      blackjackKey,
      'blackjack key aliases',
    );
  }

  text = replaceRequired(
    text,
    "    if (/^baccarat\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:baccarat:bet';\n    if (/^baccarat\\s*[—-]\\s*result\\b/.test(normalizedTitle)) return 'game:baccarat:result';\n    return '';",
    "    if (/^baccarat\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:baccarat:bet';\n    const outcome = baccaratOutcomeFromText(title, description);\n    if (outcome) return `game:baccarat:${outcome}`;\n    if (/^baccarat\\s*[—-]\\s*result\\b/.test(normalizedTitle)) return 'game:baccarat:result';\n    return '';",
    'baccarat distinct keys',
  );

  text = replaceRequired(
    text,
    "function rememberTemplate(key, data, context = null) {\n  if (!key || !data || !isEditableSystemCatalogTemplate(key, context)) return;\n  templateCache.set(cacheIdentity(key, context), cloneData(data));\n}",
    "function rememberTemplate(key, data, context = null) {\n  if (!key || !data || !isEditableSystemCatalogTemplate(key, context)) return;\n  const normalized = String(key).startsWith('game:')\n    ? normalizeCuratedGameTemplate(data, key)\n    : cloneData(data);\n  templateCache.set(cacheIdentity(key, context), normalized);\n}",
    'catalog cache normalization',
  );

  if (!text.includes('const canonicalContext = curatedCasinoContext(metadata, data);')) {
    text = replaceRequired(
      text,
      "      const data = cloneData(embed);\n      const stableGameKey = String(metadata.key || '').startsWith('game:')\n        && isEditableSystemCatalogTemplate(metadata.key, metadata.context)\n        ? metadata.key\n        : null;\n      const canonicalKey = stableGameKey\n        || legacyCasinoTemplateKey(metadata.key, metadata.context)\n        || getSystemEmbedTemplateKey(\n          metadata.kind,\n          data.title,\n          data.description,\n          metadata.context,\n        );",
      "      const data = cloneData(embed);\n      const inferredGameKey = getSystemEmbedTemplateKey(\n        metadata.kind,\n        data.title,\n        data.description,\n        metadata.context,\n      );\n      const legacyBaccaratResult = normalize(metadata.context) === 'gambling/baccarat'\n        && normalize(metadata.key) === 'game:baccarat:result'\n        && /^game:baccarat:(?:win|loss|tie|expired)$/.test(String(inferredGameKey || ''));\n      const stableGameKey = legacyBaccaratResult\n        ? inferredGameKey\n        : (String(metadata.key || '').startsWith('game:')\n          && isEditableSystemCatalogTemplate(metadata.key, metadata.context)\n          ? metadata.key\n          : null);\n      const canonicalKey = stableGameKey\n        || legacyCasinoTemplateKey(metadata.key, metadata.context)\n        || inferredGameKey;",
      'legacy baccarat migration',
    );
  }

  if (!text.includes("      winner.canonicalContext,\n      winner.metadata.kind,")
    && !text.includes("      keeper.canonicalContext,\n      keeper.metadata.kind,")) {
    text = replaceRequired(
      text,
      "    const canonicalData = withStableKey(\n      merged,\n      winner.canonicalKey,",
      "    const canonicalData = withStableKey(\n      normalizeCuratedGameTemplate(merged, winner.canonicalKey),\n      winner.canonicalKey,",
      'catalog cleanup repair',
    );
  }

  text = replaceRequired(
    text,
    `function catalogEntryPriority(location) {
  const stableKey = String(location.metadata?.key || '');
  return (stableKey.startsWith('game:') ? 1_000_000_000_000_000 : 0) + catalogEntryTimestamp(location);
}`,
    `function catalogEntryPriority(location) {
  const stableKey = String(location.metadata?.key || '');
  const customizedTitlePriority = location.customizedTitle ? 3_000_000_000_000_000 : 0;
  const customizedLegacyPriority = location.customizedLegacy ? 2_000_000_000_000_000 : 0;
  const stableGamePriority = stableKey.startsWith('game:') ? 1_000_000_000_000_000 : 0;
  return customizedTitlePriority + customizedLegacyPriority + stableGamePriority + catalogEntryTimestamp(location);
}`,
    'custom legacy template priority',
  );

  if (!text.includes("        canonicalContext,\n        customizedLegacy:")) {
    text = replaceRequired(
      text,
      "      groups.get(identity).push({ message, index, embed, metadata, canonicalKey });",
      "      groups.get(identity).push({\n        message,\n        index,\n        embed,\n        metadata,\n        canonicalKey,\n        customizedLegacy: !String(metadata.key || '').startsWith('game:')\n          && isLegacyCatalogEdit(metadata, data),\n        customizedTitle: /<a?:[^:>]+:\\d+>/.test(String(data.title || ''))\n          || !isLegacyDefaultGameTitle(data.title, canonicalKey),\n      });",
      'custom legacy template migration',
    );
  }

  text = replaceRequired(
    text,
    "      if (!isCuratedCasinoContext(metadata.context)) continue;\n\n      const data = cloneData(embed);\n      const inferredGameKey = getSystemEmbedTemplateKey(\n        metadata.kind,\n        data.title,\n        data.description,\n        metadata.context,\n      );",
    "      const data = cloneData(embed);\n      const canonicalContext = curatedCasinoContext(metadata, data);\n      if (!isCuratedCasinoContext(canonicalContext)) continue;\n\n      const inferredGameKey = getSystemEmbedTemplateKey(\n        metadata.kind,\n        data.title,\n        data.description,\n        canonicalContext,\n      );",
    'structural casino catalog context',
  );

  text = replaceRequired(
    text,
    "      const legacyBaccaratResult = normalize(metadata.context) === 'gambling/baccarat'\n        && normalize(metadata.key) === 'game:baccarat:result'",
    "      const legacyBaccaratResult = canonicalContext === 'gambling/baccarat'\n        && normalize(metadata.key) === 'game:baccarat:result'",
    'canonical baccarat cleanup context',
  );

  text = replaceRequired(
    text,
    "          && isEditableSystemCatalogTemplate(metadata.key, metadata.context)",
    "          && isEditableSystemCatalogTemplate(metadata.key, canonicalContext)",
    'canonical stable game context',
  );

  text = replaceRequired(
    text,
    "        || legacyCasinoTemplateKey(metadata.key, metadata.context)",
    "        || legacyCasinoTemplateKey(metadata.key, canonicalContext)",
    'canonical legacy game context',
  );

  text = replaceRequired(
    text,
    "      if (!canonicalKey || !isEditableSystemCatalogTemplate(canonicalKey, metadata.context)) {",
    "      if (!canonicalKey || !isEditableSystemCatalogTemplate(canonicalKey, canonicalContext)) {",
    'canonical editable game context',
  );

  text = replaceRequired(
    text,
    "      const identity = cacheIdentity(canonicalKey, metadata.context);",
    "      const identity = cacheIdentity(canonicalKey, canonicalContext);",
    'canonical cleanup identity',
  );

  text = replaceRequired(
    text,
    "        canonicalKey,\n        customizedLegacy:",
    "        canonicalKey,\n        canonicalContext,\n        customizedLegacy:",
    'canonical cleanup record context',
  );

  if (!text.includes("      keeper.canonicalContext,\n      keeper.metadata.kind,")) {
    text = replaceRequired(
      text,
      "      winner.metadata.context,\n      winner.metadata.kind,",
      "      winner.canonicalContext,\n      winner.metadata.kind,",
      'canonical cleanup rewrite context',
    );
  }

  text = replaceRequired(
    text,
    "export async function cleanupSystemCatalogEntries(messages) {\n  const groups = new Map();",
    "export async function cleanupSystemCatalogEntries(messages) {\n  const groups = new Map();\n  let mergedCasinoDuplicates = 0;",
    'casino cleanup counter',
  );

  text = replaceRequired(
    text,
    "    const ordered = [...entries].sort((left, right) => catalogEntryPriority(right) - catalogEntryPriority(left));\n    const winner = ordered[0];\n    let merged = cloneData(winner.embed);\n\n    for (const duplicate of ordered.slice(1)) {\n      merged = mergeCatalogShape(merged, duplicate.embed);\n      markRemoval(duplicate.message, duplicate.index);\n    }\n\n    const canonicalData = withStableKey(\n      normalizeCuratedGameTemplate(merged, winner.canonicalKey),\n      winner.canonicalKey,\n      winner.canonicalContext,\n      winner.metadata.kind,\n    );\n    if (!catalogDataChanged(winner.embed, canonicalData)) continue;\n    if (!rewrites.has(winner.message.id)) rewrites.set(winner.message.id, new Map());\n    rewrites.get(winner.message.id).set(winner.index, canonicalData);",
    "    const ordered = [...entries].sort((left, right) => catalogEntryPriority(right) - catalogEntryPriority(left));\n    const styleWinner = ordered[0];\n    const canonicalEntries = entries.filter(entry =>\n      normalize(entry.metadata.key) === normalize(entry.canonicalKey)\n      && normalize(entry.metadata.context) === normalize(entry.canonicalContext));\n    const keeper = [...canonicalEntries]\n      .sort((left, right) => catalogEntryPriority(right) - catalogEntryPriority(left))[0]\n      || styleWinner;\n    let merged = cloneData(styleWinner.embed);\n\n    for (const entry of ordered) {\n      if (entry === styleWinner) continue;\n      merged = mergeCatalogShape(merged, entry.embed);\n    }\n    for (const duplicate of entries) {\n      if (duplicate === keeper) continue;\n      mergedCasinoDuplicates += 1;\n      markRemoval(duplicate.message, duplicate.index);\n    }\n\n    const canonicalData = withStableKey(\n      normalizeCuratedGameTemplate(merged, keeper.canonicalKey),\n      keeper.canonicalKey,\n      keeper.canonicalContext,\n      keeper.metadata.kind,\n    );\n    if (!catalogDataChanged(keeper.embed, canonicalData)) continue;\n    if (!rewrites.has(keeper.message.id)) rewrites.set(keeper.message.id, new Map());\n    rewrites.get(keeper.message.id).set(keeper.index, canonicalData);",
    'stable canonical casino Save target',
  );

  text = replaceRequired(
    text,
    "  for (const context of contexts.values()) {\n    const messages = await loadCatalogMessages(context);\n    await cleanupSystemCatalogEntries(messages);\n    for (const message of messages) rememberCatalogMessage(message);",
    "  for (const context of contexts.values()) {\n    const messages = await loadCatalogMessages(context);\n    // Cleanup can delete or reorder the exact catalog embed an administrator\n    // is editing. It runs once during catalog startup; live flushes only append\n    // or enrich stable entries so Save targets never disappear mid-session.\n    for (const message of messages) rememberCatalogMessage(message);",
    'no live casino cleanup during Save',
  );

  text = replaceRequired(
    text,
    "  messages.splice(0, messages.length, ...nextMessages);\n  return true;",
    "  messages.splice(0, messages.length, ...nextMessages);\n  if (mergedCasinoDuplicates > 0) {\n    logger.warn(`[EMBED_BUILDER] Casino catalog merged ${mergedCasinoDuplicates} duplicate template(s).`);\n  }\n  return true;",
    'casino cleanup result log',
  );

  text = replaceRequired(
    text,
    "  const data = isBlackjackContext(context)\n    ? stripBlackjackCardsRemaining(sourceData)\n    : sourceData;\n  if (isInternalTemplate(data)) return false;\n  const key = getSystemEmbedTemplateKey('embed', data.title, data.description, context);\n  if (!key || !isEditableSystemCatalogTemplate(key, context)) return false;\n  return queueRuntimeEntry({\n    key,\n    context,\n    kind: 'embed',\n    data: withStableKey(data, key, context, 'embed'),\n  });",
    "  let data = isBlackjackContext(context)\n    ? stripBlackjackCardsRemaining(sourceData)\n    : sourceData;\n  if (isInternalTemplate(data)) return false;\n  const key = getSystemEmbedTemplateKey('embed', data.title, data.description, context);\n  if (!key || !isEditableSystemCatalogTemplate(key, context)) return false;\n\n  data = normalizeCuratedGameTemplate(data, key);\n  if (/^game:baccarat:(?:win|loss|tie|expired)$/.test(key) && !findTemplate(key, context)) {\n    const legacy = findTemplate('game:baccarat:result', context);\n    const decoration = baccaratDecorationFallback(legacy, data);\n    if (decoration) data = { ...data, ...decoration, title: data.title };\n  }\n\n  return queueRuntimeEntry({\n    key,\n    context,\n    kind: 'embed',\n    data: withStableKey(data, key, context, 'embed'),\n  });",
    'runtime capture normalization',
  );

  text = replaceRequired(
    text,
    "  const specificKey = getSystemEmbedTemplateKey('embed', data.title, data.description, context);\n  const titleKey = normalize(data.title);\n  const template = (specificKey ? findTemplate(specificKey, context) : null) || findTemplate(titleKey, context);",
    "  const specificKey = getSystemEmbedTemplateKey('embed', data.title, data.description, context);\n  const titleKey = normalize(data.title);\n  let template = specificKey ? findTemplate(specificKey, context) : null;\n  let usingLegacyBaccaratFallback = false;\n  if (!template && /^game:baccarat:(?:win|loss|tie|expired)$/.test(String(specificKey || ''))) {\n    const legacy = findTemplate('game:baccarat:result', context);\n    if (legacy) {\n      template = baccaratDecorationFallback(legacy, data);\n      usingLegacyBaccaratFallback = true;\n    }\n  }\n  template ||= findTemplate(titleKey, context);\n  if (template && String(specificKey || '').startsWith('game:')) {\n    template = normalizeCuratedGameTemplate(template, specificKey);\n  }",
    'runtime template lookup',
  );

  text = replaceRequired(
    text,
    "  if (template.title) next.title = renderDynamic(template.title, data.title, { fallbackToRuntimeOnMismatch: true });",
    "  if (template.title) next.title = renderTitleTemplate(template.title, data.title);",
    'saved title rendering',
  );

  text = replaceRequired(
    text,
    "  const next = { ...data };",
    "  if (usingLegacyBaccaratFallback) captureSystemEmbedData(data, contextSource);\n\n  const next = { ...data };",
    'baccarat fallback capture',
  );

  text = replaceRequired(
    text,
    "    await saveCatalogIds(guild.id, messages);\n    await registerCatalogMessages(messages).catch(error => logger.warn(`Failed to register response catalog messages: ${error.message}`));",
    "    await saveCatalogIds(guild.id, messages);\n    await registerCatalogMessages(messages, true).catch(error => logger.warn(`Failed to replace response catalog registry: ${error.message}`));",
    'complete startup catalog registry',
  );

  text = replaceRequired(
    text,
    "    await saveCatalogIds(context.guild.id, messages);\n  }\n}",
    "    await saveCatalogIds(context.guild.id, messages);\n    await registerCatalogMessages(messages, true).catch(error => {\n      logger.warn(`Failed to replace flushed response catalog registry: ${error.message}`);\n    });\n  }\n}",
    'complete flushed catalog registry',
  );

  return text;
});

const registryChanged = patchFile('src/services/embedRegistryService.js', source => {
  let text = source;
  if (!text.includes('export async function replaceSystemCatalogEmbedMessages(')) {
    const marker = "export async function registerCloudyEmbedMessage(message, source = 'cloudy') {";
    if (!text.includes(marker)) throw new Error('[CASINO_EMBEDS] registry replacement marker was not found.');
    const helper = `export async function replaceSystemCatalogEmbedMessages(messages) {
    const grouped = new Map();

    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message?.guildId || !isSystemCatalogMessage(message)) continue;
        const additions = message.embeds.map((embed, embedIndex) => {
            const location = recordLocationForEmbed(message, embed);
            const addition = {
                guildId: message.guildId,
                ...location,
                messageId: message.id,
                embedIndex,
                source: 'system-catalog',
                title: embed?.title || '',
                name: embedName(embed),
                createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
            };
            rememberEmbedSnapshot(addition, embed);
            return addition;
        });
        if (!grouped.has(message.guildId)) grouped.set(message.guildId, []);
        grouped.get(message.guildId).push(...additions);
    }

    if (!grouped.size) return false;
    await Promise.all([...grouped.entries()].map(([guildId, additions]) => mutateRegistry(guildId, async () => {
        const retained = cleanStoredRecords(await readStoredRecords(guildId))
            .filter(record => String(record?.source || '') !== 'system-catalog');
        const next = new Map(retained.map(record => [recordKey(record), record]));
        for (const addition of additions) {
            const record = normalizeRecord(addition);
            if (record) next.set(recordKey(record), record);
        }
        return setInDb(registryKey(guildId), sortRecords([...next.values()]));
    })));
    return true;
}

`;
    text = text.replace(marker, helper + marker);
  }
  return text;
});

const responseCatalogChanged = patchFile('src/events/fullResponseCatalogReady.js', source => {
  let text = source;
  text = replaceRequired(
    text,
    "    title: 'Roulette — You won!',",
    "    title: 'Roulette win',",
    'roulette win seed',
  );
  text = replaceRequired(
    text,
    "    title: 'Roulette — You lost',",
    "    title: 'Roulette loss',",
    'roulette loss seed',
  );
  text = replaceRequired(
    text,
    '      title: `Result: ${title}`,',
    '      title: `Blackjack ${title.toLowerCase()}`,',
    'blackjack result seed',
  );

  const oldBaccaratResultSeed = `  captureSystemEmbedData({
    title: 'Baccarat — Result',
    description: 'You chose **{dynamic}**. Winner: **{dynamic}**\\nPayout: **{dynamic}**\\nCash balance: **{dynamic}**',
    color: 0x57F287,
    fields: [
      { name: 'Player Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
      { name: 'Banker Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
    ],
  }, baccarat);`;

  const newBaccaratResultSeeds = `  const baccaratFields = [
    { name: 'Player Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
    { name: 'Banker Hand', value: '{dynamic}\\nValue: **{dynamic}**', inline: true },
  ];
  const baccaratResults = [
    ['win', 'You chose **{dynamic}**. Winner: **{dynamic}**\\nPayout: **{dynamic}**\\nCash balance: **{dynamic}**', baccaratFields],
    ['loss', 'You chose **{dynamic}**. Winner: **{dynamic}**\\nYou lost **{dynamic}**\\nCash balance: **{dynamic}**', baccaratFields],
    ['tie', 'You chose **{dynamic}**. Winner: **{dynamic}**\\nTie — your **{dynamic}** bet was returned.\\nCash balance: **{dynamic}**', baccaratFields],
    ['expired', 'Game expired — **{dynamic}** was returned.', []],
  ];
  for (const [outcome, description, fields] of baccaratResults) {
    captureSystemEmbedData({
      title: \`Baccarat \${outcome}\`,
      description,
      color: 0x57F287,
      ...(fields.length ? { fields } : {}),
    }, baccarat);
  }`;

  text = replaceRequired(
    text,
    oldBaccaratResultSeed,
    newBaccaratResultSeeds,
    'baccarat outcome seeds',
  );
  return text;
});

const builderTitleDisplayChanged = patchFile('src/commands/Tools/embedbuilder.js', source => {
  let text = source;

  if (!text.includes('function visibleBuilderTitle(')) {
    const marker = 'function isPublicToEveryone(guild, channel) {';
    if (!text.includes(marker)) throw new Error('[CASINO_EMBEDS] Builder short-value marker was not found.');
    const helper = `function visibleBuilderTitle(value) {
    if (!value) return '\`Not set\`';
    // Custom emoji markup must stay outside a code span so Discord renders the
    // emoji itself instead of exposing its internal name and numeric ID.
    return String(value).replace(/\\s+/g, ' ').trim();
}

${marker}`;
    text = text.replace(marker, helper);
  }

  text = replaceRequired(
    text,
    '            `**Title** › ${shortValue(state.title, 40)}`,',
    '            `**Title** › ${visibleBuilderTitle(state.title)}`,',
    'rendered Builder title',
  );

  return text;
});

const managerChanged = patchFile('src/services/embedManagerService.js', source => {
  let text = source;

  text = replaceRequired(
    text,
    "    primeSystemEmbedCatalogMessage,\n    primeSystemEmbedTemplateData,\n    syncSystemEmbedCatalogMessage,",
    "    getSystemEmbedTemplateKey,\n    primeSystemEmbedCatalogMessage,\n    primeSystemEmbedTemplateData,\n    syncSystemEmbedCatalogMessage,",
    'manager catalog import',
  );

  if (!text.includes('function curatedGameTemplateIdentity(')) {
    const marker = 'export function templateIdentity(channelId, value) {';
    if (!text.includes(marker)) throw new Error('[CASINO_EMBEDS] manager identity marker was not found.');
    const helper = `function curatedGameTemplateIdentity(value) {
    const data = value && typeof value === 'object' ? value : { title: value };
    const stableContext = stableSystemTemplateContext(data);
    const fieldNames = new Set((Array.isArray(data.fields) ? data.fields : [])
        .map(field => String(field?.name || '').replace(/<a?:[^:>]+:\\d+>/g, ' ').trim().toLowerCase()));
    const description = String(data.description || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const structuralContext = fieldNames.has('player hand') && fieldNames.has('banker hand')
        || (/\\byou chose\\b/.test(description) && /\\bwinner\\b/.test(description))
        ? 'gambling/baccarat'
        : fieldNames.has('your hand') && fieldNames.has('dealer hand')
            || (/\\bpayout\\b/.test(description) && /\\bcash balance\\b/.test(description))
            ? 'gambling/blackjack'
            : /\\bwheel landed on\\b/.test(description)
                ? 'gambling/roulette'
                : '';
    const preferredContext = /^gambling\\/(?:roulette|blackjack|baccarat)$/.test(stableContext)
        ? stableContext
        : structuralContext;
    const contexts = preferredContext
        ? [preferredContext]
        : ['gambling/roulette', 'gambling/blackjack', 'gambling/baccarat'];
    for (const context of contexts) {
        const key = getSystemEmbedTemplateKey('embed', data.title || '', data.description || '', context);
        if (String(key || '').startsWith('game:')) return key;
    }
    return '';
}

`;
    text = text.replace(marker, helper + marker);
  }

  const formerManagerIdentity = "    const stableKey = stableSystemTemplateKey(data);\n    if (stableKey) return stableKey;\n    const curatedGameKey = curatedGameTemplateIdentity(data);\n    if (curatedGameKey) return curatedGameKey;\n    const title = String(data.title || '');";
  const managerIdentity = "    const stableKey = stableSystemTemplateKey(data);\n    if (String(stableKey || '').startsWith('game:')) return stableKey;\n    const curatedGameKey = curatedGameTemplateIdentity(data);\n    if (curatedGameKey) return curatedGameKey;\n    if (stableKey) return stableKey;\n    const title = String(data.title || '');";
  if (text.includes(formerManagerIdentity) && !text.includes(managerIdentity)) {
    text = text.replace(formerManagerIdentity, managerIdentity);
  } else {
    text = replaceRequired(
      text,
      "    const stableKey = stableSystemTemplateKey(data);\n    if (stableKey) return stableKey;\n    const title = String(data.title || '');",
      managerIdentity,
      'manager curated identity',
    );
  }

  text = replaceRequired(
    text,
    "function collapseDisplayRecords(channelRecords, channelId = null) {\n    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));\n    const groups = new Map();",
    "function collapseDisplayRecords(channelRecords, channelId = null) {\n    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));\n    const groups = new Map();\n    const hasSpecificBaccaratResult = channelRecords.some(record =>\n        /^game:baccarat:(?:win|loss|tie|expired)$/.test(templateIdentity(channelId, recordEmbedData(record))));",
    'manager baccarat visibility',
  );

  text = replaceRequired(
    text,
    "        const recordData = recordEmbedData(record);\n        const ticketLog = canonicalTicketLogTemplate(recordData);",
    "        const recordData = recordEmbedData(record);\n        if (hasSpecificBaccaratResult && stableSystemTemplateKey(recordData) === 'game:baccarat:result') continue;\n        const ticketLog = canonicalTicketLogTemplate(recordData);",
    'manager legacy baccarat hide',
  );

  const oldRepresentative = `        group.records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        // Show the newest real message when there is one, so the Builder opens
        // with live cards/bets/cash. The hidden peers remain linked for Save.
        const realRecords = group.records.filter(record => record.source !== 'system-catalog');
        const representative = (realRecords.length ? realRecords : group.records).at(-1);
        return {
            ...representative,`;

  const newRepresentative = `        group.records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        // For casino templates, preview the newest live values but keep the
        // editable system-catalog record as the physical Save target. Slash
        // command replies themselves cannot be edited later by the Builder.
        const realRecords = group.records.filter(record => record.source !== 'system-catalog');
        const catalogRecords = group.records.filter(record => record.source === 'system-catalog');
        const liveRepresentative = realRecords.at(-1) || null;
        const groupIdentity = String(group.identity || '');
        const canonicalCatalogRepresentative = catalogRecords.filter(record =>
            stableSystemTemplateKey(recordEmbedData(record)) === groupIdentity).at(-1) || null;
        const legacyCatalogRepresentative = catalogRecords.filter(record => {
            const data = recordEmbedData(record);
            const stableKey = stableSystemTemplateKey(data);
            return groupIdentity.startsWith('game:')
                && !stableKey.startsWith('game:')
                && curatedGameTemplateIdentity(data) === groupIdentity;
        }).at(-1) || null;
        const catalogRepresentative = canonicalCatalogRepresentative || catalogRecords.at(-1) || null;
        const previewRepresentative = liveRepresentative || legacyCatalogRepresentative;
        let representative = (realRecords.length ? realRecords : group.records).at(-1);

        if (catalogRepresentative && previewRepresentative) {
            const liveSnapshot = recordEmbedData(previewRepresentative);
            const saveSnapshot = recordEmbedData(catalogRepresentative);
            const stableTemplateKey = groupIdentity
                || stableSystemTemplateKey(saveSnapshot)
                || curatedGameTemplateIdentity(liveSnapshot);
            if (String(stableTemplateKey || '').startsWith('game:')) {
                representative = {
                    ...catalogRepresentative,
                    snapshot: liveSnapshot,
                    saveSnapshot,
                    stableTemplateKey,
                };
            }
        }

        return {
            ...representative,`;

  if (!text.includes(newRepresentative)
    && !text.includes('catalogRepresentative.snapshot = liveSnapshot;')) {
    text = replaceRequired(text, oldRepresentative, newRepresentative, 'manager casino save representative');
  }

  text = replaceRequired(
    text,
    "    const data = migrateCloudyLogoEmbedData(snapshot).data || {};\n    const footerText = cleanFooter(data.footer?.text || '');",
    "    const data = migrateCloudyLogoEmbedData(snapshot).data || {};\n    const saveSnapshot = record?.saveSnapshot || snapshot;\n    const saveData = migrateCloudyLogoEmbedData(saveSnapshot).data || data;\n    const footerText = cleanFooter(data.footer?.text || '');",
    'manager save snapshot',
  );

  text = replaceRequired(
    text,
    "        sourceEmbedData: data,\n        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),\n        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',\n        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),\n        cachedMessage: null,",
    "        sourceEmbedData: saveData,\n        hadBuilderMarker: Boolean(saveData.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),\n        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',\n        templateTitle: record?.stableTemplateKey || templateRule?.key || templateIdentity(logicalChannelId, saveData),\n        cachedMessage: null,",
    'manager catalog save target state',
  );

  if (!text.includes('function customEmojiOption(')) {
    const marker = `function standardDynamicTemplateName(value) {
    const title = String(value || '').replace(/\\s+/g, ' ').trim();
    if (/^blackjack\\s*[—-]\\s*bet\\b/i.test(title)) return 'Blackjack — Bet';
    if (/^baccarat\\s*[—-]\\s*bet\\b/i.test(title)) return 'Baccarat — Bet';
    return title;
}
`;
    if (!text.includes(marker)) throw new Error('[CASINO_EMBEDS] manager display-name marker was not found.');
    const helpers = `${marker}
function customEmojiOption(value) {
    const match = String(value || '').match(/<(a?):([^:>]+):(\\d+)>/);
    if (!match) return null;
    return { id: match[3], name: match[2], animated: match[1] === 'a' };
}

function gameTemplateDisplayName(identity) {
    const key = String(identity || '').toLowerCase();
    if (key === 'game:roulette:won') return 'Roulette win';
    if (key === 'game:roulette:lost') return 'Roulette loss';
    if (key === 'game:blackjack:bet') return 'Blackjack bet';
    if (key === 'game:baccarat:bet') return 'Baccarat bet';

    const blackjackPrefix = 'game:blackjack:result:';
    if (key.startsWith(blackjackPrefix)) {
        const outcome = key.slice(blackjackPrefix.length)
            .split('-')
            .map(part => part === 'blackjack' ? 'natural win' : part)
            .join(' / ');
        return outcome ? \`Blackjack \${outcome}\` : '';
    }

    const baccaratMatch = key.match(/^game:baccarat:(win|loss|tie|expired)$/);
    return baccaratMatch ? \`Baccarat \${baccaratMatch[1]}\` : '';
}
`;
    text = text.replace(marker, helpers);
  }

  text = replaceRequired(
    text,
    `        const name = standardDynamicTemplateName(rawName) || 'Untitled embed';
        const key = \`template:\${templateIdentity(channelId, recordEmbedData(record))}\`;
        if (!groups.has(key)) groups.set(key, { label: name, records: [], templateMode: false });
        groups.get(key).records.push(record);`,
    `        const identity = templateIdentity(channelId, recordData);
        const visibleName = stripCustomEmojiMarkup(rawName);
        const name = gameTemplateDisplayName(identity)
            || standardDynamicTemplateName(visibleName)
            || 'Untitled embed';
        const key = \`template:\${identity}\`;
        const emoji = customEmojiOption(recordData.title || rawName);
        if (!groups.has(key)) groups.set(key, {
            label: name,
            identity,
            records: [],
            templateMode: false,
            optionEmoji: emoji,
        });
        const group = groups.get(key);
        if (emoji && (record.source === 'system-catalog' || !group.optionEmoji)) group.optionEmoji = emoji;
        group.records.push(record);`,
    'manager stable game display names',
  );

  text = replaceRequired(
    text,
    `            name: group.label,
            duplicateCount: group.records.length,`,
    `            name: group.label,
            optionEmoji: group.optionEmoji || null,
            duplicateCount: group.records.length,`,
    'manager custom emoji option',
  );

  text = replaceRequired(
    text,
    `                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(displayName, 'Untitled embed'))
                    .setDescription(description.slice(0, 100))
                    .setValue(\`\${record.messageId}:\${record.embedIndex || 0}\`);`,
    `                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(displayName, 'Untitled embed'))
                    .setDescription(description.slice(0, 100))
                    .setValue(\`\${record.messageId}:\${record.embedIndex || 0}\`);
                if (record.optionEmoji) option.setEmoji(record.optionEmoji);
                return option;`,
    'manager rendered custom emoji',
  );

  return text;
});

console.log(`[CASINO_EMBEDS] ${[
  rouletteChanged,
  blackjackChanged,
  baccaratChanged,
  catalogChanged,
  responseCatalogChanged,
  builderTitleDisplayChanged,
  managerChanged,
  registryChanged,
].some(Boolean) ? 'patched distinct per-game outcomes + safe catalog Save targeting' : 'already current'}`);
