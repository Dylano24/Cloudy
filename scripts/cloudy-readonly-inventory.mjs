const GUILD='1532882647838228723';
const out=(kind,data)=>console.log(JSON.stringify({inventory:'cloudy-parent-audit',kind,data}));
async function get(route){for(let i=0;i<5;i++){const r=await fetch('https://discord.com/api/v10'+route,{headers:{Authorization:`Bot ${process.env.DISCORD_TOKEN}`},signal:AbortSignal.timeout(15000)});if(r.status===429){const j=await r.json();await new Promise(res=>setTimeout(res,Math.ceil(Number(j.retry_after||1)*1000)+100));continue}if(!r.ok)throw new Error('HTTP_'+r.status);return r.json()}throw new Error('RATE_LIMIT')}
const ts=id=>new Date(Number((BigInt(id)>>22n)+1420070400000n)).toISOString();
async function audit(action){let before=null,all=[];for(let p=0;p<10;p++){const a=await get(`/guilds/${GUILD}/audit-logs?action_type=${action}&limit=100${before?`&before=${before}`:''}`);const es=a.audit_log_entries||[];all.push(...es);if(es.length<100)break;before=es.at(-1).id}return all}
async function main(){const dels=await audit(12);const names={};for(const e of dels){const t=ts(e.id);if(!t.startsWith('2026-09-18'))continue;for(const c of e.changes||[])if(c.key==='name')names[e.target_id]=c.old_value}
const ids=new Set(Object.keys(names));const ups=(await audit(11)).filter(e=>ids.has(e.target_id));
const moves=[];for(const e of ups){const rel=(e.changes||[]).filter(c=>['parent_id','position'].includes(c.key));if(rel.length)moves.push({id:e.target_id,name:names[e.target_id],time:ts(e.id),changes:rel})}
out('moves',moves);out('counts',{targets:ids.size,updates:ups.length,moves:moves.length})}
main().catch(e=>{out('failed',{code:e.message});process.exitCode=1});