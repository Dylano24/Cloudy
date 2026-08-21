import { AttachmentBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { logger } from '../utils/logger.js';

const MAX_TRANSCRIPT_MESSAGES = 10_000;
const FETCH_BATCH_SIZE = 100;

function transcriptError(message, userMessage, code = 'TICKET_TRANSCRIPT_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.userMessage = userMessage;
  return error;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderAttachments(message) {
  if (!message.attachments?.size) return '';
  return [...message.attachments.values()]
    .map(attachment => {
      const label = escapeHtml(attachment.name || 'attachment');
      const url = escapeHtml(attachment.url || '');
      const size = Number.isFinite(attachment.size) ? ` (${Math.ceil(attachment.size / 1024)} KB)` : '';
      return `<div class="attachment"><a href="${url}" target="_blank" rel="noreferrer">${label}</a>${escapeHtml(size)}</div>`;
    })
    .join('');
}

function renderEmbeds(message) {
  if (!message.embeds?.length) return '';
  return message.embeds.map(embed => {
    const parts = [];
    if (embed.title) parts.push(`<strong>${escapeHtml(embed.title)}</strong>`);
    if (embed.description) parts.push(`<div>${escapeHtml(embed.description).replace(/\n/g, '<br>')}</div>`);
    for (const field of embed.fields || []) {
      parts.push(`<div><strong>${escapeHtml(field.name)}:</strong> ${escapeHtml(field.value).replace(/\n/g, '<br>')}</div>`);
    }
    return `<div class="embed">${parts.join('')}</div>`;
  }).join('');
}

function renderMessage(message) {
  const created = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdTimestamp || Date.now());
  const edited = message.editedTimestamp ? new Date(message.editedTimestamp) : null;
  const authorName = message.member?.displayName || message.author?.globalName || message.author?.username || 'Unknown';
  const authorTag = message.author?.tag || message.author?.username || 'Unknown';
  const avatar = message.author?.displayAvatarURL?.({ extension: 'png', size: 64 }) || '';
  const content = escapeHtml(message.content || '').replace(/\n/g, '<br>');

  return `
  <article class="message">
    ${avatar ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="">` : ''}
    <div class="body">
      <div class="meta">
        <strong>${escapeHtml(authorName)}</strong>
        <span class="tag">${escapeHtml(authorTag)}</span>
        <time>${escapeHtml(created.toISOString())}</time>
        ${edited ? `<span class="edited">edited ${escapeHtml(edited.toISOString())}</span>` : ''}
      </div>
      ${content ? `<div class="content">${content}</div>` : ''}
      ${renderEmbeds(message)}
      ${renderAttachments(message)}
    </div>
  </article>`;
}

async function fetchAllMessages(channel) {
  const messages = [];
  let before;

  while (messages.length < MAX_TRANSCRIPT_MESSAGES) {
    const remaining = MAX_TRANSCRIPT_MESSAGES - messages.length;
    const limit = Math.min(FETCH_BATCH_SIZE, remaining);
    const batch = await channel.messages.fetch({
      limit,
      ...(before ? { before } : {}),
    });

    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < limit) break;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return messages;
}

function buildTranscriptHtml(channel, ticketData, messages, generatedAt) {
  const ticketNumber = ticketData?.ticketNumber || ticketData?.id || channel.id;
  const creator = ticketData?.userId ? `<@${ticketData.userId}>` : 'Unknown';
  const status = ticketData?.status || 'unknown';
  const reason = ticketData?.reason || 'No reason provided';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloudy Ticket #${escapeHtml(ticketNumber)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111214;color:#dbdee1;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1100px;margin:0 auto;padding:28px}.header{background:#1e1f22;border:1px solid #2b2d31;border-radius:12px;padding:20px;margin-bottom:20px}.header h1{margin:0 0 10px;color:#fff}.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;color:#b5bac1}.message{display:flex;gap:12px;padding:12px 8px;border-bottom:1px solid #202225}.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover}.body{min-width:0;flex:1}.meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.tag,time,.edited{color:#949ba4;font-size:12px}.content{margin-top:4px;white-space:normal;overflow-wrap:anywhere}.attachment,.embed{margin-top:8px;background:#1e1f22;border-left:3px solid #5865f2;border-radius:4px;padding:8px 10px}.attachment a{color:#00a8fc}.footer{margin-top:24px;color:#949ba4;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <section class="header">
    <h1>Cloudy Ticket #${escapeHtml(ticketNumber)}</h1>
    <div class="meta-grid">
      <div><strong>Channel:</strong> #${escapeHtml(channel.name)}</div>
      <div><strong>Creator:</strong> ${escapeHtml(creator)}</div>
      <div><strong>Status:</strong> ${escapeHtml(status)}</div>
      <div><strong>Messages:</strong> ${messages.length}</div>
      <div><strong>Created:</strong> ${escapeHtml(ticketData?.createdAt || 'Unknown')}</div>
      <div><strong>Generated:</strong> ${escapeHtml(generatedAt)}</div>
    </div>
    <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
  </section>
  <main>${messages.map(renderMessage).join('\n')}</main>
  <div class="footer">© Cloudy Inc. • Quality. Innovation. Performance.</div>
</div>
</body>
</html>`;
}

