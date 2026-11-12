import { MessageFlags } from 'discord.js';
import { handleInteractionError } from '../utils/errorHandler.js';
import { getGuildMusicData } from '../services/music/playerStore.js';
import {
    getPlayer,
    buildQueueReply,
    destroyPlayerSession,
    setLoopMode,
    applyPause,
    applyResume,
    skipCurrentTrack,
    playPreviousTrack,
    arrangeJamQueue,
} from '../services/music/musicActions.js';
import { canControlMusic, VOICE_CHANNEL_DENIAL } from '../services/music/permissions.js';
import { refreshPlayerMessage, answerWithPlayerPanel } from '../services/music/playerHandler.js';
import { openPlaylistPanel } from '../services/music/musicPlaylists.js';
import { MUSIC_BUTTON_IDS } from '../services/music/musicEmbeds.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';

// These change the player panel itself: the click is answered with the new panel
// in one step (no acknowledgement first and an edit after it).
const PANEL_BUTTONS = new Set([
    MUSIC_BUTTON_IDS.PAUSE,
    MUSIC_BUTTON_IDS.RESUME,
    MUSIC_BUTTON_IDS.SHUFFLE,
    MUSIC_BUTTON_IDS.LOOP,
]);

async function answerPanelButton(interaction, client, player, guildData) {
    const guildId = interaction.guild.id;
    switch (interaction.customId) {
        case MUSIC_BUTTON_IDS.PAUSE:
            await applyPause(client, guildId, { refresh: false });
            break;
        case MUSIC_BUTTON_IDS.RESUME:
            await applyResume(client, guildId, { refresh: false });
            break;
        case MUSIC_BUTTON_IDS.SHUFFLE:
            if (player.queue.length > 0) {
                player.queue.shuffle();
                // In a jam the turns stay (who goes first and each person's own order are mixed).
                if (guildData.jam) arrangeJamQueue(player);
                guildData.shuffle = true;
            }
            break;
        default: {
            const next = guildData.loop === 'none' ? 'track' : guildData.loop === 'track' ? 'queue' : 'none';
            await setLoopMode(client, interaction, next, { refresh: false });
        }
    }
    await answerWithPlayerPanel(interaction, client, guildId);
}

async function handleMusicButton(interaction, client) {
    const player = getPlayer(client, interaction.guild.id);
    const guildData = getGuildMusicData(interaction.guild.id);
    const customId = interaction.customId;

    // Saved playlists can be opened and added to by everyone; starting one
    // checks the voice channel itself.
    if (customId === MUSIC_BUTTON_IDS.PLAYLISTS) {
        return openPlaylistPanel(interaction, client);
    }

    if (customId === MUSIC_BUTTON_IDS.QUEUE) {
        if (!player?.current) {
            return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Nothing is playing right now.' });
        }
        if (!canControlMusic(interaction.member, player)) {
            return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: VOICE_CHANNEL_DENIAL });
        }
        guildData.queuePages.set(interaction.user.id, 0);
        const payload = buildQueueReply(client, interaction.guild.id, 0);
        return interaction.reply({
            embeds: payload.embeds,
            components: payload.components,
            flags: MessageFlags.Ephemeral,
        });
    }

    const queuePaginationIds = [
        MUSIC_BUTTON_IDS.QUEUE_FIRST,
        MUSIC_BUTTON_IDS.QUEUE_PREV,
        MUSIC_BUTTON_IDS.QUEUE_NEXT,
        MUSIC_BUTTON_IDS.QUEUE_LAST,
    ];

    if (queuePaginationIds.includes(customId)) {
        if (!player?.current) {
            return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Nothing is playing right now.' });
        }
        if (!canControlMusic(interaction.member, player)) {
            return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: VOICE_CHANNEL_DENIAL });
        }

        await interaction.deferUpdate();
        const payload = buildQueueReply(client, interaction.guild.id, guildData.queuePages.get(interaction.user.id) || 0);
        const totalPages = payload.totalPages;
        let page = payload.page;

        switch (customId) {
            case MUSIC_BUTTON_IDS.QUEUE_FIRST:
                page = 0;
                break;
            case MUSIC_BUTTON_IDS.QUEUE_PREV:
                page = Math.max(0, page - 1);
                break;
            case MUSIC_BUTTON_IDS.QUEUE_NEXT:
                page = Math.min(totalPages - 1, page + 1);
                break;
            case MUSIC_BUTTON_IDS.QUEUE_LAST:
                page = totalPages - 1;
                break;
            default:
                break;
        }

        guildData.queuePages.set(interaction.user.id, page);
        const updated = buildQueueReply(client, interaction.guild.id, page);
        return interaction.editReply({
            embeds: updated.embeds,
            components: updated.components,
        });
    }

    if (!player) {
        return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'No music is playing. Use `/play` first.' });
    }

    if (!canControlMusic(interaction.member, player)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: VOICE_CHANNEL_DENIAL });
    }

    if (PANEL_BUTTONS.has(customId)) {
        try {
            await answerPanelButton(interaction, client, player, guildData);
        } catch (error) {
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: interaction.customId,
                handler: 'music',
            });
        }
        return;
    }

    await interaction.deferUpdate();

    try {
        switch (customId) {
            case MUSIC_BUTTON_IDS.PREVIOUS:
                playPreviousTrack(player, guildData);
                break;
            case MUSIC_BUTTON_IDS.SKIP:
                if (player.current) skipCurrentTrack(player, guildData);
                break;
            case MUSIC_BUTTON_IDS.STOP:
                await destroyPlayerSession(client, interaction.guild.id, player, guildData);
                break;
            case MUSIC_BUTTON_IDS.VOL_DOWN:
                guildData.volume = Math.max(0, guildData.volume - 10);
                player.setVolume(guildData.volume);
                await refreshPlayerMessage(client, interaction.guild.id);
                break;
            case MUSIC_BUTTON_IDS.VOL_UP:
                guildData.volume = Math.min(100, guildData.volume + 10);
                player.setVolume(guildData.volume);
                await refreshPlayerMessage(client, interaction.guild.id);
                break;
            default:
                break;
        }
    } catch (error) {
        await handleInteractionError(interaction, error, {
            type: 'button',
            customId: interaction.customId,
            handler: 'music',
        });
    }
}

export const musicButtonHandler = {
    async execute(interaction, client) {
        try {
            if (!client.riffy) {
                return replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Music is unavailable — Lavalink is not configured.' });
            }
            await handleMusicButton(interaction, client);
        } catch (error) {
            await handleInteractionError(interaction, error, { handler: 'musicButton' });
        }
    },
};

export default musicButtonHandler;
