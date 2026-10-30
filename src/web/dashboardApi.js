// Cloudy Dashboard API: the private, signed connection used by the Cloudy
// Store Bot dashboard. Every read and write goes through the same services as
// Cloudy's own Discord dashboards, so caches, write queues and validation stay
// in charge and no restart is needed. Saving never edits a posted message by
// itself; only the explicit panel actions do, exactly like in Discord.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig, patchGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig, updateWelcomeConfig, getApplicationSettings, saveApplicationSettings, getJoinToCreateConfig, updateJoinToCreateConfig } from '../utils/database.js';
import { getLevelingConfig } from '../services/leveling/leveling.js';
import { getCountingGameConfig, saveCountingGameConfig } from '../services/countingGameService.js';
import { saveTicketDashboardSetting, moveTicketPanel, repostTicketPanel } from '../services/ticketDashboardService.js';
import { updateLivePanel as updateVerificationPanel, repostVerificationPanel } from '../commands/Verification/modules/verification_dashboard.js';
import { hasCloudyOwnerMember } from '../services/ownerRoleAccess.js';
import { getGuildGiveaways } from '../utils/giveaways.js';
import { giveawayEndTime, giveawayParticipants, isGiveawayFinished } from '../services/giveawayService.js';
import { getAllReactionRoleMessages } from '../services/reactionRoleService.js';
import { getEmbedRegistry } from '../services/embedRegistryService.js';
import { readFeeds } from '../services/cloudyFeedService.js';
import { WarningService } from '../services/moderation/warningService.js';
import { readGuildEconomyValues } from '../utils/economy.js';
import { getEconomyPrefix } from '../utils/database/keys.js';
import { BotConfig } from '../config/bot.js';

export const DASHBOARD_PREFIX = '/api/dashboard/v1';
const MAX_SKEW_SECONDS = 60;
const NONCE_TTL_MS = 120_000;
const WRITES_PER_MINUTE = 30;
const AUDIT_LIMIT = 200;
const SNOWFLAKE = /^\d{17,20}$/;

// ---------------------------------------------------------------- signing

export function canonicalString({ method, path, timestamp, nonce, actorId, body }) {
  const bodyHash = createHash('sha256').update(body || '').digest('hex');
  return ['cloudy-dashboard-v1', String(method).toUpperCase(), path, timestamp, nonce, actorId, bodyHash].join('\n');
}

export function createNonceStore(now = () => Date.now(), limit = 10_000) {
  const seen = new Map();
  return {
    // Returns false when the nonce was already used inside its lifetime.
    remember(nonce) {
      const at = now();
      for (const [key, expires] of seen) { if (expires > at) break; seen.delete(key); }
      if (seen.has(nonce) && seen.get(nonce) > at) return false;
      seen.set(nonce, at + NONCE_TTL_MS);
      while (seen.size > limit) seen.delete(seen.keys().next().value);
      return true;
    },
  };
}

export function verifySignedRequest({ method, path, headers, body, secret, nonces, nowMs = Date.now() }) {
  if (!secret || secret.length < 32) return { ok: false, status: 503, code: 'not_configured' };
  const timestamp = String(headers['x-cloudy-dashboard-timestamp'] || '');
  const nonce = String(headers['x-cloudy-dashboard-nonce'] || '');
  const actorId = String(headers['x-cloudy-dashboard-actor'] || '');
  const signature = String(headers['x-cloudy-dashboard-signature'] || '');
  if (!/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !SNOWFLAKE.test(actorId) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return { ok: false, status: 401, code: 'unauthorized' };
  }
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, status: 401, code: 'expired' };
  const expected = createHmac('sha256', secret).update(canonicalString({ method, path, timestamp, nonce, actorId, body })).digest('base64url');
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { ok: false, status: 401, code: 'unauthorized' };
  if (!nonces.remember(nonce)) return { ok: false, status: 401, code: 'replayed' };
  return { ok: true, actorId };
}

// ---------------------------------------------------------------- values

