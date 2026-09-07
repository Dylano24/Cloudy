import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const token = process.env.DISCORD_TOKEN;
const HAIR = '\u2063\u200A';
const CONT = HAIR.repeat(8);

if (!token) process.exit(0);
const rest = new REST({ version: '10' }).setToken(token);
const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) });

function markerFor(value, phrase) {
  const line = String(value || '').split('\n').find(item => item.toLowerCase().includes(phrase.toLowerCase()));
  if (!line) return null;
  const custom = line.match(/^(\s*<a?:[^>]+>)\s*/u);
  if (custom) return custom[1];
  const standard = line.match(/^(\s*[•◦▪▫‣⁃●○])\s*/u);
  return standard?.[1] || null;
}

let message = null;
let embedIndex = -1;
for (const candidate of Array.isArray(messages) ? messages : []) {
  const embeds = Array.isArray(candidate?.embeds) ? candidate.embeds : [];
  const index = embeds.findIndex(embed => {
    const fields = Array.isArray(embed?.fields) ? embed.fields : [];
    const names = fields.map(field => String(field?.name || '').toLowerCase()).join('\n');
    return /zorp guide/i.test(String(embed?.title || '')) && names.includes('important information') && names.includes('how to remove a zorp zone');
  });
  if (index >= 0) {
    message = candidate;
    embedIndex = index;
    break;
  }
}

if (!message || embedIndex < 0) {
  console.error('[ZORP_EXACT_ONCE] Live ZORP embed not found; leaving unchanged');
  process.exit(0);
}

const embeds = message.embeds.map(embed => ({ ...embed }));
const source = { ...embeds[embedIndex] };
const fields = (source.fields || []).map(field => ({ ...field }));
const importantIndex = fields.findIndex(field => String(field?.name || '').toLowerCase().includes('important information'));
const removeIndex = fields.findIndex(field => String(field?.name || '').toLowerCase().includes('how to remove a zorp zone'));

if (importantIndex < 0 || removeIndex < 0) {
  console.error('[ZORP_EXACT_ONCE] Target fields not found; leaving unchanged');
  process.exit(0);
}

const importantOld = String(fields[importantIndex].value || '');
const removeOld = String(fields[removeIndex].value || '');

const m1 = markerFor(importantOld, 'ZORP zones expire after 24 hours');
const m2 = markerFor(importantOld, 'The timer is automatically reset');
const m3 = markerFor(importantOld, 'A team cannot create a ZORP zone');
const m4 = markerFor(importantOld, 'If a player switches teams');
const mr1 = markerFor(removeOld, 'Use');
const mr2 = markerFor(removeOld, 'Select');

if (![m1, m2, m3, m4, mr1, mr2].every(Boolean)) {
  console.error('[ZORP_EXACT_ONCE] Existing bullet markers could not be preserved; leaving unchanged');
  process.exit(0);
}

const importantNew = [
  `${m1} ZORP zones expire after 24 hours.`,
  `${m2} The timer is automatically reset while`,
  `${CONT}the team is online.`,
  `${m3} A team cannot create a ZORP zone`,
  `${CONT}that overlaps with another team’s`,
  `${CONT}zone.`,
  `${m4} If a player switches teams, their`,
  `${CONT}existing ZORP zone will be removed`,
  `${CONT}to prevent abuse.`,
].join('\n');

const removeNew = [
  'To delete an existing ZORP zone:',
  '',
  `${mr1} Use \`Can I build around here?\``,
  `${mr2} Select \`Good Bye\` to confirm the`,
  `${CONT}removal.`,
].join('\n');

if (importantOld === importantNew && removeOld === removeNew) {
  console.log(`[ZORP_EXACT_ONCE] Exact layout already present message=${message.id}`);
  process.exit(0);
}

fields[importantIndex].value = importantNew;
fields[removeIndex].value = removeNew;
source.fields = fields;
embeds[embedIndex] = source;

function sendableEmbed(embed) {
  const out = {};
  for (const key of ['title', 'description', 'url', 'timestamp', 'color']) {
    if (embed?.[key] !== undefined) out[key] = embed[key];
  }
  if (embed?.footer) out.footer = embed.footer;
  if (embed?.image?.url) out.image = { url: embed.image.url };
  if (embed?.thumbnail?.url) out.thumbnail = { url: embed.thumbnail.url };
  if (embed?.author?.name) out.author = {
    name: embed.author.name,
    ...(embed.author.url ? { url: embed.author.url } : {}),
    ...(embed.author.icon_url ? { icon_url: embed.author.icon_url } : {}),
  };
  if (Array.isArray(embed?.fields) && embed.fields.length) out.fields = embed.fields;
  return out;
}

await rest.patch(Routes.channelMessage(channelId, message.id), {
  body: { embeds: embeds.map(sendableEmbed) },
});

console.log(`[ZORP_EXACT_ONCE] Updated exact live ZORP layout message=${message.id}`);
