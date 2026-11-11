# Creator notifications

Cloudy checks configured accounts every five minutes and posts a direct content link to the platform's existing Discord channel. Monitoring is opt-in: nothing is announced until a server moderator adds a creator.

## Discord commands (Manage Server permission)

- `/creator-notify add platform:YouTube creator:https://www.youtube.com/@GoogleDevelopers` — paste a YouTube profile link; Cloudy resolves and stores its stable UC channel ID.
- `/creator-notify add platform:Twitch creator:https://www.twitch.tv/streamername` — paste a Twitch profile link; Cloudy extracts the login name.
- `/creator-notify add platform:TikTok creator:https://www.tiktok.com/@username` — paste a TikTok profile link; Cloudy extracts the username.
- `/creator-notify add platform:YouTube creator:https://youtube.com/@GoogleDevelopers channel:#announcements` — optional channel override.
- Direct YouTube `UC...` IDs and Twitch/TikTok usernames are still accepted.
- `/creator-notify list` — saved creators and provider readiness.
- `/creator-notify remove platform:YouTube creator:UC123...` — stop notifications.

**Simple setup:** `/creator-notify add creator:https://www.youtube.com/@kanaalnaam` — the platform field is optional when pasting a supported link. Cloudy identifies YouTube, Twitch or TikTok from its URL, even if a different platform was selected accidentally. Select the platform only when entering a bare username (except a full `UC...` YouTube channel ID). Paste the person's profile URL; the bot monitors new posts by that creator rather than only the pasted video.

When no channel is supplied, Cloudy resolves the server's existing `#youtube`, `#twitch`, or `#tiktok` channel. The first successful check initializes a baseline without reposting older content. Only unseen content is announced; the recent IDs are stored in PostgreSQL between restarts. Moderation permissions are required for all configuration actions.

## Platform requirements

**YouTube**: public Atom feed; no API key.
Cloudy accepts YouTube `/@handle`, `/channel/UC...`, `/c/name` and `/user/name` channel links (also without `https://`). When given a handle or legacy link, Cloudy resolves the UC channel ID from YouTube's channel metadata, or uses the official YouTube Data API if `YOUTUBE_API_KEY` is configured. You can remove a subscription using the same original link. Video links (`youtu.be`, `/watch`, `/shorts`, `/live`) are resolved to the video's creator through YouTube oEmbed; only the creator's channel is stored, never the video. Servers in the EU are often sent to YouTube's cookie-consent page: Cloudy sends a consent cookie, retries the mobile page, and if YouTube still blocks the lookup it says so (set `YOUTUBE_API_KEY` to avoid page lookups entirely). A URL that cannot be resolved produces a clear error; Cloudy never guesses an ID. Only official YouTube hosts are fetched.


**Twitch**: set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in the Railway service environment. Twitch uses its OAuth app token plus the official Helix streams and videos endpoints. API credentials are not stored in Discord or the database.

**TikTok**: monitoring an arbitrary TikTok account is not supported by TikTok's publishing-status webhooks. Set `CREATOR_TIKTOK_FEED_TEMPLATE` to a trusted, operator-managed HTTPS RSS/Atom feed template containing `{account}`, such as `https://rss.example.com/tiktok/user/{account}`. Cloudy accepts only TikTok-hosted video URLs from that feed. Without a bridge, TikTok subscriptions may be saved but cannot become active. Do not treat a saved TikTok subscription as a working notification until the provider is configured and checked.

Failures are logged without exposing tokens. Delivery errors do not mark a video as seen, allowing retry on the next check. Discord messages have Cloudy's C logo, standard footer, direct content link and no automatic role mentions.

## Vote footer

Vote cards with optional media now use a native compact text footer on desktop and mobile instead of an oversized media image. Standard embeds elsewhere are unchanged.
