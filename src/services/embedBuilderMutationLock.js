// Serialize mutations targeting one physical Discord message within this bot.
const queues = new Map();
export async function withEmbedBuilderMessageMutation(guildId, channelId, messageId, work) {
    if (!guildId || !channelId || !messageId) return work();
    const key = [String(guildId), String(channelId), String(messageId)].join(':');
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const reservation = new Promise(resolve => { release = resolve; });
    queues.set(key, reservation);
    try {
        await previous.catch(() => {});
        return await work();
    } finally {
        release();
        if (queues.get(key) === reservation) queues.delete(key);
    }
}