const idOf = value => (value && typeof value === 'object' ? value.id : value) || null;
const str = value => (typeof value === 'string' ? value : '');
function setPath(object, path, value) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}
const colorHex = value => (typeof value === 'number' ? `#${value.toString(16).padStart(6, '0').toUpperCase()}` : /^#[0-9a-f]{6}$/i.test(str(value)) ? str(value).toUpperCase() : '');
const trueKeys = record => Object.fromEntries(Object.entries(record && typeof record === 'object' ? record : {}).filter(([, value]) => value === true).map(([key]) => [String(key).toLowerCase(), true]));

export function revisionOf(values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('base64url').slice(0, 22);
}

// Field rules mirror the website's catalog; Cloudy checks them again here.
const T = {
  bool: { t: 'bool' }, id: { t: 'id' },
  text: (max, min = 0) => ({ t: 'text', max, min }), area: max => ({ t: 'area', max }), url: max => ({ t: 'url', max }),
  ids: max => ({ t: 'ids', max }), num: (min, max) => ({ t: 'num', min, max }), choice: values => ({ t: 'choice', values }),
  color: { t: 'color' }, flags: keys => ({ t: 'flags', keys }), levelRoles: { t: 'levelRoles' }, list: (min, max, itemMax) => ({ t: 'list', min, max, itemMax }),
};
// Control characters other than tab and newline are never valid in Discord text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function checkValue(rule, value) {
  switch (rule.t) {
    case 'bool': return typeof value === 'boolean';
    case 'id': return value === null || (typeof value === 'string' && SNOWFLAKE.test(value));
    case 'ids': return Array.isArray(value) && value.length <= rule.max && value.every(entry => typeof entry === 'string' && SNOWFLAKE.test(entry)) && new Set(value).size === value.length;
    case 'text': return typeof value === 'string' && value.length >= rule.min && value.length <= rule.max && !CONTROL.test(value) && !/[\r\n]/.test(value);
    case 'area': return typeof value === 'string' && value.length <= rule.max && !CONTROL.test(value);
    case 'url': {
      if (value === '') return true;
      if (typeof value !== 'string' || value.length > rule.max) return false;
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
    }
    case 'num': return Number.isInteger(value) && value >= rule.min && value <= rule.max;
    case 'choice': return rule.values.includes(value);
    case 'color': return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    case 'flags': return value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, flag]) => rule.keys.includes(key) && typeof flag === 'boolean');
    case 'levelRoles': return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 25
      && Object.entries(value).every(([level, role]) => /^\d{1,3}$/.test(level) && Number(level) >= 1 && Number(level) <= 500 && typeof role === 'string' && SNOWFLAKE.test(role));
    case 'list': return Array.isArray(value) && value.length >= rule.min && value.length <= rule.max
      && value.every(entry => typeof entry === 'string' && entry.trim() && entry.length <= rule.itemMax && !CONTROL.test(entry) && !/[\r\n]/.test(entry));
    default: return false;
  }
}

const LOG_EVENTS = ['moderation.ban', 'moderation.unban', 'moderation.kick', 'moderation.timeout', 'moderation.untimeout', 'moderation.warn', 'moderation.purge', 'moderation.lock', 'moderation.unlock', 'moderation.dm', 'moderation.config', 'message.delete', 'message.edit', 'message.bulkdelete', 'member.join', 'member.leave', 'member.namechange', 'role.create', 'role.delete', 'role.update', 'reactionrole.create', 'reactionrole.update', 'reactionrole.delete', 'reactionrole.add', 'reactionrole.remove', 'giveaway.create', 'giveaway.winner', 'giveaway.reroll', 'giveaway.delete', 'leveling.levelup', 'leveling.milestone', 'counter.update', 'counter.config', 'application.submit', 'application.review', 'report.file'];
const CATEGORIES = ['birthday', 'community', 'core', 'economy', 'fun', 'giveaway', 'jointocreate', 'leveling', 'logging', 'moderation', 'music', 'reaction_roles', 'search', 'serverstats', 'ticket', 'tools', 'utility', 'verification', 'welcome'];
const COUNTING_SYSTEMS = ['decimal', 'hexadecimal', 'binary', 'base36', 'base64', 'roman', 'math', 'alphabet'];

class DashboardError extends Error {
  constructor(message, status = 400, code = 'invalid', path = undefined) { super(message); this.status = status; this.code = code; this.path = path; }
}
const userMessage = (error, fallback) => String(error?.userMessage || error?.message || fallback).slice(0, 200);

function roleUsable(guild, roleId) {
  const role = guild.roles.cache.get(roleId);
  const highest = guild.members.me?.roles?.highest?.position ?? 0;
  if (!role || role.id === guild.id || role.managed) throw new DashboardError('That role cannot be used. Choose a normal server role.');
  if (role.position >= highest) throw new DashboardError(`Cloudy's role must be above @${role.name} in Server Settings → Roles.`);
}
function channelOfType(guild, channelId, types, label) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !types.includes(channel.type)) throw new DashboardError(`Choose a valid ${label}.`);
  return channel;
}
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

