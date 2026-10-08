# Ticket reliability and performance evidence

Updated 8 October 2026. The previous document's 10× speedup and latency estimates were not backed by measurements and have been removed.

Ticket discovery uses stored message IDs and bounded recent/pinned-message lookups where available. Transcript generation intentionally reads the full history to preserve complete transcripts; it can consume substantial memory for large tickets.

The current audit fixes overlapping delete actions so one ticket deletion is scheduled once, and legacy feedback uses the shared serialized mutation path. A failed feedback write no longer reports that a rating was saved. Ticket layouts, logs, manually saved content and the 10-second deletion delay remain unchanged.

Behavioral regressions are in `test/ticketDeleteConcurrency.test.js` and `test/commercialLegacyFeedback.test.js`. Existing ticket latency, lifecycle, status, transcript and template tests are retained in the full suite. These tests do not establish live Discord response times or a numeric speedup.

See [the repository audit](CODE_QUALITY_AUDIT.md) for complete verification and remaining operational limits.
