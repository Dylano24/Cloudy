// The music player's list (owner's choice): songs and playlists for this session.
// The player's 🎵 Add button opens one form at once that shows the list and has a
// field to add a song or playlist, a Start choice, a Remove choice and the Jam. An
// item is its link, so starting a playlist always loads its current songs. The list
// lives only in memory for the session (owner's choice: nothing is kept): Stop, the
// bot leaving and a restart empty it. Lists stored before are deleted.
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
import { createHash, randomUUID } from 'node:crypto';
import { CLOUDY_LOGO_URL } from '../cloudyLogoService.js';
import { CLOUDY_BRANDING } from '../cloudyBrandingService.js';
import { feedEmoji } from '../feedEmojiService.js';
import { CLOUDY_RED_COLOR } from '../../utils/embedColorPolicy.js';
import { CloudyError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
  MAX_QUEUE_ITEMS, activeSource, assertCanControl, canEndJam, getPlayer, inspectMusicLink, isJamOn, playQuery, playQueuedNow,
  queuedSources, removeSourceFromQueue, replaceQueue, setJam, trackPickKey,
} from './musicActions.js';
import { prepareMusicQuery } from './musicLinks.js';
import { getGuildMusicData } from './playerStore.js';

const PREFIX = 'musicpl:';
const MAX_PLAYLISTS = 25; // one Discord select menu
const MAX_PER_MEMBER = 10;
const queues = new Map();
const forgotten = new Set();

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

// A list that an earlier version stored in the database is deleted once (owner's
// choice: no songs stay saved).
function forgetStoredList(client, guildId) {
  const key = String(guildId);
  if (forgotten.has(key)) return;
  forgotten.add(key);
  void Promise.resolve().then(() => client.db?.delete?.(storageKey(guildId))).catch(() => {});
}

async function readPlaylists(client, guildId) {
  forgetStoredList(client, guildId);
  const { list } = getGuildMusicData(guildId);
  return Array.isArray(list) ? [...list] : [];
}

async function writePlaylists(client, guildId, items) {
  getGuildMusicData(guildId).list = items;
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

// The list in this order (owner's choice): what plays now ("<green dot> Playing:",
// Cloudy's glowing green dot), then what waits in the queue ("<blue dot> Queue:",
// Cloudy's blue dot, in queue order), then the rest of the list, each after the
// white glowing dot instead of a number. Nothing shows twice; a song that is not in
// the list (a /play song) shows the same way. While something plays, a small line
// says how many can wait (owner's choice).
const MAX_QUEUE_LINES = MAX_QUEUE_ITEMS;
const queueKey = url => 'q:' + createHash('sha1').update(String(url)).digest('hex').slice(0, 16);

function listEntries(items, active, queued) {
  const list = items || [];
  const savedFor = source => (source?.url ? list.find(item => item.url === source.url) : null);
  const used = new Set();
  const entries = [];
  const take = (state, source) => {
    const item = savedFor(source);
    if (item && used.has(item.id)) return;
    if (item) used.add(item.id);
    entries.push({ state, item, source: item || source, by: source.by || null });
  };
  if (active) take('playing', active);
  for (const source of queued || []) take('queue', source);
  for (const item of list) if (!used.has(item.id)) entries.push({ state: 'list', item, source: item });
  return entries;
}

// In a jam the Playing and Queue lines also say who added it (like Spotify).
// Every line stays on one line on a phone (owner's choice: the text runs neatly
// under each other, nothing wraps back to the left): a long name is shortened
// with "…" so the line after the dot is at most 40 characters.
const MAX_LINE = 40;
function fitLine(label, name, suffix) {
  const room = MAX_LINE - label.length - suffix.length;
  const text = name.length > room ? `${name.slice(0, Math.max(4, room - 1)).trimEnd()}…` : name;
  return `${label}${text}${suffix}`;
}

function listText(items, active = null, queued = [], jam = null) {
  const entries = listEntries(items, active, queued);
  const waiting = entries.filter(entry => entry.state === 'queue');
  const by = entry => (jam && entry.state !== 'list' && entry.by ? ` · ${String(entry.by).slice(0, 12)}` : '');
  const line = (dot, label, entry) => `${dot} ${fitLine(label, itemName(entry.source), ` · ${itemKind(entry.source)}${by(entry)}`)}`;
  // The small line about the queue sits right under the heading (owner's choice);
  // in a jam it names the host, like Spotify's "<name>'s Jam".
  const lines = [jam
    ? `-# ${jam.hostName || 'Someone'}'s Jam · max ${MAX_QUEUE_ITEMS} songs or playlists in the queue`
    : `-# Max ${MAX_QUEUE_ITEMS} songs or playlists in the queue`];
  for (const entry of entries) {
    if (entry.state === 'playing') lines.push(line(feedEmoji('online'), 'Playing: ', entry));
    else if (entry.state === 'queue' && waiting.indexOf(entry) < MAX_QUEUE_LINES) lines.push(line(feedEmoji('report_blue'), 'Queue: ', entry));
    else if (entry.state === 'list') lines.push(line(feedEmoji('dot'), '', entry));
    if (entry.state === 'queue' && waiting.indexOf(entry) === MAX_QUEUE_LINES) {
      lines.push(`${feedEmoji('report_blue')} Queue: +${waiting.length - MAX_QUEUE_LINES} more`);
    }
  }
  if (!items) lines.push('Your list could not be loaded right now. Open Add again in a moment.');
  else if (!entries.length) lines.push('Your list is empty. Add a song or a playlist below.');
  return ['**Your list**', ...lines].join('\n').slice(0, 3900);
}

function entryOption(entry, value) {
  const { source, state } = entry;
  return {
    label: itemName(source).slice(0, 100),
    description: `${itemKind(source)} • ${state === 'list' ? source.ownerName || 'Unknown' : state}`.slice(0, 100),
    value,
    emoji: { name: source.kind === 'song' ? '🎶' : '🎵' },
  };
}

// One choice each (owner's choice): a tap selects at once. A choice of several
// needed Discord's extra Select button on the phone.
function itemSelect(customId, options, placeholder) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .addOptions(options);
}

