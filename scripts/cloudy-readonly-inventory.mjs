const GUILD='1532882647838228723';
const out=(kind,data)=>console.log(JSON.stringify({inventory:'cloudy-sep18-recovery',kind,data}));
async function get(route){
 for(let i=0;i<5;i++){
  const r=await fetch('https://discord.com/api/v10'+route,{headers:{Authorization:`Bot ${process.env.DISCORD_TOKEN}`},signal:AbortSignal.timeout(15000)});
  if(r.status===429){const j=await r.json();await new Promise(res=>setTimeout(res,Math.ceil(Number(j.retry_after||1)*1000)+150));continue}
  if(!r.ok)throw new Error('HTTP_'+r.status); return r.json();
 } throw new Error('RATE_LIMIT');
}
const ts=id=>Number((BigInt(id)>>22n)+1420070400000n);
async function audit(action){
 let before=null,all=[];
 for(let p=0;p<10;p++){
  const a=await get(`/guilds/${GUILD}/audit-logs?action_type=${action}&limit=100${before?`&before=${before}`:''}`);
  const es=a.audit_log_entries||[]; all.push(...es);
  if(es.length<100)break; before=es.at(-1).id;
 }
 return all;
}
function vals(entry,side){
 const o={}; for(const c of entry.changes||[]) if(['name','type','parent_id','position','permission_overwrites','bitrate','user_limit','rate_limit_per_user','nsfw'].includes(c.key)) o[c.key]=c[side];
 return o;
}
async function main(){
 const dels=await audit(12);
 const targets=[];
 for(const e of dels){
  const t=new Date(ts(e.id)).toISOString();
  if(t.startsWith('2026-09-18')) targets.push({id:e.target_id,deleted_at:t,...vals(e,'old_value')});
 }
 const ids=new Set(targets.map(x=>x.id));
 const creates=(await audit(10)).filter(e=>ids.has(e.target_id));
 const updates=(await audit(11)).filter(e=>ids.has(e.target_id));
 const by=new Map(targets.map(x=>[x.id,{...x}]));
 const chronology=[...creates.map(e=>({e,kind:'create'})),...updates.map(e=>({e,kind:'update'}))].sort((a,b)=>ts(a.e.id)-ts(b.e.id));
 for(const {e,kind} of chronology){
  const o=by.get(e.target_id); if(!o)continue;
  Object.assign(o, vals(e,'new_value'));
  (o.audit??=[]).push({kind,time:new Date(ts(e.id)).toISOString(),changes:e.changes});
 }
 // deletion old_value is authoritative for final visible fields; preserve parent/position learned above
 for(const d of targets){const o=by.get(d.id); for(const k of ['name','type','permission_overwrites','bitrate','user_limit','rate_limit_per_user','nsfw']) if(d[k]!==undefined)o[k]=d[k];}
 const arr=[...by.values()].sort((a,b)=>(a.position??999)-(b.position??999)||a.deleted_at.localeCompare(b.deleted_at));
 out('recovery',arr.map(({audit,...x})=>x));
 out('audit_counts',{deleted:targets.length,creates:creates.length,updates:updates.length});
}
main().catch(e=>{out('failed',{code:e.message});process.exitCode=1});