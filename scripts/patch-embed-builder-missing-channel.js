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
                        // If this channel only has a virtual system-catalog entry,
                        // fetch the real panel from the selected channel instead of
                        // showing a {dynamic} placeholder in the preview.
                        const discovered = await discoverMissingChannelEmbed(
                            guild,
                            channelId,
                            buttonInteraction.client.user.id,
                        ).catch(error => {
                            logger.debug(\`On-demand channel embed discovery skipped: \${error?.message || error}\`);
                            return null;
                        });

                        // A slower older channel lookup must never overwrite the
                        // newest selection in the live preview.
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

// Do not serialize every click behind one slow ticket/log request. Each click is
// handled immediately; the newest selection version is authoritative.
if (text.includes('session.queue = session.queue.then(async () => {')) {
  text = text.replace(
`            session.queue = session.queue.then(async () => {
                if (session.closed || state.activeEmbedManager !== session) return;`,
`            const selectionVersion = (session.selectionVersion || 0) + 1;
            session.selectionVersion = selectionVersion;

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

// A fallback message fetch can finish after the user has already selected a
// different embed. Drop that stale result before it touches the preview state.
text = text.replace(
`                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (!resolved) {`,
`                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (selectionVersion !== session.selectionVersion) return;
                    if (!resolved) {`);

// Any remaining registry refresh is allowed to finish in the background, but it
// may only render if it still belongs to the newest interaction.
text = text.replaceAll(
`                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(`,
`                    records = await getEmbedRegistry(guild.id);
                    if (selectionVersion !== session.selectionVersion) return;
                    await updateEmbedManager(`);

if (text !== before) fs.writeFileSync(path, text);
console.log(`[EMBED_BUILDER_MISSING] ${text === before ? 'already current' : 'patched latest-wins'}`);
