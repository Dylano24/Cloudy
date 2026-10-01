const guildId = String(process.env.GUILD_ID || '1532882647838228723');
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');

const API = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}` };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function get(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(API + path, { headers });
    if (response.status === 429) {
      const retry = await response.json().catch(() => ({}));
      await sleep(Math.ceil(Number(retry.retry_after || 1) * 1000) + 200);
      continue;
    }
    if (!response.ok) throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
    return response.json();
  }
  throw new Error(`${path} -> RATE_LIMIT`);
}

const me = await get('/users/@me');
const channels = await get(`/guilds/${guildId}/channels`);
const gambling = channels.find(channel =>
  [0, 5].includes(channel.type)
  && String(channel.name || '').toLowerCase().includes('gambling')
);
if (!gambling) throw new Error('GAMBLING_CHANNEL_NOT_FOUND');

const messages = await get(`/channels/${gambling.id}/messages?limit=100`);
const casino = [];
for (const message of messages) {
  if (message.author?.id !== me.id) continue;
  for (const embed of message.embeds || []) {
    const title = String(embed.title || '');
    if (!/^(blackjack|baccarat|roulette)/i.test(title)) continue;
    casino.push({
      messageId: message.id,
      title,
      color: Number.isInteger(embed.color)
        ? '#' + embed.color.toString(16).padStart(6, '0').toUpperCase()
        : null,
      thumbnail: embed.thumbnail?.url || null,
      timestamp: message.timestamp,
    });
  }
}
console.error('CASINO_VERIFY ' + JSON.stringify({ channelId: gambling.id, casino: casino.slice(0, 20) }));
await sleep(5000);
