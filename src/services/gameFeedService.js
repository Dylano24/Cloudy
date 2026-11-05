// Game server feeds (owner's choice): the "feeds" channels (#pvp, #player,
// #zorp, #raids, #ban) and #wipe-feed get one embed per game event. The game
// server is not linked yet: whatever links it later (a server plugin, an RCON
// or Nitrado bridge) sends events to POST /api/game/v1/events (gameFeedApi.js).
// Embeds are plain objects so their colours stay exactly as set here.
import { feedEmoji, weaponEmoji } from './feedEmojiService.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_GREEN_COLOR, CLOUDY_NEUTRAL_COLOR, CLOUDY_RED_COLOR } from '../utils/embedColorPolicy.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from './cloudyChannelResolver.js';
import { recordKill, recordServerStatus, resetLeaderboard } from './gameServerBoardsService.js';

export const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
export const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const MAX_EVENTS_PER_REQUEST = 50;
const FLUSH_DELAY_MS = 1_500;
const EMBEDS_PER_MESSAGE = 10;

// Event type → channel (cloudyChannelResolver key) and the channel's name.
export const GAME_FEED_CHANNELS = Object.freeze({
  pvp: { key: 'pvp', name: '#pvp' },
  player: { key: 'player', name: '#player' },
  zorp: { key: 'zorpUpdates', name: '#zorp' },
  raid: { key: 'raids', name: '#raids' },
  ban: { key: 'banFeed', name: '#ban' },
  wipe: { key: 'wipeFeed', name: '#wipe-feed' },
});

class GameFeedError extends Error {}
const fail = message => { throw new GameFeedError(message); };

