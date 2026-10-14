// Shared raster brush used for ownership masks and layer retouching.
export function paintStroke(mask, width, height, from, to, radius, value) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, radius / 3)));
  for (let step = 0; step <= steps; step++) {
    const cx = from.x + (to.x - from.x) * step / steps, cy = from.y + (to.y - from.y) * step / steps;
    for (let y = Math.max(0, Math.floor(cy-radius)); y <= Math.min(height-1, Math.ceil(cy+radius)); y++)
      for (let x = Math.max(0, Math.floor(cx-radius)); x <= Math.min(width-1, Math.ceil(cx+radius)); x++)
        if ((x-cx)**2+(y-cy)**2 <= radius*radius) mask[y*width+x] = value;
  }
}
export function editArtwork(layer) {
  return new Promise(async (resolve, reject) => {
    const dialog = document.createElement("dialog"); dialog.className = "art-dialog";
    dialog.innerHTML = `<div class="dialog-card"><h2>Edit layer artwork</h2>
      <p>Paint missing artwork, erase a cutout edge, or mark an area for the configured local repair helper.</p>
      <div class="art-tools"><label>Tool<select class="art-tool"><option value="paint">Paint</option><option value="erase">Erase</option><option value="repair">Repair mask</option></select></label>
      <label>Colour<input class="art-colour" type="color" value="#f4d2c6"></label><label>Brush<input class="art-radius" type="range" min="1" max="80" value="12"></label>
      <button class="art-undo" type="button">Undo stroke</button><label>Replace image<input class="art-file" type="file" accept="image/png,image/webp"></label>
      <button class="art-repair" type="button">Repair selected area locally</button></div>
      <div class="region-viewport"><canvas class="art-canvas"></canvas></div><p class="art-status" role="status"></p>
      <button class="art-apply primary" type="button">Apply artwork</button><button class="art-cancel" type="button">Cancel</button></div>`;
    document.body.append(dialog);
    const output = document.createElement("canvas"), preview = dialog.querySelector("canvas"), context = output.getContext("2d", { willReadFrequently: true });
    const status = dialog.querySelector(".art-status"), tool = dialog.querySelector(".art-tool"), history = [];
    let repairMask, pointer = null, closed = false;
    const cleanup = () => { closed = true; dialog.remove(); };
    const controller = new AbortController();
    dialog.addEventListener("close", () => { controller.abort(); cleanup(); resolve(null); });
    const draw = () => {
      const ctx = preview.getContext("2d"); ctx.clearRect(0,0,preview.width,preview.height); ctx.drawImage(output,0,0);
      const overlay = ctx.createImageData(preview.width, preview.height);
      for(let i=0;i<repairMask.length;i++) if(repairMask[i]) overlay.data.set([255,60,190,140],i*4);
      const c = document.createElement("canvas"); c.width=preview.width;c.height=preview.height;c.getContext("2d").putImageData(overlay,0,0);ctx.drawImage(c,0,0);
    };
    async function load(src, crop = null) {
      const image = new Image(); image.src = src; await image.decode();
      if (closed) return;
      output.width = crop?.width ?? image.width; output.height = crop?.height ?? image.height;
      if (output.width * output.height > 16*1024*1024) throw new Error("Artwork exceeds 16 megapixels.");
      preview.width = output.width; preview.height = output.height;
      if (crop) context.drawImage(image,crop.x,crop.y,crop.width,crop.height,0,0,output.width,output.height); else context.drawImage(image,0,0);
      repairMask = new Uint8Array(output.width*output.height); draw();
    }
    const point = e => { const r = preview.getBoundingClientRect(); return { x:(e.clientX-r.left)/r.width*preview.width, y:(e.clientY-r.top)/r.height*preview.height }; };
    const stroke = (from,to) => {
      const radius = Number(dialog.querySelector(".art-radius").value);
      if(tool.value==="repair") paintStroke(repairMask,output.width,output.height,from,to,radius,1);
      else {
        context.save();context.globalCompositeOperation=tool.value==="erase"?"destination-out":"source-over";
        context.strokeStyle=dialog.querySelector(".art-colour").value;context.lineWidth=radius*2;context.lineCap="round";
        context.beginPath();context.moveTo(from.x,from.y);context.lineTo(to.x+.001,to.y);context.stroke();context.restore();
      }
      draw();
    };
    preview.addEventListener("pointerdown",e=>{if(e.button!==0)return;e.preventDefault();history.push({ pixels:context.getImageData(0,0,output.width,output.height),mask:repairMask.slice() });if(history.length>12)history.shift();pointer=point(e);preview.setPointerCapture(e.pointerId);stroke(pointer,pointer);});
    preview.addEventListener("pointermove",e=>{if(!pointer)return;const next=point(e);stroke(pointer,next);pointer=next;});
    for(const name of ["pointerup","pointercancel"])preview.addEventListener(name,()=>{pointer=null;});
    dialog.querySelector(".art-undo").onclick=()=>{const frame=history.pop();if(frame){output.width=frame.pixels.width;output.height=frame.pixels.height;preview.width=output.width;preview.height=output.height;context.putImageData(frame.pixels,0,0);repairMask=frame.mask;draw();}};
    dialog.querySelector(".art-file").onchange=async e=>{const file=e.target.files[0];if(!file)return;const url=URL.createObjectURL(file);try{history.push({pixels:context.getImageData(0,0,output.width,output.height),mask:repairMask.slice()});await load(url);}catch(error){status.textContent=error.message;}finally{URL.revokeObjectURL(url);}};
    dialog.querySelector(".art-repair").onclick=async e=>{
      if(!repairMask.some(Boolean)){status.textContent="Mark the missing area with Repair mask first.";return;}
      e.target.disabled=true;status.textContent="Running local repair…";
      try {
        const c=document.createElement("canvas");c.width=output.width;c.height=output.height;const ctx=c.getContext("2d"),pixels=ctx.createImageData(c.width,c.height);
        for(let i=0;i<repairMask.length;i++)pixels.data.set([255,255,255,repairMask[i]?255:0],i*4);ctx.putImageData(pixels,0,0);
        const response=await fetch("/api/reconstruct",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({image:output.toDataURL(),mask:c.toDataURL()}),signal:controller.signal});
        const result=await response.json();if(!response.ok)throw new Error(result.error??"Repair failed.");
        if(!/^data:image\/png;base64,/.test(result.image))throw new Error("Repair helper returned invalid artwork.");
        const image=new Image();image.src=result.image;await image.decode();
        if(image.width!==output.width||image.height!==output.height)throw new Error("Repair helper changed the image dimensions.");
        history.push({pixels:context.getImageData(0,0,output.width,output.height),mask:repairMask.slice()});context.clearRect(0,0,output.width,output.height);context.drawImage(image,0,0);repairMask.fill(0);draw();status.textContent="Repair ready. Inspect the artwork before applying.";
      }catch(error){if(!closed)status.textContent=error.message;}finally{e.target.disabled=false;}
    };
    dialog.querySelector(".art-cancel").onclick=()=>dialog.close();
    dialog.querySelector(".art-apply").onclick=()=>{const result={src:output.toDataURL(),width:output.width,height:output.height};controller.abort();cleanup();resolve(result);};
    try {await load(layer.source.src,layer.source.crop);dialog.showModal();}catch(error){cleanup();reject(error);}
  });
}
