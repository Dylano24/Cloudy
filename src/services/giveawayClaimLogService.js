// Dedicated audit trail for giveaway prize claims. Never include the actual
// activation code, encrypted code, demo code or interaction response contents.
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_TICKET_CLOSED_COLOR } from '../utils/ticket/ticketBranding.js';
import { CLOUDY_RED_COLOR } from '../utils/embedColorPolicy.js';
import { unwrapReplitData } from '../utils/database.js';
import { getOrCreateGiveawayNumber } from './giveawayNumberService.js';

export const GIVEAWAY_CLAIM_LOG_CHANNEL_ID = '1566390264291917874';
export const GIVEAWAY_CLAIM_LOG_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

const EVENTS = Object.freeze({
  opened: { title: 'Giveaway claim opened', color: 0x00C49D, action: 'Claim' },
  revealed: { title: 'Giveaway code revealed', color: 0xFFFFFF, action: 'Reveal my code' },
  closed: { title: 'Giveaway claim closed', color: CLOUDY_TICKET_CLOSED_COLOR, action: 'Close' },
  expired: { title: 'Giveaway claim expired', color: CLOUDY_RED_COLOR, action: 'giveaway auto expiry' },
});

function safeValue(value, limit = 1024) {
  return String(value || 'Not specified').slice(0, limit);
}

export function buildGiveawayClaimLog({ event, guildId, messageId, userId,
  claimChannelId = null, giveaway = null, giveawayNumber = null, occurredAt = null } = {}) {
  const definition = EVENTS[event];
  if (!definition) throw new Error('Unsupported giveaway claim log event: ' + event);
  const sourceChannelId = giveaway?.channelId;
  const number = Number(giveawayNumber || giveaway?.giveawayNumber);
  const validNumber = Number.isSafeInteger(number) && number > 0;
  const label = validNumber ? '#' + number : 'Go to giveaway';
  // A closed or expired claim retains #N as text. While open, #N links to the
  // original giveaway, using the same Discord message URL as before.
  const canLink = event !== 'closed' && event !== 'expired'
    && sourceChannelId && /^\d{17,20}$/.test(String(sourceChannelId));
  const originalLink = canLink
    ? '[' + label + '](https://discord.com/channels/' + guildId + '/'
      + sourceChannelId + '/' + messageId + ')'
    : validNumber ? label : 'Message ID: `' + safeValue(messageId, 24) + '`';
  // Discord's :F format localizes the exact action time to the viewer.
  const stamp = new Date(occurredAt || Date.now()).getTime();
  const eventSeconds = Math.floor((Number.isFinite(stamp) ? stamp : Date.now()) / 1000);
  const fields = [
    { name: 'Member', value: '<@' + userId + '>', inline: false },
    { name: 'Prize', value: safeValue(giveaway?.prize, 500), inline: true },
    { name: 'Action', value: definition.action, inline: true },
    { name: 'Giveaway', value: originalLink, inline: false },
  ];
  if (claimChannelId) {
    fields.push({
      name: 'Private channel',
      value: event === 'closed' || event === 'expired'
        ? '`' + claimChannelId + '`'
        : '<#' + claimChannelId + '>',
      inline: false,
    });
  }
  fields.push({ name: 'Date', value: '<t:' + eventSeconds + ':F>', inline: false });
  if (event === 'expired') {
    fields.push({ name: 'Reason', value: 'The private claim channel reached its 24-hour deadline', inline: false });
  }
  return {
    embeds: [{
      title: definition.title,
      color: definition.color,
      thumbnail: { url: CLOUDY_C_LOGO_URL },
      fields,
      footer: { text: GIVEAWAY_CLAIM_LOG_FOOTER },
    }],
    allowedMentions: { parse: [] },
  };
}

