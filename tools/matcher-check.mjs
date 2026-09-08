/* Pins the speech matcher's behaviour, including the parts that are deliberately loose.
   HANDOFF.md says the matcher must stay forgiving and must not be tightened to make
   anything pass; this is what stops that happening by accident. Cases marked false are
   as important as the ones marked true.

   Needs playwright. From the repo root:
       node tools/matcher-check.mjs
   Exits non-zero on any failure, so it works in CI too. */

import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve('app/src/main/assets/index.html')).href;

/* [object, language, what the recogniser reported, should it count, why this case exists] */
const CASES = [
  ['shoe', 'ja', '靴 普通',                       true,  'ja-JP returns kanji; the data holds kana'],
  ['shoe', 'ja', 'くつ',                          true,  'hiragana, the written form in the data'],
  ['shoe', 'ja', 'kutsu',                         true,  'romaji, the spoken form in the data'],
  ['shoe', 'ja', 'tutu',                          true,  'a two-year-old saying kutsu. The brief names this one'],
  ['dog',  'ja', '犬',                            true,  'kanji, single character'],
  ['dog',  'ja', 'いぬ',                          true,  'kana still counts'],
  ['book', 'ja', '本を読む',                       true,  'the word inside a longer transcript'],
  ['sun',  'ja', '太陽',                          true,  'kanji, two characters'],
  ['shoe', 'en', 'shoe shoe shoe Shoe Show Shoe', true,  'repeats and mishearings around the word'],
  ['shoe', 'es', 'zapato zapato zapato za',       true,  'a truncated final repeat'],
  ['shoe', 'zh', '鞋鞋',                          true,  'hanzi, doubled'],
  ['shoe', 'ja', 'ねこ',                          false, 'a different word must not count'],
  ['shoe', 'ja', '',                              false, 'silence must not count'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(PAGE);
// top-level const does not land on globalThis, so probe the bindings themselves
await page.waitForFunction(() => typeof heard === 'function' && typeof ALL !== 'undefined' && ALL.length > 0);

const results = await page.evaluate(cs => cs.map(([obj, lang, txt, want, why]) => {
  const entry = ALL.find(a => a.obj === obj && a.lang === lang);
  if (!entry) return { obj, lang, txt, want, why, got: 'NO SUCH WORD' };
  return { obj, lang, txt, want, why, got: heard(txt, entry) };
}), CASES);

let failed = 0;
for (const r of results) {
  const ok = r.got === r.want;
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${r.lang}/${r.obj}  ${JSON.stringify(r.txt)} -> ${r.got}   ${r.why}`);
}
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} pass`);

await browser.close();
process.exit(failed ? 1 : 0);
