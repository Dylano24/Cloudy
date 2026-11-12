// Per-guild music session state (in-memory). Adapted from Musicify playerStore (Apache-2.0).

export class GuildMusicData {
    constructor() {
        // The card (cover, title, timer, bar: redrawn every second) and, under it, the
        // controls message (buttons: redrawn only when something on it changes).
        this.playerMessageId = null;
        this.playerChannelId = null;
        this.controlsMessageId = null;
        this.lastControls = null;
        this.controlsHold = 0;
        this.controlsWork = null;
        this.autoplay = false;
        this.loop = 'none';
        // 100 is the song's own sound: only then does the Lavalink node pass the
        // original audio through unchanged. Any other volume made the node decode
        // and encode every song again (lower quality, more load, more stutter).
        this.volume = 100;
        this.shuffle = false;
        this.previousTracks = [];
        this.twentyFourSeven = false;
        this.queuePages = new Map();
        this.updateInterval = null;
        this.idleTimeout = null;
        this.autoPaused = false;
        this.stopConfirmPending = null;
        // The track a Skip was last sent for, so a double click skips one song.
        this.lastSkip = null;
        // What the player panel last showed, so an unchanged refresh is not sent again.
        this.lastPanel = null;
        // The song the player panel shows, and how a song is ending (Skip/Stop).
        this.panelTrack = null;
        this.endingTrack = null;
        // Previous (⏮️): its last click, and whether the next song start is the way back.
        this.lastBack = null;
        this.goingBack = false;
        // Jam (Add form, like a Spotify Jam) and the list of the Add button: both live
        // only for the session and are gone after Stop, the bot leaving or a restart.
        this.jam = null;
        this.jamHostTimer = null;
        this.list = [];
    }
}

export function clearUpdateInterval(guildData) {
    if (guildData.updateInterval) {
        clearInterval(guildData.updateInterval);
        guildData.updateInterval = null;
    }
}

const guildStore = new Map();

export function getGuildMusicData(guildId) {
    if (!guildStore.has(guildId)) {
        guildStore.set(guildId, new GuildMusicData());
    }
    return guildStore.get(guildId);
}

export function deleteGuildMusicData(guildId) {
    const guildData = guildStore.get(guildId);
    if (guildData) {
        clearUpdateInterval(guildData);
        if (guildData.idleTimeout) {
            clearTimeout(guildData.idleTimeout);
        }
    }
    guildStore.delete(guildId);
}
