import test from 'node:test';
import assert from 'node:assert/strict';
import {
  amsterdamParts, parseAmsterdamStart, parseAutomationDuration, shortAutomationDuration,
  normalizeAutomationDate, normalizeAutomationTime,
} from '../src/services/automationSchedule.js';

test('schedule duration requires a valid unit and supports one-week before wipe', () => {
  const samples = { '1m': 1, '10m': 10, '1h': 60, '2h': 120, '1d': 1440, '2d': 2880, '1w': 10080 };
  for (const [input, minutes] of Object.entries(samples)) {
    assert.equal(parseAutomationDuration(input), minutes);
    assert.equal(shortAutomationDuration(minutes), input);
  }
  for (const invalid of ['15', '0m', '12x', 'abc', '-1h', '31d', '1.5h', '1hour', '1day', '1 m', '2y']) {
    assert.throws(() => parseAutomationDuration(invalid), RangeError);
  }
});

test('EU date and time only accept DD-MM-YYYY and HH:MM', () => {
  const expected = Date.parse('2026-11-10T17:00:00.000Z');
  assert.equal(parseAmsterdamStart('10-11-2026', '18:00'), expected);
  assert.equal(normalizeAutomationDate('10-11-2026'), '10-11-2026');
  assert.equal(normalizeAutomationTime('18:00'), '18:00');
  assert.deepEqual(amsterdamParts(expected), { date: '10-11-2026', time: '18:00' });
  assert.equal(parseAmsterdamStart('10-07-2027', '18:00'), Date.parse('2027-07-10T16:00:00.000Z'));
  for (const [date, time] of [
    ['10112026', '1800'], ['20261110', '18:00'], ['2026-11-10', '18:00'],
    ['10/11/2026', '18:00'], ['10.11.2026', '18:00'], ['10-11-2026', '1800'],
    ['10-11-2026', '18.00'], ['10-11-2026', '18'], ['10-11-2026', '9:05'],
  ]) assert.throws(() => parseAmsterdamStart(date, time), RangeError);
});

test('invalid calendar dates and impossible daylight-saving times never become schedules', () => {
  for (const input of ['31-02-2027', '29-02-2027', '00-11-2027', '32-11-2027']) {
    assert.throws(() => parseAmsterdamStart(input, '18:00'), RangeError);
  }
  assert.throws(() => parseAmsterdamStart('28-03-2027', '02:30'), RangeError);
  assert.throws(() => parseAmsterdamStart('10-11-2027', '25:00'), RangeError);
  assert.throws(() => parseAmsterdamStart('abc', '18:00'), RangeError);
});
