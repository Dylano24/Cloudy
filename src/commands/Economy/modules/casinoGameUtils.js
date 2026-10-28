import { createError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getEconomyData, getEconomyKey, setEconomyData, getInitialEconomyData } from '../../../utils/economy.js';
import { Mutex } from '../../../utils/mutex.js';

function isAtomicPostgres(client) {
  return client.db?.getConnectionType?.() === 'postgresql'
    && typeof client.db.mutateEconomyAccount === 'function';
}

function applyCasinoDelta(current, delta) {
  if (!Number.isSafeInteger(current.wallet) || !Number.isSafeInteger(delta)) {
    throw createError('Casino balance unavailable', ErrorTypes.DATABASE,
      'Your balance could not be saved. Please try again.');
  }
  const nextWallet = current.wallet + delta;
  if (nextWallet < 0) {
    throw createError('Insufficient funds', ErrorTypes.VALIDATION,
      'You do not have enough cash for this action.');
  }
  if (!Number.isSafeInteger(nextWallet)) throw new Error('Casino balance exceeds safe integer range');
  current.wallet = nextWallet;
}

// Collectors run after the command's initial acknowledgement, sometimes on
// separate replicas. The PostgreSQL row lock—not an in-process mutex—must
// guard settlement against other currency commands and concurrent games.
export async function adjustCasinoBalance(client, guildId, userId, delta) {
  if (isAtomicPostgres(client)) {
    const mutation = await client.db.mutateEconomyAccount(
      guildId, userId, getInitialEconomyData(), current => applyCasinoDelta(current, delta),
    );
    return mutation.account;
  }
  return Mutex.runExclusive(`economy:${guildId}:${userId}`, async () => {
    const current = await client.db.get(getEconomyKey(guildId, userId));
    if (!current) {
      throw createError('Casino balance unavailable', ErrorTypes.DATABASE,
        'Your balance could not be saved. Please try again.');
    }
    applyCasinoDelta(current, delta);
    if (!await setEconomyData(client, guildId, userId, current)) {
      throw createError('Casino persistence failed', ErrorTypes.DATABASE,
        'Your balance could not be saved. Please try again.');
    }
    return current;
  });
}

export async function takeBet(interaction, client, { settleImmediately = false } = {}) {
  const amount = interaction.options.getInteger('amount');
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw createError('Invalid bet', ErrorTypes.VALIDATION,
      'Enter a valid bet amount of at least $1.');
  }

  // Long-running baccarat and blackjack reserve their stake up front.
  if (isAtomicPostgres(client) && !settleImmediately) {
    const mutation = await client.db.mutateEconomyAccount(
      interaction.guildId, interaction.user.id, getInitialEconomyData(), current => {
        if (current.wallet < amount) {
          throw createError('Insufficient funds', ErrorTypes.VALIDATION,
            `You only have **$${current.wallet.toLocaleString()}** cash.`);
        }
        applyCasinoDelta(current, -amount);
      },
    );
    return { amount, userData: mutation.account, alreadyPersisted: true };
  }

  const userData = await getEconomyData(client, interaction.guildId, interaction.user.id);
  if (userData.wallet < amount) {
    throw createError('Insufficient funds', ErrorTypes.VALIDATION,
      `You only have **$${userData.wallet.toLocaleString()}** cash.`);
  }
  // Roulette and Slots have immediate settlement. Their PostgreSQL branch
  // debits the stake and awards the payout together in settleBet below.
  if (!(isAtomicPostgres(client) && settleImmediately)) userData.wallet -= amount;
  return { amount, userData, alreadyPersisted: false };
}

export async function settleBet(interaction, client, userData, amount, multiplier) {
  const payout = Math.floor(amount * multiplier);
  if (!Number.isSafeInteger(payout) || payout < 0) {
    throw createError('Invalid casino payout', ErrorTypes.VALIDATION, 'The payout could not be calculated.');
  }

  if (isAtomicPostgres(client)) {
    const mutation = await client.db.mutateEconomyAccount(
      interaction.guildId, interaction.user.id, getInitialEconomyData(), current => {
        if (current.wallet < amount) {
          throw createError('Insufficient funds', ErrorTypes.VALIDATION,
            `You only have **$${current.wallet.toLocaleString()}** cash.`);
        }
        applyCasinoDelta(current, payout - amount);
      },
    );
    return { payout, profit: payout - amount, balance: mutation.account.wallet };
  }

  userData.wallet += payout;
  if (!await setEconomyData(client, interaction.guildId, interaction.user.id, userData)) {
    throw createError('Casino persistence failed', ErrorTypes.DATABASE,
      'Your balance could not be saved. Please try again.');
  }
  return { payout, profit: payout - amount, balance: userData.wallet };
}

export function money(value) {
  return `$${Number(value || 0).toLocaleString()}`;
}
