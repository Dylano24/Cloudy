
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
    if(res.status===429){const j=await res.json().catch(()=>({}));await sleep(Math.ceil(Number(j.retry_after||1)*1000)+150);continue;}
    const text=await res.text();
    if(!res.ok) return {status:res.status,text};
    return {status:res.status,json:text?JSON.parse(text):null};
  }
  return {status:429,text:'rate limit'};
}
const deletedChannelFetch=await get(`/channels/${oldRules}/messages?limit=100`);
const audit=await get(`/guilds/${guildId}/audit-logs?action_type=72&limit=100`);
const msgDeletes=(audit.json?.audit_log_entries||[]).filter(e=>String(e.options?.channel_id||'')===oldRules);
console.error('RULES_CHANNEL_FETCH_STATUS '+JSON.stringify({status:deletedChannelFetch.status,body:deletedChannelFetch.text||null}));
console.error('RULES_MESSAGE_DELETE_AUDIT '+JSON.stringify(msgDeletes.map(e=>({id:e.id,user_id:e.user_id,target_id:e.target_id,options:e.options,reason:e.reason||null}))));
await sleep(2000);
