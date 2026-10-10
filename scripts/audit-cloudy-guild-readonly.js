// One-shot, read-only Discord audit for Cloudy. Does not login a second gateway
// session, invoke interactions, post messages, update DB, or modify server data.
import { PermissionFlagsBits } from 'discord.js';

const guildId = String(process.env.GUILD_ID || '1532882647838228723').trim();
const token = String(process.env.DISCORD_TOKEN || process.env.CLOUDY_DISCORD_TOKEN || process.env.BOT_TOKEN || '').trim();
const apiBase = 'https://discord.com/api/v10';
if (!token) {
  console.error('Discord audit unavailable: bot token is not configured in GitHub Actions.');
  process.exit(2);
}
if (!/^\d{17,20}$/.test(guildId)) {
  console.error('Discord audit unavailable: invalid guild ID.');
  process.exit(2);
}
async function get(path) {
  const response = await fetch(apiBase + path, {
    headers: { Authorization: 'Bot ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Discord API request failed (' + response.status + ') at ' + path.replace(/\d{17,20}/g, '[id]'));
  return response.json();
}
function normalize(name = '') {
  const last = String(name).trim().toLowerCase().split(/[│｜]/u).at(-1);
  return last.normalize('NFKD').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function permissions(channel, member, roles, botId) {
  const all = roles.find(role => role.id === guildId);
  let value = BigInt(all?.permissions || '0');
  for (const role of roles) {
    if (member.roles.includes(role.id)) value |= BigInt(role.permissions || '0');
  }
  if ((value & PermissionFlagsBits.Administrator) !== 0n) return { view: true, history: true, send: true, embed: true, manageRoles: true };

  const overwrites = channel.permission_overwrites || [];
  function apply(deny, allow) {
    value &= ~deny;
    value |= allow;
  }
  const everyone = overwrites.find(o => o.id === guildId && o.type === 0);
  if (everyone) apply(BigInt(everyone.deny), BigInt(everyone.allow));
  let roleDeny = 0n, roleAllow = 0n;
  for (const over of overwrites) {
    if (over.type === 0 && member.roles.includes(over.id)) {
      roleDeny |= BigInt(over.deny);
      roleAllow |= BigInt(over.allow);
    }
  }
  apply(roleDeny, roleAllow);
  const me = overwrites.find(o => o.type === 1 && o.id === botId);
  if (me) apply(BigInt(me.deny), BigInt(me.allow));
  const has = bit => (value & bit) === bit;
  return {
    view: has(PermissionFlagsBits.ViewChannel),
    history: has(PermissionFlagsBits.ReadMessageHistory),
    send: has(PermissionFlagsBits.SendMessages),
    embed: has(PermissionFlagsBits.EmbedLinks),
    manageRoles: has(PermissionFlagsBits.ManageRoles),
  };
}
const aliases = {
  rustPatch: ['patch-notes', 'rust', 'rust-patch-notes'],
  nitradoPatch: ['nitrado-patch-notes', 'nitrado-updates', 'nitrado'],
  zorp: ['zorp-off-raid-protection'],
  tickets: ['ticket-logs', 'ticket-transcripts'],
  reports: ['reports'],
  botCommands: ['bot-commands'],
  rules: ['rules'],
  faq: ['faq'],
  welcome: ['welcome'],
  staffList: ['staff-list', 'staff-team'],
  support: ['contact-support', 'contact-us'],
  joinToCreate: ['join-for-create-set-it-up', 'join-for-create-and-set-it-up'],
};
const legacy = {
  rustPatch: '1533886914459861103',
  nitradoPatch: '1539397467647377530',
  zorp: '1533212973034770462',
  reports: '1554538663512248350',
};
try {
  const user = await get('/users/@me');
  const [guild, channels, roles, member] = await Promise.all([
    get('/guilds/' + guildId),
    get('/guilds/' + guildId + '/channels'),
    get('/guilds/' + guildId + '/roles'),
    get('/guilds/' + guildId + '/members/' + user.id),
  ]);
  const text = channels.filter(c => c.type === 0 || c.type === 5);
  const channelAudit = text.map(c => ({
    id: c.id,
    name: c.name,
    norm: normalize(c.name),
    permissions: permissions(c, member, roles, user.id),
  }));
  const results = {};
  for (const [key, names] of Object.entries(aliases)) {
    const id = legacy[key];
    const entry = (id && channelAudit.find(c => c.id === id))
      || channelAudit.find(c => names.includes(c.norm));
    results[key] = entry ? { found: true, name: entry.name, id: entry.id, permissions: entry.permissions } : { found: false };
  }
  const unableToRead = channelAudit.filter(c => !c.permissions.view || !c.permissions.history);
  const unableToPost = ['rustPatch', 'nitradoPatch'].filter(key => !results[key].found || !results[key].permissions.view || !results[key].permissions.send || !results[key].permissions.embed);
  const findings = [];
  for (const key of unableToPost) findings.push(key + ': no accessible channel with ViewChannel, SendMessages, EmbedLinks');
  if (!results.zorp.found) findings.push('ZORP: existing guide channel not found among accessible text channels');
  const report = {
    mode: 'read-only',
    guildId: guild.id,
    guildName: guild.name,
    botId: user.id,
    botRoleCount: member.roles.length,
    totalChannels: channels.length,
    textChannels: text.length,
    readableTextChannels: text.length - unableToRead.length,
    unreadableTextChannels: unableToRead.length,
    unreadableNames: unableToRead.map(c => ({ name: c.name, id: c.id })),
    destinations: results,
    findings,
  };
  console.log('CLOUDY_READONLY_AUDIT_START');
  console.log(JSON.stringify(report, null, 2));
  console.log('CLOUDY_READONLY_AUDIT_END');
  // Report issues as findings, not a failed CI; business logic tests remain separate.
  // No Discord changes are made by this script.
} catch (error) {
  console.error('Discord audit failed safely: ' + (error?.message || String(error)));
  process.exitCode = 1;
}
