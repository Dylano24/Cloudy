import { randomBytes } from 'node:crypto';
import {
    releaseBuilderSessionHold,
    runWithBuilderSessionHold,
} from '../utils/builderSessionCleanup.js';

const sessions = new Map();
const EDIT_PREFIX = '__CLOUDY_EMBED_EDIT__:';
const STATE_PREFIX = '__CLOUDY_EMBED_STATE__';
const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';
const PAUSE_PREFIX = '__CLOUDY_EMBED_PAUSE__'; // EMBED_EDITOR_CLOSE_RETURNS_5M_V6: compatibility with cached V3 pages
const OPEN_PREFIX = '__CLOUDY_EMBED_OPEN__:'; // EMBED_EDITOR_EXACT_OPEN_LEASE_V2
const CLOSE_PREFIX = '__CLOUDY_EMBED_CLOSE__';
const EDIT_FLUSH_DELAY_MS = 0; // BUILDER_NATIVE_COLOR_INSTANT_V1: flush edits on the next event-loop turn
export const EMBED_EDITOR_IDLE_MS = 14 * 60_000; // EMBED_EDITOR_EXACT_OPEN_LEASE_V2

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
        templateKind: value.templateKind === 'content' ? 'content' : 'embed', // CONTENT_TEMPLATE_EDITOR_V1
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

function clearSessionIdleTimer(session) {
    if (session?.idleTimer) clearTimeout(session.idleTimer);
    if (session) session.idleTimer = null;
}

function scheduleSessionIdleExpiry(token, session, editorInstanceId) {
    clearSessionIdleTimer(session);
    const instanceId = String(editorInstanceId || '');
    session.idleTimer = setTimeout(() => {
        session.idleTimer = null;
        if (sessions.get(token) !== session) return;
        if (!instanceId || session.activeEditorInstanceId !== instanceId) return;

        session.expiredEditorInstanceIds.add(instanceId);
        session.activeEditorInstanceId = null;
        session.holdActive = false;
        // 14m ends only the editor hold. The Builder then gets a fresh normal 5m.
        releaseBuilderSessionHold(token);
    }, EMBED_EDITOR_IDLE_MS);
    session.idleTimer.unref?.();
}

function normalizeEditorInstanceId(value) {
    return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}

async function openEditorLease(token, session, instanceId) {
    if (!instanceId) return { ok: false, reason: 'editor_instance_required' };
    if (session.closedEditorInstanceIds.has(instanceId)
        || session.expiredEditorInstanceIds.has(instanceId)) {
        return { ok: false, reason: 'editor_expired' };
    }

    if (session.activeEditorInstanceId !== instanceId) {
        // Only a genuinely new page starts a fresh fixed 14m. Same-page activity does not.
        session.activeEditorInstanceId = instanceId;
        scheduleSessionIdleExpiry(token, session, instanceId);
    }

    const held = await ensureEditorHold(token, session);
    if (!held.ok) return held;
    return { ok: true };
}

function requireActiveEditorInstance(session, instanceId) {
    if (!instanceId || session.activeEditorInstanceId !== instanceId) {
        return { ok: false, reason: 'editor_expired' };
    }
    return { ok: true };
}

export async function flushPendingEmbedEditorUpdates(token) {
    const session = sessions.get(token);
    if (!session || typeof session.onEditorUpdate !== 'function') return;
    if (session.editFlushTimer) clearTimeout(session.editFlushTimer);
    session.editFlushTimer = null;
    const generation = session.editGeneration;
    const previous = session.editorDrain || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
        session.editFlushRunning = true;
        try {
            while (session.pendingEditorUpdates.size && generation === session.editGeneration && sessions.get(token) === session) {
                const pending = [...session.pendingEditorUpdates.entries()];
                session.pendingEditorUpdates.clear();
                for (const [field, value] of pending) {
                    if (generation !== session.editGeneration) break;
                    try {
                        await session.onEditorUpdate(field, value);
                    } catch (error) {
                        // Keep this and remaining accepted updates for a retry.
                        if (generation === session.editGeneration && sessions.get(token) === session) {
                            for (const [retryField, retryValue] of pending.slice(pending.findIndex(entry => entry[0] === field))) {
                                if (!session.pendingEditorUpdates.has(retryField)) session.pendingEditorUpdates.set(retryField, retryValue);
                            }
                        }
                        throw error;
                    }
                }
            }
        } finally { session.editFlushRunning = false; }
    });
    session.editorDrain = job;
    try { await job; }
    finally { if (session.editorDrain === job) session.editorDrain = null; }
}

