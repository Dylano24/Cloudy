import fs from 'node:fs';

function edit(path, before, after) {
  const source = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    console.log(`[BUILDER_SAVE_SESSION] legacy anchor already evolved in ${path}; keeping current implementation`);
    return;
  }
  fs.writeFileSync(path, source.replace(before, after));
}

const builder = 'src/commands/Tools/embedbuilder.js';
edit(builder, 'async function saveExistingEmbed(buttonInteraction, guild, state) {', `export async function saveExistingEmbed(buttonInteraction, guild, state) {
    // Claim before awaiting acknowledgement: collectors can deliver a second click.
    const alreadySaving = Boolean(state.saveInFlight);
    if (!alreadySaving) state.saveInFlight = true;
    try {
        if (!buttonInteraction.deferred && !buttonInteraction.replied) {
            await buttonInteraction.deferUpdate();
        }
        if (alreadySaving) return { ok: false, reason: 'save-in-progress' };
        return await finishExistingEmbedSave(buttonInteraction, guild, state);
    } finally {
        if (!alreadySaving) state.saveInFlight = false;
    }
}

async function finishExistingEmbedSave(buttonInteraction, guild, state) {`);
edit(builder, `                                await buttonInteraction.deferUpdate().catch(() => {});
                                await saveExistingEmbed(buttonInteraction, interaction.guild, state);`, `                                await saveExistingEmbed(buttonInteraction, interaction.guild, state);`);
edit(builder, `                try {
                    switch (buttonInteraction.customId) {`, `                try {
                    if (state.saveInFlight && buttonInteraction.customId !== 'simple_embed_post') {
                        await buttonInteraction.deferUpdate();
                        return;
                    }
                    switch (buttonInteraction.customId) {`);
// State mutations are synchronous. A rate-limited preview must not block the
// editor drain or prevent later accepted fields from reaching the Save snapshot.
edit(builder, `                    const refreshed = await refreshBuilder(interaction, state);
                    if (!refreshed) {
                        const error = new Error('The message builder session has expired.');
                        error.code = 'EMBED_BUILDER_EXPIRED';
                        throw error;
                    }
                },
                onColor:`, `                    void refreshBuilder(interaction, state).catch(error => {
                        logger.error('Failed to refresh editor preview:', error);
                    });
                },
                onColor:`);

const editor = 'src/services/embedColorPickerSessionService.js';
edit(editor, `    const job = previous.then(async () => {`, `    const job = previous.catch(() => {}).then(async () => {`);
edit(editor, `                    await session.onEditorUpdate(field, value);`, `                    try {
                        await session.onEditorUpdate(field, value);
                    } catch (error) {
                        // Keep this and remaining accepted updates for a retry.
                        if (generation === session.editGeneration && sessions.get(token) === session) {
                            for (const [retryField, retryValue] of pending.slice(pending.findIndex(entry => entry[0] === field))) {
                                if (!session.pendingEditorUpdates.has(retryField)) session.pendingEditorUpdates.set(retryField, retryValue);
                            }
                        }
                        throw error;
                    }`);

const manager = 'src/services/embedManagerService.js';
edit(manager, `    await flushPendingEmbedEditorUpdates(state.colorSessionToken);
    const target = state.modifyTarget;`, `    await flushPendingEmbedEditorUpdates(state.colorSessionToken);
    const liveState = state;
    state = { ...state, embedFields: state.embedFields?.map(field => ({ ...field })) };
    const target = state.modifyTarget;`);
edit(manager, `        state.componentsDirty = false;
    }

    const current = edited.embeds`, `        state.componentsDirty = false;
        if (liveState.modifyTarget === target) {
            liveState.componentRows = state.componentRows;
            liveState.componentRowsSourceMessageId = state.componentRowsSourceMessageId;
            liveState.componentsDirty = false;
        }
    }

    const current = edited.embeds`);
edit(manager, `    await registerCloudyEmbedMessage(edited, registrySource)
        .catch(error => {`, `    const registered = await registerCloudyEmbedMessage(edited, registrySource)
        .catch(error => {`);
