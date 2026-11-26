'use strict';

/* "Audit the code so nothing does what it isn't meant to — fake cards and what not."

   Each test here is something the app did that nobody designed, found in that audit:
     1. a card that could never answer, shown before the first session of a launch
     2. the device check's 9s timer shutting her microphone off under her first card,
        while the ring kept breathing as if it were listening
     3. the device check's level meter still holding the microphone when her session began
     4. one tap on "Start over" erasing every day and every recorded word
     5. no way for Android to bring her card back when the app returns to the front
     6. the grown-up panel saying speech recognition is on-device, when for a language with
        no offline pack the recogniser sends her voice over the internet */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, waitFor } = require('./harness');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cardShowing = (app) => app.$('picture').style.background !== 'transparent';

for (const bridge of [false, true]) {
  const name = bridge ? 'Android build' : 'browser build';

  test(name + ': before the first session her screen shows no card to tap', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());

    app.$('back').click();                                  // "Back to her screen" before "Start today"
    await pause(20);
    assert.ok(!app.$('parent').classList.contains('on'), 'the panel should be closed');
    assert.strictEqual(app.$('picture').textContent, '', 'a card face is showing that no tap can answer');
    assert.ok(!cardShowing(app), 'a white card is showing with no session behind it');
    assert.ok(app.$('moon').classList.contains('on'), 'her screen should be the quiet night screen');
  });

  test(name + ': a listening test from the device check cannot switch off her microphone', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());

    app.win.eval('diagListen("en")');                       // a grown-up tests English...
    await pause(5000);
    app.win.eval('S.plan=["cup:en","dog:es"]');
    app.$('begin').click();                                 // ...then starts her day
    app.$('picture').click();
    await waitFor(() => app.tts.speaking, 'the word');
    app.tts.finish();
    await waitFor(() => app.$('ear').classList.contains('on'), 'the ear to open');
    assert.ok(app.asr.open, 'her microphone should be open');

    await pause(4300);                                      // past the check's own 9s timer
    assert.ok(app.$('ear').classList.contains('on'), 'the ear should still be showing');
    assert.ok(app.asr.open,
      'the device check shut her microphone off mid-card, while the ring still showed it listening');
  });

  test(name + ': starting her session ends the microphone test from the device check', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());

    let micHeld = false;
    if (bridge) {
      app.win.AndroidBridge.levelStart = () => { micHeld = true; return true; };
      app.win.AndroidBridge.levelStop = () => { micHeld = false; };
    } else {
      app.win.navigator.mediaDevices = {
        getUserMedia: async () => { micHeld = true; return { getTracks: () => [{ stop() { micHeld = false; } }] }; },
      };
      app.win.AudioContext = function () {
        return {
          state: 'running',
          createMediaStreamSource: () => ({ connect() {} }),
          createAnalyser: () => ({ fftSize: 0, getByteTimeDomainData() {} }),
        };
      };
    }
    app.win.eval('diagRun()');
    await waitFor(() => micHeld, 'the microphone test to open the mic');
    app.$('begin').click();
    await pause(20);
    assert.strictEqual(app.win.eval('ended'), false, 'her session should have started');
    assert.strictEqual(micHeld, false, 'the device check still holds the microphone her session needs');
  });

  test(name + ': one tap on Start over does not erase her progress and your recordings', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());

    await app.win.eval('VOICE["cup:en:a"]="data:x"; S.day=40; Promise.all([store.set("em:v:cup:en:a","data:x"), saveState()])');
    app.$('reset').click();
    await pause(30);
    assert.strictEqual(app.win.eval('S.day'), 40, 'one tap erased every day of progress');
    assert.strictEqual(app.win.eval('Object.keys(VOICE).length'), 1, 'one tap erased the recorded words');

    app.$('resetYes').click();                              // the deliberate second step still works
    await pause(30);
    assert.strictEqual(app.win.eval('S.day'), 0, 'confirming should erase');
    assert.strictEqual(app.win.eval('Object.keys(VOICE).length'), 0, 'confirming should erase the recordings');
  });

  test(name + ': the host can bring her card back after a stand-down', async (t) => {
    const app = await openApp({ bridge });
    t.after(() => app.close());

    app.win.eval('S.plan=["cup:en","dog:es"]; startSession()');
    await waitFor(() => app.$('picture').classList.contains('invite'), 'the card');
    assert.strictEqual(typeof app.win.__standDown, 'function');
    assert.strictEqual(typeof app.win.__resume, 'function',
      'Android calls __standDown() on pause but has nothing to call on the way back');

    app.win.__standDown();                                  // MainActivity.onPause()
    assert.strictEqual(app.win.eval('ended'), true);
    app.win.__resume();                                     // MainActivity.onResume()
    assert.strictEqual(app.win.eval('ended'), false, 'her card should be live again');

    const before = app.tts.said.length;
    app.$('picture').click();
    await pause(30);
    assert.strictEqual(app.tts.said[before], 'cup', 'a tap on the card she came back to should say its word');
  });
}

test('Android build: the grown-up panel does not claim her voice never leaves the tablet', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  const cap = app.$('cap').textContent;
  assert.ok(!/Speech recognition is on-device\./.test(cap),
    'the panel says recognition is on-device, but Bridge.java retries over the network');
  assert.match(cap, /internet/, 'the panel should say when her voice can go over the internet');
  assert.ok(!/Nothing here talks to a server\./.test(app.win.document.body.textContent),
    'the panel says nothing talks to a server');
});
