// The public "Now playing" message of /play must not say "Now playing" once the
// song is over: when the track ends it becomes "Played" (or "Could not play").
import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';

export async function finishRequestMessage(client, track, outcome = 'played') {
    const info = track?.info;
    if (!info) return false;
    const ref = info.requestRef;
    if (!ref) {
        // The reply is still being sent: remember how the song ended.
        info.requestOutcome = outcome;
        return false;
    }
    info.requestRef = null;
    info.requestOutcome = null;
    try {
        const channel = client.channels?.cache?.get(ref.channelId) || await client.channels?.fetch?.(ref.channelId).catch(() => null);
        const message = channel?.messages ? await channel.messages.fetch(ref.messageId).catch(() => null) : null;
        const source = message?.embeds?.[0];
        if (!message || !source) return false;
        await message.edit({
            embeds: [EmbedBuilder.from(source).setTitle(outcome === 'failed' ? 'Could not play' : 'Played')],
            allowedMentions: { parse: [] },
        });
        return true;
    } catch (error) {
        logger.debug(`[MUSIC] Could not update the request message: ${error?.message || error}`);
        return false;
    }
}

export async function rememberRequestMessage(client, track, message) {
    if (!track?.info || !message?.id) return;
    track.info.requestRef = { channelId: message.channelId, messageId: message.id };
    if (track.info.requestOutcome) await finishRequestMessage(client, track, track.info.requestOutcome);
}

// Riffy emits only queueEnd (no trackEnd) for the very last song.
export function lastFinishedTrack(player) {
    return Array.isArray(player?.previous) ? player.previous.at(-1) : player?.previous || null;
}
