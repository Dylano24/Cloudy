# Cloudy Developer Map

This file is the fast-entry map for future Cloudy changes. Use it before searching the whole repository.

## Hard rules

- Preserve existing user-facing wording, embed layout, colors, logos, footer text and command behavior unless the requested task explicitly changes them.
- Prefer instant Discord acknowledgement. Defer/reply first; slow recovery, scans and refreshes should run in the background when safe.
- Never add a second slash-command registration path. Guild command sync has one source of truth.
- Economy writes must stay serialized per affected user. Do not bypass the economy command mutex.
- Embed Builder saves must update the saved template and keep live/dynamic values dynamic.
- Do not block normal bot startup on optional external services.

## Startup and slash commands

- `package.json` — process start scripts and quality commands.
- `src/bootstrap.js` — preflight validation and application bootstrap.
- `src/app.js` — main bot lifecycle, Discord login, web health endpoints and cron jobs.
- `src/handlers/loaders/commandLoader.js` — discovers commands, applies economy locking and gambling channel guards. Runtime slash registration is intentionally skipped here.
- `scripts/register-cloudy-guild-commands.js` — single source of truth for Discord guild command registration. It compares existing commands first and only performs a bulk PUT when the schema actually changed.

When a slash command option or choice changes, edit the command file first. The registration script will publish the changed schema on deploy.

## Interaction speed and reliability

- `src/utils/interactionHelper.js` — central reply/defer/edit/follow-up safety layer.
- `src/utils/responseCoordinator.js` — response coordination for interactions/prefix compatibility.
- `src/handlers/loaders/interactions.js` — loads buttons, select menus and modals and blocks duplicate handler names.
- `src/interactions/buttons/` — button handlers.
- `src/interactions/selectMenus/` — select-menu handlers.
- `src/interactions/modals/` — modal handlers.

Rule: avoid doing database/network scans before the first Discord acknowledgement.

## Embed Builder and saved embed styles

- `src/commands/Tools/embedbuilder.js` — Embed Builder command/UI and Save flow.
- `src/services/embedManagerService.js` — channel/message discovery, grouping and Builder manager views.
- `src/services/embedTemplateService.js` — saved template cache, template persistence, dynamic-value rendering and applying saved styles to runtime embeds.
- `src/services/embedDefinitionDiscoveryService.js` — discovers embed definitions.
- `src/services/embedRegistryService.js` — registry of Cloudy embed messages.
- `src/services/cloudyBrandingService.js` — Cloudy branding/footer behavior.
- `src/services/cloudyLogoService.js` — logo handling/migration.

Important: templates intentionally keep runtime values such as users, money, numbers, roulette colors and timestamps dynamic. Save-related UI refreshes should not delay the Save response.

## Gambling and economy

Command files live in `src/commands/Economy/`.

Main game files:

- `src/commands/Economy/roulette.js` — roulette command schema and roulette game result.
- `src/commands/Economy/blackjack.js` — blackjack.
- `src/commands/Economy/baccarat.js` — baccarat.
- `src/commands/Economy/modules/casinoGameUtils.js` — shared casino bet/settlement helpers.
- `src/commands/Economy/modules/rouletteNumberEmoji.js` — roulette number/color visual helpers.

Shared economy:

- `src/services/economyService.js` — higher-level economy operations.
- `src/utils/economy.js` — economy data access/helpers.
- `src/handlers/loaders/commandLoader.js` — serializes Economy commands with per-guild/per-user mutex keys.
- `src/utils/mutex.js` — in-process mutex implementation.

Do not replace the user locking with global locking; that would slow unrelated users down.

## Tickets

- `src/commands/Ticket/ticket.js` — `/ticket` setup/dashboard/health/debug entry point.
- `src/commands/Ticket/modules/ticket_dashboard.js` — dashboard fast path. It renders controls immediately and performs recovery in the background.
- `src/services/ticketDashboardViewService.js` — dashboard rendering.
- `src/services/ticketDashboardRecoveryService.js` — recovery logic.
- `src/services/ticketChannelBrowserService.js` — ticket channel discovery/refresh.
- `src/services/ticketDestinationAutoConfig.js` — destination/category recovery.
- `src/services/ticketPanelBuilder.js` — ticket panel payload.
- `src/services/ticketHealthService.js` — ticket diagnostics.
- `src/utils/ticket/` — ticket branding/utilities.

Keep the dashboard fast path: render first, recover second.

## Automod and moderation protection

- `src/services/automodProtectionService.js` — spam, raid and image-moderation protection.
- Moderation commands are under `src/commands/Moderation/`.
- Logging-related commands are under `src/commands/Logging/`.

External moderation requests must have bounded latency/failure handling so a slow external API cannot stall normal Discord event processing.

## Database

- `src/utils/database.js` — compatibility facade and shared database functions.
- `src/utils/database/` — split database implementation.
- `src/utils/postgresDatabase.js` — PostgreSQL implementation.
- `src/services/config/guildConfig.js` — guild configuration API.

Prefer PostgreSQL-native atomic operations for multi-account money movement when changing transaction code. In-process mutexes protect concurrency inside one bot process but cannot make two separate database writes crash-atomic.

## Quality and security

- `.github/workflows/quality-fast.yml` — cached ESLint + tests in parallel + high-level npm audit.
- `.github/workflows/codeql.yml` — CodeQL scanning.
- `.github/dependabot.yml` — dependency update automation.
- `eslint.config.js` — lint rules.

Useful commands:

- `npm run lint:fast`
- `npm test`
- `npm run check:fast`

## Fast workflow for future changes

1. Find the feature in this map.
2. Read the primary file and its direct service/helper imports only.
3. Preserve current UI/text unless the request explicitly changes it.
4. Make the smallest safe change.
5. Run lint/tests.
6. Check Railway build/runtime logs after deploy.
7. For slash-schema changes, confirm the command-sync reports COMPLETE or SKIPPED with the expected command count.
