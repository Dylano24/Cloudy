import { MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { CloudyError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildMusicData, clearUpdateInterval } from './playerStore.js';
import { canControlMusic, requireVoiceChannel, VOICE_CHANNEL_DENIAL } from './permissions.js';
import {
    buildNowPlayingEmbed,
    buildMusicRequestEmbed,
    buildQueueEmbed,
    buildQueuePaginationRow,
    getQueuePageSize,
} from './musicEmbeds.js';
import { refreshPlayerMessage } from './playerHandler.js';
import { prepareMusicQuery } from './musicLinks.js';
import { finishRequestMessage } from './musicRequestMessages.js';
import { logger } from '../../utils/logger.js';

const MUSIC_SERVER_BUSY = 'The music server is not responding right now. Please try again in a moment.';
const LINK_NOT_PLAYABLE = 'That link could not be opened. It may be private, region-locked or not available right now. Try another link or a song name.';
const RESOLVE_TIMEOUT_MS = 12_000;
const PLAYABLE_LOAD_TYPES = new Set(['track', 'playlist', 'search', 'TRACK_LOADED', 'PLAYLIST_LOADED', 'SEARCH_RESULT']);

export function getPlayer(client, guildId) {
    return client.riffy?.players?.get(guildId) || null;
}

export function assertRiffyAvailable(client) {
    if (!client.riffy) {
        throw new CloudyError(
            'Lavalink not configured',
            ErrorTypes.CONFIGURATION,
            'Music is unavailable — Lavalink is not configured.',
        );
    }
}

export function assertInVoice(member) {
    if (!requireVoiceChannel(member)) {
        throw new CloudyError(
            'Not in voice channel',
            ErrorTypes.USER_INPUT,
            'You need to be in a voice channel.',
        );
    }
}

export function assertCanControl(member, player) {
    if (!canControlMusic(member, player)) {
        throw new CloudyError(
            'Wrong voice channel',
            ErrorTypes.PERMISSION,
            VOICE_CHANNEL_DENIAL,
        );
    }
}

export async function ensurePlayer(client, interaction, { node = null } = {}) {
    assertRiffyAvailable(client);
    assertInVoice(interaction.member);

    const guildId = interaction.guild.id;
    const guildData = getGuildMusicData(guildId);
    let player = getPlayer(client, guildId);

    if (!player) {
        const options = {
            guildId,
            voiceChannel: interaction.member.voice.channel.id,
            textChannel: interaction.channel.id,
            deaf: true,
        };
        // A link is opened on a node that can play it, so the player lives there too.
        player = node && typeof client.riffy.createPlayer === 'function'
            ? client.riffy.createPlayer(node, options)
            : client.riffy.createConnection(options);
        guildData.playerChannelId = interaction.channel.id;
    }

    player.setVolume(guildData.volume);
    return { player, guildData };
}

function isDuplicateTrack(player, track) {
    const uri = track?.info?.uri;
    if (!uri) {
        return false;
    }
    if (player.current?.info?.uri === uri) {
        return true;
    }
    return player.queue.some((existing) => existing.info?.uri === uri);
}

export async function joinVoiceChannel(client, interaction) {
    assertRiffyAvailable(client);
    assertInVoice(interaction.member);

    const guildId = interaction.guild.id;
    const guildData = getGuildMusicData(guildId);
    const channel = interaction.member.voice.channel;
    let player = getPlayer(client, guildId);

    if (player && player.voiceChannel !== channel.id) {
        try {
            player.destroy();
        } catch {
            // player may already be gone
        }
        player = null;
    }

    if (!player) {
        player = client.riffy.createConnection({
            guildId,
            voiceChannel: channel.id,
            textChannel: interaction.channel.id,
            deaf: true,
        });
        guildData.playerChannelId = interaction.channel.id;
    }

    player.setVolume(guildData.volume);

    return successEmbed(
        'Joined voice channel',
        `Connected to **${channel.name}**. Use /play to start music, or /music for playback controls.`,
    );
}

function isPlayableResult(result) {
    return Boolean(result) && PLAYABLE_LOAD_TYPES.has(result.loadType)
        && Array.isArray(result.tracks) && result.tracks.length > 0;
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Music server timed out')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Riffy throws a TypeError when the music node answers without a body
// (e.g. while Lavalink restarts); show a clear message instead of a crash.
async function resolveQuery(client, interaction, query, node = null) {
    let result;
    try {
        result = await withTimeout(client.riffy.resolve({
            query,
            requester: interaction.user,
            ...(node ? { node } : {}),
        }), RESOLVE_TIMEOUT_MS);
    } catch (error) {
        throw new CloudyError(
            `Music search failed: ${error?.message || error}`,
            ErrorTypes.NETWORK,
            MUSIC_SERVER_BUSY,
        );
    }
    if (!result) {
        throw new CloudyError('Music search returned no response', ErrorTypes.NETWORK, MUSIC_SERVER_BUSY);
    }
    return result;
}

// Links from YouTube, Spotify, Apple Music, Deezer, SoundCloud and others go to
// the music server. A link is tried on every connected node, and a new player
// is created on the node that opened it (no voice join for a link nobody can open).
async function resolveLinkAndConnect(client, interaction, query) {
    const existing = getPlayer(client, interaction.guild.id);
    const nodes = existing
        ? [existing.node].filter(Boolean)
        : (Array.isArray(client.riffy.leastUsedNodes) ? [...client.riffy.leastUsedNodes] : []);

    if (!nodes.length) {
        const { player } = await ensurePlayer(client, interaction);
        return { player, result: await resolveQuery(client, interaction, query) };
    }

    let failure = null;
    let last = null;
    for (const node of nodes) {
        try {
            const result = await resolveQuery(client, interaction, query, node);
            if (isPlayableResult(result)) {
                const { player } = await ensurePlayer(client, interaction, { node });
                return { player, result };
            }
            last = result;
        } catch (error) {
            failure ||= error;
        }
    }

    if (!last && failure) {
        throw failure;
    }
    logger.warn(`[MUSIC] Link could not be opened (${last?.loadType}): ${last?.exception?.message || last?.exception || 'no details'}`);
    throw new CloudyError(`Link not playable (${last?.loadType})`, ErrorTypes.USER_INPUT, LINK_NOT_PLAYABLE);
}

export async function playQuery(client, interaction, rawQuery) {
    assertRiffyAvailable(client);
    assertInVoice(interaction.member);

    const { query, isLink } = await prepareMusicQuery(rawQuery);
    let player;
    let result;
    if (isLink) {
        ({ player, result } = await resolveLinkAndConnect(client, interaction, query));
    } else {
        ({ player } = await ensurePlayer(client, interaction));
        result = await resolveQuery(client, interaction, query);
    }

    const { loadType, tracks, playlistInfo } = result;

    if (loadType === 'playlist' || loadType === 'PLAYLIST_LOADED') {
        let added = 0;
        let skipped = 0;

        for (const track of tracks) {
            track.info.requester = interaction.user;
            if (isDuplicateTrack(player, track)) {
                skipped += 1;
                continue;
            }
            player.queue.add(track);
            added += 1;
        }

        if (!player.playing && !player.paused) {
            player.play();
        }

        return {
            embed: successEmbed(
                'Playlist added',
                `**${playlistInfo?.name || 'Playlist'}**\nAdded ${added} of ${tracks.length} track(s).${skipped ? ` Skipped ${skipped} duplicate(s).` : ''}`,
            ),
        };
    }

    if (
        loadType === 'search'
        || loadType === 'track'
        || loadType === 'SEARCH_RESULT'
        || loadType === 'TRACK_LOADED'
    ) {
        const track = tracks?.[0];
        if (!track) {
            throw new CloudyError('No results', ErrorTypes.USER_INPUT, 'No results found for that query.');
        }

        if (isDuplicateTrack(player, track)) {
            throw new CloudyError(
                'Duplicate track',
                ErrorTypes.USER_INPUT,
                `**${track.info.title}** is already in the queue or playing.`,
            );
        }

        track.info.requester = interaction.user;

        const willPlayNow = !player.playing && !player.paused;
        player.queue.add(track);
        const queuePosition = player.queue.length;

        if (willPlayNow) {
            player.play();
        }

        return {
            embed: buildMusicRequestEmbed(track, {
                playNow: willPlayNow,
                queuePosition,
            }),
            // Only a song that starts at once says "Now playing" and needs updating later.
            track: willPlayNow ? track : null,
        };
    }

    throw new CloudyError('No results', ErrorTypes.USER_INPUT, 'No results found for that query.');
}

export async function skipTrack(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);
    const title = player.current.info?.title || 'Unknown';
    // Under track-loop, stop() would replay the same track. Clear it so the skip
    // advances; trackStart re-applies the stored loop mode to the next track.
    if (player.loop === 'track') {
        player.setLoop('none');
    }
    player.stop();
    return successEmbed('Skipped', `Skipped **${title}**.`);
}

export async function stopPlayback(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }
    assertCanControl(interaction.member, player);

    const guildData = getGuildMusicData(interaction.guild.id);
    const queueLength = player.queue?.length || 0;

    if (queueLength >= 5 && guildData.stopConfirmPending !== interaction.user.id) {
        guildData.stopConfirmPending = interaction.user.id;
        setTimeout(() => {
            if (guildData.stopConfirmPending === interaction.user.id) {
                guildData.stopConfirmPending = null;
            }
        }, 15000);
        return successEmbed(
            'Confirm stop',
            `There are **${queueLength}** tracks in the queue. Run **/music stop** again within 15 seconds to confirm.`,
        );
    }

    guildData.stopConfirmPending = null;
    await destroyPlayerSession(client, interaction.guild.id, player, guildData);
    return successEmbed('Stopped', 'Playback stopped and the queue was cleared.');
}

