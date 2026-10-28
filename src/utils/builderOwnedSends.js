import { MESSAGE_BUILDER_FOOTER_MARKER } from '../services/cloudyBrandingService.js';

// Discord echoes a send's nonce in its own MESSAGE_CREATE gateway event. The
// Builder tags its physical posts with one, so the generic "new bot message"
// listener can recognise them even before channel.send() has resolved and
// even when the post has no footer marker (no footer at all).
const NONCE_PREFIX = 'cbld';
const OWNERSHIP_TTL_MS = 5 * 60_000;
const MAX_TRACKED = 1000;
const ownedNonces = new Map();
const ownedMessageIds = new Map();

function prune(map, now = Date.now()) {
    for (const [key, expiresAt] of map) {
        if (expiresAt <= now) map.delete(key);
    }
    while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

function createNonce() {
    // Discord accepts at most 25 characters.
    return (NONCE_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 25);
}

export function withBuilderOwnedNonce(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const nonce = createNonce();
    prune(ownedNonces);
    ownedNonces.set(nonce, Date.now() + OWNERSHIP_TTL_MS);
    return { ...payload, nonce };
}

export function rememberBuilderOwnedMessage(message) {
    const id = String(message?.id || '');
    if (!id) return;
    prune(ownedMessageIds);
    ownedMessageIds.set(id, Date.now() + OWNERSHIP_TTL_MS);
}

function hasBuilderMarker(message) {
    return (message?.embeds || []).some(embed => {
        const text = String(embed?.footer?.text || embed?.data?.footer?.text || '');
        return text.length > MESSAGE_BUILDER_FOOTER_MARKER.length
            && text.endsWith(MESSAGE_BUILDER_FOOTER_MARKER);
    });
}

export function isBuilderOwnedMessage(message) {
    if (!message) return false;
    if (hasBuilderMarker(message)) return true;
    const now = Date.now();
    const nonce = message.nonce == null ? '' : String(message.nonce);
    if (nonce && (ownedNonces.get(nonce) || 0) > now) return true;
    const id = String(message.id || '');
    return Boolean(id && (ownedMessageIds.get(id) || 0) > now);
}
