// Saved playlists of the music player: a private panel (Playlists button on the
// player) to start a playlist, add one with its link or remove one. A saved
// playlist is its link, so starting it always loads the current songs. They are
// stored per server in PostgreSQL (guild:<id>:music-playlists), never in memory.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { CLOUDY_LOGO_URL } from '../cloudyLogoService.js';
import { CLOUDY_BRANDING } from '../cloudyBrandingService.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR } from '../../utils/embedColorPolicy.js';
import { CloudyError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { assertCanControl, getPlayer, inspectMusicLink, playQuery } from './musicActions.js';
import { prepareMusicQuery } from './musicLinks.js';

const PREFIX = 'musicpl:';
const IDLE_MS = 5 * 60_000;
const MODAL_HOLD_MS = 15 * 60_000;
const MAX_PLAYLISTS = 25; // one Discord select menu
const MAX_PER_MEMBER = 10;
const sessions = new Map();
const queues = new Map();

const storageKey = guildId => 'guild:' + guildId + ':music-playlists';
const makeId = () => randomUUID().slice(0, 12);

async function lockGuild(guildId, task) {
  const key = String(guildId);
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const next = previous.catch(() => {}).then(() => barrier);
  queues.set(key, next);
  await previous.catch(() => {});
  try { return await task(); }
  finally {
    release();
    if (queues.get(key) === next) queues.delete(key);
  }
}

async function readPlaylists(client, guildId) {
  const saved = await client.db.get(storageKey(guildId));
  return Array.isArray(saved?.items) ? saved.items : [];
}

async function writePlaylists(client, guildId, items) {
  if (await client.db.set(storageKey(guildId), { items }) === false) {
    throw new Error('Could not save the playlists.');
  }
}

export async function listPlaylists(client, guildId) {
  return structuredClone(await readPlaylists(client, guildId));
}

export async function addPlaylist(client, guildId, playlist) {
  return lockGuild(guildId, async () => {
    const items = await readPlaylists(client, guildId);
    if (items.some(item => item.url === playlist.url)) {
      throw new CloudyError('Duplicate playlist', ErrorTypes.USER_INPUT, 'That playlist is already saved.');
    }
    if (items.length >= MAX_PLAYLISTS) {
      throw new CloudyError('Too many playlists', ErrorTypes.USER_INPUT, `This server can save up to ${MAX_PLAYLISTS} playlists. Remove one first.`);
    }
    if (items.filter(item => item.ownerId === playlist.ownerId).length >= MAX_PER_MEMBER) {
      throw new CloudyError('Too many playlists', ErrorTypes.USER_INPUT, `You can save up to ${MAX_PER_MEMBER} playlists. Remove one first.`);
    }
    const entry = { id: randomUUID().slice(0, 8), ...playlist, createdAt: Date.now() };
    items.push(entry);
    await writePlaylists(client, guildId, items);
    return structuredClone(entry);
  });
}

// The member who added a playlist, or a moderator, may remove it.
export async function removePlaylist(client, guildId, id, { userId, canManage = false }) {
  return lockGuild(guildId, async () => {
    const items = await readPlaylists(client, guildId);
    const entry = items.find(item => item.id === id);
    if (!entry) return { removed: false, reason: 'missing' };
    if (entry.ownerId !== userId && !canManage) return { removed: false, reason: 'forbidden' };
    await writePlaylists(client, guildId, items.filter(item => item.id !== id));
    return { removed: true, entry: structuredClone(entry) };
  });
}

function closeSession(session, removeMessage = true) {
  clearTimeout(session.timer);
  sessions.delete(session.id);
  if (removeMessage) void Promise.resolve().then(() => session.root.deleteReply()).catch(() => {});
}

function keepSessionAlive(session, modalOpen = false) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => closeSession(session), modalOpen ? MODAL_HOLD_MS : IDLE_MS);
  session.timer.unref?.();
}

