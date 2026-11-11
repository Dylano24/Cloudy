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


// A previously deployed /play also posted a public summary without controls.
// Remove only these bot-authored legacy summaries once per text channel, never
// the real player (which has seven buttons), guides or user messages.
const cleanedMusicChannels = new Set();
export async function removeOldMusicAnnouncements(client, channel) {
    const key = String(channel?.id || '');
    if (!key || cleanedMusicChannels.has(key) || !channel?.messages?.fetch || !client?.user?.id) return 0;
    cleanedMusicChannels.add(key);
    try {
        const messages = await channel.messages.fetch({ limit: 30 });
        let deleted = 0;
        for (const message of messages?.values?.() || []) {
            if (message.author?.id !== client.user.id || message.components?.length || !message.delete) continue;
            const e = message.embeds?.[0];
            if (!['Now playing', 'Added to queue'].includes(e?.title)) continue;
            if (!e.fields?.some(field => field.name === 'Duration')
                || !e.fields?.some(field => field.name === 'Requested by')) continue;
            if (await message.delete().then(() => true, () => false)) deleted++;
        }
        return deleted;
    } catch (error) {
        cleanedMusicChannels.delete(key);
        logger.debug('[MUSIC] Legacy announcement cleanup skipped: ' + (error?.message || error));
        return 0;
    }
}
