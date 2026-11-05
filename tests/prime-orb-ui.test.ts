import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../ui/echo-prime/orb.js', import.meta.url), 'utf8');

type Fn = (e?: unknown) => void;
interface El { tag: string; className: string; textContent: string; hidden: boolean; dataset: Record<string, string>; style: Record<string, string>; children: El[]; parentNode: El | null; nextSibling: null;
  append(...n: El[]): void; setAttribute(k: string, v: string): void; insertBefore(n: El, ref: unknown): void; addEventListener(n: string, fn: Fn): void; removeEventListener(n: string, fn: Fn): void; fire(n: string, e?: unknown): void; listeners(n: string): number }
function element(tag = 'div'): El {
  const handlers = new Map<string, Set<Fn>>();
  const el: El = {
    tag, className: '', textContent: '', hidden: false, dataset: {}, style: {}, children: [], parentNode: null, nextSibling: null,
    append(...n) { for (const c of n) { c.parentNode = el; el.children.push(c); } },
    setAttribute() { /* attributes are not inspected */ },
    insertBefore(n) { n.parentNode = el; el.children.push(n); },
    addEventListener(n, fn) { (handlers.get(n) ?? handlers.set(n, new Set()).get(n)!).add(fn); },
    removeEventListener(n, fn) { handlers.get(n)?.delete(fn); },
    fire(n, e) { for (const fn of handlers.get(n) ?? []) fn(e ?? {}); },
    listeners(n) { return handlers.get(n)?.size ?? 0; },
  };
  return el;
}
/** A 2D context that records call counts and accepts every style the orb sets. */
function context2d() {
  const calls: Record<string, number> = {};
  const gradient = () => ({ addColorStop() { /* colours are not inspected */ } });
  const ctx: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalCompositeOperation: 'source-over', calls, createRadialGradient: gradient, createLinearGradient: gradient };
  for (const name of ['setTransform', 'clearRect', 'fillRect', 'beginPath', 'arc', 'fill', 'stroke', 'moveTo', 'lineTo', 'save', 'restore', 'clip', 'closePath']) ctx[name] = () => { calls[name] = (calls[name] ?? 0) + 1; };
  return ctx as Record<string, unknown> & { calls: Record<string, number> };
}
interface Opts { webgl?: boolean; twoD?: boolean; reduced?: boolean }
interface OrbApi { setState(d: unknown): boolean; getState(): Record<string, unknown> & { mode: string; hover: { id: string; name: string; kind: string } | null; claims: string[]; pulse: number; ripple: number; amplitude: number; intensity: number; transient: string | null; arcs: number; satellites: number };
  pulse(s?: number): number; setSatellites(d: unknown): boolean; satellites(): { id: string; kind: string; status: string; busy: boolean; size: number; color: number[]; sx: number; sy: number; front: boolean }[]; arcs(): { from: string; to: string; kind: string }[]; links(): { to: string }[]; destroy(): void }
