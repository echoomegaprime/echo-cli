/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic DOM and bridge stand-ins mirror prime-views-ui.test.ts */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';

const camel = (key: string) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class Node {
 tagName: string;
 _text = '';
 className = '';
 hidden = false;
 disabled = false;
 checked = false;
 open = false;
 value = '';
 max = 0;
 isConnected = true;
 focused = false;
 dataset: Record<string, string> = {};
 attributes: Record<string, string> = {};
 children: Node[] = [];
 inserted: Node[] = [];
 parent: Node | null = null;
 events: Record<string, ((event: any) => unknown)[]> = {};
 files: any[] = [];
 style = { setProperty: vi.fn() };
 constructor(tag = 'div') {
  this.tagName = tag.toUpperCase();
 }
 get textContent(): string {
  return this._text + this.children.map(c => c.textContent).join('');
 }
 set textContent(val: string) {
  this._text = String(val);
  this.children = [];
 }
 append(...items: Node[]) {
  for (const item of items) {
   item.parent = this;
   item.isConnected = true;
   this.children.push(item);
  }
 }
 prepend(...items: Node[]) {
  for (const item of items) {
   item.parent = this;
   item.isConnected = true;
  }
  this.children = [...items, ...this.children];
 }
 replaceChildren(...items: Node[]) {
  for (const child of this.children) child.isConnected = false;
  this.children = [];
  this._text = '';
  this.append(...items);
 }
 after(...items: Node[]) {
  this.inserted.push(...items);
 }
 before(...items: Node[]) {
  this.inserted.push(...items);
 }
 setAttribute(key: string, val: string) {
  this.attributes[key] = val;
  if (key === 'value') this.value = val;
  if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = val;
 }
 getAttribute(key: string) {
  return this.attributes[key] ?? null;
 }
 addEventListener(name: string, cb: (event: any) => unknown) {
  (this.events[name] ??= []).push(cb);
 }
 async fire(name: string, event: any = {}) {
  for (const fn of this.events[name] || []) {
   await fn({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
  }
 }
 dispatchEvent(event: any) {
  void this.fire(event.type, event);
  return true;
 }
 showModal() {
  this.open = true;
 }
 close() {
  if (!this.open) return;
  this.open = false;
  void this.fire('close');
 }
 focus() {
  this.focused = true;
 }
 scrollIntoView() {}
 click() {
  return this.fire('click');
 }
 getBoundingClientRect() {
  return { left: 0, right: 200, top: 0, bottom: 200 };
 }
}

const walk = (root: Node): Node[] => [...root.children, ...root.inserted].flatMap(c => [c, ...walk(c)]);
const source = (name: string) => readFileSync(new URL('../ui/echo-prime/' + name, import.meta.url), 'utf8');
const tick = async () => {
 for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
};

const UPL_IMG = 'upl_' + '1'.repeat(32);
const UPL_VID = 'upl_' + '2'.repeat(32);
const UPL_AUD = 'upl_' + '3'.repeat(32);
const UPL_PDF = 'upl_' + '4'.repeat(32);
const UPL_TXT = 'upl_' + '5'.repeat(32);
const ART_STUDIO = 'art_' + 'a'.repeat(32);
const ART_ADK = 'art_' + 'b'.repeat(32);

function sampleUploads() {
 return [
  { id: UPL_IMG, name: 'hero.png', type: 'image/png', bytes: 20480, sha256: 'sha-img', created_at: '2026-11-04T20:05:00Z', owner: 'owner', kind: 'image', width: 1024, height: 768, thumb: true, exif_gps_stripped: true, tags: ['character', 'concept'] },
  { id: UPL_VID, name: 'clip.mp4', type: 'video/mp4', bytes: 512000, sha256: 'sha-vid', created_at: '2026-11-04T20:04:00Z', owner: 'owner', kind: 'video', duration: 6.5, tags: ['b-roll'] },
  { id: UPL_AUD, name: 'theme.wav', type: 'audio/wav', bytes: 64000, sha256: 'sha-aud', created_at: '2026-11-04T20:03:00Z', owner: 'owner', kind: 'audio', duration: 4 },
  { id: UPL_PDF, name: 'spec.pdf', type: 'application/pdf', bytes: 48000, sha256: 'sha-pdf', created_at: '2026-11-04T20:02:00Z', owner: 'owner', kind: 'document', pages: 5, tags: ['spec'] },
  { id: UPL_TXT, name: 'readme.md', type: 'text/markdown', bytes: 120, sha256: 'sha-txt', created_at: '2026-11-04T20:01:00Z', owner: 'owner', kind: 'document', tags: ['docs'] },
 ];
}

function sampleArtifacts() {
 return [
  {
   id: ART_STUDIO,
   title: 'media.image_generate · Solar Citadel',
   kind: 'image',
   type: 'image/png',
   bytes: 20480,
   created_at: '2026-11-04T20:10:00Z',
   owner: 'owner',
   upload_id: UPL_IMG,
   tags: ['citadel'],
   provenance: {
    source: 'studio',
    prompt: 'Solar Citadel at dawn',
    model: 'flux-1-dev',
    capability: 'echo.media.image_generate',
    run_id: 'job_solar_1',
    inputs: [{ upload_id: UPL_IMG, role: 'reference' }],
   },
  },
  {
   id: ART_ADK,
   title: 'ADK · verifier · run_99',
   kind: 'proof',
   type: 'application/json',
   bytes: 950,
   created_at: '2026-11-04T20:09:00Z',
   owner: 'owner',
   tags: ['verified'],
   provenance: {
    source: 'adk',
    agent: 'verifier',
    prompt: 'Audit prime parity routes',
    run_id: 'run_99',
    verdict: 'PASS',
    events_sha256: 'e3b0c44298fc1c149afbf4c8996fb924',
   },
  },
 ];
}

function makeFakeBridge() {
 const state: any = {
  data: {
   context_length: 262144,
   base_context_chars: 600,
   library: [{ id: 'ws_1', name: 'architecture-note.md', path: 'notes/architecture-note.md', chat_id: 'c1' }],
   projects: [],
   personalities: [{ id: 'auto', name: 'Auto' }],
   voice: { configured: false },
  },
  chat: {
   id: 'c1',
   title: 'Prime Parity Chat',
   project_id: null,
   messages: [{ id: 'm1', role: 'user', content: 'Design the artifact center' }, { id: 'm2', role: 'assistant', content: 'Ready.' }],
   events: [],
  },
  attachments: new Set<string>(),
  accountEpoch: 0,
  epoch: 0,
 };
 const session = { workspaceConfigured: true, authenticated: true, ownerAccess: true, csrf: 'csrf-tok-1', user: { uid: 'owner', role: 'owner', status: 'approved' } };
 return {
  state,
  voiceOptions: { conversation: false },
  session,
  api: vi.fn(async (path: string) => (path.startsWith('/library/') ? { id: 'ws_1', name: 'architecture-note.md', path: 'notes/architecture-note.md', content: '# Workspace Note' } : {})),
  refresh: vi.fn(async () => {}),
  openChat: vi.fn(async () => {}),
  updateContext: vi.fn(() => {}),
  onStatus: vi.fn(),
  normalizeImport: vi.fn((raw: string, title: string) => ({ title: title || 'Imported', messages: [{ role: 'user', content: raw }] })),
 };
}

function buildLibraryWorld(scripts = ['library.js'], opts: { uploads?: any[]; artifacts?: any[]; bridge?: any; enabled?: boolean; catalog?: any } = {}) {
 let uploads = [...(opts.uploads ?? sampleUploads())];
 let artifacts = [...(opts.artifacts ?? sampleArtifacts())];
 const bridge = opts.bridge ?? makeFakeBridge();
 const nodes = new Map<string, Node>();
 const events: Record<string, ((e: any) => unknown)[]> = {};
 const body = new Node('body');
 const get = (selector: string) => {
  if (!nodes.has(selector)) {
   const tag = selector === '#prompt' || selector === '#creative-prompt' || selector === '#creative-arguments' ? 'textarea' : selector === '#creative-category' ? 'select' : selector.endsWith('-dialog') ? 'dialog' : 'div';
   nodes.set(selector, new Node(tag));
  }
  return nodes.get(selector)!;
 };

 const fetchMock = vi.fn(async (url: string, init?: any) => {
  const u = new URL(url, 'http://127.0.0.1:8767');
  const p = u.pathname;
  const method = init?.method || 'GET';
  const jsonResp = (status: number, data: unknown) => ({
   ok: status >= 200 && status < 300,
   status,
   headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
   json: async () => data,
   text: async () => JSON.stringify(data),
  });

  if (p === '/api/prime/uploads/list' && method === 'GET') {
   return jsonResp(200, { configured: true, maxBytes: 200 * 1024 * 1024, types: ['image/png', 'video/mp4', 'application/pdf', 'text/markdown'], uploads });
  }
  if (p === '/api/prime/uploads' && method === 'POST') {
   const created = {
    id: 'upl_' + '9'.repeat(32),
    name: decodeURIComponent(init?.headers?.['X-Upload-Filename'] || 'uploaded.png'),
    type: init?.headers?.['Content-Type'] || 'image/png',
    bytes: 4096,
    sha256: 'sha-new',
    created_at: '2026-11-04T21:00:00Z',
    owner: 'owner',
    kind: 'image',
    width: 512,
    height: 512,
    thumb: true,
    tags: init?.headers?.['X-Upload-Tags'] ? decodeURIComponent(init.headers['X-Upload-Tags']).split(',').map((s: string) => s.trim()) : [],
   };
   uploads = [created, ...uploads];
   return jsonResp(201, created);
  }
  const updMatch = /^\/api\/prime\/uploads\/([^/]+)\/update$/.exec(p);
  if (updMatch && method === 'POST') {
   const patch = JSON.parse(init.body);
   const found = uploads.find(x => x.id === updMatch[1]);
   if (!found) return jsonResp(404, { error: 'Not found' });
   if (patch.name) found.name = patch.name;
   if (patch.tags) found.tags = patch.tags;
   return jsonResp(200, { ...found });
  }
  const delMatch = /^\/api\/prime\/uploads\/([^/]+)\/delete$/.exec(p);
  if (delMatch && method === 'POST') {
   uploads = uploads.filter(x => x.id !== delMatch[1]);
   return jsonResp(200, { id: delMatch[1], deleted: true });
  }
  const fileMatch = /^\/api\/prime\/uploads\/([^/]+)\/file$/.exec(p);
  if (fileMatch && method === 'GET') {
   return {
    ok: true,
    status: 206,
    headers: { get: () => 'text/markdown; charset=utf-8' },
    text: async () => '# Preview Markdown Content\nReady for inspection.',
   };
  }
  if (p === '/api/prime/artifacts' && method === 'GET') {
   return jsonResp(200, { configured: true, artifacts });
  }
  if (p === '/api/prime/artifacts' && method === 'POST') {
   const payload = JSON.parse(init.body);
   const rec = {
    id: 'art_' + String(artifacts.length + 1).padStart(32, '0'),
    title: payload.title,
    kind: payload.kind || 'other',
    type: payload.type || 'application/json',
    bytes: 256,
    created_at: '2026-11-04T21:05:00Z',
    owner: 'owner',
    tags: payload.tags || [],
    provenance: payload.provenance,
   };
   artifacts = [rec, ...artifacts];
   return jsonResp(201, rec);
  }
  const artOne = /^\/api\/prime\/artifacts\/([^/]+)$/.exec(p);
  if (artOne && method === 'GET') {
   const found = artifacts.find(a => a.id === artOne[1]);
   return found ? jsonResp(200, { ...found, content: '{"proof":"verified"}' }) : jsonResp(404, { error: 'Not found' });
  }
  const artDel = /^\/api\/prime\/artifacts\/([^/]+)\/delete$/.exec(p);
  if (artDel && method === 'POST') {
   artifacts = artifacts.filter(a => a.id !== artDel[1]);
   return jsonResp(200, { id: artDel[1], deleted: true });
  }
  if (p === '/api/prepare' && method === 'POST') {
   const reqBody = JSON.parse(init.body);
   return jsonResp(200, { id: 'tkt_1', digest: 'dig_1', requestId: 'req_1', cost: 'Governed', scope: 'media.write', request: reqBody });
  }
  if (p === '/api/execute' && method === 'POST') {
   // Prime stores the generated file and registers its artifact server-side (media-jobs.ts); the Studio renders it.
   return jsonResp(200, { state: 'returned', requestId: 'req_1', capability: 'echo.media.image_generate', kind: 'image', untrusted: true, result: { ok: true, job_id: 'j7', status: 'done', model: 'flux-pro' },
    job: { phase: 'done', label: 'On-prem media router', elapsedMs: 4200, followable: true, polls: 1 },
    media: { uploadId: 'upl_' + 'f'.repeat(32), artifactId: 'art_' + 'f'.repeat(32), url: '/api/prime/uploads/upl_' + 'f'.repeat(32) + '/file', type: 'image/png', kind: 'image', bytes: 2048, name: 'media.image_generate-req_1.png' } });
  }
  return jsonResp(404, { error: 'Unhandled ' + p });
 });

 const studioStub = { open: vi.fn() };
 const window: any = {
  addEventListener: (name: string, fn: (e: any) => unknown) => (events[name] ??= []).push(fn),
  dispatchEvent: (event: any) => {
   for (const fn of events[event.type] || []) fn(event);
  },
  EchoPrimeCatalog: opts.catalog ?? {
   capabilities: [
    { id: 'echo.media.image_generate', category: 'image', description: 'Generate image', health: 'green', scope: 'media.write' },
    { id: 'echo.media.video_generate', category: 'video', description: 'Generate video', health: 'green', scope: 'media.write' },
   ],
   models: [],
  },
  EchoPrimeStudio: studioStub,
  EchoPrimeWorkspace: {
   ready: Promise.resolve(opts.enabled ?? true),
   get enabled() {
    return opts.enabled ?? true;
   },
   get session() {
    return bridge.session;
   },
   bridge,
   ownerHeaders: async () => ({ 'x-echo-csrf': bridge.session?.csrf || 'owner' }),
   invalidate: vi.fn(),
  },
 };
 bridge.updateContext = vi.fn(() => window.dispatchEvent(new Event('echo-workspace-context')));

 const document: any = {
  body,
  head: new Node('head'),
  hidden: false,
  querySelector: get,
  querySelectorAll: () => [],
  createElement: (t: string) => new Node(t),
  createTextNode: (t: string) => Object.assign(new Node('#text'), { _text: t }),
  addEventListener() {},
 };

 const context = {
  window,
  document,
  fetch: fetchMock,
  location: { protocol: 'http:' },
  navigator: { clipboard: { writeText: vi.fn() } },
  crypto: { randomUUID },
  AbortController,
  AbortSignal,
  TextEncoder,
  TextDecoder,
  Event,
  Blob,
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  setTimeout,
  clearTimeout,
  console: { debug: vi.fn() },
  Error,
  Number,
  Math,
  JSON,
  Set,
  Map,
  Array,
  Object,
  String,
  Promise,
  Boolean,
 };

 for (const s of scripts) runInNewContext(source(s), context);

 const all = () => [body, ...nodes.values()].flatMap(n => [n, ...walk(n)]);
 const dialog = () => body.children.find(n => n.attributes.id === 'library-dialog')!;
 const previewDialog = () => body.children.find(n => n.attributes.id === 'library-preview-dialog')!;
 const emit = (type: string) => window.dispatchEvent(new Event(type));

 return { window, document, body, bridge, fetchMock, studioStub, get, all, dialog, previewDialog, emit };
}

describe('Library & Artifact Center pure helpers', () => {
 it('merges Prime uploads and Workspace items and filters by kind, tag, path and query', () => {
  const w = buildLibraryWorld();
  const { mergeLibraryItems, filterUnifiedItems, formatBytes, studioTargetForUpload } = w.window.EchoPrimeLibrary.core;
  const merged = mergeLibraryItems(sampleUploads(), [{ id: 'ws_1', name: 'notes.md', path: 'proj/notes.md' }]);
  expect(merged).toHaveLength(6);

  expect(filterUnifiedItems(merged, { kind: 'image' }).map((i: any) => i.id)).toEqual([UPL_IMG]);
  expect(filterUnifiedItems(merged, { kind: 'video' }).map((i: any) => i.id)).toEqual([UPL_VID]);
  expect(filterUnifiedItems(merged, { kind: 'workspace' }).map((i: any) => i.id)).toEqual(['ws_1']);
  expect(filterUnifiedItems(merged, { kind: 'all', query: 'concept' }).map((i: any) => i.id)).toEqual([UPL_IMG]);
  expect(filterUnifiedItems(merged, { kind: 'all', query: 'proj/notes' }).map((i: any) => i.id)).toEqual(['ws_1']);

  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(2048)).toBe('2.0 KB');
  expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');

  expect(studioTargetForUpload({ kind: 'image' })).toEqual({ category: 'image', role: 'reference' });
  expect(studioTargetForUpload({ kind: 'video' })).toEqual({ category: 'video', role: 'reference' });
  expect(studioTargetForUpload({ kind: 'audio' })).toEqual({ category: 'video', role: 'audio' });
  expect(studioTargetForUpload({ kind: 'document' })).toEqual({ category: 'video', role: 'script' });
 });

 it('filters Artifact Center items by source, kind and provenance fields', () => {
  const w = buildLibraryWorld();
  const { filterArtifacts } = w.window.EchoPrimeLibrary.core;
  const arts = sampleArtifacts();

  expect(filterArtifacts(arts, { source: 'studio' }).map((a: any) => a.id)).toEqual([ART_STUDIO]);
  expect(filterArtifacts(arts, { source: 'adk' }).map((a: any) => a.id)).toEqual([ART_ADK]);
  expect(filterArtifacts(arts, { kind: 'proof' }).map((a: any) => a.id)).toEqual([ART_ADK]);
  expect(filterArtifacts(arts, { query: 'flux-1-dev' }).map((a: any) => a.id)).toEqual([ART_STUDIO]);
  expect(filterArtifacts(arts, { query: 'run_99' }).map((a: any) => a.id)).toEqual([ART_ADK]);
 });
});

describe('Unified Library fake-DOM interactions', () => {
 it('renders merged uploads + Workspace files in grid mode, toggles list mode, and filters by kind & search', async () => {
  const w = buildLibraryWorld();
  await w.window.EchoPrimeLibrary.open('library');
  await tick();

  const dlg = w.dialog();
  expect(dlg.open).toBe(true);
  expect(dlg.textContent).toContain('hero.png');
  expect(dlg.textContent).toContain('EXIF GPS stripped');
  expect(dlg.textContent).toContain('architecture-note.md');

  // Image card renders thumbnail <img> with ?thumb=1
  const thumb = walk(dlg).find(n => n.tagName === 'IMG' && n.className === 'library-thumb')!;
  expect(thumb.attributes.src).toBe(`/api/prime/uploads/${UPL_IMG}/file?thumb=1`);

  // Toggle Grid -> List layout
  const listToggle = walk(dlg).find(n => n.attributes['data-layout-mode'] === 'list')!;
  await listToggle.click();
  const itemsWrap = walk(dlg).find(n => n.attributes['data-layout'] === 'list')!;
  expect(itemsWrap).toBeTruthy();

  // Filter by Video kind
  const videoPill = walk(dlg).find(n => n.attributes['data-kind-filter'] === 'video')!;
  await videoPill.click();
  const cardsAfterVideo = walk(dlg).filter(n => n.tagName === 'ARTICLE' && n.className.includes('library-card'));
  expect(cardsAfterVideo).toHaveLength(1);
  expect(cardsAfterVideo[0].attributes['data-upload-id']).toBe(UPL_VID);

  // Switch back to All and search by tag
  await walk(dlg).find(n => n.attributes['data-kind-filter'] === 'all')!.click();
  const search = walk(dlg).find(n => n.attributes['data-field'] === 'unified-search')!;
  search.value = 'spec';
  await search.fire('input');
  const cardsAfterSearch = walk(dlg).filter(n => n.tagName === 'ARTICLE' && n.className.includes('library-card'));
  expect(cardsAfterSearch).toHaveLength(1);
  expect(cardsAfterSearch[0].attributes['data-upload-id']).toBe(UPL_PDF);
 });

 it('opens preview modal for image, video, audio, PDF and text uploads', async () => {
  const w = buildLibraryWorld();
  await w.window.EchoPrimeLibrary.open('library');
  await tick();
  const dlg = w.dialog();

  const clickPreviewFor = async (uploadId: string) => {
   const card = walk(dlg).find(n => n.attributes['data-upload-id'] === uploadId)!;
   const btn = walk(card).find(n => n.attributes['data-action'] === 'preview')!;
   await btn.click();
   await tick();
   return w.previewDialog();
  };

  // Image preview -> <img class="preview-media">
  const pImg = await clickPreviewFor(UPL_IMG);
  expect(pImg.open).toBe(true);
  expect(walk(pImg).some(n => n.tagName === 'IMG' && n.attributes.src === `/api/prime/uploads/${UPL_IMG}/file`)).toBe(true);

  // Video preview -> <video controls>
  const pVid = await clickPreviewFor(UPL_VID);
  expect(walk(pVid).some(n => n.tagName === 'VIDEO' && n.attributes.src === `/api/prime/uploads/${UPL_VID}/file`)).toBe(true);

  // Audio preview -> <audio controls>
  const pAud = await clickPreviewFor(UPL_AUD);
  expect(walk(pAud).some(n => n.tagName === 'AUDIO' && n.attributes.src === `/api/prime/uploads/${UPL_AUD}/file`)).toBe(true);

  // PDF preview -> <iframe class="preview-pdf">
  const pPdf = await clickPreviewFor(UPL_PDF);
  expect(walk(pPdf).some(n => n.tagName === 'IFRAME' && n.attributes.src === `/api/prime/uploads/${UPL_PDF}/file`)).toBe(true);

  // Text/Markdown preview -> fetches Range bytes and renders <pre class="preview-text">
  const pTxt = await clickPreviewFor(UPL_TXT);
  expect(pTxt.textContent).toContain('# Preview Markdown Content');
 });

 it('uploads new files, renames & updates tags, and enforces inline two-step delete', async () => {
  const w = buildLibraryWorld();
  await w.window.EchoPrimeLibrary.open('library');
  await tick();
  const dlg = w.dialog();

  // Upload new file
  const picker = walk(dlg).find(n => n.attributes['data-field'] === 'prime-upload-file')!;
  const tagsField = walk(dlg).find(n => n.attributes['data-field'] === 'prime-upload-tags')!;
  picker.files = [{ name: 'sketch.png', type: 'image/png', size: 4096, text: async () => 'PNGDATA' }];
  tagsField.value = 'draft, ui';
  await walk(dlg).find(n => n.attributes['data-action'] === 'submit-upload')!.click();
  await tick();
  expect(dlg.textContent).toContain('sketch.png');
  expect(dlg.textContent).toContain('#draft');

  // Rename + retag UPL_VID
  const vidCard = walk(dlg).find(n => n.attributes['data-upload-id'] === UPL_VID)!;
  walk(vidCard).find(n => n.attributes['data-field'] === `rename-${UPL_VID}`)!.value = 'intro-reel.mp4';
  walk(vidCard).find(n => n.attributes['data-field'] === `tags-${UPL_VID}`)!.value = 'reel, final';
  await walk(vidCard).find(n => n.attributes['data-action'] === 'save-meta')!.click();
  await tick();
  expect(dlg.textContent).toContain('intro-reel.mp4');
  expect(dlg.textContent).toContain('#reel');

  // Two-step delete: step 1 reveals Confirm delete without calling delete endpoint yet
  const vidCardAfter = walk(dlg).find(n => n.attributes['data-upload-id'] === UPL_VID)!;
  await walk(vidCardAfter).find(n => n.attributes['data-action'] === 'delete-step1')!.click();
  expect(w.fetchMock.mock.calls.some((c: any[]) => String(c[0]).endsWith('/delete'))).toBe(false);
  expect(dlg.textContent).toContain('Confirm delete');

  // Step 2: Confirm delete removes item
  await walk(dlg).find(n => n.attributes['data-action'] === 'delete-confirm')!.click();
  await tick();
  expect(walk(dlg).find(n => n.attributes['data-upload-id'] === UPL_VID)).toBeUndefined();
 });

 it('attaches uploads to chat and renders thumbnail chips in composer.js', async () => {
  const w = buildLibraryWorld(['library.js', 'composer.js']);
  await tick();
  await w.window.EchoPrimeLibrary.open('library');
  await tick();

  const imgCard = walk(w.dialog()).find(n => n.attributes['data-upload-id'] === UPL_IMG)!;
  await walk(imgCard).find(n => n.attributes['data-action'] === 'attach')!.click();
  await tick();

  expect(w.dialog().open).toBe(false);
  expect([...w.bridge.state.attachments]).toEqual([UPL_IMG]);

  // Verify composer.js rendered a removable chip with thumbnail <img> and exact label 'hero.png ×'
  const chip = w.all().find(n => n.tagName === 'BUTTON' && n.className === 'chip')!;
  expect(chip).toBeTruthy();
  expect(chip.textContent.trim()).toBe('hero.png ×');
  expect(walk(chip).some(n => n.tagName === 'IMG' && n.className === 'chip-thumb')).toBe(true);

  // Composer Attach dialog also lists uploads with checkboxes
  const attachBtn = w.all().find(n => n.tagName === 'BUTTON' && n.textContent.trim() === '＋ Attach')!;
  await attachBtn.click();
  await tick();
  expect(w.all().some(n => n.tagName === 'INPUT' && n.attributes['data-file'] === UPL_PDF)).toBe(true);

  // Removing the chip also removes the "Attached hero.png to your next message." notice it caused.
  expect(w.get('#draft-notice').textContent).toBe('Attached hero.png to your next message.');
  await w.all().find(n => n.tagName === 'BUTTON' && n.className === 'chip')!.click();
  await tick();
  expect([...w.bridge.state.attachments]).toEqual([]);
  expect(w.get('#draft-notice').textContent).toBe('');
  expect(w.get('#draft-notice').hidden).toBe(true);
 });

 it('sends uploads to Studio via Use in Studio, supports role selection, passes inputs:[{upload_id,role}], and shows the stored Studio output', async () => {
  const w = buildLibraryWorld(['library.js', 'integrations.js']);
  await w.window.EchoPrimeLibrary.open('library');
  await tick();

  const imgCard = walk(w.dialog()).find(n => n.attributes['data-upload-id'] === UPL_IMG)!;
  await walk(imgCard).find(n => n.attributes['data-action'] === 'use-in-studio')!.click();

  expect(w.dialog().open).toBe(false);
  expect(w.get('#creative-dialog').open).toBe(true);
  expect(w.window.EchoPrimeStudio.inputs()).toEqual([{ upload_id: UPL_IMG, role: 'reference' }]);

  // Change role from 'reference' to 'init' in #creative-inputs
  const roleSelect = walk(w.get('#creative-inputs')).find(n => n.attributes['data-input-role'] === UPL_IMG)!;
  roleSelect.value = 'init';
  await roleSelect.fire('change');
  w.get('#creative-prompt').value = 'Transform into crystal fortress';
  await w.get('#creative-prompt').fire('input');

  const argsJson = JSON.parse(w.get('#creative-arguments').value);
  expect(argsJson.inputs).toEqual([{ upload_id: UPL_IMG, role: 'init' }]);

  // Prepare + Execute -> verifies inputs sent to /api/prepare and Studio output registered in /api/prime/artifacts
  await w.get('#prepare-creative').click();
  await tick();
  expect(w.get('#review-dialog').open).toBe(true);

  const prepareBody = JSON.parse(w.fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/prepare')![1].body);
  expect(prepareBody.arguments).toMatchObject({ prompt: 'Transform into crystal fortress', wait: false, inputs: [{ upload_id: UPL_IMG, role: 'init' }] });
  expect(prepareBody.arguments.options).toBeUndefined();

  await w.get('#execute-request').click();
  await tick();
  // The media artifact (with the stored file) is Prime's to register; the Studio does not post a JSON copy.
  expect(w.fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/prime/artifacts' && c[1]?.method === 'POST')).toBeUndefined();
  const shown = walk(w.get('#creative-result')).find(n => n.tagName === 'IMG');
  expect(shown?.attributes.src).toBe('/api/prime/uploads/upl_' + 'f'.repeat(32) + '/file');
  expect(shown?.attributes.alt).toBe('Transform into crystal fortress');
  expect(w.get('#creative-result').textContent).toContain('Saved to Library as media.image_generate-req_1.png');
 });

 it('delegates EchoPrimeViews.open("library") to unified EchoPrimeLibrary when loaded', async () => {
  const w = buildLibraryWorld(['views.js', 'library.js']);
  await tick();
  await w.window.EchoPrimeViews.open('library');
  await tick();
  expect(w.dialog().open).toBe(true);
  expect(w.dialog().textContent).toContain('Library & Artifact Center');
 });
});

describe('Library first paint', () => {
 it('says the uploads are loading until the list answers, never that uploads are off', async () => {
  const w = buildLibraryWorld();
  let release: () => void = () => {};
  const original = w.fetchMock.getMockImplementation()!;
  w.fetchMock.mockImplementation(async (url: string, init: any) => {
   if (String(url).startsWith('/api/prime/uploads/list')) await new Promise<void>(r => { release = r; });
   return original(url, init);
  });
  const opening = w.window.EchoPrimeLibrary.open('library');
  await tick();
  expect(w.dialog().textContent).toContain('Loading your uploads…');
  expect(w.dialog().textContent).not.toContain('uploads are off');
  release();
  await opening;
  await tick();
  expect(w.dialog().textContent).not.toContain('Loading your uploads…');
  expect(w.dialog().textContent).toContain('Upload pictures, video, audio & documents');
 });
});

describe('Artifact Center provenance & actions', () => {
 it('renders provenance records (prompt, model, capability, run_id, verdict, sha256) and supports preview, download, Re-use and export chat', async () => {
  const w = buildLibraryWorld();
  await w.window.EchoPrimeLibrary.open('artifacts');
  await tick();

  const dlg = w.dialog();
  expect(dlg.open).toBe(true);
  expect(dlg.textContent).toContain('Solar Citadel at dawn');
  expect(dlg.textContent).toContain('flux-1-dev');
  expect(dlg.textContent).toContain('echo.media.image_generate');
  expect(dlg.textContent).toContain('run_99');
  expect(dlg.textContent).toContain('PASS');
  expect(dlg.textContent).toContain('e3b0c44298fc1c149afbf4c8996fb924');

  // Preview ADK proof artifact
  const adkCard = walk(dlg).find(n => n.attributes['data-artifact-id'] === ART_ADK)!;
  await walk(adkCard).find(n => n.attributes['data-action'] === 'artifact-preview')!.click();
  await tick();
  expect(w.previewDialog().open).toBe(true);
  expect(w.previewDialog().textContent).toContain('"proof":"verified"');

  // Re-use Studio artifact -> opens EchoPrimeStudio with original prompt & reference inputs!
  const studioCard = walk(dlg).find(n => n.attributes['data-artifact-id'] === ART_STUDIO)!;
  const downloadLink = walk(studioCard).find(n => n.tagName === 'A' && n.textContent === 'Download')!;
  expect(downloadLink.attributes.href).toBe(`/api/prime/artifacts/${ART_STUDIO}/file?download=1`);

  await walk(studioCard).find(n => n.attributes['data-action'] === 'artifact-reuse')!.click();
  expect(w.studioStub.open).toHaveBeenCalledWith('image', 'Solar Citadel at dawn', [{ upload_id: UPL_IMG, role: 'reference' }]);

  // Re-open Artifacts and Re-use ADK artifact -> populates composer #prompt
  await w.window.EchoPrimeLibrary.open('artifacts');
  await tick();
  const adkCard2 = walk(w.dialog()).find(n => n.attributes['data-artifact-id'] === ART_ADK)!;
  await walk(adkCard2).find(n => n.attributes['data-action'] === 'artifact-reuse')!.click();
  expect(w.get('#prompt').value).toBe('Audit prime parity routes');

  // Export current chat button registers a chat_export artifact
  await w.window.EchoPrimeLibrary.open('artifacts');
  await tick();
  const exportBtn = walk(w.dialog()).find(n => n.attributes['data-action'] === 'export-current-chat')!;
  await exportBtn.click();
  await tick();
  expect(w.dialog().textContent).toContain('Prime Parity Chat');
 });

 it('enforces two-step delete on artifacts and clears all cached uploads/artifacts on echo-account-changed', async () => {
  const w = buildLibraryWorld();
  await w.window.EchoPrimeLibrary.open('artifacts');
  await tick();

  const card = walk(w.dialog()).find(n => n.attributes['data-artifact-id'] === ART_ADK)!;
  await walk(card).find(n => n.attributes['data-action'] === 'artifact-delete-step1')!.click();
  expect(w.dialog().textContent).toContain('Confirm delete');
  await walk(w.dialog()).find(n => n.attributes['data-action'] === 'artifact-delete-confirm')!.click();
  await tick();
  expect(walk(w.dialog()).find(n => n.attributes['data-artifact-id'] === ART_ADK)).toBeUndefined();

  // Account change closes modals and wipes cached uploads & artifacts
  w.emit('echo-account-changed');
  expect(w.dialog().open).toBe(false);
  expect(w.window.EchoPrimeLibrary.uploads()).toEqual([]);
  expect(w.window.EchoPrimeArtifacts.list()).toEqual([]);
 });

 it('blocks unauthenticated Workspace visitors without fetching uploads or artifacts', async () => {
  const bridge = makeFakeBridge();
  bridge.session = { workspaceConfigured: true, authenticated: false, ownerAccess: false, csrf: '', user: null as any };
  const w = buildLibraryWorld(['library.js'], { bridge });
  await w.window.EchoPrimeLibrary.open('library');
  await tick();
  expect(w.dialog().textContent).toContain('Sign in to an approved Workspace account');
  expect(w.fetchMock).not.toHaveBeenCalled();
 });

 it('serves library.js and library.css from the Prime HTTP server and wires index.html', async () => {
  const server = await startPrimeServer(new PrimeHub({ capabilities: [] }), fileURLToPath(new URL('../ui/echo-prime/', import.meta.url)), 0);
  try {
   for (const [assetPath, mime] of [['/library.js', 'javascript'], ['/library.css', 'css']]) {
    const res = await fetch(server.url + assetPath);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(mime);
   }
   const html = await (await fetch(server.url + '/')).text();
   expect(html).toContain('library.js');
   expect(html).toContain('library.css');
   expect(html).toContain('id="open-library"');
   expect(html).toContain('id="open-artifacts"');
   expect(html).toContain('id="creative-inputs"');
  } finally {
   await server.close();
  }
 });

 it('refuses credential and executable filenames client-side before sending network bytes', async () => {
  const w = buildLibraryWorld();
  await expect(w.window.EchoPrimeLibrary.uploadFile({ name: '.env.production', size: 12, type: 'text/plain' })).rejects.toThrow(/Vault/i);
  await expect(w.window.EchoPrimeLibrary.uploadFile({ name: 'installer.exe', size: 12, type: 'application/octet-stream' })).rejects.toThrow(/refused/i);
  expect(w.fetchMock).not.toHaveBeenCalled();
 });

 it('caps chat attachments at 8 items and notifies status', async () => {
  const w = buildLibraryWorld();
  for (let i = 0; i < 8; i++) w.bridge.state.attachments.add(`lib_${i}`);
  await w.window.EchoPrimeLibrary.open('library');
  await tick();
  const imgCard = walk(w.dialog()).find(n => n.attributes['data-upload-id'] === UPL_IMG)!;
  await walk(imgCard).find(n => n.attributes['data-action'] === 'attach')!.click();
  expect(w.bridge.state.attachments.has(UPL_IMG)).toBe(false);
  expect(w.dialog().textContent).toContain('Attach at most 8 files');
 });

 it('opens Studio upload picker lazily on click without fetching on Studio open', async () => {
  const w = buildLibraryWorld(['library.js', 'integrations.js']);
  w.window.EchoPrimeStudio.open('video', 'Ocean waves');
  // Opening Studio must NOT trigger any automatic /api/prime/uploads/list fetch
  expect(w.fetchMock).not.toHaveBeenCalled();

  // Clicking "Choose from uploads" fetches uploads and lets user pick UPL_VID + UPL_AUD
  const chooseBtn = walk(w.get('#creative-inputs')).find(n => n.attributes['data-action'] === 'choose-studio-upload')!;
  await chooseBtn.click();
  await tick();
  expect(w.fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes('/api/prime/uploads/list'))).toBe(true);

  const pickAud = walk(w.get('#creative-inputs')).find(n => n.attributes['data-pick-upload'] === UPL_AUD)!;
  await pickAud.click();
  expect(w.window.EchoPrimeStudio.inputs()).toEqual([{ upload_id: UPL_AUD, role: 'audio' }]);
 });

 it('preserves Workspace note authoring and chat import inside the unified Library view', async () => {
  const w = buildLibraryWorld();
  await w.window.EchoPrimeLibrary.open('library');
  await tick();
  const dlg = w.dialog();

  // Write a Workspace note
  walk(dlg).find(n => n.attributes['data-field'] === 'note-name')!.value = 'design.md';
  walk(dlg).find(n => n.attributes['data-field'] === 'note-content')!.value = '# Unified Design';
  const saveNoteBtn = walk(dlg).find(n => n.tagName === 'BUTTON' && n.textContent === 'Save note')!;
  await saveNoteBtn.click();
  await tick();
  expect(w.bridge.api).toHaveBeenCalledWith('/library', expect.objectContaining({ name: 'design.md', content: '# Unified Design' }));

  // Import chat
  walk(dlg).find(n => n.attributes['data-field'] === 'import-title')!.value = 'Prior Chat';
  walk(dlg).find(n => n.attributes['data-field'] === 'import-data')!.value = 'Hello transcript';
  const impBtn = walk(dlg).find(n => n.tagName === 'BUTTON' && n.textContent === 'Import chat')!;
  await impBtn.click();
  await tick();
  expect(w.bridge.api).toHaveBeenCalledWith('/import', expect.objectContaining({ title: 'Prior Chat', source: 'chatgpt' }));
 });

 it('forwards attached uploads in chat.js and files no Echo Build artifact for a chat reply', async () => {
  const w = buildLibraryWorld(['library.js', 'chat.js']);
  w.bridge.state.attachments.add(UPL_PDF);

  w.fetchMock.mockImplementation(async (url: string, init?: any) => {
   if (url === '/api/status') {
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ chat: { state: 'attached', busy: false } }) };
   }
   if (url === '/api/chat') {
    const body = JSON.parse(init.body);
    expect(body.attachments).toEqual([UPL_PDF]);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ status: 'completed', sessionId: 'sess_42', answer: '```ts\nexport const ok = true;\n```', model: 'qwen2.5-coder' }) };
   }
   if (url === '/api/prime/artifacts' && init?.method === 'POST') {
    const rec = JSON.parse(init.body);
    return { ok: true, status: 201, headers: { get: () => 'application/json' }, json: async () => ({ id: 'art_' + 'c'.repeat(32), ...rec, bytes: 32, created_at: '2026-11-04T21:10:00Z', owner: 'owner', tags: [] }) };
   }
   return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ error: 'unhandled' }) };
  });

  const sent = await w.window.EchoPrimeChat.send('Build the upload parser');
  expect(sent.sent).toBe(true);
  await tick();

  // Live test 2026-11-06: every ECHO Code reply was filed as an "Echo Build" code artifact. A chat reply is not a build.
  const artCall = w.fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/prime/artifacts' && c[1]?.method === 'POST');
  expect(artCall).toBeUndefined();
 });

 it('works for approved Workspace members (non-owner) with member CSRF headers', async () => {
  const bridge = makeFakeBridge();
  bridge.session = {
   workspaceConfigured: true,
   authenticated: true,
   ownerAccess: false,
   csrf: 'csrf-member-token',
   user: { uid: 'member_7', role: 'member', status: 'approved' },
  };
  const w = buildLibraryWorld(['library.js'], { bridge });
  await w.window.EchoPrimeLibrary.open('library');
  await tick();

  expect(w.dialog().textContent).toContain('hero.png');
  for (const call of w.fetchMock.mock.calls) {
   expect(call[1]?.headers?.['x-echo-csrf']).toBe('csrf-member-token');
  }
 });
});
