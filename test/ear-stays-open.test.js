'use strict';

/* "I have to repeat the same word many times before the tablet picks it up."

   Android's recogniser hears one utterance and then stops: it hands back its final guess
   and closes, with no error. The browser recogniser runs continuously and is restarted
   when it ends, but the Android build had no way to know a listen had finished, so the
   first thing she said that was not quite the word shut the ear for the rest of the card.
   The ring kept breathing, nothing was listening, and only the quiet repeat at 7s (and a
   tap after that) opened the microphone again. Everything she said in between went
   nowhere, and a card nobody heard is marked missed at 19s.

   The bridge now reports the end of a listen with window.__asrEnd(seq), in the same call
   as the final result, and the card listens again. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, intoTheMiddleOfACard, waitFor } = require('./harness');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* What MainActivity's recogniser does after one utterance: the final guess, then done. */
function finalResult(app, text) {
  app.asr.ended();
  app.win.__asrHeard(text, undefined);
  if (typeof app.win.__asrEnd === 'function') app.win.__asrEnd(undefined);
}

test('Android build: a guess that is not the word does not close the ear for the card', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  const starts = app.asr.starts;

  finalResult(app, 'zzzz');                         // she said something it could not match
  await waitFor(() => app.asr.open, 'the microphone to open again without a tap', 1500);

  assert.strictEqual(app.asr.starts, starts + 1, 'expected exactly one new listen');
  assert.ok(app.$('ear').classList.contains('on'), 'the ring went out while it was listening');
  assert.ok(!app.tts.speaking, 'it re-opened by saying the word again, not by listening');
});

test('Android build: the word heard on the second try advances the card', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  const word = app.tts.said[app.tts.said.length - 1];

  finalResult(app, 'zzzz');
  await waitFor(() => app.asr.open, 'the second listen', 1500);
  finalResult(app, word);                            // she says it again, clearly this time
  await waitFor(() => app.$('picture').classList.contains('said'), 'the card to count it');
});

test('Android build: a listen that ends after the card is said does not reopen the mic', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'listening');
  const word = app.tts.said[app.tts.said.length - 1];
  finalResult(app, word);                            // heard: the card is on its way out
  const starts = app.asr.starts;
  await pause(600);
  assert.strictEqual(app.asr.starts, starts, 'the old card\'s listen came back after it was heard');
});

test('Android build: an end from an older listen is ignored', async (t) => {
  const app = await openApp({ bridge: true });
  t.after(() => app.close());

  await intoTheMiddleOfACard(app, 'speaking');      // she tapped: the ear is shut, the word plays
  const starts = app.asr.starts;
  app.win.__asrEnd && app.win.__asrEnd(undefined);  // the listen it replaced finally reports in
  await pause(500);
  assert.strictEqual(app.asr.starts, starts, 'the microphone opened while the tablet was talking');
});
