// xpSystem.js

import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData } from './leveling.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { Mutex } from '../../utils/mutex.js';
import { wrapServiceBoundary } from '../../utils/errorHandler.js';

// Last message award per guild:user written by this process. Inside the XP
// cooldown the stored lastMessage is at least this recent, so the database
// read can be skipped for every further message in that window.
const recentMessageAwards = new Map();
const MAX_RECENT_AWARDS = 50_000;

function recentlyAwarded(lockKey, cooldownMs, now = Date.now()) {
  const awardedAt = recentMessageAwards.get(lockKey);
  if (!awardedAt) return false;
  if (now - awardedAt < cooldownMs) return true;
  recentMessageAwards.delete(lockKey);
  return false;
}

function rememberMessageAward(lockKey, at) {
  recentMessageAwards.delete(lockKey);
  recentMessageAwards.set(lockKey, at);
  while (recentMessageAwards.size > MAX_RECENT_AWARDS) recentMessageAwards.delete(recentMessageAwards.keys().next().value);
}

// Test helper.
export function clearRecentMessageAwards() {
  recentMessageAwards.clear();
}

/**
 * Award XP to a member. Returns null when XP is skipped (disabled/invalid amount).
 * Throws on storage or unexpected failures.
 */
export const addXp = wrapServiceBoundary(async function addXp(client, guild, member, xpToAdd, { messageAward = false } = {}) {
  const lockKey = `leveling:${guild.id}:${member.user.id}`;
  return await Mutex.runExclusive(lockKey, async () => {
    if (!xpToAdd || xpToAdd <= 0) {
      return null;
    }

    const config = await getLevelingConfig(client, guild.id);

    if (!config.enabled) {
      return null;
    }

    const cooldownMs = (config.xpCooldown || 60) * 1000;
    if (messageAward && recentlyAwarded(lockKey, cooldownMs)) return null;

    const levelData = await getUserLevelData(client, guild.id, member.user.id);

    if (messageAward) {
      // Concurrent messages must check the latest saved timestamp under the
      // same lock as the award. Manual XP operations retain their behavior.
      if (Date.now() - (levelData.lastMessage || 0) < cooldownMs) {
        return null;
      }
    }

    levelData.xp += xpToAdd;
    levelData.totalXp += xpToAdd;
    levelData.lastMessage = Date.now();

    let xpNeededForNextLevel = getXpForLevel(levelData.level);
    let didLevelUp = false;
    const initialLevel = levelData.level;
    const roleRewards = [];

    while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
      levelData.xp -= xpNeededForNextLevel;
      levelData.level += 1;
      didLevelUp = true;
      xpNeededForNextLevel = getXpForLevel(levelData.level);

      logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

      if (config.roleRewards && config.roleRewards[levelData.level]) {
        roleRewards.push({ roleId: config.roleRewards[levelData.level], level: levelData.level });
      }
    }

    // Never announce a level-up or grant its rewards until XP is persisted.
    await saveUserLevelData(client, guild.id, member.user.id, levelData);
    if (messageAward) rememberMessageAward(lockKey, levelData.lastMessage);
    for (const reward of roleRewards) {
      await awardRoleReward(guild, member, reward.roleId, reward.level);
    }

    if (didLevelUp) {
      if (config.announceLevelUp) {
        await sendLevelUpAnnouncement(guild, member, levelData, config);
      }

      try {
        await logEvent({
          client,
          guildId: guild.id,
          eventType: EVENT_TYPES.LEVELING_LEVELUP,
          data: {
            title: 'Level Up',
            lines: [
              formatLogLine('Member', `${member.user.tag} (\`${member.user.id}\`)`),
              formatLogLine('New Level', levelData.level.toString()),
              formatLogLine('Levels Gained', (levelData.level - initialLevel).toString()),
              formatLogLine('Total XP', levelData.totalXp.toString()),
            ],
            userId: member.user.id,
          },
        });
      } catch (logError) {
        logger.debug('Failed to log leveling event:', logError.message);
      }
    }

    return {
      level: levelData.level,
      xp: levelData.xp,
      totalXp: levelData.totalXp,
      xpNeeded: levelData.level === 1000 ? xpNeededForNextLevel : getXpForLevel(levelData.level + 1),
      leveledUp: didLevelUp,
    };
  });
}, {
  service: 'xpSystem',
  operation: 'addXp',
  userMessage: 'Failed to award XP. Please try again.',
});

async function awardRoleReward(guild, member, roleId, level) {
  try {
    const role = guild.roles.cache.get(roleId);

    if (!role) {
      logger.warn(`Role ${roleId} not found for level ${level} reward in guild ${guild.id}`);
      return;
    }

    if (member.roles.cache.has(roleId)) {
      return;
    }

    await member.roles.add(role, `Level ${level} reward`);
    logger.info(`✅ Awarded role ${role.name} to ${member.user.tag} for reaching level ${level}`);
  } catch (error) {
    logger.error(`Failed to award role reward to ${member.user.id}:`, error);
  }
}

async function sendLevelUpAnnouncement(guild, member, levelData, config) {
  try {
    const levelUpChannel = config.levelUpChannel
      ? guild.channels.cache.get(config.levelUpChannel)
      : guild.systemChannel;

    if (!levelUpChannel || !levelUpChannel.isTextBased()) {
      return;
    }

    const permissions = levelUpChannel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions to send levelup message in ${levelUpChannel.id}`);
      return;
    }

    const message = config.levelUpMessage
      .replace(/{user}/g, member.toString())
      .replace(/{level}/g, levelData.level)
      .replace(/{xp}/g, levelData.xp)
      .replace(/{xpNeeded}/g, getXpForLevel(Math.min(levelData.level + 1, 1000)));

    await levelUpChannel.send(message).catch(error => {
      logger.error(`Failed to send level up message in channel ${levelUpChannel.id}:`, error);
    });
  } catch (error) {
    logger.error('Error sending level up announcement:', error);
  }
}
