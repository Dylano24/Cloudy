const guildId = String(process.env.GUILD_ID || '1532882647838228723');
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');

const API = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}` };

async function get(path) {
  const response = await fetch(API + path, { headers });
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  return response.json();
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
console.log(JSON.stringify({ channelId: gambling.id, casino: casino.slice(0, 20) }));
