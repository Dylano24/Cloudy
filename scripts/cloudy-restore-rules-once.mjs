
const GUILD = '1532882647838228723';
const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) throw new Error('MISSING_DISCORD_TOKEN');

const API = 'https://discord.com/api/v10';
const headers = {
  Authorization: `Bot ${token}`,
  'Content-Type': 'application/json',
};
const LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, path, body) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429) {
      const retry = await res.json().catch(() => ({}));
      await sleep(Math.ceil(Number(retry.retry_after || 1) * 1000) + 150);
      continue;
    }

    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  throw new Error('RATE_LIMIT');
}

function slug(name = '') {
  let value = String(name).toLowerCase();
  for (const sep of ['│', '｜', '|']) {
    if (value.includes(sep)) value = value.split(sep).at(-1);
  }
  return value.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const channels = await api('GET', `/guilds/${GUILD}/channels`);
const rules = channels.find(channel => [0, 5].includes(channel.type) && slug(channel.name) === 'rules');
if (!rules) throw new Error('RULES_CHANNEL_NOT_FOUND');

const current = await api('GET', `/channels/${rules.id}/messages?limit=100`);
const existing = current.find(message =>
  message.author?.bot
  && (message.embeds || []).some(embed => String(embed.title || '').replace(/^\s+|\s+$/g, '') === '☑️ In-Game Rules')
);

const description = [
  'Follow these rules to ensure a fair and balanced gameplay experience',
  '',
  '**Gameplay & Behavior**',
  '• Maximum 6 players per team and per base',
  '• Alliances allowed, maximum 6 players may fight, raid, or defend together',
  '• Griefing to prevent building is prohibited',
  '• No combat logging',
  '• No rocket PvP at Launch Site',
  '• No Entity Spam',
  '',
  '**ZORP**',
  '• No ZORP exploits',
  '• No ZORP-protected raid bases',
  '• No main base building inside another team’s ZORP',
  '• No raid bases inside the red ZORP when raiding a base in a green zone',
  '',
  '**Construction**',
  '• Maximum 1 main base per team',
  '• Maximum 1 TC line outside your ZORP',
  '• No building beyond your ZORP',
  '• Any base that remains 2x2 or smaller will be removed after 24h',
  '• Any abandoned or decaying base will be removed after 24h',
  '',
  '⚠️ Administrators reserve the right to remove any base that violates server rules',
].join('\n');

const payload = {
  embeds: [{
    title: '☑️ In-Game Rules',
    description,
    color: 0xFFFFFF,
    thumbnail: { url: LOGO },
    footer: { text: FOOTER },
  }],
};

let result;
if (existing) {
  result = await api('PATCH', `/channels/${rules.id}/messages/${existing.id}`, payload);
  console.error('RULES_RESTORED ' + JSON.stringify({ action: 'updated', channelId: rules.id, messageId: result.id }));
} else {
  result = await api('POST', `/channels/${rules.id}/messages`, payload);
  console.error('RULES_RESTORED ' + JSON.stringify({ action: 'created', channelId: rules.id, messageId: result.id }));
}

await sleep(3000);
