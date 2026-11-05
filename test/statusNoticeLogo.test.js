import test from 'node:test';
import assert from 'node:assert/strict';
import { withStatusLogo } from '../src/events/fullResponseCatalogReady.js';

test('status replies always get the Cloudy logo, other embeds are left alone', () => {
  const success = withStatusLogo({ title: 'Success', description: 'You voted for **dz west**.' });
  assert.match(success.thumbnail.url, /cloudy-c-logo/);
  const warning = withStatusLogo({ title: 'Warning', description: 'This vote has ended.' });
  assert.match(warning.thumbnail.url, /cloudy-c-logo/);
  const own = { title: 'Success', thumbnail: { url: 'https://example.com/own.png' } };
  assert.equal(withStatusLogo(own), own, 'an existing thumbnail stays');
  const content = { title: 'Map vote', description: 'x' };
  assert.equal(withStatusLogo(content), content, 'normal content is not a status reply');
});
