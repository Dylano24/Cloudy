import fs from 'node:fs';

// Final interaction-path hardening for the Embed Builder.
// Rules:
// 1. Channel/embed switching never waits for Discord history, DB refreshes, or message resolution.
// 2. Every option rendered from a real Discord channel must already have a usable preview snapshot.
// 3. Snapshot data is persisted with registry rows so previews survive restarts.
// 4. Repeated messages of one template remain one visible Builder entry.

const registryPath = 'src/services/embedRegistryService.js';
const registryBefore = fs.readFileSync(registryPath, 'utf8');
let registryText = registryBefore;

registryText = registryText.replace(
`    embedSnapshotCache.delete(key);
    embedSnapshotCache.set(key, data);`,
`    // Keep the snapshot on the registry row as well as in memory. This makes
    // Builder previews restart-safe and removes the need to re-fetch Discord
    // messages before an embed can be opened.
    record.snapshot = data;
    embedSnapshotCache.delete(key);
    embedSnapshotCache.set(key, data);`,
);

registryText = registryText.replace(
`export function getEmbedRegistrySnapshot(record) {
    if (!record) return null;
    return embedSnapshotCache.get(recordKey(record)) || null;
}`,
`export function getEmbedRegistrySnapshot(record) {
    if (!record) return null;
    return embedSnapshotCache.get(recordKey(record))
        || (record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : null)
        || null;
}`,
);

registryText = registryText.replace(
`        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),`,
`        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshot: record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : null,`,
);

if (!registryText.includes("snapshot: record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : null")) {
    throw new Error('Could not enable persistent Embed Builder snapshots.');
}
if (registryText !== registryBefore) fs.writeFileSync(registryPath, registryText);
console.log(`[EMBED_BUILDER_ZERO_WAIT] ${registryText === registryBefore ? 'registry already current' : 'persisted preview snapshots'}`);

const discoveryPath = 'src/services/embedMissingChannelService.js';
const discoveryBefore = fs.readFileSync(discoveryPath, 'utf8');
let discoveryText = discoveryBefore;

if (!discoveryText.includes('export function discoverCachedChannelEmbeds')) {
    const marker = 'export async function discoverRecentChannelEmbeds(guild, channelId, botUserId) {';
    const helper = `export function discoverCachedChannelEmbeds(guild, channelId, botUserId) {
    if (!guild || !channelId || !botUserId) return [];
    const channel = guild.channels.cache.get(String(channelId)) || null;
    if (!channel?.messages?.cache) return [];

    const messages = [...channel.messages.cache.values()]
        .filter(message => isUsableMessage(message, botUserId))
        .sort((a, b) =>
            candidatePriority(b) - candidatePriority(a)
            || Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0),
        );

    return messages.flatMap(message => buildRecords(guild, channel, message));
}

`;
    if (!discoveryText.includes(marker)) throw new Error('Cached discovery insertion point was not found.');
    discoveryText = discoveryText.replace(marker, helper + marker);
}

if (discoveryText !== discoveryBefore) fs.writeFileSync(discoveryPath, discoveryText);
console.log(`[EMBED_BUILDER_ZERO_WAIT] ${discoveryText === discoveryBefore ? 'cached discovery already current' : 'added zero-network cached discovery'}`);

const managerPath = 'src/services/embedManagerService.js';
const managerBefore = fs.readFileSync(managerPath, 'utf8');
let managerText = managerBefore;

// Normalize whichever import shape the older compatibility patches left behind.
managerText = managerText.replace(
    /import \{[^\n]*discoverMissingChannelEmbed[^\n]*\} from '\.\/embedMissingChannelService\.js';/,
    "import { discoverCachedChannelEmbeds } from './embedMissingChannelService.js';",
);

if (!managerText.includes('function hasRenderableBuilderSnapshot(record)')) {
    const marker = 'function collapseDisplayRecords(channelRecords, channelId = null) {';
    const helper = `function hasRenderableBuilderSnapshot(record) {
    const snapshot = record?.snapshot || getEmbedRegistrySnapshot(record);
    return Boolean(snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length);
}

`;
    if (!managerText.includes(marker)) throw new Error('Display helper insertion point was not found.');
    managerText = managerText.replace(marker, helper + marker);
}

