import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const MAX_FILE_SIZE = 1_000_000;
const EMBED_HINT = /\b(?:EmbedBuilder|createEmbed|buildUserErrorEmbed|successEmbed|infoEmbed|warningEmbed|errorEmbed|notificationEmbed)\b/;
const SKIPPED_FILES = new Set([
  'embedManagerService.js',
  'embedDefinitionDiscoveryService.js',
  'systemEmbedCatalogService.js',
  'systemEmbedCaptureReady.js',
  'systemEmbedCatalogReady.js',
  'systemEmbedCatalogMessageUpdate.js',
]);

const STRING_LITERAL = String.raw`(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\`((?:\\.|[^\`\\])*)\`)`;
const TITLE_PATTERNS = [
  new RegExp(String.raw`\.setTitle\(\s*${STRING_LITERAL}\s*\)`, 'gs'),
  new RegExp(String.raw`\btitle\s*:\s*${STRING_LITERAL}`, 'gs'),
  new RegExp(String.raw`\btitleOverride\s*:\s*${STRING_LITERAL}`, 'gs'),
];
const DESCRIPTION_PATTERNS = [
  new RegExp(String.raw`\.setDescription\(\s*${STRING_LITERAL}\s*\)`, 'gs'),
  new RegExp(String.raw`\bdescription\s*:\s*${STRING_LITERAL}`, 'gs'),
];

function decodeLiteral(match, offset = 1, { allowDynamic = true } = {}) {
  const raw = match[offset] ?? match[offset + 1] ?? match[offset + 2];
  if (raw == null) return null;
  if (!allowDynamic && raw.includes('${')) return null;

  return raw
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
  const commandCategory = parts[0] === 'commands' ? String(parts[1] || '').toLowerCase() : '';

  if (commandCategory === 'economy') return `gambling/${file}`;
  if (commandCategory === 'music') return `music/${file}`;
  if (commandCategory === 'ticket') return `tickets/${file}`;
  if (commandCategory === 'giveaway') return `giveaway/${file}`;
  if (commandCategory === 'moderation' || commandCategory === 'logging') return `botlog/${file}`;
  if (commandCategory === 'community') {
    if (/appeal/.test(file)) return `ban-appeal/${file}`;
    if (/report/.test(file)) return `reports/${file}`;
    if (/shop|store|purchase|subscription/.test(file)) return `shop/${file}`;
    return `botlog/${file}`;
  }
  if (commandCategory === 'fun') return `botlog/${file}`;
  if (commandCategory === 'reaction_roles') return `botlog/${file}`;
  if (commandCategory) return `botlog/${file}`;

  if (/welcome/.test(file)) return `welcome/${file}`;
  if (/faq/.test(file)) return `faq/${file}`;
  if (/staff.*review/.test(file)) return `staff-reviews/${file}`;
  if (/appeal/.test(file)) return `ban-appeal/${file}`;
  if (/report/.test(file)) return `reports/${file}`;
  if (/music/.test(file)) return `music/${file}`;
  if (/ticket|transcript/.test(file)) return `tickets/${file}`;
  if (/gambl|economy|coin|flip|slots|blackjack|roulette|fight|dice|roll/.test(file)) return `gambling/${file}`;
  return `botlog/${file}`;
}

function inferColor(title) {
  const value = String(title || '').toLowerCase();
  if (/success|completed|created|saved|enabled|added|joined|won|winner/.test(value)) return 0x57F287;
  if (/warning|cooldown|wait|pending|slow|too fast/.test(value)) return 0xFEE75C;
  if (/error|wrong|invalid|failed|denied|missing|not enough|blocked|disabled|cannot|could not/.test(value)) return 0xED4245;
  return 0x5865F2;
}

function nearestDescription(source, index) {
  const window = source.slice(index, Math.min(source.length, index + 1800));
  let best = null;

  for (const pattern of DESCRIPTION_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(window);
    if (!match) continue;
    if (!best || match.index < best.index) best = { match, index: match.index };
  }

  return best ? decodeLiteral(best.match, 1, { allowDynamic: true }) : null;
}

function extractDefinitions(source, relativePath) {
  if (!EMBED_HINT.test(source)) return [];

  const context = inferContext(relativePath);
  const results = [];
  const seen = new Set();

  for (const pattern of TITLE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      const title = decodeLiteral(match, 1, { allowDynamic: false });
      if (!title || title.length > 256) continue;

      const description = nearestDescription(source, match.index);
      const identity = `${context}\n${title}\n${description || ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);

      results.push({
        title,
        description,
        color: inferColor(title),
        context,
        variantId: `${relativePath}:${match.index}`,
      });
    }
  }

  return results;
}

async function walk(dir, output = []) {
  let entries;
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
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js') || SKIPPED_FILES.has(entry.name)) continue;
    output.push(absolute);
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
      const identity = `${definition.context}|${definition.title}|${definition.description || ''}`;
      if (unique.has(identity)) continue;
      unique.add(identity);
      definitions.push(definition);
    }
  }

  return definitions;
}
