# Contact panel and assistant button

Status: preparation only. Do not merge, deploy or run `--apply` until Dylano explicitly authorizes going live. This change is separate from cleanup draft PR #674. Vote footer work is deferred at the owner’s request and is excluded from this change.

## Agreed behavior

- The new shield **Contact the staff team** message retains its exact embed, message ID, title, description, fields, media, color and footer. Copy the old `create_ticket` control and FAQ link onto it; no third link button.
- FAQ retains the question-mark emoji and links to channel **1554538586001645679**.
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
