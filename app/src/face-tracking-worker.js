let landmarker;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      // Optional download only after the user enables webcam tracking. These
      // can be self-hosted at /static/mediapipe/ for an entirely offline setup.
      let vision;
      try { vision = await import("/static/mediapipe/vision_bundle.mjs"); }
      catch { vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs"); }
      const local = await fetch("/static/mediapipe/face_landmarker.task", { method: "HEAD" });
      const wasm = await vision.FilesetResolver.forVisionTasks(local.ok ? "/static/mediapipe/wasm" : "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm");
      landmarker = await vision.FaceLandmarker.createFromOptions(wasm, { baseOptions: { modelAssetPath: local.ok ? "/static/mediapipe/face_landmarker.task" : "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", delegate: "CPU" }, runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
      self.postMessage({type:"ready"});
    } else if (data.type === "frame") {
      try { self.postMessage({result:landmarker.detectForVideo(data.image,data.timeMs)}); } finally { data.image.close(); }
    }
  } catch(error) { self.postMessage({error:error.message}); }
};
