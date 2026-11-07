import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getPaginationRow } from '../../utils/components.js';

const QUEUE_PAGE_SIZE = 10;
// Cloudy's logo and footer on every music embed (owner's choice).
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

export const MUSIC_BUTTON_IDS = {
    PAUSE: 'music_pause',
    RESUME: 'music_resume',
    SKIP: 'music_skip',
    STOP: 'music_stop',
    SHUFFLE: 'music_shuffle',
    LOOP: 'music_loop',
    VOL_DOWN: 'music_vol_down',
    VOL_UP: 'music_vol_up',
    QUEUE: 'music_queue',
    QUEUE_FIRST: 'music_queue_first',
    QUEUE_PREV: 'music_queue_prev',
    QUEUE_NEXT: 'music_queue_next',
    QUEUE_LAST: 'music_queue_last',
};

export function formatDuration(ms) {
    if (!ms || Number.isNaN(ms)) {
        return 'Live';
    }
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getTrackArtwork(track) {
    // Lavalink/Riffy may expose artwork in different metadata fields.
    // Never invent an album cover when the source provides none.
    return [
        track?.info?.artworkUrl,
        track?.info?.thumbnail,
        track?.info?.albumArt,
        track?.pluginInfo?.artworkUrl,
    ].find(url => typeof url === 'string' && /^https?:\/\//i.test(url)) || null;
}

function getAlbumName(track) {
    const album = track?.info?.album;
    return track?.info?.albumName
        || track?.pluginInfo?.albumName
        || (typeof album === 'string' ? album : album?.name)
        || null;
}

export function formatMusicProgress(positionMs, lengthMs, steps = 12) {
    const length = Number(lengthMs);
    if (!Number.isFinite(length) || length <= 0) return null;
    const position = Number(positionMs);
    const fraction = Number.isFinite(position) ? Math.max(0, Math.min(1, position / length)) : 0;
    const filled = Math.round(fraction * steps);
    return '▰'.repeat(filled) + '▱'.repeat(steps - filled);
}

export function buildMusicRequestEmbed(track, { playNow = false, queuePosition = 1 } = {}) {
    const info = track?.info || {};
    const requester = info.requester;
    const requesterLabel = requester?.username || requester?.tag || 'Unknown';
    const album = getAlbumName(track);
    return createEmbed({
        title: playNow ? 'Now playing' : 'Added to queue',
        description: `**${String(info.title || 'Unknown track').slice(0, 220)}**\n${String(info.author || 'Unknown artist').slice(0, 300)}`,
        color: 'primary',
        fields: [
            { name: 'Requested by', value: requesterLabel, inline: true },
            ...(album ? [{ name: 'Album', value: String(album).slice(0, 1024), inline: true }] : []),
            { name: 'Duration', value: formatDuration(info.length), inline: true },
            ...(!playNow ? [{ name: 'Queue position', value: `#${queuePosition}`, inline: true }] : []),
        ],
        thumbnail: CLOUDY_C_LOGO_URL,
        image: getTrackArtwork(track),
        footer: CLOUDY_FOOTER,
    });
}

export const MUSIC_GUIDE_DESCRIPTION =
    'Listen to music together with Cloudy. Join a voice channel and use `/play` to start a song. ' +
    'Click the button below to view all available music commands.';

export function buildMusicGuideEmbed() {
    return createEmbed({
        title: 'Cloudy music',
        description: MUSIC_GUIDE_DESCRIPTION,
        color: 'primary',
        thumbnail: CLOUDY_C_LOGO_URL,
        footer: CLOUDY_FOOTER,
    });
}

export function buildMusicCommandsEmbed() {
    return createEmbed({
        title: 'Music commands',
        description: [
            '**Getting started**',
            '`/play` — Play a song.',
            '`/join` — Join voice.',
            '`/now playing` — Current song.',
            '`/queue` — Show queue.',
            '',
            '**Playback controls**',
            '`/music pause` — Pause.',
            '`/music resume` — Resume.',
            '`/music skip` — Next song.',
            '`/music stop` — Stop.',
            '`/music shuffle` — Shuffle.',
            '`/music loop` — Repeat.',
            '',
            '**Queue & volume**',
            '`/music volume` — Set volume.',
            '`/music remove` — Remove song.',
            '`/music move` — Move song.',
            '`/music clear` — Clear queue.',
            '`/music leave` — Disconnect.',
            '',
            'Join a voice channel to play music.',
        ].join('\n'),
        color: 'primary',
        thumbnail: CLOUDY_C_LOGO_URL,
        footer: CLOUDY_FOOTER,
    });
}

function getLoopLabel(loop) {
    switch (loop) {
        case 'track':
            return 'Track';
        case 'queue':
            return 'Queue';
        default:
            return 'Off';
    }
}

export function buildNowPlayingEmbed(track, player, guildData) {
    const requester = track?.info?.requester;
    const requesterLabel = requester
        ? (requester.username || requester.tag || 'Unknown')
        : 'Unknown';

    const position = formatDuration(player?.position || 0);
    const duration = formatDuration(track?.info?.length || 0);

    const queued = player?.queue?.length || 0;
    const album = getAlbumName(track);
    const progressBar = formatMusicProgress(player?.position || 0, track?.info?.length);
    // The track's cover is the image; the Cloudy logo stays the thumbnail.
    return createEmbed({
        title: 'Now playing',
        description: `**${track?.info?.title || 'Unknown track'}**`,
        color: 'primary',
        fields: [
            { name: 'Artist', value: track?.info?.author || 'Unknown', inline: true },
            ...(album ? [{ name: 'Album', value: String(album).slice(0, 1024), inline: true }] : []),
            { name: 'Requested by', value: requesterLabel, inline: true },
            { name: 'Progress', value: `${progressBar ? `${progressBar}\n` : ''}${position} / ${duration}`, inline: true },
            { name: 'Status', value: player?.paused ? 'Paused' : 'Playing', inline: true },
            { name: 'Volume', value: `${guildData?.volume ?? 75}%`, inline: true },
            { name: 'Loop', value: getLoopLabel(guildData?.loop), inline: true },
            { name: 'Queue', value: `${queued} ${queued === 1 ? 'track' : 'tracks'}`, inline: true },
        ],
        thumbnail: CLOUDY_C_LOGO_URL,
        image: getTrackArtwork(track),
        footer: CLOUDY_FOOTER,
    });
}

export function buildQueueEmbed(queue, currentTrack, page = 0) {
    const totalTracks = queue?.length || 0;
    const totalPages = Math.max(1, Math.ceil(totalTracks / QUEUE_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * QUEUE_PAGE_SIZE;
    const slice = queue?.slice(start, start + QUEUE_PAGE_SIZE) || [];

    let description = '';
    if (currentTrack) {
        description += `**Now playing**\n${currentTrack.info?.title || 'Unknown'} — ${currentTrack.info?.author || 'Unknown'}\n\n`;
    }

    if (slice.length === 0) {
        description += 'The queue is empty.';
    } else {
        description += slice
            .map((track, index) => {
                const num = start + index + 1;
                return `${num}. ${track.info?.title || 'Unknown'} — ${track.info?.author || 'Unknown'}`;
            })
            .join('\n');
    }

    description += `\n\nPage ${safePage + 1} of ${totalPages} · ${totalTracks} queued`;
    return createEmbed({
        title: 'Music queue',
        description: description.substring(0, 4096),
        color: 'info',
        thumbnail: CLOUDY_C_LOGO_URL,
        footer: CLOUDY_FOOTER,
    });
}

export function buildPlayerButtonRows(player, guildData) {
    const paused = player?.paused;
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.PAUSE)
            .setLabel('Pause')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⏸️')
            .setDisabled(Boolean(paused)),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.RESUME)
            .setLabel('Resume')
            .setStyle(ButtonStyle.Success)
            .setEmoji('▶️')
            .setDisabled(!paused),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.SKIP)
            .setLabel('Skip')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⏭️'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.STOP)
            .setLabel('Stop')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⏹️'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.SHUFFLE)
            .setLabel('Shuffle')
            .setStyle(guildData?.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('🔀'),
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.LOOP)
            .setLabel('Loop')
            .setStyle(guildData?.loop !== 'none' ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('🔁'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.VOL_DOWN)
            .setLabel('Vol -')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔉'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.VOL_UP)
            .setLabel('Vol +')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔊'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.QUEUE)
            .setLabel('Queue')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋'),
    );

    return [row1, row2];
}

export function buildQueuePaginationRow(page, totalPages) {
    return getPaginationRow('music_queue', page + 1, totalPages);
}

export function getQueuePageSize() {
    return QUEUE_PAGE_SIZE;
}
