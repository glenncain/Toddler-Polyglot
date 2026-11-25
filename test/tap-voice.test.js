'use strict';

process.env.TZ = 'America/New_York';   // see the last test: the day must be local

/* "Sometimes when I tap, the voice does not happen."

   A tap used to be dropped, silently, whenever the page still thought something was being
   said: say() returned at once if a previous saying had not settled yet. The picture
   bounced (that runs on touch), nothing was spoken, and the microphone opened anyway —
   sometimes while the tablet was still talking, so it could hear itself. Each test below
   is one way a tap reached that state. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, intoTheMiddleOfACard, waitFor } = require('./harness');

const BUILDS = [
  { name: 'browser build', bridge: false },
  { name: 'Android build', bridge: true },
];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* Watches, for a while, whether the microphone is ever open while the tablet is talking. */
async function micOverVoice(app, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (app.tts.speaking && app.asr.open) return true;
    await pause(5);
  }
  return false;
}

for (const build of BUILDS) {
  test(build.name + ': a tap while the word is still playing says it again', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    await intoTheMiddleOfACard(app, 'speaking');      // the repeat is playing now
    const before = app.tts.said.length;
    app.$('picture').click();                         // she taps again before it finishes
    await pause(50);

    assert.strictEqual(app.tts.said.length, before + 1, 'the tap was swallowed: nothing new was said');
    assert.ok(!(await micOverVoice(app, 300)), 'the microphone opened while the tablet was still talking');

    app.tts.finish();
    await waitFor(() => app.asr.open, 'the ear to open once the word is done');
  });

  test(build.name + ': the first tap on a new card speaks, even if the last word was cut off', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    await intoTheMiddleOfACard(app, 'speaking');      // a word is mid-air
    const first = app.tts.said[app.tts.said.length - 1];
    /* the grown-up marks it said while the tablet is still talking */
    app.win.document.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: 'Enter' }));
    await waitFor(() => app.$('picture').classList.contains('invite'), 'the next card');
    const before = app.tts.said.length;

    app.$('picture').click();                         // her first tap on the new card
    await pause(50);

    assert.strictEqual(app.tts.said.length, before + 1, 'the new card stayed silent on her tap');
    assert.notStrictEqual(app.tts.said[app.tts.said.length - 1], first, 'it said the old card\'s word');
  });

  test(build.name + ': a tap between cards does not say the next word over the old picture', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    await intoTheMiddleOfACard(app, 'listening');
    const before = app.tts.said.length;
    app.win.document.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: 'Enter' }));
    app.$('picture').click();                         // in the 0.6s the old picture bounces
    await pause(50);

    assert.strictEqual(app.tts.said.length, before, 'a word was said before its picture was on screen');
  });

  test(build.name + ': stopping the ear for a repeat keeps it stopped until the word is done', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    await intoTheMiddleOfACard(app, 'listening');
    if (build.bridge) {
      /* the recogniser timed out on silence, as it does every few seconds; the page
         re-arms it a quarter of a second later */
      app.win.__asrError('no-match', true, true, false);
    }
    app.$('picture').click();                         // she taps inside that quarter second
    await waitFor(() => app.tts.speaking, 'the repeat to start');

    assert.ok(!(await micOverVoice(app, 500)), 'the microphone came back on while the tablet was talking');
  });
}

/* The day count and the streak used to be dated with toISOString(), which is UTC. West of
   London an evening session lands on tomorrow's date, so a morning run and an evening run
   on the same day counted as two days: two days' worth of new words, and a streak that
   jumped. Run here as 11:30pm in New York, which is already the next day in UTC. */
test('an evening session is dated today, not tomorrow', async (t) => {
  const app = await openApp({ bridge: false });
  t.after(() => app.close());

  const Real = app.win.Date;
  let now = new Real('2026-11-14T04:30:00Z').getTime();     // 11:30pm on the 13th in New York
  class Clock extends Real {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  app.win.Date = Clock;

  app.$('begin').click();
  await waitFor(() => !app.$('parent').classList.contains('on'), 'the session to start');
  now += 12 * 60 * 1000;                                      // past the eleven minutes
  app.win.document.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: 'Enter' }));
  await waitFor(() => app.$('moon').classList.contains('on'), 'the session to finish');

  const saved = JSON.parse(app.win.localStorage.getItem('em:state'));
  assert.strictEqual(saved.lastDate, '2026-11-13', 'the session was dated ' + saved.lastDate);
});
