import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../static/voice.js', import.meta.url), 'utf8');

function setup() {
  const observed = {calls: [], stopped: 0, requested: 0, clock: 0}, composer = {value: '', focus() {}};
  observed.status = {textContent: ''};
  observed.audio = Object.assign(new EventTarget(), {setAttribute() {}, removeAttribute() {}, load() {}, pause() { observed.paused = true; }, async play() {}});
  const track = {stop() { observed.stopped++; }}, stream = {getTracks: () => [track]};
  class AudioContext {
    sampleRate = 48000; destination = {};
    createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
    createScriptProcessor() { return observed.processor = {connect() {}, disconnect() {}, onaudioprocess: null}; }
    createGain() { return {gain: {}, connect() {}, disconnect() {}}; }
    async resume() {} async close() {}
  }
  const context = vm.createContext({window: {addEventListener() {}}, document: {querySelectorAll: selector => selector === '[data-voice-status]' ? [observed.status] : [], createElement: () => observed.audio, body: {append() {}}},
    localStorage: {getItem: () => null, setItem() {}}, navigator: {mediaDevices: {async getUserMedia(options) { observed.requested++; observed.constraints = options; return stream; }}},
    AudioContext, AbortController, setTimeout, clearTimeout, performance: {now: () => observed.clock}, crypto: {randomUUID: () => 'fixture-request-0001'},
    Float32Array, ArrayBuffer, DataView, Uint8Array, btoa: x => Buffer.from(x, 'binary').toString('base64'),
    state: {data: {csrf: 'fixture', voice: {configured: true}}, chat: {id: 'chat1'}, busy: false},
    $: () => composer, toast() {},
    fetch: async (url, options) => { observed.calls.push({url, body: JSON.parse(options.body)}); return {ok: true, json: async () => url.endsWith('/start') ? {session_id:'voice1',audio_url:'/audio/fixture.wav',has_more:false} : ({provider: 'elevenlabs-scribe', text: 'A spoken message.'})}; }});
  vm.runInContext(source, context);
  return {context, observed, composer, voice: context.window.echoVoice};
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('microphone is opt in; two second silence stops capture and sends bounded PCM audio', async () => {
  const {observed, voice, composer} = setup();
  assert.equal(observed.requested, 0);
  await voice.dictate();
  assert.equal(observed.constraints.audio.echoCancellation, true);
  assert.equal(observed.calls.length, 0);
  observed.processor.onaudioprocess({inputBuffer: {getChannelData: () => new Float32Array(4800).fill(.2)}});
  observed.clock = 1900;
  observed.processor.onaudioprocess({inputBuffer: {getChannelData: () => new Float32Array(4800)}});
  assert.equal(observed.stopped, 0);
  observed.clock = 2100;
  observed.processor.onaudioprocess({inputBuffer: {getChannelData: () => new Float32Array(4800)}});
  await settle();
  assert.equal(observed.stopped, 1);
  assert.equal(observed.calls.length, 1);
  const audio = Buffer.from(observed.calls[0].body.audio_b64, 'base64');
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.readUInt32LE(24), 16000);
  assert.equal(audio.readUInt16LE(22), 1);
  assert.ok(audio.length <= 262144);
  assert.equal(composer.value, 'A spoken message.');
});

test('Stop discards microphone capture without a provider request', async () => {
  const {observed, voice} = setup();
  await voice.dictate();
  observed.processor.onaudioprocess({inputBuffer: {getChannelData: () => new Float32Array(4800).fill(.2)}});
  voice.stopAll(); await settle();
  assert.equal(observed.stopped, 1);
  assert.equal(observed.calls.length, 0);
});


test('interrupting spoken playback clears Speaking status and cancels the voice session', async () => {
  const {observed, voice}=setup();
  const speaking=voice.speak({id:'reply1'},'chat1'); await settle();
  assert.match(observed.status.textContent,/Speaking/);
  voice.stopSpeech(); await speaking; await settle();
  assert.doesNotMatch(observed.status.textContent,/Speaking/);
  assert.equal(observed.paused,true);
  assert.equal(observed.calls.filter(c=>c.url.endsWith('/cancel')).length,1);
});
