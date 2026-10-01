
const GUILD = process.env.GUILD_ID || '1532882647838228723';
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('NO_TOKEN');

const API = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, path, body) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 429) {
      const retry = await response.json().catch(() => ({}));
      await sleep(Math.ceil(Number(retry.retry_after || 1) * 1000) + 150);
      continue;
    }

    if (!response.ok) {
      throw new Error(`${method} ${path} ${response.status}: ${(await response.text()).slice(0, 250)}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  throw new Error('RATE_LIMIT');
}

function slug(name = '') {
  let value = String(name).toLowerCase();
  for (const separator of ['│', '｜', '|']) {
    if (value.includes(separator)) value = value.split(separator).at(-1);
  }
  return value.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isBlue(color) {
  if (!Number.isInteger(color)) return false;
  const red = (color >> 16) & 255;
  const green = (color >> 8) & 255;
  const blue = color & 255;
  return blue >= 120 && blue > red * 1.18 && blue > green * 1.06;
}

function editableEmbed(source) {
  const embed = {};
  for (const key of ['title', 'description', 'url', 'timestamp', 'color']) {
    if (source[key] !== undefined) embed[key] = source[key];
  }

  if (source.footer) {
    embed.footer = {
      text: source.footer.text,
      ...(source.footer.icon_url ? { icon_url: source.footer.icon_url } : {}),
    };
  }
  if (source.image?.url) embed.image = { url: source.image.url };
  if (source.thumbnail?.url) embed.thumbnail = { url: source.thumbnail.url };
  if (source.author) {
    embed.author = {
      ...(source.author.name ? { name: source.author.name } : {}),
      ...(source.author.url ? { url: source.author.url } : {}),
      ...(source.author.icon_url ? { icon_url: source.author.icon_url } : {}),
    };
  }
  if (Array.isArray(source.fields)) {
    embed.fields = source.fields.map(field => ({
      name: field.name,
      value: field.value,
      inline: Boolean(field.inline),
    }));
  }
  return embed;
}

console.log(JSON.stringify({ action: 'blue-audit-start', guildId: GUILD }));

const me = await api('GET', '/users/@me');
const channels = await api('GET', `/guilds/${GUILD}/channels`);
const categories = new Map(channels.filter(channel => channel.type === 4).map(channel => [channel.id, channel.name]));

const skipSlugs = new Set([
  'timeout-logs',
  'kick-logs',
  'ban-logs',
  'invitation-logs',
  'reports',
  'alert-activity',
  'payments-logs',
  'ticket-logs',
  'ticket-transcripts',
  'posted-reviews',
]);
const skipParents = new Set(['⇀ Owner ↼', '⇀ Tickets feed ↼']);

let channelsScanned = 0;
let scanned = 0;
let edited = 0;
let blueFixed = 0;
let logosAdded = 0;

for (const channel of channels.filter(channel => [0, 5].includes(channel.type))) {
  const channelSlug = slug(channel.name);
  if (skipSlugs.has(channelSlug) || skipParents.has(categories.get(channel.parent_id))) continue;

  channelsScanned += 1;
  let before = null;
  let seen = 0;

  while (seen < 10000) {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);

    const batch = await api('GET', `/channels/${channel.id}/messages?${query}`);
    if (!batch.length) break;

    for (const message of batch) {
      seen += 1;
      scanned += 1;

      if (message.author?.id !== me.id || !Array.isArray(message.embeds) || !message.embeds.length) continue;

      // Never rewrite user-created Embed Builder messages.
      if (message.embeds.some(embed => String(embed.footer?.text || '').endsWith('\u200B'))) continue;

      let changed = false;
      let fixedBlue = false;
      let addedLogo = false;

      const embeds = message.embeds.map(raw => {
        const embed = editableEmbed(raw);

        if (isBlue(embed.color)) {
          embed.color = 0xFFFFFF;
          changed = true;
          fixedBlue = true;
        }

        // Restore the Cloudy C on game messages, or alongside any neutralized
        // old blue system embed. Existing status colors are never changed.
        if (!embed.thumbnail?.url && (channelSlug === 'gambling' || fixedBlue)) {
          embed.thumbnail = { url: LOGO };
          changed = true;
          addedLogo = true;
        }

        return embed;
      });

      if (!changed) continue;

      await api('PATCH', `/channels/${channel.id}/messages/${message.id}`, { embeds });
      edited += 1;
      if (fixedBlue) blueFixed += 1;
      if (addedLogo) logosAdded += 1;

      console.log(JSON.stringify({
        action: 'normalized',
        channel: channel.name,
        messageId: message.id,
        blueFixed: fixedBlue,
        logoAdded: addedLogo,
      }));

      await sleep(120);
    }

    before = batch.at(-1)?.id || null;
    if (batch.length < 100) break;
  }
}

console.log(JSON.stringify({
  action: 'blue-audit-complete',
  channelsScanned,
  scanned,
  edited,
  blueFixed,
  logosAdded,
}));
