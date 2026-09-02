import fs from 'node:fs';

// Final Embed Builder integrity pass. This runs after the older compatibility
// patches and deliberately touches only registry placement and Builder browse /
// preview identity. Game engines, Save semantics, dynamic values and logos stay
// untouched.

const registryPath = 'src/services/embedRegistryService.js';
const registryBefore = fs.readFileSync(registryPath, 'utf8');
let registryText = registryBefore;

// A generic `tickets/...` context is not a ticket log. Old code sent every
// ticket dashboard/panel/debug/contact response into #ticket-logs. Specific
// contact/panel routing runs before this; everything else remains in its real
// catalog scope unless it is an actual ticket event.
registryText = registryText.replace(
    "        tickets: ['ticket-logs', 'ticket-panel', 'tickets'],",
    "        tickets: [],",
);

registryText = registryText.replace(
`    {
        match: /\\b(ticket|transcript|claim ticket|close ticket|reopen ticket)\\b/i,
        channelSlugs: ['ticket-logs', 'ticket-panel', 'tickets'],
    },`,
`    {
        match: /\\b(?:ticket\\s+(?:created|claimed|unclaimed|closed|deleted|pinned|unpinned)|priority updated|transcript generated|feedback received)\\b/i,
        channelSlugs: ['ticket-logs'],
    },`,
);

if (registryText !== registryBefore) fs.writeFileSync(registryPath, registryText);
console.log(`[EMBED_BUILDER_INTEGRITY] ${registryText === registryBefore ? 'registry already current' : 'removed broad ticket-to-logs routing'}`);

const managerPath = 'src/services/embedManagerService.js';
const managerBefore = fs.readFileSync(managerPath, 'utf8');
let managerText = managerBefore;

managerText = managerText.replace(
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds } from './embedMissingChannelService.js';",
    "import { discoverMissingChannelEmbed, discoverMissingChannelEmbeds, discoverRecentChannelEmbeds } from './embedMissingChannelService.js';",
);

if (!managerText.includes('function strictTicketLogTemplate(value)')) {
    const marker = 'function isLegacyTicketLog(value) {';
    const start = managerText.indexOf(marker);
    if (start === -1) throw new Error('Ticket-log canonicalization helper was not found.');
    const nextMarker = '\n\nexport function templateIdentity';
    const end = managerText.indexOf(nextMarker, start);
    if (end === -1) throw new Error('Template identity marker was not found after ticket helpers.');

    const helper = `

function strictTicketLogTemplate(value) {
    const data = value && typeof value === 'object' ? value : {};
    const fields = ticketLogFieldNames(data);
    const title = normalizedTicketLogTitle(data.title);

    // Prefer structural fields whenever the snapshot is already warm.
    if (fields.has('ticket')) {
        if (fields.has('unclaimed by')) return { key: 'unclaim', label: 'Ticket unclaimed' };
        if (fields.has('claimed by')) return { key: 'claim', label: 'Ticket claimed' };
        if (fields.has('closed by')) return { key: 'close', label: 'Ticket closed' };
        if (fields.has('deleted by')) return { key: 'delete', label: 'Ticket deleted' };
        if (fields.has('unpinned by')) return { key: 'unpin', label: 'Ticket unpinned' };
        if (fields.has('pinned by')) return { key: 'pin', label: 'Ticket pinned' };
        if (fields.has('rating')) return { key: 'feedback', label: 'Feedback received' };
        if (fields.has('priority')) return { key: 'priority', label: 'Priority updated' };
        if (fields.has('creator') && fields.has('messages')) return { key: 'transcript', label: 'Transcript generated' };
        if (fields.has('creator') && fields.has('channel')) return { key: 'open', label: 'Ticket created' };
    }

    // Registry rows survive restarts while the in-memory snapshot cache does
    // not. Exact canonical event titles are therefore an equally safe fallback
    // for the first paint. No generic "ticket" matching is allowed here.
    const exact = new Map([
        ['ticket created', { key: 'open', label: 'Ticket created' }],
        ['ticket claimed', { key: 'claim', label: 'Ticket claimed' }],
        ['ticket unclaimed', { key: 'unclaim', label: 'Ticket unclaimed' }],
        ['ticket closed', { key: 'close', label: 'Ticket closed' }],
        ['ticket deleted', { key: 'delete', label: 'Ticket deleted' }],
        ['ticket pinned', { key: 'pin', label: 'Ticket pinned' }],
        ['ticket unpinned', { key: 'unpin', label: 'Ticket unpinned' }],
        ['priority updated', { key: 'priority', label: 'Priority updated' }],
        ['transcript generated', { key: 'transcript', label: 'Transcript generated' }],
        ['feedback received', { key: 'feedback', label: 'Feedback received' }],
    ]);
    return exact.get(title) || null;
}

function isTicketLogsBuilderChannel(guild, channelId) {
    const channel = guild?.channels?.cache?.get?.(String(channelId)) || null;
    const name = normalizedTicketLogTitle(channel?.name || '');
    return /^ticket(?:-|\\s)*logs?$/.test(name);
}

function builderRecordsForChannel(guild, channelId, records) {
    const list = Array.isArray(records) ? records : [];
    if (!isTicketLogsBuilderChannel(guild, channelId)) return list;
    return list.filter(record => Boolean(strictTicketLogTemplate(recordEmbedData(record))));
}
`;
    managerText = managerText.slice(0, end) + helper + managerText.slice(end);
}

