import { MessageFlags, PermissionFlagsBits } from 'discord.js';
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
const RESOLVE_TIMEOUT_MS = 8_000;
const MUSIC_READY_WAIT_MS = 6_000;
const VOICE_MOVE_TIMEOUT_MS = 12_000;
const BAD_NODE_MS = 10 * 60 * 1000;
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

// A voice channel the bot cannot join (no Connect/Speak, or full) would leave
// /play waiting for a connection that never comes.
async function assertBotCanJoin(interaction) {
    const channel = interaction.member?.voice?.channel;
    const members = interaction.guild?.members;
    // The bot's own member is fetched when it is not cached, so the check always runs.
    const me = members?.me || await members?.fetchMe?.().catch(() => null);
    const permissions = me && channel?.permissionsFor?.(me);
    if (!permissions) return;
    if (!permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        throw new CloudyError(
            'Missing voice permissions',
            ErrorTypes.PERMISSION,
            `I need the View Channel, Connect and Speak permissions in **${channel.name}**.`,
        );
    }
    if (channel.userLimit > 0 && (channel.members?.size || 0) >= channel.userLimit
        && !permissions.has(PermissionFlagsBits.MoveMembers)) {
        throw new CloudyError('Voice channel full', ErrorTypes.USER_INPUT, `**${channel.name}** is full.`);
    }
}

async function tryPlay(player) {
    try {
        return (await player.play()) !== false;
    } catch (error) {
        logger.warn(`[MUSIC] Playback could not start: ${error?.message || error}`);
        return false;
    }
}

// What reached the player: whether Discord sent its voice details and whether the node took them.
function describeVoice(player) {
    const voice = player?.connection?.voice || {};
    return `node=${player?.node?.name || '?'} nodeConnected=${Boolean(player?.node?.connected)}`
        + ` session=${Boolean(voice.sessionId)} endpoint=${voice.endpoint ? String(voice.endpoint).split('.')[0] : 'none'}`
        + ` token=${Boolean(voice.token)} establishing=${Boolean(player?.connection?.establishing)}`;
}

function dropPlayer(player) {
    try {
        player.queue?.clear?.();
        player.destroy();
    } catch {
        // already gone
    }
}

// Right after a restart Riffy is not initialised yet and its nodes are still
// connecting. A /play in that window waits for them instead of failing.
function musicIsReady(client) {
    const riffy = client.riffy;
    if (riffy.initiated === false) return false;
    return !Array.isArray(riffy.leastUsedNodes) || riffy.leastUsedNodes.length > 0;
}

export async function waitForMusicReady(client, timeoutMs = MUSIC_READY_WAIT_MS) {
    assertRiffyAvailable(client);
    const deadline = Date.now() + timeoutMs;
    while (!musicIsReady(client) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!musicIsReady(client)) {
        throw new CloudyError('Music nodes unavailable', ErrorTypes.NETWORK, MUSIC_SERVER_BUSY);
    }
}

// A node that could not hold a voice connection is tried last for a while, so the
// next /play does not wait for it again.
const badNodes = new Map();

function isBadNode(node) {
    return (badNodes.get(node?.name) || 0) > Date.now();
}

function markNodeBad(node) {
    if (node?.name) badNodes.set(node.name, Date.now() + BAD_NODE_MS);
}

function markNodeGood(node) {
    if (node?.name) badNodes.delete(node.name);
}

// The connected nodes, those that recently failed last.
function orderedNodes(client) {
    const nodes = Array.isArray(client.riffy?.leastUsedNodes) ? [...client.riffy.leastUsedNodes] : [];
    return [...nodes.filter(node => !isBadNode(node)), ...nodes.filter(isBadNode)];
}

function createVoicePlayer(client, options, node = null) {
    const target = node || orderedNodes(client)[0] || null;
    return target && typeof client.riffy.createPlayer === 'function'
        ? client.riffy.createPlayer(target, options)
        : client.riffy.createConnection(options);
}

