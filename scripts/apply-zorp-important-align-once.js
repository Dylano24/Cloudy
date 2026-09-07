import { REST, Routes } from 'discord.js';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';

const channelId = '1533212973034770462';
const messageId = '1540279973691007048';
const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('[ZORP_ALIGN_ONCE] Missing DISCORD_TOKEN');
  process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(token);
const message = await rest.get(Routes.channelMessage(channelId, messageId));
const embeds = Array.isArray(message?.embeds) ? message.embeds : [];

const targetIndex = embeds.findIndex(embed => {
  const haystack = `${embed?.title || ''}\n${embed?.description || ''}\n${JSON.stringify(embed?.fields || [])}`.toLowerCase();
  return haystack.includes('zorp') && haystack.includes('important information');
});

if (targetIndex < 0) {
  console.error('[ZORP_ALIGN_ONCE] Target embed not found; leaving message unchanged');
  process.exit(0);
}

const source = embeds[targetIndex];
let changed = false;
const next = { ...source };

const fields = Array.isArray(source.fields) ? source.fields.map(field => ({ ...field })) : [];
const importantIndex = fields.findIndex(field => String(field?.name || '').trim().toLowerCase() === 'important information');
if (importantIndex >= 0) {
  const before = String(fields[importantIndex].value || '');
  const after = normalizeManualIndent(before);
  if (after !== before) {
    fields[importantIndex].value = after;
    changed = true;
  }
  next.fields = fields;
}

if (importantIndex < 0 && typeof source.description === 'string') {
  const lines = source.description.split('\n');
  const start = lines.findIndex(line => /important information/i.test(line));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/how to remove a zorp zone/i.test(lines[i])) {
        end = i;
        break;
      }
    }
    const body = lines.slice(start + 1, end).join('\n');
    const normalized = normalizeManualIndent(body);
    if (normalized !== body) {
      next.description = [
        ...lines.slice(0, start + 1),
        ...normalized.split('\n'),
        ...lines.slice(end),
      ].join('\n');
      changed = true;
    }
  }
}

if (!changed) {
  console.log('[ZORP_ALIGN_ONCE] Important information already aligned');
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
await rest.patch(Routes.channelMessage(channelId, messageId), { body: { embeds: nextEmbeds } });
console.log(`[ZORP_ALIGN_ONCE] Updated Important information alignment message=${messageId}`);