function baseEmbed(description) {
  return new EmbedBuilder().setColor(0xFFFFFF).setThumbnail(CLOUDY_LOGO_URL)
    .setFooter({ text: CLOUDY_BRANDING }).setTitle('Playlists').setDescription(description);
}

const songs = count => `${count} ${count === 1 ? 'song' : 'songs'}`;

function playlistMenu(session, items, action, placeholder) {
  return new StringSelectMenuBuilder()
    .setCustomId(PREFIX + action + ':' + session.id)
    .setPlaceholder(placeholder)
    .addOptions(items.slice(0, MAX_PLAYLISTS).map(item => ({
      label: String(item.name).slice(0, 100),
      description: (songs(item.count || 0) + ' • ' + (item.ownerName || 'Unknown')).slice(0, 100),
      value: item.id,
      emoji: { name: '🎵' },
    })));
}

export function buildPlaylistPanel(session, items) {
  if (session.view === 'remove' && items.length) {
    return {
      embeds: [baseEmbed('Choose the playlist you want to remove.')],
      components: [
        new ActionRowBuilder().addComponents(playlistMenu(session, items, 'removepick', 'Remove a playlist')),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(PREFIX + 'back:' + session.id).setLabel('Back').setStyle(ButtonStyle.Secondary),
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }
  const rows = [];
  if (items.length) rows.push(new ActionRowBuilder().addComponents(playlistMenu(session, items, 'start', 'Start a playlist')));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'add:' + session.id).setLabel('Add playlist').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'remove:' + session.id).setLabel('Remove').setStyle(ButtonStyle.Secondary).setDisabled(!items.length),
  ));
  return {
    embeds: [baseEmbed(items.length
      ? 'Pick a playlist to start it, or add a new one with its link.'
      : 'No playlists yet. Add one with the link of a playlist or album.')],
    components: rows,
    allowedMentions: { parse: [] },
  };
}

function addModal(session) {
  const link = new TextInputBuilder().setCustomId('link').setLabel('Playlist link')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)
    .setPlaceholder('Spotify, Apple Music, YouTube, Deezer ...');
  const name = new TextInputBuilder().setCustomId('name').setLabel('Name (optional)')
    .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
    .setPlaceholder('Leave empty to use the playlist name');
  return new ModalBuilder().setCustomId(PREFIX + 'modal:' + session.id).setTitle('Add playlist')
    .addComponents(new ActionRowBuilder().addComponents(link), new ActionRowBuilder().addComponents(name));
}

function removeLater(remove) {
  const timer = setTimeout(() => { void Promise.resolve().then(remove).catch(() => {}); }, 10_000);
  timer.unref?.();
}

// Notices are private and remove themselves after exactly 10 seconds.
async function notice(interaction, embed) {
  const message = await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => null);
  if (message) removeLater(() => interaction.webhook.deleteMessage(message.id));
}

async function errorNotice(interaction, error) {
  const known = error?.name === 'CloudyError' && (error.userMessage || error.message);
  if (!known) logger.warn('[MUSIC_PLAYLISTS] ' + (error?.message || error));
  const embed = errorEmbed('Playlist error', known || 'Something went wrong. Please try again.', { showDetails: false });
  embed.data.color = CLOUDY_RED_COLOR;
  await notice(interaction, embed);
}

async function silentAck(interaction) {
  if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
    await interaction.deferUpdate().catch(() => {});
  }
}

export async function openPlaylistPanel(interaction, client) {
  for (const session of sessions.values()) {
    if (session.guildId === interaction.guildId && session.userId === interaction.user.id) closeSession(session);
  }
  const session = {
    id: makeId(), guildId: interaction.guildId, userId: interaction.user.id,
    root: interaction, timer: null, view: 'main',
  };
  sessions.set(session.id, session);
  try {
    const items = await listPlaylists(client, session.guildId);
    await interaction.reply({ ...buildPlaylistPanel(session, items), flags: MessageFlags.Ephemeral });
    keepSessionAlive(session);
  } catch (error) {
    closeSession(session, false);
    throw error;
  }
}