// The same player, with the voice details Discord already sent, moves to another
// node: nobody leaves and joins again, so nothing can destroy the new player.
async function moveVoiceToNode(player, node) {
    const connection = player.connection;
    const voice = connection?.voice;
    if (!connection || !voice?.sessionId || !voice.endpoint || !voice.token
        || typeof connection.updatePlayerVoiceData !== 'function') {
        return false;
    }
    // The old node is told to let go but never waited for: a stuck node must not block this one.
    Promise.resolve(player.node?.rest?.destroyPlayer?.(player.guildId)).catch(() => {});
    player.node = node;
    // The old node's unanswered voice update no longer counts.
    connection.pendingUpdate = null;
    try {
        await withTimeout(connection.updatePlayerVoiceData({
            sessionId: voice.sessionId,
            endpoint: voice.endpoint,
            token: voice.token,
            channelId: player.voiceChannel,
        }), VOICE_MOVE_TIMEOUT_MS);
    } catch (error) {
        logger.warn(`[MUSIC] Node ${node?.name} did not take the voice details: ${error?.message || error}`);
        markNodeBad(node);
        return false;
    }
    // The node took the voice details; as after a normal join, the player counts as connected.
    connection.establishing = false;
    player.connected = true;
    return true;
}

// Riffy waits for the voice connection and rejects when it never comes. Awaiting
// it means no "Now playing" for a song that never started, and no stray rejection.
// When Discord did send the voice details but this node could not use them (public
// nodes are flaky), the same player moves to each other node before giving up.
async function startPlayback(client, interaction, player) {
    const guildId = interaction.guild.id;
    if (await tryPlay(player)) {
        markNodeGood(player.node);
        return player;
    }
    // Only a node that was given Discord's voice details and could not use them is at fault.
    const voice = player.connection?.voice || {};
    if (voice.sessionId && voice.endpoint && voice.token) markNodeBad(player.node);
    logger.warn(`[MUSIC] Voice connection failed in ${guildId}: ${describeVoice(player)}`);

    const tried = new Set([player.node]);
    for (const node of orderedNodes(client)) {
        if (tried.has(node)) continue;
        tried.add(node);
        if (!await moveVoiceToNode(player, node)) continue;
        if (await tryPlay(player)) {
            markNodeGood(node);
            return player;
        }
        markNodeBad(node);
        logger.warn(`[MUSIC] Voice connection failed again in ${guildId}: ${describeVoice(player)}`);
    }

    dropPlayer(player);
    throw new CloudyError(
        'Voice connection failed',
        ErrorTypes.NETWORK,
        'I could not connect to your voice channel. Check that I can connect and speak there, then try again.',
    );
}

// After a crash or restart Discord can still show the bot in a voice channel.
// Joining that channel again then sends no new voice details and playback waits
// for nothing: the bot leaves first.
async function releaseStaleVoice(client, interaction) {
    const guildId = interaction.guild.id;
    const channelId = interaction.guild.members?.me?.voice?.channelId;
    if (!channelId || getPlayer(client, guildId) || typeof client.riffy?.send !== 'function') return;
    logger.warn(`[MUSIC] Bot is still shown in voice channel ${channelId} in ${guildId}; leaving it before joining.`);
    client.riffy.send({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false } });
    await new Promise(resolve => setTimeout(resolve, 800));
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
        await releaseStaleVoice(client, interaction);
        const options = {
            guildId,
            voiceChannel: interaction.member.voice.channel.id,
            textChannel: interaction.channel.id,
            deaf: true,
        };
        // A link is opened on a node that can play it, so the player lives there too;
        // otherwise the player starts on the node that did not recently fail.
        player = createVoicePlayer(client, options, node);
        guildData.playerChannelId = interaction.channel.id;
    }

    if (player.volume !== guildData.volume) player.setVolume(guildData.volume);
    return { player, guildData };
}

export async function joinVoiceChannel(client, interaction) {
    await waitForMusicReady(client);
    assertInVoice(interaction.member);
    if (!getPlayer(client, interaction.guild.id)) await assertBotCanJoin(interaction);

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
        await releaseStaleVoice(client, interaction);
        player = createVoicePlayer(client, {
            guildId,
            voiceChannel: channel.id,
            textChannel: interaction.channel.id,
            deaf: true,
        });
        guildData.playerChannelId = interaction.channel.id;
    }

    if (player.volume !== guildData.volume) player.setVolume(guildData.volume);

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

