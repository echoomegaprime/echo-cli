/* ECHO Prime living orb. Native WebGL with a full 2D fallback; no remote assets or model/service calls.
 *
 * Contract (consumed here; sibling modules dispatch, everything is additive and optional):
 *  - document CustomEvent 'echo-orb-state'  detail {mode, amplitude?, intensity?, source?}
 *      modes: idle | listening | thinking | deep | replying | speaking | error | success.
 *      Sources arbitrate: speaking > replying > deep > thinking > listening > idle. 'error' and 'success' are timed
 *      overlays that restore the winning mode. 'idle' from a source clears only that source's claim. 'speaking' and
 *      'listening' without a source are attributed to 'voice'; everything else without a source is 'app'. The listening
 *      ripple and the speaking amplitude overlay whatever mode wins.
 *  - document CustomEvent 'echo-orb-pulse'  detail {strength?}  (token arrival) == window.EchoOrb.pulse(strength)
 *  - document CustomEvent 'echo-orb-satellites'  detail {source?, satellites:[{id, kind:'agent'|'bot'|'swarm', name, status, busy, group?}]}
 *      status: paused | idle | running | error (default idle). Lists merge per source: with `source` the list replaces that
 *      source's entries; without it the list replaces the kinds it contains, and an empty list without a source clears all.
 *      Capped at 24 (busy first, then bots, swarm, agents). Anonymous users are sent nothing, so nothing orbits.
 *  - document CustomEvent 'echo-orb-open'  detail {id, kind}  dispatched here when a moon is clicked or tapped.
 *  window.EchoOrb (installed by mount): setState, getState, pulse, setSatellites, satellites, arcs, links, destroy.
 *  bots.js (sibling slice) publishes on every list refresh, for example:
 *    document.dispatchEvent(new CustomEvent('echo-orb-satellites',{detail:{source:'bots',satellites:bots.map(b=>({id:'bot:'+b.bot_id,
 *      kind:'bot',name:b.name,status:b.status,busy:b.status==='running'||inLiveGroup(b),group:inLiveGroup(b)?group.groupId:undefined}))}}));
 */
