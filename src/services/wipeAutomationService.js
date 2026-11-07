import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { resolveCloudyChannel } from './cloudyChannelResolver.js';
import { buildVoteMessage, saveVote } from './voteService.js';
import {
  createGiveawayEmbed, GIVEAWAY_EMOJIS,
  selectWinners, DEFAULT_GIVEAWAY_INTRO, DEFAULT_GIVEAWAY_DESCRIPTION,
  DEFAULT_GIVEAWAY_CLOSING,
} from './giveawayService.js';

export const AUTO_WIPE_GUILD_ID = '1532882647838228723';
export const AUTO_WIPE_KIND = Object.freeze({ vote: 'vote', giveaway: 'giveaway' });
export const AUTO_WIPE_STATES = Object.freeze(['stopped', 'running', 'paused']);
const HISTORY_LIMIT = 30;
const MINUTE = 60_000;

const configKey = guildId => `guild:${guildId}:wipe-automations:v1`;
const indexKey = guildId => `guild:${guildId}:wipe-automation:giveaways`;
const sessionKey = (guildId, id) => `guild:${guildId}:wipe-automation:giveaway:${id}`;
const sentKey = (guildId, kind, id) => `guild:${guildId}:wipe-automation:sent:${kind}:${id}`;
const nameKey = name => String(name || '').trim().toLowerCase();
const validGuild = guild => guild?.id === AUTO_WIPE_GUILD_ID;
const missing = value => value == null || value === '';

export function wipeSessionId(guildId, server, wipeAt) {
  return createHash('sha256').update(`${guildId}:${nameKey(server)}:${wipeAt}`).digest('hex').slice(0, 20);
}

export async function getWipeAutomationConfig(client, guildId) {
  const raw = await client.db.get(configKey(guildId), null);
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    vote: config.vote || null,
    giveaway: config.giveaway || null,
    wipes: config.wipes && typeof config.wipes === 'object' ? config.wipes : {},
  };
}

async function saveConfig(client, guildId, config) {
  if (await client.db.set(configKey(guildId), config) === false) throw new Error('Automation configuration could not be saved');
  return config;
}

function validBefore(beforeMinutes, durationMinutes) {
  return Number.isInteger(beforeMinutes) && beforeMinutes >= 2 && beforeMinutes <= 10080
    && Number.isInteger(durationMinutes) && durationMinutes >= 1
    && durationMinutes < beforeMinutes;
}

export async function configureWipeAutomation(client, guildId, kind, configuration) {
  if (guildId !== AUTO_WIPE_GUILD_ID || !Object.hasOwn(AUTO_WIPE_KIND, kind)) throw new RangeError('Invalid automation');
  const server = String(configuration?.server || '').trim();
  const beforeMinutes = Number(configuration?.beforeMinutes);
  const durationMinutes = Number(configuration?.durationMinutes);
  if (!server || server.length > 60 || !validBefore(beforeMinutes, durationMinutes)) {
    throw new RangeError('Provide a server name and valid before/duration minutes (duration must finish before the wipe)');
  }
  const previous = await getWipeAutomationConfig(client, guildId);
  let configured;
  if (kind === 'vote') {
    const question = String(configuration?.question || '').trim();
    const maps = Array.isArray(configuration?.maps) ? configuration.maps.map(x => String(x).trim()).filter(Boolean) : [];
    if (!question || question.length > 250 || maps.length < 2 || maps.length > 3
      || maps.some(x => x.length > 80) || new Set(maps.map(x => x.toLowerCase())).size !== maps.length) {
      throw new RangeError('Configure a question and two or three unique map choices');
    }
    configured = { server, question, maps, beforeMinutes, durationMinutes, state: 'stopped' };
  } else {
    const kit = String(configuration?.kit || '').trim();
    const winnerRoleId = String(configuration?.winnerRoleId || '');
    const winnerCount = Number(configuration?.winnerCount);
    if (!kit || kit.length > 150 || !/^\d{17,20}$/.test(winnerRoleId)
      || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 10) {
      throw new RangeError('Configure a kit name, a winner role and 1–10 winners');
    }
    configured = { server, kit, winnerRoleId, winnerCount, beforeMinutes, durationMinutes, state: 'stopped' };
  }
  return saveConfig(client, guildId, { ...previous, [kind]: configured });
}

