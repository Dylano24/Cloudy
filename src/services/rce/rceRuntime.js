// The Rust Console Edition module at run time: one RceSession per connected
// game server of every Discord server, and everything that happens with their
// events — Discord feeds, player statistics, economy rewards, account links,
// emote actions (kits, items, teleports), bounties, the Discord shop,
// automatic in-game messages, the status board, ZORP and store deliveries.
import { randomInt } from 'node:crypto';
import { logger as defaultLogger } from '../../utils/logger.js';
import EconomyService from '../economyService.js';
import { RconError } from '../rustConsole/rconClient.js';
import { RceSession } from './rceSession.js';
import { KILLER_TYPES, QUICK_CHAT, QUICK_CHAT_CODES, quickChatLabel } from './rceParser.js';
import { RceCommandError, rceCommand, renderCommandTemplate } from './rceCommands.js';
import {
  appliesTo, getRceConfig, isHomeGuild, onRceConfigChange, openSecret, rceGuildIds, rcePlanAllows,
} from './rceStore.js';
import {
  createStatsStore, discordForPlayer, getBounties, getLinks, getLists, linkForDiscord, mutateBounties,
  mutateData, mutateLists, playerKey, readData, releaseCooldown, setLink, takeCooldown,
} from './rceData.js';
import {
  adminEmbed, chatEmbed, code, joinEmbed, killEmbed, plain, rceEmbed, serverStatusEmbed, suicideEmbed, worldEventEmbed, RCE_COLORS,
} from './rceEmbeds.js';
import { createZorp } from './rceZorp.js';
import { createDeliveries } from './rceDelivery.js';
import { getCloudyChannelDefinition, findCloudyChannelByAlias } from '../cloudyChannelResolver.js';
import { recordKill, recordServerStatus } from '../gameServerBoardsService.js';
import { safePlayerName } from './rceCommands.js';

const FLUSH_DELAY_MS = 1_500;
const EMBEDS_PER_MESSAGE = 10;
const LINK_TTL_MS = 10 * 60_000;
const LINK_EMOTES = Object.freeze([
  'd11_quick_chat_responses_slot_0', 'd11_quick_chat_responses_slot_1', 'd11_quick_chat_responses_slot_2',
  'd11_quick_chat_responses_slot_3', 'd11_quick_chat_responses_slot_4', 'd11_quick_chat_responses_slot_5',
  'd11_quick_chat_responses_slot_7',
]);
const NOTICE_COOLDOWN_MS = 60_000;

// Home server fallback: the existing feed channels (owner's #pvp, #player, #zorp).
const HOME_FALLBACK = Object.freeze({ killfeed: 'pvp', joins: 'player', zorp: 'zorpUpdates' });

let instance = null;

export function getRceRuntime() {
  return instance;
}

