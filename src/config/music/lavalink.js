import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

function parseNodesFromEnv() {
    const raw = process.env.LAVALINK_NODES?.trim();
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function parseNodesPayload(parsed) {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (Array.isArray(parsed?.nodes)) {
        return parsed.nodes;
    }
    return null;
}

// The default fallback list lives in lavalink/nodes.json. Include this source
// entry when updating that list: Railway deploys watch /src/**.
function loadNodesFromFile() {
    const nodesFile = process.env.LAVALINK_NODES_FILE?.trim()
        || path.join(projectRoot, 'lavalink', 'nodes.json');

    if (!existsSync(nodesFile)) {
        return null;
    }

    try {
        const parsed = JSON.parse(readFileSync(nodesFile, 'utf8'));
        return parseNodesPayload(parsed);
    } catch {
        return null;
    }
}

// Cloudy's own Lavalink server (owner's choice: a private music server in the
// Railway project, reached over the private network). It is used first; the public
// nodes stay as backup. Only when both its host and password are set.
export const PRIVATE_NODE_NAME = process.env.LAVALINK_PRIVATE_NAME?.trim() || 'Cloudy';

function privateNode() {
    const host = process.env.LAVALINK_PRIVATE_HOST?.trim();
    const password = process.env.LAVALINK_PRIVATE_PASSWORD;
    if (!host || !password) {
        return null;
    }
    return {
        host,
        port: Number(process.env.LAVALINK_PRIVATE_PORT || 2333),
        password,
        secure: parseBoolean(process.env.LAVALINK_PRIVATE_SECURE, false),
        name: PRIVATE_NODE_NAME,
    };
}

export function getLavalinkNodes() {
    const own = privateNode();
    const others = sharedNodes();
    return own ? [own, ...others.filter(node => node?.name !== own.name)] : others;
}

function sharedNodes() {
    const fromJson = parseNodesFromEnv();
    if (fromJson?.length) {
        return fromJson;
    }

    const fromFile = loadNodesFromFile();
    if (fromFile?.length) {
        return fromFile;
    }

    const host = process.env.LAVALINK_HOST || 'localhost';
    const port = Number(process.env.LAVALINK_PORT || 2333);
    const password = process.env.LAVALINK_PASSWORD || 'youshallnotpass';
    const secure = parseBoolean(process.env.LAVALINK_SECURE, false);

    return [{
        host,
        port,
        password,
        secure,
        name: process.env.LAVALINK_NAME || 'Main',
    }];
}

export const lavalinkConfig = {
    nodes: getLavalinkNodes(),
    defaultSearchPlatform: process.env.LAVALINK_SEARCH_PLATFORM || 'ytmsearch',
    restVersion: process.env.LAVALINK_REST_VERSION || 'v4',
};

export default lavalinkConfig;
