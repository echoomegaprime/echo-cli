/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM and bridge stand-ins */
import {expect,it,vi} from 'vitest';
import {Node,walk,world,storage,primeShell,source,type World} from './fixtures/prime-fake-dom.js';

// Layout system (layout.js) and ESH dock chrome (esh-dock.js), ported from the private Workspace.
// Pure functions first, then the mounted controls against a DOM stand-in, then the shipped
// workspace.js with both modules loaded so the review-then-run gate is exercised end to end.
const KEY='echo-prime-layout-v1',view={width:1200,height:800};
const saved=(w:World)=>JSON.parse(w.storage.map.get(KEY)||'null');
function layoutWorld(options:{storage?:ReturnType<typeof storage>;bridge?:any;files?:string[];width?:number;height?:number}={}){
 const geometry={rect:{x:280,y:90,width:640,height:430},floating:false};
 const bridge=options.bridge??{eshLayout:{get:vi.fn(()=>({rect:{...geometry.rect},floating:geometry.floating})),set:vi.fn((next:any)=>{if(next.rect)Object.assign(geometry.rect,next.rect);if(typeof next.floating==='boolean')geometry.floating=next.floating;})}};
 const w=world(options.files??['layout.js'],{storage:options.storage,width:options.width,height:options.height,body:primeShell,window:{EchoPrimeWorkspace:{bridge}}});
 return {...w,bridge,geometry};
}
const pure=()=>layoutWorld().window.EchoPrimeLayout;

// ---------- pure geometry ----------
it('normalizes a saved layout to Prime defaults and clamps every value to the viewport',()=>{
 const L=pure();
 expect(L.normalize(null,view)).toEqual({version:1,side:'left',sidebar:250,dockHeight:430,mode:'dock',rect:{x:280,y:90,width:640,height:430}});
 expect(L.normalize({version:1,side:'right',sidebar:9000,dockHeight:1,mode:'float',rect:{x:-50,y:-50,width:5000,height:5000}},view)).toEqual({version:1,side:'right',sidebar:480,dockHeight:160,mode:'float',rect:{x:8,y:8,width:1184,height:784}});
 for(const bad of [{version:2,side:'right'},['right'],'right',7,{side:'right'}])expect(L.normalize(bad,view).side).toBe('left');
 expect(L.normalize({version:1,sidebar:300},{width:500,height:300}).sidebar).toBe(180);
 expect(L.normalize({version:1,dockHeight:700},{width:1200,height:600}).dockHeight).toBe(510);
});
it('clamps a rectangle inside the viewport with the ESH minimum size and tolerates junk',()=>{
 const L=pure();
 expect(L.clampRect({x:1000,y:700,width:400,height:300},view)).toEqual({x:792,y:492,width:400,height:300});
 expect(L.clampRect({width:10,height:10},view)).toMatchObject({width:300,height:200});
 expect(L.clampRect(undefined,view)).toEqual({x:280,y:90,width:640,height:430});
 expect(L.clampRect({x:'a',y:NaN,width:Infinity,height:null},view)).toEqual({x:280,y:90,width:640,height:430});
 expect(L.clampRect({},{width:200,height:160})).toEqual({x:8,y:8,width:184,height:144});
});
it('resizes from each of the eight edges without crossing the minimum size or the viewport',()=>{
 const L=pure(),rect={x:300,y:100,width:400,height:300};
 expect(L.resizeRect(rect,'e',50,0,view)).toEqual({x:300,y:100,width:450,height:300});
 expect(L.resizeRect(rect,'w',50,0,view)).toEqual({x:350,y:100,width:350,height:300});
 expect(L.resizeRect(rect,'n',0,-40,view)).toEqual({x:300,y:60,width:400,height:340});
 expect(L.resizeRect(rect,'s',0,60,view)).toEqual({x:300,y:100,width:400,height:360});
 expect(L.resizeRect(rect,'ne',30,-30,view)).toEqual({x:300,y:70,width:430,height:330});
 expect(L.resizeRect(rect,'sw',-30,30,view)).toEqual({x:270,y:100,width:430,height:330});
 expect(L.resizeRect(rect,'w',500,0,view)).toEqual({x:400,y:100,width:300,height:300});// minimum width
 expect(L.resizeRect(rect,'s',0,5000,view)).toEqual({x:300,y:100,width:400,height:692});// viewport bottom - 8
 expect(L.resizeRect(rect,'n',0,5000,view)).toEqual({x:300,y:200,width:400,height:200});// minimum height
 expect(L.resizeRect(rect,'zz',99,99,view)).toEqual(rect);
});
it('reads and writes the layout under one Prime key and survives a broken or missing storage',()=>{
 const L=pure(),good=storage({[KEY]:JSON.stringify({version:1,side:'right',sidebar:320,mode:'float',rect:{x:10,y:10,width:500,height:400}})});
 expect(L.readLayout(good,view)).toMatchObject({side:'right',sidebar:320,mode:'float',rect:{x:10,y:10,width:500,height:400}});
 expect(L.readLayout(storage({[KEY]:'{not json'}),view)).toEqual(L.normalize(null,view));
 expect(L.readLayout(storage({},{throws:true}),view)).toEqual(L.normalize(null,view));
 expect(L.readLayout(null,view)).toEqual(L.normalize(null,view));
 const out=storage();expect(L.writeLayout(out,L.normalize(null,view))).toBe(true);expect(JSON.parse(out.map.get(KEY)!)).toMatchObject({version:1,side:'left'});
 expect(L.writeLayout(storage({},{throws:true}),L.normalize(null,view))).toBe(false);expect(L.writeLayout(null,{})).toBe(false);
 expect(L.KEY).toBe(KEY);
});

