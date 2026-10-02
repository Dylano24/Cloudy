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

    text = replaceOnce(
      text,
      'function loadRecordSnapshotIntoState(state, guild, record) {',
      'function loadRecordSnapshotIntoState(state, guild, record, previewRecord = null) {',
      'loader signature',
    );

    text = replaceOnce(
      text,
      `    const data = migrateCloudyLogoEmbedData(snapshot).data || {};
    const footerText = cleanFooter(data.footer?.text || '');`,
      `    const data = migrateCloudyLogoEmbedData(snapshot).data || {};
    const previewSnapshot = previewRecord ? getEmbedRegistrySnapshot(previewRecord) : null;
    const previewData = previewSnapshot && typeof previewSnapshot === 'object' && Object.keys(previewSnapshot).length
        ? (migrateCloudyLogoEmbedData(previewSnapshot).data || {})
        : null;
    const displayTitle = previewData?.title || data.title;
    const displayDescription = previewData?.description ?? data.description;
    const displayFields = Array.isArray(previewData?.fields) && previewData.fields.length
        ? previewData.fields
        : data.fields;
    const footerText = cleanFooter(data.footer?.text || '');`,
      'loader live data',
    );

    text = replaceOnce(text, '    state.title = data.title || null;', '    state.title = displayTitle || null;', 'live title');
    text = replaceOnce(text, '    state.message = data.description || null;', '    state.message = displayDescription || null;', 'live description');
    text = replaceOnce(
      text,
      `    state.embedFields = Array.isArray(data.fields)
        ? data.fields.map(field => ({`,
      `    state.embedFields = Array.isArray(displayFields)
        ? displayFields.map(field => ({`,
      'live fields',
    );

    text = replaceOnce(
      text,
      `        sourceEmbedData: data,
        hadBuilderMarker:`,
      `        sourceEmbedData: data,
        previewSourceData: previewData,
        hadBuilderMarker:`,
      'retain canonical and live data',
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

    const saveMarker = 'function applyStateToExistingEmbed(state) {';
    const saveHelpers = `function escapeDynamicPattern(value) {
    return String(value || '').replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

function capturedDynamicValues(templateText, liveText) {
    const template = String(templateText || '');
    if (!/\\{dynamic\\}/i.test(template)) return [];

    const parts = template.split(/\\{dynamic\\}/gi);
    const pattern = '^' + parts.map(escapeDynamicPattern).join('([\\s\\S]+?)') + '$';
    const match = String(liveText || '').match(new RegExp(pattern, 'i'));
    return match ? match.slice(1) : [];
}

function restoreDynamicTemplateText(templateText, liveText, editedText) {
    const template = String(templateText || '');
    const live = String(liveText || '');
    const edited = String(editedText || '');

    if (!/\\{dynamic\\}/i.test(template)) return edited;
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
