'use strict';

/* Leaving her session must be a full stop, not a screen that covers it.
   The bug this locks out: the grown-up panel slid over the top while the tablet
   went on speaking, went on listening to the room, and kept two timers armed to
   advance a card nobody could see. The same hole was on every other way out.

   These are the same three readings the parent panel prints by hand:
   ear on, timers armed, still listening. */

const test = require('node:test');
const assert = require('node:assert');
const { openApp, intoTheMiddleOfACard } = require('./harness');

const BUILDS = [
  { name: 'browser build', bridge: false },
  { name: 'Android build', bridge: true },
];

/* Every way her session can end, and how to take it. */
const EXITS = [
  {
    name: 'the grown-up panel, held open at the corner',
    leave: (app) => app.$('gate').dispatchEvent(new app.win.Event('pointerdown')),
    /* the hold is 1.6 seconds before the panel comes up */
    settled: (app) => app.$('parent').classList.contains('on'),
    settledIs: 'the grown-up panel to open',
  },
  {
    name: 'the keyboard shortcut to the panel',
    leave: (app) => app.win.document.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: 'p' })),
    settled: (app) => app.$('parent').classList.contains('on'),
    settledIs: 'the grown-up panel to open',
  },
  {
    name: 'another app taking the foreground',
    leave: (app) => {
      Object.defineProperty(app.win.document, 'hidden', { get: () => true, configurable: true });
      app.win.document.dispatchEvent(new app.win.Event('visibilitychange'));
    },
  },
  {
    name: 'the window losing focus',
    leave: (app) => app.win.dispatchEvent(new app.win.Event('blur')),
  },
  {
    name: 'the tab or the app going away',
    leave: (app) => app.win.dispatchEvent(new app.win.Event('pagehide')),
  },
  {
    name: 'the eleven minutes running out',
    leave: (app) => app.win.finish(),
    settled: (app) => app.$('moon').classList.contains('on'),
    settledIs: 'the moon to come up',
  },
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
  for (const exit of EXITS) {
    test(build.name + ': ' + exit.name + ' stops her session', async (t) => {
      const app = await openApp({ bridge: build.bridge });
      t.after(() => app.close());

      const before = await intoTheMiddleOfACard(app);
      assert.ok(before.speaking && before.listening && before.earOn && before.armed.length >= 2,
        'the card should be live before she leaves, but it reads:\n' + report('', before));

      exit.leave(app);
      if (exit.settled) await app.waitFor(() => exit.settled(app), exit.settledIs);

      const after = app.snapshot();
      t.diagnostic('\n' + report('before:', before) + '\n' + report('after:', after));
      assertReleased(before, after);
      assert.deepStrictEqual(app.problems, [], 'the page threw on the way out');
    });
  }
}
