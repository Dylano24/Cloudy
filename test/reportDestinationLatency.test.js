import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { validateReportDestinations, REPORT_LOG_CHANNEL_ID } from '../src/services/reportCaseLifecycleService.js';
import { REPORT_CATEGORY_ID } from '../src/services/reportCaseService.js';

test('independent report destination lookups start together while private permissions remain mandatory', async () => {
  const releases = new Map();
  const guild = { roles: { everyone: { id: 'everyone' } }, channels: { fetch: id => new Promise(resolve => releases.set(id, resolve)) } };
  const pending = validateReportDestinations(guild);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.deepEqual([...releases.keys()].sort(), [REPORT_CATEGORY_ID, REPORT_LOG_CHANNEL_ID].sort());
  const category = { type: ChannelType.GuildCategory };
  const logs = { send: async () => {}, permissionsFor: () => ({ has: () => false }) };
  releases.get(REPORT_CATEGORY_ID)(category);
  releases.get(REPORT_LOG_CHANNEL_ID)(logs);
  assert.deepEqual(await pending, { category, logs });
  logs.permissionsFor = () => ({ has: () => true });
  guild.channels.fetch = async id => id === REPORT_CATEGORY_ID ? category : logs;
  await assert.rejects(validateReportDestinations(guild), /private report-logs channel is unavailable/);
});
