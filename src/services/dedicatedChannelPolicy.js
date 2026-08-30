const GAMBLING_COMMANDS = new Set(['gamble', 'fight', 'flip', 'roll']);
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
  const commandName = interaction?.commandName || context.commandName || context.command;
  if (resolved?.key !== 'gambling' && !GAMBLING_COMMANDS.has(commandName)) return null;

  // Also covers validation and cooldown errors raised before command.execute.
  const targetId = resolved?.key === 'gambling'
    ? resolved.channelId
    : findDedicatedChannelBySlug(interaction?.guild, 'gambling')?.id;
  const currentId = interaction?.channelId || interaction?.channel?.id;
  const inGamblingChannel = Boolean(targetId && currentId === targetId);

  return {
    showCloseButton: false,
    autoDelete: !inGamblingChannel,
    ephemeral: !inGamblingChannel,
  };
}
