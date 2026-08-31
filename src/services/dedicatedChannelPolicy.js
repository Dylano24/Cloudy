import { isGamblingGameCommand } from '../config/gamblingCommands.js';

const resolvedChannels = new WeakMap();

export function rememberDedicatedCommandChannel(interaction, key, channelId) {
  resolvedChannels.set(interaction, { key, channelId });
}

export function findDedicatedChannelBySlug(guild, slug) {
  const normalizedSlug = String(slug).toLowerCase();
  return guild?.channels?.cache?.find(channel =>
    channel?.isTextBased?.() && channel?.isSendable?.()
    && String(channel.name || '').toLowerCase().includes(normalizedSlug)
  ) || null;
}

export function getGamblingResponsePolicy(interaction, context = {}) {
  const resolved = resolvedChannels.get(interaction);
  const commandName = String(interaction?.commandName || context.commandName || context.command || '').toLowerCase();
  if (resolved?.key !== 'gambling' && !isGamblingGameCommand(commandName)) return null;

  // Also covers validation and cooldown errors raised before command.execute.
  const targetId = resolved?.key === 'gambling'
    ? resolved.channelId
    : findDedicatedChannelBySlug(interaction?.guild, 'gambling')?.id;
  const currentId = interaction?.channelId || interaction?.channel?.id;
  const inGamblingChannel = Boolean(targetId && currentId === targetId);

  return {
    showCloseButton: false,
    // Keep errors visible in the dedicated channel; elsewhere they are temporary.
    autoDelete: !inGamblingChannel,
    ephemeral: !inGamblingChannel,
  };
}
