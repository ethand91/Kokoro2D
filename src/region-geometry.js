// Contours are image-space points; bounds remain available for crop/mesh sizing
// and for older models that only stored rectangles.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const FEATURE_REGIONS = ['leftEye', 'rightEye', 'mouth'];

export function seedContour(name, r) {
  if (name !== 'face' && !FEATURE_REGIONS.includes(name)) {
    return [[0,0],[.5,0],[1,0],[1,.5],[1,1],[.5,1],[0,1],[0,.5]]
      .map(([u,v]) => [r.x + u*r.width, r.y + v*r.height]);
  }
  return Array.from({length:16}, (_, i) => {
    const a = Math.PI + i * Math.PI / 8;
    const y = Math.sin(a);
    return [r.x + r.width*(.5 + .5*Math.cos(a)),
      r.y + r.height*(.5 + .5*(name === 'face' ? y : y*Math.abs(y)))];
  });
}

export function setRegionBounds(r, next) {
  if (r.contour && r.width > 0 && r.height > 0) {
    r.contour = r.contour.map(([x,y]) => [
      next.x + (x-r.x)/r.width*next.width,
      next.y + (y-r.y)/r.height*next.height,
    ]);
  }
  Object.assign(r, next);
  return r;
}

export function updateContourBounds(r) {
  const xs = r.contour.map(p => p[0]), ys = r.contour.map(p => p[1]);
  r.x = Math.min(...xs); r.y = Math.min(...ys);
  r.width = Math.max(...xs)-r.x; r.height = Math.max(...ys)-r.y;
  return r;
}

export function containsPoint(points, x, y) {
  let inside = false;
  for (let i=0,j=points.length-1;i<points.length;j=i++) {
    const [ax,ay]=points[i], [bx,by]=points[j];
    if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
  }
  return inside;
}

export function regionContains(r, x, y, oval = false) {
  if (x<r.x || y<r.y || x>r.x+r.width || y>r.y+r.height) return false;
  if (r.contour) return containsPoint(r.contour,x,y);
  return !oval || ((x-r.x-r.width/2)/(r.width/2))**2+((y-r.y-r.height/2)/(r.height/2))**2<=1;
}

export function nearestEdge(points, x, y) {
  let best={distance:Infinity,index:0,point:[x,y]};
  for(let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length],dx=b[0]-a[0],dy=b[1]-a[1];
    const t=clamp(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1),0,1);
    const point=[a[0]+dx*t,a[1]+dy*t],distance=Math.hypot(x-point[0],y-point[1]);
    if(distance<best.distance)best={distance,index:i,point};
  }
  return best;
}

export function contourProblem(points, width, height) {
  if(!Array.isArray(points)||points.length<3||points.length>64) return 'an outline needs 3 to 64 points';
  if(points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))return 'a point has an invalid position';
  if(points.some(([x,y])=>x<0||y<0||x>width||y>height))return 'a point is outside the image';
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on=(a,b,p)=>Math.abs(cross(a,b,p))<1e-7&&p[0]>=Math.min(a[0],b[0])-1e-7&&p[0]<=Math.max(a[0],b[0])+1e-7&&p[1]>=Math.min(a[1],b[1])-1e-7&&p[1]<=Math.max(a[1],b[1])+1e-7;
  let area=0;
  for(let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length];
    if(Math.hypot(a[0]-b[0],a[1]-b[1])<.01)return 'two neighbouring points overlap';
    area+=a[0]*b[1]-b[0]*a[1];
    for(let j=i+2;j<points.length;j++) {
      if(i===0&&j===points.length-1)continue;
      const c=points[j],d=points[(j+1)%points.length];
      if((cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))return 'outline edges are crossed or touching';
    }
  }
  return Math.abs(area)>2 ? null : 'the outline is flattened into a line or too small';
}

export function validContour(points, width, height) {
  return contourProblem(points,width,height)===null;
}

// Reset must recover collapsed bounds too; reseeding a zero-height box just
// creates another line and leaves the user trapped behind the same error.
export function resetRegionContour(name, r, width, height) {
  const w=clamp(Number.isFinite(r.width)?r.width:20,2,width);
  const h=clamp(Number.isFinite(r.height)?r.height:10,name==='mouth'?Math.max(2,w*.1):2,height);
  const cx=(Number.isFinite(r.x)?r.x:0)+(Number.isFinite(r.width)?r.width:0)/2;
  const cy=(Number.isFinite(r.y)?r.y:0)+(Number.isFinite(r.height)?r.height:0)/2;
  Object.assign(r,{x:clamp(cx-w/2,0,width-w),y:clamp(cy-h/2,0,height-h),width:w,height:h});
  r.contour=seedContour(name,r);
  return r;
}

