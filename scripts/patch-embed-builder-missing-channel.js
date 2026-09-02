import fs from 'node:fs';

const path = 'src/services/embedManagerService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

// Keep the runtime patch narrow: only the Embed Manager discovery/selection
// path is changed. Save, templates, games and logo handling stay untouched.
if (text.includes("import { discoverMissingChannelEmbed } from './embedMissingChannelService.js';")) {
  text = text.replace(
    "import { discoverMissingChannelEmbed } from './embedMissingChannelService.js';",
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
  );
} else if (!text.includes('discoverMissingChannelEmbeds')) {
  text = text.replace(
    "import { saveEmbedTemplateDecoration } from './embedTemplateService.js';",
    "import { saveEmbedTemplateDecoration } from './embedTemplateService.js';\nimport { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
  );
}

if (!text.includes('discardPendingEmbedEditorUpdates')) {
  text = text.replace(
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';\nimport { discardPendingEmbedEditorUpdates } from './embedColorPickerSessionService.js';",
  );
}

// Session-only discovery records carry their own embed snapshot. Prefer that
// snapshot so every discovered embed can render immediately without requiring
// a persistent registry write first.
text = text.replace(
  "const snapshot = migrateCloudyLogoEmbedData(getEmbedRegistrySnapshot(record) || {}).data || {};",
  "const snapshot = migrateCloudyLogoEmbedData(record?.snapshot || getEmbedRegistrySnapshot(record) || {}).data || {};",
);
text = text.replace(
  "const snapshot = getEmbedRegistrySnapshot(record);\n    if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) return false;",
  "const snapshot = record?.snapshot || getEmbedRegistrySnapshot(record);\n    if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) return false;",
);

// Historical ticket logs changed titles several times. Their field layout is
// stable, so identify the event by fields and show exactly one current entry
// per ticket-log type without turning ticket history into a template.
if (!text.includes('function canonicalTicketLogTemplate(value)')) {
  const marker = 'export function templateIdentity(channelId, value) {';
  const helper = `function canonicalTicketLogTemplate(value) {
    const data = value && typeof value === 'object' ? value : {};
    const fields = new Set((Array.isArray(data.fields) ? data.fields : [])
        .map(field => String(field?.name || '').replace(/<a?:[^:>]+:\\d+>/g, ' ').replace(/[^a-z0-9&\\s-]/gi, ' ').replace(/\\s+/g, ' ').trim().toLowerCase())
        .filter(Boolean));
    if (!fields.has('ticket')) return null;

    const definitions = [
        ['claim', 'Ticket claimed', 'claimed by'],
        ['unclaim', 'Ticket unclaimed', 'unclaimed by'],
        ['close', 'Ticket closed', 'closed by'],
        ['delete', 'Ticket deleted', 'deleted by'],
        ['pin', 'Ticket pinned', 'pinned by'],
        ['unpin', 'Ticket unpinned', 'unpinned by'],
        ['priority', 'Priority updated', 'priority'],
        ['feedback', 'Feedback received', 'rating'],
    ];
    for (const [key, label, field] of definitions) {
        if (fields.has(field)) return { key, label };
    }

    if (fields.has('creator') && fields.has('messages')) return { key: 'transcript', label: 'Transcript generated' };
    if (fields.has('creator') && fields.has('channel')) return { key: 'open', label: 'Ticket created' };
    return null;
}

`;
  if (!text.includes(marker)) throw new Error('Embed Manager template identity marker was not found.');
  text = text.replace(marker, helper + marker);
}

text = text.replace(
`export function templateIdentity(channelId, value) {
    const data = value && typeof value === 'object' ? value : { title: value };
    const stableKey = stableSystemTemplateKey(data);`,
`export function templateIdentity(channelId, value) {
    const data = value && typeof value === 'object' ? value : { title: value };
    const ticketLog = canonicalTicketLogTemplate(data);
    if (ticketLog) return \`ticket-log:\${ticketLog.key}\`;
    const stableKey = stableSystemTemplateKey(data);`,
);

