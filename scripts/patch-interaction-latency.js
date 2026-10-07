import fs from 'node:fs';

function patchFile(file, transform) {
  const before = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  const marker = '// CLOUDY_INTERACTION_LATENCY_V1';
  if (before.includes(marker)) return;
  const after = transform(before);
  if (after !== before) fs.writeFileSync(file, marker + '\n' + after);
}

function replaceRequired(text, before, after) {
  if (text.includes(after)) return text;
  if (!text.includes(before)) throw new Error('Latency patch anchor missing: ' + before.slice(0, 80));
  return text.replace(before, after);
}

patchFile('src/services/embedRegistryService.js', text => {
  text = replaceRequired(text,
    'const registryMutationQueues = new Map();',
    'const registryMutationQueues = new Map();\nconst registryWriteBatches = new Map();');
  text = replaceRequired(text,
    'const registryWriteBatches = new Map();',
    `const registryWriteBatches = new Map();
const registryGenerations = new Map();
export function getEmbedRegistryGeneration(guildId) {
    return registryGenerations.get(String(guildId)) || 0;
}`);
  text = replaceRequired(text,
    '    const queueKey = String(guildId);\n    const previous = registryMutationQueues.get(queueKey)',
    '    const queueKey = String(guildId);\n    // Other mutations are ordering barriers for pending registration batches.\n    registryWriteBatches.delete(queueKey);\n    const previous = registryMutationQueues.get(queueKey)');
  text = replaceRequired(text,
    '    registryWriteBatches.delete(queueKey);\n    const previous',
    '    registryWriteBatches.delete(queueKey);\n    registryGenerations.set(queueKey, getEmbedRegistryGeneration(queueKey) + 1);\n    const previous');
  text = replaceRequired(text,
    '    } finally {\n        if (registryMutationQueues.get(queueKey) === current)',
    '    } finally {\n        registryGenerations.set(queueKey, getEmbedRegistryGeneration(queueKey) + 1);\n        if (registryMutationQueues.get(queueKey) === current)');
  text = replaceRequired(text,
    'async function saveRecords(guildId, additions) {\n    return mutateRegistry(guildId, async () => {\n        const records = cleanStoredRecords(await readStoredRecords(guildId));',
    `function registryContent(records) {
    return JSON.stringify(records.map(record => {
        if (!record || typeof record !== 'object') return record;
        const { updatedAt, ...content } = record;
        return content;
    }));
}

async function saveRecords(guildId, additions) {
    const key = String(guildId);
    const pending = registryWriteBatches.get(key);
    if (pending) {
        pending.additions.push(...additions);
        return pending.promise;
    }
    const batch = { additions: [...additions], promise: null };
    batch.promise = mutateRegistry(guildId, async () => {
        if (registryWriteBatches.get(key) === batch) registryWriteBatches.delete(key);
        const stored = await readStoredRecords(guildId);
        const records = cleanStoredRecords(stored);`);
  text = replaceRequired(text,
    '        for (const addition of additions) {\n            const record = normalizeRecord(addition);',
    '        for (const addition of batch.additions) {\n            const record = normalizeRecord(addition);');
  text = replaceRequired(text,
    '        return setInDb(registryKey(guildId), sortRecords([...next.values()]));\n    });\n}',
    `        const result = sortRecords([...next.values()]);
        // Gateway updates can arrive from several listeners with the same payload.
        // Avoid rewriting a large JSON document for an updatedAt-only difference.
        if (registryContent(stored) === registryContent(result)) return true;
        return setInDb(registryKey(guildId), result);
    });
    registryWriteBatches.set(key, batch);
    return batch.promise;
}`);
  return text;
});
patchFile('src/services/embedManagerService.js', text => {
  text = replaceRequired(text,
    "import { isBuilderSessionMessage } from '../utils/builderSessionCleanup.js';",
    "import { isBuilderSessionMessage, linkBuilderSessionMessages, registerBuilderSessionCollector, touchBuilderSessionMessage } from '../utils/builderSessionCleanup.js';");
  text = replaceRequired(text,
    '    getEmbedRegistry,',
    '    getEmbedRegistry,\n    getEmbedRegistryGeneration,');
  text = replaceRequired(text,
    'export async function openEmbedManager(buttonInteraction, state, refreshBuilder) {',
    `export function prepareEmbedManager(guild, state) {
    if (!guild?.id || state.embedManagerPrepared) return;
    // Preserve the existing live-only channel browser contents. Only prefetch its
    // persisted records; no Discord history scan or catalog rewrite is involved.
    state.embedManagerPrepared = getEmbedRegistry(guild.id).catch(error => {
        logger.debug(\`Channel browser preload skipped: \${error?.message || error}\`);
        return null;
    });
}

export async function openEmbedManager(buttonInteraction, state, refreshBuilder) {`);
  text = replaceRequired(text,
    '    state.embedManagerPrepared = getEmbedRegistry(guild.id).catch(error => {',
    '    state.embedManagerPreparedGeneration = getEmbedRegistryGeneration(guild.id);\n    state.embedManagerPrepared = getEmbedRegistry(guild.id).catch(error => {');
  // The replacement is deliberately scoped: a generic "try" is not an
  // idempotency marker and already occurs elsewhere in this module.
  const opening = text.indexOf('export async function openEmbedManager(');
  const acknowledgement = '    await buttonInteraction.deferUpdate().catch(() => {});\n\n';
  const openBody = text.slice(opening);
  text = text.slice(0, opening) + openBody.replace(acknowledgement, '');
  text = replaceRequired(text,
    '    if (!guild || !buttonInteraction.client.user?.id) return;\n\n    try {',
    `    if (!guild || !buttonInteraction.client.user?.id) return;
    // Fast opens reply directly. Slow storage must not expire the component:
    // deferUpdate is silent and keeps the exact existing private follow-up flow.
    let pendingAcknowledgement = null;
    const acknowledgementTimer = setTimeout(() => {
        if (!buttonInteraction.deferred && !buttonInteraction.replied) {
            pendingAcknowledgement = buttonInteraction.deferUpdate().catch(() => {});
        }
    }, 750);
    acknowledgementTimer.unref?.();

    try {`);
  text = replaceRequired(text,
    '                await buttonInteraction.webhook.deleteMessage(previousSession.messageId).catch(() => {});',
    '                void buttonInteraction.webhook.deleteMessage(previousSession.messageId).catch(() => {});');
  text = replaceRequired(text,
    '        const allStoredRecords = await getEmbedRegistry(guild.id);',
    `        const prepared = state.embedManagerPrepared;
        delete state.embedManagerPrepared;
        const preparedGeneration = state.embedManagerPreparedGeneration;
        delete state.embedManagerPreparedGeneration;
        const preparedRecords = prepared && await prepared;
        const allStoredRecords = preparedRecords && preparedGeneration === getEmbedRegistryGeneration(guild.id)
            ? preparedRecords : await getEmbedRegistry(guild.id);`);
  text = replaceRequired(text,
    `        const managerMessage = await buttonInteraction.followUp({
            ...initialPayload,
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (!managerMessage) return;`,
    `        let managerMessage;
        if (typeof buttonInteraction.reply === 'function'
            && !buttonInteraction.deferred && !buttonInteraction.replied) {
            const response = await buttonInteraction.reply({
                ...initialPayload,
                flags: MessageFlags.Ephemeral,
                withResponse: true,
            });
            managerMessage = response?.resource?.message;
            // Some adapters return the Message directly instead of an API response.
            if (!managerMessage && response?.createMessageComponentCollector) managerMessage = response;
            if (!managerMessage) managerMessage = await buttonInteraction.fetchReply();
        } else {
            if (!buttonInteraction.deferred && !buttonInteraction.replied) {
                await buttonInteraction.deferUpdate();
            }
            managerMessage = await buttonInteraction.followUp({
                ...initialPayload,
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            });
        }
        if (!managerMessage) return;`);
  text = replaceRequired(text,
    '        let managerMessage;\n        if (typeof buttonInteraction.reply',
    '        clearTimeout(acknowledgementTimer);\n        if (pendingAcknowledgement) await pendingAcknowledgement;\n        let managerMessage;\n        if (typeof buttonInteraction.reply');
  text = replaceRequired(text,
    '        if (!managerMessage) return;\n\n        const session = {',
    `        if (!managerMessage) return;
        // Direct callback replies bypass InteractionWebhook.send, so retain
        // the exact existing ownership, inactivity and ephemeral cleanup hooks.
        linkBuilderSessionMessages(buttonInteraction.message, managerMessage);
        touchBuilderSessionMessage(managerMessage, () => buttonInteraction.webhook.deleteMessage(managerMessage.id));

        const session = {`);
  text = replaceRequired(text,
    '        session.collector = collector;',
    '        session.collector = collector;\n        registerBuilderSessionCollector(managerMessage, collector);');
  text = replaceRequired(text,
    "        collector.on('collect', async interaction => {\n            session.hasInteracted = true;",
    "        collector.on('collect', async interaction => {\n            touchBuilderSessionMessage(managerMessage);\n            session.hasInteracted = true;");
  text = text.replace(
    `            const acknowledged = await interaction.deferUpdate()
                .then(() => true)
                .catch(error => {
                    logger.error('Embed manager acknowledgement failed:', error);
                    return interaction.deferred || interaction.replied;
                });
            if (!acknowledged) return;

            const selectionVersion`,
    '            const selectionVersion');
  // Selection can require REST I/O; acknowledge it silently before that work.
  text = replaceRequired(text,
    `                const parts = interaction.customId.split(':');
                const channelId = parts[1];
                const page = Number(parts[2]) || 0;
                const [messageId, embedIndexRaw]`,
    `                await interaction.deferUpdate();
                const parts = interaction.customId.split(':');
                const channelId = parts[1];
                const page = Number(parts[2]) || 0;
                const [messageId, embedIndexRaw]`);
  const start = text.indexOf('async function updateEmbedManager(');
  const end = text.indexOf('\nfunction managerRecordKey', start);
  if (start < 0 || end < 0) throw new Error('Manager update function missing');
  const update = replaceRequired(text.slice(start, end),
    '        await interaction.editReply(payload);',
    `        if (!interaction.deferred && !interaction.replied && typeof interaction.update === 'function') {
            await interaction.update(payload);
        } else {
            await interaction.editReply(payload);
        }`);
  text = text.slice(0, start) + update + text.slice(end);
  text = replaceRequired(text,
    "        logger.error('Embed manager failed:', error);\n        await buttonInteraction.followUp({",
    `        clearTimeout(acknowledgementTimer);
        if (pendingAcknowledgement) await pendingAcknowledgement;
        logger.error('Embed manager failed:', error);
        const errorResponse = (!buttonInteraction.deferred && !buttonInteraction.replied && buttonInteraction.reply)
            ? buttonInteraction.reply.bind(buttonInteraction)
            : buttonInteraction.followUp.bind(buttonInteraction);
        await errorResponse({`);
  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  text = replaceRequired(text,
    '    openEmbedManager,',
    '    openEmbedManager,\n    prepareEmbedManager,');
  text = replaceRequired(text,
    '            const colorSessionToken = createEmbedColorPickerSession({',
    '            prepareEmbedManager(interaction.guild, state);\n            const colorSessionToken = createEmbedColorPickerSession({');
  // Earlier migrations left a second identical case after the active combined
  // clear/remove branch. It is unreachable; removing it preserves the handler.
  const duplicate = text.indexOf("                        case 'simple_embed_remove_buttons': {", text.indexOf("case 'simple_embed_clear_buttons':"));
  if (duplicate >= 0) {
    const nextCase = text.indexOf("                        case 'simple_embed_modify':", duplicate);
    if (nextCase < 0) throw new Error('Duplicate button case end missing');
    text = text.slice(0, duplicate) + text.slice(nextCase);
  }
  return text;
});

