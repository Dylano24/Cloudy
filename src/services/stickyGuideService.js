const DEFAULT_REFRESH_DELAY_MS = 1500;

function isNewerId(id, otherId) {
  const value = String(id || '');
  const other = String(otherId || '');
  return value.length > other.length || (value.length === other.length && value > other);
}

/**
 * Keep one bot-owned guide at the bottom without losing it on a failed send.
 * Storage and payload construction stay with the feature that owns the guide.
 */
export function createStickyGuideManager({
  loadState,
  saveState,
  buildPayload,
  isGuide,
  onError,
  delayMs = DEFAULT_REFRESH_DELAY_MS,
}) {
  const operations = new Map();
  const scheduled = new Map();

  async function persist(channel, state) {
    if (await saveState(channel, state) === false) {
      throw new Error('Could not save sticky guide message IDs');
    }
  }

  async function refreshChannel(channel) {
    const botUserId = channel.client?.user?.id || channel.guild?.client?.user?.id;
    if (!botUserId || !channel.messages?.fetch) return false;

    // A failed history read must not be mistaken for an empty channel.
    const recent = await channel.messages.fetch({ limit: 100 });
    const state = await loadState(channel);
    const trackedIds = new Set([state?.messageId, ...(state?.staleMessageIds || [])].filter(Boolean));
    const guides = new Map();
    const rememberGuide = message => {
      if (message?.author?.id === botUserId
        && (trackedIds.has(message.id) || isGuide(message))) {
        guides.set(message.id, message);
      }
    };
    for (const message of recent.values()) rememberGuide(message);

    // The previous guide can be outside the history window after a restart.
    for (const id of trackedIds) {
      if (recent.has(id)) continue;
      try {
        rememberGuide(await channel.messages.fetch({ message: id, force: true }));
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    }

    let existing = guides.get(state?.messageId) || null;
    if (!existing) {
      for (const message of guides.values()) {
        if (!existing || isNewerId(message.id, existing.id)) existing = message;
      }
    }
    const latest = recent.first();
    const alreadyLast = existing && latest?.id === existing.id
      && !isNewerId(channel.lastMessageId, existing.id);
    let current = existing;

    if (!alreadyLast) {
      current = await channel.send(await buildPayload(channel, existing));
    }

    const stale = [...guides.values()].filter(message => message.id !== current.id);
    try {
      // Save both the replacement and pending cleanup before deleting anything.
      await persist(channel, {
        messageId: current.id,
        staleMessageIds: stale.map(message => message.id),
      });
    } catch (error) {
      if (current !== existing) {
        await current.delete().catch(onError);
      }
      throw error;
    }

    const remainingIds = [];
    for (const message of stale) {
      try {
        await message.delete();
      } catch (error) {
        if (error.code !== 10008) {
          remainingIds.push(message.id);
          onError(error);
        }
      }
    }
    if (stale.length && remainingIds.length !== stale.length) {
      await persist(channel, { messageId: current.id, staleMessageIds: remainingIds });
    }
    return true;
  }

  async function refresh(channel) {
    const key = channel.id;
    const previous = operations.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => refreshChannel(channel));
    operations.set(key, current);
    try {
      return await current;
    } finally {
      if (operations.get(key) === current) operations.delete(key);
    }
  }

  function schedule(message) {
    const channel = message.channel;
    const botUserId = channel?.client?.user?.id || message.guild?.client?.user?.id;
    if (!channel || !message.guild || !botUserId) return false;
    if (message.author?.id === botUserId && isGuide(message)) return false;

    const existing = scheduled.get(channel.id);
    if (existing) {
      existing.dirty = true;
      return true;
    }

    const pending = { dirty: true };
    scheduled.set(channel.id, pending);
    const armTimer = () => {
      const timer = setTimeout(async () => {
        pending.dirty = false;
        try {
          await refresh(channel);
        } catch (error) {
          onError(error);
        } finally {
          // Traffic during an in-flight refresh gets one further pass.
          if (pending.dirty) armTimer();
          else scheduled.delete(channel.id);
        }
      }, delayMs);
      timer.unref?.();
    };
    armTimer();
    return true;
  }

  return { refresh, schedule };
}
