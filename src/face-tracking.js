const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export function trackingValues(result, neutral = {}, sensitivity = 1) {
  const scores = Object.fromEntries((result.faceBlendshapes?.[0]?.categories ?? []).map(c => [c.categoryName, c.score]));
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  if (!matrix || matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) return null;
  const yaw = Math.atan2(matrix[8], matrix[10]), pitch = Math.atan2(-matrix[9], Math.hypot(matrix[8], matrix[10])), roll = Math.atan2(matrix[1], matrix[5]);
  const value = (name) => clamp((scores[name] ?? 0) - (neutral[name] ?? 0));
  return {
    "head.yaw": clamp((yaw - (neutral.yaw ?? 0)) * sensitivity / .65, -1, 1),
    "head.pitch": clamp((pitch - (neutral.pitch ?? 0)) * sensitivity / .5, -1, 1),
    "head.roll": clamp((roll - (neutral.roll ?? 0)) * sensitivity / .5, -1, 1),
    "eyes.blink": 0,
    "eyes.blinkLeft": clamp((value("eyeBlinkLeft") - .12) / .6), "eyes.blinkRight": clamp((value("eyeBlinkRight") - .12) / .6),
    "eyes.squint": Math.max(value("eyeSquintLeft"), value("eyeSquintRight")),
    "eyes.lookX": clamp((value("eyeLookOutLeft")+value("eyeLookInRight")-value("eyeLookInLeft")-value("eyeLookOutRight"))*1.5,-1,1),
    "eyes.lookY": clamp((value("eyeLookDownLeft")+value("eyeLookDownRight")-value("eyeLookUpLeft")-value("eyeLookUpRight"))*1.5,-1,1),
    "brows.raise": clamp((value("browInnerUp")-Math.max(value("browDownLeft"),value("browDownRight")))*1.5,-1,1),
    "mouth.open": value("jawOpen"), "mouth.jaw": value("jawOpen"), "mouth.round": value("mouthPucker"),
    "mouth.smile": clamp((value("mouthSmileLeft")+value("mouthSmileRight")-value("mouthFrownLeft")-value("mouthFrownRight"))*.75,-1,1),
  };
}
export function trackingNeutral(result) {
  const scores = Object.fromEntries((result.faceBlendshapes?.[0]?.categories ?? []).map(c => [c.categoryName, c.score]));
  const m = result.facialTransformationMatrixes?.[0]?.data;
  if (!m || !result.faceLandmarks?.length) return null;
  return { ...scores, yaw: Math.atan2(m[8],m[10]), pitch: Math.atan2(-m[9],Math.hypot(m[8],m[10])), roll: Math.atan2(m[1],m[5]) };
}
export class FaceTracker {
  constructor(onValues, onStatus) { this.onValues = onValues; this.onStatus = onStatus; this.neutral = {}; this.sensitivity = 1; this.smoothing = .65; this.generation = 0; }
  calibrate() {
    const neutral = this.lastResult && trackingNeutral(this.lastResult);
    if (!neutral) throw new Error("Keep your face visible with eyes open to calibrate.");
    this.neutral = neutral; this.filtered = null;
  }
  async start() {
    this.stop();
    const generation = ++this.generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      if (generation !== this.generation) { stream.getTracks().forEach(t=>t.stop()); return; }
      this.stream = stream;
      this.video = document.createElement("video"); this.video.muted = true; this.video.playsInline = true; this.video.srcObject = this.stream; await this.video.play();
      if (generation !== this.generation) return;
      this.worker = new Worker(new URL("./face-tracking-worker.js", import.meta.url), { type: "module" });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(()=>reject(new Error("Tracking model download timed out.")),60000);
        this.worker.onerror = event => {clearTimeout(timeout);reject(new Error(event.message));};
        this.worker.onmessage = ({data}) => { if(data.type==="ready"){clearTimeout(timeout);resolve();} else if(data.error){clearTimeout(timeout);reject(new Error(data.error));} };
        this.worker.postMessage({ type:"init" });
      });
      if (generation !== this.generation) return;
      this.worker.onmessage = ({data}) => {
        this.busy = false;
        if(data.error){this.onStatus(data.error);this.onValues(null);return;}
        this.lastResult = data.result;
        const values = trackingValues(data.result,this.neutral,this.sensitivity);
        if(values){
          const amount = 1-this.smoothing;
          this.filtered ??= { ...values };
          for(const [id,value] of Object.entries(values))this.filtered[id]+= (value-this.filtered[id]) * (id.includes("blink")?.8:amount);
          this.onValues({ ...this.filtered });
        }else{this.filtered=null;this.onValues(null);}
      };
      this.timer = setInterval(async()=>{
        if(this.busy || !this.video.videoWidth)return;this.busy=true;
        try{const image=await createImageBitmap(this.video);if(generation!==this.generation){image.close();return;}this.worker.postMessage({type:"frame",image,timeMs:performance.now()},[image]);}
        catch(error){this.busy=false;this.onStatus(error.message);}
      },40);
      this.onStatus("Webcam tracking active. Calibrate with a relaxed face.");
    }catch(error){if(generation===this.generation)this.stop();throw error;}
  }
  stop() { ++this.generation; clearInterval(this.timer); this.worker?.terminate(); this.worker=null;this.stream?.getTracks().forEach(t=>t.stop()); this.video?.pause();this.stream=null;this.lastResult=null;this.filtered=null;this.busy=false;this.onValues(null); }
}
