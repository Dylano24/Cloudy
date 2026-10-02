
const guildId='1532882647838228723';
const oldRules='1533189582064062564';
const token=String(process.env.DISCORD_TOKEN||'').trim();
if(!token) throw new Error('NO_TOKEN');
const API='https://discord.com/api/v10';
const headers={Authorization:`Bot ${token}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){
  for(let i=0;i<8;i++){
    const res=await fetch(API+path,{headers});
    if(res.status===429){
      const j=await res.json().catch(()=>({}));
      await sleep(Math.ceil(Number(j.retry_after||1)*1000)+150);
      continue;
    }
    if(!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0,500)}`);
    return res.json();
  }
  throw new Error('RATE_LIMIT');
}
const DISCORD_EPOCH=1420070400000n;
function snowflakeFromMs(ms){return String((BigInt(ms)-DISCORD_EPOCH)<<22n);}
const start=Date.parse('2026-09-17T00:00:00Z');
const end=Date.parse('2026-09-19T23:59:59Z');
const before=snowflakeFromMs(end);
let cursor=before;
let all=[];
for(let page=0;page<8;page++){
  const q=new URLSearchParams({limit:'100',before:cursor});
  const data=await get(`/guilds/${guildId}/audit-logs?${q}`);
  const entries=data.audit_log_entries||[];
  if(!entries.length) break;
  all.push(...entries);
  const oldest=entries.at(-1)?.id;
  if(!oldest) break;
  cursor=oldest;
  const ts=Number((BigInt(oldest)>>22n)+DISCORD_EPOCH);
  if(ts<start) break;
  await sleep(250);
}
const inWindow=all.filter(e=>{
  const ts=Number((BigInt(e.id)>>22n)+DISCORD_EPOCH);
  return ts>=start&&ts<=end;
});
const relevant=inWindow.filter(e=>{
  const s=JSON.stringify(e);
  return s.includes(oldRules)
    || [10,11,12,13,14,15,72,73].includes(Number(e.action_type))
    || /rule/i.test(s);
});
const slim=relevant.map(e=>({
  id:e.id,
  at:new Date(Number((BigInt(e.id)>>22n)+DISCORD_EPOCH)).toISOString(),
  action_type:e.action_type,
  user_id:e.user_id,
  target_id:e.target_id,
  options:e.options||null,
  changes:e.changes||null,
  reason:e.reason||null
}));
console.error('RULES_DISCORD_AUDIT '+JSON.stringify(slim));
await sleep(3000);