interface Mounted { motion: boolean; frames: number; setPalette(v: string): void; setQuality(v: string): void; setMotion(v: boolean): void; destroy(): void }
function setup(opts: Opts = {}) {
  const doc = element('document') as El & { hidden: boolean; createElement(tag: string): El; dispatchEvent(e: Event): boolean };
  doc.hidden = false; doc.createElement = (tag: string) => element(tag);
  doc.dispatchEvent = (e: Event) => { doc.fire(e.type, e); return true; };
  const stage = element('div'), canvas = element('canvas') as El & { width: number; height: number; getBoundingClientRect(): { left: number; top: number; width: number; height: number }; getContext(kind: string): unknown };
  stage.append(canvas); canvas.width = 0; canvas.height = 0;
  const ctx = context2d();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 440 });
  canvas.getContext = (kind: string) => kind === 'webgl' ? (opts.webgl ? {} : null) : kind === '2d' ? (opts.twoD === false ? null : ctx) : null;
  const rafs = new Map<number, (t: number) => void>(); let rafId = 0, cancelled = 0;
  const media = { matches: opts.reduced === true, handlers: [] as Fn[], addEventListener(_n: string, fn: Fn) { media.handlers.push(fn); }, removeEventListener() { /* noop */ } };
  const win: Record<string, unknown> = {};
  const fallback = vi.fn(), motionChange = vi.fn();
  const context = {
    window: win, document: doc, matchMedia: () => media, ResizeObserver: class { observe() { /* noop */ } disconnect() { /* noop */ } },
    requestAnimationFrame: (fn: (t: number) => void) => { rafs.set(++rafId, fn); return rafId; }, cancelAnimationFrame: (id: number) => { if (rafs.delete(id)) cancelled++; },
    devicePixelRatio: 1, setTimeout, clearTimeout, Date, CustomEvent, console: { warn: vi.fn(), debug: vi.fn() },
  };
  runInNewContext(source, context);
  const mount = (win.EchoPrimeOrb as { mount(c: unknown, o: unknown): Mounted }).mount;
  const orb = mount(canvas, { onFallback: fallback, onMotionChange: motionChange });
  if (opts.twoD !== false) orb.setQuality('quiet'); // fewer points: the fake context records every call, so frames stay cheap
  let stamp = 0;
  /** Runs every pending animation frame once, `ms` later on the frame clock and on Date.now(). */
  const frame = (ms = 16) => { stamp += ms; vi.advanceTimersByTime(ms); const pending = [...rafs.values()]; rafs.clear(); for (const fn of pending) fn(stamp); };
  const api = () => win.EchoOrb as OrbApi | undefined;
  const dispatch = (type: string, detail: unknown) => doc.dispatchEvent(new CustomEvent(type, { detail }));
  const sat = (id: string, kind: string, over: Record<string, unknown> = {}) => ({ id, kind, name: id.toUpperCase(), status: 'idle', busy: false, ...over });
  return { doc, stage, canvas, ctx, orb, api, frame, dispatch, sat, rafs, media, fallback, motionChange, cancelled: () => cancelled, win };
}
const lum = (c: number[]) => c[0] + c[1] + c[2];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T20:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('mount and renderer selection', () => {
  it('falls back to the 2D renderer without WebGL, exposes window.EchoOrb and starts idle', () => {
    const s = setup();
    expect(s.canvas.dataset.renderer).toBe('canvas-3d'); expect(s.fallback).not.toHaveBeenCalled();
    const api = s.api()!; expect(api).toBeDefined();
    expect(api.getState().mode).toBe('idle'); expect(s.canvas.dataset.orbMode).toBe('idle'); expect(s.stage.dataset.orbMode).toBe('idle');
    expect(typeof api.setState).toBe('function'); expect(typeof api.pulse).toBe('function'); expect(typeof api.setSatellites).toBe('function');
    expect(s.orb.frames).toBeGreaterThan(0);
  });
  it('reports a fallback and returns an inert handle when no 2D context exists either, without throwing', () => {
    const s = setup({ twoD: false });
    expect(s.fallback).toHaveBeenCalledTimes(1); expect(s.api()).toBeUndefined();
    expect(() => { s.orb.setPalette('aurora'); s.orb.setMotion(false); s.orb.destroy(); }).not.toThrow();
  });
  it('runs an animation loop of frames that draw without exceptions', () => {
    const s = setup(); const before = s.orb.frames;
    for (let i = 0; i < 30; i++) s.frame();
    expect(s.orb.frames).toBe(before + 30); expect(s.ctx.calls.arc).toBeGreaterThan(0);
  });
});

