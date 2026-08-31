import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const MAX_FILE_SIZE = 1_000_000;
const SKIPPED_FILES = new Set([
  'embedManagerService.js',
  'embedDefinitionDiscoveryService.js',
  'systemEmbedCatalogService.js',
  'systemEmbedCaptureReady.js',
  'systemEmbedCatalogReady.js',
  'systemEmbedCatalogMessageUpdate.js',
]);

function decodeString(value, { allowDynamic = true } = {}) {
  if (value == null) return null;
  if (!allowDynamic && value.includes('${')) return null;
  return String(value)
    .replace(/\$\{[^}]*\}/g, '{dynamic}')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\`/g, '`')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    .trim();
}

function literalFromText(text) {
  const match = String(text || '').match(/(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/s);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function allLiterals(text, limit = 2) {
  const output = [];
  const regex = /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/gs;
  let match;
  while ((match = regex.exec(String(text || ''))) && output.length < limit) {
    output.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return output;
}

function safeSlug(value) {
  return String(value || '')
    .replace(/\.js$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function inferContext(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const file = safeSlug(parts.at(-1));
  const category = parts[0] === 'commands' ? String(parts[1] || '').toLowerCase() : '';

  if (category === 'economy') {
    if (/shop|store|purchase|subscription|buy|sell/.test(file)) return `shop/${file}`;
    return `gambling/${file}`;
  }
  if (category === 'fun') {
    if (/^(fight|flip|roll|dice|slots?|roulette|blackjack)/.test(file)) return `gambling/${file}`;
    return `botlog/${file}`;
  }
  if (category === 'music') return `music/${file}`;
  if (category === 'ticket') return `tickets/${file}`;
  if (category === 'giveaway') return `giveaway/${file}`;
  if (category === 'moderation' || category === 'logging') return `botlog/${file}`;
  if (category === 'community') {
    if (/appeal/.test(file)) return `ban-appeal/${file}`;
    if (/report/.test(file)) return `reports/${file}`;
    if (/shop|store|purchase|subscription/.test(file)) return `shop/${file}`;
    return `botlog/${file}`;
  }
  if (category) return `botlog/${file}`;

  if (/welcome/.test(file)) return `welcome/${file}`;
  if (/faq/.test(file)) return `faq/${file}`;
  if (/staff.*review/.test(file)) return `staff-reviews/${file}`;
  if (/appeal/.test(file)) return `ban-appeal/${file}`;
  if (/report/.test(file)) return `reports/${file}`;
  if (/music/.test(file)) return `music/${file}`;
  if (/ticket|transcript/.test(file)) return `tickets/${file}`;
  if (/shop|store|purchase|subscription/.test(file)) return `shop/${file}`;
  if (/gambl|economy|coin|flip|slots|blackjack|roulette|baccarat|fight|dice|roll/.test(file)) return `gambling/${file}`;
  return `botlog/${file}`;
}

function inferColor(title, kind = 'embed') {
  const value = String(title || '').toLowerCase();
  if (/success|completed|created|saved|enabled|added|joined|won|winner|purchased|received/.test(value)) return 0x57F287;
  if (/warning|cooldown|wait|pending|slow|too fast/.test(value)) return 0xFEE75C;
  if (/error|wrong|invalid|failed|denied|missing|not enough|blocked|disabled|cannot|could not|lost|loss/.test(value)) return 0xED4245;
  return kind === 'content' ? 0x99AAB5 : 0x5865F2;
}

function commandLabel(relativePath) {
  const file = safeSlug(relativePath.split('/').at(-1));
  return file
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Bot';
}

function plainLabel(relativePath, content) {
  const preview = String(content || '')
    .replace(/<a?:[^:>]+:\d+>/g, '')
    .replace(/\{dynamic\}/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${commandLabel(relativePath)} • ${preview || 'Message'}`.slice(0, 256);
}

function findDescription(lines, startIndex) {
  const end = Math.min(lines.length, startIndex + 24);
  for (let index = startIndex; index < end; index += 1) {
    const line = lines[index];
    const marker = line.includes('.setDescription(')
      ? '.setDescription('
      : /\bdescription\s*:/.test(line)
        ? 'description:'
        : null;
    if (!marker) continue;

    const combined = lines.slice(index, Math.min(end, index + 8)).join('\n');
    const raw = literalFromText(combined.slice(combined.indexOf(marker) + marker.length));
    const decoded = decodeString(raw, { allowDynamic: true });
    if (decoded) return decoded;
  }
  return null;
}

function findTitlesOnLine(lines, index) {
  const line = lines[index];
  let marker = null;
  if (line.includes('.setTitle(')) marker = '.setTitle(';
  else if (/\btitleOverride\s*:/.test(line)) marker = 'titleOverride:';
  else if (/\btitle\s*:/.test(line)) marker = 'title:';
  if (!marker) return [];

  const markerIndex = line.indexOf(marker);
  const sameLineExpression = line.slice(markerIndex + marker.length);
  const candidates = allLiterals(sameLineExpression, 8)
    .map(raw => decodeString(raw, { allowDynamic: false }))
    .filter(Boolean)
    .filter(value => value.length <= 256);

  if (candidates.length) return [...new Set(candidates)];

  const combined = lines.slice(index, Math.min(lines.length, index + 8)).join('\n');
  const raw = literalFromText(combined.slice(combined.indexOf(marker) + marker.length));
  const decoded = decodeString(raw, { allowDynamic: false });
  return decoded ? [decoded] : [];
}

function addDefinition(results, seen, definition) {
  const identity = `${definition.kind}|${definition.context}|${definition.title || definition.label || ''}|${definition.description || ''}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  results.push(definition);
}

function extractEmbedDefinitions(source, relativePath, results, seen) {
  const context = inferContext(relativePath);
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const titles = findTitlesOnLine(lines, index);
    if (!titles.length) continue;
    const description = findDescription(lines, index);
    for (const title of titles) {
      addDefinition(results, seen, {
        kind: 'embed',
        title,
        description,
        color: inferColor(title),
        context,
        variantId: `${relativePath}:embed:${index + 1}:${safeSlug(title)}`,
      });
    }
  }

  const helperRegex = /\b(successEmbed|infoEmbed|warningEmbed|errorEmbed)\s*\(([\s\S]{0,900}?)\)/g;
  let helperMatch;
  while ((helperMatch = helperRegex.exec(source))) {
    const literals = allLiterals(helperMatch[2], 2).map(value => decodeString(value, { allowDynamic: true }));
    if (!literals[0]) continue;
    const helper = helperMatch[1];
    const fallback = helper === 'successEmbed' ? 'Success'
      : helper === 'infoEmbed' ? 'Information'
        : helper === 'warningEmbed' ? 'Warning' : 'Error';
    const title = literals.length > 1 ? literals[0] : fallback;
    const description = literals.length > 1 ? literals[1] : literals[0];
    addDefinition(results, seen, {
      kind: 'embed',
      title,
      description,
      color: inferColor(title),
      context,
      variantId: `${relativePath}:helper:${helperMatch.index}`,
    });
  }
}

function extractPlainDefinitions(source, relativePath, results, seen) {
  const context = inferContext(relativePath);
  const patterns = [
    /\bcontent\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs,
    /\.(?:reply|followUp|editReply|send|respond)\s*\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const raw = literalFromText(match[1]);
      const content = decodeString(raw, { allowDynamic: true });
      if (!content || content.length > 4000) continue;
      if (/^(?:https?:\/\/|attachment:\/\/)/i.test(content) && !content.includes(' ')) continue;
      addDefinition(results, seen, {
        kind: 'content',
        label: plainLabel(relativePath, content),
        description: content,
        color: inferColor(content, 'content'),
        context,
        variantId: `${relativePath}:content:${match.index}`,
      });
    }
  }
}

function extractDefinitions(source, relativePath) {
  const results = [];
  const seen = new Set();
  extractEmbedDefinitions(source, relativePath, results, seen);
  extractPlainDefinitions(source, relativePath, results, seen);
  return results;
}

async function walk(dir, output = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, output);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !SKIPPED_FILES.has(entry.name)) {
      output.push(absolute);
    }
  }
  return output;
}

export async function discoverEmbedDefinitions() {
  const files = await walk(SOURCE_ROOT);
  const definitions = [];
  const unique = new Set();

  for (const absolute of files) {
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;

    let source;
    try {
      source = await fs.readFile(absolute, 'utf8');
    } catch {
      continue;
    }

    const relativePath = path.relative(SOURCE_ROOT, absolute).replace(/\\/g, '/');
    for (const definition of extractDefinitions(source, relativePath)) {
      const identity = `${definition.kind}|${definition.context}|${definition.title || definition.label || ''}|${definition.description || ''}`;
      if (unique.has(identity)) continue;
      unique.add(identity);
      definitions.push(definition);
    }
  }

  return definitions;
}