// One form, opened at once by the player's Add button: the list itself (Playing,
// Queue, the rest), a field to add a song or playlist, Start (plays the chosen one
// in place of what plays now) and Remove, in the same order as the list. Every
// opening gets its own id. `items` null means the list could not be read.
export function buildListModal(items, { active = null, queued = [], jam = null, tracks = [], canEnd = false } = {}) {
  const add = new TextInputBuilder().setCustomId('add').setStyle(TextInputStyle.Short)
    .setRequired(false).setMaxLength(500).setPlaceholder('Song name or playlist link');
  // No help lines under the fields (owner's choice: too much text). In a jam the
  // field and Start add to the jam's queue in turn instead.
  const labels = [new LabelBuilder().setLabel(jam ? 'Add to the jam' : 'Add a song or playlist').setTextInputComponent(add)];
  const entries = listEntries(items, active, queued);
  const saved = entries.filter(entry => entry.item).slice(0, MAX_PLAYLISTS).map(entry => entryOption(entry, entry.item.id));
  const removable = entries
    .filter(entry => entry.item || entry.source.url)
    .map(entry => entryOption(entry, entry.item ? entry.item.id : entry.state === 'playing' ? 'active' : queueKey(entry.source.url)))
    .slice(0, MAX_PLAYLISTS);
  if (saved.length) {
    labels.push(new LabelBuilder().setLabel(jam ? 'Add from your list' : 'Start')
      .setStringSelectMenuComponent(itemSelect('start', saved, 'Choose what to play')));
  }
  if (removable.length) {
    labels.push(new LabelBuilder().setLabel('Remove')
      .setStringSelectMenuComponent(itemSelect('remove', removable, 'Choose what to remove')));
  }
  // In a jam this field lists the songs in the queue (owner's choice): one chosen
  // plays at once. Only the host or a moderator also gets "End the jam".
  const picks = jam ? [...(tracks || [])].slice(0, MAX_PLAYLISTS - 1).map((track, index) => ({
    label: String(track?.info?.title || 'Unknown track').replace(/\*/g, '').slice(0, 100),
    description: String(track?.info?.requester?.username || 'Unknown').slice(0, 100),
    value: trackPickKey(track, index),
    emoji: { name: '🎶' },
  })) : [];
  // No emoji on Start/End, and a "Choose ..." placeholder like the other fields (owner's choice).
  const jamChoices = jam
    ? [...picks, ...(canEnd ? [{ label: 'End the jam', value: 'end', description: 'Stops the music for everyone' }] : [])]
    : [{ label: 'Start a jam', value: 'start', description: 'Everyone in the voice channel can add songs' }];
  if (jamChoices.length) {
    labels.push(new LabelBuilder().setLabel('Jam').setStringSelectMenuComponent(itemSelect('jam', jamChoices,
      jam ? (picks.length ? 'Choose a song to play now' : 'Choose to end the jam') : 'Choose to start a jam')));
  }
  return new ModalBuilder().setCustomId(PREFIX + 'modal:' + makeId()).setTitle('Add to your list')
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(listText(items, active, queued, jam)))
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

