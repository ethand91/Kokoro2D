import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayer, createModel, evaluateLayer, defaultParameterValues, ensureKeyform } from '../src/model.js';
import { authorAnimeMouth } from '../src/anime-mouth.js';
import { mouthOpeningRegion } from '../src/region-geometry.js';
import { PuppetMotion } from '../src/motion.js';

function fixture() {
  const source={x:20,y:30,width:80,height:18,sourceClosed:true,contour:[[20,30],[60,46],[100,30],[60,48]]};
  const opening=mouthOpeningRegion(source,200);
  const mouth=createLayer({name:'Mouth',src:'',width:opening.width,height:opening.height,columns:10,rows:6});
  const lips=createLayer({name:'Lips',src:'',width:80,height:18});
  ensureKeyform(lips,'mouth.open',.2).transform.opacity=-1;
  authorAnimeMouth(mouth,lips,source,opening,1);
  const model=createModel();
  model.parameters['mouth.round']={id:'mouth.round',min:0,max:1,default:0};
  const pose=(open,extra={})=>evaluateLayer(mouth,{...defaultParameterValues(model),'mouth.open':open,...extra},model.parameters);
  return {source,opening,mouth,lips,model,pose};
}

function middleColumn(f, pose) {
  const ys=[];
  for(let i=0;i<f.mouth.mesh.uvs.length;i+=2)if(Math.abs(f.mouth.mesh.uvs[i]-.5)<.001)ys.push(pose.vertices[i+1]);
  return [Math.min(...ys),Math.max(...ys)];
}

test('closed anime smiles open into a cavity from the drawn curved lip line',()=>{
  const f=fixture(),rest=f.pose(0),mid=f.pose(.3),full=f.pose(1);
  assert.equal(rest.transform.opacity,0);
  assert.equal(f.pose(.06).transform.opacity,1);
  assert.equal(evaluateLayer(f.lips,{'mouth.open':.06},f.model.parameters).transform.opacity,0);
  const [r0,r1]=middleColumn(f,rest),[m0,m1]=middleColumn(f,mid),[f0,f1]=middleColumn(f,full);
  assert.ok(f1-f0>f.opening.height*.9,'thin source contour must not limit cavity height');
  assert.ok(m1-m0<(f1-f0)*.3,'quiet syllables should stay small');
  assert.ok(f1-r1>2*(r0-f0),'lower jaw travels farther than the upper lip');
  for(let i=0;i<rest.vertices.length;i+=2){
    const u=f.mouth.mesh.uvs[i];
    const seam=30+4*u*(1-u)*17-f.opening.y-f.opening.height/2;
    assert.ok(Math.abs(rest.vertices[i+1]-seam)<1);
  }
});

test('wide and rounded vowels differ in width and height without folding the mesh',()=>{
  const f=fixture();
  const wide=f.pose(.7,{'mouth.form':1}),round=f.pose(.7,{'mouth.round':1});
  assert.ok(wide.transform.scaleX>round.transform.scaleX);
  assert.ok(wide.transform.scaleY<round.transform.scaleY);
  for(const open of [0,.03,.06,.15,.3,.6,1])for(const form of [-1,0,1])for(const rounded of [0,1]) {
    const p=f.pose(open,{'mouth.form':form,'mouth.round':rounded});
    assert.ok(p.transform.scaleX>0&&p.transform.scaleY>0);
    const signs=[];
    for(let i=0;i<f.mouth.mesh.indices.length;i+=3){
      const [a,b,c]=f.mouth.mesh.indices.slice(i,i+3).map(j=>j*2),v=p.vertices;
      const area=(v[b]-v[a])*(v[c+1]-v[a+1])-(v[b+1]-v[a+1])*(v[c]-v[a]);
      assert.ok(Math.abs(area)>1e-8);signs.push(Math.sign(area));
    }
    assert.ok(signs.every(s=>s===signs[0]));
  }
});


test('speech closes fully between phrases and responds consistently across frame rates',()=>{
  const outputs=[];
  for(const fps of [30,60,120]) {
    const {model}=fixture();const motion=new PuppetMotion({random:()=>.5});
    for(let frame=0;frame<=fps;frame++)motion.update(frame*1000/fps,model,{microphone:{open:.8,form:0,round:0}});
    assert.ok(motion.pose['mouth.open']>.79);
    for(let frame=1;frame<=fps/2;frame++)motion.update(1000+frame*1000/fps,model,{microphone:{open:0,form:0,round:0}});
    assert.equal(motion.pose['mouth.open'],0);
    outputs.push(motion.pose['mouth.open']);
  }
  assert.deepEqual(outputs,[0,0,0]);
});
