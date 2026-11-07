# Contact panel and assistant button

Status: PR #675 was deployed and the original shield controls were transferred. This follow-up fixes a stale cross-process ticket panel ID check and changes the existing FAQ link label/icon to **Support assistant** with Cloudy's white bot emoji. Do not merge, deploy or run the updated `--apply` until Dylano explicitly authorizes going live. Vote footer work remains excluded.

## Agreed behavior

- The new shield **Contact the staff team** message retains its exact embed, message ID, title, description, fields, media, color and footer. Keep `Start chat` (`create_ticket`) and a second **Support assistant** link button; no third button.
- **Support assistant** uses the existing application emoji `cloudy_support_bot_white` and links to channel **1554538586001645679**. Other assistant panel controls and the old ticket panel are not touched.
- The white bot emoji belongs only on **Ask a question** in Support assistant. Its `faq_ai_question` action, modal, AI provider, permissions and cooldown remain unchanged. The existing assistant channel/state ID **1534654577385672917** remains separate from FAQ.

## Prepared implementation

`transferTicketPanelControls` updates only the selected target's components, registers the same live embed/controls for Builder, and updates only panel configuration fields. Ticket staff/category/limits and the old message are retained. Failed configuration writes trigger a controls rollback. Repeating a successful transfer is a no-op. Automatic ticket presentation respects the existing preserve-embeds policy, so attaching controls cannot replace the shield embed with an old template.

Assistant reconciliation changes only components of an existing assistant panel and records the controls for later Builder saves. The original white robot pictogram is prepared in `assets/support-bot-white.svg` / `.png`; application emoji preparation creates it once and reuses it. An unsuccessful button edit does not post a replacement panel.

## Exact-message maintenance, after live authorization

Obtain actual Discord message links for both the old ticket panel and new shield panel. They must be distinct messages by Cloudy in the same guild/channel. Screenshots and channel IDs cannot establish these message IDs. The currently connected Discord integration cannot access the Cloudy guild; no live message has been changed by this work.

Using Cloudy's authorized credentials and PostgreSQL environment, first preview:

```sh
node scripts/transfer-ticket-panel.js --source-url "$OLD_PANEL_URL" --target-url "$SHIELD_PANEL_URL"
```

Review the exact IDs and controls, then run the same command with `--apply` only after authorization. Preview does not initialize PostgreSQL or write Discord/config/registry state. The standalone client does not load bot events or register commands. Avoid simultaneous Builder edits while applying: its mutation lock cannot coordinate separate processes.

After deployment and explicit maintenance, verify on Discord desktop and phone: Start chat opens the existing ticket flow; FAQ opens the supplied channel; Ask a question opens its existing modal with the white bot icon; Builder Save retains both panels' controls. These live-client checks remain pending until authorized deployment. API timeouts or rollback errors require reading the exact target again before retrying.


## Follow-up for the November 7 outdated-panel warning

The original transfer updated persistent guild configuration in a separate short-lived process, while the bot maintained a five-minute local configuration cache. Immediately clicking the newly transferred `Start chat` button could therefore incorrectly show "This ticket panel is outdated" even though the new message ID was saved. The create-ticket handler now confirms any panel-ID mismatch against a fresh persistent read, with a bounded timeout. Genuinely old panels remain rejected and any failed verification fails closed rather than silently bypassing the guard.

The updated maintenance CLI fetches the existing application emoji for previews and ensures it exists before an authorized apply. Re-running the exact-message transfer upgrades **only** the known two-button legacy `Start chat + FAQ` layout on the chosen shield message; it rejects unrelated target controls. It edits only button components and preserves the embed and the old message. Do not run `--apply` until authorized.