text = text.replace(
`    for (const record of channelRecords) {
        const rawName = recordName(record);
        const rule = strictTemplateMode
            ? getChannelTemplateRule(channelId, rawName)
            : getTemplateRule(channelId, rawName);`,
`    for (const record of channelRecords) {
        const rawName = recordName(record);
        const recordData = recordEmbedData(record);
        const ticketLog = canonicalTicketLogTemplate(recordData);
        if (ticketLog) {
            const key = \`ticket-log:\${ticketLog.key}\`;
            if (!groups.has(key)) groups.set(key, {
                label: ticketLog.label,
                records: [],
                templateMode: false,
                preventTemplateMode: true,
            });
            groups.get(key).records.push(record);
            continue;
        }

        const rule = strictTemplateMode
            ? getChannelTemplateRule(channelId, rawName)
            : getTemplateRule(channelId, rawName);`,
);

text = text.replace(
  "templateMode: Boolean(group.templateMode) || group.records.length > 1 || representative.source === 'system-catalog',",
  "templateMode: group.preventTemplateMode ? false : (Boolean(group.templateMode) || group.records.length > 1 || representative.source === 'system-catalog'),",
);

// Preserve latest-wins interaction handling. Never serialize rapid selections
// behind an older Discord/API request.
if (text.includes('session.queue = session.queue.then(async () => {')) {
  text = text.replace(
`            session.queue = session.queue.then(async () => {
                if (session.closed || state.activeEmbedManager !== session) return;`,
`            const selectionVersion = (session.selectionVersion || 0) + 1;
            session.selectionVersion = selectionVersion;
            discardPendingEmbedEditorUpdates(state.colorSessionToken);

            void (async () => {
                if (session.closed || state.activeEmbedManager !== session) return;
                if (selectionVersion !== session.selectionVersion) return;`);

  text = text.replace(
`            }).catch(error => {
                logger.error('Embed manager selection failed:', error);
            });

            await session.queue;`,
`            })().catch(error => {
                logger.error('Embed manager selection failed:', error);
            });`);
}

// Selecting a channel only discovers/populates its complete embed list. It must
// not push an arbitrary first embed into the live preview, because that creates
// stale preview edits when the user immediately chooses another embed.
const channelStartMarker = "                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {";
const channelEndMarker = "                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {";
const channelStart = text.indexOf(channelStartMarker);
const channelEnd = channelStart === -1 ? -1 : text.indexOf(channelEndMarker, channelStart);

if (channelStart === -1 || channelEnd === -1) {
  throw new Error('Embed Manager channel-selection block was not found.');
}

const channelBlock = `                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
                    const discoveredRecords = await discoverMissingChannelEmbeds(
                        guild,
                        channelId,
                        buttonInteraction.client.user.id,
                    ).catch(error => {
                        logger.debug(\`On-demand channel embed discovery skipped: \${error?.message || error}\`);
                        return [];
                    });

                    if (selectionVersion !== session.selectionVersion) return;

                    if (discoveredRecords.length) {
                        const otherChannelRecords = records.filter(record =>
                            String(record.channelId) !== String(channelId)
                            || String(record.source || '') === 'system-catalog'
                        );
                        const existingCatalogRecords = records.filter(record =>
                            String(record.channelId) === String(channelId)
                            && String(record.source || '') === 'system-catalog'
                        );

                        // Session-only discovery replaces stale real-message rows
                        // for this channel. Nothing is written back to the registry,
                        // so old history cannot accumulate as permanent clones.
                        records = [
                            ...otherChannelRecords,
                            ...existingCatalogRecords.filter(record => !otherChannelRecords.includes(record)),
                            ...discoveredRecords,
                        ];
                    }

                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }

`;

text = text.slice(0, channelStart) + channelBlock + text.slice(channelEnd);

// Any async record resolve belongs only to the selection that started it.
text = text.replace(
`                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (!resolved) {`,
`                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (selectionVersion !== session.selectionVersion) return;
                    if (!resolved) {`);

text = text.replaceAll(
`                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(`,
`                    records = await getEmbedRegistry(guild.id);
                    if (selectionVersion !== session.selectionVersion) return;
                    await updateEmbedManager(`);

if (text !== before) fs.writeFileSync(path, text);
console.log(`[EMBED_BUILDER_MISSING] ${text === before ? 'already current' : 'patched complete discovery + ticket dedupe + latest-wins preview'}`);
