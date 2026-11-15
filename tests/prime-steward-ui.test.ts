import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../ui/echo-prime/steward.js',import.meta.url),'utf8');
function fixture(fetch:ReturnType<typeof vi.fn>){
 function element(){return {textContent:'',value:'',hidden:false,disabled:false,open:false,children:[] as ReturnType<typeof element>[],events:{} as Record<string,(e?:unknown)=>unknown>,append(...items:ReturnType<typeof element>[]){this.children.push(...items);},replaceChildren(...items:ReturnType<typeof element>[]){this.children=items;},addEventListener(name:string,fn:(e?:unknown)=>unknown){this.events[name]=fn;},showModal(){this.open=true;},close(){this.open=false;this.events.close?.();}};}
 const names=['open-steward','steward-dialog','close-steward','refresh-steward','steward-status','steward-nodes','steward-node','steward-mode','steward-text','steward-target','steward-target-label','steward-form','steward-submit','steward-result'];
 const nodes=Object.fromEntries(names.map(n=>[n,element()]));nodes['steward-mode'].value='answer';
 runInNewContext(source,{document:{querySelector:(s:string)=>nodes[s.slice(1)],createElement:element},fetch,AbortController,Error,JSON});
 return nodes;
}
const inventory=(complete=false)=>({state:'connected',inventoryComplete:complete,coverageComplete:false,coverage:{total:1,admitted:1,available:1},nodes:[{id:'fixture-node',os:'linux',identityVerified:true,admitted:true,advisoryAvailable:true,runtime:{state:'shadow',model:'fixture-model',current:true},evaluation:{verdict:'FAIL'},canary:'UNKNOWN',rollbackReady:false}]});
it('shows incomplete fleet coverage and renders model output as text without storing it',async()=>{
 const payload='<img src=x onerror=alert(1)>';
 const fetch=vi.fn(async(path:string)=>({ok:true,json:async()=>path.endsWith('status')?inventory():{text:payload,executionAuthorized:false}}));
 const n=fixture(fetch);await n['open-steward'].events.click();
 expect(n['steward-status'].textContent).toContain('incomplete');expect(n['steward-submit'].disabled).toBe(false);
 n['steward-text'].value='Explain fixture';await n['steward-form'].events.submit({preventDefault(){}});
 expect(n['steward-result'].textContent).toContain(payload);
 expect(fetch.mock.calls[1][0]).toBe('/api/steward/ask');
 expect(JSON.parse((fetch.mock.calls[1] as unknown as [string,{body:string}])[1].body)).toEqual({node:'fixture-node',mode:'answer',text:'Explain fixture'});
});
it('does not submit when no node is verified and clears previous output on refresh failure',async()=>{
 let available=true;
 const fetch=vi.fn(async()=>({ok:available,json:async()=>available?inventory():{error:'Owner unavailable'}}));
 const n=fixture(fetch);await n['open-steward'].events.click();n['steward-result'].textContent='old node result';available=false;
 await n['refresh-steward'].events.click();expect(n['steward-result'].textContent).toBe('');expect(n['steward-submit'].disabled).toBe(true);
 await n['steward-form'].events.submit({preventDefault(){}});expect(fetch).toHaveBeenCalledTimes(2);
});
it('discards late advisory output when the panel is closed',async()=>{
 let finish!:(v:unknown)=>void;
 const fetch=vi.fn(async(path:string)=>path.endsWith('status')?{ok:true,json:async()=>inventory(true)}:new Promise(resolve=>{finish=resolve;}));
 const n=fixture(fetch);await n['open-steward'].events.click();n['steward-text'].value='Explain fixture';
 const pending=n['steward-form'].events.submit({preventDefault(){}});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 n['steward-dialog'].close();finish({ok:true,json:async()=>({text:'Late old-node response'})});await pending;
 expect(n['steward-result'].textContent).not.toContain('Late old-node response');
});
