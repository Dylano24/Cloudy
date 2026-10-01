import { Client as PgClient } from 'pg';
import { resolvePostgresPoolConfig } from '../src/config/database/postgres.js';

const GUILD = '1532882647838228723';
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');

const categories = [
  ['1533189262130938046', '⇀ Introduction ↼'],
  ['1533191129133088809', '⇀ Server informations ↼'],
  ['1533201475713499177', '⇀ Server notifications ↼'],
  ['1533212403490095135', '⇀ Guides ↼'],
  ['1533201002692349953', '⇀ Shop & Abonnements ↼'],
  ['1539447211480457257', '⇀ Rewards ↼'],
  ['1533965050015125774', '⇀ Love & Community support ↼'],
  ['1532882648580493513', '⇀ Chats ↼'],
  ['1533193742419365888', '⇀ Post your contents ↼'],
  ['1533208942375731361', '⇀ Feeds ↼'],
  ['1533886695014142003', '⇀ Updates ↼'],
  ['1533189728223101048', '⇀ Staff contact & Support ↼'],
  ['1532882648580493514', '⇀ Vocals ↼'],
  ['1539490702348521583', '⇀ Tickets ↼'],
  ['1539470691328462878', '⇀ Tickets feed ↼'],
  ['1539259149152690227', '⇀ Owner ↼'],
];

const denyReadOnly = [{ id: GUILD, type: 0, allow: '0', deny: '4012086522992656' }];
const denyView = [{ id: GUILD, type: 0, allow: '0', deny: '1024' }];
const staffView = [
  { id: '1534645342996533389', type: 0, allow: '1024', deny: '0' },
  { id: GUILD, type: 0, allow: '0', deny: '1024' },
];
const botCommandsPerms = [
  { id: '1534645342996533389', type: 0, allow: '1024', deny: '0' },
  { id: '1542633221437657209', type: 0, allow: '1024', deny: '0' },
  { id: GUILD, type: 0, allow: '0', deny: '1024' },
];

