// Approved Cloudy music player design: fixed, silver-white 128px control glyphs.
// The simulated preview backgrounds are not included: Discord owns the button chrome.
export const MUSIC_CONTROL_ART_KEYS = Object.freeze(["shuffle","previous","pause","next","repeat","queue","add","remove","stop","play","repeat_one"]);
const SHAPES = Object.freeze({
  "shuffle": "<path d=\"M-26 -17 H-17 C-5 -17 0 -6 10 7 C17 17 21 17 27 17\"/><path d=\"M17 8 L27 17 L17 26\"/><path d=\"M-26 17 H-17 C-4 17 1 5 11 -8 C17 -17 21 -17 27 -17\"/><path d=\"M17 -26 L27 -17 L17 -8\"/>",
  "previous": "<rect x=\"-29\" y=\"-26\" width=\"7\" height=\"52\" rx=\"2.5\" fill=\"url(#steel)\" stroke=\"none\"/><path d=\"M19 -24 L-18 0 L19 24 Z\" fill=\"url(#steel)\" stroke=\"none\"/>",
  "pause": "<rect x=\"-18\" y=\"-26\" width=\"11\" height=\"52\" rx=\"3\" fill=\"url(#steel)\" stroke=\"none\"/><rect x=\"7\" y=\"-26\" width=\"11\" height=\"52\" rx=\"3\" fill=\"url(#steel)\" stroke=\"none\"/>",
  "next": "<path d=\"M-19 -24 L18 0 L-19 24 Z\" fill=\"url(#steel)\" stroke=\"none\"/><rect x=\"22\" y=\"-26\" width=\"7\" height=\"52\" rx=\"2.5\" fill=\"url(#steel)\" stroke=\"none\"/>",
  "repeat": "<path d=\"M-20 -10 C-17 -20 -10 -24 2 -24 H20\"/><path d=\"M12 -32 L21 -24 L12 -16\"/><path d=\"M20 10 C17 20 10 24 -2 24 H-20\"/><path d=\"M-12 16 L-21 24 L-12 32\"/>",
  "queue": "<path d=\"M-24 -20 H24 M-24 0 H24 M-24 20 H24\"/>",
  "add": "<path d=\"M-25 0 H25 M0 -25 V25\"/>",
  "remove": "<rect x=\"-25\" y=\"-3.5\" width=\"50\" height=\"7\" rx=\"3.5\" fill=\"url(#steel)\" stroke=\"none\"/>",
  "stop": "<rect x=\"-24\" y=\"-24\" width=\"48\" height=\"48\" rx=\"4\" fill=\"url(#steel)\" stroke=\"none\"/>",
  "play": "<path d=\"M-20 -27 L24 0 L-20 27 Z\" fill=\"url(#steel)\" stroke=\"none\"/>",
  "repeat_one": "<path d=\"M-20 -10 C-17 -20 -10 -24 2 -24 H20\"/><path d=\"M12 -32 L21 -24 L12 -16\"/><path d=\"M20 10 C17 20 10 24 -2 24 H-20\"/><path d=\"M-12 16 L-21 24 L-12 32\"/><circle cx=\"21\" cy=\"19\" r=\"12\" fill=\"#35363d\" stroke=\"none\"/><text x=\"21\" y=\"26\" text-anchor=\"middle\" font-family=\"sans-serif\" font-weight=\"700\" font-size=\"22\" fill=\"#f0f2f6\" stroke=\"none\">1</text>"
});
const PREFIX = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="-42 -42 84 84"><defs><linearGradient id="steel" x1="0" y1="0" x2=".85" y2="1"><stop stop-color="#ffffff"/><stop offset=".42" stop-color="#f0f2f6"/><stop offset="1" stop-color="#c6cbd4"/></linearGradient></defs><g stroke="url(#steel)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" fill="none">';
const SUFFIX = '</g></svg>';
export function musicControlSvg(key) {
  return Object.hasOwn(SHAPES, key) ? PREFIX + SHAPES[key] + SUFFIX : null;
}