describe('state machine and event arbitration', () => {
  it('drives the mode from the echo-orb-state event and marks the canvas and stage', () => {
    const s = setup(); s.dispatch('echo-orb-state', { mode: 'thinking', source: 'chat' });
    expect(s.api()!.getState().mode).toBe('thinking'); expect(s.canvas.dataset.orbMode).toBe('thinking'); expect(s.stage.dataset.orbMode).toBe('thinking');
  });
  it('ignores unknown modes and malformed details', () => {
    const s = setup(); const api = s.api()!;
    expect(api.setState({ mode: 'dancing' })).toBe(false); expect(api.setState(null)).toBe(false); expect(api.setState('deep')).toBe(false);
    expect(s.dispatch('echo-orb-state', { mode: 42 })).toBe(true); expect(api.getState().mode).toBe('idle');
  });
  it('lets speaking win over the chat while it speaks, then falls back to the chat claim', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'thinking', source: 'chat' }); api.setState({ mode: 'speaking', amplitude: .8, source: 'voice' });
    expect(api.getState().mode).toBe('speaking'); expect(api.getState().amplitude).toBe(.8);
    api.setState({ mode: 'idle', source: 'voice' });
    expect(api.getState().mode).toBe('thinking'); expect(api.getState().amplitude).toBe(0);
  });
  it('attributes speaking and listening without a source to the voice, and other modes to the app', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'speaking' }); expect(api.getState().claims).toEqual(['voice']);
    api.setState({ mode: 'thinking' }); expect(api.getState().claims).toEqual(['voice', 'app']);
  });
  it('ranks deep above thinking and replying above deep', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'thinking', source: 'chat' }); api.setState({ mode: 'deep', source: 'agents' }); expect(api.getState().mode).toBe('deep');
    api.setState({ mode: 'replying', source: 'chat' }); expect(api.getState().mode).toBe('replying');
    api.setState({ mode: 'idle', source: 'chat' }); expect(api.getState().mode).toBe('deep');
  });
  it('clears only the claiming source on idle', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'deep', source: 'swarm' }); api.setState({ mode: 'thinking', source: 'chat' });
    api.setState({ mode: 'idle', source: 'chat' }); expect(api.getState().mode).toBe('deep'); expect(api.getState().claims).toEqual(['swarm']);
    api.setState({ mode: 'idle', source: 'swarm' }); expect(api.getState().mode).toBe('idle');
  });
  it('flashes error as a timed overlay and restores the winning mode afterwards', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'thinking', source: 'chat' }); api.setState({ mode: 'error', source: 'chat' });
    expect(api.getState().mode).toBe('error'); expect(api.getState().transient).toBe('error');
    vi.advanceTimersByTime(1000);
    expect(api.getState().mode).toBe('thinking'); expect(api.getState().transient).toBeNull();
  });
  it('flashes success then settles to idle when nothing else is claimed', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'success', source: 'chat' }); expect(api.getState().mode).toBe('success');
    for (let i = 0; i < 4; i++) s.frame(100); expect(api.getState().mode).toBe('success');
    vi.advanceTimersByTime(800); expect(api.getState().mode).toBe('idle');
  });
  it('keeps the listening ripple as a layer under a higher-priority mode', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'thinking', source: 'chat' }); api.setState({ mode: 'listening', source: 'voice' });
    expect(api.getState().mode).toBe('thinking');
    for (let i = 0; i < 20; i++) s.frame(); expect(api.getState().ripple).toBeGreaterThan(.3);
    api.setState({ mode: 'idle', source: 'voice' }); for (let i = 0; i < 60; i++) s.frame(); expect(api.getState().ripple).toBeLessThan(.05);
  });
  it('clamps amplitude and intensity into 0..1', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'speaking', amplitude: 7, intensity: -2, source: 'voice' });
    expect(api.getState().amplitude).toBe(1); expect(api.getState().intensity).toBe(0);
    api.setState({ mode: 'speaking', amplitude: Number.NaN, source: 'voice' }); expect(api.getState().amplitude).toBe(0);
  });
  it('pulses on token arrival through the API and the event, then decays over frames', () => {
    const s = setup(); const api = s.api()!;
    expect(api.pulse()).toBeGreaterThan(0); s.dispatch('echo-orb-pulse', { strength: 1 });
    const peak = api.getState().pulse; expect(peak).toBeGreaterThan(.6);
    for (let i = 0; i < 40; i++) s.frame(); expect(api.getState().pulse).toBeLessThan(peak * .2);
  });
});