edit(manager, `    const displayChannel = guild.channels.cache.get(target.channelId) || channel;`, `    if (!registered) return { ok: false, reason: 'persistence-failed' };
    const displayChannel = guild.channels.cache.get(target.channelId) || channel;`);
edit(manager, `registerCloudyEmbedMessage(edited, registrySource)`, `registerCloudyEmbedMessage(edited, registrySource, { manualSave: true, manualSaveIndex: index })`);

const registry = 'src/services/embedRegistryService.js';
edit(registry, `export async function registerCloudyEmbedMessages(messages, source = 'cloudy') {`, `export async function registerCloudyEmbedMessages(messages, source = 'cloudy', { manualSave = false, manualSaveIndex = 0 } = {}) {`);
edit(registry, `            if (isBotHistoryMessage) {\n                if (!isSearchableCloudyBotEmbedMessage(message)) continue;\n            } else if (!isManualBuilderMessage && !isRegistrableCloudyEmbedMessage(message)) continue;`, `            if (isBotHistoryMessage) {\n                if (!isSearchableCloudyBotEmbedMessage(message)) continue;\n            } else if (!manualSave && !isManualBuilderMessage && !isRegistrableCloudyEmbedMessage(message)) continue;`);
edit(registry, `                    || isManualBuilderMessage
                    || isBotHistoryMessage
                    || (!isInternalEmbedRecord(addition)`, `                    || isManualBuilderMessage
                    || isBotHistoryMessage
                    || (manualSave && addition.embedIndex === manualSaveIndex)
                    || (!isInternalEmbedRecord(addition)`);
edit(registry, `        source: String(record.source || 'cloudy'),`, `        source: String(record.source || 'cloudy'),
        manualSaved: Boolean(record.manualSaved),`);
edit(registry, `function isFixedCloudyRecord(record) {`, `function isFixedCloudyRecord(record) {
    if (record.manualSaved) return true;`);
edit(registry, `            const additions = message.embeds`, `            const priorRecords = manualSave ? await getEmbedRegistry(message.guildId) : [];
            const additions = message.embeds`);
edit(registry, `                    const location = recordLocationForEmbed(message, embed);`, `                    const prior = priorRecords.find(record => String(record.messageId) === String(message.id) && Number(record.embedIndex || 0) === embedIndex);
                    const location = prior ? { channelId: prior.channelId, backingChannelId: prior.backingChannelId } : recordLocationForEmbed(message, embed);`);
edit(registry, `                        source: isSystemCatalogMessage(message) ? 'system-catalog' : source,`, `                        source: prior?.source || (isSystemCatalogMessage(message) ? 'system-catalog' : source),`);
edit(registry, `                        title: embed?.title || '',`, `                        manualSaved: Boolean(prior?.manualSaved || (manualSave && embedIndex === manualSaveIndex)),
                        title: embed?.title || '',`);
edit(registry, `        await Promise.all([...grouped.entries()].map(([guildId, additions]) => saveRecords(guildId, additions)));
        return true;`, `        const results = await Promise.all([...grouped.entries()].map(([guildId, additions]) => saveRecords(guildId, additions)));
        return results.every(Boolean);`);
edit(registry, `export async function registerCloudyEmbedMessage(message, source = 'cloudy') {
    return registerCloudyEmbedMessages([message], source);`, `export async function registerCloudyEmbedMessage(message, source = 'cloudy', options = {}) {
    return registerCloudyEmbedMessages([message], source, options);`);

const page = 'src/web/embedColorPickerPage.js';
edit(page, '    async function callSession(value) {', `    let sessionExpired = false;
    async function callSession(value) {
      if (sessionExpired) throw new Error('This editor session has expired. Reopen it from Discord.');`);
edit(page, `      const data = await response.json().catch(() => ({}));`, `      if (response.status === 410) {
        sessionExpired = true;
        clearInterval(heartbeatTimer);
      }
      const data = await response.json().catch(() => ({}));`);
edit(page, `      if (!token || heartbeatInFlight) return;`, `      if (!token || sessionExpired || heartbeatInFlight) return;`);
edit(page, `      if (!token) return;
      const payload = JSON.stringify({`, `      if (!token || sessionExpired) return;
      const payload = JSON.stringify({`);