// Older patch versions filtered inside collapseDisplayRecords(). Keep that
// function pure so offline/unit callers can still inspect registry grouping.
// The actual Discord interaction path below enforces the renderable-only rule.
managerText = managerText.replace(
`    for (const record of channelRecords) {
        if (!hasRenderableBuilderSnapshot(record)) continue;
        const rawName = recordName(record);`,
`    for (const record of channelRecords) {
        const rawName = recordName(record);`,
);

const channelStartMarker = "                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {";
const channelEndMarker = "                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {";
const channelStart = managerText.indexOf(channelStartMarker);
const channelEnd = channelStart === -1 ? -1 : managerText.indexOf(channelEndMarker, channelStart);
if (channelStart === -1 || channelEnd === -1) throw new Error('Channel selection block was not found.');

const channelBlock = `                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
                    const selectedChannel = guild.channels.cache.get(String(channelId)) || null;

                    // Zero-wait switching: only inspect objects Discord.js already
                    // has in memory. No history fetch, registry reconcile or message
                    // resolve is allowed on this interaction path.
                    const cachedRecords = discoverCachedChannelEmbeds(
                        guild,
                        channelId,
                        buttonInteraction.client.user.id,
                    );

                    // Real discord.js text channels always expose messages.cache.
                    // For those channels, remove stale registry rows before the
                    // menu is rendered. Therefore every visible option has a full
                    // snapshot and can paint the preview synchronously.
                    if (selectedChannel?.messages?.cache) {
                        const outsideSelectedChannel = records.filter(record =>
                            String(record.channelId) !== String(channelId)
                        );
                        const selectedCandidates = [
                            ...records.filter(record => String(record.channelId) === String(channelId)),
                            ...cachedRecords,
                        ];
                        const renderableSelected = selectedCandidates.filter(hasRenderableBuilderSnapshot);
                        records = [...outsideSelectedChannel, ...renderableSelected];
                    }

                    if (selectionVersion !== session.selectionVersion) return;
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }

`;
managerText = managerText.slice(0, channelStart) + channelBlock + managerText.slice(channelEnd);

// Embed clicks are snapshot-only. If a stale component somehow points at a
// record without a snapshot, remove it immediately rather than blocking on a
// Discord fetch and leaving the preview hanging.
const selectStartMarker = '                let record = records.find(item =>';
const selectEndMarker = '\n            })().catch(error => {';
const selectStart = managerText.indexOf(selectStartMarker, managerText.indexOf(channelEndMarker));
const selectEnd = selectStart === -1 ? -1 : managerText.indexOf(selectEndMarker, selectStart);
if (selectStart === -1 || selectEnd === -1) throw new Error('Embed selection resolve block was not found.');

const selectBlock = `                const record = records.find(item =>
                    String(item.channelId) === String(channelId) &&
                    String(item.messageId) === String(messageId) &&
                    Number(item.embedIndex || 0) === embedIndex,
                );

                if (!record || !loadRecordSnapshotIntoState(state, guild, record)) {
                    records = records.filter(item => !(
                        String(item.channelId) === String(channelId)
                        && String(item.messageId) === String(messageId)
                        && Number(item.embedIndex || 0) === embedIndex
                    ));
                    if (selectionVersion !== session.selectionVersion) return;
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
                    return;
                }

                if (selectionVersion !== session.selectionVersion) return;
                void Promise.resolve(refreshBuilder()).catch(error => {
                    logger.debug(\`Immediate embed preview refresh skipped: \${error?.message || error}\`);
                });
                await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);`;

managerText = managerText.slice(0, selectStart) + selectBlock + managerText.slice(selectEnd);

const patchedChannelSection = managerText.slice(
    managerText.indexOf(channelStartMarker),
    managerText.indexOf(channelEndMarker, managerText.indexOf(channelStartMarker)),
);
if (/discover(?:Missing|Recent)ChannelEmbeds|messages\.fetch|resolveEmbedRegistryRecord|getEmbedRegistry\(/.test(patchedChannelSection)) {
    throw new Error('A blocking/network operation remains in the channel-switch path.');
}
if (!patchedChannelSection.includes('selectedCandidates.filter(hasRenderableBuilderSnapshot)')) {
    throw new Error('Renderable-only channel filtering was not installed.');
}

if (managerText !== managerBefore) fs.writeFileSync(managerPath, managerText);
console.log(`[EMBED_BUILDER_ZERO_WAIT] ${managerText === managerBefore ? 'manager already current' : 'patched snapshot-only channel/embed switching'}`);