describe('satellites', () => {
  it('caps the roster at 24 and keeps busy satellites first', () => {
    const s = setup(); const api = s.api()!;
    const list = Array.from({ length: 30 }, (_, i) => s.sat('agent-' + i, 'agent'));
    list[27].busy = true; list[29].status = 'running';
    s.dispatch('echo-orb-satellites', { source: 'agents', satellites: list });
    const sats = api.satellites(); expect(sats).toHaveLength(24);
    expect(sats[0].busy).toBe(true); expect(sats[1].busy).toBe(true); expect(sats.map(x => x.id)).toContain('agent-27'); expect(sats.map(x => x.id)).toContain('agent-29');
  });
  it('drops entries without an id or with an unknown kind, dedupes ids and defaults unknown statuses to idle', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('a', 'agent', { status: 'sleepy' }), { kind: 'agent', name: 'no id' }, s.sat('b', 'planet'), s.sat('a', 'agent'), s.sat('c', 'bot', { name: '   ' })] });
    const sats = api.satellites(); expect(sats.map(x => x.id).sort()).toEqual(['a', 'c']);
    expect(sats.find(x => x.id === 'a')!.status).toBe('idle'); expect(sats.find(x => x.id === 'c')!.name).toBe('c');
  });
  it('maps status to colour: running brightest, idle soft, paused dim, error red', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('run', 'bot', { status: 'running' }), s.sat('idle', 'bot'), s.sat('pause', 'bot', { status: 'paused' }), s.sat('err', 'bot', { status: 'error' })] });
    s.frame();
    const by = Object.fromEntries(api.satellites().map(x => [x.id, x]));
    expect(lum(by.run.color)).toBeGreaterThan(lum(by.idle.color)); expect(lum(by.idle.color)).toBeGreaterThan(lum(by.pause.color));
    expect(by.err.color[0]).toBeGreaterThan(by.err.color[1] * 2); expect(by.err.color[0]).toBeGreaterThan(by.err.color[2] * 2);
  });
  it('sizes moons by kind: swarm larger than bots, bots larger than agent definitions', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('a', 'agent'), s.sat('b', 'bot'), s.sat('w', 'swarm')] });
    const by = Object.fromEntries(api.satellites().map(x => [x.id, x]));
    expect(by.b.size).toBeGreaterThan(by.a.size); expect(by.w.size).toBeGreaterThan(by.b.size);
  });
  it('merges lists per source so agents.js and bots.js never clobber each other', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { source: 'agents', satellites: [s.sat('a1', 'agent'), s.sat('a2', 'agent')] });
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [s.sat('b1', 'bot'), s.sat('b2', 'bot')] });
    expect(api.satellites()).toHaveLength(4);
    s.dispatch('echo-orb-satellites', { source: 'agents', satellites: [s.sat('a3', 'agent')] });
    expect(api.satellites().map(x => x.id).sort()).toEqual(['a3', 'b1', 'b2']);
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [] });
    expect(api.satellites().map(x => x.id)).toEqual(['a3']);
  });
  it('without a source, a list replaces the kinds it contains and an empty list clears everything', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [s.sat('b1', 'bot')] });
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('a1', 'agent'), s.sat('a2', 'agent')] });
    expect(api.satellites().map(x => x.id).sort()).toEqual(['a1', 'a2', 'b1']);
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('a9', 'agent')] });
    expect(api.satellites().map(x => x.id).sort()).toEqual(['a9', 'b1']);
    s.dispatch('echo-orb-satellites', { satellites: [] });
    expect(api.satellites()).toHaveLength(0); expect(api.getState().satellites).toBe(0);
  });
  it('keeps the frame loop exception-free with no satellites at all (anonymous users)', () => {
    const s = setup(); for (let i = 0; i < 20; i++) s.frame();
    expect(s.api()!.satellites()).toEqual([]); expect(s.api()!.arcs()).toEqual([]); expect(s.orb.frames).toBeGreaterThan(20);
  });
  it('orbits moons through depth: moons sit behind and in front of the sphere and cross between the two over time', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { satellites: Array.from({ length: 8 }, (_, i) => s.sat('m' + i, 'agent')) });
    const first = Object.fromEntries(api.satellites().map(m => [m.id, m.front]));
    expect(Object.values(first)).toContain(true); expect(Object.values(first)).toContain(false);
    let crossed = false;
    for (let i = 0; i < 120 && !crossed; i++) { s.frame(60); crossed = api.satellites().some(m => m.front !== first[m.id]); }
    expect(crossed).toBe(true);
  });
  it('derives satellite colours from the active palette', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('i', 'bot')] }); s.frame();
    const prism = [...api.satellites()[0].color]; s.orb.setPalette('aurora'); s.frame();
    expect(api.satellites()[0].color).not.toEqual(prism);
  });
});