// Each module: read(ctx) → flat values by field path, write(ctx, changes, current).
export const MODULES = {
  general: {
    fields: { prefix: T.text(10, 1), modRole: T.id, adminRole: T.id, premiumRoleId: T.id },
    async read({ client, guild }) {
      const config = await getGuildConfig(client, guild.id);
      return { prefix: str(config.prefix), modRole: idOf(config.modRole), adminRole: idOf(config.adminRole), premiumRoleId: idOf(config.premiumRoleId) };
    },
    async write({ client, guild }, changes) {
      await patchGuildConfig(client, guild.id, changes, { source: 'dashboard' });
    },
  },
  commands: {
    fields: { disabledCategories: T.flags(CATEGORIES) },
    async read({ client, guild }) {
      const config = await getGuildConfig(client, guild.id);
      return { disabledCategories: trueKeys(config.disabledCategories) };
    },
    async write({ client, guild }, changes) {
      const config = await getGuildConfig(client, guild.id);
      const next = trueKeys(config.disabledCategories);
      for (const category of CATEGORIES) {
        if (changes.disabledCategories[category] === true) next[category] = true; else delete next[category];
      }
      // Same write as /commands: the whole record, so enabling removes the key.
      await updateGuildConfig(client, guild.id, { disabledCategories: next }, { source: 'dashboard' });
    },
  },
  logging: {
    fields: {
      'logging.enabled': T.bool, 'logging.channels.audit': T.id, 'logging.channels.applications': T.id, 'logging.channels.reports': T.id,
      'logging.enabledEvents': T.flags(LOG_EVENTS), 'logging.ignore.channels': T.ids(25),
    },
    async read({ client, guild }) {
      const logging = (await getGuildConfig(client, guild.id)).logging || {};
      return {
        'logging.enabled': logging.enabled === true,
        'logging.channels.audit': logging.channels?.audit || null,
        'logging.channels.applications': logging.channels?.applications || null,
        'logging.channels.reports': logging.channels?.reports || null,
        'logging.enabledEvents': Object.fromEntries(Object.entries(logging.enabledEvents || {}).filter(([key]) => LOG_EVENTS.includes(key)).map(([key, value]) => [key, value === true])),
        'logging.ignore.channels': Array.isArray(logging.ignore?.channels) ? logging.ignore.channels.filter(id => SNOWFLAKE.test(id)) : [],
      };
    },
    async write({ client, guild }, changes) {
      for (const key of ['logging.channels.audit', 'logging.channels.applications', 'logging.channels.reports']) {
        if (changes[key]) channelOfType(guild, changes[key], TEXT_TYPES, 'text channel');
      }
      const config = await getGuildConfig(client, guild.id);
      const logging = structuredClone(config.logging || {});
      for (const [path, value] of Object.entries(changes)) setPath(logging, path.slice('logging.'.length), value);
      await patchGuildConfig(client, guild.id, { logging }, { source: 'dashboard' });
    },
  },
  welcome: {
    fields: {
      enabled: T.bool, channelId: T.id, welcomePing: T.bool, welcomeMessage: T.area(2000),
      goodbyeEnabled: T.bool, goodbyeChannelId: T.id, goodbyePing: T.bool, leaveMessage: T.area(2000),
      'leaveEmbed.title': T.text(256), 'leaveEmbed.color': T.color, 'leaveEmbed.footer': T.text(2048), 'leaveEmbed.image': T.url(500),
    },
    async read({ client, guild }) {
      const config = await getWelcomeConfig(client, guild.id);
      const leave = config.leaveEmbed || {};
      return {
        enabled: config.enabled === true, channelId: config.channelId || null, welcomePing: config.welcomePing === true,
        welcomeMessage: str(config.welcomeMessage), goodbyeEnabled: config.goodbyeEnabled === true,
        goodbyeChannelId: config.goodbyeChannelId || null, goodbyePing: config.goodbyePing === true, leaveMessage: str(config.leaveMessage),
        'leaveEmbed.title': str(leave.title), 'leaveEmbed.color': colorHex(leave.color) || '#7A1712',
        'leaveEmbed.footer': str(leave.footer), 'leaveEmbed.image': typeof leave.image === 'string' ? leave.image : str(leave.image?.url),
      };
    },
    async write({ client, guild }, changes) {
      for (const key of ['channelId', 'goodbyeChannelId']) if (changes[key]) channelOfType(guild, changes[key], TEXT_TYPES, 'text channel');
      const config = await getWelcomeConfig(client, guild.id, { strict: true });
      const updates = {};
      const leaveEmbed = { ...(config.leaveEmbed || {}) };
      let leaveChanged = false;
      for (const [path, value] of Object.entries(changes)) {
        if (path.startsWith('leaveEmbed.')) {
          const key = path.slice('leaveEmbed.'.length);
          if (key === 'image' && value === '') delete leaveEmbed.image; else leaveEmbed[key] = value;
          leaveChanged = true;
        } else updates[path] = value;
      }
      if (leaveChanged) updates.leaveEmbed = leaveEmbed;
      await updateWelcomeConfig(client, guild.id, updates);
    },
  },
  autoroles: {
    fields: { roleIds: T.ids(1) },
    async read({ client, guild }) {
      const config = await getWelcomeConfig(client, guild.id);
      return { roleIds: Array.isArray(config.roleIds) ? config.roleIds.filter(id => SNOWFLAKE.test(id)).slice(0, 1) : [] };
    },
    async write({ client, guild }, changes) {
      for (const roleId of changes.roleIds) roleUsable(guild, roleId);
      const config = await getWelcomeConfig(client, guild.id, { strict: true });
      // Only the first auto role is given on join today; keep any others untouched.
      const rest = (Array.isArray(config.roleIds) ? config.roleIds : []).slice(1);
      await updateWelcomeConfig(client, guild.id, { roleIds: [...changes.roleIds, ...rest.filter(id => !changes.roleIds.includes(id))] });
    },
  },
  verification: {
    fields: {
      'verification.enabled': T.bool, 'verification.channelId': T.id, 'verification.roleId': T.id, 'verification.message': T.area(2000),
      'verification.buttonText': T.text(80, 1), 'verification.autoVerify.enabled': T.bool,
      'verification.autoVerify.criteria': T.choice(['none', 'account_age', 'server_size']), 'verification.autoVerify.accountAgeDays': T.num(1, 365),
    },
    async read({ client, guild }) {
      const verification = (await getGuildConfig(client, guild.id)).verification || {};
      const auto = verification.autoVerify || {};
      return {
        'verification.enabled': verification.enabled === true, 'verification.channelId': verification.channelId || null,
        'verification.roleId': verification.roleId || null, 'verification.message': str(verification.message),
        'verification.buttonText': str(verification.buttonText) || 'Verify', 'verification.autoVerify.enabled': auto.enabled === true,
        'verification.autoVerify.criteria': ['none', 'account_age', 'server_size'].includes(auto.criteria) ? auto.criteria : 'none',
        'verification.autoVerify.accountAgeDays': Number.isInteger(auto.accountAgeDays) ? auto.accountAgeDays : 7,
      };
    },
    async write({ client, guild }, changes) {
      if (changes['verification.channelId']) channelOfType(guild, changes['verification.channelId'], TEXT_TYPES, 'text channel');
      if (changes['verification.roleId']) roleUsable(guild, changes['verification.roleId']);
      const config = await getGuildConfig(client, guild.id);
      const before = structuredClone(config.verification || {});
      const next = structuredClone(before);
      for (const [path, value] of Object.entries(changes)) setPath(next, path.slice('verification.'.length), value);
      if (next.roleId === null) delete next.roleId;
      const channelChanged = 'verification.channelId' in changes && changes['verification.channelId'] !== (before.channelId || null);
      // Same as the Discord dashboard: a new channel gets a new panel and the old one is removed.
      if (channelChanged) {
        if (before.channelId && before.messageId) {
          const old = guild.channels.cache.get(before.channelId);
          await old?.messages?.fetch(before.messageId).then(message => message.delete()).catch(() => null);
        }
        delete next.messageId;
        if (next.channelId && next.enabled !== false) {
          const posted = await repostVerificationPanel(guild, next).catch(error => { throw new DashboardError(userMessage(error, 'Cloudy could not post the panel in that channel.')); });
          next.messageId = posted.id;
        }
      }
      await patchGuildConfig(client, guild.id, { verification: next }, { source: 'dashboard' });
      if (!channelChanged && ('verification.message' in changes || 'verification.buttonText' in changes)) {
        await updateVerificationPanel(guild, next);
      }
    },
    actions: {
      async 'repost-panel'({ client, guild }) {
        const config = await getGuildConfig(client, guild.id);
        const verification = structuredClone(config.verification || {});
        if (!verification.channelId) throw new DashboardError('Choose a panel channel first.');
        const posted = await repostVerificationPanel(guild, verification).catch(error => { throw new DashboardError(userMessage(error, 'Cloudy could not post the panel.')); });
        verification.messageId = posted.id;
        await patchGuildConfig(client, guild.id, { verification }, { source: 'dashboard' });
        return 'The verification panel was posted again.';
      },
    },
  },
  leveling: {
    fields: {
      enabled: T.bool, 'xpRange.min': T.num(1, 500), 'xpRange.max': T.num(1, 500), xpCooldown: T.num(0, 3600), announceLevelUp: T.bool,
      levelUpChannel: T.id, levelUpMessage: T.area(500), roleRewards: T.levelRoles, ignoredChannels: T.ids(25), ignoredRoles: T.ids(25),
    },
    async read({ client, guild }) {
      const config = await getLevelingConfig(client, guild.id);
      const range = config.xpRange || config.xpPerMessage || {};
      return {
        enabled: config.enabled !== false, 'xpRange.min': Number(range.min) || 15, 'xpRange.max': Number(range.max) || 25,
        xpCooldown: Number.isInteger(config.xpCooldown) ? config.xpCooldown : 60, announceLevelUp: config.announceLevelUp !== false,
        levelUpChannel: config.levelUpChannel || null, levelUpMessage: str(config.levelUpMessage),
        roleRewards: Object.fromEntries(Object.entries(config.roleRewards || {}).filter(([, role]) => SNOWFLAKE.test(String(role)))),
        ignoredChannels: Array.isArray(config.ignoredChannels) ? config.ignoredChannels : [], ignoredRoles: Array.isArray(config.ignoredRoles) ? config.ignoredRoles : [],
      };
    },
    async write({ client, guild }, changes, current) {
      const min = changes['xpRange.min'] ?? current['xpRange.min'];
      const max = changes['xpRange.max'] ?? current['xpRange.max'];
      if (min > max) throw new DashboardError('Minimum XP cannot be greater than maximum XP.', 400, 'invalid', 'xpRange.min');
      if (changes.levelUpChannel) channelOfType(guild, changes.levelUpChannel, TEXT_TYPES, 'text channel');
      for (const roleId of Object.values(changes.roleRewards || {})) roleUsable(guild, roleId);
      const next = structuredClone(await getLevelingConfig(client, guild.id));
      for (const [path, value] of Object.entries(changes)) setPath(next, path, value);
      await patchGuildConfig(client, guild.id, { leveling: next }, { source: 'dashboard' });
    },
  },
  birthdays: {
    fields: { birthdayChannelId: T.id },
    async read({ client, guild }) { return { birthdayChannelId: idOf((await getGuildConfig(client, guild.id)).birthdayChannelId) }; },
    async write({ client, guild }, changes) {
      if (changes.birthdayChannelId) channelOfType(guild, changes.birthdayChannelId, TEXT_TYPES, 'text channel');
      await patchGuildConfig(client, guild.id, changes, { source: 'dashboard' });
    },
  },
  applications: {
    fields: {
      enabled: T.bool, logChannelId: T.id, managerRoles: T.ids(10), questions: T.list(1, 5, 100),
      pendingApplicationRetentionDays: T.num(1, 3650), reviewedApplicationRetentionDays: T.num(1, 3650),
    },
    async read({ client, guild }) {
      const settings = await getApplicationSettings(client, guild.id);
      return {
        enabled: settings.enabled === true, logChannelId: settings.logChannelId || null,
        managerRoles: Array.isArray(settings.managerRoles) ? settings.managerRoles : [],
        questions: Array.isArray(settings.questions) ? settings.questions.filter(question => typeof question === 'string').slice(0, 5) : [],
        pendingApplicationRetentionDays: Number(settings.pendingApplicationRetentionDays) || 30,
        reviewedApplicationRetentionDays: Number(settings.reviewedApplicationRetentionDays) || 14,
      };
    },
    async write({ client, guild }, changes) {
      if (changes.logChannelId) channelOfType(guild, changes.logChannelId, TEXT_TYPES, 'text channel');
      const updates = { ...changes };
      if (updates.questions) updates.questions = updates.questions.map(question => question.trim());
      if (!(await saveApplicationSettings(client, guild.id, updates))) throw new DashboardError('Cloudy could not save the application settings.', 503, 'storage');
    },
  },
  tickets: {
    fields: {
      ticketStaffRoleId: T.id, maxTicketsPerUser: T.num(1, 10), ticketPanelChannelId: T.id, ticketPanelMessage: T.area(4000),
      ticketButtonLabel: T.text(80), ticketCategoryId: T.id, ticketClosedCategoryId: T.id, ticketLogsChannelId: T.id, ticketTranscriptChannelId: T.id,
    },
    async read({ client, guild }) {
      const config = await getGuildConfig(client, guild.id);
      return {
        ticketStaffRoleId: config.ticketStaffRoleId || null, maxTicketsPerUser: Number(config.maxTicketsPerUser) || 3,
        ticketPanelChannelId: config.ticketPanelChannelId || null, ticketPanelMessage: str(config.ticketPanelMessage), ticketButtonLabel: str(config.ticketButtonLabel),
        ticketCategoryId: config.ticketCategoryId || null, ticketClosedCategoryId: config.ticketClosedCategoryId || null,
        ticketLogsChannelId: config.ticketLogsChannelId || null, ticketTranscriptChannelId: config.ticketTranscriptChannelId || null,
      };
    },
    async write({ client, guild }, changes) {
      // The Discord ticket dashboard's own save functions, field by field.
      for (const [field, value] of Object.entries(changes)) {
        if (field === 'ticketPanelChannelId') {
          if (!value) throw new DashboardError('Choose a panel channel.', 400, 'invalid', field);
          await moveTicketPanel(client, guild, value).catch(error => { throw new DashboardError(userMessage(error, 'Cloudy could not move the panel.'), 400, 'invalid', field); });
        } else {
          const stored = (field === 'ticketPanelMessage' || field === 'ticketButtonLabel') && value === '' ? null : value;
          await saveTicketDashboardSetting(client, guild, field, stored).catch(error => { throw new DashboardError(userMessage(error, 'That ticket setting could not be saved.'), 400, 'invalid', field); });
        }
      }
    },
    actions: {
      async 'repost-panel'({ client, guild }) {
        await repostTicketPanel(client, guild).catch(error => { throw new DashboardError(userMessage(error, 'Cloudy could not post the panel.')); });
        return 'The ticket panel was posted again.';
      },
    },
  },
  counting: {
    fields: { enabled: T.bool, channelId: T.id, system: T.choice(COUNTING_SYSTEMS) },
    async read({ client, guild }) {
      const config = await getCountingGameConfig(client, guild.id);
      return { enabled: config.enabled === true, channelId: config.channelId || null, system: config.system };
    },
    async write({ client, guild }, changes) {
      if (changes.channelId) channelOfType(guild, changes.channelId, TEXT_TYPES, 'text channel');
      const config = await getCountingGameConfig(client, guild.id);
      const next = { ...config, ...changes };
      if (next.enabled && !next.channelId) throw new DashboardError('Choose a counting channel first.', 400, 'invalid', 'channelId');
      await saveCountingGameConfig(client, guild.id, next);
    },
  },
  jointocreate: {
    fields: { enabled: T.bool, triggerChannels: T.ids(10), categoryId: T.id, channelNameTemplate: T.text(100, 1), userLimit: T.num(0, 99), bitrate: T.num(8000, 384000) },
    async read({ client, guild }) {
      const config = await getJoinToCreateConfig(client, guild.id);
      return {
        enabled: config.enabled === true, triggerChannels: Array.isArray(config.triggerChannels) ? config.triggerChannels : [],
        categoryId: config.categoryId || null, channelNameTemplate: str(config.channelNameTemplate) || "{username}'s Room",
        userLimit: Number(config.userLimit) || 0, bitrate: Number(config.bitrate) || 64000,
      };
    },
    async write({ client, guild }, changes) {
      for (const id of changes.triggerChannels || []) channelOfType(guild, id, [ChannelType.GuildVoice], 'voice channel');
      if (changes.categoryId) channelOfType(guild, changes.categoryId, [ChannelType.GuildCategory], 'category');
      if (changes.bitrate && changes.bitrate > (guild.maximumBitrate || 96000)) {
        throw new DashboardError(`This server allows up to ${Math.floor((guild.maximumBitrate || 96000) / 1000)} kbps.`, 400, 'invalid', 'bitrate');
      }
      await updateJoinToCreateConfig(client, guild.id, changes);
    },
  },
};

