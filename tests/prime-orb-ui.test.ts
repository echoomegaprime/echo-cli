import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

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
interface OrbApi { setState(d: unknown): boolean; getState(): Record<string, unknown> & { mode: string; hover: { id: string; name: string; kind: string } | null; claims: string[]; pulse: number; ripple: number; amplitude: number; intensity: number; transient: string | null; arcs: number; satellites: number; energy: number; swirl: number; flow: number; filaments: number; hue: number; ampl: number };
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
  const winHandlers = new Map<string, Set<Fn>>();
  const win: Record<string, unknown> = {
    addEventListener(n: string, fn: Fn) { (winHandlers.get(n) ?? winHandlers.set(n, new Set()).get(n)!).add(fn); },
    removeEventListener(n: string, fn: Fn) { winHandlers.get(n)?.delete(fn); },
  };
  const winFire = (type: string, detail?: unknown) => { for (const fn of winHandlers.get(type) ?? []) fn(new CustomEvent(type, { detail })); };
  const winListeners = (type: string) => winHandlers.get(type)?.size ?? 0;
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
  return { doc, stage, canvas, ctx, orb, api, frame, dispatch, sat, rafs, media, fallback, motionChange, cancelled: () => cancelled, win, winFire, winListeners };
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
    for (let i = 0; i < 5; i++) s.api()!.pulse(); // static redraws never animate, so token pulses must not pile up
    expect(s.api()!.getState().pulse).toBe(0);
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
    const s = setup(); expect(s.doc.listeners('echo-orb-state')).toBe(1); expect(s.winListeners('echo-orb-satellites')).toBe(1); expect(s.winListeners('echo-account-changed')).toBe(1);
    s.orb.destroy();
    expect(s.doc.listeners('echo-orb-state')).toBe(0); expect(s.doc.listeners('echo-orb-satellites')).toBe(0); expect(s.win.EchoOrb).toBeUndefined();
    expect(s.winListeners('echo-orb-satellites')).toBe(0); expect(s.winListeners('echo-account-changed')).toBe(0);
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

describe('static frames show the state (reduced motion, Animation off)', () => {
  it('snaps a static frame straight to the deep look instead of leaving the idle colours on screen', () => {
    const s = setup({ reduced: true }); const api = s.api()!;
    expect(api.getState().energy).toBeCloseTo(.15); expect(api.getState().swirl).toBe(0);
    s.dispatch('echo-orb-state', { mode: 'deep', source: 'agents' });
    expect(api.getState().energy).toBe(1); expect(api.getState().swirl).toBe(1); expect(api.getState().filaments).toBe(1); expect(api.getState().flow).toBeCloseTo(2.7);
    s.dispatch('echo-orb-state', { mode: 'idle', source: 'agents' }); expect(api.getState().swirl).toBe(0); expect(api.getState().energy).toBeCloseTo(.15);
  });
  it('shows speaking at rest and does not redraw for each ~20 Hz amplitude tick, only when something visible changes', () => {
    const s = setup({ reduced: true }); const api = s.api()!;
    s.dispatch('echo-orb-state', { mode: 'speaking', amplitude: .4, source: 'speech' }); const drawn = s.orb.frames;
    for (let i = 0; i < 40; i++) s.dispatch('echo-orb-state', { mode: 'speaking', amplitude: (i % 10) / 10, source: 'speech' });
    expect(s.orb.frames).toBe(drawn); expect(api.getState().ampl).toBe(0); expect(api.getState().amplitude).toBeCloseTo(.9);
    s.dispatch('echo-orb-state', { mode: 'idle', source: 'speech' }); expect(s.orb.frames).toBe(drawn + 1);
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [s.sat('b', 'bot')] }); expect(s.orb.frames).toBe(drawn + 2);
  });
  it('keeps the animated loop easing (no snap) while motion is on', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-state', { mode: 'deep', source: 'agents' }); s.frame(); s.frame(); // the first frame after scheduling has dt=0
    expect(api.getState().swirl).toBeGreaterThan(0); expect(api.getState().swirl).toBeLessThan(.5);
    for (let i = 0; i < 90; i++) s.frame(); expect(api.getState().swirl).toBeGreaterThan(.95);
  });
});

