// Read-only Embed Builder registry audit + backup.
//
// Usage (Railway shell or local with production env):
//   node scripts/embed-registry-audit.js [--guild <id>] [--title pop] [--out ./backups] [--verify-discord]
//
// 1. Writes a JSON backup of every Embed Builder storage document for the
//    guild (registry, delete tombstones, Reappear rules, shared templates).
// 2. Prints which registry rows share a title, which rows are detached
//    (saved template whose message is gone), which Builder posts were stored
//    under an "automatic" source, and which Reappear rule owns which message.
// 3. With --verify-discord it GETs each listed message from Discord (read-only)
//    to show whether it physically exists and what it currently shows.
//
// It never writes to PostgreSQL, Redis or Discord. It never deletes anything.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MARKER = '​';
const OBSERVED_SOURCES = new Set(['automatic', 'automatic-update', 'history', 'bot-history', 'reconciled']);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) { args[key] = inline; continue; }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    index += 1;
  }
  return args;
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMarked(record) {
  const text = String(record?.snapshot?.footer?.text || '');
  return text.length > MARKER.length && text.endsWith(MARKER);
}

function physicalKey(record) {
  return [record.backingChannelId || record.channelId, record.messageId, Number(record.embedIndex || 0)].join(':');
}

function describe(record) {
  return {
    channelId: String(record.channelId || ''),
    backingChannelId: record.backingChannelId ? String(record.backingChannelId) : null,
    messageId: String(record.messageId || ''),
    embedIndex: Number(record.embedIndex || 0),
    title: record.snapshot?.title || record.title || record.name || '',
    source: record.source || '',
    manualSaved: record.manualSaved,
    explicitSave: record.explicitSave,
    detached: Boolean(record.detached),
    builderMarked: isMarked(record),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  };
}

