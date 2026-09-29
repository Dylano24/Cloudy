import 'dotenv/config';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';
import { initializeDatabase } from '../src/utils/database.js';

const TARGET_GUILD_ID = String(process.env.GUILD_ID || '1532882647838228723');
const RESTORE_KEY = 'global:cloudy:server-structure-restore:2026-09-29:v1';

const LAYOUT = [
  ['— Introduction —', 'readOnly', [['👋｜welcome','text']]],
  ['— Server informations —', 'readOnly', [
    ['📜｜rules','text'], ['⚙️｜settings','text'], ['🧴｜wipes','text'], ['🔁｜restart','text'],
    ['🌐｜population','text'], ['❓｜faq','text'], ['📄｜termes-of-services','text'],
    ['🔐｜privacy-policy','text'], ['📄｜terms-of-sale','text'],
  ]],
  ['— Server notifications —', 'readOnly', [
    ['📢｜announcements','text'], ['📌｜next-wipe','text'], ['📡｜server-status','text'], ['🗳️｜votes','text'],
  ]],
  ['→ Shop & Abonnements ←', 'readOnly', [
    ['🏆｜vip','text'], ['🏎️｜queue-skip','text'], ['🎬｜content-creator','text'], ['🛍️｜cloudy-official-store','text'],
  ]],
  ['→ Rewards ←', 'readOnly', [
    ['🥇｜leaderboard','text'], ['🎉｜giveaway','text'], ['🔹｜boost','text'],
  ]],
  ['→ Love & Community support ←', 'readOnly', [
    ['🫙｜tip-jar','text'], ['✨｜staff-reviews','text'], ['⭐｜posted-reviews','text'],
  ]],
  ['→ Chats ←', 'public', [
    ['💬｜general','text'], ['🎲｜gambling','text'], ['🛒｜shop','text'], ['📷｜media','text'],
    ['👀｜team-up','voice'], ['💡｜suggestions','voice'],
  ]],
  ['→ Post your contents ←', 'public', [
    ['▶️｜youtube','text'], ['🟣｜twitch','text'], ['🎵｜tiktok','text'], ['ℹ️｜informations','text'],
  ]],
  ['→ Guides ←', 'readOnly', [['🛡️｜zorp-off-raid-protection','text']]],
  ['→ Feeds ←', 'readOnly', [['📰｜patch-notes','text'], ['🛰️｜nitrado-patch-notes','text']]],
  ['→ Vocals ←', 'public', [
    ['Duo','voice'], ['Trio','voice'], ['Squad','voice'], ['Join for create & set it up','voice'],
  ]],
  ['→ Support & help ←', 'readOnly', [
    ['📌｜staff-list','text'], ['✉️｜contact-support','text'], ['📮｜appeal-form','text'], ['🛡️｜security-information','text'],
  ]],
  ['→ Tickets ←', 'privateStaff', []],
  ['→ Owner ←', 'privateStaff', [
    ['🤖｜bot-commands','text'], ['⛔｜ban-logs','text'], ['💢｜kick-logs','text'], ['⏱️｜timeout-logs','text'],
    ['📩｜invitation-logs','text'], ['📊｜reports','text'], ['📨｜ban-timeout-appeals','text'],
    ['🛠️｜FIX-GUIDE','text'], ['🧾｜botlog-commands','text'],
  ]],
  ['→ Tickets feed ←', 'privateStaff', [['🧾｜ticket-logs','text'], ['📄｜ticket-transcripts','text']]],
];

function normalize(value='') {
  const raw=String(value).trim().toLowerCase();
  const tail=raw.includes('｜')?raw.split('｜').at(-1):raw.includes('│')?raw.split('│').at(-1):raw;
  return tail.normalize('NFKD').replace(/&/g,'and').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

function staffRoles(guild) {
  const names=new Set(['founder','owner','staff','support','moderator','admin','administrator']);
  return [...guild.roles.cache.values()].filter(r=>names.has(r.name.trim().toLowerCase()));
}

function overwrites(guild, mode) {
  const out=[];
  if (mode==='readOnly') out.push({
    id:guild.roles.everyone.id,
    deny:[PermissionFlagsBits.SendMessages],
    allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory],
  });
  if (mode==='privateStaff') {
    out.push({id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]});
    for (const role of staffRoles(guild)) out.push({
      id:role.id,
      allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak],
    });
  }
  if (guild.members.me?.id && mode!=='public') out.push({
    id:guild.members.me.id,
    allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak],
  });
  return out;
}

function findCategory(guild,name) {
  const n=normalize(name);
  return [...guild.channels.cache.values()].find(c=>c.type===ChannelType.GuildCategory && normalize(c.name)===n) || null;
}

function findChannel(guild,name,kind) {
  const n=normalize(name);
  const type=kind==='voice'?ChannelType.GuildVoice:ChannelType.GuildText;
  return [...guild.channels.cache.values()].find(c=>c.type===type && normalize(c.name)===n) || null;
}

const token=String(process.env.DISCORD_TOKEN||process.env.TOKEN||process.env.BOT_TOKEN||'').trim();
if (!token) throw new Error('DISCORD_TOKEN is missing');

const client=new Client({intents:[GatewayIntentBits.Guilds]});

client.once('ready', async()=>{
  let db=null;
  try {
    const guild=client.guilds.cache.get(TARGET_GUILD_ID) || await client.guilds.fetch(TARGET_GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();

    const createdCategories=[];
    const createdChannels=[];
    const moved=[];

    for (const [categoryName,mode,channels] of LAYOUT) {
      let category=findCategory(guild,categoryName);
      if (!category) {
        category=await guild.channels.create({
          name:categoryName,
          type:ChannelType.GuildCategory,
          permissionOverwrites:overwrites(guild,mode),
          reason:'Cloudy one-shot server restore',
        });
        createdCategories.push(category.name);
      }

      for (const [name,kind] of channels) {
        let channel=findChannel(guild,name,kind);
        if (!channel) {
          channel=await guild.channels.create({
            name,
            type:kind==='voice'?ChannelType.GuildVoice:ChannelType.GuildText,
            parent:category.id,
            reason:'Cloudy one-shot server restore',
          });
          createdChannels.push(channel.name);
        } else if (channel.parentId!==category.id) {
          await channel.setParent(category.id,{lockPermissions:false,reason:'Restore Cloudy channel placement'});
          moved.push(channel.name);
        }
      }
    }

    try {
      const dbInstance=await initializeDatabase();
      db=dbInstance.db;
      if (db?.set) await db.set(RESTORE_KEY,{
        completedAt:new Date().toISOString(),
        source:'one-shot-restore-service',
        createdCategories,
        createdChannels,
        moved,
      });
    } catch (error) {
      console.warn('[RESTORE] Could not persist completion marker:',error?.message||error);
    }

    console.log(JSON.stringify({
      ok:true,
      guildId:guild.id,
      createdCategories,
      createdChannels,
      moved,
    },null,2));
    process.exitCode=0;
  } catch (error) {
    console.error('[RESTORE] FAILED',error);
    process.exitCode=1;
  } finally {
    try { if (db?.db?.pool) await db.db.pool.end(); } catch {}
    client.destroy();
    setTimeout(()=>process.exit(process.exitCode||0),250).unref?.();
  }
});

await client.login(token);
