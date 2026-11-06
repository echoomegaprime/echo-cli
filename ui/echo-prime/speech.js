(() => {
 'use strict';
 // ECHO Prime spoken replies ("Echo talks"). Commander directive 2026-11-04: "ECHO SHOULD TALK
 // REPLIES, USE ALL SPEAKING LOGIC THAT'S KNOWN, CONVO AI STYLE".
 //
 // Echo's voice is the Workspace backend's configured Personality Forge voice, reached only through
 // window.EchoPrimeWorkspace.bridge (/api/voice/start|next|cancel|transcribe plus governed WAV
 // artifacts). The backend synthesises saved assistant replies, so Echo's own voice starts the
 // moment a reply is saved ("done"), chunk by chunk with the next chunk prefetched while the
 // current one plays. Every other reply path (ECHO Code replies, Swarm and Agents results, Steward
 // advice) speaks in the same voice through the owner-only Prime route POST /api/prime/voice/speak,
 // which calls the same loopback voice gateway, persona and model (Prime holds no provider token).
 // A device voice (speechSynthesis) is never a silent fallback: it speaks only behind the explicit
 // toggle "Device voice (not Echo's)" and only when Echo's voice cannot reach that text at all; a
 // failed synthesis shows its reason and is never substituted. Spoken replies default ON for signed-in
 // approved accounts and OFF for anonymous visitors. The only browser storage is the mute and
 // device-voice preference, read and written inside try/catch. Debug events never carry text.
 const $=selector=>document.querySelector(selector);
 const bridge=()=>window.EchoPrimeWorkspace?.bridge;
 const clock=()=>typeof performance!=='undefined'&&performance&&typeof performance.now==='function'?performance.now():Date.now();
 const announce=(name,detail)=>{try{window.dispatchEvent(Object.assign(new Event(name),{detail}));}catch{}};
 const debug=(event,extra={})=>{try{console.debug('[echo.speech]',{schema_version:1,event,...extra});}catch{}};
 const uuid=()=>{try{return crypto.randomUUID();}catch{return 'speech-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);}};
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(value!==false&&value!==undefined&&value!==null)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);}
  return node;
 }

 // ---------------------------------------------------------------- text normalisation
 const ONES=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
 const TENS=['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
 const SCALES=['','thousand','million','billion','trillion'];
 const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const UNITS={ms:'milliseconds',kb:'kilobytes',mb:'megabytes',gb:'gigabytes',tb:'terabytes',km:'kilometers',kg:'kilograms',hz:'hertz',khz:'kilohertz',mhz:'megahertz',ghz:'gigahertz'};
 const digitsOf=s=>[...String(s)].filter(c=>/\d/.test(c)).map(d=>ONES[Number(d)]).join(' ');
 function below1000(n){const h=Math.floor(n/100),r=n%100,parts=[];if(h)parts.push(ONES[h]+' hundred');if(r)parts.push(r<20?ONES[r]:TENS[Math.floor(r/10)]+(r%10?'-'+ONES[r%10]:''));return parts.join(' ');}
 function cardinal(digits){
  const s=String(digits).replace(/[^\d]/g,'').replace(/^0+(?=\d)/,'');
  if(!s)return '';if(s.length>15)return digitsOf(s);
  let n=Number(s);if(n===0)return 'zero';const parts=[];let i=0;
  while(n>0){const group=n%1000;if(group)parts.unshift(below1000(group)+(SCALES[i]?' '+SCALES[i]:''));n=Math.floor(n/1000);i++;}
  return parts.join(' ');
 }
 function ordinal(digits){
  const words=cardinal(digits);if(!words)return '';
  const special={one:'first',two:'second',three:'third',five:'fifth',eight:'eighth',nine:'ninth',twelve:'twelfth'};
  return words.replace(/(\w+)$/,last=>special[last]||(last.endsWith('y')?last.slice(0,-1)+'ieth':last+'th'));
 }
 function yearWords(s){
  const n=Number(s);if(!/^\d{4}$/.test(s)||n<1900||n>2099)return cardinal(s);
  const hi=Math.floor(n/100),lo=n%100;if(lo===0)return cardinal(s);
  return below1000(hi)+' '+(lo<10?'oh '+ONES[lo]:below1000(lo));
 }
 function timeWords(h,m,ampm){
  const hour=Number(h),minute=Number(m);if(hour>23||minute>59)return null;
  const suffix=ampm?' '+ampm.toLowerCase().split('').join(' '):'';
  return cardinal(String(hour))+(minute===0?(ampm?'':" o'clock"):minute<10?' oh '+ONES[minute]:' '+below1000(minute))+suffix;
 }
 function summariseTable(lines){
  const rows=lines.filter(line=>!/^\s*\|?\s*:?-{2,}/.test(line));
  const columns=Math.max(0,...rows.map(line=>line.trim().replace(/^\||\|$/g,'').split('|').length));
  const header=rows[0]?rows[0].trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim()).filter(Boolean):[];
  const data=Math.max(0,rows.length-1);
  return 'Table with '+cardinal(String(data))+' row'+(data===1?'':'s')+' and '+cardinal(String(columns))+' column'+(columns===1?'':'s')+(header.length?', columns: '+header.join(', '):'')+'.';
 }
 function normalizeForSpeech(input){
  let text=String(input??'').replace(/\r\n?/g,'\n');
  if(!text.trim())return '';
  const spans=[];
  // Fenced code is screen-only; an unbalanced trailing fence is also code.
  text=text.replace(/```[\s\S]*?```/g,' Code block omitted. ').replace(/```[\s\S]*$/,' Code block omitted. ');
  // Inline code is read verbatim and protected from number expansion (letter-only placeholders).
  const token=index=>{let key='';do{key=String.fromCharCode(97+index%26)+key;index=Math.floor(index/26);}while(index>0);return '\u0001'+key+'\u0001';};
  text=text.replace(/`([^`\n]+)`/g,(_,code)=>{spans.push(code);return token(spans.length-1);});
  // Markdown tables become a one-sentence summary.
  text=text.replace(/(?:^[ \t]*\|.*\|[ \t]*\n?){2,}/gm,block=>' '+summariseTable(block.trim().split('\n'))+' ');
  text=text.replace(/<[^>\n]{1,200}>/g,' ');
  text=text.replace(/!\[([^\]]*)\]\([^)]*\)/g,(_,alt)=>alt?alt+' (image)':'image');
  text=text.replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.|mailto:)[^)]*\)/g,'$1 (link)');
  text=text.replace(/\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi,'link');
  text=text.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,'email address');
  text=text.replace(/\b[a-fA-F0-9]{20,}\b/g,'identifier');
  text=text.replace(/(?:[A-Za-z]:\\|\/(?:home|mnt|etc|var|tmp|usr|opt|Users)\/)[^\s`<>"']+/g,'file path');
  text=text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm,'').replace(/^[ \t]*>[ \t]?/gm,'').replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm,'').replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm,'');
  text=text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,'$2').replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?=[^\w*]|$)/g,'$1$2').replace(/~~(?=\S)([\s\S]*?\S)~~/g,'$1');
  // Dates and times before bare numbers.
  text=text.replace(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z?)?\b/g,(all,y,m,d,hh,mm)=>{const month=MONTHS[Number(m)-1];if(!month||Number(d)<1||Number(d)>31)return all;return month+' '+ordinal(d)+', '+yearWords(y)+(hh?' at '+timeWords(hh,mm,''):'');});
  text=text.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,(all,m,d,y)=>{const month=MONTHS[Number(m)-1];return month&&Number(d)>=1&&Number(d)<=31?month+' '+ordinal(d)+', '+yearWords(y):all;});
  text=text.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s?([ap]m|[AP]M))?\b/g,(all,h,m,ampm)=>timeWords(h,m,ampm)||all);
  text=text.replace(/\$(\d[\d,]*)(?:\.(\d{2}))?\b/g,(_,dollars,cents)=>{const d=dollars.replace(/,/g,'');return cardinal(d)+' dollar'+(d==='1'?'':'s')+(cents&&Number(cents)?' and '+cardinal(cents)+' cent'+(cents==='01'?'':'s'):'');});
  text=text.replace(/\b(\d[\d,]*(?:\.\d+)?)\s?%/g,(_,n)=>numberWords(n)+' percent');
  text=text.replace(/\b(\d+)(?:\.\d+){2,}\b/g,v=>v.split('.').map(part=>cardinal(part)).join(' point '));
  text=text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\.(\d+)\b/g,(_,whole,frac)=>cardinal(whole.replace(/,/g,''))+' point '+digitsOf(frac));
  text=text.replace(/\b(\d+)(st|nd|rd|th)\b/g,(_,n)=>ordinal(n));
  text=text.replace(/\b(\d[\d,]*)\s?[-–]\s?(\d[\d,]*)\b/g,(_,a,b)=>numberWords(a)+' to '+numberWords(b));
  text=text.replace(/(^|[\s(])-(\d)/g,'$1minus $2');
  text=text.replace(/\b(\d[\d,]*)\s?(ms|kb|mb|gb|tb|km|kg|hz|khz|mhz|ghz)\b/gi,(_,n,unit)=>numberWords(n)+' '+UNITS[unit.toLowerCase()]);
  text=text.replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g,n=>numberWords(n));
  text=text.replace(/\s&\s/g,' and ').replace(/\s(?:->|→|=>)\s/g,' to ').replace(/\s=\s/g,' equals ').replace(/\s\+\s/g,' plus ').replace(/[*_#|>~^]+/g,' ');
  text=text.replace(/\u0001([a-z]+)\u0001/g,(_,key)=>{let index=0;for(const ch of key)index=index*26+(ch.charCodeAt(0)-97);return spans[index]??'';});
  const lines=text.split('\n').map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean).map(line=>/[.!?:;,。！？]["')\]]*$/.test(line)?line:line+'.');
  return lines.join(' ').replace(/\s+([,.;:!?])/g,'$1').replace(/\(\s+/g,'(').replace(/\s+\)/g,')').replace(/\s{2,}/g,' ').trim();
 }
 function numberWords(raw){const s=String(raw).replace(/,/g,'');if(/^\d{4}$/.test(s))return yearWords(s);return cardinal(s);}
 const SCRIPTS=[[/[぀-ヿ]/,'ja'],[/[가-힯]/,'ko'],[/[一-鿿]/,'zh'],[/[Ѐ-ӿ]/,'ru'],[/[؀-ۿ]/,'ar'],[/[֐-׿]/,'he'],[/[Ͱ-Ͽ]/,'el'],[/[ऀ-ॿ]/,'hi'],[/[฀-๿]/,'th']];
 const MARKERS={es:/\b(?:el|la|los|las|que|de|con|para|una|está|gracias|hola)\b/gi,fr:/\b(?:le|les|est|une|pas|avec|pour|vous|nous|bonjour|merci)\b/gi,de:/\b(?:der|die|das|und|nicht|ist|ich|sie|mit|für|danke)\b/gi,pt:/\b(?:não|você|uma|com|para|obrigado|também|isso)\b/gi,it:/\b(?:il|che|non|una|per|sono|grazie|questo|anche)\b/gi};
 function detectLanguage(text){
  const value=String(text??'');
  for(const [pattern,lang] of SCRIPTS){const hits=(value.match(new RegExp(pattern.source,'g'))||[]).length;if(hits>=Math.max(2,value.length*0.05))return lang;}
  let best='en',score=1;
  for(const [lang,pattern] of Object.entries(MARKERS)){const hits=(value.match(pattern)||[]).length;if(hits>score){best=lang;score=hits;}}
  return score>=3?best:'en';
 }

 // ---------------------------------------------------------------- sentence chunking
 const ABBREVIATIONS=new Set(['dr','mr','mrs','ms','prof','sr','jr','st','vs','etc','e.g','i.e','no','fig','approx','inc','ltd','co','mt','gen','col','lt','sgt','capt','jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec','u.s','u.k','a.m','p.m','ph.d','cf','al','ex','rev','hon','esq','dept','est','min','max','avg']);
 function splitLong(text,max){
  if(text.length<=max)return [text];const out=[];let rest=text;
  while(rest.length>max){
   let cut=-1;
   for(const separator of ['; ',', ',' — ',' – ',' ']){const index=rest.lastIndexOf(separator,max);if(index>max*0.4){cut=index+separator.length;break;}}
   if(cut<0)cut=max;out.push(rest.slice(0,cut).trim());rest=rest.slice(cut).trim();
  }
  if(rest)out.push(rest);return out;
 }
 function createChunker(options={}){
  const min=options.min??20,max=options.max??300;let buffer='',carry='';
  function boundaries(text,final){
   const out=[];let start=0,i=0;
   while(i<text.length){
    const ch=text[i];
    if(ch==='\n'){const segment=text.slice(start,i).trim();if(segment)out.push(segment);start=i+1;i++;continue;}
    if('。！？'.includes(ch)){const segment=text.slice(start,i+1).trim();if(segment)out.push(segment);start=i+1;i++;continue;}
    if('.!?'.includes(ch)){
     let j=i;while(j+1<text.length&&'.!?'.includes(text[j+1]))j++;
     let k=j+1;while(k<text.length&&'"\')\]”’»'.includes(text[k]))k++;
     if(k>=text.length&&!final)break;
     if(k<text.length&&!/\s/.test(text[k])){i=j+1;continue;}
     if(ch==='.'&&j===i){
      const before=text.slice(start,i),word=(before.match(/(\S+)$/)||[])[1]||'',lower=word.replace(/^[("'[]+/,'').toLowerCase();
      const listMarker=/^\d{1,3}$/.test(word)&&/(?:^|\n)\s*$/.test(before.slice(0,before.length-word.length));
      if(ABBREVIATIONS.has(lower)||/^[A-Za-z]$/.test(word)||listMarker){i=j+1;continue;}
     }
     const segment=text.slice(start,k).trim();if(segment)out.push(segment);start=k;i=k;continue;
    }
    i++;
   }
   return {segments:out,rest:text.slice(start)};
  }
  function shape(segments,final){
   const out=[];let pending=carry;carry='';
   for(const segment of segments){const merged=pending?pending+' '+segment:segment;if(merged.length<min){pending=merged;continue;}pending='';out.push(...splitLong(merged,max));}
   if(pending){if(final)out.push(...splitLong(pending,max));else carry=pending;}
   return out;
  }
  return {
   push(delta){buffer+=String(delta??'');const {segments,rest}=boundaries(buffer,false);buffer=rest;return shape(segments,false);},
   flush(){const {segments,rest}=boundaries(buffer,true);buffer='';const tail=rest.trim();if(tail)segments.push(tail);return shape(segments,true);},
   get pending(){return (buffer+(carry?' '+carry:'')).trim();},
  };
 }
 const chunkSentences=(text,options)=>{const chunker=createChunker(options);return chunker.push(text).concat(chunker.flush());};

 // ---------------------------------------------------------------- ordered playback queue
 // Plays items in order and prepares exactly one item ahead of playback (ConvAI style). `fetchNext`
 // is called for item n+1 as soon as item n starts; `play` resolves when the item finished (false
 // when it was interrupted). cancel() aborts the shared signal and drops every pending item.
 function createQueue({fetchNext,play,onEvent}){
  let cancelled=false,running=false;const controller=new AbortController();
  const aborted=new Promise(resolve=>{try{controller.signal.addEventListener('abort',()=>resolve({cancelled:true}),{once:true});}catch{}});
  const emit=(event,detail)=>{try{onEvent?.(event,detail);}catch{}};
  return {
   get cancelled(){return cancelled;},get signal(){return controller.signal;},
   cancel(reason){if(cancelled)return;cancelled=true;try{controller.abort();}catch{}emit('cancelled',{reason});},
   async run(first){
    if(running)throw new Error('Queue already running.');running=true;let item=first,index=0;
    try{
     while(item&&!cancelled){
      const ahead=item.hasMore===true?Promise.resolve().then(()=>fetchNext(item,index+1)).then(value=>({value}),error=>({error})):null;
      emit('item_started',{index});
      const played=await play(item,controller.signal,index);
      if(cancelled)return false;
      emit('item_finished',{index,played});
      if(played===false)return false;
      if(!ahead)return true;
      const next=await Promise.race([ahead,aborted]);if(cancelled||next.cancelled)return false;// a cancelled queue settles even while a prefetch is in flight
      if(next.error)throw next.error;
      item=next.value;index++;
     }
     return !cancelled;
    }finally{running=false;}
   },
  };
 }

 // ---------------------------------------------------------------- voice activity detection
 // Pure state machine fed with RMS samples from an AnalyserNode. The noise floor adapts while
 // nobody speaks; while Echo is speaking the start threshold and hold time rise so the speaker
 // does not barge in on itself.
 function createVad(options={}){
  const endOfTurnMs=options.endOfTurnMs??1500,startMs=options.startMs??150,bargeStartMs=options.bargeStartMs??300,floor=options.minThreshold??0.012;
  let noise=options.noise??0.004,speaking=false,speechMs=0,silenceMs=0;
  return {
   get speaking(){return speaking;},get noise(){return noise;},
   threshold(echoSpeaking){return Math.max(floor,noise*(echoSpeaking?2.5:3));},
   reset(){speaking=false;speechMs=0;silenceMs=0;},
   update(rms,dt,echoSpeaking=false){
    const threshold=this.threshold(echoSpeaking);
    if(!speaking){
     if(rms<threshold)noise=noise*0.95+rms*0.05;
     if(rms>threshold){speechMs+=dt;if(speechMs>=(echoSpeaking?bargeStartMs:startMs)){speaking=true;speechMs=0;silenceMs=0;return 'start';}}
     else speechMs=0;
     return null;
    }
    if(rms>threshold){silenceMs=0;return null;}
    silenceMs+=dt;if(silenceMs>=endOfTurnMs){speaking=false;silenceMs=0;return 'end';}
    return null;
   },
  };
 }
 // Mono 16 kHz PCM WAV, the canonical Workspace transcription contract (≤ 128000 frames).
 function encodeWav(samples){
  if(!samples.length||samples.length>128000)throw new Error('Microphone clip must be between one frame and eight seconds.');
  const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer),text=(offset,value)=>[...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
  samples.forEach((sample,i)=>view.setInt16(44+i*2,Math.max(-1,Math.min(1,sample))*(sample<0?32768:32767),true));
  let binary='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
 }
 function resample(chunks,rate){
  const size=chunks.reduce((n,part)=>n+part.length,0),input=new Float32Array(size);let offset=0;for(const part of chunks){input.set(part,offset);offset+=part.length;}
  const output=new Float32Array(Math.floor(size*16000/rate)),ratio=rate/16000;
  for(let i=0;i<output.length;i++){const start=Math.floor(i*ratio),end=Math.min(input.length,Math.max(start+1,Math.floor((i+1)*ratio)));let total=0;for(let j=start;j<end;j++)total+=input[j];output[i]=total/Math.max(1,end-start);}
  return output;
 }

 // ---------------------------------------------------------------- preferences + session
 const STORAGE_KEY='echo-prime-speech-v1';
 const prefs={muted:false,device:false};
 function loadPrefs(){try{const raw=localStorage.getItem(STORAGE_KEY),value=raw?JSON.parse(raw):null;if(value&&typeof value==='object'){prefs.muted=value.muted===true;prefs.device=value.device===true;}}catch{}}
 function savePrefs(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({muted:prefs.muted,device:prefs.device}));return true;}catch{return false;}}
 const session=()=>window.EchoPrimeWorkspace?.session;
 const signedIn=()=>{const s=session();return !!s&&s.authenticated===true&&s.user?.status==='approved';};
 const voiceInfo=()=>bridge()?.state?.data?.voice;
 const echoVoiceConfigured=()=>voiceInfo()?.configured===true;
 const providerName=id=>window.EchoPrimeVoiceBar?.providerName?.(id)||(typeof id==='string'?id:'');
 function voiceLabel(){const voice=voiceInfo();const label=[voice?.label,voice?.persona].find(value=>typeof value==='string'&&value.trim());return label?label.trim():'configured voice';}
 function voiceReason(){
  const b=bridge();if(!b)return 'the Workspace is not connected';
  if(!signedIn())return 'sign in to an approved account';
  const voice=voiceInfo();if(!b.state.data)return 'the Workspace state has not loaded';
  for(const key of ['error','reason','detail'])if(typeof voice?.[key]==='string'&&voice[key].trim())return voice[key].trim();
  return 'the Workspace backend reports no configured voice';
 }
 const shouldAutoSpeak=()=>{const b=bridge();return !!b&&b.voiceOptions.spoken===true&&!prefs.muted&&signedIn();};

 // ---------------------------------------------------------------- runtime state
 const S={appliedEpoch:null,turns:0,spoken:new Map(),current:null,device:null,deferred:null,blocked:null,ctx:null,unlocked:false,stream:null,closedStreams:new Map(),reasonShown:false,hidden:false,levelTimer:null,prime:null,primeLoading:null,autoSpoken:new Map()};
 let ui=null,conversation=null;
 const liveCurrent=current=>!!current&&S.current===current&&current.epoch===bridge()?.state.accountEpoch;
 function setStatus(text){if(ui)ui.status.textContent=String(text||'').slice(0,400);}
 // Orb sync contract (orb.js is owned elsewhere): `echo-orb-state` on document with
 // {mode:'speaking',amplitude:0..1,source:'speech'} at ~20 Hz while Echo talks (amplitude from the
 // AnalyserNode when the AudioContext runs, else a steady breathing level), {mode:'listening'} while
 // the microphone is open and {mode:'idle',source:'speech'} when done.
 function emitState(){
  const speaking=!!S.current||!!S.device,listening=!!conversation&&conversation.active&&!conversation.paused;
  const amplitude=speaking?Math.max(0.2,Math.min(1,S.level||0.55)):0;
  const detail=speaking?{mode:'speaking',amplitude,source:'speech'}:listening?{mode:'listening',source:'speech'}:{mode:'idle',source:'speech'};
  try{document.dispatchEvent(typeof CustomEvent==='function'?new CustomEvent('echo-orb-state',{detail}):Object.assign(new Event('echo-orb-state'),{detail}));}catch{}
  announce('echo-speech-state',{state:detail.mode,level:amplitude,listening});
 }
 function startLevelLoop(meter){
  stopLevelLoop();S.level=0.55;
  const tick=()=>{if(!S.current&&!S.device){stopLevelLoop();return;}
   if(meter){try{S.level=Math.min(1,meter()*3.2);}catch{S.level=0.55;}}else S.level=0.55+0.3*Math.sin(clock()/160);
   emitState();S.levelTimer=setTimeout(tick,50);};
  tick();
 }
 function stopLevelLoop(){if(S.levelTimer){clearTimeout(S.levelTimer);S.levelTimer=null;}S.level=0;}
 function audioContext(){
  if(S.ctx)return S.ctx;
  const Context=typeof AudioContext!=='undefined'?AudioContext:window.webkitAudioContext;if(!Context)return null;
  try{S.ctx=new Context();}catch{S.ctx=null;}return S.ctx;
 }
 async function unlock(){
  // Autoplay policy: the first user gesture resumes the AudioContext and primes an Audio element
  // with a silent governed-format WAV blob (CSP media-src allows blob:, never data:).
  if(S.unlocked)return true;
  try{const ctx=audioContext();if(ctx&&ctx.state==='suspended')await ctx.resume();}catch{}
  try{
   if(typeof Audio!=='undefined'&&typeof Blob!=='undefined'&&typeof URL!=='undefined'&&URL.createObjectURL){
    const bytes=Uint8Array.from(atob(encodeWav(new Float32Array(160))),c=>c.charCodeAt(0));
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})),probe=new Audio(url);probe.volume=0;
    await Promise.resolve(probe.play()).catch(()=>{});try{probe.pause();}catch{}
    setTimeout(()=>{try{URL.revokeObjectURL(url);}catch{}},1000);
   }
   S.unlocked=true;
  }catch{S.unlocked=true;}
  return S.unlocked;
 }

 // ---------------------------------------------------------------- Echo voice pipeline
 const audioPath=chunk=>{if(typeof chunk?.audio_url!=='string'||!/^\/api\/voice\/audio\/[A-Za-z0-9_-]{1,120}$/.test(chunk.audio_url))throw new Error('Unrecognized voice artifact.');return chunk.audio_url.replace(/^\/api/,'');};
 const quietError=error=>/view changed|session changed|interrupted|aborted/i.test(error instanceof Error?error.message:String(error));
 function playBlob(blob,signal,current,index){
  return new Promise(resolve=>{
   if(signal.aborted){resolve(false);return;}
   if(typeof Audio==='undefined'||typeof URL==='undefined'||!URL.createObjectURL){setStatus('Audio playback is unavailable in this browser.');resolve(false);return;}
   const url=URL.createObjectURL(blob),audio=new Audio(url);let settled=false,meter=null,source=null;
   const finish=value=>{if(settled)return;settled=true;try{signal.removeEventListener('abort',abort);}catch{}try{audio.pause();}catch{}try{source?.disconnect();}catch{}setTimeout(()=>{try{URL.revokeObjectURL(url);}catch{}},500);resolve(value);};
   const abort=()=>finish(false);
   try{signal.addEventListener('abort',abort,{once:true});}catch{}
   const ctx=S.ctx;
   if(ctx&&ctx.state==='running'&&typeof ctx.createMediaElementSource==='function'){
    try{source=ctx.createMediaElementSource(audio);const analyser=ctx.createAnalyser();analyser.fftSize=1024;source.connect(analyser);analyser.connect(ctx.destination);const data=new Uint8Array(analyser.fftSize);
     meter=()=>{analyser.getByteTimeDomainData(data);let sum=0;for(let i=0;i<data.length;i++){const v=(data[i]-128)/128;sum+=v*v;}return Math.sqrt(sum/data.length);};}
    catch{meter=null;source=null;}
   }
   audio.addEventListener('ended',()=>finish(true),{once:true});
   audio.addEventListener('error',()=>{setStatus('Audio playback failed; the speech receipt is in the conversation journal.');finish(false);},{once:true});
   const started=()=>{
    if(current.ttfa===null){current.ttfa=Math.round(clock()-current.startedAt);S.turns++;debug('first_audio',{source:'echo',ttfa_ms:current.ttfa,message_id:current.message.id,lang:current.lang,turns:S.turns});}
    current.chunks=index+1;startLevelLoop(meter);setStatus('Speaking · '+current.voice+(current.provider?' · '+current.provider:''));sync();
   };
   Promise.resolve(audio.play()).then(started,error=>{
    if(error&&(error.name==='NotAllowedError'||/not allowed|gesture/i.test(String(error?.message)))){
     S.blocked={message:current.message,chatId:current.chatId};debug('autoplay_blocked',{message_id:current.message.id});setStatus('Tap to hear Echo.');
    }else setStatus('Audio playback was blocked by the browser.');
    if(S.blocked&&current.replay)S.blocked={replay:current.replay};// a Prime-route reply replays its own text, not a saved message
    finish(false);
   });
  });
 }
 async function speakMessage(message,chatId,options={}){
  const b=bridge();if(!b)return false;
  if(!message||typeof message.id!=='string'||!chatId){setStatus('Nothing saved to speak yet.');return false;}
  if(!echoVoiceConfigured()){
   if(prefs.device)return speakText(message.content,{source:'workspace-device',key:'msg:'+message.id});
   setStatus("Echo's voice is unavailable: "+voiceReason()+". Device voice (not Echo's) is off.");debug('echo_voice_unavailable',{message_id:message.id});return false;
  }
  const key=message.id,prior=S.spoken.get(key);
  if(prior&&!options.force&&!prior.failed){debug('duplicate_suppressed',{message_id:key});return false;}
  // Stop first: cancelling a playing session marks its record, and the id is reused only when the earlier
  // attempt neither failed nor cancelled its session (the autoplay-blocked case).
  stop('replace',{quiet:true});
  const requestId=prior&&!prior.failed&&!prior.cancelled&&typeof prior.requestId==='string'?prior.requestId:uuid();
  const current={message,chatId,requestId,session:{chat_id:chatId,session_id:null},epoch:b.state.accountEpoch,startedAt:clock(),ttfa:null,chunks:0,voice:voiceLabel(),provider:providerName(voiceInfo()?.provider),lang:detectLanguage(message.content||''),queue:null,key:'msg:'+key};
  S.current=current;S.spoken.set(key,{requestId,at:Date.now(),failed:false,cancelled:false});S.blocked=null;S.deferred=null;
  while(S.spoken.size>500)S.spoken.delete(S.spoken.keys().next().value);
  b.state.speech=current.session;setStatus('Preparing '+current.voice+'…');sync();
  debug('speech_requested',{source:'echo',message_id:key,request_id:requestId,lang:current.lang,mode:b.voiceOptions.brief?'summary':'full'});
  let complete=false;
  try{
   const first=await b.api('/voice/start',{chat_id:chatId,message_id:message.id,request_id:requestId,mode:b.voiceOptions.brief?'summary':'full',read_identifiers:false});
   if(!liveCurrent(current))return false;
   const path=audioPath(first);current.session.session_id=first.session_id;
   if(typeof first.voice==='string'&&first.voice.trim())current.voice=first.voice.trim();
   if(typeof first.provider==='string'&&first.provider.trim())current.provider=providerName(first.provider);
   first.blob=await b.audio(path);if(!liveCurrent(current))return false;
   const queue=createQueue({
    fetchNext:async chunk=>{const next=await b.api('/voice/next',{chat_id:chatId,session_id:current.session.session_id,chunk_index:chunk.chunk_index+1});const nextPath=audioPath(next);next.blob=await b.audio(nextPath);next.hasMore=next.has_more===true;return next;},
    play:(chunk,signal,index)=>playBlob(chunk.blob,signal,current,index),
    onEvent:(event,detail)=>debug('queue_'+event,{source:'echo',message_id:key,...detail}),
   });
   current.queue=queue;first.hasMore=first.has_more===true;
   complete=await queue.run(first);
   if(liveCurrent(current)){
    if(complete){setStatus('Spoke with '+current.voice+'. Microphone '+(conversation?.active?'listening':'off')+'.');debug('speech_finished',{source:'echo',message_id:key,chunks:current.chunks,ttfa_ms:current.ttfa,duration_ms:Math.round(clock()-current.startedAt)});}
    else if(!S.blocked){debug('speech_interrupted',{source:'echo',message_id:key,chunks:current.chunks});}
   }
   return complete;
  }catch(error){
   if(!liveCurrent(current))return false;
   const record=S.spoken.get(key);if(record)record.failed=true;
   if(quietError(error)){debug('speech_cancelled',{source:'echo',message_id:key});return false;}
   const reason=error instanceof Error?error.message:'No speech receipt was returned.';
   setStatus("Echo could not speak this reply: "+reason+' No automatic retry was made.');debug('speech_failed',{source:'echo',message_id:key});
   return false;
  }finally{
   if(S.current===current){S.current=null;if(b.state.speech===current.session)b.state.speech=null;stopLevelLoop();emitState();sync();}
  }
 }

 // ---------------------------------------------------------------- Echo's voice for every other reply path
 // ECHO Code replies (chat.js `echo-code-reply`), Swarm and Agents results and Steward advice are not saved
 // Workspace messages, so the backend's /api/voice/start cannot reach them. They speak through the owner-only
 // Prime route POST /api/prime/voice/speak {text} (one bounded section per call, audio/mpeg or audio/wav back),
 // which calls the same loopback voice gateway with the same persona and model. The route status
 // (GET /api/prime/voice/status) is read once per identity and cached, so a Speak click answers at once.
 const PRIME_FIRST=220,PRIME_CHUNK=400,PRIME_BRIEF=600,PRIME_MAX_TEXT=30000,PRIME_MAX_AUDIO=5*1024*1024;
 const SOURCE_LABEL={code:'ECHO Code reply',swarm:'Swarm result',agents:'Agents result',steward:'Steward advice'};
 const sourceLabel=source=>SOURCE_LABEL[source]||'text';
 const ownerSession=()=>signedIn()&&session()?.ownerAccess===true;
 async function primeHeaders(extra={}){const ws=window.EchoPrimeWorkspace;const owner=typeof ws?.ownerHeaders==='function'?await ws.ownerHeaders():{};return {'x-prime-request':'1',...owner,...extra};}
 const primeOff=reason=>({configured:false,available:false,reason});
 const primeVoiceNow=()=>{const p=S.prime;return p&&p.epoch===bridge()?.state?.accountEpoch&&p.owner===ownerSession()?p:null;};
 // An owner's "unavailable" verdict is re-read after a minute (the gateway may have come back); "available" stays cached
 // for the identity, and a later synthesis failure still shows its own reason.
 const PRIME_RECHECK_MS=60000;
 const primeVoiceFresh=()=>{const p=primeVoiceNow();return p&&p.owner&&!(p.configured&&p.available)&&clock()-p.at>PRIME_RECHECK_MS?null:p;};
 function refreshPrimeVoice(){
  const epoch=bridge()?.state?.accountEpoch,owner=ownerSession(),keep=value=>{S.prime={epoch,owner,at:clock(),...value};return S.prime;};
  if(!owner)return Promise.resolve(keep(primeOff(signedIn()?"Echo's voice for these replies is owner-only":'sign in to an approved account')));
  if(typeof fetch!=='function')return Promise.resolve(keep(primeOff('this browser cannot reach the Prime voice route')));
  if(S.primeLoading&&S.primeLoading.epoch===epoch)return S.primeLoading.promise;
  const promise=(async()=>{
   let value;
   try{
    const response=await fetch('/api/prime/voice/status',{method:'GET',credentials:'same-origin',headers:await primeHeaders()});
    let data=null;try{data=await response.json();}catch{}
    if(!response.ok)value=primeOff(typeof data?.error==='string'&&data.error.trim()?data.error.trim().slice(0,300):'the Prime voice route answered HTTP '+response.status);
    else if(!data||typeof data!=='object')value=primeOff('the Prime voice route returned an unrecognized status');
    else{
     const text=v=>typeof v==='string'&&v.trim()?v.trim().slice(0,120):null;
     value={configured:data.configured===true,available:data.configured===true&&data.available!==false,label:text(data.label),provider:text(data.provider),reason:text(data.reason)||(data.configured===true?null:"Echo's voice route is off on this host")};
    }
   }catch{value=primeOff('the Prime voice status check failed');}
   debug('prime_voice_status',{configured:value.configured,available:value.available});
   if(S.primeLoading?.promise===promise)S.primeLoading=null;
   if(bridge()?.state?.accountEpoch!==epoch)return {epoch,owner,...value};// a newer identity owns the cache
   const kept=keep(value);sync();return kept;
  })();
  S.primeLoading={epoch,promise};return promise;
 }
 function primeChunks(text,brief){
  const out=[];let current='';
  for(const sentence of chunkSentences(text,{max:PRIME_CHUNK})){
   const limit=out.length?PRIME_CHUNK:PRIME_FIRST;// a short first section keeps time-to-first-audio low
   if(current&&(current+' '+sentence).length>limit){out.push(current);current=sentence;}else current=current?current+' '+sentence:sentence;
  }
  if(current)out.push(current);
  if(!brief)return out;
  const kept=[];let total=0;for(const chunk of out){if(kept.length&&total+chunk.length>PRIME_BRIEF)break;kept.push(chunk);total+=chunk.length;}
  return kept;
 }
 async function primeSpeak(text,current,index){
  const started=clock();
  const response=await fetch('/api/prime/voice/speak',{method:'POST',credentials:'same-origin',headers:await primeHeaders({'content-type':'application/json'}),body:JSON.stringify({text}),signal:current.controller.signal});
  const header=name=>{try{return String(response.headers?.get?.(name)||'');}catch{return '';}};
  if(!response.ok){
   let data=null;try{data=await response.json();}catch{}
   debug('prime_chunk_failed',{origin:current.source,index,status:response.status});
   throw new Error(typeof data?.error==='string'&&data.error.trim()?data.error.trim().slice(0,300):'the Prime voice route answered HTTP '+response.status+'.');
  }
  if(!/^audio\/(?:mpeg|wav)\b/i.test(header('content-type')))throw new Error("the Prime voice route did not return Echo's audio.");
  const blob=await response.blob();
  if(!blob||!blob.size)throw new Error('the Prime voice route returned empty audio.');
  if(blob.size>PRIME_MAX_AUDIO)throw new Error('the speech audio exceeds the 5 MiB limit.');
  let label='';try{label=decodeURIComponent(header('x-echo-voice-label'));}catch{label='';}
  if(label.trim())current.voice=label.trim().slice(0,60);
  if(header('x-echo-voice-provider'))current.provider=providerName(header('x-echo-voice-provider'));
  debug('prime_chunk_ready',{origin:current.source,index,bytes:blob.size,ms:Math.round(clock()-started)});
  return blob;
 }
 async function speakEcho(text,options={}){
  const b=bridge(),source=options.source||'text',key=options.key||null,label=sourceLabel(source);
  if(!b)return false;
  if(typeof text!=='string'||!text.trim()){setStatus('Nothing to speak yet.');return false;}
  const pv=primeVoiceFresh()||await refreshPrimeVoice();
  if(!pv.configured||pv.available===false){
   // Device voice only behind its explicit toggle, and only because Echo's voice cannot reach this text at all.
   if(prefs.device)return speakText(text,{source,key});
   debug('prime_voice_unavailable',{origin:source,configured:pv.configured});
   if(options.auto){if(S.reasonShown)return false;S.reasonShown=true;}// explain once per identity for automatic replies
   setStatus("Echo's voice is unavailable for this "+label+': '+(pv.reason||"the Prime voice route is off")+'. Turn on "Device voice (not Echo\'s)" to hear this '+label+'.');
   return false;
  }
  const normalised=normalizeForSpeech(text);
  if(!normalised){setStatus('Nothing to speak after screen-only details are removed.');return false;}
  if(normalised.length>PRIME_MAX_TEXT){setStatus('This '+label+' is too long for speech. Ask for a shorter spoken version.');return false;}
  const brief=b.voiceOptions?.brief===true,chunks=primeChunks(normalised,brief);
  if(!chunks.length){setStatus('Nothing to speak after screen-only details are removed.');return false;}
  stop('replace',{quiet:true});
  const current={kind:'prime',source,key,message:{id:'prime:'+(key||uuid())},chatId:null,requestId:null,session:{chat_id:null,session_id:null},epoch:b.state.accountEpoch,startedAt:clock(),ttfa:null,chunks:0,
   voice:pv.label||voiceLabel(),provider:providerName(pv.provider),lang:detectLanguage(text),queue:null,controller:new AbortController(),replay:()=>speakEcho(text,{source,key})};
  S.current=current;S.blocked=null;S.deferred=null;
  setStatus('Preparing '+current.voice+'…');sync();
  debug('speech_requested',{source:'echo',route:'prime',origin:source,sections:chunks.length,lang:current.lang,mode:brief?'summary':'full'});
  try{
   const section=async index=>({blob:await primeSpeak(chunks[index],current,index),index,hasMore:index<chunks.length-1});
   const first=await section(0);if(!liveCurrent(current))return false;
   const queue=createQueue({
    fetchNext:item=>section(item.index+1),
    play:(item,signal,index)=>playBlob(item.blob,signal,current,index),
    onEvent:(event,detail)=>debug('queue_'+event,{source:'echo',route:'prime',origin:source,...detail}),
   });
   current.queue=queue;
   const complete=await queue.run(first);
   if(liveCurrent(current)){
    if(complete){setStatus('Spoke the '+label+' with '+current.voice+'. Microphone '+(conversation?.active?'listening':'off')+'.');debug('speech_finished',{source:'echo',route:'prime',origin:source,chunks:current.chunks,ttfa_ms:current.ttfa,duration_ms:Math.round(clock()-current.startedAt)});}
    else if(!S.blocked)debug('speech_interrupted',{source:'echo',route:'prime',origin:source,chunks:current.chunks});
   }
   return complete;
  }catch(error){
   if(!liveCurrent(current))return false;
   if(quietError(error)){debug('speech_cancelled',{source:'echo',route:'prime',origin:source});return false;}
   const raw=error instanceof Error&&error.message.trim()?error.message.trim():'no audio was returned.',reason=/[.!?]$/.test(raw)?raw:raw+'.';
   setStatus('Echo could not speak this '+label+': '+reason+' No automatic retry was made.');debug('speech_failed',{source:'echo',route:'prime',origin:source,chunks:current.chunks});
   return false;
  }finally{
   if(S.current===current){S.current=null;stopLevelLoop();emitState();sync();}
  }
 }
 // Automatic speech when spoken replies is on, deferred to "Resume Echo" while the tab is hidden. Every ECHO Code
 // reply is its own turn; a Swarm, Agents or Steward result re-rendered with the same text speaks once (ten minutes).
 function autoSpeak(text,source,key){
  if(!shouldAutoSpeak()||typeof text!=='string'||!text.trim())return;
  if(source!=='code'){
   const fingerprint=source+':'+text.length+':'+text.slice(0,80),now=Date.now();
   for(const [entry,at] of S.autoSpoken)if(now-at>600000)S.autoSpoken.delete(entry);
   if(S.autoSpoken.has(fingerprint)){debug('duplicate_suppressed',{origin:source});return;}
   S.autoSpoken.set(fingerprint,now);while(S.autoSpoken.size>200)S.autoSpoken.delete(S.autoSpoken.keys().next().value);
  }
  if(document.hidden){S.deferred={replay:()=>speakEcho(text,{source,key})};sync();return;}
  void speakEcho(text,{source,key,auto:true});
 }

 // ---------------------------------------------------------------- device voice (explicit)
 const deviceAvailable=()=>typeof speechSynthesis!=='undefined'&&typeof SpeechSynthesisUtterance!=='undefined';
 function deviceVoiceFor(lang){
  try{const voices=speechSynthesis.getVoices?.()||[];return voices.find(v=>String(v.lang||'').toLowerCase().startsWith(lang))||voices.find(v=>String(v.lang||'').toLowerCase().startsWith(lang.slice(0,2)))||null;}catch{return null;}
 }
 function utter(sentence,lang,signal,current,index){
  return new Promise(resolve=>{
   if(signal.aborted){resolve(false);return;}
   let settled=false;const finish=value=>{if(settled)return;settled=true;try{signal.removeEventListener('abort',abort);}catch{}resolve(value);};
   const abort=()=>{try{speechSynthesis.cancel();}catch{}finish(false);};
   try{signal.addEventListener('abort',abort,{once:true});}catch{}
   try{
    const utterance=new SpeechSynthesisUtterance(sentence);utterance.lang=lang;const voice=deviceVoiceFor(lang);if(voice)utterance.voice=voice;
    utterance.onstart=()=>{if(current.ttfa===null){current.ttfa=Math.round(clock()-current.startedAt);S.turns++;debug('first_audio',{source:'device',ttfa_ms:current.ttfa,lang,turns:S.turns});startLevelLoop(null);sync();}current.chunks=index+1;};
    utterance.onend=()=>finish(true);utterance.onerror=event=>{if(event?.error==='interrupted'||event?.error==='canceled')finish(false);else{setStatus('Device voice failed: '+String(event?.error||'unknown')+'.');finish(false);}};
    speechSynthesis.speak(utterance);
   }catch{setStatus('Device voice is unavailable in this browser.');finish(false);}
  });
 }
 async function speakText(text,options={}){
  const source=options.source||'text';
  if(!prefs.device){setStatus("Device voice (not Echo's) is off. Turn on \"Device voice (not Echo's)\" to hear this "+sourceLabel(source)+'.');debug('device_voice_off',{source});return false;}
  if(!deviceAvailable()){setStatus('Device voice is unavailable in this browser.');return false;}
  let first,fetchNext,count=null;
  if(options.first&&options.fetchNext){first=options.first;fetchNext=options.fetchNext;}// an open stream feeds sentences as they arrive
  else{
   // Device engines drop very long utterances; keep each one short of ~240 characters.
   const normalised=normalizeForSpeech(text),sentences=options.sentences||chunkSentences(normalised,{max:240});
   if(!sentences.length){setStatus('Nothing to speak after screen-only details are removed.');return false;}
   const items=sentences.map((sentence,i)=>({text:sentence,hasMore:i<sentences.length-1,index:i}));first=items[0];fetchNext=item=>items[item.index+1]||null;count=sentences.length;
  }
  stop('replace',{quiet:true});
  const lang=options.lang||detectLanguage(text||first.text),current={source,lang,startedAt:clock(),ttfa:null,chunks:0,key:options.key||null,queue:null,epoch:bridge()?.state?.accountEpoch};
  S.device=current;setStatus("Device voice (not Echo's) · speaking");sync();
  debug('speech_requested',{source:'device',origin:source,lang,sentences:count});
  const queue=createQueue({fetchNext,play:(item,signal,index)=>utter(item.text,lang,signal,current,index),onEvent:(event,detail)=>debug('queue_'+event,{source:'device',...detail})});
  current.queue=queue;
  try{const complete=await queue.run(first);if(S.device===current){if(complete){setStatus("Device voice (not Echo's) finished.");debug('speech_finished',{source:'device',origin:source,chunks:current.chunks,ttfa_ms:current.ttfa});}}return complete;}
  catch(error){if(S.device===current){setStatus('Device voice failed: '+(error instanceof Error?error.message:'unknown')+'.');debug('speech_failed',{source:'device',origin:source});}return false;}
  finally{if(S.device===current){S.device=null;stopLevelLoop();emitState();sync();}}
 }

 // ---------------------------------------------------------------- stop / barge-in
 function stop(reason,options={}){
  const b=bridge(),current=S.current,device=S.device;let stopped=false;
  if(current){S.current=null;stopped=true;try{current.queue?.cancel(reason);}catch{}try{current.controller?.abort();}catch{}// drops an in-flight Prime-route section too
   // The backend caches start() per request id. Once a session is cancelled (or its start was abandoned in
   // flight) a replay must mint a fresh id, otherwise /voice/next answers "session ended".
   const record=S.spoken.get(current.message.id);if(record)record.cancelled=true;
   // Never cancel across an identity boundary: after an account change the old session belongs to another login.
   if(options.cancelBackend!==false&&current.session.session_id&&b&&current.epoch===b.state.accountEpoch)Promise.resolve().then(()=>b.api('/voice/cancel',{chat_id:current.session.chat_id,session_id:current.session.session_id})).catch(()=>{});
   if(b&&b.state.speech===current.session)b.state.speech=null;}
  if(device){S.device=null;stopped=true;try{device.queue?.cancel(reason);}catch{}try{if(deviceAvailable())speechSynthesis.cancel();}catch{}}
  if(S.stream&&reason!=='replace'){if(reason!=='hidden'||S.stream.spokenByDevice)S.stream.cancelled=true;streamClose(S.stream);}
  if(stopped){stopLevelLoop();debug('stopped',{reason,had_echo:!!current,had_device:!!device});if(!options.quiet)setStatus(reason==='hidden'?'Paused while this tab was hidden.':reason==='barge-in'?'Listening · you interrupted Echo.':'Stopped. Microphone '+(conversation?.active?'listening':'off')+'.');}
  emitState();sync();return stopped;
 }
 const speakingKey=()=>S.current?.key||S.device?.key||null;
 // What "Resume Echo" offers back: a Prime-route reply replays its own text, a Workspace reply its saved message.
 const deferOf=current=>typeof current.replay==='function'?{replay:current.replay}:{message:current.message,chatId:current.chatId};

 // ---------------------------------------------------------------- reply hooks
 // Streamed replies: one open device-voice queue per stream. Sentences are pushed as they complete and the
 // queue waits for the next one (or the close) instead of restarting, so sentence 1 plays while the rest
 // streams. Echo's own voice needs the saved reply and starts at `echo-reply-saved`.
 function streamPush(stream,sentence){const text=normalizeForSpeech(sentence);if(!text)return;const item={text,hasMore:true,index:stream.queue.length};stream.queue.push(item);if(stream.waiter){const wake=stream.waiter;stream.waiter=null;wake(item);}}
 function streamClose(stream){if(stream.closed)return;stream.closed=true;if(stream.waiter){const wake=stream.waiter;stream.waiter=null;wake(null);}}
 function streamNext(stream,index){if(stream.queue[index])return Promise.resolve(stream.queue[index]);if(stream.closed||stream.cancelled)return Promise.resolve(null);return new Promise(resolve=>{stream.waiter=resolve;});}
 async function speakStream(stream){
  const first=await streamNext(stream,0);if(!first||stream.cancelled)return false;
  return speakText(null,{source:'stream',key:'stream:'+stream.chatId,lang:detectLanguage(first.text),first,fetchNext:item=>streamNext(stream,item.index+1)});
 }
 function onReplySaved(detail){
  const b=bridge();if(!b||!detail)return;
  const message=detail.message,chatId=detail.chatId,key=streamKey(detail);let closed=null;
  if(S.stream&&S.stream.key===key){
   const stream=S.stream;S.stream=null;
   if(stream.spokenByDevice&&!stream.cancelled)for(const sentence of stream.chunker.flush())streamPush(stream,sentence);
   streamClose(stream);debug('stream_closed',{sentences:stream.sentences,spoken_by_device:stream.spokenByDevice,cancelled:stream.cancelled});
   closed={spokenByDevice:stream.spokenByDevice,cancelled:stream.cancelled};
  }else if(S.closedStreams.has(key)){closed=S.closedStreams.get(key);S.closedStreams.delete(key);}// its stream was already replaced by a newer turn
  // A reply the device voice already spoke, or that the user interrupted while it streamed, is not read again; Listen replays it.
  if(closed&&(closed.spokenByDevice||closed.cancelled)){if(message?.id)S.spoken.set(message.id,{requestId:null,at:Date.now(),failed:false,cancelled:false,device:closed.spokenByDevice,interrupted:closed.cancelled});return;}
  if(b.voiceOptions.conversation===true)return;// the legacy hands-free loop owns this reply
  if(!message||!shouldAutoSpeak())return;
  if(document.hidden){S.deferred={message,chatId};sync();return;}
  void speakMessage(message,chatId);
 }
 // Streams are keyed per turn (workspace.js passes the turn's request id) so an interrupted reply never poisons the next one.
 const streamKey=detail=>String(detail.chatId)+(detail.turn?':'+detail.turn:'');
 function onReplyStream(detail){
  const b=bridge();if(!b||!detail||typeof detail.text!=='string')return;
  const key=streamKey(detail);
  if(!S.stream||S.stream.key!==key){
   if(S.stream){const old=S.stream;streamClose(old);S.closedStreams.set(old.key,{spokenByDevice:old.spokenByDevice,cancelled:old.cancelled});while(S.closedStreams.size>50)S.closedStreams.delete(S.closedStreams.keys().next().value);}
   S.stream={key,chatId:detail.chatId,chunker:createChunker({max:240}),sentences:0,startedAt:clock(),spokenByDevice:false,cancelled:false,closed:false,queue:[],waiter:null};
  }
  const stream=S.stream,sentences=stream.chunker.push(detail.text);
  if(!sentences.length)return;
  stream.sentences+=sentences.length;
  debug('sentence_ready',{chat_id:detail.chatId,count:sentences.length,since_first_token_ms:Math.round(clock()-stream.startedAt)});
  if(stream.cancelled)return;// the user interrupted this reply; do not resume mid-stream
  // Sentence 1 can be spoken while the rest streams only through the device voice; Echo's own voice
  // needs the saved reply, which the backend synthesises from the journal.
  if(!(prefs.device&&shouldAutoSpeak()&&!echoVoiceConfigured()&&b.voiceOptions.conversation!==true&&!document.hidden))return;
  for(const sentence of sentences)streamPush(stream,sentence);
  if(!stream.spokenByDevice){stream.spokenByDevice=true;void speakStream(stream);}
 }
 function registerSpeakButton(article,text,source,key){
  if(!article||typeof text!=='string'||!text.trim())return null;
  let host=/\bmessage-actions\b/.test(String(article.className||''))?article:null;
  if(!host)try{host=article.querySelector?.('.message-actions')||null;}catch{host=null;}
  if(!host){host=el('div',{class:'message-actions speech-actions'});try{article.append(host);}catch{return null;}}
  const label=source==='swarm'||source==='agents'?'Speak result':source==='steward'?'Speak advice':'Speak';
  const button=el('button',{type:'button',class:'quiet-button','data-speech-speak':source},'🔊 '+label);
  // Speak/stop toggle: playback runs in the background so the same button can stop it.
  // Echo's own voice through the Prime route; the device voice only behind its toggle when that route is unavailable.
  button.addEventListener('click',()=>{if(speakingKey()===key)stop('user');else void speakEcho(text,{source,key});sync();});
  host.append(button);
  (ui?.speakButtons||(ui.speakButtons=new Map())).set(button,{key,label:'🔊 '+label});
  return button;
 }
 function onCodeReply(detail){
  if(!detail||typeof detail.text!=='string')return;
  const key='code:'+(detail.sessionId||'')+':'+S.turns+':'+detail.text.length;
  registerSpeakButton(detail.article,detail.text,'code',key);
  autoSpeak(detail.text,'code',key);// Commander 2026-11-05: "It should speak them when spoken replies is selected."
 }
 function onResultRendered(detail){
  if(!detail||typeof detail.text!=='string')return;
  const target=detail.article||detail.container;if(!target)return;
  const key=String(detail.source||'result')+':'+Date.now();
  if(detail.container&&!detail.article){
   // A bare container (the Steward <pre>) gets a sibling actions row instead of children.
   let row=null;try{row=target.parentNode?.querySelector?.('[data-speech-result-row="'+String(detail.source||'result')+'"]')||null;}catch{row=null;}
   if(!row){row=el('div',{class:'message-actions speech-actions','data-speech-result-row':String(detail.source||'result')});try{if(typeof target.after==='function')target.after(row);else target.parentNode?.append(row);}catch{return;}}
   else row.replaceChildren();
   registerSpeakButton(row,detail.text,detail.source,key);
   autoSpeak(detail.text,String(detail.source||'result'),key);
   return;
  }
  registerSpeakButton(target,detail.text,detail.source,key);
  autoSpeak(detail.text,String(detail.source||'result'),key);
 }

 // ---------------------------------------------------------------- conversation mode (continuous)
 const endOfTurnMs=()=>{const value=Number(voiceInfo()?.end_of_turn_ms);return Number.isFinite(value)&&value>=400&&value<=5000?value:1500;};
 // Transcripts wait in an ordered outbox: `echo-reply-saved` fires before send() settles, so a turn can still
 // be in flight when the next words are ready. The drain retries every 250 ms (bounded) and keeps order.
 function queueTranscript(text){const conv=conversation;if(!conv||!conv.active||!text)return;conv.outbox.push(text);conv.drainTries=0;void drainOutbox();}
 async function drainOutbox(){
  const b=bridge(),conv=conversation;if(!b||!conv||!conv.active||!conv.outbox.length||conv.sending)return;
  if(conv.drainTimer){clearTimeout(conv.drainTimer);conv.drainTimer=null;}
  if(b.state.turn){
   if(conv.drainTries===0)setStatus('Echo is still answering; your words are queued.');
   if(++conv.drainTries<=480)conv.drainTimer=setTimeout(()=>void drainOutbox(),250);else setStatus('Still waiting for Echo; your words are kept until the turn ends.');
   return;
  }
  const chatId=b.state.chat?.id;if(!chatId){setStatus('Open a saved conversation to keep talking.');return;}
  conv.chatId=chatId;const text=conv.outbox.splice(0).join(' ');conv.sending=true;
  setStatus('Sending your words…');debug('conversation_send',{chars:text.length});
  try{const outcome=await window.EchoPrimeWorkspace.send(text);if(conversation!==conv)return;if(!outcome?.sent)setStatus('Not sent: '+(outcome?.detail||'the conversation refused the message')+' Still listening.');}
  catch(error){if(conversation===conv)setStatus('Not sent: '+(error instanceof Error?error.message:'conversation failed')+' Still listening.');}
  finally{if(conversation===conv){conv.sending=false;if(conv.outbox.length)void drainOutbox();}}
 }
 async function endUtterance(reason){
  const b=bridge(),conv=conversation;if(!b||!conv||!conv.active)return;
  if(conv.transcribing){if(reason!=='max')conv.endPending=true;return;}// finish this part first, then close the turn
  const chatId=b.state.chat?.id;if(!chatId){setStatus('Open a saved conversation to keep talking.');return;}
  conv.chatId=chatId;
  const chunks=conv.chunks;conv.chunks=[];conv.frames=0;
  conv.capturing=reason==='max';// a long utterance keeps recording while its first part is transcribed
  let samples;try{samples=resample(chunks,conv.sampleRate);}catch{samples=new Float32Array(0);}
  if(samples.length<4800){
   debug('utterance_dropped',{reason,frames:samples.length});
   if(reason!=='max'&&conv.pendingText){const whole=conv.pendingText;conv.pendingText='';queueTranscript(whole);}
   return;
  }
  conv.transcribing=true;setStatus('Transcribing · '+(reason==='max'?'long utterance, still listening':'end of speech'));sync();
  const texts=[];
  try{
   for(let i=0;i<samples.length;i+=120000){
    if(!conversation||conversation!==conv||!conv.active)return;
    const part=samples.subarray(i,Math.min(samples.length,i+120000));
    const result=await b.api('/voice/transcribe',{chat_id:conv.chatId,request_id:uuid(),audio_b64:encodeWav(part)});
    if(result?.provider!=='elevenlabs-scribe'||typeof result.text!=='string'||result.text.length>12000)throw new Error('The canonical transcription provider did not confirm a bounded transcript.');
    if(result.text.trim())texts.push(result.text.trim());
   }
   debug('utterance_transcribed',{reason,parts:texts.length,frames:samples.length});
   const text=texts.join(' ').trim();
   if(reason==='max'){conv.pendingText=[conv.pendingText,text].filter(Boolean).join(' ');return;}// more of this utterance is still being captured
   const whole=[conv.pendingText,text].filter(Boolean).join(' ');conv.pendingText='';
   if(!whole){setStatus('No words were recognised. Still listening.');return;}
   queueTranscript(whole);
  }catch(error){if(conversation===conv)setStatus((error instanceof Error?error.message:'Transcription unavailable.')+' Still listening; no automatic retry was made.');debug('utterance_failed',{reason});}
  finally{if(conversation===conv){conv.transcribing=false;sync();if(conv.endPending){conv.endPending=false;void endUtterance('silence');}}}
 }
 function pump(dt){
  const conv=conversation;if(!conv||!conv.active||conv.paused)return null;
  let rms=0;try{conv.analyser.getFloatTimeDomainData(conv.buffer);let sum=0;for(let i=0;i<conv.buffer.length;i++)sum+=conv.buffer[i]*conv.buffer[i];rms=Math.sqrt(sum/conv.buffer.length);}catch{rms=0;}
  const echoSpeaking=!!S.current||!!S.device,verdict=conv.vad.update(rms,dt,echoSpeaking);
  if(verdict==='start'){
   if(echoSpeaking)stop('barge-in',{quiet:false});
   if(!conv.capturing){conv.chunks=conv.preroll.slice();conv.frames=conv.chunks.reduce((n,part)=>n+part.length,0);conv.capturing=true;}
   setStatus('Listening · speak, then pause to send');debug('utterance_started',{barge_in:echoSpeaking});emitState();
  }else if(verdict==='end')void endUtterance('silence');
  return verdict;
 }
 async function startConversation(){
  const b=bridge();if(!b)return false;
  if(conversation?.active)return true;
  if(!signedIn()){setStatus('Sign in to an approved account before starting conversation mode.');return false;}
  if(window.EchoPrimeWorkspace?.generalMode===false){setStatus('Switch the conversation to Echo (not ECHO Code) before starting conversation mode.');return false;}
  if(!echoVoiceConfigured()){setStatus("Conversation mode needs the Workspace voice backend for transcription: "+voiceReason()+'.');return false;}
  if(b.state.capture||b.state.micPending||b.voiceOptions.conversation){setStatus('Stop the active microphone or hands-free voice first.');return false;}
  if(!navigator.mediaDevices?.getUserMedia){setStatus('Microphone capture is unavailable in this browser.');return false;}
  if(!b.state.chat){try{await window.EchoPrimeWorkspace.newChat();}catch{}if(!b.state.chat){setStatus('Open a saved conversation first.');return false;}}
  stop('mic',{quiet:true});await unlock();
  const epoch=b.state.accountEpoch,chatId=b.state.chat.id;let stream,ctx;
  setStatus('Requesting microphone permission…');
  try{
   stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   if(epoch!==b.state.accountEpoch||conversation){stream.getTracks().forEach(track=>track.stop());return false;}
   const Context=typeof AudioContext!=='undefined'?AudioContext:window.webkitAudioContext;if(!Context)throw new Error('PCM microphone capture is unavailable in this browser.');
   ctx=new Context();if(!Number.isFinite(ctx.sampleRate)||ctx.sampleRate<8000||ctx.sampleRate>192000)throw new Error('Unsupported microphone sample rate.');
   const source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser();analyser.fftSize=1024;source.connect(analyser);
   const processor=ctx.createScriptProcessor(4096,1,1),mute=ctx.createGain();mute.gain.value=0;source.connect(processor);processor.connect(mute);mute.connect(ctx.destination);
   const conv={active:true,paused:false,stream,ctx,source,analyser,processor,mute,buffer:new Float32Array(analyser.fftSize),vad:createVad({endOfTurnMs:endOfTurnMs()}),chunks:[],preroll:[],frames:0,capturing:false,transcribing:false,endPending:false,pendingText:'',outbox:[],drainTimer:null,drainTries:0,sending:false,chatId,epoch,sampleRate:ctx.sampleRate,timer:null};
   processor.onaudioprocess=event=>{
    if(!conv.active||conv.paused)return;const data=new Float32Array(event.inputBuffer.getChannelData(0));
    if(conv.capturing){conv.chunks.push(data);conv.frames+=data.length;if(conv.frames>=Math.floor(conv.sampleRate*7.5))void endUtterance('max');}
    else{conv.preroll.push(data);while(conv.preroll.length>3)conv.preroll.shift();}
   };
   conversation=conv;
   const tick=()=>{if(conversation!==conv||!conv.active)return;pump(50);conv.timer=setTimeout(tick,50);};
   await ctx.resume();tick();
   setStatus('Conversation mode · listening. Speak, pause to send; speak over Echo to interrupt.');debug('conversation_started',{end_of_turn_ms:endOfTurnMs()});emitState();announce('echo-speech-changed',{});sync();
   return true;
  }catch(error){
   stream?.getTracks().forEach(track=>track.stop());try{await ctx?.close();}catch{}
   if(conversation&&conversation.stream===stream)conversation=null;
   setStatus(error instanceof Error?error.message:'Microphone permission is unavailable.');emitState();sync();return false;
  }
 }
 function stopConversation(reason){
  const conv=conversation;if(!conv)return false;conversation=null;conv.active=false;
  if(conv.timer)clearTimeout(conv.timer);if(conv.drainTimer)clearTimeout(conv.drainTimer);conv.processor.onaudioprocess=null;
  for(const node of [conv.source,conv.processor,conv.mute])try{node.disconnect();}catch{}
  try{conv.stream.getTracks().forEach(track=>track.stop());}catch{}
  try{void conv.ctx.close?.();}catch{}
  debug('conversation_stopped',{reason});setStatus('Conversation mode off. Microphone off.');emitState();announce('echo-speech-changed',{});sync();return true;
 }
 const conversationApi={
  start:startConversation,stop:(reason='user')=>stopConversation(reason),
  toggle:async()=>conversation?.active?stopConversation('user'):startConversation(),
  active:()=>!!conversation&&conversation.active,
  pump,
 };

 // ---------------------------------------------------------------- dock UI
 function control(label,run,attributes={}){
  const node=el('button',{type:'button',class:'quiet-button speech-button',...attributes},label);
  node.addEventListener('click',async()=>{if(node.disabled)return;node.disabled=true;try{await run();}catch(error){setStatus(error instanceof Error?error.message:'Speech action could not be completed.');}finally{node.disabled=false;sync();}});
  return node;
 }
 function setMuted(value){
  const b=bridge();prefs.muted=value===true;savePrefs();
  if(b){const before=b.voiceOptions.spoken;b.voiceOptions.spoken=signedIn()&&!prefs.muted;if(before!==b.voiceOptions.spoken)try{b.updateContext();}catch{}}// re-syncs the voice bar checkbox
  if(prefs.muted)stop('mute',{quiet:true});
  debug('mute_changed',{muted:prefs.muted});setStatus(prefs.muted?'Echo is muted. Replies stay silent until you unmute.':'Echo will speak replies.');announce('echo-speech-changed',{});sync();
 }
 function build(){
  if(ui)return;
  ui={speakButtons:new Map()};
  ui.voice=el('span',{class:'speech-voice','data-speech-voice':''});
  ui.mute=control('Mute Echo',async()=>setMuted(!prefs.muted),{'data-speech-mute':'','aria-pressed':'false'});
  ui.stop=control('⏹ Stop',async()=>{stop('user');},{'data-speech-stop':''});
  ui.count=el('span',{class:'speech-count','data-speech-count':'',role:'status'},'Spoken: 0');
  ui.device=el('input',{type:'checkbox','data-speech-device':''});
  ui.device.addEventListener('change',()=>{prefs.device=ui.device.checked===true;savePrefs();if(!prefs.device&&S.device)stop('device-off',{quiet:true});debug('device_voice_changed',{enabled:prefs.device});setStatus(prefs.device?"Device voice (not Echo's) will speak text Echo's voice cannot reach.":'Device voice off.');sync();});
  ui.deviceLabel=el('label',{class:'check speech-device'},ui.device,"Device voice (not Echo's)");
  ui.conversation=control('◉ Conversation mode',async()=>{await conversationApi.toggle();},{'data-speech-conversation':'','aria-pressed':'false',title:'Continuous voice conversation: the microphone stays open, each pause sends your words, Echo speaks the reply, and speaking over Echo interrupts it.'});
  // A Prime-route reply (ECHO Code, Swarm, Agents, Steward) carries its own replay; a Workspace reply replays its saved message.
  const replay=item=>{if(!item)return;if(typeof item.replay==='function')void item.replay();else void speakMessage(item.message,item.chatId,{force:true});};
  ui.tap=control('Tap to hear Echo',async()=>{const blocked=S.blocked;S.blocked=null;await unlock();replay(blocked);},{class:'speech-chip','data-speech-tap':''});
  ui.resume=control('Resume Echo',async()=>{const deferred=S.deferred;S.deferred=null;await unlock();replay(deferred);},{class:'speech-chip','data-speech-resume':''});
  ui.status=el('small',{class:'speech-status','data-speech-status':'',role:'status'});
  ui.root=el('div',{class:'speech-dock','data-speech-dock':'','aria-label':'Spoken replies'},
   el('div',{class:'speech-row'},ui.voice,ui.mute,ui.stop,ui.count),
   el('div',{class:'speech-row'},ui.deviceLabel,ui.conversation,ui.tap,ui.resume),
   ui.status);
  ui.root.hidden=true;ui.tap.hidden=true;ui.resume.hidden=true;
  ($('#composer-extras')||$('.composer-caption'))?.after(ui.root);
  for(const name of ['echo-workspace-context','echo-account-changed'])window.addEventListener(name,()=>{if(name==='echo-account-changed')onAccountChanged();applyDefault();sync();});
  window.addEventListener('echo-reply-saved',event=>onReplySaved(event?.detail));
  window.addEventListener('echo-reply-stream',event=>onReplyStream(event?.detail));
  window.addEventListener('echo-code-reply',event=>onCodeReply(event?.detail));
  window.addEventListener('echo-result-rendered',event=>onResultRendered(event?.detail));
  // workspace.js calls stopAudio() from its own visibilitychange handler before ours runs; keep the hidden-tab
  // reply so "Resume Echo" can offer it back.
  window.addEventListener('echo-voice-stop',()=>{if(!(S.current||S.device))return;if(document.hidden&&S.current)S.deferred=deferOf(S.current);stop(document.hidden?'hidden':'workspace',{quiet:!document.hidden});});
  window.addEventListener('pagehide',()=>{stop('pagehide',{quiet:true});stopConversation('pagehide');});
  for(const name of ['pointerdown','keydown','touchstart'])window.addEventListener(name,()=>{void unlock();},{once:true,capture:true,passive:true});
  document.addEventListener('visibilitychange',()=>{
   if(document.hidden){const current=S.current;if(current){S.deferred=deferOf(current);}stop('hidden',{quiet:false});if(conversation)conversation.paused=true;}
   else{if(conversation){conversation.paused=false;conversation.vad.reset();}emitState();}
   sync();
  });
  $('#prompt')?.addEventListener('input',()=>{if(S.current||S.device)stop('typing');});
  $('#composer')?.addEventListener('submit',()=>{if(S.current||S.device)stop('send',{quiet:true});},true);
  $('#stop-chat')?.addEventListener('click',()=>{stop('stop');});
  $('#voice-button')?.addEventListener('click',async()=>{const b=bridge();if(!b||!window.EchoPrimeWorkspace?.enabled)return;stop('mic',{quiet:true});if(!signedIn()||!echoVoiceConfigured()){setStatus(signedIn()?"Microphone needs the Workspace voice backend: "+voiceReason()+'.':'Sign in to use the microphone.');sync();return;}try{await b.dictate();}catch(error){setStatus(error instanceof Error?error.message:'Microphone unavailable.');}sync();});
  bridge()?.onStatus(()=>sync());
  applyDefault();sync();
 }
 function onAccountChanged(){
  S.spoken.clear();S.closedStreams.clear();S.turns=0;S.deferred=null;S.blocked=null;S.stream=null;S.reasonShown=false;S.appliedEpoch=null;S.prime=null;S.primeLoading=null;S.autoSpoken.clear();
  stop('account',{quiet:true,cancelBackend:false});stopConversation('account');setStatus('');
 }
 function applyDefault(){
  const b=bridge();if(!b)return;const epoch=b.state.accountEpoch;
  if(S.appliedEpoch===epoch)return;S.appliedEpoch=epoch;
  // Commander directive 2026-11-04: spoken replies are ON for signed-in approved accounts unless
  // muted; anonymous visitors stay silent. workspace.js keeps its own default at false and resets
  // it per identity; this applies the directive after each identity readback.
  const before=b.voiceOptions.spoken;b.voiceOptions.spoken=signedIn()&&!prefs.muted;
  debug('default_applied',{signed_in:signedIn(),spoken:b.voiceOptions.spoken,muted:prefs.muted});
  if(before!==b.voiceOptions.spoken)try{b.updateContext();}catch{}// the voice bar checkbox rendered before this default landed
  void refreshPrimeVoice();// Echo's voice for ECHO Code, Swarm, Agents and Steward: read once per identity
 }
 function attachBarControl(){
  const bar=$('[data-voice-bar]');if(!bar||ui.barMute)return;
  let controls=null;try{controls=bar.querySelector('.voice-controls');}catch{controls=null;}
  if(!controls)return;
  ui.barMute=control('Mute Echo',async()=>setMuted(!prefs.muted),{'data-speech-bar-mute':''});controls.append(ui.barMute);
 }
 function sync(){
  if(!ui)return;const b=bridge();
  const visible=!!b&&signedIn();ui.root.hidden=!visible;
  if(!visible)return;
  attachBarControl();
  const configured=echoVoiceConfigured(),speaking=!!S.current,deviceSpeaking=!!S.device;
  ui.voice.textContent=configured?"Echo's voice · "+(S.current?.voice||voiceLabel())+(providerName(voiceInfo()?.provider)?' · '+providerName(voiceInfo()?.provider):''):"Echo's voice unavailable · "+voiceReason();
  ui.voice.classList.toggle('unavailable',!configured);
  const muted=prefs.muted||b.voiceOptions.spoken!==true;
  for(const button of [ui.mute,ui.barMute].filter(Boolean)){button.textContent=muted?'🔊 Unmute Echo':'🔇 Mute Echo';button.setAttribute('aria-pressed',String(muted));}
  ui.stop.hidden=!(speaking||deviceSpeaking);
  ui.count.textContent='Spoken: '+S.turns;
  ui.device.checked=prefs.device;
  ui.conversation.hidden=!configured;ui.conversation.textContent=conversation?.active?'◉ Conversation mode on':'◉ Conversation mode';ui.conversation.setAttribute('aria-pressed',String(!!conversation?.active));
  ui.tap.hidden=!S.blocked;ui.resume.hidden=!S.deferred||document.hidden;
  const key=speakingKey();
  for(const [button,info] of ui.speakButtons){const active=key!==null&&info.key===key;button.textContent=active?'⏹ Stop':info.label;button.setAttribute('aria-pressed',String(active));}
 }

 // ---------------------------------------------------------------- public surface
 window.EchoPrimeSpeech={
  normalizeForSpeech,chunkSentences,createChunker,detectLanguage,createQueue,createVad,encodeWav,resample,numberWords,cardinal,ordinal,
  speakMessage,speakText,speakEcho,primeChunks,refreshPrimeVoice,get primeVoice(){return primeVoiceNow();},stop,unlock,conversation:conversationApi,
  setMuted,get muted(){return prefs.muted;},get deviceVoice(){return prefs.device;},
  get turns(){return S.turns;},get speaking(){return !!S.current||!!S.device;},get blocked(){return !!S.blocked;},get deferred(){return !!S.deferred;},
  get handlesReplies(){return !!ui;},
  snapshot(){const p=primeVoiceNow();return {turns:S.turns,speaking:!!S.current,deviceSpeaking:!!S.device,muted:prefs.muted,device:prefs.device,blocked:!!S.blocked,deferred:!!S.deferred,conversation:!!conversation?.active,spoken:[...S.spoken.keys()],primeVoice:p?{configured:p.configured,available:p.available}:null};},
 };
 (async()=>{
  try{
   loadPrefs();
   const workspace=window.EchoPrimeWorkspace;if(!workspace||!await workspace.ready||!workspace.enabled||!bridge())return;
   build();
  }catch{}
 })();
})();
