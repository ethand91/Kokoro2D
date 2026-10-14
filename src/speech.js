// Lightweight spectral mouth-shape estimate, not phoneme recognition. Higher
// spectral energy favours a wide shape; lower energy favours rounded lips.
export function speechShape(samples, spectrum, sampleRate, fftSize) {
  let energy=0, low=0, high=0;
  for(const sample of samples){const x=(sample-128)/128;energy+=x*x;}
  const rms=Math.sqrt(energy/Math.max(1,samples.length));
  const open=Math.max(0,Math.min(1,(rms-.012)*10));
  if(open===0)return {open:0,round:0,form:0};
  for(let i=0;i<spectrum.length;i++) {
    const hz=i*sampleRate/fftSize, power=10**(spectrum[i]/10);
    if(hz>=150&&hz<900)low+=power;
    if(hz>=900&&hz<3500)high+=power;
  }
  const balance=high/(low+high+1e-12);
  return {open,round:Math.max(0,Math.min(1,(.6-balance)*1.7)),form:Math.max(-1,Math.min(1,(balance-.4)*2))};
}
