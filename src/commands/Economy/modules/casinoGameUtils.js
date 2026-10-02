import { createError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getEconomyData, getEconomyKey, setEconomyData } from '../../../utils/economy.js';
import { Mutex } from '../../../utils/mutex.js';

// Collector callbacks run after the command's economy lock has been released.
// Apply only their delta to current data, never the game's old wallet snapshot.
export async function adjustCasinoBalance(client, guildId, userId, delta) {
  return Mutex.runExclusive(`economy:${guildId}:${userId}`, async () => {
    const current = await client.db.get(getEconomyKey(guildId, userId));
    if (!current || !Number.isSafeInteger(current.wallet) || !Number.isSafeInteger(delta)) {
      throw createError('Casino balance unavailable', ErrorTypes.DATABASE, 'Your balance could not be saved. Please try again.');
    }
    if (current.wallet + delta < 0) {
      throw createError('Insufficient funds', ErrorTypes.VALIDATION, 'You do not have enough cash for this action.');
    }
    if (!Number.isSafeInteger(current.wallet + delta)) throw new Error('Casino balance exceeds safe integer range');
    current.wallet += delta;
    if (!await setEconomyData(client, guildId, userId, current)) {
      throw createError('Casino persistence failed', ErrorTypes.DATABASE, 'Your balance could not be saved. Please try again.');
    }
    return current;
  });
}

export async function takeBet(interaction, client) {
  const amount = interaction.options.getInteger('amount');
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw createError('Invalid bet', ErrorTypes.VALIDATION, 'Enter a valid bet amount of at least $1.');
  }

  const userData = await getEconomyData(client, interaction.guildId, interaction.user.id);
  if (userData.wallet < amount) {
    throw createError('Insufficient funds', ErrorTypes.VALIDATION, `You only have **$${userData.wallet.toLocaleString()}** cash.`);
  }
  userData.wallet -= amount;
  return { amount, userData };
}

export async function settleBet(interaction, client, userData, amount, multiplier) {
  const payout = Math.floor(amount * multiplier);
  userData.wallet += payout;
  if (!await setEconomyData(client, interaction.guildId, interaction.user.id, userData)) {
    throw createError('Casino persistence failed', ErrorTypes.DATABASE, 'Your balance could not be saved. Please try again.');
  }
  return { payout, profit: payout - amount, balance: userData.wallet };
}

export function money(value) {
  return `$${Number(value || 0).toLocaleString()}`;
}
