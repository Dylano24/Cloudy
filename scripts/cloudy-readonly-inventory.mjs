// Run from the Cloudy application directory. No application bootstrap or migrations.
// Only Discord GET requests and a PostgreSQL READ ONLY transaction are used.
// Re-run marker: 2026-10-01 historical Sep 17/18 recovery audit.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const GUILD = '1532882647838228723';
const output = (kind, data) => console.log(JSON.stringify({ inventory: 'cloudy-v1', guild: GUILD, kind, data }));
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);

// Do not log complete config values, embed bodies, ticket content or credentials.
export function references(value, prefix = '', result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|credential|webhook|api.?key/i.test(key)) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if (/channel|category|role|message|trigger/i.test(field) && snowflake(item)) {
      result.push({ field, id: item });
    } else if (item && typeof item === 'object') references(item, field, result);
  }
  return result;
}

async function discordGet(route) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://discord.com/api/v10${route}`, {
      method: 'GET',
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (response.status === 429) {
      const data = await response.json();
      const seconds = Number(data.retry_after);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 15) throw new Error('RATE_LIMIT');
      await new Promise(resolve => setTimeout(resolve, Math.ceil(seconds * 1000) + 100));
      continue;
    }
    if (!response.ok) throw new Error(`DISCORD_HTTP_${response.status}`);
    return response.json();
  }
  throw new Error('RATE_LIMIT');
}

export async function main() {
  if (!process.env.DISCORD_TOKEN) throw new Error('MISSING_BOT_CREDENTIAL');
  const guild = await discordGet(`/guilds/${GUILD}`);
  if (guild.id !== GUILD) throw new Error('GUILD_MISMATCH');
  output('guild', { id: guild.id, name: guild.name });
  const channels = await discordGet(`/guilds/${GUILD}/channels`);
  for (const c of channels) output('channel', {
    id: c.id, name: c.name, type: c.type, parent_id: c.parent_id,
    position: c.position, permission_overwrites: c.permission_overwrites,
    nsfw: c.nsfw, rate_limit_per_user: c.rate_limit_per_user,
    bitrate: c.bitrate, user_limit: c.user_limit,
  });
  const roles = await discordGet(`/guilds/${GUILD}/roles`);
  for (const r of roles) output('role', { id: r.id, name: r.name, position: r.position, permissions: r.permissions, managed: r.managed });
  const bot = await discordGet('/users/@me');
  const member = await discordGet(`/guilds/${GUILD}/members/${bot.id}`);
  output('bot', { id: bot.id, roles: member.roles });
  // Historical channel deletions only; no actor/reason/user records are emitted.
  let before;
  for (let page = 0; page < 10; page++) {
    let audit;
    try {
      audit = await discordGet(`/guilds/${GUILD}/audit-logs?action_type=12&limit=100${before ? `&before=${before}` : ''}`);
    } catch (error) {
      output('audit_unavailable', { code: /^DISCORD_HTTP_\d+$/.test(error.message) ? error.message : 'READ_FAILED' });
      break;
    }
    const entries = audit.audit_log_entries || [];
    for (const entry of entries) output('deleted_channel', {
      audit_id: entry.id, old_id: entry.target_id,
      changes: (entry.changes || []).filter(c => ['name', 'type', 'position', 'parent_id', 'permission_overwrites', 'bitrate', 'user_limit', 'nsfw', 'rate_limit_per_user'].includes(c.key)),
    });
    if (entries.length < 100) break;
    before = entries.at(-1).id;
    if (page === 9) output('audit_truncated', { pages: 10 });
  }
  const require = createRequire(path.resolve('package.json'));
  const { Client } = require('pg');
  const { resolvePostgresPoolConfig } = await import(pathToFileURL(path.resolve('src/config/database/postgres.js')));
  const client = new Client({ ...resolvePostgresPoolConfig(), application_name: 'cloudy-readonly-inventory', statement_timeout: 10000, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const [kind, query] of [
      ['guild_config', 'SELECT config FROM guilds WHERE id = $1'],
      ['welcome_config', 'SELECT config FROM welcome_configs WHERE guild_id = $1'],
    ]) {
      const rows = (await client.query(query, [GUILD])).rows;
      output(kind, { records: rows.length });
      for (const reference of rows.flatMap(r => references(r.config))) output('config_reference', { source: kind, ...reference });
    }
    const keys = [`guild:${GUILD}:jointocreate`, `guild:${GUILD}:jointocreate:channels`, `cloudy:embed-registry:${GUILD}`];
    for (const table of ['temp_data', 'cache_data']) {
      const rows = (await client.query(`SELECT key, value, expires_at FROM ${table} WHERE key = ANY($1::text[])`, [keys])).rows;
      for (const row of rows) {
        output('stored_mapping', { table, key: row.key, expires_at: row.expires_at });
        const refs = references(row.value);
        for (let offset = 0; offset < refs.length; offset += 10) output('stored_references', { table, key: row.key, offset, references: refs.slice(offset, offset + 10) });
      }
    }
    await client.query('ROLLBACK');
    output('complete', { channels: channels.length, roles: roles.length });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    // Raw driver errors can contain credentials or private connection details.
    output('failed', { code: 'INVENTORY_INCOMPLETE' });
    process.exitCode = 1;
  });
}
