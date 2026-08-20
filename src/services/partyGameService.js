const QUESTIONS = {
  truth: {
    pg: [
      'What is a small thing that always makes your day better?',
      'What is the funniest misunderstanding you have ever had?',
      'What is a skill you wish you could learn instantly?',
      'What is your most-used emoji and why?',
      'What is the weirdest food combination you actually like?',
      'What is a harmless habit you would like to stop?',
      'What is the nicest compliment you remember receiving?',
      'What is something you were completely wrong about as a kid?',
      'What is the most embarrassing autocorrect you have sent?',
      'Which fictional world would you live in for one week?',
      'What is a song you know almost every word to?',
      'What is the longest you have stayed awake?',
      'What is one thing on your bucket list?',
      'What is a talent most people do not know you have?',
      'What is your funniest gaming moment?',
    ],
    pg13: [
      'Who in this server would you trust with your biggest secret?',
      'What is the biggest lie you have told to avoid plans?',
      'What is the most jealous you have ever been?',
      'What is a first impression you had of someone here that turned out wrong?',
      'What is something you pretend not to care about but actually do?',
      'What is the boldest message you have ever sent?',
      'What is the most awkward conversation you have had recently?',
      'What is one thing you would change about your dating history?',
      'Have you ever ignored a message on purpose? Why?',
      'What is the pettiest reason you have been annoyed with someone?',
      'What is a secret opinion you rarely say out loud?',
      'What is the biggest risk you have taken for someone?',
    ],
  },
  dare: {
    pg: [
      'Send the last safe meme in your camera roll.',
      'Talk only in questions for the next three messages.',
      'Change your nickname to something chosen by the group for 10 minutes.',
      'Send a compliment to the person who spoke before you.',
      'Use only emojis for your next two messages.',
      'Write a four-line poem about the server.',
      'Do your best dramatic movie-trailer voice in voice chat.',
      'Let the group choose your status for 10 minutes.',
      'Post your most recently used GIF.',
      'Describe your day using exactly five words.',
      'Invent a ridiculous product and give it a sales pitch.',
      'Type your next message with your eyes closed.',
    ],
    pg13: [
      'Send a genuine compliment to someone you do not usually compliment.',
      'Let the group pick a harmless profile status for 15 minutes.',
      'Tell the group your most awkward recent moment.',
      'Message a friend you have not spoken to in a while and say hello.',
      'Read your last sent message dramatically in voice chat.',
      'Share an unpopular opinion and defend it for one minute.',
      'Let another player choose three words you must use in your next message.',
      'Admit one thing you have been procrastinating on.',
      'Post a song that matches your current mood.',
      'Give someone here a new harmless nickname and explain it.',
    ],
  },
  wyr: {
    pg: [
      'Would you rather be able to fly or breathe underwater?',
      'Would you rather always have perfect Wi-Fi or never need to charge a device?',
      'Would you rather explore space or the deepest ocean?',
      'Would you rather be able to pause time or rewind ten minutes once per day?',
      'Would you rather have unlimited travel or unlimited concert tickets?',
      'Would you rather only play one amazing game forever or every average game?',
      'Would you rather know every language or play every instrument?',
      'Would you rather be extremely lucky or extremely talented?',
      'Would you rather live in the mountains or by the sea?',
      'Would you rather give up music or movies for a year?',
    ],
    pg13: [
      'Would you rather know who secretly likes you or who secretly dislikes you?',
      'Would you rather always say exactly what you think or never be able to explain yourself?',
      'Would you rather forgive someone too easily or hold grudges too long?',
      'Would you rather have one perfect relationship or ten perfect friendships?',
      'Would you rather be famous with no privacy or unknown with complete freedom?',
      'Would you rather hear a difficult truth immediately or discover it later yourself?',
      'Would you rather lose every old message or every old photo?',
      'Would you rather be able to read minds once a day or become invisible for ten minutes?',
    ],
  },
  nhie: {
    pg: [
      'Never have I ever fallen asleep during a movie.',
      'Never have I ever sent a message to the wrong person.',
      'Never have I ever pretended to understand something when I did not.',
      'Never have I ever rage-quit a game.',
      'Never have I ever laughed so hard I could not talk.',
      'Never have I ever forgotten someone’s birthday.',
      'Never have I ever eaten food after dropping it.',
      'Never have I ever stayed in pajamas all day.',
      'Never have I ever blamed lag for losing.',
      'Never have I ever searched my own name online.',
    ],
    pg13: [
      'Never have I ever ignored someone because I was annoyed with them.',
      'Never have I ever had a crush on someone I should not have.',
      'Never have I ever lied about being busy to avoid someone.',
      'Never have I ever screenshotted a conversation and sent it to someone else.',
      'Never have I ever regretted sending a late-night message.',
      'Never have I ever been jealous of a friend.',
      'Never have I ever pretended not to see a notification.',
      'Never have I ever changed my opinion because of someone I liked.',
    ],
  },
  paranoia: {
    pg: [
      'Who here would survive the longest in a zombie apocalypse?',
      'Who here is most likely to become famous?',
      'Who here would be the best teammate in a difficult game?',
      'Who here is most likely to accidentally become a meme?',
      'Who here would make the best teacher?',
      'Who here is most likely to forget where they put their phone?',
      'Who here would win a talent show?',
      'Who here is most likely to start a successful business?',
      'Who here would be the calmest in an emergency?',
      'Who here is most likely to stay up all night gaming?',
    ],
    pg13: [
      'Who here is most likely to catch feelings first?',
      'Who here is most likely to keep a major secret?',
      'Who here is most likely to get jealous but hide it?',
      'Who here would you trust most with relationship advice?',
      'Who here is most likely to ghost a group chat for a week?',
      'Who here is most likely to make a risky last-minute decision?',
      'Who here is hardest to read emotionally?',
      'Who here would be most likely to admit they were wrong first?',
    ],
  },
};

export const PARTY_GAME_TYPES = Object.freeze(['truth', 'dare', 'tod', 'wyr', 'nhie', 'paranoia', 'random']);
export const PARTY_GAME_MODES = Object.freeze(['pg', 'pg13']);

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function resolvePool(type, mode) {
  const normalizedMode = PARTY_GAME_MODES.includes(mode) ? mode : 'pg';
  const base = QUESTIONS[type];
  if (!base) return [];
  return normalizedMode === 'pg13' ? [...base.pg, ...base.pg13] : base.pg;
}

export function getPartyPrompt(type = 'random', mode = 'pg') {
  let resolvedType = type;

  if (resolvedType === 'tod') {
    resolvedType = Math.random() < 0.5 ? 'truth' : 'dare';
  } else if (resolvedType === 'random') {
    resolvedType = pick(['truth', 'dare', 'wyr', 'nhie', 'paranoia']);
  }

  if (!['truth', 'dare', 'wyr', 'nhie', 'paranoia'].includes(resolvedType)) {
    resolvedType = 'truth';
  }

  const pool = resolvePool(resolvedType, mode);
  return {
    type: resolvedType,
    mode: PARTY_GAME_MODES.includes(mode) ? mode : 'pg',
    prompt: pick(pool),
  };
}

export function getPartyGameStats() {
  const byType = {};
  let total = 0;

  for (const [type, modes] of Object.entries(QUESTIONS)) {
    byType[type] = {
      pg: modes.pg.length,
      pg13: modes.pg13.length,
      total: modes.pg.length + modes.pg13.length,
    };
    total += byType[type].total;
  }

  return { total, byType };
}
