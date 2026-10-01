const guildId = String(process.env.GUILD_ID || '1532882647838228723');
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');

const API = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, path, body) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
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
      throw new Error(`${method} ${path} -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  throw new Error('RATE_LIMIT');
}

function editableEmbed(source) {
  const data = {};
  for (const key of ['title', 'description', 'url', 'timestamp', 'color']) {
    if (source[key] !== undefined) data[key] = source[key];
  }
  if (source.author) data.author = {
    ...(source.author.name ? { name: source.author.name } : {}),
    ...(source.author.url ? { url: source.author.url } : {}),
    ...(source.author.icon_url ? { icon_url: source.author.icon_url } : {}),
  };
  if (source.footer) data.footer = {
    text: source.footer.text,
    ...(source.footer.icon_url ? { icon_url: source.footer.icon_url } : {}),
  };
  if (source.image?.url) data.image = { url: source.image.url };
  if (source.thumbnail?.url) data.thumbnail = { url: source.thumbnail.url };
  if (Array.isArray(source.fields)) {
    data.fields = source.fields.map(field => ({
      name: field.name,
      value: field.value,
      inline: Boolean(field.inline),
    }));
  }
  return data;
}

const me = await api('GET', '/users/@me');
const channels = await api('GET', `/guilds/${guildId}/channels`);
const gambling = channels.find(channel =>
  [0, 5].includes(channel.type)
  && String(channel.name || '').toLowerCase().includes('gambling')
);

if (!gambling) throw new Error('GAMBLING_CHANNEL_NOT_FOUND');

let before = null;
let scanned = 0;
let edited = 0;

for (let page = 0; page < 10; page += 1) {
  const query = new URLSearchParams({ limit: '100' });
  if (before) query.set('before', before);

  const messages = await api('GET', `/channels/${gambling.id}/messages?${query}`);
  if (!messages.length) break;

  for (const message of messages) {
    scanned += 1;
    if (message.author?.id !== me.id || !Array.isArray(message.embeds) || !message.embeds.length) continue;

    let changed = false;
    const embeds = message.embeds.map(raw => {
      const data = editableEmbed(raw);
      const title = String(data.title || '').replace(/\s+/g, ' ').trim();
      const normalized = title.toLowerCase();

      if (/^(blackjack|baccarat)\s*[—-]\s*bet\b/.test(normalized)) {
        if (data.color !== 0xFFFFFF) {
          data.color = 0xFFFFFF;
          changed = true;
        }
        if (data.thumbnail?.url !== LOGO) {
          data.thumbnail = { url: LOGO };
          changed = true;
        }
        return data;
      }

      const outcome = normalized.match(/^(blackjack|baccarat|roulette)\s+(win|loss|bust|push)$/);
      if (!outcome) return data;

      const status = outcome[2];
      const expectedColor = status === 'win'
        ? 0x00C49D
        : status === 'push'
          ? 0xFFFFFF
          : 0x7A1712;

      if (data.color !== expectedColor) {
        data.color = expectedColor;
        changed = true;
      }
      if (data.thumbnail?.url !== LOGO) {
        data.thumbnail = { url: LOGO };
        changed = true;
      }
      return data;
    });

    if (!changed) continue;

    await api('PATCH', `/channels/${gambling.id}/messages/${message.id}`, { embeds });
    edited += 1;
    console.log(JSON.stringify({ action: 'fixed', messageId: message.id, titles: embeds.map(embed => embed.title || null) }));
    await sleep(120);
  }

  before = messages.at(-1)?.id || null;
  if (messages.length < 100) break;
}

console.log(JSON.stringify({ complete: true, channelId: gambling.id, scanned, edited }));