(() => {
  'use strict';
  const VERTEX = `attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}`;
  const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 resolution, pointer;
uniform float time,ftime;
uniform vec3 colorA,colorB,colorC;
uniform vec4 modeA,modeB,modeC,modeD;
uniform vec4 arcLights[4];
float hash(vec3 p){p=fract(p*.3183099+vec3(.17,.31,.73));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*noise(p);p=p*2.03+vec3(1.2,3.4,2.1);a*=.49;}return s;}
mat2 rot(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
vec3 hueRot(vec3 c,float a){mat3 toYIQ=mat3(.299,.596,.211,.587,-.274,-.523,.114,-.322,.312);mat3 toRGB=mat3(1.,1.,1.,.956,-.272,-1.106,.621,-.647,1.703);vec3 yiq=toYIQ*c;float co=cos(a),si=sin(a);yiq.yz=mat2(co,si,-si,co)*yiq.yz;return clamp(toRGB*yiq,0.,1.);}
void main(){
 vec2 uv=(gl_FragCoord.xy-.5*resolution)/resolution.y;
 vec3 ro=vec3(0.,0.,3.3),rd=normalize(vec3(uv*2.5,-3.));
 float scale=modeC.w,R=.83*scale;
 float b=dot(ro,rd),h=b*b-dot(ro,ro)+R*R;
 float d=length(uv)/scale,energy=modeA.x,swirl=modeA.y,pulse=modeA.z,rimBoost=modeA.w;
 float gr=(d-.305)/.085;
 float glow=(exp(-pow(d/.35,3.))*0.06+exp(-gr*gr)*.035)*(1.+rimBoost*1.8+pulse*.9+energy*.6);
 vec3 col=mix(colorA,colorC,smoothstep(-.3,.3,uv.x))*.22;
 float alpha=glow;
 float rip=pow(max(0.,sin((d-.33)*46.-time*5.5)),10.)*exp(-max(0.,d-.33)*7.)*step(.33,d)*modeB.x;
 col+=mix(colorB,vec3(1.),.3)*rip*.55;alpha+=rip*.45;
 float rg=(d-(.33+modeD.x*.45))/.03;
 float ring=exp(-rg*rg)*modeB.w;
 col+=mix(colorA,vec3(1.),.55)*ring*1.2;alpha+=ring*.8;
 if(h>0.){
   float hit=-b-sqrt(h);vec3 p=ro+rd*hit,n=normalize(p);vec3 q=p/scale;
   q.xz=rot(ftime*.065)*q.xz;q.yz=rot(-.12+sin(ftime*.08)*.12)*q.yz;
   float twist=swirl*(.6+.25*sin(ftime*.6))*exp(-dot(q.xy,q.xy)*1.2);
   q.xy=rot(twist*sin(ftime*.45+length(q.xy)*4.))*q.xy;
   float drift=ftime*.075;
   vec3 warp=vec3(noise(q*2.3+drift),noise(q.zxy*2.8-drift),noise(q.yzx*2.5+drift*.6))-.5;
   float fluid=fbm(q*5.2+warp*2.3+vec3(drift,-drift*.35,0.));
   float fine=fbm(q*17.+warp*2.+vec3(0.,drift*.4,0.));
   float veins=pow(max(0.,1.-abs(sin(fluid*26.+q.y*3.4))),8.);
   float waves=pow(max(0.,1.-abs(sin(fine*22.+fluid*5.))),12.);
   float hue=modeC.y*.9;
   vec3 cA=hueRot(colorA,hue*sin(ftime*.35)),cB=hueRot(colorB,hue*sin(ftime*.35+1.3)),cC=hueRot(colorC,hue*sin(ftime*.35+2.1));
   vec3 palette=mix(cA,cB,smoothstep(.26,.65,fluid+q.x*.12));
   palette=mix(palette,cC,smoothstep(.16,.83,noise(q*1.6+vec3(0.,0.,drift)) +q.x*.18-q.y*.1));
   // Two-tone vortex: logarithmic spiral arms advected inward (constant-phase contours 2*angle + k*log(r)); the integer
   // angular frequency keeps the atan branch cut seamless and the centre is faded before atan could see (0,0).
   float vR=length(q.xy);vec2 vDir=vR<.05?vec2(1.,0.):q.xy;float vAng=atan(vDir.y,vDir.x);
   float vFlow=log(max(vR,.05))+mix(.1,.32,swirl)*ftime;
   float vWave=.5+.5*sin(2.*vAng+mix(5.,8.,swirl)*vFlow+.55*(fluid-.5));
   vec3 vortex=mix(cA,cC,smoothstep(.25,.75,vWave))*(.9+.1*sin(11.*vFlow));
   float vMask=smoothstep(.05,.15,vR)*(1.-smoothstep(.78,1.,vR));
   palette=mix(palette,vortex,swirl*(.35+.65*swirl)*vMask);
   vec3 bump=normalize(n+warp*.13);
   vec3 key=normalize(vec3(-.8+pointer.x*.5,1.2+pointer.y*.35,1.5));
   vec3 fill=normalize(vec3(1.3,-.35,.35));
   float diffuse=max(dot(bump,key),0.);
   float rim=pow(1.-max(dot(n,-rd),0.),3.8)*(1.+rimBoost*1.4+pulse*.6);
   float spec=pow(max(dot(reflect(-key,bump),-rd),0.),52.);
   float grazing=pow(max(dot(reflect(-fill,n),-rd),0.),15.);
   float structure=.14+fluid*.3+veins*.67+waves*.23;
   float shadow=smoothstep(-.55,.75,dot(n,key));
   col=palette*structure*(.18+diffuse*.85)*(.53+shadow*.47)*(1.+energy*.35+pulse*.25+modeC.z*.4);
   col+=palette*(veins*.35+waves*.22)*(.4+.6*diffuse);
   col+=mix(cA,cB,.45)*rim*(.65+.45*diffuse);
   col+=cC*grazing*.27+vec3(.77,1.,.93)*spec*.6;
   // Internal lightning while thinking hard: a piecewise-linear trunk (two noise samples share cell endpoints, so it
   // stays connected) with two attached branches, a pale core, a coloured halo and stepped flicker.
   vec2 ePos=rot(.55+ftime*.15)*q.xy;float eTick=floor(time*14.);
   float eGrid=ePos.x*14.,eCell=floor(eGrid),eFrac=fract(eGrid);
   float eN0=noise(vec3(eCell,eTick*.37,2.)),eN1=noise(vec3(eCell+1.,eTick*.37,2.));
   float eTrunk=.1*ePos.x+.24*(mix(eN0,eN1,eFrac)-.5);
   float eB1=eTrunk+.65*max(ePos.x+.28,0.),eB2=eTrunk-.8*max(ePos.x-.02,0.);
   vec3 eDist=abs(vec3(ePos.y)-vec3(eTrunk,eB1,eB2));
   vec3 eGate=vec3(1.,step(-.28,ePos.x)*(1.-smoothstep(.18,.48,ePos.x)),step(.02,ePos.x)*(1.-smoothstep(.38,.66,ePos.x)));
   vec3 eCores=(vec3(1.)-smoothstep(.003,.009,eDist))*eGate,eHalos=(vec3(1.)-smoothstep(.009,.045,eDist))*eGate;
   float eCore=max(eCores.x,max(eCores.y,eCores.z)),eHalo=max(eHalos.x,max(eHalos.y,eHalos.z));
   float eEnv=(1.-smoothstep(.65,.9,abs(ePos.x)))*(1.-smoothstep(.65,.98,vR));
   float eStrength=modeC.x*eEnv*(.15+.85*hash(vec3(eTick,1.,7.)));
   col+=eStrength*(mix(cB,vec3(1.),.85)*eCore*1.4+cB*eHalo*.3);
   // Shimmer: a specular band travelling across the sphere (squared by multiplication: pow of a signed base is undefined).
   float bandPos=fract(time*.09)*3.4-1.7;
   float bandX=(dot(p.xy,vec2(.8,.6))-bandPos)*4.2;
   float band=exp(-bandX*bandX)*modeB.y;
   col+=vec3(.9,1.,.97)*band*.28*(.35+diffuse)*(1.-rim*.5);
   // Soft highlights on the limb facing a firing satellite.
   for(int i=0;i<4;i++){col+=mix(cB,vec3(1.),.5)*pow(max(dot(n,arcLights[i].xyz),0.),5.)*arcLights[i].w*.95;}
   float inner=pow(max(0.,1.-length(uv)/(.305*scale)),2.);
   col+=mix(cA,cC,.5)*inner*.025;
   // Surface occlusion and a dark translucent center preserve dimensional form.
   col*=.87-.14*exp(-dot(uv,uv)*65.);
   float flick=.55+.45*hash(vec3(floor(time*28.),3.,5.));
   col=mix(col,vec3(1.,.22,.17)*(.35+structure*.9+rim*.8),modeB.z*flick*.85);
   col=1.-exp(-col*1.6);alpha=1.;
 }
 gl_FragColor=vec4(col,alpha);
}`;
  const PARTICLE_VERTEX = `
precision highp float;
attribute vec3 position;attribute float seed;attribute float kind;
uniform float time,aspect,pixelRatio;uniform vec2 pointer;
varying float intensity,tint,isRing;
mat2 rot(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
void main(){
 vec3 p=position;float t=time*.07;
 if(kind<.5){p*=1.+.014*sin(p.y*9.+t*2.+seed*8.);p.xz=rot(t+pointer.x*.035)*p.xz;p.yz=rot(-.12+sin(t)*.1+pointer.y*.025)*p.yz;}
 else if(kind<1.5){p.xz=rot(t*.45)*p.xz;p.xy=rot(sin(t*.5)*.055)*p.xy;}
 else{p.y+=sin(t+seed*8.)*.04;p.x+=cos(t*.7+seed*3.)*.025;}
 float z=3.3-p.z;gl_Position=vec4(2.4*p.x/z/aspect,2.4*p.y/z,0.,1.);
 gl_PointSize=pixelRatio*(kind<.5?mix(.7,1.9,seed):kind<1.5?mix(.6,1.65,seed):mix(.5,2.4,seed))*(3.3/z);
 intensity=(kind<.5?(p.z<0.?.07:.28+.48*seed):kind<1.5?.12+seed*.26:.13+seed*.2);
 intensity*=.65+.35*sin(time*.35+seed*30.);
 tint=seed;isRing=kind;
}`;
  const PARTICLE_FRAGMENT = `precision mediump float;
uniform vec3 colorA,colorB,colorC;varying float intensity,tint,isRing;
void main(){float d=length(gl_PointCoord-.5)*2.;if(d>1.)discard;
vec3 c=tint<.5?mix(colorA,colorB,tint*2.):mix(colorB,colorC,(tint-.5)*2.);
c=mix(c,vec3(.85,1.,.93),.35);float a=(1.-smoothstep(.05,1.,d))*intensity;
gl_FragColor=vec4(c,a);}`;
  // Moons: shaded point sprites; the ones behind the sphere's limb (z < R*R/d) are clipped by its screen-space disc.
  // `halo` is read by both stages, so its precision is spelled out: a highp/mediump mismatch is a link error in GLSL ES 1.00.
  const MOON_VERTEX = `
precision highp float;
attribute vec3 position;attribute float size;attribute vec3 color;attribute float glow;
uniform float aspect,pixelRatio,limbZ;uniform mediump float halo;
varying vec3 vColor;varying float vBehind,vGlow;
void main(){float z=3.3-position.z;gl_Position=vec4(2.4*position.x/z/aspect,2.4*position.y/z,0.,1.);
 gl_PointSize=pixelRatio*size*(3.3/z)*(halo>.5?3.2:1.);vColor=color;vBehind=position.z<limbZ?1.:0.;vGlow=glow;}`;
  const MOON_FRAGMENT = `precision mediump float;
uniform vec3 sphere;uniform mediump float halo;
varying vec3 vColor;varying float vBehind,vGlow;
void main(){vec2 c=gl_PointCoord-.5;float d=length(c)*2.;if(d>1.)discard;
 if(vBehind>.5&&distance(gl_FragCoord.xy,sphere.xy)<sphere.z)discard;
 if(halo>.5){float a=pow(1.-d,2.2)*vGlow*.42*(vBehind>.5?.5:1.);gl_FragColor=vec4(vColor,a);return;}
 vec3 n=vec3(c.x,-c.y,sqrt(max(0.,1.-d*d)));vec3 l=normalize(vec3(-.55,.65,.55));
 float diff=max(dot(n,l),0.),rim=pow(1.-n.z,2.5);
 vec3 col=vColor*(.25+.75*diff)+vColor*rim*.6+vec3(1.)*pow(max(dot(reflect(-l,n),vec3(0.,0.,1.)),0.),24.)*.5;
 float a=(1.-smoothstep(.72,1.,d))*(vBehind>.5?.75:1.);
 gl_FragColor=vec4(col*(1.+vGlow*.5),a);}`;
  // Glow lines: lightning bolts, orbit trails and steady links share one additive program.
  const LINE_VERTEX = `attribute vec2 position;attribute vec4 color;uniform float pointSize;varying vec4 vColor;
void main(){gl_Position=vec4(position,0.,1.);gl_PointSize=pointSize;vColor=color;}`;
  const LINE_FRAGMENT = `precision mediump float;uniform float soft;varying vec4 vColor;
void main(){float a=vColor.a;if(soft>.5){float d=length(gl_PointCoord-.5)*2.;if(d>1.)discard;a*=pow(1.-d,2.);}gl_FragColor=vec4(vColor.rgb,a);}`;
  const PALETTES = {
    prism:[[.22,.94,.63],[.18,.72,.88],[.62,.38,.88]],
    emerald:[[.3,.95,.53],[.14,.65,.52],[.7,.85,.38]],
    aurora:[[.27,.69,.92],[.62,.43,.92],[.94,.38,.65]],
  };
  const MODES=['idle','listening','thinking','deep','replying','speaking','error','success'];
  const PRIORITY={speaking:8,replying:7,deep:6,thinking:5,listening:4,idle:0};
  // Visual targets per mode: energy, swirl, flow speed, rim bloom, shimmer, filaments, hue drift.
  const LOOK={
    idle:     {energy:.15,swirl:0,  flow:1,   rim:0,  shimmer:.35,filaments:0,  hue:0},
    listening:{energy:.35,swirl:.05,flow:1.15,rim:.45,shimmer:.5, filaments:0,  hue:0},
    thinking: {energy:.55,swirl:.55,flow:1.9, rim:.25,shimmer:.6, filaments:.15,hue:.5},
    deep:     {energy:1,  swirl:1,  flow:2.7, rim:.4, shimmer:.8, filaments:1,  hue:1},
    replying: {energy:.7, swirl:.25,flow:1.5, rim:.9, shimmer:.9, filaments:.1, hue:.15},
    speaking: {energy:.6, swirl:.2, flow:1.4, rim:.6, shimmer:.7, filaments:0,  hue:.1},
    error:    {energy:.6, swirl:.1, flow:1.2, rim:.3, shimmer:.3, filaments:0,  hue:0},
    success:  {energy:.8, swirl:.1, flow:1.3, rim:1,  shimmer:.9, filaments:0,  hue:0},
  };
  const KINDS={agent:{size:4.6,radius:1.1,speed:.3,weight:1},bot:{size:7,radius:1.32,speed:.19,weight:3},swarm:{size:9,radius:1.58,speed:.12,weight:2}};
  const STATUSES=['paused','idle','running','error'];
  const MAX_SATS=24,MAX_ARCS=12,SEGMENTS=16,TRAIL=10,MAX_LIGHTS=4,ERROR_MS=900,SUCCESS_MS=720,TIP_MS=1600,TAU=Math.PI*2;
  // A moon centre is hidden by the sphere once its depth drops below the limb, z < R*R/d (camera at d=3.3, sphere R=.83).
  const LIMB_Z=.83*.83/3.3;
  const now=()=>Date.now();
  const clamp01=v=>typeof v==='number'&&Number.isFinite(v)?Math.min(1,Math.max(0,v)):0;
  function hash(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0)/4294967296;}
  function prand(n){const x=Math.sin(n*12.9898+78.233)*43758.5453;return x-Math.floor(x);}
  function hueRotate(c,a,out){const Y=.299*c[0]+.587*c[1]+.114*c[2],I=.596*c[0]-.274*c[1]-.322*c[2],Q=.211*c[0]-.523*c[1]+.312*c[2],co=Math.cos(a),si=Math.sin(a),I2=I*co-Q*si,Q2=I*si+Q*co;
    out[0]=Math.min(1,Math.max(0,Y+.956*I2+.621*Q2));out[1]=Math.min(1,Math.max(0,Y-.272*I2-.647*Q2));out[2]=Math.min(1,Math.max(0,Y-1.106*I2+1.703*Q2));return out;}
  function dispatch(name,detail){try{if(typeof document.dispatchEvent==='function'&&typeof CustomEvent==='function')document.dispatchEvent(new CustomEvent(name,{detail}));}catch{}}

  /** Shared state, satellites and arcs for both renderers. Everything is preallocated; the frame loop allocates nothing. */
  function createScene(){
    const claims={};let transient=null,transientTimer=0,flashAt=-Infinity,errorAt=-Infinity;
    const state={mode:'idle',intensity:0,amplitude:0,source:'app'};
    const look={energy:.15,swirl:0,flow:1,rim:0,shimmer:.35,filaments:0,hue:0,pulse:0,ripple:0,red:0,flash:0,flashR:0,ampl:0,scale:1,intensity:0};
    const goal={energy:.15,swirl:0,flow:1,rim:0,shimmer:.35,filaments:0,hue:0,ripple:0,ampl:0,intensity:0};
    const sources=new Map();
    const sats=[];for(let i=0;i<MAX_SATS;i++)sats.push({id:'',kind:'agent',name:'',status:'idle',busy:false,group:'',size:4,radius:1.1,speed:.3,incl:0,tilt:0,phase:0,dir:1,ecc:0,peri:0,ci:1,si:0,ct:1,st:0,cp:1,sp:0,sq:1,glow:0,color:new Float32Array(3),x:0,y:0,z:0,sx:0,sy:0,k:1,nextArc:0,nextLink:0,trail:new Float32Array(TRAIL*2),trailLen:0,trailAt:0});
    let satCount=0;
    const arcs=[];for(let i=0;i<MAX_ARCS;i++)arcs.push({active:false,a:-1,b:-1,born:0,life:0,seed:0,alpha:0});
    const lights=new Float32Array(MAX_LIGHTS*4);
    const bolt=new Float32Array((SEGMENTS+1)*2);
    let clock=0,fclock=0,hover=-1,hoverId='',tipUntil=0;
    const palette=[new Float32Array(3),new Float32Array(3),new Float32Array(3)];
    const base=[new Float32Array(3),new Float32Array(3),new Float32Array(3)];
    const self={
      state,look,sats,arcs,lights,bolt,palette,base,
      get satCount(){return satCount;},get clock(){return clock;},get fclock(){return fclock;},get hover(){return hover;},
      setBase(colors){for(let i=0;i<3;i++){base[i][0]=colors[i][0];base[i][1]=colors[i][1];base[i][2]=colors[i][2];}},
      setState(detail){
        if(!detail||typeof detail!=='object')return false;
        const mode=detail.mode;if(!MODES.includes(mode))return false;
        const source=typeof detail.source==='string'&&detail.source?detail.source.slice(0,32):(mode==='speaking'||mode==='listening')?'voice':'app';
        const amplitude=clamp01(detail.amplitude),intensity=clamp01(detail.intensity);
        if(mode==='error'||mode==='success'){
          transient={mode,until:now()+(mode==='error'?ERROR_MS:SUCCESS_MS)};
          if(mode==='error')errorAt=now();else flashAt=now();
          if(transientTimer)clearTimeout(transientTimer);
          transientTimer=setTimeout(()=>{transientTimer=0;self.expire();self.onStatic?.();},(mode==='error'?ERROR_MS:SUCCESS_MS)+5);
        }else if(mode==='idle')delete claims[source];
        else claims[source]={mode,amplitude,intensity,at:now()};
        return self.recompute(source);
      },
      expire(){if(transient&&now()>=transient.until){transient=null;self.recompute(state.source);return true;}return false;},
      recompute(source){
        let best='idle',bestSource=source||'app',rank=0,amplitude=0,intensity=0,ripple=0;
        for(const key in claims){const c=claims[key];const r=PRIORITY[c.mode]||0;if(r>rank){rank=r;best=c.mode;bestSource=key;}if(c.mode==='speaking')amplitude=Math.max(amplitude,c.amplitude);if(c.mode==='listening')ripple=1;intensity=Math.max(intensity,c.intensity);}
        const effective=transient?transient.mode:best;
        state.mode=effective;state.source=transient?(source||bestSource):bestSource;state.amplitude=amplitude;state.intensity=intensity;
        const L=LOOK[effective];goal.energy=L.energy;goal.swirl=L.swirl;goal.flow=L.flow;goal.rim=L.rim;goal.shimmer=L.shimmer;goal.filaments=L.filaments;goal.hue=L.hue;
        goal.ripple=ripple;goal.ampl=amplitude;goal.intensity=intensity;
        self.onMode?.(effective);return true;
      },
      pulse(strength){const s=typeof strength==='number'&&Number.isFinite(strength)?Math.min(2,Math.max(0,strength)):1;look.pulse=Math.min(1.4,look.pulse+s*.6);return look.pulse;},
      /** Smooths the look toward the goal and advances satellites, arcs and lights by dt seconds. */
      step(dt,motion){
        if(transient&&now()>=transient.until)self.expire();
        clock+=dt;fclock+=dt*look.flow;
        const t=now(),ease=Math.min(1,dt*4.5);
        for(const key in goal){look[key]+=(goal[key]-look[key])*(key==='ampl'?Math.min(1,dt*14):key==='ripple'?Math.min(1,dt*6):ease);}
        look.pulse=motion?look.pulse*Math.exp(-dt*6):0; // static redraws never animate, so a pulse must not accumulate there
        const et=(t-errorAt)/ERROR_MS;look.red=et<1?Math.max(0,1-et*et)*(transient&&transient.mode==='error'?1:.4):0;
        const ft=(t-flashAt)/SUCCESS_MS;look.flash=ft<1?1-ft:0;look.flashR=ft<1?ft:0;
        look.scale=1+.016*Math.sin(clock*1.4)*(.3+look.energy)+look.pulse*.05+look.ampl*.08+look.flash*.02;
        const hue=look.hue*.9;
        for(let i=0;i<3;i++)hueRotate(base[i],hue*Math.sin(fclock*.35+i*1.3+(i===2?.8:0)),palette[i]);
        self.orbit(motion);
        if(motion)self.arcStep(t);else for(const a of arcs)a.active=false;
        self.lightStep(t);
      },
      /** Orbital positions in sphere space: Keplerian ellipses with the sphere at a focus (moons dive and whip past
       *  periapsis), inclined and tilted per moon, the whole system slowly spinning. A frozen clock is a static layout. */
      orbit(motion){
        const c=Math.cos(clock*.025),sn=Math.sin(clock*.025);
        for(let i=0;i<satCount;i++){
          const s=sats[i],e=s.ecc,m=(s.phase+clock*s.speed*s.dir)%TAU;
          let E=m+e*Math.sin(m);E-=(E-e*Math.sin(E)-m)/(1-e*Math.cos(E));
          const ox=(Math.cos(E)-e)*s.radius,oy=Math.sin(E)*s.sq*s.radius;
          let x=ox*s.cp-oy*s.sp,y=ox*s.sp+oy*s.cp,z=y*s.si;y*=s.ci;
          const xx=x*s.ct-y*s.st;y=x*s.st+y*s.ct;x=xx;
          s.x=x*c+z*sn;s.y=y;s.z=z*c-x*sn;x=s.x;z=s.z;
          if(motion&&clock-s.trailAt>.05){s.trailAt=clock;const n=Math.min(TRAIL,s.trailLen+1);for(let k=n-1;k>0;k--){s.trail[k*2]=s.trail[(k-1)*2];s.trail[k*2+1]=s.trail[(k-1)*2+1];}s.trail[0]=x;s.trail[1]=y;s.trailLen=n;}
          self.colorFor(s);
        }
      },
      colorFor(s){
        const A=palette[0],B=palette[1],C=palette[2],c=s.color;
        if(s.status==='running'){c[0]=A[0]+(1-A[0])*.45;c[1]=A[1]+(1-A[1])*.45;c[2]=A[2]+(1-A[2])*.45;s.glow=1;}
        else if(s.status==='error'){c[0]=1*.85+C[0]*.15;c[1]=.26*.85+C[1]*.15;c[2]=.2*.85+C[2]*.15;s.glow=.8;}
        else if(s.status==='paused'){c[0]=(C[0]*.3+.45*.7)*.55;c[1]=(C[1]*.3+.45*.7)*.55;c[2]=(C[2]*.3+.45*.7)*.55;s.glow=0;}
        else{c[0]=(B[0]*.7+C[0]*.3)*.85;c[1]=(B[1]*.7+C[1]*.3)*.85;c[2]=(B[2]*.7+C[2]*.3)*.85;s.glow=.35;}
        if(s.busy)s.glow=Math.min(1.4,s.glow+.45);
      },
      /** Replaces one source's satellites (or the kinds present when no source is named) and rebuilds the capped roster. */
      setSatellites(detail){
        if(!detail||typeof detail!=='object')return false;
        const list=Array.isArray(detail.satellites)?detail.satellites:Array.isArray(detail)?detail:null;if(!list)return false;
        const clean=[];const seen=new Set();
        for(const raw of list){
          if(!raw||typeof raw!=='object')continue;
          const id=typeof raw.id==='string'?raw.id.slice(0,120):'';const kind=raw.kind;
          if(!id||!KINDS[kind]||seen.has(id))continue;seen.add(id);
          const status=STATUSES.includes(raw.status)?raw.status:'idle';
          clean.push({id,kind,name:typeof raw.name==='string'&&raw.name.trim()?raw.name.trim().slice(0,80):id,status,busy:raw.busy===true||status==='running',group:typeof raw.group==='string'?raw.group.slice(0,64):''});
          if(clean.length>=200)break;
        }
        const source=typeof detail.source==='string'&&detail.source?detail.source.slice(0,32):'';
        if(source)sources.set(source,clean);
        else if(!clean.length)sources.clear();
        else{const kinds=new Set(clean.map(s=>s.kind));for(const [key,items] of sources)sources.set(key,items.filter(s=>!kinds.has(s.kind)));sources.set('*',[...(sources.get('*')||[]).filter(s=>!kinds.has(s.kind)),...clean]);}
        self.rebuild();return true;
      },
      rebuild(){
        const all=[];for(const items of sources.values())all.push(...items);
        all.sort((a,b)=>(b.busy-a.busy)||(KINDS[b.kind].weight-KINDS[a.kind].weight)||(a.id<b.id?-1:a.id>b.id?1:0));
        const n=Math.min(MAX_SATS,all.length);
        for(let i=0;i<n;i++){
          const src=all[i],s=sats[i],K=KINDS[src.kind];
          if(s.id!==src.id){
            s.trailLen=0;s.nextArc=0;s.nextLink=0;
            const h=hash(src.id),h2=hash(src.id+'/t'),h3=hash(src.id+'/p');
            s.incl=.55+h*1.9;s.tilt=h2*TAU;s.phase=h3*TAU;s.dir=h2>.5?1:-1;s.ecc=.06+hash(src.id+'/e')*.09;s.peri=hash(src.id+'/q')*TAU;
            s.ci=Math.cos(s.incl);s.si=Math.sin(s.incl);s.ct=Math.cos(s.tilt);s.st=Math.sin(s.tilt);s.cp=Math.cos(s.peri);s.sp=Math.sin(s.peri);s.sq=Math.sqrt(1-s.ecc*s.ecc);
          }
          s.id=src.id;s.kind=src.kind;s.name=src.name;s.status=src.status;s.busy=src.busy;s.group=src.group;
          s.size=K.size;s.radius=K.radius+(hash(src.id+'/r')-.5)*.14;s.speed=K.speed*(.85+hash(src.id+'/s')*.3);
        }
        satCount=n;if(hover>=n){hover=-1;hoverId='';}
        for(const a of arcs)if(a.a>=n||a.b>=n)a.active=false;
        self.orbit(false);
      },
      busyCount(){let n=0;for(let i=0;i<satCount;i++)if(sats[i].busy)n++;return n;},
      activeArcs(){let n=0;for(const a of arcs)if(a.active)n++;return n;},
      spawn(a,b,t){for(const arc of arcs){if(arc.active)continue;arc.active=true;arc.a=a;arc.b=b;arc.born=t;arc.life=140+prand(t*.37+a*3+b*7)*140;arc.seed=Math.floor(t*.013)+a*17+b*31;arc.alpha=1;return arc;}return null;},
      /** Time-scheduled bolts: every busy satellite fires to the core; busy members of one group fire to each other. */
      arcStep(t){
        for(const arc of arcs){if(!arc.active)continue;const age=(t-arc.born)/arc.life;if(age>=1){arc.active=false;continue;}arc.alpha=age<.15?age/.15:1-(age-.15)/.85;}
        const busy=self.busyCount();if(!busy)return;
        const rate=Math.min(1.6,.45+busy*.14),cap=Math.min(MAX_ARCS,2+busy*2);let spawned=0;
        // Bolts only reach moons in front of the limb; one aimed behind the sphere would cross its face.
        for(let i=0;i<satCount&&spawned<2;i++){
          const s=sats[i];if(!s.busy||s.z<LIMB_Z)continue;
          if(!s.nextArc)s.nextArc=t+200+prand(i*7.1+t*.001)*900/rate;
          if(t>=s.nextArc){s.nextArc=t+(380+prand(i*3.7+t*.003)*1100)/rate;if(self.activeArcs()<cap&&self.spawn(-1,i,t))spawned++;}
          if(!s.group)continue;
          if(!s.nextLink)s.nextLink=t+500+prand(i*5.3+t*.002)*1200;
          if(t>=s.nextLink){s.nextLink=t+(700+prand(i*9.1+t*.004)*1500)/rate;for(let j=i+1;j<satCount;j++){const o=sats[j];if(o.busy&&o.z>=LIMB_Z&&o.group===s.group&&self.activeArcs()<cap&&spawned<2){if(self.spawn(i,j,t))spawned++;break;}}}
        }
      },
      lightStep(){
        lights.fill(0);let n=0;
        for(const arc of arcs){if(!arc.active||n>=MAX_LIGHTS)continue;const s=sats[arc.a<0?arc.b:arc.a];const len=Math.hypot(s.x,s.y,s.z)||1;lights[n*4]=s.x/len;lights[n*4+1]=s.y/len;lights[n*4+2]=s.z/len;lights[n*4+3]=arc.alpha*(arc.a<0?.9:.45);n++;}
      },
      /** Writes a jittered bolt between two screen points into `bolt` (SEGMENTS+1 pairs) and returns the point count. */
      makeBolt(x0,y0,x1,y1,seed,t){
        bolt[0]=x0;bolt[1]=y0;bolt[SEGMENTS*2]=x1;bolt[SEGMENTS*2+1]=y1;
        const len=Math.hypot(x1-x0,y1-y0),nx=-(y1-y0)/(len||1),ny=(x1-x0)/(len||1),frame=Math.floor(t/40);
        for(let step=SEGMENTS;step>1;step>>=1){
          for(let i=0;i<SEGMENTS;i+=step){
            const m=i+step/2,ax=bolt[i*2],ay=bolt[i*2+1],bx=bolt[(i+step)*2],by=bolt[(i+step)*2+1];
            const off=(prand(seed+m*13.7+frame*.731+step)-.5)*len*.22*(step/SEGMENTS);
            bolt[m*2]=(ax+bx)/2+nx*off;bolt[m*2+1]=(ay+by)/2+ny*off;
          }
        }
        return SEGMENTS+1;
      },
      hit(px,py,maxDistance){let best=-1,bd=maxDistance;for(let i=0;i<satCount;i++){const s=sats[i];const d=Math.hypot(s.sx-px,s.sy-py)-s.size*s.k*.6;if(d<bd){bd=d;best=i;}}return best;},
      setHover(index,t){hover=index;hoverId=index>=0?sats[index].id:'';if(index>=0)tipUntil=t+TIP_MS;},
      get hoverId(){return hoverId;},get tipUntil(){return tipUntil;},
      snapshot(){
        const list=[];for(let i=0;i<satCount;i++){const s=sats[i];list.push({id:s.id,kind:s.kind,name:s.name,status:s.status,busy:s.busy,group:s.group||undefined,size:s.size,color:[s.color[0],s.color[1],s.color[2]],glow:s.glow,x:s.x,y:s.y,z:s.z,sx:s.sx,sy:s.sy,front:s.z>=LIMB_Z});}return list;
      },
      arcList(){const list=[];for(const a of arcs)if(a.active)list.push({from:a.a<0?'core':sats[a.a].id,to:sats[a.b].id,alpha:a.alpha,kind:a.a<0?'core':'group'});return list;},
      linkList(){const list=[];for(let i=0;i<satCount;i++)if(sats[i].busy)list.push({to:sats[i].id,steady:true});return list;},
      getState(){return {mode:state.mode,source:state.source,intensity:state.intensity,amplitude:state.amplitude,transient:transient?transient.mode:null,pulse:look.pulse,ripple:look.ripple,red:look.red,flash:look.flash,energy:look.energy,swirl:look.swirl,hover:hover>=0?{id:sats[hover].id,name:sats[hover].name,kind:sats[hover].kind}:null,satellites:satCount,arcs:self.activeArcs(),claims:Object.keys(claims)};},
      destroy(){if(transientTimer)clearTimeout(transientTimer);transientTimer=0;},
    };
    return self;
  }
  /** Installs the public window.EchoOrb surface and the document listeners for one mounted orb. */
  function expose(scene,hooks){
    const onState=e=>{if(scene.setState(e&&e.detail))hooks.changed();};
    const onSatellites=e=>{if(scene.setSatellites(e&&e.detail))hooks.changed();};
    const onPulse=e=>{scene.pulse(e&&e.detail&&e.detail.strength);hooks.changed();};
    const listen=typeof document.addEventListener==='function';
    if(listen){document.addEventListener('echo-orb-state',onState);document.addEventListener('echo-orb-satellites',onSatellites);document.addEventListener('echo-orb-pulse',onPulse);}
    const api={
      setState(detail){const ok=scene.setState(detail);if(ok)hooks.changed();return ok;},
      getState(){return scene.getState();},
      pulse(strength){const v=scene.pulse(strength);hooks.changed();return v;},
      setSatellites(detail){const ok=scene.setSatellites(Array.isArray(detail)?{satellites:detail}:detail);if(ok)hooks.changed();return ok;},
      satellites(){return scene.snapshot();},arcs(){return scene.arcList();},links(){return scene.linkList();},
      destroy(){if(listen){document.removeEventListener('echo-orb-state',onState);document.removeEventListener('echo-orb-satellites',onSatellites);document.removeEventListener('echo-orb-pulse',onPulse);}if(window.EchoOrb===api)window.EchoOrb=undefined;},
    };
    window.EchoOrb=api;return api;
  }
  /** Hover tooltip and open-on-click for the moons; shared by both renderers. */
  function pointerBridge(canvas,scene,redraw){
    let tip=null;
    function ensureTip(){if(tip||!canvas.parentNode||typeof document.createElement!=='function')return;try{tip=document.createElement('div');tip.className='orb-tip';tip.hidden=true;tip.setAttribute('role','tooltip');canvas.parentNode.insertBefore(tip,canvas.nextSibling);}catch{tip=null;}}
    function show(){
      ensureTip();const i=scene.hover;
      if(canvas.dataset)canvas.dataset.orbHover=String(i>=0);
      if(!tip)return;
      if(i<0){tip.hidden=true;return;}
      const s=scene.sats[i];tip.textContent='';
      try{const name=document.createElement('strong'),meta=document.createElement('small');name.textContent=s.name;meta.textContent=s.kind+' · '+s.status+(s.busy?' · busy':'');tip.append(name,meta);}catch{tip.textContent=s.name;}
      tip.style.left=s.sx+'px';tip.style.top=(s.sy-s.size*s.k*.7)+'px';tip.hidden=false;
    }
    function locate(event){const r=canvas.getBoundingClientRect();return [event.clientX-r.left,event.clientY-r.top];}
    function move(event){const [x,y]=locate(event);const hit=scene.hit(x,y,14);if(hit!==scene.hover){scene.setHover(hit,now());show();redraw();}}
    function leave(){if(scene.hover>=0){scene.setHover(-1,now());show();redraw();}}
    function click(event){const [x,y]=locate(event);const hit=scene.hit(x,y,18);if(hit<0)return;scene.setHover(hit,now());show();const s=scene.sats[hit];dispatch('echo-orb-open',{id:s.id,kind:s.kind});}
    canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerleave',leave);canvas.addEventListener('click',click);
    return {refresh(){if(scene.hover>=0)show();},destroy(){canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('click',click);if(tip&&tip.parentNode)tip.parentNode.removeChild(tip);tip=null;}};
  }
  function stageMode(canvas,mode){try{if(canvas.dataset)canvas.dataset.orbMode=mode;const stage=canvas.parentNode;if(stage&&stage.dataset)stage.dataset.orbMode=mode;}catch{}}

  // A full projected-particle renderer also serves browsers without WebGL.
  function mountCanvas(canvas,options){
    const ctx=canvas.getContext('2d',{alpha:true});
    if(!ctx){options.onFallback?.();return {motion:false,setPalette(){},setMotion(){},setQuality(){},destroy(){}};}
    canvas.dataset.renderer='canvas-3d';
    const mq=matchMedia('(prefers-reduced-motion: reduce)');
    let motion=!mq.matches,palette='prism',quality='adaptive',frame=0,last=0,dead=false;
    let width=1,height=1,dpr=1,pointer=[0,0],target=[0,0],pts=new Float32Array(0),count=0,stars=new Float32Array(0),starCount=0,drawCount=0;
    const scene=createScene();scene.setBase(PALETTES[palette]);
    const R3=new Float64Array(3),P3=new Float64Array(3),T3=new Float64Array(3),M3=new Float64Array(3);
    const rgb=(c,a=1)=>`rgba(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)},${a})`;
    const mix=(a,b,t,out=M3)=>{out[0]=a[0]+(b[0]-a[0])*t;out[1]=a[1]+(b[1]-a[1])*t;out[2]=a[2]+(b[2]-a[2])*t;return out;};
    const WHITE=[1,1,1],MINT=[.83,1,.95],GLASS=[.55,.85,.76],DEEP=[.01,.035,.05];
    const tintCache=new Array(32*8);let tintKey='';
    function tint(x,y){const colors=scene.palette,t=Math.max(0,Math.min(1,(x+1)*.55+y*.12));return t<.5?mix(colors[0],colors[1],t*2,T3):mix(colors[1],colors[2],(t-.5)*2,T3);}
    function tintStyle(x,y,alpha){
      const key=palette+':'+Math.round(scene.look.hue*Math.sin(scene.fclock*.35)*64);
      if(key!==tintKey){tintKey=key;for(let ti=0;ti<32;ti++){const t=ti/31,c=t<.5?mix(scene.palette[0],scene.palette[1],t*2,T3):mix(scene.palette[1],scene.palette[2],(t-.5)*2,T3);mix(c,MINT,.16,T3);for(let ai=0;ai<8;ai++)tintCache[ai*32+ti]=rgb(T3,(ai+1)/8);}}
      const t=Math.max(0,Math.min(1,(x+1)*.55+y*.12));return tintCache[Math.round(Math.max(0,Math.min(1,alpha))*7)*32+Math.round(t*31)];
    }
    function makePoints(){count=quality==='high'?3200:quality==='quiet'?800:2000;pts=new Float32Array(count*4);for(let i=0;i<count;i++){const y=1-2*(i+.5)/count,r=Math.sqrt(1-y*y),a=i*2.39996323;pts[i*4]=Math.cos(a)*r*.842;pts[i*4+1]=y*.842;pts[i*4+2]=Math.sin(a)*r*.842;pts[i*4+3]=((i*73)%997)/997;}
      starCount=quality==='high'?140:quality==='quiet'?50:90;stars=new Float32Array(starCount*4);for(let i=0;i<starCount;i++){stars[i*4]=prand(i*1.7+.3)*2-1;stars[i*4+1]=prand(i*2.9+.7)*2-1;stars[i*4+2]=.3+prand(i*4.1+.1)*.7;stars[i*4+3]=prand(i*6.3+.9);}}
    function rotate(x,y,z,a){const c=Math.cos(a),s=Math.sin(a),xx=x*c+z*s;z=z*c-x*s;x=xx;const angle=-.16+Math.sin(scene.clock*.035)*.12+pointer[1]*.035,cc=Math.cos(angle),ss=Math.sin(angle);R3[0]=x;R3[1]=y*cc-z*ss;R3[2]=y*ss+z*cc;return R3;}
    function project(x,y,z){const k=height*1.2/(3.3-z);P3[0]=width/2+x*k;P3[1]=height/2-y*k;P3[2]=k;return P3;}
    function orbit(front){const clock=scene.clock;ctx.lineWidth=.55;for(let ring=0;ring<3;ring++){const c=scene.palette[ring],incl=[1.15,.92,1.37][ring],tilt=[.38,1.08,2.14][ring]+Math.sin(clock*.03)*.04;ctx.strokeStyle=rgb(c,front?.24:.085);ctx.beginPath();let connected=false;for(let i=0;i<=240;i++){const a=i/240*Math.PI*2;let x=Math.cos(a)*1.19,y=Math.sin(a)*1.19,z=y*Math.sin(incl);y*=Math.cos(incl);const xx=x*Math.cos(tilt)-y*Math.sin(tilt);y=x*Math.sin(tilt)+y*Math.cos(tilt);x=xx;rotate(x,y,z,clock*.025);if((R3[2]>=0)!==front){connected=false;continue;}project(R3[0],R3[1],R3[2]);if(connected)ctx.lineTo(P3[0],P3[1]);else ctx.moveTo(P3[0],P3[1]);connected=true;}ctx.stroke();}}
    function satScreen(){for(let i=0;i<scene.satCount;i++){const s=scene.sats[i];project(s.x,s.y,s.z);s.sx=P3[0];s.sy=P3[1];s.k=P3[2]/(height*.37);}}
    function moons(front){
      const clock=scene.clock;
      for(let i=0;i<scene.satCount;i++){
        const s=scene.sats[i];if((s.z>=LIMB_Z*scene.look.scale*scene.look.scale)!==front)continue;
        const size=s.size*s.k*(1+(s.busy?.08*Math.sin(clock*7+i):0)),dim=front?1:.75;
        if(motion&&quality!=='quiet'&&s.trailLen>1){ctx.beginPath();project(s.x,s.y,s.z);ctx.moveTo(P3[0],P3[1]);for(let k=0;k<s.trailLen;k++){project(s.trail[k*2],s.trail[k*2+1],s.z);ctx.lineTo(P3[0],P3[1]);}ctx.strokeStyle=rgb(s.color,.16*dim*(s.busy?1.5:1));ctx.lineWidth=Math.max(.5,size*.25);ctx.stroke();}
        if(s.glow>0){const g=ctx.createRadialGradient(s.sx,s.sy,0,s.sx,s.sy,size*3.2);g.addColorStop(0,rgb(s.color,.4*s.glow*dim));g.addColorStop(1,rgb(s.color,0));ctx.fillStyle=g;ctx.fillRect(s.sx-size*3.2,s.sy-size*3.2,size*6.4,size*6.4);}
        const g=ctx.createRadialGradient(s.sx-size*.35,s.sy-size*.4,size*.1,s.sx,s.sy,size);g.addColorStop(0,rgb(mix(s.color,WHITE,.55),dim));g.addColorStop(.55,rgb(s.color,dim));g.addColorStop(1,rgb(mix(s.color,DEEP,.75),dim));
        ctx.fillStyle=g;ctx.beginPath();ctx.arc(s.sx,s.sy,size,0,Math.PI*2);ctx.fill();
        if(i===scene.hover){ctx.strokeStyle=rgb(WHITE,.8);ctx.lineWidth=1;ctx.beginPath();ctx.arc(s.sx,s.sy,size+3,0,Math.PI*2);ctx.stroke();}
      }
    }
    function bolts(){
      const t=now(),B=scene.bolt;
      for(const arc of scene.arcs){
        if(!arc.active)continue;const to=scene.sats[arc.b];let x0,y0;
        if(arc.a<0){const len=Math.hypot(to.x,to.y,to.z)||1;project(to.x/len*.83,to.y/len*.83,to.z/len*.83);x0=P3[0];y0=P3[1];}else{x0=scene.sats[arc.a].sx;y0=scene.sats[arc.a].sy;}
        const n=scene.makeBolt(x0,y0,to.sx,to.sy,arc.seed,t),c=arc.a<0?scene.palette[1]:to.color;
        ctx.lineWidth=3;ctx.strokeStyle=rgb(c,.22*arc.alpha);ctx.beginPath();ctx.moveTo(B[0],B[1]);for(let i=1;i<n;i++)ctx.lineTo(B[i*2],B[i*2+1]);ctx.stroke();
        ctx.lineWidth=1;ctx.strokeStyle=rgb(mix(c,WHITE,.7),.95*arc.alpha);ctx.beginPath();ctx.moveTo(B[0],B[1]);for(let i=1;i<n;i++)ctx.lineTo(B[i*2],B[i*2+1]);ctx.stroke();
      }
    }
    function links(){for(let i=0;i<scene.satCount;i++){const s=scene.sats[i];if(!s.busy)continue;const len=Math.hypot(s.x,s.y,s.z)||1;project(s.x/len*.83,s.y/len*.83,s.z/len*.83);ctx.strokeStyle=rgb(s.color,.28);ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(P3[0],P3[1]);ctx.lineTo(s.sx,s.sy);ctx.stroke();}}
    function draw(){
      if(dead)return;drawCount++;
      const look=scene.look,colors=scene.palette,clock=scene.clock,fclock=scene.fclock,cx=width/2,cy=height/2,r=height*.312*look.scale;
      satScreen();
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
      let g=ctx.createRadialGradient(cx,cy,r*.75,cx,cy,r*(1.6+look.rim*.5+look.energy*.3));g.addColorStop(0,rgb(colors[0],.07+look.rim*.08+look.pulse*.06));g.addColorStop(.5,rgb(colors[1],.035+look.rim*.04));g.addColorStop(1,rgb(colors[2],0));ctx.fillStyle=g;ctx.fillRect(0,0,width,height);
      // Star field with pointer parallax.
      ctx.globalCompositeOperation='lighter';
      for(let i=0;i<starCount;i++){const depth=stars[i*4+2],x=cx+stars[i*4]*width*.5+pointer[0]*depth*18,y=cy+stars[i*4+1]*height*.5-pointer[1]*depth*14,tw=.5+.5*Math.sin(clock*(.6+depth)+stars[i*4+3]*20);if(Math.hypot(x-cx,y-cy)<r*1.05)continue;ctx.fillStyle=rgb(colors[i%3],(.08+.22*tw)*depth);const sz=depth>.8?1.4:.8;ctx.fillRect(x,y,sz,sz);}
      ctx.globalCompositeOperation='source-over';
      orbit(false);
      ctx.globalCompositeOperation='lighter';if(!motion)links();moons(false);ctx.globalCompositeOperation='source-over';
      // A solid tinted body keeps the emerald volume visible throughout the animation.
      ctx.fillStyle=rgb(mix(colors[0],DEEP,.9));ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
      // Analytic lighting: a shaded glass core, reflected color and a soft rim.
      g=ctx.createRadialGradient(cx-r*.38+pointer[0]*8,cy-r*.45-pointer[1]*6,r*.02,cx,cy,r);g.addColorStop(0,rgb(mix(colors[0],GLASS,.5),.28+look.energy*.1));g.addColorStop(.35,rgb(colors[0],.16));g.addColorStop(.75,'rgba(3,12,16,.72)');g.addColorStop(.96,rgb(mix(colors[1],colors[2],.5),.17+look.rim*.2));g.addColorStop(1,rgb(colors[1],.42+look.rim*.4));ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
      ctx.save();ctx.beginPath();ctx.arc(cx,cy,r-.5,0,Math.PI*2);ctx.clip();
      g=ctx.createRadialGradient(cx+r*.52,cy+r*.2,0,cx+r*.3,cy+r*.1,r*.9);g.addColorStop(0,rgb(colors[2],.13));g.addColorStop(1,rgb(colors[2],0));ctx.fillStyle=g;ctx.fillRect(cx-r,cy-r,2*r,2*r);
      // Braided flowing field lines follow the visible hemisphere.
      ctx.globalCompositeOperation='lighter';
      for(let band=0;band<27;band++){const y0=-.95+band/26*1.9;let connected=false;ctx.beginPath();for(let i=0;i<=148;i++){const a=i/148*Math.PI*2,y=y0+.035*Math.sin(a*4+fclock*.19+band*.46),ring=Math.sqrt(Math.max(0,1-y*y));rotate(Math.cos(a)*ring*.823,y*.823,Math.sin(a)*ring*.823,fclock*.075);const ripple=1+.012*Math.sin(a*11+fclock*.21+band*.4);const x=R3[0]*ripple,yy=R3[1]*ripple,z=R3[2];if(z<.08){connected=false;continue;}project(x,yy,z);if(connected)ctx.lineTo(P3[0],P3[1]);else ctx.moveTo(P3[0],P3[1]);connected=true;}ctx.lineWidth=band%4===0?.65:.35;ctx.strokeStyle=rgb(mix(colors[0],colors[2],band/27),(band%4===0?.24:.12)*(1+look.energy*.5));ctx.stroke();}
      // A second oblique filament layer gives the sphere volume, not a flat grid.
      for(let strand=0;strand<18;strand++){ctx.beginPath();let connected=false;for(let i=0;i<=125;i++){const a=i/125*Math.PI,b= strand/18*Math.PI*2+Math.sin(a*3+fclock*.1)*.26;rotate(Math.sin(a)*Math.cos(b)*.831,Math.cos(a)*.831,Math.sin(a)*Math.sin(b)*.831,fclock*.055+.7);if(R3[2]<.15){connected=false;continue;}project(R3[0],R3[1],R3[2]);if(connected)ctx.lineTo(P3[0],P3[1]);else ctx.moveTo(P3[0],P3[1]);connected=true;}ctx.strokeStyle=rgb(colors[(strand+1)%3],.15);ctx.lineWidth=.55;ctx.stroke();}
      // Projected particles; additive blending makes depth order irrelevant, so nothing is sorted or allocated.
      for(let i=0;i<count;i++){const px=pts[i*4],py=pts[i*4+1],pz=pts[i*4+2],s=pts[i*4+3];const wobble=1+.011*Math.sin(py*11+fclock*.22+s*4);rotate(px*wobble,py*wobble,pz*wobble,fclock*.075+pointer[0]*.025);const x=R3[0],y=R3[1],z=R3[2];if(z<-.12)continue;project(x,y,z);const sx=P3[0],sy=P3[1],front=Math.max(0,z/.842),shine=.6+.4*Math.sin(s*31+fclock*.35);const alpha=(.25+front*.72)*(.65+s*.35)*(.7+.3*shine);const size=(.65+s*.85)*(P3[2]/(height*.37));ctx.fillStyle=tintStyle(x,y,alpha);ctx.fillRect(sx-size/2,sy-size/2,size,size);if(s>.988&&front>.2){const c=tint(x,y),sz=2.3+front;g=ctx.createRadialGradient(sx,sy,0,sx,sy,sz*2);g.addColorStop(0,rgb(mix(c,WHITE,.5),.7));g.addColorStop(.25,rgb(c,.2));g.addColorStop(1,rgb(c,0));ctx.fillStyle=g;ctx.fillRect(sx-sz*2,sy-sz*2,sz*4,sz*4);}}
      // Two-tone vortex while thinking; brighter and tighter when thinking hard.
      if(look.swirl>.02){ctx.lineWidth=1.1;for(let arm=0;arm<6;arm++){ctx.beginPath();for(let i=0;i<=60;i++){const u=i/60,ang=arm/6*Math.PI*2+u*5.5+fclock*.9*(arm%2?1:-1)*.6,rad=r*(.08+u*.78);ctx.lineTo(cx+Math.cos(ang)*rad,cy+Math.sin(ang)*rad*.86);}ctx.strokeStyle=rgb(arm%2?colors[0]:colors[2],.22*look.swirl);ctx.stroke();}}
      // Internal lightning filaments.
      if(look.filaments>.02){const t=now(),B=scene.bolt,flick=.55+.45*prand(Math.floor(t/48));for(let f=0;f<4;f++){const a0=f*1.7+fclock*.4,a1=a0+2.2+Math.sin(fclock+f)*.8;const n=scene.makeBolt(cx+Math.cos(a0)*r*.25,cy+Math.sin(a0)*r*.25,cx+Math.cos(a1)*r*.8,cy+Math.sin(a1)*r*.8,f*41,t);ctx.lineWidth=1;ctx.strokeStyle=rgb(mix(colors[1],WHITE,.6),.75*look.filaments*flick);ctx.beginPath();ctx.moveTo(B[0],B[1]);for(let i=1;i<n;i++)ctx.lineTo(B[i*2],B[i*2+1]);ctx.stroke();}}
      // Shimmer: a specular band travelling across the sphere.
      {const pos=(((clock*.09)%1)*3.4-1.7)*r,ang=-.64;const dx=Math.cos(ang),dy=Math.sin(ang);g=ctx.createLinearGradient(cx+dx*(pos-r*.3),cy+dy*(pos-r*.3),cx+dx*(pos+r*.3),cy+dy*(pos+r*.3));g.addColorStop(0,'rgba(230,255,247,0)');g.addColorStop(.5,rgb(MINT,.18*look.shimmer));g.addColorStop(1,'rgba(230,255,247,0)');ctx.fillStyle=g;ctx.fillRect(cx-r,cy-r,2*r,2*r);}
      // Soft limb highlights facing a firing satellite.
      for(let i=0;i<MAX_LIGHTS;i++){const w=scene.lights[i*4+3];if(w<=0)continue;const lx=cx+scene.lights[i*4]*r*.95,ly=cy-scene.lights[i*4+1]*r*.95;g=ctx.createRadialGradient(lx,ly,0,lx,ly,r*.55);g.addColorStop(0,rgb(mix(colors[1],WHITE,.5),.45*w));g.addColorStop(1,rgb(colors[1],0));ctx.fillStyle=g;ctx.fillRect(cx-r,cy-r,2*r,2*r);}
      ctx.globalCompositeOperation='source-over';
      if(look.red>.01){const flick=.55+.45*prand(Math.floor(now()/36));ctx.fillStyle=`rgba(255,56,43,${(.55*look.red*flick).toFixed(3)})`;ctx.fillRect(cx-r,cy-r,2*r,2*r);}
      ctx.restore();ctx.globalCompositeOperation='lighter';orbit(true);
      // Bright orbital sparks only while no real satellite orbits; sparse suspended dust always.
      if(!scene.satCount)for(let j=0;j<3;j++){const a=clock*(.12+j*.025)+j*2.1,incl=[1.15,.92,1.37][j],tilt=[.38,1.08,2.14][j];let x=Math.cos(a)*1.19,y=Math.sin(a)*1.19,z=y*Math.sin(incl);y*=Math.cos(incl);const xx=x*Math.cos(tilt)-y*Math.sin(tilt);y=x*Math.sin(tilt)+y*Math.cos(tilt);x=xx;rotate(x,y,z,clock*.025);if(R3[2]<0)continue;project(R3[0],R3[1],R3[2]);const px=P3[0],py=P3[1];g=ctx.createRadialGradient(px,py,0,px,py,7);g.addColorStop(0,'rgba(228,255,248,.9)');g.addColorStop(.13,rgb(colors[j],.65));g.addColorStop(.5,rgb(colors[j],.09));g.addColorStop(1,rgb(colors[j],0));ctx.fillStyle=g;ctx.fillRect(px-7,py-7,14,14);}
      for(let i=0;i<58;i++){const a=i*2.39996323+clock*.008,rr=1.16+(i*53%97)/97*.55;project(Math.cos(a)*rr,Math.sin(a)*rr*.72,Math.sin(i*1.7)*.2);ctx.fillStyle=rgb(colors[i%3],.1+.13*(.5+.5*Math.sin(clock*.4+i)));ctx.fillRect(P3[0],P3[1],i%9===0?1.2:.6,i%9===0?1.2:.6);}
      // Listening ripples and the success flash ring sit just outside the sphere.
      if(look.ripple>.02){ctx.lineWidth=1.2;for(let k=0;k<3;k++){const ph=((clock*.9+k/3)%1),rr=r*(1.04+ph*.42);ctx.strokeStyle=rgb(mix(colors[1],WHITE,.3),(1-ph)*.42*look.ripple);ctx.beginPath();ctx.arc(cx,cy,rr,0,Math.PI*2);ctx.stroke();}}
      if(look.flash>.01){const rr=r*(1.05+look.flashR*1.4);ctx.lineWidth=2+look.flash*3;ctx.strokeStyle=rgb(mix(colors[0],WHITE,.55),look.flash*.9);ctx.beginPath();ctx.arc(cx,cy,rr,0,Math.PI*2);ctx.stroke();}
      moons(true);if(motion)bolts();
      ctx.globalCompositeOperation='source-over';
    }
    function resize(){const r=canvas.getBoundingClientRect();width=Math.max(1,r.width);height=Math.max(1,r.height);dpr=Math.min(devicePixelRatio||1,quality==='high'?2:quality==='quiet'?1:1.5);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);scene.step(0,motion);draw();}
    function tick(stamp){frame=0;if(dead||!motion||document.hidden)return;const dt=last?Math.min((stamp-last)/1000,.06):0;last=stamp;pointer[0]+=(target[0]-pointer[0])*.035;pointer[1]+=(target[1]-pointer[1])*.035;scene.step(dt,true);draw();bridge.refresh();frame=requestAnimationFrame(tick);}
    function schedule(){if(frame)cancelAnimationFrame(frame);frame=0;last=0;if(motion&&!dead&&!document.hidden)frame=requestAnimationFrame(tick);else if(!dead){scene.step(0,false);draw();}}
    function move(e){const r=canvas.getBoundingClientRect();target[0]=(e.clientX-r.left)/r.width*2-1;target[1]=1-(e.clientY-r.top)/r.height*2;if(!motion){pointer[0]=target[0];pointer[1]=target[1];draw();}}
    function leave(){target[0]=0;target[1]=0;}
    function reduced(){motion=!mq.matches;options.onMotionChange?.(motion);schedule();}
    const changed=()=>{if(dead)return;stageMode(canvas,scene.state.mode);if(!motion){scene.step(0,false);draw();}};
    scene.onMode=mode=>stageMode(canvas,mode);scene.onStatic=()=>{if(!motion&&!dead){scene.step(0,false);draw();}};
    const bridge=pointerBridge(canvas,scene,()=>{if(!motion&&!dead)draw();});
    const api=expose(scene,{changed});
    stageMode(canvas,'idle');
    makePoints();resize();const observer=new ResizeObserver(resize);observer.observe(canvas);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerleave',leave);document.addEventListener('visibilitychange',schedule);mq.addEventListener('change',reduced);schedule();
    return {get motion(){return motion;},get frames(){return drawCount;},setPalette(v){if(PALETTES[v]){palette=v;scene.setBase(PALETTES[v]);scene.step(0,motion);draw();}},setQuality(v){if(['adaptive','high','quiet'].includes(v)){quality=v;makePoints();resize();}},setMotion(v){motion=Boolean(v);schedule();},destroy(){dead=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerleave',leave);document.removeEventListener('visibilitychange',schedule);mq.removeEventListener('change',reduced);bridge.destroy();api.destroy();scene.destroy();}};
  }
  function mount(canvas, options={}) {
    let gl;try{gl=canvas.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false,powerPreference:'low-power',preserveDrawingBuffer:false});}catch{}
    if(!gl) return mountCanvas(canvas,options);
    canvas.dataset.renderer='webgl';
    const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
    let motion=!motionQuery.matches,quality='adaptive',palette='prism',frame=0,dead=false,lost=false,ready=false;
    let clock=0,last=0,ratio=1,width=1,height=1,slowFrames=0,adaptiveCap=1.5,drawCount=0;
    let pointer=[0,0],target=[0,0],core,particles,moonProgram,lineProgram,quad,cloud,moonBuffer,lineBuffer,count=0;
    const scene=createScene();scene.setBase(PALETTES[palette]);
    const resources=[];const locations=new Map();
    const MOON_STRIDE=8,moonData=new Float32Array(MAX_SATS*MOON_STRIDE),LINE_STRIDE=6;
    const lineCap=MAX_ARCS*SEGMENTS*2+MAX_SATS*TRAIL*2+MAX_SATS*2+MAX_ARCS*(SEGMENTS+1),lineData=new Float32Array(lineCap*LINE_STRIDE);
    const P2=new Float64Array(3);
    function shader(type,code){const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error('ECHO orb shader: '+message);}resources.push(['shader',s]);return s;}
    function program(vertex,fragment){const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const message=gl.getProgramInfoLog(p);gl.deleteProgram(p);throw new Error('ECHO orb program failed: '+message);}resources.push(['program',p]);return p;}
    function buffer(data,usage){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data instanceof Float32Array?data:new Float32Array(data),usage||gl.STATIC_DRAW);resources.push(['buffer',b]);return b;}
    function makeCloud(){const data=[],n=quality==='high'?3600:quality==='quiet'?900:2200;
      const add=(x,y,z,s,k)=>data.push(x,y,z,s,k);
      for(let i=0;i<n;i++){const y=1-2*(i+.5)/n,r=Math.sqrt(1-y*y),a=i*2.39996323;add(Math.cos(a)*r*.842,y*.842,Math.sin(a)*r*.842,((i*73)%997)/997,0);}
      for(let ring=0;ring<3;ring++){const nRing=quality==='quiet'?128:320;for(let i=0;i<nRing;i++){const a=i/nRing*Math.PI*2;let x=Math.cos(a)*1.19,y=Math.sin(a)*1.19,z=0;const tilt=[.38,1.08,2.14][ring],incl=[1.15,.92,1.37][ring];z=y*Math.sin(incl);y*=Math.cos(incl);const xx=x*Math.cos(tilt)-y*Math.sin(tilt);y=x*Math.sin(tilt)+y*Math.cos(tilt);x=xx;add(x,y,z,((i*19+ring*127)%311)/311,1);}}
      const dust=quality==='high'?150:quality==='quiet'?60:110;
      for(let i=0;i<dust;i++){const a=i*2.39996323,r=1.22+((i*53)%97)/97*.65;add(Math.cos(a)*r,Math.sin(a)*r*.68,Math.sin(i*1.71)*.2,((i*37)%83)/83,2);}
      if(cloud){gl.deleteBuffer(cloud);const index=resources.findIndex(r=>r[1]===cloud);if(index>=0)resources.splice(index,1);}
      cloud=buffer(data);count=data.length/5;
    }
    function init(){locations.clear();core=program(VERTEX,FRAGMENT);particles=program(PARTICLE_VERTEX,PARTICLE_FRAGMENT);moonProgram=program(MOON_VERTEX,MOON_FRAGMENT);lineProgram=program(LINE_VERTEX,LINE_FRAGMENT);quad=buffer([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]);moonBuffer=buffer(moonData,gl.DYNAMIC_DRAW);lineBuffer=buffer(lineData,gl.DYNAMIC_DRAW);makeCloud();ready=true;resize();}
    function resize(){const rect=canvas.getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);const cap=quality==='high'?2:quality==='quiet'?.85:adaptiveCap;ratio=Math.min(devicePixelRatio||1,cap);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);if(!lost&&!dead){scene.step(0,motion);draw();}}
    function location(prog,name){let map=locations.get(prog);if(!map){map=new Map();locations.set(prog,map);}let loc=map.get(name);if(loc===undefined){loc=gl.getUniformLocation(prog,name);map.set(name,loc);}return loc;}
    function uniform(prog,name,type,...value){const loc=location(prog,name);if(loc!==null)gl[type](loc,...value);}
    function colors(prog){const c=scene.base;for(let i=0;i<3;i++)uniform(prog,['colorA','colorB','colorC'][i],'uniform3f',c[i][0],c[i][1],c[i][2]);}
    function attrib(prog,name,size,stride,offset){const a=gl.getAttribLocation(prog,name);if(a>=0){gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,size,gl.FLOAT,false,stride,offset);}return a;}
    function project(x,y,z){const d=3.3-z;P2[0]=2.4*x/d/(width/height);P2[1]=2.4*y/d;P2[2]=3.3/d;return P2;}
    function satScreen(){for(let i=0;i<scene.satCount;i++){const s=scene.sats[i];project(s.x,s.y,s.z);s.sx=(P2[0]+1)/2*width;s.sy=(1-P2[1])/2*height;s.k=P2[2]*height*1.2/3.3/(height*.37);}}
    function fillMoons(){for(let i=0;i<scene.satCount;i++){const s=scene.sats[i],o=i*MOON_STRIDE;moonData[o]=s.x;moonData[o+1]=s.y;moonData[o+2]=s.z;moonData[o+3]=s.size*1.9*(1+(s.busy?.08*Math.sin(scene.clock*7+i):0));moonData[o+4]=s.color[0]*(i===scene.hover?1.3:1);moonData[o+5]=s.color[1]*(i===scene.hover?1.3:1);moonData[o+6]=s.color[2]*(i===scene.hover?1.3:1);moonData[o+7]=s.glow+(i===scene.hover?.5:0);}}
    let lineVerts=0,boltStart=0,boltVerts=0,glowStart=0,glowVerts=0;
    function vertex(px,py,r,g,b,a){if(lineVerts>=lineCap)return;const o=lineVerts*LINE_STRIDE;lineData[o]=px/width*2-1;lineData[o+1]=1-py/height*2;lineData[o+2]=r;lineData[o+3]=g;lineData[o+4]=b;lineData[o+5]=a;lineVerts++;}
    /** Trails and steady links first (LINES), then bolts (LINES) and their glow points (POINTS), all in one buffer. */
    function fillLines(){
      lineVerts=0;const B=scene.bolt,t=now();
      for(let i=0;i<scene.satCount;i++){const s=scene.sats[i];
        if(motion&&quality!=='quiet'&&s.trailLen>1){const dim=s.z>=LIMB_Z?1:.6;let px=s.sx,py=s.sy;for(let k=0;k<s.trailLen;k++){project(s.trail[k*2],s.trail[k*2+1],s.z);const qx=(P2[0]+1)/2*width,qy=(1-P2[1])/2*height,a=.22*dim*(1-k/s.trailLen)*(s.busy?1.5:1);vertex(px,py,s.color[0],s.color[1],s.color[2],a);vertex(qx,qy,s.color[0],s.color[1],s.color[2],a);px=qx;py=qy;}}
        if(!motion&&s.busy){const len=Math.hypot(s.x,s.y,s.z)||1;project(s.x/len*.83,s.y/len*.83,s.z/len*.83);vertex((P2[0]+1)/2*width,(1-P2[1])/2*height,s.color[0],s.color[1],s.color[2],.3);vertex(s.sx,s.sy,s.color[0],s.color[1],s.color[2],.3);}
      }
      boltStart=lineVerts;
      if(motion)for(const arc of scene.arcs){
        if(!arc.active)continue;const to=scene.sats[arc.b];let x0,y0;
        if(arc.a<0){const len=Math.hypot(to.x,to.y,to.z)||1;project(to.x/len*.83,to.y/len*.83,to.z/len*.83);x0=(P2[0]+1)/2*width;y0=(1-P2[1])/2*height;}else{x0=scene.sats[arc.a].sx;y0=scene.sats[arc.a].sy;}
        const n=scene.makeBolt(x0,y0,to.sx,to.sy,arc.seed,t),c=arc.a<0?scene.palette[1]:to.color;
        const r=c[0]*.3+.7,g=c[1]*.3+.7,b=c[2]*.3+.7;
        for(let i=1;i<n;i++){vertex(B[(i-1)*2],B[(i-1)*2+1],r,g,b,arc.alpha);vertex(B[i*2],B[i*2+1],r,g,b,arc.alpha);}
      }
      boltVerts=lineVerts-boltStart;glowStart=lineVerts;
      if(motion)for(const arc of scene.arcs){
        if(!arc.active)continue;const to=scene.sats[arc.b];let x0,y0;
        if(arc.a<0){const len=Math.hypot(to.x,to.y,to.z)||1;project(to.x/len*.83,to.y/len*.83,to.z/len*.83);x0=(P2[0]+1)/2*width;y0=(1-P2[1])/2*height;}else{x0=scene.sats[arc.a].sx;y0=scene.sats[arc.a].sy;}
        const n=scene.makeBolt(x0,y0,to.sx,to.sy,arc.seed,t),c=arc.a<0?scene.palette[1]:to.color;
        for(let i=0;i<n;i++)vertex(B[i*2],B[i*2+1],c[0],c[1],c[2],arc.alpha*.35);
      }
      glowVerts=lineVerts-glowStart;
    }
    function draw(){
      if(dead||lost||!ready)return;drawCount++;
      const look=scene.look;satScreen();fillMoons();fillLines();
      gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
      gl.useProgram(core);gl.bindBuffer(gl.ARRAY_BUFFER,quad);const a=attrib(core,'position',2,0,0);
      uniform(core,'resolution','uniform2f',canvas.width,canvas.height);uniform(core,'pointer','uniform2f',pointer[0],pointer[1]);uniform(core,'time','uniform1f',scene.clock);uniform(core,'ftime','uniform1f',scene.fclock);colors(core);
      uniform(core,'modeA','uniform4f',look.energy,look.swirl,look.pulse,look.rim);uniform(core,'modeB','uniform4f',look.ripple,look.shimmer,look.red,look.flash);uniform(core,'modeC','uniform4f',look.filaments,look.hue,look.ampl,look.scale);uniform(core,'modeD','uniform4f',look.flashR,0,0,0);
      uniform(core,'arcLights[0]','uniform4fv',scene.lights);
      gl.drawArrays(gl.TRIANGLES,0,6);gl.disableVertexAttribArray(a);
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.useProgram(particles);gl.bindBuffer(gl.ARRAY_BUFFER,cloud);const attrs=[['position',3,0],['seed',1,12],['kind',1,16]];for(const [name,size,offset] of attrs)attrib(particles,name,size,20,offset);uniform(particles,'time','uniform1f',scene.fclock);uniform(particles,'aspect','uniform1f',width/height);uniform(particles,'pixelRatio','uniform1f',ratio);uniform(particles,'pointer','uniform2f',pointer[0],pointer[1]);colors(particles);gl.drawArrays(gl.POINTS,0,count);for(const [name] of attrs){const loc=gl.getAttribLocation(particles,name);if(loc>=0)gl.disableVertexAttribArray(loc);}
      // Trails, steady links, bolts and bolt glow.
      if(lineVerts){gl.useProgram(lineProgram);gl.bindBuffer(gl.ARRAY_BUFFER,lineBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,lineData.subarray(0,lineVerts*LINE_STRIDE));const lp=attrib(lineProgram,'position',2,LINE_STRIDE*4,0),lc=attrib(lineProgram,'color',4,LINE_STRIDE*4,8);
        uniform(lineProgram,'soft','uniform1f',0);uniform(lineProgram,'pointSize','uniform1f',1);if(boltStart)gl.drawArrays(gl.LINES,0,boltStart);
        if(boltVerts){gl.drawArrays(gl.LINES,boltStart,boltVerts);}
        if(glowVerts){uniform(lineProgram,'soft','uniform1f',1);uniform(lineProgram,'pointSize','uniform1f',7*ratio);gl.drawArrays(gl.POINTS,glowStart,glowVerts);}
        if(lp>=0)gl.disableVertexAttribArray(lp);if(lc>=0)gl.disableVertexAttribArray(lc);}
      // Moons: halos (additive) then shaded bodies (alpha blended); the ones behind the sphere are clipped in the shader.
      if(scene.satCount){gl.useProgram(moonProgram);gl.bindBuffer(gl.ARRAY_BUFFER,moonBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,moonData.subarray(0,scene.satCount*MOON_STRIDE));
        const mp=attrib(moonProgram,'position',3,MOON_STRIDE*4,0),ms=attrib(moonProgram,'size',1,MOON_STRIDE*4,12),mc=attrib(moonProgram,'color',3,MOON_STRIDE*4,16),mg=attrib(moonProgram,'glow',1,MOON_STRIDE*4,28);
        uniform(moonProgram,'aspect','uniform1f',width/height);uniform(moonProgram,'pixelRatio','uniform1f',ratio);uniform(moonProgram,'limbZ','uniform1f',LIMB_Z*look.scale*look.scale);uniform(moonProgram,'sphere','uniform3f',canvas.width/2,canvas.height/2,.3152*canvas.height*look.scale);
        uniform(moonProgram,'halo','uniform1f',1);gl.drawArrays(gl.POINTS,0,scene.satCount);
        gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);uniform(moonProgram,'halo','uniform1f',0);gl.drawArrays(gl.POINTS,0,scene.satCount);
        for(const loc of [mp,ms,mc,mg])if(loc>=0)gl.disableVertexAttribArray(loc);}
      gl.disable(gl.BLEND);
    }
    function tick(stamp){frame=0;if(dead||lost||!motion||document.hidden)return;const dt=last?Math.min((stamp-last)/1000,.07):0;last=stamp;clock+=dt;pointer[0]+=(target[0]-pointer[0])*.04;pointer[1]+=(target[1]-pointer[1])*.04;scene.step(dt,true);draw();bridge.refresh();if(quality==='adaptive'&&dt>.031&&dt<.07)slowFrames++;else slowFrames=Math.max(0,slowFrames-1);if(slowFrames>55&&adaptiveCap>1){adaptiveCap=1;slowFrames=0;resize();}frame=requestAnimationFrame(tick);}
    function schedule(){if(frame){cancelAnimationFrame(frame);frame=0;}last=0;if(motion&&!document.hidden&&!lost&&!dead)frame=requestAnimationFrame(tick);else if(!lost&&!dead){scene.step(0,false);draw();}}
    function move(event){const r=canvas.getBoundingClientRect();target[0]=(event.clientX-r.left)/r.width*2-1;target[1]=1-(event.clientY-r.top)/r.height*2;if(!motion){pointer[0]=target[0];pointer[1]=target[1];draw();}}
    function leave(){target[0]=0;target[1]=0;}
    function reduce(){motion=!motionQuery.matches;options.onMotionChange?.(motion);schedule();}
    function contextLost(event){event.preventDefault();lost=true;if(frame)cancelAnimationFrame(frame);frame=0;}
    function contextRestored(){lost=false;resources.length=0;cloud=null;try{init();schedule();}catch{options.onFallback?.();}}
    const changed=()=>{if(dead||lost)return;stageMode(canvas,scene.state.mode);if(!motion){scene.step(0,false);draw();}};
    scene.onMode=mode=>stageMode(canvas,mode);scene.onStatic=()=>{if(!motion&&!dead&&!lost){scene.step(0,false);draw();}};
    const bridge=pointerBridge(canvas,scene,()=>{if(!motion&&!dead&&!lost)draw();});
    let api=null,observer;
    try{init();api=expose(scene,{changed});stageMode(canvas,'idle');observer=new ResizeObserver(resize);observer.observe(canvas);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerleave',leave);canvas.addEventListener('webglcontextlost',contextLost);canvas.addEventListener('webglcontextrestored',contextRestored);document.addEventListener('visibilitychange',schedule);motionQuery.addEventListener('change',reduce);schedule();}
    catch(error){console.warn('ECHO orb uses its static fallback:',error.message);options.onFallback?.();}
    return {
      get motion(){return motion;},get frames(){return drawCount;},
      setPalette(value){if(PALETTES[value]){palette=value;scene.setBase(PALETTES[value]);if(!lost&&ready){scene.step(0,motion);draw();}}},
      setMotion(value){motion=Boolean(value);schedule();},
      setQuality(value){if(!['adaptive','high','quiet'].includes(value))return;quality=value;adaptiveCap=1.5;slowFrames=0;if(!lost&&ready){makeCloud();resize();}},
      destroy(){dead=true;if(frame)cancelAnimationFrame(frame);observer?.disconnect();canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('webglcontextlost',contextLost);canvas.removeEventListener('webglcontextrestored',contextRestored);document.removeEventListener('visibilitychange',schedule);motionQuery.removeEventListener('change',reduce);bridge.destroy();api?.destroy();scene.destroy();for(const [type,item] of resources){if(type==='shader')gl.deleteShader(item);else if(type==='program')gl.deleteProgram(item);else gl.deleteBuffer(item);}},
    };
  }
  window.EchoPrimeOrb={mount,MODES:MODES.slice(),KINDS:Object.keys(KINDS),STATUSES:STATUSES.slice()};
})();
