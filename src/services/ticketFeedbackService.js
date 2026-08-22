import { getTicketData, saveTicketData } from '../utils/database.js';

const feedbackMutationQueues = new Map();

function feedbackError(message, userMessage, code) {
  const error = new Error(message);
  error.userMessage = userMessage;
  error.code = code;
  return error;
}

function enqueue(key, operation) {
  const previous = feedbackMutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  feedbackMutationQueues.set(key, current);
  current.finally(() => {
    if (feedbackMutationQueues.get(key) === current) feedbackMutationQueues.delete(key);
  }).catch(() => {});
  return current;
}

export async function mutateTicketFeedback({
  guildId,
  channelId,
  userId,
  changes,
  onceFields = [],
}) {
  if (!guildId || !channelId || !userId) {
    throw feedbackError(
      'Invalid feedback mutation identity',
      'This feedback submission is invalid.',
      'TICKET_FEEDBACK_INVALID',
    );
  }

  const key = `${guildId}:${channelId}`;

  return enqueue(key, async () => {
    let ticketData;
    try {
      ticketData = await getTicketData(guildId, channelId);
    } catch (error) {
      throw feedbackError(
        `Ticket feedback read failed: ${error.message}`,
        'Cloudy could not verify this ticket right now. Please try again.',
        'TICKET_FEEDBACK_READ_FAILED',
      );
    }

    if (!ticketData) {
      throw feedbackError(
        'Ticket feedback record not found',
        'Could not find the ticket associated with this feedback.',
        'TICKET_FEEDBACK_NOT_FOUND',
      );
    }

    if (String(ticketData.userId) !== String(userId)) {
      throw feedbackError(
        'Feedback submitted by non-owner',
        'Only the ticket creator can submit feedback for this ticket.',
        'TICKET_FEEDBACK_NOT_OWNER',
      );
    }

    const existingFeedback = ticketData.feedback && typeof ticketData.feedback === 'object'
      ? ticketData.feedback
      : {};

    const alreadyFields = onceFields.filter(field => existingFeedback[field] != null);
    if (alreadyFields.length > 0) {
      return {
        status: 'already_submitted',
        existingFields: alreadyFields,
        ticketData,
      };
    }

    ticketData.feedback = {
      ...existingFeedback,
      ...changes,
    };

    try {
      await saveTicketData(guildId, channelId, ticketData);
    } catch (error) {
      throw feedbackError(
        `Ticket feedback save failed: ${error.message}`,
        'Cloudy could not save your feedback. Please try again.',
        'TICKET_FEEDBACK_SAVE_FAILED',
      );
    }

    return {
      status: 'saved',
      existingFields: [],
      ticketData,
    };
  });
}