export async function setWipeAutomationState(client, guildId, kind, state) {
  if (guildId !== AUTO_WIPE_GUILD_ID || !Object.hasOwn(AUTO_WIPE_KIND, kind)
    || !AUTO_WIPE_STATES.includes(state)) throw new RangeError('Invalid automation state');
  return Mutex.runExclusive(`wipeauto:config:${guildId}`, async () => {
    const config = await getWipeAutomationConfig(client, guildId);
    if (!config[kind]) throw new RangeError('Configure this automation before starting it');
    config[kind] = { ...config[kind], state };
    await saveConfig(client, guildId, config);
    return config[kind];
  });
}

export async function observeWipeEvent(client, guild, event) {
  if (!validGuild(guild) || !['status', 'wipe'].includes(event?.type) || !event.server) return;
  let tickNeeded = false;
  await Mutex.runExclusive(`wipeauto:config:${guild.id}`, async () => {
    const cfg = await getWipeAutomationConfig(client, guild.id);
    const server = nameKey(event.server);
    const nextWipe = event.type === 'status'
      ? event.nextWipe
      : event.state === 'soon' ? event.at : event.state === 'done' ? event.next : null;
    if (Number.isFinite(nextWipe) && nextWipe > Date.now()) {
      cfg.wipes[server] = nextWipe;
      await saveConfig(client, guild.id, cfg);
      tickNeeded = true;
    }
  });
  // A completed wipe ends the *previous* wipe's temporary roles; never
  // remove the new wipe's roles at the start of the new wipe.
  if (event.type === 'wipe' && event.state === 'done') {
    await expirePreviousWipeRoles(client, guild, event.server, event.time || Date.now());
  }
  if (tickNeeded) await runWipeAutomationTick(client);
}

function giveawayButtons(id, ended = false) {
  if (ended) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wipeauto_enter:${id}`)
      .setLabel('Enter giveaway').setEmoji(GIVEAWAY_EMOJIS.enter).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wipeauto_leave:${id}`)
      .setLabel('Leave giveaway').setEmoji(GIVEAWAY_EMOJIS.leave).setStyle(ButtonStyle.Secondary),
  )];
}

export function autoWipeGiveawayPayload(session) {
  const giveaway = {
    prize: session.kit,
    hostId: session.hostId,
    introTitle: DEFAULT_GIVEAWAY_INTRO,
    description: DEFAULT_GIVEAWAY_DESCRIPTION,
    closingText: DEFAULT_GIVEAWAY_CLOSING,
    requirements: 'None',
    winnerCount: session.winnerCount,
    participants: session.participants,
    endsAt: session.endsAt,
    endedAt: session.endedAt,
    winnerIds: session.winners,
  };
  return {
    embeds: [createGiveawayEmbed(giveaway, session.status === 'ended' || session.status === 'expired' ? 'ended' : 'active', session.winners)],
    components: giveawayButtons(session.id, session.status !== 'active'),
    allowedMentions: { parse: [] },
  };
}

async function getHistory(client, guildId) {
  const records = await client.db.get(indexKey(guildId), []);
  return Array.isArray(records) ? records.slice(0, HISTORY_LIMIT) : [];
}

async function getSession(client, guildId, id) {
  return client.db.get(sessionKey(guildId, id), null);
}

async function saveSession(client, guildId, session) {
  if (await client.db.set(sessionKey(guildId, session.id), session) === false) throw new Error('Could not save wipe giveaway');
}

async function rememberSession(client, guildId, id) {
  return Mutex.runExclusive(indexKey(guildId), async () => {
    const history = await getHistory(client, guildId);
    if (!history.includes(id)) {
      history.unshift(id);
      if (await client.db.set(indexKey(guildId), history.slice(0, HISTORY_LIMIT)) === false) {
        throw new Error('Could not save wipe giveaway history');
      }
    }
  });
}

async function getTextChannel(client, guild, key) {
  const channel = await resolveCloudyChannel(client, key, { guild, textOnly: true });
  return channel?.isSendable?.() ? channel : null;
}

