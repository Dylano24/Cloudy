import test from 'node:test';
import assert from 'node:assert/strict';
import {
  amsterdamParts, parseAmsterdamStart, parseAutomationDuration, shortAutomationDuration,
  normalizeAutomationDate, normalizeAutomationTime,
} from '../src/services/automationSchedule.js';

test('short durations are parsed and displayed consistently for auto vote and giveaway', () => {
  const samples = { '1m': 1, '10m': 10, '1h': 60, '2h': 120, '1d': 1440, '2d': 2880, '1w': 10080 };
  for (const [input, minutes] of Object.entries(samples)) {
    assert.equal(parseAutomationDuration(input), minutes);
    assert.equal(shortAutomationDuration(minutes), input);
  }
  assert.equal(parseAutomationDuration('15'), 15, 'older numeric values still work');
  for (const invalid of ['0m', '12x', 'abc', '-1h', '31d', '1.5h', '1hour', '1day']) {
    assert.throws(() => parseAutomationDuration(invalid), RangeError);
  }
});

test('Central European dates and times are real UTC timestamps independent of host timezone', () => {
  const expected = Date.parse('2026-11-10T17:00:00.000Z');
  assert.equal(parseAmsterdamStart('10-11-2026', '18:00'), expected);
  assert.equal(parseAmsterdamStart('2026-11-10', '18:00'), expected);
  assert.equal(parseAmsterdamStart('10/11/2026', '18.00'), expected);
  assert.equal(parseAmsterdamStart('10.11.2026', '18'), expected);
  assert.equal(parseAmsterdamStart('10-11-2026', '18'), expected);
  assert.equal(parseAmsterdamStart('10112026', '1800'), expected);
  assert.equal(parseAmsterdamStart('20261110', '1800'), expected);
  assert.equal(normalizeAutomationDate('10112026'), '10-11-2026');
  assert.equal(normalizeAutomationDate('20261110'), '2026-11-10');
  assert.equal(normalizeAutomationTime('1800'), '18:00');
  assert.equal(normalizeAutomationTime('930'), '09:30');
  assert.equal(normalizeAutomationTime('9:5'), '09:05');
  assert.deepEqual(amsterdamParts(expected), { date: '10-11-2026', time: '18:00' });
  assert.equal(parseAmsterdamStart('10-07-2027', '18:00'), Date.parse('2027-07-10T16:00:00.000Z'));
});

test('impossible calendar dates and nonexistent daylight-saving clock times are rejected', () => {
  for (const input of ['31-02-2027', '29-02-2027', '00-11-2027', '32-11-2027']) {
    assert.throws(() => parseAmsterdamStart(input, '18:00'), RangeError);
  }
  assert.throws(() => parseAmsterdamStart('28-03-2027', '02:30'), RangeError);
  assert.throws(() => parseAmsterdamStart('10-11-2027', '25:00'), RangeError);
  assert.throws(() => parseAmsterdamStart('10112027', '2500'), RangeError);
  assert.throws(() => parseAmsterdamStart('31112027', '1800'), RangeError);
  assert.throws(() => parseAmsterdamStart('abc', '1800'), RangeError);
});
