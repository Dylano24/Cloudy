// The automation panel uses Central European time (CET/CEST), regardless
// of the host's (Railway) timezone. Discord timestamps render per viewer.
const ZONE = 'Europe/Amsterdam';
const LOCAL_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function parseAutomationDuration(input, fieldName = 'Duration') {
  const raw = String(input ?? '').trim().toLowerCase();
  const match = /^(\d{1,6})([mhdw])$/.exec(raw);
  if (!match) {
    throw new RangeError(`${fieldName}: use 1m, 1h, 1d or 1w. Other letters are not allowed.`);
  }
  const multiplier = match[2]?.startsWith('w') ? 10080
    : match[2]?.startsWith('d') ? 1440
      : match[2]?.startsWith('h') ? 60 : 1;
  const minutes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 43200) {
    throw new RangeError(`${fieldName} must be between 1m and 30d.`);
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

// Discord text inputs do not support live input masks. Normalize compact
// entries at submit time instead, so 10112026 and 1800 work as expected.
export function normalizeAutomationDate(input) {
  const raw = String(input ?? '').trim().replace(/[/.]/g, '-');
  if (!/^\d{8}$/.test(raw)) return raw;
  if (/^20\d{2}(0[1-9]|1[0-2])/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  }
  return `${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4)}`;
}

export function normalizeAutomationTime(input) {
  const raw = String(input ?? '').trim().replace('.', ':');
  if (/^\d{1,2}$/.test(raw)) return `${raw.padStart(2, '0')}:00`;
  if (/^\d{3,4}$/.test(raw)) {
    return `${raw.slice(0, -2).padStart(2, '0')}:${raw.slice(-2)}`;
  }
  const parts = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
  return parts ? `${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}` : raw;
}

export function parseAmsterdamStart(date, time) {
  // Only explicit EU separators are accepted: there are no implicit / auto
  // corrected dates that could schedule something the user did not intend.
  const rawDate = String(date ?? '').trim();
  const rawTime = String(time ?? '').trim();
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(rawDate);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(rawTime);
  if (!match) {
    throw new RangeError('Invalid Date: use DD-MM-YYYY, for example 10-11-2027.');
  }
  if (!timeMatch) {
    throw new RangeError('Invalid Time: use HH:MM, for example 18:00.');
  }
  const year = Number(match[3]);
  const month = Number(match[2]);
  const day = Number(match[1]);
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