function scheduleEditorFlush(token, session) {
    if (session.editFlushRunning) return;
    if (session.editFlushTimer) clearTimeout(session.editFlushTimer);
    session.editFlushTimer = setTimeout(() => {
        void flushPendingEmbedEditorUpdates(token).catch(error => {
            if (error?.code !== 'EMBED_BUILDER_EXPIRED') console.error('Builder editor update failed:', error.message);
        });
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
        await runWithBuilderSessionHold(token, async () => {
            if (typeof session.onEditorHold === 'function') await session.onEditorHold();
        });
        session.holdActive = true;
    } catch (error) {
        releaseBuilderSessionHold(token);
        if (error?.code === 'EMBED_BUILDER_EXPIRED') {
            // An old Discord interaction must not invalidate the browser editor.
            // Keep accepting/saving editor state until the real 14-minute idle timer expires.
            session.holdActive = false;
            return { ok: true, previewUnavailable: true };
        }
        throw error;
    }

    return { ok: true };
}

async function touchEditorSession(token, session) {
    // EMBED_EDITOR_CLOSE_RETURNS_5M_V6: heartbeat NEVER restarts the fixed 14m lease. It only
    // refreshes the same Builder preview while the editor remains open.
    const held = await ensureEditorHold(token, session);
    if (!held.ok) return held;

    if (typeof session.onEditorUpdate !== 'function') {
        return { ok: false, reason: 'editor_unavailable' };
    }

    try {
        await runWithBuilderSessionHold(
            token,
            () => session.onEditorUpdate('__heartbeat__', ''),
        );
        session.holdActive = true;
    } catch (error) {
        if (error?.code === 'EMBED_BUILDER_EXPIRED') {
            session.holdActive = false;
            return { ok: true, previewUnavailable: true };
        }
        throw error;
    }

    return { ok: true };
}

export function createEmbedColorPickerSession({ userId, onColor, getEditorState, onEditorUpdate, onEditorHold, emojis = [] }) {
    const token = randomBytes(32).toString('hex');
    const session = {
        userId,
        onColor,
        getEditorState,
        onEditorUpdate,
        onEditorHold,
        emojis: sanitizeEmojis(emojis),
        holdActive: false,
        pendingEditorUpdates: new Map(),
        editFlushTimer: null,
        editFlushRunning: false,
        editGeneration: 0,
        idleTimer: null,
        activeEditorInstanceId: null, // EMBED_EDITOR_EXACT_OPEN_LEASE_V2
        closedEditorInstanceIds: new Set(),
        expiredEditorInstanceIds: new Set(),
    };
    sessions.set(token, session);
    // 14m starts only when Editor/Color Picker is actually opened.
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

export async function applyEmbedColorPickerSession(token, value, { editorInstanceId = null } = {}) {
    const session = sessions.get(token);
    if (!session) {
        return { ok: false, reason: 'expired' };
    }

    const explicitInstanceId = normalizeEditorInstanceId(editorInstanceId);
    const instanceId = explicitInstanceId || '__legacy_editor__';

    if (typeof value === 'string' && value.startsWith(OPEN_PREFIX)) {
        const requestedId = normalizeEditorInstanceId(value.slice(OPEN_PREFIX.length));
        if (!explicitInstanceId || requestedId !== explicitInstanceId) {
            return { ok: false, reason: 'editor_instance_required' };
        }
        const opened = await openEditorLease(token, session, instanceId);
        if (!opened.ok) return opened;
        return { ok: true, color: JSON.stringify({ type: 'editor_opened' }) };
    }

    if (value === PAUSE_PREFIX) {
        // A cached V3 page may still send PAUSE while merely backgrounded.
        // PAUSE is not proof the editor was closed, so only explicit CLOSE
        // releases the Builder hold and starts the normal fresh 5m window.
        return { ok: true, color: JSON.stringify({ type: 'editor_lifecycle_ignored' }) };
    }

    if (value === CLOSE_PREFIX) {
        // A no-ID close can be a stale cached page, so it may never release a newer page.
        if (!explicitInstanceId) {
            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };
        }
        session.closedEditorInstanceIds.add(instanceId);
        if (session.activeEditorInstanceId !== instanceId) {
            return { ok: true, color: JSON.stringify({ type: 'editor_close_ignored' }) };
        }

        clearSessionIdleTimer(session);
        session.activeEditorInstanceId = null;
        session.holdActive = false;
        // Closing starts a fresh normal 5m Builder inactivity window.
        releaseBuilderSessionHold(token);
        return { ok: true, color: JSON.stringify({ type: 'editor_closed' }) };
    }

    // Backwards compatibility for an already-cached pre-instance editor page or
    // internal caller: its first request opens one fixed legacy 14m lease. It
    // still cannot reset that lease through typing/heartbeat/activity.
    if (!explicitInstanceId && !session.activeEditorInstanceId) {
        const opened = await openEditorLease(token, session, instanceId);
        if (!opened.ok) return opened;
    }

    const active = requireActiveEditorInstance(session, instanceId);
    if (!active.ok) return active;

    if (value === HEARTBEAT_PREFIX) {
        const touched = await touchEditorSession(token, session);
        if (!touched.ok) return touched;
        return { ok: true, color: JSON.stringify({ type: 'heartbeat' }) };
    }

    // State, typing, emoji and color requests do NOT restart the fixed 14m.
    const held = await ensureEditorHold(token, session);
    if (!held.ok) return held;

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
        if (error?.code !== 'EMBED_BUILDER_EXPIRED') {
            throw error;
        }
    }
    return { ok: true, color: `#${color.toString(16).padStart(6, '0').toUpperCase()}` };
}

export function deleteEmbedColorPickerSession(token) {
    const session = sessions.get(token);
    if (session?.editFlushTimer) clearTimeout(session.editFlushTimer);
    clearSessionIdleTimer(session);
    sessions.delete(token);
    releaseBuilderSessionHold(token);
}