// Closed lips need a source patch, not a valid hand-drawn opening. Recover
// collapsed/crossed outlines locally without moving a valid mouth placement.
export function recoverClosedMouth(r, width, height) {
  if(!r?.sourceClosed || ![r.x,r.y,r.width,r.height].every(Number.isFinite)
    || r.x<0 || r.y<0 || r.width<2 || r.height<0
    || r.x+r.width>width+.01 || r.y+r.height>height+.01)return false;
  if(r.height>=2 && validContour(r.contour,width,height)
    && r.contour.every(([x,y])=>x>=r.x-.01&&y>=r.y-.01&&x<=r.x+r.width+.01&&y<=r.y+r.height+.01))return false;
  resetRegionContour('mouth',r,width,height);
  return true;
}

// A closed lip line describes the resting artwork, not how tall speech can
// open. Keep the same centre and width, but give the generated cavity height.
export function mouthOpeningRegion(r, imageHeight) {
  if(!r.sourceClosed)return r;
  const opening=structuredClone(r);
  const height=Math.min(imageHeight,Math.max(r.height,r.width*.45));
  setRegionBounds(opening,{x:r.x,y:clamp(r.y+r.height/2-height/2,0,imageHeight-height),width:r.width,height});
  return opening;
}

export function contourPath(r, local = false) {
  return r.contour.map(([x,y],i)=>`${i?'L':'M'}${x-(local?r.x:0)} ${y-(local?r.y:0)}`).join(' ')+'Z';
}

// Upper/lower lid and closure line at a horizontal position, including tilted
// eyes. Both the opening and lash ribbon must close onto the same line.
export function eyeProfile(r, u) {
  const points=r.contour;
  const left=points.reduce((a,b)=>b[0]<a[0]?b:a),right=points.reduce((a,b)=>b[0]>a[0]?b:a);
  const x=clamp(r.x+u*r.width,left[0]+1e-6,right[0]-1e-6), ys=[];
  for(let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length];
    if((a[0]<=x&&b[0]>x)||(b[0]<=x&&a[0]>x))ys.push(a[1]+(x-a[0])/(b[0]-a[0])*(b[1]-a[1]));
  }
  const closed=left[1]+(right[1]-left[1])*clamp((x-left[0])/(right[0]-left[0]||1),0,1);
  return {upper:ys.length?Math.min(...ys):closed,lower:ys.length?Math.max(...ys):closed,closed};
}

// Search only near each seed along its outward ray. This refines a found
// feature; it cannot safely locate a missing eye or distinguish hair from lids.
export function fitContourToEdges(image, region, name) {
  const seed=seedContour(name,region), cx=region.x+region.width/2,cy=region.y+region.height/2;
  const luma=(x,y)=>{
    const i=(clamp(Math.round(y),0,image.height-1)*image.width+clamp(Math.round(x),0,image.width-1))*4;
    return (image.data[i]*.299+image.data[i+1]*.587+image.data[i+2]*.114)*image.data[i+3]/255;
  };
  let supported=0;
  const points=seed.map(([x,y])=>{
    const dx=x-cx,dy=y-cy,length=Math.hypot(dx,dy),nx=dx/length,ny=dy/length;
    let best=0,point=[x,y];
    for(let step=-5;step<=5;step++) {
      const t=1+step*.035,px=cx+dx*t,py=cy+dy*t;
      if(px<region.x||py<region.y||px>region.x+region.width||py>region.y+region.height)continue;
      const contrast=Math.abs(luma(px+nx*1.5,py+ny*1.5)-luma(px-nx*1.5,py-ny*1.5));
      const score=contrast/(1+Math.abs(step)*.16);
      if(score>best&&contrast>=24){best=score;point=[px,py];}
    }
    if(best>0)supported++;
    return point;
  });
  return supported>=seed.length*.5&&validContour(points,image.width,image.height)?points:seed;
}

export function addRegionContours(regions, image = null) {
  for(const [name,r] of Object.entries(regions)) {
    if(!r.contour)r.contour=image&&FEATURE_REGIONS.includes(name)?fitContourToEdges(image,r,name):seedContour(name,r);
  }
  return regions;
}
