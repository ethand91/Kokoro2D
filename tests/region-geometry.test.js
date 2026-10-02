import test from 'node:test';
import assert from 'node:assert/strict';
import { seedContour, setRegionBounds, updateContourBounds, regionContains, validContour, fitContourToEdges, eyeProfile, addRegionContours } from '../src/region-geometry.js';
import { validateRegions, fitRegions } from '../src/layered-rig.js';

const shape=()=>({x:20,y:20,width:60,height:30});
test('outlines exclude pixels inside a bounding box but outside the drawn shape',()=>{
  const r=shape();r.contour=seedContour('leftEye',r);
  assert.equal(regionContains(r,21,21),false);
  assert.equal(regionContains(r,50,35),true);
  assert.equal(regionContains({...r,contour:undefined},21,21),true);
  assert.ok(validContour(r.contour,100,100));
});
test('moving, resizing, and fitting bounds carry contour points with them',()=>{
  const r=shape();r.contour=seedContour('face',r);const before=structuredClone(r);
  setRegionBounds(r,{x:40,y:10,width:120,height:60});
  for(let i=0;i<r.contour.length;i++)assert.deepEqual(r.contour[i],[40+(before.contour[i][0]-20)*2,10+(before.contour[i][1]-20)*2]);
  fitRegions({face:r},100,100);
  assert.ok(validContour(r.contour,100,100));
  updateContourBounds(r);assert.equal(r.width,60);
});
test('crossed, degenerate, nonfinite, and out-of-image outlines are rejected',()=>{
  for(const points of [ [[0,0],[10,10],[0,10],[10,0]], [[1,1],[2,2],[3,3]], [[0,0],[10,0],[NaN,10]], [[-1,0],[10,0],[5,10]], [[0,0],[10,0],[10,0],[0,10]] ])assert.equal(validContour(points,100,100),false);
  const regions=addRegionContours(Object.fromEntries(['face','leftEye','rightEye','mouth'].map(name=>[name,shape()])));
  assert.equal(validateRegions(regions,100,100,{faceOnly:true}),regions);
  regions.leftEye.contour=[[20,20],[80,50],[20,50],[80,20]];
  assert.throws(()=>validateRegions(regions,100,100,{faceOnly:true}),/crossed/);
});
test('tilted eyelids close along their corners instead of a horizontal midline',()=>{
  const r={x:10,y:10,width:40,height:25,contour:[[10,25],[30,10],[50,15],[30,35]]};
  const a=eyeProfile(r,.25),b=eyeProfile(r,.75);
  assert.ok(a.closed>b.closed);
  assert.ok(a.upper<a.closed&&a.closed<a.lower);
  assert.ok(b.upper<b.closed&&b.closed<b.lower);
});
test('edge fitting reduces boundary error on a known feature and leaves flat artwork alone',()=>{
  const r={x:20,y:20,width:80,height:40},width=120,height=80;
  const data=new Uint8ClampedArray(width*height*4);
  // Draw a slightly smaller almond than the initial estimate.
  const truth=seedContour('leftEye',{x:24,y:22,width:72,height:36});
  const inside={...r,contour:truth};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const color=regionContains(inside,x,y)?35:230;
    data.set([color,color,color,255],(y*width+x)*4);
  }
  const seed=seedContour('leftEye',r),fitted=fitContourToEdges({width,height,data},r,'leftEye');
  const error=points=>points.reduce((sum,p,i)=>sum+Math.hypot(p[0]-truth[i][0],p[1]-truth[i][1]),0)/points.length;
  assert.ok(error(fitted)<error(seed)*.75,`boundary error: ${error(seed)} → ${error(fitted)}`);
  assert.ok(validContour(fitted,width,height));
  data.fill(230);
  assert.deepEqual(fitContourToEdges({width,height,data},r,'leftEye'),seed);
});

test('reset recovers a closed mouth collapsed to a line, including at the image edge',async()=>{
  const {resetRegionContour,contourProblem,mouthOpeningRegion}=await import('../src/region-geometry.js');
  const r={x:50,y:99,width:40,height:0,sourceClosed:true,contour:[[50,99],[70,99],[90,99]]};
  assert.match(contourProblem(r.contour,100,100),/flattened/);
  resetRegionContour('mouth',r,100,100);
  assert.ok(validContour(r.contour,100,100));
  assert.ok(r.height>=2&&r.y+r.height<=100);
  const original=structuredClone(r),opening=mouthOpeningRegion(r,100);
  assert.deepEqual(r,original,'opening must not enlarge the source skin-repair patch');
  assert.ok(opening.height>=r.width*.45);
  assert.ok(opening.y+opening.height<=100);
  assert.ok(validContour(opening.contour,100,100));
});

test('closed-mouth mode repairs crossed or collapsed outlines but preserves valid edits',async()=>{
  const {recoverClosedMouth}=await import('../src/region-geometry.js');
  const r={x:20,y:20,width:40,height:10,sourceClosed:true,contour:[[20,20],[60,30],[20,30],[60,20]]};
  const ordinary=structuredClone(r);ordinary.sourceClosed=false;
  assert.equal(recoverClosedMouth(ordinary,100,100),false);
  assert.equal(recoverClosedMouth(r,100,100),true);
  assert.ok(validContour(r.contour,100,100));
  assert.deepEqual([r.x,r.y,r.width,r.height],[20,20,40,10]);
  const valid=structuredClone(r);
  assert.equal(recoverClosedMouth(r,100,100),false);
  assert.deepEqual(r,valid);
  r.height=0;r.contour=[[20,20],[40,20],[60,20]];
  assert.equal(recoverClosedMouth(r,100,100),true);
  assert.ok(r.height>=2&&validContour(r.contour,100,100));
  r.x=NaN;
  assert.equal(recoverClosedMouth(r,100,100),false,'unknown placement still needs correction');
});
