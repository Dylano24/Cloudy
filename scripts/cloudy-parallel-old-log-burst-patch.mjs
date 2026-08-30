import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/embedManagerService.js';
const source = readFileSync(file, 'utf8');

const oldBlock = `async function updateMatchingTemplatePeers(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
    const records = await getEmbedRegistry(guild.id);
    const peers = records.filter(record =>
        String(record.channelId) === String(targetSnapshot.channelId) &&
        !(String(record.messageId) === String(targetSnapshot.messageId) && Number(record.embedIndex || 0) === Number(targetSnapshot.embedIndex || 0)),
    );

    const results = await Promise.all(peers.map(async record => {
        const resolved = await resolveEmbedRegistryRecord(guild, record).catch(() => null);
        if (!resolved) return false;

        const peerData = resolved.embed.toJSON();
        const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData.title || recordName(record));
        if (peerIdentity !== targetSnapshot.templateTitle) return false;

        const peerIndex = Number(record.embedIndex || 0);
        const peerEmbeds = resolved.message.embeds.map((embed, embedIndex) =>
            embedIndex === peerIndex
                ? new EmbedBuilder(applyStateToTemplatePeer(stateSnapshot, peerData, current, mediaChanges))
                : new EmbedBuilder(embed.toJSON()),
        );

        const peerEdited = await resolved.message.edit({ embeds: peerEmbeds }).catch(error => {
            logger.error('Failed to update matching log template embed:', error);
            return null;
        });
        if (!peerEdited) return false;

        void registerCloudyEmbedMessage(peerEdited, 'modified-template')
            .catch(error => logger.error('Failed to refresh modified template registry:', error));
        return true;
    }));

    return results.filter(Boolean).length;
}`;

const newBlock = `async function updateMatchingTemplatePeers(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
    const records = await getEmbedRegistry(guild.id);
    const peers = records.filter(record =>
        String(record.channelId) === String(targetSnapshot.channelId) &&
        !(String(record.messageId) === String(targetSnapshot.messageId) && Number(record.embedIndex || 0) === Number(targetSnapshot.embedIndex || 0)) &&
        templateIdentity(targetSnapshot.channelId, recordName(record)) === targetSnapshot.templateTitle,
    );

    // Resolve every matching historical log first, in parallel. This prevents
    // network fetch timing from staggering the actual Discord edit requests.
    const resolvedPeers = await Promise.all(peers.map(record =>
        resolveEmbedRegistryRecord(guild, record).catch(() => null),
    ));

    const edits = [];
    for (const resolved of resolvedPeers) {
        if (!resolved) continue;

        const { record } = resolved;
        const peerData = resolved.embed.toJSON();
        const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData.title || recordName(record));
        if (peerIdentity !== targetSnapshot.templateTitle) continue;

        const peerIndex = Number(record.embedIndex || 0);
        const peerEmbeds = resolved.message.embeds.map((embed, embedIndex) =>
            embedIndex === peerIndex
                ? new EmbedBuilder(applyStateToTemplatePeer(stateSnapshot, peerData, current, mediaChanges))
                : new EmbedBuilder(embed.toJSON()),
        );
        edits.push({ resolved, peerEmbeds });
    }

    // Start all matching message edits together. Discord may still apply its own
    // per-route rate limits, but Cloudy adds no per-embed delay or sequencing here.
    const results = await Promise.all(edits.map(async ({ resolved, peerEmbeds }) => {
        const peerEdited = await resolved.message.edit({ embeds: peerEmbeds }).catch(error => {
            logger.error('Failed to update matching log template embed:', error);
            return null;
        });
        if (!peerEdited) return false;

        void registerCloudyEmbedMessage(peerEdited, 'modified-template')
            .catch(error => logger.error('Failed to refresh modified template registry:', error));
        return true;
    }));

    return results.filter(Boolean).length;
}`;

if (!source.includes(oldBlock)) throw new Error('Expected updateMatchingTemplatePeers block not found');
const next = source.replace(oldBlock, newBlock);
writeFileSync(file, next);
console.log('Old log edits now resolve first and start in one parallel burst.');
