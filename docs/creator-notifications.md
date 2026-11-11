# Creator notifications

Cloudy checks configured accounts every five minutes and posts a direct content link to the platform's existing Discord channel. Monitoring is opt-in: nothing is announced until a server moderator adds a creator.

## Discord command (Manage Server permission)

`/creator-notify` opens a private dashboard, built like `/auto feed` (it closes after 5 minutes of inactivity):

- **Add creator** — choose the channel, then paste the creator's profile link in the form. The platform is detected from the link (YouTube `/@handle`, `/channel/UC...`, `/c/` and `/user/`, video links such as `youtu.be`; Twitch and TikTok profile links). Choose a platform on the channel step only when entering a bare username.
- **Manage creator** — pick a creator, then **Change channel**, **Pause creator** / **Resume creator** (a resumed creator skips anything posted while paused) or **Delete creator**. A server can monitor up to 25 creators.

Errors are red and disappear after 10 seconds. The first successful check initializes a baseline without reposting older content. Only unseen content is announced; the recent IDs are stored in PostgreSQL between restarts.

## Platform requirements

**YouTube**: public Atom feed; no API key.
Cloudy accepts YouTube `/@handle`, `/channel/UC...`, `/c/name` and `/user/name` channel links (also without `https://`). When given a handle or legacy link, Cloudy resolves the UC channel ID from YouTube's channel metadata, or uses the official YouTube Data API if `YOUTUBE_API_KEY` is configured. You can remove a subscription using the same original link. Video links (`youtu.be`, `/watch`, `/shorts`, `/live`) are resolved to the video's creator through YouTube oEmbed; only the creator's channel is stored, never the video. Servers in the EU are often sent to YouTube's cookie-consent page: Cloudy sends a consent cookie, retries the mobile page, and if YouTube still blocks the lookup it says so (set `YOUTUBE_API_KEY` to avoid page lookups entirely). A URL that cannot be resolved produces a clear error; Cloudy never guesses an ID. Only official YouTube hosts are fetched.


**Twitch**: set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in the Railway service environment. Twitch uses its OAuth app token plus the official Helix streams and videos endpoints. API credentials are not stored in Discord or the database.

**TikTok**: monitoring an arbitrary TikTok account is not supported by TikTok's publishing-status webhooks. Set `CREATOR_TIKTOK_FEED_TEMPLATE` to a trusted, operator-managed HTTPS RSS/Atom feed template containing `{account}`, such as `https://rss.example.com/tiktok/user/{account}`. Cloudy accepts only TikTok-hosted video URLs from that feed. Without a bridge, TikTok subscriptions may be saved but cannot become active. Do not treat a saved TikTok subscription as a working notification until the provider is configured and checked.

Failures are logged without exposing tokens. Delivery errors do not mark a video as seen, allowing retry on the next check. Discord messages have Cloudy's C logo, standard footer, direct content link and no automatic role mentions.

## Vote footer

Vote cards with optional media now use a native compact text footer on desktop and mobile instead of an oversized media image. Standard embeds elsewhere are unchanged.
