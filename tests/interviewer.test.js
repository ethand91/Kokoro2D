import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseModel,defaultParameterValues,evaluateLayer} from '../src/model.js';
import {evaluateScene} from '../src/scene.js';
import {PuppetMotion,STYLES} from '../src/motion.js';
import {eyeProfile,mouthOpeningRegion} from '../src/region-geometry.js';
const model=parseModel(readFileSync(new URL('../interviewer.kokoro2d',import.meta.url),'utf8'));
const original=parseModel(readFileSync(new URL('../sample.kokoro2d',import.meta.url),'utf8'));

test('interviewer preserves the source artwork and binds features to the denser portrait',()=>{
  assert.equal(model.meta.name,'Interviewer');
  // The drawing is what has to survive untouched. The generated vector helpers
  // - eye openings, lashes, the mouth cavity - are this script's to reauthor,
  // so compare the raster layers, which are the only cut artwork in the file.
  const painted=m=>m.layers.filter(l=>l.source.src.startsWith('data:image/png')).map(l=>l.source.src);
  assert.deepEqual(painted(model),painted(original));
  assert.equal(painted(model).length,4);
  assert.ok(model.layers[0].mesh.vertices.length>1000);
  for(const layer of model.layers.slice(1))assert.deepEqual(layer.parent.bind.vertices,model.layers[0].mesh.vertices);
});
test('head and breathing poses move continuously without folding the portrait mesh',()=>{
  const rest=evaluateScene(model,defaultParameterValues(model));
  const base=model.layers[0],restVertices=rest.get(base.id).vertices;
  for(const channel of ['head.yaw','head.pitch','head.roll','body.breathe','body.sway']) {
    for(const value of [-1,1]) {
      const poses=evaluateScene(model,{...defaultParameterValues(model),[channel]:value});
      const vertices=poses.get(base.id).vertices;
      assert.ok(vertices.some((v,i)=>Math.abs(v-restVertices[i])>1),channel);
      for(let i=0;i<base.mesh.indices.length;i+=3) {
        const [a,b,c]=base.mesh.indices.slice(i,i+3);
        const area=p=>(p[b*2]-p[a*2])*(p[c*2+1]-p[a*2+1])-(p[b*2+1]-p[a*2+1])*(p[c*2]-p[a*2]);
        assert.ok(area(vertices)*area(restVertices)>0,`${channel} folded a triangle`);
      }
      if(channel.startsWith('head.'))assert.ok(poses.get(model.layers[1].id).vertices.some((v,i)=>Math.abs(v-rest.get(model.layers[1].id).vertices[i])>1));
    }
  }
});
test('interviewer rests with closed lips, blinks, and responds to speech',()=>{
  let seed=31;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
  const motion=new PuppetMotion({random,style:{...STYLES.calm,...model.meta.motion.overrides}});
  let blink=0,turn=0;
  for(let i=0;i<1200;i++) {
    const pose=motion.update(i*1000/60,model);
    blink=Math.max(blink,pose['eyes.blink']??0);turn=Math.max(turn,Math.abs(pose['head.yaw']??0));
    assert.equal(pose['mouth.open']??0,0);
  }
  assert.ok(blink>.8);assert.ok(turn>.05);
  let speaking;
  for(let i=1200;i<1212;i++)speaking=motion.update(i*1000/60,model,{microphone:{open:.6,form:.2,round:.3}});
  assert.ok(speaking['mouth.open']>.3);
});

test('the mouth opens from the drawn lip line instead of fading in over it',()=>{
  const cavity=model.layers.find(l=>l.name.startsWith('Mouth • open'));
  const png=Buffer.from(model.layers[0].source.src.split(',')[1],'base64');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  const scale=model.layers[0].source.width/width;
  const lip=model.meta.regions.mouth,rect=mouthOpeningRegion(lip,height);
  const at=open=>evaluateLayer(cavity,{...defaultParameterValues(model),'mouth.open':open},model.parameters);
  // Nothing may paint over the drawn mouth to back the cavity: the skin ellipse
  // that used to do it erased the lips into a flat oval whenever she spoke.
  assert.equal(model.layers.filter(l=>/backing/i.test(l.name)).length,0);
  // Invisible closed, opaque before ordinary speech reaches it. Reaching full
  // opacity at .2, as the inherited rig did, spent quiet syllables as a
  // translucent smudge lying over the lips rather than a hole in them.
  assert.equal(at(0).transform.opacity,0);
  assert.equal(at(.06).transform.opacity,1);
  // At rest every vertex sits on the drawn lip line, which arcs down in the
  // middle. A single y offset cannot do this: the straight chord between the
  // outline's end points runs about 5px above the ink at the centre.
  let worst=0;
  for(let i=0;i<cavity.mesh.uvs.length;i+=2) {
    const seam=(eyeProfile(lip,cavity.mesh.uvs[i]).lower-rect.y-rect.height/2)*scale;
    worst=Math.max(worst,Math.abs(at(0).vertices[i+1]-seam));
  }
  assert.ok(worst<1.5*scale,`rest pose sits ${(worst/scale).toFixed(2)}px off the lip line`);
  // Aperture measured down one column: across a curved seam a bounding box
  // measures the arc, not the opening.
  const aperture=(pose,u)=>{
    const ys=[];
    for(let i=0;i<cavity.mesh.uvs.length;i+=2)if(cavity.mesh.uvs[i]===u)ys.push(pose.vertices[i+1]);
    return Math.max(...ys)-Math.min(...ys);
  };
  const u=cavity.mesh.uvs.filter((_,i)=>i%2===0).reduce((a,b)=>Math.abs(b-.5)<Math.abs(a-.5)?b:a);
  const rest=aperture(at(0),u),mid=aperture(at(.3),u),full=aperture(at(1),u);
  assert.ok(rest<full*.1,`closed mouth is ${(rest/full*100).toFixed(0)}% open`);
  assert.ok(rest<mid&&mid<full);
  // Quiet speech is a slit, not a small circle: half the travel must still be
  // ahead at .3, or every syllable shows the shape of a shout.
  assert.ok(mid<full*.35,`${(mid/full*100).toFixed(0)}% open at .3`);
  // A jaw drops and an upper lip barely moves. Splitting the travel evenly is
  // most of what makes a talking rig read as a hinged beak.
  const edge=(pose,pick)=>pick(...pose.vertices.filter((_,i)=>i%2));
  const up=edge(at(0),Math.min)-edge(at(1),Math.min),down=edge(at(1),Math.max)-edge(at(0),Math.max);
  assert.ok(down>up*2,`jaw travels ${(down/up).toFixed(2)}x the upper lip`);
});