// ---------- mounted layout controls ----------
it('mounts navigation tools, resizers, Reset and eight ESH edge handles and applies the default geometry',()=>{
 const w=layoutWorld(),sidebar=w.get('#sidebar'),host=w.get('#workspace-esh');
 const tools=w.find('.sidebar-layout-tools')!;expect(tools.parent).toBe(w.get('.sidebar-bottom'));expect(w.get('.sidebar-bottom').children[0]).toBe(tools);
 expect(w.button('⠿ Move')).toBeTruthy();expect(w.button('⇆')).toBeTruthy();
 const side=w.find('.sidebar-resizer')!;expect(side.parent).toBe(sidebar);expect(side.attributes.role).toBe('separator');expect(side.attributes['aria-orientation']).toBe('vertical');expect(side.attributes['aria-valuenow']).toBe('250');
 const dock=w.find('.dock-resizer')!;expect(host.children[0]).toBe(dock);expect(dock.attributes['aria-orientation']).toBe('horizontal');expect(dock.attributes['aria-valuenow']).toBe('430');expect(dock.attributes['aria-valuemax']).toBe('680');
 const titlebar=w.find('.workspace-esh-titlebar')!,labels=titlebar.children.map(n=>n.attributes.id||n.textContent);expect(labels).toEqual(['workspace-esh-grip','workspace-esh-title','workspace-esh-float','Reset','workspace-esh-close']);
 const handles=walk(host).filter(n=>/\bpanel-resizer\b/.test(n.className));expect(handles.map(h=>h.dataset.edge)).toEqual(['n','e','s','w','ne','nw','se','sw']);
 for(const h of handles){expect(h.attributes['aria-label']).toContain('Resize ESH '+h.dataset.edge!.toUpperCase());expect(h.attributes.type).toBe('button');}
 expect(w.body.classList.contains('sidebar-right')).toBe(false);expect(w.body.styles['--sidebar-width']).toBe('250px');expect(host.styles['--dock-height']).toBe('430px');
 expect(w.bridge.eshLayout.set).toHaveBeenCalledWith({rect:{x:280,y:90,width:640,height:430},floating:false});
 expect(w.storage.writes).toEqual([]);// mounting does not write
});
it('moves the navigation to the other side by button, keyboard or drag and persists the side only',async()=>{
 const w=layoutWorld();
 await w.button('⇆')!.click();expect(w.body.classList.contains('sidebar-right')).toBe(true);expect(saved(w)).toMatchObject({version:1,side:'right',sidebar:250});
 const move=w.button('⠿ Move')!;await move.fire('keydown',{key:'ArrowLeft'});expect(w.body.classList.contains('sidebar-right')).toBe(false);expect(saved(w).side).toBe('left');
 await move.fire('pointerdown',{button:0,pointerId:1,clientX:100,clientY:10});await move.fire('pointermove',{pointerId:1,clientX:900,clientY:10});expect(w.body.classList.contains('sidebar-right')).toBe(true);
 expect(w.body.classList.contains('panel-dragging')).toBe(true);await move.fire('pointerup',{pointerId:1,clientX:900,clientY:10});expect(w.body.classList.contains('panel-dragging')).toBe(false);expect(saved(w).side).toBe('right');
 const last=w.debug.mock.calls.at(-1)!;expect(last[0]).toBe('[echo.layout]');expect(last[1]).toMatchObject({event:'layout_changed',reason:'move-navigation',persisted:true,side:'right'});
 expect(JSON.stringify(saved(w))).not.toMatch(/Get-Location|command|csrf/);
});
it('resizes the navigation panel with the keyboard and by dragging, clamped to the Prime bounds, and cancels a drag cleanly',async()=>{
 const w=layoutWorld(),side=w.find('.sidebar-resizer')!;
 await side.fire('keydown',{key:'ArrowRight'});expect(w.body.styles['--sidebar-width']).toBe('270px');expect(side.attributes['aria-valuenow']).toBe('270');expect(saved(w).sidebar).toBe(270);
 await side.fire('keydown',{key:'Home'});expect(saved(w).sidebar).toBe(250);
 for(let i=0;i<20;i++)await side.fire('keydown',{key:'ArrowLeft'});expect(saved(w).sidebar).toBe(180);
 for(let i=0;i<40;i++)await side.fire('keydown',{key:'ArrowRight'});expect(saved(w).sidebar).toBe(480);
 await side.fire('keydown',{key:'Home'});
 await side.fire('pointerdown',{button:0,pointerId:3,clientX:250,clientY:300});await side.fire('pointermove',{pointerId:3,clientX:310,clientY:300});expect(w.body.styles['--sidebar-width']).toBe('310px');
 await side.fire('pointercancel',{pointerId:3,clientX:310,clientY:300});expect(w.body.styles['--sidebar-width']).toBe('250px');expect(saved(w).sidebar).toBe(250);
 await w.button('⇆')!.click();await side.fire('keydown',{key:'ArrowRight'});expect(saved(w).sidebar).toBe(230);// mirrored on the right side
 await side.fire('pointerdown',{button:1,pointerId:4,clientX:0,clientY:0});expect(w.body.classList.contains('panel-dragging')).toBe(false);// secondary button ignored
});
it('resizes the docked ESH height with the keyboard and drag and keeps it inside the viewport',async()=>{
 const w=layoutWorld(),dock=w.find('.dock-resizer')!,host=w.get('#workspace-esh');
 await dock.fire('keydown',{key:'ArrowUp'});expect(host.styles['--dock-height']).toBe('450px');expect(saved(w).dockHeight).toBe(450);
 await dock.fire('keydown',{key:'ArrowDown'});await dock.fire('keydown',{key:'ArrowDown'});expect(saved(w).dockHeight).toBe(410);
 await dock.fire('keydown',{key:'Home'});expect(saved(w).dockHeight).toBe(430);
 await dock.fire('pointerdown',{button:0,pointerId:2,clientX:500,clientY:400});await dock.fire('pointermove',{pointerId:2,clientX:500,clientY:300});await dock.fire('pointerup',{pointerId:2,clientX:500,clientY:300});
 expect(saved(w).dockHeight).toBe(530);expect(dock.attributes['aria-valuenow']).toBe('530');
 for(let i=0;i<30;i++)await dock.fire('keydown',{key:'ArrowUp'});expect(saved(w).dockHeight).toBe(680);
 for(let i=0;i<60;i++)await dock.fire('keydown',{key:'ArrowDown'});expect(saved(w).dockHeight).toBe(160);
 await dock.fire('keydown',{key:'Enter'});expect(saved(w).dockHeight).toBe(160);
});
it('resizes the floating ESH rectangle from any edge through the owner bridge and remembers float mode',async()=>{
 const w=layoutWorld(),handle=(edge:string)=>walk(w.get('#workspace-esh')).find(n=>n.dataset.edge===edge)!;
 w.bridge.eshLayout.set.mockClear();
 await handle('e').fire('keydown',{key:'ArrowRight'});
 expect(w.bridge.eshLayout.set).toHaveBeenLastCalledWith({rect:{x:280,y:90,width:660,height:430},floating:true});expect(saved(w)).toMatchObject({mode:'float',rect:{x:280,y:90,width:660,height:430}});
 await handle('w').fire('keydown',{key:'ArrowLeft'});expect(w.geometry.rect).toEqual({x:260,y:90,width:680,height:430});
 await handle('n').fire('keydown',{key:'ArrowUp'});expect(w.geometry.rect).toEqual({x:260,y:70,width:680,height:450});
 await handle('sw').fire('keydown',{key:'ArrowDown'});expect(w.geometry.rect).toEqual({x:260,y:70,width:680,height:470});
 await handle('se').fire('pointerdown',{button:0,pointerId:5,clientX:900,clientY:500});await handle('se').fire('pointermove',{pointerId:5,clientX:940,clientY:530});
 expect(w.geometry.rect).toEqual({x:260,y:70,width:720,height:500});await handle('se').fire('pointerup',{pointerId:5,clientX:940,clientY:530});expect(saved(w).rect).toEqual({x:260,y:70,width:720,height:500});
 await handle('nw').fire('pointerdown',{button:0,pointerId:6,clientX:260,clientY:70});await handle('nw').fire('pointermove',{pointerId:6,clientX:200,clientY:30});expect(w.geometry.rect.x).toBe(200);
 await handle('nw').fire('pointercancel',{pointerId:6,clientX:200,clientY:30});expect(w.geometry.rect).toEqual({x:260,y:70,width:720,height:500});// cancel restores the owner too
 await handle('e').fire('keydown',{key:'Tab'});expect(saved(w).rect).toEqual({x:260,y:70,width:720,height:500});
});
it('persists the rectangle the owner reports on echo-esh-layout and resets everything to defaults',async()=>{
 const w=layoutWorld();
 w.geometry.rect={x:40,y:50,width:500,height:300};w.geometry.floating=true;w.emit('echo-esh-layout');
 expect(saved(w)).toMatchObject({mode:'float',rect:{x:40,y:50,width:500,height:300}});
 await w.button('⇆')!.click();await w.find('.sidebar-resizer')!.fire('keydown',{key:'ArrowRight'});await w.find('.dock-resizer')!.fire('keydown',{key:'ArrowUp'});
 w.bridge.eshLayout.set.mockClear();await w.button('Reset')!.click();
 expect(saved(w)).toEqual({version:1,side:'left',sidebar:250,dockHeight:430,mode:'dock',rect:{x:280,y:90,width:640,height:430}});
 expect(w.bridge.eshLayout.set).toHaveBeenCalledWith({rect:{x:280,y:90,width:640,height:430},floating:false});expect(w.body.classList.contains('sidebar-right')).toBe(false);expect(w.body.styles['--sidebar-width']).toBe('250px');
 expect(w.window.EchoPrimeLayout.instance.getState()).toMatchObject({side:'left',mode:'dock'});
 w.window.EchoPrimeLayout.instance.reset();expect(w.debug.mock.calls.at(-1)![1]).toMatchObject({reason:'reset'});
});
it('restores a persisted layout on mount, hands the rectangle to the owner once and re-clamps on viewport resize',()=>{
 const store=storage({[KEY]:JSON.stringify({version:1,side:'right',sidebar:320,dockHeight:500,mode:'float',rect:{x:600,y:300,width:500,height:400}})});
 const w=layoutWorld({storage:store});
 expect(w.body.classList.contains('sidebar-right')).toBe(true);expect(w.body.styles['--sidebar-width']).toBe('320px');expect(w.get('#workspace-esh').styles['--dock-height']).toBe('500px');
 expect(w.bridge.eshLayout.set).toHaveBeenCalledTimes(1);expect(w.bridge.eshLayout.set).toHaveBeenCalledWith({rect:{x:600,y:300,width:500,height:400},floating:true});
 w.window.innerWidth=600;w.window.innerHeight=500;w.emit('resize');
 expect(w.body.styles['--sidebar-width']).toBe('240px');// clamped to width - 360
 expect(w.get('#workspace-esh').styles['--dock-height']).toBe('425px');// clamped to 85% of the height
 expect(store.writes).toEqual([]);// applying a resize does not write
});
it('keeps working when storage is unavailable and reports persisted:false without throwing',async()=>{
 const w=layoutWorld({storage:storage({},{throws:true})});
 expect(w.body.styles['--sidebar-width']).toBe('250px');
 await w.button('⇆')!.click();expect(w.body.classList.contains('sidebar-right')).toBe(true);
 expect(w.debug.mock.calls.at(-1)![1]).toMatchObject({reason:'move-navigation',persisted:false});
});