export function createRceRuntime(client, { now = () => Date.now(), log = defaultLogger, sessionFactory = null, economy = EconomyService } = {}) {
  const sessions = new Map();
  const stats = createStatsStore(client, { now, log });
  const queues = new Map();
  const pendingLinks = new Map();
  const notices = new Map();
  const automessageSent = new Map();
  const statusMessages = new Map();
  const timers = new Set();
  const offlineSince = new Map();
  let started = false;
  let unsubscribe = null;

  const sessionKey = (guildId, serverId) => `${guildId}:${serverId}`;
  const guildOf = guildId => client.guilds?.cache?.get?.(guildId) || null;

  const runtime = {
    client, stats, sessions, now, log, economy,
    session: (guildId, serverId) => sessions.get(sessionKey(guildId, serverId)) || null,
    guildSessions: guildId => [...sessions.values()].filter(session => session.guildId === guildId),
  };

  // ---------------------------------------------------------- Discord output

  function feedChannel(guildId, config, type) {
    const guild = guildOf(guildId);
    if (!guild) return null;
    const configured = config.channels?.[type];
    if (configured) {
      const channel = guild.channels?.cache?.get?.(configured);
      return channel?.isTextBased?.() ? channel : null;
    }
    if (isHomeGuild(guildId) && HOME_FALLBACK[type]) {
      const definition = getCloudyChannelDefinition(HOME_FALLBACK[type]);
      const known = guild.channels?.cache?.get?.(definition?.legacyId);
      if (known?.isTextBased?.()) return known;
      return findCloudyChannelByAlias(guild, definition?.aliases || [], { textOnly: true });
    }
    return null;
  }

  function flush(channel) {
    const queue = queues.get(channel.id);
    if (!queue) return undefined;
    clearTimeout(queue.timer);
    queue.timer = null;
    const embeds = queue.embeds.splice(0, EMBEDS_PER_MESSAGE);
    if (queue.embeds.length) queue.timer = setTimeout(() => flush(channel), 250);
    else queues.delete(channel.id);
    if (!embeds.length) return undefined;
    return channel.send({ embeds, allowedMentions: { parse: [] } })
      .catch(error => log.warn(`[RCE] Feed post in ${channel.id} failed: ${error?.message || error}`));
  }

  /** Sends every waiting feed post now (shutdown and tests). */
  runtime.flushFeeds = async () => {
    const sends = [];
    for (const queue of [...queues.values()]) while (queues.has(queue.channel.id)) sends.push(flush(queue.channel));
    await Promise.all(sends);
  };

  async function post(guildId, type, embed) {
    const config = await getRceConfig(client, guildId);
    const channel = feedChannel(guildId, config, type);
    if (!channel?.send) return false;
    const queue = queues.get(channel.id) || { embeds: [], timer: null, channel };
    queues.set(channel.id, queue);
    queue.embeds.push(embed);
    if (queue.embeds.length >= EMBEDS_PER_MESSAGE) flush(channel);
    else if (!queue.timer) { queue.timer = setTimeout(() => flush(channel), FLUSH_DELAY_MS); queue.timer.unref?.(); }
    return true;
  }
  runtime.post = post;

  /** Sends a command; returns the reply, or null (and logs) when the server is not reachable. */
  async function command(session, line) {
    try {
      return await session.send(line);
    } catch (error) {
      log.debug?.(`[RCE] Command on ${session.name} failed: ${error?.message}`);
      return null;
    }
  }
  runtime.command = command;

  async function say(session, text) {
    try { return await command(session, rceCommand.say(text)); } catch { return null; }
  }
  runtime.say = say;

  /** A short in-game notice for one player, at most once a minute per player and topic. */
  async function notify(session, player, topic, text) {
    const key = `${session.guildId}:${session.id}:${playerKey(player)}:${topic}`;
    const last = notices.get(key) || 0;
    if (now() - last < NOTICE_COOLDOWN_MS) return;
    notices.set(key, now());
    if (notices.size > 5_000) notices.delete(notices.keys().next().value);
    await say(session, `[Cloudy] ${player}: ${text}`);
  }
  runtime.notify = notify;

  // ---------------------------------------------------------- sessions

  async function syncGuild(guildId) {
    let config;
    try { config = await getRceConfig(client, guildId, { fresh: true }); } catch (error) {
      log.warn(`[RCE] Could not read the settings of guild ${guildId}:`, error?.message);
      return;
    }
    const allowed = Boolean(guildOf(guildId)) && await rcePlanAllows(client, guildId, now()).catch(() => false);
    const wanted = new Map();
    if (allowed) for (const server of config.servers) if (server.enabled) wanted.set(server.id, server);
    for (const session of runtime.guildSessions(guildId)) {
      const next = wanted.get(session.id);
      const same = next && next.host === session.server.host && next.port === session.server.port && next.tls === session.server.tls
        && JSON.stringify(next.password) === JSON.stringify(session.server.password);
      if (!same) {
        session.stop();
        sessions.delete(sessionKey(guildId, session.id));
      } else {
        session.server = next;
      }
    }
    for (const [serverId, server] of wanted) {
      if (sessions.has(sessionKey(guildId, serverId))) continue;
      const password = openSecret(server.password);
      if (!password) {
        log.warn(`[RCE] The RCON password of ${server.name} (guild ${guildId}) cannot be read; enter it again with /rce server edit.`);
        continue;
      }
      const session = sessionFactory
        ? sessionFactory({ guildId, server, password, handlers })
        : new RceSession({ guildId, server, password, handlers, now, log });
      sessions.set(sessionKey(guildId, serverId), session);
      session.start();
    }
  }
  runtime.syncGuild = syncGuild;

  const handlers = {
    onEvent: (session, event) => handleEvent(session, event),
    onState: (session, state, previous) => { void handleState(session, state, previous); },
  };

  async function handleState(session, state, previous) {
    const key = sessionKey(session.guildId, session.id);
    if (state === 'online') {
      const since = offlineSince.get(key);
      offlineSince.delete(key);
      if (since && now() - since >= 60_000) {
        await post(session.guildId, 'admin', adminEmbed(session.name, 'Server connected', ['Cloudy is connected to the game server again.'], now(), RCE_COLORS.green));
      }
    } else if (previous === 'online' && state === 'offline') {
      offlineSince.set(key, now());
      await post(session.guildId, 'admin', adminEmbed(session.name, 'Server disconnected', ['The connection to the game server was lost. Cloudy reconnects automatically.'], now(), RCE_COLORS.red));
    } else if (state === 'offline' && !offlineSince.has(key)) {
      offlineSince.set(key, now());
    }
  }

  // ---------------------------------------------------------- events

  async function handleEvent(session, event) {
    const guildId = session.guildId;
    const config = await getRceConfig(client, guildId);
    switch (event.type) {
      case 'kill': return onKill(session, config, event);
      case 'suicide': return onSuicide(session, config, event);
      case 'join': return onJoin(session, config, event);
      case 'leave': return onLeave(session, config, event);
      case 'respawn': return stats.mutate(guildId, session.id, (_state, player) => {
        const entry = player(event.player);
        if (entry) { entry.lastSeen = now(); if (event.platform) entry.platform = event.platform; }
      });
      case 'chat': return onChat(session, config, event);
      case 'note': return onNote(session, config, event);
      case 'worldEvent': return onWorldEvent(session, config, event);
      case 'kit': return post(guildId, 'admin', adminEmbed(session.name, 'Kit given', [`**Player:** ${code(event.player)}`, `**Kit:** ${plain(event.kit, 40)}`, event.by ? `**By:** ${code(event.by)}` : null].filter(Boolean), now()));
      case 'item': return post(guildId, 'admin', adminEmbed(session.name, 'Item given', [`**Player:** ${code(event.player)}`, `**Item:** ${event.amount} x ${plain(event.item, 60)}`], now()));
      case 'ban': return post(guildId, 'admin', adminEmbed(session.name, 'Player banned', [`**Player:** ${code(event.player)}`, event.by ? `**By:** ${code(event.by)}` : null].filter(Boolean), now(), RCE_COLORS.red));
      case 'unban': return post(guildId, 'admin', adminEmbed(session.name, 'Player unbanned', [`**Player:** ${code(event.player)}`, event.by ? `**By:** ${code(event.by)}` : null].filter(Boolean), now(), RCE_COLORS.green));
      case 'roleAdd':
      case 'roleRemove': return post(guildId, 'admin', adminEmbed(session.name, event.type === 'roleAdd' ? 'Role added' : 'Role removed', [`**Player:** ${code(event.player)}`, `**Role:** ${plain(event.role, 40)}`], now()));
      case 'teamCreate':
      case 'teamJoin':
      case 'teamLeave':
      case 'teamPromoted': return zorp.onTeamEvent(session, config, event);
      case 'info': return onInfo(session, config, event);
      case 'playersKnown': return zorp.tickServer(session, config).catch(() => undefined);
      default: return undefined;
    }
  }

  async function onKill(session, config, event) {
    const { killer, victim } = event;
    const pvp = killer.type === KILLER_TYPES.player && victim.type === KILLER_TYPES.player && playerKey(killer.name) !== playerKey(victim.name);
    let streak = 0;
    await stats.mutate(session.guildId, session.id, (_state, player) => {
      if (victim.type === KILLER_TYPES.player) {
        const entry = player(victim.name);
        if (entry) { entry.deaths += 1; entry.streak = 0; entry.lastSeen = now(); if (pvp) entry.deathsByPlayer += 1; }
      }
      if (killer.type === KILLER_TYPES.player) {
        const entry = player(killer.name);
        if (!entry) return;
        entry.lastSeen = now();
        if (pvp) {
          entry.kills += 1;
          entry.streak += 1;
          entry.bestStreak = Math.max(entry.bestStreak, entry.streak);
          streak = entry.streak;
        } else if (victim.type !== KILLER_TYPES.player) {
          entry.npcKills += 1;
        }
      }
    });
    const bounty = pvp ? await claimBounty(session, config, killer.name, victim.name) : 0;
    if (pvp || config.settings.killfeedMode === 'all') {
      await post(session.guildId, 'killfeed', killEmbed(session.name, event, { streak, bounty }, now()));
    }
    if (pvp && config.settings.ingameKillfeed) await say(session, `${killer.name} killed ${victim.name}${streak >= 3 ? ` (${streak} streak)` : ''}`);
    // Economy rewards for linked players.
    const reward = pvp ? config.settings.rewards.kill : (killer.type === KILLER_TYPES.player && victim.type !== KILLER_TYPES.player ? config.settings.rewards.npcKill : 0);
    if (reward > 0) await rewardPlayer(session.guildId, killer.name, reward, pvp ? 'rce:kill' : 'rce:npc-kill');
    // The leaderboards of Cloudy's own server keep working from real kills.
    if (pvp && isHomeGuild(session.guildId) && guildOf(session.guildId)) {
      await recordKill(client, guildOf(session.guildId), { server: session.name, killer: killer.name, victim: victim.name }).catch(() => undefined);
    }
  }

  async function onSuicide(session, config, event) {
    await stats.mutate(session.guildId, session.id, (_state, player) => {
      const entry = player(event.player);
      if (entry) { entry.suicides += 1; entry.streak = 0; entry.lastSeen = now(); }
    });
    if (config.settings.killfeedMode === 'all') await post(session.guildId, 'killfeed', suicideEmbed(session.name, event.player, now()));
  }

  async function onJoin(session, config, event) {
    const online = session.players.get(playerKey(event.player));
    await stats.mutate(session.guildId, session.id, (_state, player) => {
      const entry = player(event.player);
      if (entry) { entry.lastSeen = now(); if (online?.platform) entry.platform = online.platform; }
    });
    await post(session.guildId, 'joins', joinEmbed(session.name, event.player, { joined: true, online: session.players.size, max: session.info?.maxPlayers, platform: online?.platform }, now()));
    if (config.settings.ingameJoins) await say(session, `${event.player} joined the server`);
    if (config.settings.welcomeMessage) await say(session, config.settings.welcomeMessage.split('{player}').join(event.player));
    await deliveries.onPlayerOnline(session, event.player).catch(error => log.warn('[RCE] Delivery check failed:', error?.message));
    await zorp.tickServer(session, config).catch(() => undefined);
  }

  async function onLeave(session, config, event) {
    await stats.mutate(session.guildId, session.id, (_state, player) => {
      const entry = player(event.player);
      if (entry) { entry.playtimeMs += event.sessionMs || 0; entry.lastSeen = now(); }
    });
    if (event.quiet) return;
    await post(session.guildId, 'joins', joinEmbed(session.name, event.player, { joined: false, online: session.players.size, max: session.info?.maxPlayers, sessionMs: event.sessionMs }, now()));
    if (config.settings.ingameJoins) await say(session, `${event.player} left the server`);
    await zorp.tickServer(session, config).catch(() => undefined);
  }

  async function onWorldEvent(session, config, event) {
    await post(session.guildId, 'events', worldEventEmbed(session.name, event.event, now()));
    if (config.settings.ingameEvents) await say(session, `${event.event} has started`);
  }

  async function onInfo(session, config, event) {
    if (isHomeGuild(session.guildId)) {
      const guild = guildOf(session.guildId);
      if (guild) {
        await recordServerStatus(client, guild, {
          server: session.name, online: true, players: event.info.players ?? session.players.size,
          max: event.info.maxPlayers, queue: event.info.queued, map: event.info.map, nextWipe: null,
        }).catch(() => undefined);
      }
    }
  }

  async function onChat(session, config, event) {
    // Cloudy's own in-game messages come back as SERVER chat: never post those.
    if (/^(?:SERVER|\[?Cloudy\]?)$/i.test(event.player)) return;
    await post(session.guildId, 'chat', chatEmbed(session.name, event, now()));
    if (await checkLinkProgress(session, event.player, { code: event.code, text: event.message })) return;
    if (!event.code) return;
    if (await zorp.onQuickChat(session, config, event)) return;
    await runEmoteActions(session, config, event);
  }

  async function onNote(session, config, event) {
    await checkLinkProgress(session, event.player, { text: event.text });
  }

  // ---------------------------------------------------------- economy

  async function rewardPlayer(guildId, gamertag, amount, source) {
    const links = await getLinks(client, guildId);
    const discordId = discordForPlayer(links, gamertag);
    if (!discordId || amount <= 0) return false;
    try {
      await economy.addMoney(client, guildId, discordId, amount, source);
      return true;
    } catch (error) {
      log.warn('[RCE] Reward failed:', error?.message);
      return false;
    }
  }
  runtime.rewardPlayer = rewardPlayer;

  async function playtimeRewards() {
    for (const session of sessions.values()) {
      if (!session.online || !session.players.size) continue;
      const config = await getRceConfig(client, session.guildId).catch(() => null);
      const perHour = config?.settings?.rewards?.playtimeHour || 0;
      if (!perHour) continue;
      // Paid every 10 minutes: a sixth of the hourly reward.
      const amount = Math.floor(perHour / 6);
      if (amount < 1) continue;
      const links = await getLinks(client, session.guildId);
      for (const player of session.players.values()) {
        const discordId = discordForPlayer(links, player.name);
        if (!discordId) continue;
        await economy.addMoney(client, session.guildId, discordId, amount, 'rce:playtime').catch(() => undefined);
      }
    }
  }

  // ---------------------------------------------------------- bounties

  async function claimBounty(session, config, killerName, victimName) {
    if (!config.settings.bounties) return 0;
    const bounties = await getBounties(client, session.guildId);
    const entry = bounties[playerKey(victimName)];
    if (!entry?.total) return 0;
    // Teammates cannot claim each other's bounty.
    const killerTeam = session.teamOf(killerName);
    if (killerTeam && killerTeam.names.has(playerKey(victimName))) return 0;
    const links = await getLinks(client, session.guildId);
    const discordId = discordForPlayer(links, killerName);
    if (!discordId) {
      await notify(session, killerName, 'bounty', `link your account with /rust link to claim bounties`);
      return 0;
    }
    const total = await mutateBounties(client, session.guildId, state => {
      const current = state[playerKey(victimName)];
      if (!current?.total) return 0;
      // A bounty placed by the killer goes back to them, it is not a reward.
      delete state[playerKey(victimName)];
      return current.total;
    });
    if (!total) return 0;
    await economy.addMoney(client, session.guildId, discordId, total, 'rce:bounty').catch(error => log.warn('[RCE] Bounty payout failed:', error?.message));
    await say(session, `${killerName} claimed the bounty of ${total.toLocaleString('en-US')} on ${victimName}`);
    return total;
  }

  async function placeBounty(guildId, discordId, target, amount) {
    const config = await getRceConfig(client, guildId);
    if (!config.settings.bounties) throw new Error('Bounties are turned off in this server.');
    if (!Number.isInteger(amount) || amount < config.settings.bountyMin) throw new Error(`The minimum bounty is ${config.settings.bountyMin.toLocaleString('en-US')}.`);
    const name = plain(target, 32);
    if (!name) throw new Error('Enter a player name.');
    const links = await getLinks(client, guildId);
    const own = linkForDiscord(links, discordId);
    if (own && playerKey(own.gamertag) === playerKey(name)) throw new Error('You cannot place a bounty on yourself.');
    await economy.removeMoney(client, guildId, discordId, amount, 'rce:bounty-place');
    try {
      return await mutateBounties(client, guildId, state => {
        const entry = state[playerKey(name)] || { name, total: 0, by: [] };
        entry.total += amount;
        entry.by = [...(entry.by || []), { discordId, amount, at: now() }].slice(-25);
        state[playerKey(name)] = entry;
        return entry;
      });
    } catch (error) {
      await economy.addMoney(client, guildId, discordId, amount, 'rce:bounty-refund').catch(() => undefined);
      throw error;
    }
  }
  runtime.placeBounty = placeBounty;

  // ---------------------------------------------------------- links

  function linkChallenge() {
    const emotes = [];
    while (emotes.length < 3) {
      const pick = LINK_EMOTES[randomInt(LINK_EMOTES.length)];
      if (emotes[emotes.length - 1] !== pick) emotes.push(pick);
    }
    return { code: String(randomInt(100_000, 1_000_000)), emotes };
  }

  /** Starts linking a member to a gamertag; they prove it in game. */
  async function startLink(guildId, discordId, gamertag, onDone = null) {
    const name = safePlayerName(gamertag);
    const links = await getLinks(client, guildId);
    const owner = discordForPlayer(links, name);
    if (owner && owner !== discordId) throw new Error('That gamertag is already linked to another member. Ask staff if this is your account.');
    const challenge = linkChallenge();
    const entry = { guildId, discordId, gamertag: name, ...challenge, progress: 0, expiresAt: now() + LINK_TTL_MS, onDone };
    const forGuild = pendingLinks.get(guildId) || new Map();
    forGuild.set(discordId, entry);
    pendingLinks.set(guildId, forGuild);
    return { code: `CLOUDY-${challenge.code}`, emotes: challenge.emotes.map(value => QUICK_CHAT[value]), expiresAt: entry.expiresAt };
  }
  runtime.startLink = startLink;

  async function checkLinkProgress(session, player, { code: chatCode = null, text = '' }) {
    const forGuild = pendingLinks.get(session.guildId);
    if (!forGuild?.size) return false;
    const wanted = playerKey(player);
    for (const entry of forGuild.values()) {
      if (playerKey(entry.gamertag) !== wanted) continue;
      if (entry.expiresAt < now()) { forGuild.delete(entry.discordId); continue; }
      let done = false;
      let method = null;
      if (text && text.toUpperCase().includes(entry.code)) { done = true; method = 'note'; }
      else if (chatCode && LINK_EMOTES.includes(chatCode)) {
        entry.progress = chatCode === entry.emotes[entry.progress] ? entry.progress + 1 : chatCode === entry.emotes[0] ? 1 : 0;
        if (entry.progress >= entry.emotes.length) { done = true; method = 'emote'; }
        else return entry.progress > 0;
      }
      if (!done) continue;
      forGuild.delete(entry.discordId);
      await completeLink(session, entry, method);
      return true;
    }
    return false;
  }

  async function completeLink(session, entry, method) {
    try {
      await setLink(client, session.guildId, entry.discordId, entry.gamertag, { method, platform: session.onlinePlayer(entry.gamertag)?.platform || null, now: now() });
    } catch (error) {
      await notify(session, entry.gamertag, 'link', String(error?.message || 'linking failed'));
      return;
    }
    const config = await getRceConfig(client, session.guildId);
    const guild = guildOf(session.guildId);
    if (config.settings.linkedRoleId && guild) {
      const member = await guild.members.fetch(entry.discordId).catch(() => null);
      await member?.roles?.add?.(config.settings.linkedRoleId, 'Rust account linked').catch(() => undefined);
    }
    await say(session, `[Cloudy] ${entry.gamertag} is now linked to Discord`);
    await post(session.guildId, 'admin', adminEmbed(session.name, 'Account linked', [`**Member:** <@${entry.discordId}>`, `**Gamertag:** ${code(entry.gamertag)}`, `**Proof:** ${method === 'note' ? 'Code on a note' : 'Emotes'}`], now(), RCE_COLORS.green));
    try { await entry.onDone?.({ gamertag: entry.gamertag, method }); } catch { /* the reply may be gone */ }
    await deliveries.onLinked(session.guildId, entry.discordId).catch(() => undefined);
  }

  function cancelLink(guildId, discordId) {
    pendingLinks.get(guildId)?.delete(discordId);
  }
  runtime.cancelLink = cancelLink;

  // ---------------------------------------------------------- emote actions

  async function performAction(session, config, action, player) {
    switch (action.action ?? action.type) {
      case 'kit': return command(session, rceCommand.kit(action.value, player));
      case 'item': return command(session, rceCommand.giveItem(player, action.value, action.amount || 1));
      case 'teleport': {
        const location = config.locations.find(entry => entry.name.toLowerCase() === String(action.value).toLowerCase() && appliesTo(entry, session.id));
        if (!location) throw new RceCommandError('That teleport location does not exist any more.', 'unknown_location');
        return command(session, rceCommand.teleport(player, location));
      }
      case 'command': return command(session, renderCommandTemplate(action.value, player));
      case 'vip': return command(session, rceCommand.addVip(player));
      default: throw new RceCommandError('Unknown action.', 'unknown_action');
    }
  }
  runtime.performAction = performAction;

  async function runEmoteActions(session, config, event) {
    const bindings = config.emotes.filter(binding => binding.trigger === event.code && appliesTo(binding, session.id));
    for (const binding of bindings) {
      const label = binding.name || (binding.action === 'kit' ? `kit ${binding.value}` : binding.action === 'teleport' ? `teleport to ${binding.value}` : binding.value);
      const links = binding.linkedOnly || binding.price || binding.kitList || binding.oncePerWipe ? await getLinks(client, session.guildId) : null;
      const discordId = links ? discordForPlayer(links, event.player) : null;
      if ((binding.linkedOnly || binding.price || binding.kitList) && !discordId) {
        await notify(session, event.player, 'link', 'link your Discord account with /rust link first');
        continue;
      }
      if (binding.kitList) {
        const lists = await getLists(client, session.guildId);
        const allowed = Array.isArray(lists.kitLists[binding.value]) && lists.kitLists[binding.value].includes(discordId);
        if (!allowed) { await notify(session, event.player, `kitlist:${binding.id}`, `you do not have access to ${label}`); continue; }
      }
      const claimKey = discordId || playerKey(event.player);
      if (binding.oncePerWipe) {
        const lists = await getLists(client, session.guildId);
        if (lists.claims?.[binding.id]?.[claimKey]) { await notify(session, event.player, `claimed:${binding.id}`, `you already claimed ${label} this wipe`); continue; }
      }
      const cooldownKey = `emote:${binding.id}:${session.id}:${playerKey(event.player)}`;
      const cooldown = await takeCooldown(client, session.guildId, cooldownKey, binding.cooldownMinutes * 60_000, now());
      if (!cooldown.ok) {
        await notify(session, event.player, `cooldown:${binding.id}`, `${label} is on cooldown for ${Math.ceil(cooldown.remainingMs / 60_000)} more minute(s)`);
        continue;
      }
      let paid = 0;
      if (binding.price) {
        try { await economy.removeMoney(client, session.guildId, discordId, binding.price, `rce:emote:${binding.id}`); paid = binding.price; } catch {
          await releaseCooldown(client, session.guildId, cooldownKey).catch(() => undefined);
          await notify(session, event.player, `money:${binding.id}`, `you need ${binding.price.toLocaleString('en-US')} to use ${label}`);
          continue;
        }
      }
      let reply;
      try { reply = await performAction(session, config, binding, event.player); } catch (error) { reply = null; log.warn('[RCE] Emote action failed:', error?.message); }
      if (reply == null) {
        await releaseCooldown(client, session.guildId, cooldownKey).catch(() => undefined);
        if (paid) await economy.addMoney(client, session.guildId, discordId, paid, 'rce:emote-refund').catch(() => undefined);
        continue;
      }
      if (binding.oncePerWipe) {
        await mutateLists(client, session.guildId, lists => {
          lists.claims[binding.id] = { ...(lists.claims[binding.id] || {}), [claimKey]: now() };
        });
      }
      if (config.settings.announceClaims) await say(session, `[Cloudy] ${event.player} used ${label}`);
      await post(session.guildId, 'admin', adminEmbed(session.name, 'Emote action', [
        `**Player:** ${code(event.player)}`, `**Emote:** ${plain(quickChatLabel(event.code), 40)}`, `**Action:** ${plain(label, 80)}`,
        paid ? `**Paid:** ${paid.toLocaleString('en-US')}` : null,
      ].filter(Boolean), now()));
    }
  }

  // ---------------------------------------------------------- shop

  /** Buys a Discord shop item for the member and delivers it in game. */
  async function buy(guildId, discordId, itemId, serverQuery = null) {
    const config = await getRceConfig(client, guildId);
    const item = config.shop.find(entry => entry.id === itemId || entry.name.toLowerCase() === String(itemId || '').toLowerCase());
    if (!item) throw new Error('That item is not in the shop.');
    const candidates = runtime.guildSessions(guildId).filter(session => appliesTo(item, session.id));
    const session = serverQuery
      ? candidates.find(entry => entry.id === serverQuery || entry.name.toLowerCase() === String(serverQuery).toLowerCase())
      : candidates.length === 1 ? candidates[0] : candidates.find(entry => entry.online) || candidates[0];
    if (!session) throw new Error(serverQuery ? 'That item is not sold on this server.' : 'No game server is connected for this item.');
    if (!session.online) throw new Error(`${session.name} is not connected right now. Try again later.`);
    const links = await getLinks(client, guildId);
    const link = linkForDiscord(links, discordId);
    if (!link) throw new Error('Link your gamertag first with /rust link.');
    if (item.type !== 'vip' && !session.isOnline(link.gamertag)) throw new Error(`Join ${session.name} first: the item is delivered to you in game.`);
    const cooldownKey = `shop:${item.id}:${discordId}`;
    const cooldown = await takeCooldown(client, guildId, cooldownKey, item.cooldownMinutes * 60_000, now());
    if (!cooldown.ok) throw new Error(`You can buy this again in ${Math.ceil(cooldown.remainingMs / 60_000)} minute(s).`);
    if (item.price > 0) {
      try { await economy.removeMoney(client, guildId, discordId, item.price, `rce:shop:${item.id}`); } catch (error) {
        await releaseCooldown(client, guildId, cooldownKey).catch(() => undefined);
        throw new Error(error?.userMessage || error?.message || 'You do not have enough money.');
      }
    }
    let reply = null;
    let failure = null;
    try {
      reply = await session.send(item.type === 'kit' ? rceCommand.kit(item.value, link.gamertag)
        : item.type === 'item' ? rceCommand.giveItem(link.gamertag, item.value, item.amount)
          : item.type === 'vip' ? rceCommand.addVip(link.gamertag)
            : renderCommandTemplate(item.value, link.gamertag));
    } catch (error) {
      failure = error;
    }
    const unsure = failure instanceof RconError && failure.code === 'timeout';
    if (failure && !unsure) {
      await releaseCooldown(client, guildId, cooldownKey).catch(() => undefined);
      if (item.price > 0) await economy.addMoney(client, guildId, discordId, item.price, 'rce:shop-refund').catch(() => undefined);
      throw new Error(failure instanceof RceCommandError ? failure.message : 'The game server did not accept the delivery. You were not charged.');
    }
    if (item.type === 'vip' && item.vipDays > 0) {
      await mutateLists(client, guildId, lists => {
        const current = lists.vip[discordId];
        const base = Math.max(now(), Number(current?.until) || 0);
        lists.vip[discordId] = { gamertag: link.gamertag, until: base + item.vipDays * 86_400_000, servers: [...new Set([...(current?.servers || []), session.id])] };
      });
    }
    await post(guildId, 'shop', rceEmbed(unsure ? 'Shop delivery to check' : 'Shop purchase', [
      `**Member:** <@${discordId}>`, `**Gamertag:** ${code(link.gamertag)}`, `**Item:** ${plain(item.name, 60)}`,
      `**Price:** ${item.price.toLocaleString('en-US')}`, `**Server:** ${plain(session.name, 60)}`,
      unsure ? '**Status:** The server did not answer in time: check in game before refunding.' : null,
    ].filter(Boolean), { color: unsure ? RCE_COLORS.yellow : RCE_COLORS.green, time: now() }));
    return { item, session, unsure, reply };
  }
  runtime.buy = buy;

  async function expireVip() {
    const guilds = new Set([...sessions.values()].map(session => session.guildId));
    for (const guildId of guilds) {
      const lists = await getLists(client, guildId).catch(() => null);
      const expired = Object.entries(lists?.vip || {}).filter(([, entry]) => Number(entry?.until) && entry.until <= now());
      for (const [discordId, entry] of expired) {
        let done = true;
        for (const serverId of entry.servers || []) {
          const session = runtime.session(guildId, serverId);
          if (!session?.online) { done = false; continue; }
          if (await command(session, rceCommand.removeVip(entry.gamertag)) == null) done = false;
        }
        if (done) await mutateLists(client, guildId, state => { delete state.vip[discordId]; });
      }
    }
  }

  // ---------------------------------------------------------- timers

  async function automessages() {
    for (const session of sessions.values()) {
      if (!session.online) continue;
      const config = await getRceConfig(client, session.guildId).catch(() => null);
      for (const message of config?.automessages || []) {
        if (!appliesTo(message, session.id)) continue;
        const key = `${session.guildId}:${session.id}:${message.id}`;
        const last = automessageSent.get(key);
        if (last == null) { automessageSent.set(key, now()); continue; }
        if (now() - last < message.intervalMinutes * 60_000) continue;
        automessageSent.set(key, now());
        await say(session, message.text);
      }
    }
  }

  async function statusBoards() {
    const guilds = new Set([...sessions.values()].map(session => session.guildId));
    for (const guildId of guilds) {
      const config = await getRceConfig(client, guildId).catch(() => null);
      const channel = config ? feedChannel(guildId, config, 'status') : null;
      if (!channel?.messages) continue;
      const key = `guild:${guildId}:rce:status-messages`;
      const ids = await readData(client, key, {});
      const next = { ...ids };
      for (const session of runtime.guildSessions(guildId)) {
        const embed = serverStatusEmbed(session, now());
        const cacheKey = `${guildId}:${session.id}:${ids[session.id] || ''}`;
        const existing = statusMessages.get(cacheKey)
          || (ids[session.id] ? await channel.messages.fetch(ids[session.id]).catch(() => null) : null);
        if (existing) {
          statusMessages.set(cacheKey, existing);
          const edited = await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => true, error => error?.code !== 10008);
          if (edited) continue;
          statusMessages.delete(cacheKey);
        }
        const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
        if (sent) { next[session.id] = sent.id; statusMessages.set(`${guildId}:${session.id}:${sent.id}`, sent); }
      }
      if (JSON.stringify(next) !== JSON.stringify(ids)) await mutateData(client, key, {}, state => { Object.assign(state, next); });
    }
  }

  function every(ms, task, name) {
    const timer = setInterval(() => { void task().catch(error => log.warn(`[RCE] ${name} failed:`, error?.message || error)); }, ms);
    timer.unref?.();
    timers.add(timer);
  }

  const zorp = createZorp(runtime);
  const deliveries = createDeliveries(runtime);
  runtime.zorp = zorp;
  runtime.deliveries = deliveries;

  async function start() {
    if (started) return;
    started = true;
    unsubscribe = onRceConfigChange(guildId => { void syncGuild(guildId); });
    for (const guildId of await rceGuildIds(client).catch(() => [])) await syncGuild(guildId);
    every(60_000, automessages, 'Automatic messages');
    every(60_000, statusBoards, 'Status board');
    every(30_000, () => zorp.tickAll(), 'ZORP');
    every(30_000, () => deliveries.processDue(), 'Deliveries');
    every(10 * 60_000, playtimeRewards, 'Playtime rewards');
    every(60 * 60_000, expireVip, 'VIP expiry');
    // Premium may end or start: check every hour which servers may connect.
    every(60 * 60_000, async () => { for (const guildId of await rceGuildIds(client)) await syncGuild(guildId); }, 'Plan check');
    log.info(`[RCE] Rust Console module started: ${sessions.size} game server(s)`);
  }
  runtime.start = start;

  async function stop() {
    unsubscribe?.();
    unsubscribe = null;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    for (const session of sessions.values()) session.stop();
    sessions.clear();
    await runtime.flushFeeds().catch(() => undefined);
    for (const queue of queues.values()) clearTimeout(queue.timer);
    queues.clear();
    await stats.flush().catch(() => undefined);
    started = false;
  }
  runtime.stop = stop;

  runtime.resetWipe = async (guildId, serverId) => {
    await stats.reset(guildId, serverId);
    await mutateLists(client, guildId, lists => { lists.claims = {}; });
    const session = runtime.session(guildId, serverId);
    await zorp.clearServer(guildId, serverId, session);
  };

  runtime.pendingLinkFor = (guildId, discordId) => pendingLinks.get(guildId)?.get(discordId) || null;
  runtime.handleEvent = handleEvent;
  runtime.QUICK_CHAT_CODES = QUICK_CHAT_CODES;

  instance = runtime;
  return runtime;
}
