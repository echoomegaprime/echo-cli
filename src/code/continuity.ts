import type { SessionStore, Session } from './sessions.js';
import { hash, redact } from './workspace.js';
import type { Workspace } from './workspace.js';
import {debuglog} from 'node:util';

export interface CapturePayload { kind: 'artifact'; title: string; detail: string; requestId: string }
export interface CaptureReceipt {
  id: string; eventId: string; kind: 'artifact'; requestId: string;
  saved: true; verified: true; duplicate: boolean; contentSha256: string;
}
export interface MemoryCheckpoint {
  version: 1; payload: CapturePayload; contentSha256: string;
  state: 'prepared' | 'blocked' | 'uncertain' | 'saved' | 'verified' | 'conflict';
  reason?: 'host_broker_not_attached' | 'write_scope_missing' | 'read_scope_missing' |
    'capture_transport_unavailable' | 'capture_receipt_invalid' | 'request_id_conflict' |
    'capture_outcome_unknown' | 'recall_transport_unavailable' | 'recall_not_matched';
  receipt?: CaptureReceipt;
}
export type ContinuityInvoker = (request: {
  capability: 'echo.continuity.capture' | 'echo.continuity.recall' | 'echo.continuity.prepare';
  params: CapturePayload | PrimeCapturePayload | { query: string } | {message:string;maxChars:number}; idempotencyKey?: string;
  reason: string; signal: AbortSignal;
}) => Promise<unknown>;

export type PrimeCaptureKind='decision'|'task'|'lesson'|'correction'|'note';
export interface PrimeCapturePayload {kind:Exclude<PrimeCaptureKind,'correction'>;title:string;detail:string;requestId:string;projectId?:string}
export interface PrimeCaptureResult {state:'verified'|'unavailable'|'uncertain';saved:boolean;message:string;receipt?:Omit<CaptureReceipt,'kind'>&{kind:PrimeCapturePayload['kind']}}
const debugContinuity=debuglog('echo-prime-continuity');