// ---------- ESH dock chrome ----------
const dockWorld=()=>world(['esh-dock.js'],{body:primeShell});
it('maps Prime receipt outcomes to the Workspace status badge vocabulary',()=>{
 const d=dockWorld().window.EchoPrimeEshDock;
 expect(d.statusFor([])).toEqual({text:'Ready',working:false,outcome:'ready'});expect(d.statusFor(undefined).text).toBe('Ready');
 expect(d.statusFor([{outcome:'returned'},{outcome:'running'}])).toEqual({text:'Working…',working:true,outcome:'running'});
 expect(d.statusFor([{outcome:'returned'}]).text).toBe('Complete');expect(d.statusFor([{outcome:'failed'}]).text).toBe('Needs attention');
 expect(d.statusFor([{outcome:'gated'}]).text).toBe('Needs authorization');expect(d.statusFor([{outcome:'unconfirmed'}]).text).toBe('Unconfirmed');
 expect(d.statusFor([{outcome:'returned'},{outcome:'failed'}]).text).toBe('Needs attention');expect(d.statusFor([{outcome:'mystery'}]).text).toBe('Ready');
});
it('renders readable receipts: PS > command, stdout, stderr, exit code, audit id and the raw receipt',()=>{
 const w=dockWorld(),d=w.window.EchoPrimeEshDock,output=w.get('#workspace-esh-output');
 const status=d.render(output,[
  {id:'1',source:'You',outcome:'returned',command:'Get-Location',result:{ok:true,exit:0,stdout:'C:\\echo',audit_id:'aud-1'}},
  {id:'2',source:'Echo',outcome:'failed',command:'Stop-Service x',result:{ok:false,exit:1,stderr:'denied',error:'Access denied'}},
  {id:'3',source:'Echo',outcome:'returned',command:'Clear-Host',result:{ok:true,exit:0}},
  {id:'4',source:'You',outcome:'running',command:'Get-Date'},
  {id:'5',source:'Echo',outcome:'unconfirmed',command:''},
  {id:'6',source:'Echo',outcome:'returned',command:'echo',result:'plain text receipt'}]);
 expect(status.text).toBe('Working…');// one row is still running
 const entries=output.children;expect(entries).toHaveLength(6);
 const text=(n:Node)=>walk(n).map(x=>x.textContent).join('|');
 expect(entries[0].className).toBe('esh-entry returned');expect(text(entries[0])).toContain('PS > Get-Location');expect(text(entries[0])).toContain('C:\\echo');expect(text(entries[0])).toContain('returned · exit 0');expect(text(entries[0])).toContain('Receipt · aud-1');
 expect(walk(entries[0]).find(n=>n.className.includes('esh-receipt'))!.tagName).toBe('DETAILS');
 expect(text(entries[1])).toContain('denied');expect(text(entries[1])).toContain('Access denied');expect(text(entries[1])).toContain('failed · exit 1');
 expect(text(entries[2])).toContain('No text output.');expect(text(entries[3])).toContain('Waiting for a final receipt…');expect(text(entries[3])).toContain('PS > Get-Date');
 expect(text(entries[4])).toContain('PS > Command receipt');expect(text(entries[4])).toContain('No final receipt recorded. Check before retrying.');
 expect(text(entries[5])).toContain('plain text receipt');
 d.render(output,[]);expect(output.children).toHaveLength(1);expect(output.textContent).toContain('Commands and receipts from this conversation appear here.');
 expect(d.render(output,[{outcome:'running'}]).text).toBe('Working…');
});
it('mounts the badge, the PS > prompt and Ctrl+Enter that reviews first and runs only a reviewed command',async()=>{
 const w=dockWorld(),title=w.get('#workspace-esh-title'),command=w.get('#workspace-esh-command'),review=w.get('#workspace-esh-review'),run=w.get('#workspace-esh-run');
 const badge=w.find('[data-esh-status]')!;expect(badge.textContent).toBe('Ready');expect(title.parent!.children[title.parent!.children.indexOf(title)+1]).toBe(badge);expect(badge.attributes.role).toBe('status');
 const prompt=w.find('.esh-prompt')!;expect(prompt.textContent).toBe('PS >');expect(command.parent!.children.indexOf(prompt)).toBe(command.parent!.children.indexOf(command)-1);expect(prompt.attributes['aria-hidden']).toBe('true');
 expect(command.attributes.placeholder).toContain('Ctrl+Enter');
 const clicks={review:0,run:0};review.addEventListener('click',()=>{clicks.review++;});run.addEventListener('click',()=>{clicks.run++;});
 await command.fire('keydown',{key:'Enter'});expect(clicks).toEqual({review:0,run:0});
 await command.fire('keydown',{key:'Enter',ctrlKey:true,isComposing:true});expect(clicks).toEqual({review:0,run:0});
 await command.fire('keydown',{key:'Enter',ctrlKey:true});expect(clicks).toEqual({review:1,run:0});// run is still disabled: review first
 run.disabled=false;await command.fire('keydown',{key:'Enter',metaKey:true});expect(clicks).toEqual({review:1,run:1});
 w.window.EchoPrimeEshDock.render(w.get('#workspace-esh-output'),[{outcome:'running'}]);expect(badge.textContent).toBe('Working…');expect(badge.classList.contains('working')).toBe(true);expect(badge.dataset.outcome).toBe('running');
 w.window.EchoPrimeEshDock.render(null,[{outcome:'gated'}]);expect(badge.textContent).toBe('Needs authorization');expect(badge.classList.contains('working')).toBe(false);
});
it('does not mount when the ESH panel is absent',()=>{
 const w=world(['esh-dock.js'],{strict:true});expect(w.window.EchoPrimeEshDock.mount()).toBe(false);expect(w.find('[data-esh-status]')).toBeUndefined();
});