// A plain search tries the node the player lives on first and then the others, so
// one node that cannot answer never fails the command.
async function searchAcrossNodes(client, interaction, query, preferred = null) {
    const nodes = [...new Set([preferred, ...orderedNodes(client)].filter(Boolean))];
    if (!nodes.length) return resolveQuery(client, interaction, query);
    let failure = null;
    let last = null;
    for (const node of nodes) {
        try {
            const result = await resolveQuery(client, interaction, query, node);
            if (isPlayableResult(result)) return result;
            last = result;
        } catch (error) {
            failure ||= error;
        }
    }
    if (last) return last;
    throw failure;
}

// Links from YouTube, Spotify, Apple Music, Deezer, SoundCloud and others go to
// the music server. A link is tried on every connected node, and a new player
// is created on the node that opened it (no voice join for a link nobody can open).
async function resolveLinkAndConnect(client, interaction, query) {
    const existing = getPlayer(client, interaction.guild.id);
    const nodes = existing ? [existing.node].filter(Boolean) : orderedNodes(client);

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

// Opens a link on any connected node without joining voice (used to check a
// playlist link before it is saved).
export async function inspectMusicLink(client, query, requester) {
    await waitForMusicReady(client);
    const nodes = orderedNodes(client);
    let failure = null;
    let answered = false;
    for (const node of nodes.length ? nodes : [null]) {
        try {
            const result = await withTimeout(client.riffy.resolve({ query, requester, ...(node ? { node } : {}) }), RESOLVE_TIMEOUT_MS);
            if (isPlayableResult(result)) return result;
            answered = true;
        } catch (error) {
            failure ||= error;
        }
    }
    if (failure && !answered) {
        throw new CloudyError(`Music search failed: ${failure?.message || failure}`, ErrorTypes.NETWORK, MUSIC_SERVER_BUSY);
    }
    throw new CloudyError('Link not playable', ErrorTypes.USER_INPUT, LINK_NOT_PLAYABLE);
}

export async function playQuery(client, interaction, rawQuery) {
    await waitForMusicReady(client);
    assertInVoice(interaction.member);
    if (!getPlayer(client, interaction.guild.id)) await assertBotCanJoin(interaction);

    const { query, isLink } = await prepareMusicQuery(rawQuery);
    let player;
    let result;
    if (isLink) {
        ({ player, result } = await resolveLinkAndConnect(client, interaction, query));
    } else {
        ({ player } = await ensurePlayer(client, interaction));
        result = await searchAcrossNodes(client, interaction, query, player.node);
    }

    const { loadType, tracks, playlistInfo } = result;

    if (loadType === 'playlist' || loadType === 'PLAYLIST_LOADED') {
        // Every song is added, also one that is already in the queue (owner's choice).
        for (const track of tracks) {
            track.info.requester = interaction.user;
            player.queue.add(track);
        }

        if (!player.playing && !player.paused) {
            await startPlayback(client, interaction, player);
        }

        return {
            embed: successEmbed(
                'Playlist added',
                `**${playlistInfo?.name || 'Playlist'}**\nAdded ${tracks.length} track(s).`,
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

        track.info.requester = interaction.user;

        const willPlayNow = !player.playing && !player.paused;
        player.queue.add(track);
        const queuePosition = player.queue.length;

        if (willPlayNow) {
            await startPlayback(client, interaction, player);
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
        return successEmbed('Paused', 'Playback is paused.');
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
        return successEmbed('Resumed', 'Playback is playing.');
    }

    await applyResume(client, interaction.guild.id);
    return successEmbed('Resumed', 'Playback resumed.');
}

export async function shuffleQueue(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);
    if (!player?.queue?.length) {
        return successEmbed('Shuffle', 'There is nothing to shuffle yet. Add more songs first.');
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
        return successEmbed('Queue cleared', 'The queue is empty.');
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