const specs = [
  { name:'👋🏼│welcome', slug:'welcome', type:0, parent:'1533189262130938046', perms:[] },
  { name:'👤│role-selector', slug:'role-selector', type:0, parent:'1533189262130938046', perms:[] },

  { name:'📑│rules', slug:'rules', type:0, parent:'1533191129133088809', perms:[] },
  { name:'📆│wipes', slug:'wipes', type:0, parent:'1533191129133088809', perms:denyReadOnly },
  { name:'⚙️│settings', slug:'settings', type:0, parent:'1533191129133088809', perms:denyReadOnly },
  { name:'🔄│restart', slug:'restart', type:0, parent:'1533191129133088809', perms:denyReadOnly },
  { name:'❔│faq', slug:'faq', type:0, parent:'1533191129133088809', perms:denyReadOnly },
  { name:'🌎│population', slug:'population', type:0, parent:'1533191129133088809', perms:denyReadOnly },
  { name:'📃│terms-of-services', slug:'terms-of-services', type:0, parent:'1533191129133088809', perms:denyReadOnly },
  { name:'📃│terms-of-sale', slug:'terms-of-sale', type:0, parent:'1533191129133088809', perms:denyReadOnly },
  { name:'🧰│security-information', slug:'security-information', type:0, parent:'1533191129133088809', perms:denyReadOnly },

  { name:'📢│next-wipe', slug:'next-wipe', type:0, parent:'1533201475713499177', perms:denyReadOnly },
  { name:'📢│announcements', slug:'announcements', type:0, parent:'1533201475713499177', perms:denyReadOnly },
  { name:'📊│server-status', slug:'server-status', type:0, parent:'1533201475713499177', perms:denyReadOnly },
  { name:'🔗│link-your-account', slug:'link-your-account', type:0, parent:'1533201475713499177', perms:denyReadOnly },
  { name:'🗳️│votes', slug:'votes', type:0, parent:'1533201475713499177', perms:denyReadOnly },
  { name:'🚧│change-logs', slug:'change-logs', type:0, parent:'1533201475713499177', perms:denyReadOnly },
  { name:'🆓│free-kits', slug:'free-kits', type:0, parent:'1533201475713499177', perms:denyReadOnly },
  { name:'🚨│raid-alerts', slug:'raid-alerts', type:0, parent:'1533201475713499177', perms:denyReadOnly },

  { name:'🛡️│zorp-off-raid-protection', slug:'zorp-off-raid-protection', type:0, parent:'1533212403490095135', perms:denyReadOnly },

  { name:'🛍️│cloudy-store', slug:'cloudy-store', aliases:['cloudy-official-store'], type:0, parent:'1533201002692349953', perms:denyReadOnly },
  { name:'🍸│vip', slug:'vip', type:0, parent:'1533201002692349953', perms:denyReadOnly },
  { name:'🏎️│queue-skip', slug:'queue-skip', type:0, parent:'1533201002692349953', perms:denyReadOnly },
  { name:'🎬│content-creator', slug:'content-creator', type:0, parent:'1533201002692349953', perms:denyReadOnly },

  { name:'🥇│leaderboard', slug:'leaderboard', type:0, parent:'1539447211480457257', perms:denyReadOnly },
  { name:'🎉│giveaway', slug:'giveaway', type:0, parent:'1539447211480457257', perms:denyReadOnly },
  { name:'🔹│boost', slug:'boost', type:0, parent:'1539447211480457257', perms:denyReadOnly },

  { name:'🫙│tip-jar', slug:'tip-jar', type:0, parent:'1533965050015125774', perms:denyReadOnly },
  { name:'✨│staff-reviews', slug:'staff-reviews', type:0, parent:'1533965050015125774', perms:denyReadOnly },
  { name:'⭐│posted-reviews', slug:'posted-reviews', type:0, parent:'1533965050015125774', perms:denyReadOnly },

  { name:'💬│general', slug:'general', type:0, parent:'1532882648580493513', perms:[], topic:'**The server’s main chat.**' },
  { name:'🎲│gambling', slug:'gambling', type:0, parent:'1532882648580493513', perms:[], topic:'**The channel for playing all kinds of games & gambling.**' },
  { name:'🛒│shop', slug:'shop', type:0, parent:'1532882648580493513', perms:[], topic:'**The channel to make your purchases through our website and Cloudy Inc.**' },
  { name:'📷│media', slug:'media', type:0, parent:'1532882648580493513', perms:[], topic:'**The channel to share your game clips, screenshots, and other media. Links are not allowed here, please post them in the “Post your contents” category.**' },
  { name:'👀│team-up', slug:'team-up', type:15, parent:'1532882648580493513', perms:[], topic:'**This forum is dedicated exclusively to finding teammates and groups for our Rust servers.\n\nPosts unrelated to our Rust servers will be removed and will result in moderation action.\n\nPromoting, recruiting for, or looking for players for other servers or communities is prohibited.**', default_auto_archive_duration:10080, available_tags:[], flags:0 },
  { name:'💡│suggestions', slug:'suggestions', type:15, parent:'1532882648580493513', perms:[], topic:'**This forum is dedicated exclusively to suggestions related to our Discord community and Rust servers.\n\nSuggestions unrelated to the Discord or our Rust servers may be removed and could result in moderation action.**', default_auto_archive_duration:10080, available_tags:[{name:'Rust server',emoji_id:'1543286621594583111',emoji_name:null,moderated:false},{name:'Discord server',emoji_id:'1543287452410716160',emoji_name:null,moderated:false}], flags:16 },

  { name:'🔗│youtube', slug:'youtube', type:0, parent:'1533193742419365888', perms:[] },
  { name:'🔗│twitch', slug:'twitch', type:0, parent:'1533193742419365888', perms:[] },
  { name:'🔗│tiktok', slug:'tiktok', type:0, parent:'1533193742419365888', perms:[] },
  { name:'ℹ️│informations', slug:'informations', type:0, parent:'1533193742419365888', perms:[] },

  { name:'🗒️│rust', slug:'rust', aliases:['patch-notes'], type:0, parent:'1533208942375731361', perms:denyReadOnly },
  { name:'📰│nitrado', slug:'nitrado', aliases:['nitrado-patch-notes'], type:0, parent:'1533208942375731361', perms:denyReadOnly },

  { name:'💀│pvp', slug:'pvp', type:0, parent:'1533886695014142003', perms:denyReadOnly },
  { name:'⚡│player', slug:'player', type:0, parent:'1533886695014142003', perms:denyReadOnly },
  { name:'🫯│zorp', slug:'zorp', type:0, parent:'1533886695014142003', perms:denyReadOnly },
  { name:'🚨│raids', slug:'raids', type:0, parent:'1533886695014142003', perms:denyReadOnly },
  { name:'⛔│ban', slug:'ban', type:0, parent:'1533886695014142003', perms:denyReadOnly },

  { name:'📌│staff-team', slug:'staff-team', aliases:['staff-list'], type:0, parent:'1533189728223101048', perms:denyReadOnly },
  { name:'✉️│contact-us', slug:'contact-us', aliases:['contact-support'], type:0, parent:'1533189728223101048', perms:denyReadOnly },
  { name:'📮│appeal-form', slug:'appeal-form', type:0, parent:'1533189728223101048', perms:denyReadOnly },

  { name:'🎮 | Games', slug:'games', type:2, parent:'1532882648580493514', perms:[], bitrate:64000, user_limit:0 },
  { name:'🧋 | Chill', slug:'chill', type:2, parent:'1532882648580493514', perms:[], bitrate:64000, user_limit:0 },
  { name:'🍨 | Trio', slug:'trio', type:2, parent:'1532882648580493514', perms:[], bitrate:64000, user_limit:3 },
  { name:'😈 | Beef', slug:'beef', type:2, parent:'1532882648580493514', perms:[], bitrate:64000, user_limit:0 },
  { name:'🍩 | Duo', slug:'duo', type:2, parent:'1532882648580493514', perms:[], bitrate:64000, user_limit:2 },
  { name:'🧁 | Squad', slug:'squad', type:2, parent:'1532882648580493514', perms:[], bitrate:64000, user_limit:4 },
  { name:'➕ | Join for create & set it up', slug:'join-for-create-set-it-up', aliases:['join-for-create-and-set-it-up'], type:2, parent:'1532882648580493514', perms:[], bitrate:64000, user_limit:0 },

  { name:'🎫│ticket-logs', slug:'ticket-logs', type:0, parent:'1539470691328462878', perms:staffView },
  { name:'🎟️│ticket-transcripts', slug:'ticket-transcripts', type:0, parent:'1539470691328462878', perms:denyView },

  { name:'🤖│bot-commands', slug:'bot-commands', type:0, parent:'1539259149152690227', perms:botCommandsPerms },
  { name:'💶│payments-logs', slug:'payments-logs', type:0, parent:'1539259149152690227', perms:denyView },
  { name:'🤐│timeout-logs', slug:'timeout-logs', type:0, parent:'1539259149152690227', perms:staffView },
  { name:'💢│kick-logs', slug:'kick-logs', type:0, parent:'1539259149152690227', perms:staffView },
  { name:'⛔│ban-logs', slug:'ban-logs', type:0, parent:'1539259149152690227', perms:staffView },
  { name:'📩│ban-timeout-appeals', slug:'ban-timeout-appeals', type:0, parent:'1539259149152690227', perms:staffView },
  { name:'📤│invitation-logs', slug:'invitation-logs', type:0, parent:'1539259149152690227', perms:staffView },
  { name:'🚨│reports', slug:'reports', type:0, parent:'1539259149152690227', perms:staffView },
  { name:'‼️│alert-activity', slug:'alert-activity', type:0, parent:'1539259149152690227', perms:denyView },
  { name:'💻│staff-assistant', slug:'staff-assistant', aliases:['fix-guide'], type:0, parent:'1539259149152690227', perms:denyView },
];

