import { randomBytes } from 'node:crypto';

const sessions = new Map();
const EDIT_PREFIX = '__CLOUDY_EMBED_EDIT__:';
const STATE_PREFIX = '__CLOUDY_EMBED_STATE__';
const HEARTBEAT_PREFIX = '__CLOUDY_EMBED_HEARTBEAT__';
const SESSION_TTL_MS = 14 * 60_000;

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

async function touchEditorSession(token, session) {
    if (typeof session.onEditorUpdate !== 'function') {
        return { ok: false, reason: 'editor_unavailable' };
    }

    try {
        // Unknown fields are intentionally ignored by the builder state updater,
        // but still refresh/touch the Discord builder session. This lets the web
        // editor keep the 60-second inactivity timer alive without changing data.
        await session.onEditorUpdate('__heartbeat__', '');
        return { ok: true };
    } catch (error) {
        if (error?.code === 'EMBED_BUILDER_EXPIRED') {
            deleteEmbedColorPickerSession(token);
            return { ok: false, reason: 'expired' };
        }
        throw error;
    }
}

export function createEmbedColorPickerSession({ userId, onColor, getEditorState, onEditorUpdate, emojis = [] }) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const expiryTimer = setTimeout(() => sessions.delete(token), SESSION_TTL_MS);
    expiryTimer.unref?.();
    sessions.set(token, {
        userId,
        onColor,
        getEditorState,
        onEditorUpdate,
        emojis: sanitizeEmojis(emojis),
        expiresAt,
        expiryTimer,
    });
    return token;
}

export async function applyEmbedColorPickerSession(token, value) {
    const session = sessions.get(token);
    if (!session || Date.now() >= session.expiresAt) {
        deleteEmbedColorPickerSession(token);
        return { ok: false, reason: 'expired' };
    }

    if (value === HEARTBEAT_PREFIX) {
        const touched = await touchEditorSession(token, session);
        if (!touched.ok) return touched;
        return { ok: true, color: JSON.stringify({ type: 'heartbeat' }) };
    }

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
        try {
            await session.onEditorUpdate(field, nextValue);
        } catch (error) {
            if (error?.code === 'EMBED_BUILDER_EXPIRED') {
                deleteEmbedColorPickerSession(token);
                return { ok: false, reason: 'expired' };
            }
            throw error;
        }
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
    sessions.delete(token);
}
