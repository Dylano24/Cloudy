import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    throw new Error(`[BUILDER_SEARCH_ALL] No changes applied to ${path}; runtime shape changed.`);
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_SEARCH_ALL] ${path}: patched`);
}

patchFile('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', text => {
  const oldDisplay = `function builderSearchDisplayRecords(records) {
    const groups = new Map();

    for (const rawRecord of records || []) {
        const record = sourceResolvedSearchRecord(rawRecord);
        const channelId = String(record?.channelId || '');
        if (!channelId) continue;
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }

    return [...groups.entries()].flatMap(([channelId, channelRecords]) =>
        collapseDisplayRecords(channelRecords, channelId)
    );
}`;

  const newDisplay = `function searchRecordIdentity(record) {
    const canonical = String(record?.canonicalIdentity || '').trim();
    if (canonical) return 'canonical:' + canonical;

    const templateKey = stableSearchTemplateKey(record);
    const templateContext = stableSearchTemplateContext(record);
    if (templateKey) {
        return [
            'template',
            templateContext,
            templateKey,
            String(record?.channelId || ''),
            String(record?.messageId || ''),
            Number(record?.embedIndex || 0),
        ].join(':');
    }

    return [
        'physical',
        String(record?.channelId || ''),
        String(record?.messageId || ''),
        Number(record?.embedIndex || 0),
    ].join(':');
}

function builderSearchDisplayRecords(records) {
    // Search is intentionally broader than the channel browser. The channel
    // browser keeps its grouped/collapsed presentation; Search keeps every
    // canonical/template record so no editable response type disappears.
    const unique = new Map();

    for (const rawRecord of records || []) {
        const record = sourceResolvedSearchRecord(rawRecord);
        if (!record?.messageId) continue;
        unique.set(searchRecordIdentity(record), record);
    }

    return [...unique.values()];
}`;

  if (!text.includes(oldDisplay)) {
    throw new Error('[BUILDER_SEARCH_ALL] Search display collapse block missing');
  }
  text = text.replace(oldDisplay, newDisplay);

  const oldKey = `        const candidate = { record, document, score };
        const key = logicalKey(record, document);
        grouped.set(key, chooseBetter(grouped.get(key), candidate));`;
  const newKey = `        const candidate = { record, document, score };
        const key = searchRecordIdentity(record);
        grouped.set(key, chooseBetter(grouped.get(key), candidate));`;
  if (!text.includes(oldKey)) {
    throw new Error('[BUILDER_SEARCH_ALL] Search result grouping block missing');
  }
  text = text.replace(oldKey, newKey);

  return text;
});

patchFile('src/events/embedManagerTitleSearchReady.js', text => {
  const oldGroup = `    const logicalName = document.templateKey
      || searchKey(record?.name)
      || searchKey(record?.source)
      || \`${record.messageId}:${record.embedIndex || 0}\`;
    const groupKey = \`${record.channelId}:${logicalName}\`;
    const candidate = { record, ...document, score };
    grouped.set(groupKey, preferredRecord(grouped.get(groupKey), candidate));`;

  const newGroup = `    const canonicalIdentity = String(record?.canonicalIdentity || '').trim();
    const groupKey = canonicalIdentity
      ? \`canonical:${canonicalIdentity}\`
      : [
          'physical',
          String(record?.channelId || ''),
          String(record?.messageId || ''),
          Number(record?.embedIndex || 0),
        ].join(':');
    const candidate = { record, ...document, score };
    grouped.set(groupKey, preferredRecord(grouped.get(groupKey), candidate));`;

  if (!text.includes(oldGroup)) {
    throw new Error('[BUILDER_SEARCH_ALL] Modal Search grouping block missing');
  }
  return text.replace(oldGroup, newGroup);
});

console.log('[BUILDER_SEARCH_ALL] Search now indexes every canonical/template record without changing channel browsing.');
