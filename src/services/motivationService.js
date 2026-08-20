import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const REMINDER_KEY_PREFIX = 'motivation:reminders:';
const DAILY_KEY_PREFIX = 'motivation:daily:';
const SCHEDULER_INTERVAL_MS = 30_000;
const MAX_REMINDERS_PER_USER = 25;

const QUOTES = [
  'Small progress still counts. Keep moving.',
  'Consistency beats intensity when intensity cannot last.',
  'Start with the next useful action, not the perfect plan.',
  'A difficult day does not erase the work you already did.',
  'You do not need more motivation to begin; beginning often creates motivation.',
  'Protect your focus like it is a limited resource, because it is.',
  'Make the goal smaller if that is what gets you moving today.',
  'Your future becomes easier when you keep one promise to yourself today.',
  'Do the important thing before the comfortable thing.',
  'Confidence grows after repeated action, not before it.',
  'One focused hour can change the direction of an entire week.',
  'Rest is useful when it helps you return with intention.',
  'You are allowed to improve the plan while you are already moving.',
  'Measure yourself against your previous habits, not someone else’s highlights.',
  'A missed day is a pause, not a reason to quit.',
  'Make it easy to start and hard to avoid.',
  'The boring repetitions are often where the real progress happens.',
  'You can be proud of progress and still want more from yourself.',
  'Choose the action that makes tomorrow easier.',
  'If the whole task feels heavy, complete the first five minutes.',
  'Discipline is remembering what you wanted when your mood changes.',
  'You do not have to feel ready to take a useful step.',
  'Momentum is built from completed actions, however small.',
  'Keep the standard high and the first step simple.',
  'A clear priority is more valuable than a long to-do list.',
  'Give your attention to what you can actually influence today.',
  'Progress can be quiet and still be real.',
  'Finish something small before starting something new.',
  'The next attempt benefits from everything the last attempt taught you.',
  'Build systems that still work on the days your motivation is low.',
  'Do not wait for a perfect week to restart a good habit.',
  'The work you repeat becomes the person you become.',
  'Make today useful, not flawless.',
  'A good routine reduces the number of decisions you need to win the day.',
  'Focus on completing the rep in front of you.',
  'You can change direction without giving up on the destination.',
  'Slow progress with consistency is stronger than fast progress that disappears.',
  'Keep showing up long enough for the results to catch up.',
  'Turn the pressure into a plan: one task, one deadline, one next step.',
  'Leave enough energy to come back tomorrow and do it again.',
];

function reminderKey(guildId) {
  return `${REMINDER_KEY_PREFIX}${guildId}`;
}

function dailyKey(guildId) {
  return `${DAILY_KEY_PREFIX}${guildId}`;
}

function randomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function getRandomMotivation() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

export function parseReminderDuration(input) {
  const raw = String(input || '').trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let multiplier = 60_000;
  if (unit.startsWith('h')) multiplier = 60 * 60_000;
  else if (unit.startsWith('d')) multiplier = 24 * 60 * 60_000;
  else if (unit.startsWith('w')) multiplier = 7 * 24 * 60 * 60_000;

  const ms = amount * multiplier;
  const min = 60_000;
  const max = 365 * 24 * 60 * 60_000;
  return ms >= min && ms <= max ? ms : null;
}

async function getReminders(client, guildId) {
  const reminders = await client.db?.get?.(reminderKey(guildId), []);
  return Array.isArray(reminders) ? reminders : [];
}

async function saveReminders(client, guildId, reminders) {
  await client.db?.set?.(reminderKey(guildId), reminders);
}

export async function createMotivationReminder(client, {
  guildId,
  channelId,
  userId,
  targetUserId = null,
  durationMs,
  repeatMs = null,
  message = null,
}) {
  const reminders = await getReminders(client, guildId);
  const userCount = reminders.filter((entry) => entry.userId === userId).length;
  if (userCount >= MAX_REMINDERS_PER_USER) {
    throw new Error(`You can have at most ${MAX_REMINDERS_PER_USER} active motivation reminders.`);
  }

  const reminder = {
    id: randomId(),
    guildId,
    channelId,
    userId,
    targetUserId: targetUserId || userId,
    message: String(message || '').trim() || null,
    createdAt: new Date().toISOString(),
    runAt: Date.now() + durationMs,
    repeatMs: repeatMs || null,
  };

  reminders.push(reminder);
  await saveReminders(client, guildId, reminders);
  return reminder;
}