describe('intensity', () => {
  const settle = (s: ReturnType<typeof setup>) => { for (let i = 0; i < 120; i++) s.frame(); return s.api()!.getState(); };
  it('leans thinking toward the deep vortex as intensity rises', () => {
    const calm = setup(); calm.dispatch('echo-orb-state', { mode: 'thinking', source: 'chat' }); const a = settle(calm);
    const hard = setup(); hard.dispatch('echo-orb-state', { mode: 'thinking', intensity: 1, source: 'chat' }); const b = settle(hard);
    expect(b.intensity).toBe(1); expect(b.swirl).toBeGreaterThan(a.swirl + .3); expect(b.flow).toBeGreaterThan(a.flow); expect(b.filaments).toBeGreaterThan(a.filaments + .5);
    expect(b.mode).toBe('thinking');
  });
  it('drives deep harder: faster flow, stronger filaments and hue drift', () => {
    const plain = setup(); plain.dispatch('echo-orb-state', { mode: 'deep', source: 'chat' }); const a = settle(plain);
    const hard = setup(); hard.dispatch('echo-orb-state', { mode: 'deep', intensity: 1, source: 'chat' }); const b = settle(hard);
    expect(b.flow).toBeGreaterThan(a.flow * 1.3); expect(b.filaments).toBeGreaterThan(a.filaments); expect(b.hue).toBeGreaterThan(a.hue);
  });
  it('takes the intensity of the winning claim only', () => {
    const s = setup(); const api = s.api()!;
    api.setState({ mode: 'thinking', intensity: 1, source: 'agents' }); expect(api.getState().intensity).toBe(1);
    api.setState({ mode: 'replying', source: 'chat' }); expect(api.getState().mode).toBe('replying'); expect(api.getState().intensity).toBe(0);
    api.setState({ mode: 'idle', source: 'chat' }); expect(api.getState().intensity).toBe(1);
  });
});

describe('bot deltas, dedupe and account changes', () => {
  const BOT = 'a'.repeat(32), BOT2 = 'b'.repeat(32);
  it('upserts a bot moon from the autoagents.js delta sent on window, then updates and removes it', () => {
    const s = setup(); const api = s.api()!;
    s.winFire('echo-orb-satellites', { source: 'autoagents', action: 'created', botId: BOT, status: 'paused' });
    expect(api.satellites().map(m => [m.id, m.kind, m.status, m.busy])).toEqual([['bot:' + BOT, 'bot', 'paused', false]]);
    expect(api.getState().satellites).toBe(1);
    s.winFire('echo-orb-satellites', { source: 'autoagents', action: 'resume', botId: BOT, status: 'running' });
    expect(api.satellites()[0]).toMatchObject({ status: 'running', busy: true });
    s.winFire('echo-orb-satellites', { source: 'autoagents', action: 'delete', botId: BOT });
    expect(api.satellites()).toEqual([]);
  });
  it('names a delta-only bot by its short id and keeps a name the bots list already gave it', () => {
    const s = setup(); const api = s.api()!;
    s.winFire('echo-orb-satellites', { action: 'created', botId: BOT, status: 'idle' });
    s.frame(); const m = api.satellites()[0]; s.canvas.fire('pointermove', { clientX: m.sx, clientY: m.sy });
    expect(api.getState().hover!.name).toBe('bot aaaaaaaa');
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [s.sat('bot:' + BOT2, 'bot', { name: 'Ledger' })] });
    s.winFire('echo-orb-satellites', { source: 'bots', action: 'created', botId: BOT2, status: 'running' });
    expect(api.satellites().find(x => x.id === 'bot:' + BOT2)).toMatchObject({ status: 'running', busy: true });
    s.frame(); const l = api.satellites().find(x => x.id === 'bot:' + BOT2)!; s.canvas.fire('pointermove', { clientX: l.sx, clientY: l.sy });
    expect(api.getState().hover!.name).toBe('Ledger');
  });
  it('lets the next full bots list replace delta moons, so a bot deleted elsewhere does not linger', () => {
    const s = setup(); const api = s.api()!;
    s.winFire('echo-orb-satellites', { source: 'autoagents', action: 'created', botId: BOT, status: 'paused' });
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [s.sat('bot:' + BOT2, 'bot')] });
    expect(api.satellites().map(m => m.id)).toEqual(['bot:' + BOT2]);
  });
  it('ignores malformed deltas: unknown shapes, short ids, no action, deleting an absent bot', () => {
    const s = setup(); const api = s.api()!;
    expect(api.setSatellites({ action: 'created', botId: 'xyz' })).toBe(false);
    expect(api.setSatellites({ botId: BOT, status: 'running' })).toBe(false);
    expect(api.setSatellites({ action: 'delete', botId: BOT })).toBe(false);
    expect(api.setSatellites({ hello: 'world' })).toBe(false);
    s.winFire('echo-orb-satellites', { action: 'created', botId: BOT.toUpperCase() });
    expect(api.satellites()).toEqual([]);
  });
  it('orbits an id published by two sources once, and the busy copy wins', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [s.sat('bot:x', 'bot')] });
    s.dispatch('echo-orb-satellites', { source: 'fleet', satellites: [s.sat('bot:x', 'bot', { status: 'running' }), s.sat('bot:y', 'bot')] });
    const sats = api.satellites(); expect(sats.map(m => m.id).sort()).toEqual(['bot:x', 'bot:y']);
    expect(sats.find(m => m.id === 'bot:x')!.busy).toBe(true);
  });
  it('clears every moon when the account changes, so a signed-out page shows nothing orbiting', () => {
    const s = setup(); const api = s.api()!;
    s.dispatch('echo-orb-satellites', { source: 'agents', satellites: [s.sat('agent:a', 'agent')] });
    s.dispatch('echo-orb-satellites', { source: 'bots', satellites: [s.sat('bot:b', 'bot', { busy: true })] });
    expect(api.satellites()).toHaveLength(2);
    s.winFire('echo-account-changed'); expect(api.satellites()).toEqual([]); expect(api.getState().satellites).toBe(0);
    for (let i = 0; i < 10; i++) s.frame(); expect(api.arcs()).toEqual([]);
  });
});

