// Per-guild music session state.

export class GuildMusicData {
    constructor() {
        this.playerMessageId = null;
        this.playerChannelId = null;
        this.autoplay = false;
        this.loop = 'none';
        this.volume = 75;
        this.shuffle = false;
        this.previousTracks = [];
        this.twentyFourSeven = false;
        this.queuePages = new Map();
        this.updateInterval = null;
        this.idleTimeout = null;
        this.autoPaused = false;
        this.stopConfirmPending = null;

        // Jockie-style session controls. Defaults preserve Cloudy's historic
        // behaviour: everyone in the same voice channel may control playback.
        this.sessionOwnerId = null;
        this.sessionLocked = false;
        this.permissionMode = 'open'; // open | owner | dj
        this.djRoleIds = new Set();
        this.allowedUsers = new Set();
        this.deniedUsers = new Set();
        this.policyHydrated = false;
        this.activeFilter = 'off';
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
