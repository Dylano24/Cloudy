// Identity of the single dedicated Gambling Commands guide.
// Do not identify unrelated game/economy embeds merely by their channel name.
const GUIDE_TITLE = /^games\s*&\s*economy$/i;
const GUIDE_DESCRIPTION = 'All Cloudy gaming and economy commands must be used in this channel. Click the button below to view all available commands.';

function hasGamblingCommandsButton(message) {
  return (message?.components || []).some(row =>
    (row?.components || row?.data?.components || []).some(button =>
      String(button?.customId || button?.custom_id || button?.data?.custom_id || '') === 'dedicated_commands:gambling',
    ),
  );
}

export function isDedicatedGamblingGuideMessage(message) {
  if (!Array.isArray(message?.embeds) || !message.embeds.length) return false;
  const commandsButton = hasGamblingCommandsButton(message);
  // The same canonical guide may have owner-edited text and no supplied
  // component metadata while Discord constructs a partial Message.
  const channelName = String(
    message?.channel?.name || message?.guild?.channels?.cache?.get?.(message?.channelId)?.name || '',
  ).toLowerCase();
  const isGamblingChannel = /(?:^|[^a-z])gambling(?:[^a-z]|$)/.test(channelName);
  return message.embeds.some(embed => {
    const title = String(embed?.title ?? embed?.data?.title ?? '').trim();
    const description = String(embed?.description ?? embed?.data?.description ?? '');
    return GUIDE_TITLE.test(title)
      && (description === GUIDE_DESCRIPTION || commandsButton || isGamblingChannel);
  });
}
