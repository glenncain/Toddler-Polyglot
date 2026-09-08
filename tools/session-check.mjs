/* The two faults reported from real use, pinned so they cannot come back:

     - a card advancing on its own, because a previous card's recogniser was still
       pushing results into the single callback slot the page keeps
     - the microphone going dead mid-card, because nothing put the recogniser back
       after it stopped listening

   The card must not advance until it hears her, so both of these are the difference
   between the app working and a three-year-old standing in front of a picture that
   ignores her. Needs playwright. From the repo root:
       node tools/session-check.mjs
*/

import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(() => {
  const kv = {};
  window.__mock = { starts: [] };
  let seq = 0;
  window.AndroidBridge = {
    capabilities:()=>JSON.stringify({platform:'android',api:35,device:'T',tts:true,asr:true,
      voices:{en:true,es:true,zh:true,ja:true}}),
    nativeCapture:()=>true, micBusyFor:()=>0, micProbe:()=>JSON.stringify({ok:true,peak:0.5}),
    recognizerInfo:()=>JSON.stringify({package:'x',mic:'granted',available:true}),
    hasVoice:()=>true, asrAvailable:()=>true,
    speak:(t,l,id)=>setTimeout(()=>window.__ttsDone&&window.__ttsDone(id,true),5), shutUp:()=>{},
    startListening:(lang)=>{ seq++; window.__mock.starts.push({seq,lang}); return seq; },
    stopListening:()=>{},
    levelStart:()=>true, levelStop:()=>{}, recStart:()=>true, recStop:()=>{},
    prefGet:k=>(k in kv?kv[k]:null), prefSet:(k,v)=>{kv[k]=v;return true;},
    prefKeys:pre=>JSON.stringify(Object.keys(kv).filter(k=>k.startsWith(pre))), prefClear:()=>{},
    saveFile:()=>'/x', copyToClipboard:()=>true,
  };
});
await p.goto(pathToFileURL(resolve('app/src/main/assets/index.html')).href);
await p.waitForFunction(()=>typeof listen==='function');

const r = await p.evaluate(async () => {
  const out = {};
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const shoeEn = ALL.find(a=>a.obj==='shoe'&&a.lang==='en');
  const cupEn  = ALL.find(a=>a.obj==='cup' &&a.lang==='en');

  // pretend a card is on screen
  const setCard = e => { ended=false; busy=false; queue=[e]; idx=0; };

  // 1. the live listen advances on the right word
  setCard(shoeEn);
  let hits = 0; unlisten(); listen(shoeEn, ()=>hits++);
  const liveSeq = asrWant;
  window.__asrHeard('shoe', liveSeq);
  out.livePasses = hits === 1;

  // 2. a result stamped with an older listen must be ignored
  hits = 0;
  window.__asrHeard('shoe', liveSeq - 1);
  out.staleIgnored = hits === 0;

  // 3. the real bug: previous card's transcript arriving after a new card started
  setCard(cupEn);
  unlisten();                       // advance() does this
  let cupHits = 0;
  listen(cupEn, ()=>cupHits++);
  window.__asrHeard('cup', liveSeq);        // old card's recogniser, still talking
  out.previousCardCannotAdvance = cupHits === 0;
  window.__asrHeard('cup', asrWant);        // the current listen
  out.currentCardStillWorks = cupHits === 1;

  // 4. a recogniser that dies mid-card is put back
  setCard(shoeEn);
  unlisten();
  window.__mock.starts.length = 0;
  listen(shoeEn, ()=>{});
  const armed = asrWant;
  window.__asrError('no-response', false, true, false, armed);
  await sleep(400);
  out.reArmedAfterFailure = window.__mock.starts.length === 2;

  // 5. once the card is gone, it stops re-arming
  window.__mock.starts.length = 0;
  const dead = asrWant;
  busy = true;                                   // advance() ran
  window.__asrError('no-response', false, true, false, dead);
  await sleep(400);
  out.stopsWhenCardGone = window.__mock.starts.length === 0;
  return out;
});

let bad = 0;
for (const [k,v] of Object.entries(r)) { if (!v) bad++; console.log(`${v?'pass':'FAIL'}  ${k}`); }
console.log('pageerrors:', errs.length?errs:'none');
console.log(bad ? `\n${bad} FAILED` : '\nall pass');
await b.close();
process.exit(bad?1:0);
