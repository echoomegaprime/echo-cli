import {createHmac,randomBytes} from 'node:crypto';

export const SDK_HMAC_SECRET_ENV='ECHO_PRIME_SDK_HMAC_SECRET';
export const SDK_HMAC_UNCONFIGURED='SDK HMAC signer is unconfigured: ECHO_PRIME_SDK_HMAC_SECRET must contain 64 hexadecimal characters';
export interface SdkHmacAuth {hmac:string;nonce:string;ts:number}

function codePointOrder(a:string,b:string):number {
 const left=Array.from(a,c=>c.codePointAt(0)!),right=Array.from(b,c=>c.codePointAt(0)!);
 for(let i=0;i<Math.min(left.length,right.length);i++)if(left[i]!==right[i])return left[i]-right[i];
 return left.length-right.length;
}
function asciiString(value:string):string {
 return JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
function pythonNumber(value:number):string {
 const wire=JSON.stringify(value);
 // The gate parses a wire integer as Python int, including large integer spellings emitted by JSON.stringify.
 if(!/[.e]/.test(wire))return wire;
 const decimal=Math.abs(value)<0.0001&&value!==0?value.toExponential():wire;
 return decimal.replace(/e([+-]?)(\d+)$/,(_all,sign:string,power:string)=>'e'+(sign||'+')+power.padStart(2,'0'));
}
function canonical(value:unknown):string {
 if(value===null)return 'null';
 if(typeof value==='string')return asciiString(value);
 if(typeof value==='number'&&Number.isFinite(value))return pythonNumber(value);
 if(typeof value==='boolean')return String(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'){
  const obj=value as Record<string,unknown>;
  return '{'+Object.keys(obj).sort(codePointOrder).map(key=>asciiString(key)+':'+canonical(obj[key])).join(',')+'}';
 }
 throw new Error('SDK HMAC request cannot be canonicalized');
}
/** Python json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=True) over the actual wire-decoded params. */
export function canonicalSdkParams(params:Record<string,unknown>):string {
 try{return canonical(JSON.parse(JSON.stringify(params)));}
 catch{throw new Error('SDK HMAC request cannot be canonicalized');}
}
/** Nonce/time arguments are local test seams; the bridge never accepts them from a caller. Secret is read for each challenge. */
export function createSdkHmacAuth(apiKey:string,capability:string,params:Record<string,unknown>,nonce=randomBytes(16).toString('hex'),ts=Math.floor(Date.now()/1000)):SdkHmacAuth {
 const secret=(process.env[SDK_HMAC_SECRET_ENV]??'').trim();
 if(!/^[a-f0-9]{64}$/i.test(secret))throw new Error(SDK_HMAC_UNCONFIGURED);
 if(!/^[a-f0-9]{32}$/.test(nonce)||!Number.isSafeInteger(ts)||ts<0)throw new Error('SDK HMAC nonce or timestamp is invalid');
 const text='v1|'+apiKey+'|'+capability+'|'+canonicalSdkParams(params)+'|'+nonce+'|'+ts;
 const key=Buffer.from(secret,'hex');
 try{return {hmac:createHmac('sha256',key).update(text,'utf8').digest('hex'),nonce,ts};}
 finally{key.fill(0);}
}
