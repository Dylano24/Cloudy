
const guildId = String(process.env.GUILD_ID || '1532882647838228723');
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('NO_TOKEN');
const API='https://discord.com/api/v10';
const headers={Authorization:`Bot ${token}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){
  for(let i=0;i<8;i++){
    const res=await fetch(API+path,{headers});
    if(res.status===429){const j=await res.json().catch(()=>({}));await sleep(Math.ceil(Number(j.retry_after||1)*1000)+100);continue;}
    if(!res.ok) throw new Error(`${path} ${res.status} ${(await res.text()).slice(0,200)}`);
    return res.json();
  }
  throw new Error('RATE_LIMIT');
}
function slug(name=''){
  let v=String(name).toLowerCase();
  for(const sep of ['│','｜','|']) if(v.includes(sep)) v=v.split(sep).at(-1);
  return v.normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}
const expected = {
  '⇀ Introduction ↼': ['welcome','role-selector'],
  '⇀ Server informations ↼': ['rules','wipes','settings','restart','faq','population','terms-of-services','terms-of-sale','security-information'],
  '⇀ Server notifications ↼': ['next-wipe','announcements','server-status','link-your-account','votes','change-logs','free-kits','raid-alerts'],
  '⇀ Guides ↼': ['zorp-off-raid-protection'],
  '⇀ Shop & Abonnements ↼': ['cloudy-store','vip','queue-skip','content-creator'],
  '⇀ Rewards ↼': ['leaderboard','giveaway','boost'],
  '⇀ Love & Community support ↼': ['tip-jar','staff-reviews','posted-reviews'],
  '⇀ Chats ↼': ['general','gambling','shop','media','team-up','suggestions'],
  '⇀ Post your contents ↼': ['youtube','twitch','tiktok','informations'],
  '⇀ Feeds ↼': ['pvp','player','zorp','raids','ban'],
  '⇀ Updates ↼': ['rust','nitrado'],
  '⇀ Staff contact & Support ↼': ['staff-team','contact-us','appeal-form'],
  '⇀ Vocals ↼': ['games','chill','trio','beef','duo','squad','join-for-create-set-it-up'],
  '⇀ Tickets ↼': [],
  '⇀ Tickets feed ↼': ['ticket-logs','ticket-transcripts'],
  '⇀ Owner ↼': ['bot-commands','payments-logs','timeout-logs','kick-logs','ban-logs','ban-timeout-appeals','invitation-logs','reports','alert-activity','staff-assistant'],
};
const me=await get('/users/@me');
const channels=await get(`/guilds/${guildId}/channels`);
const cats=channels.filter(c=>c.type===4).sort((a,b)=>a.position-b.position);
const categoryAudit=[];
for(const cat of cats){
  const actual=channels.filter(c=>c.parent_id===cat.id).sort((a,b)=>a.position-b.position).map(c=>({name:c.name,slug:slug(c.name),type:c.type,id:c.id}));
  const exp=expected[cat.name];
  categoryAudit.push({
    category:cat.name,
    position:cat.position,
    expected:exp??null,
    actual,
    missing:Array.isArray(exp)?exp.filter(x=>!actual.some(a=>a.slug===x)):[],
    extras:Array.isArray(exp)?actual.filter(a=>!exp.includes(a.slug)):actual,
  });
}
const missingCategories=Object.keys(expected).filter(name=>!cats.some(c=>c.name===name));
const duplicateSlugs={};
for(const c of channels.filter(c=>c.type!==4)){
  const s=slug(c.name); if(!duplicateSlugs[s]) duplicateSlugs[s]=[]; duplicateSlugs[s].push({id:c.id,name:c.name,type:c.type,parent:c.parent_id});
}
const duplicates=Object.fromEntries(Object.entries(duplicateSlugs).filter(([,v])=>v.length>1));

const panelChecks=[
  ['terms-of-services', /terms of service/i],
  ['terms-of-sale', /store terms of sale/i],
  ['faq', /faq|frequently/i],
  ['zorp-off-raid-protection', /zorp guide/i],
  ['security-information', /security information/i],
  ['staff-team', /staff team/i],
  ['appeal-form', /appeal form/i],
  ['staff-reviews', /staff review/i],
  ['contact-us', /contact|ticket/i],
  ['rules', /rule/i],
];
const panels=[];
for(const [target,pattern] of panelChecks){
  const ch=channels.find(c=>[0,5].includes(c.type)&&slug(c.name)===target);
  if(!ch){panels.push({target,channelMissing:true});continue;}
  const msgs=await get(`/channels/${ch.id}/messages?limit=100`);
  const botMsgs=msgs.filter(m=>m.author?.id===me.id);
  const match=botMsgs.find(m=>(m.embeds||[]).some(e=>pattern.test(String(e.title||''))||pattern.test(String(e.description||''))));
  panels.push({target,channelId:ch.id,total:msgs.length,botMessages:botMsgs.length,matched:Boolean(match),matchId:match?.id||null,titles:botMsgs.flatMap(m=>(m.embeds||[]).map(e=>e.title||null)).filter(Boolean).slice(0,10)});
}
console.error('FULL_AUDIT '+JSON.stringify({
  categoryCount:cats.length,
  channelCount:channels.length,
  missingCategories,
  categoryAudit,
  duplicates,
  panels
}));
await sleep(3000);
