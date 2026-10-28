import { logger } from '../utils/logger.js';
import { registerCloudyEmbedMessage } from './embedRegistryService.js';
import { withEmbedBuilderMessageMutation } from './embedBuilderMutationLock.js';

function snapshotIdentity(snapshot) {
    const node = snapshot?.toJSON?.() || snapshot || {};
    return JSON.stringify({
        title: node.title || '',
        description: node.description || '',
        color: node.color ?? null,
        image: node.image?.url || '',
        thumbnail: node.thumbnail?.url || '',
        fields: node.fields || [],
        footer: node.footer?.text || '',
        footerIcon: node.footer?.icon_url || node.footer?.iconURL || '',
        author: node.author?.name || '',
    });
}

/**
 * Refresh only one manually saved physical message, by its stable Discord ID.
 * Never merge by title: two separate Test/Yess posts must stay separate, and
 * losing permission to fetch is not permission to delete a saved template.
 */
export async function refreshManualBuilderSearchRecord(guild, record) {
    if (!guild?.id || !record || record.detached
        || record.source !== 'embed-builder' || record.manualSaved !== true
        || !record.messageId || String(record.messageId).startsWith('draft-')) return record;

    const channelId = String(record.backingChannelId || record.channelId || '');
    const messageId = String(record.messageId);
    const embedIndex = Math.max(0, Number(record.embedIndex) || 0);
    if (!channelId || !messageId) return record;

    return withEmbedBuilderMessageMutation(guild.id, channelId, messageId, async () => {
        let channel = guild.channels?.cache?.get?.(channelId) || null;
        if (!channel && typeof guild.channels?.fetch === 'function') {
            channel = await guild.channels.fetch(channelId).catch(() => null);
        }
        if (!channel?.messages?.fetch) return record;
        let message;
        try {
            message = await channel.messages.fetch(messageId, { force: true });
        } catch {
            // No delete/tombstone on a temporary 403, 404 or Discord failure.
            return record;
        }
        const embed = message?.embeds?.[embedIndex];
        const botId = guild.client?.user?.id;
        if (!embed || String(message.id) !== messageId
            || (botId && String(message.author?.id) !== String(botId))) return record;

        const snapshot = embed.toJSON?.() || embed;
        const rows = (message.components || []).map(row => row?.toJSON?.() || row);
        if (snapshotIdentity(snapshot) === snapshotIdentity(record.snapshot)
            && JSON.stringify(rows) === JSON.stringify(record.components || [])) return record;

        const fresh = {
            ...record,
            name: snapshot.title || '',
            title: snapshot.title || '',
            snapshot,
            components: rows,
        };
        const saved = await registerCloudyEmbedMessage(message, 'embed-builder', {
            manualSave: true,
            manualSaveIndex: embedIndex,
        });
        if (!saved) {
            logger.warn('[EMBED_SEARCH] Physical message was newer than stored snapshot, but registry update failed.');
        }
        // For this one Search open, the actual physical embed is authoritative
        // even if persistence was temporarily unavailable.
        return fresh;
    });
}
