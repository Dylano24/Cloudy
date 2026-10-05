import { reviewWithClaude } from '../src/services/claudeReviewer.js';

// A trusted local operator supplies JSON on stdin; no automatic source retrieval.
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32_000) throw new Error('context_too_large');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = await reviewWithClaude(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Never print raw provider errors, request contents or credentials.
  process.stderr.write(`Claude review failed: ${error?.code || 'invalid_request'}\n`);
  process.exitCode = 1;
}
