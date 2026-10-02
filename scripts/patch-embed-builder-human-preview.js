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
    return 'Untitled embed';
}

// BUILDER_HUMAN_NAMES_V1
`;
    text = replaceOnce(text, identityMarker, helper + identityMarker, 'human record names');

    if (text.includes("if (stableKey && !stableKey.startsWith('embed:')) return stableKey;")) {
      text = text.replace(
        "if (stableKey && !stableKey.startsWith('embed:')) return stableKey;",
        "if (stableKey && !/^(?:embed|source):/i.test(stableKey)) return stableKey;",
      );
    }

    text = replaceOnce(
      text,
      '    const titleShape = dynamicTemplateText(title);',
      "    const titleShape = isTechnicalBuilderLabel(title) ? '' : dynamicTemplateText(title);",
      'ignore technical titles for identity',
    );

    if (text.includes('standardDynamicTemplateName(rawName)')) {
      text = text.replaceAll('standardDynamicTemplateName(rawName)', 'humanTemplateRecordName(record)');
    } else if (!text.includes('humanTemplateRecordName(record)')) {
      throw new Error('[BUILDER_HUMAN_PREVIEW] human menu label marker not found');
    }

    const displayEmojiMarker = `        const displayEmojiSource = group.records
            .map(record => recordEmbedData(record).title || record.title || record.name || '')
            .find(value => customEmojiOption(value)) || '';`;
    text = replaceOnce(
      text,
      displayEmojiMarker,
      `        const previewRecord = realRecords.at(-1) || representative;
${displayEmojiMarker}`,
      'live preview record',
    );

    text = replaceOnce(
      text,
      `            displayEmojiSource,
            duplicateCount: group.records.length,`,
      `            displayEmojiSource,
            previewRecord,
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
      const loaderBlock = `export function loadRecordSnapshotIntoState(state, guild, record, previewRecord = null) {
    const snapshot = getEmbedRegistrySnapshot(record);
    if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) return false;

    const data = migrateCloudyLogoEmbedData(snapshot).data || {};
    const previewSnapshot = previewRecord ? getEmbedRegistrySnapshot(previewRecord) : null;
    const previewData = previewSnapshot && typeof previewSnapshot === 'object' && Object.keys(previewSnapshot).length
        ? (migrateCloudyLogoEmbedData(previewSnapshot).data || {})
        : null;
    const displayTitle = previewData?.title || data.title;
    const displayDescription = previewData?.description ?? data.description;
    const displayFields = Array.isArray(previewData?.fields) && previewData.fields.length
        ? previewData.fields
        : data.fields;
    const footerText = cleanFooter(data.footer?.text || '');
    const logicalChannelId = String(record.channelId || '');
    const backingChannelId = String(record.backingChannelId || record.channelId || '');
    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);
    const templateKind = stableSystemTemplateKind(data);

    state.title = templateKind === 'content' ? null : (displayTitle || null);
    state.message = displayDescription || null;
    state.embedFields = Array.isArray(displayFields)
        ? displayFields.map(field => ({
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
        previewSourceData: previewData,
        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),
        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),
        templateKind,
        catalogTitle: data.title || null,
        cachedMessage: null,
    };
    return true;
}
`;

      text = text.slice(0, replaceStart) + loaderBlock + text.slice(loaderEnd);
    }

    const selectedMarker = `                let record = records.find(item =>
                    String(item.channelId) === String(channelId) &&
                    String(item.messageId) === String(messageId) &&
                    Number(item.embedIndex || 0) === embedIndex,
                );`;
    text = replaceOnce(
      text,
      selectedMarker,
      `                const selectedDisplayRecord = collapseDisplayRecords(
                    records.filter(item => String(item.channelId) === String(channelId)),
                    channelId,
                ).find(item =>
                    String(item.messageId) === String(messageId)
                    && Number(item.embedIndex || 0) === embedIndex
                );
                const previewRecord = selectedDisplayRecord?.previewRecord || null;

${selectedMarker}`,
      'selected live preview lookup',
    );

    text = replaceOnce(
      text,
      '                let loaded = record ? loadRecordSnapshotIntoState(state, guild, record) : false;',
      '                let loaded = record ? loadRecordSnapshotIntoState(state, guild, record, previewRecord) : false;',
      'selected live preview load',
    );

    text = text.replace(
      '&& loadRecordSnapshotIntoState(state, interaction.guild, pendingSearch.record)',
      '&& loadRecordSnapshotIntoState(state, interaction.guild, pendingSearch.record, pendingSearch.previewRecord || null)',
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
    const templateSource = target?.sourceEmbedData;
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

    fs.writeFileSync(path, text, 'utf8');
    console.log('[BUILDER_HUMAN_PREVIEW] human names and live dynamic previews patched');
  } else {
    console.log('[BUILDER_HUMAN_PREVIEW] manager already current');
  }
}
