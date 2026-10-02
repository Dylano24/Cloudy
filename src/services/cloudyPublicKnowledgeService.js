import { PermissionFlagsBits } from 'discord.js';
import { redactAiText } from './aiSafety.js';
import { resolveCloudyChannel } from './cloudyChannelResolver.js';
import { registerCloudyEmbedMessage } from './embedRegistryService.js';

export const CLOUDY_KNOWLEDGE_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

export const VERIFIED_CLOUDY_TEXT = Object.freeze({
  rulesLabel: 'Rules',
  rulesText: 'Check our rules',
  linkAccountLabel: 'Link your account',
  linkAccountText: 'Claim free kits, purchases & alerts',
  purchasesLabel: 'Subscriptions & Purchases',
  purchasesText: 'Cloudy Inc. website',
  supportLabel: 'Support & Help',
  supportText: 'Contact us',
});

const PUBLIC_KNOWLEDGE_CHANNEL_KEYS = Object.freeze([
  'rules',
  'settings',
  'wipes',
  'restart',
  'population',
  'terms',
  'privacy',
  'termsOfSale',
  'announcements',
  'nextWipe',
  'serverStatus',
  'votes',
  'linkYourAccount',
  'freeKits',
  'vip',
  'queueSkip',
  'contentCreator',
  'officialStore',
  'leaderboard',
  'giveaway',
  'boost',
  'informations',
  'zorp',
  'rustPatch',
  'nitradoPatch',
  'staffList',
  'contactSupport',
  'security',
  'appeal',
  'shop',
]);

function channelUrl(guildId, channelId) {
  return channelId ? `https://discord.com/channels/${guildId}/${channelId}` : null;
}

async function resolveKnowledgeChannels(client, guild) {
  const keys = [
    'rules',
    'linkYourAccount',
    'freeKits',
    'shop',
    'officialStore',
    'contactSupport',
    'informations',
  ];

  const pairs = await Promise.all(keys.map(async key => [
    key,
    await resolveCloudyChannel(client, key, { guild, textOnly: true }),
  ]));

  return Object.fromEntries(pairs);
}

function link(text, guildId, channel) {
  const url = channelUrl(guildId, channel?.id);
  return url ? `[${text}](${url})` : text;
}

export async function buildVerifiedCloudyFacts(client, guild) {
  const channels = await resolveKnowledgeChannels(client, guild);
  const purchaseDestination = channels.officialStore || channels.shop;

  return {
    source: 'Retained Cloudy templates saved before the September 18 channel deletion',
    verifiedAt: '2026-09-11T00:45:56.294Z',
    navigation: [
      {
        label: VERIFIED_CLOUDY_TEXT.rulesLabel,
        text: VERIFIED_CLOUDY_TEXT.rulesText,
        channelId: channels.rules?.id || null,
        channelName: channels.rules?.name || null,
        url: channelUrl(guild.id, channels.rules?.id),
      },
      {
        label: VERIFIED_CLOUDY_TEXT.linkAccountLabel,
        text: VERIFIED_CLOUDY_TEXT.linkAccountText,
        channelId: channels.linkYourAccount?.id || null,
        channelName: channels.linkYourAccount?.name || null,
        url: channelUrl(guild.id, channels.linkYourAccount?.id),
      },
      {
        label: VERIFIED_CLOUDY_TEXT.purchasesLabel,
        text: VERIFIED_CLOUDY_TEXT.purchasesText,
        channelId: purchaseDestination?.id || null,
        channelName: purchaseDestination?.name || null,
        url: channelUrl(guild.id, purchaseDestination?.id),
      },
      {
        label: VERIFIED_CLOUDY_TEXT.supportLabel,
        text: VERIFIED_CLOUDY_TEXT.supportText,
        channelId: channels.contactSupport?.id || null,
        channelName: channels.contactSupport?.name || null,
        url: channelUrl(guild.id, channels.contactSupport?.id),
      },
    ],
    freeKits: {
      verifiedInstruction: VERIFIED_CLOUDY_TEXT.linkAccountText,
      linkAccountChannelId: channels.linkYourAccount?.id || null,
      freeKitsChannelId: channels.freeKits?.id || null,
      note: 'No Cloudy Manager slash command for claiming free kits was verified in the retained templates, current registered commands, source history, or recovered chat context. Do not invent one.',
    },
    informationChannelId: channels.informations?.id || null,
  };
}

