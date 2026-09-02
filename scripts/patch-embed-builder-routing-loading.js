import fs from 'node:fs';

// This patch runs after the existing Embed Builder patches. It corrects
// catalog placement, channel-selection loading, and the Save feedback lifecycle.
// Game behavior, template semantics, dynamic values, and logo behavior stay untouched.

const registryPath = 'src/services/embedRegistryService.js';
const registryBefore = fs.readFileSync(registryPath, 'utf8');
let registryText = registryBefore;

if (!registryText.includes('function ticketPanelCatalogChannel(message, embed)')) {
    const marker = 'function catalogDisplayChannelId(message, embed) {';
    const helper = `function ticketPanelCatalogChannel(message, embed) {
    const text = cleanName(systemTemplateSearchText(embed));
    const panelMessage = /\\b(?:change panel message|ticket panel message|ticket panel|create a ticket)\\b/.test(text);
    const context = systemTemplateContext(embed);
    const explicitContext = /^tickets\\/(?:panel|ticket-panel|change-panel|panel-message)(?:\\/|$)/.test(context);
    if (!panelMessage && !explicitContext) return null;
    return findFeatureChannel(message.guild, ['ticket-panel', 'tickets']);
}

`;
    if (!registryText.includes(marker)) throw new Error('Embed registry catalog placement marker was not found.');
    registryText = registryText.replace(marker, helper + marker);
}

const contactRouting = `    const contactChannel = contactUsCatalogChannel(message, embed);
    if (contactChannel?.id) return String(contactChannel.id);

`;
if (registryText.includes(contactRouting) && !registryText.includes('const ticketPanelChannel = ticketPanelCatalogChannel(message, embed);')) {
    registryText = registryText.replace(
        contactRouting,
        `${contactRouting}    const ticketPanelChannel = ticketPanelCatalogChannel(message, embed);\n    if (ticketPanelChannel?.id) return String(ticketPanelChannel.id);\n\n`,
    );
}

if (registryText !== registryBefore) fs.writeFileSync(registryPath, registryText);
console.log(`[EMBED_BUILDER_ROUTING_LOADING] ${registryText === registryBefore ? 'registry already current' : 'patched contact/panel catalog placement'}`);

const managerPath = 'src/services/embedManagerService.js';
const managerBefore = fs.readFileSync(managerPath, 'utf8');
let managerText = managerBefore;

const channelStartMarker = "                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {";
const channelEndMarker = "                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {";
const channelStart = managerText.indexOf(channelStartMarker);
const channelEnd = channelStart === -1 ? -1 : managerText.indexOf(channelEndMarker, channelStart);

if (channelStart === -1 || channelEnd === -1) {
    throw new Error('Embed Manager channel-selection block was not found.');
}

// Paint the current menu immediately. The complete history discovery may take
// multiple Discord API pages, so it must never hold the visible Builder hostage.
// When discovery finishes, only the still-current selection may refresh the menu.
const channelBlock = `                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];

                    // Immediate paint from registry/catalog state. This keeps channel
                    // switching responsive even when a channel has a long history.
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    if (selectionVersion !== session.selectionVersion) return;

                    const discoveredRecords = await discoverMissingChannelEmbeds(
                        guild,
                        channelId,
                        buttonInteraction.client.user.id,
                    ).catch(error => {
                        logger.debug(\`On-demand channel embed discovery skipped: \${error?.message || error}\`);
                        return [];
                    });

                    if (selectionVersion !== session.selectionVersion) return;

                    if (discoveredRecords.length) {
                        const otherChannelRecords = records.filter(record =>
                            String(record.channelId) !== String(channelId)
                            || String(record.source || '') === 'system-catalog'
                        );
                        const existingCatalogRecords = records.filter(record =>
                            String(record.channelId) === String(channelId)
                            && String(record.source || '') === 'system-catalog'
                        );

                        // Session-only discovery replaces stale real-message rows
                        // for this channel. Nothing is written back to the registry.
                        records = [
                            ...otherChannelRecords,
                            ...existingCatalogRecords.filter(record => !otherChannelRecords.includes(record)),
                            ...discoveredRecords,
                        ];
                    }

                    if (selectionVersion !== session.selectionVersion) return;
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }

`;

managerText = managerText.slice(0, channelStart) + channelBlock + managerText.slice(channelEnd);

if (managerText !== managerBefore) fs.writeFileSync(managerPath, managerText);
console.log(`[EMBED_BUILDER_ROUTING_LOADING] ${managerText === managerBefore ? 'manager already current' : 'patched non-blocking channel selection'}`);

const builderPath = 'src/commands/Tools/embedbuilder.js';
const builderBefore = fs.readFileSync(builderPath, 'utf8');
let builderText = builderBefore;

// The Save button is already acknowledged with deferUpdate before this function
// runs. A second ephemeral "Saving changes…" message can outlive a failed edit
// of that follow-up and leave Discord visibly stuck on loading even though the
// real embed was saved. Only show a terminal success/error message after Save.
if (builderText.includes("        content: 'Saving changes…',")) {
    const saveStartMarker = 'async function saveExistingEmbed(buttonInteraction, guild, state) {';
    const saveEndMarker = '\n\nfunction buildSingleEmbed(state, description = null, options = {}) {';
    const saveStart = builderText.indexOf(saveStartMarker);
    const saveEnd = saveStart === -1 ? -1 : builderText.indexOf(saveEndMarker, saveStart);

    if (saveStart === -1 || saveEnd === -1) {
        throw new Error('Embed Builder Save function was not found.');
    }

    const saveBlock = `async function saveExistingEmbed(buttonInteraction, guild, state) {
    const saved = await saveModifiedEmbed(guild, state);

    if (!saved.ok) {
        const failure = await buttonInteraction.followUp({
            content: null,
            embeds: [new EmbedBuilder()
                .setTitle('Could not save changes')
                .setDescription('The existing embed could not be updated. It may have been deleted or Cloudy may no longer have access.')
                .setColor(getColor('error'))],
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (failure) removeTransientMessage(buttonInteraction, failure);
        else {
            await replyUserError(buttonInteraction, {
                type: ErrorTypes.UNKNOWN,
                message: 'The existing embed could not be updated. It may have been deleted or Cloudy may no longer have access.',
            });
        }
        return saved;
    }

    void refreshBuilder(buttonInteraction, state).catch(() => {});
    const confirmation = await buttonInteraction.followUp({
        content: null,
        embeds: [successEmbed('Changes saved', \`The existing embed in \${saved.channel} was updated.\`)],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
    }).catch(() => null);
    if (confirmation) removeTransientMessage(buttonInteraction, confirmation);
    return saved;
}`;

    builderText = builderText.slice(0, saveStart) + saveBlock + builderText.slice(saveEnd);
}

if (builderText !== builderBefore) fs.writeFileSync(builderPath, builderText);
console.log(`[EMBED_BUILDER_ROUTING_LOADING] ${builderText === builderBefore ? 'save feedback already current' : 'patched terminal-only save feedback'}`);