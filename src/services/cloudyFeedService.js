import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  EmbedBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { hasCloudyOwnerMember, hasCloudyOwnerRole } from './ownerRoleAccess.js';
import { readWebsiteItems, validateSourceUrl } from './cloudyFeedParser.js';
import { logger } from '../utils/logger.js';

const PREFIX = 'cloudyfeed:';
const MAX_FEEDS = 5;
const MIN_MINUTES = 1;
const MAX_MINUTES = 10080;
const DASHBOARD_MS = 5 * 60_000;
const running = new Set();

function storageKey(guildId) {
  return 'guild:' + guildId + ':cloudy:feeds';
}

export async function readFeeds(client, guildId) {
  const data = await client.db.get(storageKey(guildId), []);
  return Array.isArray(data) ? data : [];
}

async function saveFeeds(client, guildId, feeds) {
  if (client.db.getStatus().isDegraded) throw new Error('Persistent storage is currently unavailable.');
  await client.db.set(storageKey(guildId), feeds);
}

async function withGuildLock(client, guildId, operation) {
  const pool = client.db?.db?.pool;
  if (!pool) {
    if (client.db?.getStatus?.().isDegraded) throw new Error('Persistent storage is unavailable.');
    return operation();
  }
  const connection = await pool.connect();
  let locked = false;
  try {
    const response = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked', [
      'cloudyfeed:' + guildId,
    ]);
    locked = response.rows[0]?.locked === true;
    if (!locked) return null;
    return await operation();
  } finally {
    if (locked) {
      await connection.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [
        'cloudyfeed:' + guildId,
      ]).catch(error => logger.error('[CLOUDY_FEED] Could not unlock guild feed:', error));
    }
    connection.release();
  }
}

function dashboard(guildId, feeds) {
  const embed = new EmbedBuilder()
    .setTitle('Cloudy feed')
    .setDescription('Configure automatic posts from websites. Cloudy will randomly select new content and post it to your chosen channel.')
    .setColor(0xFFFFFF);
  if (!feeds.length) {
    embed.addFields({ name: 'Feeds', value: 'No feeds configured.' });
  }
  for (const feed of feeds.slice(0, MAX_FEEDS)) {
    embed.addFields({
      name: 'Feed ' + feed.id,
      value: '**Source:** ' + feed.source.slice(0, 170)
        + '\n**Channel:** <#' + feed.channelId + '>'
        + '\n**Auto message:** Every ' + feed.minutes + ' minutes'
        + '\n**Status:** ' + (feed.active ? 'Active' : 'Paused'),
    });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'add:' + guildId).setLabel('Add feed').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'edit:' + guildId).setLabel('Edit feed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'pause:' + guildId).setLabel('Pause feed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'delete:' + guildId).setLabel('Delete feed').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function input(id, label, required = true, placeholder = '') {
  const component = new TextInputBuilder().setCustomId(id).setLabel(label)
    .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(500);
  if (placeholder) component.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(component);
}

function buildModal(action, guildId) {
  const modal = new ModalBuilder().setCustomId(PREFIX + 'submit:' + action + ':' + guildId)
    .setTitle(action === 'add' ? 'Add feed' : action === 'edit' ? 'Edit feed' : action === 'delete' ? 'Delete feed' : 'Pause or resume feed');

  if (action === 'add') {
    return modal.addComponents(
      input('source', 'Website URL', true, 'https://example.com'),
      input('channel', 'Channel ID', true, 'Discord text channel ID'),
      input('minutes', 'Auto message (minutes)', true, '30'),
      input('adult', '18+ content? (yes/no)', false, 'no'),
    );
  }
  modal.addComponents(input('feedId', 'Feed ID', true, 'Shown in Cloudy feed'));
  if (action === 'edit') {
    modal.addComponents(
      input('source', 'New website URL', false, 'Leave blank to keep current'),
      input('channel', 'New channel ID', false, 'Leave blank to keep current'),
      input('minutes', 'Auto message (minutes)', false, 'Leave blank to keep current'),
      input('adult', '18+ content? (yes/no)', false, 'Leave blank to keep current'),
    );
  }
  return modal;
}