export async function sendGiveawayClaimLog(client, guild, detail) {
  const target = guild?.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
    || await guild?.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
  if (!target?.send) throw new Error('Giveaway claim log channel unavailable');
  const giveawayNumber = await getOrCreateGiveawayNumber(client, guild.id, detail.messageId);
  return target.send(buildGiveawayClaimLog({ ...detail, guildId: guild.id, giveawayNumber }));
}

// One-time, in-place correction of already posted claim logs. Only remove
// their embed timestamp. Preserve the message, logo, fields and exact footer.
export async function removeExistingClaimLogTimestamps(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:no-timestamp-v1';
    try {
      if (await client.db?.get?.(marker, false)) continue;
      const channel = guild.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
        || await guild.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
      if (!channel?.messages?.fetch) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const message of messages?.values?.() || []) {
        if (message.author?.id !== client.user?.id || !message.edit) continue;
        let changed = false;
        const embeds = message.embeds.map(embed => {
          const data = embed.toJSON?.() || { ...embed };
          if (!data.timestamp || !Object.values(EVENTS).some(item => item.title === data.title)
            || data.footer?.text !== GIVEAWAY_CLAIM_LOG_FOOTER) return data;
          changed = true;
          const { timestamp, ...withoutTimestamp } = data;
          return withoutTimestamp;
        });
        if (changed) await message.edit({ embeds });
      }
      if (client.db?.set) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not remove old giveaway claim log timestamps in ' + guild.id, error);
    }
  }
}

 // One-time, in-place cleanup of previously published claim logs. Keep the
 // original message, links, logo, footer and all other fields untouched.
export async function refreshExistingGiveawayClaimLogPresentation(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:compact-fields-orange-close-v1';
    try {
      if (await client.db?.get?.(marker, false)) continue;
      const channel = guild.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
        || await guild.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
      if (!channel?.messages?.fetch) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const message of messages?.values?.() || []) {
        if (message.author?.id !== client.user?.id || !message.edit) continue;
        let changed = false;
        const embeds = (message.embeds || []).map(embed => {
          const data = embed.toJSON?.() || { ...embed };
          if (!Object.values(EVENTS).some(item => item.title === data.title)
            || data.footer?.text !== GIVEAWAY_CLAIM_LOG_FOOTER) return data;
          const fields = (data.fields || []).map(field => {
            if (!['Member', 'Private channel'].includes(field.name)) return field;
            const compact = String(field.value || '').replace(
              /^(<@!?\d{17,20}>|<#\d{17,20}>) \(\`\d{17,20}\`\)$/, '$1');
            if (compact === field.value) return field;
            changed = true;
            return { ...field, value: compact };
          });
          const isClosed = data.title === EVENTS.closed.title;
          if (isClosed && data.color !== CLOUDY_TICKET_CLOSED_COLOR) changed = true;
          return {
            ...data,
            fields,
            ...(isClosed ? { color: CLOUDY_TICKET_CLOSED_COLOR } : {}),
          };
        });
        if (changed) await message.edit({ embeds });
      }
      if (client.db?.set) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not refresh old giveaway claim log presentation in ' + guild.id, error);
    }
  }
}

 // A closed claim's Discord channel no longer resolves as a mention.
 // Update old closing logs in place so the former channel ID remains usable.
export async function refreshClosedGiveawayClaimLogChannels(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:closed-channel-id-v1';
    try {
      if (await client.db?.get?.(marker, false)) continue;
      const channel = guild.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
        || await guild.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
      if (!channel?.messages?.fetch) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const message of messages?.values?.() || []) {
        if (message.author?.id !== client.user?.id || !message.edit) continue;
        let changed = false;
        const embeds = (message.embeds || []).map(embed => {
          const data = embed.toJSON?.() || { ...embed };
          if (![EVENTS.closed.title, EVENTS.expired.title].includes(data.title)
            || data.footer?.text !== GIVEAWAY_CLAIM_LOG_FOOTER) return data;
          const fields = (data.fields || []).map(field => {
            if (field.name !== 'Private channel') return field;
            const match = /^<#([0-9]{17,20})>/.exec(String(field.value || ''));
            if (!match) return field;
            changed = true;
            return { ...field, value: '`' + match[1] + '`' };
          });
          return changed ? { ...data, fields } : data;
        });
        if (changed) await message.edit({ embeds });
      }
      if (client.db?.set) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not refresh closed giveaway claim channel IDs in ' + guild.id, error);
    }
  }
}

