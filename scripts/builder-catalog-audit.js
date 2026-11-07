// Read-only data export. Deliberately never imports the application's DB initializer.
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { builderCatalogMetadata, classifyBuilderRecord } from '../src/services/builderCatalogPolicy.js';
import retiredCatalogFingerprints from '../src/config/retiredBuilderCatalogFingerprints.json' with { type: 'json' };

const quoteIdentifier = value => '"' + String(value).replaceAll('"', '""') + '"';

export async function readAuditSnapshot(client) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const inventory = await client.query(`SELECT schemaname, tablename FROM pg_catalog.pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND schemaname NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY schemaname, tablename`);
    const tables = [];
    for (const { schemaname, tablename } of inventory.rows) {
      const result = await client.query(`SELECT * FROM ${quoteIdentifier(schemaname)}.${quoteIdentifier(tablename)}`);
      tables.push({ schema: schemaname, name: tablename, rows: result.rows });
    }
    await client.query('COMMIT');
    return { formatVersion: 1, createdAt: new Date().toISOString(), complete: true,
      schemaIncluded: false, tables };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

// Pure dry-run: no connection, schema initialization, Discord calls or writes.
// An archive decision changes only Builder admission; it never authorizes data
// deletion. Unknown legacy ownership and incomplete evidence remain review.
export function analyzeAuditSnapshot(snapshot) {
  if (snapshot?.complete !== true || !Array.isArray(snapshot.tables)) throw new Error('Cannot analyze an incomplete audit');
  const values = new Map();
  const warnings = [];
  for (const table of snapshot.tables) {
    for (const row of table.rows || []) {
      if (typeof row?.key !== 'string' || !row.key.startsWith('cloudy:')) continue;
      let value = row.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); }
        catch { warnings.push('Unparsed value: ' + row.key); continue; }
      }
      if (values.has(row.key) && JSON.stringify(values.get(row.key)) !== JSON.stringify(value)) {
        throw new Error('Conflicting audit values require review');
      }
      values.set(row.key, value);
    }
  }
  const records = [];
  const counts = {show: 0, archive: 0, review: 0};
  for (const [key, rows] of values) {
    if (!key.startsWith('cloudy:embed-registry:')) continue;
    const guildId = key.slice('cloudy:embed-registry:'.length);
    if (!Array.isArray(rows)) { warnings.push('Invalid registry: ' + key); continue; }
    const usage = values.get('cloudy:embed-builder-used-catalog:' + guildId);
    const used = new Set(Array.isArray(usage) ? usage : []);
    const templateEntries = [...values].filter(([scope]) => scope.startsWith('cloudy:embed-template:' + guildId + ':'))
      .flatMap(([, value]) => value && typeof value === 'object' ? Object.entries(value) : []);
    for (const row of rows) {
      const record = {...row, guildId};
      const metadata = builderCatalogMetadata(record);
      const frozen = retiredCatalogFingerprints[[metadata.kind, metadata.context, metadata.key].join('|')];
      const normalizeAlias = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const aliases = new Set([metadata.key, normalizeAlias(record.snapshot?.title), normalizeAlias(record.title)].filter(Boolean));
      const overlays = templateEntries.filter(([, template]) => template?.canonicalIdentity === metadata.key);
      const ambiguousOverlay = templateEntries.some(([alias, template]) => !template?.canonicalIdentity
        && (aliases.has(normalizeAlias(alias)) || aliases.has(normalizeAlias(template?.title))));
      const result = classifyBuilderRecord(record, {metadata, sourcePath: frozen?.sourcePath,
        baselineFingerprints: ambiguousOverlay ? undefined : frozen?.fingerprints,
        ownerModified: Boolean(metadata.key && overlays.length),
        everUsed: used.has(metadata.key), usageState: Array.isArray(usage) ? 'ready' : 'unknown'});
      counts[result.decision]++;
      records.push({...result, guildId, channelId: record.channelId, backingChannelId: record.backingChannelId,
        messageId: record.messageId, embedIndex: record.embedIndex || 0, key: metadata.key, context: metadata.context});
    }
  }
  return {formatVersion: 1, canMutate: false, complete: warnings.length === 0, counts, records, warnings};
}

async function copyMedia(source, destination, relative = '', files = []) {
  const entries = await readdir(path.join(source, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Audit media contains a symlink; export requires review');
    if (entry.isDirectory()) {
      await mkdir(path.join(destination, name), { recursive: true, mode: 0o700 });
      await copyMedia(source, destination, name, files);
    } else if (entry.isFile()) {
      const bytes = await readFile(path.join(source, name));
      await writeFile(path.join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
      files.push({ path: name.split(path.sep).join('/'), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error('Unsupported media entry; export requires review');
  }
  return files;
}

export async function writeAuditExport(snapshot, filename, { mediaDir = null } = {}) {
  if (snapshot?.complete !== true || !Array.isArray(snapshot.tables)) throw new Error('Cannot save an incomplete audit');
  const target = path.resolve(filename);
  const directory = path.dirname(target);
  const source = mediaDir ? path.resolve(mediaDir) : null;
  if (source && (directory === source || directory.startsWith(source + path.sep))) {
    throw new Error('Audit destination must be outside the media source');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Exclusive creation also protects a previous successful backup from retries.
  const handle = await open(target, 'wx', 0o600);
  try {
    let media = { included: false, files: [] };
    if (source) {
      const destination = path.join(directory, 'media');
      await mkdir(destination, { mode: 0o700 });
      media = { included: true, files: await copyMedia(source, destination) };
    }
    await handle.writeFile(JSON.stringify({ ...snapshot, media }, null, 2) + '\n');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(target, { force: true });
    throw error;
  }
  await handle.close();
  return target;
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
  };
  const out = option('--out');
  if (!out) throw new Error('Use --out /private/new-directory/snapshot.json');
  const input = option('--input');
  let snapshot;
  if (input) snapshot = JSON.parse(await readFile(path.resolve(input), 'utf8'));
  else {
    const databaseUrl = process.env.POSTGRES_URL;
    if (!databaseUrl) throw new Error('POSTGRES_URL is required; no memory fallback is allowed');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: databaseUrl,
      options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      snapshot = await readAuditSnapshot(client);
    } finally { await client.end(); }
  }
  const analysis = analyzeAuditSnapshot(snapshot);
  const saved = await writeAuditExport({...snapshot, analysis}, out, {
    mediaDir: option('--media-dir') || process.env.CLOUDY_EMBED_MEDIA_DIR || null,
  });
  console.log(JSON.stringify({ file: saved, complete: true, tables: snapshot.tables.length, decisions: analysis.counts,
    schemaIncluded: false, note: 'Data export only; keep a verified pg_dump schema/data backup before any production migration.' }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Connection errors can contain credentials; never print raw connection/error objects.
    console.error('Read-only catalog audit failed:', error.code || 'AUDIT_FAILED');
    process.exitCode = 1;
  });
}
