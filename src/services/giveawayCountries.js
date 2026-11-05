// Every country in English, for the country step of a giveaway without a
// code. Discord only offers search-while-typing in slash commands, so the
// member types a country and Cloudy searches this list. Aliases (local names,
// short forms) only help finding; the English name is what is saved.
const COUNTRIES = [
  ['Afghanistan'], ['Albania'], ['Algeria', 'algerie'], ['Andorra'], ['Angola'],
  ['Antigua and Barbuda'], ['Argentina'], ['Armenia'], ['Aruba'], ['Australia'],
  ['Austria', 'osterreich', 'oostenrijk', 'autriche'], ['Azerbaijan'], ['Bahamas'], ['Bahrain'],
  ['Bangladesh'], ['Barbados'], ['Belarus'],
  ['Belgium', 'belgie', 'belgique', 'belgien', 'be'], ['Belize'], ['Benin'], ['Bhutan'],
  ['Bolivia'], ['Bosnia and Herzegovina', 'bosnia'], ['Botswana'], ['Brazil', 'brasil'],
  ['Brunei'], ['Bulgaria', 'bulgarije'], ['Burkina Faso'], ['Burundi'], ['Cambodia'],
  ['Cameroon', 'cameroun'], ['Canada'], ['Cape Verde', 'cabo verde'], ['Central African Republic'],
  ['Chad'], ['Chile'], ['China'], ['Colombia'], ['Comoros'],
  ['Congo', 'republic of the congo', 'congo brazzaville'], ['Costa Rica'],
  ['Croatia', 'hrvatska', 'kroatie'], ['Cuba'], ['Curacao'], ['Cyprus'],
  ['Czech Republic', 'czechia', 'tsjechie'], ['Democratic Republic of the Congo', 'dr congo', 'drc', 'congo kinshasa'],
  ['Denmark', 'danmark', 'denemarken'], ['Djibouti'], ['Dominica'], ['Dominican Republic'],
  ['East Timor', 'timor leste'], ['Ecuador'], ['Egypt', 'egypte'], ['El Salvador'],
  ['Equatorial Guinea'], ['Eritrea'], ['Estonia'], ['Eswatini', 'swaziland'], ['Ethiopia'],
  ['Fiji'], ['Finland', 'suomi'], ['France', 'frankrijk', 'fr'], ['Gabon'], ['Gambia'],
  ['Georgia'], ['Germany', 'deutschland', 'duitsland', 'allemagne', 'de'], ['Ghana'],
  ['Greece', 'hellas', 'griekenland', 'grece'], ['Grenada'], ['Guatemala'], ['Guinea'],
  ['Guinea-Bissau'], ['Guyana'], ['Haiti'], ['Honduras'], ['Hong Kong'],
  ['Hungary', 'magyarorszag', 'hongarije'], ['Iceland'], ['India'], ['Indonesia', 'indonesie'],
  ['Iran'], ['Iraq'], ['Ireland', 'eire', 'ierland'], ['Israel'], ['Italy', 'italia', 'italie'],
  ['Ivory Coast', 'cote d ivoire', 'cote divoire'], ['Jamaica'], ['Japan'], ['Jordan'],
  ['Kazakhstan'], ['Kenya'], ['Kiribati'], ['Kosovo'], ['Kuwait'], ['Kyrgyzstan'], ['Laos'],
  ['Latvia'], ['Lebanon', 'liban'], ['Lesotho'], ['Liberia'], ['Libya'], ['Liechtenstein'],
  ['Lithuania'], ['Luxembourg', 'luxemburg'], ['Madagascar'], ['Malawi'], ['Malaysia'],
  ['Maldives'], ['Mali'], ['Malta'], ['Marshall Islands'], ['Mauritania'], ['Mauritius'],
  ['Mexico', 'mexique'], ['Micronesia'], ['Moldova'], ['Monaco'], ['Mongolia'], ['Montenegro'],
  ['Morocco', 'maroc', 'marokko'], ['Mozambique'], ['Myanmar', 'burma'], ['Namibia'], ['Nauru'],
  ['Nepal'], ['Netherlands', 'the netherlands', 'holland', 'nederland', 'pays bas', 'dutch', 'nl'],
  ['New Zealand'], ['Nicaragua'], ['Niger'], ['Nigeria'], ['North Korea'],
  ['North Macedonia', 'macedonia'], ['Norway', 'norge', 'noorwegen'], ['Oman'], ['Pakistan'],
  ['Palau'], ['Palestine'], ['Panama'], ['Papua New Guinea'], ['Paraguay'], ['Peru'],
  ['Philippines'], ['Poland', 'polska', 'polen', 'pologne'], ['Portugal'], ['Puerto Rico'],
  ['Qatar'], ['Romania', 'roemenie', 'roumanie'], ['Russia', 'russian federation'], ['Rwanda'],
  ['Saint Kitts and Nevis'], ['Saint Lucia'], ['Saint Vincent and the Grenadines'], ['Samoa'],
  ['San Marino'], ['Sao Tome and Principe'], ['Saudi Arabia'], ['Senegal'],
  ['Serbia', 'srbija', 'servie'], ['Seychelles'], ['Sierra Leone'], ['Singapore'],
  ['Sint Maarten', 'saint martin'], ['Slovakia'], ['Slovenia'], ['Solomon Islands'], ['Somalia'],
  ['South Africa'], ['South Korea', 'korea'], ['South Sudan'],
  ['Spain', 'espana', 'spanje', 'espagne'], ['Sri Lanka'], ['Sudan'], ['Suriname', 'surinam'],
  ['Sweden', 'sverige', 'zweden', 'suede'], ['Switzerland', 'suisse', 'schweiz', 'zwitserland'],
  ['Syria'], ['Taiwan'], ['Tajikistan'], ['Tanzania'], ['Thailand'], ['Togo'], ['Tonga'],
  ['Trinidad and Tobago'], ['Tunisia', 'tunisie'], ['Turkey', 'turkiye', 'turkije', 'turquie'],
  ['Turkmenistan'], ['Tuvalu'], ['Uganda'], ['Ukraine', 'oekraine'], ['United Arab Emirates', 'uae'],
  ['United Kingdom', 'uk', 'gb', 'great britain', 'britain', 'england', 'scotland', 'wales',
    'northern ireland', 'verenigd koninkrijk', 'royaume uni'],
  ['United States', 'usa', 'us', 'america', 'united states of america', 'verenigde staten', 'etats unis'],
  ['Uruguay'], ['Uzbekistan'], ['Vanuatu'], ['Vatican City', 'vatican', 'holy see'],
  ['Venezuela'], ['Vietnam'], ['Yemen'], ['Zambia'], ['Zimbabwe'],
];