export async function generateTicketTranscript(channel, ticketData = null) {
  if (!channel?.messages?.fetch || !channel.guild) {
    throw transcriptError('Invalid ticket channel for transcript', 'This ticket channel cannot be transcribed.');
  }

  const generatedAt = new Date().toISOString();
  const messages = await fetchAllMessages(channel);
  const html = buildTranscriptHtml(channel, ticketData, messages, generatedAt);
  const buffer = Buffer.from(html, 'utf8');
  const ticketNumber = ticketData?.ticketNumber || ticketData?.id || channel.id;
  const safeNumber = String(ticketNumber).replace(/[^a-zA-Z0-9_-]/g, '-') || channel.id;

  return {
    attachment: new AttachmentBuilder(buffer, { name: `ticket-${safeNumber}.html` }),
    buffer,
    html,
    messageCount: messages.length,
    generatedAt,
    truncated: messages.length >= MAX_TRANSCRIPT_MESSAGES,
  };
}

function missingTranscriptPermissions(channel, botMember) {
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  const required = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
    [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
    [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  ];
  if (!permissions) return required.map(([, label]) => label);
  return required.filter(([permission]) => !permissions.has(permission)).map(([, label]) => label);
}

export async function archiveTicketTranscript({ channel, ticketData, executor = null, requireDestination = false }) {
  const transcript = await generateTicketTranscript(channel, ticketData);
  const config = await getGuildConfig(channel.client, channel.guild.id);
  const destinationId = config.ticketTranscriptChannelId || null;

  if (!destinationId) {
    if (requireDestination) {
      throw transcriptError(
        'Transcript channel is not configured',
        'A transcript channel must be configured before this ticket can be permanently deleted.',
        'TICKET_TRANSCRIPT_CHANNEL_MISSING',
      );
    }
    return { ...transcript, sent: false, destination: null, reason: 'not_configured' };
  }

  const destination = channel.guild.channels.cache.get(destinationId)
    || await channel.guild.channels.fetch(destinationId).catch(() => null);

  if (!destination || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(destination.type) || !destination.isSendable?.()) {
    throw transcriptError(
      `Transcript channel ${destinationId} is unavailable`,
      'The configured transcript channel is unavailable. Fix it in /ticket dashboard before deleting this ticket.',
      'TICKET_TRANSCRIPT_CHANNEL_INVALID',
    );
  }

  const missing = missingTranscriptPermissions(destination, channel.guild.members.me);
  if (missing.length) {
    throw transcriptError(
      `Missing transcript permissions: ${missing.join(', ')}`,
      `Cloudy is missing ${missing.join(', ')} in the transcript channel. Fix the channel permissions before deleting this ticket.`,
      'TICKET_TRANSCRIPT_PERMISSION_MISSING',
    );
  }

  const sent = await logTicketEvent({
    client: channel.client,
    guildId: channel.guild.id,
    event: {
      type: 'transcript',
      ticketId: channel.id,
      ticketNumber: ticketData?.ticketNumber || ticketData?.id,
      userId: ticketData?.userId,
      executorId: executor?.id || null,
      reason: ticketData?.reason || null,
      attachments: [transcript.attachment],
      metadata: {
        messageCount: transcript.messageCount,
        generatedAt: transcript.generatedAt,
        truncated: transcript.truncated,
      },
    },
  });

  if (!sent) {
    throw transcriptError(
      'Transcript log send returned false',
      'Cloudy could not save the transcript to the configured transcript channel. The ticket was not deleted.',
      'TICKET_TRANSCRIPT_SEND_FAILED',
    );
  }

  logger.info('Ticket transcript archived', {
    guildId: channel.guild.id,
    channelId: channel.id,
    destinationId,
    messageCount: transcript.messageCount,
    truncated: transcript.truncated,
  });

  return { ...transcript, sent: true, destination, reason: null };
}
