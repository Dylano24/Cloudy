import fs from 'node:fs';

// This patch runs after the existing Embed Builder patches. It only corrects
// catalog placement and channel-selection loading; game/save/logo behavior is
// intentionally left untouched.

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
