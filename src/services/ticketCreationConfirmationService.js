import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { deleteFromDb, getFromDb, getTicketData, saveTicketData, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const privateTicketCreationConfirmations = new Map();

function privateConfirmationCryptoKey() {
  const secret = process.env.DISCORD_TOKEN
    || process.env.TOKEN
    || process.env.BOT_TOKEN
    || process.env.DISCORD_BOT_TOKEN
    || '';
  if (!secret) return null;
  return createHash('sha256').update(secret).digest();
}

function encryptInteractionToken(token) {
  const key = privateConfirmationCryptoKey();
  if (!key || !token) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(part => part.toString('base64url')).join('.');
}

function decryptInteractionToken(value) {
  const key = privateConfirmationCryptoKey();
  if (!key || !value) return null;
  try {
    const [ivPart, tagPart, cipherPart] = String(value).split('.');
    if (!ivPart || !tagPart || !cipherPart) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

async function deletePersistedPrivateConfirmation(reference) {
  const applicationId = String(reference?.applicationId || '').trim();
  const token = decryptInteractionToken(reference?.encryptedInteractionToken);
  const messageId = String(reference?.messageId || '').trim();
  if (!applicationId || !token) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  timeout.unref?.();

  try {
    const targetMessage = messageId ? encodeURIComponent(messageId) : '@original';
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/${targetMessage}`,
      { method: 'DELETE', signal: controller.signal },
    );
    return response.ok || response.status === 404;
  } catch (error) {
    logger.debug('Persisted private ticket confirmation cleanup skipped', {
      error: error?.message || String(error),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function privateConfirmationStorageKey(guildId, ticketId) {
  return `cloudy:ticket-private-creation-confirmation:${String(guildId)}:${String(ticketId)}`;
}

function privateConfirmationKey(ticketChannel) {
  return `${ticketChannel?.guild?.id || ''}:${ticketChannel?.id || ''}`;
}

export async function registerPrivateTicketCreationConfirmation(ticketChannel, interaction, confirmationMessage = null) {
  if (!ticketChannel?.guild?.id || !ticketChannel?.id || !interaction) return false;
  const messageId = String(confirmationMessage?.id || '').trim() || null;
  const canDeleteLive = messageId
    ? typeof interaction.webhook?.deleteMessage === 'function'
    : typeof interaction.deleteReply === 'function';
  if (!canDeleteLive) return false;

  privateTicketCreationConfirmations.set(privateConfirmationKey(ticketChannel), {
    interaction,
    messageId,
  });

  const encryptedInteractionToken = encryptInteractionToken(interaction.token);
  const applicationId = String(interaction.applicationId || interaction.client?.application?.id || '').trim();
  if (!encryptedInteractionToken || !applicationId) return true;

  try {
    const data = await getTicketData(ticketChannel.guild.id, ticketChannel.id);
    if (!data) return true;
    const reference = {
      applicationId,
      encryptedInteractionToken,
      ...(messageId ? { messageId } : {}),
      createdAt: new Date().toISOString(),
    };
    await setInDb(
      privateConfirmationStorageKey(ticketChannel.guild.id, ticketChannel.id),
      reference,
    );
    // Keep the legacy field temporarily for backward compatibility with
    // already-running ticket data, but the dedicated key is authoritative.
    data.privateCreationConfirmation = reference;
    await saveTicketData(ticketChannel.guild.id, ticketChannel.id, data);
  } catch (error) {
    logger.warn('Could not persist private ticket creation confirmation cleanup reference', {
      ticketId: ticketChannel.id,
      error: error?.message || String(error),
    });
  }
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

export async function prepareTicketCreationConfirmationCleanup(ticketChannel, providedData = null) {
  if (!ticketChannel?.guild?.id || !ticketChannel?.id) return async () => false;

  const privateKey = privateConfirmationKey(ticketChannel);
  const privateConfirmation = privateTicketCreationConfirmations.get(privateKey) || null;
  const data = providedData
    ? structuredClone(providedData)
    : await getTicketData(ticketChannel.guild.id, ticketChannel.id);
  const dedicatedReference = await getFromDb(
    privateConfirmationStorageKey(ticketChannel.guild.id, ticketChannel.id),
    null,
  ).catch(() => null);

  const prepared = {
    privateKey,
    privateConfirmation,
    dedicatedReference: dedicatedReference ? structuredClone(dedicatedReference) : null,
    data: data ? structuredClone(data) : null,
  };

  return async () => deleteTicketCreationConfirmation(ticketChannel, prepared);
}

export async function deleteTicketCreationConfirmation(ticketChannel, prepared = null) {
  if (!ticketChannel?.guild?.id) return false;

  let deleted = false;
  const data = prepared?.data
    ? structuredClone(prepared.data)
    : await getTicketData(ticketChannel.guild.id, ticketChannel.id);
  const privateKey = prepared?.privateKey || privateConfirmationKey(ticketChannel);
  const privateConfirmation = prepared?.privateConfirmation
    || prepared?.privateInteraction
    || privateTicketCreationConfirmations.get(privateKey);
  const privateInteraction = privateConfirmation?.interaction || privateConfirmation || null;
  const privateMessageId = String(privateConfirmation?.messageId || '').trim() || null;
  if (privateInteraction) {
    privateTicketCreationConfirmations.delete(privateKey);
    try {
      if (privateMessageId) {
        if (typeof privateInteraction.webhook?.deleteMessage === 'function') {
          await privateInteraction.webhook.deleteMessage(privateMessageId);
          deleted = true;
        }
      } else if (typeof privateInteraction.deleteReply === 'function') {
        await privateInteraction.deleteReply();
        deleted = true;
      }
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

  const dedicatedReference = prepared?.dedicatedReference
    || await getFromDb(
      privateConfirmationStorageKey(ticketChannel.guild.id, ticketChannel.id),
      null,
    ).catch(() => null);
  const persistedReference = dedicatedReference || data?.privateCreationConfirmation || null;

  if (!deleted && persistedReference) {
    deleted = await deletePersistedPrivateConfirmation(persistedReference);
  }

  await deleteFromDb(
    privateConfirmationStorageKey(ticketChannel.guild.id, ticketChannel.id),
  ).catch(() => {});

  if (data?.privateCreationConfirmation) {
    delete data.privateCreationConfirmation;
    await saveTicketData(ticketChannel.guild.id, ticketChannel.id, data).catch(() => {});
  }

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
