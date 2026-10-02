import { authorPortraitMotion } from "./portrait-motion.js";
import { authorAnimeMouth } from "./anime-mouth.js";
import { createLayer, createModel, ensureKeyform } from './model.js';
import { bindParent } from './scene.js';
import { regionContains, contourProblem, setRegionBounds, contourPath, eyeProfile, mouthOpeningRegion, recoverClosedMouth } from './region-geometry.js';

const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.ceil(w), height: Math.ceil(h) });
const key = (layer, id, value, transform) => Object.assign(ensureKeyform(layer, id, value).transform, transform);
// Four-point sparkle, drawn from its centre so it can ride on a pupil.
const starPath = (cx, cy, r) => `M${cx} ${cy-r}L${cx+r*.24} ${cy-r*.24}L${cx+r} ${cy}L${cx+r*.24} ${cy+r*.24}L${cx} ${cy+r}L${cx-r*.24} ${cy+r*.24}L${cx-r} ${cy}L${cx-r*.24} ${cy-r*.24}Z`;
const svg = (w, h, body) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`;
function warp(layer, id, value, fn) {
  const k = ensureKeyform(layer, id, value);
  for (let i = 0; i < layer.mesh.vertices.length; i += 2) {
    const [x,y] = layer.mesh.vertices.slice(i, i+2);
    const u = layer.mesh.uvs[i], v = layer.mesh.uvs[i+1];
    [k.offsets[i], k.offsets[i+1]] = fn(x,y,u,v);
  }
}
export function defaultRegions(analysis) {
  const f = analysis.face, s = analysis.subject;
  return {
    face: { x:f.x, y:f.y, width:f.width, height:f.height, ...(f.contour ? { contour: structuredClone(f.contour) } : {}) },
    leftEye: { ...analysis.features.leftEye }, rightEye: { ...analysis.features.rightEye }, mouth: { ...analysis.features.mouth },
    backHair: { x:s.x, y:s.y, width:s.width, height:s.height*.72 },
    bangs: { x:f.x, y:s.y, width:f.width, height: Math.max(1, f.y + f.height * 0.35 - s.y) },
    leftHair: { x:s.x, y:s.y, width: Math.max(1, f.x-s.x+f.width*0.13), height:s.height*0.75 },
    rightHair: { x:f.x+f.width*0.87, y:s.y, width:Math.max(1,s.x+s.width-f.x-f.width*0.87), height:s.height*0.75 },
  };
}
export function validateRegions(regions, width, height, { faceOnly = false } = {}) {
  for (const name of (faceOnly ? ['face','leftEye','rightEye','mouth'] : ['face','leftEye','rightEye','mouth','bangs','leftHair','rightHair','backHair'])) {
    const r = regions[name];
    if (!r || ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width < 2 || r.height < 2 || r.x+r.width > width+0.01 || r.y+r.height > height+0.01) throw new Error(`Adjust ${name}: its bounds must fit inside the image and be at least 2 pixels wide and high.`);
    if (r.contour) {
      const problem=contourProblem(r.contour,width,height)
        ?? (r.contour.some(([x,y])=>x<r.x-.01||y<r.y-.01||x>r.x+r.width+.01||y>r.y+r.height+.01)?'the outline extends outside its bounds':null);
      if(problem)throw new Error(`Adjust ${name}: ${problem}. Select this region and use Undo or Reset outline.${name==='mouth'?' For closed lips, keep a thin loop around the lip line; do not merge the upper and lower points.':''}`);
    }
  }
  return regions;
}
export function fitRegions(regions, width, height) {
  for (const r of Object.values(regions)) {
    const x=clamp(r.x,0,width-2), y=clamp(r.y,0,height-2);
    setRegionBounds(r,{x,y,width:clamp(r.width,2,width-x),height:clamp(r.height,2,height-y)});
  }
  return regions;
}

function inside(r,x,y) { return regionContains(r,x,y); }
function ellipse(r,x,y) { return regionContains(r,x,y,true); }
function skinColor(data,r) {
  let color=[0,0,0], count=0;
  for(let y=Math.floor(r.y);y<r.y+r.height;y++) for(let x=Math.floor(r.x);x<r.x+r.width;x++) {
    const i=(y*data.width+x)*4, a=data.data;
    if(a[i]>a[i+1]*1.03 && a[i+1]>a[i+2]*0.9 && a[i]>160 && a[i+3]>128) { for(let c=0;c<3;c++)color[c]+=a[i+c]; count++; }
  }
  return count ? color.map(v=>Math.round(v/count)) : [245,210,202];
}

// Soften a layer's silhouette so it cross-fades into what sits beneath it
// instead of stamping onto it. The torso underneath carries a diffused fill of
// the area this layer covers, so a feathered edge blends into something close
// to the right colour; a hard edge reads as a cut-out pasted on the picture,
// and every separation boundary traces a visible contour - most obviously
// along the jaw, where the face ellipse ends.
function featherAlpha(image, width, height, radius) {
  const { data } = image;
  const source = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) source[i] = data[i * 4 + 3];
  const span = radius * 2 + 1;
  const rows = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let d = -radius; d <= radius; d += 1) {
        sum += source[y * width + clamp(x + d, 0, width - 1)];
      }
      rows[y * width + x] = sum / span;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let d = -radius; d <= radius; d += 1) {
        sum += rows[clamp(y + d, 0, height - 1) * width + x];
      }
      // Never add coverage where there was none: only soften what is already
      // opaque, so the layer cannot grow into its neighbours.
      const blurred = sum / span;
      const index = y * width + x;
      data[index * 4 + 3] = Math.min(data[index * 4 + 3], blurred);
    }
  }
}

// Drop small disconnected islands from a separated part. A dark outline stroke
// along a jaw is not a strand of hair, but the colour test cannot tell them
// apart pixel by pixel - what distinguishes them is that hair is connected and
// the misclassifications are confetti. They matter because every speck is
// carried by that layer's springs, so they visibly detach and swim.
function removeSpecks(image, width, height, keepShare = 0.02) {
  const { data } = image;
  const total = width * height;
  const label = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  const sizes = [];
  for (let seed = 0; seed < total; seed += 1) {
    if (label[seed] >= 0 || data[seed * 4 + 3] <= 24) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    label[seed] = id;
    let count = 0;
    while (head < tail) {
      const index = queue[head++];
      count += 1;
      const x = index % width;
      for (const neighbor of [index - 1, index + 1, index - width, index + width]) {
        if (neighbor < 0 || neighbor >= total || label[neighbor] >= 0) continue;
        if (data[neighbor * 4 + 3] <= 24) continue;
        if (Math.abs((neighbor % width) - x) > 1) continue;
        label[neighbor] = id;
        queue[tail++] = neighbor;
      }
    }
    sizes.push(count);
  }
  if (sizes.length < 2) return 0;
  const biggest = Math.max(...sizes);
  const floor = Math.max(24, biggest * keepShare);
  let cleared = 0;
  for (let index = 0; index < total; index += 1) {
    const id = label[index];
    if (id < 0 || sizes[id] >= floor) continue;
    data[index * 4 + 3] = 0;
    cleared += 1;
  }
  return cleared;
}

// Extend retained pixels into newly exposed seams. The bounded fill is intentionally
// local: it does not invent a hidden face or leave a second hair silhouette behind.
function extendEdges(image, distance, subjectMask) {
  const {width:w,height:h,data:a}=image, queue=new Int32Array(w*h), depth=new Uint8Array(w*h);
  let head=0,tail=0;
  for(let i=0;i<w*h;i++) if(a[i*4+3]>128) {queue[tail++]=i;depth[i]=1;}
  while(head<tail) {
    const i=queue[head++]; if(depth[i]>distance)continue;
    for(const j of [i-1,i+1,i-w,i+w]) {
      if(j<0||j>=w*h||Math.abs(j%w-i%w)>1||depth[j]||subjectMask[j]<24)continue;
      depth[j]=depth[i]+1; queue[tail++]=j;
      // Average the already-filled neighbours rather than copying the one pixel
      // this was reached from. Copying propagates a single colour outward in a
      // line, so a dark brow or a hairline smears into the vacated area as a
      // streak - a ghost of itself that shows whenever the head turns away.
      let filled=0; const sum=[0,0,0,0];
      for(const k of [j-1,j+1,j-w,j+w]) {
        if(k<0||k>=w*h||Math.abs(k%w-j%w)>1||!depth[k])continue;
        for(let c=0;c<4;c++)sum[c]+=a[k*4+c];
        filled++;
      }
      for(let c=0;c<4;c++)a[j*4+c]=filled?sum[c]/filled:a[i*4+c];
    }
  }
}

// Where does a part's artwork actually sit? A full-canvas layer spends its mesh
// on empty space: the face used to get the same 12x16 grid as the whole picture,
// while an eye got its grid over a few hundred pixels. Cropping each part to its
// content puts the vertices where the drawing is, and shrinks the texture with it.
function contentBounds(context, width, height, pad = 2) {
  const { data } = context.getImageData(0, 0, width, height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - pad), y = Math.max(0, minY - pad);
  return { x, y, width: Math.min(width, maxX + pad + 1) - x, height: Math.min(height, maxY + pad + 1) - y };
}

function unionRect(rects) {
  const live = rects.filter(Boolean);
  if (!live.length) return null;
  const x = Math.min(...live.map(r => r.x)), y = Math.min(...live.map(r => r.y));
  return {
    x, y,
    width: Math.max(...live.map(r => r.x + r.width)) - x,
    height: Math.max(...live.map(r => r.y + r.height)) - y,
  };
}

// Cage layers need a margin so the children they deform stay inside them.
function growRect(r, amount, width, height) {
  const x = Math.max(0, r.x - r.width * amount), y = Math.max(0, r.y - r.height * amount);
  return {
    x, y,
    width: Math.min(width, r.x + r.width * (1 + amount)) - x,
    height: Math.min(height, r.y + r.height * (1 + amount)) - y,
  };
}

export function buildLayeredRig(imageData, analysis, regions, name='Layered Puppet', { faceOnly = false } = {}) {
  const {width:w,height:h}=imageData;
  // Also cover direct auto-rig callers that skip the placement editor.
  if(regions.mouth?.sourceClosed) {
    regions={...regions,mouth:structuredClone(regions.mouth)};
    recoverClosedMouth(regions.mouth,w,h);
  }
  validateRegions(regions,w,h,{ faceOnly });
  const model=createModel(name), subject=analysis.subject;
  const scale=Math.min(900/subject.height,840/subject.width);
  const origin={x:subject.x+subject.width/2,y:subject.y+subject.height/2};
  const skin=skinColor(imageData,regions.face), skinCss=`rgb(${skin.join(',')})`;
  model.meta.rigRevision=2;
  model.meta.regions=structuredClone(regions);
  for(const [id,label,min,max] of [['body.breathe','Breathing',-1,1],['body.bounce','Body Bounce',-1,1],['chest.bounce','Chest Bounce',-1,1],['chest.sway','Chest Sway',-1,1],['hair.bangs','Bangs',-1,1],['hair.left','Left Hair Root',-1,1],['hair.leftTip','Left Hair Tip',-1,1],['hair.right','Right Hair Root',-1,1],['hair.rightTip','Right Hair Tip',-1,1],['hair.back','Back Hair Root',-1,1],['hair.backTip','Back Hair Tip',-1,1],['mouth.round','Mouth Rounded',0,1],['expr.happy','Happy',0,1],['expr.sad','Sad',0,1],['expr.angry','Angry',0,1],['expr.confused','Confused',0,1]]) model.parameters[id]={id,name:label,min,max,default:0};
  model.physics=[
    {id:'back-root',input:'head.yaw',output:'hair.back',strength:-.5,frequency:1.8,damping:.75},
    {id:'back-tip',input:'hair.back',output:'hair.backTip',strength:1,frequency:1.1,damping:.65},
    {id:'bangs',input:'head.yaw',output:'hair.bangs',strength:-0.65,frequency:3.6,damping:0.75},
    {id:'left-root',input:'head.yaw',output:'hair.left',strength:-0.8,frequency:2.2,damping:0.66},
    {id:'left-tip',input:'hair.left',output:'hair.leftTip',strength:1,frequency:1.4,damping:0.58},
    {id:'right-root',input:'head.yaw',output:'hair.right',strength:-0.7,frequency:2.5,damping:0.7},
    {id:'right-tip',input:'hair.right',output:'hair.rightTip',strength:1,frequency:1.6,damping:0.6},
    {id:'chest-bounce',input:'body.bounce',output:'chest.bounce',strength:.85,frequency:1.5,damping:.16},
    {id:'chest-sway',input:'body.sway',output:'chest.sway',strength:.55,frequency:1.6,damping:.28},
  ];
  function layer(name,r,src,z=0,cols=10,rows=12) {
    const l=createLayer({name,src,width:r.width*scale,height:r.height*scale,x:(r.x+r.width/2-origin.x)*scale,y:(r.y+r.height/2-origin.y)*scale,zIndex:z,columns:cols,rows});
    model.layers.push(l);return l;
  }
  const source=canvas(w,h);source.getContext('2d').putImageData(imageData,0,0);
  function crop(r) {const c=canvas(r.width,r.height);c.getContext('2d').drawImage(source,r.x,r.y,r.width,r.height,0,0,c.width,c.height);return c;}
  const face=regions.face;
  let faceContext, faceLayer, emptyNames=[];
  // The limited rig retains one static image instead of cutting up the body.
  if (faceOnly) {
    const base=canvas(w,h), context=base.getContext('2d');
    const pixels=context.createImageData(w,h);
    pixels.data.set(imageData.data);
    for(let i=0;i<w*h;i++)pixels.data[i*4+3]=Math.min(pixels.data[i*4+3],analysis.mask[i]);
    context.putImageData(pixels,0,0);
    faceContext=context;
  } else {
    const partNames=['Body','Face','Bangs','Left Hair','Right Hair','Back Hair'];
    const parts=partNames.map(()=>canvas(w,h)), buffers=parts.map(c=>c.getContext('2d').createImageData(w,h));
    const partCounts=partNames.map(()=>0);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      const i=y*w+x, o=i*4, alpha=analysis.mask[i]; if(alpha<1)continue;
      const a=imageData.data;
      // Hair regions are editable; protect warm face pixels from the bangs cut.
      const warm=a[o]>a[o+1]*1.03 && a[o+1]>a[o+2]*0.9 && a[o]>135;
      let part=ellipse(face,x,y)?1:0;
      // Ears sit just outside the face ellipse but belong to the head: left in
      // the torso they stay behind while the head turns, and tear at the join.
      if(!face.contour&&part===0&&warm&&ellipse({x:face.x-face.width*.12,y:face.y+face.height*.05,width:face.width*1.24,height:face.height*.9},x,y))part=1;
      const belowChin=Math.max(0,y-face.y-face.height);
      const torsoHalfWidth=face.width*.45+belowChin*.43;
      const overTorso=belowChin>0 && Math.abs(x-face.x-face.width/2)<torsoHalfWidth;
      const maximum=Math.max(a[o],a[o+1],a[o+2]),minimum=Math.min(a[o],a[o+1],a[o+2]);
      const hairPixel=!overTorso && ((a[o+2]>a[o+1]*1.02 && a[o]<a[o+2]*1.5 && minimum/Math.max(1,maximum)<.85) || maximum<65);
      if(inside(regions.backHair,x,y)&&!ellipse(face,x,y)&&hairPixel)part=5;
      if(inside(regions.leftHair,x,y)&&!ellipse(face,x,y)&&hairPixel)part=3;
      if(inside(regions.rightHair,x,y)&&!ellipse(face,x,y)&&hairPixel)part=4;
      // Bangs take hair, never skin. Claiming warm pixels above the face box cut
      // the forehead along a dead straight horizontal line at that boundary.
      if(inside(regions.bangs,x,y)&&!warm)part=2;
      // Eyes must not remain baked into bangs: otherwise a blink reveals a second iris.
      if ([regions.leftEye,regions.rightEye,regions.mouth].some(r=>r.contour?inside(r,x,y):ellipse({x:r.x-r.width*.12,y:r.y-r.height*.3,width:r.width*1.24,height:r.height*1.6},x,y))) part=1;
      for(let c=0;c<3;c++)buffers[part].data[o+c]=a[o+c];
      buffers[part].data[o+3]=Math.min(a[o+3],alpha);
      if(buffers[part].data[o+3]>24)partCounts[part]++;
    }
    // Clean each part before anything is filled or cropped, so the seam fill does
    // not grow the specks and the crop is not stretched around them.
    for(let part=0;part<buffers.length;part++)partCounts[part]-=removeSpecks(buffers[part],w,h);
    // Fill underneath the moving face/hair only near cut edges.
    for(let part=0;part<2;part++)extendEdges(buffers[part],Math.max(2,Math.round(12/scale)),analysis.mask);
    // Everything that moves over the torso gets a softened silhouette. The torso
    // itself is the base and keeps its hard outline against the background.
    const feather=Math.max(2,Math.round(Math.min(w,h)/110));
    for(let part=1;part<buffers.length;part++)featherAlpha(buffers[part],w,h,feather);
    parts.forEach((c,i)=>c.getContext('2d').putImageData(buffers[i],0,0));
    faceContext=parts[1].getContext('2d');
    restoreFeatures(faceContext);
    // Crop every part to its own artwork. Sub-rectangles are copied out of the
    // finished canvases so the seam fill and the restored skin come with them.
    // A hair part must be a real mass of hair, not a few slivers. Judged against
    // the largest hair part as well as the canvas: on a tied-back hairstyle the
    // side regions catch a handful of stray strands, and a layer holding only
    // those swings around on its springs like confetti on a string.
    // Measured against the character, not the canvas: a portrait on a large empty
    // background would otherwise set the bar far too low. Also against the largest
    // hair mass, since a tied-back hairstyle leaves the side regions with strays.
    const subjectArea=Math.max(1,subject.width*subject.height);
    const biggestHair=Math.max(...partCounts.slice(2));
    const hairMinimum=Math.max(subjectArea*0.025,biggestHair*0.25);
    const partRects=parts.map((c,i)=>(i>1&&partCounts[i]<hairMinimum)?null:contentBounds(c.getContext('2d'),w,h));
    const cropped=parts.map((c,i)=>{
      const r=partRects[i]; if(!r)return null;
      const out=canvas(r.width,r.height);
      out.getContext('2d').drawImage(c,r.x,r.y,r.width,r.height,0,0,out.width,out.height);
      return out;
    });
    const imageAt=(r)=>(u,v)=>[r.x+u*r.width,r.y+v*r.height];
    // Face centre expressed in a given layer's own local space.
    const faceCentre=(l)=>[(face.x+face.width/2-origin.x)*scale-l.transform.x,(face.y+face.height*.85-origin.y)*scale-l.transform.y];
    const bodyRect=partRects[0]??{x:0,y:0,width:w,height:h};
    const rootRect=growRect(unionRect(partRects.filter(Boolean))??subject,0.04,w,h);
    const root=layer('Portrait Deformer',rootRect,svg(1,1,'<path fill="white" d="M0 0h1v1H0z"/>'),0,18,26);
    root.maskOnly=true;
    authorPortraitMotion(root,rootRect,face,subject,scale);
    const body=layer('Torso',bodyRect,cropped[0].toDataURL(),0,16,20);bindParent(body,root);
    const bodyAt=imageAt(bodyRect);
    // Torso motion is measured against the subject, not the canvas. The previous
    // 1-v taper put its largest displacement above the shoulders, where this
    // layer keeps no pixels, and pinned the shoulders themselves to ~2 screen px.
    const torsoBottom=subject.y+subject.height;
    const breathReach=subject.height*scale*.006;
    // The chest lobe is a local Gaussian below the chin, kept inside the
    // silhouette, so its springs move it without dragging the shoulders.
    const chest={
      x:face.x+face.width/2,
      y:Math.min(torsoBottom-face.height*.2,face.y+face.height*1.55),
      rx:face.width*.62, ry:face.height*.44,
    };
    const chestWeight=(ix,iy)=>Math.exp(-(((ix-chest.x)/chest.rx)**2+((iy-chest.y)/chest.ry)**2));
    const bounceReach=face.height*scale*.105, chestSwayReach=face.width*scale*.085;
    for(const d of [-1,1]) {
      // Sway pivots at the base and carries the shoulders.
      // Shared posture sway is authored on the portrait cage.
      // Both axes fall off, or the widening term runs away at the layer edges.
      warp(body,'body.breathe',d,(x,y,u,v)=>{
        const [ix,iy]=bodyAt(u,v);
        const dx=(ix-chest.x)/(chest.rx*2.2), dy=(iy-chest.y)/(chest.ry*1.9);
        const g=Math.exp(-(dx*dx+dy*dy));
        return[d*breathReach*.5*dx*g,-d*breathReach*g];
      });
      // Volume-preserving: rising narrows, dropping spreads.
      warp(body,'chest.bounce',d,(x,y,u,v)=>{const [ix,iy]=bodyAt(u,v);const g=chestWeight(ix,iy);return[-d*bounceReach*.3*((ix-chest.x)/chest.rx)*g,d*bounceReach*g];});
      warp(body,'chest.sway',d,(x,y,u,v)=>{const [ix,iy]=bodyAt(u,v);const g=chestWeight(ix,iy);return[d*chestSwayReach*g,d*chestSwayReach*.22*((ix-chest.x)/chest.rx)*g];});
    }
    // The cage only has to span the layers it deforms, with a margin so they
    // stay inside it rather than being extrapolated at the edges.
    const headRect=growRect(unionRect([partRects[1],partRects[2],partRects[3],partRects[4],partRects[5]])??bodyRect,0.06,w,h);
    const head=layer('Head Deformer',headRect,svg(1,1,'<path fill="white" d="M0 0h1v1H0z"/>'),0,14,18);
    head.maskOnly=true;bindParent(head,root);
    const [centerX,centerY]=faceCentre(head);
    warp(head,'expr.sad',1,()=>[0,face.height*scale*.03]);
    warp(head,'expr.confused',1,(x,y)=>{const a=.06,dx=x-centerX,dy=y-centerY;return[dx*Math.cos(a)-dy*Math.sin(a)-dx,dx*Math.sin(a)+dy*Math.cos(a)-dy];});
    const faceRect=partRects[1]??bodyRect;
    faceLayer=layer('Face',faceRect,cropped[1].toDataURL(),2,12,16);bindParent(faceLayer,head);
    // A hair region that lost almost every pixel to an overlapping neighbour would
    // ship a near-empty full-canvas texture and a spring chain driving nothing.
    // Back hair hits this whenever the side regions meet across the middle: the
    // remainder is a sliver, and at z -1 it renders behind everything anyway.
    const unused=new Set();
    for(const [index,id,tip,z] of [[2,'hair.bangs',null,8],[3,'hair.left','hair.leftTip',1],[4,'hair.right','hair.rightTip',1],[5,'hair.back','hair.backTip',-1]]) {
      if(partCounts[index]<hairMinimum) {unused.add(id); if(tip)unused.add(tip); continue;}
      const hairRect=partRects[index];
      const hair=layer(partNames[index],hairRect,cropped[index].toDataURL(),z,12,20);bindParent(hair,head);
      const hairAt=imageAt(hairRect);
      const r=regions[index===2?'bangs':index===3?'leftHair':index===4?'rightHair':'backHair'];
      // How far down its own region a strand sits, so the tips swing most.
      const along=(u,v)=>clamp((hairAt(u,v)[1]-r.y)/r.height);
      for(const d of [-1,1]) {
        warp(hair,id,d,(x,y,u,v)=>[d*12*along(u,v)**1.4,0]);
        if(tip)warp(hair,tip,d,(x,y,u,v)=>[d*18*along(u,v)**2.5,d*2*along(u,v)**2]);
        warp(hair,'hair.motion',d,(x,y,u,v)=>[d*8*along(u,v),0]);
      }
    }
    model.physics=model.physics.filter(entry=>!unused.has(entry.output)&&!unused.has(entry.input));
    for(const id of unused)delete model.parameters[id];
    model.meta.emptyRegions=[...unused];
    emptyNames=[...unused].filter(id=>!id.endsWith('Tip')).map(id=>id.replace('hair.',''));
  }
  function restoreFeatures(faceContext) {
    // Restore skin under features so opening/closing never cross-fades two eyes.
    for(const r of [regions.leftEye,regions.rightEye,regions.mouth]) {
      if(r===regions.mouth&&r.sourceClosed&&r.contour) {
        // Reconstruct the narrow lip stroke from skin directly above and below
        // each column. A single sampled color leaves a painted smile-shaped scar.
        const pad=Math.max(3,r.width*.065), x0=Math.max(0,Math.floor(r.x-pad)), y0=Math.max(0,Math.floor(r.y-pad*2));
        const pw=Math.min(w-x0,Math.ceil(r.width+pad*2)), ph=Math.min(h-y0,Math.ceil(r.height+pad*4));
        const patch=canvas(pw,ph),ctx=patch.getContext('2d'),pixels=ctx.createImageData(pw,ph);
        for(let py=0;py<ph;py++)for(let px=0;px<pw;px++) {
          const x=x0+px,y=y0+py,at=(y*w+x)*4,out=(py*pw+px)*4;
          pixels.data.set(imageData.data.subarray(at,at+4),out);
          const profile=eyeProfile(r,clamp((x-r.x)/r.width));
          const above=Math.max(0,Math.floor(profile.upper-pad)),below=Math.min(h-1,Math.ceil(profile.lower+pad));
          if(y<above||y>below)continue;
          const edge=clamp((x-(r.x-pad))/pad)*clamp((r.x+r.width+pad-x)/pad);
          const blend=edge*clamp(Math.min(y-above,below-y)/2);
          const t=(y-above)/Math.max(1,below-above);
          for(let c=0;c<3;c++) {
            const skin=imageData.data[(above*w+x)*4+c]*(1-t)+imageData.data[(below*w+x)*4+c]*t;
            pixels.data[out+c]=pixels.data[out+c]*(1-blend)+skin*blend;
          }
        }
        ctx.putImageData(pixels,0,0);faceContext.drawImage(patch,x0,y0);continue;
      }
      const localSkin=skinColor(imageData,{x:Math.max(0,r.x-r.width*.15),y:Math.min(h-r.height*.3,r.y+r.height),width:r.width*1.3,height:Math.max(2,r.height*.3)});
      faceContext.save();
      const gradient=faceContext.createRadialGradient(r.x+r.width/2,r.y+r.height/2,0,r.x+r.width/2,r.y+r.height/2,r.width*.7);
      gradient.addColorStop(0,`rgb(${localSkin.join(',')})`);gradient.addColorStop(1,skinCss);
      faceContext.fillStyle=gradient;
      if(r.contour) {
        const path=new Path2D(contourPath(r));
        faceContext.fill(path);
        faceContext.strokeStyle=gradient;faceContext.lineWidth=Math.max(1,Math.min(r.width,r.height)*.12,r===regions.mouth&&r.sourceClosed?r.width*.10:0);faceContext.lineJoin='round';faceContext.stroke(path);
      } else {
        faceContext.beginPath();faceContext.ellipse(r.x+r.width/2,r.y+r.height/2,r.width*.63,r.height*.82,0,0,Math.PI*2);faceContext.fill();
      }
      faceContext.restore();
    }
  }
  if (faceOnly) {
    restoreFeatures(faceContext);
    faceLayer=layer('Character', {x:0,y:0,width:w,height:h}, faceContext.canvas.toDataURL(),0,1,1);
  }
  for(const [side,r] of [['Left',regions.leftEye],['Right',regions.rightEye]]) {
    const ew=r.width,eh=r.height;
    const path=r.contour?contourPath(r,true):`M1 ${eh*.5} Q${ew*.5} ${-eh*.35} ${ew-1} ${eh*.5} Q${ew*.5} ${eh*1.25} 1 ${eh*.5}Z`;
    const white=layer(`${side} Eye Opening`,r,svg(ew,eh,`<path d="${path}" fill="#fff6f1"/>`),4,12,4);bindParent(white,faceLayer);
    const irisR={x:r.x+ew*.28,y:r.y,width:ew*.44,height:eh};
    const irisCanvas=crop(irisR);
    const iris=layer(`${side} Iris`,irisR,irisCanvas.toDataURL(),5,8,6);iris.source.mask='ellipse';iris.source.feather=.035;iris.clipMask=white.id;bindParent(iris,faceLayer);
    for(const d of [-1,1]) {key(iris,'eyes.lookX',d,{x:d*ew*scale*.16});key(iris,'eyes.lookY',d,{y:d*eh*scale*.18});}
    const lashHeight=Math.max(4,eh*.14);
    const lashRect={x:r.x,y:r.y+eh*.5-lashHeight/2,width:ew,height:lashHeight};
    const lashes=layer(`${side} Eyelashes`,lashRect,svg(ew,lashHeight,`<path d="M1 ${lashHeight/2}H${ew-1}" fill="none" stroke="#422c42" stroke-width="${lashHeight*.7}" stroke-linecap="round"/>`),6,16,1);
    // A thin ribbon bends along the lid while retaining its thickness at closure.
    for(let i=0;i<lashes.mesh.vertices.length;i+=2) {
      const u=lashes.mesh.uvs[i]*2-1;
      lashes.mesh.vertices[i+1]+=r.contour
        ? (eyeProfile(r,(u+1)/2).upper-r.y-eh*.5)*scale
        : -eh*scale*.425*(1-u*u);
    }
    bindParent(lashes,faceLayer);
    warp(lashes,'eyes.blink',1,(x,y,u)=>{
      if(!r.contour)return[0,eh*scale*.5*(1-(u*2-1)**2)];
      const profile=eyeProfile(r,u);return[0,(profile.closed-profile.upper)*scale];
    });
    warp(white,'eyes.blink',1,(x,y,u)=>[0,r.contour?(eyeProfile(r,u).closed-r.y-eh/2)*scale-y:-y]);
    if (!faceOnly) {
      // Happy stars ride the pupil and are clipped by the eye opening, so they
      // cannot escape the lid or outlive a blink.
      const starSize=Math.min(irisR.width,eh);
      const stars=layer(`${side} Eye Stars`,irisR,svg(irisR.width,eh,
        `<path d="${starPath(irisR.width*.5,eh*.46,starSize*.44)}" fill="#fff7fb"/>`+
        `<path d="${starPath(irisR.width*.5,eh*.46,starSize*.26)}" fill="#ffc8ea"/>`+
        `<path d="${starPath(irisR.width*.16,eh*.76,starSize*.16)}" fill="#fff7fb"/>`+
        `<path d="${starPath(irisR.width*.86,eh*.22,starSize*.13)}" fill="#fff7fb"/>`),5,6,6);
      stars.transform.opacity=0;stars.clipMask=white.id;bindParent(stars,faceLayer);
      key(stars,'expr.happy',1,{opacity:1,scaleX:.1,scaleY:.1});
      for(const d of [-1,1]) {key(stars,'eyes.lookX',d,{x:d*ew*scale*.16});key(stars,'eyes.lookY',d,{y:d*eh*scale*.18});}
      // 1 at the inner corner, so sad droops outward and angry slants inward.
      const towardNose=(u)=>side==='Left'?u:1-u;
      const askew=side==='Left'?1:-1;
      key(white,'expr.happy',1,{scaleY:.12});key(iris,'expr.happy',1,{scaleX:.08,scaleY:.08});
      warp(lashes,'expr.happy',1,(x,y,u)=>[0,-eh*scale*.12*(1-(u*2-1)**2)]);
      key(white,'expr.sad',1,{scaleY:-.14});key(iris,'expr.sad',1,{y:eh*scale*.1});
      warp(lashes,'expr.sad',1,(x,y,u)=>[0,eh*scale*.3*(1-towardNose(u))**1.5]);
      key(white,'expr.angry',1,{scaleY:-.16});key(iris,'expr.angry',1,{scaleX:-.08,scaleY:-.08});
      warp(lashes,'expr.angry',1,(x,y,u)=>[0,eh*scale*.34*towardNose(u)**1.6]);
      key(white,'expr.confused',1,{scaleY:askew*.1});key(iris,'expr.confused',1,{x:ew*scale*.06*askew});
      warp(lashes,'expr.confused',1,(x,y,u)=>[0,-askew*eh*scale*.26*(u*.7+.3)]);
    }
  }
  const mr=mouthOpeningRegion(regions.mouth,h),mw=mr.width,mh=mr.height;
  const mouthShape=mr.contour?`<path d="${contourPath(mr,true)}" fill="#642a3e"/>`:null;
  const mouth=layer('Mouth • open / wide / rounded',mr,svg(mw,mh,`<ellipse cx="${mw/2}" cy="${mh/2}" rx="${mw*.44}" ry="${mh*.45}" fill="#642a3e"/><ellipse cx="${mw/2}" cy="${mh*.76}" rx="${mw*.28}" ry="${mh*.18}" fill="#e68a99"/><path d="M${mw*.22} ${mh*.19}Q${mw*.5} ${mh*.1} ${mw*.78} ${mh*.19}" stroke="#fff4e8" stroke-width="${mh*.12}" fill="none"/>`),6,10,6);bindParent(mouth,faceLayer);
  if(mr.contour) {
    mouth.source.src=svg(mw,mh,`<defs><clipPath id="lip"><path d="${contourPath(mr,true)}"/></clipPath></defs>${mouthShape}<g clip-path="url(#lip)"><ellipse cx="${mw/2}" cy="${mh*.76}" rx="${mw*.28}" ry="${mh*.18}" fill="#e68a99"/><path d="M${mw*.22} ${mh*.19}Q${mw*.5} ${mh*.1} ${mw*.78} ${mh*.19}" stroke="#fff4e8" stroke-width="${mh*.12}" fill="none"/></g>`);
    const open=ensureKeyform(mouth,'mouth.open',1);
    for(let i=0;i<mouth.mesh.vertices.length;i+=2) {
      const line=(eyeProfile(mr,mouth.mesh.uvs[i]).closed-mr.y-mh/2)*scale;
      const y=mouth.mesh.vertices[i+1];
      mouth.mesh.vertices[i+1]=line+(y-line)*.065;
      open.offsets[i+1]=y-mouth.mesh.vertices[i+1];
    }
  } else {
    mouth.transform.scaleY=.065;
    key(mouth,'mouth.open',1,{scaleY:.935});
  }
  let originalLips=null;
  if(regions.mouth.sourceClosed) {
    // Preserve the actual lip drawing at rest. Only the selected source patch
    // is restored; the taller generated cavity appears as mouth.open rises.
    const pad=regions.mouth.width*.06;
    const resting={...regions.mouth,x:Math.max(0,regions.mouth.x-pad),y:Math.max(0,regions.mouth.y-pad)};
    resting.width=Math.min(w,regions.mouth.x+regions.mouth.width+pad)-resting.x;
    resting.height=Math.min(h,regions.mouth.y+regions.mouth.height+pad)-resting.y;
    // Keep the complete lip stroke, including antialiasing outside the detected
    // contour. The patch disappears before the generated opening is visible.
    const lipsCanvas=crop(resting);
    const lips=layer('Mouth • original closed lips',resting,lipsCanvas.toDataURL(),7,10,4);bindParent(lips,faceLayer);originalLips=lips;
    key(lips,'mouth.open',.2,{opacity:-1});
    mouth.transform.opacity=0;key(mouth,'mouth.open',.2,{opacity:1});key(mouth,'mouth.open',1,{opacity:1});
    // A new intermediate opacity key also needs the interpolated opening pose.
    const halfway=ensureKeyform(mouth,'mouth.open',.2), fully=ensureKeyform(mouth,'mouth.open',1);
    halfway.offsets=fully.offsets.map(value=>value*.2);
    halfway.transform.scaleY=fully.transform.scaleY*.2;
  }
  key(mouth,'mouth.form',-1,{scaleX:-.2});key(mouth,'mouth.form',1,{scaleX:.25});
  key(mouth,'mouth.round',1,{scaleX:-.48});
  if((analysis.style??'anime')==='anime')authorAnimeMouth(mouth,originalLips,regions.mouth,mr,scale);
  key(mouth,'expr.happy',1,{scaleY:.34,scaleX:.16,y:mh*scale*.1});
  key(mouth,'expr.sad',1,{scaleX:-.22,scaleY:.05,y:mh*scale*.34});
  key(mouth,'expr.angry',1,{scaleX:.2,scaleY:.06,y:mh*scale*.16});
  key(mouth,'expr.confused',1,{scaleX:-.26,scaleY:.04,x:mw*scale*.16});
  if (faceOnly) {
    const allowed=new Set(['eyes.blink','mouth.open','mouth.form','mouth.round']);
    model.parameters=Object.fromEntries(Object.entries(model.parameters).filter(([id])=>allowed.has(id)));
    model.physics=[];
    for(const part of model.layers)for(const id of Object.keys(part.keyforms))if(!allowed.has(id))delete part.keyforms[id];
    model.meta.emptyRegions=[];
  }
  const rigWarnings=[...analysis.warnings,faceOnly
    ? 'Eye and mouth reconstruction is approximate. Inspect blink and lip sync.'
    : 'Single-image separation and hidden seams are approximations. Inspect hair boundaries and feature placement.'];
  if(emptyNames.length)rigWarnings.push(`No artwork reached the ${emptyNames.join(' and ')} hair region, so that layer and its springs were left out. Move the neighbouring hair outlines apart to keep it.`);
  model.meta.autoRig={version:2,faceOnly,confidence:analysis.confidence,warnings:rigWarnings,landmarkMethod:analysis.landmarkMethod??"Estimated landmarks"};
  return model;
}
