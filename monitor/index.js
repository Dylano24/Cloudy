import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);
const POLL_MS = 60_000;
const CLOUDY_BASE = process.env.CLOUDY_BASE_URL || 'https://cloudy-production-b24f.up.railway.app';
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'cloudy-monitor-state.json');
const MAX_INCIDENTS = 100;
const FETCH_TIMEOUT_MS = 12_000;

const urls = {
  health: `${CLOUDY_BASE}/health`,
  ready: `${CLOUDY_BASE}/ready`,
  commits: 'https://github.com/Dylano24/Cloudy/commits/main.atom',
  quality: 'https://github.com/Dylano24/Cloudy/actions/workflows/quality-fast.yml/badge.svg?branch=main',
  migration: 'https://github.com/Dylano24/Cloudy/actions/workflows/migration-version-check.yml/badge.svg?branch=main',
  docker: 'https://github.com/Dylano24/Cloudy/actions/workflows/docker-publish.yml/badge.svg?branch=main',
};

let state = {
  startedAt: new Date().toISOString(),
  lastCheckAt: null,
  lastHealthyAt: null,
  overall: 'unknown',
  checks: {},
  latestRailwayEvent: null,
  incidents: [],
};

function nowIso() {
  return new Date().toISOString();
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
}

async function loadState() {
  try {
    const loaded = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state = {
        ...state,
        ...loaded,
        startedAt: state.startedAt,
        incidents: Array.isArray(loaded.incidents) ? loaded.incidents.slice(0, MAX_INCIDENTS) : [],
      };
    }
  } catch {
    // First boot or missing volume state is normal.
  }
}

async function saveState() {
  await ensureDataDir();
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Cloudy-Monitor/1.0',
        'cache-control': 'no-cache',
      },
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const result = await fetchText(url);
  let body = null;
  try { body = JSON.parse(result.text); } catch {}
  return { ...result, body };
}

function workflowStatus(svgText) {
  const lower = String(svgText || '').toLowerCase();
  if (/passing|success|successful/.test(lower)) return 'success';
  if (/failing|failure|failed/.test(lower)) return 'failure';
  if (/no status|unknown|inaccessible/.test(lower)) return 'unknown';
  return 'unknown';
}

function parseHeadSha(atomText) {
  const ids = [...String(atomText || '').matchAll(/Grit::Commit\/Dylano24\/Cloudy\/([0-9a-f]{40})/gi)];
  if (ids.length) return ids[0][1];
  const href = String(atomText || '').match(/\/commit\/([0-9a-f]{40})/i);
  return href?.[1] || null;
}

function severityFor(checks) {
  if (checks.health?.ok === false || checks.ready?.ok === false) return 'critical';
  if (checks.quality?.status === 'failure') return 'high';
  if (checks.migration?.status === 'failure' || checks.docker?.status === 'failure') return 'high';
  return 'info';
}

function overallFor(checks) {
  if (checks.health?.ok === false || checks.ready?.ok === false) return 'unhealthy';
  if ([checks.quality?.status, checks.migration?.status, checks.docker?.status].includes('failure')) return 'degraded';
  if (checks.health?.ok && checks.ready?.ok) return 'healthy';
  return 'unknown';
}

function incidentFingerprint(source, summary, evidence = {}) {
  const raw = JSON.stringify({
    source,
    summary,
    sha: evidence.githubHead || null,
    deploymentId: evidence.deploymentId || null,
    eventType: evidence.eventType || null,
    failedChecks: evidence.failedChecks || [],
  });
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20);
}

async function recordIncident({ source, severity, summary, evidence = {}, likelyCause, impact, nextInvestigation }) {
  const fingerprint = incidentFingerprint(source, summary, evidence);
  if (state.incidents.some(item => item.fingerprint === fingerprint && item.status === 'open')) {
    return state.incidents.find(item => item.fingerprint === fingerprint && item.status === 'open');
  }

  const incident = {
    id: `cloudy-${Date.now()}-${fingerprint.slice(0, 6)}`,
    fingerprint,
    status: 'open',
    detectedAt: nowIso(),
    severity,
    source,
    summary,
    githubHead: evidence.githubHead || state.checks.github?.headSha || null,
    deploymentId: evidence.deploymentId || null,
    eventType: evidence.eventType || null,
    failedChecks: evidence.failedChecks || [],
    cloudyHealth: state.checks.health || null,
    cloudyReady: state.checks.ready || null,
    githubChecks: {
      fastQuality: state.checks.quality?.status || 'unknown',
      migration: state.checks.migration?.status || 'unknown',
      dockerPublish: state.checks.docker?.status || 'unknown',
    },
    railwayEvent: evidence.railwayEvent || state.latestRailwayEvent || null,
    likelyCause: likelyCause || 'Needs root-cause investigation from current logs/code; monitor does not guess beyond observed evidence.',
    impact: impact || 'Unknown until the affected path is reproduced or traced.',
    nextInvestigation: nextInvestigation || [
      'Read the exact GitHub commit diff for the reported SHA.',
      'Read Railway deployment/runtime logs around detectedAt.',
      'Reproduce the failing command/event without changing production.',
      'Trace the failure to the first bad boundary before proposing a fix.',
    ],
    doNotChange: [
      'Do not alter working Cloudy functionality just because the monitor detected an incident.',
      'Do not overwrite manually saved Embed Builder content.',
      'Do not treat a successful Railway deploy as proof that CI is green.',
    ],
  };

  state.incidents.unshift(incident);
  state.incidents = state.incidents.slice(0, MAX_INCIDENTS);
  await saveState().catch(() => {});
  return incident;
}

