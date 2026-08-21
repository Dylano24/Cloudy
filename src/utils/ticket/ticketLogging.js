// ticketLogging.js

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { logger } from '../logger.js';
import {
  buildStandardLogEmbed,
  formatRatingStars,
  resolveUserAuthor,
} from '../logging/logEmbeds.js';

const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

function getRequiredDestinationPermissions({ attachments = false } = {}) {
  return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, ...(attachments ? [PermissionFlagsBits.AttachFiles] : [])];
}
function getMissingPermissions(channel, botMember, { attachments = false } = {}) {
  if (!channel || !botMember) return ['View Channel', 'Send Messages', 'Embed Links'];
  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return ['View Channel', 'Send Messages', 'Embed Links'];
  const required = [[PermissionFlagsBits.ViewChannel,'View Channel'],[PermissionFlagsBits.SendMessages,'Send Messages'],[PermissionFlagsBits.EmbedLinks,'Embed Links'],...(attachments ? [[PermissionFlagsBits.AttachFiles,'Attach Files']] : [])];
  return required.filter(([permission]) => !permissions.has(permission)).map(([, label]) => label);
}

export async function logTicketEvent({ client, guildId, event }) {
  try {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) { logger.warn(`logTicketEvent invoked without valid guild: ${guildId}`); return false; }
    const config = await getGuildConfig(client, guildId);
    const logChannelId = getLogChannelForEventType(config, event.type);
    if (!logChannelId) return false;
    const channel = guild.channels.cache.get(logChannelId) || await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel) { logger.warn(`Ticket log channel not found: ${logChannelId} for event type: ${event.type}`); return false; }
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || !channel.isSendable?.()) return false;
    const hasAttachments = Boolean(event.attachments?.length);
    const missing = getMissingPermissions(channel, guild.members.me, { attachments: hasAttachments });
    if (missing.length > 0) return false;
    const embed = await createTicketLogEmbed(guild, event);
    const messageOptions = { embeds: [embed] };
    if (hasAttachments) messageOptions.files = event.attachments;
    await channel.send(messageOptions);
    logger.info(`Ticket event logged: ${event.type} in guild ${guildId}`);
    return true;
  } catch (error) { logger.error('Error logging ticket event:', error); return false; }
}

export async function logTicketFeedback({ client, guildId, ticketNumber, ticketChannelId, userId, rating = null, comment = null }) {
  return await logTicketEvent({ client, guildId, event: { type: 'feedback', ticketId: ticketChannelId, ticketNumber, userId, metadata: { rating, comment } } });
}

function getLogChannelForEventType(config, eventType) {
  if (eventType === 'transcript') return config.ticketTranscriptChannelId || null;
  if (['open','close','delete','claim','unclaim','priority','pin','unpin','feedback'].includes(eventType)) return config.ticketLogsChannelId || null;
  return null;
}

const TICKET_EVENT_STYLES = {
  open: { color: 0xFFFFFF, title: 'Ticket Created' },
  close: { color: 0xFF7A00, title: 'Ticket Closed' },
  delete: { color: 0xED4245, title: 'Ticket Deleted' },
  claim: { color: 0x57F287, title: 'Ticket Claimed' },
  unclaim: { color: 0x000000, title: 'Ticket Unclaimed' },
  priority: { color: 0xFF1493, title: 'Priority Updated' },
  pin: { color: 0x8A2BE2, title: 'Ticket Pinned' },
  unpin: { color: 0x95A5A6, title: 'Ticket Unpinned' },
  transcript: { color: 0x57F287, title: 'Transcript Generated' },
  feedback: { color: 0x57F287, title: 'Feedback Received' },
};

