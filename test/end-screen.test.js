'use strict';

/* "Why is it that when I tap on moon, nothing happens?"

   The moon he tapped was not the moon card. It was the end of the day: the session is over,
   the buttons are gone, and a moon floats on the dark screen. But 600ms after the end, a
   timer put the empty white card back behind that moon, so the end of the day looked exactly
   like a card with a moon on it. She taps it, and it does nothing, because the day is done.

   The end screen must not show a card. The card comes back when the next session starts. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, waitFor } = require('./harness');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cardShowing = (app) => {
  const p = app.$('picture');
  return p.style.background !== 'transparent';   // the inline override finish() sets
};

for (const bridge of [false, true]) {
  const name = bridge ? 'Android build' : 'browser build';

  test(name + ': the end screen shows the moon on its own, not a card', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());

    app.win.eval('S.plan=["cup:en"]; startSession()');      // a one-card day
    await waitFor(() => app.$('picture').classList.contains('invite'), 'the card');
    app.win.eval('advance(true,true)');                     // she says it: that was the last card
    await waitFor(() => app.win.eval('ended'), 'the end of the session');

    await pause(1000);                                      // well past the old 600ms timer
    assert.ok(app.$('moon').classList.contains('on'), 'the moon should be up');
    assert.strictEqual(app.$('picture').textContent, '', 'nothing should be on the card');
    assert.ok(!cardShowing(app), 'the empty white card came back behind the moon');
  });

  test(name + ': the card comes back when the next session starts', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());

    app.win.eval('S.plan=["cup:en"]; startSession()');
    await waitFor(() => app.$('picture').classList.contains('invite'), 'the card');
    app.win.eval('advance(true,true)');
    await waitFor(() => app.win.eval('ended'), 'the end of the session');
    await pause(1000);                                      // a grown-up opens the panel and starts again

    app.win.eval('S.plan=["dog:en"]; startSession()');
    await waitFor(() => app.$('picture').classList.contains('invite'), 'the next card');
    assert.ok(cardShowing(app), 'the next session started with no card to tap');
    assert.ok(!app.$('moon').classList.contains('on'), 'the moon should be gone');

    const before = app.tts.said.length;
    app.$('picture').click();
    await pause(30);
    assert.strictEqual(app.tts.said[before], 'dog', 'a tap on the new card should say its word');
  });
}
