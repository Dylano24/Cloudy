import fs from 'node:fs';

// Narrow compatibility patch for casino Embed Builder identities only.
// Game rules, payouts, buttons, colors, logos and unrelated embeds stay untouched.
const path = 'src/services/systemEmbedCatalogService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

function replaceOnce(from, to, label) {
  if (text.includes(to)) return;
  if (!text.includes(from)) throw new Error(`[CASINO_TEMPLATE_STATES] Missing ${label} marker.`);
  text = text.replace(from, to);
}

replaceOnce(
`const BLACKJACK_RESULT_STATES = new Set([
  'bust',
  'blackjack',
  'win',
  'push',
  'loss',
  'expired',
]);`,
`const BLACKJACK_RESULT_STATES = new Set([
  'bust',
  'blackjack',
  'win',
  'push',
  'loss',
  'expired',
]);

const BACCARAT_RESULT_STATES = new Set([
  'win',
  'loss',
  'tie',
  'expired',
]);`,
'casino state sets',
);

replaceOnce(
`  if (normalizedContext === 'gambling/baccarat') {
    return normalizedKey === 'game:baccarat:bet' || normalizedKey === 'game:baccarat:result';
  }`,
`  if (normalizedContext === 'gambling/baccarat') {
    if (normalizedKey === 'game:baccarat:bet') return true;
    return BACCARAT_RESULT_STATES.has(normalizedKey.replace(/^game:baccarat:/, ''));
  }`,
'baccarat editable keys',
);

replaceOnce(
`function canonicalBlackjackResult(value) {
  const result = normalize(value).replace(/^result\\s*:\\s*/, '');
  const outcomes = result.split(/\\s*\\/\\s*/).map(item => normalize(item)).filter(Boolean);
  if (!outcomes.length || outcomes.length > 2 || outcomes.some(item => !BLACKJACK_RESULT_STATES.has(item))) {
    return '';
  }
  return outcomes.join('-');
}`,
`function canonicalBlackjackResult(value) {
  const result = normalize(value).replace(/^(?:result\\s*:\\s*|blackjack\\s+)/, '');
  const outcomes = result.split(/\\s*\\/\\s*/).map(item => normalize(item)).filter(Boolean);
  if (!outcomes.length || outcomes.length > 2 || outcomes.some(item => !BLACKJACK_RESULT_STATES.has(item))) {
    return '';
  }
  return outcomes.join('-');
}

function canonicalBaccaratResult(title, description = '') {
  const direct = normalize(title).match(/^baccarat\\s+(win|loss|tie|expired)$/);
  if (direct) return direct[1];

  const body = normalize(description);
  if (/\\bgame expired\\b/.test(body)) return 'expired';
  if (/\\byou lost\\b/.test(body)) return 'loss';
  if (/\\btie\\b.*\\breturned\\b/.test(body)) return 'tie';
  if (/\\bpayout\\s*:/.test(body)) return 'win';
  return '';
}

function canonicalCasinoTitle(key) {
  const normalizedKey = normalize(key);
  if (normalizedKey === 'game:roulette:won') return 'Roulette win';
  if (normalizedKey === 'game:roulette:lost') return 'Roulette loss';
  if (normalizedKey.startsWith('game:baccarat:')) {
    const state = normalizedKey.slice('game:baccarat:'.length);
    return BACCARAT_RESULT_STATES.has(state) ? \\`Baccarat \\${state}\\` : null;
  }
  if (normalizedKey.startsWith('game:blackjack:result:')) {
    const result = normalizedKey.slice('game:blackjack:result:'.length);
    if (!isValidBlackjackResultSlug(result)) return null;
    return \\`Blackjack \\${result.split('-').join(' / ')}\\`;
  }
  return null;
}

function shouldRepairCasinoTitle(title, key) {
  const canonical = canonicalCasinoTitle(key);
  if (!canonical) return false;
  const current = normalize(title);
  if (current === normalize(canonical)) return false;
  if (!current) return true;
  if (/^result\\s*:/.test(current)) return true;
  if (/^(?:win|loss|tie|expired|push|bust|blackjack)(?:\\s*\\/\\s*(?:win|loss|tie|expired|push|bust|blackjack))?$/.test(current)) return true;
  if (/^roulette\\s*[—-]\\s*you\\s+(?:won!?|lost)$/.test(current)) return true;
  if (/^baccarat\\s*[—-]\\s*result\\b/.test(current)) return true;

  const expectedGame = normalize(canonical).split(' ')[0];
  const namedGame = current.match(/^(blackjack|roulette|baccarat)\\b/)?.[1] || null;
  return Boolean(namedGame && namedGame !== expectedGame);
}

function casinoFieldNames(data) {
  return (Array.isArray(data?.fields) ? data.fields : [])
    .map(field => normalize(field?.name).replace(/[^a-z0-9\\s]/g, ' ').replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
}

function hasForeignCasinoFields(data, context) {
  const names = casinoFieldNames(data);
  if (!names.length) return false;
  const normalizedContext = normalize(context);

  if (normalizedContext === 'gambling/roulette') {
    return names.some(name => name.includes('hand'));
  }
  if (normalizedContext === 'gambling/baccarat') {
    return names.some(name => name.includes('dealer hand') || name.includes('your hand'));
  }
  if (normalizedContext === 'gambling/blackjack') {
    return names.some(name => name.includes('player hand') || name.includes('banker hand'));
  }
  return false;
}

function repairCasinoTemplate(templateData, runtimeData, key, context) {
  const current = cloneData(templateData || {});
  const runtime = cloneData(runtimeData || {});
  let changed = false;

  if (shouldRepairCasinoTitle(current.title, key) && runtime.title) {
    current.title = runtime.title;
    changed = true;
  }

  if (hasForeignCasinoFields(current, context)) {
    if (runtime.description) current.description = runtime.description;
    else delete current.description;
    if (Array.isArray(runtime.fields) && runtime.fields.length) current.fields = runtime.fields.map(field => ({ ...field }));
    else delete current.fields;
    changed = true;
  }

  return { data: current, changed };
}`,
'casino canonical helpers',
);