// ---------------------------------------------------------------- overviews (read-only, live)

const iso = ms => (ms ? new Date(ms).toISOString() : '');
function memberName(guild, userId) {
  const member = guild.members.cache.get(String(userId));
  return member ? (member.displayName || member.user?.username || String(userId)) : String(userId || '');
}
function channelName(guild, channelId) {
  const channel = guild.channels.cache.get(String(channelId));
  return channel ? `#${channel.name}` : '';
}

export const INSIGHTS = {
  async moderation({ guild }) {
    const warnings = await WarningService.getGuildWarnings(guild.id, { limit: 50 });
    const people = new Set(warnings.map(warning => warning.userId));
    return {
      stats: [{ label: 'Recent warnings', value: String(warnings.length) }, { label: 'Members warned', value: String(people.size) }],
      tables: [{
        title: 'Latest warnings', columns: ['Member', 'Reason', 'By', 'Date'], empty: 'No warnings in this server.',
        rows: warnings.slice(0, 25).map(warning => [memberName(guild, warning.userId), String(warning.reason || '').slice(0, 140), memberName(guild, warning.moderatorId), iso(Number(warning.timestamp))]),
      }],
    };
  },
  async automod() {
    // The protections and limits Cloudy enforces today (see automodProtectionService and linkProtectionService).
    return {
      stats: [{ label: 'Protections active', value: '6' }],
      tables: [{
        title: 'Protections', columns: ['Protection', 'What Cloudy does'], empty: '',
        rows: [
          ['Message spam', 'Removes bursts of repeated messages within 10 seconds and warns the member.'],
          ['Link spam', 'More than 3 links within 15 seconds: 1-hour timeout, repeat offences 6 hours.'],
          ['Malicious links', 'Dangerous domains, link shorteners and executable files are removed; 30-minute timeout.'],
          ['Invite and content channels', 'Links are only allowed in the content channels (YouTube, TikTok, Twitch).'],
          ['Join raids', 'Detects mass joins within 10 seconds and protects the server.'],
          ['NSFW content', 'AI check on images and text; repeat offences within 7 days are escalated.'],
        ],
      }],
    };
  },
  async giveaways({ client, guild }) {
    const giveaways = (await getGuildGiveaways(client, guild.id)).filter(Boolean);
    const active = giveaways.filter(giveaway => !isGiveawayFinished(giveaway));
    const sorted = [...giveaways].sort((a, b) => giveawayEndTime(b) - giveawayEndTime(a));
    return {
      stats: [{ label: 'Running', value: String(active.length) }, { label: 'Total', value: String(giveaways.length) }],
      tables: [{
        title: 'Giveaways', columns: ['Prize', 'Status', 'Entries', 'Winners', 'Ends'], empty: 'No giveaways yet. Create one with /gcreate.',
        rows: sorted.slice(0, 25).map(giveaway => [
          String(giveaway.prize || 'Giveaway').slice(0, 100), isGiveawayFinished(giveaway) ? 'Ended' : 'Running',
          String(giveawayParticipants(giveaway).length),
          (Array.isArray(giveaway.winnerIds) && giveaway.winnerIds.length ? giveaway.winnerIds.map(id => memberName(guild, id)).join(', ') : String(Number(giveaway.winnerCount) || 1)),
          iso(giveawayEndTime(giveaway)),
        ]),
      }],
    };
  },
  async economy({ client, guild }) {
    const keys = await client.db.list(getEconomyPrefix(guild.id)).catch(() => []);
    const accountKeys = (Array.isArray(keys) ? keys : []).filter(key => !guild.members.cache.get(key.split(':').pop())?.user?.bot);
    const rows = await readGuildEconomyValues(client, guild.id, accountKeys, {});
    const balances = rows.map((data, index) => ({ userId: accountKeys[index].split(':').pop(), total: (Number(data?.wallet) || 0) + (Number(data?.bank) || 0) }))
      .filter(entry => entry.total > 0).sort((a, b) => b.total - a.total);
    const total = balances.reduce((sum, entry) => sum + entry.total, 0);
    const symbol = BotConfig.economy?.currency?.symbol || '';
    return {
      stats: [
        { label: 'Currency', value: `${symbol} ${BotConfig.economy?.currency?.name || 'coins'}`.trim() },
        { label: 'Accounts', value: String(balances.length) },
        { label: 'In circulation', value: `${symbol}${total.toLocaleString('en')}` },
      ],
      tables: [{ title: 'Richest members', columns: ['Member', 'Balance'], empty: 'Nobody has earned anything yet.', rows: balances.slice(0, 10).map(entry => [memberName(guild, entry.userId), `${symbol}${entry.total.toLocaleString('en')}`]) }],
    };
  },
  async music({ client, guild }) {
    const player = client.riffy?.players?.get(guild.id);
    const track = player?.current?.info;
    return {
      stats: [
        { label: 'Status', value: player ? (player.paused ? 'Paused' : track ? 'Playing' : 'Connected') : 'Not playing' },
        { label: 'Voice channel', value: player?.voiceChannel ? channelName(guild, player.voiceChannel) || 'Voice' : '' },
        { label: 'Queue', value: String(player?.queue?.length || 0) },
      ],
      tables: [{
        title: 'Up next', columns: ['Track', 'Artist'], empty: track ? 'Nothing else in the queue.' : 'Nothing is playing. Start music with /play.',
        rows: [...(track ? [[`▶ ${track.title}`, track.author || '']] : []), ...(player?.queue || []).slice(0, 15).map(entry => [entry.info?.title || 'Track', entry.info?.author || ''])],
      }],
    };
  },
  async reactionroles({ client, guild }) {
    const panels = await getAllReactionRoleMessages(client, guild.id).catch(() => []);
    const list = Array.isArray(panels) ? panels : Object.values(panels || {});
    return {
      stats: [{ label: 'Panels', value: String(list.length) }],
      tables: [{
        title: 'Reaction role panels', columns: ['Channel', 'Roles', 'Message'], empty: 'No panels yet. Create one with /reactroles setup.',
        rows: list.slice(0, 25).map(panel => [channelName(guild, panel.channelId), Object.values(panel.roles || {}).map(role => `@${guild.roles.cache.get(idOf(role))?.name || 'role'}`).join(', '), String(panel.messageId || '')]),
      }],
    };
  },
  async embeds({ guild }) {
    const records = (await getEmbedRegistry(guild.id, { cached: true }).catch(() => [])).filter(record => record && !record.deleted && !record.detached);
    return {
      stats: [{ label: 'Posted embeds', value: String(records.length) }],
      tables: [{
        title: 'Embeds', columns: ['Title', 'Channel', 'Source'], empty: 'No embeds found.',
        rows: records.slice(0, 50).map(record => [String(record.name || record.title || 'Untitled').slice(0, 100), channelName(guild, record.channelId), record.source === 'embed-builder' ? 'Embed Builder' : 'Cloudy']),
      }],
    };
  },
  async feeds({ client, guild, member }) {
    if (!hasCloudyOwnerMember(member) && guild.ownerId !== member.id) throw new DashboardError('Only members with the Owner role can view Cloudy Feed.', 403, 'forbidden');
    const feeds = await readFeeds(client, guild.id);
    return {
      stats: [{ label: 'Feeds', value: `${feeds.length} / 5` }, { label: 'Active', value: String(feeds.filter(feed => feed.active).length) }],
      tables: [{
        title: 'Feeds', columns: ['Feed', 'Channel', 'Every', 'Status'], empty: 'No feeds yet. Add one with /auto feed.',
        rows: feeds.map(feed => [String(feed.name || feed.source || 'Feed').slice(0, 100), channelName(guild, feed.channelId), `${feed.minutes} min`, feed.active ? (feed.startAt > Date.now() ? `Starts ${iso(feed.startAt)}` : 'Active') : 'Paused']),
      }],
    };
  },
};

