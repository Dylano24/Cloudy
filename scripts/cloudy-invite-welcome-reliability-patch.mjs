import fs from 'node:fs';

function patchFile(path, replacements) {
  let text = fs.readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!text.includes(before)) {
      throw new Error(`Expected block not found in ${path}: ${before.slice(0, 120)}`);
    }
    text = text.replace(before, after);
  }
  fs.writeFileSync(path, text);
}

patchFile('src/services/embedManagerService.js', [
  [
`const TEMPLATE_CHANNEL_IDS = new Set([
    '1539375620885323826',
    '1539371111240831078',
    '1539259457404412036',
    '1539372511089926244',
]);`,
`const TEMPLATE_CHANNEL_IDS = new Set([
    '1539375620885323826',
    '1539371111240831078',
    '1539259457404412036',
    '1539372511089926244',
    '1539371572442435646',
]);`],
  [
`    ['1539372511089926244', [
        { key: 'report-log', label: 'Report log', match: /\\breport(?:s)?\\s+log\\b|\\breport\\b/i },
    ]],
]);`,
`    ['1539372511089926244', [
        { key: 'report-log', label: 'Report log', match: /\\breport(?:s)?\\s+log\\b|\\breport\\b/i },
    ]],
    ['1539371572442435646', [
        { key: 'invite-created', label: 'Invite created', match: /\\binvite\\s+created\\b/i },
        { key: 'member-joined-using-invite', label: 'Member joined using invite', match: /\\bmember\\s+joined\\s+using\\s+invite\\b/i },
    ]],
]);

const GLOBAL_TEMPLATE_RULES = [
    { key: 'welcome-cloudy', label: 'Welcome to Cloudy Inc.', match: /^welcome to cloudy(?:\\s+inc\\.?)?$/i },
];`],
  [
`function getTemplateRule(channelId, value) {
    const rules = TEMPLATE_RULES.get(String(channelId)) || [];
    const cleaned = stripCustomEmojiMarkup(value);
    return rules.find(rule => rule.match.test(cleaned)) || null;
}

function templateIdentity(channelId, value) {
    const rule = getTemplateRule(channelId, value);
    return rule?.key || titleKey(stripCustomEmojiMarkup(value));
}`,
`function getChannelTemplateRule(channelId, value) {
    const rules = TEMPLATE_RULES.get(String(channelId)) || [];
    const cleaned = stripCustomEmojiMarkup(value);
    return rules.find(rule => rule.match.test(cleaned)) || null;
}

function getTemplateRule(channelId, value) {
    const cleaned = stripCustomEmojiMarkup(value);
    return getChannelTemplateRule(channelId, cleaned)
        || GLOBAL_TEMPLATE_RULES.find(rule => rule.match.test(cleaned))
        || null;
}

function getTemplateRuleByKey(channelId, key) {
    const rules = [
        ...(TEMPLATE_RULES.get(String(channelId)) || []),
        ...GLOBAL_TEMPLATE_RULES,
    ];
    return rules.find(rule => rule.key === key) || null;
}

function templateIdentity(channelId, value) {
    const rule = getTemplateRule(channelId, value);
    return rule?.key || titleKey(stripCustomEmojiMarkup(value));
}`],
  [
`function collapseDisplayRecords(channelRecords, channelId = null) {
    const templateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const groups = new Map();

    for (const record of channelRecords) {
        const rawName = recordName(record);
        if (templateMode) {
            const rule = getTemplateRule(channelId, rawName);
            if (!rule) continue;
            if (!groups.has(rule.key)) groups.set(rule.key, { label: rule.label, records: [] });
            groups.get(rule.key).records.push(record);
            continue;
        }

        const name = rawName || 'Untitled embed';
        const key = titleKey(name);
        if (!groups.has(key)) groups.set(key, { label: name, records: [] });
        groups.get(key).records.push(record);
    }

    return [...groups.values()].map(group => {
        group.records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const representative = group.records[group.records.length - 1];
        return {
            ...representative,
            name: group.label,
            duplicateCount: group.records.length,
            templateCount: group.records.length,
        };
    });
}`,
`function collapseDisplayRecords(channelRecords, channelId = null) {
    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const groups = new Map();

    for (const record of channelRecords) {
        const rawName = recordName(record);
        const rule = strictTemplateMode
            ? getChannelTemplateRule(channelId, rawName)
            : getTemplateRule(channelId, rawName);

        if (strictTemplateMode) {
            if (!rule) continue;
            if (!groups.has(rule.key)) groups.set(rule.key, { label: rule.label, records: [], templateMode: true });
            groups.get(rule.key).records.push(record);
            continue;
        }

        if (rule) {
            const key = `template:${rule.key}`;
            if (!groups.has(key)) groups.set(key, { label: rule.label, records: [], templateMode: true });
            groups.get(key).records.push(record);
            continue;
        }

        const name = rawName || 'Untitled embed';
        const key = titleKey(name);
        if (!groups.has(key)) groups.set(key, { label: name, records: [], templateMode: false });
        groups.get(key).records.push(record);
    }

    return [...groups.values()].map(group => {
        group.records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const representative = group.records[group.records.length - 1];
        return {
            ...representative,
            name: group.label,
            duplicateCount: group.records.length,
            templateCount: group.records.length,
            templateMode: Boolean(group.templateMode),
        };
    });
}`],
  [
`    const templateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const displayRecords = collapseDisplayRecords(channelRecords, channelId);`,
`    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const displayRecords = collapseDisplayRecords(channelRecords, channelId);`],
  [
`                const displayName = templateMode ? record.name : stripCustomEmojiMarkup(name);
                const description = templateMode
                    ? \`Edit this template • applies to \${record.templateCount || 1} matching embed(s)\`
                    : 'Edit this embed';`,
`                const isTemplate = Boolean(record.templateMode);
                const displayName = isTemplate ? record.name : stripCustomEmojiMarkup(name);
                const description = isTemplate
                    ? \`Edit this template • applies to \${record.templateCount || 1} matching embed(s)\`
                    : 'Edit this embed';`],
  [
`                templateMode ? \`**Templates:** \${displayRecords.length}\` : \`**Embeds:** \${displayRecords.length}\`,`,
`                strictTemplateMode ? \`**Templates:** \${displayRecords.length}\` : \`**Embeds:** \${displayRecords.length}\`,`],
  [
`                templateMode
                    ? 'Only real log templates for this channel are shown. Old unrelated embeds and duplicates are ignored.'
                    : 'Only unique embeds are shown. Duplicate and old blank registry entries are hidden.',`,
`                strictTemplateMode
                    ? 'Only real log templates for this channel are shown. Old unrelated embeds and duplicates are ignored.'
                    : 'Only unique embeds are shown. Repeated Cloudy templates are grouped automatically.',`],
  [
`    const footerText = cleanFooter(data.footer?.text || '');

    state.title = data.title || null;`,
`    const footerText = cleanFooter(data.footer?.text || '');
    const templateRule = getTemplateRule(channel.id, recordName(record) || data.title);

    state.title = data.title || null;`],
  [
`        templateMode: TEMPLATE_CHANNEL_IDS.has(String(channel.id)),
        templateTitle: templateIdentity(channel.id, data.title || recordName(record)),`,
`        templateMode: Boolean(templateRule),
        templateTitle: templateRule?.key || templateIdentity(channel.id, recordName(record) || data.title),`],
  [
`            const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData.title || recordName(record));`,
`            const peerIdentity = templateIdentity(targetSnapshot.channelId, recordName(record) || peerData.title);`],
  [
`        const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData.title || recordName(record));`,
`        const peerIdentity = templateIdentity(targetSnapshot.channelId, recordName(record) || peerData.title);`],
  [
`        const sourceRule = getTemplateRule(target.channelId, sourceData.title || target.templateTitle);
        const aliases = [sourceData.title, current.title, sourceRule?.label].filter(Boolean);`,
`        const sourceRule = getTemplateRuleByKey(target.channelId, target.templateTitle)
            || getTemplateRule(target.channelId, sourceData.title || target.templateTitle);
        const aliases = [sourceData.title, current.title, sourceRule?.label].filter(Boolean);`],
  [
`    state.modifyTarget.sourceEmbedData = current;
    state.modifyTarget.templateTitle = templateIdentity(target.channelId, current.title || target.templateTitle);`,
`    state.modifyTarget.sourceEmbedData = current;
    if (!target.templateMode) {
        state.modifyTarget.templateTitle = templateIdentity(target.channelId, current.title || target.templateTitle);
    }`],
]);

