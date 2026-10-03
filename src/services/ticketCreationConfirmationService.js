import { getTicketData, saveTicketData } from '../utils/database.js';
import { logger } from '../utils/logger.js';

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
  if ((await getTicketData(ticketChannel.guild.id, ticketChannel.id))?.status === 'closed') {
    await deleteTicketCreationConfirmation(ticketChannel);
  }
  return true;
}

export async function deleteTicketCreationConfirmation(ticketChannel) {
  if (!ticketChannel?.guild?.id) return false;
  const data = await getTicketData(ticketChannel.guild.id, ticketChannel.id);
  const reference = data?.creationConfirmation;
  if (!reference?.messageId || !reference?.channelId) return false;
  try {
    const channel = await ticketChannel.guild.channels.fetch(reference.channelId);
    if (!channel || channel.guild.id !== ticketChannel.guild.id) return false;
    const message = await channel.messages.fetch(reference.messageId);
    if (message?.author?.id !== ticketChannel.client.user.id) return false;
    await message.delete();
  } catch (error) {
    if (error?.code !== 10008) {
      logger.warn('Ticket creation confirmation cleanup failed', { ticketId: ticketChannel.id, messageId: reference.messageId, error: error.message });
      return false;
    }
  }
  delete data.creationConfirmation;
  await saveTicketData(ticketChannel.guild.id, ticketChannel.id, data);
  return true;
}
