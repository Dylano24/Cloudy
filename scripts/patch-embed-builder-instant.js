import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(path, after);
  console.log(`[EMBED_BUILDER_PATCH] ${path}: ${after === before ? 'already current' : 'patched'}`);
}

patchFile('src/services/embedManagerService.js', text => {
  if (!text.includes('Show every real text/announcement channel')) {
    const oldGroups = `function buildChannelGroups(guild, records) {
    const groups = new Map();
    for (const record of records) {
        const channelId = String(record.channelId);
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }

    return [...groups.entries()]
        .map(([channelId, channelRecords]) => ({
            channelId,
            channel: guild.channels.cache.get(channelId) || null,
            records: channelRecords.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)),
        }))
        .filter(group => collapseDisplayRecords(group.records, group.channelId).length > 0)
        .sort(compareChannelsByDiscordOrder);
}`;
    const newGroups = `function buildChannelGroups(guild, records) {
    const groups = new Map();

    // Show every real text/announcement channel, even when it does not have a
    // registered embed yet. The Modify browser is a channel browser first.
    for (const channel of guild.channels.cache.values()) {
        if (![0, 5].includes(channel?.type) || !channel?.messages?.fetch) continue;
        groups.set(String(channel.id), []);
    }

    for (const record of records) {
        const channelId = String(record.channelId);
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }

    return [...groups.entries()]
        .map(([channelId, channelRecords]) => ({
            channelId,
            channel: guild.channels.cache.get(channelId) || null,
            records: channelRecords.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)),
        }))
        .filter(group => Boolean(group.channel))
        .sort(compareChannelsByDiscordOrder);
}`;
    text = text.replace(oldGroups, newGroups);
  }

  text = text.replace(
`            .addOptions(...result.items.map(group => {
                const name = group.channel?.name ? \`# \${group.channel.name}\` : 'Unknown channel';
                const count = collapseDisplayRecords(group.records, group.channelId).length;
                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(\`\${name} • \${count} \${count === 1 ? 'embed' : 'embeds'}\`))
                    .setDescription('Open the embeds in this channel')
                    .setValue(group.channelId);
            }));`,
`            .addOptions(...result.items.map(group => {
                const name = group.channel?.name ? \`# \${group.channel.name}\` : 'Unknown channel';
                const count = collapseDisplayRecords(group.records, group.channelId).length;
                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(name))
                    .setDescription(count ? 'Open the saved embed' : 'No saved embed yet')
                    .setValue(group.channelId);
            }));`);

  if (!text.includes('function loadRecordSnapshotIntoState')) {
    const marker = 'function loadEmbedIntoState(state, resolved) {';
    const helper = `function loadRecordSnapshotIntoState(state, guild, record) {
    const snapshot = getEmbedRegistrySnapshot(record);
    if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) return false;

    const data = migrateCloudyLogoEmbedData(snapshot).data || {};
    const footerText = cleanFooter(data.footer?.text || '');
    const logicalChannelId = String(record.channelId || '');
    const backingChannelId = String(record.backingChannelId || record.channelId || '');
    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);

    state.title = data.title || null;
    state.message = data.description || null;
    state.embedFields = Array.isArray(data.fields)
        ? data.fields.map(field => ({
            name: String(field.name || '').slice(0, 256),
            value: String(field.value || '').slice(0, 1024),
            inline: Boolean(field.inline),
        }))
        : [];
    state.sideColor = Number.isInteger(data.color) ? data.color : 0xFFFFFF;
    state.showLogo = isCloudyLogoUrl(data.thumbnail?.url);
    state.removeExistingLogo = false;
    state.bottomLine = footerText || null;
    state.mediaUrl = data.image?.url || null;
    state.mediaBuffer = null;
    state.mediaName = null;
    state.mediaConvertedFromVideo = false;
    state.modifyTarget = {
        guildId: guild.id,
        channelId: logicalChannelId,
        backingChannelId,
        messageId: String(record.messageId),
        embedIndex: Number(record.embedIndex || 0),
        source: record.source || 'cloudy',
        sourceEmbedData: data,
        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),
        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),
        cachedMessage: null,
    };
    return true;
}

`;
    text = text.replace(marker, helper + marker);
  }

  text = text.replace(
`                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }`,
`                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
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
                }`);

  text = text.replace(
`                const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                if (!resolved) {
                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
                    return;
                }

                loadEmbedIntoState(state, resolved);
                const refreshed = await refreshBuilder();
                if (refreshed === false) {
                    throw new Error('The message builder could not refresh after loading the selected embed.');
                }

                records = await getEmbedRegistry(guild.id);
                await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);`,
`                let loaded = record ? loadRecordSnapshotIntoState(state, guild, record) : false;
                if (loaded) {
                    void Promise.resolve(refreshBuilder()).catch(error => {
                        logger.debug(\`Immediate embed preview refresh skipped: \${error?.message || error}\`);
                    });
                } else {
                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (!resolved) {
                        await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
                        return;
                    }
                    loadEmbedIntoState(state, resolved);
                    loaded = true;
                    void Promise.resolve(refreshBuilder()).catch(error => {
                        logger.debug(\`Resolved embed preview refresh skipped: \${error?.message || error}\`);
                    });
                }

                await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);`);

  text = text.replaceAll(
`                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildChannelPayload(guild, records, 0), state, session);`,
`                    await updateEmbedManager(interaction, buildChannelPayload(guild, records, 0), state, session);`);
  text = text.replaceAll(
`                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildChannelPayload(guild, records, page), state, session);`,
`                    await updateEmbedManager(interaction, buildChannelPayload(guild, records, page), state, session);`);
  text = text.replaceAll(
`                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);`,
`                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);`);

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  if (text.includes('Latest-preview-wins: never build a long Discord edit queue')) return text;
  return text.replace(/async function refreshBuilder\(interaction, state\) \{[\s\S]*?\n\}\n\nasync function editContent/, `async function refreshBuilder(interaction, state) {
    if (state.colorSessionToken) {
        state.colorPickerUrl = \`\${COLOR_PICKER_URL}/embed-color?session=\${state.colorSessionToken}&color=\${encodeURIComponent(colorToHex(state.sideColor))}\`;
    }

    const payload = {
        embeds: [buildPreviewEmbed(state), buildControlEmbed(state)],
        components: buildControls(state),
        attachments: [],
    };

    if (state.mediaBuffer && state.mediaName) {
        payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
    }

    // Latest-preview-wins: never build a long Discord edit queue. If a preview
    // edit is already in flight, replace the pending one with the newest state.
    state.previewEditPending = { interaction, payload };
    if (state.previewEditRunning) return true;

    state.previewEditRunning = true;
    let result = true;
    try {
        while (state.previewEditPending) {
            const next = state.previewEditPending;
            state.previewEditPending = null;
            result = await InteractionHelper.safeEditReply(next.interaction, next.payload);
        }
    } finally {
        state.previewEditRunning = false;
    }
    return result;
}

async function editContent`);
});

patchFile('src/services/embedColorPickerSessionService.js', text =>
  text.replace('const EDIT_FLUSH_DELAY_MS = 220;', 'const EDIT_FLUSH_DELAY_MS = 45;')
);
