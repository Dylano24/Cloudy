const INTERNAL_RESPONSE_PAYLOAD = Symbol.for('cloudy.internalResponsePayload');

export function markInternalResponsePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    payload[INTERNAL_RESPONSE_PAYLOAD] = true;
    return payload;
}

export function isInternalResponsePayload(payload) {
    return Boolean(payload && typeof payload === 'object' && payload[INTERNAL_RESPONSE_PAYLOAD]);
}

export function stripInternalResponsePayloadMarker(payload) {
    if (!isInternalResponsePayload(payload)) return payload;
    const clean = { ...payload };
    delete clean[INTERNAL_RESPONSE_PAYLOAD];
    return clean;
}