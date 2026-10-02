import test from 'node:test';
import assert from 'node:assert/strict';
import { PuppetMotion } from '../src/motion.js';
import { createModel } from '../src/model.js';
import {
  VISEME_SHAPES,
  wordToVisemes,
  estimateWordTimings,
  buildVisemeTrack,
  sampleVisemeTrack,
  VisemeTalker,
} from '../src/viseme-lipsync.js';

test('spelling becomes the visemes a speaker would actually make',()=>{
  assert.deepEqual(wordToVisemes('hello'),['E','nn','O']);
  assert.deepEqual(wordToVisemes('you'),['I','O','U']);
  assert.deepEqual(wordToVisemes('the'),['TH','E']);
  assert.deepEqual(wordToVisemes('ship'),['CH','I','PP']);
  assert.deepEqual(wordToVisemes('photo'),['FF','O','DD','O']);
});

test('digraphs beat the single letters inside them',()=>{
  // TH is one sound, not DD followed by a breath.
  assert.deepEqual(wordToVisemes('think'),['TH','I','nn','kk']);
  assert.deepEqual(wordToVisemes('quick'),['kk','U','I','kk']);
  assert.deepEqual(wordToVisemes('school'),['SS','kk','U','nn']);
  // Longest match wins: OUGH is not OU + GH.
  assert.deepEqual(wordToVisemes('though'),['TH','O']);
});

test('silent letters and doubles do not each get their own mouth shape',()=>{
  assert.deepEqual(wordToVisemes('make'),['PP','aa','kk']);   // silent final E
  assert.deepEqual(wordToVisemes('time'),['DD','I','PP']);
  assert.deepEqual(wordToVisemes('ball'),['PP','aa','nn']);   // LL says one nn
  assert.deepEqual(wordToVisemes('knee'),['nn','E']);         // silent K
});

test('soft c and soft g follow the vowel after them',()=>{
  assert.deepEqual(wordToVisemes('city'),['SS','I','DD','I']);
  assert.deepEqual(wordToVisemes('cat'),['kk','aa','DD']);
  assert.deepEqual(wordToVisemes('gem'),['CH','E','PP']);
  assert.deepEqual(wordToVisemes('got'),['kk','O','DD']);
});

test('unspeakable input never throws and never returns nothing',()=>{
  assert.deepEqual(wordToVisemes(''),[]);
  assert.deepEqual(wordToVisemes('...'),[]);
  assert.deepEqual(wordToVisemes('42'),[]);
  assert.deepEqual(wordToVisemes('h'),['aa']);   // no pronounceable letters left
  assert.deepEqual(wordToVisemes('Zoë'),['SS','O','E']);
});

test('every viseme has a pose and a duration, and form stays bipolar',()=>{
  for(const [id,shape] of Object.entries(VISEME_SHAPES)) {
    assert.ok(shape.open>=0&&shape.open<=1,`${id} open in range`);
    assert.ok(shape.round>=0&&shape.round<=1,`${id} round in range`);
    assert.ok(shape.form>=-1&&shape.form<=1,`${id} form in range`);
  }
  // Rounded vowels narrow the lips, spread vowels widen them.
  assert.ok(VISEME_SHAPES.U.form<0&&VISEME_SHAPES.O.form<0);
  assert.ok(VISEME_SHAPES.I.form>0&&VISEME_SHAPES.E.form>0);
  assert.ok(VISEME_SHAPES.aa.open>VISEME_SHAPES.PP.open);
});

test('word timings grow with length and pause on punctuation',()=>{
  const t=estimateWordTimings('a longer word',20);
  assert.equal(t.words.length,3);
  assert.equal(t.times[0],0);
  assert.ok(t.durations[1]>t.durations[0],'longer spelling takes longer');
  assert.ok(t.times[1]>0&&t.times[2]>t.times[1],'starts are ordered');

  const plain=estimateWordTimings('stop now',20);
  const stopped=estimateWordTimings('stop. now',20);
  assert.ok(stopped.durations[0]>plain.durations[0],'a full stop adds a pause');
  assert.ok(estimateWordTimings('stop, now',20).durations[0]>plain.durations[0]);
});

test('a faster speaking rate produces a shorter utterance',()=>{
  const slow=estimateWordTimings('the quick brown fox',12);
  const fast=estimateWordTimings('the quick brown fox',24);
  assert.ok(fast.totalMs<slow.totalMs/1.8,'roughly halving the rate halves the time');
});

test('a track covers its words in order and stays inside their windows',()=>{
  const track=buildVisemeTrack('hello there',{charsPerSecond:18});
  assert.ok(track.segments.length>=6);
  for(let i=1;i<track.segments.length;i++) {
    assert.ok(track.segments[i].t0>=track.segments[i-1].t0,'segments are ordered');
  }
  // Each word's visemes finish before the next word starts.
  const secondWordStart=track.times[1];
  const firstWordSegments=track.segments.filter(s=>s.t0<secondWordStart);
  assert.ok(firstWordSegments[firstWordSegments.length-1].t1<=secondWordStart+1);
  assert.ok(track.totalMs>0&&track.totalMs<=track.times[1]+track.durations[1]);
});

