# Cloudy background worker preparation

## Safety boundaries

This is an **opt-in infrastructure foundation**; it does not make the existing Discord bot 10× faster by itself.
Cloudy stays at **one Discord Gateway replica**. No user-facing embeds, controls, tickets, report sanctions, gambling, economy, or other critical tasks are moved.

The standalone process can only aggregate **anonymous latency diagnostics**. The queue is bounded to 1,000 records, discards its oldest metrics under overload, and is **best effort**. The Redis server saves snapshots periodically; a popped event can be lost on worker failure. NEVER use this queue for money, permissions, report outcomes, moderation, tickets, deletions, or anything requiring durable delivery.

Cloudy Monitor already exists and remains unchanged. Cloudy Redis cache and PostgreSQL are existing live services and remain untouched by this branch.

## Deployment preparation (do not activate without approval)

After review and successful tests, add a **separate Railway service** in the existing Cloudy project from this repository and deploy to the existing European region. This is a **new billable Railway service**.

- Source: `Dylano24/Cloudy` with the approved commit, working directory at repository root
- Start command: `npm run worker:start`, Node.js 24, one replica
- Set `CLOUDY_WORKER_ENABLED=1` **on the worker only**
- Set `REDIS_URL` by referencing the existing Redis service's **private** connection variable
- Health: `/ready` on `PORT` (default 8080); do not add a public domain
- Do **not** copy `DISCORD_TOKEN`, `CLIENT_ID`, PostgreSQL credentials, Cloudy profile variables, or other bot secrets to the worker
- Make sure it starts independently and Redis health reaches ready before producing events

Only **after** the new worker is proven healthy, opt in the existing Cloudy bot to `CLOUDY_LATENCY_WORKER_EXPORT=1` and redeploy its existing service. With that flag off or unset, Cloudy makes **zero additional Redis telemetry calls**.

No worker service has been created and no environment variables have been changed by this preparation.

## Rollback

1. Remove `CLOUDY_LATENCY_WORKER_EXPORT` from Cloudy or set it to `0`; deploy the change.
2. Stop/disable the separate Worker. The original bot continues unchanged.
3. The optional Redis telemetry queue and hourly 48-hour counters may expire/evict; there is no business data in them.

Do not scale Cloudy's Discord Gateway to multiple replicas without deliberate shard ownership, global idempotency, distributed locks and rollout tests. A Railway replica count increase by itself can duplicate Gateway events, schedules, report actions and other Discord side effects.

## Evaluation

Capture baseline p50, p95 and p99 user-visible acknowledgement and completion times for each command category, concurrency level, Discord 429s, database pool acquisition, and Worker backlog, before and after an approved rollout. Current Railway CPU/RAM utilization is low, so increasing replica count or resources alone is not evidence of improvement.

The proposed Worker only supports telemetry; moving real background jobs is a **separate design/review step** requiring per-task idempotency, durable queue semantics, permissions analysis and extensive regression tests.