// After a claim channel closes, its mention resolves to #unknown in Discord.
// Preserve its original numeric ID in *every* related audit entry (including
// earlier Claim and Reveal entries), without changing any unrelated field.
const CLAIM_CHANNEL_ID_PATTERN = /^<#([0-9]{17,20})>(?: \(\x60[0-9]{17,20}\x60\))?$/;
const claimLogTitles = new Set(Object.values(EVENTS).map(event => event.title));

export function replaceClosedClaimChannelMentions(embed, closedChannelIds) {
  const data = embed?.toJSON?.() || { ...(embed || {}) };
  if (!claimLogTitles.has(data.title) || data.footer?.text !== GIVEAWAY_CLAIM_LOG_FOOTER) {
    return { embed: data, changed: false };
  }
  const privateChannel = (data.fields || []).find(field => field.name === 'Private channel');
  const matched = CLAIM_CHANNEL_ID_PATTERN.exec(String(privateChannel?.value || ''));
  if (!matched || !closedChannelIds.has(matched[1])) return { embed: data, changed: false };
  let changed = false;
  const fields = (data.fields || []).map(field => {
    if (field.name === 'Private channel') {
      changed = true;
      return { ...field, value: '`' + matched[1] + '`' };
    }
    if (field.name === 'Giveaway') {
      const link = /^\[(#[1-9]\d*)\]\(https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}\/\d{17,20}\)$/.exec(String(field.value || ''));
      if (link) {
        changed = true;
        return { ...field, value: link[1] };
      }
    }
    return field;
  });
  return { embed: changed ? { ...data, fields } : data, changed };
}

export async function updateClosedClaimChannelLogs(client, guild, closedChannelIds) {
  const knownIds = new Set([...closedChannelIds].filter(id => /^[0-9]{17,20}$/.test(String(id))).map(String));
  if (!knownIds.size) return 0;
  const channel = guild?.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
    || await guild?.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
  if (!channel?.messages?.fetch) return 0;
  let edited = 0;
  let before;
  // At most ten Discord pages; only run on closing and during one-time
  // migration, never on normal Claim or Reveal button interactions.
  for (let page = 0; page < 10; page++) {
    const options = before ? { limit: 100, before } : { limit: 100 };
    const messages = [...(await channel.messages.fetch(options)).values()];
    if (!messages.length) break;
    for (const message of messages) {
      if (message.author?.id !== client.user?.id || !message.edit) continue;
      const results = (message.embeds || []).map(embed =>
        replaceClosedClaimChannelMentions(embed, knownIds));
      if (!results.some(result => result.changed)) continue;
      await message.edit({ embeds: results.map(result => result.embed) });
      edited++;
    }
    if (messages.length < 100 || !messages[messages.length - 1]?.id) break;
    before = messages[messages.length - 1].id;
  }
  return edited;
}

// This migrates prior logs from claims closed before this feature was
// deployed. It keys by persisted claim state, never by an assumed channel
// name or a failed Discord mention lookup.
export async function refreshClosedClaimReferencesInEarlierLogs(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:closed-all-audit-refs-v1';
    try {
      if (await client.db?.get?.(marker, false)) continue;
      const raw = unwrapReplitData(await client.db?.get?.('guild:' + guild.id + ':giveaway-claim:records', {}));
      const closedIds = new Set(Object.values(raw || {})
        .filter(record => record?.closedAt && record?.channelId)
        .map(record => String(record.channelId)));
      await updateClosedClaimChannelLogs(client, guild, closedIds);
      if (client.db?.set) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not update older closed giveaway claim log references in ' + guild.id, error);
    }
  }
}


// A bounded, idempotent one-time update for previously posted Claim/Reveal/
// Close/Expired audit messages. Keep the exact original message, side colour,
// prize, member, logo, reason and footer; reconstruct action times from the
// Discord message creation time (not the migration time).
export async function refreshHistoricalGiveawayClaimNumbersAndDates(client) {
  if (!client?.db?.get || !client?.db?.set) return;
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:number-date-v1';
    try {
      if (await client.db.get(marker, false)) continue;
      const channel = guild.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
        || await guild.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
      if (!channel?.messages?.fetch) continue;
      const rawClaims = unwrapReplitData(await client.db.get(
        'guild:' + guild.id + ':giveaway-claim:records', {}));
      const claimByChannel = new Map(Object.values(rawClaims || {}).filter(record =>
        record?.channelId && record?.messageId)
        .map(record => [String(record.channelId), record]));
      const all = [];
      let before;
      let complete = false;
      // Match the existing audit migration's finite history window.
      for (let page = 0; page < 10; page++) {
        const list = [...(await channel.messages.fetch(before
          ? { limit: 100, before } : { limit: 100 })).values()];
        all.push(...list);
        if (list.length < 100 || !list.at(-1)?.id) { complete = true; break; }
        before = list.at(-1).id;
      }
      // Assign numbers to missing historical records in chronological order.
      for (const message of all.reverse()) {
        if (message.author?.id !== client.user?.id || !message.edit) continue;
        let changed = false;
        const embeds = [];
        for (const embed of message.embeds || []) {
          const data = embed.toJSON?.() || { ...embed };
          if (!claimLogTitles.has(data.title)
            || data.footer?.text !== GIVEAWAY_CLAIM_LOG_FOOTER) {
            embeds.push(data);
            continue;
          }
          const fields = data.fields || [];
          const current = fields.find(field => field.name === 'Giveaway');
          const oldValue = String(current?.value || '');
          const originalUrl = /https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}\/\d{17,20}/.exec(oldValue)?.[0];
          const fromLink = originalUrl?.split('/').at(-1);
          const legacyId = /Message ID:\s*`(\d{17,20})`/.exec(oldValue)?.[1];
          const privateValue = fields.find(field => field.name === 'Private channel')?.value || '';
          const privateId = /\d{17,20}/.exec(privateValue)?.[0];
          const claimRecord = claimByChannel.get(privateId);
          const messageId = fromLink || legacyId || claimRecord?.messageId;
          if (!messageId) { embeds.push(data); continue; }
          const number = await getOrCreateGiveawayNumber(client, guild.id, messageId);
          const closed = data.title === EVENTS.closed.title || data.title === EVENTS.expired.title
            || Boolean(claimRecord?.closedAt);
          const nextValue = closed || !originalUrl ? '#' + number
            : '[#' + number + '](' + originalUrl + ')';
          let nextFields = fields.map(field =>
            field.name === 'Giveaway' && field.value !== nextValue
              ? (changed = true, { ...field, value: nextValue }) : field);
          if (!nextFields.some(field => field.name === 'Date')) {
            let occurredAt = Number(message.createdTimestamp)
              || Date.parse(message.createdAt || '');
            if (!Number.isFinite(occurredAt) && /^\d{17,20}$/.test(String(message.id || ''))) {
              occurredAt = Number((BigInt(message.id) >> 22n) + 1420070400000n);
            }
            if (Number.isFinite(occurredAt)) {
              const after = nextFields.findIndex(field => field.name === 'Private channel');
              const index = after >= 0 ? after + 1 : nextFields.length;
              nextFields.splice(index, 0, {
                name: 'Date', value: '<t:' + Math.floor(occurredAt / 1000) + ':F>', inline: false,
              });
              changed = true;
            }
          }
          if (data.title === EVENTS.expired.title) {
            nextFields = nextFields.map(field =>
              field.name === 'Action' && field.value !== EVENTS.expired.action
                ? (changed = true, { ...field, value: EVENTS.expired.action }) : field);
          }
          embeds.push({ ...data, fields: nextFields });
        }
        if (changed) await message.edit({ embeds });
      }
      if (complete) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not update old giveaway claim numbers/dates in ' + guild.id, error);
    }
  }
}