// The player's Add button: the form with the list opens at once.
export async function openPlaylistPanel(interaction, client) {
  const guildId = interaction.guildId;
  const items = await listPlaylists(client, guildId);
  const player = getPlayer(client, guildId);
  await interaction.showModal(buildListModal(items, {
    active: activeSource(player),
    queued: queuedSources(player),
    jam: getGuildMusicData(guildId).jam,
    tracks: player?.queue,
    canEnd: canEndJam(guildId, interaction.user.id, interaction.memberPermissions),
  }));
}

// The songs of a list item carry it, so Add can show it as active.
const sourceOf = item => ({
  url: item.url,
  name: itemName(item),
  count: Number(item.count) || 1,
  kind: item.kind === 'song' ? 'song' : 'playlist',
});

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
// an error. Remove of what plays now also takes its songs out of the queue;
// Start plays the chosen one in place of what plays now.
async function handleListForm(interaction, client, state) {
  const guildId = interaction.guildId;
  const removeIds = selectedValues(interaction, 'remove');
  const [startId] = selectedValues(interaction, 'start');
  const [jamChoice] = selectedValues(interaction, 'jam');
  const raw = typedValue(interaction, 'add');
  if (!removeIds.length && !raw && !startId && !jamChoice) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  // A song chosen in the Jam field, like Start, shows nothing: the player shows it.
  const pick = String(jamChoice || '').startsWith('t:') ? jamChoice : null;
  if (!removeIds.length && !raw && (!jamChoice || pick)) {
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

  if (jamChoice === 'start' || jamChoice === 'end') {
    try {
      await setJam(client, interaction, jamChoice === 'start');
      lines.push(jamChoice === 'start' ? 'Jam started: everyone in the voice channel can add songs.' : 'The jam has ended.');
    } catch (error) {
      fail(userMessageOf(error));
    }
  }
  const jam = isJamOn(guildId);

  const player = getPlayer(client, guildId);
  const active = activeSource(player);
  const queued = queuedSources(player);
  for (const id of removeIds) {
    try {
      if (id === 'active' || id.startsWith('q:')) {
        // What plays now or waits in the queue and is not in the list.
        const source = id === 'active' ? active : queued.find(entry => entry.url && queueKey(entry.url) === id);
        if (source && await removeSourceFromQueue(client, guildId, source.url, interaction.member)) {
          lines.push(`**${itemName(source)}** was removed.`);
        }
        continue;
      }
      const result = await removePlaylist(client, guildId, id, {
        userId: interaction.user.id,
        canManage: Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)),
      });
      if (result.removed) {
        lines.push(`**${itemName(result.entry)}** was removed.`);
        await removeSourceFromQueue(client, guildId, result.entry.url, interaction.member);
      } else if (result.reason === 'forbidden') {
        fail(`Only the person who added **${itemName(byId.get(id))}** or a moderator can remove it.`);
      }
    } catch (error) {
      fail(userMessageOf(error));
    }
  }

  if (raw) {
    try {
      if (jam) {
        // In a jam the field adds to the queue, in this member's turn; nothing is saved.
        const { added } = await playQuery(client, interaction, raw);
        lines.push(`**${itemName(added)}** was added to the jam.`);
      } else {
        const entry = await addToList(interaction, client, guildId, raw);
        lines.push(`**${itemName(entry)}** was added · ${itemKind(entry)}.`);
      }
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
      // In a jam it waits for this member's turn; otherwise it replaces what plays.
      if (jam) await playQuery(client, interaction, item.url, { source: sourceOf(item) });
      else await replaceQueue(client, interaction, item.url, { source: sourceOf(item) });
    } catch (error) {
      fail(userMessageOf(error));
    }
  }

  if (pick) {
    try {
      playQueuedNow(client, interaction, pick);
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
