import fs from 'node:fs';

function replaceOnce(text, find, replace, label) {
  if (!text.includes(find)) throw new Error(`[BUILDER_HUMAN_PREVIEW] marker not found: ${label}`);
  return text.replace(find, replace);
}

{
  const path = 'src/commands/Tools/embedbuilder.js';
  const before = fs.readFileSync(path, 'utf8');

  if (!before.includes('BUILDER_HUMAN_PREVIEW_V1')) {
    let text = before;
    const marker = 'function buildPreviewEmbed(state) {';
    const helper = `function isInternalTemplateAuthor(value) {
    return /^cloudy template key:/i.test(String(value || '').trim());
}

// BUILDER_HUMAN_PREVIEW_V1
`;

    text = replaceOnce(text, marker, helper + marker, 'preview metadata helper');
    text = replaceOnce(
      text,
      `        const source = state.modifyTarget.sourceEmbedData;
        const data = { ...source, color: state.sideColor };`,
      `        const source = state.modifyTarget.sourceEmbedData;
        const data = { ...source, color: state.sideColor };
        if (isInternalTemplateAuthor(data.author?.name)) delete data.author;`,
      'hide internal template author',
    );

    fs.writeFileSync(path, text, 'utf8');
    console.log('[BUILDER_HUMAN_PREVIEW] hidden internal metadata from preview');
  } else {
    console.log('[BUILDER_HUMAN_PREVIEW] preview already current');
  }
}

