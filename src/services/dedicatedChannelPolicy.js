import { isGamblingGameCommand } from '../config/gamblingCommands.js';

const resolvedChannels = new WeakMap();
const SHOP_COMMANDS = new Set(['shop', 'buy']);

function normalizeChannelSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function rememberDedicatedCommandChannel(interaction, key, channelId) {
  resolvedChannels.set(interaction, { key, channelId });
}

export function findDedicatedChannelBySlug(guild, slug) {
  const normalizedSlug = normalizeChannelSlug(slug);
  const channels = [...(guild?.channels?.cache?.values?.() || [])]
    .filter(channel => channel?.isTextBased?.() && channel?.isSendable?.());

  return channels.find(channel => normalizeChannelSlug(channel.name) === normalizedSlug)
    || channels.find(channel => normalizeChannelSlug(channel.name).includes(normalizedSlug))
    || null;
}

export function getGamblingResponsePolicy(interaction, context = {}) {
  const resolved = resolvedChannels.get(interaction);
  const commandName = String(interaction?.commandName || context.commandName || context.command || '').toLowerCase();
  const dedicatedKey = resolved?.key
    || (isGamblingGameCommand(commandName) ? 'gambling' : null)
    || (SHOP_COMMANDS.has(commandName) ? 'shop' : null);

  if (!['gambling', 'shop'].includes(dedicatedKey)) return null;

  // Gambling and shop use the exact same response policy; only the target
  // dedicated channel differs.
  const targetId = resolved?.key === dedicatedKey
    ? resolved.channelId
    : findDedicatedChannelBySlug(interaction?.guild, dedicatedKey)?.id;
  const currentId = interaction?.channelId || interaction?.channel?.id;
  const inDedicatedChannel = Boolean(targetId && currentId === targetId);

  return {
    showCloseButton: false,
    // Keep errors visible in the dedicated channel; elsewhere they are temporary.
    autoDelete: !inDedicatedChannel,
    ephemeral: !inDedicatedChannel,
  };
}