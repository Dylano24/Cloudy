import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    TextDisplayBuilder,
} from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { getPaginationRow } from '../../utils/components.js';
import { MUSIC_BUTTON_IDS } from './musicButtonIds.js';
import { feedEmoji, feedEmojiReady, feedEmojiComponent } from '../feedEmojiService.js';

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

export function getTrackArtwork(track) {
    // Lavalink/Riffy may expose artwork in different metadata fields.
    // Never invent an album cover when the source provides none. The sharper
    // copy of the same cover (musicArtwork.js) comes first.
    return [
        track?.info?.cloudyArtworkUrl,
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
// played, grey for the rest, the same pieces as the vote bar, and a white knob
// where the song is, like Spotify. 14 pieces: as wide as the row of five buttons
// under it (owner's choice). The knob moves in 216 small steps (about one per
// second for a song of 3 to 4 minutes; owner's choice: the bar moves every
// second): see `mbar_*` in feedEmojiService.js. Plain blocks show until the
// pieces are uploaded.
export const MUSIC_BAR_STEPS = 14;
const BAR_PIECE_PX = 128;
const KNOB_FIRST_PX = 36;
const KNOB_STEP_PX = 8;
const KNOB_PLACES = 215;
const KNOB_REACH_PX = 30;
const SECOND_MS = 1_000;

/** The emoji keys of the bar's 14 pieces for this moment of the song. */
export function musicBarPieces(positionMs, lengthMs) {
    const length = Number(lengthMs);
    if (!Number.isFinite(length) || length <= 0) return null;
    const position = Number(positionMs);
    const fraction = Number.isFinite(position) ? Math.max(0, Math.min(1, position / length)) : 0;
    const knob = KNOB_FIRST_PX + KNOB_STEP_PX * Math.round(fraction * KNOB_PLACES);
    return Array.from({ length: MUSIC_BAR_STEPS }, (_, index) => {
        const kind = index === 0 ? 'l' : index === MUSIC_BAR_STEPS - 1 ? 'r' : 'm';
        const offset = knob - index * BAR_PIECE_PX;
        if (offset <= -KNOB_REACH_PX) return `bar_${kind}e`;
        if (offset >= BAR_PIECE_PX + KNOB_REACH_PX) return `bar_${kind}f`;
        return `mbar_${kind}_${offset < 0 ? `n${-offset}` : offset}`;
    });
}

export function musicProgressBar(positionMs, lengthMs) {
    return musicBarPieces(positionMs, lengthMs)?.map(key => feedEmoji(key)).join('') ?? null;
}

// Cloudy's own clock for the timer on the player card (owner's choice: a
// real-time timer). It counts real time from where the song was and follows the
// node again only when the song is paused or resumed, or when they differ by more
// than 1.5 seconds (a seek, Previous, a stall): the node reports the position
// every few seconds, a little early or late, and following every report made the
// timer stop for a second or skip one.
const CLOCK_DRIFT_MS = 1_500;

export function songPosition(player, guildData = null, now = Date.now()) {
    const node = livePlayerPosition(player, now);
    const track = player?.current;
    if (!guildData || !track) return node;
    // Without a voice connection nothing plays: the timer stands still, as when paused.
    const paused = Boolean(player.paused) || player.connected === false;
    const clock = guildData.songClock;
    if (clock?.track === track && clock.paused === paused) {
        const own = paused ? clock.base : clock.base + Math.max(0, now - clock.at);
        if (Math.abs(own - node) <= CLOCK_DRIFT_MS) return own;
    }
    guildData.songClock = { track, paused, base: node, at: now };
    return node;
}

// Milliseconds until the timer on the card should show its next second (null
// while paused, without a length or at the end); 0 when the card is behind (an
// edit was late), so the next one goes at once and no second is skipped. `lead`
// is how long an edit takes to show: the edit is sent that much earlier.
export function msUntilNextSecond(player, now = Date.now(), guildData = null, lead = 0) {
    const length = Number(player?.current?.info?.length);
    if (!player?.current || player.paused || !Number.isFinite(length) || length <= 0) return null;
    const shown = songPosition(player, guildData, now) + lead;
    if (shown >= length) return null;
    if (Number.isInteger(guildData?.shownSecond) && guildData.shownSecond < Math.floor(shown / SECOND_MS)) return 0;
    return SECOND_MS - (shown % SECOND_MS);
}

/** m:ss (or h:mm:ss), also for 0. */
export function formatClock(ms) {
    const value = Number(ms);
    return Number.isFinite(value) && value >= 1_000 ? formatDuration(value) : '0:00';
}

// Where the song is now. The node reports the position every few seconds; in
// between, the time since that report is added while the song plays (never while
// paused), so the bar follows the music even when a report is late. A song that
// has not reported anything yet stays at its last known position.
export function livePlayerPosition(player, now = Date.now()) {
    const position = Math.max(0, Number(player?.position) || 0);
    const reportedAt = Number(player?.cloudyPositionAt) || 0;
    // A node without a voice connection (`connected` false in its report) plays nothing:
    // the bar stays where it is instead of running on, or jumping back to the node's
    // position at every report.
    if (!reportedAt || player?.paused || !player?.current || player?.connected === false) return position;
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

// The player's buttons carry TEXT symbols in their labels, never an emoji (owner's choice:
// Cloudy's own icons are custom emoji, and Discord's app loads a custom emoji again every
// time the card is redrawn, every second for the timer, so they blinked; a symbol is drawn
// by the phone itself and never blinks). The owner picked each symbol on his own phone as
// the closest to his icons: crossing arrows for shuffle (the sign of the 🔀 emoji without its
// square), a bar with one triangle for previous and next, ↻ for repeat, ☰ for the queue.
// The symbols that have a text selector (U+FE0E) keep it, so they stay white text.
export const PLAYER_BUTTON_SYMBOLS = Object.freeze({
    shuffle: '\u292E',
    previous: '\u2759\u25C0\uFE0E',
    pause: '\u23F8\uFE0E',
    play: '\u25B6\uFE0E',
    next: '\u25B6\uFE0E\u2759',
    repeat: '\u21BB',
    repeatOne: '\u21BB1',
    queue: '\u2630',
    add: '+',
    remove: '\u2212',
    stop: '\u25A0',
});

// Owner's choice: /play starts the music and the player's buttons do everything
// else, so the buttons are explained here by their own symbols, one short line each
// in the order of the buttons (one symbol per line keeps the lines neatly under each
// other). Only commands that are not on the player (for example a future Guess the
// song) get a slash command line.
const musicCommandsDescription = () => [
    '**Play**',
    '`/play` — Play a song or link.',
    '',
    '**Player buttons**',
    `${PLAYER_BUTTON_SYMBOLS.shuffle} Shuffle the queue`,
    `${PLAYER_BUTTON_SYMBOLS.previous} Previous song`,
    `${PLAYER_BUTTON_SYMBOLS.pause} Pause or continue`,
    `${PLAYER_BUTTON_SYMBOLS.next} Next song`,
    `${PLAYER_BUTTON_SYMBOLS.repeat} Repeat song or queue`,
    `${PLAYER_BUTTON_SYMBOLS.queue} Show the queue`,
    `${PLAYER_BUTTON_SYMBOLS.add} Add or start a song`,
    `${PLAYER_BUTTON_SYMBOLS.remove} Remove from the list`,
    `${PLAYER_BUTTON_SYMBOLS.stop} Stop and leave`,
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

// Labels are a fallback only while the new application emojis are uploading.
// Word-joiners keep fallback padding consistent on mobile Discord.
const WORD_JOINER = '\u2060';
const THIN_SPACE = '\u2009';
const padLabel = (label, spaces = 1) => `${WORD_JOINER}${THIN_SPACE.repeat(spaces)}${label}${THIN_SPACE.repeat(spaces)}${WORD_JOINER}`;

// Use a single uploaded silver glyph as the entire button content. Unlike
// platform fonts, these render at the same size and match the approved preview.
// The old text symbols remain a safe fallback while application emojis upload.
function musicIconButton(customId, style, icon, fallback, spaces = 1) {
    const button = new ButtonBuilder().setCustomId(customId).setStyle(style);
    const emojiKey = `mc_button_${icon}`;
    if (feedEmojiReady(emojiKey)) return button.setEmoji(feedEmojiComponent(emojiKey));
    return button.setLabel(padLabel(fallback, spaces));
}

export function buildPlayerButtonRows(player, guildData) {
    const paused = Boolean(player?.paused);
    const loop = guildData?.loop || 'none';
    const modeStyle = on => (on ? ButtonStyle.Success : ButtonStyle.Secondary);
    const controls = new ActionRowBuilder().addComponents(
        musicIconButton(MUSIC_BUTTON_IDS.SHUFFLE, modeStyle(guildData?.shuffle), 'shuffle', PLAYER_BUTTON_SYMBOLS.shuffle, 4),
        musicIconButton(MUSIC_BUTTON_IDS.PREVIOUS, ButtonStyle.Secondary, 'previous', PLAYER_BUTTON_SYMBOLS.previous, 0),
        musicIconButton(paused ? MUSIC_BUTTON_IDS.RESUME : MUSIC_BUTTON_IDS.PAUSE,
            ButtonStyle.Secondary, paused ? 'play' : 'pause',
            paused ? PLAYER_BUTTON_SYMBOLS.play : PLAYER_BUTTON_SYMBOLS.pause),
        musicIconButton(MUSIC_BUTTON_IDS.SKIP, ButtonStyle.Secondary, 'next', PLAYER_BUTTON_SYMBOLS.next, 0),
        musicIconButton(MUSIC_BUTTON_IDS.LOOP, modeStyle(loop === 'track' || loop === 'queue'),
            loop === 'track' ? 'repeat_one' : 'repeat',
            loop === 'track' ? PLAYER_BUTTON_SYMBOLS.repeatOne : PLAYER_BUTTON_SYMBOLS.repeat, loop === 'track' ? 3 : 5),
    );
    const actions = new ActionRowBuilder().addComponents(
        musicIconButton(MUSIC_BUTTON_IDS.QUEUE, ButtonStyle.Secondary, 'queue', PLAYER_BUTTON_SYMBOLS.queue, 4),
        musicIconButton(MUSIC_BUTTON_IDS.PLAYLISTS, ButtonStyle.Secondary, 'add', PLAYER_BUTTON_SYMBOLS.add, 6),
        musicIconButton(MUSIC_BUTTON_IDS.REMOVE, ButtonStyle.Secondary, 'remove', PLAYER_BUTTON_SYMBOLS.remove, 6),
        musicIconButton(MUSIC_BUTTON_IDS.STOP, ButtonStyle.Secondary, 'stop', PLAYER_BUTTON_SYMBOLS.stop, 6),
    );
    return [controls, actions];
}

export function buildQueuePaginationRow(page, totalPages) {
    return getPaginationRow('music_queue', page + 1, totalPages);
}

export function getQueuePageSize() {
    return QUEUE_PAGE_SIZE;
}

// The player as one card like Spotify's Now Playing (owner's choice: the buttons
// inside it): the cover on top (no ALT label), the title and the artist, the
// timer (where the song is / its length, every second) on its own small line on
// the left right above the bar, the bar with its knob, the controls (all grey),
// "Requested by" after the white dot and under it the Cloudy footer. A record of
// an ended song says "Played", "Skipped", ... above the title, shows only the
// song's length and has no bar and no buttons. No "Now playing" line and no logo.
export const PLAYER_CARD_HEADINGS = ['Played', 'Skipped', 'Stopped', 'Could not play'];
// The footer (owner's choice: small, white, on one line and the same on a PC as
// on a phone) is the footer text drawn over 14 emoji pieces, as wide as the bar
// (`footer_*` in feedEmojiService.js), on the line under "Requested by" (a line
// of only emoji would be shown big). Until the pieces are uploaded it is text.
// Cards posted earlier: the footer as a picture or as a line of its own.
const PLAYER_CARD_FOOTER_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@0c7c11e1fe8a2e71e0c259aa7c0e9d8d8bfbe41b/assets/music-footer.png';
const PLAYER_CARD_FOOTER_MARKS = [CLOUDY_FOOTER, ':cft_1:'];
// The footer of the player card is ONE fixed picture (owner's choice): the same 14
// footer pieces side by side (`assets/music-footer-line.png`, transparent, the text
// filling 83.5% of the width as the emoji line did). The card is redrawn every second
// for the timer and Discord's app loads custom emoji again on every redraw, so the
// emoji footer blinked; a picture whose link never changes stays put, like the cover.
export const PLAYER_FOOTER_PICTURE_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@da41ebfa0c912ffe1582a559b88d35fcf95467a5/assets/music-footer-line.png';
const PLAYER_CARD_FOOTER_URLS = new Set([PLAYER_CARD_FOOTER_URL, PLAYER_FOOTER_PICTURE_URL]);
// A pause or resume never shows the timer a second back: an edit shows the next
// second a moment early (`lead`), and the node's own position can be that bit behind.
const TIMER_HOLD_MS = 1_200;


function timerPosition(player, guildData, lead) {
    let position = songPosition(player, guildData) + (player?.paused ? 0 : lead);
    const shown = guildData?.shownSecond;
    if (Number.isInteger(shown) && guildData.shownTrack === player?.current) {
        const held = shown * SECOND_MS;
        if (position < held && held - position < TIMER_HOLD_MS) position = held;
    }
    return position;
}

export function buildPlayerCard(track, player, guildData, { ended = null, lead = 0 } = {}) {
    const info = track?.info || {};
    const text = content => new TextDisplayBuilder().setContent(content);
    const title = String(info.title || 'Unknown track').replace(/\n/g, ' ').slice(0, 200);
    const artist = String(info.author || 'Unknown artist').replace(/\n/g, ' ').slice(0, 200);
    const card = new ContainerBuilder().setAccentColor(0xFFFFFF);
    const cover = getTrackArtwork(track);
    if (cover) card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(cover)));
    card.addTextDisplayComponents(text(`${ended ? `-# ${ended}\n` : ''}### ${title}\n${artist}`));
    const length = Number(info.length);
    const timed = !info.isStream && Number.isFinite(length) && length > 0;
    if (!timed) {
        card.addTextDisplayComponents(text('-# Live'));
    } else if (ended) {
        card.addTextDisplayComponents(text(`-# ${formatClock(length)}`));
    } else {
        const position = Math.min(timerPosition(player, guildData, lead), length);
        if (guildData) guildData.cardSecond = Math.floor(position / SECOND_MS);
        // Only the timer, no bar (owner's choice: the bar's emoji pieces glitched; the
        // /now playing embed keeps its bar).
        card.addTextDisplayComponents(text(`-# ${formatClock(position)} / ${formatClock(length)}`));
    }
    if (!ended) card.addActionRowComponents(...buildPlayerButtonRows(player, guildData));
    const requester = String(info.requester?.username || info.requester?.tag || 'Unknown').replace(/\n/g, ' ');
    // The live card has no "Requested by" (owner's choice, for now: its dot emoji blinked
    // on the every-second redraw); a record keeps it. Both end with the footer picture.
    if (ended) card.addTextDisplayComponents(text(`-# ${feedEmoji('dot')} Requested by ${requester}`));
    card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(PLAYER_FOOTER_PICTURE_URL)));
    return { flags: MessageFlags.IsComponentsV2, components: [card], allowedMentions: { parse: [] } };
}

// A message that is one of these cards: Cloudy's player (its music buttons) or a
// record of an ended song (its heading), both with the Cloudy footer.
export function isPlayerCardMessage(message) {
    const texts = [];
    let musicButtons = false;
    let footer = false;
    const walk = items => {
        for (const item of items || []) {
            const data = item?.toJSON ? item.toJSON() : item?.data || item;
            if (typeof data?.content === 'string') texts.push(data.content);
            if ((data?.items || []).some(entry => PLAYER_CARD_FOOTER_URLS.has(entry?.media?.url || entry?.url))) footer = true;
            if (String(data?.custom_id || data?.customId || '').startsWith('music_')) musicButtons = true;
            walk(data?.components);
        }
    };
    walk(message?.components);
    if (!footer && !texts.some(content => PLAYER_CARD_FOOTER_MARKS.some(mark => content.includes(mark)))) return false;
    const heading = new RegExp(`^-# (${PLAYER_CARD_HEADINGS.join('|')})\\n### `);
    return musicButtons || texts.some(content => heading.test(content));
}
