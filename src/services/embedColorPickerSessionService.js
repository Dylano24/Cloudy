import { randomBytes } from 'node:crypto';
import {
    releaseBuilderSessionHold,
    runWithBuilderSessionHold,
} from '../utils/builderSessionCleanup.js';

const sessions = new Map();
const EDIT_PREFIX = '__CLOUDY_EMBED_EDIT__:';
const STATE_PREFIX = '__CLOUDY_EMBED_STATE__';
const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';
const CLOSE_PREFIX = '__CLOUDY_EMBED_CLOSE__';
const SESSION_TTL_MS = 14 * 60_000;
const EDIT_FLUSH_DELAY_MS = 0;

function parseColor(value) {
    const match = typeof value === 'string' && value.trim().match(/^#?([0-9a-f]{6})$/i);
    return match ? Number.parseInt(match[1], 16) : null;
}

function sanitizeEditorState(value = {}) {
    return {
        title: typeof value.title === 'string' ? value.title.slice(0, 256) : '',
        message: typeof value.message === 'string' ? value.message.slice(0, 4096) : '',
        footer: typeof value.footer === 'string' ? value.footer.slice(0, 2048) : '',
        fields: Array.isArray(value.fields)
            ? value.fields.slice(0, 25).map(field => ({
                name: typeof field?.name === 'string' ? field.name.slice(0, 256) : '',
                value: typeof field?.value === 'string' ? field.value.slice(0, 1024) : '',
                inline: Boolean(field?.inline),
            }))
            : [],
    };
}

function sanitizeEmojis(emojis = []) {
    const unique = new Map();

    for (const emoji of Array.isArray(emojis) ? emojis : []) {
        const clean = {
            id: String(emoji?.id || ''),
            name: String(emoji?.name || 'emoji').slice(0, 100),
            animated: Boolean(emoji?.animated),
        };
        if (/^\d+$/.test(clean.id) && !unique.has(clean.id)) {
            unique.set(clean.id, clean);
        }
    }

    return [...unique.values()].slice(0, 500);
}

function clearSessionExpiry(session) {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
}

function extendSessionLifetime(token, session) {
    // Once the browser editor/picker is actually open, its lifetime is tied to
    // the explicit browser close signal rather than a timer. This matters on
    // mobile where browsers suspend JavaScript/network timers in background.
    if (session.holdActive) {
        clearSessionExpiry(session);
        session.expiresAt = Number.POSITIVE_INFINITY;
        return;
    }

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    clearSessionExpiry(session);
    session.expiryTimer = setTimeout(() => deleteEmbedColorPickerSession(token), SESSION_TTL_MS);
    session.expiryTimer.unref?.();
}

function scheduleEditorFlush(token, session) {
    if (session.editFlushRunning) return;

    if (session.editFlushTimer) clearTimeout(session.editFlushTimer);
    const generation = session.editGeneration;
    session.editFlushTimer = setTimeout(async () => {
        session.editFlushTimer = null;
        if (!sessions.has(token) || typeof session.onEditorUpdate !== 'function') return;
        if (generation !== session.editGeneration) return;

        const pending = [...session.pendingEditorUpdates.entries()];
        session.pendingEditorUpdates.clear();
        if (!pending.length) return;

        session.editFlushRunning = true;
        try {
            for (const [field, value] of pending) {
                if (generation !== session.editGeneration) break;
                await session.onEditorUpdate(field, value);
            }
        } catch (error) {
            if (error?.code === 'EMBED_BUILDER_EXPIRED') {
                deleteEmbedColorPickerSession(token);
            }
        } finally {
            session.editFlushRunning = false;
            if (session.pendingEditorUpdates.size && sessions.has(token)) {
                scheduleEditorFlush(token, session);
            }
        }
    }, EDIT_FLUSH_DELAY_MS);
    session.editFlushTimer.unref?.();
}

function queueEditorUpdate(token, session, field, value) {
    session.pendingEditorUpdates.set(field, value);
    scheduleEditorFlush(token, session);
}

async function ensureEditorHold(token, session) {
    if (session.holdActive) return { ok: true };
    if (typeof session.onEditorUpdate !== 'function') {
        return { ok: false, reason: 'editor_unavailable' };
    }

    try {
        // One unchanged preview refresh is enough to capture the Message Builder
        // (and linked Modify Embed parent/child) inside the held session. From
        // this point there is NO five-minute deletion timer while the web editor
        // remains open, even if a phone/browser suspends heartbeats entirely.
        await runWithBuilderSessionHold(token, () => session.onEditorUpdate('__heartbeat__', ''));
        session.holdActive = true;
        clearSessionExpiry(session);
        session.expiresAt = Number.POSITIVE_INFINITY;
    } catch (error) {
        releaseBuilderSessionHold(token);
        if (error?.code === 'EMBED_BUILDER_EXPIRED') {
            deleteEmbedColorPickerSession(token);
            return { ok: false, reason: 'expired' };
        }
        throw error;
    }

    return { ok: true };
}

async function touchEditorSession(token, session) {
    const held = await ensureEditorHold(token, session);
    if (!held.ok) return held;
    extendSessionLifetime(token, session);
    return { ok: true };
}

export function createEmbedColorPickerSession({ userId, onColor, getEditorState, onEditorUpdate, emojis = [] }) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const session = {
        userId,
        onColor,
        getEditorState,
        onEditorUpdate,
        emojis: sanitizeEmojis(emojis),
        expiresAt,
        expiryTimer: null,
        holdActive: false,
        pendingEditorUpdates: new Map(),
        editFlushTimer: null,
        editFlushRunning: false,
        editGeneration: 0,
    };
    session.expiryTimer = setTimeout(() => deleteEmbedColorPickerSession(token), SESSION_TTL_MS);
    session.expiryTimer.unref?.();
    sessions.set(token, session);
    return token;
}