const artifactIds = new Set([
  '1550358480982909029',
  '1554538598177701890',
  '1554538648236720169',
  '1554539828740227273',
  '1554539834595475466',
  '1554539836097175625',
  '1554538626661089280',
  '1554538627814531072',
  '1554538588773814332',
  '1554538671829418105',
]);

function normalize(value='') {
  let raw=String(value).trim().toLowerCase();
  for (const sep of ['│','｜','|']) if (raw.includes(sep)) raw=raw.split(sep).at(-1);
  return raw.normalize('NFKD').replace(/&/g,'and').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

async function api(method, path, body) {
  for (let attempt=0; attempt<6; attempt++) {
    const r=await fetch('https://discord.com/api/v10'+path, {
      method,
      headers: { Authorization: `Bot ${token}`, ...(body !== undefined ? {'Content-Type':'application/json'} : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429) {
      const d=await r.json().catch(()=>({}));
      const wait=Math.min(15000, Math.max(250, Math.ceil(Number(d.retry_after||1)*1000)+100));
      await new Promise(resolve=>setTimeout(resolve,wait));
      continue;
    }
    if (!r.ok) {
      const txt=await r.text().catch(()=>'');
      throw new Error(`${method} ${path} -> ${r.status} ${txt.slice(0,400)}`);
    }
    if (r.status === 204) return null;
    const txt=await r.text();
    return txt ? JSON.parse(txt) : null;
  }
  throw new Error(`RATE_LIMIT ${method} ${path}`);
}

function wantedNames(spec) { return new Set([spec.slug, ...(spec.aliases||[])].map(normalize)); }
const fetchChannels = () => api('GET', `/guilds/${GUILD}/channels`);

async function del(id, reason) {
  await api('DELETE', `/channels/${id}`);
  console.log(JSON.stringify({action:'deleted',id,reason}));
}
async function patch(id, body) {
  const c=await api('PATCH', `/channels/${id}`, body);
  console.log(JSON.stringify({action:'patched',id,name:c?.name,type:c?.type,parent_id:c?.parent_id}));
  return c;
}
function channelBody(spec) {
  const body={name:spec.name,parent_id:spec.parent,permission_overwrites:spec.perms};
  if (spec.topic !== undefined) body.topic=spec.topic;
  if (spec.type===2) { body.bitrate=spec.bitrate ?? 64000; body.user_limit=spec.user_limit ?? 0; }
  if (spec.type===15) {
    body.default_auto_archive_duration=spec.default_auto_archive_duration ?? 10080;
    body.available_tags=spec.available_tags ?? [];
    body.flags=spec.flags ?? 0;
  }
  return body;
}
function normalizedOverwrites(value=[]) {
  return [...value].map(x=>({id:String(x.id),type:Number(x.type),allow:String(x.allow||'0'),deny:String(x.deny||'0')}))
    .sort((a,b)=>a.id.localeCompare(b.id)||a.type-b.type);
}
function normalizedTags(value=[]) {
  return [...value].map(t=>({name:t.name,emoji_id:t.emoji_id||null,emoji_name:t.emoji_name||null,moderated:Boolean(t.moderated)}));
}
function channelMatchesSpec(c,spec) {
  if (!c || c.name!==spec.name || c.type!==spec.type || c.parent_id!==spec.parent) return false;
  if (JSON.stringify(normalizedOverwrites(c.permission_overwrites))!==JSON.stringify(normalizedOverwrites(spec.perms))) return false;
  if (spec.topic !== undefined && String(c.topic||'')!==String(spec.topic||'')) return false;
  if (spec.type===2) {
    if (Number(c.bitrate||0)!==Number(spec.bitrate??64000)) return false;
    if (Number(c.user_limit||0)!==Number(spec.user_limit??0)) return false;
  }
  if (spec.type===15) {
    if (Number(c.default_auto_archive_duration||0)!==Number(spec.default_auto_archive_duration??10080)) return false;
    if (Number(c.flags||0)!==Number(spec.flags??0)) return false;
    if (JSON.stringify(normalizedTags(c.available_tags))!==JSON.stringify(normalizedTags(spec.available_tags))) return false;
  }
  return true;
}
function canonicalPerms(list=[]) {
  return [...list].map(x=>({id:String(x.id),type:Number(x.type),allow:String(x.allow||'0'),deny:String(x.deny||'0')}))
    .sort((a,b)=>a.id.localeCompare(b.id)||a.type-b.type);
}
function canonicalTags(list=[]) {
  return [...list].map(t=>({name:t.name,emoji_id:t.emoji_id||null,emoji_name:t.emoji_name||null,moderated:Boolean(t.moderated)}));
}
function needsPatch(channel,spec) {
  if (!channel) return true;
  if (channel.name!==spec.name || channel.parent_id!==spec.parent) return true;
  if (spec.topic!==undefined && channel.topic!==spec.topic) return true;
  if (spec.type===2 && (Number(channel.bitrate||0)!==Number(spec.bitrate||64000) || Number(channel.user_limit||0)!==Number(spec.user_limit||0))) return true;
  if (spec.type===15) {
    if (Number(channel.default_auto_archive_duration||0)!==Number(spec.default_auto_archive_duration||10080)) return true;
    if (Number(channel.flags||0)!==Number(spec.flags||0)) return true;
    if (JSON.stringify(canonicalTags(channel.available_tags||[]))!==JSON.stringify(canonicalTags(spec.available_tags||[]))) return true;
  }
  const critical = ['ticket-logs','ticket-transcripts','bot-commands','payments-logs','timeout-logs','kick-logs','ban-logs','ban-timeout-appeals','invitation-logs','reports','alert-activity','staff-assistant'];
  if (critical.includes(spec.slug) && JSON.stringify(canonicalPerms(channel.permission_overwrites||[]))!==JSON.stringify(canonicalPerms(spec.perms||[]))) return true;
  return false;
}

async function create(spec) {
  const body={type:spec.type,...channelBody(spec)};
  const c=await api('POST', `/guilds/${GUILD}/channels`, body);
  console.log(JSON.stringify({action:'created',id:c.id,name:c.name,type:c.type,parent_id:c.parent_id}));
  return c;
}

const guildEmojis=await api('GET', `/guilds/${GUILD}/emojis`);
for (const emojiId of ['1543286621594583111','1543287452410716160']) {
  if (!guildEmojis.some(e=>e.id===emojiId)) throw new Error(`ABORT_MISSING_HISTORICAL_EMOJI ${emojiId}`);
}

let channels=await fetchChannels();
for (const [id,name] of categories) {
  const c=channels.find(x=>x.id===id && x.type===4);
  if (!c) throw new Error(`ABORT_MISSING_ORIGINAL_CATEGORY ${id} ${name}`);
  if (c.name!==name) await patch(id,{name});
}

const resolved=new Map();
for (const spec of specs) {
  const wanted=wantedNames(spec);
  let candidates=channels.filter(c=>c.type!==4 && wanted.has(normalize(c.name)));

  if (spec.recreate) {
    for (const c of candidates) {
      await del(c.id,'replace wrong channel type with historical forum type');
      channels=channels.filter(x=>x.id!==c.id);
    }
    candidates=[];
  }

  let chosen=candidates.find(c=>c.type===spec.type) || null;
  if (!chosen && candidates.length) {
    for (const c of candidates) {
      await del(c.id,'replace wrong historical channel type');
      channels=channels.filter(x=>x.id!==c.id);
    }
  }

  if (!chosen) {
    const again=channels.filter(c=>c.type!==4 && wanted.has(normalize(c.name)));
    chosen=again.find(c=>c.type===spec.type) || null;
    if (!chosen) {
      chosen=await create(spec);
      channels.push(chosen);
    }
  }

  const duplicates=channels.filter(c=>c.type!==4 && wanted.has(normalize(c.name)) && c.id!==chosen.id);
  for (const duplicate of duplicates) {
    await del(duplicate.id,'remove semantic duplicate during exact restore');
    channels=channels.filter(x=>x.id!==duplicate.id);
  }

  if (needsPatch(chosen,spec)) {
    chosen=await patch(chosen.id,channelBody(spec));
    channels=channels.map(x=>x.id===chosen.id?chosen:x);
  } else {
    console.log(JSON.stringify({action:'unchanged',id:chosen.id,name:chosen.name,type:chosen.type,parent_id:chosen.parent_id}));
  }
  resolved.set(spec.slug,chosen.id);
}

channels=await fetchChannels();
for (const c of channels) {
  if (!artifactIds.has(c.id)) continue;
  if ([...resolved.values()].includes(c.id)) continue;
  await del(c.id,'remove known restore artefact/duplicate');
}

await api('PATCH', `/guilds/${GUILD}/channels`, categories.map(([id],position)=>({id,position})));
for (const [categoryId] of categories) {
  const group=specs.filter(s=>s.parent===categoryId);
  if (!group.length) continue;
  await api('PATCH', `/guilds/${GUILD}/channels`, group.map((spec, position)=>({
    id: resolved.get(spec.slug),
    position,
  })));
}

const pg=new PgClient({...resolvePostgresPoolConfig(),application_name:'cloudy-exact-restore-2026-10-01',statement_timeout:15000,connectionTimeoutMillis:15000});
await pg.connect();
try {
  await pg.query('BEGIN');
  const row=(await pg.query('SELECT config FROM guilds WHERE id=$1 FOR UPDATE',[GUILD])).rows[0];
  if (row?.config) {
    const config={...row.config,
      ticketLogsChannelId:resolved.get('ticket-logs'),
      ticketPanelChannelId:resolved.get('contact-us'),
      ticketPanelMessageId:null,
      ticketTranscriptChannelId:resolved.get('ticket-transcripts'),
      ticketCategoryId:'1539490702348521583',
      ticketClosedCategoryId:'1539490702348521583',
    };
    await pg.query('UPDATE guilds SET config=$2::jsonb WHERE id=$1',[GUILD,JSON.stringify(config)]);
  }

  const wr=(await pg.query('SELECT config FROM welcome_configs WHERE guild_id=$1 FOR UPDATE',[GUILD])).rows[0];
  if (wr?.config) {
    const config={...wr.config,channelId:resolved.get('welcome')};
    await pg.query('UPDATE welcome_configs SET config=$2::jsonb WHERE guild_id=$1',[GUILD,JSON.stringify(config)]);
  }

  const key=`guild:${GUILD}:jointocreate`;
  const jr=(await pg.query('SELECT value FROM temp_data WHERE key=$1 FOR UPDATE',[key])).rows[0];
  if (jr?.value) {
    const oldId='1542223981963251712', newId=resolved.get('join-for-create-set-it-up');
    const replace=(v)=>{
      if (v===oldId) return newId;
      if (Array.isArray(v)) return v.map(replace);
      if (v && typeof v==='object') {
        const out={};
        for (const [k,val] of Object.entries(v)) out[k===oldId?newId:k]=replace(val);
        return out;
      }
      return v;
    };
    await pg.query('UPDATE temp_data SET value=$2::jsonb WHERE key=$1',[key,JSON.stringify(replace(jr.value))]);
  }
  await pg.query('COMMIT');
} catch (e) {
  await pg.query('ROLLBACK').catch(()=>{});
  throw e;
} finally { await pg.end(); }

const configClient=new PgClient({...resolvePostgresPoolConfig(),application_name:'cloudy-panel-restore-2026-10-01',statement_timeout:10000,connectionTimeoutMillis:10000});
await configClient.connect();
let ticketConfig={};
try { ticketConfig=(await configClient.query('SELECT config FROM guilds WHERE id=$1',[GUILD])).rows[0]?.config||{}; }
finally { await configClient.end(); }

const panelChannel=resolved.get('contact-us');
const recent=await api('GET',`/channels/${panelChannel}/messages?limit=100`);
let panel=(recent||[]).find(m=>m.author?.bot && (m.components||[]).some(r=>(r.components||[]).some(b=>b.custom_id==='create_ticket')))||null;
if (!panel) {
  const title=(typeof ticketConfig.ticketPanelTitle==='string'&&ticketConfig.ticketPanelTitle.trim())?ticketConfig.ticketPanelTitle.trim():'Contact the support';
  const description=(typeof ticketConfig.ticketPanelMessage==='string'&&ticketConfig.ticketPanelMessage.trim())?ticketConfig.ticketPanelMessage:'If you need assistance or have something to report, simply hit the **Start Chat** button below and our team will get back to you as soon as possible.\n\nBefore submitting a request, please make sure the answer to your question cannot already be found in our **FAQ** section using the button at the bottom right.';
  const label=ticketConfig.ticketButtonLabel||'Start Chat';
  panel=await api('POST',`/channels/${panelChannel}/messages`,{
    embeds:[{title,description,color:16777215,footer:{text:'© Cloudy Inc. • Quality. Innovation. Performance.'}}],
    components:[{type:1,components:[
      {type:2,style:2,custom_id:'create_ticket',label,emoji:{name:'💬'}},
      {type:2,style:5,label:'❔FAQ',url:`https://discord.com/channels/${GUILD}/${resolved.get('faq')}`},
    ]}],
    allowed_mentions:{parse:[]},
  });
}
const pg2=new PgClient({...resolvePostgresPoolConfig(),application_name:'cloudy-panel-id-restore-2026-10-01',statement_timeout:10000,connectionTimeoutMillis:10000});
await pg2.connect();
try {
  const row=(await pg2.query('SELECT config FROM guilds WHERE id=$1 FOR UPDATE',[GUILD])).rows[0];
  if (row?.config) await pg2.query('UPDATE guilds SET config=$2::jsonb WHERE id=$1',[GUILD,JSON.stringify({...row.config,ticketPanelMessageId:panel.id})]);
} finally { await pg2.end(); }

channels=await fetchChannels();
const problems=[];
for (const spec of specs) {
  const id=resolved.get(spec.slug), c=channels.find(x=>x.id===id);
  if (!c) { problems.push(`missing:${spec.name}`); continue; }
  if (c.name!==spec.name) problems.push(`name:${c.id}:${c.name}->${spec.name}`);
  if (c.type!==spec.type) problems.push(`type:${spec.name}:${c.type}->${spec.type}`);
  if (c.parent_id!==spec.parent) problems.push(`parent:${spec.name}:${c.parent_id}->${spec.parent}`);
  if (spec.topic !== undefined && c.topic !== spec.topic) problems.push(`topic:${spec.name}`);
  if (spec.type===2 && Number(c.user_limit||0)!==Number(spec.user_limit||0)) problems.push(`user_limit:${spec.name}:${c.user_limit}->${spec.user_limit}`);
  if (spec.type===15) {
    if (Number(c.default_auto_archive_duration)!==Number(spec.default_auto_archive_duration)) problems.push(`archive:${spec.name}`);
    const tags=(c.available_tags||[]).map(t=>({name:t.name,emoji_id:t.emoji_id||null,emoji_name:t.emoji_name||null,moderated:Boolean(t.moderated)}));
    const expected=(spec.available_tags||[]).map(t=>({name:t.name,emoji_id:t.emoji_id||null,emoji_name:t.emoji_name||null,moderated:Boolean(t.moderated)}));
    if (JSON.stringify(tags)!==JSON.stringify(expected)) problems.push(`tags:${spec.name}`);
  }
  const dup=channels.filter(x=>x.type!==4 && wantedNames(spec).has(normalize(x.name)));
  if (dup.length!==1) problems.push(`duplicates:${spec.name}:${dup.map(x=>x.id).join(',')}`);
}
for (const id of artifactIds) if (channels.some(c=>c.id===id)) problems.push(`artifact-still-present:${id}`);

console.log(JSON.stringify({ok:problems.length===0,restored:specs.length,ticketPanelMessageId:panel.id,problems,ids:Object.fromEntries(resolved)},null,2));
if (problems.length) process.exitCode=2;