async function createAutomaticVote(client, guild, config, id, wipeAt) {
  const channel = await getTextChannel(client, guild, 'votes');
  if (!channel) return;
  const key = sentKey(guild.id, 'vote', id);
  await Mutex.runExclusive(key, async () => {
    if (await client.db.get(key, null)) return;
    // Record BEFORE posting: on a crash never duplicate an automatic vote.
    await client.db.set(key, { state: 'posting', recordedAt: Date.now() });
    const vote = {
      guildId: guild.id, channelId: channel.id, messageId: null,
      question: config.question, options: config.maps, votes: {},
      endsAt: Date.now() + config.durationMinutes * MINUTE, ended: false,
      layout: 'preview', pictureOptions: config.maps.map(() => false),
      createdBy: client.user.id, createdAt: new Date().toISOString(),
      automationId: id, automationServer: config.server, wipeAt,
    };
    try {
      const posted = await channel.send(buildVoteMessage(vote));
      vote.messageId = posted.id;
      await saveVote(client, guild.id, vote);
      await client.db.set(key, { state: 'posted', messageId: posted.id });
    } catch (error) {
      logger.error('[WIPE_AUTO] Vote creation failed (will not duplicate an uncertain send):', error);
    }
  });
}

async function findExistingWipePost(channel, id) {
  const history = await channel.messages?.fetch?.({ limit: 100 }).catch(() => null);
  if (!history) return { lookupSucceeded: false, message: null };
  const found = history.find(message =>
    message.components?.some(row => row.components?.some(button =>
      button.customId === `wipeauto_enter:${id}` || button.customId === `wipeauto_leave:${id}`,
    ))) || null;
  return { lookupSucceeded: true, message: found };
}

async function createAutomaticGiveaway(client, guild, config, id, wipeAt) {
  const channel = await getTextChannel(client, guild, 'giveaway');
  if (!channel) return;
  const key = sessionKey(guild.id, id);
  await Mutex.runExclusive(key, async () => {
    let session = await getSession(client, guild.id, id);
    if (session?.messageId) return;
    const lookup = session ? await findExistingWipePost(channel, id) : null;
    if (session && !lookup?.lookupSucceeded) return;
    if (!session) {
      session = {
        id, server: config.server, kit: config.kit, roleId: config.winnerRoleId,
        winnerCount: config.winnerCount, wipeAt,
        endsAt: Date.now() + config.durationMinutes * MINUTE,
        hostId: client.user.id, channelId: channel.id,
        participants: [], winners: [], synced: [], roleGranted: [],
        status: 'active', messageId: null, messageUpdated: false,
      };
      await saveSession(client, guild.id, session);
      await rememberSession(client, guild.id, id);
    }
    const message = lookup?.message || await channel.send(autoWipeGiveawayPayload(session));
    session.messageId = message.id;
    await saveSession(client, guild.id, session);
  });
}

export async function changeAutoWipeEntry(client, guildId, id, userId, enter, now = Date.now()) {
  if (guildId !== AUTO_WIPE_GUILD_ID || !/^\w{20}$/.test(id) || !/^\d{17,20}$/.test(userId)) {
    return { status: 'invalid' };
  }
  return Mutex.runExclusive(sessionKey(guildId, id), async () => {
    const session = await getSession(client, guildId, id);
    if (!session) return { status: 'missing' };
    if (session.status !== 'active' || now >= session.endsAt) return { status: 'ended' };
    const entries = new Set(session.participants);
    if (enter === entries.has(userId)) return { status: enter ? 'already' : 'not-entered', session };
    if (enter) entries.add(userId);
    else entries.delete(userId);
    const updated = { ...session, participants: [...entries] };
    await saveSession(client, guildId, updated);
    return { status: enter ? 'entered' : 'left', session: updated };
  });
}

