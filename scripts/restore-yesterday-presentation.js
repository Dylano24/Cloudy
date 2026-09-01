import { initializeDatabase, db } from '../src/utils/database.js';

const CUTOFF = Date.parse('2026-08-31T22:00:00.000Z'); // 1 Sep 00:00 Europe/Amsterdam
const BACKUP_PREFIX = 'cloudy:recovery-backup:2026-09-01-before-yesterday-restore:';

function templateWasChangedToday(template) {
  const raw = template?.updatedAt;
  if (!raw) return false;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && timestamp >= CUTOFF;
}

async function backupKey(key, value) {
  await db.set(`${BACKUP_PREFIX}${key}`, value);
}

await initializeDatabase();

const templateKeys = await db.list('cloudy:embed-template:');
let removedEntries = 0;
let retainedEntries = 0;
let changedKeys = 0;
const guildIds = new Set();

for (const key of templateKeys) {
  const value = await db.get(key, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

  const guildMatch = String(key).match(/^cloudy:embed-template:([^:]+):/);
  if (guildMatch?.[1]) guildIds.add(guildMatch[1]);

  await backupKey(key, value);

  const next = {};
  let removedFromKey = 0;
  for (const [alias, template] of Object.entries(value)) {
    if (templateWasChangedToday(template)) {
      removedEntries += 1;
      removedFromKey += 1;
      continue;
    }
    next[alias] = template;
    retainedEntries += 1;
  }

  if (!removedFromKey) continue;
  changedKeys += 1;

  if (Object.keys(next).length) await db.set(key, next);
  else if (await db.exists(key)) await db.delete(key);

  console.log(`[YESTERDAY_RESTORE] ${key}: removed=${removedFromKey}, kept=${Object.keys(next).length}`);
}

if (process.env.GUILD_ID) guildIds.add(String(process.env.GUILD_ID));

for (const guildId of guildIds) {
  for (const key of [
    `cloudy:system-embed-catalog:${guildId}`,
    `cloudy:embed-registry:${guildId}`,
  ]) {
    if (!await db.exists(key)) continue;
    const value = await db.get(key, null);
    await backupKey(key, value);
    await db.delete(key);
    console.log(`[YESTERDAY_RESTORE] Cleared rebuildable state ${key}`);
  }
}

console.log(`[YESTERDAY_RESTORE] complete changedKeys=${changedKeys} removedEntries=${removedEntries} retainedEntries=${retainedEntries} guilds=${[...guildIds].join(',')}`);
process.exit(0);
