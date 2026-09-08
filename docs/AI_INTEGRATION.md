# Explicit Cloudy AI

This integration answers questions, scans one explicitly selected Discord channel, analyzes one explicitly selected source/config file, and prepares unapplied changes. It has no shell, executable tools, autonomous retrieval, web search, remote GitHub access, or runtime write capability. Changes must be reviewed, tested and applied through the repository's normal commit/PR process.

## Architecture and scope

Baseline: `6eb1956765ea1b9285ee4fd4eadd376728ffe93d` (`main`). The source inventory covers 418 existing JavaScript modules: startup/app, 141 command files, 13 configuration modules, 79 event handlers, 17 loaders/handlers, 30 interaction handlers, 78 services, 56 utilities and 2 web modules. The expanded 421-module tree was also syntax-parsed after integration.

`npm start` applies existing source patches, then `src/bootstrap.js` validates configuration, installs lifecycle/color policies and imports `app.js`. The app initializes PostgreSQL (with a memory fallback), Express, recursive command loading, independent event/interaction handlers, Discord, music and existing scheduled tasks. Slash registration is owned by `scripts/register-cloudy-guild-commands.js`; the command loader documents the existing 100-command limit. No new slash command or registration change is introduced.

The existing command families include moderation, tickets, economy/casino, leveling, welcome/verification, music, birthdays, giveaways, server counters, reaction roles, tools and community applications. Their handlers, storage, schedules and presentation are untouched. The existing Embed Builder, response catalogs, saved embed policy, ZORP Guide and permanent logs are not rewritten by this integration.

The existing AI entry points are reused:

- Fix Guide Ask button/modal → `ownerAssistantService` → shared explicit service.
- `!ai ...` in `#botlog-commands` → existing owner message handler → shared explicit service. Ordinary messages are ignored by AI.
- FAQ Ask form → `faqAiService` → shared explicit service.
- Shared service → deterministic parser/authorization → optional bounded read → tool-free provider → private response for sensitive operations.

The old model-selected Discord/embed/log/GitHub retrieval, implicit FAQ knowledge scan, OpenAI fallback path and startup AI probe have been removed. Startup panel discovery remains normal bot UI maintenance; it does not send any data to AI. Existing saved panels are retained without edits; duplicate Fix Guide panels are no longer automatically deleted. New AI modal hints describe explicit commands. Existing response embed styles, titles, buttons and reply lifetimes are preserved.

The only general message-handler changes suppress the content/argument logging of explicit `!ai` requests in the assistant channel. Other command handling and XP processing are unchanged.

## Usage and rights

Open the existing **Fix Guide → Ask** or **FAQ → Ask a question** form. Type `help` for syntax. The Fix Guide retains its existing Owner-role entry gate; sensitive reads additionally check stable IDs/current Discord permissions. FAQ access remains available to members with access to its channel.

| Input | Action | Authorization |
| --- | --- | --- |
| `What is a JavaScript promise?` or `ask QUESTION` | Answer only the supplied question; no context read | Existing form access |
| `scan CHANNEL_ID 20 \| Summarize the discussion` | Read only that channel's last 1–50 messages, including embed text | Current Administrator permission or `OWNER_IDS`, current membership and both user/bot View Channel + Read Message History |
| `history CHANNEL_ID 500 \| Find older relevant information` | Search up to 500 recent messages in one selected channel and send only bounded relevant evidence | Same current permissions as scan |
| `code \| Find the ticket timeout implementation` | Search the current deployed `src/**/*.js` tree for bounded relevant snippets | Current membership plus user ID in `OWNER_IDS` |
| `analyze src/config/bot.js \| Explain this configuration` | Read one allowed local file, up to 12 KB | Current guild membership plus user ID in `OWNER_IDS` |
| `prepare src/config/bot.js \| Describe a minimal proposed change` or `fix ...` | Produce a labelled, unapplied code suggestion and validation steps | Same bot-owner checks as analyze |
| `help` | Explain syntax and limitations; no provider request | Existing form access |

`!ai ask QUESTION` and `!ai help` work in `#botlog-commands` for its existing Owner-role users. Sensitive commands must use a private form; the public message route refuses them before reading data. A natural-language request such as “investigate all channels” is just a question: it cannot grant a retrieval scope. Put `ask` before text that begins with a reserved command word if it is only a question.

