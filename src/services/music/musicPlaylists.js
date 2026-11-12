// The music player's list (owner's choice): songs and playlists a server keeps to
// start later. The player's 🎵 Add button opens one form at once that shows the
// list and has a field to add a song or playlist, a Start choice and a Remove
// choice. An item is its link, so starting a playlist always loads its current
// songs. Stored per server in PostgreSQL (guild:<id>:music-playlists), never in memory.
import {
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { CLOUDY_LOGO_URL } from '../cloudyLogoService.js';
import { CLOUDY_BRANDING } from '../cloudyBrandingService.js';
import { CLOUDY_RED_COLOR } from '../../utils/embedColorPolicy.js';
import { CloudyError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { assertCanControl, getPlayer, inspectMusicLink, playQuery } from './musicActions.js';
import { prepareMusicQuery } from './musicLinks.js';

const PREFIX = 'musicpl:';
const MAX_PLAYLISTS = 25; // one Discord select menu
const MAX_PER_MEMBER = 10;
// Discord waits 3 seconds for the form; a slow database never makes Add fail.
const LIST_WAIT_MS = 1_500;
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
      throw new CloudyError('Duplicate playlist', ErrorTypes.USER_INPUT, `**${playlist.name}** is already in your list.`);
    }
    if (items.length >= MAX_PLAYLISTS) {
      throw new CloudyError('Too many playlists', ErrorTypes.USER_INPUT, `The list holds up to ${MAX_PLAYLISTS} songs and playlists. Remove one first.`);
    }
    if (items.filter(item => item.ownerId === playlist.ownerId).length >= MAX_PER_MEMBER) {
      throw new CloudyError('Too many playlists', ErrorTypes.USER_INPUT, `You can add up to ${MAX_PER_MEMBER} songs and playlists. Remove one first.`);
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

const songs = count => `${count} ${count === 1 ? 'song' : 'songs'}`;
const itemKind = item => (item.kind === 'song' ? 'song' : songs(item.count || 0));
const itemName = item => String(item?.name || 'Untitled').replace(/\*/g, '').slice(0, 80);

function listText(items) {
  if (!items) return '**Your list**\nYour list could not be loaded right now. Open Add again in a moment.';
  if (!items.length) return '**Your list**\nYour list is empty. Add a song or a playlist below.';
  return ['**Your list**', ...items.slice(0, MAX_PLAYLISTS)
    .map((item, index) => `${index + 1}. ${itemName(item)} · ${itemKind(item)}`)].join('\n').slice(0, 3900);
}

function itemSelect(customId, items, placeholder, multiple) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(multiple ? Math.min(items.length, MAX_PLAYLISTS) : 1)
    .addOptions(items.slice(0, MAX_PLAYLISTS).map(item => ({
      label: itemName(item).slice(0, 100),
      description: `${itemKind(item)} • ${item.ownerName || 'Unknown'}`.slice(0, 100),
      value: item.id,
      emoji: { name: item.kind === 'song' ? '🎶' : '🎵' },
    })));
}

// One form, opened at once by the player's Add button: the list itself, a field
// to add a song or playlist, and (when the list has something) Start and Remove.
// Every opening gets its own id. `items` null means the list could not be read.
export function buildListModal(items) {
  const add = new TextInputBuilder().setCustomId('add').setStyle(TextInputStyle.Short)
    .setRequired(false).setMaxLength(500).setPlaceholder('Song name, or a song or playlist link');
  const labels = [new LabelBuilder().setLabel('Add a song or playlist')
    .setDescription('A song name, or a link from Spotify, YouTube, Apple Music, SoundCloud ...')
    .setTextInputComponent(add)];
  if (items?.length) {
    labels.push(
      new LabelBuilder().setLabel('Start').setDescription('Play one from your list now')
        .setStringSelectMenuComponent(itemSelect('start', items, 'Choose what to play', false)),
      new LabelBuilder().setLabel('Remove').setDescription('Remove from your list')
        .setStringSelectMenuComponent(itemSelect('remove', items, 'Choose what to remove', true)),
    );
  }
  return new ModalBuilder().setCustomId(PREFIX + 'modal:' + makeId()).setTitle('Add to your list')
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(listText(items)))
    .addLabelComponents(...labels);
}

function removeLater(remove) {
  const timer = setTimeout(() => { void Promise.resolve().then(remove).catch(() => {}); }, 10_000);
  timer.unref?.();
}

function userMessageOf(error) {
  const known = error?.name === 'CloudyError' && (error.userMessage || error.message);
  if (!known) logger.warn('[MUSIC_PLAYLISTS] ' + (error?.message || error));
  return known || 'Something went wrong. Please try again.';
}

function resultEmbed(lines, failed) {
  return new EmbedBuilder().setColor(failed ? CLOUDY_RED_COLOR : 0xFFFFFF).setThumbnail(CLOUDY_LOGO_URL)
    .setFooter({ text: CLOUDY_BRANDING }).setTitle('Your list').setDescription(lines.join('\n').slice(0, 4000));
}

function selectedValues(interaction, customId) {
  try { return interaction.fields.getStringSelectValues(customId) || []; } catch { return []; }
}

function typedValue(interaction, customId) {
  try { return String(interaction.fields.getTextInputValue(customId) || '').trim(); } catch { return ''; }
}

