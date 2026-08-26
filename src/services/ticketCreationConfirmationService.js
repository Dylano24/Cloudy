const creationConfirmations = new Map();

function ticketKey(channelOrId) {
  return String(channelOrId?.id || channelOrId || '').trim();
}

export function registerTicketCreationConfirmation(ticketChannel, interaction) {
  const key = ticketKey(ticketChannel);
  if (!key || !interaction) return false;

  creationConfirmations.set(key, async () => {
    try {
      await interaction.deleteReply();
      return true;
    } catch {
      try {
        await interaction.webhook?.deleteMessage?.('@original');
        return true;
      } catch {
        return false;
      }
    }
  });

  return true;
}

export async function deleteTicketCreationConfirmation(ticketChannel) {
  const key = ticketKey(ticketChannel);
  if (!key) return false;

  const cleanup = creationConfirmations.get(key);
  creationConfirmations.delete(key);
  if (!cleanup) return false;

  return await cleanup();
}
