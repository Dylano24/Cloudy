import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const token = process.env.DISCORD_TOKEN;
const HAIR = '\u2063\u200A';
const CONT = HAIR.repeat(8);

if (!token) {
  console.error('[ZORP_EXACT_ONCE] Missing DISCORD_TOKEN');
  process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(token);
const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) });

function embedText(embed) {
  return [
    embed?.title || '',
    embed?.description || '',
    ...(Array.isArray(embed?.fields) ? embed.fields.flatMap(field => [field?.name || '', field?.value || '']) : []),
  ].join('\n').toLowerCase();
}

let message = null;
let targetIndex = -1;
for (const candidate of Array.isArray(messages) ? messages : []) {
  const embeds = Array.isArray(candidate?.embeds) ? candidate.embeds : [];
  const index = embeds.findIndex(embed => {
    const haystack = embedText(embed);
    return haystack.includes('zorp') && haystack.includes('important information') && haystack.includes('how to remove a zorp zone');
  });
  if (index >= 0) {
    message = candidate;
    targetIndex = index;
    break;
  }
}

if (!message || targetIndex < 0) {
  console.error('[ZORP_EXACT_ONCE] Current ZORP embed not found; leaving unchanged');
  process.exit(0);
}

const embeds = Array.isArray(message.embeds) ? message.embeds : [];
const source = embeds[targetIndex];

function markerFor(text, phrase) {
  const lines = String(text || '').split('\n');
  const line = lines.find(item => item.toLowerCase().includes(phrase.toLowerCase()));
  if (!line) return null;
  const custom = line.match(/^(\s*<a?:[^>]+>)\s*/u);
  if (custom) return custom[1];
  const standard = line.match(/^(\s*[•◦▪▫‣⁃●○])\s*/u);
  return standard?.[1] || null;
}

function exactImportant(value) {
  const m1 = markerFor(value, 'ZORP zones expire after 24 hours');
  const m2 = markerFor(value, 'The timer is automatically reset');
  const m3 = markerFor(value, 'A team cannot create a ZORP zone');
  const m4 = markerFor(value, 'If a player switches teams');
  if (![m1, m2, m3, m4].every(Boolean)) return null;
  return [
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
}

function exactRemove(value) {
  const mr1 = markerFor(value, 'Use');
  const mr2 = markerFor(value, 'Select');
  if (![mr1, mr2].every(Boolean)) return null;
  const intro = String(value || '').split('\n').find(line => /to delete an existing zorp zone/i.test(line)) || 'To delete an existing ZORP zone:';
  return [
    intro,
    '',
    `${mr1} Use \`Can I build around here?\``,
    `${mr2} Select \`Good Bye\` to confirm the`,
    `${CONT}removal.`,
  ].join('\n');
}

let changed = false;
const next = { ...source };
const fields = Array.isArray(source.fields) ? source.fields.map(field => ({ ...field })) : [];
const importantField = fields.findIndex(field => String(field?.name || '').trim().toLowerCase() === 'important information');
const removeField = fields.findIndex(field => /how to remove a zorp zone/i.test(String(field?.name || '')));

if (importantField >= 0 && removeField >= 0) {
  const importantValue = exactImportant(fields[importantField].value);
  const removeValue = exactRemove(fields[removeField].value);
  if (!importantValue || !removeValue) {
    console.error('[ZORP_EXACT_ONCE] Could not preserve existing bullet markers; leaving unchanged');
    process.exit(0);
  }
  if (fields[importantField].value !== importantValue) {
    fields[importantField].value = importantValue;
    changed = true;
  }
  if (fields[removeField].value !== removeValue) {
    fields[removeField].value = removeValue;
    changed = true;
  }
  next.fields = fields;
} else if (typeof source.description === 'string') {
  const lines = source.description.split('\n');
  const importantStart = lines.findIndex(line => /important information/i.test(line));
  const removeStart = lines.findIndex(line => /how to remove a zorp zone/i.test(line));
  const zoneColorsStart = lines.findIndex(line => /zone colors/i.test(line));
  if (importantStart < 0 || removeStart < 0 || zoneColorsStart < 0 || !(importantStart < removeStart && removeStart < zoneColorsStart)) {
    console.error('[ZORP_EXACT_ONCE] Section boundaries not found; leaving unchanged');
    process.exit(0);
  }
  const importantValue = exactImportant(lines.slice(importantStart + 1, removeStart).join('\n'));
  const removeValue = exactRemove(lines.slice(removeStart + 1, zoneColorsStart).join('\n'));
  if (!importantValue || !removeValue) {
    console.error('[ZORP_EXACT_ONCE] Could not preserve existing bullet markers; leaving unchanged');
    process.exit(0);
  }
  const nextDescription = [
    ...lines.slice(0, importantStart + 1),
    importantValue,
    '',
    lines[removeStart],
    removeValue,
    '',
    ...lines.slice(zoneColorsStart),
  ].join('\n');
  if (nextDescription !== source.description) {
    next.description = nextDescription;
    changed = true;
  }
} else {
  console.error('[ZORP_EXACT_ONCE] ZORP sections unavailable; leaving unchanged');
  process.exit(0);
}

if (!changed) {
  console.log(`[ZORP_EXACT_ONCE] Exact layout already present message=${message.id}`);
  process.exit(0);
}

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

const nextEmbeds = embeds.map((embed, index) => sendableEmbed(index === targetIndex ? next : embed));
await rest.patch(Routes.channelMessage(channelId, message.id), { body: { embeds: nextEmbeds } });
console.log(`[ZORP_EXACT_ONCE] Updated exact ZORP layout message=${message.id}`);
