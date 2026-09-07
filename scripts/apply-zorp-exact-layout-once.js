import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const messageId = '1540279973691007048';
const token = process.env.DISCORD_TOKEN;
const HAIR = '\u2063\u200A';
const CONT = HAIR.repeat(8);

if (!token) {
  console.error('[ZORP_EXACT_ONCE] Missing DISCORD_TOKEN');
  process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(token);
const message = await rest.get(Routes.channelMessage(channelId, messageId));
const embeds = Array.isArray(message?.embeds) ? message.embeds : [];

const targetIndex = embeds.findIndex(embed => {
  const haystack = `${embed?.title || ''}\n${embed?.description || ''}`.toLowerCase();
  return haystack.includes('zorp') && haystack.includes('important information') && haystack.includes('how to remove a zorp zone');
});

if (targetIndex < 0) {
  console.error('[ZORP_EXACT_ONCE] Target embed not found; leaving unchanged');
  process.exit(0);
}

const source = embeds[targetIndex];
if (typeof source.description !== 'string') {
  console.error('[ZORP_EXACT_ONCE] Target description missing; leaving unchanged');
  process.exit(0);
}

const lines = source.description.split('\n');
const importantStart = lines.findIndex(line => /important information/i.test(line));
const removeStart = lines.findIndex(line => /how to remove a zorp zone/i.test(line));
const zoneColorsStart = lines.findIndex(line => /zone colors/i.test(line));

if (importantStart < 0 || removeStart < 0 || zoneColorsStart < 0 || !(importantStart < removeStart && removeStart < zoneColorsStart)) {
  console.error('[ZORP_EXACT_ONCE] Section boundaries not found; leaving unchanged');
  process.exit(0);
}

function markerFor(sectionLines, phrase) {
  const line = sectionLines.find(item => item.toLowerCase().includes(phrase.toLowerCase()));
  if (!line) return null;
  const custom = line.match(/^(\s*<a?:[^>]+>)\s*/u);
  if (custom) return custom[1];
  const standard = line.match(/^(\s*[•◦▪▫‣⁃●○])\s*/u);
  return standard?.[1] || null;
}

const importantSlice = lines.slice(importantStart + 1, removeStart);
const removeSlice = lines.slice(removeStart + 1, zoneColorsStart);

const m1 = markerFor(importantSlice, 'ZORP zones expire after 24 hours');
const m2 = markerFor(importantSlice, 'The timer is automatically reset');
const m3 = markerFor(importantSlice, 'A team cannot create a ZORP zone');
const m4 = markerFor(importantSlice, 'If a player switches teams');
const mr1 = markerFor(removeSlice, 'Use');
const mr2 = markerFor(removeSlice, 'Select');

if (![m1, m2, m3, m4, mr1, mr2].every(Boolean)) {
  console.error('[ZORP_EXACT_ONCE] Could not preserve all existing bullet markers; leaving unchanged');
  process.exit(0);
}

const importantExact = [
  lines[importantStart],
  `${m1} ZORP zones expire after 24 hours.`,
  `${m2} The timer is automatically reset while`,
  `${CONT}the team is online.`,
  `${m3} A team cannot create a ZORP zone`,
  `${CONT}that overlaps with another team’s`,
  `${CONT}zone.`,
  `${m4} If a player switches teams, their`,
  `${CONT}existing ZORP zone will be removed`,
  `${CONT}to prevent abuse.`,
];

const removeBody = removeSlice.filter(line => line.trim());
const intro = removeBody.find(line => /to delete an existing zorp zone/i.test(line)) || 'To delete an existing ZORP zone:';
const removeExact = [
  lines[removeStart],
  intro,
  '',
  `${mr1} Use \`Can I build around here?\``,
  `${mr2} Select \`Good Bye\` to confirm the`,
  `${CONT}removal.`,
  '',
];

const nextDescription = [
  ...lines.slice(0, importantStart),
  ...importantExact,
  '',
  ...removeExact,
  ...lines.slice(zoneColorsStart),
].join('\n');

if (nextDescription === source.description) {
  console.log('[ZORP_EXACT_ONCE] Exact layout already present');
  process.exit(0);
}

function sendableEmbed(embed, description) {
  const out = {};
  for (const key of ['title', 'url', 'timestamp', 'color']) {
    if (embed?.[key] !== undefined) out[key] = embed[key];
  }
  out.description = description;
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

const nextEmbeds = embeds.map((embed, index) =>
  index === targetIndex ? sendableEmbed(embed, nextDescription) : sendableEmbed(embed, embed.description),
);

await rest.patch(Routes.channelMessage(channelId, messageId), { body: { embeds: nextEmbeds } });
console.log(`[ZORP_EXACT_ONCE] Updated exact ZORP layout message=${messageId}`);
