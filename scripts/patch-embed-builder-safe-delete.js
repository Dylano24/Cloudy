import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    throw new Error(`[BUILDER_SAFE_DELETE] No changes applied to ${path}; runtime shape changed.`);
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_SAFE_DELETE] ${path}: patched`);
}

function replaceRequired(text, before, after, label) {
  if (text.includes(before)) return text.replace(before, after);
  if (text.includes(after)) return text;
  throw new Error(`[BUILDER_SAFE_DELETE] Missing ${label}`);
}

patchFile('src/services/embedManagerService.js', text => {
  const before = `    state.mediaConvertedFromVideo = false;
    state.modifyTarget = {`;
  const after = `    state.mediaConvertedFromVideo = false;
    state.pendingBuilderDelete = null;
    state.modifyTarget = {`;

  const occurrences = text.split(before).length - 1;
  if (occurrences < 2 && !text.includes(after)) {
    throw new Error('[BUILDER_SAFE_DELETE] modify target load anchors missing');
  }
  return text.replaceAll(before, after);
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  text = replaceRequired(
    text,
    `import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';`,
    `import {
    purgeEmbedRegistryRecord,
    registerCloudyEmbedMessage,
} from '../../services/embedRegistryService.js';`,
    'registry import',
  );

  const helperAnchor = `// Acknowledging the click immediately makes Save feel instant, while the
// actual message edit still remains the source of truth before we confirm it.`;
  if (!text.includes(helperAnchor)) {
    throw new Error('[BUILDER_SAFE_DELETE] save helper anchor missing');
  }

  if (!text.includes('async function inspectBuilderDeleteTarget(')) {
    const helpers = `
const BUILDER_DELETE_MISSING_CODES = new Set([10003, 10008]);

function builderDeleteTargetKey(target) {
    return [
        String(target?.backingChannelId || target?.channelId || ''),
        String(target?.messageId || ''),
        Math.max(0, Number(target?.embedIndex) || 0),
    ].join(':');
}

function canDeleteBuilderRecord(target) {
    return Boolean(
        target?.messageId
        && target?.channelId
        && target?.source !== 'system-catalog'
        && !target?.templateMode
    );
}

async function inspectBuilderDeleteTarget(guild, target) {
    if (!canDeleteBuilderRecord(target)) return { status: 'protected' };

    const channelId = String(target.backingChannelId || target.channelId || '');
    let channel = guild.channels.cache.get(channelId) || null;

    if (!channel) {
        try {
            channel = await guild.channels.fetch(channelId);
        } catch (error) {
            return BUILDER_DELETE_MISSING_CODES.has(error?.code)
                ? { status: 'missing' }
                : { status: 'unknown' };
        }
    }

    if (!channel?.messages?.fetch) return { status: 'unknown' };

    try {
        const message = await channel.messages.fetch(String(target.messageId));
        return message ? { status: 'exists', message } : { status: 'unknown' };
    } catch (error) {
        return BUILDER_DELETE_MISSING_CODES.has(error?.code)
            ? { status: 'missing' }
            : { status: 'unknown' };
    }
}

function clearBuilderRecordCaches(guildId) {
    const prefix = String(guildId) + ':';
    const managerCache = globalThis.__cloudyEmbedManagerRecordCache;
    if (managerCache?.keys) {
        for (const key of managerCache.keys()) {
            if (String(key).startsWith(prefix)) managerCache.delete(key);
        }
    }
    globalThis.__cloudyEmbedCanonicalSearchCache?.delete?.(String(guildId));
}

async function sendBuilderDeleteNotice(interaction, title, description, color = 0xFFFFFF) {
    const message = await interaction.followUp({
        embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
    }).catch(() => null);
    if (message) removeTransientMessage(interaction, message);
}

async function togglePendingBuilderDeletion(buttonInteraction, guild, state) {
    const target = state.modifyTarget;
    const key = builderDeleteTargetKey(target);

    if (state.pendingBuilderDelete?.key === key) {
        state.pendingBuilderDelete = null;
        await refreshBuilder(buttonInteraction, state);
        return;
    }

    if (!canDeleteBuilderRecord(target)) {
        await sendBuilderDeleteNotice(
            buttonInteraction,
            'Delete unavailable',
            'This is a protected Cloudy template or no editable Builder record is selected.',
            0xED4245,
        );
        return;
    }

    const presence = await inspectBuilderDeleteTarget(guild, target);
    if (presence.status === 'exists') {
        await sendBuilderDeleteNotice(
            buttonInteraction,
            'Delete blocked',
            'The real Discord message still exists. Delete that message first; Cloudy will never remove a live embed through **Delete from Builder**.',
            0xED4245,
        );
        return;
    }
    if (presence.status !== 'missing') {
        await sendBuilderDeleteNotice(
            buttonInteraction,
            'Could not verify safely',
            'Cloudy could not confirm that the original Discord message is gone, so nothing was marked for deletion.',
            0xED4245,
        );
        return;
    }

    state.pendingBuilderDelete = {
        key,
        channelId: String(target.channelId),
        backingChannelId: String(target.backingChannelId || target.channelId),
        messageId: String(target.messageId),
        embedIndex: Math.max(0, Number(target.embedIndex) || 0),
    };
    await refreshBuilder(buttonInteraction, state);
}

function resetBuilderAfterRecordDeletion(state) {
    state.title = null;
    state.message = null;
    state.embedFields = [];
    state.sideColor = 0xFFFFFF;
    state.showLogo = true;
    state.removeExistingLogo = false;
    state.bottomLine = DEFAULT_FOOTER_TEXT;
    state.mediaUrl = null;
    state.mediaBuffer = null;
    state.mediaName = null;
    state.mediaConvertedFromVideo = false;
    state.modifyTarget = null;
    state.pendingBuilderDelete = null;
}

async function savePendingBuilderDeletion(buttonInteraction, guild, state) {
    const target = state.modifyTarget;
    const pending = state.pendingBuilderDelete;
    if (!target || !pending || pending.key !== builderDeleteTargetKey(target)) {
        state.pendingBuilderDelete = null;
        await sendBuilderDeleteNotice(
            buttonInteraction,
            'Delete cancelled',
            'The selected Builder record changed, so the pending deletion was cancelled.',
            0xED4245,
        );
        return false;
    }

    // Re-check on Save. The first Delete click only arms the operation.
    const presence = await inspectBuilderDeleteTarget(guild, target);
    if (presence.status === 'exists') {
        state.pendingBuilderDelete = null;
        await sendBuilderDeleteNotice(
            buttonInteraction,
            'Delete blocked',
            'The real Discord message exists again, so the Builder record was not removed.',
            0xED4245,
        );
        await refreshBuilder(buttonInteraction, state);
        return false;
    }
    if (presence.status !== 'missing') {
        await sendBuilderDeleteNotice(
            buttonInteraction,
            'Could not verify safely',
            'Cloudy still cannot prove that the Discord message is gone. The Builder record was not removed.',
            0xED4245,
        );
        return false;
    }

    await purgeEmbedRegistryRecord(
        guild.id,
        pending.channelId,
        pending.messageId,
        pending.embedIndex,
    );

    clearBuilderRecordCaches(guild.id);
    resetBuilderAfterRecordDeletion(state);
    await refreshBuilder(buttonInteraction, state);
    await sendBuilderDeleteNotice(
        buttonInteraction,
        'Removed from Builder',
        'The stale record was removed from the Embed Builder. No Discord message was deleted.',
        0x57F287,
    );
    return true;
}

`;
    text = text.replace(helperAnchor, helpers + helperAnchor);
  }

  text = replaceRequired(
    text,
    `.setLabel(state.modifyTarget ? 'Save changes' : 'Post message')
            .setStyle(ButtonStyle.Success)
            .setEmoji(state.modifyTarget ? '💾' : '📤'),`,
    `.setLabel(state.pendingBuilderDelete ? 'Save deletion' : (state.modifyTarget ? 'Save changes' : 'Post message'))
            .setStyle(state.pendingBuilderDelete ? ButtonStyle.Danger : ButtonStyle.Success)
            .setEmoji(state.pendingBuilderDelete ? '🗑️' : (state.modifyTarget ? '💾' : '📤')),`,
    'Save deletion button state',
  );

  text = replaceRequired(
    text,
    `    const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_close')
            .setLabel('Close message')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('✖️'),
    );`,
    `    const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_delete_from_builder')
            .setLabel(state.pendingBuilderDelete ? 'Cancel delete' : 'Delete from Builder')
            .setStyle(state.pendingBuilderDelete ? ButtonStyle.Secondary : ButtonStyle.Danger)
            .setEmoji(state.pendingBuilderDelete ? '↩️' : '🗑️')
            .setDisabled(!canDeleteBuilderRecord(state.modifyTarget)),
        new ButtonBuilder()
            .setCustomId('simple_embed_close')
            .setLabel('Close message')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('✖️'),
    );`,
    'Delete from Builder control',
  );

  text = replaceRequired(
    text,
    `                        case 'simple_embed_post':
                            if (state.modifyTarget) {
                                await buttonInteraction.deferUpdate().catch(() => {});
                                await saveExistingEmbed(buttonInteraction, interaction.guild, state);
                                break;
                            }`,
    `                        case 'simple_embed_post':
                            if (state.modifyTarget) {
                                await buttonInteraction.deferUpdate().catch(() => {});
                                if (state.pendingBuilderDelete) {
                                    await savePendingBuilderDeletion(buttonInteraction, interaction.guild, state);
                                    break;
                                }
                                await saveExistingEmbed(buttonInteraction, interaction.guild, state);
                                break;
                            }`,
    'Save pending deletion branch',
  );

  text = replaceRequired(
    text,
    `                        case 'simple_embed_close':`,
    `                        case 'simple_embed_delete_from_builder':
                            await buttonInteraction.deferUpdate().catch(() => {});
                            await togglePendingBuilderDeletion(buttonInteraction, interaction.guild, state);
                            break;
                        case 'simple_embed_close':`,
    'Delete from Builder handler',
  );

  text = replaceRequired(
    text,
    `                            state.modifyTarget = null;
                            await refreshBuilder(buttonInteraction, state);`,
    `                            state.modifyTarget = null;
                            state.pendingBuilderDelete = null;
                            await refreshBuilder(buttonInteraction, state);`,
    'Reset clears pending deletion',
  );

  return text;
});

console.log('[BUILDER_SAFE_DELETE] Two-step stale record deletion enabled.');
