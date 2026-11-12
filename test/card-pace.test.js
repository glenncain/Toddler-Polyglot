'use strict';

/* How long she stands in front of a picture that is doing nothing.

   Three waits made the session feel stuck on the tablet:
   - a tap during the invite wobble showed nothing, because the animation overrode :active;
   - the word was said twice before the microphone opened, so she answered into a closed mic;
   - after a right answer the next card sat silent for nine seconds unless she tapped it.
   Each test below times one of them against a budget. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, intoTheMiddleOfACard } = require('./harness');

const BUILDS = [
  { name: 'browser build', bridge: false },
  { name: 'Android build', bridge: true },
];

/* after she says it: chime and bounce, then the next word, with no tap from her */
const NEXT_WORD_BUDGET_MS = 4000;

for (const build of BUILDS) {
  test(build.name + ': after she says the word, the next word plays without a tap', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    await intoTheMiddleOfACard(app);
    const first = app.tts.said.length;

    const t0 = Date.now();
    /* a right answer, the way the parent's key marks one */
    app.win.document.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: 'Enter' }));
    await app.waitFor(() => app.tts.said.length > first, 'the next word to be spoken', 15000);
    const waited = Date.now() - t0;

    t.diagnostic('right answer to the next word: ' + waited + 'ms');
    assert.ok(waited <= NEXT_WORD_BUDGET_MS,
      'the next card sat silent for ' + waited + 'ms after she got one right');
  });

  test(build.name + ': one tap, one word, then it listens', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    app.$('begin').click();
    await app.waitFor(() => !app.$('parent').classList.contains('on'), 'the session to start');
    app.$('picture').click();
    await app.waitFor(() => app.tts.speaking, 'the word to be spoken');
    app.tts.finish();
    await app.waitFor(() => app.$('ear').classList.contains('on'), 'the ear to open after one saying');

    assert.strictEqual(app.tts.said.length, 1, 'the word was said more than once before the ear opened');
    assert.ok(app.asr.open, 'the ear shows but the microphone is not open');
  });

  test(build.name + ': touching the picture shows at once, even mid-wobble', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    app.$('begin').click();
    await app.waitFor(() => app.$('picture').classList.contains('invite'), 'the invite wobble');
    app.$('picture').dispatchEvent(new app.win.Event('pointerdown'));

    assert.ok(app.$('picture').classList.contains('press'), 'a press shows no feedback');
    assert.ok(!app.$('picture').classList.contains('invite'), 'the wobble still overrides the press');
  });
}

test('Android build: the next card\'s voice is loaded before she taps', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  app.$('begin').click();
  await app.waitFor(() => app.tts.prepared.length > 0, 'the card to ask for its voice');
  assert.strictEqual(app.tts.said.length, 0, 'preparing the voice said something out loud');
});