describe('arcs', () => {
  const run = (s: ReturnType<typeof setup>, frames: number, step = 60) => { const seen: ReturnType<OrbApi['arcs']> = []; for (let i = 0; i < frames; i++) { s.frame(step); seen.push(...s.api()!.arcs()); } return seen; };
  // Bolts only fire at moons in front of the sphere's limb, so these rosters carry several busy moons: at any instant some are in front.
  const busyIds = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  it('fires lightning between Echo and busy satellites only, and none when nothing is busy', () => {
    const idle = setup(); idle.dispatch('echo-orb-satellites', { satellites: [idle.sat('a', 'agent'), ...busyIds.map(id => idle.sat(id, 'bot'))] });
    expect(run(idle, 80)).toHaveLength(0);
    const busy = setup(); busy.dispatch('echo-orb-satellites', { satellites: [busy.sat('a', 'agent'), busy.sat('q', 'agent'), ...busyIds.map(id => busy.sat(id, 'bot', { busy: true }))] });
    const seen = run(busy, 80);
    expect(seen.length).toBeGreaterThan(0); expect(seen.every(a => a.from === 'core' && busyIds.includes(a.to))).toBe(true);
    const front = new Set(busy.api()!.satellites().filter(m => m.front).map(m => m.id));
    expect(busy.api()!.arcs().every(a => front.has(a.to))).toBe(true);
  });
  it('arcs satellite to satellite only inside a running group', () => {
    const grouped = setup(); grouped.dispatch('echo-orb-satellites', { satellites: [...busyIds.slice(0, 4).map(id => grouped.sat(id, 'bot', { busy: true, group: 'g1' })), ...busyIds.slice(4).map(id => grouped.sat(id, 'bot', { busy: true, group: 'g2' }))] });
    const seen = run(grouped, 90);
    const pairs = seen.filter(a => a.kind === 'group'); expect(pairs.length).toBeGreaterThan(0);
    const g1 = new Set(busyIds.slice(0, 4)), g2 = new Set(busyIds.slice(4));
    expect(pairs.every(a => (g1.has(a.from) && g1.has(a.to)) || (g2.has(a.from) && g2.has(a.to)))).toBe(true);
    const apart = setup(); apart.dispatch('echo-orb-satellites', { satellites: busyIds.map((id, i) => apart.sat(id, 'bot', { busy: true, group: 'g' + i })) });
    expect(run(apart, 90).filter(a => a.kind === 'group')).toHaveLength(0);
  });
  it('never exceeds the per-frame arc cap with many busy satellites', () => {
    const s = setup(); s.dispatch('echo-orb-satellites', { satellites: Array.from({ length: 24 }, (_, i) => s.sat('b' + i, 'bot', { busy: true, group: 'g' + (i % 3) })) });
    let max = 0; for (let i = 0; i < 90; i++) { s.frame(50); max = Math.max(max, s.api()!.getState().arcs); }
    expect(max).toBeGreaterThan(0); expect(max).toBeLessThanOrEqual(12);
  });
  it('lights the sphere limb while an arc is firing', () => {
    const s = setup(); s.dispatch('echo-orb-satellites', { satellites: busyIds.map(id => s.sat(id, 'bot', { busy: true })) });
    let lit = false; for (let i = 0; i < 80 && !lit; i++) { s.frame(60); lit = s.api()!.getState().arcs > 0; }
    expect(lit).toBe(true);
  });
});

