import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { confirmBuilderPostedMessage } from '../src/commands/Tools/embedbuilder.js';

test('successful Post edits the original ephemeral picker rather than deleting its reference', async () => {
    let editCount = 0;
    let followUps = 0;
    let deletions = 0;
    const interaction = {
        async editReply(payload) {
            editCount++;
            assert.equal(payload.components.length, 0);
            return payload;
        },
        async followUp() { followUps++; },
        webhook: { async deleteMessage() { deletions++; } },
    };
    const result = await confirmBuilderPostedMessage(interaction, {
        embeds: [{ title: 'Message sent' }], components: [],
    });
    assert.equal(result, true);
    assert.equal(editCount, 1);
    assert.equal(followUps, 0);
    assert.equal(deletions, 0);
});

test('a failed in-place update falls back to private followup without deleting its original', async () => {
    let deletions = 0;
    const responses = [];
    const interaction = {
        async editReply() { throw new Error('Transient interaction edit failure'); },
        async followUp(payload) { responses.push(payload); },
        webhook: { async deleteMessage() { deletions++; } },
    };
    const ok = await confirmBuilderPostedMessage(interaction, {
        embeds: [{ title: 'Message sent' }], components: [],
    });
    assert.equal(ok, false);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].flags, MessageFlags.Ephemeral);
    assert.equal(deletions, 0);
});