patchFile('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', text => {
  if (text.includes('getCanonicalBuilderRecords(guild)') && !/import[^;]*\bgetCanonicalBuilderRecords\b[^;]*from/.test(text)) {
    return replaceRequired(text,
      'import { collapseDisplayRecords, canonicalBuilderResponseTitle }',
      'import { collapseDisplayRecords, canonicalBuilderResponseTitle, getCanonicalBuilderRecords }');
  }
  return text;
});
patchFile('src/utils/interactionHelper.js', text => {
  text = replaceRequired(text,
    "import { ResponseCoordinator } from './responseCoordinator.js';",
    "import { ResponseCoordinator } from './responseCoordinator.js';\nimport { observeInteractionLatency } from './interactionLatency.js';");
  return replaceRequired(text,
    '    static patchInteractionResponses(interaction) {',
    '    static patchInteractionResponses(interaction) {\n        observeInteractionLatency(interaction);');
});
patchFile('src/services/reportCaseLifecycleService.js', text => replaceRequired(text,
  '  const category = await fetchChannel(guild, REPORT_CATEGORY_ID);\n  const logs = await fetchChannel(guild, REPORT_LOG_CHANNEL_ID);',
  '  const [category, logs] = await Promise.all([\n    fetchChannel(guild, REPORT_CATEGORY_ID),\n    fetchChannel(guild, REPORT_LOG_CHANNEL_ID),\n  ]);'));
console.log('[INTERACTION_LATENCY] Durable registry batching, single-request Modify and latency observation enabled.');

