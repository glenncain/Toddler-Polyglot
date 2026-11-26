'use strict';

/* "When I tap on the moon, nothing happens." — "No response when tapped."

   With no session running, her screen is the night colour and the moon. She taps it. It used
   to do nothing at all. Now it hops and says goodnight in one of today's languages, in turn,
   without ever opening the microphone or starting cards. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, waitFor } = require('./harness');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function toTheEndOfTheDay(app) {
  app.win.eval('S.plan=["cup:en"]; startSession()');                 // a one-card day
  await waitFor(() => app.$('picture').classList.contains('invite'), 'the card');
  app.win.eval('advance(true,true)');                                // she says it: the day is done
  await waitFor(() => app.$('moon').classList.contains('on'), 'the moon');
  app.tts.finish();
  await pause(50);
}

for (const bridge of [false, true]) {
  const name = bridge ? 'Android build' : 'browser build';

  test(name + ': tapping the moon at the end of the day says goodnight', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());
    await toTheEndOfTheDay(app);

    const before = app.tts.said.length;
    app.$('picture').click();
    await pause(30);
    assert.strictEqual(app.tts.said.length, before + 1, 'the moon said nothing');
    assert.ok(app.$('moon').classList.contains('nod'), 'the moon did not move');
    assert.ok(!app.asr.open, 'a tap on the moon opened the microphone');
    assert.ok(app.win.eval('ended'), 'a tap on the moon started cards');
  });

  test(name + ': each tap is the next language, and a fast tap replaces the last', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());
    await toTheEndOfTheDay(app);

    const before = app.tts.said.length;
    for (let i = 0; i < 4; i++) { app.$('picture').click(); await pause(10); }
    const said = app.tts.said.slice(before);
    assert.deepStrictEqual(
      [...said].sort(), ['buenas noches', 'good night', 'おやすみ', '晚安'].sort(),
      'four taps should be goodnight once in each language');
    assert.ok(!app.asr.open, 'the microphone opened');
  });

  test(name + ': only today\'s languages say goodnight', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());
    app.win.eval('S.active=["es"]');
    app.win.eval('S.plan=["cup:es"]; startSession()');
    await waitFor(() => app.$('picture').classList.contains('invite'), 'the card');
    app.win.eval('advance(true,true)');
    await waitFor(() => app.$('moon').classList.contains('on'), 'the moon');
    app.tts.finish();

    const before = app.tts.said.length;
    app.$('picture').click(); await pause(10);
    app.$('picture').click(); await pause(10);
    assert.deepStrictEqual(app.tts.said.slice(before), ['buenas noches', 'buenas noches']);
  });

  test(name + ': the moon is quiet while the grown-up panel is open', async (t) => {
    const app = await openApp({ bridge });                            // launch opens the panel
    t.after(() => app.close());
    assert.ok(app.$('parent').classList.contains('on'));
    const before = app.tts.said.length;
    app.$('picture').click();
    await pause(30);
    assert.strictEqual(app.tts.said.length, before, 'the moon spoke behind the grown-up panel');
  });
}
