import { paintStroke } from "./art-editor.js";
import { applyAnimeLandmarks, detectAnimeLandmarks } from "./anime-landmarks.js";
import { defaultRegions, fitRegions, validateRegions } from './layered-rig.js';
import { analyzeImageData, PROPORTIONS } from './auto-rigger.js';
import { detectProportions, visionAvailable } from './vision.js';
import { addRegionContours, resetRegionContour, recoverClosedMouth, fitContourToEdges, setRegionBounds, updateContourBounds, containsPoint, nearestEdge, FEATURE_REGIONS } from './region-geometry.js';

export function reviewRegions(dialog, prepared) {
  return new Promise((resolve,reject)=> {
    const { imageData, faceOnly = false }=prepared;
    const visibleRegion=name=>!faceOnly || ['face',...FEATURE_REGIONS,'leftLid','rightLid'].includes(name);
    let regions=addRegionContours(structuredClone(prepared.regions),imageData), analysis=prepared.analysis;
    const addLids=()=>{for(const side of ['left','right'])if(!regions[`${side}Lid`])regions[`${side}Lid`]=structuredClone(regions[`${side}Eye`]);};
    addLids();
    let selectedPoint=-1, drag=null;
    const history=[], future=[];
    const panel=document.createElement('section'); panel.className='region-editor';
    panel.innerHTML=`<h3>${faceOnly?'Outline the eyes and mouth':'Outline the moving parts'}</h3>
      <p>Drag the dots to follow the artwork. Drag inside the selected outline to move it. Double-click an edge to add a point; select a dot and press Delete to remove it. Arrow keys nudge a selected dot. ${faceOnly?'The rest of the character stays still.':'Face and hair outlines guide the cutouts.'}</p>
      <button type="button" class="detect-anime">Detect anime landmarks</button><p class="anime-status" role="status"></p>
      <label>Proportions<select class="style-select"></select></label>
      <button type="button" class="detect-style" hidden>Detect with Ollama</button>
      <p class="hint">Switching proportions re-estimates all outlines. Undo restores your edits.</p>
      <label class="checkbox"><input class="preserve-eyes" type="checkbox" checked> Preserve painted eyes and lashes</label>
      <p class="hint">Eye regions erase the source paint. Left/right lid outlines define the opening inside the lashes.</p>
      <label>Editing tool<select class="ownership-tool"><option value="outline">Outline</option><option value="claim">Claim pixels for this part</option><option value="exclude">Exclude pixels from this part</option><option value="clear">Clear brush override</option></select></label>
      <label>Ownership brush<input class="ownership-radius" type="range" min="2" max="50" value="12"></label>
      <label>Region<select class="region-select"></select></label>
      <div class="mouth-options" hidden><label class="checkbox"><input type="checkbox" class="mouth-closed"> Source mouth is closed</label><p>Place the mouth over the lip line. This keeps the drawn lips at rest and generates an opening for talking. Flattened or crossed lip outlines are repaired automatically.</p></div>
      <div class="region-tools"><button type="button" class="region-undo">Undo outline</button><button type="button" class="region-redo">Redo</button><button type="button" class="region-fit">Fit to nearby edges</button><button type="button" class="region-reset">Reset outline</button></div>
      <label class="region-zoom-label">Zoom <input class="region-zoom" aria-label="Placement zoom" type="range" min="1" max="4" step=".25" value="1"><output class="region-zoom-value">1×</output></label>
      <div class="region-viewport"><canvas tabindex="0" aria-label="Feature outline editor"></canvas></div>
      <p class="region-feedback" aria-live="polite">Review the estimated outlines, especially the eye corners and lips.</p>
      <details class="region-numeric"><summary>Position and size</summary><div class="region-fields"></div></details>
      <p class="region-error" role="alert"></p><button type="button" class="primary build-rig">${faceOnly?'Build blink and talking rig':'Build layered rig'}</button>`;
    dialog.querySelector('.dialog-card').append(panel);
    const select=panel.querySelector('.region-select'), canvas=panel.querySelector('canvas'), context=canvas.getContext('2d');
    const error=panel.querySelector('.region-error'),build=panel.querySelector('.build-rig');
    const feedback=panel.querySelector('.region-feedback');
    const mouthOptions=panel.querySelector('.mouth-options'),closedMouth=panel.querySelector('.mouth-closed');
    closedMouth.addEventListener('change',()=>{checkpoint();regions.mouth.sourceClosed=closedMouth.checked;draw();});
    const styleSelect=panel.querySelector('.style-select'),zoom=panel.querySelector('.region-zoom');
    const fit=panel.querySelector('.region-fit'),undo=panel.querySelector('.region-undo'),redo=panel.querySelector('.region-redo');
    const snapshot=()=>({regions:structuredClone(regions),analysis,selected:select.value});
    const checkpoint=()=>{history.push(snapshot());if(history.length>60)history.shift();future.length=0;};
    function restore(saved) {
      regions=saved.regions;analysis=saved.analysis;select.value=saved.selected;
      styleSelect.value=analysis.style??'anime';selectedPoint=-1;draw();
      animeStatus.textContent=analysis.landmarkMethod ? 'Anime landmarks applied. Review the outlines before building.' : 'Using estimated outlines.';
    }
    undo.addEventListener('click',()=>{if(history.length){future.push(snapshot());restore(history.pop());}});
    redo.addEventListener('click',()=>{if(future.length){history.push(snapshot());restore(future.pop());}});
    for(const [id,p] of Object.entries(PROPORTIONS))styleSelect.add(new Option(p.label,id));
    styleSelect.value=analysis.style??'anime';
    const applyStyle=(style)=> {
      const sourceClosed=regions.mouth.sourceClosed;
      checkpoint();styleSelect.value=style;analysis=analyzeImageData(imageData,style);
      animeStatus.textContent='Using estimated outlines. Choose Detect anime landmarks to re-detect.';
      regions=addRegionContours(fitRegions(defaultRegions(analysis),imageData.width,imageData.height),imageData);
      regions.mouth.sourceClosed=sourceClosed;addLids();
      selectedPoint=-1;draw();
    };
    styleSelect.addEventListener('change',()=>applyStyle(styleSelect.value));
    const detect=panel.querySelector('.detect-style');
    const visionController=new AbortController();
    const animeStatus=panel.querySelector('.anime-status');
    animeStatus.textContent=analysis.landmarkMethod ? 'Anime landmarks applied. Review the outlines before building.' : (analysis.warnings.find(w=>w.startsWith('Anime detector:')) ?? 'Using estimated outlines. Anime detection runs locally when installed.');
    panel.querySelector('.detect-anime').addEventListener('click',async()=>{
      panel.inert=true;animeStatus.textContent='Finding anime landmarks…';
      try {
        const result=await detectAnimeLandmarks(imageData,{signal:visionController.signal});
        if(!panel.isConnected)return;
        const next=applyAnimeLandmarks(analysis,result,imageData.width,imageData.height);
        checkpoint();analysis=next;styleSelect.value='anime';
        regions=addRegionContours(fitRegions(defaultRegions(analysis),imageData.width,imageData.height),imageData);
        addLids();selectedPoint=-1;draw();animeStatus.textContent='Anime landmarks applied. Undo restores your previous outlines.';
      } catch(e) {if(panel.isConnected)animeStatus.textContent=e.message;}
      finally {panel.inert=false;}
    });
    visionAvailable().then(ok=>{if(panel.isConnected)detect.hidden=!ok;});
    detect.addEventListener('click',async()=> {
      const label=detect.textContent;
      detect.disabled=true;detect.textContent='Looking…';
      try {
        const style=await detectProportions(imageData,{signal:visionController.signal});
        if(!panel.isConnected)return;
        if(style){applyStyle(style);detect.textContent=`Chose ${PROPORTIONS[style].label}`;}
        else detect.textContent='No clear answer';
      } catch(e) {if(panel.isConnected)error.textContent=`Could not reach the vision model: ${e.message}`;}
      finally {detect.disabled=false;setTimeout(()=>{detect.textContent=label;},2500);}
    });
    canvas.width=imageData.width;canvas.height=imageData.height;
    for(const name of Object.keys(regions).filter(visibleRegion))select.add(new Option(name.replace(/([A-Z])/g,' $1'),name));
    const fields={};
    for(const property of ['x','y','width','height']) {
      const label=document.createElement('label');label.textContent=property;
      const input=document.createElement('input');input.type='number';input.step='1';input.min=property==='x'||property==='y'?'0':'2';
      input.setAttribute('aria-label',`Region ${property}`);label.append(input);panel.querySelector('.region-fields').append(label);fields[property]=input;
      let before;
      input.addEventListener('focus',()=>{before=structuredClone(regions[select.value]);checkpoint();});
      input.addEventListener('input',()=> {
        const r=structuredClone(before??regions[select.value]);
        const bounds={x:r.x,y:r.y,width:r.width,height:r.height,[property]:input.value===''?NaN:Number(input.value)};
        if(Object.values(bounds).every(Number.isFinite)&&bounds.width>0&&bounds.height>0)setRegionBounds(r,bounds);
        else Object.assign(r,bounds);
        regions[select.value]=r;selectedPoint=-1;draw(false);
      });
    }
    fit.addEventListener('click',()=>{
      checkpoint();const r=regions[select.value];r.contour=fitContourToEdges(imageData,r,select.value);selectedPoint=-1;
      feedback.textContent='Fitted near the current feature. Check the result; Undo restores your outline.';draw();
    });
    panel.querySelector('.region-reset').addEventListener('click',()=>{
      checkpoint();resetRegionContour(select.value,regions[select.value],canvas.width,canvas.height);selectedPoint=-1;draw();
    });
    zoom.addEventListener('input',()=>{
      canvas.style.width=`${Number(zoom.value)*100}%`;
      panel.querySelector('.region-zoom-value').textContent=`${zoom.value}×`;draw(false);
    });
    const displayScale=()=>canvas.width/Math.max(1,canvas.getBoundingClientRect().width);
    function draw(sync=true) {
      if(!drag && recoverClosedMouth(regions.mouth,canvas.width,canvas.height)) {
        selectedPoint=-1;sync=true;
        feedback.textContent='Closed lip outline repaired automatically. The rig will generate the talking opening.';
      }
      context.putImageData(imageData,0,0);
      const activeMask=regions[select.value]?.paintMask;
      if(activeMask){context.save();for(let i=0;i<activeMask.length;i++)if(activeMask[i]){context.fillStyle=activeMask[i]===1?'rgba(60,240,190,.45)':'rgba(255,60,100,.45)';context.fillRect(i%canvas.width,Math.floor(i/canvas.width),1,1);}context.restore();}
      const scale=displayScale();
      for(const [name,r] of Object.entries(regions)) {
        if(!visibleRegion(name))continue;
        const active=name===select.value;
        if(!r.contour?.every(p=>p.every(Number.isFinite)))continue;
        context.beginPath();r.contour.forEach(([x,y],i)=>i?context.lineTo(x,y):context.moveTo(x,y));context.closePath();
        context.strokeStyle=active?'#ff5ccb':'#79e7df';context.lineWidth=(active?2:1)*scale;context.stroke();
        if(active) {
          context.fillStyle='rgba(255,92,203,.08)';context.fill();
          r.contour.forEach(([x,y],i)=>{
            context.beginPath();context.arc(x,y,(i===selectedPoint?5:3.5)*scale,0,Math.PI*2);
            context.fillStyle=i===selectedPoint?'#ffffff':'#ff5ccb';context.fill();context.strokeStyle='#24172f';context.lineWidth=scale;context.stroke();
          });
        }
      }
      if(sync)for(const [id,input] of Object.entries(fields))input.value=Number.isFinite(regions[select.value][id])?Math.round(regions[select.value][id]*10)/10:'';
      mouthOptions.hidden=select.value!=='mouth';closedMouth.checked=Boolean(regions.mouth.sourceClosed);
      undo.disabled=!history.length;redo.disabled=!future.length;
      fit.disabled=!FEATURE_REGIONS.includes(select.value);
      try {validateRegions(regions,canvas.width,canvas.height,{ faceOnly });error.textContent='';build.disabled=false;}
      catch(e){error.textContent=e.message;build.disabled=true;fit.disabled=true;}
    }
    select.addEventListener('change',()=>{selectedPoint=-1;draw();});
    const point=e=>{const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*canvas.width,y:(e.clientY-r.top)/r.height*canvas.height};};
    canvas.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      canvas.focus({preventScroll:true});const p=point(e);let r=regions[select.value];
      const tool=panel.querySelector('.ownership-tool').value;
      if(tool!=='outline'){
        if(!['face','bangs','leftHair','rightHair','backHair'].includes(select.value)){feedback.textContent='Ownership brushes apply to face and hair parts. Use Outline for facial features.';return;}
        checkpoint();r.paintMask??=new Uint8Array(canvas.width*canvas.height);drag={brush:true,...p};canvas.setPointerCapture(e.pointerId);
        paintStroke(r.paintMask,canvas.width,canvas.height,p,p,Number(panel.querySelector('.ownership-radius').value),tool==='claim'?1:tool==='exclude'?2:0);draw();return;
      }
      const distances=r.contour.map(([x,y])=>Math.hypot(x-p.x,y-p.y));
      selectedPoint=distances.indexOf(Math.min(...distances));
      if(distances[selectedPoint]>10*displayScale())selectedPoint=-1;
      if(selectedPoint<0&&!containsPoint(r.contour,p.x,p.y)&&nearestEdge(r.contour,p.x,p.y).distance>10*displayScale()) {
        const hit=Object.entries(regions).filter(([name])=>visibleRegion(name)).reverse().find(([,shape])=>containsPoint(shape.contour,p.x,p.y));
        if(!hit){draw();return;}
        select.value=hit[0];r=hit[1];
      }
      checkpoint();drag={...p,region:structuredClone(r),index:selectedPoint};canvas.setPointerCapture(e.pointerId);draw();
    });
    canvas.addEventListener('pointermove',e=>{
      if(!drag)return;const p=point(e),r=regions[select.value],b=drag.region;
      if(drag.brush){const tool=panel.querySelector('.ownership-tool').value;paintStroke(r.paintMask,canvas.width,canvas.height,drag,p,Number(panel.querySelector('.ownership-radius').value),tool==='claim'?1:tool==='exclude'?2:0);drag.x=p.x;drag.y=p.y;draw();return;}
      const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
      if(drag.index>=0) {
        r.contour[drag.index]=[clamp(p.x,0,canvas.width),clamp(p.y,0,canvas.height)];updateContourBounds(r);
      } else {
        const dx=clamp(p.x-drag.x,-b.x,canvas.width-b.x-b.width),dy=clamp(p.y-drag.y,-b.y,canvas.height-b.y-b.height);
        r.contour=b.contour.map(([x,y])=>[x+dx,y+dy]);r.x=b.x+dx;r.y=b.y+dy;r.width=b.width;r.height=b.height;
      }
      draw();
    });
    canvas.addEventListener('pointerup',()=>{drag=null;draw();});canvas.addEventListener('pointercancel',()=>{drag=null;draw();});
    canvas.addEventListener('dblclick',e=>{
      const p=point(e),r=regions[select.value],edge=nearestEdge(r.contour,p.x,p.y);
      if(edge.distance>12*displayScale()||r.contour.length>=64||r.contour.some(([x,y])=>Math.hypot(x-edge.point[0],y-edge.point[1])<2*displayScale()))return;
      checkpoint();r.contour.splice(edge.index+1,0,edge.point);selectedPoint=edge.index+1;draw();
    });
    panel.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z') {
        e.preventDefault();e.stopPropagation();(e.shiftKey?redo:undo).click();return;
      }
      if(e.target!==canvas||selectedPoint<0)return;
      const r=regions[select.value],p=r.contour[selectedPoint];
      if(['Delete','Backspace'].includes(e.key)&&r.contour.length>3) {
        e.preventDefault();checkpoint();r.contour.splice(selectedPoint,1);selectedPoint=-1;updateContourBounds(r);draw();
      } else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
        e.preventDefault();checkpoint();const step=e.shiftKey?5:1;
        p[0]=Math.max(0,Math.min(canvas.width,p[0]+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0)));
        p[1]=Math.max(0,Math.min(canvas.height,p[1]+(e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0)));updateContourBounds(r);draw();
      }
    });
    const cleanup=()=>{visionController.abort();panel.remove();dialog.removeEventListener('close',cancel);};
    const cancel=()=>{cleanup();reject(new Error('Rig creation cancelled.'));};
    dialog.addEventListener('close',cancel,{once:true});
    build.addEventListener('click',()=>{try{recoverClosedMouth(regions.mouth,canvas.width,canvas.height);validateRegions(regions,canvas.width,canvas.height,{ faceOnly });cleanup();resolve({regions,analysis,preserveEyes:panel.querySelector(".preserve-eyes").checked});}catch(e){error.textContent=e.message;}});
    draw();panel.scrollIntoView({block:'nearest'});
  });
}
