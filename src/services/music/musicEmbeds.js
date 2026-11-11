import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getPaginationRow } from '../../utils/components.js';
import { MUSIC_BUTTON_IDS } from './musicButtonIds.js';
import { feedEmoji } from '../feedEmojiService.js';

export { MUSIC_BUTTON_IDS } from './musicButtonIds.js';

const QUEUE_PAGE_SIZE = 10;
// Cloudy's logo and footer on every music embed (owner's choice).
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
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

// A progress bar of rounded pieces (owner's choice): white for the part that has
// played, grey for the rest, the same pieces as the vote bar. Ten pieces: twelve
// wrapped to a second line in Discord on a PC. Plain blocks show until the pieces
// are uploaded.
export function musicProgressBar(positionMs, lengthMs, steps = 10) {
    const length = Number(lengthMs);
    if (!Number.isFinite(length) || length <= 0) return null;
    const position = Number(positionMs);
    const fraction = Number.isFinite(position) ? Math.max(0, Math.min(1, position / length)) : 0;
    const filled = Math.round(fraction * steps);
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

// Owner's choice: /play starts the music and the player's buttons do everything
// else, so the buttons are explained here by their own emoji. Only commands that
// are not on the player (for example a future Guess the song) get a slash command line.
const MUSIC_COMMANDS_DESCRIPTION = [
    '**Start the music**',
    '`/play` — Type a song name or paste a link from YouTube, Spotify, Apple Music, Deezer or SoundCloud. Everything else is done with the buttons on the player.',
    '',
    '**Player buttons**',
    '⏸️ / ▶️ **Pause / Resume** — Pause the song, press again to continue.',
    '⏭️ **Skip** — Play the next song.',
    '🔀 **Shuffle** — Mix up the order of the queue.',
    '🔁 / 🔂 **Loop** — Press once to repeat the song (🔂), again to repeat the queue (🔁) and a third time to turn it off.',
    '📋 **Queue** — See what is coming up next.',
    '🎵 **Playlists** — Start a saved playlist, add a new one with its link or remove one.',
    '⏹️ **Stop** — Stop the music, clear the queue and leave the voice channel.',
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

export function buildNowPlayingEmbed(track, player, guildData) {
    const requester = track?.info?.requester;
    const requesterLabel = requester
        ? (requester.username || requester.tag || 'Unknown')
        : 'Unknown';

    const queued = player?.queue?.length || 0;
    const album = getAlbumName(track);
    const progressBar = musicProgressBar(player?.position || 0, track?.info?.length);
    // The track's cover is the image; the Cloudy logo stays the thumbnail. The
    // white bar sits under the title on its own line and is the only progress
    // indicator (owner's choice: no "position / length" text next to it).
    return createEmbed({
        title: 'Now playing',
        description: `**${track?.info?.title || 'Unknown track'}**${progressBar ? `\n\n${progressBar}` : ''}`,
        color: 'primary',
        fields: [
            { name: 'Artist', value: track?.info?.author || 'Unknown', inline: true },
            ...(album ? [{ name: 'Album', value: String(album).slice(0, 1024), inline: true }] : []),
            { name: 'Requested by', value: requesterLabel, inline: true },
            { name: 'Status', value: player?.paused ? 'Paused' : 'Playing', inline: true },
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
