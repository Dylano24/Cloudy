import { randomBytes } from 'node:crypto';

const sessions = new Map();
const EDIT_PREFIX = '__CLOUDY_EMBED_EDIT__:';
const STATE_PREFIX = '__CLOUDY_EMBED_STATE__';

function parseColor(value) {
    const match = typeof value === 'string' && value.trim().match(/^#?([0-9a-f]{6})$/i);
    return match ? Number.parseInt(match[1], 16) : null;
}

function sanitizeEditorState(value = {}) {
    return {
        title: typeof value.title === 'string' ? value.title.slice(0, 256) : '',
        message: typeof value.message === 'string' ? value.message.slice(0, 4000) : '',
        footer: typeof value.footer === 'string' ? value.footer.slice(0, 2048) : '',
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

export function createEmbedColorPickerSession({ userId, onColor, getEditorState, onEditorUpdate, emojis = [] }) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
        userId,
        onColor,
        getEditorState,
        onEditorUpdate,
        emojis: sanitizeEmojis(emojis),
    });
    return token;
}

export async function applyEmbedColorPickerSession(token, value) {
    const session = sessions.get(token);
    if (!session) {
        sessions.delete(token);
        return { ok: false, reason: 'expired' };
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
        const limits = { title: 256, message: 4000, footer: 2048 };
        if (!Object.hasOwn(limits, field) || typeof payload?.value !== 'string') {
            return { ok: false, reason: 'invalid_editor_payload' };
        }

        const nextValue = payload.value.slice(0, limits[field]);
        await session.onEditorUpdate(field, nextValue);
        return { ok: true, color: JSON.stringify({ type: 'editor_saved', field, value: nextValue }) };
    }

    const color = parseColor(value);
    if (color === null) return { ok: false, reason: 'invalid_color' };

    await session.onColor(color);
    return { ok: true, color: `#${color.toString(16).padStart(6, '0').toUpperCase()}` };
}

export function deleteEmbedColorPickerSession(token) {
    sessions.delete(token);
}
