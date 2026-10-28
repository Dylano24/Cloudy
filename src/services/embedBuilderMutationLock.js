// Serialize mutations targeting one physical Discord message within this bot.
const queues = new Map();

// Waits for earlier mutations of this exact message and returns a release
// function. Used by flows (Reappear moves) that cannot be one callback.
export async function acquireEmbedBuilderMessageMutation(guildId, channelId, messageId) {
    if (!guildId || !channelId || !messageId) return () => {};
    const key = [String(guildId), String(channelId), String(messageId)].join(':');
    const previous = queues.get(key) || Promise.resolve();
    let resolveReservation;
    const reservation = new Promise(resolve => { resolveReservation = resolve; });
    queues.set(key, reservation);
    await previous.catch(() => {});
    let released = false;
    return () => {
        if (released) return;
        released = true;
        resolveReservation();
        if (queues.get(key) === reservation) queues.delete(key);
    };
}

export async function withEmbedBuilderMessageMutation(guildId, channelId, messageId, work) {
    if (!guildId || !channelId || !messageId) return work();
    const release = await acquireEmbedBuilderMessageMutation(guildId, channelId, messageId);
    try {
        return await work();
    } finally {
        release();
    }
}
