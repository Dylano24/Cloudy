
const guildId = String(process.env.GUILD_ID || '1532882647838228723');
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('NO_TOKEN');
const API = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(API + path, { headers });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.ceil(Number(j.retry_after || 1) * 1000) + 100);
      continue;
    }
    if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0,200)}`);
    return res.json();
  }
  throw new Error('RATE_LIMIT');
}

const channels = await get(`/guilds/${guildId}/channels`);
const cats = channels.filter(c => c.type === 4).sort((a,b) => a.position - b.position);
const catById = new Map(cats.map(c => [c.id, c]));
const rows = cats.map(cat => ({
  id: cat.id,
  name: cat.name,
  position: cat.position,
  children: channels
    .filter(c => c.parent_id === cat.id)
    .sort((a,b) => a.position - b.position)
    .map(c => ({ id:c.id, name:c.name, type:c.type, position:c.position, parent_id:c.parent_id })),
}));
const orphaned = channels.filter(c => c.type !== 4 && !c.parent_id).map(c => ({id:c.id,name:c.name,type:c.type,position:c.position}));
const brokenParents = channels.filter(c => c.type !== 4 && c.parent_id && !catById.has(c.parent_id)).map(c => ({id:c.id,name:c.name,parent_id:c.parent_id}));
console.error('CATEGORY_LIVE_AUDIT ' + JSON.stringify({
  categoryCount: cats.length,
  channelCount: channels.length,
  categories: rows,
  orphaned,
  brokenParents
}));
await sleep(3000);
