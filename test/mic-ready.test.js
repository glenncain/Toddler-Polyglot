'use strict';

/* From the word being read out to the microphone being ready for her.

   Everything she says between the word ending and the recogniser actually holding the
   microphone goes nowhere, and a three-year-old answers fast. Three things made that gap
   longer or invisible:
     - the ring breathed from the moment the word ended, before anything was listening,
       so the screen said "listening" during the deaf part;
     - after a guess that was not the word, the page waited before asking again, and the
       bridge then destroyed the recogniser and built a new one (about a second, deaf);
     - "heard nothing" counted as a fault, so a quiet child used up the retry cap.
   The ring now has three states (on, ready, hearing), the bridge keeps a finished
   recogniser warm and reuses it, and the page measures both gaps on the tablet itself
   and shows them in the grown-up panel. The Java side cannot run here; these tests pin
   the page's half. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, intoTheMiddleOfACard, waitFor } = require('./harness');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ear = (app) => app.$('ear').classList;

test('Android build: the ring does not claim to listen until the recogniser has the microphone', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  assert.ok(ear(app).contains('on'), 'the ring should show the microphone is on its way');
  assert.ok(!ear(app).contains('ready'), 'the ring breathed before anything was listening');

  app.win.__asrReady(false, undefined);
  assert.ok(ear(app).contains('ready'), 'the recogniser reported ready and the ring did not show it');
});

test('Android build: the ring follows her voice once it is listening', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  app.win.__asrLevel(8, undefined);                  // before ready: nothing is listening yet
  assert.ok(!ear(app).contains('hearing'), 'the ring reacted before the recogniser was ready');

  app.win.__asrReady(false, undefined);
  for (const v of [-1, -1.2, -0.8, -1]) app.win.__asrLevel(v, undefined);   // the room
  assert.ok(!ear(app).contains('hearing'), 'room noise made the ring think she was talking');

  app.win.__asrLevel(4, undefined);                  // a quiet voice, a few dB over the room
  assert.ok(ear(app).contains('hearing'), 'a quiet voice did not move the ring');
  await waitFor(() => !ear(app).contains('hearing'), 'the ring to settle after she stops', 1500);
});

test('Android build: after a guess that was not the word, it listens again within a tenth of a second', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  app.win.__asrReady(false, undefined);
  const starts = app.asr.starts;

  const t0 = Date.now();
  app.asr.ended();
  app.win.__asrHeard('zzzz', undefined);
  app.win.__asrEnd(undefined);
  await waitFor(() => app.asr.starts > starts, 'the re-arm', 1000);
  const ms = Date.now() - t0;
  assert.ok(ms < 120, `re-arm took ${ms}ms`);
  assert.ok(ear(app).contains('on') && !ear(app).contains('ready'),
    'between listens the ring should say "on its way", not "listening"');
});

test('Android build: silence is not a fault, so a quiet child does not use up the retries', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  for (let i = 0; i < 10; i++) {
    const starts = app.asr.starts;
    app.win.__asrReady(false, undefined);
    app.asr.ended();
    app.win.__asrError('no-speech', true, true, false, undefined);
    await waitFor(() => app.asr.starts > starts, `listen ${i + 2} after silence`, 1000);
  }
  assert.ok(ear(app).contains('on'), 'the ring went out after a run of silences');
});

test('Android build: a recogniser that keeps failing still gives up', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  for (let i = 0; i < 8; i++) {
    app.asr.ended();
    app.win.__asrError('busy', false, false, false, undefined);
    await pause(280);
  }
  assert.ok(!ear(app).contains('on'), 'a broken recogniser kept the ring on forever');
});

test('Android build: the panel shows how long the microphone took to be ready', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  await pause(30);
  app.win.__asrReady(false, undefined);              // the first listen after the word
  app.asr.ended();
  app.win.__asrHeard('zzzz', undefined);
  app.win.__asrEnd(undefined);
  await waitFor(() => app.asr.open, 'the re-arm', 1000);
  app.win.__asrReady(false, undefined);              // the re-armed listen

  const first = app.win.eval('EAR.first.slice()');
  const again = app.win.eval('EAR.rearm.slice()');
  assert.strictEqual(first.length, 1, 'the first listen was not timed');
  assert.strictEqual(again.length, 1, 'the re-arm was not timed separately');
  assert.ok(first[0] >= 25, `first gap ${first[0]}ms should include the wait before ready`);

  app.win.eval('openParent()');
  const text = app.$('diagRows').textContent;
  assert.match(text, /Microphone ready/, 'no ready-time row in the panel');
  assert.match(text, /After the word: \d\.\d\ds \(1 listens\)/);
});

test('browser build: the ring waits for the recogniser to start hearing audio', async (t) => {
  const app = await openApp({ bridge: false });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  assert.ok(ear(app).contains('on') && !ear(app).contains('ready'));
  const rec = app.win.eval('rec');
  rec.onaudiostart();
  assert.ok(ear(app).contains('ready'), 'audiostart did not mark the ring ready');
  rec.onspeechstart();
  assert.ok(ear(app).contains('hearing'), 'speechstart did not show she is being heard');
});

test('Android build: the grown-up can turn the quiet-voice boost on and off, and it is remembered', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  app.win.eval('paintDiag()');
  const btn = () => app.$('boostBtn');
  assert.ok(btn(), 'no quiet-voice boost control in the panel');
  assert.strictEqual(btn().textContent, 'off', 'the boost must start off');
  btn().click();
  assert.strictEqual(btn().textContent, 'on');
  assert.strictEqual(app.win.AndroidBridge.prefGet('em:mic-boost'), '1', 'the choice was not saved');
  btn().click();
  assert.strictEqual(btn().textContent, 'off');
});

test('browser build: no boost control, because there is no bridge to boost', async (t) => {
  const app = await openApp({ bridge: false });
  t.after(() => app.close());
  app.win.eval('paintDiag()');
  assert.ok(!app.$('boostBtn'), 'the browser build offered a boost it cannot do');
});
