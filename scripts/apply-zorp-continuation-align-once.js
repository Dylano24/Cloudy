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
  const index = (candidate?.embeds || []).findIndex(embed =>
    /ZORP Guide/i.test(String(embed?.title || ''))
  );
  if (index >= 0) {
    message = candidate;
    embedIndex = index;
    break;
  }
}
if (!message || embedIndex < 0) {
  console.error('[ZORP_CONTINUATION_ALIGN_ONCE] Live ZORP Guide not found');
  process.exit(0);
}

const embeds = message.embeds.map(embed => ({ ...embed }));
const target = { ...embeds[embedIndex] };
const fields = (target.fields || []).map(field => ({ ...field }));
const bodies = new Set([
  'the team is online.',
  'that overlaps with another team’s',
  'zone.',
  'existing ZORP zone will be removed',
  'to prevent abuse.',
  'removal.',
]);
const strip = line => String(line || '').replace(/^(?:\u2063[\u2002\u2009\u200A]|[ \t\u00a0\u2002\u2009\u200A\u2800])+/u, '');
let canonicalPrefix = '';
for (const field of fields) {
  for (const line of String(field.value || '').split('\n')) {
    if (strip(line) === 'the team is online.') {
      canonicalPrefix = line.slice(0, line.length - strip(line).length);
      break;
    }
  }
  if (canonicalPrefix) break;
}
if (!canonicalPrefix) canonicalPrefix = '\u2800';

let changed = false;
for (const field of fields) {
  const lines = String(field.value || '').split('\n');
  field.value = lines.map(line => {
    const body = strip(line);
    if (!bodies.has(body)) return line;
    const next = canonicalPrefix + body;
    if (next !== line) changed = true;
    return next;
  }).join('\n');
}
if (!changed) {
  console.log('[ZORP_CONTINUATION_ALIGN_ONCE] All continuation lines already match');
  process.exit(0);
}

target.fields = fields;
embeds[embedIndex] = target;
const sendable = embed => {
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
};
await rest.patch(Routes.channelMessage(channelId, message.id), {
  body: { embeds: embeds.map(sendable) },
});
console.log(`[ZORP_CONTINUATION_ALIGN_ONCE] Normalized every continuation line message=${message.id}`);
