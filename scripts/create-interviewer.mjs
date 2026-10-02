// Refine this supplied portrait without re-segmenting or repainting its artwork.
import { readFile, writeFile } from 'node:fs/promises';
import { createGridMesh, ensureKeyform, parseModel, serializeModel, uid } from '../src/model.js';
import { bindParent } from '../src/scene.js';
import { contourPath, eyeProfile, mouthOpeningRegion } from '../src/region-geometry.js';

const model=parseModel(await readFile(new URL('../sample.kokoro2d',import.meta.url),'utf8'));
const base=model.layers.find(l=>l.name==='Character');
if(!base || !model.meta.regions?.face)throw new Error('Expected the supplied portrait rig with reviewed face regions.');
const png=Buffer.from(base.source.src.split(',')[1],'base64');
const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
const scale=base.source.width/width, face=model.meta.regions.face;
const cx=face.x+face.width/2, neckY=face.y+face.height*1.12;
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const smooth=v=>{v=clamp(v);return v*v*(3-2*v);};
base.mesh=createGridMesh(base.source.width,base.source.height,32,40);
for(const layer of model.layers)if(layer.parent?.id===base.id)bindParent(layer,base);
for(const [id,name,min,max] of [
  ['head.yaw','Head turn',-1,1],['head.pitch','Head nod',-1,1],['head.roll','Head tilt',-1,1],
  ['eyes.lookX','Look left / right',-1,1],['eyes.lookY','Look up / down',-1,1],
  ['body.breathe','Breathing',-1,1],['body.sway','Posture shift',-1,1],['expr.attentive','Attentive',0,1],
])model.parameters[id]={id,name,min,max,default:0};
function warp(id,value,fn) {
  const key=ensureKeyform(base,id,value);
  for(let i=0;i<base.mesh.vertices.length;i+=2) {
    const x=base.mesh.uvs[i]*width,y=base.mesh.uvs[i+1]*height;
    const [dx,dy]=fn(x,y);
    key.offsets[i]=dx*scale;key.offsets[i+1]=dy*scale;
  }
}
const headWeight=y=>1-smooth((y-(face.y+face.height*.92))/(face.height*.48));
for(const d of [-1,1]) {
  warp('head.yaw',d,(x,y)=>{
    const w=headWeight(y),front=Math.exp(-(((x-cx)/(face.width*.65))**2));
    return[d*face.width*.037*w*(.6+.4*front),-d*(x-cx)*.008*w];
  });
  warp('head.pitch',d,(x,y)=>[d*(x-cx)*.012*headWeight(y),d*face.height*.019*headWeight(y)]);
  warp('head.roll',d,(x,y)=>{
    const angle=d*.048*headWeight(y),dx=x-cx,dy=y-neckY;
    return[dx*Math.cos(angle)-dy*Math.sin(angle)-dx,dx*Math.sin(angle)+dy*Math.cos(angle)-dy];
  });
  warp('body.sway',d,(x,y)=>[d*face.width*.025*smooth((height-y)/(height-neckY)),0]);
  warp('body.breathe',d,(x,y)=>{
    const chestY=neckY+face.height*.42;
    const weight=Math.exp(-(((x-cx)/(face.width*.75))**2+((y-chestY)/(face.height*.58))**2));
    return[d*(x-cx)*.007*weight,-d*face.height*.007*weight];
  });
}
warp('expr.attentive',1,(x,y)=>{
  let weight=0;
  for(const r of [model.meta.regions.leftEye,model.meta.regions.rightEye]) {
    const bx=r.x+r.width/2,by=r.y-r.height*.9;
    weight+=Math.exp(-(((x-bx)/(r.width*.65))**2+((y-by)/(r.height*.55))**2));
  }
  return[0,-face.height*.008*weight];
});
for(const layer of model.layers.filter(l=>l.name.endsWith('Iris'))) {
  const r=model.meta.regions[layer.name.startsWith('Left')?'leftEye':'rightEye'];
  for(const d of [-1,1]) {
    ensureKeyform(layer,'eyes.lookX',d).transform.x=d*r.width*scale*.105;
    ensureKeyform(layer,'eyes.lookY',d).transform.y=d*r.height*scale*.095;
  }
}
// The mouth is rebuilt rather than nudged. Three things were wrong with the
// inherited one, and only the first is visible in a still: a skin ellipse faded
// in over the lips to back the cavity, which erased the drawn mouth and left a
// flat oval with a rim; the opening was registered by a single y offset, which
// cannot fit a lip line that arcs down in the middle (`eyeProfile`'s straight
// chord runs ~5px above the ink at the centre and meets it at the corners); and
// the opening was a scaled copy of itself at every value, so a quiet syllable
// showed the same shape as a shout, only fainter.
const mouth=model.layers.find(l=>l.name==='Mouth • open / wide / rounded');
const lip=model.meta.regions.mouth, rect=mouthOpeningRegion(lip,height);
// The outline's lower edge tracks the drawn lip line to within a pixel, which
// the chord between its end points does not. Collapse onto it column by column.
const seam=u=>(eyeProfile(lip,u).lower-rect.y-rect.height/2)*scale;
// Regenerating the generated cavity, not the drawing. A nearly closed mouth
// compresses this texture to a few pixels, so whatever it contains is what a
// quiet syllable looks like: the stock tongue covers a third of the height and
// turned every small opening into a pink band. Keep it low and muted so the
// slit reads as a dark line, which is all a barely open mouth ever is.
{
  const mw=rect.width, mh=rect.height;
  // A smooth lens, not the reviewed outline. The outline bulges upward where
  // the drawing has only a line, and stretching it to the cavity height leaves
  // a top edge the mesh rows cannot follow, which frays into vertical streaks.
  const path=`M0 ${mh/2} Q${mw/2} ${-mh/2} ${mw} ${mh/2} Q${mw/2} ${mh*1.5} 0 ${mh/2}Z`;
  const art=`<svg xmlns="http://www.w3.org/2000/svg" width="${mw}" height="${mh}" viewBox="0 0 ${mw} ${mh}">`
    +`<defs><clipPath id="lip"><path d="${path}"/></clipPath></defs>`
    +`<path d="${path}" fill="#57202f"/><g clip-path="url(#lip)">`
    +`<ellipse cx="${mw/2}" cy="${mh*.88}" rx="${mw*.26}" ry="${mh*.1}" fill="#c8677a"/>`
    +`<path d="M${mw*.26} ${mh*.15}Q${mw*.5} ${mh*.08} ${mw*.74} ${mh*.15}" stroke="#fdeee2" stroke-width="${mh*.075}" fill="none" opacity=".9"/>`
    +`</g></svg>`;
  mouth.source.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(art)}`;
}
// A jaw drops; an upper lip barely moves. Splitting the travel evenly is most
// of what makes a talking rig read as a hinged beak.
const span=rect.height*.52*scale, UPPER=.3, REST=.05;
delete mouth.keyforms['mouth.open'];
const stages=[[.05,.03],[.3,.18],[1,1]].map(([value,share])=>[ensureKeyform(mouth,'mouth.open',value),share]);
for(let i=0;i<mouth.mesh.vertices.length;i+=2) {
  const u=mouth.mesh.uvs[i], v=mouth.mesh.uvs[i+1], line=seam(u);
  const rest=line+(v-UPPER)*span*REST, full=line+(v-UPPER)*span;
  mouth.mesh.vertices[i+1]=rest;
  for(const [key,share] of stages)key.offsets[i+1]=(full-rest)*share;
}
// Opaque as soon as it is wide enough to see. The inherited cross-fade reached
// full only at .2, so ordinary speech spent its time as a translucent smudge
// over the lips instead of as a hole in them.
mouth.transform.opacity=0;
for(const [key] of stages)key.transform.opacity=1;
// Wide open, the corners are drawn in by the same jaw that lowered the lip.
stages.at(-1)[0].transform.scaleX=-.07;
// Rounded is narrow and tall, spread is wide and flat. Scaling width alone left
// every vowel the same shape.
mouth.keyforms['mouth.round']=[];mouth.keyforms['mouth.form']=[];
Object.assign(ensureKeyform(mouth,'mouth.round',1).transform,{scaleX:-.3,scaleY:.16});
Object.assign(ensureKeyform(mouth,'mouth.form',-1).transform,{scaleX:-.12,scaleY:.04});
Object.assign(ensureKeyform(mouth,'mouth.form',1).transform,{scaleX:.15,scaleY:-.1});
// The reviewed source patch sits above the actual smile; it contains mostly
// skin and leaves a visible oval at rest. The portrait already has the smile.
const restingLips=model.layers.find(l=>l.name==='Mouth • original closed lips');
restingLips.transform.opacity=0;restingLips.keyforms={};
const sourceId=model.meta.id;
model.meta.id=uid('puppet');model.meta.name='Interviewer';
model.meta.derivedFrom={file:'sample.kokoro2d',id:sourceId};
model.meta.motion={style:'calm',overrides:{turnRate:.25,turnSize:.22,tiltSize:.06,bob:.005,headDeadZone:.25,headGain:.65,breathRate:.2,microsaccade:.012,idleMouth:0,swaySize:.3,shiftSize:.5,bounceDrive:0}};
model.meta.refinement='Continuous portrait mesh with gentle head turns, nods, breathing, posture shifts, eye gaze, and a mouth that opens from the drawn lip line.';
if(model.meta.autoRig)model.meta.autoRig.faceOnly=false;
await writeFile(new URL('../interviewer.kokoro2d',import.meta.url),serializeModel(model));
console.log(`Created interviewer.kokoro2d: ${model.layers.length} layers, ${Object.keys(model.parameters).length} parameters; original embedded artwork retained.`);