async function showPanel(interaction, client, session, method = 'update') {
  const items = await listPlaylists(client, session.guildId);
  if (!items.length) session.view = 'main';
  await interaction[method](buildPlaylistPanel(session, items));
}

export async function handleMusicPlaylistControls(interaction, client) {
  if (!interaction.customId?.startsWith(PREFIX)) return false;
  const [type, id] = interaction.customId.slice(PREFIX.length).split(':');
  const session = sessions.get(id);
  if (!session || session.userId !== interaction.user.id) {
    await silentAck(interaction);
    return true;
  }
  keepSessionAlive(session);

  try {
    if (type === 'add' && interaction.isButton()) {
      await interaction.showModal(addModal(session));
      keepSessionAlive(session, true);
      return true;
    }

    if ((type === 'remove' || type === 'back') && interaction.isButton()) {
      session.view = type === 'remove' ? 'remove' : 'main';
      await showPanel(interaction, client, session);
      return true;
    }

    if (type === 'start' && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate();
      const items = await listPlaylists(client, session.guildId);
      const item = items.find(entry => entry.id === interaction.values[0]);
      if (!item) throw new CloudyError('Missing playlist', ErrorTypes.USER_INPUT, 'That playlist no longer exists.');
      const player = getPlayer(client, session.guildId);
      if (player) assertCanControl(interaction.member, player);
      const { embed } = await playQuery(client, interaction, item.url);
      // The confirmation replaces the panel and removes itself after 10 seconds.
      closeSession(session, false);
      await interaction.editReply({ embeds: [embed], components: [] });
      removeLater(() => interaction.deleteReply());
      return true;
    }

    if (type === 'removepick' && interaction.isStringSelectMenu()) {
      await interaction.deferUpdate();
      const result = await removePlaylist(client, session.guildId, interaction.values[0], {
        userId: interaction.user.id,
        canManage: Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)),
      });
      if (result.reason === 'forbidden') {
        throw new CloudyError('Not allowed', ErrorTypes.PERMISSION, 'Only the person who added this playlist or a moderator can remove it.');
      }
      session.view = 'main';
      await showPanel(interaction, client, session, 'editReply');
      if (result.removed) await notice(interaction, successEmbed('Playlist removed', `**${result.entry.name}** was removed.`));
      return true;
    }

    if (type === 'modal' && interaction.isModalSubmit()) {
      // Checking a link can take a few seconds: acknowledge first.
      await interaction.deferUpdate();
      keepSessionAlive(session);
      const { query, isLink } = await prepareMusicQuery(interaction.fields.getTextInputValue('link'));
      if (!isLink) throw new CloudyError('Not a link', ErrorTypes.USER_INPUT, 'Paste the link of a playlist or album.');
      const result = await inspectMusicLink(client, query, interaction.user);
      if (!['playlist', 'PLAYLIST_LOADED'].includes(result.loadType)) {
        throw new CloudyError('Not a playlist', ErrorTypes.USER_INPUT, 'That link is a single song. Paste the link of a playlist or album.');
      }
      const typed = interaction.fields.getTextInputValue('name').trim();
      const entry = await addPlaylist(client, session.guildId, {
        url: query,
        name: (typed || result.playlistInfo?.name || 'Playlist').slice(0, 80),
        count: result.tracks.length,
        ownerId: interaction.user.id,
        ownerName: String(interaction.user.username || 'Unknown').slice(0, 40),
      });
      session.view = 'main';
      await showPanel(interaction, client, session, 'editReply');
      await notice(interaction, successEmbed('Playlist added', `**${entry.name}** · ${songs(entry.count)}`));
      return true;
    }

    await silentAck(interaction);
  } catch (error) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    await errorNotice(interaction, error);
    keepSessionAlive(session);
  }
  return true;
}