const hasControl = (text: string) => [...text].some(char => {
  const code = char.charCodeAt(0); return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
});
const contentOf = (payload: CapturePayload) => `${payload.title}\n${payload.detail}`.trim();
function payloadFor(sessionId: string, title: string, detail: string): CapturePayload {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
      typeof detail !== 'string' || detail.length > 20000 ||
      hasControl(title + detail)) throw new Error('Invalid checkpoint title or detail');
  title = title.trim(); detail = detail.trim();
  if (redact(title) !== title || redact(detail) !== detail) throw new Error('Secret-like checkpoint content refused');
  const digest = hash(JSON.stringify({ kind: 'artifact', title, detail }));
  return { kind: 'artifact', title, detail, requestId: `echo-code:${sessionId}:${digest}` };
}
function checkpoints(session: Session): MemoryCheckpoint[] {
  const items = session.checkpoints ?? [];
  if (!Array.isArray(items) || items.length > 20) throw new Error('Checkpoint integrity invalid');
  for (const item of items) {
    if (!item || item.version !== 1 || !item.payload || item.payload.kind !== 'artifact') throw new Error('Checkpoint integrity invalid');
    const expected = payloadFor(session.id, item.payload.title, item.payload.detail);
    if (JSON.stringify(item.payload) !== JSON.stringify(expected) || item.contentSha256 !== hash(contentOf(expected)) ||
        !['prepared', 'blocked', 'uncertain', 'saved', 'verified', 'conflict'].includes(item.state)) throw new Error('Checkpoint integrity invalid');
    if (item.receipt && !validReceipt(item.receipt, item)) throw new Error('Checkpoint receipt integrity invalid');
    if (['saved', 'verified'].includes(item.state) && !item.receipt) throw new Error('Checkpoint receipt missing');
  }
  return items;
}
function sessionFor(store: SessionStore, workspace: Workspace, id: string) {
  const session = store.get(id);
  if (session.workspace !== workspace.root) throw new Error('Session workspace mismatch');
  return session;
}
export function listCheckpoints(store: SessionStore, workspace: Workspace, sessionId: string): MemoryCheckpoint[] {
  return checkpoints(sessionFor(store, workspace, sessionId));
}
/** Explicit caller-supplied summary only. Never copy source, paths or transcripts automatically. */
export function prepareCheckpoint(store: SessionStore, workspace: Workspace, sessionId: string, title: string, detail: string): MemoryCheckpoint {
  const payload = payloadFor(sessionId, title, detail), release = store.lease(sessionId);
  try {
    const session = sessionFor(store, workspace, sessionId), items = checkpoints(session);
    const existing = items.find(item => item.payload.requestId === payload.requestId);
    if (existing) return existing;
    if (items.length >= 20) throw new Error('Checkpoint limit reached');
    const item: MemoryCheckpoint = { version: 1, payload, contentSha256: hash(contentOf(payload)), state: 'prepared' };
    session.checkpoints = [...items, item]; store.save(session); return item;
  } finally { release(); }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function response(value: unknown) {
  let root=record(value),error=false;
  for(let i=0;i<4;i++){
    error ||= root.isError===true||root.ok===false;
    if(root.structuredContent){root=record(root.structuredContent);continue;}
    if(Array.isArray(root.content)){
      const text=record(root.content.find(b=>record(b).type==='text')).text;
      if(typeof text!=='string'||Buffer.byteLength(text)>1048576){root={};break;}
      try{root=record(JSON.parse(text));continue;}catch{root={};break;}
    }
    break;
  }
  if(error)root={...root,ok:false};
  const sdk = record(root.sdk_result), result = record(sdk.result);
  let body=record(result.body);
  if(typeof result.body==='string'&&Buffer.byteLength(result.body)<=1048576){try{body=record(JSON.parse(result.body));}catch{body={};}}
  return { root, sdk, result, body, data: record(body.result) };
}
function ownerData(value: unknown): Record<string, unknown> | undefined {
  const r = response(value);
  if (r.root.ok !== true || r.sdk.status !== 'ok' || r.result.status_code !== 200 ||
      r.body.ok !== true || r.body.service !== 'echo-continuity-fabric-mcp') return;
  return r.data;
}
function denied(value: unknown) {
  const r = response(value);
  return r.root.error === 'scope_forbidden' || r.sdk.error === 'scope_forbidden' ||
    r.result.status_code === 401 || r.result.status_code === 403 ||
    ['scope_forbidden', 'insufficient_scope', 'operator_required'].includes(String(r.body.error));
}
function conflicting(value: unknown) {
  const r = response(value);
  return r.root.error === 'request_id_conflict' || r.result.status_code === 409 || r.body.error === 'request_id_conflict';
}
function validReceipt(value: unknown, checkpoint: MemoryCheckpoint): value is CaptureReceipt {
  const r = record(value), id = /^[a-zA-Z0-9_-]{1,100}$/;
  return typeof r.id === 'string' && id.test(r.id) && typeof r.eventId === 'string' && id.test(r.eventId) &&
    r.kind === 'artifact' && r.requestId === checkpoint.payload.requestId && r.saved === true &&
    r.verified === true && typeof r.duplicate === 'boolean' && r.contentSha256 === checkpoint.contentSha256;
}
function receiptFields(receipt: CaptureReceipt): CaptureReceipt {
  return { id: receipt.id, eventId: receipt.eventId, kind: receipt.kind, requestId: receipt.requestId,
    saved: true, verified: true, duplicate: receipt.duplicate, contentSha256: receipt.contentSha256 };
}
function recallMatches(value: unknown, checkpoint: MemoryCheckpoint): boolean {
  const data = ownerData(value), receipt = checkpoint.receipt;
  if (!data || !receipt || !Array.isArray(data.events) || data.events.length > 20) return false;
  const expected = contentOf(checkpoint.payload);
  return data.events.some(value => {
    const event = record(value);
    if (event.id !== receipt.eventId || event.event_type !== 'ARTIFACT_REGISTERED' ||
        event.content_sha256 !== checkpoint.contentSha256) return false;
    return event.content_text === expected || (expected.length > 1200 && event.excerpt_truncated === true &&
      event.content_text === expected.slice(0, 1199) + '\u2026');
  });
}
/** Bounds local waiting; abort is best effort. A late remote write remains uncertain and
 * must be retried with this same durable request ID through the same authorized owner. */
async function boundedInvoke(invoke: ContinuityInvoker, request: Omit<Parameters<ContinuityInvoker>[0], 'signal'>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke({ ...request, signal: controller.signal })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Owner timeout')); }, 15000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
/** Existing host broker only. No credentials, scopes, alternate transport or automatic retry.
 * Receipt verification confirms persisted bytes, never the truth of captured assertions. */
export async function syncCheckpoint(store: SessionStore, workspace: Workspace, sessionId: string, requestId: string, invoke?: ContinuityInvoker): Promise<MemoryCheckpoint> {
  const release = store.lease(sessionId);
  try {
    const session = sessionFor(store, workspace, sessionId);
    const item = checkpoints(session).find(c => c.payload.requestId === requestId);
    if (!item) throw new Error('Checkpoint not found');
    if (item.state === 'verified' || item.state === 'conflict') return item;
    const save = (state: MemoryCheckpoint['state'], reason?: MemoryCheckpoint['reason']) => {
      item.state = state; if (reason) item.reason = reason; else delete item.reason;
      store.save(session); return item;
    };
    if (!invoke) return save(item.receipt ? 'saved' : item.state === 'uncertain' ? 'uncertain' : 'blocked', 'host_broker_not_attached');
    if (!item.receipt) {
      // Persist before the call: process death or a lost reply cannot erase request identity.
      save('uncertain', 'capture_outcome_unknown');
      let reply: unknown;
      try {
        reply = await boundedInvoke(invoke, { capability: 'echo.continuity.capture',
          params: structuredClone(item.payload), idempotencyKey: item.payload.requestId,
          reason: 'Save the explicitly prepared ECHO Code checkpoint through the existing authorized Fabric owner.' });
      } catch { return save('uncertain', 'capture_transport_unavailable'); }
      if (denied(reply)) return save('blocked', 'write_scope_missing');
      if (conflicting(reply)) return save('conflict', 'request_id_conflict');
      const receipt = ownerData(reply);
      if (!validReceipt(receipt, item)) return save('uncertain', 'capture_receipt_invalid');
      item.receipt = receiptFields(receipt); save('saved');
    }
    let recall: unknown;
    try {
      recall = await boundedInvoke(invoke, { capability: 'echo.continuity.recall',
        params: { query: item.receipt.eventId },
        reason: 'Verify the saved ECHO Code checkpoint by exact event identity and content hash.' });
    } catch { return save('saved', 'recall_transport_unavailable'); }
    if (denied(recall)) return save('saved', 'read_scope_missing');
    return recallMatches(recall, item) ? save('verified') : save('saved', 'recall_not_matched');
  } finally { release(); }
}

/** Prime's bounded client uses only the same host invoker as explicit checkpoints.
 * Captured assertions remain model text. Verification proves storage, not truth. */
export class ContinuityClient {
 constructor(private invoke?:ContinuityInvoker){}
 private async call(capability:Parameters<ContinuityInvoker>[0]['capability'],params:Parameters<ContinuityInvoker>[0]['params'],signal?:AbortSignal,idempotencyKey?:string){
  if(!this.invoke)throw new Error('Existing continuity host broker is not attached');
  if(signal?.aborted)throw new Error('Interrupted');
  const invoke=this.invoke;
  const reply=await boundedInvoke(request=>invoke({...request,signal:signal?AbortSignal.any([signal,request.signal]):request.signal}),{
   capability,params,idempotencyKey,reason:'Prime bounded continuity through the existing host authority; no scope expansion.'});
  if(signal?.aborted)throw new Error('Interrupted; continuity outcome unknown');
  if(Buffer.byteLength(JSON.stringify(reply))>1048576)throw new Error('Continuity response exceeds limit');
  if(denied(reply))throw new Error('Existing continuity broker scope denied');
  const data=ownerData(reply);if(!data)throw new Error('Continuity owner response not verified');return data;
 }
 async prepare(message:string,signal?:AbortSignal){
  if(typeof message!=='string'||!message.trim()||message.length>12000)throw new Error('Invalid continuity message');
  const data=await this.call('echo.continuity.prepare',{message:redact(message),maxChars:4000},signal);
  if(data.ready!==true||typeof data.context!=='string')throw new Error('Continuity prepare unavailable');
  debugContinuity('%j',{event:'ecf_prepare',chars:Math.min(data.context.length,4000),ambiguous:data.ambiguous===true});
  return {context:redact(data.context).slice(0,4000),ambiguous:data.ambiguous===true,untrusted:true};
 }
 async recall(query:string,signal?:AbortSignal){
  if(typeof query!=='string'||!query.trim()||query.length>500||redact(query)!==query)throw new Error('Invalid continuity query');
  const data=await this.call('echo.continuity.recall',{query},signal);
  const text=redact(JSON.stringify(data));
  debugContinuity('%j',{event:'ecf_recall',chars:Math.min(text.length,8000)});
  return {untrusted:true,context:text.slice(0,8000),truncated:text.length>8000};
 }
 async capture(kind:PrimeCaptureKind,content:string,sessionId:string,project?:string,signal?:AbortSignal):Promise<PrimeCaptureResult>{
  if(!['decision','task','lesson','correction','note'].includes(kind)||typeof content!=='string'||!content.trim()||content.length>4000||hasControl(content)||redact(content)!==content)throw new Error('Invalid or secret-like continuity content');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)||(project!==undefined&&!/^[A-Za-z0-9_-]{1,120}$/.test(project)))throw new Error('Invalid continuity session or project');
  // ECF has no native correction kind. Keep that intent explicit in the note title.
  const nativeKind=kind==='correction'?'note':kind,title='Prime '+kind,detail=content.trim();
  const requestId='prime:'+sessionId+':'+hash(JSON.stringify({kind:nativeKind,title,detail,project}));
  const payload:PrimeCapturePayload={kind:nativeKind,title,detail,requestId,...(project?{projectId:project}:{})};
  const expected=title+'\n'+detail,contentSha256=hash(expected);
  const fail=(state:'unavailable'|'uncertain',message:string):PrimeCaptureResult=>{
   debugContinuity('%j',{event:'ecf_capture',state,kind});return {state,saved:false,message};
  };
  if(!this.invoke)return fail('unavailable','ECF capture unavailable: existing host broker is not attached. Nothing was saved.');
  let receipt:Record<string,unknown>;
  try{receipt=await this.call('echo.continuity.capture',payload,signal,requestId);}
  catch{return fail('uncertain','ECF capture unavailable or unconfirmed. No verified save; do not replay with a new request ID.');}
  const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
  if(!validId(receipt.id)||!validId(receipt.eventId)||receipt.kind!==nativeKind||receipt.requestId!==requestId||receipt.saved!==true||receipt.verified!==true||typeof receipt.duplicate!=='boolean'||receipt.contentSha256!==contentSha256)
   return fail('uncertain','ECF capture returned an invalid receipt. Saved state is unverified.');
  let recall:Record<string,unknown>;
  try{recall=await this.call('echo.continuity.recall',{query:receipt.eventId},signal);}
  catch{return fail('uncertain','ECF capture returned, but receipt read-back is unavailable. Saved state is unverified.');}
  const match=Array.isArray(recall.events)&&recall.events.length<=20&&recall.events.some(value=>{
   const event=record(value);return event.id===receipt.eventId&&event.content_sha256===contentSha256&&
    (event.content_text===expected||(expected.length>1200&&event.excerpt_truncated===true&&event.content_text===expected.slice(0,1199)+'\u2026'));
  });
  if(!match)return fail('uncertain','ECF receipt read-back did not match the exact event and content hash. Saved state is unverified.');
  const verified={id:receipt.id,eventId:receipt.eventId,kind:nativeKind,requestId,saved:true as const,verified:true as const,duplicate:receipt.duplicate,contentSha256};
  debugContinuity('%j',{event:'ecf_capture',state:'verified',kind,receiptId:receipt.id});
  return {state:'verified',saved:true,receipt:verified,message:'Saved to ECF; receipt '+receipt.id+' read back and verified.'};
 }
}