async function finishWipeGiveaway(client, guild, id, now) {
  await Mutex.runExclusive(sessionKey(guild.id, id), async () => {
    let session = await getSession(client, guild.id, id);
    if (!session || session.status === 'expired') return;
    if (session.status === 'active' && now >= session.endsAt) {
      session = {
        ...session, winners: selectWinners(session.participants, session.winnerCount),
        status: 'ended', endedAt: new Date(now).toISOString(), messageUpdated: false,
      };
      await saveSession(client, guild.id, session);
    }
    if (session.status !== 'ended' || session.messageUpdated || !session.messageId) return;
    const channel = guild.channels?.cache?.get(session.channelId)
      || await guild.channels?.fetch?.(session.channelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(session.messageId).catch(() => null);
    if (!message) return;
    await message.edit(autoWipeGiveawayPayload(session));
    await saveSession(client, guild.id, { ...session, messageUpdated: true });
  });
}

export async function runWipeAutomationTick(client, now = Date.now()) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    if (!validGuild(guild)) continue;
    const config = await getWipeAutomationConfig(client, guild.id);
    for (const id of await getHistory(client, guild.id)) {
      try { await finishWipeGiveaway(client, guild, id, now); }
      catch (error) { logger.warn('[WIPE_AUTO] Could not finish giveaway:', error); }
    }
    for (const kind of Object.keys(AUTO_WIPE_KIND)) {
      const setting = config[kind];
      if (!setting || setting.state !== 'running') continue;
      const wipeAt = Number(config.wipes[nameKey(setting.server)]);
      if (!Number.isFinite(wipeAt) || wipeAt <= now) continue;
      const startsAt = wipeAt - setting.beforeMinutes * MINUTE;
      if (now < startsAt || now >= wipeAt) continue;
      const id = wipeSessionId(guild.id, setting.server, wipeAt);
      try {
        if (kind === 'vote') await createAutomaticVote(client, guild, setting, id, wipeAt);
        else await createAutomaticGiveaway(client, guild, setting, id, wipeAt);
      } catch (error) {
        logger.warn(`[WIPE_AUTO] Could not start ${kind}:`, error);
      }
    }
  }
}

export async function syncWipePrize(client, member, now = Date.now()) {
  const guild = member?.guild;
  if (!validGuild(guild)) return { status: 'unavailable' };
  for (const id of await getHistory(client, guild.id)) {
    const result = await Mutex.runExclusive(sessionKey(guild.id, id), async () => {
      const session = await getSession(client, guild.id, id);
      if (!session || session.status !== 'ended' || !session.winners.includes(member.id)
        || session.wipeAt + 45 * 24 * 60 * MINUTE < now) return null;
      if (session.synced.includes(member.id)) return { status: 'already', session };
      const role = guild.roles?.cache?.get(session.roleId)
        || await guild.roles?.fetch?.(session.roleId).catch(() => null);
      if (!role || !member.roles?.add) return { status: 'role-unavailable' };
      const alreadyHasRole = member.roles.cache?.has?.(role.id);
      if (!alreadyHasRole) {
        await member.roles.add(role, 'Automated wipe giveaway winner sync');
      }
      const updated = {
        ...session, synced: [...session.synced, member.id],
        roleGranted: alreadyHasRole ? session.roleGranted : [...session.roleGranted, member.id],
      };
      await saveSession(client, guild.id, updated);
      return { status: 'synced', session: updated };
    });
    if (result) return result;
  }
  return { status: 'not-winner' };
}

export async function expirePreviousWipeRoles(client, guild, server, currentWipeAt) {
  if (!validGuild(guild)) return;
  for (const id of await getHistory(client, guild.id)) {
    await Mutex.runExclusive(sessionKey(guild.id, id), async () => {
      const session = await getSession(client, guild.id, id);
      if (!session || session.status !== 'ended' || nameKey(session.server) !== nameKey(server)
        || currentWipeAt <= session.wipeAt + 60 * MINUTE) return;
      const remaining = [];
      for (const userId of session.roleGranted || []) {
        try {
          const member = await guild.members?.fetch?.(userId).catch(() => null);
          if (member?.roles?.cache?.has?.(session.roleId)) {
            await member.roles.remove(session.roleId, 'Previous Rust wipe ended');
          }
        } catch (error) {
          logger.warn('[WIPE_AUTO] Could not remove expired wipe role:', error);
          remaining.push(userId);
        }
      }
      await saveSession(client, guild.id, {
        ...session, status: remaining.length ? 'ended' : 'expired',
        roleGranted: remaining, expiredAt: remaining.length ? null : new Date(currentWipeAt).toISOString(),
      });
    });
  }
}
