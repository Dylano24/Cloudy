import { createHash, randomInt, randomUUID } from 'node:crypto';
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

export function wipeSessionId(guildId, server, wipeAt) {
  return createHash('sha256').update(`${guildId}:${nameKey(server)}:${wipeAt}`).digest('hex').slice(0, 20);
}

export async function getWipeAutomationConfig(client, guildId) {
  const raw = await client.db.get(configKey(guildId), null);
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    vote: config.vote || null,
    giveaway: config.giveaway || null,
    voteJobs: Array.isArray(config.voteJobs) ? config.voteJobs : [],
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

function validRepeat(repeatMinutes, durationMinutes) {
  return Number.isSafeInteger(repeatMinutes) && repeatMinutes >= 1 && repeatMinutes <= 43200
    && Number.isSafeInteger(durationMinutes) && durationMinutes >= 1
    && durationMinutes <= repeatMinutes;
}

function shuffled(values) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const index = randomInt(i + 1);
    [out[i], out[index]] = [out[index], out[i]];
  }
  return out;
}

function validatedAutomationConfig(kind, configuration) {
  const schedule = ['repeat', 'once', 'wipe'].includes(configuration?.schedule)
    ? configuration.schedule : 'wipe';
  const server = String(configuration?.server || (schedule !== 'wipe' ? 'Cloudy' : '')).trim();
  const beforeMinutes = Number(configuration?.beforeMinutes);
  const durationMinutes = Number(configuration?.durationMinutes);
  const repeatMinutes = Number(configuration?.repeatMinutes);
  const startAt = configuration?.startAt == null ? null : Number(configuration.startAt);
  const channelId = String(configuration?.channelId || '').trim();
  const randomize = configuration?.randomize === true;
  if (!server || server.length > 60
    || (schedule === 'repeat'
      ? !validRepeat(repeatMinutes, durationMinutes)
      : schedule === 'once'
        ? !Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 43200
        : !validBefore(beforeMinutes, durationMinutes))) {
    throw new RangeError(schedule === 'repeat'
      ? 'Repeat must be between 1m and 30d and no shorter than Duration'
      : schedule === 'once'
        ? 'Duration must be between 1m and 30d'
        : 'Provide a server and duration that finishes before the Rust wipe');
  }
  if (schedule !== 'wipe' && startAt != null && (!Number.isSafeInteger(startAt) || startAt < 0)) {
    throw new RangeError('Choose a valid start date and time.');
  }
  if (schedule === 'once' && (!startAt || startAt <= Date.now())) {
    throw new RangeError('Choose a future start date for this one-time automation.');
  }
  if (channelId && !/^\d{17,20}$/.test(channelId)) {
    throw new RangeError('Select a valid destination channel');
  }
  let configured;
  if (kind === 'vote') {
    const name = String(configuration?.name || '').trim();
    const question = String(configuration?.question || '').trim();
    const maps = Array.isArray(configuration?.maps) ? configuration.maps.map(x => String(x).trim()).filter(Boolean) : [];
    if (name.length > 64 || !question || question.length > 250 || maps.length < 2 || maps.length > 3
      || maps.some(x => x.length > 80) || new Set(maps.map(x => x.toLowerCase())).size !== maps.length) {
      throw new RangeError('Configure a question and two or three unique map choices');
    }
    configured = { server, name, question, maps, beforeMinutes, durationMinutes, state: 'stopped' };
  } else {
    const kit = String(configuration?.kit || '').trim();
    const prizes = (Array.isArray(configuration?.prizes) ? configuration.prizes : [kit])
      .map(prize => String(prize).trim()).filter(Boolean);
    const winnerRoleId = String(configuration?.winnerRoleId || '');
    const winnerCount = Number(configuration?.winnerCount);
    if (!prizes.length || prizes.length > 20 || prizes.some(prize => prize.length > 150)
      || (schedule === 'wipe' && !/^\d{17,20}$/.test(winnerRoleId))
      || (winnerRoleId && !/^\d{17,20}$/.test(winnerRoleId))
      || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 10) {
      throw new RangeError('Configure 1–20 prizes, 1–10 winners and a valid optional winner role');
    }
    const description = String(configuration?.description || '').trim();
    if (description.length > 800) throw new RangeError('Description is too long');
    configured = { server, kit: prizes[0], prizes, winnerRoleId, winnerCount,
      description, beforeMinutes, durationMinutes, state: 'stopped' };
  }
  Object.assign(configured, {
    schedule, channelId, randomize,
    ...(schedule === 'repeat'
      ? { repeatMinutes, ...(startAt ? { startAt } : {}),
        nextRunAt: startAt || Date.now() + repeatMinutes * MINUTE }
      : schedule === 'once'
        ? { startAt, nextRunAt: startAt }
        : {}),
  });
  return configured;
}

