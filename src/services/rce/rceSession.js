// One live WebRCON connection to one Rust Console Edition game server.
//
// Keeps the connection open (reconnecting with growing pauses), polls the
// player list, server info and teams, turns console lines into events and
// hands everything to `handlers`. It never decides what Discord shows: that
// is rceGameplay.js.
import { createRconClient, RconError } from '../rustConsole/rconClient.js';
import { parseConsoleLine, parsePlayerList, parseServerInfo, parseTeamInfo } from './rceParser.js';
import { rceCommand } from './rceCommands.js';
import { playerKey } from './rceData.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import { assertPublicHost } from './rceNetwork.js';

export const SESSION_STATES = Object.freeze(['connecting', 'online', 'offline', 'stopped']);
const LINE_BUFFER = 100;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export const RCE_POLL = Object.freeze({
  playersMs: 30_000,
  infoMs: 60_000,
  teamsMs: 5 * 60_000,
  commandTimeoutMs: 10_000,
});

export class RceSession {
  constructor({ guildId, server, password, handlers = {}, createClient = createRconClient, now = () => Date.now(), log = defaultLogger, poll = RCE_POLL, WebSocketImpl, hostCheck = assertPublicHost }) {
    this.hostCheck = hostCheck;
    this.guildId = guildId;
    this.server = server;
    this.password = password;
    this.handlers = handlers;
    this.createClient = createClient;
    this.now = now;
    this.log = log;
    this.poll = poll;
    this.WebSocketImpl = WebSocketImpl;
    this.state = 'offline';
    this.lastError = null;
    this.connectedAt = null;
    this.lastSeenAt = null;
    this.failures = 0;
    this.players = new Map();
    this.playersKnown = false;
    this.info = null;
    this.teams = new Map();
    this.memberTeam = new Map();
    this.lines = [];
    this.rcon = null;
    this.timers = new Set();
    this.stopped = false;
    this.reconnectTimer = null;
  }