function closeRecoveredIncidents(source) {
  let changed = false;
  for (const incident of state.incidents) {
    if (incident.status === 'open' && incident.source === source) {
      incident.status = 'recovered';
      incident.recoveredAt = nowIso();
      changed = true;
    }
  }
  return changed;
}

async function runPoll() {
  const previousOverall = state.overall;
  const previousChecks = state.checks;

  const [health, ready, commits, quality, migration, docker] = await Promise.allSettled([
    fetchJson(urls.health),
    fetchJson(urls.ready),
    fetchText(urls.commits),
    fetchText(urls.quality),
    fetchText(urls.migration),
    fetchText(urls.docker),
  ]);

  const checks = {
    health: health.status === 'fulfilled'
      ? { ok: health.value.ok && health.value.body?.status === 'healthy', httpStatus: health.value.status, body: health.value.body }
      : { ok: false, error: String(health.reason?.message || health.reason) },
    ready: ready.status === 'fulfilled'
      ? { ok: ready.value.ok && ready.value.body?.ready === true, httpStatus: ready.value.status, body: ready.value.body }
      : { ok: false, error: String(ready.reason?.message || ready.reason) },
    github: commits.status === 'fulfilled'
      ? { ok: commits.value.ok, headSha: parseHeadSha(commits.value.text), httpStatus: commits.value.status }
      : { ok: false, headSha: null, error: String(commits.reason?.message || commits.reason) },
    quality: quality.status === 'fulfilled'
      ? { ok: quality.value.ok, status: workflowStatus(quality.value.text), httpStatus: quality.value.status }
      : { ok: false, status: 'unknown', error: String(quality.reason?.message || quality.reason) },
    migration: migration.status === 'fulfilled'
      ? { ok: migration.value.ok, status: workflowStatus(migration.value.text), httpStatus: migration.value.status }
      : { ok: false, status: 'unknown', error: String(migration.reason?.message || migration.reason) },
    docker: docker.status === 'fulfilled'
      ? { ok: docker.value.ok, status: workflowStatus(docker.value.text), httpStatus: docker.value.status }
      : { ok: false, status: 'unknown', error: String(docker.reason?.message || docker.reason) },
  };

  state.checks = checks;
  state.lastCheckAt = nowIso();
  state.overall = overallFor(checks);
  if (state.overall === 'healthy') state.lastHealthyAt = state.lastCheckAt;

  const failedChecks = [];
  if (!checks.health.ok) failedChecks.push('cloudy.health');
  if (!checks.ready.ok) failedChecks.push('cloudy.ready');
  if (checks.quality.status === 'failure') failedChecks.push('github.fast-quality');
  if (checks.migration.status === 'failure') failedChecks.push('github.migration-version');
  if (checks.docker.status === 'failure') failedChecks.push('github.docker-publish');

  if (failedChecks.length) {
    await recordIncident({
      source: 'poller',
      severity: severityFor(checks),
      summary: `Cloudy monitor detected failing checks: ${failedChecks.join(', ')}`,
      evidence: { githubHead: checks.github.headSha, failedChecks },
      likelyCause: checks.health.ok && checks.ready.ok
        ? 'Runtime is reachable; the failure is currently in one or more release/CI checks rather than basic availability.'
        : 'Cloudy health/readiness is failing or unreachable; inspect Railway runtime/deployment logs first.',
      impact: !checks.health.ok || !checks.ready.ok
        ? 'Cloudy may be unavailable or not production-ready.'
        : 'Cloudy is reachable, but the deployed/main revision is not fully validated by all monitored release checks.',
    });
  } else if (previousOverall !== 'healthy' && state.overall === 'healthy') {
    closeRecoveredIncidents('poller');
  }

  const headChanged = previousChecks?.github?.headSha && checks.github.headSha
    && previousChecks.github.headSha !== checks.github.headSha;
  if (headChanged && checks.quality.status === 'failure') {
    await recordIncident({
      source: 'github',
      severity: 'high',
      summary: 'New Cloudy main commit detected while Fast Quality Check is failing.',
      evidence: { githubHead: checks.github.headSha, failedChecks: ['github.fast-quality'] },
      impact: 'A new revision exists on main without a green Fast Quality release gate.',
    });
  }

  await saveState().catch(() => {});
}

