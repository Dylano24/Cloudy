// "Start time" in the Cloudy Feed form: when a feed makes its first post.
// Times are read as the server owner's local time (Netherlands).
export const FEED_TIME_ZONE = 'Europe/Amsterdam';
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: FEED_TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function zonedParts(timestamp) {
  const parts = {};
  for (const part of partsFormatter.formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

function zoneOffsetMs(timestamp) {
  const p = zonedParts(timestamp);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(timestamp / 1000) * 1000;
}

// Netherlands wall-clock time to a UTC timestamp, including summer/winter time.
function zonedTimestamp(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let result = wall - zoneOffsetMs(wall);
  result = wall - zoneOffsetMs(result);
  return result;
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const FORMAT_HINT = 'Start time must look like 20:00 or 30-10 20:00.';

// Empty means "no start time": the feed starts as before.
// Accepts "20:00" (today, or tomorrow once passed), "30-10 20:00" (the next
// 30 October) and "30-10-2026 20:00".
export function parseStartTime(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^(?:(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?\s+)?(\d{1,2})[:.](\d{2})$/.exec(text);
  if (!match) throw new Error(FORMAT_HINT);
  const [, dayText, monthText, yearText, hourText, minuteText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour > 23 || minute > 59) throw new Error(FORMAT_HINT);

  const today = zonedParts(now);
  let result;
  if (!dayText) {
    result = zonedTimestamp(today.year, today.month, today.day, hour, minute);
    if (result <= now) {
      const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
      result = zonedTimestamp(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1,
        tomorrow.getUTCDate(), hour, minute);
    }
  } else {
    const day = Number(dayText);
    const month = Number(monthText);
    let year = yearText ? Number(yearText) : today.year;
    if (!validDate(year, month, day) && !(yearText === undefined && month === 2 && day === 29)) {
      throw new Error(FORMAT_HINT);
    }
    if (!yearText) {
      // Without a year: the next time this date comes around.
      while (!validDate(year, month, day) || zonedTimestamp(year, month, day, hour, minute) <= now) {
        year++;
        if (year > today.year + 4) throw new Error(FORMAT_HINT);
      }
    }
    result = zonedTimestamp(year, month, day, hour, minute);
  }
  if (result <= now) throw new Error('Start time must be in the future.');
  if (result - now > MAX_AHEAD_MS) throw new Error('Start time must be within one year.');
  return result;
}

// Shown in the Edit feed form, in the same format the form accepts.
export function formatStartTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return '';
  const p = zonedParts(timestamp);
  const pad = value => String(value).padStart(2, '0');
  const date = pad(p.day) + '-' + pad(p.month) + (p.year !== zonedParts(now).year ? '-' + p.year : '');
  return date + ' ' + pad(p.hour) + ':' + pad(p.minute);
}
