(() => {
 'use strict';
 // Activity cards and the streaming "thinking" panel, ported from the private
 // Workspace (app.js activityCard / send). Saved tool_result, action_receipt and
 // preference_saved events are interleaved with messages by their saved time;
 // while a turn streams, status and tool events collect under one panel and
 // each tool_result becomes a card above it. Pure DOM: no fetch, no storage.
 const activityKinds=new Set(['tool_result','action_receipt','preference_saved']);
 function el(tag,attributes={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attributes)){if(key==='class')node.className=value;else if(value!==false&&value!==undefined)node.setAttribute(key,String(value));}
  for(const child of children.flat(Infinity)){if(child!==null&&child!==undefined)node.append(typeof child==='string'?document.createTextNode(child):child);}
  return node;
 }
 const bound=(value,max=600)=>String(value??'').slice(0,max);
 const asText=value=>typeof value==='string'?value:value===undefined||value===null?'':JSON.stringify(value,null,2);
 function activityModel(event){
  const kind=typeof event?.kind==='string'?event.kind:typeof event?.type==='string'?event.type:'';
  let data;
  if(typeof event?.content==='string'){try{data=JSON.parse(event.content);}catch{data={detail:event.content};}}
  else data=event;
  if(!data||typeof data!=='object'||Array.isArray(data))data={detail:asText(data)};
  const preference=kind==='preference_saved';
  const label=preference?'Memory saved':bound(data.tool||data.action||data.request?.action||'Plugin action',100);
  const result=data.result!==undefined?data.result:data;
  const failed=result?.ok===false||!!result?.error;
  return {kind,preference,label,failed,marker:preference?'◈':'⌘',status:failed?' · needs attention':' · recorded',
   body:preference?bound(data.content??data.detail??'',4000):result,
   note:preference?'Available in future chats. ECF delivery is tracked separately.':'Actual tool response. A submitted action is verified only when its receipt confirms the result.'};
 }
 function activityCard(event){
  const m=activityModel(event);
  const body=m.preference?el('p',{},m.body):el('pre',{class:'workspace-receipt'},asText(m.body).slice(0,90000));
  return el('details',{class:'tool-card'+(m.failed?' failed':''),'data-activity':m.kind||'activity'},
   el('summary',{},el('span',{class:'pill '+(m.failed?'pending':'good'),'aria-hidden':'true'},m.marker),' '+m.label,el('small',{},m.status)),body,el('small',{class:'muted'},m.note));
 }
 // Messages and activity events in saved order. Items without a saved time keep
 // their relative position: messages first, events after.
 function timeline(chat){
  const items=[];let order=0;
  for(const message of chat?.messages||[])if(message&&['user','assistant'].includes(message.role))items.push({kind:'message',message,key:typeof message.created==='string'?message.created:'',order:order++});
  for(const event of chat?.events||[])if(event&&activityKinds.has(event.kind))items.push({kind:'event',event,key:typeof event.created==='string'&&event.created?event.created:'￿',order:order++});
  return items.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:a.order-b.order);
 }
 function thinkingPanel(){
  const text=el('span',{class:'thinking-text',role:'status'},'Echo is thinking…'),steps=el('ol',{class:'activity-steps'});
  const node=el('details',{class:'thinking','data-thinking':''},el('summary',{},el('span',{class:'thinking-spinner','aria-hidden':'true'}),text,el('small',{},' · View activity')),steps);
  const add=item=>{steps.append(item);if(steps.children.length>200)steps.children[0]?.remove?.();};
  return {node,
   status(value){text.textContent=bound(value)||'Echo is thinking…';},
   step(value){add(el('li',{},bound(value)));},
   tool(tool,args){add(el('li',{},el('details',{},el('summary',{},bound(tool||'tool',100)+' · started'),el('pre',{class:'workspace-receipt'},asText(args).slice(0,2000)))));},
   remove(){node.remove?.();}};
 }
 window.EchoPrimeChatActions={activityKinds,activityModel,activityCard,timeline,thinkingPanel};
})();
