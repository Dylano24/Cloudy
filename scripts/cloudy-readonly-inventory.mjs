import { pathToFileURL } from 'node:url';
import path from 'node:path';

const GUILD = '1532882647838228723';
const FROM = Date.parse('2026-09-18T04:00:00Z');
const TO = Date.parse('2026-09-18T04:15:00Z');
const output = (kind, data) => console.log(JSON.stringify({ inventory: 'cloudy-history-v2', guild: GUILD, kind, data }));
const sfTime = id => Number((BigInt(id) >> 22n) + 1420070400000n);

async function discordGet(route) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`https://discord.com/api/v10${route}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429) {
      const data = await response.json();
      await new Promise(r => setTimeout(r, Math.ceil(Number(data.retry_after || 1) * 1000) + 100));
      continue;
    }
    if (!response.ok) throw new Error(`DISCORD_HTTP_${response.status}`);
    return response.json();
  }
  throw new Error('RATE_LIMIT');
}

async function audit(actionType, maxPages = 20) {
  const rows = [];
  let before = null;
  for (let page = 0; page < maxPages; page++) {
    const d = await discordGet(`/guilds/${GUILD}/audit-logs?action_type=${actionType}&limit=100${before ? `&before=${before}` : ''}`);
    const e = d.audit_log_entries || [];
    rows.push(...e);
    if (e.length < 100) break;
    before = e.at(-1).id;
  }
  return rows;
}

if (!process.env.DISCORD_TOKEN) throw new Error('MISSING_BOT_CREDENTIAL');

const deletedAll = await audit(12);
const deleted = deletedAll.filter(e => {
  const t = sfTime(e.id);
  return t >= FROM && t <= TO;
});
const ids = new Set(deleted.map(e => e.target_id));
output('window', { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), deleted: ids.size });

for (const e of deleted.sort((a,b)=>sfTime(a.id)-sfTime(b.id))) {
  output('deleted_channel', {
    audit_id: e.id,
    deleted_at: new Date(sfTime(e.id)).toISOString(),
    old_id: e.target_id,
    changes: e.changes || [],
  });
}

for (const actionType of [10, 11]) {
  const entries = await audit(actionType);
  for (const e of entries) {
    if (!ids.has(e.target_id)) continue;
    output('history', {
      action_type: actionType,
      audit_id: e.id,
      at: new Date(sfTime(e.id)).toISOString(),
      target_id: e.target_id,
      changes: e.changes || [],
    });
  }
}

const channels = await discordGet(`/guilds/${GUILD}/channels`);
for (const c of channels) output('current_channel', {
  id: c.id, name: c.name, type: c.type, parent_id: c.parent_id, position: c.position,
  permission_overwrites: c.permission_overwrites || [],
});
output('complete', { deleted: ids.size, current_channels: channels.length });