test('supplied word timings are used instead of estimated ones',()=>{
  const timings={words:['hello'],times:[500],durations:[1000]};
  const track=buildVisemeTrack('hello',{timings});
  assert.equal(track.segments[0].t0,500,'honours the given start');
  assert.ok(track.totalMs<=1500&&track.totalMs>1200,'honours the given duration');
});

test('sampling a track walks through distinct mouth shapes',()=>{
  const track=buildVisemeTrack('hello',{charsPerSecond:15});
  const seen=new Set();
  for(let t=0;t<=track.totalMs;t+=10) {
    const shape=sampleVisemeTrack(track,t);
    if(shape)seen.add(`${shape.open}/${shape.round}/${shape.form}`);
  }
  assert.ok(seen.size>=3,'the mouth changes shape while speaking');
});

test('a finished track releases the mouth instead of pinning it',()=>{
  const track=buildVisemeTrack('hi',{charsPerSecond:15});
  assert.ok(sampleVisemeTrack(track,10),'speaking mid-track');
  assert.equal(sampleVisemeTrack(track,track.totalMs+1),null,'released after the end');
  assert.equal(sampleVisemeTrack(null,0),null);
  assert.deepEqual(sampleVisemeTrack(track,-50),VISEME_SHAPES.sil);
});

test('the talker reports poses against wall-clock time and then goes idle',()=>{
  const talker=new VisemeTalker({charsPerSecond:15});
  assert.equal(talker.speaking,false);
  assert.equal(talker.shapeAt(0),null);

  const track=talker.speak('hello there',{startMs:1000});
  assert.equal(talker.speaking,true);
  assert.ok(talker.shapeAt(1000+Math.round(track.totalMs/2)),'speaks in the middle');
  assert.equal(talker.shapeAt(1000+track.totalMs+50),null,'finishes');
  assert.equal(talker.speaking,false,'and clears itself');

  talker.speak('hello',{startMs:0});
  talker.stop();
  assert.equal(talker.shapeAt(10),null,'stop is immediate');
});

test('gain scales the mouth without leaving the parameter ranges',()=>{
  const loud=new VisemeTalker({charsPerSecond:15,gain:3});
  loud.speak('oh',{startMs:0});
  let checked=0;
  for(let t=0;t<400;t+=5) {
    const shape=loud.shapeAt(t);
    if(!shape)continue;
    checked++;
    assert.ok(shape.open<=1&&shape.open>=0);
    assert.ok(shape.round<=1&&shape.round>=0);
    assert.ok(shape.form<=1&&shape.form>=-1);
  }
  assert.ok(checked>0,'sampled something');
});


// --- integration: the track has to actually reach her mouth ---

function lcg(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// mouth.round is an optional parameter: createModel() ships mouth.open and
// mouth.form only, so a model has to declare it before motion will carry it.
function roundingModel() {
  const model = createModel();
  model.parameters['mouth.round'] = { id: 'mouth.round', name: 'Mouth Rounded', min: 0, max: 1, default: 0 };
  return model;
}

// Drive motion for `ms` and report how far the mouth travelled. The very first
// update has no elapsed time, so it returns an empty pose; skip those frames.
function driveMouth(drive, ms = 400) {
  const motion = new PuppetMotion({ random: lcg(17) });
  const model = createModel();
  const opens = [];
  for (let t = 0; t <= ms; t += 1000 / 60) {
    const pose = motion.update(t, model, { mouth: drive(t) });
    if (typeof pose['mouth.open'] === 'number') opens.push(pose['mouth.open']);
  }
  assert.ok(opens.length > 1, 'collected some frames');
  return { min: Math.min(...opens), max: Math.max(...opens), last: opens[opens.length - 1] };
}

test('a viseme track opens her mouth through motion.update',()=>{
  const talker=new VisemeTalker({charsPerSecond:15});
  talker.speak('wow hello',{startMs:0});
  const spoken=driveMouth(t=>talker.shapeAt(t),900);
  assert.ok(spoken.max>0.3,`viseme track drove the mouth open (peaked at ${spoken.max.toFixed(2)})`);

  const silent=driveMouth(()=>null,900);
  assert.ok(spoken.max>silent.max+0.2,'and noticeably more than the idle mouth alone');
});

test('the mouth drive still answers to its original microphone name',()=>{
  const motion=new PuppetMotion({random:lcg(17)});
  const model=createModel();
  let pose;
  for(let t=0;t<=400;t+=1000/60) {
    pose=motion.update(t,model,{microphone:{open:0.9,round:0.2,form:0.5}});
  }
  assert.ok(pose['mouth.open']>0.5,'microphone: still drives openness');
  assert.ok(pose['mouth.form']>0.2,'microphone: still drives form');
});

test('rounded and spread vowels reach her mouth as different poses',()=>{
  const hold=viseme=>{
    const motion=new PuppetMotion({random:lcg(17)});
    const model=roundingModel();
    let pose;
    for(let t=0;t<=500;t+=1000/60)pose=motion.update(t,model,{mouth:VISEME_SHAPES[viseme]});
    return pose;
  };
  const oo=hold('U'),ee=hold('I');
  assert.ok(oo['mouth.round']>ee['mouth.round'],'"oo" is the rounder mouth');
  assert.ok(ee['mouth.form']>oo['mouth.form'],'"ee" is the wider mouth');
});