  get id() { return this.server.id; }
  get name() { return this.server.name; }
  get online() { return this.state === 'online'; }

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const rcon = this.rcon;
    this.rcon = null;
    try { rcon?.close?.(); } catch { /* closed */ }
    this.setState('stopped');
  }

  setState(state, error = null) {
    const previous = this.state;
    this.state = state;
    if (error !== undefined) this.lastError = error;
    if (previous !== state) {
      try { this.handlers.onState?.(this, state, previous); } catch (handlerError) { this.log.warn('[RCE] State handler failed:', handlerError?.message); }
    }
  }

  clearTimers() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }

  every(ms, task) {
    const timer = setInterval(() => { void task().catch(error => this.log.debug?.(`[RCE] Poll failed on ${this.name}: ${error?.message}`)); }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  async connect() {
    if (this.stopped) return;
    this.setState('connecting', null);
    let rcon;
    try {
      if (this.hostCheck) {
        try { await this.hostCheck(this.server.host); } catch (error) { throw new RconError(error?.message || 'Address not allowed.', 'invalid_config'); }
      }
      rcon = this.createClient({
        host: this.server.host, port: this.server.port, password: this.password, tls: this.server.tls,
        name: 'Cloudy', timeoutMs: this.poll.commandTimeoutMs,
        ...(this.WebSocketImpl ? { WebSocketImpl: this.WebSocketImpl } : {}),
      });
      this.rcon = rcon;
      rcon.onMessage(frame => this.handleFrame(frame));
      rcon.onClose?.(() => this.handleClose());
      await rcon.connect();
    } catch (error) {
      if (this.rcon === rcon) this.rcon = null;
      try { rcon?.close?.(); } catch { /* closed */ }
      this.failures += 1;
      const reason = error instanceof RconError ? error.code : 'connect_failed';
      this.setState('offline', reason === 'invalid_config' ? error.message : reason);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) { rcon.close?.(); return; }
    this.failures = 0;
    this.connectedAt = this.now();
    this.lastSeenAt = this.now();
    this.playersKnown = false;
    this.setState('online', null);
    this.log.info(`[RCE] Connected to ${this.name} (guild ${this.guildId})`);
    this.clearTimers();
    this.every(this.poll.playersMs, () => this.refreshPlayers());
    this.every(this.poll.infoMs, () => this.refreshInfo());
    this.every(this.poll.teamsMs, () => this.refreshTeams());
    void this.refreshPlayers().catch(() => undefined);
    void this.refreshInfo().catch(() => undefined);
    void this.refreshTeams().catch(() => undefined);
  }

  handleClose() {
    if (this.stopped) return;
    this.rcon = null;
    this.clearTimers();
    this.setState('offline', 'closed');
    this.log.warn(`[RCE] Connection to ${this.name} closed (guild ${this.guildId})`);
    this.scheduleReconnect(MIN_BACKOFF_MS);
  }

  scheduleReconnect(delay = null) {
    if (this.stopped || this.reconnectTimer) return;
    const wait = delay ?? Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(10, Math.max(0, this.failures - 1)));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, wait);
    this.reconnectTimer.unref?.();
  }

  /** Reconnects at once (staff asked for it). */
  reconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const rcon = this.rcon;
    this.rcon = null;
    this.clearTimers();
    try { rcon?.close?.(); } catch { /* closed */ }
    this.failures = 0;
    void this.connect();
  }

  /** Sends one command; throws RconError when the server is not connected. */
  async send(command) {
    if (!this.rcon || this.state !== 'online') throw new RconError(`${this.name} is not connected.`, 'offline');
    const reply = await this.rcon.send(command);
    this.lastSeenAt = this.now();
    return String(reply ?? '').replaceAll('\u0000', '').trim();
  }

  remember(line) {
    this.lines.push({ at: this.now(), line: line.slice(0, 500) });
    if (this.lines.length > LINE_BUFFER) this.lines.splice(0, this.lines.length - LINE_BUFFER);
  }

  handleFrame(frame) {
    this.lastSeenAt = this.now();
    const text = String(frame?.message ?? '').replaceAll('\u0000', '').trim();
    if (!text) return;
    // A frame may carry several console lines.
    for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      this.remember(line);
      let event;
      try { event = parseConsoleLine(line); } catch { event = null; }
      if (!event) continue;
      this.trackTeams(event);
      if (event.type === 'respawn' && event.platform) {
        const entry = this.players.get(playerKey(event.player));
        if (entry) entry.platform = event.platform;
      }
      this.emit(event);
    }
  }

  emit(event) {
    try {
      const result = this.handlers.onEvent?.(this, event);
      if (result?.catch) result.catch(error => this.log.warn(`[RCE] Event ${event.type} failed on ${this.name}:`, error?.message || error));
    } catch (error) {
      this.log.warn(`[RCE] Event ${event.type} failed on ${this.name}:`, error?.message || error);
    }
  }

  isOnline(name) {
    return this.players.has(playerKey(name));
  }

  onlinePlayer(name) {
    return this.players.get(playerKey(name)) || null;
  }

  async refreshPlayers() {
    const list = parsePlayerList(await this.send(rceCommand.playerList()));
    if (!list) return;
    const now = this.now();
    const next = new Map();
    for (const entry of list) {
      const key = playerKey(entry.name);
      const known = this.players.get(key);
      next.set(key, {
        name: entry.name, ping: entry.ping, health: entry.health,
        since: known?.since ?? (entry.connectedSeconds != null ? now - entry.connectedSeconds * 1000 : now),
        platform: known?.platform ?? null,
      });
    }
    const first = !this.playersKnown;
    const joined = [...next.keys()].filter(key => !this.players.has(key)).map(key => next.get(key));
    const left = [...this.players.keys()].filter(key => !next.has(key)).map(key => this.players.get(key));
    this.players = next;
    this.playersKnown = true;
    // The first list after connecting only learns who is online: no join spam.
    // Players who left while Cloudy was disconnected still end their session.
    if (first) {
      for (const player of left) this.emit({ type: 'leave', player: player.name, sessionMs: Math.max(0, now - (player.since || now)), at: now, quiet: true });
      this.emit({ type: 'playersKnown', players: [...next.values()] });
      return;
    }
    for (const player of joined) this.emit({ type: 'join', player: player.name, at: now });
    for (const player of left) this.emit({ type: 'leave', player: player.name, sessionMs: Math.max(0, now - (player.since || now)), at: now });
  }

  async refreshInfo() {
    const info = parseServerInfo(await this.send(rceCommand.serverInfo()));
    if (!info) return;
    this.info = { ...info, updatedAt: this.now() };
    this.emit({ type: 'info', info: this.info });
  }

  async refreshTeams() {
    const teams = parseTeamInfo(await this.send(rceCommand.teamInfo()));
    if (!teams) return;
    this.teams = new Map();
    this.memberTeam = new Map();
    for (const team of teams) {
      const entry = { id: team.id, leader: playerKey(team.leader), names: new Map() };
      for (const member of team.members) {
        entry.names.set(playerKey(member), member);
        this.memberTeam.set(playerKey(member), team.id);
      }
      this.teams.set(team.id, entry);
    }
  }

  trackTeams(event) {
    const add = (teamId, name, leader = null) => {
      const team = this.teams.get(teamId) || { id: teamId, leader: playerKey(leader || name), names: new Map() };
      team.names.set(playerKey(name), name);
      if (leader) team.names.set(playerKey(leader), leader);
      this.teams.set(teamId, team);
      this.memberTeam.set(playerKey(name), teamId);
      if (leader) this.memberTeam.set(playerKey(leader), teamId);
    };
    if (event.type === 'teamCreate') { this.removeFromTeam(event.player); add(event.team, event.player); }
    else if (event.type === 'teamJoin') { this.removeFromTeam(event.player); add(event.team, event.player, event.leader); }
    else if (event.type === 'teamLeave') { this.removeFromTeam(event.player); }
    else if (event.type === 'teamPromoted') {
      const team = this.teams.get(event.team);
      if (team) team.leader = playerKey(event.leader);
      else add(event.team, event.leader);
    }
  }

  removeFromTeam(name) {
    const key = playerKey(name);
    const teamId = this.memberTeam.get(key);
    if (!teamId) return;
    this.memberTeam.delete(key);
    const team = this.teams.get(teamId);
    if (!team) return;
    team.names.delete(key);
    if (!team.names.size) this.teams.delete(teamId);
    else if (team.leader === key) team.leader = team.names.keys().next().value;
  }

  teamOf(name) {
    const teamId = this.memberTeam.get(playerKey(name));
    return teamId ? this.teams.get(teamId) || null : null;
  }

  summary() {
    return {
      id: this.id, name: this.name, state: this.state, lastError: this.lastError,
      connectedAt: this.connectedAt, players: this.players.size, info: this.info,
    };
  }
}
