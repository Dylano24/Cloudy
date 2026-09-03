import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';

const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const WARNING_DELETE_MS = 15 * 1000;
const MESSAGE_WINDOW_MS = 10 * 1000;
const LINK_WINDOW_MS = 15 * 1000;
const BOT_SPAM_WINDOW_MS = 6 * 1000;
const JOIN_WINDOW_MS = 10 * 1000;
const NSFW_OFFENSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_SWEEP_INTERVAL = 250;

const messageActivity = new Map();
const joinActivity = new Map();
const nsfwOffenses = new Map();
let activitySweepCounter = 0;

function isStaff(message) {
  return Boolean(
    message.member?.permissions?.has(PermissionFlagsBits.Administrator)
    || message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
  );
}

function countLinks(content = '') {
  return (String(content).match(/(?:https?:\/\/|www\.|discord\.gg\/)/gi) || []).length;
}

function getMessageKey(message) {
  return `${message.guild.id}:${message.author.id}`;
}

function prune(entries, now, windowMs) {
  return entries.filter(entry => now - entry.timestamp <= windowMs);
}

function sweepActivityMap(map, now, windowMs) {
  for (const [key, entries] of map) {
    const current = prune(Array.isArray(entries) ? entries : [], now, windowMs);
    if (current.length === 0) map.delete(key);
    else if (current.length !== entries.length) map.set(key, current);
  }
}

function maybeSweepActivityMaps(now) {
  activitySweepCounter += 1;
  if (activitySweepCounter % ACTIVITY_SWEEP_INTERVAL !== 0) return;

  sweepActivityMap(messageActivity, now, Math.max(LINK_WINDOW_MS, MESSAGE_WINDOW_MS));
  sweepActivityMap(joinActivity, now, JOIN_WINDOW_MS);
  sweepActivityMap(nsfwOffenses, now, NSFW_OFFENSE_WINDOW_MS);
}

function recordMessageActivity(message) {
  const now = Date.now();
  maybeSweepActivityMaps(now);
  const key = getMessageKey(message);
  const previous = prune(messageActivity.get(key) || [], now, Math.max(LINK_WINDOW_MS, MESSAGE_WINDOW_MS));
  previous.push({
    timestamp: now,
    channelId: message.channel.id,
    links: countLinks(message.content),
    mentions: message.mentions?.users?.size || 0,
    content: String(message.content || '').trim().toLowerCase(),
  });
  messageActivity.set(key, previous);
  return previous;
}

function getSpamDecision(message, activity) {
  const now = Date.now();
  const recentMessages = activity.filter(entry => now - entry.timestamp <= MESSAGE_WINDOW_MS);
  const recentLinks = activity.filter(entry => now - entry.timestamp <= LINK_WINDOW_MS);
  const botBurst = activity.filter(entry => now - entry.timestamp <= BOT_SPAM_WINDOW_MS);

  const linkCount = recentLinks.reduce((sum, entry) => sum + entry.links, 0);
  const mentionCount = recentMessages.reduce((sum, entry) => sum + entry.mentions, 0);
  const channelCount = new Set(recentMessages.map(entry => entry.channelId)).size;
  const repeatedContent = recentMessages.filter(entry => entry.content && entry.content === recentMessages.at(-1)?.content).length;

  if (message.author.bot && (botBurst.length >= 6 || linkCount >= 4 || (recentMessages.length >= 8 && channelCount >= 2))) {
    return { action: 'ban', reason: 'Automod: bot spam or raid behavior detected' };
  }

  if (linkCount >= 7) {
    return { action: message.author.bot ? 'ban' : 'timeout', durationMs: 60 * 60 * 1000, reason: 'Automod: excessive link spam' };
  }

  if ((recentMessages.length >= 12 && channelCount >= 3) || mentionCount >= 12) {
    return { action: 'ban', reason: 'Automod: raid-like behavior detected' };
  }

  if (recentMessages.length >= 9 || repeatedContent >= 6) {
    return { action: 'timeout', durationMs: 10 * 60 * 1000, reason: 'Automod: message spam detected' };
  }

  return null;
}

function getImageUrls(message) {
  const urls = [];

  for (const attachment of message.attachments?.values?.() || []) {
    const type = String(attachment.contentType || '').toLowerCase();
    const name = String(attachment.name || '').toLowerCase();
    if (type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif)$/i.test(name)) {
      urls.push(attachment.url);
    }
  }

  for (const embed of message.embeds || []) {
    if (embed?.image?.url) urls.push(embed.image.url);
    if (embed?.thumbnail?.url) urls.push(embed.thumbnail.url);
  }

  return [...new Set(urls)].slice(0, 4);
}

