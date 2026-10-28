import { MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { withEmbedBuilderMessageMutation } from './embedBuilderMutationLock.js';
import { beginEmbedRegistryMove, purgeEmbedRegistryRecord } from './embedRegistryService.js';
import { syncExistingEmbedReappearRule } from './embedReappearService.js';

/**
 * Repost is an operation on the selected Builder identity, not permission to
 * create an untracked copy of the old physical message. An ordinary brand-new
 * Post has no target and retains its normal ability to create a new message.
 *
 * A deliberate Repost always publishes a NEW physical message (new message
 * ID, also in the same channel) and retires the old one, so exactly one live
 * message and one registry identity remain. Save is the in-place edit.
 */
export async function postReplacingManualBuilderMessage({
    guild, target, postNew,
    // Kept in the call signature for existing callers. A Repost no longer
    // depends on the destination channel or an in-place Save.
    channel: _channel,
    saveExisting: _saveExisting,
    purge = purgeEmbedRegistryRecord,
    disableReappear = syncExistingEmbedReappearRule,
    beginMove = beginEmbedRegistryMove,
}) {
    const replace = target?.source === 'embed-builder'
        && !target.detached && target?.messageId
        && !String(target.messageId).startsWith('draft-');
    if (!replace) return postNew();

    const sourceChannelId = String(target.backingChannelId || target.channelId || '');
    const sourceMessageId = String(target.messageId);

    return withEmbedBuilderMessageMutation(guild.id, sourceChannelId, sourceMessageId, async () => {
        const sourceChannel = guild.channels?.cache?.get?.(sourceChannelId)
            || await guild.channels?.fetch?.(sourceChannelId).catch(() => null);
        if (!sourceChannel?.messages?.fetch) {
            return { ok: false, reason: 'source-unavailable' };
        }
        let original;
        try {
            original = await sourceChannel.messages.fetch(sourceMessageId, { force: true });
        } catch {
            return { ok: false, reason: 'source-unavailable' };
        }
        if (!original || String(original.id) !== sourceMessageId
            || String(original.author?.id || '') !== String(guild.client?.user?.id || '')
            || original.flags?.has?.(MessageFlags.Ephemeral)) {
            return { ok: false, reason: 'source-not-owned' };
        }

        const posted = await postNew();
        if (!posted.ok) return posted;

        // The new message is already durable in the registry. If the old
        // physical message cannot be deleted, roll back every new post.
        // Therefore a failed Repost never leaves two live copies. Cloudy's own
        // deletion is not a manual Discord delete: no detached ghost appears.
        const releaseMove = beginMove(guild.id, sourceChannelId, sourceMessageId);
        try {
            const deleted = await original.delete().then(() => true).catch(() => false);
            if (!deleted) {
                await posted.rollback?.();
                return { ok: false, reason: 'original-delete-failed' };
            }
            return await retireRepostedSource({
                guild, target, posted, sourceChannelId, sourceMessageId, purge, disableReappear,
            });
        } finally {
            releaseMove();
        }
    });
}

async function retireRepostedSource({
    guild, target, posted, sourceChannelId, sourceMessageId, purge, disableReappear,
}) {
    // Old reappear rules would recreate the deleted message and cause
    // unexpected future duplicates even after Search/registry cleanup.
    const reappear = await disableReappear({
        guildId: guild.id,
        channelId: sourceChannelId,
        messageId: sourceMessageId,
        embedIndex: Number(target.embedIndex) || 0,
        every: null,
    }).catch(() => ({ ok: false }));
    if (!reappear?.ok) {
        logger.error('[EMBED_BUILDER] Repost moved, but old reappear rule cleanup failed', {
            guildId: guild.id, sourceChannelId, sourceMessageId,
        });
    }

    let purged = false;
    for (let attempt = 0; attempt < 3 && !purged; attempt += 1) {
        purged = Boolean(await purge(
            guild.id, sourceChannelId, sourceMessageId, null,
        ).catch(() => false));
    }
    if (!purged || !reappear?.ok) {
        logger.error('[EMBED_BUILDER] Repost cleanup is incomplete; new physical message retained', {
            guildId: guild.id, sourceChannelId, sourceMessageId,
            registryRemoved: purged, reappearDisabled: Boolean(reappear?.ok),
        });
        return { ...posted, ok: false, reason: 'cleanup-incomplete', newMessagePosted: true };
    }
    return { ...posted, replaced: true };
}
