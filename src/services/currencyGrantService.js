import { isBotOwner } from '../config/bot.js';
import { hasCloudyOwnerRole } from './ownerRoleAccess.js';
import { getEconomyData, getInitialEconomyData, setEconomyData } from '../utils/economy.js';

export function canGrantCurrency(interaction) {
  const userId = interaction?.user?.id;
  if (!interaction?.guildId || !userId) return false;
  return isBotOwner(userId)
    || String(interaction.guild?.ownerId || '') === String(userId)
    || hasCloudyOwnerRole(interaction);
}

export function parseCurrencyAmount(rawAmount) {
  const raw = String(rawAmount ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error('Enter a whole positive number.');
  const amount = Number(raw);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Amount must be a positive safe whole number.');
  }
  return amount;
}

export async function grantCurrency(client, guildId, userId, amount) {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Amount must be a positive safe whole number.');
  }
  if (client.db?.getConnectionType?.() === 'postgresql'
    && typeof client.db.mutateEconomyAccount === 'function') {
    const mutation = await client.db.mutateEconomyAccount(
      guildId, userId, getInitialEconomyData(), current => {
        if (!Number.isSafeInteger(current.wallet) || current.wallet < 0
          || current.wallet > Number.MAX_SAFE_INTEGER - amount) {
          throw new Error('That amount would exceed the maximum safe economy balance.');
        }
        current.wallet += amount;
      },
    );
    return mutation.account.wallet;
  }

  const current = await getEconomyData(client, guildId, userId);
  if (!Number.isSafeInteger(current.wallet) || current.wallet < 0
    || current.wallet > Number.MAX_SAFE_INTEGER - amount) {
    throw new Error('That amount would exceed the maximum safe economy balance.');
  }
  current.wallet += amount;
  const saved = await setEconomyData(client, guildId, userId, current);
  if (!saved) throw new Error('The new balance could not be saved.');
  return current.wallet;
}

export async function grantCurrencyToMembers(client, guildId, memberIds, amount, {
  concurrency = 5,
} = {}) {
  const ids = [...new Set(memberIds.map(String))];
  const results = { granted: 0, failed: [], total: ids.length };
  // Bounded concurrency avoids flooding the database and holds each
  // account's normal atomic mutation lock independently.
  for (let index = 0; index < ids.length; index += concurrency) {
    const batch = ids.slice(index, index + concurrency);
    const settled = await Promise.allSettled(batch.map(id => grantCurrency(client, guildId, id, amount)));
    settled.forEach((result, offset) => {
      if (result.status === 'fulfilled') results.granted++;
      else results.failed.push({ id: batch[offset], error: result.reason?.message || 'Unknown error' });
    });
  }
  return results;
}
