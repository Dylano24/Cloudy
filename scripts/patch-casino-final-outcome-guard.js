import fs from 'node:fs';

function patchFile(path, label, transform) {
  const before = fs.readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) {
    console.log(`[CASINO_FINAL_GUARD] ${label}=current`);
    return false;
  }
  fs.writeFileSync(path, after);
  console.log(`[CASINO_FINAL_GUARD] ${label}=patched`);
  return true;
}

patchFile('src/services/systemEmbedCatalogService.js', 'system-runtime-authority', before => {
  let text = before;

  const marker = `  if (template.thumbnail?.url) next.thumbnail = { ...template.thumbnail };
  else delete next.thumbnail;
  if (template.image?.url) next.image = { ...template.image };
  else delete next.image;
  return isBlackjackContext(context) ? stripBlackjackCardsRemaining(next) : next;`;
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
      next.title = game.charAt(0).toUpperCase() + game.slice(1) + ' ' + outcome;
      next.color = outcome === 'win' ? 0x00C49D : outcome === 'push' ? 0x336699 : 0x670102;
      if (data.thumbnail?.url) next.thumbnail = { ...data.thumbnail };
    }
  }

  return isBlackjackContext(context) ? stripBlackjackCardsRemaining(next) : next;`;

  if (!text.includes('Casino result semantics are runtime-owned.') && text.includes(marker)) {
    text = text.replace(marker, guard);
  }

  const blackjackCanonicalMarker = `  const result = normalize(value).replace(/^result\\s*:\\s*/, '');`;
  if (text.includes(blackjackCanonicalMarker)) {
    text = text.replace(
      blackjackCanonicalMarker,
      `  const result = normalize(value)
    .replace(/^blackjack\\s+/, '')
    .replace(/^result\\s*:\\s*/, '');`,
    );
  }

  const rouletteLegacy = `  if (normalizedKind === 'embed' && normalizedContext === 'gambling/roulette') {
    if (/^roulette\\s*[—-]\\s*you\\s+won!?$/.test(normalizedTitle)) return 'game:roulette:won';
    if (/^roulette\\s*[—-]\\s*you\\s+lost$/.test(normalizedTitle)) return 'game:roulette:lost';
    return '';
  }`;
  const rouletteCurrent = `  if (normalizedKind === 'embed' && normalizedContext === 'gambling/roulette') {
    if (/^roulette\\s+win$/.test(normalizedTitle) || /^roulette\\s*[—-]\\s*you\\s+won!?$/.test(normalizedTitle)) return 'game:roulette:won';
    if (/^roulette\\s+loss$/.test(normalizedTitle) || /^roulette\\s*[—-]\\s*you\\s+lost$/.test(normalizedTitle)) return 'game:roulette:lost';
    return '';
  }`;
  if (text.includes(rouletteLegacy)) text = text.replace(rouletteLegacy, rouletteCurrent);

  const blackjackLegacy = `  if (normalizedKind === 'embed' && normalizedContext === 'gambling/blackjack') {
    if (/^blackjack\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:blackjack:bet';
    if (/^result\\s*:/.test(normalizedTitle)) {
      const result = canonicalBlackjackResult(normalizedTitle);
      return result ? \`game:blackjack:result:\${result}\` : '';
    }
    return '';
  }`;
  const blackjackCurrent = `  if (normalizedKind === 'embed' && normalizedContext === 'gambling/blackjack') {
    if (/^blackjack\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:blackjack:bet';
    const result = canonicalBlackjackResult(normalizedTitle);
    return result ? \`game:blackjack:result:\${result}\` : '';
  }`;
  if (text.includes(blackjackLegacy)) text = text.replace(blackjackLegacy, blackjackCurrent);

  const baccaratLegacy = `  if (normalizedKind === 'embed' && normalizedContext === 'gambling/baccarat') {
    if (/^baccarat\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:baccarat:bet';
    if (/^baccarat\\s*[—-]\\s*result\\b/.test(normalizedTitle)) return 'game:baccarat:result';
    return '';
  }`;
  const baccaratCurrent = `  if (normalizedKind === 'embed' && normalizedContext === 'gambling/baccarat') {
    if (/^baccarat\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:baccarat:bet';
    const result = normalizedTitle.match(/^baccarat\\s+(win|loss|push|expired)$/);
    if (result) return \`game:baccarat:\${result[1]}\`;
    if (/^baccarat\\s*[—-]\\s*result\\b/.test(normalizedTitle)) return 'game:baccarat:result';
    return '';
  }`;
  if (text.includes(baccaratLegacy)) text = text.replace(baccaratLegacy, baccaratCurrent);

  const baccaratEditableLegacy = `  if (normalizedContext === 'gambling/baccarat') {
    return normalizedKey === 'game:baccarat:bet' || normalizedKey === 'game:baccarat:result';
  }`;
  const baccaratEditableCurrent = `  if (normalizedContext === 'gambling/baccarat') {
    return new Set([
      'game:baccarat:bet',
      'game:baccarat:result',
      'game:baccarat:win',
      'game:baccarat:loss',
      'game:baccarat:push',
      'game:baccarat:expired',
    ]).has(normalizedKey);
  }`;
  if (text.includes(baccaratEditableLegacy)) text = text.replace(baccaratEditableLegacy, baccaratEditableCurrent);

  return text;
});

patchFile('src/services/embedTemplateService.js', 'saved-template-outcome-isolation', before => {
  if (before.includes('Casino result titles/colors are semantic runtime data.')) return before;

  const headMarker = `function decorateEmbedData(embed, stored, options = {}) {
  const original = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
  const data = { ...original };
  const template = findStoredTemplate(data, stored, options);
  if (!template) return { matched: false, changed: false, data };`;

  const headReplacement = `function decorateEmbedData(embed, stored, options = {}) {
  const original = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
  const data = { ...original };

  const runtimeTitle = normalizeKey(original.title);
  const casinoMatch = runtimeTitle.match(/^(blackjack|baccarat|roulette)\\s+(win|loss|bust|push)$/);
  const casinoRuntime = (() => {
    if (!casinoMatch) return null;
    const [, game, outcome] = casinoMatch;
    const allowed = (game === 'blackjack' && ['win', 'loss', 'bust', 'push'].includes(outcome))
      || (game === 'baccarat' && ['win', 'loss', 'push'].includes(outcome))
      || (game === 'roulette' && ['win', 'loss'].includes(outcome));
    if (!allowed) return null;
    return {
      title: game.charAt(0).toUpperCase() + game.slice(1) + ' ' + outcome,
      color: outcome === 'win' ? 0x00C49D : outcome === 'push' ? 0x336699 : 0x670102,
    };
  })();

  // Win/loss/push/bust share very similar descriptions. Never let the generic
  // description alias select another casino outcome's saved template.
  const template = findStoredTemplate(data, stored, {
    ...options,
    strictTitle: options.strictTitle === true || Boolean(casinoRuntime),
  });
  if (!template) return { matched: false, changed: false, data };`;

  const tailMarker = `  const finalData = stripBlackjackCardsRemaining(data);
  return {`;

  const tailReplacement = `  // Casino result titles/colors are semantic runtime data. A correctly matched
  // Builder template may still style fields/footer/media, but cannot change the
  // actual result identity, side color, or live Cloudy logo.
  if (casinoRuntime) {
    data.title = casinoRuntime.title;
    data.color = casinoRuntime.color;
    if (original.thumbnail?.url) data.thumbnail = { ...original.thumbnail };
  }

  const finalData = stripBlackjackCardsRemaining(data);
  return {`;

  if (!before.includes(headMarker) || !before.includes(tailMarker)) return before;
  return before.replace(headMarker, headReplacement).replace(tailMarker, tailReplacement);
});

patchFile('src/events/fullResponseCatalogReady.js', 'final-discord-outcome-enforcement', before => {
  let text = before;

  if (!text.includes('Final Discord payload guard for casino outcomes.')) {
    const helperMarker = 'function applyPayloadTemplates(payload, source) {';
    const helper = `// Final Discord payload guard for casino outcomes. This uses the ORIGINAL
// runtime payload as authority after every catalog and saved-template layer.
function enforceCasinoOutcomePresentation(runtimePayload, outgoing, source, method = 'unknown') {
  const command = String(source?.commandName || '').trim().toLowerCase();
  if (!['blackjack', 'baccarat', 'roulette'].includes(command)) return outgoing;
  if (!runtimePayload || typeof runtimePayload !== 'object' || !Array.isArray(runtimePayload.embeds)) return outgoing;
  if (!outgoing || typeof outgoing !== 'object' || !Array.isArray(outgoing.embeds)) return outgoing;

  let protectedCount = 0;
  const embeds = outgoing.embeds.map((embed, index) => {
    const runtimeEmbed = runtimePayload.embeds[index];
    const runtimeData = runtimeEmbed?.toJSON ? runtimeEmbed.toJSON() : runtimeEmbed;
    if (!runtimeData || typeof runtimeData !== 'object') return embed;

    const match = String(runtimeData.title || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      .match(/^(blackjack|baccarat|roulette)\\s+(win|loss|bust|push)$/);
    if (!match) return embed;

    const [, game, outcome] = match;
    const allowed = game === command && (
      (game === 'blackjack' && ['win', 'loss', 'bust', 'push'].includes(outcome))
      || (game === 'baccarat' && ['win', 'loss', 'push'].includes(outcome))
      || (game === 'roulette' && ['win', 'loss'].includes(outcome))
    );
    if (!allowed) return embed;

    const decorated = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
    const protectedEmbed = {
      ...decorated,
      title: game.charAt(0).toUpperCase() + game.slice(1) + ' ' + outcome,
      color: outcome === 'win' ? 0x00C49D : outcome === 'push' ? 0x336699 : 0x670102,
      ...(runtimeData.thumbnail?.url ? { thumbnail: { ...runtimeData.thumbnail } } : {}),
    };
    protectedCount += 1;
    return protectedEmbed;
  });

  if (protectedCount) {
    logger.warn(
      \`[CASINO_OUTGOING] command=\${command} method=\${method} protected=\${protectedCount} title=\${embeds[0]?.title || ''} color=\${embeds[0]?.color ?? ''}\`,
    );
  }
  return { ...outgoing, embeds };
}

`;
    if (text.includes(helperMarker)) text = text.replace(helperMarker, helper + helperMarker);
  }

  const wrapperMarker = `          outgoing = applyPayloadTemplates(payload, source);
          outgoing = await applySavedBlackjackPayloadTemplates(outgoing, source);`;
  const wrapperReplacement = `          outgoing = applyPayloadTemplates(payload, source);
          outgoing = await applySavedBlackjackPayloadTemplates(outgoing, source);
          outgoing = enforceCasinoOutcomePresentation(payload, outgoing, source, method);`;
  if (!text.includes('enforceCasinoOutcomePresentation(payload, outgoing, source, method)') && text.includes(wrapperMarker)) {
    text = text.replace(wrapperMarker, wrapperReplacement);
  }

  // Keep the Builder's seeded casino identities aligned with the actual
  // player-facing result palette.
  text = text
    .replace(`color: 0x57F287,
    fields: [
      { name: 'Your bet'`, `color: 0x00C49D,
    fields: [
      { name: 'Your bet'`)
    .replace(`color: 0xFEE75C,
    fields: [
      { name: 'Your bet'`, `color: 0x670102,
    fields: [
      { name: 'Your bet'`)
    .replace(
      "color: title === 'Win' || title === 'Blackjack' ? 0x57F287 : title === 'Loss' || title === 'Bust' ? 0xED4245 : 0x5865F2,",
      "color: title === 'Win' || title === 'Blackjack' ? 0x00C49D : title === 'Loss' || title === 'Bust' ? 0x670102 : title === 'Push' ? 0x336699 : 0x5865F2,",
    )
    .replace(
      `    ['tie', 'You chose **{dynamic}**. Winner: **{dynamic}**\\nTie — your **{dynamic}** bet was returned.\\nCash balance: **{dynamic}**', baccaratFields],`,
      `    ['push', 'You chose **{dynamic}**. Winner: **{dynamic}**\\nTie — your **{dynamic}** bet was returned.\\nCash balance: **{dynamic}**', baccaratFields],`,
    )
    .replace(
      `      color: 0x57F287,
      ...(fields.length ? { fields } : {}),`,
      `      color: outcome === 'win' ? 0x00C49D : outcome === 'loss' ? 0x670102 : outcome === 'push' ? 0x336699 : 0x5865F2,
      ...(fields.length ? { fields } : {}),`,
    );

  return text;
});

console.log('[CASINO_FINAL_GUARD] complete');
