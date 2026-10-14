import { benchmarkFixtures, poseCases } from "./benchmark-fixtures.js";
import { KokoroRenderer } from "./renderer.js";
import { analyzeImageData, prepareAutoRig } from "./auto-rigger.js";
import { buildLayeredRig } from "./layered-rig.js";
import { addRegionContours } from "./region-geometry.js";
import { createLayeredSampleModel } from "./sample.js";
import { defaultParameterValues, validateModel } from "./model.js";
import { evaluateScene } from "./scene.js";
import { importProject, downloadBlob } from "./project-file.js";
const element = id => document.getElementById(id);
const canvas=element("benchmarkCanvas"), renderer=new KokoroRenderer(canvas), poses=poseCases();
const entries=benchmarkFixtures().map(fixture=>({name:fixture.name,fixture}));
entries.unshift({name:"Interviewer · supplied artwork",factory:async()=>{const response=await fetch("./interviewer.kokoro2d");if(!response.ok)throw new Error("Interviewer fixture unavailable.");return importProject(await response.blob());}});
entries.unshift({name:"Kokoro-chan · reviewed artwork",factory:createLayeredSampleModel});
const results=[];let model, selected=0, running=false, loadToken=0;
function iou(a,b){const intersection=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return intersection/(a.width*a.height+b.width*b.height-intersection);}
async function makeModel(entry){
  if(entry.model)return entry.model;
  if(entry.factory)return entry.factory();
  const f=entry.fixture,image=new Image();image.src=`data:image/svg+xml,${encodeURIComponent(f.svg)}`;await image.decode();
  const c=document.createElement("canvas");c.width=f.width;c.height=f.height;c.getContext("2d").drawImage(image,0,0);
  const data=c.getContext("2d").getImageData(0,0,c.width,c.height),analysis=analyzeImageData(data,"anime");
  entry.eyeIoU=(iou(analysis.features.leftEye,f.regions.leftEye)+iou(analysis.features.rightEye,f.regions.rightEye))/2;
  // Reviewed annotations isolate deformation quality from automatic localization;
  // the detector is scored independently against those same annotations.
  return buildLayeredRig(data,analysis,addRegionContours(structuredClone(f.regions),data),entry.name);
}
async function select(index){const token=++loadToken;const next=await makeModel(entries[index]);if(token!==loadToken)return;await renderer.setModel(next);model=next;selected=index;element("benchmarkStatus").textContent=`${next.layers.length} layers · ${entries[index].name}`;}
for(const [index,entry] of entries.entries())element("benchmarkCharacter").add(new Option(entry.name,index));
for(const [index,pose] of poses.entries())element("benchmarkPose").add(new Option(pose.name,index));
element("benchmarkCharacter").onchange=()=>select(Number(element("benchmarkCharacter").value)).catch(error=>{element("benchmarkStatus").textContent=error.message;});
element("benchmarkFiles").onchange=async event=>{
  try{for(const file of event.target.files){let model;if(file.type.startsWith("image/")){const p=await prepareAutoRig(file);model=buildLayeredRig(p.imageData,p.analysis,p.regions,p.name);}else model=await importProject(file);entries.push({name:file.name,model});element("benchmarkCharacter").add(new Option(file.name,entries.length-1));}element("benchmarkStatus").textContent="References added.";}catch(error){element("benchmarkStatus").textContent=error.message;}event.target.value="";
};
export async function runBenchmark(){
  if(running)return;running=true;++loadToken;element("runBenchmark").disabled=true;element("benchmarkCharacter").disabled=true;element("benchmarkFiles").disabled=true;results.length=0;element("benchmarkResults").replaceChildren();
  try{
    for(const [index,entry] of entries.entries()){
      element("benchmarkStatus").textContent=`Measuring ${index+1}/${entries.length}: ${entry.name}`;
      const candidate=await makeModel(entry);const errors=validateModel(candidate);if(errors.length)throw new Error(errors.join(" "));
      await renderer.setModel(candidate);const defaults=defaultParameterValues(candidate),times=[];let finite=true;
      for(const pose of poses){const values={...defaults,...pose.values};for(const evaluated of evaluateScene(candidate,values).values())if(!evaluated.vertices.every(Number.isFinite))finite=false;
        renderer.render(values);times.push(renderer.metrics.frameMs);await new Promise(requestAnimationFrame);
      }
      // Return to neutral and compare geometry; parameter sampling must be reversible.
      const first=evaluateScene(candidate,defaults);renderer.render({...defaults,"eyes.blink":1});const restored=evaluateScene(candidate,defaults);
      finite &&= [...first].every(([id,p])=>p.vertices.every((v,i)=>v===restored.get(id).vertices[i]));
      times.sort((a,b)=>a-b);
      const row={name:entry.name,kind:entry.fixture?"synthetic":"artwork",poses:poses.length,cpuP95Ms:times[Math.floor((times.length-1)*.95)],textureMiB:renderer.metrics.textureBytes/1048576,eyeIoU:entry.eyeIoU??null,finiteAndReversible:finite};results.push(row);
      const tr=document.createElement("tr");for(const value of [row.name,row.cpuP95Ms.toFixed(1),row.textureMiB.toFixed(1),row.eyeIoU===null?"—":row.eyeIoU.toFixed(3),finite?"Pass":"FAIL"]){const td=document.createElement("td");td.textContent=value;tr.append(td);}element("benchmarkResults").append(tr);
    }
    element("benchmarkStatus").textContent=`Measured ${results.length} characters across ${poses.length} poses each. Review visual quality alongside the numbers.`;element("downloadBenchmark").disabled=false;
  }finally{running=false;element("runBenchmark").disabled=false;element("benchmarkCharacter").disabled=false;element("benchmarkFiles").disabled=false;await select(selected);}
  return results;
}
element("runBenchmark").onclick=()=>runBenchmark().catch(error=>{element("benchmarkStatus").textContent=error.message;});
element("downloadBenchmark").onclick=()=>downloadBlob(new Blob([JSON.stringify({at:new Date().toISOString(),userAgent:navigator.userAgent,devicePixelRatio:devicePixelRatio,viewport:[canvas.width,canvas.height],results},null,2)],{type:"application/json"}),"kokoro2d-benchmark.json");
element("captureBenchmark").onclick=()=>canvas.toBlob(blob=>{if(blob)downloadBlob(blob,`pose-${selected}.png`);});
function frame(time){if(model&&!running){const values={...defaultParameterValues(model),...poses[Number(element("benchmarkPose").value)].values};if(element("benchmarkAnimate").checked){values["head.yaw"]=Math.sin(time/1600)*.8;values["head.pitch"]=Math.sin(time/2100)*.5;const blink=time%3300;values["eyes.blink"]=blink<90?blink/90:blink<140?1:blink<320?1-(blink-140)/180:0;}renderer.render(values);}requestAnimationFrame(frame);}
await select(0);requestAnimationFrame(frame);