{
  const path = 'src/services/embedManagerService.js';
  const before = fs.readFileSync(path, 'utf8');

  if (!before.includes('BUILDER_HUMAN_NAMES_V1')) {
    let text = before;

    text = replaceOnce(
      text,
      `import {
    primeSystemEmbedCatalogMessage,`,
      `import {
    getSystemSourceDefinitionPreview,
    getSystemSourceDefinitionPreviewForEmbed,
    primeSystemEmbedCatalogMessage,`,
      'source preview import',
    );

    const identityMarker = '\n\nexport function templateIdentity';
    const helper = `

function isTechnicalBuilderLabel(value) {
    const text = stripCustomEmojiMarkup(value).trim();
    return /^cloudy template key:/i.test(text)
        || /^(?:source|embed):[a-z0-9_-]{6,}$/i.test(text)
        || /^(?:game|ticket-log):[a-z0-9:_-]+$/i.test(text);
}

function humanTemplateRecordName(record) {
    const data = recordEmbedData(record);
    const candidates = [
        data.title,
        record?.name,
        record?.title,
    ].map(value => stripCustomEmojiMarkup(value)).filter(Boolean);

    for (const candidate of candidates) {
        if (!isTechnicalBuilderLabel(candidate)) return standardDynamicTemplateName(candidate);
    }

    const firstLine = String(data.description || '')
        .split('\\n')
        .map(line => stripCustomEmojiMarkup(line).replace(/^[>\\s#*_\`~|]+/, '').replace(/[*_\`~]/g, '').trim())
        .find(Boolean);
    if (firstLine && !isTechnicalBuilderLabel(firstLine)) return firstLine;

    const firstFieldName = (data.fields || [])
        .map(field => stripCustomEmojiMarkup(field?.name || '').trim())
        .find(value => value && !isTechnicalBuilderLabel(value));
    if (firstFieldName) return standardDynamicTemplateName(firstFieldName);

    const footerText = stripCustomEmojiMarkup(data.footer?.text || '').trim();
    if (footerText && !isTechnicalBuilderLabel(footerText)) return standardDynamicTemplateName(footerText);

    const authorName = stripCustomEmojiMarkup(data.author?.name || '').trim();
    if (authorName && !isTechnicalBuilderLabel(authorName)) return standardDynamicTemplateName(authorName);

    const context = String(stableSystemTemplateContext(data) || '').trim();
    const contextLeaf = context.split('/').filter(Boolean).at(-1) || '';
    if (contextLeaf) {
        return contextLeaf
            .split(/[-_]+/)
            .filter(Boolean)
            .map(part => {
                const lower = part.toLowerCase();
                if (lower === 'faq') return 'FAQ';
                if (lower === 'ai') return 'AI';
                return lower.charAt(0).toUpperCase() + lower.slice(1);
            })
            .join(' ');
    }

    return 'Embed';
}

function builderSourceCompleteness(record) {
    const data = recordEmbedData(record);
    let score = 0;
    if (data.description) score += 1000 + String(data.description).length;
    if (Array.isArray(data.fields)) score += data.fields.length * 500;
    if (data.footer?.text) score += 250;
    if (data.thumbnail?.url) score += 150;
    if (data.image?.url) score += 100;
    return score;
}

function isLegacyHelperParserArtifactRecord(record) {
    if (String(record?.source || '') !== 'system-catalog') return false;
    const data = recordEmbedData(record);
    const title = stripCustomEmojiMarkup(data.title || '').trim();
    const description = stripCustomEmojiMarkup(data.description || '').trim();
    if (!/^(?:success|error|information|warning)$/i.test(title) || !description) return false;

    const source = getSystemSourceDefinitionPreview(
        description,
        stableSystemTemplateContext(data),
    );
    if (!source) return false;

    const sourceTitle = stripCustomEmojiMarkup(source.title || '').trim();
    return sourceTitle.toLowerCase() === description.toLowerCase()
        && Boolean(source.description || source.fields?.length);
}

function containsDynamicPlaceholder(value) {
    if (/\{dynamic\}/i.test(String(value || ''))) return true;
    if (Array.isArray(value)) {
        return value.some(item => containsDynamicPlaceholder(item?.name) || containsDynamicPlaceholder(item?.value));
    }
    return false;
}

function isStaleDynamicSourceArtifactRecord(record) {
    if (String(record?.source || '') !== 'system-catalog') return false;
    const data = recordEmbedData(record);
    const stableKey = stableSystemTemplateKey(data);
    if (!/^(?:embed|embed-type):/i.test(stableKey)) return false;
    if (!containsDynamicPlaceholder(data.title)) return false;

    // PR #131 temporarily allowed arbitrary calculated template literals into
    // static discovery. Keep a catalog-only dynamic row when it still maps to
    // a current source definition. Otherwise hide only placeholder-shaped
    // parser artifacts; real runtime captures keep their concrete body.
    if (getSystemSourceDefinitionPreviewForEmbed(data)) return false;
    return containsDynamicPlaceholder(data.description)
        || containsDynamicPlaceholder(data.fields);
}

function bestBuilderSourceRecord(records, fallback = null) {
    const sources = (records || [])
        .filter(record => String(record?.source || '') === 'system-catalog')
        .filter(record => !isLegacyHelperParserArtifactRecord(record))
        .sort((left, right) => {
            const scoreDelta = builderSourceCompleteness(left) - builderSourceCompleteness(right);
            if (scoreDelta) return scoreDelta;
            const leftTime = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
            const rightTime = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
            return leftTime - rightTime;
        });
    return sources.at(-1) || fallback;
}

// BUILDER_HUMAN_NAMES_V1
`;
    text = replaceOnce(text, identityMarker, helper + identityMarker, 'human record names');

    if (text.includes("if (stableKey && !stableKey.startsWith('embed:')) return stableKey;")) {
      text = text.replace(
        "if (stableKey && !stableKey.startsWith('embed:')) return stableKey;",
        "if (stableKey && !/^(?:embed(?:-type)?|source):/i.test(stableKey)) return stableKey;",
      );
    }

    if (text.includes('    const titleShape = dynamicTemplateText(title);')) {
      text = text.replace(
        '    const titleShape = dynamicTemplateText(title);',
        "    const titleShape = isTechnicalBuilderLabel(title) ? '' : dynamicTemplateText(title);",
      );
    } else if (text.includes('    const titleShape = canonicalBuilderResponseTitle(title);')) {
      text = text.replace(
        '    const titleShape = canonicalBuilderResponseTitle(title);',
        "    const titleShape = isTechnicalBuilderLabel(title) ? '' : canonicalBuilderResponseTitle(title);",
      );
    } else if (!text.includes("const titleShape = isTechnicalBuilderLabel(title) ? '' : canonicalBuilderResponseTitle(title);")
      && !text.includes("const titleShape = isTechnicalBuilderLabel(title) ? '' : dynamicTemplateText(title);")) {
      throw new Error('[BUILDER_HUMAN_PREVIEW] marker not found: ignore technical titles for identity');
    }

    if (text.includes('standardDynamicTemplateName(rawName)')) {
      text = text.replaceAll('standardDynamicTemplateName(rawName)', 'humanTemplateRecordName(record)');
    } else if (!text.includes('humanTemplateRecordName(record)')) {
      throw new Error('[BUILDER_HUMAN_PREVIEW] human menu label marker not found');
    }

    text = replaceOnce(
      text,
      `    for (const record of channelRecords) {
        const rawName = recordName(record);`,
      `    for (const record of channelRecords) {
        if (isLegacyHelperParserArtifactRecord(record) || isStaleDynamicSourceArtifactRecord(record)) continue;
        const rawName = recordName(record);`,
      'hide legacy helper parser artifacts',
    );

    const displayEmojiMarker = `        const displayEmojiSource = group.records
            .map(record => recordEmbedData(record).title || record.title || record.name || '')
            .find(value => customEmojiOption(value)) || '';`;
    text = replaceOnce(
      text,
      displayEmojiMarker,
      `        const previewRecord = realRecords.at(-1) || representative;
        const sourceRecord = bestBuilderSourceRecord(group.records, representative);
${displayEmojiMarker}`,
      'live preview record',
    );

    text = replaceOnce(
      text,
      `            displayEmojiSource,
            duplicateCount: group.records.length,`,
      `            displayEmojiSource,
            previewRecord,
            sourceRecord,
            duplicateCount: group.records.length,`,
      'attach live preview record',
    );

    {
      const loaderStart = text.indexOf('function loadRecordSnapshotIntoState(');
      const loaderEnd = text.indexOf('\nfunction loadEmbedIntoState', loaderStart);
      if (loaderStart === -1 || loaderEnd === -1) {
        throw new Error('[BUILDER_HUMAN_PREVIEW] loader block not found');
      }

      const exportStart = text.lastIndexOf('export ', loaderStart);
      const replaceStart = exportStart !== -1 && exportStart + 7 === loaderStart ? exportStart : loaderStart;
      const loaderBlock = `export function loadRecordSnapshotIntoState(
    state,
    guild,
    record,
    previewRecord = null,
    sourceRecord = null,
) {
    const snapshot = record?.snapshot || getEmbedRegistrySnapshot(record);
    if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) return false;

    const data = migrateCloudyLogoEmbedData(snapshot).data || {};
    const previewSnapshot = previewRecord
        ? (previewRecord?.snapshot || getEmbedRegistrySnapshot(previewRecord))
        : null;
    const previewData = previewSnapshot && typeof previewSnapshot === 'object' && Object.keys(previewSnapshot).length
        ? (migrateCloudyLogoEmbedData(previewSnapshot).data || {})
        : null;
    const effectiveSourceRecord = sourceRecord || record?.sourceRecord || null;
    const sourceSnapshot = effectiveSourceRecord
        ? (effectiveSourceRecord?.snapshot || getEmbedRegistrySnapshot(effectiveSourceRecord))
        : null;
    const sourceData = sourceSnapshot && typeof sourceSnapshot === 'object' && Object.keys(sourceSnapshot).length
        ? (migrateCloudyLogoEmbedData(sourceSnapshot).data || {})
        : null;
    const sourcePreviewData = getSystemSourceDefinitionPreviewForEmbed(
        sourceData && Object.keys(sourceData).length ? sourceData : data,
    );
    const templateSourceData = {
        ...(sourceData || {}),
        ...(sourcePreviewData || {}),
    };

    // A live/history peer can exist but still be sparse. Merge each visible
    // piece independently so one title-only peer can never hide the complete
    // source definition from the Builder preview.
    const displayTitle = previewData?.title
        || sourcePreviewData?.title
        || sourceData?.title
        || data.title;
    const displayDescription = previewData?.description
        ?? sourcePreviewData?.description
        ?? sourceData?.description
        ?? data.description;
    const displayFields = Array.isArray(previewData?.fields) && previewData.fields.length
        ? previewData.fields
        : (Array.isArray(sourcePreviewData?.fields) && sourcePreviewData.fields.length
            ? sourcePreviewData.fields
            : (Array.isArray(sourceData?.fields) && sourceData.fields.length
                ? sourceData.fields
                : data.fields));
    const displayFooter = previewData?.footer
        || sourcePreviewData?.footer
        || sourceData?.footer
        || data.footer;
    const displayImage = previewData?.image
        || sourcePreviewData?.image
        || sourceData?.image
        || data.image;
    const displayThumbnail = previewData?.thumbnail
        || sourcePreviewData?.thumbnail
        || sourceData?.thumbnail
        || data.thumbnail;
    const displaySourceData = {
        ...(sourcePreviewData || {}),
        ...(previewData || {}),
        ...(displayTitle ? { title: displayTitle } : {}),
        ...(displayDescription != null ? { description: displayDescription } : {}),
        ...(Array.isArray(displayFields) ? { fields: displayFields } : {}),
        ...(displayFooter ? { footer: displayFooter } : {}),
        ...(displayImage ? { image: displayImage } : {}),
        ...(displayThumbnail ? { thumbnail: displayThumbnail } : {}),
    };
    const footerText = cleanFooter(displayFooter?.text || data.footer?.text || '');
    const logicalChannelId = String(record.channelId || '');
    const backingChannelId = String(record.backingChannelId || record.channelId || '');
    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);
    const templateKind = stableSystemTemplateKind(sourceData || {})
        || stableSystemTemplateKind(data);

    state.title = templateKind === 'content' ? null : (displayTitle || null);
    state.message = displayDescription || null;
    state.embedFields = Array.isArray(displayFields)
        ? displayFields.map(field => ({
            name: String(field.name || '').slice(0, 256),
            value: String(field.value || '').slice(0, 1024),
            inline: Boolean(field.inline),
        }))
        : [];
    state.sideColor = Number.isInteger(previewData?.color)
        ? previewData.color
        : (Number.isInteger(sourcePreviewData?.color)
            ? sourcePreviewData.color
            : (Number.isInteger(sourceData?.color)
                ? sourceData.color
                : (Number.isInteger(data.color) ? data.color : 0xFFFFFF)));
    state.showLogo = isCloudyLogoUrl(displayThumbnail?.url);
    state.removeExistingLogo = false;
    state.bottomLine = footerText || null;
    state.mediaUrl = displayImage?.url || null;
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
        templateSourceData,
        previewSourceData: displaySourceData,
        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),
        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(
            logicalChannelId,
            Object.keys(templateSourceData).length ? templateSourceData : data,
        ),
        templateKind,
        catalogTitle: templateSourceData.title || data.title || null,
        detached: Boolean(record.detached),
        cachedMessage: null,
    };
    loadBuilderComponentsFromRecord(state, previewRecord || record);
    return true;
}
`;

      text = text.slice(0, replaceStart) + loaderBlock + text.slice(loaderEnd);
    }

    const channelGroupsMarker = 'function buildChannelGroups(guild, records) {';
    const channelGroupsHelper = `const SAVED_TEMPLATE_CHANNEL_ID = '__cloudy_saved_templates__';

function builderDisplayChannelId(guild, record) {
    const logicalChannelId = String(record?.channelId || '');
    if (logicalChannelId && guild?.channels?.cache?.has?.(logicalChannelId)) return logicalChannelId;

    const backingChannelId = String(record?.backingChannelId || '');
    if (String(record?.source || '') === 'system-catalog'
        && backingChannelId
        && guild?.channels?.cache?.has?.(backingChannelId)) {
        return backingChannelId;
    }

    if (record?.detached) return SAVED_TEMPLATE_CHANNEL_ID;
    return logicalChannelId;
}

function builderDisplayChannel(guild, channelId) {
    if (String(channelId) === SAVED_TEMPLATE_CHANNEL_ID) {
        return {
            id: SAVED_TEMPLATE_CHANNEL_ID,
            name: 'Saved templates',
            type: 0,
            rawPosition: Number.MAX_SAFE_INTEGER,
            position: Number.MAX_SAFE_INTEGER,
            parent: null,
            messages: { fetch: async () => null },
            toString: () => 'Saved templates',
        };
    }
    return guild?.channels?.cache?.get?.(String(channelId)) || null;
}

// BUILDER_DURABLE_SNAPSHOT_V1
`;
    text = replaceOnce(text, channelGroupsMarker, channelGroupsHelper + channelGroupsMarker, 'saved template display helpers');

    if (text.includes('for (const record of filterEmbedManagerRecords(records))')) {
      console.log('[BUILDER_HUMAN_PREVIEW] live-only channel grouping already current; Search-only archive remains hidden from Modify');
    } else {
      text = replaceOnce(
        text,
        `    for (const record of records) {
        const channelId = String(record.channelId);
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }`,
        `    for (const record of records) {
        const channelId = builderDisplayChannelId(guild, record);
        if (!channelId) continue;
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }`,
        'saved template channel grouping',
      );
    }

    text = replaceOnce(
      text,
      '            channel: guild.channels.cache.get(channelId) || null,',
      '            channel: builderDisplayChannel(guild, channelId),',
      'saved template virtual channel',
    );

    text = replaceOnce(
      text,
      '    const channel = guild.channels.cache.get(channelId) || null;',
      '    const channel = builderDisplayChannel(guild, channelId);',
      'saved template embed browser channel',
    );

    if (
      text.includes('const visibleChannelRecords = filterEmbedManagerRecords(records)')
      || text.includes('const channelRecords = filterEmbedManagerRecords(records)')
    ) {
      console.log('[BUILDER_HUMAN_PREVIEW] live-only embed list already current; detached Search archive remains out of Modify');
    } else {
      text = replaceOnce(
        text,
        `    const rawChannelRecords = records
        .filter(record => String(record.channelId) === String(channelId))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));`,
        `    const rawChannelRecords = records
        .filter(record => builderDisplayChannelId(guild, record) === String(channelId))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));`,
        'saved template embed list',
      );
    }

    text = replaceOnce(
      text,
      `    getEmbedRegistrySnapshot,
    reconcileEmbedRegistry,`,
      `    getEmbedRegistrySnapshot,
    reconcileEmbedRegistry,
    updateDetachedEmbedRegistrySnapshot,`,
      'detached snapshot save import',
    );

    text = replaceOnce(
      text,
      `    const backingChannelId = String(target.backingChannelId || target.channelId);`,
      `    if (target.detached && target.source === 'embed-builder') {
        const current = applyStateToExistingEmbed(state);
        if (getEmbedsTextLength([current]) > DISCORD_EMBED_TOTAL_TEXT_LIMIT) {
            return { ok: false, reason: 'embed-too-large' };
        }

        const persisted = await updateDetachedEmbedRegistrySnapshot(guild.id, target, current);
        if (!persisted) return { ok: false, reason: 'persistence-failed' };

        state.modifyTarget.sourceEmbedData = current;
        state.modifyTarget.previewSourceData = { ...current };
        state.modifyTarget.cachedMessage = null;
        return {
            ok: true,
            channel: 'Saved templates',
            message: null,
            updatedCount: 1,
            detached: true,
        };
    }

    const backingChannelId = String(target.backingChannelId || target.channelId);`,
      'detached snapshot save',
    );

    const selectedMarker = `                let record = records.find(item =>
                    String(item.channelId) === String(channelId) &&
                    String(item.messageId) === String(messageId) &&
                    Number(item.embedIndex || 0) === embedIndex,
                );`;
    text = replaceOnce(
      text,
      selectedMarker,
      `                const selectedDisplayRecord = collapseDisplayRecords(
                    records.filter(item => builderDisplayChannelId(guild, item) === String(channelId)),
                    channelId,
                ).find(item =>
                    String(item.messageId) === String(messageId)
                    && Number(item.embedIndex || 0) === embedIndex
                );
                const previewRecord = selectedDisplayRecord?.previewRecord || null;
                const sourceRecord = selectedDisplayRecord?.sourceRecord || null;

                let record = records.find(item =>
                    builderDisplayChannelId(guild, item) === String(channelId) &&
                    String(item.messageId) === String(messageId) &&
                    Number(item.embedIndex || 0) === embedIndex,
                );`,
      'selected live preview lookup',
    );

    text = replaceOnce(
      text,
      '                let loaded = record ? loadRecordSnapshotIntoState(state, guild, record) : false;',
      '                let loaded = record ? loadRecordSnapshotIntoState(state, guild, record, previewRecord, sourceRecord) : false;',
      'selected live preview load',
    );

    text = text.replace(
      '&& loadRecordSnapshotIntoState(state, interaction.guild, pendingSearch.record)',
      '&& loadRecordSnapshotIntoState(\n'
        + '                    state,\n'
        + '                    interaction.guild,\n'
        + '                    pendingSearch.record,\n'
        + '                    pendingSearch.previewRecord || null,\n'
        + '                    pendingSearch.sourceRecord || pendingSearch.record?.sourceRecord || null,\n'
        + '                )',
    );

    const saveMarker = 'function applyStateToExistingEmbed(state) {';
    const saveHelpers = `function capturedDynamicValues(templateText, liveText) {
    const template = String(templateText || '');
    const live = String(liveText || '');
    if (!template.includes('{dynamic}')) return [];

    const parts = template.split('{dynamic}');
    if (parts[0] && !live.startsWith(parts[0])) return [];

    const values = [];
    let cursor = parts[0].length;

    for (let index = 1; index < parts.length; index += 1) {
        const literal = parts[index];
        if (index === parts.length - 1 && !literal) {
            values.push(live.slice(cursor));
            cursor = live.length;
            continue;
        }

        const nextIndex = live.indexOf(literal, cursor);
        if (nextIndex === -1) return [];
        values.push(live.slice(cursor, nextIndex));
        cursor = nextIndex + literal.length;
    }

    return cursor === live.length ? values : [];
}

function restoreDynamicTemplateText(templateText, liveText, editedText) {
    const template = String(templateText || '');
    const live = String(liveText || '');
    const edited = String(editedText || '');

    if (!template.includes('{dynamic}')) return edited;
    if (edited === live) return template;

    const values = capturedDynamicValues(template, live);
    if (!values.length) return edited;

    let restored = edited;
    for (const value of values) {
        if (!value) continue;
        const index = restored.indexOf(value);
        if (index === -1) continue;
        restored = restored.slice(0, index) + '{dynamic}' + restored.slice(index + value.length);
    }
    return restored;
}

`;
    text = replaceOnce(text, saveMarker, saveHelpers + saveMarker, 'dynamic save helpers');

    text = replaceOnce(
      text,
      `    } else {
        delete data.fields;
    }
    data.color = state.sideColor;`,
      `    } else {
        delete data.fields;
    }

    const previewSource = target?.previewSourceData;
    const templateSource = target?.templateSourceData || target?.sourceEmbedData;
    if (previewSource && templateSource) {
        if (data.title && templateSource.title) {
            data.title = restoreDynamicTemplateText(templateSource.title, previewSource.title, data.title).slice(0, 256);
        }
        if (data.description && templateSource.description) {
            data.description = restoreDynamicTemplateText(
                templateSource.description,
                previewSource.description,
                data.description,
            ).slice(0, 4096);
        }
        if (Array.isArray(data.fields) && Array.isArray(templateSource.fields)) {
            data.fields = data.fields.map((field, index) => {
                const templateField = templateSource.fields[index] || {};
                const liveField = previewSource.fields?.[index] || {};
                return {
                    ...field,
                    name: templateField.name
                        ? restoreDynamicTemplateText(templateField.name, liveField.name, field.name).slice(0, 256)
                        : field.name,
                    value: templateField.value
                        ? restoreDynamicTemplateText(templateField.value, liveField.value, field.value).slice(0, 1024)
                        : field.value,
                };
            });
        }
    }

    data.color = state.sideColor;`,
      'restore dynamic slots on save',
    );

    text = replaceOnce(
      text,
      `    state.modifyTarget.sourceEmbedData = current;
    state.modifyTarget.cachedMessage = edited;`,
      `    state.modifyTarget.sourceEmbedData = current;
    if (state.modifyTarget.previewSourceData) {
        const nextPreview = { ...state.modifyTarget.previewSourceData };
        if (state.title) nextPreview.title = state.title;
        else delete nextPreview.title;
        if (state.message) nextPreview.description = state.message;
        else delete nextPreview.description;
        nextPreview.fields = Array.isArray(state.embedFields)
            ? state.embedFields.map(field => ({ ...field }))
            : [];
        state.modifyTarget.previewSourceData = nextPreview;
    }
    state.modifyTarget.cachedMessage = edited;`,
      'refresh live preview baseline after save',
    );

    if (!text.includes('export function collapseDisplayRecords(')) {
      text = text.replace(
        'function collapseDisplayRecords(channelRecords, channelId = null) {',
        'export function collapseDisplayRecords(channelRecords, channelId = null) {',
      );
    }

    fs.writeFileSync(path, text, 'utf8');
    console.log('[BUILDER_HUMAN_PREVIEW] human names and live dynamic previews patched');
  } else {
    console.log('[BUILDER_HUMAN_PREVIEW] manager already current');
  }
}
