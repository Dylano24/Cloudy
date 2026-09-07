import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const token = process.env.DISCORD_TOKEN;
const HANG = '\u2800\u2800\u2800';

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
  console.error('[ZORP_HANG_ONCE] Live ZORP embed not found');
  process.exit(0);
}

const embeds = message.embeds.map(embed => ({ ...embed }));
const source = { ...embeds[embedIndex] };
const fields = (source.fields || []).map(field => ({ ...field }));
const importantIndex = fields.findIndex(field => String(field?.name || '').toLowerCase().includes('important information'));
const removeIndex = fields.findIndex(field => String(field?.name || '').toLowerCase().includes('how to remove a zorp zone'));
if (importantIndex < 0 || removeIndex < 0) process.exit(0);

const marker = '<:W87205667glowingdotwhite:1543291335036108830>';
fields[importantIndex].value = [
  `${marker} ZORP zones expire after 24 hours.`,
  `${marker} The timer is automatically reset while`,
  `${HANG}the team is online.`,
  `${marker} A team cannot create a ZORP zone`,
  `${HANG}that overlaps with another team’s`,
  `${HANG}zone.`,
  `${marker} If a player switches teams, their`,
  `${HANG}existing ZORP zone will be removed`,
  `${HANG}to prevent abuse.`,
].join('\n');

fields[removeIndex].value = [
  'To delete an existing ZORP zone:',
  '',
  `${marker} Use \`Can I build around here?\``,
  `${marker} Select \`Good Bye\` to confirm the`,
  `${HANG}removal.`,
].join('\n');

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

console.log(`[ZORP_HANG_ONCE] Updated live ZORP hanging indent message=${message.id}`);
