import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayer, createModel, evaluateLayer, defaultParameterValues } from '../src/model.js';
import { authorPortraitMotion } from '../src/portrait-motion.js';
import { bindParent, evaluateScene } from '../src/scene.js';

function fixture() {
  const model=createModel();
  model.parameters['body.breathe']={id:'body.breathe',min:-1,max:1,default:0};
  const rect={x:0,y:0,width:1000,height:1200},face={x:300,y:300,width:400,height:400};
  const root=createLayer({name:'Portrait Deformer',width:1000,height:1200,columns:18,rows:26});root.maskOnly=true;
  authorPortraitMotion(root,rect,face,rect,1);
  const body=createLayer({name:'Unseparated hair and torso',width:1000,height:1200,columns:18,rows:26});bindParent(body,root);
  const head=createLayer({name:'Head',width:400,height:400,x:0,y:-100,columns:10,rows:10});bindParent(head,root);
  model.layers=[root,body,head];
  return {root,body,head,model};
}

test('head channels carry unseparated head artwork and face together',()=>{
  const {root,body,head,model}=fixture(),neutral=evaluateScene(model,defaultParameterValues(model));
  for(const id of ['head.yaw','head.pitch','head.roll']) {
    const pose=evaluateScene(model,{...defaultParameterValues(model),[id]:1});
    for(const layer of [body,head]) {
      const base=neutral.get(layer.id).vertices, moved=pose.get(layer.id).vertices;
      const travel=moved.reduce((maximum,v,i)=>Math.max(maximum,Math.abs(v-base[i])),0);
      assert.ok(travel>10,`${layer.name} should follow ${id}: ${travel}`);
    }
    // Mesh at the base stays planted while head and neck move.
    const p=evaluateLayer(root,{[id]:1},model.parameters);
    for(let i=0;i<root.mesh.uvs.length;i+=2)if(root.mesh.uvs[i+1]===1) {
      assert.ok(Math.abs(p.vertices[i]-root.mesh.vertices[i])<1e-8);
      assert.ok(Math.abs(p.vertices[i+1]-root.mesh.vertices[i+1])<1e-8);
    }
  }
});

test('combined turns, nods, tilts, breathing and sway preserve cage triangle orientation',()=>{
  const {root,model}=fixture();
  for(const yaw of [-1,1])for(const pitch of [-1,1])for(const roll of [-1,1])for(const sway of [-1,1])for(const breath of [-1,1]) {
    const p=evaluateLayer(root,{'head.yaw':yaw,'head.pitch':pitch,'head.roll':roll,'body.sway':sway,'body.breathe':breath},model.parameters);
    for(let i=0;i<root.mesh.indices.length;i+=3) {
      const [a,b,c]=root.mesh.indices.slice(i,i+3).map(j=>j*2);
      const area=v=>(v[b]-v[a])*(v[c+1]-v[a+1])-(v[b+1]-v[a+1])*(v[c]-v[a]);
      assert.ok(area(p.vertices)*area(root.mesh.vertices)>0,'combined motion folded a triangle');
    }
  }
});

test('a head tilt bends the neck the same way instead of scissoring it',()=>{
  const {root,model}=fixture();
  const nearest=(x,y)=>{let best=0,distance=Infinity;for(let i=0;i<root.mesh.uvs.length;i+=2){const d=Math.hypot(root.mesh.uvs[i]*1000-x,root.mesh.uvs[i+1]*1200-y);if(d<distance){distance=d;best=i;}}return best;};
  const crown=nearest(500,300),neck=nearest(500,760);
  for(const d of [-1,1]) {
    const p=evaluateLayer(root,{'head.roll':d},model.parameters).vertices;
    const crownX=p[crown]-root.mesh.vertices[crown],neckX=p[neck]-root.mesh.vertices[neck];
    // Pivoting at the chin swung the neck opposite to the crown.
    assert.ok(Math.sign(crownX)===Math.sign(neckX)&&Math.abs(neckX)>0.5,`crown ${crownX.toFixed(1)} neck ${neckX.toFixed(1)}`);
    assert.ok(Math.abs(crownX)>Math.abs(neckX),'the head should travel further than the neck');
  }
});
