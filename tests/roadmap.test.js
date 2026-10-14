import test from "node:test";
import assert from "node:assert/strict";
import { createModel, createLayer, ensureKeyform, ensureCorrective, evaluateLayer, validateModel, parseModel, serializeModel } from "../src/model.js";
import { readZip, writeZip, crc32 } from "../src/archive.js";
import { exportProject, importProject } from "../src/project-file.js";
import { SnapshotPool } from "../src/project-store.js";
import { paintStroke } from "../src/art-editor.js";
import { parseTimedVisemes, timedVisemeShape } from "../src/audio-visemes.js";
import { trackingValues, trackingNeutral } from "../src/face-tracking.js";
import { parameterCommand } from "../src/control-api.js";

function layer(name="Left Eye Opening") { return createLayer({name,src:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",width:100,height:60}); }
test("one eye can wink without doubling the shared blink or moving the other eye",()=>{
  const m=createModel(),left=layer(),right=layer("Right Eye Opening");
  for(const l of [left,right])ensureKeyform(l,"eyes.blink",1).transform.scaleY=-1;
  assert.equal(evaluateLayer(left,{"eyes.blinkLeft":1},m.parameters).transform.scaleY,0);
  assert.equal(evaluateLayer(right,{"eyes.blinkLeft":1},m.parameters).transform.scaleY,1);
  assert.equal(evaluateLayer(left,{"eyes.blink":1,"eyes.blinkLeft":1,"eyes.squint":1},m.parameters).transform.scaleY,0);
});
test("combined-pose corrections vanish on either neutral axis and interpolate at corners",()=>{
  const m=createModel(),l=layer("Face");m.layers.push(l);
  ensureKeyform(l,"head.yaw",1).transform.x=10;
  const correction=ensureCorrective(l,{"head.yaw":1,"head.pitch":-1});correction.transform.x=20;correction.offsets[0]=8;
  assert.equal(ensureCorrective(l,{"head.pitch":-1,"head.yaw":1}),correction);
  assert.equal(evaluateLayer(l,{"head.yaw":1},m.parameters).transform.x,10);
  assert.equal(evaluateLayer(l,{"head.yaw":1,"head.pitch":1},m.parameters).transform.x,10);
  assert.equal(evaluateLayer(l,{"head.yaw":.5,"head.pitch":-.5},m.parameters).transform.x,10);
  assert.equal(evaluateLayer(l,{"head.yaw":1,"head.pitch":-1},m.parameters).transform.x,30);
  assert.deepEqual(validateModel(parseModel(serializeModel(m))),[]);
});
test("nested masks and groups validate; mask and group cycles are rejected",()=>{
  const m=createModel(),a=layer("A"),b=layer("B"),c=layer("C");m.layers=[a,b,c];a.clipMask=b.id;b.clipMask=c.id;
  m.groups=[{id:"g1",opacity:.5},{id:"g2",parent:"g1"}];a.group="g2";
  assert.deepEqual(validateModel(m),[]);
  c.clipMask=a.id;assert.match(validateModel(m).join(" "),/cyclic/);delete c.clipMask;
  m.groups[0].parent="g2";assert.match(validateModel(m).join(" "),/Cyclic group/);
});
test("ZIP checks CRCs and refuses path traversal, duplicates, and malformed data",async()=>{
  const input=new Map([["manifest.json","{}"],["assets/a.png",new Uint8Array([0,1,2,255])]]);
  const zip=writeZip(input),entries=await readZip(zip);
  assert.equal(new TextDecoder().decode(entries.get("manifest.json")),"{}");
  assert.deepEqual(entries.get("assets/a.png"),new Uint8Array([0,1,2,255]));
  assert.equal(crc32(new TextEncoder().encode("123456789")),0xcbf43926);
  const corrupt=zip.slice();corrupt[43]^=1;await assert.rejects(readZip(corrupt));
  assert.throws(()=>writeZip(new Map([["../outside",new Uint8Array()]])));
  await assert.rejects(readZip(new Uint8Array(4)));
});
test("binary project round-trips metadata, geometry, and deduplicated artwork",async()=>{
  const m=createModel("Portable"),a=layer(),b=layer("Right Eye Opening");m.layers=[a,b];
  const zip=await exportProject(m),entries=await readZip(await zip.arrayBuffer());
  assert.equal(entries.size,2);assert.equal(m.layers[0].source.type,"embedded");
  const restored=await importProject(zip);
  assert.deepEqual(restored,m);
  assert.deepEqual(await importProject(new Blob([serializeModel(m)])),m);
});
test("undo frames keep stable artwork references while retaining independent geometry",()=>{
  const pool=new SnapshotPool(),m=createModel(),a=layer();m.layers=[a];
  const before=pool.pack({model:m});a.mesh.vertices[0]=900;const after=pool.pack({model:m});
  assert.equal(pool.assets.size,1);assert.ok(!before.includes("base64"));
  assert.equal(pool.unpack(before).model.layers[0].mesh.vertices[0],-50);
  assert.equal(pool.unpack(after).model.layers[0].mesh.vertices[0],900);
});
test("ownership brushes cover continuous strokes and can erase only overrides",()=>{
  const mask=new Uint8Array(10000);paintStroke(mask,100,100,{x:5,y:50},{x:95,y:50},3,1);
  for(let x=5;x<=95;x++)assert.equal(mask[50*100+x],1);
  assert.equal(mask[0],0);paintStroke(mask,100,100,{x:50,y:50},{x:50,y:50},5,0);assert.equal(mask[5050],0);assert.equal(mask[5010],1);
});
test("timed audio follows seeks, closes bilabials, rounds vowels, and rests in gaps",()=>{
  const track=parseTimedVisemes({segments:[{viseme:"aa",t0:0,t1:100},{viseme:"PP",t0:100,t1:140},{viseme:"U",t0:140,t1:300},{viseme:"I",t0:500,t1:700}]});
  assert.equal(timedVisemeShape(track,120).open,0);
  assert.ok(timedVisemeShape(track,220).round>.8);
  assert.equal(timedVisemeShape(track,400).open,0);
  assert.ok(timedVisemeShape(track,70).open>.8); // seek backwards
  assert.ok(timedVisemeShape(track,600).form>.8);
  assert.equal(timedVisemeShape(track,800).open,0);
  assert.throws(()=>parseTimedVisemes({segments:[{viseme:"aa",t0:100,t1:50}]}));
  assert.throws(()=>parseTimedVisemes({segments:[{viseme:"bogus",t0:0,t1:50}]}));
  assert.equal(parseTimedVisemes({mouthCues:[{value:"A",start:.1,end:.2}]}).segments[0].viseme,"PP");
});
test("tracking calibration removes neutral bias and missing faces release the driver",()=>{
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const result={faceLandmarks:[[]],facialTransformationMatrixes:[{data:matrix}],faceBlendshapes:[{categories:[{categoryName:"eyeBlinkLeft",score:.9},{categoryName:"eyeBlinkRight",score:.1},{categoryName:"jawOpen",score:.4}]}]};
  const v=trackingValues(result);assert.equal(v["eyes.blinkLeft"],1);assert.equal(v["eyes.blinkRight"],0);assert.equal(v["mouth.open"],.4);
  const neutral=trackingNeutral(result);assert.equal(trackingValues(result,neutral)["mouth.open"],0);
  assert.equal(trackingValues({}),null);
});
test("local parameter commands clamp ranges and reject undeclared or nonfinite values",()=>{
  const m=createModel(),result=parameterCommand({type:"parameters",values:{"head.yaw":99,"mouth.open":NaN,bogus:1},holdMs:1e6},m.parameters);
  assert.deepEqual(result.values,{"head.yaw":1});assert.equal(result.holdMs,15000);
  assert.equal(parameterCommand({type:"speech"},m.parameters),null);
});