export async function getUserMotivationReminders(client, guildId, userId) {
  const reminders = await getReminders(client, guildId);
  return reminders
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => a.runAt - b.runAt);
}

export async function cancelMotivationReminder(client, guildId, userId, id, canManageAll = false) {
  const reminders = await getReminders(client, guildId);
  const index = reminders.findIndex((entry) =>
    String(entry.id).toUpperCase() === String(id).toUpperCase()
    && (canManageAll || entry.userId === userId)
  );

  if (index === -1) return false;
  reminders.splice(index, 1);
  await saveReminders(client, guildId, reminders);
  return true;
}

export async function configureDailyMotivation(client, guildId, config) {
  const normalized = {
    enabled: Boolean(config.enabled),
    channelId: config.channelId || null,
    hourUtc: Math.max(0, Math.min(23, Number(config.hourUtc ?? 9))),
    mentionRoleId: config.mentionRoleId || null,
    lastDate: config.lastDate || null,
  };

  await client.db?.set?.(dailyKey(guildId), normalized);
  return normalized;
}

export async function getDailyMotivationConfig(client, guildId) {
  return await client.db?.get?.(dailyKey(guildId), null);
}

function buildQuoteEmbed(text, title = '💡 Motivation') {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(text)
    .setTimestamp();
}

async function deliverReminder(client, guild, reminder) {
  const text = reminder.message || getRandomMotivation();
  const targetMention = `<@${reminder.targetUserId || reminder.userId}>`;
  const payload = {
    content: `${targetMention} ⏰ your motivation reminder is here.`,
    embeds: [buildQuoteEmbed(text, '⏰ Motivation Reminder')],
    allowedMentions: { users: [reminder.targetUserId || reminder.userId] },
  };

  const channel = guild.channels.cache.get(reminder.channelId)
    || await guild.channels.fetch(reminder.channelId).catch(() => null);

  if (channel?.isTextBased?.()) {
    await channel.send(payload);
    return true;
  }

  const user = await client.users.fetch(reminder.targetUserId || reminder.userId).catch(() => null);
  if (user) {
    await user.send({ embeds: payload.embeds, content: '⏰ Your motivation reminder is here.' });
    return true;
  }

  return false;
}

async function processReminders(client, guild) {
  const reminders = await getReminders(client, guild.id);
  if (!reminders.length) return;

  const now = Date.now();
  let changed = false;
  const keep = [];

  for (const reminder of reminders) {
    if (Number(reminder.runAt) > now) {
      keep.push(reminder);
      continue;
    }

    try {
      await deliverReminder(client, guild, reminder);
    } catch (error) {
      logger.warn(`Motivation reminder ${reminder.id} failed: ${error?.message || error}`);
    }

    changed = true;
    if (reminder.repeatMs) {
      keep.push({
        ...reminder,
        runAt: now + Number(reminder.repeatMs),
      });
    }
  }

  if (changed) {
    await saveReminders(client, guild.id, keep);
  }
}

async function processDailyQuote(client, guild) {
  const daily = await getDailyMotivationConfig(client, guild.id);
  if (!daily?.enabled || !daily.channelId) return;

  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== Number(daily.hourUtc) || daily.lastDate === dateKey) return;

  const channel = guild.channels.cache.get(daily.channelId)
    || await guild.channels.fetch(daily.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const roleMention = daily.mentionRoleId ? `<@&${daily.mentionRoleId}> ` : '';
  await channel.send({
    content: roleMention || undefined,
    embeds: [buildQuoteEmbed(getRandomMotivation(), '🌤️ Daily Motivation')],
    allowedMentions: daily.mentionRoleId ? { roles: [daily.mentionRoleId] } : { parse: [] },
  });

  await configureDailyMotivation(client, guild.id, {
    ...daily,
    lastDate: dateKey,
  });
}

async function schedulerTick(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await processReminders(client, guild);
      await processDailyQuote(client, guild);
    } catch (error) {
      logger.warn(`Motivation scheduler failed in ${guild.id}: ${error?.message || error}`);
    }
  }
}

export function startMotivationScheduler(client) {
  if (client.motivationSchedulerInterval) return;

  void schedulerTick(client);
  client.motivationSchedulerInterval = setInterval(
    () => void schedulerTick(client),
    SCHEDULER_INTERVAL_MS,
  );
  client.motivationSchedulerInterval.unref?.();
  logger.info('Motivation reminder scheduler started');
}