// ---------- the shipped workspace.js with both modules ----------
function workspaceWorld(options:{request?:ReturnType<typeof vi.fn>;storage?:ReturnType<typeof storage>}={}){
 let identity!:(session:any)=>void;
 const chat={id:'shell-chat',title:'Shell chat',messages:[],events:[]} as any;
 const request=options.request??vi.fn(async(path:string)=>path==='/state'?{chats:[],projects:[],library:[],personalities:[],context_length:262144}:path==='/chats'||path==='/chats/shell-chat'?chat:path==='/action'?{ok:true,exit:0,stdout:'fixture location',audit_id:'aud-9'}:{});
 const session={workspaceConfigured:true,authenticated:true,ownerAccess:true,csrf:'owner',user:{uid:'owner',role:'owner',status:'approved'}};
 class Transport {session=session;constructor(o:any){identity=o.onIdentityChange;}loadSession=async()=>this.session;request=request;chat=async(input:any)=>({id:input.chat_id,messages:[]});text=async()=>'';audio=async()=>new Blob();headers=()=>({'x-echo-csrf':'owner'});clear(){identity(null);}auth=async()=>({google_login_enabled:false});}
 const w=world(['workspace.js','esh-dock.js','chat-actions.js','layout.js'],{body:primeShell,storage:options.storage,window:{EchoPrimeWorkspaceTransport:Transport,EchoPrimeChat:{reset:vi.fn()}}});
 w.get('#workspace-chat-kind').value='workspace';
 return {...w,request,change:()=>identity({...session,user:{uid:'member',role:'member',status:'approved'},ownerAccess:false})};
}
it('runs the ESH dock through workspace.js: Ctrl+Enter reviews, a second Ctrl+Enter dispatches once, receipts and badge follow, and the account change resets to Ready',async()=>{
 const w=workspaceWorld();await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.newChat();await w.get('#workspace-open-esh').fire('click');
 const badge=w.find('[data-esh-status]')!,command=w.get('#workspace-esh-command'),output=w.get('#workspace-esh-output');
 expect(badge.textContent).toBe('Ready');expect(output.textContent).toContain('Commands and receipts from this conversation appear here.');
 command.value='Get-Location';await command.fire('input');await command.fire('keydown',{key:'Enter',ctrlKey:true});
 expect(w.request.mock.calls.some(c=>c[0]==='/action')).toBe(false);expect(w.get('#workspace-esh-run').disabled).toBe(false);expect(w.get('#workspace-esh-reviewed').textContent).toBe('Get-Location');
 await command.fire('keydown',{key:'Enter',ctrlKey:true});
 const writes=w.request.mock.calls.filter(c=>c[0]==='/action');expect(writes).toHaveLength(1);expect(writes[0][1]).toMatchObject({action:'esh',command:'Get-Location',chat_id:'shell-chat'});
 expect(badge.textContent).toBe('Complete');expect(badge.dataset.outcome).toBe('returned');
 const text=walk(output).map(n=>n.textContent).join('|');expect(text).toContain('PS > Get-Location');expect(text).toContain('fixture location');expect(text).toContain('Receipt · aud-9');expect(text).toContain('You');
 await command.fire('keydown',{key:'Enter',ctrlKey:true});expect(w.request.mock.calls.filter(c=>c[0]==='/action')).toHaveLength(1);// the review was consumed: a third press only reviews again
 w.change();expect(badge.textContent).toBe('Ready');expect(w.get('#workspace-esh').hidden).toBe(true);expect(w.get('#workspace-esh-command').value).toBe('');
});
it('persists ESH geometry moved through workspace.js (grip, Float, corner) via layout.js without any command text',async()=>{
 const w=workspaceWorld();await w.window.EchoPrimeWorkspace.ready;await w.window.EchoPrimeWorkspace.newChat();await w.get('#workspace-open-esh').fire('click');
 w.get('#workspace-esh-command').value='Get-Location';
 await w.get('#workspace-esh-grip').fire('keydown',{key:'ArrowRight'});
 expect(saved(w)).toMatchObject({mode:'float',rect:{x:300,y:90,width:640,height:430}});expect(w.get('#workspace-esh-float').textContent).toBe('Dock');
 await w.get('#workspace-esh-resize').fire('keydown',{key:'ArrowDown'});expect(saved(w).rect).toEqual({x:300,y:90,width:640,height:450});
 await w.get('#workspace-esh-float').fire('click');expect(saved(w).mode).toBe('dock');expect(w.get('#workspace-esh-float').textContent).toBe('Float');
 const east=walk(w.get('#workspace-esh')).find(n=>n.dataset.edge==='e')!;await east.fire('keydown',{key:'ArrowRight'});
 expect(w.window.EchoPrimeWorkspace.bridge.eshLayout.get()).toEqual({rect:{x:300,y:90,width:660,height:450},floating:true});expect(w.get('#workspace-esh').styles['--esh-width']).toBe('660px');
 await w.button('Reset')!.click();expect(w.window.EchoPrimeWorkspace.bridge.eshLayout.get()).toEqual({rect:{x:280,y:90,width:640,height:430},floating:false});
 expect([...w.storage.map.values()].join('')).not.toContain('Get-Location');
 expect(w.window.EchoPrimeWorkspace.bridge.eshLayout.set({rect:{x:'bad',width:NaN},floating:'yes'})).toBeUndefined();expect(w.window.EchoPrimeWorkspace.bridge.eshLayout.get()).toEqual({rect:{x:280,y:90,width:640,height:430},floating:false});
});
it('restores a persisted floating rectangle into workspace.js before the panel opens',async()=>{
 const store=storage({[KEY]:JSON.stringify({version:1,mode:'float',rect:{x:100,y:120,width:520,height:360},sidebar:300})});
 const w=workspaceWorld({storage:store});await w.window.EchoPrimeWorkspace.ready;
 expect(w.window.EchoPrimeWorkspace.bridge.eshLayout.get()).toEqual({rect:{x:100,y:120,width:520,height:360},floating:true});
 await w.get('#workspace-open-esh').fire('click');expect(w.get('#workspace-esh').styles['--esh-x']).toBe('100px');expect(w.get('#workspace-esh-float').textContent).toBe('Dock');expect(w.body.styles['--sidebar-width']).toBe('300px');
});
it('ships the modules in index.html after workspace.js and in the server allowlist',()=>{
 const html=source('index.html');
 for(const file of ['esh-dock.js','chat-actions.js','layout.js'])expect(html.indexOf('<script src="'+file+'">')).toBeGreaterThan(html.indexOf('<script src="workspace.js">'));
 expect(html).toContain('id="conversation-subtitle"');
 const css=source('styles.css');for(const token of ['--sidebar-width','--dock-height','.sidebar-right','.panel-resizer-se','.esh-status','.tool-card','.thinking'])expect(css).toContain(token);
 // A floating ESH panel must keep its own x whichever side the navigation is on: every later (0,2,0) rule that
 // sets `left` on .workspace-esh needs this (0,3,0) counterpart after it.
 expect(css.match(/\.sidebar-right \.workspace-esh\.floating\{[^}]*\}/g)).toEqual(['.sidebar-right .workspace-esh.floating{left:var(--esh-x);right:auto}']);
 expect(css).not.toMatch(/\.sidebar-right \.workspace-esh\.floating\.[\w-]+\{/);// nothing more specific overrides it
});
