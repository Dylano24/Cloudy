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
                    let firstRecord = collapseDisplayRecords(channelRecords, channelId)[0] || null;

                    if (firstRecord && loadRecordSnapshotIntoState(state, guild, firstRecord)) {
                        void Promise.resolve(refreshBuilder()).catch(error => {
                            logger.debug(\`Immediate channel preview refresh skipped: \${error?.message || error}\`);
                        });
                    } else if (!firstRecord) {
                        // Only the selected empty channel is checked. This is one
                        // bounded Discord request, never a guild-wide history scan.
                        const discovered = await discoverMissingChannelEmbed(
                            guild,
                            channelId,
                            buttonInteraction.client.user.id,
                        ).catch(error => {
                            logger.debug(\`On-demand channel embed discovery skipped: \${error?.message || error}\`);
                            return null;
                        });

                        if (discovered) {
                            loadEmbedIntoState(state, discovered);
                            firstRecord = discovered.record;
                            records = [
                                ...records.filter(record => !(
                                    String(record.channelId) === String(channelId)
                                    && String(record.source || '') === 'embed-builder'
                                )),
                                discovered.record,
                            ];
                            void Promise.resolve(refreshBuilder()).catch(error => {
                                logger.debug(\`Discovered channel preview refresh skipped: \${error?.message || error}\`);
                            });
                        }
                    }

                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }`;

if (!text.includes('On-demand channel embed discovery skipped')) {
  if (!text.includes(oldBlock)) {
    throw new Error('Expected instant channel selection block was not found.');
  }
  text = text.replace(oldBlock, newBlock);
}

if (text !== before) fs.writeFileSync(path, text);
console.log(`[EMBED_BUILDER_MISSING] ${text === before ? 'already current' : 'patched'}`);
