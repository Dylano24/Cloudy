import fs from 'node:fs';

function edit(path, before, after) {
  let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  if (!text.includes(before)) throw new Error('Builder audit anchor missing: ' + path + ' ' + before.slice(0, 60));
  text = text.replace(before, after);
  fs.writeFileSync(path, text);
}

const manager = 'src/services/embedManagerService.js';
const modeBefore = "templateMode: Boolean(templateRule) || record.source !== 'embed-builder',";
const modeAfter = "templateMode: Boolean(record.templateMode) || Boolean(templateRule) || record.source !== 'embed-builder',";
edit(manager, modeBefore, modeAfter);
edit(manager, modeBefore, modeAfter);
edit(manager, '        const master = bestBuilderSourceRecord(catalogs, peers.at(-1));', String.raw`        const live = peers.filter(record => record.source !== 'system-catalog' && !record.detached)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
                || String(b.messageId).length - String(a.messageId).length
                || String(b.messageId).localeCompare(String(a.messageId)));
        const master = perChannel && live.length ? live[0] : bestBuilderSourceRecord(catalogs, live[0] || peers.at(-1));`);
edit(manager, '                    const discoveredRecords = await discoverRecentChannelEmbeds(guild, channelId, buttonInteraction.client.user.id)', String.raw`                    // Paint indexed embeds immediately; refresh only the selected channel.
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    const discoveredRecords = await discoverRecentChannelEmbeds(guild, channelId, buttonInteraction.client.user.id)`);
edit(manager, '                    records = await getCanonicalBuilderRecords(guild, mergeEmbedManagerRecords(registeredRecords, discoveredRecords), { perChannel: true });', String.raw`                    const nextRecords = await getCanonicalBuilderRecords(guild, mergeEmbedManagerRecords(registeredRecords, discoveredRecords), { perChannel: true });
                    if (selectionVersion !== session.selectionVersion) return;
                    records = nextRecords;`);
edit(manager, 'export async function saveModifiedEmbed(guild, state) {', String.raw`export async function saveModifiedEmbed(guild, state) {
    const { flushPendingEmbedEditorUpdates } = await import('./embedColorPickerSessionService.js');
    await flushPendingEmbedEditorUpdates(state.colorSessionToken);`);
edit(manager, '    if (state.message) data.description = mergeTemplateDescription(source.description, state.message, peerData.description);', String.raw`    const staticPanel = !/(?:\blog$|^ticket\b|^report\b|^(?:success|failed|error|warning|information|invalid|expired)$)/i.test(String(source.title || ''))
        && !/\{dynamic\}|<[@#]|<t:/i.test(String(source.description || ''));
    if (state.message) data.description = staticPanel ? normalizeManualIndent(state.message).slice(0, 4096) : mergeTemplateDescription(source.description, state.message, peerData.description);`);
edit(manager, '    data.color = state.sideColor;\n\n    if (mediaChanges.thumbnailChanged)', String.raw`    if (Array.isArray(state.embedFields)) {
        data.fields = state.embedFields.map((field, index) => ({
            name: mergeDynamicTemplateText(source.fields?.[index]?.name, field.name, peerData.fields?.[index]?.name).slice(0, 256),
            value: normalizeManualIndent(mergeDynamicTemplateText(source.fields?.[index]?.value, field.value, peerData.fields?.[index]?.value)).slice(0, 1024),
            inline: Boolean(field.inline),
        }));
        if (!data.fields.length) delete data.fields;
    }
    data.color = state.sideColor;

    if (mediaChanges.thumbnailChanged)`);
edit(manager, '        message: state.message,\n        sideColor: state.sideColor,', '        message: state.message,\n        embedFields: Array.isArray(state.embedFields) ? state.embedFields.map(field => ({ ...field })) : undefined,\n        sideColor: state.sideColor,');

const editor = 'src/services/embedColorPickerSessionService.js';
const text = fs.readFileSync(editor, 'utf8').replaceAll('\r\n', '\n');
const start = text.indexOf('function scheduleEditorFlush(token, session) {');
const end = text.indexOf('\nfunction queueEditorUpdate(', start);
if (start < 0 || end < 0) throw new Error('Builder editor flush anchor missing');
fs.writeFileSync(editor, text.slice(0, start) + String.raw`export async function flushPendingEmbedEditorUpdates(token) {
    const session = sessions.get(token);
    if (!session || typeof session.onEditorUpdate !== 'function') return;
    if (session.editFlushTimer) clearTimeout(session.editFlushTimer);
    session.editFlushTimer = null;
    const generation = session.editGeneration;
    const previous = session.editorDrain || Promise.resolve();
    const job = previous.then(async () => {
        session.editFlushRunning = true;
        try {
            while (session.pendingEditorUpdates.size && generation === session.editGeneration && sessions.get(token) === session) {
                const pending = [...session.pendingEditorUpdates.entries()];
                session.pendingEditorUpdates.clear();
                for (const [field, value] of pending) {
                    if (generation !== session.editGeneration) break;
                    await session.onEditorUpdate(field, value);
                }
            }
        } finally { session.editFlushRunning = false; }
    });
    session.editorDrain = job;
    try { await job; }
    finally { if (session.editorDrain === job) session.editorDrain = null; }
}

function scheduleEditorFlush(token, session) {
    if (session.editFlushRunning) return;
    if (session.editFlushTimer) clearTimeout(session.editFlushTimer);
    session.editFlushTimer = setTimeout(() => {
        void flushPendingEmbedEditorUpdates(token).catch(error => {
            if (error?.code !== 'EMBED_BUILDER_EXPIRED') console.error('Builder editor update failed:', error.message);
        });
    }, EDIT_FLUSH_DELAY_MS);
    session.editFlushTimer.unref?.();
}
` + text.slice(end));

