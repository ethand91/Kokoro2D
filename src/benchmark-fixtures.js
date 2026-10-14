// Deterministic, original synthetic illustrations. These exercise geometry and
// style variation; they are not a substitute for an artist-reviewed corpus.
const HAIR = ["#211b2b", "#ecd39a", "#985acd", "#cb7050", "#e2e5ed", "#51868a"];
const SKIN = ["#f3d3bd", "#c89373", "#805044", "#efd8cd"];
export function benchmarkFixtures() {
  return Array.from({length:24},(_,index)=>{
    const width=320,height=440,skin=SKIN[index%4],hair=HAIR[index%6],eyeHeight=18+(index%3)*7,eyeWidth=34+(index%3)*4;
    const left={x:97,y:142,width:eyeWidth,height:eyeHeight},right={x:186,y:140+(index%2)*5,width:eyeWidth,height:eyeHeight};
    const mouth={x:145,y:206,width:32,height:8,sourceClosed:true};
    const glasses=index%4===0;
    const eye = r=>`<path d="M${r.x} ${r.y+r.height/2} Q${r.x+r.width/2} ${r.y-r.height*.5} ${r.x+r.width} ${r.y+r.height/2} Q${r.x+r.width/2} ${r.y+r.height*1.5} ${r.x} ${r.y+r.height/2}" fill="#fff7ee" stroke="#302039" stroke-width="3"/><ellipse cx="${r.x+r.width*.52}" cy="${r.y+r.height*.52}" rx="${r.width*.2}" ry="${r.height*.48}" fill="${index%2?'#527764':'#9d65aa'}"/><ellipse cx="${r.x+r.width*.53}" cy="${r.y+r.height*.52}" rx="${r.width*.09}" ry="${r.height*.35}" fill="#252038"/><circle cx="${r.x+r.width*.45}" cy="${r.y+r.height*.3}" r="3" fill="white"/>`;
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <path d="M61 124Q48 34 160 25Q282 33 269 149L288 380Q250 414 229 370L88 374Q50 412 33 378Z" fill="${hair}"/>
      <path d="M113 243Q160 263 207 243L255 294L284 440H36L65 294Z" fill="${index%2?'#656c9a':'#8e497c'}"/>
      <path d="M137 221H185L190 265Q160 283 130 265Z" fill="${skin}"/>
      <ellipse cx="160" cy="152" rx="81" ry="94" fill="${skin}"/>
      ${eye(left)}${eye(right)}
      <path d="M101 131Q118 123 135 129M186 127Q203 120 224 130" stroke="#3c2937" stroke-width="3" fill="none"/>
      <path d="M146 209Q160 218 177 207" stroke="#783f4f" stroke-width="3" fill="none"/>
      <path d="M78 114Q77 51 160 38Q244 48 250 112L226 103L214 74L205 118L177 91L163 126L130 83L108 124Z" fill="${hair}"/>
      ${glasses?'<g fill="none" stroke="#384151" stroke-width="3"><rect x="91" y="136" width="54" height="42" rx="10"/><rect x="179" y="136" width="54" height="42" rx="10"/><path d="M145 150Q160 144 179 150"/></g>':''}
      ${index%3===0?'<path d="M70 72L92 54L102 80L82 94Z" fill="#e09cab"/>':''}
    </svg>`;
    return {id:`synthetic-${index+1}`,name:`${["Dark","Blond","Purple","Copper","Silver","Teal"][index%6]} ${index+1}${glasses?' · glasses':''}`,svg,width,height,regions:{face:{x:79,y:58,width:162,height:188},leftEye:left,rightEye:right,mouth,backHair:{x:33,y:25,width:255,height:370},bangs:{x:77,y:35,width:173,height:92},leftHair:{x:32,y:110,width:72,height:288},rightHair:{x:226,y:104,width:63,height:294}}};
  });
}
export function poseCases() {
  const cases=[{name:"Neutral",values:{}},{name:"Half blink",values:{"eyes.blink":.5}},{name:"Closed",values:{"eyes.blink":1}},{name:"Left wink",values:{"eyes.blinkLeft":1}},{name:"Right wink",values:{"eyes.blinkRight":1}}];
  for(const yaw of [-1,1])for(const pitch of [-1,1])for(const blink of [0,.5,1])cases.push({name:`Turn ${yaw}, nod ${pitch}, blink ${blink}`,values:{"head.yaw":yaw,"head.pitch":pitch,"eyes.blink":blink,"eyes.lookX":-yaw,"eyes.lookY":pitch}});
  cases.push({name:"Rounded speech",values:{"mouth.open":.8,"mouth.round":1}},{name:"Smile",values:{"expr.happy":1,"mouth.smile":1}},{name:"Squint",values:{"eyes.squint":1,"brows.raise":-.5}});
  return cases;
}
