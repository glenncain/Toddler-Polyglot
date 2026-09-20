'use strict';

/* Leaving her session must be a full stop, not a screen that covers it.
   The bug this locks out: the grown-up panel slid over the top while the tablet
   went on speaking, went on listening to the room, and kept two timers armed to
   advance a card nobody could see.

   These are the same three readings the parent panel prints by hand after the fix:
   ear on, timers armed, still listening. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, intoTheMiddleOfACard } = require('./harness');

const BUILDS = [
  { name: 'browser build', bridge: false },
  { name: 'Android build', bridge: true },
];

function report(label, s) {
  return [
    label,
    '  speaking:   ' + (s.speaking ? 'yes' : 'no'),
    '  listening:  ' + (s.listening ? 'yes — the microphone is open' : 'no'),
    '  ear:        ' + (s.earOn ? 'on' : 'off'),
    '  timers:     ' + (s.armed.length ? s.armedDescribed.join(', ') : 'none armed'),
  ].join('\n');
}

/* Everything the session was holding is gone, and nothing it armed is still pending. */
function assertReleased(before, after) {
  const leftOver = after.armed.filter((id) => before.armed.includes(id));

  assert.strictEqual(after.speaking, false,
    'the voice is still speaking after she left the session');
  assert.strictEqual(after.listening, false,
    'the microphone is still open after she left the session');
  assert.strictEqual(after.earOn, false,
    'the ear is still showing, so the screen says she is being listened to');
  assert.deepStrictEqual(leftOver, [],
    'timers armed during the card are still pending: ' + after.armedDescribed.join(', '));
}

for (const build of BUILDS) {
  test(build.name + ': the grown-up panel stops her session', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    const before = await intoTheMiddleOfACard(app);
    assert.ok(before.speaking && before.listening && before.earOn && before.armed.length >= 2,
      'the card should be live before the panel opens, but it reads:\n' + report('', before));

    /* the real way in: press and hold the top-left corner for 1.6 seconds */
    app.$('gate').dispatchEvent(new app.win.Event('pointerdown'));
    await app.waitFor(() => app.$('parent').classList.contains('on'), 'the grown-up panel to open');

    const after = app.snapshot();
    t.diagnostic('\n' + report('before opening the panel:', before) + '\n' + report('after opening the panel:', after));
    assertReleased(before, after);
    assert.deepStrictEqual(app.problems, [], 'the page threw while the panel was opening');
  });

  test(build.name + ': the keyboard shortcut to the panel stops her session too', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    const before = await intoTheMiddleOfACard(app);
    app.win.document.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: 'p' }));
    await app.waitFor(() => app.$('parent').classList.contains('on'), 'the grown-up panel to open');

    const after = app.snapshot();
    t.diagnostic('\n' + report('before:', before) + '\n' + report('after:', after));
    assertReleased(before, after);
  });

  test(build.name + ': the end of the eleven minutes stops her session', async (t) => {
    const app = await openApp({ bridge: build.bridge });
    t.after(() => app.close());

    const before = await intoTheMiddleOfACard(app);
    app.win.finish();                              // the moon, the end of the day
    await app.waitFor(() => app.$('moon').classList.contains('on'), 'the moon to come up');

    const after = app.snapshot();
    t.diagnostic('\n' + report('before:', before) + '\n' + report('after:', after));
    assertReleased(before, after);
  });
}