async function moderateImageUrl(url) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !url) return { unsafe: false, unavailable: true };

  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url } }],
      }),
    });

    if (!response.ok) {
      logger.warn(`Image moderation request failed with status ${response.status}`);
      return { unsafe: false, unavailable: true };
    }

    const data = await response.json();
    const result = data?.results?.[0];
    const categories = result?.categories || {};
    const scores = result?.category_scores || {};

    const sexual = Boolean(categories.sexual) || Number(scores.sexual || 0) >= 0.72;
    const sexualMinors = Boolean(categories['sexual/minors']) || Number(scores['sexual/minors'] || 0) >= 0.12;
    const graphic = Boolean(categories['violence/graphic']) || Number(scores['violence/graphic'] || 0) >= 0.85;

    return { unsafe: sexual || sexualMinors || graphic, sexual, sexualMinors, graphic };
  } catch (error) {
    logger.warn('Image moderation request failed:', error);
    return { unsafe: false, unavailable: true };
  }
}

async function sendWarning(message, title, description) {
  const warning = await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(getColor('red'))
        .setTitle(title)
        .setDescription(`<@${message.author.id}>, ${description}`)
        .setThumbnail(CLOUDY_C_LOGO_URL)
        .setFooter({ text: 'This notice will be removed automatically.' }),
    ],
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);

  if (warning) {
    const timer = setTimeout(() => {
      void warning.delete().catch(() => {});
    }, WARNING_DELETE_MS);
    timer.unref?.();
  }
}

async function punish(message, decision) {
  if (!decision) return false;

  await message.delete().catch(() => {});

  if (decision.action === 'ban') {
    if (message.member?.bannable) {
      await message.member.ban({ reason: decision.reason, deleteMessageSeconds: 60 }).catch(error => {
        logger.warn(`Could not ban ${message.author.tag}:`, error);
      });
    }
    return true;
  }

  if (decision.action === 'timeout' && message.member?.moderatable) {
    await message.member.timeout(decision.durationMs, decision.reason).catch(error => {
      logger.warn(`Could not timeout ${message.author.tag}:`, error);
    });
    await sendWarning(message, 'Spam detected', 'your message was removed because spam or excessive links were detected.');
    return true;
  }

  return false;
}

async function handleImageModeration(message) {
  if (isStaff(message)) return false;
  const imageUrls = getImageUrls(message);
  if (imageUrls.length === 0) return false;

  const results = await Promise.all(imageUrls.map(url => moderateImageUrl(url)));
  const unsafeResult = results.find(result => result.unsafe);
  if (!unsafeResult) return false;

  await message.delete().catch(() => {});

  const key = getMessageKey(message);
  const now = Date.now();
  const previous = prune(nsfwOffenses.get(key) || [], now, NSFW_OFFENSE_WINDOW_MS);
  previous.push({ timestamp: now });
  nsfwOffenses.set(key, previous);

  if (previous.length >= 3 && message.member?.bannable) {
    await message.member.ban({ reason: 'Automod: repeated explicit or graphic image violations', deleteMessageSeconds: 60 }).catch(() => {});
    return true;
  }

  if (previous.length >= 2 && message.member?.moderatable) {
    await message.member.timeout(60 * 60 * 1000, 'Automod: repeated explicit or graphic image violation').catch(() => {});
  }

  await sendWarning(
    message,
    'Image removed',
    previous.length >= 2
      ? 'your image was removed because it was detected as explicit or graphic. Repeated violations can result in a ban.'
      : 'your image was removed because it was detected as explicit or graphic. Please keep images appropriate for the server.'
  );
  return true;
}

export async function enforceAutomodProtection(message) {
  if (!message?.guild || !message.author || message.author.id === message.client?.user?.id) return false;
  if (isStaff(message)) return false;

  const activity = recordMessageActivity(message);
  const decision = getSpamDecision(message, activity);
  if (decision) return punish(message, decision);

  return handleImageModeration(message);
}

export async function enforceJoinRaidProtection(member) {
  if (!member?.guild || !member.user) return false;

  const now = Date.now();
  maybeSweepActivityMaps(now);
  const guildId = member.guild.id;
  const recent = prune(joinActivity.get(guildId) || [], now, JOIN_WINDOW_MS);
  recent.push({ timestamp: now, userId: member.id, bot: member.user.bot });
  joinActivity.set(guildId, recent);

  const botJoins = recent.filter(entry => entry.bot).length;
  const totalJoins = recent.length;

  const suspiciousBotRaid = member.user.bot && (botJoins >= 4 || totalJoins >= 10);
  if (!suspiciousBotRaid) return false;

  if (member.bannable) {
    await member.ban({ reason: 'Automod: suspected bot raid join burst' }).catch(error => {
      logger.warn(`Could not ban suspected raid bot ${member.user.tag}:`, error);
    });
    return true;
  }

  return false;
}