// One-time, bounded migration of old automatic 24-hour deletion logs.
// Only the expired entry's Action and standard Cloudy red side line change;
// manual Close, existing #numbers, dates, links, logo, and footer stay intact.
export async function refreshGiveawayAutoExpiryLogAction(client) {
  if (!client?.db?.get || !client?.db?.set) return;
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:auto-expiry-action-v1';
    try {
      if (await client.db.get(marker, false)) continue;
      const channel = guild.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
        || await guild.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
      if (!channel?.messages?.fetch) continue;
      let before;
      let complete = false;
      for (let page = 0; page < 10; page++) {
        const messages = [...(await channel.messages.fetch(before
          ? { limit: 100, before } : { limit: 100 })).values()];
        for (const message of messages) {
          if (message.author?.id !== client.user?.id || !message.edit) continue;
          let changed = false;
          const embeds = (message.embeds || []).map(embed => {
            const data = embed.toJSON?.() || { ...embed };
            if (data.title !== EVENTS.expired.title
              || data.footer?.text !== GIVEAWAY_CLAIM_LOG_FOOTER) return data;
            const fields = (data.fields || []).map(field => {
              if (field.name !== 'Action' || field.value === EVENTS.expired.action) return field;
              changed = true;
              return { ...field, value: EVENTS.expired.action };
            });
            if (data.color !== CLOUDY_RED_COLOR) changed = true;
            return changed ? { ...data, fields, color: CLOUDY_RED_COLOR } : data;
          });
          if (changed) await message.edit({ embeds });
        }
        if (messages.length < 100 || !messages.at(-1)?.id) {
          complete = true;
          break;
        }
        before = messages.at(-1).id;
      }
      if (complete) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not refresh giveaway auto-expiry audit logs in ' + guild.id, error);
    }
  }
}