export const GIVEAWAY_COUNTRY_NAMES = Object.freeze(COUNTRIES.map(([name]) => name));
export const GIVEAWAY_COUNTRY_RESULT_LIMIT = 25;

export function normalizeCountryText(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^the /, '');
}

const INDEX = COUNTRIES.map(([name, ...aliases]) => ({
  name,
  terms: [name, ...aliases].map(normalizeCountryText),
}));

export function isGiveawayCountry(name) {
  return GIVEAWAY_COUNTRY_NAMES.includes(name);
}

const hasWord = (term, text) => ` ${term} `.includes(` ${text} `);

// Exact name or alias first (with other countries that contain it as a whole
// word, e.g. Guinea and Papua New Guinea); otherwise names or words that start
// with the typed text; otherwise names that contain it. At most 25 (one list).
export function searchGiveawayCountries(query) {
  const text = normalizeCountryText(query);
  if (text.length < 2) return [];
  const exact = INDEX.find(country => country.terms.includes(text));
  if (exact) {
    const related = INDEX.filter(country => country !== exact && country.terms.some(term => hasWord(term, text)));
    return [exact, ...related].map(country => country.name).slice(0, GIVEAWAY_COUNTRY_RESULT_LIMIT);
  }
  const starts = INDEX.filter(country => country.terms.some(term =>
    term.startsWith(text) || term.split(' ').some(word => word.startsWith(text))));
  const found = starts.length ? starts
    : text.length >= 3 ? INDEX.filter(country => country.terms.some(term => term.includes(text))) : [];
  return found.map(country => country.name).slice(0, GIVEAWAY_COUNTRY_RESULT_LIMIT);
}
