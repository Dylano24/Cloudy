import { getTicketData, saveTicketData } from '../utils/database.js';
import { buildCloudyTicketEmbed } from '../utils/ticket/ticketBranding.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { requirePersistentTicketDatabase } from './ticketReliabilityService.js';
import { archiveTicketTranscript } from './ticketTranscriptService.js';
import { ensureTicketDestinationConfig } from './ticketDestinationAutoConfig.js';
import { logger } from '../utils/logger.js';

const DELETE_DELAY_MS = 3000;
const deleteQueues = new Map();

function ticketDeleteError(message, userMessage, code = 'TICKET_DELETE_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.userMessage = userMessage;
  return error;
}

function enqueue(key, operation) {
  const previous = deleteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  deleteQueues.set(key, current);
  current.finally(() => {
    if (deleteQueues.get(key) === current) deleteQueues.delete(key);
  }).catch(() => {});
  return current;
}

export async function deleteTicketSafely(channel, deleter) {
  if (!channel?.guild?.id || !channel?.id) {
    throw ticketDeleteError('Invalid ticket channel', 'This is not a valid ticket channel.');
  }

  requirePersistentTicketDatabase(channel.client);
  const key = `${channel.guild.id}:${channel.id}`;

  return enqueue(key, async () => {
    await ensureTicketDestinationConfig(
      channel.client,
      channel.guild,
      { refreshIfMissing: true },
    );

    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) {
      throw ticketDeleteError('Ticket data not found', 'This is not a valid ticket channel.', 'TICKET_NOT_FOUND');
    }

    if (ticketData.status === 'deleted') {
      throw ticketDeleteError('Ticket already deleted', 'This ticket is already marked as deleted.', 'TICKET_ALREADY_DELETED');
    }

    const scheduledAt = ticketData.deletionScheduledAt
      ? new Date(ticketData.deletionScheduledAt).getTime()
      : 0;
    if (Number.isFinite(scheduledAt) && scheduledAt > Date.now() - 30_000) {
      throw ticketDeleteError(
        'Ticket deletion already scheduled',
        'This ticket is already scheduled for deletion.',
        'TICKET_DELETE_ALREADY_SCHEDULED',
      );
    }

    const previousStatus = ticketData.status || 'open';
    ticketData.deletionScheduledAt = new Date().toISOString();
    ticketData.deletionScheduledBy = deleter.id;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    try {
      if (!ticketData.transcriptArchivedAt) {
        const transcript = await archiveTicketTranscript({
          channel,
          ticketData,
          executor: deleter,
          requireDestination: true,
        });
        ticketData.transcriptArchivedAt = transcript.generatedAt;
        ticketData.transcriptMessageCount = transcript.messageCount;
        ticketData.transcriptTruncated = transcript.truncated;
      }

      ticketData.status = 'deleted';
      ticketData.previousStatusBeforeDelete = previousStatus;
      ticketData.deletedAt = new Date().toISOString();
      ticketData.deletedBy = deleter.id;
      await saveTicketData(channel.guild.id, channel.id, ticketData);

      const deleteLogSent = await logTicketEvent({
        client: channel.client,
        guildId: channel.guild.id,
        event: {
          type: 'delete',
          ticketId: channel.id,
          ticketNumber: ticketData.ticketNumber || ticketData.id,
          userId: ticketData.userId,
          executorId: deleter.id,
          metadata: {
            deletedAt: ticketData.deletedAt,
            transcriptArchivedAt: ticketData.transcriptArchivedAt,
          },
        },
      });

      if (!deleteLogSent) {
        logger.warn('Ticket delete log was not delivered; continuing because transcript is already archived', {
          guildId: channel.guild.id,
          channelId: channel.id,
        });
      }

      await channel.send({
        embeds: [buildCloudyTicketEmbed({
          title: 'Ticket deleted',
          description: `This ticket will be permanently deleted in ${Math.ceil(DELETE_DELAY_MS / 1000)} seconds.`,
        })],
      }).catch(() => {});

      const timer = setTimeout(async () => {
        try {
          await channel.delete(`Ticket deleted by ${deleter.username || deleter.id}`);
          logger.info('Ticket channel permanently deleted after transcript archive', {
            guildId: channel.guild.id,
            channelId: channel.id,
            ticketNumber: ticketData.ticketNumber || ticketData.id,
          });
        } catch (error) {
          logger.error('Ticket channel deletion failed after transcript archive', {
            guildId: channel.guild.id,
            channelId: channel.id,
            error: error.message,
          });

          try {
            const latest = await getTicketData(channel.guild.id, channel.id);
            if (latest) {
              latest.status = previousStatus;
              latest.deletionScheduledAt = null;
              latest.deletionFailedAt = new Date().toISOString();
              latest.deletionFailure = error.message;
              await saveTicketData(channel.guild.id, channel.id, latest);
            }
          } catch (saveError) {
            logger.error('Could not restore ticket state after failed Discord deletion', {
              guildId: channel.guild.id,
              channelId: channel.id,
              error: saveError.message,
            });
          }
        }
      }, DELETE_DELAY_MS);
      timer.unref?.();

      return ticketData;
    } catch (error) {
      ticketData.status = previousStatus;
      ticketData.deletionScheduledAt = null;
      ticketData.deletionScheduledBy = null;
      ticketData.deletionFailedAt = new Date().toISOString();
      ticketData.deletionFailure = error.message;
      await saveTicketData(channel.guild.id, channel.id, ticketData).catch(() => {});
      throw error;
    }
  });
}
