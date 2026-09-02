import fs from 'node:fs';

const path = 'src/services/embedManagerService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

// Keep the runtime patch narrow: only the Embed Manager discovery/selection
// path is changed. Save, templates, games and logo handling stay untouched.
if (text.includes("import { discoverMissingChannelEmbed } from './embedMissingChannelService.js';")) {
  text = text.replace(
    "import { discoverMissingChannelEmbed } from './embedMissingChannelService.js';",
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
  );
} else if (!text.includes('discoverMissingChannelEmbeds')) {
  text = text.replace(
    "import { saveEmbedTemplateDecoration } from './embedTemplateService.js';",
    "import { saveEmbedTemplateDecoration } from './embedTemplateService.js';\nimport { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
  );
}

if (!text.includes('discardPendingEmbedEditorUpdates')) {
  text = text.replace(
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';\nimport { discardPendingEmbedEditorUpdates } from './embedColorPickerSessionService.js';",
  );
}

// Preserve latest-wins interaction handling. Never serialize rapid selections
// behind an older Discord/API request.
if (text.includes('session.queue = session.queue.then(async () => {')) {
  text = text.replace(
`            session.queue = session.queue.then(async () => {
                if (session.closed || state.activeEmbedManager !== session) return;`,
`            const selectionVersion = (session.selectionVersion || 0) + 1;
            session.selectionVersion = selectionVersion;
            discardPendingEmbedEditorUpdates(state.colorSessionToken);

            void (async () => {
                if (session.closed || state.activeEmbedManager !== session) return;
                if (selectionVersion !== session.selectionVersion) return;`);

  text = text.replace(
`            }).catch(error => {
                logger.error('Embed manager selection failed:', error);
            });

            await session.queue;`,
`            })().catch(error => {
                logger.error('Embed manager selection failed:', error);
            });`);
}

// Selecting a channel only discovers/populates its complete embed list. It must
// not push an arbitrary first embed into the live preview, because that creates
// stale preview edits when the user immediately chooses another embed.
const channelStartMarker = "                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {";
const channelEndMarker = "                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {";
const channelStart = text.indexOf(channelStartMarker);
const channelEnd = channelStart === -1 ? -1 : text.indexOf(channelEndMarker, channelStart);

if (channelStart === -1 || channelEnd === -1) {
  throw new Error('Embed Manager channel-selection block was not found.');
}

const channelBlock = `                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
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

                        // Replace stale real-message records for this channel with
                        // the freshly discovered set. collapseDisplayRecords then
                        // guarantees one visible entry per canonical embed type.
                        records = [
                            ...otherChannelRecords,
                            ...existingCatalogRecords.filter(record => !otherChannelRecords.includes(record)),
                            ...discoveredRecords,
                        ];
                    }

                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }

`;

text = text.slice(0, channelStart) + channelBlock + text.slice(channelEnd);

// Any async record resolve belongs only to the selection that started it.
text = text.replace(
`                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (!resolved) {`,
`                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (selectionVersion !== session.selectionVersion) return;
                    if (!resolved) {`);

text = text.replaceAll(
`                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(`,
`                    records = await getEmbedRegistry(guild.id);
                    if (selectionVersion !== session.selectionVersion) return;
                    await updateEmbedManager(`);

if (text !== before) fs.writeFileSync(path, text);
console.log(`[EMBED_BUILDER_MISSING] ${text === before ? 'already current' : 'patched complete discovery + explicit latest-wins preview'}`);
