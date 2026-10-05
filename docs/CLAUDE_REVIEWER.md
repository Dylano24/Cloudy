# Explicit external Claude reviewer

Cloudy is a Node ESM Discord bot deployed from Dylano24/Cloudy main to Railway
project sweet-kindness, service Cloudy, production. Its existing assistant uses
explicitAiProvider (Ollama/Groq); OpenAI moderation is a separate existing path.
There is no Vercel AI SDK/Gateway integration. The reviewer uses the official
Anthropic Messages API with built-in fetch, adding no dependencies.

ChatGPT remains the primary development agent. This module does not select or
change the model of the ChatGPT session. Existing Discord AI routing is unchanged.
No startup call, Discord command, HTTP endpoint, database change or autonomous
review loop is introduced. A trusted operator/primary agent explicitly calls
reviewWithClaude({ question, evidence }) or runs the stdin command below.
Validate the advice before applying anything; Claude has no tools or write access.

## Configuration

Set these on Railway Cloudy / production, using its Variables tab:

```dotenv
CLOUDY_REVIEW_PROVIDER=anthropic
CLOUDY_REVIEW_MODEL=claude-sonnet-5
ANTHROPIC_API_KEY=<set as a secret; never commit>
```

The key is absent from the inspected production variable names on 5 October 2026.
Do not replace GROQ_API_KEY, OPENAI_API_KEY or CLOUDY_AI_* settings.
The route defaults to disabled unless CLOUDY_REVIEW_PROVIDER is anthropic.
Set it to disabled to stop reviews. No fallback to another model/provider exists.
Only claude-sonnet-5 is accepted; access is subject to the Anthropic account.
API usage is billed separately from a ChatGPT subscription.

For local use, supply the same environment variables through your secret manager.
The script does not load .env automatically. Pipe a JSON object to:

```text
node scripts/review-with-claude.js
```

Input example: {"question":"Review this proposed fix","evidence":"<selected code or diff>"}
Output: JSON containing text, provider, model and applied:false.
On Railway, a trusted operator can run the same command inside the service with
its environment. There is deliberately no publicly reachable review endpoint.

Only explicitly supplied material is sent. Existing secret redaction is reused;
do not include secrets. Limits: 24 KB redacted input, 32 KB stdin, 96 KB response,
1,200 output tokens, 45 seconds, one concurrent call per reviewer instance,
429 cooldown of 1 minute to 1 hour, no retries/redirects/tools. Truncated responses
fail rather than being accepted as complete reviews. No content/key logging.

Official references: [Sonnet 5 model ID](https://platform.claude.com/docs/en/models/sonnet-5/overview),
[Messages API](https://platform.claude.com/docs/en/api/messages).
