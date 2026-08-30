import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/services/embedManagerService.js';
let source = readFileSync(path, 'utf8');

const badFilter = `    const peers = records.filter(record =>\n        String(record.channelId) === String(targetSnapshot.channelId) &&\n        !(String(record.messageId) === String(targetSnapshot.messageId) && Number(record.embedIndex || 0) === Number(targetSnapshot.embedIndex || 0)) &&\n        templateIdentity(targetSnapshot.channelId, recordName(record)) === targetSnapshot.templateTitle,\n    );`;
const goodFilter = `    const peers = records.filter(record =>\n        String(record.channelId) === String(targetSnapshot.channelId) &&\n        !(String(record.messageId) === String(targetSnapshot.messageId) && Number(record.embedIndex || 0) === Number(targetSnapshot.embedIndex || 0)),\n    );`;
if (!source.includes(badFilter)) throw new Error('Expected restrictive peer filter not found');
source = source.replace(badFilter, goodFilter);

const oldQueue = `function queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {\n    const key = \`${'${guild.id}:${targetSnapshot.channelId}:${targetSnapshot.templateTitle || \'\'}'}\`;\n    const previous = templatePeerUpdateJobs.get(key) || Promise.resolve();\n    const job = previous\n        .catch(() => {})\n        .then(() => updateMatchingTemplatePeers(guild, stateSnapshot, targetSnapshot, current, mediaChanges));\n    templatePeerUpdateJobs.set(key, job);\n\n    void job\n        .then(updatedCount => logger.debug(\`Updated ${'${updatedCount}'} matching historical log embed(s) in background.\`))\n        .catch(error => logger.error('Failed to update matching historical log embeds in background:', error))\n        .finally(() => {\n            if (templatePeerUpdateJobs.get(key) === job) templatePeerUpdateJobs.delete(key);\n        });\n}`;

const newQueue = `function queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {\n    const key = \`${'${guild.id}:${targetSnapshot.channelId}:${targetSnapshot.templateTitle || \'\'}'}\`;\n    const request = { guild, stateSnapshot, targetSnapshot, current, mediaChanges };\n    const existing = templatePeerUpdateJobs.get(key);\n\n    if (existing) {\n        existing.pending = request;\n        return;\n    }\n\n    const entry = { pending: request };\n    templatePeerUpdateJobs.set(key, entry);\n\n    const run = async () => {\n        while (entry.pending) {\n            const next = entry.pending;\n            entry.pending = null;\n\n            try {\n                const updatedCount = await updateMatchingTemplatePeers(\n                    next.guild,\n                    next.stateSnapshot,\n                    next.targetSnapshot,\n                    next.current,\n                    next.mediaChanges,\n                );\n                logger.debug(\`Updated ${'${updatedCount}'} matching historical log embed(s) in background.\`);\n            } catch (error) {\n                logger.error('Failed to update matching historical log embeds in background:', error);\n            }\n        }\n    };\n\n    void run().finally(() => {\n        if (templatePeerUpdateJobs.get(key) === entry) templatePeerUpdateJobs.delete(key);\n    });\n}`;

if (!source.includes(oldQueue)) throw new Error('Expected historical log queue block not found');
source = source.replace(oldQueue, newQueue);

writeFileSync(path, source);
console.log('Restored all valid log matches and coalesced repeated saves.');