async function discordMessage(token, channelId, messageId) {
  if (!token || !/^\d{17,20}$/.test(String(messageId))) return { status: 'not-checked' };
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    headers: { Authorization: 'Bot ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  }).catch(error => ({ ok: false, status: 0, error }));
  if (response.status === 404) return { status: 'missing' };
  if (!response.ok) return { status: 'unknown', httpStatus: response.status || null };
  const data = await response.json();
  return {
    status: 'exists',
    titles: (data.embeds || []).map(embed => embed.title || ''),
    authorId: data.author?.id || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guildId = String(args.guild || process.env.GUILD_ID || '').trim();
  if (!/^\d{17,20}$/.test(guildId)) {
    console.error('Provide --guild <id> or GUILD_ID.');
    process.exit(2);
  }
  const titleFilter = args.title ? normalizeTitle(args.title) : '';
  const outDir = path.resolve(String(args.out || process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups')));

  const { initializeDatabase, db } = await import('../src/utils/database/wrapper.js');
  await initializeDatabase();
  // db.get reads PostgreSQL directly (no Redis read-through/write-back).
  const read = (key, fallback) => db.get(key, fallback, { strict: true });

  const registryKey = 'cloudy:embed-registry:' + guildId;
  const registry = await read(registryKey, []);
  const records = Array.isArray(registry) ? registry : [];
  const tombstones = await read('cloudy:embed-registry-deleted:' + guildId, []);
  const globalTemplates = await read(`cloudy:embed-template:${guildId}:__global__`, {});
  const channelIds = [...new Set(records.flatMap(record => [record.channelId, record.backingChannelId]).filter(Boolean).map(String))];

  const reappear = {};
  for (const channelId of channelIds) {
    const index = await read(`cloudy:embed-reappear-index:${guildId}:${channelId}`, []);
    if (!Array.isArray(index) || !index.length) continue;
    reappear[channelId] = [];
    for (const originId of index) {
      const rule = await read(`cloudy:embed-reappear:${guildId}:${channelId}:${originId}`, null);
      const disabled = await read(`cloudy:embed-reappear-disabled:${guildId}:${channelId}:${originId}:${Number(rule?.embedIndex || 0)}`, null);
      reappear[channelId].push({ originId: String(originId), rule, disabled });
    }
  }

  // 1. Backup first, before any analysis.
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(outDir, `embed-registry-${guildId}-${stamp}.json`);
  await writeFile(backupFile, JSON.stringify({
    createdAt: new Date().toISOString(), guildId,
    documents: {
      [registryKey]: registry,
      ['cloudy:embed-registry-deleted:' + guildId]: tombstones,
      [`cloudy:embed-template:${guildId}:__global__`]: globalTemplates,
    },
    reappear,
  }, null, 2));

  // 2. Analysis.
  const byPhysical = new Map();
  for (const record of records) {
    const key = physicalKey(record);
    byPhysical.set(key, [...(byPhysical.get(key) || []), record]);
  }
  const duplicatePhysical = [...byPhysical.entries()].filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, rows: items.map(describe) }));

  const byTitle = new Map();
  for (const record of records) {
    const title = normalizeTitle(record.snapshot?.title || record.title || record.name);
    if (!title || (titleFilter && !title.includes(titleFilter))) continue;
    byTitle.set(title, [...(byTitle.get(title) || []), record]);
  }

  const tombstoneSet = new Set((Array.isArray(tombstones) ? tombstones : []).map(String));
  const reappearOwners = new Map();
  for (const [channelId, rules] of Object.entries(reappear)) {
    for (const { originId, rule, disabled } of rules) {
      for (const id of [originId, rule?.messageId, ...(rule?.previousMessageIds || [])].filter(Boolean)) {
        reappearOwners.set(`${channelId}:${id}`, { originId, activeMessageId: rule?.messageId || null, every: rule?.every || null, disabled: Boolean(disabled), ruleTitle: rule?.embed?.title || '' });
      }
    }
  }

  const token = args['verify-discord'] ? String(process.env.DISCORD_TOKEN || '').trim() : '';
  const titleGroups = [];
  for (const [title, items] of [...byTitle.entries()].sort()) {
    const rows = [];
    for (const record of items) {
      const row = describe(record);
      row.reappear = reappearOwners.get(`${row.backingChannelId || row.channelId}:${row.messageId}`) || null;
      row.permanentlyDeleted = tombstoneSet.has(`${row.backingChannelId || row.channelId}:${row.messageId}`);
      if (token && !row.detached) {
        row.discord = await discordMessage(token, row.backingChannelId || row.channelId, row.messageId);
        await new Promise(resolve => { setTimeout(resolve, 120); });
      }
      rows.push(row);
    }
    titleGroups.push({ title, count: rows.length, rows });
  }

  const sourceCounts = records.reduce((counts, record) => {
    const key = String(record.source || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const misclassifiedBuilderPosts = records
    .filter(record => isMarked(record) && OBSERVED_SOURCES.has(String(record.source || '')))
    .map(describe);
  const builderTitles = new Set(records
    .filter(record => record.source === 'embed-builder' || isMarked(record))
    .map(record => normalizeTitle(record.snapshot?.title || record.title)));
  const templatesOnBuilderTitles = Object.entries(globalTemplates && typeof globalTemplates === 'object' ? globalTemplates : {})
    .filter(([alias]) => builderTitles.has(normalizeTitle(alias)))
    .map(([alias, template]) => ({ alias, title: template?.title || '', color: template?.color ?? null, updatedAt: template?.updatedAt || null }));

  const report = {
    guildId,
    backupFile,
    totals: {
      records: records.length,
      detached: records.filter(record => record.detached).length,
      bySource: sourceCounts,
      permanentDeleteTombstones: tombstoneSet.size,
      reappearRules: Object.values(reappear).reduce((total, rules) => total + rules.length, 0),
    },
    duplicatePhysicalIdentities: duplicatePhysical,
    builderPostsStoredAsAutomatic: misclassifiedBuilderPosts,
    sharedTemplatesUsingBuilderTitles: templatesOnBuilderTitles,
    titleGroups: titleFilter ? titleGroups : titleGroups.filter(group => group.count > 1),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Backup written: ${backupFile}`);
    console.log(`Registry rows: ${report.totals.records} (detached: ${report.totals.detached})`);
    console.log('Rows by source:', report.totals.bySource);
    console.log(`Permanent Delete tombstones: ${report.totals.permanentDeleteTombstones}`);
    console.log(`Reappear rules: ${report.totals.reappearRules}`);
    console.log(`Duplicate physical identities: ${duplicatePhysical.length}`);
    console.log(`Builder posts stored under an automatic source: ${misclassifiedBuilderPosts.length}`);
    console.log(`Shared templates whose alias equals a Builder title: ${templatesOnBuilderTitles.length}`);
    for (const group of report.titleGroups) {
      console.log(`\nTitle "${group.title}" -> ${group.count} row(s)`);
      for (const row of group.rows) {
        const physicalState = row.discord ? ` discord=${row.discord.status}${row.discord.titles ? ' ' + JSON.stringify(row.discord.titles) : ''}` : '';
        const reappearState = row.reappear ? ` reappear(origin=${row.reappear.originId}, active=${row.reappear.activeMessageId}, every=${row.reappear.every}, disabled=${row.reappear.disabled})` : '';
        console.log(`  #${row.channelId} message=${row.messageId}:${row.embedIndex} title="${row.title}" source=${row.source} manualSaved=${row.manualSaved} explicitSave=${row.explicitSave} detached=${row.detached}${physicalState}${reappearState}`);
      }
    }
  }
  process.exit(0);
}

main().catch(error => {
  console.error('Embed registry audit failed:', error?.message || error);
  process.exit(1);
});
