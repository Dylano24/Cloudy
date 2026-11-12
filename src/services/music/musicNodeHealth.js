// Which Lavalink nodes recently could not hold a voice connection. The public nodes
// are flaky: right after a restart one of them can be down and the other (MilloHost)
// accepts a song but never gets sound into the voice channel, which Lavalink reports as
// "track stuck". Such a node is tried last for a while, and a new player is not created
// on it while no other node is connected.
const BAD_NODE_MS = 10 * 60 * 1000;
const RECENT_BAD_MS = 2 * 60 * 1000;
const badNodes = new Map();

export function isBadNode(node) {
    return (badNodes.get(node?.name) || 0) > Date.now();
}

/** This node failed or played without sound just now. */
export function markNodeBad(node) {
    if (node?.name) badNodes.set(node.name, Date.now() + BAD_NODE_MS);
}

/** This node really started a song. */
export function clearBadNode(node) {
    if (node?.name) badNodes.delete(node.name);
}

/** The node failed within the last two minutes: a new player does not go there while no other node is connected. */
export function isRecentlyBadNode(node) {
    const until = badNodes.get(node?.name) || 0;
    return until - BAD_NODE_MS + RECENT_BAD_MS > Date.now();
}