describe('reduced motion, hidden tab and teardown', () => {
  it('renders static state colours under prefers-reduced-motion: no frames, no arcs, steady links for busy moons', () => {
    const s = setup({ reduced: true }); expect(s.orb.motion).toBe(false); expect(s.rafs.size).toBe(0);
    const before = s.orb.frames; s.dispatch('echo-orb-satellites', { satellites: [s.sat('b', 'bot', { busy: true }), s.sat('a', 'agent')] });
    s.dispatch('echo-orb-state', { mode: 'deep', source: 'agents' });
    expect(s.orb.frames).toBeGreaterThan(before); expect(s.api()!.getState().mode).toBe('deep'); expect(s.rafs.size).toBe(0);
    vi.advanceTimersByTime(3000); expect(s.api()!.arcs()).toEqual([]); expect(s.api()!.links()).toEqual([{ to: 'b', steady: true }]);
  });
  it('pauses the loop when the tab is hidden and resumes on visibility', () => {
    const s = setup(); expect(s.rafs.size).toBe(1);
    s.doc.hidden = true; s.doc.fire('visibilitychange'); expect(s.rafs.size).toBe(0); expect(s.cancelled()).toBe(1);
    s.frame(); expect(s.rafs.size).toBe(0);
    s.doc.hidden = false; s.doc.fire('visibilitychange'); expect(s.rafs.size).toBe(1);
  });
  it('stops animating when the user turns motion off and redraws state changes statically', () => {
    const s = setup(); s.orb.setMotion(false); expect(s.rafs.size).toBe(0);
    const before = s.orb.frames; s.api()!.setState({ mode: 'replying', source: 'chat' }); expect(s.orb.frames).toBe(before + 1);
    s.media.matches = true; s.media.handlers.forEach(fn => fn()); expect(s.motionChange).toHaveBeenLastCalledWith(false);
  });
  it('removes its listeners and the global API on destroy', () => {
    const s = setup(); expect(s.doc.listeners('echo-orb-state')).toBe(1);
    s.orb.destroy();
    expect(s.doc.listeners('echo-orb-state')).toBe(0); expect(s.doc.listeners('echo-orb-satellites')).toBe(0); expect(s.win.EchoOrb).toBeUndefined();
    expect(() => s.dispatch('echo-orb-state', { mode: 'deep' })).not.toThrow(); expect(() => s.frame()).not.toThrow();
  });
});

describe('hover and open', () => {
  function locate(s: ReturnType<typeof setup>, id: string) { s.frame(); return s.api()!.satellites().find(x => x.id === id)!; }
  it('shows the satellite name on hover and hides it when the pointer leaves', () => {
    const s = setup(); s.dispatch('echo-orb-satellites', { satellites: [s.sat('bot:1', 'bot', { name: 'Ledger Bot', status: 'running' })] });
    const m = locate(s, 'bot:1');
    s.canvas.fire('pointermove', { clientX: m.sx, clientY: m.sy });
    expect(s.api()!.getState().hover).toEqual({ id: 'bot:1', name: 'Ledger Bot', kind: 'bot' }); expect(s.canvas.dataset.orbHover).toBe('true');
    const tip = s.stage.children.find(c => c.className === 'orb-tip')!; expect(tip.hidden).toBe(false); expect(tip.children[0].textContent).toBe('Ledger Bot'); expect(tip.children[1].textContent).toContain('running');
    s.canvas.fire('pointermove', { clientX: m.sx + 200, clientY: m.sy + 200 }); expect(s.api()!.getState().hover).toBeNull();
    s.canvas.fire('pointermove', { clientX: m.sx, clientY: m.sy }); s.canvas.fire('pointerleave'); expect(s.api()!.getState().hover).toBeNull(); expect(tip.hidden).toBe(true);
  });
  it('dispatches echo-orb-open with the id and kind when a moon is clicked, and nothing on empty space', () => {
    const s = setup(); const opened: unknown[] = []; s.doc.addEventListener('echo-orb-open', (e: unknown) => opened.push((e as CustomEvent).detail));
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('agent:researcher', 'agent', { name: 'researcher' })] });
    const m = locate(s, 'agent:researcher');
    s.canvas.fire('click', { clientX: m.sx + 250, clientY: m.sy + 250 }); expect(opened).toEqual([]);
    s.canvas.fire('click', { clientX: m.sx, clientY: m.sy }); expect(opened).toEqual([{ id: 'agent:researcher', kind: 'agent' }]);
  });
});

describe('quality tiers', () => {
  it('accepts every tier, rebuilds the point cloud and keeps drawing', () => {
    const s = setup(); s.dispatch('echo-orb-satellites', { satellites: [s.sat('b', 'bot', { busy: true })] });
    for (const q of ['high', 'quiet', 'adaptive', 'bogus']) { s.orb.setQuality(q); s.frame(); }
    expect(s.orb.frames).toBeGreaterThan(4); expect(s.canvas.width).toBe(640);
  });
});
