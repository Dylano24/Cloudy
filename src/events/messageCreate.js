import { Events, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { deleteFromDb, getFromDb, setInDb } from '../utils/database.js';
import { getLevelingConfig } from '../services/leveling/leveling.js';
import { addXp } from '../services/leveling/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabledInConfig } from '../services/commandAccessService.js';
import { enforceLinkProtection } from '../services/linkProtectionService.js';
import { enforceProtectedIdentityMessage } from '../services/protectedIdentityService.js';
import {
  beginEmbedRegistryMove,
  moveEmbedRegistryMessage,
} from '../services/embedRegistryService.js';
import { rememberBuilderOwnedMessage, withBuilderOwnedNonce } from '../utils/builderOwnedSends.js';
import { acquireEmbedBuilderMessageMutation } from '../services/embedBuilderMutationLock.js';
import {
  getCountingGameConfig,
  saveCountingGameConfig,
  isValidCountingMessage,
  recordCorrectCount,
} from '../services/countingGameService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (!message.guild) return;
      // Viewing or running commands must never create persistent Builder items.
      // Explicit Builder Post/Save and source-catalog registration are handled
      // by their own workflows; live channel browsing discovers real messages.
      if (message.author.id === client.user?.id) return;

      logger.debug('Message received', {
        event: 'message.received',
        messageId: message.id,
        guildId: message.guild.id,
        channelId: message.channel?.id,
        userId: message.author.id,
        traceId: message.traceId || message.traceContext?.traceId,
      });

      const identityBlocked = await enforceProtectedIdentityMessage(message);
      if (identityBlocked) {
        return;
      }

      const linkBlocked = await enforceLinkProtection(message);
      if (linkBlocked) {
        return;
      }

      // Other bots are scanned for links, but never processed as users.
      if (message.author.bot) return;

      await handleEmbedReappear(message);

      const countingProcessed = await handleCountingGame(message, client);
      if (countingProcessed) {
        return;
      }

      await handlePrefixCommand(message, client);

      if (isCommandCategoryEnabled('leveling')) {
        await handleLeveling(message, client);
      }
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

async function handlePrefixCommand(message, client) {
  try {
    // The dedicated AI handler owns these requests; do not log prompt arguments.
    if (String(message.channel?.name || '').toLowerCase() === 'botlog-commands' && /^!ai\s/.test(message.content || '')) return;
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || getCommandPrefix();
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) {
      return; 
    }

    let { commandName, args } = parsed;
    const musicPrefixShortcut = commandName.toLowerCase();
    const MUSIC_PREFIX_SHORTCUTS = new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume']);
    if (MUSIC_PREFIX_SHORTCUTS.has(musicPrefixShortcut)) {
      commandName = 'music';
      args = [musicPrefixShortcut, ...args];
    }

    logger.info(`Prefix command detected: ${commandName}`);

    const resolvedCommandName = resolveCommandAlias(commandName);
    logger.info(`Resolved command name: ${resolvedCommandName}`);
    const command = client.commands.get(resolvedCommandName);

    if (!command) {
      logger.warn(`Command not found: ${resolvedCommandName}`);
      return; 
    }

    const requiredPermissionBits = command.data?.toJSON?.().default_member_permissions;
    const hasRequiredCommandPermissions = requiredPermissionBits
      ? message.member?.permissions?.has(BigInt(requiredPermissionBits))
      : false;

    if (
      command.adminOnly &&
      !isBotOwner(message.author.id) &&
      !message.member?.permissions?.has(PermissionFlagsBits.Administrator) &&
      !hasRequiredCommandPermissions
    ) {
      await message.channel.send({
        embeds: [createEmbed({
          title: 'Staff only',
          description: 'This command is only available to authorized staff members.',
          color: 'error',
        }).setTitle('Staff only')],
      }).catch(() => {});
      return;
    }

    if (isMaintenanceMode() && !isBotOwner(message.author.id)) {
      await message.channel.send({
        embeds: [createEmbed({
          title: 'Maintenance mode',
          description: getBotMessage('maintenanceMode'),
          color: 'warning',
        }).setTitle('Maintenance mode')],
      }).catch(() => {});
      return;
    }

    if (!isCommandCategoryEnabled(command.category)) {
      await message.channel.send({
        embeds: [createEmbed({
          title: 'Feature disabled',
          description: getBotMessage('commandDisabled'),
          color: 'error',
        }).setTitle('Feature disabled')],
      }).catch(() => {});
      return;
    }

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash command only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        }).setTitle('Slash command only');
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!isCommandEnabledInConfig(guildConfig, resolvePrefixAccessKey(command.data, args), command.category)) {
      const embed = createEmbed({
        title: 'Command disabled',
        description: 'This command has been disabled for this server.',
        color: 'error',
      }).setTitle('Command disabled');
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    const mockInteractionForProtection = {
      guildId: message.guild.id,
      user: message.author,
    };
    const abuseProtection = await enforceAbuseProtection(
      mockInteractionForProtection,
      command,
      resolvedCommandName,
    );
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error',
      }).setTitle('Command cooldown');
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    logger.info(`Executing prefix command: ${prefix}${commandName} (resolved to ${resolvedCommandName}) by ${message.author.tag}`);
    
    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => {
        failureMessage.delete().catch(() => {});
      }, 10000);

      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) {
      return;
    }

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    
    if (!levelingConfig?.enabled) {
      return;
    }

    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) {
      return;
    }

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => {
        return null;
      });
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) {
        return;
      }
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) {
      return;
    }

    if (!message.content || message.content.trim().length === 0) {
      return;
    }

    const minXP = levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15;
    const maxXP = levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25;

    const safeMinXP = Math.max(1, minXP);
    const safeMaxXP = Math.max(safeMinXP, maxXP);

    const xpToGive = Math.floor(Math.random() * (safeMaxXP - safeMinXP + 1)) + safeMinXP;

    let finalXP = xpToGive;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP, { messageAward: true });

    if (result?.leveledUp) {
      logger.info(
        `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
      );
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}


// A Reappear move replaces the physical message of the SAME Builder item.
// These hooks keep its registry identity attached to the new message ID.
const reappearIdentity = {
  lock: acquireEmbedBuilderMessageMutation,
  beginMove: beginEmbedRegistryMove,
  move: moveEmbedRegistryMessage,
  ownedPayload: withBuilderOwnedNonce,
  rememberOwned: rememberBuilderOwnedMessage,
};

const reappearQueues = new Map();

async function handleEmbedReappear(message) {
  const channelKey = `${message.guild.id}:${message.channel.id}`;
  const previous = reappearQueues.get(channelKey) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => processEmbedReappear(message));
  reappearQueues.set(channelKey, pending);
  try {
    await pending;
  } finally {
    if (reappearQueues.get(channelKey) === pending) reappearQueues.delete(channelKey);
  }
}

async function processEmbedReappear(message) {
  try {
    const prefix = `cloudy:embed-reappear:${message.guild.id}:${message.channel.id}:`;
    const indexKey = `cloudy:embed-reappear-index:${message.guild.id}:${message.channel.id}`;
    const configs = await getFromDb(indexKey, []);
    if (!Array.isArray(configs) || !configs.length) return;

    // A confirmed Builder Delete is persisted separately from the visible
    // registry. Do not allow a legacy/orphan Reappear rule to resurrect an
    // owner-deleted message, even after a bot restart or registry cache miss.
    const permanentlyDeleted = new Set(
      await getFromDb(`cloudy:embed-registry-deleted:${message.guild.id}`, []) || [],
    );

    // Reappear ownership is independent from Search/registry indexing.
    // Delete writes an exact tombstone for the one embed being removed; only
    // that tombstone may disable this rule. Search/catalog updates must never
    // make a live Reappear embed disappear.
    const removedIds = new Set();

    // Reappear can be attached to several embeds in one channel. Read their
    // independent configs concurrently so a normal user message never waits on
    // N sequential database/cache round-trips before the counter is updated.
    const configEntries = await Promise.all(
      configs.map(async id => {
        const originalMessageId = String(id);
        const key = prefix + originalMessageId;
        return {
          originalMessageId,
          key,
          config: await getFromDb(key, null),
        };
      }),
    );

    for (const { originalMessageId, key, config } of configEntries) {
      const embedIndex = Math.max(0, Number(config?.embedIndex) || 0);
      if (config) {
        // Normalize legacy rules in-place so every existing Reappear rule also
        // gets the same exact ownership metadata as newly posted embeds.
        if (!config.originMessageId) config.originMessageId = originalMessageId;
        if (config.embedIndex == null) config.embedIndex = embedIndex;
      }
      const disableKey = `cloudy:embed-reappear-disabled:${message.guild.id}:${message.channel.id}:${originalMessageId}:${embedIndex}`;

      if (!config?.every || !config?.embed) {
        removedIds.add(originalMessageId);
        await deleteFromDb(key);
        continue;
      }

      // Only an exact Delete tombstone may stop this rule. Do not infer deletion
      // from the Embed Registry: registry/Search indexing is asynchronous and
      // can temporarily miss or reclassify a freshly posted Builder embed.
      const disabled = await getFromDb(disableKey, null);
      const deletedOrigin = permanentlyDeleted.has(`${message.channel.id}:${originalMessageId}`)
        || (config?.messageId && permanentlyDeleted.has(`${message.channel.id}:${config.messageId}`));
      if (disabled || deletedOrigin) {
        if (deletedOrigin && !disabled) {
          // Tombstone first so another in-flight event cannot restore the rule.
          const marked = await setInDb(disableKey, {
            disabled: true,
            reason: 'builder-message-permanently-deleted',
            disabledAt: new Date().toISOString(),
          });
          if (!marked) continue;
        }
        const activeMessageId = config.messageId ? String(config.messageId) : null;
        if (activeMessageId) {
          const activeMessage = await message.channel.messages.fetch(activeMessageId).catch(() => null);
          await activeMessage?.delete?.().catch(() => {});
        }
        removedIds.add(originalMessageId);
        await deleteFromDb(key);
        continue;
      }

      config.count = (Number(config.count) || 0) + 1;
      if (config.count < config.every) {
        if (await getFromDb(disableKey, null)) {
          removedIds.add(originalMessageId);
          await deleteFromDb(key);
          continue;
        }
        await setInDb(key, config);
        continue;
      }

      // Never recreate an old embed when its current physical message was
      // removed directly in Discord. The previous implementation treated a
      // confirmed 10008 as permission to send the old saved content again.
      const previousMessageId = config.messageId ? String(config.messageId) : null;
      // A Builder Save of this exact message finishes first (and vice
      // versa), so a move never races an edit of the same physical message.
      const releaseMessageLock = previousMessageId
        ? await reappearIdentity.lock(message.guild.id, message.channel.id, previousMessageId)
        : () => {};
      try {
        let previous = null;
        let sourceMissing = !previousMessageId;
        if (previousMessageId) {
          try {
            previous = await message.channel.messages.fetch(previousMessageId, { force: true });
            sourceMissing = !previous;
          } catch (error) {
            if (Number(error?.code) === 10008) sourceMissing = true;
            else throw error; // Temporary API failures must not delete the rule.
          }
        }
        if (sourceMissing && config.pendingMove !== true) {
          // Disable the exact old rule, not a newer Test embed in this channel.
          if (!await setInDb(disableKey, {
            disabled: true, reason: 'physical-message-deleted',
            disabledAt: new Date().toISOString(),
          })) continue;
          removedIds.add(originalMessageId);
          await deleteFromDb(key);
          continue;
        }

        // The moved message must show exactly what is in the channel NOW, not
        // the snapshot captured when Reappear was first configured. Otherwise
        // a Save (Test -> Yess, new colour/logo/GIF) is undone by the next move.
        const liveEmbed = previous?.embeds?.[embedIndex] || null;
        if (liveEmbed) {
          config.embed = liveEmbed.toJSON?.() || JSON.parse(JSON.stringify(liveEmbed));
          config.components = (previous.components || []).map(row => row?.toJSON?.() || row);
        }

        // A move that Cloudy itself initiated may legitimately have no current
        // physical message if the replacement send failed. Record that explicit
        // intent before deleting, so retry never revives an unrelated deleted
        // Yess and still recovers from a failed automatic replacement.
        config.pendingMove = true;
        if (!await setInDb(key, config)) continue;
        // Cloudy's own deletion of the old copy is not a manual Discord delete:
        // its registry identity must survive until it follows the new message.
        const releaseMove = previousMessageId
          ? reappearIdentity.beginMove(message.guild.id, message.channel.id, previousMessageId)
          : () => {};
        try {
          if (previous) {
            const removedPrevious = await previous.delete().then(() => true).catch(() => false);
            if (!removedPrevious) {
              config.pendingMove = false;
              await setInDb(key, config);
              continue;
            }
            // Give Discord clients time to process deletion before replacement.
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

          if (await getFromDb(disableKey, null)) {
            removedIds.add(originalMessageId);
            await deleteFromDb(key);
            continue;
          }

          // Remove the old copy before creating the new one: Discord must never
          // show two copies while the embed moves to the bottom.
          const sent = await message.channel.send(reappearIdentity.ownedPayload({
            embeds: [config.embed],
            components: config.components || [],
          })).catch(() => null);
          if (!sent) continue;
          reappearIdentity.rememberOwned(sent);

          // Delete may race with a user message that triggered Reappear. Re-check
          // the exact tombstone after sending and remove only this just-created copy.
          if (await getFromDb(disableKey, null)) {
            await sent.delete().catch(() => {});
            removedIds.add(originalMessageId);
            await deleteFromDb(key);
            continue;
          }

          if (previousMessageId) {
            const moved = await reappearIdentity.move(
              message.guild.id, message.channel.id, previousMessageId, sent,
            ).catch(error => {
              logger.error('Embed reappear registry move failed:', error);
              return false;
            });
            if (!moved) {
              logger.warn('Embed reappear moved a message without a registry identity to follow.', {
                guildId: message.guild.id, channelId: message.channel.id,
                previousMessageId, messageId: sent.id,
              });
            }
          }

          config.count = 0;
          config.pendingMove = false;
          // Every former physical ID stays linked to this one rule, so a Delete
          // opened from any earlier copy still disables the right Reappear.
          config.previousMessageIds = [...new Set([
            ...(Array.isArray(config.previousMessageIds) ? config.previousMessageIds.map(String) : []),
            ...(previousMessageId ? [previousMessageId] : []),
          ])].slice(-50);
          config.messageId = sent.id;
          config.updatedAt = new Date().toISOString();
          await setInDb(key, config);
        } finally {
          releaseMove();
        }
      } finally {
        releaseMessageLock();
      }
    }

    // Never rewrite the index from the stale snapshot read at the beginning of
    // this handler. Re-read it and remove only the rules proven dead here; this
    // prevents one Reappear deletion from dropping unrelated/newer embeds.
    if (removedIds.size) {
      const latestIndex = await getFromDb(indexKey, []);
      if (Array.isArray(latestIndex)) {
        const nextIndex = latestIndex.filter(id => !removedIds.has(String(id)));
        if (nextIndex.length !== latestIndex.length) {
          await setInDb(indexKey, nextIndex);
        }
      }
    }
  } catch (error) {
    logger.error('Embed reappear handler failed:', error);
  }
}
