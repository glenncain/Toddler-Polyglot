'use strict';

/* Every word she can be shown has its own picture, and the card shows it. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp } = require('./harness');

test('every object in the word list has a built-in picture', async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const ids = app.win.eval('OBJ.map(o=>o[0])');
  const pics = app.win.eval('Object.keys(PICS)');
  const missing = ids.filter((id) => !pics.includes(id));
  assert.strictEqual(missing.length, 0, 'these words would still show an emoji: ' + missing.join(', '));
  for (const id of ids) {
    assert.match(app.win.eval('PICS[' + JSON.stringify(id) + ']'), /^data:image\/jpeg;base64,\/9j\//,
      id + ' is not an embedded JPEG');
  }
});

test('a card shows the picture of its own word', async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  app.$('begin').click();
  await app.waitFor(() => app.$('picture').querySelector('img'), 'the first card to show a picture');
  const word = app.win.eval('queue[idx].obj');
  assert.strictEqual(app.$('picture').querySelector('img').src, app.win.eval('PICS[queue[idx].obj]'),
    'the picture on screen is not the one for ' + word);
});