describe('touch: the first tap names a moon, the second opens it', () => {
  function placed(s: ReturnType<typeof setup>) {
    const opened: unknown[] = []; s.doc.addEventListener('echo-orb-open', (e: unknown) => opened.push((e as CustomEvent).detail));
    s.dispatch('echo-orb-satellites', { satellites: [s.sat('bot:t', 'bot', { name: 'Tap Bot' })] }); s.frame();
    return { opened, m: s.api()!.satellites()[0] };
  }
  it('shows the name on the first tap without opening, opens on a second tap while the name shows', () => {
    const s = setup(); const { opened, m } = placed(s);
    const tip = () => s.stage.children.find(c => c.className === 'orb-tip');
    s.canvas.fire('pointerdown', { pointerType: 'touch' }); s.canvas.fire('click', { clientX: m.sx, clientY: m.sy });
    expect(opened).toEqual([]); expect(s.api()!.getState().hover!.name).toBe('Tap Bot'); expect(tip()!.hidden).toBe(false);
    s.canvas.fire('pointerleave', { pointerType: 'touch' }); expect(tip()!.hidden).toBe(false); // a lifted finger keeps the name up
    s.canvas.fire('pointerdown', { pointerType: 'touch' }); s.canvas.fire('click', { clientX: m.sx, clientY: m.sy });
    expect(opened).toEqual([{ id: 'bot:t', kind: 'bot' }]);
  });
  it('hides the name after a while and starts over, and a tap on empty space hides it', () => {
    const s = setup(); const { opened, m } = placed(s);
    s.canvas.fire('pointerdown', { pointerType: 'touch' }); s.canvas.fire('click', { clientX: m.sx, clientY: m.sy });
    vi.advanceTimersByTime(1700); expect(s.api()!.getState().hover).toBeNull();
    s.canvas.fire('pointerdown', { pointerType: 'touch' }); s.canvas.fire('click', { clientX: m.sx, clientY: m.sy }); expect(opened).toEqual([]);
    s.canvas.fire('pointerdown', { pointerType: 'touch' }); s.canvas.fire('click', { clientX: m.sx + 300, clientY: m.sy + 300 }); expect(s.api()!.getState().hover).toBeNull();
    s.canvas.fire('pointerdown', { pointerType: 'mouse' }); s.canvas.fire('click', { clientX: m.sx, clientY: m.sy }); expect(opened).toEqual([{ id: 'bot:t', kind: 'bot' }]);
  });
  it('ignores touch pointermove for hover, so a drag never opens on lift', () => {
    const s = setup(); const { m } = placed(s);
    s.canvas.fire('pointermove', { pointerType: 'touch', clientX: m.sx, clientY: m.sy }); expect(s.api()!.getState().hover).toBeNull();
    s.canvas.fire('pointermove', { pointerType: 'mouse', clientX: m.sx, clientY: m.sy }); expect(s.api()!.getState().hover!.id).toBe('bot:t');
  });
});

