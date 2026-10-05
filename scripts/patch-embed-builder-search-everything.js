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
    const resolved = (records || [])
        .map(record => sourceResolvedSearchRecord(record))
        .filter(record => record?.messageId);

    // The live Search path receives canonical Builder records. Those records
    // are already one reusable response type each, so channel-specific browser
    // filtering must not hide any of them.
    if (resolved.some(record => record?.canonicalIdentity)) {
        const unique = new Map();
        for (const record of resolved) {
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
    }

    // Raw/legacy callers still need the existing peer collapse so the correct
    // catalog master remains the Save target and repeated runtime examples do
    // not become duplicate Search results.
    const groups = new Map();
    for (const record of resolved) {
        const channelId = String(record?.channelId || '');
        if (!channelId) continue;
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }

    return [...groups.entries()].flatMap(([channelId, channelRecords]) =>
        collapseDisplayRecords(channelRecords, channelId)
    );
}`;

if (!text.includes(oldDisplay)) {
  throw new Error('[BUILDER_SEARCH_ALL] Search display collapse block missing');
}
text = text.replace(oldDisplay, newDisplay);

fs.writeFileSync(path, text);
console.log('[BUILDER_SEARCH_ALL] Search indexes every canonical record while preserving logical duplicate grouping.');
