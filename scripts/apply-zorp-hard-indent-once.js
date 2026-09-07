import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const messageId = '1540279973691007048';
const token = process.env.DISCORD_TOKEN;
const INDENT = '\u2800\u2800';

if (!token) process.exit(0);

const rest = new REST({ version: '10' }).setToken(token);
const message = await rest.get(Routes.channelMessage(channelId, messageId));
const embeds = Array.isArray(message?.embeds) ? message.embeds.map(embed => ({ ...embed })) : [];
const embedIndex = embeds.findIndex(embed => /zorp guide/i.test(String(embed?.title || '')));
if (embedIndex < 0) {
  console.error('[ZORP_HARD_INDENT_ONCE] ZORP Guide not found; leaving unchanged');
  process.exit(0);
}

const embed = { ...embeds[embedIndex] };
const fields = Array.isArray(embed.fields) ? embed.fields.map(field => ({ ...field })) : [];
const importantIndex = fields.findIndex(field => /important information/i.test(String(field?.name || '')));
const removeIndex = fields.findIndex(field => /how to remove a zorp zone/i.test(String(field?.name || '')));
if (importantIndex < 0 || removeIndex < 0) {
  console.error('[ZORP_HARD_INDENT_ONCE] Target fields not found; leaving unchanged');
  process.exit(0);
}

function markerFor(value, phrase) {
  const line = String(value || '').split('\n').find(item => item.toLowerCase().includes(phrase.toLowerCase()));
  if (!line) return null;
  const custom = line.match(/^(\s*<a?:[^>]+>)\s*/u);
  if (custom) return custom[1];
  const standard = line.match(/^(\s*[•◦▪▫‣⁃●○])\s*/u);
  return standard?.[1] || null;
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
  console.error('[ZORP_HARD_INDENT_ONCE] Existing markers could not be preserved; leaving unchanged');
  process.exit(0);
}

const importantNew = [
  `${m1} ZORP zones expire after 24 hours.`,
  `${m2} The timer is automatically reset while`,
  `${INDENT}the team is online.`,
  `${m3} A team cannot create a ZORP zone`,
  `${INDENT}that overlaps with another team’s`,
  `${INDENT}zone.`,
  `${m4} If a player switches teams, their`,
  `${INDENT}existing ZORP zone will be removed`,
  `${INDENT}to prevent abuse.`,
].join('\n');

const removeNew = [
  'To delete an existing ZORP zone:',
  '',
  `${mr1} Use \`Can I build around here?\``,
  `${mr2} Select \`Good Bye\` to confirm the`,
  `${INDENT}removal.`,
].join('\n');

fields[importantIndex].value = importantNew;
fields[removeIndex].value = removeNew;
embed.fields = fields;
embeds[embedIndex] = embed;

function sendableEmbed(source) {
  const out = {};
  for (const key of ['title', 'description', 'url', 'timestamp', 'color']) {
    if (source?.[key] !== undefined) out[key] = source[key];
  }
  if (source?.footer) out.footer = source.footer;
  if (source?.image?.url) out.image = { url: source.image.url };
  if (source?.thumbnail?.url) out.thumbnail = { url: source.thumbnail.url };
  if (source?.author?.name) out.author = {
    name: source.author.name,
    ...(source.author.url ? { url: source.author.url } : {}),
    ...(source.author.icon_url ? { icon_url: source.author.icon_url } : {}),
  };
  if (Array.isArray(source?.fields) && source.fields.length) out.fields = source.fields;
  return out;
}

await rest.patch(Routes.channelMessage(channelId, messageId), { body: { embeds: embeds.map(sendableEmbed) } });
console.log(`[ZORP_HARD_INDENT_ONCE] Applied exact hard line breaks and preserved indent message=${messageId}`);
