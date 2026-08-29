function wait(delay) {
  if (!delay) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, delay);
    timer.unref?.();
  });
}

export async function fetchRecentAuditEntry(
  guild,
  type,
  targetId,
  { limit = 6, maxAgeMs = 15_000, retryDelays = [0, 100, 250, 500] } = {},
) {
  let lastError = null;

  for (const delay of retryDelays) {
    await wait(delay);

    try {
      const auditLogs = await guild.fetchAuditLogs({ type, limit });
      const now = Date.now();
      const entry = auditLogs.entries.find(item =>
        item.target?.id === targetId &&
        now - item.createdTimestamp < maxAgeMs,
      );
      if (entry) return entry;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}
