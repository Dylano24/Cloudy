import { createError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getEconomyData, setEconomyData } from '../../../utils/economy.js';

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
  await setEconomyData(client, interaction.guildId, interaction.user.id, userData);
  return { payout, profit: payout - amount, balance: userData.wallet };
}

export function money(value) {
  return `$${Number(value || 0).toLocaleString()}`;
}
