import { isDeepStrictEqual } from 'node:util';

function comparable(component) {
  const data = {...(component.toJSON?.() || component)};
  // Discord assigns numeric component IDs and fills in false/null defaults.
  // The functional custom_id, labels, styles, URLs and emoji IDs stay exact.
  delete data.id;
  if (data.disabled === false) delete data.disabled;
  if (data.emoji) {
    data.emoji = {...data.emoji};
    for (const key of Object.keys(data.emoji)) {
      if (data.emoji[key] === null || (key === 'animated' && data.emoji[key] === false)) delete data.emoji[key];
    }
  }
  if (data.components) data.components = data.components.map(comparable);
  return data;
}

export function sameTicketComponents(left, right) {
  return isDeepStrictEqual(left.map(comparable), right.map(comparable));
}