export function discardPendingEmbedEditorUpdates(token) {
    const session = sessions.get(token);
    if (!session) return false;

    session.editGeneration += 1;
    session.pendingEditorUpdates.clear();
    if (session.editFlushTimer) clearTimeout(session.editFlushTimer);
    session.editFlushTimer = null;
    return true;
}

export async function applyEmbedColorPickerSession(token, value) {
    const session = sessions.get(token);
    if (!session || Date.now() >= session.expiresAt) {
        deleteEmbedColorPickerSession(token);
        return { ok: false, reason: 'expired' };
    }

    if (value === CLOSE_PREFIX) {
        deleteEmbedColorPickerSession(token);
        return { ok: true, color: JSON.stringify({ type: 'editor_closed' }) };
    }

    if (value === HEARTBEAT_PREFIX) {
        const touched = await touchEditorSession(token, session);
        if (!touched.ok) return touched;
        return { ok: true, color: JSON.stringify({ type: 'heartbeat' }) };
    }

    // Loading state, editing content and using the picker all prove that the
    // browser editor is open. Establish the hold before doing any of them.
    const held = await ensureEditorHold(token, session);
    if (!held.ok) return held;
    extendSessionLifetime(token, session);

    if (value === STATE_PREFIX) {
        const state = sanitizeEditorState(await session.getEditorState?.() || {});
        return {
            ok: true,
            color: JSON.stringify({
                type: 'editor_state',
                ...state,
                emojis: session.emojis,
            }),
        };
    }

    if (typeof value === 'string' && value.startsWith(EDIT_PREFIX)) {
        if (typeof session.onEditorUpdate !== 'function') {
            return { ok: false, reason: 'editor_unavailable' };
        }

        let payload;
        try {
            payload = JSON.parse(value.slice(EDIT_PREFIX.length));
        } catch {
            return { ok: false, reason: 'invalid_editor_payload' };
        }

        const field = payload?.field;
        const fieldMatch = typeof field === 'string' && field.match(/^embed_field_(name|value):(\d{1,2})$/);
        const fieldIndex = fieldMatch ? Number(fieldMatch[2]) : -1;
        const limits = { title: 256, message: 4096, footer: 2048 };
        const limit = fieldMatch
            ? (fieldMatch[1] === 'name' ? 256 : 1024)
            : limits[field];
        if ((!Number.isInteger(limit) || fieldIndex > 24) || typeof payload?.value !== 'string') {
            return { ok: false, reason: 'invalid_editor_payload' };
        }

        const nextValue = payload.value.slice(0, limit);
        queueEditorUpdate(token, session, field, nextValue);
        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };
    }

    const color = parseColor(value);
    if (color === null) return { ok: false, reason: 'invalid_color' };

    try {
        await session.onColor(color);
    } catch (error) {
        if (error?.code === 'EMBED_BUILDER_EXPIRED') {
            deleteEmbedColorPickerSession(token);
            return { ok: false, reason: 'expired' };
        }
        throw error;
    }
    return { ok: true, color: `#${color.toString(16).padStart(6, '0').toUpperCase()}` };
}

export function deleteEmbedColorPickerSession(token) {
    const session = sessions.get(token);
    if (session?.expiryTimer) clearTimeout(session.expiryTimer);
    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);
    sessions.delete(token);
    releaseBuilderSessionHold(token);
}