patchFile('src/services/embedRegistryService.js', [
  [
`function isCloudyWelcomeEmbed(embed) {
    const title = String(embed?.title || '').replace(/\\s+/g, ' ').trim();
    if (/^welcome to cloudy(?:\\s+inc\\.?)?$/i.test(title)) return true;

    const fieldNames = new Set((embed?.fields || []).map(field => cleanFieldName(field?.name)));
    return fieldNames.has('rules')
        && fieldNames.has('link your account')
        && fieldNames.has('subscriptions & purchases')
        && fieldNames.has('support & help');
}`,
`function embedFieldNames(embed) {
    return new Set((embed?.fields || []).map(field => cleanFieldName(field?.name)));
}

function isCloudyWelcomeEmbed(embed) {
    const title = String(embed?.title || '').replace(/\\s+/g, ' ').trim();
    if (/^welcome to cloudy(?:\\s+inc\\.?)?$/i.test(title)) return true;

    const fieldNames = embedFieldNames(embed);
    return fieldNames.has('rules')
        && fieldNames.has('link your account')
        && fieldNames.has('subscriptions & purchases')
        && fieldNames.has('support & help');
}

function isInviteCreatedEmbed(embed) {
    const fieldNames = embedFieldNames(embed);
    return fieldNames.has('created by')
        && fieldNames.has('invite')
        && fieldNames.has('channel')
        && fieldNames.has('maximum uses')
        && fieldNames.has('expires')
        && fieldNames.has('created');
}

function isInviteJoinEmbed(embed) {
    const fieldNames = embedFieldNames(embed);
    return fieldNames.has('member')
        && fieldNames.has('invited by')
        && fieldNames.has('invite')
        && fieldNames.has('invite uses')
        && fieldNames.has('account age')
        && fieldNames.has('joined server');
}`],
  [
`function embedName(embed) {
    if (isCloudyWelcomeEmbed(embed)) return 'Welcome to Cloudy Inc.';

    const title = canonicalEmbedName(embed?.title || '');`,
`function embedName(embed) {
    if (isCloudyWelcomeEmbed(embed)) return 'Welcome to Cloudy Inc.';
    if (isInviteCreatedEmbed(embed)) return 'Invite created';
    if (isInviteJoinEmbed(embed)) return 'Member joined using invite';

    const title = canonicalEmbedName(embed?.title || '');`],
  [
`export async function registerCloudyEmbedMessage(message, source = 'cloudy') {
    if (!isRegistrableCloudyEmbedMessage(message)) return false;

    try {
        const additions = message.embeds
            .map((embed, embedIndex) => {
                const addition = {
                    guildId: message.guildId,
                    channelId: message.channelId,
                    messageId: message.id,
                    embedIndex,
                    source,
                    title: embed?.title || '',
                    name: embedName(embed),
                    createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                };
                rememberEmbedSnapshot(addition, embed);
                return addition;
            })
            .filter(addition => !isInternalEmbedRecord(addition));

        if (!additions.length) return false;
        return await saveRecords(message.guildId, additions);
    } catch (error) {
        logger.error('Failed to register Cloudy embed message:', error);
        return false;
    }
}`,
`export async function registerCloudyEmbedMessages(messages, source = 'cloudy') {
    const grouped = new Map();

    try {
        for (const message of Array.isArray(messages) ? messages : []) {
            if (!isRegistrableCloudyEmbedMessage(message)) continue;

            const additions = message.embeds
                .map((embed, embedIndex) => {
                    const addition = {
                        guildId: message.guildId,
                        channelId: message.channelId,
                        messageId: message.id,
                        embedIndex,
                        source,
                        title: embed?.title || '',
                        name: embedName(embed),
                        createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                    };
                    rememberEmbedSnapshot(addition, embed);
                    return addition;
                })
                .filter(addition => !isInternalEmbedRecord(addition));

            if (!additions.length) continue;
            if (!grouped.has(message.guildId)) grouped.set(message.guildId, []);
            grouped.get(message.guildId).push(...additions);
        }

        if (!grouped.size) return false;
        await Promise.all([...grouped.entries()].map(([guildId, additions]) => saveRecords(guildId, additions)));
        return true;
    } catch (error) {
        logger.error('Failed to register Cloudy embed messages:', error);
        return false;
    }
}

export async function registerCloudyEmbedMessage(message, source = 'cloudy') {
    return registerCloudyEmbedMessages([message], source);
}`],
  [
`                    if (isInternalEmbedRecord(addition)) continue;
                    additions.push(addition);`,
`                    if (isInternalEmbedRecord(addition)) continue;
                    rememberEmbedSnapshot(addition, embed);
                    additions.push(addition);`],
]);

