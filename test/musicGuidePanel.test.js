import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { reconcileMusicGuideMessage } from '../src/services/music/musicGuidePanel.js';

const HOME = '1532882647838228723';
const BOT = '1534506224312389863';

function setup({ history = [], stored = null, allow = true, channelName = '🎧│music' } = {}) {
    const sent = [];
    const edits = [];
    const storage = new Map();
    if (stored) storage.set('cloudy:music:guide:' + HOME, stored);
    const messages = new Collection(history.map(message => [message.id, message]));
    for (const message of messages.values()) {
        message.edit = async payload => {
            edits.push(payload);
            message.embeds = payload.embeds;
            message.components = payload.components;
            return message;
        };
    }
    const channel = {
        id: 'music-channel',
        name: channelName,
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isThread: () => false,
        permissionsFor: () => ({ has: () => allow }),
        messages: {
            fetch: async selector => {
                if (typeof selector === 'string') {
                    if (!messages.has(selector)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
                    return messages.get(selector);
                }
                return messages;
            },
        },
        send: async payload => {
            sent.push(payload);
            const message = {
                id: 'new-guide-' + sent.length,
                author: { id: BOT },
                embeds: payload.embeds.map(embed => embed.toJSON()),
                components: payload.components?.map(row => row.toJSON?.() || row) || [],
                edit: async value => {
                    edits.push(value);
                    message.embeds = value.embeds;
                    message.components = value.components;
                    return message;
                },
            };
            messages.set(message.id, message);
            return message;
        },
    };
    const guild = {
        id: HOME,
        members: { me: { id: BOT } },
        channels: { cache: new Collection([[channel.id, channel]]) },
    };
    const client = {
        user: { id: BOT },
        config: { features: { music: true } },
        guilds: { cache: new Collection([[guild.id, guild]]) },
        db: {
            get: async key => storage.get(key) ?? null,
            set: async (key, value) => { storage.set(key, value); return true; },
        },
    };
    return { client, channel, storage, messages, sent, edits };
}

test('Cloudy posts one public music guide with slash command instructions, never duplicates it on restart', async () => {
    const ctx = setup();
    const first = await reconcileMusicGuideMessage(ctx.client, HOME);
    assert.deepEqual(first, { ok: true, action: 'posted', messageId: 'new-guide-1' });
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].embeds[0].toJSON().title, 'Cloudy music');
    assert.match(ctx.sent[0].embeds[0].toJSON().description, /Click the button below/);
    assert.equal(ctx.sent[0].components[0].toJSON().components[0].custom_id, 'dedicated_commands:music');
    assert.deepEqual(ctx.sent[0].allowedMentions, { parse: [] });

    const second = await reconcileMusicGuideMessage(ctx.client, HOME);
    assert.deepEqual(second, { ok: true, action: 'preserved', messageId: 'new-guide-1' });
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.edits.length, 0);
});

test('Cloudy reuses a previously posted music guide and preserves owner changes', async () => {
    const history = [{
        id: 'existing-1',
        author: { id: BOT },
        embeds: [{ title: 'Cloudy music', description: 'Custom owner wording' }],
    }];
    const ctx = setup({ history });
    const result = await reconcileMusicGuideMessage(ctx.client, HOME);
    assert.equal(result.action, 'updated');
    assert.equal(result.messageId, 'existing-1');
    assert.equal(ctx.sent.length, 0);
    assert.equal(ctx.edits.length, 1, 'only missing Commands button added to existing guide');
    assert.equal(ctx.edits[0].embeds[0].description, 'Custom owner wording');
    assert.equal(ctx.edits[0].components[0].components[0].custom_id, 'dedicated_commands:music');
    assert.equal(ctx.storage.get('cloudy:music:guide:' + HOME).messageId, 'existing-1');
});

test('an owner-deleted music guide is not silently recreated', async () => {
    const ctx = setup({ stored: { channelId: 'music-channel', messageId: 'deleted-1' } });
    const result = await reconcileMusicGuideMessage(ctx.client, HOME);
    assert.equal(result.reason, 'guide_deleted');
    assert.equal(ctx.sent.length, 0);
});

test('missing permissions, channel, music feature, or primary guild never trigger a guide post', async () => {
    const blocked = setup({ allow: false });
    assert.equal((await reconcileMusicGuideMessage(blocked.client, HOME)).reason, 'missing_permissions');
    assert.equal(blocked.sent.length, 0);

    const wrongChannel = setup({ channelName: 'general' });
    assert.equal((await reconcileMusicGuideMessage(wrongChannel.client, HOME)).reason, 'channel_missing');
    assert.equal(wrongChannel.sent.length, 0);

    const feature = setup();
    feature.client.config.features.music = false;
    assert.equal((await reconcileMusicGuideMessage(feature.client, HOME)).reason, 'music_disabled');

    const other = setup();
    assert.equal((await reconcileMusicGuideMessage(other.client, 'other-guild')).reason, 'guild_missing');
    assert.equal(other.sent.length, 0);
});

test('the guide will not post if Discord history cannot be verified', async () => {
    const ctx = setup();
    ctx.channel.messages.fetch = async () => { throw new Error('Discord temporary outage'); };
    await assert.rejects(reconcileMusicGuideMessage(ctx.client, HOME), /temporary outage/);
    assert.equal(ctx.sent.length, 0);
});

test('old public music instructions migrate in place without changing the message ID', async () => {
    const legacy = {
        id: 'old-guide',
        author: { id: BOT },
        embeds: [{
            title: 'Cloudy music',
            description: 'Your music. Your queue. Your experience.\n\n**Getting started**\nUse /play',
            color: 0xffffff,
        }],
        components: [],
    };
    const ctx = setup({
        history: [legacy],
        stored: { channelId: 'music-channel', messageId: 'old-guide' },
    });
    const updated = await reconcileMusicGuideMessage(ctx.client, HOME);
    assert.deepEqual(updated, { ok: true, action: 'updated', messageId: 'old-guide' });
    assert.equal(ctx.edits.length, 1);
    assert.equal(ctx.edits[0].embeds[0].title, 'Cloudy music');
    assert.match(ctx.edits[0].embeds[0].description, /Click the button below/);
    assert.equal(ctx.edits[0].components[0].components[0].custom_id, 'dedicated_commands:music');
    assert.equal(ctx.sent.length, 0, 'migration must not send a duplicate');
    const again = await reconcileMusicGuideMessage(ctx.client, HOME);
    assert.equal(again.action, 'preserved');
    assert.equal(ctx.edits.length, 1);
});

test('a customized existing music guide keeps its wording when the button already exists', async () => {
    const custom = {
        id: 'custom-guide',
        author: { id: BOT },
        embeds: [{ title: 'Cloudy music', description: 'Owner-specific instructions.' }],
        components: [{
            type: 1,
            components: [{ type: 2, style: 2, label: 'Commands', custom_id: 'dedicated_commands:music' }],
        }],
    };
    const ctx = setup({
        history: [custom],
        stored: { channelId: 'music-channel', messageId: 'custom-guide' },
    });
    assert.equal((await reconcileMusicGuideMessage(ctx.client, HOME)).action, 'preserved');
    assert.equal(ctx.edits.length, 0);
    assert.equal(ctx.sent.length, 0);
});
