import { getTicketData, saveTicketData } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const privateTicketCreationConfirmations = new Map();

function privateConfirmationKey(ticketChannel) {
  return `${ticketChannel?.guild?.id || ''}:${ticketChannel?.id || ''}`;
}

export function registerPrivateTicketCreationConfirmation(ticketChannel, interaction) {
  if (!ticketChannel?.guild?.id || !ticketChannel?.id || typeof interaction?.deleteReply !== 'function') return false;
  privateTicketCreationConfirmations.set(privateConfirmationKey(ticketChannel), interaction);
  return true;
}

export async function sendTicketCreationConfirmation(ticketChannel, sourceChannel, payload) {
  const message = await sourceChannel.send(payload);
  if (!await registerTicketCreationConfirmation(ticketChannel, message)) {
    await message.delete().catch(() => {});
    throw new Error('Could not persist ticket creation confirmation');
  }
  return message;
}

export async function registerTicketCreationConfirmation(ticketChannel, message) {
  if (!ticketChannel?.guild?.id || !message?.id || !message?.channelId) return false;
  const data = await getTicketData(ticketChannel.guild.id, ticketChannel.id);
  if (!data) return false;
  data.creationConfirmation = { channelId: message.channelId, messageId: message.id };
  await saveTicketData(ticketChannel.guild.id, ticketChannel.id, data);
  return true;
}

export async function deleteTicketCreationConfirmation(ticketChannel) {
  if (!ticketChannel?.guild?.id) return false;

  let deleted = false;
  const privateKey = privateConfirmationKey(ticketChannel);
  const privateInteraction = privateTicketCreationConfirmations.get(privateKey);
  if (privateInteraction) {
    privateTicketCreationConfirmations.delete(privateKey);
    try {
      await privateInteraction.deleteReply();
      deleted = true;
    } catch (error) {
      // Discord interaction webhooks expire. The confirmation remains private;
      // do not turn a cleanup limitation into a failed ticket deletion.
      if (![10008, 10015, 10062].includes(error?.code)) {
        logger.debug('Private ticket creation confirmation cleanup skipped', {
          ticketId: ticketChannel.id,
          error: error.message,
        });
      }
    }
  }

  const data = await getTicketData(ticketChannel.guild.id, ticketChannel.id);
  const reference = data?.creationConfirmation;
  if (!reference?.messageId || !reference?.channelId) return deleted;

  try {
    const channel = await ticketChannel.guild.channels.fetch(reference.channelId);
    if (!channel || channel.guild.id !== ticketChannel.guild.id) return deleted;
    const message = await channel.messages.fetch(reference.messageId);
    if (message?.author?.id !== ticketChannel.client.user.id) return deleted;
    await message.delete();
    deleted = true;
  } catch (error) {
    if (error?.code !== 10008) {
      logger.warn('Ticket creation confirmation cleanup failed', { ticketId: ticketChannel.id, messageId: reference.messageId, error: error.message });
      return deleted;
    }
    deleted = true;
  }

  delete data.creationConfirmation;
  await saveTicketData(ticketChannel.guild.id, ticketChannel.id, data);
  return deleted;
}
