import test from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/utils/database.js';
import {
    getEmbedRegistry,
    registerCloudyEmbedMessage,
} from '../src/services/embedRegistryService.js';

function installTestStorage() {
    const values = new Map();
    db.initialized = true;
    db.useFallback = false;
    db.connectionType = 'test';
    db.db = {
        get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
        set: async (key, value) => {
            values.set(key, structuredClone(value));
            return true;
        },
        delete: async key => values.delete(key),
        list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
    };
}

function textChannel(id, name, position) {
    return {
        id,
        name,
        type: 0,
        position,
        rawPosition: position,
        parent: null,
        isTextBased: () => true,
        messages: { fetch: async () => null },
    };
}

function catalogMessage({ guild, id, embed }) {
    return {
        id,
        guildId: guild.id,
        channelId: '299999999999999998',
        guild,
        content: 'System & error embed templates',
        embeds: [embed],
        createdAt: new Date('2026-09-02T13:40:00.000Z'),
        flags: { has: () => false },
    };
}

test('change panel message stays with ticket panel and never ticket logs', async () => {
    installTestStorage();

    const ticketPanel = textChannel('200000000000000211', 'ticket-panel', 1);
    const ticketLogs = textChannel('200000000000000212', 'ticket-logs', 2);
    const catalog = textChannel('299999999999999998', 'system-embed-catalog', 3);
    const guild = {
        id: '100000000000000211',
        channels: {
            cache: new Map([
                [ticketPanel.id, ticketPanel],
                [ticketLogs.id, ticketLogs],
                [catalog.id, catalog],
            ]),
        },
    };

    const panelEmbed = {
        title: 'Change panel message',
        description: 'Change the ticket panel message.',
        author: {
            name: 'Cloudy template key: tickets:panel-message || Cloudy context: tickets/panel || Cloudy kind: embed',
        },
    };

    await registerCloudyEmbedMessage(catalogMessage({
        guild,
        id: '300000000000000211',
        embed: panelEmbed,
    }));

    const records = await getEmbedRegistry(guild.id);
    const panelRecord = records.find(record => record.messageId === '300000000000000211');

    assert.equal(panelRecord?.channelId, ticketPanel.id);
    assert.notEqual(panelRecord?.channelId, ticketLogs.id);
});
