import fs from 'node:fs';

function patchFile(path, transforms, marker) {
  const before = fs.readFileSync(path, 'utf8');
  let text = before;
  if (text.includes(marker)) {
    console.log(`[CONTENT_TEMPLATE_EDITOR] ${path}=current`);
    return;
  }

  for (const { find, replace, label } of transforms) {
    if (!text.includes(find)) {
      console.error(`[CONTENT_TEMPLATE_EDITOR] ${path}: marker not found (${label})`);
      process.exit(1);
    }
    text = text.replace(find, replace);
  }

  if (!text.includes(marker)) {
    console.error(`[CONTENT_TEMPLATE_EDITOR] ${path}: final marker missing`);
    process.exit(1);
  }
  fs.writeFileSync(path, text, 'utf8');
  console.log(`[CONTENT_TEMPLATE_EDITOR] ${path}=patched`);
}

patchFile('src/services/embedManagerService.js', [
  {
    label: 'template kind parser',
    find: `function curatedGameTemplateContext(templateKey) {`,
    replace: `function stableSystemTemplateKind(value) {
    const data = value && typeof value === 'object' ? value : {};
    const authorName = String(data.author?.name || '').trim();
    if (!authorName.toLowerCase().startsWith('cloudy template key:')) return 'embed';
    const match = authorName.match(/\\|\\|\\s*Cloudy kind:\\s*([^|]+)/i);
    const kind = String(match?.[1] || 'embed').replace(/\\s+/g, ' ').trim().toLowerCase();
    return kind === 'content' ? 'content' : 'embed';
}

// CONTENT_TEMPLATE_EDITOR_V1: a plain response has a management name, not a Discord embed title.
function curatedGameTemplateContext(templateKey) {`,
  },
  {
    label: 'snapshot kind',
    find: `    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);

    state.title = data.title || null;`,
    replace: `    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);
    const templateKind = stableSystemTemplateKind(data);

    state.title = templateKind === 'content' ? null : (data.title || null);`,
  },
  {
    label: 'snapshot target metadata',
    find: `        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),
        cachedMessage: null,`,
    replace: `        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),
        templateKind,
        catalogTitle: data.title || null,
        cachedMessage: null,`,
  },
  {
    label: 'resolved kind',
    find: `    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);

    state.title = data.title || null;`,
    replace: `    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);
    const templateKind = stableSystemTemplateKind(data);

    state.title = templateKind === 'content' ? null : (data.title || null);`,
  },
  {
    label: 'resolved target metadata',
    find: `        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),
        cachedMessage: message,`,
    replace: `        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),
        templateKind,
        catalogTitle: data.title || null,
        cachedMessage: message,`,
  },
  {
    label: 'preserve content management title on save',
    find: `    if (state.title) data.title = state.title.slice(0, 256);
    else delete data.title;
    if (state.message) data.description = normalizeManualIndent(state.message).slice(0, 4096);`,
    replace: `    if (target?.templateKind === 'content') {
        if (target.catalogTitle) data.title = String(target.catalogTitle).slice(0, 256);
        else if (!data.title) data.title = 'Message';
    } else if (state.title) data.title = state.title.slice(0, 256);
    else delete data.title;
    if (state.message) data.description = normalizeManualIndent(state.message).slice(0, 4096);`,
  },
  {
    label: 'preserve peer content management title',
    find: `    if (state.title) data.title = mergeDynamicTemplateText(source.title, state.title, peerData.title).slice(0, 256);
    else delete data.title;

    if (state.message) data.description = mergeTemplateDescription(source.description, state.message, peerData.description);`,
    replace: `    if (target?.templateKind === 'content') {
        if (peerData.title) data.title = peerData.title;
        else if (target.catalogTitle) data.title = String(target.catalogTitle).slice(0, 256);
    } else if (state.title) data.title = mergeDynamicTemplateText(source.title, state.title, peerData.title).slice(0, 256);
    else delete data.title;

    if (state.message) data.description = mergeTemplateDescription(source.description, state.message, peerData.description);`,
  },
], 'CONTENT_TEMPLATE_EDITOR_V1');

patchFile('src/commands/Tools/embedbuilder.js', [
  {
    label: 'expose template kind to web editor',
    find: `                getEditorState: () => ({
                    title: state.title || '',
                    message: state.message || '',
                    footer: state.bottomLine || '',
                    fields: Array.isArray(state.embedFields) ? state.embedFields : [],
                }),`,
    replace: `                getEditorState: () => ({
                    title: state.title || '',
                    message: state.message || '',
                    footer: state.bottomLine || '',
                    fields: Array.isArray(state.embedFields) ? state.embedFields : [],
                    templateKind: state.modifyTarget?.templateKind || 'embed', // CONTENT_TEMPLATE_EDITOR_V1
                }),`,
  },
], 'CONTENT_TEMPLATE_EDITOR_V1');

patchFile('src/services/embedColorPickerSessionService.js', [
  {
    label: 'sanitize template kind',
    find: `        fields: Array.isArray(value.fields)
            ? value.fields.slice(0, 25).map(field => ({
                name: typeof field?.name === 'string' ? field.name.slice(0, 256) : '',
                value: typeof field?.value === 'string' ? field.value.slice(0, 1024) : '',
                inline: Boolean(field?.inline),
            }))
            : [],
    };`,
    replace: `        fields: Array.isArray(value.fields)
            ? value.fields.slice(0, 25).map(field => ({
                name: typeof field?.name === 'string' ? field.name.slice(0, 256) : '',
                value: typeof field?.value === 'string' ? field.value.slice(0, 1024) : '',
                inline: Boolean(field?.inline),
            }))
            : [],
        templateKind: value.templateKind === 'content' ? 'content' : 'embed', // CONTENT_TEMPLATE_EDITOR_V1
    };`,
  },
], 'CONTENT_TEMPLATE_EDITOR_V1');

patchFile('src/web/embedColorPickerPage.js', [
  {
    label: 'content-only editor mode',
    find: `          const data = JSON.parse(raw || '{}');
          titleInput.value = data.title || '';
          messageInput.value = data.message || '';`,
    replace: `          const data = JSON.parse(raw || '{}');
          const plainResponseTemplate = data.templateKind === 'content'; // CONTENT_TEMPLATE_EDITOR_V1
          if (plainResponseTemplate && mode === 'content') {
            const titleRow = titleInput.previousElementSibling;
            titleRow?.classList.add('hidden');
            titleEditor.classList.add('hidden');
            document.getElementById('editorTitle').textContent = 'Edit message';
            document.getElementById('editorDescription').textContent = 'Edit the bot response here. The template name is internal and is not duplicated into the Discord message.';
            activeField = messageEditor;
          }
          titleInput.value = data.title || '';
          messageInput.value = data.message || '';`,
  },
], 'CONTENT_TEMPLATE_EDITOR_V1');

console.log('[CONTENT_TEMPLATE_EDITOR] complete');
