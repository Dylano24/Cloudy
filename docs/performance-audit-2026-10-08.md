# Cloudy performance review, 8 October 2026

Base: `06ca5ef26303b2cef22bdce3482d9b340af6ac2e`.

## Scope and evidence

The existing read-only latency inventory scanned 658 JavaScript files across
source, scripts and tests (109,567 lines at baseline). An AST pass parsed all
474 source files and inventoried 5,823 function expressions/declarations and
4,448 await expressions, with no syntax errors. This is an automated full-source
screen followed by targeted code review, not an end-to-end execution of every
Discord function or proof that every possible bottleneck is resolved.

Reviewed the shared PostgreSQL read/list paths, guild configuration caching,
Redis connection handling, event dispatch, economy/leveling leaderboards,
report Read handling, ticket creation and catalog initialization. Existing
single-flight configuration reads, cache refresh after successful writes,
parallel report prerequisites and startup catalog reuse remain intact.

## Change

`PostgreSQLDatabase.list` previously awaited every independent temporary,
cache and structured-table query serially. Execute these same SELECTs in
batches of at most four per list. Merge results in the original query order.
Keep the singleton existence checks, SQL parameters, expiry predicates,
canonicalization, deduplication and error fallback unchanged.

No command text, embed, permission decision, write path, timer, pool size,
Railway resource setting or dependency changes. No persistent data migration.
No additional queries on successful calls and no additional hosted services.
Concurrent list calls still share the existing PostgreSQL pool; four is a
per-list bound, not a global request limit. A failed batch can have other
read-only SELECTs already in flight; their rejections are observed.

## Controlled latency comparison

Ten calls per case, using the actual old/new list implementation with a fake
pool imposing 10 ms per query and empty results. Singleton checks are stubbed
identically. This isolates network-wait scheduling; it is not a live Railway
benchmark or a promise about complete Discord response times.

| List | Before, mean | After, mean | Queries per call |
| --- | ---: | ---: | ---: |
| Reaction roles | 46.1 ms | 14.7 ms | 3 before and after |
| Broad guild list | 173.6 ms | 49.1 ms | 13 before and after |

Regression tests cover overlapping reads, out-of-order completion, unchanged
canonical results and ordering, a maximum of four active reads on a broad
list, structured/singleton entries, read failures and unavailable storage.

## Limits and remaining candidates

Leaderboard code still loads per-user records. Converting it to bulk SQL
requires separately testing membership filtering, legacy storage, ties and
fallback behavior. It is not silently changed in this patch. Discord API
calls and permission updates remain subject to upstream latency/rate limits.
Earlier report latency logs do not establish that the latest deployment has
the same cause. Real production improvement requires measurement after an
explicitly approved deployment. No guarantee of unlimited load or sub-second
responses is made.