// Plain text only: no mentions, no markdown from the game server.
function text(value, max = 100) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[`*_~|<>@#\\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, max);
}
function required(value, field, max) {
  return text(value, max) || fail(`${field} is required`);
}
function whole(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? Math.round(number) : null;
}
function moment(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
const unix = ms => Math.floor(ms / 1000);
// An empty line in small text: a smaller gap than a normal empty line.
const SMALL_GAP = '-# \u200b';
// Short date and time (05/11/2026 13:26) so a line stays on one row next to the logo.
const shortMoment = ms => `<t:${unix(ms)}:s>`;

// Checks one incoming event and returns the clean version, or throws.
export function normalizeGameFeedEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('event must be an object');
  const type = String(raw.type || '').toLowerCase();
  if (!Object.hasOwn(GAME_FEED_CHANNELS, type) && type !== 'status') fail(`unknown type ${text(type, 20) || '(empty)'}`);
  const base = { type, server: required(raw.server, 'server', 60), time: moment(raw.time) || Date.now() };
  // status: no feed post; it updates #server-status and #population.
  if (type === 'status') {
    if (typeof raw.online !== 'boolean') fail('online must be true or false');
    return { ...base, online: raw.online, players: whole(raw.players, 0, 10_000), max: whole(raw.max, 0, 10_000),
      queue: whole(raw.queue, 0, 10_000), map: text(raw.map, 60) || null, nextWipe: moment(raw.nextWipe) };
  }
  if (type === 'pvp') {
    return { ...base, killer: required(raw.killer, 'killer', 60), victim: required(raw.victim, 'victim', 60),
      weapon: text(raw.weapon, 60) || null, distance: whole(raw.distance, 0, 10_000),
      headshot: raw.headshot === true, grid: text(raw.grid, 10) || null };
  }
  if (type === 'player') {
    const action = String(raw.action || '').toLowerCase();
    if (!['join', 'leave', 'kit'].includes(action)) fail('action must be join, leave or kit');
    return { ...base, action, player: required(raw.player, 'player', 60),
      online: whole(raw.online, 0, 10_000), max: whole(raw.max, 0, 10_000),
      platform: text(raw.platform, 30) || null,
      kit: action === 'kit' ? required(raw.kit, 'kit', 60) : null };
  }
  if (type === 'zorp') {
    const state = String(raw.state || '').toLowerCase();
    if (!['on', 'off'].includes(state)) fail('state must be on or off');
    return { ...base, state, player: required(raw.player, 'player', 60), grid: text(raw.grid, 10) || null };
  }
  if (type === 'raid') {
    return { ...base, attacker: required(raw.attacker, 'attacker', 60), target: text(raw.target, 60) || null,
      grid: text(raw.grid, 10) || null, item: text(raw.item, 60) || null };
  }
  if (type === 'ban') {
    const action = String(raw.action || 'ban').toLowerCase();
    if (!['ban', 'unban'].includes(action)) fail('action must be ban or unban');
    const discordId = value => (/^\d{17,20}$/.test(String(value ?? '')) ? String(value) : null);
    return { ...base, action, player: required(raw.player, 'player', 60), reason: text(raw.reason, 300) || null,
      duration: text(raw.duration, 40) || null, by: text(raw.by, 60) || null,
      discord: discordId(raw.discord), byDiscord: discordId(raw.byDiscord),
      bannedAt: moment(raw.bannedAt), expiresAt: moment(raw.expiresAt) };
  }
  const state = String(raw.state || '').toLowerCase();
  if (!['soon', 'done'].includes(state)) fail('state must be soon or done');
  const kind = String(raw.kind || '').toLowerCase();
  return { ...base, state, at: moment(raw.at), map: text(raw.map, 60) || null,
    kind: ['map', 'full'].includes(kind) ? kind : null, next: moment(raw.next),
    store: /^https:\/\/[^\s<>()\[\]]{4,200}$/.test(String(raw.store || '')) ? String(raw.store) : null };
}

// Player names are shown in a code block (owner's choice).
const name = value => `\`${value}\``;

function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const line = (label, value, emoji) => (value == null || value === '' ? null : `**${label}:** ${emoji ? `${feedEmoji(emoji)} ` : ''}${value}`);

// Classic feed layout (owner's choice): title, labelled lines with names in
// code, Time, the big Cloudy logo and the footer with the small logo.
function classicEmbed(title, color, lines, event, timeIcon) {
  return {
    title,
    description: [...lines, `${timeIcon ? `${feedEmoji('dot')} ` : ''}${line('Time', timeIcon ? shortMoment(event.time) : `<t:${unix(event.time)}:f>`)}`].filter(entry => entry != null).join('\n'),
    color,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  };
}

export function buildGameFeedEmbed(event) {
  const server = line('Server', event.server);
  const serverIcon = line('Server', event.server, 'server');
  switch (event.type) {
    case 'pvp':
      return classicEmbed('Player killed', CLOUDY_RED_COLOR, [
        line('Killer', name(event.killer), 'killer'), line('Victim', name(event.victim), 'victim'), line('Weapon', event.weapon && `${weaponEmoji(event.weapon) || feedEmoji('weapon')} ${event.weapon}`),
        line('Distance', event.distance == null ? null : `${event.distance} m`, 'distance'),
        event.headshot ? line('Headshot', feedEmoji('headshot')) : null,
        event.streak > 1 ? line('Killstreak', `🔥 ${event.streak}`) : null, serverIcon,
      ], event);
    case 'player':
      if (event.action === 'kit') {
        return classicEmbed('Kit claimed', CLOUDY_NEUTRAL_COLOR, [
          line('Player', name(event.player)), line('Kit', event.kit), server,
        ], event);
      }
      return classicEmbed(event.action === 'join' ? `${feedEmoji('login')} LOGIN` : `${feedEmoji('logout')} LOGOUT`,
        event.action === 'join' ? CLOUDY_GREEN_COLOR : CLOUDY_RED_COLOR, [
          line('Player', name(event.player)),
          event.platform ? line('Platform', feedEmoji(/xbox/i.test(event.platform) ? 'xbox' : 'console')) : null, server,
          line('Online', event.online == null ? null : event.max ? `${event.online}/${event.max}` : String(event.online)),
        ], event);
    case 'zorp':
      return classicEmbed(`${feedEmoji(event.state === 'on' ? 'on' : 'off')} ZORP`,
        event.state === 'on' ? CLOUDY_GREEN_COLOR : CLOUDY_RED_COLOR, [
          line('Player', name(event.player)),
          event.state === 'off' && event.protectedFor ? line('Protected for', duration(event.protectedFor)) : null, server,
        ], event);
    case 'raid':
      return classicEmbed('Raid alert', CLOUDY_RED_COLOR, [
        line('Raider', name(event.attacker)), line('Target', event.target ? name(event.target) : null),
        line('Used', event.item && `${weaponEmoji(event.item) ? `${weaponEmoji(event.item)} ` : ''}${event.item}`), server,
      ], event);
    case 'ban': {
      // Ban log (owner's choice, like the KAOSBOT ban-log in Cloudy style):
      // every line is an emoji and its value, no labels. Discord accounts are
      // tagged (without pinging); the times are relative.
      const banned = event.action === 'ban';
      const icon = (key, value) => (value == null || value === '' ? null : `${feedEmoji(key)} ${value}`);
      const since = banned ? event.time : event.bannedAt;
      const until = banned
        ? (event.expiresAt ? `<t:${unix(event.expiresAt)}:R>` : event.duration || 'Permanent')
        : `<t:${unix(event.time)}:R>`;
      const kind = banned ? (event.expiresAt || event.duration ? 'Tempban' : 'Permanent') : 'Unban';
      return {
        title: banned ? `${feedEmoji('ban')} BAN` : `${feedEmoji('unban')} UNBAN`,
        description: [
          icon('mention', event.discord ? `<@${event.discord}>` : null),
          icon('victim', name(event.player)),
          icon('timer', since ? `<t:${unix(since)}:R>` : null),
          icon('timer_off', until),
          icon('staff', event.byDiscord ? `<@${event.byDiscord}>` : event.by),
          icon('warning', event.reason),
          icon('server', `${event.server} · ${kind}`),
        ].filter(Boolean).join('\n'),
        color: banned ? CLOUDY_RED_COLOR : CLOUDY_GREEN_COLOR,
        thumbnail: { url: CLOUDY_C_LOGO_URL },
        footer: { text: CLOUDY_FOOTER },
      };
    }
    default: {
      const soon = event.state === 'soon';
      if (!soon) {
        const dot = feedEmoji('dot');
        return classicEmbed('Server wiped', CLOUDY_NEUTRAL_COLOR, [
          `**${event.server}** has just wiped!`,
          '',
          ...[line('Wipe', event.kind === 'full' ? 'Full wipe' : event.kind === 'map' ? 'Map wipe' : null),
            line('Map', event.map)].map(entry => (entry ? `${dot} ${entry}` : null)),
          '',
          '**How to play on this server?**',
          SMALL_GAP,
          `${dot} Open the community tab in Rust`,
          `${dot} Search for ${name(event.server)}`,
          '',
          '**Current wipe**',
          SMALL_GAP,
          `${dot} **Start:** ${shortMoment(event.time)}`,
          event.next ? `${dot} **End:** ${shortMoment(event.next)}` : null,
          event.store ? `\n**Store:** [Click here to view our packages](${event.store})` : null,
        ], event, true);
      }
      return classicEmbed(soon ? 'Wipe incoming' : 'Server wiped', CLOUDY_NEUTRAL_COLOR, [
        soon ? `**${event.server}** is about to wipe${event.at ? ` <t:${unix(event.at)}:R>` : ''}.`
          : `**${event.server}** just wiped.`,
        '',
        line('Wipe', event.kind === 'full' ? 'Full wipe' : event.kind === 'map' ? 'Map wipe' : null),
        line('Map', event.map),
        soon && event.at ? line('Wipe time', `<t:${unix(event.at)}:f>`) : null,
        line('Next wipe', event.next ? `<t:${unix(event.next)}:f>` : null),
      ], event);
    }
  }
}

// Killstreaks and ZORP protection time are kept in
// memory per server; a restart starts them again.
const streaks = new Map();
const zorpSince = new Map();

export function enrichGameFeedEvent(event) {
  const key = player => `${event.server}\u0000${player}`;
  if (event.type === 'pvp') {
    const streak = (streaks.get(key(event.killer)) || 0) + 1;
    streaks.set(key(event.killer), streak);
    streaks.delete(key(event.victim));
    return { ...event, streak };
  }
  if (event.type === 'zorp') {
    if (event.state === 'on') { zorpSince.set(key(event.player), event.time); return event; }
    const since = zorpSince.get(key(event.player));
    zorpSince.delete(key(event.player));
    return since ? { ...event, protectedFor: event.time - since } : event;
  }
  if (event.type === 'wipe' && event.state === 'done') {
    for (const streakKey of streaks.keys()) if (streakKey.startsWith(`${event.server}\u0000`)) streaks.delete(streakKey);
  }
  return event;
}

// Example events, used by /gamefeed preview.
export const SAMPLE_GAME_FEED_EVENTS = Object.freeze([
  { type: 'pvp', server: 'Darkzone South', killer: 'Dyn', victim: 'Dylano', weapon: 'Assault rifle', distance: 145, headshot: true, streak: 3 },
  { type: 'player', server: 'Darkzone South', action: 'join', player: 'Dylano', platform: 'Xbox Series' },
  { type: 'player', server: 'Darkzone South', action: 'leave', player: 'Dyn', platform: 'PlayStation 5' },
  { type: 'player', server: 'Darkzone South', action: 'kit', player: 'Cloudy', kit: 'Full Kit AK' },
  { type: 'zorp', server: 'Darkzone South', state: 'on', player: 'Dyn' },
  { type: 'zorp', server: 'Darkzone South', state: 'off', player: 'Dyn', protectedFor: 8_040_000 },
  { type: 'raid', server: 'Darkzone South', attacker: 'Dylano', target: 'Dyn', item: 'Rocket' },
  { type: 'ban', server: 'Darkzone South', action: 'ban', player: 'Dyn', reason: 'Raid in a red zone', by: 'Dylano', expiresAt: Date.now() + 3 * 86_400_000 },
  { type: 'ban', server: 'Darkzone South', action: 'unban', player: 'Cloudy', reason: 'Appeal accepted', by: 'Dylano', bannedAt: Date.now() - 4 * 86_400_000 },
  { type: 'wipe', server: 'Darkzone South', state: 'done', kind: 'map', map: 'Procedural 4000', next: Date.now() + 7 * 86_400_000 },
]);

// Embeds go out per channel in batches (up to 10 per message), so a busy
// kill feed stays within Discord's rate limits.
const queues = new Map();

function flush(channel) {
  const queue = queues.get(channel.id);
  if (!queue) return;
  clearTimeout(queue.timer);
  queue.timer = null;
  const embeds = queue.embeds.splice(0, EMBEDS_PER_MESSAGE);
  if (queue.embeds.length) schedule(channel, 0);
  else queues.delete(channel.id);
  if (!embeds.length) return;
  void channel.send({ embeds, allowedMentions: { parse: [] } })
    .catch(error => logger.warn(`Game feed post in ${channel.id} failed: ${error?.message || error}`));
}

function schedule(channel, delay = FLUSH_DELAY_MS) {
  const queue = queues.get(channel.id);
  if (!queue || queue.timer) return;
  queue.timer = setTimeout(() => flush(channel), delay);
  queue.timer.unref?.();
}

function enqueue(channel, embed) {
  const queue = queues.get(channel.id) || { embeds: [], timer: null };
  queues.set(channel.id, queue);
  queue.embeds.push(embed);
  if (queue.embeds.length >= EMBEDS_PER_MESSAGE) flush(channel);
  else schedule(channel);
}

async function primaryGuild(client) {
  const guildId = String(process.env.GUILD_ID || '').trim();
  return (guildId && client.guilds?.cache?.get?.(guildId)) || client.guilds?.cache?.first?.() || null;
}

// Found in Cloudy's channel cache (no Discord request per event): the
// owner's channel ID first (#pvp, #player, #zorp, #raids, #ban), else by name.
export async function gameFeedChannels(client) {
  const guild = await primaryGuild(client);
  const result = {};
  for (const [type, channel] of Object.entries(GAME_FEED_CHANNELS)) {
    const definition = getCloudyChannelDefinition(channel.key);
    const known = guild?.channels?.cache?.get?.(definition?.legacyId);
    result[type] = !guild ? null
      : known?.isTextBased?.() ? known
        : findCloudyChannelByAlias(guild, definition?.aliases || [], { textOnly: true });
  }
  return result;
}

// Accepts a batch of events; each is checked on its own. Returns what was
// accepted and why the others were not.
export async function postGameFeedEvents(client, rawEvents) {
  const events = Array.isArray(rawEvents) ? rawEvents.slice(0, MAX_EVENTS_PER_REQUEST) : [];
  const channels = await gameFeedChannels(client);
  let accepted = 0;
  const rejected = [];
  for (const [index, raw] of events.entries()) {
    try {
      const event = normalizeGameFeedEvent(raw);
      const guild = await primaryGuild(client);
      if (event.type === 'status') {
        if (!guild) fail('server not found');
        await recordServerStatus(client, guild, event);
        accepted += 1;
        continue;
      }
      const channel = channels[event.type];
      if (!channel?.send) fail(`${GAME_FEED_CHANNELS[event.type].name} channel not found`);
      enqueue(channel, buildGameFeedEmbed(enrichGameFeedEvent(event)));
      accepted += 1;
      // The leaderboard counts kills and starts again after a wipe.
      if (event.type === 'pvp') await recordKill(client, guild, event);
      if (event.type === 'wipe' && event.state === 'done') await resetLeaderboard(client, guild, event.server);
    } catch (error) {
      rejected.push({ index, error: error instanceof GameFeedError ? error.message : 'could not be posted' });
    }
  }
  return { accepted, rejected };
}

// Test helper.
export function clearGameFeedQueues() {
  for (const queue of queues.values()) clearTimeout(queue.timer);
  queues.clear();
}
