
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');
const API='https://discord.com/api/v10';
const headers={Authorization:`Bot ${token}`};
const channelId='1554538580695584938';
const messageId='1555268110460653629';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let attempt=0; attempt<8; attempt++){
  const res=await fetch(`${API}/channels/${channelId}/messages/${messageId}`,{method:'DELETE',headers});
  if(res.status===429){
    const j=await res.json().catch(()=>({}));
    await sleep(Math.ceil(Number(j.retry_after||1)*1000)+150);
    continue;
  }
  if(res.status===204){
    console.error('RULES_WRONG_MESSAGE_DELETED '+JSON.stringify({channelId,messageId}));
    await sleep(2000);
    process.exit(0);
  }
  if(res.status===404){
    console.error('RULES_WRONG_MESSAGE_ALREADY_GONE '+JSON.stringify({channelId,messageId}));
    await sleep(2000);
    process.exit(0);
  }
  throw new Error(`DELETE -> ${res.status}: ${(await res.text()).slice(0,300)}`);
}
throw new Error('RATE_LIMIT');
