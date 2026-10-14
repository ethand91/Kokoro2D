export async function measureRenderer(Renderer) {
  const { createModel, createLayer, ensureKeyform } = await import("/src/model.js");
  const { StageRecorder } = await import("/src/recorder.js");
  const canvas = document.createElement("canvas"); canvas.style.cssText = "width:640px;height:480px"; document.body.append(canvas);
  const renderer = new Renderer(canvas), results = [];
  const summarise = samples => {
    const sorted = [...samples].sort((a,b) => a-b);
    return { averageMs: samples.reduce((a,b) => a+b,0)/samples.length, p95Ms: sorted[Math.ceil(sorted.length*.95)-1], p99Ms: sorted[Math.ceil(sorted.length*.99)-1] };
  };
  for (const [name, layers, side] of [["small",4,64],["medium",32,128],["large",128,256]]) {
    const model = createModel(name);
    for (let i = 0; i < layers; i++) {
      const art = document.createElement("canvas"); art.width = art.height = side;
      art.getContext("2d").fillStyle = `hsl(${i*2},60%,50%)`; art.getContext("2d").fillRect(0,0,side,side);
      const layer = createLayer({name:"Layer "+i,src:art.toDataURL(),width:64,height:64,x:(i%16-8)*20,y:(Math.floor(i/16)-4)*20,columns:8,rows:8});
      ensureKeyform(layer, "head.yaw", 1).offsets[0] = 2; model.layers.push(layer);
    }
    const at = performance.now(); await renderer.setModel(model); const loadMs = performance.now()-at;
    const switchTimes = [];
    for (let i = 0; i < 10; i++) { const at = performance.now(); await renderer.setModel(model); switchTimes.push(performance.now()-at); }
    const cpu = [], intervals = []; let previous;
    for (let i = 0; i < 140; i++) {
      const now = await new Promise(requestAnimationFrame);
      renderer.render({"head.yaw":Math.sin(i/20)});
      if (i >= 20) { cpu.push(renderer.metrics.frameMs); intervals.push(now-previous); }
      previous = now;
    }
    const recorder = new StageRecorder(canvas); const recordingTimes = []; recorder.start(); const owned = recorder.stream;
    for (let i = 0; i < 30; i++) { await new Promise(requestAnimationFrame); const at = performance.now(); renderer.render({}); recorder.frame(); recordingTimes.push(performance.now()-at); }
    const blob = await recorder.stop();
    if (!blob?.size || owned.getVideoTracks().some(track => track.readyState !== "ended")) throw new Error("Recording benchmark failed");
    results.push({ name, layers, textureSide:side, samples:cpu.length, cpu:summarise(cpu), frameInterval:summarise(intervals), drawCalls:renderer.metrics.drawCalls, textureBytes:renderer.metrics.textureBytes, surfaceBytes:renderer.metrics.surfaceBytes, loadMs, switching:summarise(switchTimes), recording:{frames:30,bytes:blob.size,cpu:summarise(recordingTimes),tracksReleased:true}, resources:renderer.diagnostics?.() ?? {layers:renderer.resources.size,textures:renderer.textures.size,surfaces:renderer.targets.length} });
  }
  const cycles = { count: 10, videoTracksReleased: 0 };
  for (let i = 0; i < cycles.count; i++) {
    const recorder = new StageRecorder(canvas); recorder.start(); const stream = recorder.stream;
    renderer.render({}); recorder.frame(); await new Promise(resolve => setTimeout(resolve, 50)); await recorder.stop();
    cycles.videoTracksReleased += stream.getVideoTracks().filter(track => track.readyState === "ended").length;
  }
  renderer.dispose(); const disposed = {layers:renderer.resources.size,textures:renderer.textures.size,surfaces:renderer.targets.length}; canvas.remove();
  return { results, recordingCycles: cycles, disposed };
}
