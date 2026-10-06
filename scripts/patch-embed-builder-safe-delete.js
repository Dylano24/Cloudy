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

  if (!text.includes("syncExistingEmbedReappearRule } from '../../services/embedReappearService.js'")) {
    const registryImport = "} from '../../services/embedRegistryService.js';";
    const registryEnd = text.indexOf(registryImport);
    if (registryEnd < 0) throw new Error('[BUILDER_SAFE_DELETE] registry import end missing');
    const insertAt = registryEnd + registryImport.length;
    text = text.slice(0, insertAt)
      + "\nimport { syncExistingEmbedReappearRule } from '../../services/embedReappearService.js';"
      + text.slice(insertAt);
  }

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

    // Disable Reappear through the canonical index. The visible copy can have
    // a newer Discord message ID than the original rule key, so constructing a
    // DB key from pending.messageId can miss the rule and resurrect the embed.
    const reappear = await syncExistingEmbedReappearRule({
        guildId: guild.id,
        channelId: pending.channelId,
        messageId: pending.messageId,
        embedIndex: pending.embedIndex,
        every: null,
    });

    if (!reappear.ok) {
        await sendBuilderDeleteNotice(
            buttonInteraction,
            'Delete could not be saved',
            'Cloudy could not disable the linked Reappear rule safely, so the Builder record was left unchanged.',
            0xED4245,
        );
        return false;
    }

    const activeReappearMessageId = reappear.activeMessageId
        ? String(reappear.activeMessageId)
        : null;
    if (activeReappearMessageId && activeReappearMessageId !== String(pending.messageId)) {
        const reappearChannel = guild.channels.cache.get(String(pending.channelId))
            || await guild.channels.fetch(String(pending.channelId)).catch(() => null);
        const activeMessage = reappearChannel?.messages?.fetch
            ? await reappearChannel.messages.fetch(activeReappearMessageId).catch(() => null)
            : null;
        await activeMessage?.delete?.().catch(() => {});
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
        'The stale record and its Reappear rule were removed from the Embed Builder.',
        0x57F287,
    );
    return true;
}

`;
    text = text.replace(helperAnchor, helpers + helperAnchor);
  }

  if (!text.includes('Save deletion')) {
    const saveButtonStart = text.indexOf(".setCustomId('simple_embed_post')");
    const saveButtonEnd = text.indexOf('new ButtonBuilder()', saveButtonStart + 1);
    if (saveButtonStart < 0 || saveButtonEnd < 0) {
      throw new Error('[BUILDER_SAFE_DELETE] Save button block missing');
    }

    let saveButton = text.slice(saveButtonStart, saveButtonEnd);
    saveButton = saveButton
      .replace(
        /\.setLabel\([^\n]+\)/,
        ".setLabel(state.pendingBuilderDelete ? 'Save deletion' : (state.modifyTarget ? 'Save changes' : 'Post message'))",
      )
      .replace(
        /\.setStyle\([^\n]+\)/,
        '.setStyle(state.pendingBuilderDelete ? ButtonStyle.Danger : ButtonStyle.Success)',
      )
      .replace(
        /\.setEmoji\([^\n]+\)/,
        ".setEmoji(state.pendingBuilderDelete ? '🗑️' : (state.modifyTarget ? '💾' : '📤'))",
      );

    text = text.slice(0, saveButtonStart) + saveButton + text.slice(saveButtonEnd);
  }

  if (!text.includes("setCustomId('simple_embed_delete_from_builder')")) {
    const closeId = text.indexOf(".setCustomId('simple_embed_close')");
    const closeButtonStart = text.lastIndexOf('new ButtonBuilder()', closeId);
    if (closeId < 0 || closeButtonStart < 0) {
      throw new Error('[BUILDER_SAFE_DELETE] Close button block missing');
    }

    const deleteButton = `new ButtonBuilder()
            .setCustomId('simple_embed_delete_from_builder')
            .setLabel(state.pendingBuilderDelete ? 'Cancel delete' : 'Delete from Builder')
            .setStyle(state.pendingBuilderDelete ? ButtonStyle.Secondary : ButtonStyle.Danger)
            .setEmoji(state.pendingBuilderDelete ? '↩️' : '🗑️')
            .setDisabled(!canDeleteBuilderRecord(state.modifyTarget)),
        `;
    text = text.slice(0, closeButtonStart) + deleteButton + text.slice(closeButtonStart);
  }

  if (!text.includes('await savePendingBuilderDeletion(buttonInteraction, interaction.guild, state);')) {
    const postCase = text.indexOf("case 'simple_embed_post':");
    const modifyBranch = text.indexOf('if (state.modifyTarget) {', postCase);
    if (postCase < 0 || modifyBranch < 0) {
      throw new Error('[BUILDER_SAFE_DELETE] Save modify branch missing');
    }
    const insertAt = text.indexOf('\n', modifyBranch) + 1;
    const pendingBranch = `                                if (state.pendingBuilderDelete) {
                                    await buttonInteraction.deferUpdate().catch(() => {});
                                    await savePendingBuilderDeletion(buttonInteraction, interaction.guild, state);
                                    break;
                                }
`;
    text = text.slice(0, insertAt) + pendingBranch + text.slice(insertAt);
  }

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

  {
    const resetCase = text.indexOf("case 'simple_embed_reset':");
    const resetEnd = text.indexOf('break;', resetCase);
    if (resetCase < 0 || resetEnd < 0) {
      throw new Error('[BUILDER_SAFE_DELETE] Reset case missing');
    }

    const resetBlock = text.slice(resetCase, resetEnd);
    if (!resetBlock.includes('state.pendingBuilderDelete = null;')) {
      const targetReset = resetBlock.indexOf('state.modifyTarget = null;');
      if (targetReset < 0) {
        throw new Error('[BUILDER_SAFE_DELETE] Reset modify target clear missing');
      }
      const insertAt = resetCase + targetReset + 'state.modifyTarget = null;'.length;
      text = text.slice(0, insertAt)
        + '\n                            state.pendingBuilderDelete = null;'
        + text.slice(insertAt);
    }
  }

  return text;
});

console.log('[BUILDER_SAFE_DELETE] Two-step stale record deletion enabled.');
