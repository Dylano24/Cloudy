
const GUILD = '1532882647838228723';
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');

const API = 'https://discord.com/api/v10';
const H = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const FEEDS = '1533208942375731361';
const UPDATES = '1533886695014142003';

const desired = [
  { id:'1555124201688670269', name:'💀│pvp', parent:FEEDS, position:0 },
  { id:'1555124202825191516', name:'⚡│player', parent:FEEDS, position:1 },
  { id:'1555124204008116274', name:'🫯│zorp', parent:FEEDS, position:2 },
  { id:'1555124205391970395', name:'🚨│raids', parent:FEEDS, position:3 },
  { id:'1555124206495207445', name:'⛔│ban', parent:FEEDS, position:4 },
  { id:'1554538636832415876', name:'🗒️│rust', parent:UPDATES, position:0 },
  { id:'1554538638027653260', name:'📰│nitrado', parent:UPDATES, position:1 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body) {
  for (let i=0;i<8;i++) {
    const res = await fetch(API + path, {
      method,
      headers: H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.ceil(Number(j.retry_after || 1)*1000)+150);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0,300)}`);
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  throw new Error('RATE_LIMIT');
}

const current = await api('GET', `/guilds/${GUILD}/channels`);
const byId = new Map(current.map(c => [c.id, c]));

for (const item of desired) {
  const ch = byId.get(item.id);
  if (!ch) throw new Error(`Missing channel ${item.id} ${item.name}`);
  if (ch.name !== item.name) throw new Error(`Unexpected channel name for ${item.id}: ${ch.name}`);
}

for (const item of desired) {
  const ch = byId.get(item.id);
  if (ch.parent_id !== item.parent) {
    await api('PATCH', `/channels/${item.id}`, {
      parent_id: item.parent,
      lock_permissions: false,
    });
    console.log(JSON.stringify({ action:'moved', id:item.id, name:item.name, from:ch.parent_id, to:item.parent }));
    await sleep(250);
  }
}

await api('PATCH', `/guilds/${GUILD}/channels`,
  desired.filter(x => x.parent === FEEDS).map(x => ({ id:x.id, position:x.position }))
);
await api('PATCH', `/guilds/${GUILD}/channels`,
  desired.filter(x => x.parent === UPDATES).map(x => ({ id:x.id, position:x.position }))
);

const after = await api('GET', `/guilds/${GUILD}/channels`);
const out = desired.map(item => {
  const ch = after.find(c => c.id === item.id);
  return { id:item.id, name:ch?.name, parent_id:ch?.parent_id, position:ch?.position };
});
console.error('FEEDS_UPDATES_FIXED ' + JSON.stringify(out));
await sleep(3000);
