import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync, existsSync} from 'node:fs';
const path = new URL('../static/esh-panel.js', import.meta.url);
function setup() {
  const context = vm.createContext({window: {}});
  if (existsSync(path)) vm.runInContext(readFileSync(path, 'utf8'), context);
  assert.ok(context.window.EchoEshPanel, 'ESH panel module must be installed');
  return context.window.EchoEshPanel;
}
test('autonomous ESH start and result become one receipt without executing output', () => {
  const {Ledger} = setup(), ledger = new Ledger();
  ledger.ingest('one', {type:'tool_started',tool:'esh',request_id:'r1',arguments:{command:'hostname'}});
  assert.equal(ledger.rows('one')[0].status, 'running');
  ledger.ingest('one', {type:'tool_result',tool:'esh',request_id:'r1',result:{ok:true,exit:0,stdout:'<script>alert(1)</script>',audit_id:'receipt-1'}});
  assert.equal(ledger.rows('one').length, 1);
  assert.equal(ledger.rows('one')[0].status, 'complete');
  assert.equal(ledger.rows('one')[0].result.stdout, '<script>alert(1)</script>');
  assert.equal(ledger.rows('one')[0].command, 'hostname');
});
test('reloaded manual action and tool receipts deduplicate and stay in their chat', () => {
  const {Ledger} = setup(), ledger = new Ledger();
  ledger.ingest('one', {kind:'action_receipt',content:JSON.stringify({action:'esh',request:{command:'hostname',request_id:'r1'},result:{ok:true,exit:0}})});
  ledger.ingest('one', {type:'tool_started',tool:'esh',request_id:'r1',arguments:{command:'hostname'}});
  ledger.ingest('one', {type:'tool_result',tool:'esh',request_id:'r1',result:{ok:true,exit:0}});
  ledger.ingest('two', {type:'tool_started',tool:'esh',request_id:'r2',arguments:{command:'Get-Date'}});
  assert.equal(ledger.rows('one').length,1);
  assert.equal(ledger.rows('two').length,1);
  assert.equal(ledger.rows('one')[0].status,'complete');
  assert.equal(ledger.rows('one')[0].command,'hostname');
});
test('failed and gated commands retain their real output and are never marked complete', () => {
  const {Ledger} = setup(), ledger = new Ledger();
  ledger.ingest('one', {type:'tool_result',tool:'esh',request_id:'r1',result:{ok:false,exit:2,stdout:'partial',stderr:'failure',verdict:'allowed'}});
  ledger.ingest('one', {type:'tool_result',tool:'esh',request_id:'r2',result:{ok:false,verdict:'gated',reason:'grant needed'}});
  assert.equal(ledger.rows('one')[0].status,'failed');
  assert.equal(ledger.rows('one')[0].result.stdout,'partial');
  assert.equal(ledger.rows('one')[1].status,'gated');
});
