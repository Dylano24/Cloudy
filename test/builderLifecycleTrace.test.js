import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { REST } from '@discordjs/rest';
import {
  installBuilderSessionCleanup, runWithBuilderSessionHold,
  acquireCurrentBuilderSessionHold, deleteBuilderSessionMessage,
  releaseBuilderSessionHold, traceEditorHold,
} from '../src/utils/builderSessionCleanup.js';
import { observeBuilderCollector, rememberBuilderWebhook, traceHoldId } from '../src/utils/builderLifecycleTrace.js';

test('trace correlates holds, collector end, REST outcomes and gateway deletion without changing deletion', async () => {
  const records = [];
  const log = console.log;
  const request = REST.prototype.request;
  const secret = 'private-editor-bearer-token';
  let calls = 0;
  const failure = Object.assign(new Error('private-request-url'), { code: 10008, status: 404 });
  REST.prototype.request = async function (options) {
    calls++;
    if (options.fail) throw failure;
    return 'unchanged-result';
  };
  console.log = line => {
    if (line.startsWith('[BUILDER_TRACE] {')) records.push(JSON.parse(line.slice(16)));
  };
  try {
    installBuilderSessionCleanup();
    const client = new EventEmitter();
    let deleted = 0;
    const message = { id: '1548046881257427006', client, embeds: [{ title: 'Message builder' }], delete: async () => { deleted++; } };
    const collector = new EventEmitter();
    collector.options = { time: 300000 };
    observeBuilderCollector(message, collector);
    await runWithBuilderSessionHold(secret, () => acquireCurrentBuilderSessionHold(message));
    collector.emit('end', [], 'time');
    assert.equal(await deleteBuilderSessionMessage(message), false);
    assert.equal(deleted, 0);
    const blocked = records.find(row => row.event === 'delete_blocked');
    assert.equal(blocked.messageId, message.id);
    assert.equal(blocked.holdActive, true);
    assert.deepEqual(blocked.holdIds, [traceHoldId(secret)]);
    assert.equal(blocked.collectorEndReason, 'time');
    traceEditorHold('test_unbound', 'unbound-session');
    assert.equal(records.at(-1).linkedMessageCount, 0);
    releaseBuilderSessionHold(secret);
    assert.equal(await deleteBuilderSessionMessage(message), true);
    assert.equal(deleted, 1);
    const rest = new REST();
    rememberBuilderWebhook({ token: secret }, message, '@original');
    assert.equal(await rest.delete(`/webhooks/123/${secret}/messages/@original`), 'unchanged-result');
    const success = records.find(row => row.event === 'delete_succeeded');
    assert.equal(success.messageId, message.id);
    assert.equal(success.route, 'REST.webhooks.delete');
    await assert.rejects(rest.request({ fullRoute: `/channels/123/messages/${message.id}`, method: 'DELETE', fail: true }), error => error === failure);
    assert.equal(records.at(-1).errorCode, 10008);
    await rest.post('/channels/123/messages/bulk-delete', { body: { messages: [message.id, '456'] } });
    assert.equal(calls, 3);
    assert.equal(records.at(-1).messageId, '456');
    client.emit('raw', { t: 'MESSAGE_DELETE', d: { id: message.id } });
    assert.equal(records.at(-1).event, 'gateway_delete');
    const serialized = JSON.stringify(records);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('private-request-url'));
    assert.ok(records.every(row => row.timestamp && row.bootId));
  } finally {
    console.log = log;
    REST.prototype.request = request;
  }
});