export async function handleFeedOpenMessage(message) {
  if (!message.guild || message.author?.bot || message.webhookId
      || String(message.content || '').trim().toLowerCase() !== '!cloudyfeed') return false;
  // Never answer or DM users without the server's exact Owner role.
  if (!hasCloudyOwnerRole(message)) return true;
  try {
    const feeds = await readFeeds(message.client, message.guild.id);
    const sent = await message.author.send(dashboard(message.guild.id, feeds));
    const timer = setTimeout(() => sent.edit({ components: [] }).catch(() => {}), DASHBOARD_MS);
    timer.unref?.();
    if (message.deletable) await message.delete().catch(() => {});
  } catch (error) {
    logger.warn('[CLOUDY_FEED] Could not open owner feed in DM:', error);
  }
  return true;
}

async function ownerOfGuild(interaction, client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  return hasCloudyOwnerMember(member) ? guild : null;
}

function parseMinutes(value) {
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    throw new Error('Auto message must be between 1 and 10080 minutes.');
  }
  return minutes;
}

function parseAdult(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['yes', 'true', '1'].includes(normalized)) return true;
  if (['no', 'false', '0'].includes(normalized)) return false;
  throw new Error('18+ content must be yes or no.');
}

async function validateChannel(guild, channelId, adult) {
  if (!/^\d{16,22}$/.test(String(channelId))) throw new Error('Enter a valid Discord channel ID.');
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('Select a text or announcement channel.');
  }
  if (adult && (!channel.nsfw || channel.type !== ChannelType.GuildText)) {
    throw new Error('18+ sources require an age-restricted text channel.');
  }
  const me = guild.members.me || await guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  ])) throw new Error('Cloudy needs View Channel, Send Messages and Embed Links.');
  return channel;
}

function field(interaction, name) {
  return interaction.fields.getTextInputValue(name).trim();
}

export function mediaCandidates(items) {
  return items.filter(item => Boolean(item.image || item.video));
}

export function mediaItemKey(item) {
  return item.video || item.image || item.url;
}

export async function applyAction(interaction, guild, action, input = {}) {
  const get = (name) => Object.hasOwn(input, name) ? String(input[name] ?? '').trim() : field(interaction, name);
  return withGuildLock(interaction.client, guild.id, async () => {
    const feeds = await readFeeds(interaction.client, guild.id);
    const now = Date.now();
    if (action === 'add') {
      if (feeds.length >= MAX_FEEDS) throw new Error('Maximum five feeds per server.');
      const source = validateSourceUrl(get('source')).href;
      const minutes = parseMinutes(get('minutes'));
      const adult = parseAdult(get('adult'));
      const channel = await validateChannel(guild, get('channel'), adult);
      const items = mediaCandidates(await readWebsiteItems(source));
      if (!items.length) throw new Error('No supported photos or videos found. Choose a public gallery, media page or supported feed.');
      const id = randomUUID().slice(0, 8);
      const name = (get('name') || (host => host.charAt(0).toUpperCase() + host.slice(1))(new URL(source).hostname.replace(/^(?:www|nl)\./i, '').split('.')[0])).slice(0, 64);
      feeds.push({ id, name, source, channelId: channel.id, channelName: channel.name, minutes, adult, active: true,
        nextAt: now + minutes * 60_000, recentUrls: [], lastError: null, lastCheck: now });
    } else {
      const id = get('feedId');
      const feed = feeds.find(value => value.id === id);
      if (!feed) throw new Error('No feed found with that ID.');
      if (action === 'delete') {
        feeds.splice(feeds.indexOf(feed), 1);
      } else if (action === 'pause') {
        feed.active = !feed.active;
        feed.nextAt = now + feed.minutes * 60_000;
      } else if (action === 'edit') {
        const newUrl = get('source');
        const source = newUrl ? validateSourceUrl(newUrl).href : feed.source;
        const minutes = get('minutes') ? parseMinutes(get('minutes')) : feed.minutes;
        const adult = parseAdult(get('adult'), feed.adult);
        const channel = await validateChannel(guild, get('channel') || feed.channelId, adult);
        const sourceChanged = source !== feed.source;
        if (sourceChanged) {
          const items = mediaCandidates(await readWebsiteItems(source));
          if (!items.length) throw new Error('No supported photos or videos found at the new website.');
          feed.recentUrls = [];
        }
        const name = (get('name') || feed.name || new URL(source).hostname.replace(/^(?:www|nl)\./i, '').split('.')[0]).slice(0, 64);
        Object.assign(feed, { name, source, channelId: channel.id, channelName: channel.name, adult, minutes,
          nextAt: now + minutes * 60_000,
          ...(sourceChanged ? { lastError: null, lastCheck: now } : {}) });
      }
    }
    await saveFeeds(interaction.client, guild.id, feeds);
    return feeds;
  });
}

