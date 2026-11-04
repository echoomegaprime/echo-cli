import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync, existsSync} from 'node:fs';
const source = new URL('../static/layout.js', import.meta.url);
function setup() {
  const context = vm.createContext({window: {}});
  if (existsSync(source)) vm.runInContext(readFileSync(source, 'utf8'), context);
  assert.ok(context.window.EchoLayout, 'Layout module must be installed');
  return context.window.EchoLayout;
}
const viewport = {width:1280, height:800};
test('saved floating layout and right sidebar restore with exact geometry', () => {
  const {normalize} = setup();
  const saved = {version:1, side:'right', sidebar:310, dockHeight:220, mode:'float', rect:{x:400,y:100,width:600,height:360}};
  assert.equal(JSON.stringify(normalize(saved,viewport)), JSON.stringify(saved));
});
test('corrupt, unsupported and nonfinite saved geometry recovers safely', () => {
  const {normalize} = setup();
  for (const saved of [null, {version:9}, {version:1,side:'elsewhere',sidebar:NaN,mode:'bad',rect:{x:Infinity}}]) {
    const value=normalize(saved,viewport);
    assert.equal(value.mode,'dock'); assert.equal(value.side,'left');
    assert.ok(Number.isFinite(value.rect.x)); assert.ok(value.sidebar>=180);
  }
});
test('restoring on a smaller screen keeps the whole panel reachable', () => {
  const {normalize} = setup(), v={width:390,height:600};
  const s=normalize({version:1,mode:'float',rect:{x:1100,y:700,width:900,height:650}},v);
  assert.ok(s.rect.x>=8 && s.rect.y>=8);
  assert.ok(s.rect.x+s.rect.width<=v.width-8);
  assert.ok(s.rect.y+s.rect.height<=v.height-8);
  assert.ok(s.dockHeight<=v.height*.5);
});
test('moving and resizing cannot lose a panel outside the viewport', () => {
  const {clampRect,resizeRect} = setup();
  const a=clampRect({x:10000,y:-500,width:400,height:280},viewport);
  assert.equal(a.x,872); assert.equal(a.y,8);
  const b=resizeRect(a,'se',5000,5000,viewport);
  assert.ok(b.x+b.width<=1272 && b.y+b.height<=792);
  assert.ok(b.width>=300 && b.height>=180);
});
test('left and top resize preserve the opposite edge and enforce minimum size', () => {
  const {resizeRect} = setup(), r={x:300,y:200,width:600,height:400};
  const s=resizeRect(r,'nw',2000,2000,viewport);
  assert.equal(s.x+s.width,900); assert.equal(s.y+s.height,600);
  assert.equal(s.width,300); assert.equal(s.height,180);
});
test('invalid storage is ignored and a persisted layout round trips', () => {
  const {readLayout,writeLayout} = setup(), mem=new Map();
  const storage={getItem:k=>mem.get(k),setItem:(k,v)=>mem.set(k,v)};
  const initial=readLayout(storage,viewport);initial.side='right';initial.mode='float';
  writeLayout(storage,initial);
  assert.equal(readLayout(storage,viewport).side,'right');
  assert.equal(readLayout(storage,viewport).mode,'float');
  assert.equal(readLayout({getItem:()=>'{bad'},viewport).mode,'dock');
  assert.doesNotThrow(()=>writeLayout({setItem:()=>{throw Error('blocked')}},initial));
});
