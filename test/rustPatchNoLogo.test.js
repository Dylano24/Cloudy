import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateCloudyLogoEmbedData, CLOUDY_LOGO_URL } from '../src/services/cloudyLogoService.js';
test('Rust patch notes retain the banner and text footer without embed logos', () => {
 const source={url:'https://rust.facepunch.com/news/halloween-2026/',thumbnail:{url:CLOUDY_LOGO_URL},image:{url:'attachment://patch-notes-banner.png'},author:{name:'RUST • OFFICIAL UPDATE',icon_url:CLOUDY_LOGO_URL},footer:{text:'© Cloudy Inc. • Quality. Innovation. Performance.',icon_url:CLOUDY_LOGO_URL}};
 const {data}=migrateCloudyLogoEmbedData(source);
 assert.equal(data.thumbnail,undefined);assert.equal(data.author.icon_url,undefined);assert.equal(data.footer.icon_url,undefined);assert.deepEqual(data.image,source.image);assert.equal(data.footer.text,source.footer.text);
});
