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
const b = await chromium.launch({ args:['--autoplay-policy=no-user-gesture-required'] });
const p = await (await b.newContext()).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(() => {
  const kv = {};
  window.__mock = { starts: [] };
  let seq = 0, live = null;
  window.AndroidBridge = {
    capabilities:()=>JSON.stringify({platform:'android',api:35,device:'T',tts:true,asr:true,
      voices:{en:true,es:true,zh:true,ja:true}}),
    nativeCapture:()=>true, micBusyFor:()=>0, micProbe:()=>JSON.stringify({ok:true,peak:0.5}),
    recognizerInfo:()=>JSON.stringify({package:'x',mic:'granted',available:true}),
    hasVoice:()=>true, asrAvailable:()=>true,
    /* Android speaks with QUEUE_FLUSH: a new utterance drops the one in flight and the
       dropped one never reports back. Anything less faithful hides the stall below. */
    speak:(t,l,id)=>{ live=id; setTimeout(()=>{ if(live===id) window.__ttsDone&&window.__ttsDone(id,true); },300); },
    shutUp:()=>{},
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

  // 5a. a tap during the opening playback must not leave the ear shut.
  //     Interrupting a clip used to leave say() awaiting a promise that never settled,
  //     so heard0 stopped one line before it opened the microphone.
  setCard(shoeEn);
  unlisten(); cardHit=null; $('ear').classList.remove('on');
  window.__mock.starts.length = 0;
  heard0(shoeEn);                                  // not awaited: she taps while it talks
  await sleep(60);
  $('picture').onclick();                          // the tap
  await sleep(1400);
  out.earOpensDespiteTapDuringPlayback =
    $('ear').classList.contains('on') && window.__mock.starts.length > 0;

  // 5b. the app must not be listening while it speaks, or it hears itself say the word
  //     and gives her the tick for it
  setCard(shoeEn);
  cardHit = ()=>{};
  openEar(shoeEn);
  const listeningBefore = asrWant !== -1;
  const speech = replay(shoeEn, 1);
  out.deafWhileSpeaking = listeningBefore && asrWant === -1;
  await speech;
  out.listensAgainAfterSpeaking = asrWant !== -1;

  // 5c. a tap while the app is speaking must not delay the ear. Tapping used to flush
  //      the utterance in flight, and the flushed one never reported done, so say() sat
  //      on its six-second timeout with the microphone shut.
  setCard(shoeEn);
  ended=false; busy=false; tapped=false; cardHit=null;
  $('ear').classList.remove('on');
  const t0 = Date.now();
  heard0(shoeEn);
  await sleep(80);
  $('picture').onclick();
  let waited = 'never';
  for (let i=0;i<80;i++){ if($('ear').classList.contains('on')){ waited = Date.now()-t0; break; } await sleep(100); }
  out.earOpensPromptlyAfterTapWhileSpeaking = typeof waited === 'number' && waited < 2500;

  // 5d. an interrupted recording must still settle the promise say() is waiting on
  const wav = (()=>{                                   // 1.2s of silence, built here
    const sr=8000, n=sr*1.2, buf=new Uint8Array(44+n*2), dv=new DataView(buf.buffer);
    const tag=(o,s)=>{ for(let i=0;i<s.length;i++) buf[o+i]=s.charCodeAt(i); };
    tag(0,'RIFF'); dv.setUint32(4,36+n*2,true); tag(8,'WAVEfmt ');
    dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
    dv.setUint32(24,sr,true); dv.setUint32(28,sr*2,true); dv.setUint16(32,2,true);
    dv.setUint16(34,16,true); tag(36,'data'); dv.setUint32(40,n*2,true);
    let bin=''; for(const b of buf) bin+=String.fromCharCode(b);
    return 'data:audio/wav;base64,'+btoa(bin);
  })();
  let settled = false;
  playClip(wav).then(()=>{ settled = true; });
  await sleep(200);
  playClip(wav);                                       // something else speaks over it
  await sleep(700);
  out.interruptedClipStillSettles = settled;

  // 6. once the card is gone, it stops re-arming
  setCard(shoeEn); unlisten(); listen(shoeEn, ()=>{});
  window.__mock.starts.length = 0;
  const dead = asrWant;
  busy = true;                                   // advance() ran
  window.__asrError('no-response', false, true, false, dead);
  await sleep(400);
  out.stopsWhenCardGone = window.__mock.starts.length === 0;
  return out;
});

// the parent's two buttons line the whole bottom edge of her screen; a brush must not count
const holdCases = await (async () => {
  await p.evaluate(() => { ended=false; busy=false; queue=[ALL[0]]; idx=0; });
  await p.dispatchEvent('#yes', 'pointerdown');
  await p.waitForTimeout(120);
  await p.dispatchEvent('#yes', 'pointerup');
  await p.waitForTimeout(500);
  const brushed = await p.evaluate(() => busy);

  await p.evaluate(() => { ended=false; busy=false; queue=[ALL[0]]; idx=0; });
  await p.dispatchEvent('#yes', 'pointerdown');
  await p.waitForTimeout(600);
  const held = await p.evaluate(() => busy);
  await p.dispatchEvent('#yes', 'pointerup');
  return { brushIgnored: brushed === false, deliberatePressWorks: held === true };
})();
Object.assign(r, holdCases);

let bad = 0;
for (const [k,v] of Object.entries(r)) { if (!v) bad++; console.log(`${v?'pass':'FAIL'}  ${k}`); }
console.log('pageerrors:', errs.length?errs:'none');
console.log(bad ? `\n${bad} FAILED` : '\nall pass');
await b.close();
process.exit(bad?1:0);
