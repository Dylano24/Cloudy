
const GUILD='1532882647838228723';
const OLD_RULES='1533189582064062564';
const RULES_EMOJI='1324217883047362590';
const token=String(process.env.DISCORD_TOKEN||'').trim();
if(!token) throw new Error('NO_TOKEN');
const API='https://discord.com/api/v10';
const H={Authorization:`Bot ${token}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function api(path){
  for(let i=0;i<10;i++){
    const res=await fetch(API+path,{headers:H});
    if(res.status===429){
      const j=await res.json().catch(()=>({}));
      await sleep(Math.ceil(Number(j.retry_after||1)*1000)+150);
      continue;
    }
    if(!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0,400)}`);
    return res.json();
  }
  throw new Error('RATE_LIMIT '+path);
}
function containsRules(obj){
  const s=JSON.stringify(obj||{}).toLowerCase();
  return s.includes('rules')
    || s.includes('server rule')
    || s.includes(OLD_RULES)
    || s.includes(RULES_EMOJI);
}
function summarizeMessage(m){
  return {
    channel_id:m.channel_id,
    id:m.id,
    timestamp:m.timestamp,
    author:{id:m.author?.id,username:m.author?.username,bot:m.author?.bot},
    content:String(m.content||'').slice(0,4000),
    embeds:(m.embeds||[]).map(e=>({
      title:e.title||null,
      description:e.description||null,
      fields:e.fields||[],
      footer:e.footer||null,
      author:e.author||null,
      color:e.color??null,
      thumbnail:e.thumbnail||null,
      image:e.image||null,
    })),
    components:m.components||[],
  };
}

const channels=await api(`/guilds/${GUILD}/channels`);
const textLike=channels.filter(c=>[0,5,15,16].includes(c.type));

const audit=await api(`/guilds/${GUILD}/audit-logs?limit=100&action_type=12`).catch(()=>({audit_log_entries:[]}));
const auditMatches=(audit.audit_log_entries||[]).filter(e=>{
  const s=JSON.stringify(e).toLowerCase();
  return s.includes(OLD_RULES) || s.includes('rules');
});

const found=[];
const pinned=[];
for(const ch of textLike){
  if(ch.type===0 || ch.type===5){
    let before=null;
    for(let page=0;page<5;page++){
      const q=new URLSearchParams({limit:'100'});
      if(before) q.set('before',before);
      const msgs=await api(`/channels/${ch.id}/messages?${q}`).catch(()=>[]);
      if(!Array.isArray(msgs)||!msgs.length) break;
      for(const m of msgs){
        if(containsRules(m)) found.push({...summarizeMessage(m),channel_name:ch.name});
      }
      before=msgs.at(-1)?.id||null;
      if(msgs.length<100) break;
    }
    const pins=await api(`/channels/${ch.id}/pins`).catch(()=>[]);
    for(const m of pins||[]){
      if(containsRules(m)) pinned.push({...summarizeMessage(m),channel_name:ch.name});
    }
  }
}

console.error('DISCORD_RULES_AUDIT '+JSON.stringify({
  auditMatches,
  found,
  pinned,
  scannedChannels:textLike.map(c=>({id:c.id,name:c.name,type:c.type})),
}));
await sleep(5000);