export async function configureWipeAutomation(client, guildId, kind, configuration) {
  if (guildId !== AUTO_WIPE_GUILD_ID || !Object.hasOwn(AUTO_WIPE_KIND, kind)) throw new RangeError('Invalid automation');
  const configured = validatedAutomationConfig(kind, configuration);
  return Mutex.runExclusive(`wipeauto:config:${guildId}`, async () => {
    const current = await getWipeAutomationConfig(client, guildId);
    return saveConfig(client, guildId, { ...current, [kind]: configured });
  });
}

export async function setWipeAutomationState(client, guildId, kind, state) {
  if (guildId !== AUTO_WIPE_GUILD_ID || !Object.hasOwn(AUTO_WIPE_KIND, kind)
    || !AUTO_WIPE_STATES.includes(state)) throw new RangeError('Invalid automation state');
  return Mutex.runExclusive(`wipeauto:config:${guildId}`, async () => {
    const config = await getWipeAutomationConfig(client, guildId);
    if (!config[kind]) throw new RangeError('Configure this automation before starting it');
    const setting = config[kind];
    if (setting.schedule === 'once' && state === 'running'
      && (setting.completedAt || setting.startAt <= Date.now())) {
      throw new RangeError('This date has passed. Set a new future date in Schedule first.');
    }
    const restart = state === 'running' && setting.state === 'stopped';
    let nextRunAt = setting.nextRunAt;
    if (restart && setting.schedule === 'repeat') {
      const interval = setting.repeatMinutes * MINUTE;
      const first = setting.startAt || Date.now() + interval;
      nextRunAt = first > Date.now()
        ? first : first + (Math.floor((Date.now() - first) / interval) + 1) * interval;
    }
    config[kind] = {
      ...setting, state,
      ...(setting.schedule === 'repeat' && restart ? { nextRunAt } : {}),
    };
    await saveConfig(client, guildId, config);
    return config[kind];
  });
}


// Saved vote automations are independent jobs. The older single 'vote'
// configuration remains accessible as 'legacy' and is never discarded on
// migration to the dashboard list.
export async function listAutomaticVotes(client, guildId) {
  if (guildId !== AUTO_WIPE_GUILD_ID) return [];
  const config = await getWipeAutomationConfig(client, guildId);
  return [
    ...(config.vote ? [{ ...config.vote, id: 'legacy' }] : []),
    ...config.voteJobs,
  ];
}