async function silentAck(interaction) {
  if (interaction.isButton?.() || interaction.isAnySelectMenu?.() || interaction.isModalSubmit?.()) {
    await interaction.deferUpdate().catch(() => {});
  }
}

async function listForForm(client, guildId) {
  let timer;
  const slow = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), LIST_WAIT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([listPlaylists(client, guildId).catch(() => null), slow]);
  } finally {
    clearTimeout(timer);
  }
}

// The player's Add button: the form with the list opens at once.
export async function openPlaylistPanel(interaction, client) {
  const items = await listForForm(client, interaction.guildId);
  await interaction.showModal(buildListModal(items));
}

// A song name or a song/playlist link: looked up once, then saved as its link.
async function addToList(interaction, client, guildId, raw) {
  const { query, isLink } = await prepareMusicQuery(raw);
  let result;
  try {
    result = await inspectMusicLink(client, query, interaction.user);
  } catch (error) {
    if (!isLink && error?.name === 'CloudyError' && error.type === ErrorTypes.USER_INPUT) {
      throw new CloudyError('No song found', ErrorTypes.USER_INPUT, `No song was found for **${String(raw).slice(0, 80)}**.`);
    }
    throw error;
  }
  const playlist = ['playlist', 'PLAYLIST_LOADED'].includes(result.loadType);
  const first = result.tracks?.[0]?.info || {};
  const entry = playlist
    ? { url: query, name: String(result.playlistInfo?.name || 'Playlist').slice(0, 80), count: result.tracks.length, kind: 'playlist' }
    : { url: isLink ? query : first.uri, name: String(first.title || raw).slice(0, 80), artist: String(first.author || '').slice(0, 80), count: 1, kind: 'song' };
  if (!/^https?:\/\//i.test(String(entry.url || ''))) {
    throw new CloudyError('No song found', ErrorTypes.USER_INPUT, `No song was found for **${String(raw).slice(0, 80)}**.`);
  }
  return addPlaylist(client, guildId, {
    ...entry,
    ownerId: interaction.user.id,
    ownerName: String(interaction.user.username || 'Unknown').slice(0, 40),
  });
}

// The private notice: an edit of the deferred answer, or (after a quiet Start)
// a follow-up. Either way it goes away after 10 seconds.
async function sendNotice(interaction, state, lines, failed) {
  const embeds = [resultEmbed(lines, failed)];
  if (state.quiet) {
    const notice = await interaction.followUp({ embeds, flags: MessageFlags.Ephemeral });
    removeLater(() => interaction.deleteReply(notice));
    return;
  }
  if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds, components: [] });
  else await interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
  removeLater(() => interaction.deleteReply());
}

// One answer for the whole form: what was removed, added and started, in one
// notice. A Start alone shows nothing (the player panel shows the songs), only
// an error.
async function handleListForm(interaction, client, state) {
  const guildId = interaction.guildId;
  const removeIds = selectedValues(interaction, 'remove');
  const [startId] = selectedValues(interaction, 'start');
  const raw = typedValue(interaction, 'add');
  if (!removeIds.length && !raw && !startId) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  if (!removeIds.length && !raw) {
    await interaction.deferUpdate();
    state.quiet = true;
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  // Read before anything is removed, so Start also plays one that is removed now.
  const items = await listPlaylists(client, guildId);
  const byId = new Map(items.map(item => [item.id, item]));
  const lines = [];
  let failed = false;
  const fail = line => { failed = true; lines.push(line); };

  for (const id of removeIds) {
    try {
      const result = await removePlaylist(client, guildId, id, {
        userId: interaction.user.id,
        canManage: Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)),
      });
      if (result.removed) lines.push(`**${itemName(result.entry)}** was removed.`);
      else if (result.reason === 'forbidden') fail(`Only the person who added **${itemName(byId.get(id))}** or a moderator can remove it.`);
    } catch (error) {
      fail(userMessageOf(error));
    }
  }

  if (raw) {
    try {
      const entry = await addToList(interaction, client, guildId, raw);
      lines.push(`**${itemName(entry)}** was added · ${itemKind(entry)}.`);
    } catch (error) {
      fail(userMessageOf(error));
    }
  }

  if (startId) {
    try {
      const item = byId.get(startId);
      if (!item) throw new CloudyError('Missing playlist', ErrorTypes.USER_INPUT, 'That one is no longer in your list.');
      const player = getPlayer(client, guildId);
      if (player) assertCanControl(interaction.member, player);
      await playQuery(client, interaction, item.url);
    } catch (error) {
      fail(userMessageOf(error));
    }
  }

  if (lines.length) await sendNotice(interaction, state, lines, failed);
  else if (!state.quiet) await interaction.deleteReply().catch(() => {});
}

export async function handleMusicPlaylistControls(interaction, client) {
  if (!interaction.customId?.startsWith(PREFIX)) return false;
  const [type] = interaction.customId.slice(PREFIX.length).split(':');
  if (type !== 'modal' || !interaction.isModalSubmit?.() || !interaction.guildId) {
    // A list from before (Start/Delete buttons) is answered without changes.
    await silentAck(interaction);
    return true;
  }
  const state = { quiet: false };
  try {
    await handleListForm(interaction, client, state);
  } catch (error) {
    await sendNotice(interaction, state, [userMessageOf(error)], true).catch(() => {});
  }
  return true;
}
