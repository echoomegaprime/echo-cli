/* ECHO Prime living orb. Native WebGL; no remote assets or model/service calls. */
(() => {
  'use strict';
  const VERTEX = `attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}`;
  const FRAGMENT = `
precision highp float;
uniform vec2 resolution, pointer;
uniform float time;
uniform vec3 colorA,colorB,colorC;
float hash(vec3 p){p=fract(p*.3183099+vec3(.17,.31,.73));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*noise(p);p=p*2.03+vec3(1.2,3.4,2.1);a*=.49;}return s;}
mat2 rot(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
void main(){
 vec2 uv=(gl_FragCoord.xy-.5*resolution)/resolution.y;
 vec3 ro=vec3(0.,0.,3.3),rd=normalize(vec3(uv*2.5,-3.));
 float b=dot(ro,rd),h=b*b-dot(ro,ro)+.83*.83;
 float d=length(uv),glow=exp(-pow(d/.35,3.))*0.06+exp(-pow((d-.305)/.085,2.))*.035;
 vec3 col=mix(colorA,colorC,smoothstep(-.3,.3,uv.x))*.22;
 float alpha=glow;
 if(h>0.){
   float hit=-b-sqrt(h);vec3 p=ro+rd*hit,n=normalize(p);vec3 q=p;
   q.xz=rot(time*.065)*q.xz;q.yz=rot(-.12+sin(time*.08)*.12)*q.yz;
   float drift=time*.075;
   vec3 warp=vec3(noise(q*2.3+drift),noise(q.zxy*2.8-drift),noise(q.yzx*2.5+drift*.6))-.5;
   float fluid=fbm(q*5.2+warp*2.3+vec3(drift,-drift*.35,0.));
   float fine=fbm(q*17.+warp*2.+vec3(0.,drift*.4,0.));
   float veins=pow(max(0.,1.-abs(sin(fluid*26.+q.y*3.4))),8.);
   float waves=pow(max(0.,1.-abs(sin(fine*22.+fluid*5.))),12.);
   vec3 palette=mix(colorA,colorB,smoothstep(.26,.65,fluid+q.x*.12));
   palette=mix(palette,colorC,smoothstep(.16,.83,noise(q*1.6+vec3(0.,0.,drift)) +q.x*.18-q.y*.1));
   vec3 bump=normalize(n+warp*.13);
   vec3 key=normalize(vec3(-.8+pointer.x*.5,1.2+pointer.y*.35,1.5));
   vec3 fill=normalize(vec3(1.3,-.35,.35));
   float diffuse=max(dot(bump,key),0.);
   float rim=pow(1.-max(dot(n,-rd),0.),3.8);
   float spec=pow(max(dot(reflect(-key,bump),-rd),0.),52.);
   float grazing=pow(max(dot(reflect(-fill,n),-rd),0.),15.);
   float structure=.14+fluid*.3+veins*.67+waves*.23;
   float shadow=smoothstep(-.55,.75,dot(n,key));
   col=palette*structure*(.18+diffuse*.85)*(.53+shadow*.47);
   col+=palette*(veins*.35+waves*.22)*(.4+.6*diffuse);
   col+=mix(colorA,colorB,.45)*rim*(.65+.45*diffuse);
   col+=colorC*grazing*.27+vec3(.77,1.,.93)*spec*.6;
   float inner=pow(max(0.,1.-length(uv)/.305),2.);
   col+=mix(colorA,colorC,.5)*inner*.025;
   // Surface occlusion and a dark translucent center preserve dimensional form.
   col*=.87-.14*exp(-dot(uv,uv)*65.);
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
  const PALETTES = {
    prism:[[.22,.94,.63],[.18,.72,.88],[.62,.38,.88]],
    emerald:[[.3,.95,.53],[.14,.65,.52],[.7,.85,.38]],
    aurora:[[.27,.69,.92],[.62,.43,.92],[.94,.38,.65]],
  };
  // A full projected-particle renderer also serves browsers without WebGL.
  function mountCanvas(canvas,options){
    const ctx=canvas.getContext('2d',{alpha:true});
    if(!ctx){options.onFallback?.();return {motion:false,setPalette(){},setMotion(){},setQuality(){},destroy(){}};}
    canvas.dataset.renderer='canvas-3d';
    const mq=matchMedia('(prefers-reduced-motion: reduce)');
    let motion=!mq.matches,palette='prism',quality='adaptive',frame=0,clock=0,last=0,dead=false;
    let width=1,height=1,dpr=1,pointer=[0,0],target=[0,0],points=[];
    const rgb=(c,a=1)=>`rgba(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)},${a})`;
    const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
    function tint(x,y,seed){const colors=PALETTES[palette],t=Math.max(0,Math.min(1,(x+1)*.55+y*.12));return t<.5?mix(colors[0],colors[1],t*2):mix(colors[1],colors[2],(t-.5)*2);}
    function makePoints(){points=[];const n=quality==='high'?3200:quality==='quiet'?800:2000;for(let i=0;i<n;i++){const y=1-2*(i+.5)/n,r=Math.sqrt(1-y*y),a=i*2.39996323;points.push({x:Math.cos(a)*r*.842,y:y*.842,z:Math.sin(a)*r*.842,s:((i*73)%997)/997});}}
    function rotate(x,y,z,a=clock*.075){const c=Math.cos(a),s=Math.sin(a),xx=x*c+z*s;z=z*c-x*s;x=xx;const angle=-.16+Math.sin(clock*.035)*.12+pointer[1]*.035,cc=Math.cos(angle),ss=Math.sin(angle);return [x,y*cc-z*ss,y*ss+z*cc];}
    function project(x,y,z){const k=height*1.2/(3.3-z);return [width/2+x*k,height/2-y*k,k];}
    function orbit(front){ctx.lineWidth=.55;for(let ring=0;ring<3;ring++){const c=PALETTES[palette][ring],incl=[1.15,.92,1.37][ring],tilt=[.38,1.08,2.14][ring]+Math.sin(clock*.03)*.04;ctx.strokeStyle=rgb(c,front?.24:.085);ctx.beginPath();let connected=false;for(let i=0;i<=240;i++){const a=i/240*Math.PI*2;let x=Math.cos(a)*1.19,y=Math.sin(a)*1.19,z=y*Math.sin(incl);y*=Math.cos(incl);const xx=x*Math.cos(tilt)-y*Math.sin(tilt);y=x*Math.sin(tilt)+y*Math.cos(tilt);x=xx;[x,y,z]=rotate(x,y,z,clock*.025);if((z>=0)!==front){connected=false;continue;}const p=project(x,y,z);if(connected)ctx.lineTo(p[0],p[1]);else ctx.moveTo(p[0],p[1]);connected=true;}ctx.stroke();}}
    function draw(){if(dead)return;const cx=width/2,cy=height/2,r=height*.312;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);const colors=PALETTES[palette];
      let g=ctx.createRadialGradient(cx,cy,r*.75,cx,cy,r*1.6);g.addColorStop(0,rgb(colors[0],.07));g.addColorStop(.5,rgb(colors[1],.035));g.addColorStop(1,rgb(colors[2],0));ctx.fillStyle=g;ctx.fillRect(0,0,width,height);orbit(false);
      // Analytic lighting: a shaded glass core, reflected color and a soft rim.
      g=ctx.createRadialGradient(cx-r*.38+pointer[0]*8,cy-r*.45-pointer[1]*6,r*.02,cx,cy,r);g.addColorStop(0,rgb(mix(colors[0],[.55,.85,.76],.5),.2));g.addColorStop(.35,rgb(colors[0],.095));g.addColorStop(.75,'rgba(3,12,16,.72)');g.addColorStop(.96,rgb(mix(colors[1],colors[2],.5),.17));g.addColorStop(1,rgb(colors[1],.42));ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
      ctx.save();ctx.beginPath();ctx.arc(cx,cy,r-.5,0,Math.PI*2);ctx.clip();
      g=ctx.createRadialGradient(cx+r*.52,cy+r*.2,0,cx+r*.3,cy+r*.1,r*.9);g.addColorStop(0,rgb(colors[2],.13));g.addColorStop(1,rgb(colors[2],0));ctx.fillStyle=g;ctx.fillRect(cx-r,cy-r,2*r,2*r);
      // Braided flowing field lines follow the visible hemisphere.
      ctx.globalCompositeOperation='lighter';
      for(let band=0;band<27;band++){const y0=-.95+band/26*1.9;let connected=false;ctx.beginPath();for(let i=0;i<=148;i++){const a=i/148*Math.PI*2,y=y0+.035*Math.sin(a*4+clock*.19+band*.46),ring=Math.sqrt(Math.max(0,1-y*y));let [x,yy,z]=rotate(Math.cos(a)*ring*.823,y*.823,Math.sin(a)*ring*.823);const ripple=1+.012*Math.sin(a*11+clock*.21+band*.4);x*=ripple;yy*=ripple;if(z<.08){connected=false;continue;}const p=project(x,yy,z);if(connected)ctx.lineTo(p[0],p[1]);else ctx.moveTo(p[0],p[1]);connected=true;}ctx.lineWidth=band%4===0?.65:.35;ctx.strokeStyle=rgb(mix(colors[0],colors[2],band/27),band%4===0?.24:.12);ctx.stroke();}
      // A second oblique filament layer gives the sphere volume, not a flat grid.
      for(let strand=0;strand<18;strand++){ctx.beginPath();let connected=false;for(let i=0;i<=125;i++){const a=i/125*Math.PI,b= strand/18*Math.PI*2+Math.sin(a*3+clock*.1)*.26;let x=Math.sin(a)*Math.cos(b)*.831,y=Math.cos(a)*.831,z=Math.sin(a)*Math.sin(b)*.831;[x,y,z]=rotate(x,y,z,clock*.055+.7);if(z<.15){connected=false;continue;}const p=project(x,y,z);if(connected)ctx.lineTo(p[0],p[1]);else ctx.moveTo(p[0],p[1]);connected=true;}ctx.strokeStyle=rgb(colors[(strand+1)%3],.15);ctx.lineWidth=.55;ctx.stroke();}
      const rendered=[];for(const p of points){const wobble=1+.011*Math.sin(p.y*11+clock*.22+p.s*4);let [x,y,z]=rotate(p.x*wobble,p.y*wobble,p.z*wobble,clock*.075+pointer[0]*.025);if(z<-.12)continue;rendered.push({x,y,z,s:p.s});}rendered.sort((a,b)=>a.z-b.z);
      for(const p of rendered){const xy=project(p.x,p.y,p.z),front=Math.max(0,p.z/.842),shine=.6+.4*Math.sin(p.s*31+clock*.35),c=tint(p.x,p.y,p.s);const alpha=(.25+front*.72)*(.65+p.s*.35)*(.7+.3*shine);const size=(.65+p.s*.85)*(xy[2]/(height*.37));ctx.fillStyle=rgb(mix(c,[.83,1,.95],.16),alpha);ctx.fillRect(xy[0]-size/2,xy[1]-size/2,size,size);if(p.s>.988&&front>.2){const s=2.3+front;g=ctx.createRadialGradient(xy[0],xy[1],0,xy[0],xy[1],s*2);g.addColorStop(0,rgb(mix(c,[1,1,1],.5),.7));g.addColorStop(.25,rgb(c,.2));g.addColorStop(1,rgb(c,0));ctx.fillStyle=g;ctx.fillRect(xy[0]-s*2,xy[1]-s*2,s*4,s*4);}}
      ctx.restore();ctx.globalCompositeOperation='lighter';orbit(true);
      // Bright orbital satellites and sparse suspended dust.
      for(let j=0;j<3;j++){const a=clock*(.12+j*.025)+j*2.1,incl=[1.15,.92,1.37][j],tilt=[.38,1.08,2.14][j];let x=Math.cos(a)*1.19,y=Math.sin(a)*1.19,z=y*Math.sin(incl);y*=Math.cos(incl);const xx=x*Math.cos(tilt)-y*Math.sin(tilt);y=x*Math.sin(tilt)+y*Math.cos(tilt);x=xx;[x,y,z]=rotate(x,y,z,clock*.025);if(z<0)continue;const p=project(x,y,z);g=ctx.createRadialGradient(p[0],p[1],0,p[0],p[1],7);g.addColorStop(0,'rgba(228,255,248,.9)');g.addColorStop(.13,rgb(colors[j],.65));g.addColorStop(.5,rgb(colors[j],.09));g.addColorStop(1,rgb(colors[j],0));ctx.fillStyle=g;ctx.fillRect(p[0]-7,p[1]-7,14,14);}
      for(let i=0;i<58;i++){const a=i*2.39996323+clock*.008,rr=1.16+(i*53%97)/97*.55,p=project(Math.cos(a)*rr,Math.sin(a)*rr*.72,Math.sin(i*1.7)*.2);ctx.fillStyle=rgb(colors[i%3],.1+.13*(.5+.5*Math.sin(clock*.4+i)));ctx.fillRect(p[0],p[1],i%9===0?1.2:.6,i%9===0?1.2:.6);}ctx.globalCompositeOperation='source-over';
    }
    function resize(){const r=canvas.getBoundingClientRect();width=Math.max(1,r.width);height=Math.max(1,r.height);dpr=Math.min(devicePixelRatio||1,quality==='high'?2:quality==='quiet'?1:1.5);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);draw();}
    function tick(stamp){frame=0;if(dead||!motion||document.hidden)return;const dt=last?Math.min((stamp-last)/1000,.06):0;last=stamp;clock+=dt;pointer=pointer.map((v,i)=>v+(target[i]-v)*.035);draw();frame=requestAnimationFrame(tick);}
    function schedule(){if(frame)cancelAnimationFrame(frame);frame=0;last=0;if(motion&&!dead&&!document.hidden)frame=requestAnimationFrame(tick);else draw();}
    function move(e){const r=canvas.getBoundingClientRect();target=[(e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2];if(!motion){pointer=target;draw();}}
    function leave(){target=[0,0];}
    function reduced(){motion=!mq.matches;options.onMotionChange?.(motion);schedule();}
    makePoints();resize();const observer=new ResizeObserver(resize);observer.observe(canvas);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerleave',leave);document.addEventListener('visibilitychange',schedule);mq.addEventListener('change',reduced);schedule();
    return {get motion(){return motion;},setPalette(v){if(PALETTES[v]){palette=v;draw();}},setQuality(v){if(['adaptive','high','quiet'].includes(v)){quality=v;makePoints();resize();}},setMotion(v){motion=Boolean(v);schedule();},destroy(){dead=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerleave',leave);document.removeEventListener('visibilitychange',schedule);mq.removeEventListener('change',reduced);}};
  }
  function mount(canvas, options={}) {
    let gl;try{gl=canvas.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false,powerPreference:'low-power',preserveDrawingBuffer:false});}catch{}
    if(!gl) return mountCanvas(canvas,options);
    canvas.dataset.renderer='webgl';
    const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
    let motion=!motionQuery.matches,quality='adaptive',palette='prism',frame=0,dead=false,lost=false,ready=false;
    let clock=0,last=0,ratio=1,width=1,height=1,slowFrames=0,adaptiveCap=1.5;
    let pointer=[0,0],target=[0,0],core,particles,quad,cloud,count=0;
    const resources=[];
    function shader(type,code){const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error('ECHO orb shader: '+message);}resources.push(['shader',s]);return s;}
    function program(vertex,fragment){const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error('ECHO orb program failed');resources.push(['program',p]);return p;}
    function buffer(data){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);resources.push(['buffer',b]);return b;}
    function makeCloud(){const data=[],n=quality==='high'?3600:quality==='quiet'?900:2200;
      const add=(x,y,z,s,k)=>data.push(x,y,z,s,k);
      for(let i=0;i<n;i++){const y=1-2*(i+.5)/n,r=Math.sqrt(1-y*y),a=i*2.39996323;add(Math.cos(a)*r*.842,y*.842,Math.sin(a)*r*.842,((i*73)%997)/997,0);}
      for(let ring=0;ring<3;ring++){const nRing=quality==='quiet'?128:320;for(let i=0;i<nRing;i++){const a=i/nRing*Math.PI*2;let x=Math.cos(a)*1.19,y=Math.sin(a)*1.19,z=0;const tilt=[.38,1.08,2.14][ring],incl=[1.15,.92,1.37][ring];z=y*Math.sin(incl);y*=Math.cos(incl);const xx=x*Math.cos(tilt)-y*Math.sin(tilt);y=x*Math.sin(tilt)+y*Math.cos(tilt);x=xx;add(x,y,z,((i*19+ring*127)%311)/311,1);}}
      for(let i=0;i<88;i++){const a=i*2.39996323,r=1.22+((i*53)%97)/97*.65;add(Math.cos(a)*r,Math.sin(a)*r*.68,Math.sin(i*1.71)*.2,((i*37)%83)/83,2);}
      if(cloud){gl.deleteBuffer(cloud);const index=resources.findIndex(r=>r[1]===cloud);if(index>=0)resources.splice(index,1);}
      cloud=buffer(data);count=data.length/5;
    }
    function init(){core=program(VERTEX,FRAGMENT);particles=program(PARTICLE_VERTEX,PARTICLE_FRAGMENT);quad=buffer([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]);makeCloud();ready=true;resize();}
    function resize(){const rect=canvas.getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);const cap=quality==='high'?2:quality==='quiet'?.85:adaptiveCap;ratio=Math.min(devicePixelRatio||1,cap);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);if(!lost&&!dead)draw();}
    function uniform(program,name,type,...value){const location=gl.getUniformLocation(program,name);if(location!==null)gl[type](location,...value);}
    function colors(program){const c=PALETTES[palette];for(let i=0;i<3;i++)uniform(program,['colorA','colorB','colorC'][i],'uniform3f',...c[i]);}
    function draw(){if(dead||lost||!ready)return;gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.useProgram(core);gl.bindBuffer(gl.ARRAY_BUFFER,quad);const a=gl.getAttribLocation(core,'position');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);uniform(core,'resolution','uniform2f',canvas.width,canvas.height);uniform(core,'pointer','uniform2f',...pointer);uniform(core,'time','uniform1f',clock);colors(core);gl.drawArrays(gl.TRIANGLES,0,6);gl.disableVertexAttribArray(a);
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.useProgram(particles);gl.bindBuffer(gl.ARRAY_BUFFER,cloud);const attrs=[['position',3,0],['seed',1,12],['kind',1,16]];for(const [name,size,offset] of attrs){const a=gl.getAttribLocation(particles,name);if(a>=0){gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,size,gl.FLOAT,false,20,offset);}}uniform(particles,'time','uniform1f',clock);uniform(particles,'aspect','uniform1f',width/height);uniform(particles,'pixelRatio','uniform1f',ratio);uniform(particles,'pointer','uniform2f',...pointer);colors(particles);gl.drawArrays(gl.POINTS,0,count);for(const [name] of attrs){const a=gl.getAttribLocation(particles,name);if(a>=0)gl.disableVertexAttribArray(a);}gl.disable(gl.BLEND);
    }
    function tick(stamp){frame=0;if(dead||lost||!motion||document.hidden)return;const dt=last?Math.min((stamp-last)/1000,.07):0;last=stamp;clock+=dt;pointer=pointer.map((v,i)=>v+(target[i]-v)*.04);draw();if(quality==='adaptive'&&dt>.031&&dt<.07)slowFrames++;else slowFrames=Math.max(0,slowFrames-1);if(slowFrames>55&&adaptiveCap>1){adaptiveCap=1;slowFrames=0;resize();}frame=requestAnimationFrame(tick);}
    function schedule(){if(frame){cancelAnimationFrame(frame);frame=0;}last=0;if(motion&&!document.hidden&&!lost&&!dead)frame=requestAnimationFrame(tick);else if(!lost&&!dead)draw();}
    function move(event){const r=canvas.getBoundingClientRect();target=[(event.clientX-r.left)/r.width*2-1,1-(event.clientY-r.top)/r.height*2];if(!motion){pointer=target;draw();}}
    function leave(){target=[0,0];}
    function reduce(){motion=!motionQuery.matches;options.onMotionChange?.(motion);schedule();}
    function contextLost(event){event.preventDefault();lost=true;if(frame)cancelAnimationFrame(frame);frame=0;}
    function contextRestored(){lost=false;resources.length=0;cloud=null;try{init();schedule();}catch{options.onFallback?.();}}
    let observer;
    try{init();observer=new ResizeObserver(resize);observer.observe(canvas);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerleave',leave);canvas.addEventListener('webglcontextlost',contextLost);canvas.addEventListener('webglcontextrestored',contextRestored);document.addEventListener('visibilitychange',schedule);motionQuery.addEventListener('change',reduce);schedule();}
    catch(error){console.warn('ECHO orb uses its static fallback:',error.message);options.onFallback?.();}
    return {
      get motion(){return motion;},
      setPalette(value){if(PALETTES[value]){palette=value;draw();}},
      setMotion(value){motion=Boolean(value);schedule();},
      setQuality(value){if(!['adaptive','high','quiet'].includes(value))return;quality=value;adaptiveCap=1.5;slowFrames=0;if(!lost&&ready){makeCloud();resize();}},
      destroy(){dead=true;if(frame)cancelAnimationFrame(frame);observer?.disconnect();canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('webglcontextlost',contextLost);canvas.removeEventListener('webglcontextrestored',contextRestored);document.removeEventListener('visibilitychange',schedule);motionQuery.removeEventListener('change',reduce);for(const [type,item] of resources){if(type==='shader')gl.deleteShader(item);else if(type==='program')gl.deleteProgram(item);else gl.deleteBuffer(item);}},
    };
  }
  window.EchoPrimeOrb={mount};
})();