export async function applyPause(client, guildId) {
    const player = getPlayer(client, guildId);
    if (!player?.current || player.paused) {
        return false;
    }

    player.pause(true);
    await refreshPlayerMessage(client, guildId);
    return true;
}

export async function applyResume(client, guildId) {
    const player = getPlayer(client, guildId);
    if (!player?.current || !player.paused) {
        return false;
    }

    player.pause(false);
    await refreshPlayerMessage(client, guildId);
    return true;
}

export async function pausePlayback(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);

    if (player.paused) {
        throw new CloudyError('Already paused', ErrorTypes.USER_INPUT, 'Playback is already paused.');
    }

    await applyPause(client, interaction.guild.id);
    return successEmbed('Paused', 'Playback paused.');
}

export async function resumePlayback(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);

    if (!player.paused) {
        throw new CloudyError('Not paused', ErrorTypes.USER_INPUT, 'Playback is not paused.');
    }

    await applyResume(client, interaction.guild.id);
    return successEmbed('Resumed', 'Playback resumed.');
}

export async function shuffleQueue(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new CloudyError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is empty.');
    }
    assertCanControl(interaction.member, player);
    player.queue.shuffle();
    getGuildMusicData(interaction.guild.id).shuffle = true;
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Shuffled', 'The queue has been shuffled.');
}

