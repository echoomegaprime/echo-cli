import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import vectors from './fixtures/sdk-hmac-canonical.json';
import {canonicalSdkParams,createSdkHmacAuth,SDK_HMAC_SECRET_ENV,SDK_HMAC_UNCONFIGURED} from '../src/bridge/sdk-hmac.js';

afterEach(()=>vi.unstubAllEnvs());
describe('SDK HMAC canonical source compatibility',()=>{
 it.each(vectors.vectors)('matches independent Python bytes and digest: $name',vector=>{
  vi.stubEnv(SDK_HMAC_SECRET_ENV,vectors.synthetic_hmac_secret_hex);
  const params=JSON.parse(vector.wire_json),serialized=canonicalSdkParams(params);
  expect(serialized).toBe(vector.canonical_params_json);
  const canonical='v1|'+vectors.api_key+'|'+vectors.capability+'|'+serialized+'|'+vectors.nonce+'|'+vectors.ts;
  expect(Buffer.from(canonical,'utf8').toString('hex')).toBe(vector.canonical_utf8_hex);
  expect(createHash('sha256').update(canonical).digest('hex')).toBe(vector.canonical_sha256);
  expect(createSdkHmacAuth(vectors.api_key,vectors.capability,params,vectors.nonce,vectors.ts)).toEqual({hmac:vector.hmac_sha256_hex,nonce:vectors.nonce,ts:vectors.ts});
 });
 it('uses the wire JSON representation of integral floats and negative zero',()=>{
  expect(canonicalSdkParams({one:1.0,zero:-0})).toBe('{"one":1,"zero":0}');
 });
 it('reads the secret at call time, refuses missing or invalid configuration, and emits only authentication fields',()=>{
  vi.stubEnv(SDK_HMAC_SECRET_ENV,'');expect(()=>createSdkHmacAuth('fake-key','echo.test.one',{})).toThrow(SDK_HMAC_UNCONFIGURED);
  vi.stubEnv(SDK_HMAC_SECRET_ENV,'not-a-secret');expect(()=>createSdkHmacAuth('fake-key','echo.test.one',{})).toThrow(SDK_HMAC_UNCONFIGURED);
  vi.stubEnv(SDK_HMAC_SECRET_ENV,vectors.synthetic_hmac_secret_hex);const first=createSdkHmacAuth('fake-key','echo.test.one',{});
  expect(Object.keys(first).sort()).toEqual(['hmac','nonce','ts']);expect(first.nonce).toMatch(/^[a-f0-9]{32}$/);expect(first.ts).toBeGreaterThan(0);
  const second=createSdkHmacAuth('fake-key','echo.test.one',{});expect(second.nonce).not.toBe(first.nonce);
  vi.stubEnv(SDK_HMAC_SECRET_ENV,'cd'.repeat(32));expect(createSdkHmacAuth('fake-key','echo.test.one',{},first.nonce,first.ts).hmac).not.toBe(first.hmac);
 });
 it('refuses data that cannot be encoded instead of choosing another signing form',()=>{
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic;expect(()=>canonicalSdkParams(cyclic)).toThrow('cannot be canonicalized');
 });
});
