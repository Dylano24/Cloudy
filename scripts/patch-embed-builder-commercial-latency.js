import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    throw new Error(`[BUILDER_COMMERCIAL_LATENCY] No changes applied to ${path}; runtime shape changed.`);
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_COMMERCIAL_LATENCY] ${path}: patched`);
}

function replaceRequired(text, before, after, label) {
  if (text.includes(before)) return text.replace(before, after);
  if (text.includes(after)) return text;
  throw new Error(`[BUILDER_COMMERCIAL_LATENCY] Missing ${label}`);
}

patchFile('src/services/embedManagerService.js', text => {
  const preparePattern = /export function prepareEmbedManager\(guild, state\) \{[\s\S]*?\n\}\n\nexport async function openEmbedManager/;
  if (!preparePattern.test(text)) throw new Error('[BUILDER_COMMERCIAL_LATENCY] prepareEmbedManager block missing');

  text = text.replace(preparePattern, `export function prepareEmbedManager(guild, state) {
    if (!guild?.id || state.embedManagerPrepared) return;
    state.embedManagerPrepared = (async () => {
        const storedRecords = await getEmbedRegistry(guild.id);
        await warmSavedEmbedTemplateScopes(guild.id, storedRecords.map(record => record.channelId));
        const records = await getCanonicalBuilderRecords(guild, storedRecords, { perChannel: true });
        const checkingChannelIds = embedManagerCheckingChannelIds(guild, storedRecords);
        const initialPayload = guild.channels.cache.size
            ? buildChannelPayload(guild, records, 0, checkingChannelIds)
            : buildEmptyManagerPayload();
        return { storedRecords, records, initialPayload };
    })().catch(error => {
        logger.debug(\`Channel browser preload skipped: \${error?.message || error}\`);
        return null;
    });
}

const EMBED_MANAGER_RECORD_CACHE_TTL = 15 * 60_000;
function rememberEmbedManagerRecordCache(guildId, userId, records) {
    if (!guildId || !userId || !Array.isArray(records)) return;
    const cache = globalThis.__cloudyEmbedManagerRecordCache
        || (globalThis.__cloudyEmbedManagerRecordCache = new Map());
    cache.set(\`\${guildId}:\${userId}\`, {
        records,
        expiresAt: Date.now() + EMBED_MANAGER_RECORD_CACHE_TTL,
    });
}

function invalidateBuilderRecordCaches(guildId) {
    const prefix = \`\${guildId}:\`;
    const managerCache = globalThis.__cloudyEmbedManagerRecordCache;
    if (managerCache?.keys) {
        for (const key of managerCache.keys()) {
            if (String(key).startsWith(prefix)) managerCache.delete(key);
        }
    }
    globalThis.__cloudyEmbedCanonicalSearchCache?.delete?.(String(guildId));
}

export async function openEmbedManager`);

  const openPreparedPattern = / {8}const prepared = state\.embedManagerPrepared;\n {8}delete state\.embedManagerPrepared;\n {8}const storedRecords = \(prepared && await prepared\) \|\| await getEmbedRegistry\(guild\.id\);\n {8}await warmSavedEmbedTemplateScopes\(guild\.id, storedRecords\.map\(record => record\.channelId\)\);\n {8}let records = await getCanonicalBuilderRecords\(guild, storedRecords, \{ perChannel: true \}\);\n {8}const checkingChannelIds = embedManagerCheckingChannelIds\(guild, storedRecords\);\n {8}const initialPayload = guild\.channels\.cache\.size\n {12}\? buildChannelPayload\(guild, records, 0, checkingChannelIds\)\n {12}: buildEmptyManagerPayload\(\);/;
  if (!openPreparedPattern.test(text)) throw new Error('[BUILDER_COMMERCIAL_LATENCY] prepared open block missing');
  text = text.replace(openPreparedPattern, `        const prepared = state.embedManagerPrepared;
        delete state.embedManagerPrepared;
        const preparedData = prepared && await prepared;
        const storedRecords = preparedData?.storedRecords || await getEmbedRegistry(guild.id);
        if (!preparedData) {
            await warmSavedEmbedTemplateScopes(guild.id, storedRecords.map(record => record.channelId));
        }
        let records = preparedData?.records
            || await getCanonicalBuilderRecords(guild, storedRecords, { perChannel: true });
        rememberEmbedManagerRecordCache(guild.id, buttonInteraction.user.id, records);
        const checkingChannelIds = embedManagerCheckingChannelIds(guild, storedRecords);
        const initialPayload = preparedData?.initialPayload
            || (guild.channels.cache.size
                ? buildChannelPayload(guild, records, 0, checkingChannelIds)
                : buildEmptyManagerPayload());`);

  text = text.replaceAll(
    '                        records = refreshedRecords;\n                        await updateEmbedManager(',
    '                        records = refreshedRecords;\n                        rememberEmbedManagerRecordCache(guild.id, buttonInteraction.user.id, records);\n                        await updateEmbedManager(',
  );

  text = replaceRequired(
    text,
    '    const current = edited.embeds?.[index]?.toJSON?.() || applyStateToExistingEmbed(state);',
    `    invalidateBuilderRecordCaches(guild.id);

    const current = edited.embeds?.[index]?.toJSON?.() || applyStateToExistingEmbed(state);`,
    'save cache invalidation',
  );

  text = replaceRequired(
    text,
    `    await buttonInteraction.deferUpdate().catch(() => {});

    try {`,
    `    try {`,
    'Modify open defer',
  );

  text = replaceRequired(
    text,
    `            if (previousSession.messageId) {
                await buttonInteraction.webhook.deleteMessage(previousSession.messageId).catch(() => {});
            }`,
    `            if (previousSession.messageId) {
                void buttonInteraction.webhook.deleteMessage(previousSession.messageId).catch(() => {});
            }`,
    'previous Modify session cleanup',
  );

  text = replaceRequired(
    text,
    `        const managerMessage = await buttonInteraction.followUp({
            ...initialPayload,
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (!managerMessage) return;`,
    `        let managerMessage = null;
        if (typeof buttonInteraction.reply === 'function'
            && !buttonInteraction.deferred
            && !buttonInteraction.replied) {
            const managerResponse = await buttonInteraction.reply({
                ...initialPayload,
                flags: MessageFlags.Ephemeral,
                withResponse: true,
            }).catch(error => {
                logger.error('Embed manager direct reply failed:', error);
                return null;
            });
            managerMessage = managerResponse?.resource?.message || null;
        }

        // Compatibility fallback for legacy/test interaction shims. Real
        // Discord button interactions take the direct one-request path above.
        if (!managerMessage) {
            if (!buttonInteraction.deferred
                && !buttonInteraction.replied
                && typeof buttonInteraction.deferUpdate === 'function') {
                await buttonInteraction.deferUpdate().catch(() => {});
            }
            managerMessage = await buttonInteraction.followUp({
                ...initialPayload,
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            }).catch(() => null);
        }
        if (!managerMessage) return;`,
    'single-roundtrip Modify reply',
  );

  text = replaceRequired(
    text,
    `    try {
        await interaction.editReply(payload);
        return true;`,
    `    try {
        if (!interaction.deferred && !interaction.replied && typeof interaction.update === 'function') {
            await interaction.update(payload);
        } else {
            await interaction.editReply(payload);
        }
        return true;`,
    'single-roundtrip manager update',
  );

  text = replaceRequired(
    text,
    `            const acknowledged = await interaction.deferUpdate()
                .then(() => true)
                .catch(error => {
                    logger.error('Embed manager acknowledgement failed:', error);
                    return interaction.deferred || interaction.replied;
                });
            if (!acknowledged) return;

            const selectionVersion = (session.selectionVersion || 0) + 1;`,
    `            const selectionVersion = (session.selectionVersion || 0) + 1;`,
    'universal manager defer',
  );

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  const refreshAnchor = 'async function refreshBuilder(interaction, state) {';
  if (!text.includes(refreshAnchor)) throw new Error('[BUILDER_COMMERCIAL_LATENCY] refreshBuilder missing');

  if (!text.includes('async function deliverBuilderPreviewUpdate(')) {
    text = text.replace(refreshAnchor, `async function deliverBuilderPreviewUpdate(state, interaction, payload) {
    if (!interaction?.deferred && !interaction?.replied && typeof interaction?.update === 'function') {
        try {
            await interaction.update(payload);
            return true;
        } catch (error) {
            if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {
                return markBuilderPreviewUnavailable(state);
            }
            logger.debug(\`Direct Builder update fell back to fixed preview edit: \${error?.message || error}\`);
        }
    }
    return editBuilderPreviewMessage(state, interaction, payload);
}

${refreshAnchor}`);
  }

  text = replaceRequired(
    text,
    '            result = await editBuilderPreviewMessage(state, interaction, nextPayload);',
    '            result = await deliverBuilderPreviewUpdate(state, interaction, nextPayload);',
    'preview delivery call',
  );

  text = text.replaceAll(
    '                            await buttonInteraction.deferUpdate();\n                            await refreshBuilder(buttonInteraction, state);',
    '                            await refreshBuilder(buttonInteraction, state);',
  );
  text = text.replaceAll(
    '    await submitted.deferUpdate().catch(() => {});\n    await refreshBuilder(submitted, state);',
    '    await refreshBuilder(submitted, state);',
  );

  return text;
});

patchFile('src/events/embedManagerTitleSearchReady.js', text => replaceRequired(
  text,
  `async function refreshRecords(interaction) {
  return getCanonicalBuilderRecords(interaction.guild);
}`,
  `async function refreshRecords(interaction) {
  const key = \`\${interaction.guildId}:\${interaction.user.id}\`;
  const cache = globalThis.__cloudyEmbedManagerRecordCache;
  const cached = cache?.get?.(key);
  if (cached?.expiresAt > Date.now() && Array.isArray(cached.records)) return cached.records;
  if (cached) cache.delete(key);

  const records = await getCanonicalBuilderRecords(interaction.guild);
  cache?.set?.(key, { records, expiresAt: Date.now() + SEARCH_SESSION_TTL });
  return records;
}`,
  'manager Search record cache',
));

patchFile('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', text => {
  const marker = `const pendingSelections = globalThis.__cloudyEmbedBuilderSearchSelections
    || (globalThis.__cloudyEmbedBuilderSearchSelections = new Map());`;
  if (!text.includes(marker)) throw new Error('[BUILDER_COMMERCIAL_LATENCY] autocomplete marker missing');

  if (!text.includes('async function getFastCanonicalBuilderRecords(')) {
    text = text.replace(marker, `${marker}
const CANONICAL_SEARCH_CACHE_TTL = 1500;
const canonicalSearchCache = globalThis.__cloudyEmbedCanonicalSearchCache
    || (globalThis.__cloudyEmbedCanonicalSearchCache = new Map());

async function getFastCanonicalBuilderRecords(guild) {
    const key = String(guild?.id || '');
    if (!key) return [];
    const now = Date.now();
    const cached = canonicalSearchCache.get(key);
    if (cached?.records && cached.expiresAt > now) return cached.records;
    if (cached?.promise) return cached.promise;

    const promise = getCanonicalBuilderRecords(guild)
        .then(records => {
            canonicalSearchCache.set(key, {
                records,
                expiresAt: Date.now() + CANONICAL_SEARCH_CACHE_TTL,
            });
            return records;
        })
        .catch(error => {
            canonicalSearchCache.delete(key);
            throw error;
        });
    canonicalSearchCache.set(key, { promise, expiresAt: now + CANONICAL_SEARCH_CACHE_TTL });
    return promise;
}`);
  }

  if (!text.includes('await getCanonicalBuilderRecords(interaction.guild)')) {
    throw new Error('[BUILDER_COMMERCIAL_LATENCY] canonical search calls missing');
  }
  return text.replaceAll(
    'await getCanonicalBuilderRecords(interaction.guild)',
    'await getFastCanonicalBuilderRecords(interaction.guild)',
  );
});

console.log('[BUILDER_COMMERCIAL_LATENCY] Sub-second Builder fast paths enabled.');