// ---------------------------------------------------------------- dispatch wiring in chat.js and workspace.js
const uiSource = (name: string) => readFileSync(new URL('../ui/echo-prime/' + name, import.meta.url), 'utf8');
type OrbEvent = { type: string; mode?: string; intensity?: number; source?: string; strength?: number };
const modes = (events: OrbEvent[]) => events.filter(e => e.type === 'echo-orb-state').map(e => e.mode);

describe('chat.js drives the orb through one ECHO Code turn', () => {
  class N { hidden = false; disabled = false; textContent = ''; className = ''; children: N[] = []; attrs: Record<string, string> = {};
    append(...n: N[]) { this.children.push(...n); } replaceChildren() { this.children = []; } setAttribute(k: string, v: string) { this.attrs[k] = v; } addEventListener() { /* unused */ } scrollIntoView() { /* unused */ } }
  function chatHarness(answer: unknown, fail = false) {
    const nodes = new Map<string, N>(), get = (sel: string) => { if (!nodes.has(sel)) nodes.set(sel, new N()); return nodes.get(sel)!; };
    const events: OrbEvent[] = [], timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    let release: () => void = () => { /* set below */ };
    const gate = new Promise<void>(r => { release = r; });
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/status') return { ok: true, status: 200, json: async () => ({ chat: { state: 'attached', busy: false } }) };
      if (url === '/api/chat') { await gate; if (fail) throw new Error('network down'); return { ok: true, status: 200, json: async () => answer }; }
      return { ok: false, status: 404, json: async () => ({ error: 'unexpected' }) };
    });
    const document = { querySelector: get, createElement: () => new N(), dispatchEvent: (e: CustomEvent) => { events.push({ type: e.type, ...(e.detail as object) }); return true; } };
    const window: Record<string, unknown> = { addEventListener() { /* unused */ }, dispatchEvent() { return true; } };
    runInNewContext(uiSource('chat.js'), { window, document, fetch, crypto: { randomUUID }, AbortController, Event, CustomEvent, console: { debug() { /* quiet */ } },
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length; }, clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; } });
    return { chat: window.EchoPrimeChat as { send(t: string): Promise<{ sent: boolean }>; reset(): void }, events, timers, release: () => release(), fetch };
  }
  const until = async (check: () => boolean) => { for (let i = 0; i < 50 && !check(); i++) await Promise.resolve(); };
  it('thinking on send, deep after 8 s, replying with a pulse on the answer, success, then idle', async () => {
    const h = chatHarness({ status: 'completed', answer: 'Done.', sessionId: 's1' });
    const turn = h.chat.send('build it');
    await until(() => h.fetch.mock.calls.some(c => c[0] === '/api/chat'));
    expect(modes(h.events)).toEqual(['thinking']);
    const deep = h.timers.find(t => t.ms === 8000)!; expect(deep).toBeDefined(); deep.fn();
    expect(modes(h.events)).toEqual(['thinking', 'deep']);
    h.release(); expect((await turn).sent).toBe(true);
    expect(modes(h.events)).toEqual(['thinking', 'deep', 'replying', 'success', 'idle']);
    expect(h.events.filter(e => e.type === 'echo-orb-pulse')).toHaveLength(1);
    expect(h.events.filter(e => e.type === 'echo-orb-state').every(e => e.source === 'chat')).toBe(true);
    expect(deep.cleared).toBe(true);
  });
  it('flashes error for a turn that did not complete and for a failed connection', async () => {
    const partial = chatHarness({ status: 'max_steps', answer: 'Stopped at the step cap.', sessionId: 's1' });
    const a = partial.chat.send('x'); await until(() => partial.fetch.mock.calls.length > 1); partial.release(); await a;
    expect(modes(partial.events)).toEqual(['thinking', 'replying', 'error', 'idle']);
    const broken = chatHarness(null, true);
    const b = broken.chat.send('x'); await until(() => broken.fetch.mock.calls.length > 1); broken.release(); expect((await b).sent).toBe(false);
    expect(modes(broken.events)).toEqual(['thinking', 'error', 'idle']);
  });
  it('returns the orb to idle on reset', () => {
    const h = chatHarness(null); h.chat.reset(); expect(modes(h.events)).toEqual(['idle']);
  });
});

