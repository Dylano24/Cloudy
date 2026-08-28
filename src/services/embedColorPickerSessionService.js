import { randomBytes } from 'node:crypto';

const sessions = new Map();

function parseColor(value) {
    const match = typeof value === 'string' && value.trim().match(/^#?([0-9a-f]{6})$/i);
    return match ? Number.parseInt(match[1], 16) : null;
}

export function createEmbedColorPickerSession({ userId, onColor }) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
        userId,
        onColor,
    });
    return token;
}

export async function applyEmbedColorPickerSession(token, value) {
    const session = sessions.get(token);
    if (!session) {
        sessions.delete(token);
        return { ok: false, reason: 'expired' };
    }

    const color = parseColor(value);
    if (color === null) return { ok: false, reason: 'invalid_color' };

    await session.onColor(color);
    return { ok: true, color: `#${color.toString(16).padStart(6, '0').toUpperCase()}` };
}

export function deleteEmbedColorPickerSession(token) {
    sessions.delete(token);
}