export async function setLoopMode(client, interaction, mode) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }
    assertCanControl(interaction.member, player);

    const guildData = getGuildMusicData(interaction.guild.id);
    guildData.loop = mode;
    player.setLoop(mode);

    const labels = { none: 'Off', track: 'Track', queue: 'Queue' };
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Loop updated', `Loop mode set to **${labels[mode] || mode}**.`);
}

export async function toggleLoop(client, interaction) {
    const guildData = getGuildMusicData(interaction.guild.id);
    const next = guildData.loop === 'none' ? 'track' : guildData.loop === 'track' ? 'queue' : 'none';
    return setLoopMode(client, interaction, next);
}

export async function setVolume(client, interaction, volume) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }
    assertCanControl(interaction.member, player);

    const guildData = getGuildMusicData(interaction.guild.id);
    guildData.volume = Math.max(0, Math.min(100, volume));
    player.setVolume(guildData.volume);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Volume updated', `Volume set to **${guildData.volume}%**.`);
}

export async function adjustVolume(client, interaction, delta) {
    const guildData = getGuildMusicData(interaction.guild.id);
    return setVolume(client, interaction, guildData.volume + delta);
}

export async function seekTrack(client, interaction, seconds) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.current) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    assertCanControl(interaction.member, player);

    const info = player.current.info || {};
    if (info.isStream || info.isSeekable === false) {
        throw new CloudyError(
            'Not seekable',
            ErrorTypes.USER_INPUT,
            'This track cannot be seeked (it may be a live stream).',
        );
    }

    const position = Math.max(0, seconds * 1000);
    if (info.length && position > info.length) {
        throw new CloudyError(
            'Seek out of range',
            ErrorTypes.USER_INPUT,
            `You can only seek up to ${Math.floor(info.length / 1000)}s for this track.`,
        );
    }

    player.seek(position);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Seeked', `Seeked to **${seconds}s**.`);
}