function railwayEventType(body) {
  return body?.type || body?.event || body?.eventType || body?.action || 'unknown';
}

async function handleRailwayWebhook(body) {
  const eventType = railwayEventType(body);
  const deploymentId = body?.deployment?.id || body?.deploymentId || body?.data?.deployment?.id || null;
  const commitHash = body?.deployment?.meta?.commitHash || body?.meta?.commitHash || body?.data?.deployment?.meta?.commitHash || null;

  state.latestRailwayEvent = {
    receivedAt: nowIso(),
    eventType,
    deploymentId,
    commitHash,
    serviceId: body?.service?.id || body?.serviceId || body?.data?.service?.id || null,
    environmentId: body?.environment?.id || body?.environmentId || body?.data?.environment?.id || null,
  };

  const lower = String(eventType).toLowerCase();
  const isFailure = /failed|crashed|oom|out.?of.?memory|monitor\.triggered/.test(lower);
  if (isFailure) {
    await recordIncident({
      source: 'railway-webhook',
      severity: /oom|crash/.test(lower) ? 'critical' : 'high',
      summary: `Railway reported ${eventType} for Cloudy infrastructure.`,
      evidence: {
        githubHead: commitHash || state.checks.github?.headSha,
        deploymentId,
        eventType,
        railwayEvent: state.latestRailwayEvent,
      },
      likelyCause: 'Railway reported a deployment/runtime infrastructure failure. Exact cause requires the matching deployment logs.',
      impact: /crash|oom/.test(lower)
        ? 'The affected deployment may be unavailable or unstable.'
        : 'The affected deployment did not complete cleanly.',
    });
  }

  await saveState().catch(() => {});
}

function handoffPayload() {
  return {
    title: 'CLOUDY CHAT HANDOFF',
    generatedAt: nowIso(),
    monitor: {
      intervalSeconds: 60,
      overall: state.overall,
      lastCheckAt: state.lastCheckAt,
      lastHealthyAt: state.lastHealthyAt,
    },
    current: {
      githubHead: state.checks.github?.headSha || null,
      health: state.checks.health || null,
      ready: state.checks.ready || null,
      fastQuality: state.checks.quality?.status || 'unknown',
      migrationVersion: state.checks.migration?.status || 'unknown',
      dockerPublish: state.checks.docker?.status || 'unknown',
      latestRailwayEvent: state.latestRailwayEvent,
    },
    latestIncident: state.incidents[0] || null,
    instructionForNextChat: [
      'Use current GitHub main, Railway production, AGENTS.md and Linear DYL-6 as source of truth.',
      'If latestIncident is open, investigate its exact commit/deployment and logs before changing code.',
      'Do not claim Cloudy is fully healthy unless runtime AND relevant CI are green.',
    ],
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256_000) throw new Error('payload_too_large');
  }
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'healthy', monitor: 'cloudy-monitor', lastCheckAt: state.lastCheckAt });
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    return sendJson(res, 200, state);
  }

  if (req.method === 'GET' && url.pathname === '/incidents') {
    return sendJson(res, 200, { incidents: state.incidents });
  }

  if (req.method === 'GET' && url.pathname === '/handoff') {
    return sendJson(res, 200, handoffPayload());
  }

  if (req.method === 'POST' && url.pathname === '/railway-webhook') {
    try {
      const body = await readBody(req);
      await handleRailwayWebhook(body);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message || error) });
    }
  }

  return sendJson(res, 404, {
    error: 'not_found',
    endpoints: ['/health', '/status', '/incidents', '/handoff', '/railway-webhook'],
  });
});

await ensureDataDir();
await loadState();
await runPoll().catch(async error => {
  await recordIncident({
    source: 'monitor',
    severity: 'high',
    summary: 'Cloudy monitor failed its own initial poll.',
    evidence: {},
    likelyCause: String(error?.message || error),
    impact: 'Monitoring coverage is degraded until the next successful poll.',
  }).catch(() => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Cloudy Monitor listening on 0.0.0.0:${PORT}; polling every 60 seconds.`);
});

setInterval(() => {
  runPoll().catch(async error => {
    await recordIncident({
      source: 'monitor',
      severity: 'high',
      summary: 'Cloudy monitor poll failed.',
      evidence: {},
      likelyCause: String(error?.message || error),
      impact: 'Monitoring coverage is degraded for this interval.',
    }).catch(() => {});
  });
}, POLL_MS);