function contentFromMessage(message) {
  const parts = [
    message.content || '',
    ...(message.embeds || []).map(embed => [
      embed.title,
      embed.description,
      ...(embed.fields || []).map(field => `${field.name}: ${field.value}`),
    ].filter(Boolean).join('\n')),
  ];
  return redactAiText(parts.join('\n')).slice(0, 1800);
}

function questionTokens(question) {
  return String(question || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(token => token.length > 2);
}

export async function buildCloudyPublicKnowledgeEvidence(actor, request) {
  const client = actor?.client;
  const guild = actor?.guild;
  const userId = actor?.user?.id || actor?.author?.id;
  if (!client || !guild || !userId) return { text: '', count: 0, channels: 0 };

  const member = actor.member?.id === userId
    ? actor.member
    : await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  const botMember = guild.members.me
    || await guild.members.fetchMe?.({ force: true }).catch(() => null);
  if (!member || !botMember) return { text: '', count: 0, channels: 0 };

  const verified = await buildVerifiedCloudyFacts(client, guild);
  const tokens = questionTokens(request.question);
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

  const resolved = await Promise.all(PUBLIC_KNOWLEDGE_CHANNEL_KEYS.map(async key => {
    const channel = await resolveCloudyChannel(client, key, { guild, textOnly: true });
    return { key, channel };
  }));

  const rows = [];
  let readableChannels = 0;

  for (const { key, channel } of resolved) {
    if (!channel?.messages?.fetch || channel.isThread?.()) continue;
    if (!channel.permissionsFor(member)?.has(required) || !channel.permissionsFor(botMember)?.has(required)) continue;

    readableChannels += 1;
    const batch = await channel.messages.fetch({ limit: 50, cache: false }).catch(() => null);
    if (!batch?.size) continue;

    const name = String(channel.name || '').toLowerCase();
    const channelScore = tokens.reduce((score, token) => score + (name.includes(token) ? 3 : 0), 0);

    for (const message of batch.values()) {
      const text = contentFromMessage(message);
      if (!text.trim()) continue;
      const lower = text.toLowerCase();
      const score = channelScore + tokens.reduce((total, token) => total + (lower.includes(token) ? 1 : 0), 0);
      rows.push({
        key,
        channelId: channel.id,
        channelName: channel.name,
        messageId: message.id,
        text,
        score,
        createdTimestamp: Number(message.createdTimestamp || 0),
      });
    }
  }

  const hasRelevant = rows.some(row => row.score > 0);
  const selected = rows
    .filter(row => !hasRelevant || row.score > 0)
    .sort((left, right) => right.score - left.score || right.createdTimestamp - left.createdTimestamp)
    .slice(0, 40)
    .map(({ score: _score, createdTimestamp: _createdTimestamp, ...row }) => row)
    .reverse();

  const payload = {
    verifiedCloudyFacts: verified,
    readablePublicChannelMessages: selected,
    instruction: 'Answer only from these verified facts and readable public channel messages. Never invent a command, URL, product, purchase process, kit claim step, or server fact.',
  };

  let text = JSON.stringify(payload);
  while (Buffer.byteLength(text) > 12_000 && selected.length) {
    selected.shift();
    payload.readablePublicChannelMessages = selected;
    text = JSON.stringify(payload);
  }

  return { text, count: selected.length + verified.navigation.length, channels: readableChannels };
}

export async function buildRestoredKnowledgePayloads(client, guild) {
  const channels = await resolveKnowledgeChannels(client, guild);
  const purchaseDestination = channels.officialStore || channels.shop;

  const informationEmbed = {
    color: 0xFFFFFF,
    fields: [
      {
        name: VERIFIED_CLOUDY_TEXT.rulesLabel,
        value: link(VERIFIED_CLOUDY_TEXT.rulesText, guild.id, channels.rules),
        inline: false,
      },
      {
        name: VERIFIED_CLOUDY_TEXT.linkAccountLabel,
        value: link(VERIFIED_CLOUDY_TEXT.linkAccountText, guild.id, channels.linkYourAccount),
        inline: false,
      },
      {
        name: VERIFIED_CLOUDY_TEXT.purchasesLabel,
        value: link(VERIFIED_CLOUDY_TEXT.purchasesText, guild.id, purchaseDestination),
        inline: false,
      },
      {
        name: VERIFIED_CLOUDY_TEXT.supportLabel,
        value: link(VERIFIED_CLOUDY_TEXT.supportText, guild.id, channels.contactSupport),
        inline: false,
      },
    ],
    footer: { text: CLOUDY_KNOWLEDGE_FOOTER },
  };

  const accountEmbed = {
    color: 0xFFFFFF,
    fields: [{
      name: VERIFIED_CLOUDY_TEXT.linkAccountLabel,
      value: link(VERIFIED_CLOUDY_TEXT.linkAccountText, guild.id, channels.linkYourAccount),
      inline: false,
    }],
    footer: { text: CLOUDY_KNOWLEDGE_FOOTER },
  };

  const freeKitsEmbed = {
    color: 0xFFFFFF,
    fields: [{
      name: VERIFIED_CLOUDY_TEXT.linkAccountLabel,
      value: link(VERIFIED_CLOUDY_TEXT.linkAccountText, guild.id, channels.linkYourAccount),
      inline: false,
    }],
    footer: { text: CLOUDY_KNOWLEDGE_FOOTER },
  };

  return {
    informations: channels.informations ? { channel: channels.informations, embeds: [informationEmbed] } : null,
    linkYourAccount: channels.linkYourAccount ? { channel: channels.linkYourAccount, embeds: [accountEmbed] } : null,
    freeKits: channels.freeKits ? { channel: channels.freeKits, embeds: [freeKitsEmbed] } : null,
  };
}

function knowledgeStateKey(channelId) {
  return `global:cloudy:verified-knowledge-panel:${channelId}`;
}

function isKnowledgeMessage(message, clientUserId) {
  return message?.author?.id === clientUserId
    && message.embeds?.some(embed => embed.footer?.text === CLOUDY_KNOWLEDGE_FOOTER);
}

export async function reconcileRestoredKnowledgePanels(client) {
  const results = [];

  for (const guild of client.guilds.cache.values()) {
    const payloads = await buildRestoredKnowledgePayloads(client, guild);

    for (const [key, entry] of Object.entries(payloads)) {
      if (!entry?.channel?.isSendable?.() || !entry.channel.messages?.fetch) {
        results.push({ guildId: guild.id, key, ok: false, reason: 'channel_missing' });
        continue;
      }

      const stateKey = knowledgeStateKey(entry.channel.id);
      let existing = null;
      const savedId = client.db?.get ? await client.db.get(stateKey).catch(() => null) : null;
      if (savedId) {
        const saved = await entry.channel.messages.fetch(savedId).catch(() => null);
        if (isKnowledgeMessage(saved, client.user.id)) existing = saved;
      }

      if (!existing) {
        const recent = await entry.channel.messages.fetch({ limit: 50 }).catch(() => null);
        existing = recent?.find(message => isKnowledgeMessage(message, client.user.id)) || null;
      }

      if (existing) {
        if (client.db?.set) await client.db.set(stateKey, existing.id).catch(() => {});
        results.push({ guildId: guild.id, key, ok: true, existing: true });
        continue;
      }

      const sent = await entry.channel.send({
        embeds: entry.embeds,
        allowedMentions: { parse: [] },
      }).catch(() => null);

      if (!sent) {
        results.push({ guildId: guild.id, key, ok: false, reason: 'send_failed' });
        continue;
      }

      if (client.db?.set) await client.db.set(stateKey, sent.id).catch(() => {});
      await registerCloudyEmbedMessage(sent, 'embed-builder').catch(() => {});
      results.push({ guildId: guild.id, key, ok: true, existing: false, messageId: sent.id });
    }
  }

  return results;
}
