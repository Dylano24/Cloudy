import fs from 'node:fs';

const path = 'src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

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

const newDisplay = `function builderSearchDisplayRecords(records) {
    // Search is intentionally broader than the channel browser. Do not apply
    // channel-specific visibility/collapse rules here: every canonical record
    // is allowed into the Search index. buildMatches still groups repeated
    // runtime peers of the same logical template into one result.
    const unique = new Map();

    for (const rawRecord of records || []) {
        const record = sourceResolvedSearchRecord(rawRecord);
        if (!record?.messageId) continue;

        const canonical = String(record?.canonicalIdentity || '').trim();
        const key = canonical
            ? 'canonical:' + canonical
            : [
                'physical',
                String(record?.channelId || ''),
                String(record?.messageId || ''),
                Number(record?.embedIndex || 0),
            ].join(':');

        unique.set(key, record);
    }

    return [...unique.values()];
}`;

if (!text.includes(oldDisplay)) {
  throw new Error('[BUILDER_SEARCH_ALL] Search display collapse block missing');
}
text = text.replace(oldDisplay, newDisplay);

fs.writeFileSync(path, text);
console.log('[BUILDER_SEARCH_ALL] Search indexes every canonical record while preserving logical duplicate grouping.');