// ---------------------------------------------------------------- handler

const CHANNEL_TYPES = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice', [ChannelType.GuildStageVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category', [ChannelType.GuildAnnouncement]: 'announcement', [ChannelType.GuildForum]: 'forum',
};
const NEEDED_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'ManageMessages', 'ManageRoles', 'ManageChannels', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog', 'Connect', 'Speak'];

async function canManage(guild, actorId) {
  const member = guild.members.cache.get(actorId) || await guild.members.fetch(actorId).catch(() => null);
  if (!member) return null;
  const allowed = guild.ownerId === actorId
    || member.permissions?.has?.(PermissionFlagsBits.Administrator)
    || member.permissions?.has?.(PermissionFlagsBits.ManageGuild);
  return allowed ? member : null;
}

export function createDashboardHandler({ client, env = process.env, nonces = createNonceStore(), modules = MODULES, insights = INSIGHTS, now = () => Date.now() }) {
  const writeLog = new Map();
  const locks = new Map();

  function withLock(key, task) {
    const previous = locks.get(key) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    locks.set(key, run.finally(() => { if (locks.get(key) === run) locks.delete(key); }));
    return run;
  }
  function allowWrite(actorId) {
    const at = now();
    const recent = (writeLog.get(actorId) || []).filter(time => at - time < 60_000);
    if (recent.length >= WRITES_PER_MINUTE) return false;
    recent.push(at);
    writeLog.set(actorId, recent);
    if (writeLog.size > 5_000) writeLog.delete(writeLog.keys().next().value);
    return true;
  }
  async function audit(guildId, entry) {
    try {
      const key = `guild:${guildId}:dashboard:audit`;
      const list = await client.db.get(key, []);
      const next = [{ at: new Date(now()).toISOString(), ...entry }, ...(Array.isArray(list) ? list : [])].slice(0, AUDIT_LIMIT);
      await client.db.set(key, next);
    } catch (error) {
      logger.warn('[DASHBOARD] Could not store audit entry:', error?.message);
    }
  }

  return async function handle(req, res) {
    const send = (status, body) => res.status(status).json(body);
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      const verified = verifySignedRequest({ method: req.method, path, headers: req.headers || {}, body: raw, secret: env.CLOUDY_DASHBOARD_API_SECRET, nonces, nowMs: now() });
      if (!verified.ok) return send(verified.status, { error: verified.code === 'not_configured' ? 'The dashboard connection is not configured.' : 'Unauthorized.', code: verified.code });
      if (!client.isReady?.()) return send(503, { error: 'Cloudy is starting. Try again in a moment.', code: 'starting' });
      const actorId = verified.actorId;
      let payload = {};
      if (raw) { try { payload = JSON.parse(raw); } catch { return send(400, { error: 'Invalid request.', code: 'invalid_json' }); } }

      const route = path.slice(DASHBOARD_PREFIX.length).split('/').filter(Boolean);
      if (req.method === 'GET' && route.length === 1 && route[0] === 'meta') {
        return send(200, { applicationId: client.user?.id || null });
      }
      if (req.method === 'POST' && route.join('/') === 'guilds/presence') {
        const ids = Array.isArray(payload.guildIds) ? payload.guildIds.filter(id => typeof id === 'string' && SNOWFLAKE.test(id)).slice(0, 200) : [];
        return send(200, { present: ids.filter(id => client.guilds.cache.has(id)) });
      }
      if (route[0] !== 'guilds' || !SNOWFLAKE.test(route[1] || '')) return send(404, { error: 'Not found.', code: 'not_found' });

      const guild = client.guilds.cache.get(route[1]);
      if (!guild) return send(404, { error: 'Cloudy is not in this server.', code: 'not_in_guild' });
      const member = await canManage(guild, actorId);
      if (!member) return send(403, { error: 'You need Manage Server in this server.', code: 'forbidden' });
      const ctx = { client, guild, member };

      if (req.method === 'GET' && route.length === 3 && route[2] === 'overview') {
        const me = guild.members.me;
        const highest = me?.roles?.highest?.position ?? 0;
        return send(200, {
          guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount ?? null, icon: guild.icon || null },
          channels: [...guild.channels.cache.values()].filter(channel => CHANNEL_TYPES[channel.type]).map(channel => ({
            id: channel.id, name: channel.name, type: CHANNEL_TYPES[channel.type], parentId: channel.parentId || null, position: channel.rawPosition ?? channel.position ?? 0,
          })),
          roles: [...guild.roles.cache.values()].filter(role => role.id !== guild.id).map(role => ({
            id: role.id, name: role.name, color: role.color || 0, position: role.position, managed: Boolean(role.managed), assignable: !role.managed && role.position < highest,
          })),
          modules: {},
          missingPermissions: me ? NEEDED_PERMISSIONS.filter(name => !me.permissions.has(PermissionFlagsBits[name])) : [],
        });
      }

      if (route[2] === 'insights' && route.length === 4 && req.method === 'GET') {
        const insight = insights[route[3]];
        if (!insight) return send(404, { error: 'Unknown module.', code: 'unknown_module' });
        return send(200, await insight(ctx));
      }

      if (route[2] !== 'modules' || !route[3]) return send(404, { error: 'Not found.', code: 'not_found' });
      const mod = modules[route[3]];
      if (!mod) return send(404, { error: 'Unknown module.', code: 'unknown_module' });

      if (route.length === 4 && req.method === 'GET') {
        const values = await mod.read(ctx);
        return send(200, { revision: revisionOf(values), values });
      }

      if (route.length === 4 && req.method === 'PATCH') {
        if (!allowWrite(actorId)) return send(429, { error: 'Too many changes. Wait a minute.', code: 'rate_limited' });
        const changes = payload.changes;
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) return send(400, { error: 'Nothing to save.', code: 'invalid' });
        for (const [field, value] of Object.entries(changes)) {
          const rule = mod.fields[field];
          if (!rule) return send(422, { error: 'Unknown setting.', code: 'invalid', path: field });
          if (!checkValue(rule, value)) return send(422, { error: 'Invalid value.', code: 'invalid', path: field });
        }
        return await withLock(`${guild.id}:${route[3]}`, async () => {
          const current = await mod.read(ctx);
          if (payload.revision !== revisionOf(current)) return send(409, { error: 'These settings changed in the meantime. Reload the page.', code: 'revision_conflict' });
          const revisionBefore = revisionOf(current);
          await mod.write(ctx, changes, current);
          const values = await mod.read(ctx);
          const revision = revisionOf(values);
          await audit(guild.id, { actor: actorId, module: route[3], keys: Object.keys(changes), revisionBefore, revisionAfter: revision });
          logger.info(`[DASHBOARD] ${actorId} updated ${route[3]} in ${guild.id}: ${Object.keys(changes).join(', ')}`);
          return send(200, { revision, values });
        });
      }

      if (route.length === 6 && route[4] === 'actions' && req.method === 'POST') {
        const action = mod.actions?.[route[5]];
        if (!action) return send(404, { error: 'Unknown action.', code: 'unknown_action' });
        if (!allowWrite(actorId)) return send(429, { error: 'Too many changes. Wait a minute.', code: 'rate_limited' });
        return await withLock(`${guild.id}:${route[3]}`, async () => {
          const message = await action(ctx);
          await audit(guild.id, { actor: actorId, module: route[3], keys: [`action:${route[5]}`] });
          return send(200, { ok: true, message });
        });
      }

      return send(404, { error: 'Not found.', code: 'not_found' });
    } catch (error) {
      if (error instanceof DashboardError) return send(error.status, { error: error.message, code: error.code, ...(error.path ? { path: error.path } : {}) });
      logger.error('[DASHBOARD] Request failed:', error);
      return send(500, { error: userMessage(error, 'Cloudy could not complete this request.').slice(0, 160), code: 'bot_error' });
    }
  };
}

/**
 * Adds the signed dashboard routes. Registered before the JSON body parser so
 * the signature covers the exact bytes that were sent. Never throws at startup.
 */
export function registerDashboardApi(app, client, express) {
  try {
    const handle = createDashboardHandler({ client });
    app.use(DASHBOARD_PREFIX, express.raw({ type: () => true, limit: '64kb' }), (req, res) => { void handle(req, res); });
  } catch (error) {
    logger.error('[DASHBOARD] Could not register the dashboard API:', error);
  }
}
