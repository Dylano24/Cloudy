
import fs from 'node:fs/promises';

const GUILD = '1532882647838228723';
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');

const source = await fs.readFile(new URL('./cloudy-exact-restore-2026-10-01.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const categories = [');
const specsStart = source.indexOf('const specs = [', start);
if (start < 0 || specsStart < 0) throw new Error('MANIFEST_NOT_FOUND');

let depth = 0;
let inString = null;
let escape = false;
let end = -1;
for (let i = specsStart; i < source.length; i++) {
  const ch = source[i];
  if (inString) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === inString) inString = null;
    continue;
  }
  if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
  if (ch === '[') depth++;
  else if (ch === ']') {
    depth--;
    if (depth === 0) {
      const semicolon = source.indexOf(';', i);
      end = semicolon + 1;
      break;
    }
  }
}
if (end <= specsStart) throw new Error('MANIFEST_END_NOT_FOUND');

const manifestSource = source.slice(start, end);
const { categories, specs } = new Function(
  'GUILD',
  `${manifestSource}\nreturn { categories, specs };`
)(GUILD);

const API='https://discord.com/api/v10';
const H={Authorization:`Bot ${token}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){
  for(let i=0;i<8;i++){
    const res=await fetch(API+path,{headers:H});
    if(res.status===429){
      const j=await res.json().catch(()=>({}));
      await sleep(Math.ceil(Number(j.retry_after||1)*1000)+150);
      continue;
    }
    if(!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0,300)}`);
    return res.json();
  }
  throw new Error('RATE_LIMIT');
}
function canonicalPerms(list=[]){
  return [...list].map(x=>({
    id:String(x.id),
    type:Number(x.type),
    allow:String(x.allow||'0'),
    deny:String(x.deny||'0'),
  })).sort((a,b)=>a.id.localeCompare(b.id)||a.type-b.type);
}
function canonicalTags(list=[]){
  return [...list].map(t=>({
    name:t.name,
    emoji_id:t.emoji_id||null,
    emoji_name:t.emoji_name||null,
    moderated:Boolean(t.moderated),
  }));
}
function normalize(name=''){
  let value=String(name).toLowerCase();
  for(const sep of ['│','｜','|']) if(value.includes(sep)) value=value.split(sep).at(-1);
  return value.normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

const channels = await get(`/guilds/${GUILD}/channels`);
const mismatches=[];

for(let position=0; position<categories.length; position++){
  const [id,name]=categories[position];
  const channel=channels.find(c=>c.id===id);
  if(!channel){
    mismatches.push({kind:'category_missing',id,name,expectedPosition:position});
    continue;
  }
  if(channel.type!==4) mismatches.push({kind:'category_type',id,name,actualType:channel.type});
  if(channel.name!==name) mismatches.push({kind:'category_name',id,expected:name,actual:channel.name});
  if(channel.position!==position) mismatches.push({kind:'category_position',id,name,expected:position,actual:channel.position});
}

const resolved=[];
for(const spec of specs){
  const aliases=new Set([spec.slug,...(spec.aliases||[])].map(normalize));
  const candidates=channels.filter(c=>c.type!==4 && aliases.has(normalize(c.name)));
  if(candidates.length===0){
    mismatches.push({kind:'channel_missing',slug:spec.slug,expectedName:spec.name});
    continue;
  }
  if(candidates.length>1){
    mismatches.push({kind:'duplicate',slug:spec.slug,candidates:candidates.map(c=>({id:c.id,name:c.name,type:c.type,parent:c.parent_id}))});
  }
  const channel=candidates.find(c=>c.type===spec.type) || candidates[0];
  resolved.push({spec,channel});
  if(channel.name!==spec.name) mismatches.push({kind:'name',slug:spec.slug,id:channel.id,expected:spec.name,actual:channel.name});
  if(channel.type!==spec.type) mismatches.push({kind:'type',slug:spec.slug,id:channel.id,expected:spec.type,actual:channel.type});
  if(channel.parent_id!==spec.parent) mismatches.push({kind:'parent',slug:spec.slug,id:channel.id,expected:spec.parent,actual:channel.parent_id});
  if(JSON.stringify(canonicalPerms(channel.permission_overwrites||[]))!==JSON.stringify(canonicalPerms(spec.perms||[]))){
    mismatches.push({kind:'permissions',slug:spec.slug,id:channel.id,expected:canonicalPerms(spec.perms||[]),actual:canonicalPerms(channel.permission_overwrites||[])});
  }
  if(spec.topic!==undefined && String(channel.topic||'')!==String(spec.topic||'')){
    mismatches.push({kind:'topic',slug:spec.slug,id:channel.id});
  }
  if(spec.type===2){
    const expectedBitrate=Number(spec.bitrate??64000);
    const expectedLimit=Number(spec.user_limit??0);
    if(Number(channel.bitrate||0)!==expectedBitrate) mismatches.push({kind:'bitrate',slug:spec.slug,id:channel.id,expected:expectedBitrate,actual:channel.bitrate});
    if(Number(channel.user_limit||0)!==expectedLimit) mismatches.push({kind:'user_limit',slug:spec.slug,id:channel.id,expected:expectedLimit,actual:channel.user_limit});
  }
  if(spec.type===15){
    const expectedArchive=Number(spec.default_auto_archive_duration??10080);
    const expectedFlags=Number(spec.flags??0);
    if(Number(channel.default_auto_archive_duration||0)!==expectedArchive) mismatches.push({kind:'forum_archive',slug:spec.slug,id:channel.id,expected:expectedArchive,actual:channel.default_auto_archive_duration});
    if(Number(channel.flags||0)!==expectedFlags) mismatches.push({kind:'forum_flags',slug:spec.slug,id:channel.id,expected:expectedFlags,actual:channel.flags});
    if(JSON.stringify(canonicalTags(channel.available_tags||[]))!==JSON.stringify(canonicalTags(spec.available_tags||[]))){
      mismatches.push({kind:'forum_tags',slug:spec.slug,id:channel.id,expected:canonicalTags(spec.available_tags||[]),actual:canonicalTags(channel.available_tags||[])});
    }
  }
}

for(const [categoryId, categoryName] of categories){
  const expected = specs.filter(s=>s.parent===categoryId);
  const actual = channels.filter(c=>c.parent_id===categoryId).sort((a,b)=>a.position-b.position);
  for(let i=0;i<expected.length;i++){
    const target = resolved.find(r=>r.spec.slug===expected[i].slug)?.channel;
    if(!target) continue;
    const actualIndex=actual.findIndex(c=>c.id===target.id);
    if(actualIndex!==i){
      mismatches.push({
        kind:'child_position',
        category:categoryName,
        slug:expected[i].slug,
        id:target.id,
        expected:i,
        actual:actualIndex,
      });
    }
  }
}

const desiredIds=new Set(resolved.map(x=>x.channel.id));
const extraStatic=channels.filter(c=>c.type!==4 && c.parent_id && !desiredIds.has(c.id));
if(extraStatic.length){
  mismatches.push({kind:'extra_channels',channels:extraStatic.map(c=>({id:c.id,name:c.name,type:c.type,parent:c.parent_id,position:c.position}))});
}

console.error('HISTORICAL_MANIFEST_AUDIT '+JSON.stringify({
  categoriesExpected:categories.length,
  specsExpected:specs.length,
  liveChannels:channels.length,
  resolved:resolved.length,
  mismatchCount:mismatches.length,
  mismatches,
}));
await sleep(3000);
