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
    const groups = new Map();

    for (const rawRecord of records || []) {
        const record = sourceResolvedSearchRecord(rawRecord);
        const channelId = String(record?.channelId || '');
        if (!channelId) continue;
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }

    const output = [];
    for (const [channelId, channelRecords] of groups.entries()) {
        // Preserve the proven canonical grouping/Save-target behavior first.
        const collapsed = collapseDisplayRecords(channelRecords, channelId);
        output.push(...collapsed);

        // Search is broader than the channel browser: add records that the
        // channel-specific collapse intentionally hides, but only when their
        // visible Search identity is not already represented.
        const represented = new Set(
            collapsed.map(record => normalize(recordTitle(record))).filter(Boolean)
        );

        for (const record of channelRecords) {
            const visibleKey = normalize(recordTitle(record));
            if (!visibleKey || represented.has(visibleKey)) continue;
            output.push(record);
            represented.add(visibleKey);
        }
    }

    return output;
}`;

if (!text.includes(oldDisplay)) {
  throw new Error('[BUILDER_SEARCH_ALL] Search display block missing');
}
text = text.replace(oldDisplay, newDisplay);

fs.writeFileSync(path, text);
console.log('[BUILDER_SEARCH_ALL] Search includes hidden unique records while preserving canonical grouping.');
