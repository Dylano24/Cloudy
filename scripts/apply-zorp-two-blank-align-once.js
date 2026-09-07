import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const token = process.env.DISCORD_TOKEN;
if (!token) process.exit(0);

const rest = new REST({ version: '10' }).setToken(token);
const messages = await rest.get(Routes.channelMessages(channelId), {
  query: new URLSearchParams({ limit: '100' }),
});

let message = null;
let embedIndex = -1;
for (const candidate of Array.isArray(messages) ? messages : []) {
  const embeds = Array.isArray(candidate?.embeds) ? candidate.embeds : [];
  const index = embeds.findIndex(embed => {
    const fields = Array.isArray(embed?.fields) ? embed.fields : [];
    const names = fields.map(field => String(field?.name || '').toLowerCase()).join('\n');
    return /zorp guide/i.test(String(embed?.title || '')) &&
      names.includes('important information') &&
      names.includes('how to remove a zorp zone');
  });
  if (index >= 0) {
    message = candidate;
    embedIndex = index;
    break;
  }
}

if (!message || embedIndex < 0) {
  console.error('[ZORP_ALIGN_ONCE] Live ZORP embed not found');
  process.exit(0);
}

const embeds = message.embeds.map(embed => ({ ...embed }));
const source = { ...embeds[embedIndex] };
const fields = (source.fields || []).map(field => ({ ...field }));
const targetNames = new Set(['important information', 'how to remove a zorp zone']);
let changed = false;

for (const field of fields) {
  if (!targetNames.has(String(field?.name || '').toLowerCase())) continue;
  const before = String(field.value || '');
  // Change only the existing three-braille continuation prefix to two.
  // Text, glowing-dot emoji, field names, and every other embed property stay untouched.
  const after = before.replace(/^\u2800\u2800\u2800(?=\S)/gmu, '\u2800\u2800');
  if (after !== before) {
    field.value = after;
    changed = true;
  }
}

if (!changed) {
  console.log('[ZORP_ALIGN_ONCE] No three-blank continuation prefixes found; nothing changed');
  process.exit(0);
}

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

console.log(`[ZORP_ALIGN_ONCE] Shifted only continuation prefixes left by one braille blank message=${message.id}`);
