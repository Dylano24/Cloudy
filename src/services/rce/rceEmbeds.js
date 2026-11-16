// Discord embeds of the Rust Console Edition module, in the Cloudy style of
// the existing game feeds: white (or event-coloured) side line, the Cloudy
// logo as thumbnail, the Cloudy footer and player names in code.
import { feedEmoji } from '../feedEmojiService.js';
import { CLOUDY_GREEN_COLOR, CLOUDY_NEUTRAL_COLOR, CLOUDY_RED_COLOR, CLOUDY_YELLOW_COLOR } from '../../utils/embedColorPolicy.js';
import { KILLER_TYPES } from './rceParser.js';

export const RCE_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
export const RCE_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const RCE_COLORS = Object.freeze({ green: CLOUDY_GREEN_COLOR, red: CLOUDY_RED_COLOR, white: CLOUDY_NEUTRAL_COLOR, yellow: CLOUDY_YELLOW_COLOR });

// Plain text only: no mentions or markdown from the game server.
export function plain(value, max = 100) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/[`*_~|<>@\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export const code = value => `\`${plain(value, 60) || '?'}\``;
const unix = ms => Math.floor(ms / 1000);
const icon = key => { const emoji = feedEmoji(key); return emoji ? `${emoji} ` : ''; };
const line = (label, value, emojiKey = null) => (value == null || value === '' ? null : `**${label}:** ${emojiKey ? icon(emojiKey) : ''}${value}`);

export function rceEmbed(title, lines, { color = CLOUDY_NEUTRAL_COLOR, time = null, fields = null, image = null } = {}) {
  const description = [...lines, time ? line('Time', `<t:${unix(time)}:f>`) : null].filter(entry => entry != null).join('\n');
  return {
    title: plain(title, 240) ? String(title).slice(0, 256) : 'Cloudy',
    ...(description ? { description: description.slice(0, 4096) } : {}),
    color,
    thumbnail: { url: RCE_LOGO_URL },
    ...(fields?.length ? { fields: fields.slice(0, 25) } : {}),
    ...(image ? { image: { url: image } } : {}),
    footer: { text: RCE_FOOTER },
  };
}

export function statusEmbed(title, description, ok = true) {
  return rceEmbed(title, [description], { color: ok ? CLOUDY_GREEN_COLOR : CLOUDY_RED_COLOR });
}

const partyLabel = party => (party.type === KILLER_TYPES.player ? code(party.name) : plain(party.name, 60));

export function killEmbed(serverName, event, { streak = 0, bounty = 0 } = {}, now = Date.now()) {
  const pvp = event.killer.type === KILLER_TYPES.player && event.victim.type === KILLER_TYPES.player;
  const killedNpc = event.killer.type === KILLER_TYPES.player && event.victim.type !== KILLER_TYPES.player;
  return rceEmbed(`${icon('kill_skull')}Kill feed`, [
    line('Killer', partyLabel(event.killer), event.killer.type === KILLER_TYPES.player ? 'kill_killer' : null),
    line('Victim', partyLabel(event.victim), event.victim.type === KILLER_TYPES.player ? 'kill_victim' : null),
    pvp && streak >= 3 ? line('Killstreak', `${streak}`) : null,
    bounty ? line('Bounty claimed', bounty.toLocaleString('en-US')) : null,
    !pvp && !killedNpc ? line('Cause', event.killer.type === KILLER_TYPES.natural ? 'Natural' : event.killer.type === KILLER_TYPES.npc ? 'NPC' : 'Trap or entity') : null,
    line('Server', plain(serverName, 60), 'server'),
  ], { color: CLOUDY_RED_COLOR, time: now });
}

export function suicideEmbed(serverName, player, now = Date.now()) {
  return rceEmbed(`${icon('kill_skull')}Kill feed`, [
    line('Player', code(player)), line('Cause', 'Suicide'), line('Server', plain(serverName, 60), 'server'),
  ], { color: CLOUDY_RED_COLOR, time: now });
}

export function joinEmbed(serverName, player, { joined = true, online = null, max = null, platform = null, sessionMs = null } = {}, now = Date.now()) {
  return rceEmbed(joined ? `${icon('login')}Login` : `${icon('logout')}Logout`, [
    line('Player', code(player)),
    platform ? line('Platform', platform === 'xbox' ? 'Xbox' : 'PlayStation') : null,
    !joined && sessionMs ? line('Played', formatDuration(sessionMs)) : null,
    line('Server', plain(serverName, 60), 'server'),
    online != null ? line('Online', max ? `${online}/${max}` : String(online)) : null,
  ], { color: joined ? CLOUDY_GREEN_COLOR : CLOUDY_RED_COLOR, time: now });
}

export function chatEmbed(serverName, event, now = Date.now()) {
  const channel = { team: 'Team', local: 'Local', server: 'Server', global: 'Global' }[event.channel] || 'Chat';
  return rceEmbed(`${channel} chat`, [
    line('Player', code(event.player)),
    line('Message', plain(event.label, 200)),
    line('Server', plain(serverName, 60), 'server'),
  ], { color: event.channel === 'team' ? CLOUDY_GREEN_COLOR : CLOUDY_NEUTRAL_COLOR, time: now });
}

const EVENT_TEXT = Object.freeze({
  'Airdrop': 'A supply drop is on its way.',
  'Cargo Ship': 'The cargo ship has entered the map.',
  'Chinook': 'A Chinook is dropping a locked crate.',
  'Patrol Helicopter': 'The patrol helicopter is flying over the map.',
  'Halloween': 'The Halloween event has started.',
  'Christmas': 'The Christmas event has started.',
  'Easter': 'The Easter event has started.',
});

export function worldEventEmbed(serverName, eventName, now = Date.now()) {
  return rceEmbed(plain(eventName, 60), [
    EVENT_TEXT[eventName] || `${plain(eventName, 60)} has started.`,
    '',
    line('Server', plain(serverName, 60), 'server'),
  ], { color: CLOUDY_NEUTRAL_COLOR, time: now });
}

export function adminEmbed(serverName, title, lines, now = Date.now(), color = CLOUDY_NEUTRAL_COLOR) {
  return rceEmbed(title, [...lines, line('Server', plain(serverName, 60), 'server')], { color, time: now });
}

export function zorpEmbed(serverName, state, zone, now = Date.now()) {
  const titles = {
    created: [`${icon('on')}ZORP`, 'Zone created', CLOUDY_NEUTRAL_COLOR],
    online: [`${icon('on')}ZORP`, 'Team online: the zone can be raided', CLOUDY_GREEN_COLOR],
    yellow: [`${icon('off')}ZORP`, 'Team offline: protection starts soon', CLOUDY_YELLOW_COLOR],
    protected: [`${icon('off')}ZORP`, 'Team offline: the zone is protected', CLOUDY_RED_COLOR],
    removed: [`${icon('off')}ZORP`, 'Zone removed', CLOUDY_RED_COLOR],
    expired: [`${icon('off')}ZORP`, 'Zone expired', CLOUDY_RED_COLOR],
  }[state] || [`ZORP`, plain(state, 60), CLOUDY_NEUTRAL_COLOR];
  return rceEmbed(titles[0], [
    titles[1],
    '',
    line('Leader', code(zone.ownerName)),
    zone.members?.length ? line('Team', zone.members.slice(0, 8).map(code).join(', ')) : null,
    line('Server', plain(serverName, 60), 'server'),
  ], { color: titles[2], time: now });
}

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

export function serverStatusEmbed(session, now = Date.now()) {
  const info = session.info;
  const online = session.state === 'online';
  const dot = icon('dot');
  return rceEmbed('Server status', [
    `${icon(online ? 'online' : 'offline')}**${plain(session.name, 60)}** ${online ? 'Online' : session.state === 'connecting' ? 'Connecting' : 'Offline'}`,
    online ? `${dot}**Players:** ${info?.players ?? session.players.size}${info?.maxPlayers ? `/${info.maxPlayers}` : ''}` : null,
    online && info?.queued ? `${dot}**Queue:** ${info.queued}` : null,
    online && info?.joining ? `${dot}**Joining:** ${info.joining}` : null,
    online && info?.map ? `${dot}**Map:** ${plain(info.map, 60)}` : null,
    online && info?.gameTime ? `${dot}**Game time:** ${plain(info.gameTime, 40)}` : null,
    online && info?.uptime != null ? `${dot}**Uptime:** ${formatDuration(info.uptime * 1000)}` : null,
    online && info?.framerate != null ? `${dot}**FPS:** ${Math.round(info.framerate)}` : null,
    !online && session.lastError ? `${dot}**Last error:** ${plain(session.lastError, 80)}` : null,
  ], { color: online ? CLOUDY_GREEN_COLOR : CLOUDY_RED_COLOR, time: now });
}
