import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

if (!text.includes('const logoMediaRow = new ActionRowBuilder().addComponents(')) {
    const controlsPattern = /function buildControls\(state\) \{[\s\S]*?\n\}\n\nfunction getPreviewUpdateQueue/;
    if (!controlsPattern.test(text)) {
        console.error('[EMBED_BUILDER_SEVEN_VISIBLE_ROWS] buildControls marker not found');
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

    const logoMediaRow = new ActionRowBuilder().addComponents(
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

    const styleButtonsRow = new ActionRowBuilder().addComponents(
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
            .setLabel(state.modifyTarget ? 'Save change' : 'Post message')
            .setStyle(ButtonStyle.Success)
            .setEmoji(state.modifyTarget ? '💾' : '📤'),
    );

    return [titleRow, logoMediaRow, styleButtonsRow, modifyResetRow, saveRow];
}

function getPreviewUpdateQueue`);
}

if (!text.includes('return [titleRow, logoMediaRow, styleButtonsRow, modifyResetRow, saveRow];')) {
    console.error('[EMBED_BUILDER_SEVEN_VISIBLE_ROWS] final verification failed');
    process.exit(1);
}

if (text !== before) fs.writeFileSync(path, text, 'utf8');
console.log(`[EMBED_BUILDER_SEVEN_VISIBLE_ROWS] ${text === before ? 'already current' : 'prepared single-message seven visible rows'}`);
