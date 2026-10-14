import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayer,createModel,ensureKeyform,validateModel,serializeModel,parseModel } from '../src/model.js';
import { bindParent,evaluateScene,sceneToLayer } from '../src/scene.js';
import { validateRegions } from '../src/layered-rig.js';
import { speechShape } from '../src/speech.js';
import { PuppetMotion } from '../src/motion.js';
const layer=name=>createLayer({name,src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',width:100,height:100,columns:2,rows:2});
function rig(){const m=createModel(),body=layer('body'),head=layer('head'),eye=layer('eye');m.layers=[body,head,eye];bindParent(head,body);bindParent(eye,head);return {m,body,head,eye};}

test('nested parent transforms compose and subsequent cage edits propagate',()=>{
 const {m,body,head,eye}=rig();
 ensureKeyform(body,'body.sway',1).transform.x=20;
 ensureKeyform(head,'head.pitch',1).transform.y=10;
 const values={'body.sway':1,'head.pitch':1};
 let pose=evaluateScene(m,values).get(eye.id);
 assert.deepEqual(pose.vertices.slice(0,2),[-30,-40]);
 head.mesh.vertices[0]+=5;
 pose=evaluateScene(m,values).get(eye.id);
 assert.deepEqual(pose.vertices.slice(0,2),[-25,-40]);
 const point=sceneToLayer(eye,-25,-40,m,values);
 assert.ok(Math.abs(point[0]+50)<1e-8 && Math.abs(point[1]+50)<1e-8);
});
test('child local scale composes before parent movement',()=>{
 const {m,body,eye}=rig();eye.transform.scaleY=.2;body.transform.rotation=Math.PI/2;
 const pose=evaluateScene(m,{}).get(eye.id);
 assert.ok(Math.abs(pose.vertices[0]-10)<1e-8);
 assert.ok(Math.abs(pose.vertices[1]+50)<1e-8);
});
test('hierarchy and clips round-trip; cycles and missing references are rejected',()=>{
 const {m,body,head,eye}=rig();eye.clipMask=head.id;
 assert.deepEqual(validateModel(m),[]);
 assert.equal(parseModel(serializeModel(m)).layers[2].parent.id,head.id);
 bindParent(body,eye);
 assert.ok(validateModel(m).some(x=>x.includes('cyclic')));
 delete body.parent;eye.clipMask='missing';
 assert.ok(validateModel(m).some(x=>x.includes('clipping')));
 head.parent.id='missing';assert.ok(validateModel(m).some(x=>x.includes('missing parent')));
});
test('legacy version one models still load',()=>{const m=createModel();m.version=1;assert.equal(parseModel(serializeModel(m)).version,1);});
test('placement refuses nonfinite, missing, or off-canvas rectangles',()=>{
 const regions=Object.fromEntries(['face','leftEye','rightEye','mouth','bangs','leftHair','rightHair','backHair'].map(x=>[x,{x:0,y:0,width:10,height:10}]));
 assert.equal(validateRegions(regions,100,100),regions);
 regions.face.x=NaN;assert.throws(()=>validateRegions(regions,100,100));
 regions.face.x=99;assert.throws(()=>validateRegions(regions,100,100));
});
test('speech gates silence and distinguishes low and high spectral energy',()=>{
 const quiet=new Uint8Array(1024).fill(128),tone=Uint8Array.from({length:1024},(_,i)=>128+Math.round(20*Math.sin(i)));
 const low=new Float32Array(512).fill(-100),high=low.slice();low[10]=-10;high[50]=-10;
 assert.deepEqual(speechShape(quiet,low,48000,1024),{open:0,round:0,form:0});
 const a=speechShape(tone,low,48000,1024),b=speechShape(tone,high,48000,1024);
 assert.ok(a.round>b.round && a.form<b.form && a.open>0);
});
test('linked spring stages lag and remain stable across display rates',()=>{
 function run(fps){const m=createModel();m.parameters.tip={id:'tip',min:-1,max:1,default:0};m.physics.push({input:'hair.motion',output:'tip',strength:1,frequency:1.4,damping:.6});const motion=new PuppetMotion({random:(()=>{let s=23;return()=>(s=(s*1103515245+12345)%2147483648)/2147483648;})()});for(let i=0;i<=fps*1;i++)motion.update(i*1000/fps,m);return motion.pose;}
 const a=run(30),b=run(144);assert.ok(Math.abs(a.tip-b.tip)<1e-9);assert.ok(Math.abs(a.tip-a['hair.motion'])>.001);
});