Source analysis permits `src/**/*.js`, `package.json` and `README.md`. It rejects traversal, absolute paths, backslashes/alternate streams, symlinks/junctions, secret-named files, missing files and oversized files. It does not read `.env`, logs, attachments, arbitrary URLs or remote repositories. The source shown is the local deployed checkout, potentially including the project's existing startup patches, not guaranteed current GitHub `main`. Each source result includes its path and SHA-256. The existing “Code files” footer counts local source reads.

Proposals are suggestions, not validated patches. `apply` and `execute` are intentionally unsupported. Arbitrary generated code cannot safely run inside a bot holding a Discord token and database credentials. Review the proposal against current GitHub HEAD, implement only the requested change on a branch, run tests, and deploy only an explicitly approved change. This integration does not create commits or deploy from Discord.

Identity questions use an application-owned answer without contacting a model: Cloudy identifies itself as an AI created, set up and managed by Dylano. Questions about model/provider/API keys/system prompts/hidden instructions receive the same privacy-safe identity answer. Provider/model identifiers and internal diagnostics are not included in user-visible replies.

## Provider selection and research (8 September 2026)

The supplied [api-key-free topic](https://github.com/topics/api-key-free) listed one repository, [Corporationakht/LocalCodeCli](https://github.com/Corporationakht/LocalCodeCli). Its README describes a local multi-provider proxy and remote CLI/chat-bot sessions. It still requires provider keys for hosted services. Its proxy and CLI execution stack are not needed for Cloudy's architecture, so no code or dependencies were copied. The relevant local-model technique is implemented directly through the official Ollama API.

| Option | Decision | Cost/key and constraints |
| --- | --- | --- |
| Local Ollama | Supported, default route | No API key for local inference. Hardware, memory, electricity and hosting are not free. Model must be installed separately; no automatic downloads. |
| Official Groq API | Supported only with explicit cloud opt-in | Own Groq key required. Free Plan is limited; quotas and model access are account-dependent. No promise of unlimited/free paid-account usage. |
| LocalCodeCli proxy / remote CLI sessions | Not incorporated | Extra runtime and execution surface with no benefit for this bounded Discord integration. No assertion that the upstream project is malicious. |
| Gemini Free Tier | Considered, not integrated | Own key required; free-tier data handling is unsuitable as a default for private Discord/source context. Adding another route is unnecessary here. |
| Unofficial scraping endpoints, shared/stolen keys, authenticated-session scraping | Excluded | No documented authorization/reliability basis; no scraping or authentication bypass implemented. |

Official references: [Ollama local authentication](https://docs.ollama.com/api/authentication), [chat API](https://docs.ollama.com/api/chat), [local-only cloud switch](https://docs.ollama.com/faq), [Ollama MIT license](https://github.com/ollama/ollama/blob/main/LICENSE), [Qwen3-4B Apache-2.0 model card](https://huggingface.co/Qwen/Qwen3-4B), [Groq production models](https://console.groq.com/docs/models), [Groq limits](https://console.groq.com/docs/rate-limits), [Groq data handling](https://console.groq.com/docs/your-data), [Groq policies](https://console.groq.com/docs/legal), [Gemini pricing/data-use table](https://ai.google.dev/gemini-api/docs/pricing).

Licenses and service terms still apply to the selected model/account. The integration uses official endpoints and owner-provided credentials; it does not claim that every possible downstream use is legally approved.

## Configuration

### Local, key-free

Install Ollama from its official distribution on the **same host/container network namespace as Cloudy**. Set `OLLAMA_NO_CLOUD=1` in the Ollama server environment and restart it. This setting is required for local-only operation; putting it only in the bot environment does not configure an independently running Ollama server. Keep Ollama bound to loopback.

After reviewing the model license, explicitly install a local model, for example `ollama pull qwen3:4b`. The example model download is about 2.5 GB; inference needs additional RAM and may need a GPU to meet the 45-second request timeout. Set:

```dotenv
CLOUDY_AI_PROVIDER=ollama
CLOUDY_AI_MODEL=qwen3:4b
CLOUDY_AI_ALLOW_CLOUD=false
```

The endpoint is fixed at `http://127.0.0.1:11434/api/chat`; there is no configurable URL or remote tunnel. Cloud model names are rejected. The bot never starts Ollama, downloads models, or probes it at startup. A separate Railway service or your laptop's Ollama is not reachable through the bot container's loopback; this release does not silently expose Ollama to solve that. Choose the explicit hosted option if the current bot host cannot run local inference.

### Official Groq Free Plan, key required

Review the account's data settings and quotas, create your own key, and configure the bot's secret environment:

```dotenv
CLOUDY_AI_PROVIDER=groq
CLOUDY_AI_ALLOW_CLOUD=true
CLOUDY_AI_MODEL=openai/gpt-oss-20b
GROQ_API_KEY=<your-own-secret-key>
```

Only `openai/gpt-oss-20b` and `openai/gpt-oss-120b` are allowed. Both are listed as production models. Groq's documented Free Plan table currently lists 30 requests/minute, 1,000/day, 8,000 tokens/minute and 200,000/day for these models; your account limits are authoritative and may change. No paid plan is enabled by this code. It cannot independently prove your account is on the free tier: review account billing/spend settings before enabling.

Cloud mode sends the question and only its explicitly selected/redacted evidence to Groq. There is no silent local-to-cloud fallback, no web tools, and no agentic Compound route. Existing `OPENAI_API_KEY`, `OPENAI_OWNER_ASSISTANT_MODEL` and `GROQ_FAQ_MODEL` values no longer select these assistants. Migration therefore requires explicitly choosing the new provider settings; the presence of an old key alone does not authorize cloud transmission.

Set `CLOUDY_AI_PROVIDER=disabled` to stop model requests. No new dependency, database migration, timer, cron job or production environment change is included in this PR.

## Safety limits and verification

- One explicit scope per request; no recursive/automatic retrieval, follow-up tools or shared conversation history.
- Fresh authorization before sensitive reads; no role-name or prompt-text privilege escalation. Threads and cross-guild scans are rejected. Sensitive results remain ephemeral.
- Per-user/server 20-second cooldown, 2 concurrent requests maximum, 10 requests/minute per bot process, bounded maps with expiry. Existing form cooldowns remain too. Multi-replica deployments multiply process-local limits; use a single replica or add a shared gate before scaling.
- Network timeout 45 seconds; no retries or provider fallback; HTTP 429 establishes a bounded 1-minute to 1-hour backoff using Retry-After. Requests outside provider quota fail cleanly.
- Source/evidence budget 12 KB, complete provider-message budget 24 KB UTF-8, response-body limit 96 KB, generation limit 1,200 tokens and visible answer bound. Long scans may include fewer than the requested messages; diagnostics report included evidence items.
- Prompt/evidence/output secret redaction is defense in depth, not a guarantee for arbitrary documents. Do not submit secrets. Model output is untrusted advice and can be incorrect. Prompt injection cannot invoke tools or writes because there are no execution capabilities, even if it affects answer quality.
- Mentions are disabled in AI outputs. Audit logs store IDs, action, outcome, provider and byte counts, never question/evidence/answer bodies. Pre-existing non-AI logs are outside this change.

Targeted command: `node --test test/ownerAssistantProvider.test.js test/ownerAssistantInteraction.test.js test/explicitAiService.test.js` — 29 tests passed on Node 24.19.0. Covers authentication, identity/privacy answers, broad source search, history scans, revoked permissions, cross-guild/denied-channel access, path traversal, junctions, size bounds, malicious evidence, tool-call refusal, provider failures, cloud opt-in, rate/concurrency budgets, secret redaction and private acknowledgement before provider calls.

Full suite was run in disposable copies because `npm test` executes source-rewriting patch scripts. Baseline: 154 tests, 144 pass, 10 fail. Integration: 171 tests, 161 pass, the **same 10 failures** in existing casino/embed/indent/catalog behavior. No additional failing test names. Lint has no errors (legacy warnings remain). Dependency audit: no high/critical vulnerabilities; one existing moderate transitive `qs` package finding. Lockfile/dependencies are unchanged.

Live model quality, actual Discord interaction delivery and Railway `ONLINE` have not been verified by these offline tests. Before merging/deploying, configure a provider, validate one ordinary question, verify a non-admin scan is refused and an authorized scan reads only its named test channel, then confirm existing bot/embeds remain intact. The PR does not assert production readiness while the baseline suite is red or the live smoke test is outstanding.