async function createTicketLogEmbed(guild, event) {
  const style = TICKET_EVENT_STYLES[event.type] || { color: 0x95A5A6, title: 'Ticket Event' };
  const ticketNumber = event.ticketNumber || event.ticketId;
  const ticketRef = ticketNumber ? `#${ticketNumber}` : 'Unknown';
  const channelMention = event.ticketId ? `<#${event.ticketId}>` : null;
  const executorMention = event.executorId ? `<@${event.executorId}>` : null;
  const userMention = event.userId ? `<@${event.userId}>` : null;
  let inlineFields = []; let fields = []; let author = null;
  const footer = { text: CLOUDY_FOOTER };

  switch (event.type) {
    case 'open':
      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:'Creator',value:userMention || 'Unknown',inline:true }];
      if (channelMention) inlineFields.push({ name:'Channel',value:channelMention,inline:true });
      if (event.reason) fields.push({ name:'Reason',value:String(event.reason).slice(0,1024),inline:false });
      break;
    case 'close':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:'Closed by',value:executorMention || 'Unknown',inline:true }];
      if (channelMention) inlineFields.push({ name:'Channel',value:channelMention,inline:true });
      if (event.reason) fields.push({ name:'Reason',value:String(event.reason).slice(0,1024),inline:false });
      break;
    case 'delete':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:'Deleted by',value:executorMention || 'Unknown',inline:true }]; break;
    case 'claim': case 'unclaim':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:event.type === 'claim' ? 'Claimed by' : 'Unclaimed by',value:executorMention || 'Unknown',inline:true }]; break;
    case 'pin': case 'unpin':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:event.type === 'pin' ? 'Pinned by' : 'Unpinned by',value:executorMention || 'Unknown',inline:true }]; break;
    case 'priority': {
      const priorityEmojis = { none:'⚪',low:'🔵',medium:'🟢',high:'🟡',urgent:'🔴' };
      const priorityLabel = event.priority ? `${priorityEmojis[event.priority] || '⚪'} ${event.priority.charAt(0).toUpperCase()}${event.priority.slice(1)}` : 'Unknown';
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:'Priority',value:priorityLabel,inline:true},{ name:'Updated by',value:executorMention || 'Unknown',inline:true }]; break;
    }
    case 'transcript':
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:'Creator',value:userMention || 'Unknown',inline:true }];
      if (event.metadata?.messageCount != null) inlineFields.push({ name:'Messages',value:String(event.metadata.messageCount),inline:true });
      if (event.metadata?.duration) fields.push({ name:'Duration',value:String(event.metadata.duration),inline:false });
      if (event.metadata?.subject || event.reason) fields.push({ name:'Subject',value:String(event.metadata?.subject || event.reason).slice(0,1024),inline:false });
      break;
    case 'feedback': {
      const rating = event.metadata?.rating ?? event.rating; const comment = event.metadata?.comment;
      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true},{ name:'Rating',value:formatRatingStars(rating) || 'No rating',inline:true }];
      if (comment) fields.push({ name:'Comment',value:String(comment).slice(0,1024),inline:false }); break;
    }
    default:
      inlineFields = [{ name:'Ticket',value:ticketRef,inline:true }];
      if (event.reason) fields.push({ name:'Details',value:String(event.reason).slice(0,1024),inline:false });
  }
  const titlePrefix = event.type === 'feedback' ? '⭐ ' : '';
  return buildStandardLogEmbed({ color:style.color,title:`${titlePrefix}${style.title}`,inlineFields,fields,author,footer });
}

export async function getTicketLoggingConfig(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  return { enabled:!!(config.ticketLogsChannelId || config.ticketTranscriptChannelId),lifecycleChannelId:config.ticketLogsChannelId || null,transcriptChannelId:config.ticketTranscriptChannelId || null };
}

export function validateLogChannel(channel, botMember, { attachments = false } = {}) {
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return { valid:false,error:'Channel must be a text or announcement channel.',missing:[] };
  if (!channel.isSendable?.()) return { valid:false,error:'Channel is not sendable by the bot.',missing:[] };
  const missing = getMissingPermissions(channel, botMember, { attachments });
  if (missing.length > 0) return { valid:false,error:`Missing permissions: ${missing.join(', ')}`,missing };
  const permissions = channel.permissionsFor(botMember);
  if (!permissions?.has(getRequiredDestinationPermissions({ attachments }))) return { valid:false,error:'Required permissions are not available in this channel.',missing };
  return { valid:true,missing:[] };
}