patchFile('src/events/guildMemberAdd.js', [
  [
`import { decorateEmbedWithSavedTemplate } from '../services/embedTemplateService.js';`,
`import { decorateEmbedWithSavedTemplate } from '../services/embedTemplateService.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';`],
  [
`                            const finalEmbed = normalizeBuiltInWelcomeMedia(decorated.embed || baseEmbed);

                            await channel.send({
                                content: ping,
                                embeds: [finalEmbed]
                            });`,
`                            const finalEmbed = decorated.matched
                                ? (decorated.embed || baseEmbed)
                                : normalizeBuiltInWelcomeMedia(baseEmbed);

                            const sentWelcome = await channel.send({
                                content: ping,
                                embeds: [finalEmbed]
                            });
                            await registerCloudyEmbedMessage(sentWelcome, 'welcome').catch(error => {
                                logger.error('Failed to register welcome embed:', error);
                            });`],
]);

patchFile('src/events/cloudyBrandingReady.js', [
  [
`import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';`,
`import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import { registerCloudyEmbedMessages } from '../services/embedRegistryService.js';`],
  [`const BRANDING_SCAN_VERSION = 1;`, `const BRANDING_SCAN_VERSION = 2;`],
  [
`    for (const message of messages.values()) {
      scanned += 1;
      if (message.author?.id !== botUserId) continue;
      if (!message.embeds?.length) continue;

      if (await normalizeCloudyMessage(message, { ensureFooter: true })) updated += 1;
    }

    before = messages.last()?.id;`,
`    const registrableMessages = [];
    for (const message of messages.values()) {
      scanned += 1;
      if (message.author?.id !== botUserId) continue;
      if (!message.embeds?.length) continue;

      if (await normalizeCloudyMessage(message, { ensureFooter: true })) updated += 1;
      registrableMessages.push(message);
    }

    if (registrableMessages.length) {
      await registerCloudyEmbedMessages(registrableMessages, 'history');
    }

    before = messages.last()?.id;`],
]);

console.log('Invite/welcome reliability patch applied.');
