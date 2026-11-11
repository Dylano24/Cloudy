# Creator notifications

Cloudy checks configured accounts every five minutes and posts a direct content link to the platform's existing Discord channel. Monitoring is opt-in: nothing is announced until a server moderator adds a creator.

## Discord commands (Manage Server permission)

- `/creator-notify add platform:YouTube creator:UC123...` — YouTube requires its 24-character channel ID beginning `UC` (not its @handle).
- `/creator-notify add platform:Twitch creator:streamername` — Twitch live broadcasts and new videos/VODs.
- `/creator-notify add platform:TikTok creator:username` — new videos via a trusted RSS bridge.
- `/creator-notify add platform:YouTube creator:UC123... channel:#announcements` — optional channel override.
- `/creator-notify list` — saved creators and provider readiness.
- `/creator-notify remove platform:YouTube creator:UC123...` — stop notifications.

When no channel is supplied, Cloudy resolves the server's existing `#youtube`, `#twitch`, or `#tiktok` channel. The first successful check initializes a baseline without reposting older content. Only unseen content is announced; the recent IDs are stored in PostgreSQL between restarts. Moderation permissions are required for all configuration actions.

## Platform requirements

**YouTube**: public Atom feed; no API key.

**Twitch**: set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in the Railway service environment. Twitch uses its OAuth app token plus the official Helix streams and videos endpoints. API credentials are not stored in Discord or the database.

**TikTok**: monitoring an arbitrary TikTok account is not supported by TikTok's publishing-status webhooks. Set `CREATOR_TIKTOK_FEED_TEMPLATE` to a trusted, operator-managed HTTPS RSS/Atom feed template containing `{account}`, such as `https://rss.example.com/tiktok/user/{account}`. Cloudy accepts only TikTok-hosted video URLs from that feed. Without a bridge, TikTok subscriptions may be saved but cannot become active. Do not treat a saved TikTok subscription as a working notification until the provider is configured and checked.

Failures are logged without exposing tokens. Delivery errors do not mark a video as seen, allowing retry on the next check. Discord messages have Cloudy's C logo, standard footer, direct content link and no automatic role mentions.

## Vote footer

Vote cards with optional media now use a native compact text footer on desktop and mobile instead of an oversized media image. Standard embeds elsewhere are unchanged.
