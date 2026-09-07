import { REST, Routes } from 'discord.js';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';

const channelId = '1533212973034770462';
const messageId = '1540279973691007048';
const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('[ZORP_ALIGN_ONCE] Missing DISCORD_TOKEN');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
const message = await rest.get(Routes.channelMessage(channelId, messageId));

const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
const targetIndex = embeds.findIndex(embed => {
  const fields = Array.isArray(embed?.fields) ? embed.fields : [];
  const hasImportant = fields.some(field => String(field?.name || '').trim().toLowerCase() === 'important information');
  const haystack = `${embed?.title || ''}\n${embed?.description || ''}`.toLowerCase();
  return hasImportant && haystack.includes('zorp');
});

if (targetIndex < 0) {
  console.error('[ZORP_ALIGN_ONCE] ZORP embed with Important information field not found');
  process.exit(1);
}

const source = embeds[targetIndex];
const fields = Array.isArray(source.fields) ? source.fields.map(field => ({ ...field })) : [];
const importantIndex = fields.findIndex(field => String(field?.name || '').trim().toLowerCase() === 'important information');

const before = String(fields[importantIndex].value || '');
const after = normalizeManualIndent(before);

if (after === before) {
  console.log('[ZORP_ALIGN_ONCE] Important information already aligned');
  process.exit(0);
}

fields[importantIndex].value = after;

function sendableEmbed(embed, nextFields) {
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
  if (nextFields?.length) out.fields = nextFields;
  return out;
}

const nextEmbeds = embeds.map((embed, index) =>
  sendableEmbed(embed, index === targetIndex ? fields : embed.fields),
);

await rest.patch(Routes.channelMessage(channelId, messageId), {
  body: { embeds: nextEmbeds },
});

console.log(`[ZORP_ALIGN_ONCE] Updated Important information alignment message=${messageId}`);