export async function saveAutomaticVoteJob(client, guildId, draft, jobId = null) {
  if (guildId !== AUTO_WIPE_GUILD_ID) throw new RangeError('Invalid automation guild');
  const configured = validatedAutomationConfig('vote', draft);
  if (jobId === 'legacy') throw new RangeError('Legacy votes are managed through the existing config');
  return Mutex.runExclusive(`wipeauto:config:${guildId}`, async () => {
    const config = await getWipeAutomationConfig(client, guildId);
    const existing = jobId ? config.voteJobs.find(job => job.id === jobId) : null;
    if (jobId && !existing) throw new RangeError('This automatic vote no longer exists.');
    if (!existing && config.voteJobs.length >= 20) {
      throw new RangeError('Maximum 20 additional automatic votes reached.');
    }
    const id = existing?.id || randomUUID().replace(/-/g, '').slice(0, 16);
    const sameTiming = existing && existing.schedule === configured.schedule
      && existing.startAt === configured.startAt
      && existing.repeatMinutes === configured.repeatMinutes
      && existing.beforeMinutes === configured.beforeMinutes
      && existing.durationMinutes === configured.durationMinutes;
    const updated = {
      ...configured, id,
      state: existing?.state || 'stopped',
      ...(sameTiming && existing.nextRunAt ? { nextRunAt: existing.nextRunAt } : {}),
      ...(sameTiming && existing.completedAt ? { completedAt: existing.completedAt } : {}),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    config.voteJobs = existing
      ? config.voteJobs.map(job => job.id === id ? updated : job)
      : [...config.voteJobs, updated];
    await saveConfig(client, guildId, config);
    return updated;
  });
}

export async function setAutomaticVoteJobState(client, guildId, jobId, state) {
  if (guildId !== AUTO_WIPE_GUILD_ID || !AUTO_WIPE_STATES.includes(state)
    || !/^[a-f0-9]{16}$/.test(jobId || '')) throw new RangeError('Invalid vote automation');
  return Mutex.runExclusive(`wipeauto:config:${guildId}`, async () => {
    const config = await getWipeAutomationConfig(client, guildId);
    const existing = config.voteJobs.find(job => job.id === jobId);
    if (!existing) throw new RangeError('This automatic vote no longer exists.');
    if (existing.schedule === 'once' && state === 'running'
      && (existing.completedAt || existing.startAt <= Date.now())) {
      throw new RangeError('This date has passed. Set a new future date first.');
    }
    const restart = state === 'running' && existing.state === 'stopped';
    let nextRunAt = existing.nextRunAt;
    if (restart && existing.schedule === 'repeat') {
      const interval = existing.repeatMinutes * MINUTE;
      const first = existing.startAt || Date.now() + interval;
      nextRunAt = first > Date.now() ? first
        : first + (Math.floor((Date.now() - first) / interval) + 1) * interval;
    }
    const updated = { ...existing, state,
      ...(existing.schedule === 'repeat' && restart ? { nextRunAt } : {}) };
    config.voteJobs = config.voteJobs.map(job => job.id === jobId ? updated : job);
    await saveConfig(client, guildId, config);
    return updated;
  });
}

export async function deleteAutomaticVoteJob(client, guildId, jobId) {
  if (guildId !== AUTO_WIPE_GUILD_ID) throw new RangeError('Invalid automation guild');
  return Mutex.runExclusive(`wipeauto:config:${guildId}`, async () => {
    const config = await getWipeAutomationConfig(client, guildId);
    if (jobId === 'legacy') {
      if (!config.vote) return false;
      config.vote = null;
    } else {
      const length = config.voteJobs.length;
      config.voteJobs = config.voteJobs.filter(job => job.id !== jobId);
      if (length === config.voteJobs.length) return false;
    }
    await saveConfig(client, guildId, config);
    return true;
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
    description: session.description || DEFAULT_GIVEAWAY_DESCRIPTION,
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

async function getTextChannel(client, guild, key, channelId = '') {
  if (channelId) {
    const channel = guild.channels?.cache?.get(channelId)
      || await guild.channels?.fetch?.(channelId).catch(() => null);
    if (channel?.guild?.id && channel.guild.id !== guild.id) return null;
    return channel?.isTextBased?.() && channel?.isSendable?.() ? channel : null;
  }
  const channel = await resolveCloudyChannel(client, key, { guild, textOnly: true });
  return channel?.isSendable?.() ? channel : null;
}

async function createAutomaticVote(client, guild, config, id, wipeAt) {
  const channel = await getTextChannel(client, guild, 'votes', config.channelId);
  if (!channel) {
    logger.warn('[WIPE_AUTO] Vote destination is unavailable:', config.channelId || 'votes');
    return;
  }
  const key = sentKey(guild.id, 'vote', id);
  await Mutex.runExclusive(key, async () => {
    if (await client.db.get(key, null)) return;
    // Record BEFORE posting: on a crash never duplicate an automatic vote.
    await client.db.set(key, { state: 'posting', recordedAt: Date.now() });
    const vote = {
      guildId: guild.id, channelId: channel.id, messageId: null,
      question: config.question,
      options: config.randomize ? shuffled(config.maps) : config.maps, votes: {},
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
  const channel = await getTextChannel(client, guild, 'giveaway', config.channelId);
  if (!channel) {
    logger.warn('[WIPE_AUTO] Giveaway destination is unavailable:', config.channelId || 'giveaway');
    return;
  }
  const key = sessionKey(guild.id, id);
  await Mutex.runExclusive(key, async () => {
    let session = await getSession(client, guild.id, id);
    if (session?.messageId) return;
    const lookup = session ? await findExistingWipePost(channel, id) : null;
    if (session && !lookup?.lookupSucceeded) return;
    if (!session) {
      session = {
        id, server: config.server,
        kit: config.randomize && config.prizes?.length > 1
          ? config.prizes[randomInt(config.prizes.length)] : config.kit,
        roleId: config.winnerRoleId,
        winnerCount: config.winnerCount, description: config.description || '',
        wipeAt,
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

export async function refreshAutoWipeEntryMessage(client, guildId, id, message) {
  if (!message?.id) return false;
  // The interaction and the scheduler share the same session lock. Never let
  // an older click overwrite a later participant count or an ended card.
  return Mutex.runExclusive(sessionKey(guildId, id), async () => {
    const session = await getSession(client, guildId, id);
    if (!session || session.messageId !== message.id) return false;
    await message.edit(autoWipeGiveawayPayload(session));
    return true;
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
      const entries = kind === 'vote'
        ? [{ setting: config.vote, jobId: null },
          ...config.voteJobs.map(setting => ({ setting, jobId: setting.id }))]
        : [{ setting: config.giveaway, jobId: null }];
      for (const { setting, jobId } of entries) {
      if (!setting || setting.state !== 'running') continue;
      if (setting.schedule === 'repeat' || setting.schedule === 'once') {
        let dueAt = null;
        let dueSetting = null;
        await Mutex.runExclusive(`wipeauto:config:${guild.id}`, async () => {
          const latest = await getWipeAutomationConfig(client, guild.id);
          const active = jobId ? latest.voteJobs.find(job => job.id === jobId) : latest[kind];
          const updateActive = updated => {
            if (jobId) latest.voteJobs = latest.voteJobs.map(job => job.id === jobId ? updated : job);
            else latest[kind] = updated;
          };
          if (!['once', 'repeat'].includes(active?.schedule) || active.state !== 'running') return;
          if (active.schedule === 'repeat'
            && !validRepeat(active.repeatMinutes, active.durationMinutes)) return;
          const next = Number(active.nextRunAt);
          if (!Number.isFinite(next) || next <= 0) {
            if (active.schedule === 'once') return;
            updateActive({ ...active, nextRunAt: now + active.repeatMinutes * MINUTE });
          } else if (next <= now) {
            dueAt = next;
            dueSetting = { ...active };
            if (active.schedule === 'once') {
              // Claim the single scheduled launch before any Discord API call.
              updateActive({ ...active, state: 'stopped', completedAt: now, lastRunAt: next });
            } else {
              const elapsed = Math.floor((now - next) / (active.repeatMinutes * MINUTE)) + 1;
              updateActive({ ...active, nextRunAt: next + elapsed * active.repeatMinutes * MINUTE,
                lastRunAt: next });
            }
          } else return;
          // Persist the advance BEFORE posting so repeated ticks/crashes cannot
          // duplicate a public giveaway or vote.
          await saveConfig(client, guild.id, latest);
        });
        if (dueAt !== null) {
          const id = wipeSessionId(guild.id, jobId ? `vote-job:${jobId}:repeat` : `${kind}:repeat`, dueAt);
          try {
            if (kind === 'vote') await createAutomaticVote(client, guild, dueSetting, id, dueAt);
            else await createAutomaticGiveaway(client, guild, dueSetting, id, dueAt);
          } catch (error) {
            logger.warn(`[WIPE_AUTO] Could not start scheduled ${kind}:`, error);
          }
        }
        continue;
      }
      const wipeAt = Number(config.wipes[nameKey(setting.server)]);
      if (!Number.isFinite(wipeAt) || wipeAt <= now) continue;
      const startsAt = wipeAt - setting.beforeMinutes * MINUTE;
      if (now < startsAt || now >= wipeAt) continue;
      const id = wipeSessionId(guild.id,
        jobId ? `vote-job:${jobId}:${setting.server}` : setting.server, wipeAt);
      try {
        if (kind === 'vote') await createAutomaticVote(client, guild, setting, id, wipeAt);
        else await createAutomaticGiveaway(client, guild, setting, id, wipeAt);
      } catch (error) {
        logger.warn(`[WIPE_AUTO] Could not start ${kind}:`, error);
      }
      }
    }
  }
}

export async function syncWipePrize(client, member) {
  const guild = member?.guild;
  if (!validGuild(guild)) return { status: 'unavailable' };
  for (const id of await getHistory(client, guild.id)) {
    const result = await Mutex.runExclusive(sessionKey(guild.id, id), async () => {
      const session = await getSession(client, guild.id, id);
      if (!session || session.status !== 'ended' || !session.winners.includes(member.id)) return null;
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