// The support assistant is one editable response type. Different source
// definitions or historical rows with the same visible assistant title must not
// become multiple menu entries or multiple Save identities.
managerText = managerText.replace(
`    const ticketLog = canonicalTicketLogTemplate(data);
    if (ticketLog) return \`ticket-log:\${ticketLog.key}\`;
    const stableKey = stableSystemTemplateKey(data);`,
`    const ticketLog = canonicalTicketLogTemplate(data);
    if (ticketLog) return \`ticket-log:\${ticketLog.key}\`;
    const visibleTitle = stripCustomEmojiMarkup(data.title || '');
    if (/^cloudy(?: support)? assistant$/i.test(visibleTitle)) return 'cloudy-assistant';
    const stableKey = stableSystemTemplateKey(data);`,
);

// Channel counts and channel contents must use exactly the same filtering.
managerText = managerText.replaceAll(
    'collapseDisplayRecords(group.records, group.channelId)',
    'collapseDisplayRecords(builderRecordsForChannel(guild, group.channelId, group.records), group.channelId)',
);

managerText = managerText.replace(
`    const channelRecords = records
        .filter(record => String(record.channelId) === String(channelId))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));`,
`    const rawChannelRecords = records
        .filter(record => String(record.channelId) === String(channelId))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const channelRecords = builderRecordsForChannel(guild, channelId, rawChannelRecords);`,
);

// Live channel switching only reads Discord's newest page plus cache. Exhaustive
// history walks are recovery work, never interaction work.
const channelStartMarker = "                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {";
const channelEndMarker = "                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {";
const channelStart = managerText.indexOf(channelStartMarker);
const channelEnd = channelStart === -1 ? -1 : managerText.indexOf(channelEndMarker, channelStart);
if (channelStart === -1 || channelEnd === -1) throw new Error('Embed Manager channel-selection block was not found.');
let channelBlock = managerText.slice(channelStart, channelEnd);
channelBlock = channelBlock.replace('const discoveredRecords = await discoverMissingChannelEmbeds(', 'const discoveredRecords = await discoverRecentChannelEmbeds(');
managerText = managerText.slice(0, channelStart) + channelBlock + managerText.slice(channelEnd);

if (!managerText.includes('discoverRecentChannelEmbeds(')) {
    throw new Error('Fast channel discovery was not applied to the Embed Manager.');
}
if (!managerText.includes('builderRecordsForChannel(guild, channelId, rawChannelRecords)')) {
    throw new Error('Strict Builder channel filtering was not applied.');
}

if (managerText !== managerBefore) fs.writeFileSync(managerPath, managerText);
console.log(`[EMBED_BUILDER_INTEGRITY] ${managerText === managerBefore ? 'manager already current' : 'patched strict ticket logs + fast preview discovery + Cloudy Assistant dedupe'}`);