describe('workspace.js drives the orb through a streamed Workspace turn', () => {
  beforeEach(() => { vi.useRealTimers(); });
  class Node {
    textContent = ''; value = ''; className = ''; hidden = false; disabled = false; checked = false; open = false; inert = false; isConnected = true;
    tagName: string; id = ''; dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; children: Node[] = []; parent: Node | null = null;
    events: Record<string, ((event: unknown) => unknown)[]> = {}; files: unknown[] = [];
    classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => false }; style = { setProperty: vi.fn() };
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
    append(...items: Node[]) { for (const item of items) { item.parent = this; this.children.push(item); } }
    replaceChildren(...items: Node[]) { for (const child of this.children) child.isConnected = false; this.children = []; this.append(...items); }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } this.isConnected = false; }
    setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === 'value') this.value = value; }
    getAttribute(key: string) { return this.attributes[key] ?? null; }
    addEventListener(name: string, callback: (event: unknown) => unknown) { (this.events[name] ??= []).push(callback); }
    showModal() { this.open = true; } close() { this.open = false; } focus() { /* unused */ } before() { /* unused */ } scrollIntoView() { /* unused */ }
    // workspace.js line() returns article.querySelector('p') and streams tokens into it, so tag lookup must work here.
    querySelector(sel: string): Node | null { const tag = sel.toUpperCase(); for (const c of this.children) { if (c.tagName === tag) return c; const f = c.querySelector(sel); if (f) return f; } return null; }
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
  }
  const session = { workspaceConfigured: true, authenticated: true, ownerAccess: true, csrf: 'owner', user: { uid: 'owner', role: 'owner', status: 'approved' } };
  const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  const ndjson = (lines: string[]) => new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l + '\n')); c.close(); } }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  function wsHarness(stream: string[], readback: (req: string | null) => unknown) {
    let req: string | null = null;
    const fetch = vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
      if (url === '/api/session') return json(session);
      if (url === '/api/workspace/state') return json({ chats: [], projects: [], library: [], preferences: [], personalities: [] });
      if (url === '/api/workspace/chats' && opts.method === 'POST') return json({ id: 'c1', title: 'New chat', messages: [], project_id: null });
      if (url === '/api/workspace/chat' && opts.method === 'POST') { req = JSON.parse(String(opts.body)).request_id; return ndjson(stream); }
      if (url.startsWith('/api/workspace/chats/c1')) return json(readback(req));
      return json({});
    });
    const nodes = new Map<string, Node>(), get = (sel: string) => { if (!nodes.has(sel)) nodes.set(sel, new Node()); return nodes.get(sel)!; };
    const events: OrbEvent[] = [], long: number[] = [], streamed: string[] = [];
    // echo-reply-stream proves the token handler ran to its end (the normal path, not the recovery path).
    const win: Record<string, unknown> = { addEventListener() { /* unused */ }, dispatchEvent(e: Event & { detail?: { text?: string } }) { if (e.type === 'echo-reply-stream') streamed.push(String(e.detail?.text)); return true; }, EchoPrimeChat: { reset() { /* unused */ } }, EchoPrimeModels: null, fetch };
    const document = { hidden: false, head: new Node(), querySelector: get, querySelectorAll: () => [], createElement: (t: string) => new Node(t), createTextNode: (t: string) => Object.assign(new Node('text'), { textContent: t }),
      createElementNS: (_n: string, t: string) => new Node(t), addEventListener() { /* unused */ }, dispatchEvent: (e: CustomEvent) => { events.push({ type: e.type, ...(e.detail as object) }); return true; } };
    // Short waits (recovery polling) run at once; the 8 s deep timer is recorded and never fires, so the tool count alone decides deep.
    const context = { window: win, document, localStorage: { getItem: () => null, setItem() { /* unused */ }, removeItem() { /* unused */ } }, matchMedia: () => ({ matches: false, addEventListener() { /* unused */ } }),
      navigator: { userAgent: 'fixture' }, location: { protocol: 'http:' }, crypto: { randomUUID },
      setTimeout: (fn: () => void, ms: number) => { if (ms >= 8000) { long.push(ms); return 0; } return setTimeout(fn, 0); }, clearTimeout, setInterval: () => 0, clearInterval() { /* unused */ },
      AbortController, AbortSignal, TextEncoder, TextDecoder, URL, Blob, Response, ReadableStream, Event, CustomEvent, Error, performance: { now: () => Date.now() }, console: { debug() { /* quiet */ } }, fetch };
    for (const file of ['activity.js', 'workspace-client.js', 'workspace.js']) runInNewContext(uiSource(file), context);
    get('#workspace-chat-kind').value = 'workspace';
    const ws = win.EchoPrimeWorkspace as { ready: Promise<unknown>; send(t: string): Promise<{ sent: boolean; verified: boolean }> };
    return { events, long, streamed, chatPosts: () => fetch.mock.calls.filter(c => c[0] === '/api/workspace/chats/c1').length, send: async (t: string) => { await ws.ready; return ws.send(t); } };
  }
  const started = (i: number, tool = 'workspace') => JSON.stringify({ type: 'tool_started', tool, request_id: 'r:tool:0:' + i, arguments: {} });
  const result = (i: number, tool = 'workspace') => JSON.stringify({ type: 'tool_result', tool, request_id: 'r:tool:0:' + i, result: { ok: true }, evidence: { status: 'observed', action: '', potential_side_effect: false } });
  const token = (text: string) => JSON.stringify({ type: 'token', text });
  const done = JSON.stringify({ type: 'done', chat: { id: 'c1', title: 't', messages: [{ id: 'u', role: 'user', content: 'q', request_id: 'x' }, { id: 'a', role: 'assistant', content: 'All good.', request_id: 'x:reply' }] } });
  const saved = (req: string | null) => ({ id: 'c1', title: 't', messages: [{ id: 'u', role: 'user', content: 'q', request_id: req }, { id: 'a', role: 'assistant', content: 'All good.', request_id: (req || '') + ':reply' }] });
  const none = () => ({ id: 'c1', title: 't', messages: [{ id: 'u', role: 'user', content: 'q', request_id: 'r' }] });
  it('thinking, then replying on the first token with a pulse per token, success after the readback, idle at the end', async () => {
    const h = wsHarness([token('All '), token('good.'), done], saved);
    expect(await h.send('q')).toMatchObject({ sent: true, verified: true, detail: 'Reply returned and saved conversation read back.' });
    expect(modes(h.events)).toEqual(['thinking', 'replying', 'success', 'idle']);
    expect(h.events.filter(e => e.type === 'echo-orb-pulse')).toHaveLength(2); expect(h.long).toEqual([8000]);
    expect(h.streamed).toEqual(['All ', 'good.']); expect(h.chatPosts()).toBe(1); // streamed to the end, one readback, no recovery polling
  });
  it('goes deep on the third tool call of one turn (a long tool loop) with rising intensity', async () => {
    const h = wsHarness([started(0), result(0), started(1), result(1), started(2), result(2), started(3), result(3), token('All good.'), done], saved);
    expect(await h.send('q')).toMatchObject({ detail: 'Reply returned and saved conversation read back.' }); expect(h.streamed).toEqual(['All good.']);
    expect(modes(h.events)).toEqual(['thinking', 'thinking', 'thinking', 'deep', 'deep', 'replying', 'success', 'idle']);
    const states = h.events.filter(e => e.type === 'echo-orb-state');
    expect(states[1].intensity).toBeCloseTo(1 / 3); expect(states[2].intensity).toBeCloseTo(2 / 3); expect(states[3].intensity).toBeCloseTo(.2); expect(states[4].intensity).toBeCloseTo(.4);
  });
  it('a dropped stream whose reply is recovered from the saved conversation ends in success, not error', async () => {
    const h = wsHarness([started(0), result(0), token('All')], saved);
    expect(await h.send('q')).toMatchObject({ sent: true, verified: true, detail: 'Reply recovered from the saved conversation after the connection dropped.' });
    expect(modes(h.events)).toEqual(['thinking', 'thinking', 'replying', 'success', 'idle']);
  });
  it('a dropped stream with nothing saved flashes error, then idle', async () => {
    const h = wsHarness([started(0), result(0)], none);
    expect((await h.send('q')).sent).toBe(false);
    expect(modes(h.events)).toEqual(['thinking', 'thinking', 'error', 'idle']);
  });
});
