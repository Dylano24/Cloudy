import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { getPaginationRow } from '../../utils/components.js';
import { MUSIC_BUTTON_IDS } from './musicButtonIds.js';
import { feedEmoji } from '../feedEmojiService.js';

export { MUSIC_BUTTON_IDS } from './musicButtonIds.js';

const QUEUE_PAGE_SIZE = 10;
// Cloudy's logo and footer on every music embed (owner's choice).
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
// Preserve the exact animated Cloudy C approved on the original Dylano
// player. The replacement PNG is a different graphic: never use it.
export const MUSIC_PLAYER_C_LOGO_URL = CLOUDY_C_LOGO_URL;
const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

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

export function getTrackArtwork(track) {
    // Riffy's Track copies title/author from Lavalink but NOT artworkUrl.
    // Reading info.thumbnail invokes an async getter, so never use it when
    // constructing a synchronous Discord embed.
    const info = track?.info || {};
    const raw = track?.rawData?.info || {};
    const candidates = [
        info.artworkUrl, raw.artworkUrl, raw.thumbnail,
        info._cachedThumbnail, info.albumArt,
        track?.pluginInfo?.artworkUrl, track?.rawData?.pluginInfo?.artworkUrl,
    ];
    const artwork = candidates.find(url => typeof url === 'string' && /^https:\/\//i.test(url));
    if (artwork) return artwork;

    // When Lavalink omits artwork, a real YouTube ID still produces a
    // deterministic thumbnail. Other providers must not get fake covers.
    let youtubeId = String(info.identifier || raw.identifier || '');
    const uri = String(info.uri || raw.uri || '');
    if (!/^[\w-]{11}$/.test(youtubeId)) {
        try {
            const url = new URL(uri);
            if (url.hostname === 'youtu.be') youtubeId = url.pathname.slice(1);
            if (/^(?:www\.|m\.|music\.)?youtube\.com$/.test(url.hostname)) {
                youtubeId = url.searchParams.get('v') || '';
            }
        } catch { /* Not a YouTube link. */ }
    }
    if ((info.sourceName === 'youtube' || raw.sourceName === 'youtube'
        || /^https:\/\/(?:www\.|m\.|music\.)?youtube\.com\//.test(uri)
        || /^https:\/\/youtu\.be\//.test(uri))
        && /^[\w-]{11}$/.test(youtubeId)) {
        return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
    }
    return null;
}

function getAlbumName(track) {
    const album = track?.info?.album;
    return track?.info?.albumName
        || track?.rawData?.info?.albumName
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

// A progress bar of rounded pieces (owner's choice): white for the part that has
// played, grey for the rest, the same pieces as the vote bar. Ten pieces: twelve
// wrapped to a second line in Discord on a PC. Plain blocks show until the pieces
// are uploaded.
export function musicProgressBar(positionMs, lengthMs, steps = 10) {
    const length = Number(lengthMs);
    if (!Number.isFinite(length) || length <= 0) return null;
    const position = Number(positionMs);
    const fraction = Number.isFinite(position) ? Math.max(0, Math.min(1, position / length)) : 0;
    const filled = fraction > 0 ? Math.max(1, Math.round(fraction * steps)) : 0;
    return Array.from({ length: steps }, (_, index) => {
        const end = index === 0 ? 'l' : index === steps - 1 ? 'r' : 'm';
        return feedEmoji(`bar_${end}${index < filled ? 'f' : 'e'}`);
    }).join('');
}

export function buildMusicRequestEmbed(track, { playNow = false, queuePosition = 1 } = {}) {
    const info = track?.info || {};
    const requester = info.requester;
    const requesterLabel = requester?.username || requester?.tag || 'Unknown';
    const album = getAlbumName(track);
    const artwork = getTrackArtwork(track);
    const embed = new EmbedBuilder({
        title: playNow ? 'Now playing' : 'Added to queue',
        description: `**${String(info.title || 'Unknown track').slice(0, 220)}**\n${String(info.author || 'Unknown artist').slice(0, 300)}`,
        color: 0xFFFFFF,
        fields: [
            { name: 'Requested by', value: requesterLabel, inline: false },
            ...(album ? [{ name: 'Album', value: String(album).slice(0, 1024), inline: false }] : []),
            { name: 'Duration', value: formatDuration(info.length), inline: false },
            ...(!playNow ? [{ name: 'Queue position', value: `#${queuePosition}`, inline: false }] : []),
        ],
        thumbnail: { url: MUSIC_PLAYER_C_LOGO_URL },
        ...(artwork ? { image: { url: artwork } } : {}),
        footer: { text: CLOUDY_FOOTER },
    });
    return setPreservedEmbedColor(embed, 0xFFFFFF);
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

// Owner's choice: /play starts the music and the player's buttons do everything
// else, so the buttons are explained here by their own emoji, one short line each
// in the order of the buttons (one emoji per line keeps the lines neatly under each
// other). Only commands that are not on the player (for example a future Guess the
// song) get a slash command line.
const MUSIC_COMMANDS_DESCRIPTION = [
    '**Play**',
    '`/play` — Play a song or link.',
    '',
    '**Player buttons**',
    '⏸️ Pause or continue',
    '⏭️ Next song',
    '🔀 Shuffle the queue',
    '🔁 Repeat song or queue',
    '📋 Show the queue',
    '🎵 Saved playlists',
    '⏹️ Stop and leave',
].join('\n');

export function buildMusicCommandsEmbed() {
    const embed = createEmbed({
        title: 'Music commands',
        description: 'Music commands',
        color: 'primary',
        thumbnail: CLOUDY_C_LOGO_URL,
        footer: CLOUDY_FOOTER,
    });
    // Embed text loses its standard emoji everywhere else; here they are the point,
    // so the text is set on the finished embed.
    embed.data.description = MUSIC_COMMANDS_DESCRIPTION;
    return embed;
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

// Approximate position between Lavalink playerUpdate packets and after the
// trackStart event when some nodes keep reporting a stale zero position.
// The clock freezes on Pause and is reset on each new track.
export function estimatedMusicPosition(player, guildData, now = Date.now()) {
    const reported = Math.max(0, Number(player?.position) || 0);
    const clock = guildData?.progressClock;
    let position = reported;
    if (clock && clock.track === player?.current && Number.isFinite(clock.startedAt)) {
        const end = clock.pausedAt != null ? clock.pausedAt : now;
        position = Math.max(position, Math.max(0, end - clock.startedAt - (clock.pausedMs || 0)));
    }
    if (player?.playing && !player.paused && Number.isFinite(player.timestamp)
        && player.timestamp > now - 30_000 && player.timestamp <= now + 5_000) {
        position = Math.max(position, reported + Math.max(0, now - player.timestamp));
    }
    const length = Number(player?.current?.info?.length);
    return Number.isFinite(length) && length > 0 ? Math.min(position, length) : position;
}

export function buildNowPlayingEmbed(track, player, guildData) {
    const requester = track?.info?.requester;
    const requesterLabel = requester
        ? (requester.username || requester.tag || 'Unknown')
        : 'Unknown';

    const queued = player?.queue?.length || 0;
    const album = getAlbumName(track);
    const progressBar = musicProgressBar(estimatedMusicPosition(player, guildData), track?.info?.length);
    // The track's cover is the image; the Cloudy logo stays the thumbnail. The
    // white bar sits under the title on its own line and is the only progress
    // indicator (owner's choice: no "position / length" text next to it).
    // This player panel is a fixed design shared by every guild. Do not pass it
    // through the editable system-embed catalog: a saved Cloudy template can
    // otherwise replace the Dylano layout on the next progress refresh.
    const fields = [
        { name: 'Artist', value: track?.info?.author || 'Unknown', inline: false },
        ...(album ? [{ name: 'Album', value: String(album).slice(0, 1024), inline: false }] : []),
        { name: 'Requested by', value: requesterLabel, inline: false },
        { name: 'Status', value: player?.paused ? 'Paused' : 'Playing', inline: false },
        { name: 'Loop', value: getLoopLabel(guildData?.loop), inline: false },
        { name: 'Queue', value: `${queued} ${queued === 1 ? 'track' : 'tracks'}`, inline: false },
    ];
    const artwork = getTrackArtwork(track);
    const embed = new EmbedBuilder({
        title: 'Now playing',
        description: `**${String(track?.info?.title || 'Unknown track').slice(0, 220)}**${progressBar ? `\n\n${progressBar}` : ''}`,
        color: 0xFFFFFF,
        fields,
        thumbnail: { url: MUSIC_PLAYER_C_LOGO_URL },
        ...(artwork ? { image: { url: artwork } } : {}),
        footer: { text: CLOUDY_FOOTER },
    });
    return setPreservedEmbedColor(embed, 0xFFFFFF);
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
    const paused = Boolean(player?.paused);
    // Icons only, so the five controls stay in one row on a phone; the bottom row
    // has Playlists and, last, the red Stop button. No volume buttons (owner's choice):
    // /music volume still sets it, and the old button ids stay registered so a
    // player message from before still answers.
    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(paused ? MUSIC_BUTTON_IDS.RESUME : MUSIC_BUTTON_IDS.PAUSE)
            .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary)
            .setEmoji(paused ? '▶️' : '⏸️'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.SKIP)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⏭️'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.SHUFFLE)
            .setStyle(guildData?.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('🔀'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.LOOP)
            .setStyle(guildData?.loop && guildData.loop !== 'none' ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji(guildData?.loop === 'track' ? '🔂' : '🔁'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.QUEUE)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋'),
    );

    const stop = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.PLAYLISTS)
            .setLabel('Playlists')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🎵'),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.STOP)
            .setLabel('Stop')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⏹️'),
    );

    return [controls, stop];
}

export function buildQueuePaginationRow(page, totalPages) {
    return getPaginationRow('music_queue', page + 1, totalPages);
}

export function getQueuePageSize() {
    return QUEUE_PAGE_SIZE;
}
