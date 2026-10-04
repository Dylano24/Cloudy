// Explicit command feedback only. Game results, ticket notices, published
// panels and normal information embeds must keep their existing lifetime.
const STATUS_TITLES = /^(?:(?:birthday(?: announcements)?|application|category|command|cash|currency symbol|currency name|premium role|counting game|template|limit|bitrate|channel|levels?|role reward|announcements|system|ignored channels|ignored roles|message|xp range|cooldown|log channel|manager roles|questions|retention|role|panel|note|notes|priority|ticket setting|changes|report channel|shared list|member|task|criteria|account age|button text|verification system|welcome system|goodbye system|image|ping|loop|volume|queue) (?:added|removed|set|updated|enabled|disabled|reset|cleared|configured|saved|completed|deleted|reposted)|(?:configuration|dashboard|review|application configuration) (?:error|timeout|timed out|updated)|birthday set!|setup (?:cancelled|already running|complete)|help menu closed|no (?:birthday found|birthdays(?: found)?|upcoming birthdays|applications found|notes(?: to clear)?|calculation history found)|insufficient funds|banned\b.*|kicked\b.*|warned\b.*|channel (?:locked|unlocked)|dm sent|messages purged|message sent|role validation warning|counter (?:created|updated) successfully\b.*|giveaway deleted|verification (?:configured|complete|successful)|not verified|video conversion failed|joined voice channel|playlist added|skipped|stopped|paused|resumed|shuffled|seeked|moved|24\/7 mode|left voice channel|(?:database|network|discord api|input) error|too fast|something went wrong|thanks for your feedback|not allowed|no problem|ticket not found)$/i;

const STATUS_CONTENT = /^(?:only (?:the user|admins|the ticket creator|the staff team)|you (?:cannot use|can only|must have|must be)|your balance could not be saved\b|this (?:dashboard belongs|fix guide is available|faq assistant can only|countdown has expired|button action is no longer|ticket dashboard is outdated|action can only)|that (?:ticket (?:text )?setting|member is no longer)|the (?:ticket (?:dashboard could not|system is currently disabled|database is temporarily)|private faq assistant is temporarily|url must start)|no (?:ticket dashboard value|calculation history)\b|please (?:enter|wait|select|choose|provide)\b|i could not open the question form\b)/i;

export function isAdditionalStatusTitle(title) {
  return STATUS_TITLES.test(title);
}

export function isAdditionalStatusContent(content) {
  return STATUS_CONTENT.test(content);
}
