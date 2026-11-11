// Saved playlists of the music player: the player's Add button opens the form to
// add one with its link at once; then a private list starts or deletes one. A saved
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
import { errorEmbed } from '../../utils/embeds.js';
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
  if (removeMessage && session.root) void Promise.resolve().then(() => session.root.deleteReply()).catch(() => {});
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

// Owner's choice: the player's Add button opens the form at once (no panel
// first); after it the saved playlists are shown as a list with Start and Delete.
export function buildPlaylistPanel(session, items) {
  const note = session.note ? `${session.note}\n\n` : '';
  if (!items.length) {
    return {
      embeds: [baseEmbed(`${note}No playlists yet. Press Add and paste the link of a playlist or album.`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(PREFIX + 'add:' + session.id).setLabel('Add').setStyle(ButtonStyle.Success).setEmoji('🎵'),
      )],
      allowedMentions: { parse: [] },
    };
  }
  const focus = items.find(item => item.id === session.focusId) || items[0];
  session.focusId = focus.id;
  return {
    embeds: [baseEmbed(`${note}Choose a playlist, then Start or Delete it.`)],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(PREFIX + 'pick:' + session.id)
        .setPlaceholder('Choose a playlist')
        .addOptions(items.slice(0, MAX_PLAYLISTS).map(item => ({
          label: String(item.name).slice(0, 100),
          description: (songs(item.count || 0) + ' • ' + (item.ownerName || 'Unknown')).slice(0, 100),
          value: item.id,
          emoji: { name: '🎵' },
          default: item.id === focus.id,
        })))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(PREFIX + 'play:' + session.id).setLabel('Start').setStyle(ButtonStyle.Success).setEmoji('▶️'),
        new ButtonBuilder().setCustomId(PREFIX + 'delete:' + session.id).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId(PREFIX + 'add:' + session.id).setLabel('Add').setStyle(ButtonStyle.Secondary).setEmoji('🎵'),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function addModal(session) {
  // Empty link: just show the saved playlists (to start or delete one).
  const link = new TextInputBuilder().setCustomId('link').setLabel('Playlist link')
    .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)
    .setPlaceholder('Spotify, Apple Music, YouTube ... or empty: your list');
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

function playlistErrorEmbed(error) {
  const known = error?.name === 'CloudyError' && (error.userMessage || error.message);
  if (!known) logger.warn('[MUSIC_PLAYLISTS] ' + (error?.message || error));
  const embed = errorEmbed('Playlist error', known || 'Something went wrong. Please try again.', { showDetails: false });
  embed.data.color = CLOUDY_RED_COLOR;
  return embed;
}

async function errorNotice(interaction, error) {
  await notice(interaction, playlistErrorEmbed(error));
}

async function silentAck(interaction) {
  if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
    await interaction.deferUpdate().catch(() => {});
  }
}

// The player's Add button: the form opens at once.
export async function openPlaylistPanel(interaction, client) {
  for (const session of sessions.values()) {
    if (session.guildId === interaction.guildId && session.userId === interaction.user.id) closeSession(session);
  }
  const session = {
    id: makeId(), guildId: interaction.guildId, userId: interaction.user.id,
    root: null, timer: null, focusId: null, note: '',
  };
  sessions.set(session.id, session);
  try {
    await interaction.showModal(addModal(session));
    keepSessionAlive(session, true);
  } catch (error) {
    closeSession(session, false);
    throw error;
  }
}

async function showPanel(interaction, client, session, method = 'update') {
  const items = await listPlaylists(client, session.guildId);
  await interaction[method](buildPlaylistPanel(session, items));
  session.note = '';
}

// Starts a saved playlist. The list goes away: the player panel shows the songs.
async function startSavedPlaylist(interaction, client, session, playlistId) {
  await interaction.deferUpdate();
  const items = await listPlaylists(client, session.guildId);
  const item = items.find(entry => entry.id === playlistId);
  if (!item) throw new CloudyError('Missing playlist', ErrorTypes.USER_INPUT, 'That playlist no longer exists.');
  const player = getPlayer(client, session.guildId);
  if (player) assertCanControl(interaction.member, player);
  await playQuery(client, interaction, item.url);
  closeSession(session, false);
  await interaction.deleteReply().catch(() => {});
}

async function deletePlaylist(interaction, client, session, playlistId) {
  const result = await removePlaylist(client, session.guildId, playlistId, {
    userId: interaction.user.id,
    canManage: Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)),
  });
  if (result.reason === 'forbidden') {
    throw new CloudyError('Not allowed', ErrorTypes.PERMISSION, 'Only the person who added this playlist or a moderator can remove it.');
  }
  session.focusId = null;
  if (result.removed) session.note = `**${String(result.entry.name).slice(0, 200)}** was deleted.`;
  await showPanel(interaction, client, session, 'editReply');
}

async function addFromForm(interaction, client, session) {
  const raw = interaction.fields.getTextInputValue('link').trim();
  if (!raw) return;
  const { query, isLink } = await prepareMusicQuery(raw);
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
  session.focusId = entry.id;
  session.note = `**${entry.name}** was added · ${songs(entry.count)}`;
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
  // The form sent from the player's Add button has no private list yet.
  const firstAnswer = type === 'modal' && interaction.isModalSubmit() && !session.root;

  try {
    if (type === 'add' && interaction.isButton()) {
      await interaction.showModal(addModal(session));
      keepSessionAlive(session, true);
      return true;
    }

    if (type === 'pick' && interaction.isStringSelectMenu()) {
      session.focusId = interaction.values[0];
      await showPanel(interaction, client, session);
      return true;
    }

    if (type === 'play' && interaction.isButton()) {
      await startSavedPlaylist(interaction, client, session, session.focusId);
      return true;
    }

    if (type === 'delete' && interaction.isButton()) {
      await interaction.deferUpdate();
      await deletePlaylist(interaction, client, session, session.focusId);
      return true;
    }

    if (type === 'modal' && interaction.isModalSubmit()) {
      // Checking a link can take a few seconds: acknowledge first. From the player
      // the answer is a new private message; from the list it updates the list.
      if (firstAnswer) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        session.root = interaction;
      } else {
        await interaction.deferUpdate();
      }
      keepSessionAlive(session);
      await addFromForm(interaction, client, session);
      await showPanel(interaction, client, session, 'editReply');
      return true;
    }

    await silentAck(interaction);
  } catch (error) {
    if (firstAnswer && interaction.deferred) {
      // Nothing to go back to: the error is the private answer, gone after 10 seconds.
      closeSession(session, false);
      await interaction.editReply({ embeds: [playlistErrorEmbed(error)], components: [] }).catch(() => {});
      removeLater(() => interaction.deleteReply());
      return true;
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    await errorNotice(interaction, error);
    keepSessionAlive(session);
  }
  return true;
}
