// warningService.js

import { db, getFromDb, setInDb, getWarningsKey, getWarningsPrefix } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes, wrapServiceClassMethods } from '../../utils/errorHandler.js';
import { Mutex } from '../../utils/mutex.js';

async function saveWarnings(key, warnings, guildId, userId, operation) {
  if (await setInDb(key, warnings) === false) {
    throw createError(
      'Warning data could not be saved',
      ErrorTypes.DATABASE,
      'The warning change could not be saved. Please try again.',
      { guildId, userId, service: 'warningService', operation }
    );
  }
}

class WarningService {

  static async addWarning({
    guildId,
    userId,
    moderatorId,
    reason,
    timestamp = Date.now()
  }) {
    const key = getWarningsKey(guildId, userId);
    return Mutex.runExclusive(key, async () => {
      const warnings = await db.get(key, [], { strict: true });

      if (!Array.isArray(warnings)) {
        logger.warn(`Warnings for ${userId} in ${guildId} corrupted, resetting`);
        await saveWarnings(key, [], guildId, userId, 'addWarning');
        throw createError(
          'Corrupted warning data',
          ErrorTypes.DATABASE,
          'Warning data was corrupted and has been reset. Please try again.',
          { guildId, userId, service: 'warningService', operation: 'addWarning' }
        );
      }

      const highestId = warnings.reduce((highest, item) =>
        Number.isSafeInteger(item?.id) ? Math.max(highest, item.id) : highest, 0);
      const warning = {
        id: Math.max(Date.now(), highestId + 1),
        guildId,
        userId,
        moderatorId,
        reason,
        timestamp,
        status: 'active'
      };

      warnings.push(warning);
      await saveWarnings(key, warnings, guildId, userId, 'addWarning');

      logger.info(`Warning added: ${userId} in ${guildId} by ${moderatorId}`);

      return {
        id: warning.id,
        totalCount: warnings.length
      };
    });
  }

  static async getWarnings(guildId, userId) {
    const key = getWarningsKey(guildId, userId);
    const warnings = await getFromDb(key, []);

    return Array.isArray(warnings)
      ? warnings.filter(w => w && w.status !== 'deleted')
      : [];
  }

  static async getWarningCount(guildId, userId) {
    const warnings = await this.getWarnings(guildId, userId);
    return warnings.length;
  }

  static async removeWarning(guildId, userId, warningId) {
    const key = getWarningsKey(guildId, userId);
    return Mutex.runExclusive(key, async () => {
      const warnings = await db.get(key, [], { strict: true });

      const index = warnings.findIndex(w => w.id === warningId);
      if (index === -1) {
        throw createError(
          'Warning not found',
          ErrorTypes.USER_INPUT,
          'That warning could not be found. It may have already been removed.',
          { guildId, userId, warningId, service: 'warningService', operation: 'removeWarning' }
        );
      }

      warnings[index].status = 'deleted';
      await saveWarnings(key, warnings, guildId, userId, 'removeWarning');

      logger.info(`Warning removed: ${warningId} for ${userId} in ${guildId}`);
      return { removed: true };
    });
  }

  static async clearWarnings(guildId, userId) {
    const key = getWarningsKey(guildId, userId);
    return Mutex.runExclusive(key, async () => {
      const warnings = await db.get(key, [], { strict: true });
      const count = warnings.length;

      await saveWarnings(key, [], guildId, userId, 'clearWarnings');

      logger.info(`Warnings cleared for ${userId} in ${guildId} (${count} removed)`);
      return { count };
    });
  }

  static async getGuildWarnings(guildId, filters = {}) {
    const { moderatorId, limit = 100 } = filters;
    const prefix = getWarningsPrefix(guildId);

    const keys = await db.list(prefix);
    const allWarnings = [];

    for (const key of Array.isArray(keys) ? keys : []) {
      const warnings = await getFromDb(key, []);
      if (!Array.isArray(warnings)) continue;

      for (const warning of warnings) {
        if (!warning || warning.status === 'deleted') continue;
        if (moderatorId && warning.moderatorId !== moderatorId) continue;
        allWarnings.push(warning);
      }
    }

    allWarnings.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    logger.debug(`Fetched guild warnings for ${guildId} with ${allWarnings.length} total`);
    return allWarnings.slice(0, limit);
  }
}

wrapServiceClassMethods(WarningService);

export { WarningService };
