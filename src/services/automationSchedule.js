// The automation panel uses Central European time (CET/CEST), regardless
// of the host's (Railway) timezone. Discord timestamps render per viewer.
const ZONE = 'Europe/Amsterdam';
const LOCAL_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function parseAutomationDuration(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  const match = /^(\d{1,6})\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?)?$/.exec(raw);
  if (!match) throw new RangeError('Use a duration such as 1m, 2h or 1d.');
  const multiplier = match[2]?.startsWith('w') ? 10080
    : match[2]?.startsWith('d') ? 1440
      : match[2]?.startsWith('h') ? 60 : 1;
  const minutes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 43200) {
    throw new RangeError('Duration must be between 1m and 30d.');
  }
  return minutes;
}

export function shortAutomationDuration(minutes) {
  if (!Number.isSafeInteger(minutes) || minutes < 1) return 'Not configured';
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function amsterdamParts(timestamp) {
  const raw = LOCAL_PARTS.formatToParts(new Date(timestamp));
  const value = type => raw.find(part => part.type === type)?.value;
  return {
    date: `${value('day')}-${value('month')}-${value('year')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

export function parseAmsterdamStart(date, time) {
  const rawDate = String(date || '').trim().replace(/[/.]/g, '-');
  const enteredTime = String(time || '').trim().replace('.', ':');
  const rawTime = /^\d{1,2}$/.test(enteredTime) ? `${enteredTime}:00` : enteredTime;
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(rawDate)
    || /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);
  const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(rawTime);
  if (!match || !timeMatch) {
    throw new RangeError('Use a date like 10-11-2026 and a time like 18:00 (EU time).');
  }
  const iso = /^\d{4}-/.test(rawDate);
  const year = Number(iso ? match[1] : match[3]);
  const month = Number(match[2]);
  const day = Number(iso ? match[3] : match[1]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const naive = Date.UTC(year, month - 1, day, hours, minutes);
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (year < 2020 || year > 2100 || actual.getUTCFullYear() !== year
    || actual.getUTCMonth() !== month - 1 || actual.getUTCDate() !== day) {
    throw new RangeError('Choose a valid date, for example 10-11-2026.');
  }
  // CET and CEST are UTC+1 and UTC+2. Check the formatted local time so
  // nonexistent clock times at DST spring-forward are rejected.
  const requested = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
  const requestedTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  for (const offset of [2, 1]) {
    const utc = naive - offset * 3_600_000;
    const rendered = amsterdamParts(utc);
    if (rendered.date === requested && rendered.time === requestedTime) return utc;
  }
  throw new RangeError('That time is unavailable in EU time. Choose another time.');
}
