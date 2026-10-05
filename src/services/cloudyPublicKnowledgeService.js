import { PermissionFlagsBits } from 'discord.js';
import { redactAiText } from './aiSafety.js';
import { resolveCloudyChannel } from './cloudyChannelResolver.js';

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

const KNOWLEDGE_FETCH_CONCURRENCY = 8;
const KNOWLEDGE_CHANNEL_FETCH_TIMEOUT_MS = 2500;

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
}

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

export async function getCloudyKnowledgeChannels(guild) {
  const fetched = await guild.channels.fetch().catch(() => guild.channels.cache);
  const channels = new Map([...(fetched?.values?.() || [])].filter(Boolean).map(channel => [channel.id, channel]));
  for (const channel of guild.channels.cache?.values?.() || []) channels.set(channel.id, channel);
  const active = await guild.channels.fetchActiveThreads?.().catch(() => null);
  for (const channel of active?.threads?.values?.() || []) channels.set(channel.id, channel);
  return [...channels.values()];
}

export async function buildCloudyPublicKnowledgeEvidence(actor, request) {
  const client = actor?.client;
  const guild = actor?.guild;
  const userId = actor?.user?.id || actor?.author?.id;
  if (!client || !guild || !userId) return { text: '', count: 0, channels: 0 };

  const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
  const botMember = guild.members.me
    || await guild.members.fetchMe?.({ force: true }).catch(() => null);
  if (!member || !botMember) return { text: '', count: 0, channels: 0 };

  const verified = await buildVerifiedCloudyFacts(client, guild);
  const tokens = questionTokens(request.question);
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

  const commandCollection = await guild.commands?.fetch?.().catch(() => null);
  const allCommands = [...(commandCollection?.values?.() || [])].map(command => ({
    name: String(command.name || ''),
    description: String(command.description || ''),
  })).filter(command => command.name);

  const commandQuestion = tokens.some(token => ['command', 'commands', 'slash', 'commando', 'commandoes'].includes(token));
  const scoredCommands = allCommands.map(command => ({
    ...command,
    score: tokens.reduce((score, token) => score
      + (command.name.toLowerCase().includes(token) ? 3 : 0)
      + (command.description.toLowerCase().includes(token) ? 1 : 0), 0),
  }));
  const relevantCommands = (commandQuestion
    ? scoredCommands
    : scoredCommands.filter(command => command.score > 0))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, commandQuestion ? 100 : 30)
    .map(({ score: _score, ...command }) => command);

  const resolved = (await getCloudyKnowledgeChannels(guild))
    .map(channel => ({ key: channel.id, channel }));
  const directory = resolved.filter(({ channel }) => channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
    && channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel))
    .map(({ channel }) => ({ channelId: channel.id, channelName: channel.name }));
  const readable = resolved.filter(({ channel }) => channel?.messages?.fetch
    && channel.permissionsFor(member)?.has(required)
    && channel.permissionsFor(botMember)?.has(required));

  const channelRows = await mapWithConcurrency(
    readable,
    KNOWLEDGE_FETCH_CONCURRENCY,
    async ({ key, channel }) => {
      const batch = await withTimeout(
        channel.messages.fetch({ limit: 50, cache: false }).catch(() => null),
        KNOWLEDGE_CHANNEL_FETCH_TIMEOUT_MS,
      );
      if (!batch?.size) return [];

      const name = String(channel.name || '').toLowerCase();
      const channelScore = tokens.reduce((score, token) => score + (name.includes(token) ? 3 : 0), 0);
      const rows = [];

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

      return rows;
    },
  );

  const rows = channelRows.flat();
  const readableChannels = readable.length;

  const hasRelevant = rows.some(row => row.score > 0);
  const selected = rows
    .filter(row => !hasRelevant || row.score > 0)
    .sort((left, right) => right.score - left.score || right.createdTimestamp - left.createdTimestamp)
    .slice(0, 40)
    .map(({ score: _score, createdTimestamp: _createdTimestamp, ...row }) => row)
    .reverse();

  const payload = {
    guildId: guild.id,
    readableChannelDirectory: directory,
    verifiedCloudyFacts: verified,
    registeredSlashCommands: relevantCommands,
    readablePublicChannelMessages: selected,
    instruction: 'Use the readable channel directory to link the actual server channels with <#channelId>. Answer only from these verified facts, registered slash commands, and readable public channel messages. Never invent a command, URL, product, purchase process, kit claim step, or server fact.',
  };

  let text = JSON.stringify(payload);
  while (Buffer.byteLength(text) > 12_000 && selected.length) {
    selected.shift();
    payload.readablePublicChannelMessages = selected;
    text = JSON.stringify(payload);
  }
  while (Buffer.byteLength(text) > 12_000 && relevantCommands.length) {
    relevantCommands.pop();
    payload.registeredSlashCommands = relevantCommands;
    text = JSON.stringify(payload);
  }

  return {
    text,
    count: selected.length + verified.navigation.length + relevantCommands.length,
    channels: readableChannels,
  };
}

function knowledgeStateKey(channelId) {
  return `global:cloudy:verified-knowledge-panel:${channelId}`;
}

function isKnowledgeMessage(message, clientUserId) {
  return message?.author?.id === clientUserId
    && message.embeds?.some(embed => embed.footer?.text === CLOUDY_KNOWLEDGE_FOOTER);
}

export async function cleanupGeneratedKnowledgePanels(client) {
  const results = [];

  for (const guild of client.guilds.cache.values()) {
    const channels = await resolveKnowledgeChannels(client, guild);
    const targets = [
      ['informations', channels.informations],
      ['linkYourAccount', channels.linkYourAccount],
      ['freeKits', channels.freeKits],
    ];

    for (const [key, channel] of targets) {
      if (!channel?.messages?.fetch) {
        results.push({ guildId: guild.id, key, ok: true, removed: false, reason: 'channel_missing' });
        continue;
      }

      const stateKey = knowledgeStateKey(channel.id);
      const savedId = client.db?.get ? await client.db.get(stateKey).catch(() => null) : null;
      if (!savedId) {
        results.push({ guildId: guild.id, key, ok: true, removed: false, reason: 'not_tracked' });
        continue;
      }

      const message = await channel.messages.fetch(savedId).catch(() => null);
      if (isKnowledgeMessage(message, client.user.id)) {
        const deleted = await message.delete().then(() => true).catch(() => false);
        results.push({ guildId: guild.id, key, ok: deleted, removed: deleted, messageId: savedId });
      } else {
        results.push({ guildId: guild.id, key, ok: true, removed: false, reason: 'tracked_message_missing_or_changed' });
      }

      if (client.db?.delete) await client.db.delete(stateKey).catch(() => {});
    }
  }

  return results;
}
