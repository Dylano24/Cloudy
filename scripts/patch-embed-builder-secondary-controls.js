import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

const controlsMarker = 'function buildSecondaryControls(state) {';
if (!text.includes(controlsMarker)) {
    const controlsPattern = /function buildControls\(state\) \{[\s\S]*?\n\}\n\nfunction getPreviewUpdateQueue/;
    if (!controlsPattern.test(text)) {
        console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] buildControls marker not found');
        process.exit(1);
    }

    text = text.replace(controlsPattern, `function buildControls(state) {
    const sourceHasLogo = Boolean(state.modifyTarget?.sourceEmbedData?.thumbnail?.url);
    const hasLogo = !state.removeExistingLogo && (state.showLogo || sourceHasLogo);

    const titleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setURL(state.contentEditorUrl)
            .setLabel('Edit title & message')
            .setStyle(ButtonStyle.Link)
            .setEmoji('✍🏼'),
    );

    const logoRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_logo')
            .setLabel('Add logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('☁️')
            .setDisabled(state.showLogo && !state.removeExistingLogo),
        new ButtonBuilder()
            .setCustomId('simple_embed_remove_logo')
            .setLabel('Remove logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️')
            .setDisabled(!hasLogo),
    );

    const mediaRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_media')
            .setLabel('Add media')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📷'),
        new ButtonBuilder()
            .setCustomId('simple_embed_clear_media')
            .setLabel('Remove media')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('❌')
            .setDisabled(!hasMedia(state)),
    );

    const styleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_footer')
            .setLabel('Edit footer')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📝'),
        new ButtonBuilder()
            .setURL(state.colorPickerUrl)
            .setLabel('Set side color')
            .setStyle(ButtonStyle.Link)
            .setEmoji('🎨'),
    );

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_buttons')
            .setLabel('Edit buttons')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔘'),
        new ButtonBuilder()
            .setCustomId('simple_embed_remove_buttons')
            .setLabel('Remove buttons')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⛔'),
    );

    return [titleRow, logoRow, mediaRow, styleRow, buttonRow];
}

function buildSecondaryControls() {
    const modifyResetRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_modify')
            .setLabel('Modify embed')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛠️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_reset')
            .setLabel('Reset')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('♻️'),
    );

    const saveRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_post')
            .setLabel('Save change')
            .setStyle(ButtonStyle.Success)
            .setEmoji('💾'),
    );

    return [modifyResetRow, saveRow];
}

async function refreshSecondaryControls(state) {
    if (!state.secondaryControlsMessage) return;
    await state.secondaryControlsMessage.edit({
        components: buildSecondaryControls(state),
    }).catch(() => {});
}

function getPreviewUpdateQueue`);
}

if (!text.includes('refreshInteraction = buttonInteraction')) {
    const saveSignature = 'async function saveExistingEmbed(buttonInteraction, guild, state) {';
    if (!text.includes(saveSignature)) {
        console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] saveExistingEmbed signature not found');
        process.exit(1);
    }
    text = text.replace(
        saveSignature,
        'async function saveExistingEmbed(buttonInteraction, guild, state, refreshInteraction = buttonInteraction) {',
    );

    const saveRefresh = '    void refreshBuilder(buttonInteraction, state).catch(() => {});';
    if (!text.includes(saveRefresh)) {
        console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] save refresh marker not found');
        process.exit(1);
    }
    text = text.replace(
        saveRefresh,
        '    void refreshBuilder(refreshInteraction, state).catch(() => {});',
    );
}

if (!text.includes('secondaryControlsMessage: null')) {
    const stateMarker = `                componentRows: [],
                componentRowsSourceMessageId: 'new',
                componentsDirty: false,
                colorSessionToken: null,`;
    const stateReplacement = `                componentRows: [],
                componentRowsSourceMessageId: 'new',
                componentsDirty: false,
                secondaryControlsMessage: null,
                secondaryControlsCollector: null,
                colorSessionToken: null,`;
    if (!text.includes(stateMarker)) {
        console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] state marker not found');
        process.exit(1);
    }
    text = text.replace(stateMarker, stateReplacement);
}

