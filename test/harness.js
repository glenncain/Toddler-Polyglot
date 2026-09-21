'use strict';

/* Loads app/src/main/assets/index.html into a DOM and watches the three things the
   child's session holds: the voice, the microphone, and every armed timer.
   The page is loaded exactly as it ships — one file, no build step, no fork — so the
   test breaks if someone quietly splits it into an Android-only copy. */

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PAGE = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'index.html');
const ORIGIN = 'https://appassets.androidplatform.net/index.html';

/* ── every timer the page arms, and whether it is still armed ──
   The panel bug was invisible precisely because the timers it left behind fired
   minutes later, with nobody looking at the screen they were driving. */
function spyOnTimers(win) {
  const live = new Set();
  const meta = new Map();
  const set = win.setTimeout.bind(win);
  const clear = win.clearTimeout.bind(win);
  const setI = win.setInterval.bind(win);
  const clearI = win.clearInterval.bind(win);

  win.setTimeout = (fn, delay, ...args) => {
    let id;
    id = set(() => { live.delete(id); if (typeof fn === 'function') fn(...args); }, delay);
    live.add(id);
    meta.set(id, { kind: 'timeout', delay: Number(delay) || 0 });
    return id;
  };
  win.clearTimeout = (id) => { live.delete(id); return clear(id); };
  win.setInterval = (fn, delay, ...args) => {
    const id = setI(fn, delay, ...args);
    live.add(id);
    meta.set(id, { kind: 'interval', delay: Number(delay) || 0 });
    return id;
  };
  win.clearInterval = (id) => { live.delete(id); return clearI(id); };

  return {
    armed: () => [...live],
    isArmed: (id) => live.has(id),
    describe: (ids) => ids.map((id) => {
      const m = meta.get(id) || { kind: '?', delay: 0 };
      return `${m.kind} ${m.delay}ms`;
    }),
    releaseAll: () => { for (const id of [...live]) clear(id); live.clear(); },
  };
}

/* ── the browser build: speechSynthesis and webkitSpeechRecognition ── */
function installWebSpeech(win) {
  const voices = ['en-US', 'es-ES', 'zh-CN', 'ja-JP'].map((lang) => ({ lang, name: 'test ' + lang }));
  const pending = [];
  const tts = {
    cancels: 0,
    said: [],
    get speaking() { return pending.length > 0; },
    /* the utterance runs to completion, the way a word she waited for does */
    finish() {
      const done = pending.splice(0);
      done.forEach((u) => { if (typeof u.onend === 'function') u.onend(); });
    },
  };

  win.SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) { this.text = text; };
  win.speechSynthesis = {
    onvoiceschanged: null,
    getVoices: () => voices,
    get speaking() { return pending.length > 0; },
    speak(u) { tts.said.push(u.text); pending.push(u); },
    /* a real cancel still fires end on whatever it cut off */
    cancel() {
      tts.cancels += 1;
      const cut = pending.splice(0);
      cut.forEach((u) => { if (typeof u.onend === 'function') u.onend(); });
    },
    pause() {}, resume() {},
  };

  const open = new Set();
  const asr = {
    starts: 0,
    stops: 0,
    get open() { return open.size > 0; },
  };
  function Recognition() { this.lang = ''; }
  Recognition.prototype.start = function () { asr.starts += 1; open.add(this); };
  Recognition.prototype.stop = function () { asr.stops += 1; open.delete(this); };
  Recognition.prototype.abort = function () { this.stop(); };
  win.webkitSpeechRecognition = Recognition;

  return { tts, asr };
}

/* ── the Android build: everything comes through AndroidBridge ── */
function installBridge(win) {
  const prefs = Object.create(null);
  const waiting = [];
  const open = { on: false };

  const tts = {
    hushes: 0,
    said: [],
    get speaking() { return waiting.length > 0; },
    finish() {
      const done = waiting.splice(0);
      done.forEach((id) => { if (typeof win.__ttsDone === 'function') win.__ttsDone(id, true); });
    },
  };
  const asr = {
    starts: 0,
    stops: 0,
    get open() { return open.on; },
  };

  win.AndroidBridge = {
    capabilities: () => JSON.stringify({
      platform: 'android', api: 35, device: 'test tablet', tts: true, asr: true,
      voices: { en: true, es: true, zh: true, ja: true },
    }),
    hasVoice: () => true,
    speak(text, langTag, reqId) { tts.said.push(text); waiting.push(reqId); },
    shutUp() { tts.hushes += 1; waiting.splice(0); },
    asrAvailable: () => true,
    startListening() { asr.starts += 1; open.on = true; },
    stopListening() { asr.stops += 1; open.on = false; },
    micBusyFor: () => 0,
    micProbe: () => JSON.stringify({ ok: true, peak: 0.7 }),
    recognizerInfo: () => JSON.stringify({ service: 'test', mic: 'granted' }),
    nativeCapture: () => true,
    levelStart: () => true,
    levelStop() {},
    recStart: () => true,
    recStop() {},
    prefGet: (k) => (k in prefs ? prefs[k] : null),
    prefSet: (k, v) => { prefs[k] = String(v); return true; },
    prefKeys: (p) => JSON.stringify(Object.keys(prefs).filter((k) => k.startsWith(p))),
    prefClear() { for (const k of Object.keys(prefs)) delete prefs[k]; },
    saveFile: () => '',
    copyToClipboard: () => true,
  };

  return { tts, asr };
}

async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* Opens the app the way the tablet does, and hands back the three watchers. */
async function openApp({ bridge = false } = {}) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const problems = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => problems.push(err));

  let speech = null;
  const dom = new JSDOM(html, {
    url: ORIGIN,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(win) {
      speech = bridge ? installBridge(win) : installWebSpeech(win);
      win.__timers = spyOnTimers(win);
    },
  });

  const win = dom.window;
  const timers = win.__timers;
  const $ = (id) => win.document.getElementById(id);

  /* boot() is async; the baby face is the last thing it paints */
  await waitFor(() => $('picture') && $('picture').textContent === '\u{1F476}', 'the app to boot');

  const app = {
    win, dom, timers, $,
    tts: speech.tts,
    asr: speech.asr,
    problems,
    waitFor,
    /* ear on, timers armed, still listening — the same three the panel check reads out */
    snapshot() {
      const armed = timers.armed();
      return {
        speaking: speech.tts.speaking,
        listening: speech.asr.open,
        earOn: $('ear').classList.contains('on'),
        armed,
        armedDescribed: timers.describe(armed),
      };
    },
    close() {
      timers.releaseAll();
      win.close();
    },
  };

  return app;
}

/* Gets her to the middle of a card: the word is playing again, the ear is open,
   and the two timers that drive the card are armed. */
async function intoTheMiddleOfACard(app) {
  app.$('begin').click();
  await waitFor(() => !app.$('parent').classList.contains('on'), 'the session to start');

  app.$('picture').click();                       // she taps the picture
  await waitFor(() => app.tts.speaking, 'the word to be spoken');
  app.tts.finish();
  await waitFor(() => app.tts.speaking, 'the word to be spoken a second time');
  app.tts.finish();
  await waitFor(() => app.$('ear').classList.contains('on'), 'the ear to open');

  app.$('picture').click();                       // she taps again: it says the word while listening
  await waitFor(() => app.tts.speaking, 'the repeat to start');

  return app.snapshot();
}

module.exports = { openApp, intoTheMiddleOfACard, waitFor, PAGE };