export async function removeFromQueue(client, interaction, index) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new CloudyError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is empty.');
    }
    assertCanControl(interaction.member, player);

    const queueIndex = index - 1;
    if (queueIndex < 0 || queueIndex >= player.queue.length) {
        throw new CloudyError('Invalid index', ErrorTypes.USER_INPUT, `Invalid queue position. Queue has ${player.queue.length} track(s).`);
    }

    const removed = player.queue[queueIndex];
    player.queue.remove(queueIndex);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Removed', `Removed **${removed.info?.title || 'track'}** from the queue.`);
}

export async function moveInQueue(client, interaction, from, to) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new CloudyError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is empty.');
    }
    assertCanControl(interaction.member, player);

    const fromIndex = from - 1;
    const toIndex = to - 1;
    if (fromIndex < 0 || fromIndex >= player.queue.length || toIndex < 0 || toIndex >= player.queue.length) {
        throw new CloudyError('Invalid index', ErrorTypes.USER_INPUT, 'Invalid queue positions.');
    }

    const track = player.queue[fromIndex];
    player.queue.remove(fromIndex);
    player.queue.splice(toIndex, 0, track);
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Moved', `Moved **${track.info?.title || 'track'}** to position #${to}.`);
}

export async function clearQueue(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        throw new CloudyError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is already empty.');
    }
    assertCanControl(interaction.member, player);
    player.queue.clear();
    await refreshPlayerMessage(client, interaction.guild.id);
    return successEmbed('Queue cleared', 'All queued tracks were removed.');
}

export async function setTwentyFourSeven(client, interaction, enabled) {
    const guildData = getGuildMusicData(interaction.guild.id);
    guildData.twentyFourSeven = enabled;
    return successEmbed(
        '24/7 mode',
        enabled
            ? '24/7 mode enabled. The bot will stay in the voice channel when the queue ends.'
            : '24/7 mode disabled. The bot will leave after 30 seconds of idle time.',
    );
}

export function buildNowPlayingReply(client, guildId) {
    const player = getPlayer(client, guildId);
    if (!player?.current) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'Nothing is playing right now.');
    }
    const guildData = getGuildMusicData(guildId);
    return {
        embeds: [buildNowPlayingEmbed(player.current, player, guildData)],
    };
}

export function buildQueueReply(client, guildId, page = 0) {
    const player = getPlayer(client, guildId);
    if (!player) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
    }

    const totalPages = Math.max(1, Math.ceil((player.queue?.length || 0) / getQueuePageSize()));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);

    return {
        embeds: [buildQueueEmbed(player.queue, player.current, safePage)],
        components: totalPages > 1 ? [buildQueuePaginationRow(safePage, totalPages)] : [],
        page: safePage,
        totalPages,
    };
}

export async function destroyPlayerSession(client, guildId, player, guildData, { forceDisconnect = false } = {}) {
    clearUpdateInterval(guildData);
    if (guildData.idleTimeout) {
        clearTimeout(guildData.idleTimeout);
        guildData.idleTimeout = null;
    }

    guildData.previousTracks = [];
    guildData.stopConfirmPending = null;
    guildData.autoPaused = false;
    guildData.queuePages?.clear();

    if (guildData.playerMessageId && guildData.playerChannelId) {
        try {
            const channel = client.channels.cache.get(guildData.playerChannelId);
            if (channel) {
                const msg = await channel.messages.fetch(guildData.playerMessageId);
                await msg.delete();
            }
        } catch {
            // message already deleted
        }
    }

    guildData.playerMessageId = null;
    guildData.playerChannelId = null;

    if (player) {
        void finishRequestMessage(client, player.current);
        player.queue.clear();
        player.stop();
        if (forceDisconnect || !guildData.twentyFourSeven) {
            player.destroy();
        }
    }
}

export async function leaveVoiceChannel(client, interaction) {
    assertRiffyAvailable(client);

    const guildId = interaction.guild.id;
    const player = getPlayer(client, guildId);
    if (!player) {
        throw new CloudyError('No player', ErrorTypes.USER_INPUT, 'I am not in a voice channel.');
    }
    assertCanControl(interaction.member, player);

    const channel = interaction.guild.channels.cache.get(player.voiceChannel);
    const channelName = channel?.name || 'voice channel';
    const guildData = getGuildMusicData(guildId);

    await destroyPlayerSession(client, guildId, player, guildData, { forceDisconnect: true });

    return successEmbed('Left voice channel', `Disconnected from **${channelName}**.`);
}

export async function replyMusicSuccess(interaction, embed) {
    if (interaction.deferred || interaction.replied) {
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed],
            allowedMentions: { parse: [] },
        });
    } else {
        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    }
}