if (!text.includes('const secondaryControlsMessage = await interaction.followUp')) {
    const dashboardMarker = `            const dashboardMessage = await interaction.fetchReply();
            const collector = dashboardMessage.createMessageComponentCollector({`;
    const dashboardReplacement = `            const dashboardMessage = await interaction.fetchReply();
            const secondaryControlsMessage = await interaction.followUp({
                components: buildSecondaryControls(state),
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            }).catch(() => null);
            state.secondaryControlsMessage = secondaryControlsMessage;

            const collector = dashboardMessage.createMessageComponentCollector({`;
    if (!text.includes(dashboardMarker)) {
        console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] dashboard collector marker not found');
        process.exit(1);
    }
    text = text.replace(dashboardMarker, dashboardReplacement);
}

if (!text.includes("secondaryCollector?.on('collect'")) {
    const collectorEndMarker = `            collector.on('end', async (_collected, reason) => {`;
    if (!text.includes(collectorEndMarker)) {
        console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] collector end marker not found');
        process.exit(1);
    }

    const secondaryCollectorBlock = `            const secondaryCollector = secondaryControlsMessage?.createMessageComponentCollector({
                filter: buttonInteraction =>
                    buttonInteraction.isButton() &&
                    buttonInteraction.user.id === interaction.user.id &&
                    ['simple_embed_modify', 'simple_embed_reset', 'simple_embed_post'].includes(buttonInteraction.customId),
            });
            state.secondaryControlsCollector = secondaryCollector || null;

            secondaryCollector?.on('collect', async buttonInteraction => {
                collector.resetTimer();
                try {
                    switch (buttonInteraction.customId) {
                        case 'simple_embed_modify':
                            await openEmbedManager(
                                buttonInteraction,
                                state,
                                async () => {
                                    await refreshBuilder(interaction, state);
                                    await refreshSecondaryControls(state);
                                },
                            );
                            break;
                        case 'simple_embed_post':
                            if (state.modifyTarget) {
                                await buttonInteraction.deferUpdate().catch(() => {});
                                await saveExistingEmbed(buttonInteraction, interaction.guild, state, interaction);
                                await refreshSecondaryControls(state);
                                break;
                            }
                            await postMessage(buttonInteraction, state, interaction.guild);
                            break;
                        case 'simple_embed_reset':
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
                            state.componentRows = [];
                            state.componentRowsSourceMessageId = 'new';
                            state.componentsDirty = false;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(interaction, state);
                            await refreshSecondaryControls(state);
                            break;
                        default:
                            await buttonInteraction.deferUpdate();
                    }
                } catch (error) {
                    logger.error('Error in secondary embed builder controls:', error);
                    if (!buttonInteraction.replied && !buttonInteraction.deferred) {
                        await buttonInteraction.deferUpdate().catch(() => {});
                    }
                    await replyUserError(buttonInteraction, {
                        type: ErrorTypes.UNKNOWN,
                        message: 'The message builder could not complete that action.',
                    }).catch(() => {});
                }
            });

            collector.on('end', async (_collected, reason) => {`;

    text = text.replace(collectorEndMarker, secondaryCollectorBlock);
}

if (!text.includes("state.secondaryControlsCollector?.stop('builder-ended')")) {
    const cleanupMarker = `            collector.on('end', async (_collected, reason) => {
                if (state.activeEmbedManager) {`;
    const cleanupReplacement = `            collector.on('end', async (_collected, reason) => {
                state.secondaryControlsCollector?.stop('builder-ended');
                state.secondaryControlsCollector = null;
                if (state.secondaryControlsMessage) {
                    await state.secondaryControlsMessage.delete().catch(() => {});
                    state.secondaryControlsMessage = null;
                }

                if (state.activeEmbedManager) {`;
    if (!text.includes(cleanupMarker)) {
        console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] cleanup marker not found');
        process.exit(1);
    }
    text = text.replace(cleanupMarker, cleanupReplacement);
}

if (!text.includes(controlsMarker) || !text.includes('secondaryControlsMessage: null')) {
    console.error('[EMBED_BUILDER_SECONDARY_CONTROLS] final verification failed');
    process.exit(1);
}

if (text !== before) fs.writeFileSync(path, text, 'utf8');
console.log(`[EMBED_BUILDER_SECONDARY_CONTROLS] ${text === before ? 'already current' : 'prepared split seven-line controls'}`);
