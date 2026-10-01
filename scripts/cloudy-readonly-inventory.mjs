import { pathToFileURL } from 'node:url';
import path from 'node:path';

const GUILD = '1532882647838228723';
const out = (kind, data) => console.log(JSON.stringify({inventory:'cloudy-repair-audit',kind,data}));

async function get(route) {
  for (let i=0;i<5;i++) {
    const r = await fetch('https://discord.com/api/v10'+route,{headers:{Authorization:`Bot ${process.env.DISCORD_TOKEN}`},signal:AbortSignal.timeout(15000)});
    if (r.status===429) {
      const j=await r.json(); await new Promise(res=>setTimeout(res, Math.ceil(Number(j.retry_after||1)*1000)+150)); continue;
    }
    if (!r.ok) throw new Error('HTTP_'+r.status);
    return r.json();
  }
  throw new Error('RATE_LIMIT');
}

async function main(){
  const current = await get(`/guilds/${GUILD}/channels`);
  out('current_channels', current.map(c=>({id:c.id,name:c.name,type:c.type,parent_id:c.parent_id,position:c.position,permission_overwrites:c.permission_overwrites,bitrate:c.bitrate,user_limit:c.user_limit,rate_limit_per_user:c.rate_limit_per_user,nsfw:c.nsfw})));

  let before=null; const deleted=[];
  for(let page=0;page<10;page++){
    const q=`/guilds/${GUILD}/audit-logs?action_type=12&limit=100${before?`&before=${before}`:''}`;
    const a=await get(q); const es=a.audit_log_entries||[];
    for(const e of es){
      const vals={};
      for(const c of (e.changes||[])) if(['name','type','parent_id','position','permission_overwrites','bitrate','user_limit','rate_limit_per_user','nsfw'].includes(c.key)) vals[c.key]=c.old_value;
      deleted.push({audit_id:e.id,old_id:e.target_id,...vals});
    }
    if(es.length<100) break; before=es.at(-1).id;
  }
  out('deleted_summary',deleted);
}
main().catch(e=>{out('failed',{code:e.message});process.exitCode=1});