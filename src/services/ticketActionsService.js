import { AttachmentBuilder, PermissionFlagsBits } from 'discord.js';
import { getTicketData } from '../utils/database.js';

async function requireTicket(channel) {
  const ticketData = await getTicketData(channel.guild.id, channel.id);
  if (!ticketData) throw new Error('This channel is not a Cloudy ticket.');
  return ticketData;
}

function sanitizeChannelName(input) {
  const clean = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_ ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
  if (!clean) throw new Error('Choose a valid ticket channel name.');
  return clean;
}

export async function renameTicketChannel(channel, newName, actor) {
  const ticketData = await requireTicket(channel);
  const clean = sanitizeChannelName(newName);
  await channel.setName(clean, `Ticket renamed by ${actor.tag || actor.id}`);
  return { ticketData, name: clean };
}

export async function addTicketMember(channel, user, actor) {
  const ticketData = await requireTicket(channel);
  await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
  }, { reason: `Ticket access added by ${actor.tag || actor.id}` });
  return ticketData;
}

export async function removeTicketMember(channel, user, actor) {
  const ticketData = await requireTicket(channel);
  await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: false,
    SendMessages: false,
  }, { reason: `Ticket access removed by ${actor.tag || actor.id}` });
  return ticketData;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function createTicketTranscriptAttachment(channel) {
  const ticketData = await requireTicket(channel);
  const messages = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100 || messages.length >= 10_000) break;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const rows = messages.map((message) => {
    const timestamp = new Date(message.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const author = escapeHtml(message.author?.tag || message.author?.username || 'Unknown');
    let content = escapeHtml(message.content || '');

    if (message.attachments.size) {
      const attachments = [...message.attachments.values()]
        .map((attachment) => `<a href="${escapeHtml(attachment.url)}">${escapeHtml(attachment.name || 'attachment')}</a>`)
        .join(', ');
      content += `${content ? '<br>' : ''}<strong>Attachments:</strong> ${attachments}`;
    }
    if (message.embeds.length) {
      const embeds = message.embeds
        .map((embed) => escapeHtml(embed.title || embed.description || '[embed]'))
        .join(' | ');
      content += `${content ? '<br>' : ''}<strong>Embeds:</strong> ${embeds}`;
    }

    return `<tr><td class="ts">${timestamp}</td><td class="author">${author}</td><td>${content || '[empty message]'}</td></tr>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cloudy Ticket Transcript - ${escapeHtml(channel.name)}</title>
<style>
body{font-family:Arial,sans-serif;background:#1e1f22;color:#dbdee1;margin:0;padding:24px}
h1{margin:0 0 6px;color:#fff}.meta{color:#949ba4;margin-bottom:20px}
table{width:100%;border-collapse:collapse;background:#2b2d31}th,td{padding:8px 10px;border-bottom:1px solid #3f4147;text-align:left;vertical-align:top}th{color:#fff;background:#232428}.ts{white-space:nowrap;color:#949ba4}.author{white-space:nowrap;color:#80a8ff}a{color:#00a8fc}
</style>
</head>
<body>
<h1>Cloudy Ticket Transcript</h1>
<div class="meta">#${escapeHtml(channel.name)} • ${messages.length} messages • Ticket ID ${escapeHtml(ticketData.id)}</div>
<table><thead><tr><th>UTC</th><th>Author</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;

  const buffer = Buffer.from(html, 'utf8');
  if (buffer.length > 24 * 1024 * 1024) {
    throw new Error('This transcript is too large to upload to Discord.');
  }

  return {
    ticketData,
    messageCount: messages.length,
    attachment: new AttachmentBuilder(buffer, { name: `ticket-${channel.id}.html` }),
  };
}

export async function getTicketInfo(channel) {
  const ticketData = await requireTicket(channel);
  return {
    ...ticketData,
    memberAccess: channel.permissionOverwrites.cache
      .filter((overwrite) =>
        overwrite.type === 1
        && overwrite.allow.has(PermissionFlagsBits.ViewChannel)
      )
      .map((overwrite) => overwrite.id),
  };
}
