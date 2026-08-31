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

  if (category === 'economy') return `gambling/${file}`;
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

function findTitleOnLine(lines, index) {
  const line = lines[index];
  let marker = null;
  if (line.includes('.setTitle(')) marker = '.setTitle(';
  else if (/\btitleOverride\s*:/.test(line)) marker = 'titleOverride:';
  else if (/\btitle\s*:/.test(line)) marker = 'title:';
  if (!marker) return null;

  const combined = lines.slice(index, Math.min(lines.length, index + 8)).join('\n');
  const raw = literalFromText(combined.slice(combined.indexOf(marker) + marker.length));
  return decodeString(raw, { allowDynamic: false });
}

function extractDefinitions(source, relativePath) {
  if (!EMBED_HINT.test(source)) return [];

  const context = inferContext(relativePath);
  const lines = source.split(/\r?\n/);
  const results = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const title = findTitleOnLine(lines, index);
    if (!title || title.length > 256) continue;

    const description = findDescription(lines, index);
    const identity = `${context}\n${title}\n${description || ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    results.push({
      title,
      description,
      color: inferColor(title),
      context,
      variantId: `${relativePath}:${index + 1}`,
    });
  }

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
      const identity = `${definition.context}|${definition.title}|${definition.description || ''}`;
      if (unique.has(identity)) continue;
      unique.add(identity);
      definitions.push(definition);
    }
  }

  return definitions;
}
