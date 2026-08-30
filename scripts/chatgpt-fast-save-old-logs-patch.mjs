import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/embedManagerService.js';
let source = readFileSync(file, 'utf8');

if (source.includes('function queueMatchingTemplatePeerUpdate(')) {
  process.stdout.write('Fast-save background peer update patch already applied.\n');
  process.exit(0);
}

const helperMarker = '\nexport async function saveModifiedEmbed(guild, state) {';
if (!source.includes(helperMarker)) {
  throw new Error('Could not find saveModifiedEmbed insertion point.');
}

const helpers = `
const templatePeerUpdateJobs = new Map();

function snapshotTemplatePeerState(state, target, sourceData) {
    return {
        title: state.title,
        message: state.message,
        sideColor: state.sideColor,
        bottomLine: state.bottomLine,
        modifyTarget: {
            ...target,
            sourceEmbedData: sourceData,
        },
    };
}

async function updateMatchingTemplatePeers(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
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
}

function queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
    const key = \`${'${guild.id}:${targetSnapshot.channelId}:${targetSnapshot.templateTitle || \'\'}'}\`;
    const previous = templatePeerUpdateJobs.get(key) || Promise.resolve();
    const job = previous
        .catch(() => {})
        .then(() => updateMatchingTemplatePeers(guild, stateSnapshot, targetSnapshot, current, mediaChanges));
    templatePeerUpdateJobs.set(key, job);

    void job
        .then(updatedCount => logger.debug(\`Updated ${'${updatedCount}'} matching historical log embed(s) in background.\`))
        .catch(error => logger.error('Failed to update matching historical log embeds in background:', error))
        .finally(() => {
            if (templatePeerUpdateJobs.get(key) === job) templatePeerUpdateJobs.delete(key);
        });
}
`;

source = source.replace(helperMarker, `${helpers}${helperMarker}`);

const templateBlock = /    if \(target\.templateMode\) \{[\s\S]*?\n    \}\n\n    state\.modifyTarget\.sourceEmbedData = current;/;
const match = source.match(templateBlock);
if (!match) {
  throw new Error('Could not find template peer update block.');
}

const replacement = `    if (target.templateMode) {
        const sourceRule = getTemplateRule(target.channelId, sourceData.title || target.templateTitle);
        const aliases = [sourceData.title, current.title, sourceRule?.label].filter(Boolean);

        await saveEmbedTemplateDecoration(
            guild.id,
            target.channelId,
            aliases,
            current,
            {
                applyThumbnail: mediaChanges.thumbnailChanged,
                applyImage: mediaChanges.imageChanged,
            },
        );

        const targetSnapshot = {
            ...target,
            sourceEmbedData: sourceData,
            templateTitle: target.templateTitle,
        };
        const stateSnapshot = snapshotTemplatePeerState(state, targetSnapshot, sourceData);
        queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges);
    }

    state.modifyTarget.sourceEmbedData = current;`;

source = source.replace(templateBlock, replacement);
writeFileSync(file, source);
process.stdout.write('Moved historical log refresh off the Save critical path while keeping template persistence blocking.\n');