replaceOnce(
`  if (normalizedKind === 'embed' && normalizedContext === 'gambling/roulette') {
    if (/^roulette\\s*[—-]\\s*you\\s+won!?$/.test(normalizedTitle)) return 'game:roulette:won';
    if (/^roulette\\s*[—-]\\s*you\\s+lost$/.test(normalizedTitle)) return 'game:roulette:lost';
    return '';
  }

  if (normalizedKind === 'embed' && normalizedContext === 'gambling/blackjack') {
    if (/^blackjack\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:blackjack:bet';
    if (/^result\\s*:/.test(normalizedTitle)) {
      const result = canonicalBlackjackResult(normalizedTitle);
      return result ? \\`game:blackjack:result:\\${result}\\` : '';
    }
    return '';
  }

  if (normalizedKind === 'embed' && normalizedContext === 'gambling/baccarat') {
    if (/^baccarat\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:baccarat:bet';
    if (/^baccarat\\s*[—-]\\s*result\\b/.test(normalizedTitle)) return 'game:baccarat:result';
    return '';
  }`,
`  if (normalizedKind === 'embed' && normalizedContext === 'gambling/roulette') {
    if (/^roulette\\s+win$/.test(normalizedTitle) || /^roulette\\s*[—-]\\s*you\\s+won!?$/.test(normalizedTitle)) return 'game:roulette:won';
    if (/^roulette\\s+loss$/.test(normalizedTitle) || /^roulette\\s*[—-]\\s*you\\s+lost$/.test(normalizedTitle)) return 'game:roulette:lost';
    return '';
  }

  if (normalizedKind === 'embed' && normalizedContext === 'gambling/blackjack') {
    if (/^blackjack\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:blackjack:bet';
    const result = canonicalBlackjackResult(normalizedTitle);
    return result ? \\`game:blackjack:result:\\${result}\\` : '';
  }

  if (normalizedKind === 'embed' && normalizedContext === 'gambling/baccarat') {
    if (/^baccarat\\s*[—-]\\s*bet\\b/.test(normalizedTitle)) return 'game:baccarat:bet';
    const result = canonicalBaccaratResult(title, description);
    return result ? \\`game:baccarat:\\${result}\\` : '';
  }`,
'casino key detection',
);

// Let legacy Baccarat result rows fall through to content-based outcome detection
// instead of pinning every result to one generic template.
text = text.replace(
`    ['gambling/baccarat', 'Baccarat — Result', 'Choose where to place your bet.', 'game:baccarat:result'],
    ['gambling/baccarat', 'Baccarat — Result', 'You chose **{dynamic}**. Winner: **{dynamic}**\\nPayout: **{dynamic}**\\nCash balance: **{dynamic}**', 'game:baccarat:result'],
`,
'',
);

replaceOnce(
`    const canonicalData = withStableKey(
      merged,
      winner.canonicalKey,
      winner.metadata.context,
      winner.metadata.kind,
    );`,
`    const canonicalTitle = canonicalCasinoTitle(winner.canonicalKey);
    if (canonicalTitle && shouldRepairCasinoTitle(merged.title, winner.canonicalKey)) {
      merged.title = canonicalTitle;
    }
    if (hasForeignCasinoFields(merged, winner.metadata.context)) {
      delete merged.description;
      delete merged.fields;
    }

    const canonicalData = withStableKey(
      merged,
      winner.canonicalKey,
      winner.metadata.context,
      winner.metadata.kind,
    );`,
'catalog cleanup repair',
);

replaceOnce(
`  const specificKey = getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  const titleKey = normalize(data.title);
  const template = (specificKey ? findTemplate(specificKey, context) : null) || findTemplate(titleKey, context);

  if (!template) {
    if (context && specificKey) captureSystemEmbedData(data, contextSource);
    return isBlackjackContext(context) ? stripBlackjackCardsRemaining(data) : data;
  }

  const next = { ...data };`,
`  const specificKey = getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  const titleKey = normalize(data.title);
  let template = (specificKey ? findTemplate(specificKey, context) : null) || findTemplate(titleKey, context);

  if (!template) {
    if (context && specificKey) captureSystemEmbedData(data, contextSource);
    return isBlackjackContext(context) ? stripBlackjackCardsRemaining(data) : data;
  }

  if (specificKey && isCuratedCasinoContext(context)) {
    const repaired = repairCasinoTemplate(template, data, specificKey, context);
    if (repaired.changed) {
      template = repaired.data;
      rememberTemplate(specificKey, template, context);
      queueRuntimeEntry({
        key: specificKey,
        context,
        kind: 'embed',
        data: withStableKey(mergeCatalogShape(template, data), specificKey, context, 'embed'),
      });
    }
  }

  const next = { ...data };`,
'runtime casino repair',
);

if (text !== before) fs.writeFileSync(path, text);
console.log(`[CASINO_TEMPLATE_STATES] ${text === before ? 'already current' : 'patched isolated game/outcome templates'}`);
