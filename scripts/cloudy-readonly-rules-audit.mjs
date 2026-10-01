
import { initializeDatabase, db, getFromDb } from '../src/utils/database.js';

const guildId = String(process.env.GUILD_ID || '1532882647838228723');
const token = String(process.env.DISCORD_TOKEN || '').trim();
const oldRulesChannelId = '1533189582064062564';

await initializeDatabase();

const registryKey = `cloudy:embed-registry:${guildId}`;
const registry = await getFromDb(registryKey, []);
const cloudyKeys = await db.list('cloudy:').catch(() => []);
const guildKeys = await db.list(`guild:${guildId}:`).catch(() => []);

const headers = { Authorization: `Bot ${token}` };
async function discordGet(path) {
  for (let i = 0; i < 8; i += 1) {
    const res = await fetch('https://discord.com/api/v10' + path, { headers });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise(r => setTimeout(r, Math.ceil(Number(body.retry_after || 1) * 1000) + 100));
      continue;
    }
    if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error('rate_limited');
}

const me = await discordGet('/users/@me');
const channels = await discordGet(`/guilds/${guildId}/channels`);
const rulesChannel = channels.find(c => {
  const name = String(c.name || '').toLowerCase();
  return [0,5].includes(c.type) && (name === 'rules' || name.endsWith('│rules') || name.endsWith('|rules') || name.includes('rules'));
});

let rulesMessages = [];
if (rulesChannel) {
  rulesMessages = await discordGet(`/channels/${rulesChannel.id}/messages?limit=100`);
}

const rulesRegistry = (Array.isArray(registry) ? registry : []).filter(record => {
  const search = JSON.stringify(record).toLowerCase();
  return String(record?.channelId || '') === oldRulesChannelId
    || String(record?.backingChannelId || '') === oldRulesChannelId
    || (rulesChannel && (String(record?.channelId || '') === rulesChannel.id || String(record?.backingChannelId || '') === rulesChannel.id))
    || search.includes('rules');
});

const keyMatches = [...(Array.isArray(cloudyKeys) ? cloudyKeys : Object.keys(cloudyKeys || {})),
  ...(Array.isArray(guildKeys) ? guildKeys : Object.keys(guildKeys || {}))]
  .filter(key => /rule/i.test(String(key)));

const messageSummary = rulesMessages.map(message => ({
  id: message.id,
  bot: message.author?.id === me.id,
  authorId: message.author?.id || null,
  timestamp: message.timestamp,
  content: String(message.content || '').slice(0, 1000),
  embeds: (message.embeds || []).map(embed => ({
    title: embed.title || null,
    description: String(embed.description || '').slice(0, 2500),
    color: Number.isInteger(embed.color) ? '#' + embed.color.toString(16).padStart(6, '0').toUpperCase() : null,
    fields: (embed.fields || []).map(field => ({
      name: field.name,
      value: String(field.value || '').slice(0, 1800),
    })),
    footer: embed.footer?.text || null,
    thumbnail: embed.thumbnail?.url || null,
    image: embed.image?.url || null,
  })),
}));

console.error('RULES_AUDIT ' + JSON.stringify({
  dbStatus: db.getStatus?.(),
  rulesChannel: rulesChannel ? { id: rulesChannel.id, name: rulesChannel.name, parentId: rulesChannel.parent_id } : null,
  currentMessageCountSample: rulesMessages.length,
  messages: messageSummary,
  rulesRegistry,
  ruleKeys: keyMatches,
}));
await new Promise(r => setTimeout(r, 3000));
