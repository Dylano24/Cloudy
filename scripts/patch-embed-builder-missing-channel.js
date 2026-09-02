import fs from 'node:fs';

const path = 'src/services/embedManagerService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

if (!text.includes("from './embedMissingChannelService.js'")) {
  text = text.replace(
    "import { saveEmbedTemplateDecoration } from './embedTemplateService.js';",
    "import { saveEmbedTemplateDecoration } from './embedTemplateService.js';\nimport { discoverMissingChannelEmbed } from './embedMissingChannelService.js';",
  );
}

if (text.includes("import { discoverMissingChannelEmbed } from './embedMissingChannelService.js';")) {
  text = text.replace(
    "import { discoverMissingChannelEmbed } from './embedMissingChannelService.js';",
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
  );
}

if (!text.includes('discardPendingEmbedEditorUpdates')) {
  text = text.replace(
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';\nimport { discardPendingEmbedEditorUpdates } from './embedColorPickerSessionService.js';",
  );
}

const oldBlock = `                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
                    const channelRecords = records.filter(record => String(record.channelId) === String(channelId));
                    const firstRecord = collapseDisplayRecords(channelRecords, channelId)[0] || null;
                    if (firstRecord && loadRecordSnapshotIntoState(state, guild, firstRecord)) {
                        void Promise.resolve(refreshBuilder()).catch(error => {
                            logger.debug(\`Immediate channel preview refresh skipped: \${error?.message || error}\`);
                        });
                    }
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }`;

const newBlock = `                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
                    const channelRecords = records.filter(record => String(record.channelId) === String(channelId));
                    const realChannelRecords = channelRecords.filter(record =>
                        String(record.source || '') !== 'system-catalog'
                        && String(record.backingChannelId || record.channelId || '') === String(channelId)
                    );
                    let firstRecord = collapseDisplayRecords(
                        realChannelRecords.length ? realChannelRecords : channelRecords,
                        channelId,
                    )[0] || null;

                    if (realChannelRecords.length && firstRecord && loadRecordSnapshotIntoState(state, guild, firstRecord)) {
                        if (selectionVersion !== session.selectionVersion) return;
                        void Promise.resolve(refreshBuilder()).catch(error => {
                            logger.debug(\`Immediate channel preview refresh skipped: \${error?.message || error}\`);
                        });
                    } else {
                        const discovered = await discoverMissingChannelEmbed(
                            guild,
                            channelId,
                            buttonInteraction.client.user.id,
                        ).catch(error => {
                            logger.debug(\`On-demand channel embed discovery skipped: \${error?.message || error}\`);
                            return null;
                        });

                        if (selectionVersion !== session.selectionVersion) return;

                        if (discovered) {
                            loadEmbedIntoState(state, discovered);
                            firstRecord = discovered.record;
                            records = [
                                ...records.filter(record => !(
                                    String(record.channelId) === String(channelId)
                                    && String(record.source || '') === 'embed-builder'
                                    && String(record.messageId) !== String(discovered.record.messageId)
                                )),
                                discovered.record,
                            ];
                            void Promise.resolve(refreshBuilder()).catch(error => {
                                logger.debug(\`Discovered channel preview refresh skipped: \${error?.message || error}\`);
                            });
                        } else if (firstRecord && loadRecordSnapshotIntoState(state, guild, firstRecord)) {
                            void Promise.resolve(refreshBuilder()).catch(error => {
                                logger.debug(\`Catalog fallback preview refresh skipped: \${error?.message || error}\`);
                            });
                        }
                    }

                    if (selectionVersion !== session.selectionVersion) return;
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }`;

if (!text.includes('A slower older channel lookup must never overwrite')) {
  if (!text.includes(oldBlock)) {
    throw new Error('Expected instant channel selection block was not found.');
  }
  text = text.replace(oldBlock, newBlock);
}

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

// Generic system-catalog hashes and a real channel message can represent the
// same visible embed. Group those by the visible title; only curated game keys
// need their stable game:* identity to stay distinct.
text = text.replace(
  '    if (stableKey) return stableKey;',
  "    if (stableKey && stableKey.startsWith('game:')) return stableKey;",
);

// Selecting a channel must only open its embed list. Do not enqueue a preview
// edit for the first item: that older edit is exactly what made the next embed
// click wait behind stale Discord traffic. Discover every persistent embed in
// the selected channel first, merge them into the local registry view, then let
// the user's explicit embed click be the only action that changes live preview.
const channelStartMarker = "                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {";
const channelEndMarker = "                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {";
const channelStart = text.indexOf(channelStartMarker);
const channelEnd = channelStart === -1 ? -1 : text.indexOf(channelEndMarker, channelStart);
if (channelStart !== -1 && channelEnd !== -1) {
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
                        const discoveredKeys = new Set(discoveredRecords.map(record =>
                            \`${'${'}String(record.backingChannelId || record.channelId)}:${'${'}String(record.messageId)}:${'${'}Number(record.embedIndex || 0)}\`,
                        ));
                        records = [
                            ...records.filter(record => !discoveredKeys.has(
                                \`${'${'}String(record.backingChannelId || record.channelId)}:${'${'}String(record.messageId)}:${'${'}Number(record.embedIndex || 0)}\`,
                            )),
                            ...discoveredRecords,
                        ];
                    }

                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }

`;
  text = text.slice(0, channelStart) + channelBlock + text.slice(channelEnd);
}

if (text !== before) fs.writeFileSync(path, text);
console.log(`[EMBED_BUILDER_MISSING] ${text === before ? 'already current' : 'patched instant canonical selection'}`);