export async function handleFeedInteraction(interaction, client) {
  if (!(interaction.isButton() || interaction.isModalSubmit())
      || !interaction.customId?.startsWith(PREFIX)) return false;

  const parts = interaction.customId.slice(PREFIX.length).split(':');
  const modal = parts[0] === 'submit';
  const action = modal ? parts[1] : parts[0];
  const guildId = modal ? parts[2] : parts[1];
  if (!['add', 'edit', 'pause', 'delete'].includes(action) || !/^\d{16,22}$/.test(guildId || '')) return true;

  const guild = await ownerOfGuild(interaction, client, guildId);
  if (!guild) {
    // Owner-only DM panel: no permission denied or invalid response for other users.
    if (interaction.isButton()) await interaction.deferUpdate().catch(() => {});
    return true;
  }

  if (!modal) {
    await interaction.showModal(buildModal(action, guildId));
    return true;
  }

  await interaction.deferUpdate();
  try {
    const feeds = await applyAction(interaction, guild, action);
    if (!feeds) throw new Error('Cloudy feed is busy. Try again.');
    await interaction.editReply(dashboard(guildId, feeds));
  } catch (error) {
    logger.warn('[CLOUDY_FEED] Owner change failed:', error);
    await interaction.followUp({ content: error.message || 'Could not update Cloudy feed.' }).then(reply => {
      const timer = setTimeout(() => reply.delete().catch(() => {}), 10_000);
      timer.unref?.();
    }).catch(() => {});
  }
  return true;
}

async function processGuild(client, guild) {
  return withGuildLock(client, guild.id, async () => {
    const feeds = await readFeeds(client, guild.id);
    let changed = false;
    for (const feed of feeds) {
      if (!feed.active || !Number.isFinite(feed.nextAt) || feed.nextAt > Date.now()) continue;
      const next = Date.now() + Math.max(MIN_MINUTES, feed.minutes) * 60_000;
      try {
        const channel = await validateChannel(guild, feed.channelId, feed.adult);
        const candidates = mediaCandidates(await readWebsiteItems(feed.source));
        const seen = new Set(feed.recentUrls || []);
        const available = candidates.filter(item => !seen.has(mediaItemKey(item)));
        if (!candidates.length) {
          feed.lastError = 'No supported photos or videos found';
        } else if (!available.length) {
          feed.lastError = 'No new media available';
        } else {
          const item = available[Math.floor(Math.random() * available.length)];
          // Reserve the item before posting to avoid double sends on retry/restart.
          feed.recentUrls = [...seen, mediaItemKey(item)].slice(-200);
          feed.nextAt = next;
          await saveFeeds(client, guild.id, feeds);
          const embed = new EmbedBuilder().setColor(0xFFFFFF).setTitle(item.title).setURL(item.url);
          if (item.description) embed.setDescription(item.description);
          if (item.image) embed.setImage(item.image);
          // Discord supports direct video URLs as linked content, not EmbedBuilder.setVideo.
          // This never copies or redistributes files that a website forbids downloading.
          await channel.send({
            content: item.video || undefined,
            embeds: [embed],
            allowedMentions: { parse: [] },
          });
          feed.lastError = null;
          feed.lastPostedAt = Date.now();
        }
      } catch (error) {
        feed.lastError = String(error?.message || 'Website unavailable').slice(0, 180);
        logger.warn('[CLOUDY_FEED] Scheduled feed failed (' + feed.id + '):', error);
      }
      feed.lastCheck = Date.now();
      feed.nextAt = next;
      changed = true;
    }
    if (changed) await saveFeeds(client, guild.id, feeds);
  });
}
export async function runCloudyFeedSchedule(client) {
  if (!client.isReady() || client.db?.getStatus?.().isDegraded) return;
  await Promise.allSettled([...client.guilds.cache.values()].map(async guild => {
    if (running.has(guild.id)) return;
    running.add(guild.id);
    try { await processGuild(client, guild); }
    finally { running.delete(guild.id); }
  }));
}

export function startCloudyFeedSchedule(client) {
  if (client.cloudyFeedScheduler) return;
  const timer = setInterval(() => {
    void runCloudyFeedSchedule(client).catch(error => logger.error('[CLOUDY_FEED] Scheduler failed:', error));
  }, 60_000);
  timer.unref?.();
  client.cloudyFeedScheduler = timer;
}
