// ZORP (Zone Offline Raid Protection) for Rust Console Edition, as the ZORP
// guide in Discord explains it:
// - the team leader uses "Can I build around here?" and confirms with "Yes";
//   "Goodbye" after "Can I build around here?" removes the zone;
// - white: just created; green: a team member is online (the base can be
//   raided); yellow: everyone went offline, protection starts soon; red: the
//   team is offline and the base is protected (no building damage);
// - a zone expires after 24 hours without anyone of the team online;
// - zones cannot overlap; when the leader leaves the team the zone is removed.
// The zone is a game custom zone (zones.createcustomzone), coloured and
// switched with zones.editcustomzone.
import { randomBytes } from 'node:crypto';
import { QUICK_CHAT_CODES, parsePosition, parseZoneList } from './rceParser.js';
import { rceCommand } from './rceCommands.js';
import { discordForPlayer, getLinks, getLists, getZones, mutateZones, playerKey } from './rceData.js';
import { getRceConfig } from './rceStore.js';
import { zorpEmbed } from './rceEmbeds.js';

const CONFIRM_MS = 60_000;
const WHITE_MS = 60_000;
const RECONCILE_MS = 10 * 60_000;
const PERSIST_ONLINE_MS = 5 * 60_000;
export const ZORP_COLORS = Object.freeze({ white: [255, 255, 255], green: [0, 255, 0], yellow: [255, 255, 0], red: [255, 0, 0] });

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function createZorp(runtime) {
  const { client, now } = runtime;
  const pending = new Map();
  const reconciledAt = new Map();
  const ticking = new Set();

  const pendingKey = (session, player) => `${session.guildId}:${session.id}:${playerKey(player)}`;

  async function teamFor(session, player) {
    let team = session.teamOf(player);
    if (!team) {
      await session.refreshTeams().catch(() => undefined);
      team = session.teamOf(player);
    }
    return team;
  }

  function zoneOfTeam(zones, team, player) {
    return Object.values(zones).find(zone => (team && zone.teamId === team.id) || zone.ownerKey === playerKey(player)) || null;
  }

  /** Handles the ZORP emotes; true when the emote was used for ZORP. */
  async function onQuickChat(session, config, event) {
    if (!config.zorp.enabled) return false;
    const key = pendingKey(session, event.player);
    if (event.code === QUICK_CHAT_CODES.canIBuild) {
      pending.set(key, now());
      const { zones } = await getZones(client, session.guildId, session.id);
      const team = await teamFor(session, event.player);
      const existing = zoneOfTeam(zones, team, event.player);
      await runtime.notify(session, event.player, 'zorp-ask', existing
        ? 'select Goodbye to remove your ZORP zone'
        : 'select Yes to create a ZORP zone here');
      return true;
    }
    if (event.code !== QUICK_CHAT_CODES.yes && event.code !== QUICK_CHAT_CODES.goodbye) return false;
    const askedAt = pending.get(key);
    if (!askedAt || now() - askedAt > CONFIRM_MS) return false;
    pending.delete(key);
    if (event.code === QUICK_CHAT_CODES.yes) await create(session, config, event.player);
    else await removeOwn(session, event.player);
    return true;
  }

  async function create(session, config, player) {
    const team = await teamFor(session, player);
    if (!team) return runtime.notify(session, player, 'zorp', 'you must be in a team to create a ZORP zone');
    if (team.leader !== playerKey(player)) return runtime.notify(session, player, 'zorp', 'only the team leader can create a ZORP zone');
    if (config.zorp.requireList) {
      const links = await getLinks(client, session.guildId);
      const discordId = discordForPlayer(links, player);
      const lists = await getLists(client, session.guildId);
      if (!discordId || !lists.zorp.includes(discordId)) return runtime.notify(session, player, 'zorp', 'you do not have access to ZORP on this server');
    }
    const { zones } = await getZones(client, session.guildId, session.id);
    if (zoneOfTeam(zones, team, player)) return runtime.notify(session, player, 'zorp', 'your team already has a ZORP zone');
    const reply = await runtime.command(session, rceCommand.printPosition(player));
    const position = reply == null ? null : parsePosition(reply);
    if (!position) return runtime.notify(session, player, 'zorp', 'your position could not be read, try again');
    const radius = config.zorp.radius;
    const clash = Object.values(zones).find(zone => distance(zone.position, position) < radius + (zone.radius || radius));
    if (clash) return runtime.notify(session, player, 'zorp', 'this spot overlaps another ZORP zone');
    const name = `ZORP_${randomBytes(3).toString('hex')}`;
    const created = await runtime.command(session, rceCommand.createZone(name, position, radius, { pvp: true, npcDamage: true, buildingDamage: true, building: true }));
    if (created == null) return runtime.notify(session, player, 'zorp', 'the ZORP zone could not be created, try again');
    await runtime.command(session, rceCommand.editZone(name, 'showarea', true));
    await runtime.command(session, rceCommand.editZone(name, 'color', ZORP_COLORS.white));
    const members = [...team.names.values()];
    const zone = {
      name, teamId: team.id, ownerKey: playerKey(player), ownerName: player, members, position, radius,
      createdAt: now(), state: 'white', lastOnlineAt: now(), savedOnlineAt: now(),
    };
    await mutateZones(client, session.guildId, session.id, state => { state.zones[name] = zone; });
    await runtime.say(session, `[ZORP] ${player}: your ZORP zone was created`);
    await runtime.post(session.guildId, 'zorp', zorpEmbed(session.name, 'created', zone, now()));
    return zone;
  }

  async function removeOwn(session, player) {
    const team = session.teamOf(player);
    const { zones } = await getZones(client, session.guildId, session.id);
    const zone = zoneOfTeam(zones, team, player);
    if (!zone) return runtime.notify(session, player, 'zorp', 'your team has no ZORP zone');
    if (zone.ownerKey !== playerKey(player) && team?.leader !== playerKey(player)) return runtime.notify(session, player, 'zorp', 'only the team leader can remove the ZORP zone');
    await removeZone(session.guildId, session.id, zone.name, session, 'removed');
    await runtime.say(session, `[ZORP] ${player}: your ZORP zone was removed`);
  }

  async function removeZone(guildId, serverId, name, session = null, reason = 'removed') {
    let removed = null;
    await mutateZones(client, guildId, serverId, state => {
      removed = state.zones[name] || null;
      delete state.zones[name];
    });
    if (session?.online) await runtime.command(session, rceCommand.deleteZone(name));
    if (removed) await runtime.post(guildId, 'zorp', zorpEmbed(session?.name || serverId, reason, removed, now()));
    return removed;
  }

  async function onTeamEvent(session, config, event) {
    if (!config.zorp.enabled) return;
    const { zones } = await getZones(client, session.guildId, session.id);
    if (!Object.keys(zones).length) return;
    if (event.type === 'teamLeave') {
      for (const zone of Object.values(zones)) {
        // A leader who leaves or switches team loses the zone (anti-abuse).
        if (zone.ownerKey === playerKey(event.player)) {
          await removeZone(session.guildId, session.id, zone.name, session, 'removed');
          await runtime.say(session, `[ZORP] ${event.player} left the team: the ZORP zone was removed`);
        } else if (zone.teamId === event.team && zone.members.some(member => playerKey(member) === playerKey(event.player))) {
          await mutateZones(client, session.guildId, session.id, state => {
            const current = state.zones[zone.name];
            if (current) current.members = current.members.filter(member => playerKey(member) !== playerKey(event.player));
          });
        }
      }
    } else if (event.type === 'teamPromoted') {
      const zone = Object.values(zones).find(entry => entry.teamId === event.team);
      if (zone) {
        await mutateZones(client, session.guildId, session.id, state => {
          const current = state.zones[zone.name];
          if (current) { current.ownerKey = playerKey(event.leader); current.ownerName = event.leader; }
        });
      }
    } else if (event.type === 'teamJoin') {
      const zone = Object.values(zones).find(entry => entry.teamId === event.team);
      if (zone && !zone.members.some(member => playerKey(member) === playerKey(event.player))) {
        await mutateZones(client, session.guildId, session.id, state => {
          const current = state.zones[zone.name];
          if (current) current.members = [...current.members, event.player].slice(0, 20);
        });
      }
    }
  }

  function desiredState(zone, anyOnline, zorp, at) {
    if (anyOnline) return zone.state === 'white' && at - zone.createdAt < WHITE_MS ? 'white' : 'green';
    const offlineFor = at - (zone.lastOnlineAt || zone.createdAt);
    if (offlineFor >= zorp.expiryHours * 3_600_000) return 'expired';
    if (zone.state === 'white' && at - zone.createdAt < WHITE_MS) return 'white';
    return offlineFor >= zorp.yellowMinutes * 60_000 ? 'red' : 'yellow';
  }

  async function applyState(session, zone, state) {
    const damage = state !== 'red';
    const color = ZORP_COLORS[state];
    const results = await Promise.all([
      runtime.command(session, rceCommand.editZone(zone.name, 'color', color)),
      runtime.command(session, rceCommand.editZone(zone.name, 'allowbuildingdamage', damage)),
    ]);
    return results.every(result => result != null);
  }

  async function tickServer(session, config = null) {
    const settings = config || await getRceConfig(client, session.guildId);
    if (!settings.zorp.enabled || !session.online || !session.playersKnown) return;
    const tickKey = `${session.guildId}:${session.id}`;
    if (ticking.has(tickKey)) return;
    ticking.add(tickKey);
    try {
      await reconcile(session);
      const { zones } = await getZones(client, session.guildId, session.id);
      const at = now();
      for (const zone of Object.values(zones)) {
        const team = session.teams.get(zone.teamId);
        const members = team ? [...team.names.values()] : zone.members;
        const anyOnline = members.some(member => session.isOnline(member));
        const state = desiredState(zone, anyOnline, settings.zorp, at);
        if (state === 'expired') {
          await removeZone(session.guildId, session.id, zone.name, session, 'expired');
          continue;
        }
        const changed = state !== zone.state;
        if (changed && !(await applyState(session, zone, state))) continue;
        const persistOnline = anyOnline && at - (zone.savedOnlineAt || 0) >= PERSIST_ONLINE_MS;
        if (changed || persistOnline || (team && team.names.size !== zone.members.length)) {
          await mutateZones(client, session.guildId, session.id, stored => {
            const current = stored.zones[zone.name];
            if (!current) return;
            current.state = state;
            if (anyOnline) { current.lastOnlineAt = at; current.savedOnlineAt = at; }
            if (team) current.members = members.slice(0, 20);
          });
        }
        if (changed && (state === 'red' || (state === 'green' && zone.state !== 'white'))) {
          await runtime.post(session.guildId, 'zorp', zorpEmbed(session.name, state === 'red' ? 'protected' : 'online', { ...zone, members }, at));
        }
      }
    } finally {
      ticking.delete(tickKey);
    }
  }

  // Zones that are gone in game (a wipe or a staff command) are forgotten.
  async function reconcile(session) {
    const key = `${session.guildId}:${session.id}`;
    if (now() - (reconciledAt.get(key) || 0) < RECONCILE_MS) return;
    reconciledAt.set(key, now());
    const reply = await runtime.command(session, rceCommand.listZones());
    const listed = reply == null ? null : parseZoneList(reply);
    if (!listed) return;
    const inGame = new Set(listed.map(zone => zone.name));
    await mutateZones(client, session.guildId, session.id, state => {
      for (const name of Object.keys(state.zones)) if (!inGame.has(name) && now() - state.zones[name].createdAt > RECONCILE_MS) delete state.zones[name];
    });
  }

  async function tickAll() {
    for (const session of runtime.sessions.values()) await tickServer(session).catch(() => undefined);
  }

  async function clearServer(guildId, serverId, session = null) {
    const { zones } = await getZones(client, guildId, serverId);
    for (const name of Object.keys(zones)) {
      if (session?.online) await runtime.command(session, rceCommand.deleteZone(name));
    }
    await mutateZones(client, guildId, serverId, state => { state.zones = {}; });
  }

  return { onQuickChat, onTeamEvent, tickServer, tickAll, removeZone, clearServer, create, desiredState };
}
