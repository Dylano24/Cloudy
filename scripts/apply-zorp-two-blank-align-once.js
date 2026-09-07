import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const token = process.env.DISCORD_TOKEN;
const HANG = '\u2800\u2800';
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
const continuationText = /^(the team is online\.|that overlaps with another team’s|zone\.|existing ZORP zone will be removed|to prevent abuse\.|removal\.)$/u;
let changed = false;

for (const field of fields) {
  const name = String(field?.name || '').toLowerCase();
  if (name !== 'important information' && name !== 'how to remove a zorp zone') continue;

  const lines = String(field.value || '').split('\n');
  const next = lines.map(line => {
    // Strip only leading spacing/invisible indentation for the known continuation
    // lines, then apply one exact two-braille prefix. The text itself is untouched.
    const body = line.replace(/^(?:\u2063[\u2002\u2009\u200A]|[ \t\u00a0\u2002\u2009\u200A\u2800])+/u, '');
    if (!continuationText.test(body)) return line;
    const aligned = `${HANG}${body}`;
    if (aligned !== line) changed = true;
    return aligned;
  });
  field.value = next.join('\n');
}

if (!changed) {
  console.log('[ZORP_ALIGN_ONCE] Continuation lines already use exact two-blank alignment');
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

console.log(`[ZORP_ALIGN_ONCE] Applied exact two-blank continuation alignment message=${message.id}`);
