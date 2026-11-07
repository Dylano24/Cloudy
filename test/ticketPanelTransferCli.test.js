import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../scripts/transfer-ticket-panel.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const source = 'https://discord.com/channels/1532882647838228723/1533197784725852181/1554538586001645679';
const target = 'https://discord.com/channels/1532882647838228723/1533197784725852181/1568468995747881030';

test('the maintenance CLI defaults to previewing exact source and target message links', () => {
  assert.equal(typeof api.parseTicketPanelTransferArgs, 'function');
  const result = api.parseTicketPanelTransferArgs(['--source-url', source, '--target-url', target]);
  assert.equal(result.apply, false);
  assert.deepEqual(result.source, {guildId: '1532882647838228723', channelId: '1533197784725852181', messageId: '1554538586001645679'});
  assert.equal(result.target.messageId, '1568468995747881030');
  assert.equal(api.parseTicketPanelTransferArgs(['--source-url', source, '--target-url', target, '--apply']).apply, true);
});

test('malformed links, conflicting modes, different channels and unrecognized arguments are rejected before login', () => {
  assert.equal(typeof api.parseTicketPanelTransferArgs, 'function');
  for (const args of [
    [], ['--source-url', source], ['--source-url', source, '--target-url', source],
    ['--source-url', source, '--target-url', target.replace('discord.com', 'discord.com.example.test')],
    ['--source-url', source, '--target-url', target.replace('1533197784725852181', '1533197784725852182')],
    ['--source-url', source, '--target-url', target, '--apply', '--dry-run'],
    ['--source-url', source, '--target-url', target, '--aply'],
    ['--vote-url', target, '--target-url', target],
  ]) assert.throws(() => api.parseTicketPanelTransferArgs(args));
});

test('the same maintenance CLI can preview one exact existing vote without accessing ticket config', () => {
  const plan = api.parseTicketPanelTransferArgs(['--vote-url', target]);
  assert.equal(plan.apply, false);
  assert.equal(plan.vote.messageId, '1568468995747881030');
  assert.equal(plan.target, undefined);
  assert.equal(api.parseTicketPanelTransferArgs(['--vote-url', target, '--apply']).apply, true);
});