// Remove only obsolete Claim accessed/denied notices previously sent by
// Cloudy. Leave the three requested audit types, 24-hour expiry and every
// other message in the log channel unchanged.
const REDUNDANT_CLAIM_LOG_TITLES = new Set([
  'Giveaway claim accessed',
  'Giveaway claim denied',
]);

export async function removeRedundantGiveawayClaimLogs(client) {
  if (!client?.db?.get || !client?.db?.set) return;
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const marker = 'guild:' + guild.id + ':giveaway-claim:remove-extra-logs-v1';
    try {
      if (await client.db.get(marker, false)) continue;
      const channel = guild.channels?.cache?.get?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID)
        || await guild.channels?.fetch?.(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
      if (!channel?.messages?.fetch) continue;
      // One-time, limited catch-up for legacy messages, not a repeated scan.
      let before;
      let complete = false;
      for (let page = 0; page < 10; page++) {
        const options = before ? { limit: 100, before } : { limit: 100 };
        const messages = [...(await channel.messages.fetch(options)).values()];
        for (const message of messages) {
          if (message.author?.id !== client.user?.id || !message.delete) continue;
          const isObsolete = (message.embeds || []).some(embed => {
            const data = embed.toJSON?.() || embed;
            return REDUNDANT_CLAIM_LOG_TITLES.has(data.title)
              && data.footer?.text === GIVEAWAY_CLAIM_LOG_FOOTER;
          });
          if (isObsolete) await message.delete();
        }
        if (messages.length < 100 || !messages[messages.length - 1]?.id) {
          complete = true;
          break;
        }
        before = messages[messages.length - 1].id;
      }
      if (complete) await client.db.set(marker, true);
    } catch (error) {
      logger.warn('Could not remove redundant giveaway claim audit logs in ' + guild.id, error);
    }
  }
}
