import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    SectionBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getPaginationRow } from '../../utils/components.js';
import { MUSIC_BUTTON_IDS } from './musicButtonIds.js';
import { feedEmoji, feedEmojiComponent } from '../feedEmojiService.js';

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
    // Like Spotify (owner's choice): a white knob where the song is now.
    const knobAt = Math.min(filled, steps - 1);
    const knob = index => (index === 0 ? 'bar_lk' : index < steps - 1 ? 'bar_mk' : filled >= steps ? 'bar_rkf' : 'bar_rk');
    return Array.from({ length: steps }, (_, index) => {
        if (index === knobAt) return feedEmoji(knob(index));
        const end = index === 0 ? 'l' : index === steps - 1 ? 'r' : 'm';
        return feedEmoji(`bar_${end}${index < filled ? 'f' : 'e'}`);
    }).join('');
}

// Milliseconds until the bar shows its next piece (null while paused, without a
// length or when it is full): the panel is refreshed at that moment, so the bar
// never runs behind the song.
export function msUntilNextBarPiece(player, now = Date.now(), steps = 10) {
    const length = Number(player?.current?.info?.length);
    if (!player?.current || player.paused || !Number.isFinite(length) || length <= 0) return null;
    const position = livePlayerPosition(player, now);
    const filled = Math.round(Math.max(0, Math.min(1, position / length)) * steps);
    if (filled >= steps) return null;
    return Math.max(0, ((filled + 0.5) * length) / steps - position);
}

// Where the song is now. The node reports the position every few seconds; in
// between, the time since that report is added while the song plays (never while
// paused), so the bar follows the music even when a report is late. A song that
// has not reported anything yet stays at its last known position.
export function livePlayerPosition(player, now = Date.now()) {
    const position = Math.max(0, Number(player?.position) || 0);
    const reportedAt = Number(player?.cloudyPositionAt) || 0;
    if (!reportedAt || player?.paused || !player?.current) return position;
    return position + Math.max(0, now - reportedAt);
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
// else, so the buttons are explained here by their own emoji, one short line each
// in the order of the buttons (one emoji per line keeps the lines neatly under each
// other). Only commands that are not on the player (for example a future Guess the
// song) get a slash command line.
// The player's buttons in their order, each with its own icon (Spotify's style;
// the standard emoji until the icons are uploaded).
const musicCommandsDescription = () => [
    '**Play**',
    '`/play` — Play a song or link.',
    '',
    '**Player buttons**',
    `${feedEmoji('mc_shuffle')} Shuffle the queue`,
    `${feedEmoji('mc_previous')} Previous song`,
    `${feedEmoji('mc_pause')} Pause or continue`,
    `${feedEmoji('mc_next')} Next song`,
    `${feedEmoji('mc_repeat')} Repeat song or queue`,
    `${feedEmoji('mc_queue')} Show the queue`,
    '🎵 Add, start or remove',
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
    embed.data.description = musicCommandsDescription();
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
    const progressBar = musicProgressBar(livePlayerPosition(player), track?.info?.length);
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
            { name: 'Duration', value: formatDuration(track?.info?.length), inline: true },
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
    // Like Spotify (owner's choice): Shuffle, Previous, Play/Pause, Next, Repeat in
    // one row, white icons on grey, the mode that is on in green, and Play/Pause in
    // the middle stands out in green. The bottom row has Queue, 🎵 Add (it opens
    // the form at once) and, last, the red Stop button.
    // No volume buttons (owner's choice): /music volume still sets it, and the old
    // button ids stay registered so a player message from before still answers.
    const loop = guildData?.loop || 'none';
    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.SHUFFLE)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(feedEmojiComponent(guildData?.shuffle ? 'mc_shuffle_on' : 'mc_shuffle')),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.PREVIOUS)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(feedEmojiComponent('mc_previous')),
        new ButtonBuilder()
            .setCustomId(paused ? MUSIC_BUTTON_IDS.RESUME : MUSIC_BUTTON_IDS.PAUSE)
            .setStyle(ButtonStyle.Success)
            .setEmoji(feedEmojiComponent(paused ? 'mc_play' : 'mc_pause')),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.SKIP)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(feedEmojiComponent('mc_next')),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.LOOP)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(feedEmojiComponent(loop === 'track' ? 'mc_repeat_one' : loop === 'queue' ? 'mc_repeat_on' : 'mc_repeat')),
    );

    const stop = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.QUEUE)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(feedEmojiComponent('mc_queue')),
        new ButtonBuilder()
            .setCustomId(MUSIC_BUTTON_IDS.PLAYLISTS)
            .setLabel('Add')
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

// The player as one card like Spotify's Now Playing (owner's choice: the buttons
// inside it): the cover on top, the title and artist beside the Cloudy logo, the
// bar with its knob, the duration and who asked for it, then the controls and the
// Cloudy footer, with the white side line. A record of an ended song ("Played",
// "Skipped", ...) is the same card without the bar and the buttons.
export const PLAYER_CARD_HEADINGS = ['Now playing', 'Played', 'Skipped', 'Stopped', 'Could not play'];

export function buildPlayerCard(track, player, guildData, { ended = null } = {}) {
    const info = track?.info || {};
    const text = content => new TextDisplayBuilder().setContent(content);
    const title = String(info.title || 'Unknown track').replace(/\n/g, ' ').slice(0, 200);
    const artist = String(info.author || 'Unknown artist').replace(/\n/g, ' ').slice(0, 200);
    const card = new ContainerBuilder().setAccentColor(0xFFFFFF);
    const cover = getTrackArtwork(track);
    if (cover) {
        card.addMediaGalleryComponents(new MediaGalleryBuilder()
            .addItems(new MediaGalleryItemBuilder().setURL(cover).setDescription(title.slice(0, 100))));
    }
    card.addSectionComponents(new SectionBuilder()
        .addTextDisplayComponents(text(`-# ${ended || 'Now playing'}\n### ${title}\n${artist}`))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(CLOUDY_C_LOGO_URL)));
    const bar = ended ? null : musicProgressBar(livePlayerPosition(player), info.length);
    if (bar) card.addTextDisplayComponents(text(bar));
    const requester = info.requester?.username || info.requester?.tag || 'Unknown';
    card.addTextDisplayComponents(text(`-# ${formatDuration(info.length)} · Requested by ${requester}`));
    if (!ended) card.addActionRowComponents(...buildPlayerButtonRows(player, guildData));
    card.addTextDisplayComponents(text(`-# ${CLOUDY_FOOTER}`));
    return { flags: MessageFlags.IsComponentsV2, components: [card], allowedMentions: { parse: [] } };
}

// A message that is one of these cards (Cloudy's own panel or record).
export function isPlayerCardMessage(message) {
    const texts = [];
    const walk = items => {
        for (const item of items || []) {
            const data = item?.toJSON ? item.toJSON() : item?.data || item;
            if (typeof data?.content === 'string') texts.push(data.content);
            walk(data?.components);
        }
    };
    walk(message?.components);
    const heading = new RegExp(`^-# (${PLAYER_CARD_HEADINGS.join('|')})\\n### `);
    return texts.some(content => heading.test(content)) && texts.includes(`-# ${CLOUDY_FOOTER}`);
}
