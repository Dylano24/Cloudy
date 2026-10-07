// The website source header is public. Bound delivery independently of it.
export function createAppealRateLimit({ now = Date.now, maxKeys = 2000 } = {}) {
  const emails = new Map();
  let windowStart = now(), attempts = 0;
  return email => {
    const time = now();
    if (time - windowStart >= 60_000) { windowStart = time; attempts = 0; }
    if (attempts >= 30) return false;
    for (const [key, entry] of emails) if (time - entry.start >= 3_600_000) emails.delete(key);
    const key = String(email).toLowerCase();
    const entry = emails.get(key);
    if (entry?.count >= 3 || (!entry && emails.size >= maxKeys)) return false;
    emails.set(key, { start: entry?.start ?? time, count: (entry?.count || 0) + 1 });
    attempts++;
    return true;
  };
}
