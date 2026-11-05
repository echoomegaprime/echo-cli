import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,readdir,readFile,rename,rm,stat,writeFile,type FileHandle} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {parse as parsePath,resolve,join} from 'node:path';
import {debuglog} from 'node:util';
import {deflateSync,inflateSync} from 'node:zlib';
import {redact} from '../code/workspace.js';
import {WorkspaceHttpError} from './workspace.js';

const debug=debuglog('echo-prime');

export const DEFAULT_UPLOAD_MAX_BYTES=200*1024*1024; // 200 MiB
export const ABSOLUTE_UPLOAD_MAX_BYTES=2*1024*1024*1024; // 2 GiB ceiling
export const TEXT_EXTRACT_FILE_CAP=2*1024*1024; // 2 MiB file cap for server-side text extraction
export const TEXT_EXTRACT_CHAR_CAP=64*1024; // 64 KiB extracted text cap per attachment

export const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX_MIME='application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const ALLOWED_UPLOAD_TYPES=[
 'image/png','image/jpeg','image/webp','image/gif',
 'video/mp4','video/webm','video/quicktime',
 'audio/mpeg','audio/wav',
 'application/pdf',
 'text/plain','text/markdown','text/csv','application/json',
 DOCX_MIME,XLSX_MIME,PPTX_MIME,
] as const;

export type AllowedUploadMime=(typeof ALLOWED_UPLOAD_TYPES)[number];
export type UploadKind='image'|'video'|'audio'|'document'|'file';

const TYPE_ALIASES:Record<string,AllowedUploadMime>={
 docx:DOCX_MIME,
 'application/docx':DOCX_MIME,
 xlsx:XLSX_MIME,
 'application/xlsx':XLSX_MIME,
 pptx:PPTX_MIME,
 'application/pptx':PPTX_MIME,
 'text/x-markdown':'text/markdown',
 'audio/mp3':'audio/mpeg',
 'audio/x-wav':'audio/wav',
 'audio/wave':'audio/wav',
};

const EXT_TO_MIME:Record<string,AllowedUploadMime>={
 '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif',
 '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
 '.mp3':'audio/mpeg','.wav':'audio/wav',
 '.pdf':'application/pdf',
 '.txt':'text/plain','.md':'text/markdown','.markdown':'text/markdown','.csv':'text/csv','.json':'application/json',
 '.docx':DOCX_MIME,'.xlsx':XLSX_MIME,'.pptx':PPTX_MIME,
};

const OOXML_ROOT:Record<string,string>={
 [DOCX_MIME]:'word/',
 [XLSX_MIME]:'xl/',
 [PPTX_MIME]:'ppt/',
};

const OOXML_EXT:Record<string,string>={
 [DOCX_MIME]:'.docx',
 [XLSX_MIME]:'.xlsx',
 [PPTX_MIME]:'.pptx',
};

const CREDENTIAL_NAME=/(?:^\.env(?:\.|$)|^id_(?:rsa|ed25519|ecdsa|dsa)|credentials?|secrets?|\.(?:pem|key|pfx|p12|kdbx|jks|keystore)$)/i;
const FORBIDDEN_EXT=/\.(?:exe|dll|msi|msp|scr|com|pif|bat|cmd|ps1|psm1|vbs|vbe|js|mjs|cjs|jse|wsf|wsh|hta|cpl|jar|war|ear|class|apk|ipa|dmg|pkg|app|deb|rpm|bin|run|elf|so|dylib|sys|drv|wasm|sh|bash|zsh|py|rb|pl|php|zip|tar|gz|tgz|bz2|tbz2|xz|txz|7z|rar|cab|iso|ar|zst|lz4)$/i;

export const UPLOAD_ID_RE=/^upl_[0-9a-f]{32}$/;
export const ARTIFACT_ID_RE=/^art_[0-9a-f]{32}$/;
export const STUDIO_INPUT_ROLES=['reference','init','mask','audio','script'] as const;
export type StudioInputRole=(typeof STUDIO_INPUT_ROLES)[number];

export interface UploadsConfig {
 root:string;
 maxBytes:number;
 types:AllowedUploadMime[];
}

export interface UploadMeta {
 id:string;
 name:string;
 type:AllowedUploadMime;
 bytes:number;
 sha256:string;
 created_at:string;
 updated_at?:string;
 owner:string;
 kind:UploadKind;
 width?:number;
 height?:number;
 duration?:number;
 pages?:number;
 exif_gps_stripped?:boolean;
 thumb?:boolean;
 tags?:string[];
}

export type ArtifactSource='studio'|'build'|'adk'|'chat_export'|'library'|'other';
export type ArtifactKind='image'|'video'|'music'|'sound'|'voice'|'code'|'proof'|'chat'|'document'|'other';

export interface ArtifactProvenance {
 source:ArtifactSource;
 prompt?:string;
 model?:string;
 capability?:string;
 run_id?:string;
 chat_id?:string;
 agent?:string;
 verdict?:string;
 events_sha256?:string;
 inputs?:Array<{upload_id:string;role:StudioInputRole}>;
}

export interface ArtifactRecord {
 id:string;
 title:string;
 kind:ArtifactKind;
 type:string;
 bytes:number;
 sha256?:string;
 created_at:string;
 owner:string;
 upload_id?:string;
 external_url?:string;
 summary?:string;
 tags:string[];
 provenance:ArtifactProvenance;
}

export class UploadError extends WorkspaceHttpError {}

function normalizeConfiguredType(raw:unknown):AllowedUploadMime{
 if(typeof raw!=='string')throw new Error('Invalid uploads configuration: type must be a string');
 const trimmed=raw.trim().toLowerCase();
 const mapped=TYPE_ALIASES[trimmed]??(trimmed as AllowedUploadMime);
 if(!(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(mapped)){
  throw new Error('Invalid uploads configuration: unsupported MIME type '+trimmed);
 }
 return mapped;
}

export function parseUploadsConfig(value:unknown):UploadsConfig{
 if(!value||typeof value!=='object'||Array.isArray(value)){
  throw new Error('Invalid uploads configuration: uploads must be an object');
 }
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input)){
  if(!['root','maxBytes','types'].includes(key)){
   throw new Error('Invalid uploads configuration: unknown field '+key);
  }
 }
 if(typeof input.root!=='string'||!input.root.trim()||[...input.root].some(c=>c.charCodeAt(0)<32)){
  throw new Error('Invalid uploads configuration: root must be a non-empty directory path');
 }
 const root=resolve(input.root.trim());
 if(root===parsePath(root).root){
  throw new Error('Invalid uploads configuration: root cannot be the filesystem root');
 }
 let maxBytes=DEFAULT_UPLOAD_MAX_BYTES;
 if(input.maxBytes!==undefined){
  if(typeof input.maxBytes!=='number'||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>ABSOLUTE_UPLOAD_MAX_BYTES){
   throw new Error('Invalid uploads configuration: maxBytes must be an integer between 1 and '+ABSOLUTE_UPLOAD_MAX_BYTES);
  }
  maxBytes=input.maxBytes;
 }
 let types:AllowedUploadMime[]=[...ALLOWED_UPLOAD_TYPES];
 if(input.types!==undefined){
  if(!Array.isArray(input.types)||!input.types.length||input.types.length>64){
   throw new Error('Invalid uploads configuration: types must be a non-empty array');
  }
  types=[...new Set(input.types.map(normalizeConfiguredType))];
 }
 return {root,maxBytes,types};
}

export function kindForMime(mime:string):UploadKind{
 if(mime.startsWith('image/'))return 'image';
 if(mime.startsWith('video/'))return 'video';
 if(mime.startsWith('audio/'))return 'audio';
 if(mime==='application/pdf'||mime.startsWith('text/')||mime==='application/json'||mime===DOCX_MIME||mime===XLSX_MIME||mime===PPTX_MIME){
  return 'document';
 }
 return 'file';
}

export function safeAccountSegment(owner:string):string{
 if(!owner||typeof owner!=='string'||!/^[A-Za-z0-9_.:@+-]{1,200}$/.test(owner)){
  throw new UploadError(400,'Invalid account owner');
 }
 if(/^[A-Za-z0-9_-]{1,80}$/.test(owner))return owner;
 const clean=owner.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,48);
 const suffix=createHash('sha256').update(owner).digest('hex').slice(0,16);
 return `${clean}_${suffix}`;
}

export function sanitizeUploadName(rawName:unknown):string{
 if(typeof rawName!=='string')throw new UploadError(400,'Upload file name required');
 const base=rawName.replace(/\\/g,'/').split('/').pop()?.trim()??'';
 const clean=[...base].filter(c=>c.charCodeAt(0)>=32&&c!=='"'&&c!=='<'&&c!=='>'&&c!=='|'&&c!==':'&&c!=='*'&&c!=='?').join('').trim();
 if(!clean||clean==='.'||clean==='..'||clean.length>180){
  throw new UploadError(400,'Invalid upload file name');
 }
 if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)){
  throw new UploadError(400,'Reserved upload file name refused');
 }
 if(CREDENTIAL_NAME.test(clean)){
  throw new UploadError(400,'Credential and key files are refused; store secrets in Vault');
 }
 if(FORBIDDEN_EXT.test(clean)){
  throw new UploadError(415,'Executables and archives are refused in v1');
 }
 return clean;
}

export function sanitizeTags(input:unknown):string[]{
 if(input===undefined||input===null||input==='')return [];
 const raw=typeof input==='string'?input.split(','):Array.isArray(input)?input:null;
 if(!raw)throw new UploadError(400,'Tags must be an array of strings');
 const out:string[]=[];
 for(const item of raw){
  if(typeof item!=='string')throw new UploadError(400,'Tags must be strings');
  const t=item.trim();
  if(!t)continue;
  if(t.length>40||!/^[A-Za-z0-9 _.:/-]{1,40}$/.test(t))throw new UploadError(400,'Invalid tag format');
  if(!out.includes(t))out.push(t);
  if(out.length>20)throw new UploadError(400,'At most 20 tags are allowed');
 }
 return out;
}

function extOf(name:string):string{
 const idx=name.lastIndexOf('.');
 return idx>=0?name.slice(idx).toLowerCase():'';
}

function resolveMime(declared:string|undefined,fileName:string,allowed:readonly AllowedUploadMime[]):AllowedUploadMime{
 const raw=(declared??'').split(';')[0].trim().toLowerCase();
 const ext=extOf(fileName);
 let candidate:AllowedUploadMime|undefined;
 if(!raw||raw==='application/octet-stream'){
  candidate=EXT_TO_MIME[ext];
 }else{
  candidate=TYPE_ALIASES[raw]??((ALLOWED_UPLOAD_TYPES as readonly string[]).includes(raw)?(raw as AllowedUploadMime):undefined);
 }
 if(!candidate)throw new UploadError(415,'Unsupported upload type');
 if(OOXML_EXT[candidate]&&ext!==OOXML_EXT[candidate]){
  throw new UploadError(415,'OOXML document extension must match its content type');
 }
 if(!allowed.includes(candidate)){
  throw new UploadError(415,'Upload type is not enabled in this Prime configuration');
 }
 return candidate;
}

/** Rejects executable and archive magic signatures on the opening bytes regardless of declared MIME. */
export function verifyMagicAndHygiene(head:Buffer,mime:AllowedUploadMime):void{
 if(head.length===0)throw new UploadError(400,'Empty uploads are refused');
 // Executable magic signatures: PE/MZ, ELF, Mach-O, WASM, Java class
 if((head.length>=2&&head[0]===0x4d&&head[1]===0x5a)||
    (head.length>=4&&head[0]===0x7f&&head[1]===0x45&&head[2]===0x4c&&head[3]===0x46)||
    (head.length>=4&&((head.readUInt32BE(0)===0xfeedface)||(head.readUInt32BE(0)===0xfeedfacf)||(head.readUInt32BE(0)===0xcefaedfe)||(head.readUInt32BE(0)===0xcffaedfe)))||
    (head.length>=4&&head[0]===0x00&&head[1]===0x61&&head[2]===0x73&&head[3]===0x6d)||
    (head.length>=4&&head.readUInt32BE(0)===0xcafebabe)){
  throw new UploadError(415,'Executable binary signature refused');
 }
 // Archive magic signatures: GZIP, BZIP2, 7z, RAR, XZ, ZSTD, CAB, TAR
 if((head.length>=2&&head[0]===0x1f&&head[1]===0x8b)||
    (head.length>=3&&head[0]===0x42&&head[1]===0x5a&&head[2]===0x68)||
    (head.length>=6&&head[0]===0x37&&head[1]===0x7a&&head[2]===0xbc&&head[3]===0xaf&&head[4]===0x27&&head[5]===0x1c)||
    (head.length>=6&&head.subarray(0,6).equals(Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07])))||
    (head.length>=6&&head.subarray(0,6).equals(Buffer.from([0xfd,0x37,0x7a,0x58,0x5a,0x00])))||
    (head.length>=4&&head.subarray(0,4).equals(Buffer.from([0x28,0xb5,0x2f,0xfd])))||
    (head.length>=4&&head.subarray(0,4).toString('ascii')==='MSCF')||
    (head.length>=262&&head.subarray(257,262).toString('ascii')==='ustar')){
  throw new UploadError(415,'Archive uploads are refused in v1');
 }
 const isZip=head.length>=4&&head[0]===0x50&&head[1]===0x4b&&(head[2]===0x03||head[2]===0x05||head[2]===0x07);
 const isOoxml=mime===DOCX_MIME||mime===XLSX_MIME||mime===PPTX_MIME;
 if(isZip&&!isOoxml){
  throw new UploadError(415,'ZIP archives are refused in v1');
 }
 if(isOoxml&&!isZip){
  throw new UploadError(415,'Invalid OOXML document header');
 }
 switch(mime){
  case 'image/png':
   if(head.length<24||!head.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))throw new UploadError(415,'Invalid PNG signature');
   break;
  case 'image/jpeg':
   if(head.length<4||head[0]!==0xff||head[1]!==0xd8||head[2]!==0xff)throw new UploadError(415,'Invalid JPEG signature');
   break;
  case 'image/gif':
   if(head.length<10||(head.subarray(0,6).toString('ascii')!=='GIF87a'&&head.subarray(0,6).toString('ascii')!=='GIF89a'))throw new UploadError(415,'Invalid GIF signature');
   break;
  case 'image/webp':
   if(head.length<16||head.subarray(0,4).toString('ascii')!=='RIFF'||head.subarray(8,12).toString('ascii')!=='WEBP')throw new UploadError(415,'Invalid WebP signature');
   break;
  case 'video/mp4':
  case 'video/quicktime':{
   if(head.length<12)throw new UploadError(415,'Invalid MP4/QuickTime header');
   const box=head.subarray(4,8).toString('ascii');
   if(!['ftyp','moov','mdat','wide','free','skip'].includes(box))throw new UploadError(415,'Invalid MP4/QuickTime container');
   break;
  }
  case 'video/webm':
   if(head.length<4||!head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))throw new UploadError(415,'Invalid WebM EBML header');
   break;
  case 'audio/wav':
   if(head.length<12||head.subarray(0,4).toString('ascii')!=='RIFF'||head.subarray(8,12).toString('ascii')!=='WAVE')throw new UploadError(415,'Invalid WAV header');
   break;
  case 'audio/mpeg':
   if(head.length<3)throw new UploadError(415,'Invalid MP3 header');
   if(head.subarray(0,3).toString('ascii')!=='ID3'&&!(head[0]===0xff&&(head[1]&0xe0)===0xe0))throw new UploadError(415,'Invalid MP3 frame or ID3 header');
   break;
  case 'application/pdf':
   if(head.length<5||head.subarray(0,5).toString('ascii')!=='%PDF-')throw new UploadError(415,'Invalid PDF header');
   break;
  case 'text/plain':
  case 'text/markdown':
  case 'text/csv':
  case 'application/json':
   if(head.includes(0))throw new UploadError(415,'Binary NUL byte refused in text upload');
   break;
 }
}

const TIFF_TYPE_BYTES:Record<number,number>={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8};

/**
 * Surgically removes the GPS Info IFD (tag 0x8825) and zeroes all GPS coordinate/value bytes
 * inside an Exif APP1 TIFF payload while preserving non-GPS EXIF fields (such as Orientation)
 * at their original TIFF offsets. Returns `{segment, stripped}` where `segment` is `null` if
 * a malformed Exif block or GPS-bearing XMP packet must be dropped fail-closed.
 */
export function sanitizeJpegApp1Payload(payload:Buffer):{payload:Buffer|null;stripped:boolean}{
 if(payload.length>=6&&payload.subarray(0,6).equals(Buffer.from('Exif\0\0','ascii'))){
  const out=Buffer.from(payload);
  const tiff=out.subarray(6);
  if(tiff.length<8)return {payload:null,stripped:true};
  const order=tiff.subarray(0,2).toString('ascii');
  if(order!=='II'&&order!=='MM')return {payload:null,stripped:true};
  const le=order==='II';
  const u16=(off:number)=>le?tiff.readUInt16LE(off):tiff.readUInt16BE(off);
  const u32=(off:number)=>le?tiff.readUInt32LE(off):tiff.readUInt32BE(off);
  const w16=(off:number,val:number)=>le?tiff.writeUInt16LE(val,off):tiff.writeUInt16BE(val,off);
  if(u16(2)!==42)return {payload:null,stripped:true};
  let ifdOffset=u32(4);
  let stripped=false;
  const visited=new Set<number>();
  for(let depth=0;depth<4&&ifdOffset>0;depth++){
   if(visited.has(ifdOffset)||ifdOffset+2>tiff.length)return {payload:null,stripped:true};
   visited.add(ifdOffset);
   let count=u16(ifdOffset);
   const tableEnd=ifdOffset+2+count*12+4;
   if(tableEnd>tiff.length)return {payload:null,stripped:true};
   const nextIfd=u32(ifdOffset+2+count*12);
   for(let i=0;i<count;i++){
    const entryOff=ifdOffset+2+i*12;
    const tag=u16(entryOff);
    if(tag===0x8825){
     stripped=true;
     const gpsIfdOff=u32(entryOff+8);
     if(gpsIfdOff>=8&&gpsIfdOff+2<=tiff.length){
      const gpsCount=u16(gpsIfdOff);
      const gpsEnd=gpsIfdOff+2+gpsCount*12+4;
      if(gpsEnd<=tiff.length){
       for(let g=0;g<gpsCount;g++){
        const gOff=gpsIfdOff+2+g*12;
        const gType=u16(gOff+2);
        const gNum=u32(gOff+4);
        const unit=TIFF_TYPE_BYTES[gType]??1;
        const total=unit*gNum;
        if(total>4&&total<=65536){
         const valOff=u32(gOff+8);
         if(valOff>=8&&valOff<tiff.length){
          tiff.fill(0,valOff,Math.min(tiff.length,valOff+total));
         }
        }
       }
       tiff.fill(0,gpsIfdOff,gpsEnd);
      }else{
       return {payload:null,stripped:true};
      }
     }
     // Shift remaining entries + nextIfd pointer left by 12 bytes so no external TIFF offset changes
     const tailStart=entryOff+12;
     const oldEnd=ifdOffset+2+count*12+4;
     tiff.copy(tiff,entryOff,tailStart,oldEnd);
     tiff.fill(0,oldEnd-12,oldEnd);
     count--;
     w16(ifdOffset,count);
     i--;
    }
   }
   ifdOffset=nextIfd;
  }
  return {payload:out,stripped};
 }
 // XMP packet inside APP1: strip if it carries exif:GPS tags
 const xmpHeader='http://ns.adobe.com/xap/1.0/\0';
 if(payload.length>xmpHeader.length&&payload.subarray(0,xmpHeader.length).toString('ascii')===xmpHeader){
  const xml=payload.subarray(xmpHeader.length).toString('utf8');
  if(/exif:GPS|GPSLatitude|GPSLongitude|GPSAltitude|GPSPosition/i.test(xml)){
   return {payload:null,stripped:true};
  }
 }
 return {payload,stripped:false};
}

/**
 * Pure helper (also exported for unit tests) that strips EXIF GPS from a complete JPEG buffer
 * and reports `{buffer, stripped, width, height}` using the exact streaming marker transformer.
 */
export function stripJpegExifGps(input:Buffer):{buffer:Buffer;stripped:boolean;width?:number;height?:number}{
 const out:Buffer[]=[];
 const transformer=new JpegHeaderTransformer(chunk=>{out.push(chunk);});
 transformer.push(input);
 transformer.end();
 return {buffer:Buffer.concat(out),stripped:transformer.stripped,width:transformer.width,height:transformer.height};
}

class JpegHeaderTransformer {
 stripped=false;
 width?:number;
 height?:number;
 private passthrough=false;
 private buf:Buffer=Buffer.alloc(0);
 private sawSoi=false;
 private headerBytes=0;
 constructor(private readonly emit:(chunk:Buffer)=>void){}
 push(chunk:Buffer):void{
  if(this.passthrough){this.emit(chunk);return;}
  this.buf=this.buf.length?Buffer.concat([this.buf,chunk]):chunk;
  this.process();
 }
 end():void{
  if(!this.passthrough&&this.buf.length){
   this.emit(this.buf);
   this.buf=Buffer.alloc(0);
  }
 }
 private process():void{
  while(!this.passthrough&&this.buf.length>0){
   if(!this.sawSoi){
    if(this.buf.length<2)return;
    if(this.buf[0]!==0xff||this.buf[1]!==0xd8)throw new UploadError(415,'Invalid JPEG SOI');
    this.sawSoi=true;
    this.emit(this.buf.subarray(0,2));
    this.buf=this.buf.subarray(2);
    continue;
   }
   if(this.buf[0]!==0xff){
    // Unexpected non-marker before SOS: switch to passthrough safely
    this.passthrough=true;
    this.emit(this.buf);
    this.buf=Buffer.alloc(0);
    return;
   }
   let i=0;
   while(i<this.buf.length&&this.buf[i]===0xff)i++;
   if(i>=this.buf.length)return; // need more bytes to see marker code
   const marker=this.buf[i];
   // Standalone markers without payload
   if(marker===0x00||marker===0x01||(marker>=0xd0&&marker<=0xd9)){
    const seg=this.buf.subarray(0,i+1);
    this.emit(seg);
    this.buf=this.buf.subarray(i+1);
    if(marker===0xd9){this.passthrough=true;if(this.buf.length){this.emit(this.buf);this.buf=Buffer.alloc(0);}return;}
    continue;
   }
   // Need 2-byte big-endian segment length
   if(this.buf.length<i+3)return;
   const segLen=this.buf.readUInt16BE(i+1);
   if(segLen<2)throw new UploadError(415,'Malformed JPEG marker segment');
   const totalSeg=i+1+segLen;
   if(this.buf.length<totalSeg){
    this.headerBytes+=0;
    if(totalSeg>2*1024*1024)throw new UploadError(415,'JPEG header exceeds bounded limit');
    return;
   }
   this.headerBytes+=totalSeg;
   if(this.headerBytes>4*1024*1024){
    throw new UploadError(415,'JPEG metadata segments exceed 4 MiB limit');
   }
   const payload=this.buf.subarray(i+3,totalSeg);
   if((marker===0xc0||marker===0xc1||marker===0xc2)&&payload.length>=5&&this.width===undefined){
    const h=payload.readUInt16BE(1),w=payload.readUInt16BE(3);
    if(w>0&&h>0){this.width=w;this.height=h;}
   }
   if(marker===0xe1){
    const res=sanitizeJpegApp1Payload(payload);
    if(res.stripped)this.stripped=true;
    if(res.payload!==null){
     const newLen=res.payload.length+2;
     const hdr=Buffer.from([0xff,0xe1,(newLen>>8)&0xff,newLen&0xff]);
     this.emit(hdr);
     this.emit(res.payload);
    }
   }else{
    this.emit(this.buf.subarray(0,totalSeg));
   }
   this.buf=this.buf.subarray(totalSeg);
   if(marker===0xda){
    // SOS reached: entropy-coded scan data follows until EOF, stream straight through!
    this.passthrough=true;
    if(this.buf.length){this.emit(this.buf);this.buf=Buffer.alloc(0);}
    return;
   }
  }
 }
}

function parseRasterDimensions(head:Buffer,mime:AllowedUploadMime):{width?:number;height?:number}{
 if(mime==='image/png'&&head.length>=24&&head.subarray(12,16).toString('ascii')==='IHDR'){
  const width=head.readUInt32BE(16),height=head.readUInt32BE(20);
  if(width>0&&height>0)return {width,height};
 }
 if(mime==='image/gif'&&head.length>=10){
  const width=head.readUInt16LE(6),height=head.readUInt16LE(8);
  if(width>0&&height>0)return {width,height};
 }
 if(mime==='image/webp'&&head.length>=30){
  const chunk=head.subarray(12,16).toString('ascii');
  if(chunk==='VP8X'){
   const width=1+head.readUIntLE(24,3),height=1+head.readUIntLE(27,3);
   if(width>0&&height>0)return {width,height};
  }else if(chunk==='VP8 '&&head.length>=30&&head[23]===0x9d&&head[24]===0x01&&head[25]===0x2a){
   const width=head.readUInt16LE(26)&0x3fff,height=head.readUInt16LE(28)&0x3fff;
   if(width>0&&height>0)return {width,height};
  }else if(chunk==='VP8L'&&head.length>=25&&head[20]===0x2f){
   const bits=head.readUInt32LE(21);
   const width=(bits&0x3fff)+1,height=((bits>>14)&0x3fff)+1;
   if(width>0&&height>0)return {width,height};
  }
 }
 return {};
}

function parseWavDuration(head:Buffer,totalBytes:number):number|undefined{
 if(head.length<44||head.subarray(0,4).toString('ascii')!=='RIFF'||head.subarray(8,12).toString('ascii')!=='WAVE')return undefined;
 let offset=12,byteRate=0,dataBytes=0;
 while(offset+8<=head.length){
  const id=head.subarray(offset,offset+4).toString('ascii');
  const size=head.readUInt32LE(offset+4);
  if(id==='fmt '&&offset+20<=head.length){
   byteRate=head.readUInt32LE(offset+16);
  }else if(id==='data'){
   dataBytes=size>0&&size<=totalBytes?size:Math.max(0,totalBytes-(offset+8));
   break;
  }
  offset+=8+size+(size%2);
 }
 if(byteRate>0&&dataBytes>0)return Math.round((dataBytes/byteRate)*100)/100;
 return undefined;
}

async function probeMp4Metadata(fh:FileHandle,totalBytes:number):Promise<{duration?:number;width?:number;height?:number}>{
 const readSlice=async(pos:number,len:number):Promise<Buffer>=>{
  const n=Math.max(0,Math.min(len,totalBytes-pos));
  if(n===0)return Buffer.alloc(0);
  const b=Buffer.alloc(n);
  const {bytesRead}=await fh.read(b,0,n,pos);
  return b.subarray(0,bytesRead);
 };
 let pos=0,moovPos=-1,moovSize=0;
 for(let boxes=0;boxes<64&&pos+8<=totalBytes;boxes++){
  const hdr=await readSlice(pos,16);
  if(hdr.length<8)break;
  let size=hdr.readUInt32BE(0);
  const type=hdr.subarray(4,8).toString('ascii');
  let headerLen=8;
  if(size===1){
   if(hdr.length<16)break;
   size=Number(hdr.readBigUInt64BE(8));
   headerLen=16;
  }else if(size===0){
   size=totalBytes-pos;
  }
  if(size<headerLen)break;
  if(type==='moov'){moovPos=pos+headerLen;moovSize=Math.min(size-headerLen,2*1024*1024);break;}
  pos+=size;
 }
 if(moovPos<0||moovSize<=0)return {};
 const moov=await readSlice(moovPos,moovSize);
 let duration:number|undefined,width:number|undefined,height:number|undefined;
 const walk=(buf:Buffer,depth:number)=>{
  if(depth>4)return;
  let off=0;
  while(off+8<=buf.length){
   const sz=buf.readUInt32BE(off);
   const tp=buf.subarray(off+4,off+8).toString('ascii');
   if(sz<8||off+sz>buf.length)break;
   const body=buf.subarray(off+8,off+sz);
   if(tp==='mvhd'&&body.length>=20){
    const version=body[0];
    if(version===0&&body.length>=20){
     const scale=body.readUInt32BE(12),dur=body.readUInt32BE(16);
     if(scale>0&&dur>0)duration=Math.round((dur/scale)*100)/100;
    }else if(version===1&&body.length>=32){
     const scale=body.readUInt32BE(20),dur=Number(body.readBigUInt64BE(24));
     if(scale>0&&dur>0)duration=Math.round((dur/scale)*100)/100;
    }
   }else if(tp==='tkhd'&&width===undefined){
    const version=body[0];
    const dimOff=version===1?88:76;
    if(body.length>=dimOff+8){
     const w=Math.round(body.readUInt32BE(dimOff)/65536);
     const h=Math.round(body.readUInt32BE(dimOff+4)/65536);
     if(w>0&&h>0){width=w;height=h;}
    }
   }else if(tp==='trak'||tp==='mdia'){
    walk(body,depth+1);
   }
   off+=sz;
  }
 };
 walk(moov,0);
 return {...(duration!==undefined?{duration}:{}),...(width!==undefined&&height!==undefined?{width,height}:{})};
}

/** Validates that an OOXML document is a genuine Office package and contains no VBA macros or embedded executables. */
async function validateOoxmlFile(filePath:string,totalBytes:number,mime:AllowedUploadMime):Promise<void>{
 const tailSize=Math.min(totalBytes,131072);
 const fh=await open(filePath,'r');
 try{
  const buf=Buffer.alloc(tailSize);
  const {bytesRead}=await fh.read(buf,0,tailSize,totalBytes-tailSize);
  const slice=buf.subarray(0,bytesRead);
  // Locate End of Central Directory (0x06054b50)
  let eocd=-1;
  for(let i=slice.length-22;i>=0;i--){
   if(slice[i]===0x50&&slice[i+1]===0x4b&&slice[i+2]===0x05&&slice[i+3]===0x06){eocd=i;break;}
  }
  if(eocd<0)throw new UploadError(415,'Malformed OOXML ZIP directory');
  const cdSize=slice.readUInt32LE(eocd+12);
  const cdOffset=slice.readUInt32LE(eocd+16);
  if(cdSize>4*1024*1024||cdOffset+cdSize>totalBytes)throw new UploadError(415,'Invalid OOXML central directory');
  const cd=Buffer.alloc(cdSize);
  await fh.read(cd,0,cdSize,cdOffset);
  let pos=0,hasContentTypes=false,hasRoot=false;
  const rootPrefix=OOXML_ROOT[mime];
  while(pos+46<=cd.length){
   if(cd.readUInt32LE(pos)!==0x02014b50)break;
   const nameLen=cd.readUInt16LE(pos+28),extraLen=cd.readUInt16LE(pos+30),commentLen=cd.readUInt16LE(pos+32);
   if(pos+46+nameLen>cd.length)break;
   const entryName=cd.subarray(pos+46,pos+46+nameLen).toString('utf8');
   if(entryName==='[Content_Types].xml')hasContentTypes=true;
   if(rootPrefix&&entryName.startsWith(rootPrefix))hasRoot=true;
   if(/vbaProject\.bin|\.(?:exe|dll|bat|cmd|ps1|vbs|js|scr|msi)$/i.test(entryName)){
    throw new UploadError(415,'OOXML macro or embedded executable refused');
   }
   pos+=46+nameLen+extraLen+commentLen;
  }
  if(!hasContentTypes||!hasRoot){
   throw new UploadError(415,'Archive does not match expected OOXML structure');
  }
 }finally{
  await fh.close();
 }
}

const CRC_TABLE=(()=>{
 const t=new Uint32Array(256);
 for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}
 return t;
})();
function crc32(buf:Buffer):number{
 let c=0xffffffff;
 for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8);
 return (c^0xffffffff)>>>0;
}
function pngChunk(type:string,data:Buffer):Buffer{
 const t=Buffer.from(type,'ascii');
 const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);
 const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])),0);
 return Buffer.concat([len,t,data,crc]);
}

/**
 * Dependency-free pure-JS PNG thumbnail generator using Node built-in `node:zlib`.
 * Decodes non-interlaced 8-bit RGB/RGBA PNGs up to 8 MiB / 4096px and downscales to <= 160px.
 * Returns null when the PNG uses exotic bit depths/palettes/interlacing so the server falls back to CSS scaling.
 */
function tryResizePngThumbnail(png:Buffer,maxEdge=160):Buffer|null{
 if(png.length>8*1024*1024||png.length<33)return null;
 const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
 const bitDepth=png[24],colorType=png[25],interlace=png[28];
 if(bitDepth!==8||(colorType!==2&&colorType!==6)||interlace!==0||width<1||height<1||width>4096||height>4096)return null;
 if(width<=maxEdge&&height<=maxEdge)return null;
 const bpp=colorType===6?4:3;
 const idatParts:Buffer[]=[];
 let off=8;
 while(off+8<=png.length){
  const len=png.readUInt32BE(off);
  const type=png.subarray(off+4,off+8).toString('ascii');
  if(off+12+len>png.length)return null;
  if(type==='IDAT')idatParts.push(png.subarray(off+8,off+8+len));
  else if(type==='IEND')break;
  off+=12+len;
 }
 if(!idatParts.length)return null;
 const stride=width*bpp;
 const expected=(stride+1)*height;
 let raw:Buffer;
 try{raw=inflateSync(Buffer.concat(idatParts),{maxOutputLength:expected+64});}catch{return null;}
 if(raw.length<expected)return null;
 const pixels=Buffer.alloc(width*height*bpp);
 const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<height;y++){
  const filter=raw[y*(stride+1)];
  const srcStart=y*(stride+1)+1,dstStart=y*stride,prevStart=(y-1)*stride;
  for(let x=0;x<stride;x++){
   const byte=raw[srcStart+x];
   const left=x>=bpp?pixels[dstStart+x-bpp]:0;
   const up=y>0?pixels[prevStart+x]:0;
   const upLeft=y>0&&x>=bpp?pixels[prevStart+x-bpp]:0;
   let recon=byte;
   if(filter===1)recon=(byte+left)&0xff;
   else if(filter===2)recon=(byte+up)&0xff;
   else if(filter===3)recon=(byte+((left+up)>>1))&0xff;
   else if(filter===4)recon=(byte+paeth(left,up,upLeft))&0xff;
   else if(filter!==0)return null;
   pixels[dstStart+x]=recon;
  }
 }
 const scale=Math.min(maxEdge/width,maxEdge/height);
 const dstW=Math.max(1,Math.round(width*scale)),dstH=Math.max(1,Math.round(height*scale));
 const outRaw=Buffer.alloc((dstW*bpp+1)*dstH);
 for(let dy=0;dy<dstH;dy++){
  const sy=Math.min(height-1,Math.floor(dy/scale));
  const rowOff=dy*(dstW*bpp+1);
  outRaw[rowOff]=0; // filter None
  for(let dx=0;dx<dstW;dx++){
   const sx=Math.min(width-1,Math.floor(dx/scale));
   const sIdx=(sy*width+sx)*bpp,dIdx=rowOff+1+dx*bpp;
   for(let c=0;c<bpp;c++)outRaw[dIdx+c]=pixels[sIdx+c];
  }
 }
 const ihdr=Buffer.alloc(13);
 ihdr.writeUInt32BE(dstW,0);ihdr.writeUInt32BE(dstH,4);
 ihdr[8]=8;ihdr[9]=colorType;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
 const compressed=deflateSync(outRaw,{level:6});
 return Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  pngChunk('IHDR',ihdr),
  pngChunk('IDAT',compressed),
  pngChunk('IEND',Buffer.alloc(0)),
 ]);
}

function decodePdfLiteralString(raw:string):string{
 let out='';
 for(let i=0;i<raw.length;i++){
  const ch=raw[i];
  if(ch!=='\\'){out+=ch;continue;}
  i++;if(i>=raw.length)break;
  const esc=raw[i];
  if(esc==='n')out+='\n';
  else if(esc==='r')out+='\r';
  else if(esc==='t')out+='\t';
  else if(esc==='b')out+='\b';
  else if(esc==='f')out+='\f';
  else if(esc==='\r'){if(raw[i+1]==='\n')i++;}
  else if(esc==='\n'){/* line continuation */}
  else if(esc>='0'&&esc<='7'){
   let oct=esc;
   if(raw[i+1]>='0'&&raw[i+1]<='7'){oct+=raw[++i];if(raw[i+1]>='0'&&raw[i+1]<='7')oct+=raw[++i];}
   out+=String.fromCharCode(parseInt(oct,8));
  }else out+=esc;
 }
 // Handle UTF-16BE BOM (\xFE\xFF)
 if(out.length>=2&&out.charCodeAt(0)===0xfe&&out.charCodeAt(1)===0xff){
  let u16='';
  for(let j=2;j+1<out.length;j+=2)u16+=String.fromCharCode((out.charCodeAt(j)<<8)|out.charCodeAt(j+1));
  return u16;
 }
 return out;
}

function decodePdfHexString(hex:string):string{
 const clean=hex.replace(/\s+/g,'');
 const padded=clean.length%2===1?clean+'0':clean;
 const bytes=Buffer.from(padded,'hex');
 if(bytes.length>=2&&bytes[0]===0xfe&&bytes[1]===0xff){
  let out='';
  for(let i=2;i+1<bytes.length;i+=2)out+=String.fromCharCode((bytes[i]<<8)|bytes[i+1]);
  return out;
 }
 return bytes.toString('latin1');
}

function extractTextFromPdfContentStream(content:string):string[]{
 const lines:string[]=[];
 const btBlocks=content.match(/BT[\s\S]*?ET/g)??[content];
 for(const block of btBlocks){
  let line='';
  // Scan tokens: (...) literal strings, <...> hex strings, [...] TJ arrays, Tj/'/"/Td/TD/T*
  let i=0;
  const readLiteral=():string=>{
   i++; // skip '('
   let depth=1,s='';
   while(i<block.length&&depth>0){
    const c=block[i++];
    if(c==='\\'){if(i<block.length)s+='\\'+block[i++];continue;}
    if(c==='('){depth++;s+=c;continue;}
    if(c===')'){depth--;if(depth>0)s+=c;continue;}
    s+=c;
   }
   return decodePdfLiteralString(s);
  };
  const pending:string[]=[];
  while(i<block.length){
   const c=block[i];
   if(c==='('){
    pending.push(readLiteral());
   }else if(c==='<'&&block[i+1]!=='<'){
    const end=block.indexOf('>',i+1);
    if(end<0)break;
    pending.push(decodePdfHexString(block.slice(i+1,end)));
    i=end+1;
   }else if(c==='['){
    i++;
    const arrParts:string[]=[];
    while(i<block.length&&block[i]!==']'){
     if(block[i]==='(')arrParts.push(readLiteral());
     else if(block[i]==='<'&&block[i+1]!=='<'){
      const end=block.indexOf('>',i+1);if(end<0)break;
      arrParts.push(decodePdfHexString(block.slice(i+1,end)));i=end+1;
     }else if(block[i]==='-'){
      let num='-';i++;while(i<block.length&&/[0-9.]/.test(block[i]))num+=block[i++];
      if(Number(num)<-120)arrParts.push(' ');
     }else i++;
    }
    if(block[i]===']')i++;
    pending.push(arrParts.join(''));
   }else if(/[A-Za-z*'"']/.test(c)){
    let op='';
    while(i<block.length&&/[A-Za-z0-9*'"']/.test(block[i]))op+=block[i++];
    if(op==='Tj'||op==='TJ'){
     line+=pending.join('');pending.length=0;
    }else if(op==="'"||op==='"'){
     if(line.trim())lines.push(line.trim());
     line=pending.slice(-1)[0]??'';pending.length=0;
    }else if(op==='T*'||op==='TD'||op==='Td'){
     if(line.trim()){lines.push(line.trim());line='';}
     pending.length=0;
    }else{
     pending.length=0;
    }
   }else{
    i++;
   }
  }
  if(line.trim())lines.push(line.trim());
 }
 return lines.filter(Boolean);
}

/**
 * Dependency-free PDF text extractor using Node's built-in `zlib.inflateSync` for `/FlateDecode`
 * content streams and `BT...ET` text operator parsing. Reports honestly when a PDF is encrypted,
 * image-only/scanned, or uses unsupported stream filters/ToUnicode CMap encodings.
 */
export function extractPdfText(pdf:Buffer):{extracted:boolean;text:string;reason?:string}{
 const raw=pdf.toString('latin1');
 if(/\/Encrypt\b/.test(raw)){
  return {extracted:false,text:'',reason:'text not extracted: encrypted PDF'};
 }
 const chunks:string[]=[];
 let pos=0;
 while(pos<raw.length){
  const streamIdx=raw.indexOf('stream',pos);
  if(streamIdx<0)break;
  const dictStart=Math.max(0,raw.lastIndexOf('<<',streamIdx));
  const dict=raw.slice(dictStart,streamIdx);
  let dataStart=streamIdx+6;
  if(raw[dataStart]==='\r'&&raw[dataStart+1]==='\n')dataStart+=2;
  else if(raw[dataStart]==='\n'||raw[dataStart]==='\r')dataStart+=1;
  else{pos=streamIdx+6;continue;}
  const endIdx=raw.indexOf('endstream',dataStart);
  if(endIdx<0)break;
  pos=endIdx+9;
  if(/\/Subtype\s*\/Image\b/.test(dict)||/\/Type\s*\/(?:XRef|ObjStm|Metadata)\b/.test(dict))continue;
  let endData=endIdx;
  if(raw[endData-2]==='\r'&&raw[endData-1]==='\n')endData-=2;
  else if(raw[endData-1]==='\n'||raw[endData-1]==='\r')endData-=1;
  const slice=pdf.subarray(dataStart,endData);
  let decoded:string|null=null;
  if(/\/FlateDecode\b/.test(dict)){
   if(/\/(?:ASCII85Decode|LZWDecode|DCTDecode|JPXDecode|JBIG2Decode|CCITTFaxDecode)\b/.test(dict))continue;
   try{decoded=inflateSync(slice,{maxOutputLength:2*1024*1024}).toString('latin1');}catch{decoded=null;}
  }else if(!/\/Filter\b/.test(dict)){
   decoded=slice.toString('latin1');
  }
  if(decoded&&/\bBT\b/.test(decoded)){
   for(const line of extractTextFromPdfContentStream(decoded)){
    chunks.push(line);
    if(chunks.join('\n').length>=TEXT_EXTRACT_CHAR_CAP)break;
   }
  }
  if(chunks.join('\n').length>=TEXT_EXTRACT_CHAR_CAP)break;
 }
 const joined=[...chunks.join('\n')].filter(ch=>{
  const code=ch.charCodeAt(0);
  return code===9||code===10||code===13||(code>=32&&code!==127);
 }).join('').trim();
 if(!joined){
  return {extracted:false,text:'',reason:'text not extracted: PDF contains no extractable text streams (scanned or custom font map)'};
 }
 return {extracted:true,text:joined.slice(0,TEXT_EXTRACT_CHAR_CAP)};
}

function contentDisposition(mode:'inline'|'attachment',name:string):string{
 const ascii=name.replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_');
 const encoded=encodeURIComponent(name);
 return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function parseMultipartBoundary(contentType:string):string|null{
 const match=/^multipart\/form-data\s*;\s*boundary=(?:"([^"]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))/i.exec(contentType.trim());
 return match?(match[1]??match[2]??null):null;
}

function parsePartHeaders(raw:string):{name?:string;filename?:string;contentType?:string}{
 const out:{name?:string;filename?:string;contentType?:string}={};
 for(const line of raw.split('\r\n')){
  const idx=line.indexOf(':');
  if(idx<0)continue;
  const k=line.slice(0,idx).trim().toLowerCase(),v=line.slice(idx+1).trim();
  if(k==='content-type')out.contentType=v;
  else if(k==='content-disposition'){
   const nameMatch=/\bname="([^"]*)"/i.exec(v);
   if(nameMatch)out.name=nameMatch[1];
   const fnStar=/\bfilename\*=UTF-8''([^;\s]+)/i.exec(v);
   const fnMatch=/\bfilename="([^"]*)"/i.exec(v);
   if(fnStar){try{out.filename=decodeURIComponent(fnStar[1]);}catch{out.filename=fnStar[1];}}
   else if(fnMatch)out.filename=fnMatch[1];
  }
 }
 return out;
}

class StreamingFileWriter {
 bytes=0;
 readonly hash=createHash('sha256');
 head=Buffer.alloc(0);
 magicChecked=false;
 jpeg?:JpegHeaderTransformer;
 private pdfCarry='';
 pdfPages=0;
 private writeChain:Promise<void>=Promise.resolve();
 private writeErr:Error|null=null;

 constructor(
  private readonly fh:FileHandle,
  private readonly mime:AllowedUploadMime,
  private readonly maxBytes:number,
 ){
  if(mime==='image/jpeg'){
   this.jpeg=new JpegHeaderTransformer(out=>{this.enqueueWrite(out);});
  }
 }

 private enqueueWrite(chunk:Buffer):void{
  if(!chunk.length||this.writeErr)return;
  this.bytes+=chunk.length;
  if(this.bytes>this.maxBytes){
   this.writeErr=new UploadError(413,`Upload exceeds maximum size of ${this.maxBytes} bytes`);
   return;
  }
  this.hash.update(chunk);
  if(this.mime==='application/pdf'){
   const windowText=this.pdfCarry+chunk.toString('latin1');
   const pending=/\/(?:T(?:y(?:p(?:e(?:\s{0,16}(?:\/(?:P(?:a(?:g(?:e(?:s)?)?)?)?)?)?)?)?)?)?)?$/.exec(windowText);
   const scanPart=pending?windowText.slice(0,pending.index):windowText;
   this.pdfCarry=pending?windowText.slice(pending.index):'';
   const matches=scanPart.match(/\/Type\s*\/Page\b(?!s)/g);
   if(matches)this.pdfPages+=matches.length;
  }
  const copy=Buffer.from(chunk);
  this.writeChain=this.writeChain.then(async()=>{
   if(this.writeErr)return;
   let off=0;
   while(off<copy.length){
    const {bytesWritten}=await this.fh.write(copy,off,copy.length-off);
    off+=bytesWritten;
   }
  }).catch(err=>{
   if(!this.writeErr)this.writeErr=err instanceof Error?err:new Error('Disk write failed');
  });
 }

 async write(chunk:Buffer):Promise<void>{
  if(!chunk.length)return;
  if(this.head.length<512){
   const need=Math.min(512-this.head.length,chunk.length);
   this.head=Buffer.concat([this.head,chunk.subarray(0,need)]);
  }
  if(!this.magicChecked&&this.head.length>=16){
   verifyMagicAndHygiene(this.head,this.mime);
   this.magicChecked=true;
  }
  if(this.mime==='text/plain'||this.mime==='text/markdown'||this.mime==='text/csv'||this.mime==='application/json'){
   if(chunk.includes(0))throw new UploadError(415,'Binary NUL byte refused in text upload');
  }
  if(this.jpeg){
   this.jpeg.push(chunk);
  }else{
   this.enqueueWrite(chunk);
  }
  await this.writeChain;
  if(this.writeErr)throw this.writeErr;
 }

 async finish():Promise<{bytes:number;sha256:string;head:Buffer;width?:number;height?:number;pages?:number;exifStripped?:boolean}>{
  if(!this.magicChecked){
   verifyMagicAndHygiene(this.head,this.mime);
   this.magicChecked=true;
  }
  if(this.jpeg)this.jpeg.end();
  if(this.mime==='application/pdf'&&this.pdfCarry){
   const matches=this.pdfCarry.match(/\/Type\s*\/Page\b(?!s)/g);
   if(matches)this.pdfPages+=matches.length;
   this.pdfCarry='';
  }
  await this.writeChain;
  if(this.writeErr)throw this.writeErr;
  if(this.bytes===0)throw new UploadError(400,'Empty uploads are refused');
  await this.fh.sync();
  const dims=this.jpeg?{width:this.jpeg.width,height:this.jpeg.height}:parseRasterDimensions(this.head,this.mime);
  return {
   bytes:this.bytes,
   sha256:this.hash.digest('hex'),
   head:this.head,
   ...(dims.width&&dims.height?{width:dims.width,height:dims.height}:{}),
   ...(this.mime==='application/pdf'?{pages:Math.max(1,this.pdfPages)}:{}),
   ...(this.jpeg?.stripped?{exifStripped:true}:{}),
  };
 }
}

async function atomicWriteJson(targetPath:string,value:unknown):Promise<void>{
 const tmp=`${targetPath}.${randomUUID()}.tmp`;
 await writeFile(tmp,JSON.stringify(value,null,2),'utf8');
 await rename(tmp,targetPath);
}

export class UploadStore {
 readonly config:UploadsConfig;
 constructor(config:UploadsConfig){
  this.config=config;
 }

 private accountRoot(owner:string):string{
  return join(this.config.root,safeAccountSegment(owner));
 }

 private uploadDir(owner:string,id:string):string{
  if(!UPLOAD_ID_RE.test(id))throw new UploadError(400,'Invalid upload id');
  return join(this.accountRoot(owner),id);
 }

 private artifactRoot(owner:string):string{
  return join(this.accountRoot(owner),'_artifacts');
 }

 private artifactDir(owner:string,id:string):string{
  if(!ARTIFACT_ID_RE.test(id))throw new UploadError(400,'Invalid artifact id');
  return join(this.artifactRoot(owner),id);
 }

 async handleUpload(req:IncomingMessage,owner:string):Promise<UploadMeta>{
  const id='upl_'+randomBytes(16).toString('hex');
  const acctDir=this.accountRoot(owner);
  const tmpDir=join(acctDir,`.tmp_${randomUUID()}`);
  await mkdir(tmpDir,{recursive:true});
  const blobPath=join(tmpDir,'blob');
  const started=Date.now();
  debug('%j',{schemaVersion:1,event:'prime_upload_started',uploadId:id,owner:safeAccountSegment(owner)});

  let fh:FileHandle|undefined;
  let writer:StreamingFileWriter|undefined;
  let finalName='';
  let finalMime:AllowedUploadMime|undefined;
  let customName='';
  let rawTags='';

  try{
   const ct=String(req.headers['content-type']??'');
   const boundary=ct.toLowerCase().startsWith('multipart/form-data')?parseMultipartBoundary(ct):null;

   if(ct.toLowerCase().startsWith('multipart/form-data')&&!boundary){
    throw new UploadError(400,'Missing multipart boundary');
   }

   if(boundary){
    const firstDelim=Buffer.from(`--${boundary}`);
    const nextDelim=Buffer.from(`\r\n--${boundary}`);
    const tailKeep=nextDelim.length+4;
    let state:'preamble'|'headers'|'file'|'field'|'done'='preamble';
    let buf=Buffer.alloc(0);
    let currentField='';
    let fieldValue='';
    let rawIncomingBytes=0;

    for await(const rawChunk of req){
     const chunk=Buffer.isBuffer(rawChunk)?rawChunk:Buffer.from(rawChunk);
     rawIncomingBytes+=chunk.length;
     if(rawIncomingBytes>this.config.maxBytes+262144){
      throw new UploadError(413,`Upload exceeds maximum size of ${this.config.maxBytes} bytes`);
     }
     if(state==='done')continue;
     buf=buf.length?Buffer.concat([buf,chunk]):chunk;

     for(;;){
      if(state==='preamble'){
       const idx=buf.indexOf(firstDelim);
       if(idx<0){
        if(buf.length>8192)throw new UploadError(400,'Malformed multipart preamble');
        break;
       }
       const after=idx+firstDelim.length;
       if(buf.length<after+2)break;
       const suffix=buf.subarray(after,after+2).toString('ascii');
       if(suffix==='--'){state='done';buf=Buffer.alloc(0);break;}
       if(suffix!=='\r\n')throw new UploadError(400,'Malformed multipart boundary');
       buf=buf.subarray(after+2);
       state='headers';
      }else if(state==='headers'){
       const hdrEnd=buf.indexOf('\r\n\r\n');
       if(hdrEnd<0){
        if(buf.length>16384)throw new UploadError(400,'Multipart part headers exceed 16 KiB');
        break;
       }
       const parsed=parsePartHeaders(buf.subarray(0,hdrEnd).toString('utf8'));
       buf=buf.subarray(hdrEnd+4);
       if(parsed.filename!==undefined){
        if(writer)throw new UploadError(400,'Upload one file per request');
        finalName=sanitizeUploadName(parsed.filename);
        finalMime=resolveMime(parsed.contentType,finalName,this.config.types);
        fh=await open(blobPath,'w',0o600);
        writer=new StreamingFileWriter(fh,finalMime,this.config.types.includes(finalMime)?this.config.maxBytes:0);
        state='file';
       }else{
        currentField=parsed.name??'';
        fieldValue='';
        state='field';
       }
      }else if(state==='file'){
       const idx=buf.indexOf(nextDelim);
       if(idx<0){
        if(buf.length>tailKeep){
         const safeLen=buf.length-tailKeep;
         await writer!.write(buf.subarray(0,safeLen));
         buf=buf.subarray(safeLen);
        }
        break;
       }
       const after=idx+nextDelim.length;
       if(buf.length<after+2)break;
       if(idx>0)await writer!.write(buf.subarray(0,idx));
       const suffix=buf.subarray(after,after+2).toString('ascii');
       buf=buf.subarray(after+2);
       if(suffix==='--'){state='done';buf=Buffer.alloc(0);break;}
       if(suffix!=='\r\n')throw new UploadError(400,'Malformed multipart closing boundary');
       state='headers';
      }else if(state==='field'){
       const idx=buf.indexOf(nextDelim);
       if(idx<0){
        if(buf.length>8192)throw new UploadError(400,'Multipart metadata field exceeds 8 KiB');
        break;
       }
       const after=idx+nextDelim.length;
       if(buf.length<after+2)break;
       fieldValue+=buf.subarray(0,idx).toString('utf8');
       if(currentField==='name')customName=fieldValue.trim();
       else if(currentField==='tags')rawTags=fieldValue.trim();
       const suffix=buf.subarray(after,after+2).toString('ascii');
       buf=buf.subarray(after+2);
       if(suffix==='--'){state='done';buf=Buffer.alloc(0);break;}
       if(suffix!=='\r\n')throw new UploadError(400,'Malformed multipart boundary');
       state='headers';
      }else break;
     }
    }
    if(state!=='done'||!writer||!finalMime){
     throw new UploadError(400,'Incomplete multipart upload');
    }
   }else{
    // Raw / chunked streaming upload using headers X-Upload-Name and X-Upload-Type / Content-Type
    const headerName=req.headers['x-upload-name']??req.headers['x-upload-filename'];
    const rawHeaderName=typeof headerName==='string'?(()=>{try{return decodeURIComponent(headerName);}catch{return headerName;}})():'';
    finalName=sanitizeUploadName(rawHeaderName);
    const declaredType=typeof req.headers['x-upload-type']==='string'?req.headers['x-upload-type']:ct;
    finalMime=resolveMime(declaredType,finalName,this.config.types);
    if(typeof req.headers['x-upload-tags']==='string'){
     const rawTagHdr=req.headers['x-upload-tags'];
     rawTags=(()=>{try{return decodeURIComponent(rawTagHdr);}catch{return rawTagHdr;}})();
    }
    fh=await open(blobPath,'w',0o600);
    writer=new StreamingFileWriter(fh,finalMime,this.config.maxBytes);
    for await(const rawChunk of req){
     const chunk=Buffer.isBuffer(rawChunk)?rawChunk:Buffer.from(rawChunk);
     await writer.write(chunk);
    }
   }

   if(customName){
    const sanitizedCustom=sanitizeUploadName(customName);
    if(OOXML_EXT[finalMime]&&extOf(sanitizedCustom)!==OOXML_EXT[finalMime]){
     throw new UploadError(415,'Custom file name extension must match OOXML document type');
    }
    finalName=sanitizedCustom;
   }
   const tags=sanitizeTags(rawTags);
   const finished=await writer.finish();
   await fh!.close();
   fh=undefined;

   // Post-stream format checks that inspect bounded slices on disk
   let duration:number|undefined;
   let width=finished.width;
   let height=finished.height;

   if(finalMime==='application/json'&&finished.bytes<=10*1024*1024){
    const rawJson=await readFile(blobPath);
    try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawJson));}
    catch{throw new UploadError(415,'Invalid JSON upload');}
   }else if(finalMime==='text/plain'||finalMime==='text/markdown'||finalMime==='text/csv'){
    if(finished.bytes<=10*1024*1024){
     const rawTxt=await readFile(blobPath);
     try{new TextDecoder('utf-8',{fatal:true}).decode(rawTxt);}
     catch{throw new UploadError(415,'Text upload must be valid UTF-8');}
    }
   }else if(finalMime===DOCX_MIME||finalMime===XLSX_MIME||finalMime===PPTX_MIME){
    await validateOoxmlFile(blobPath,finished.bytes,finalMime);
   }else if(finalMime==='audio/wav'){
    duration=parseWavDuration(finished.head,finished.bytes);
   }else if(finalMime==='video/mp4'||finalMime==='video/quicktime'){
    const probeFh=await open(blobPath,'r');
    try{
     const probed=await probeMp4Metadata(probeFh,finished.bytes);
     if(probed.duration!==undefined)duration=probed.duration;
     if(probed.width&&probed.height){width=probed.width;height=probed.height;}
    }finally{await probeFh.close();}
   }

   let thumb=false;
   if(finalMime==='image/png'&&finished.bytes<=8*1024*1024){
    try{
     const pngBytes=await readFile(blobPath);
     // Also check UTF-8/CRC basic structure via thumb generator
     const resized=tryResizePngThumbnail(pngBytes,160);
     if(resized){
      await writeFile(join(tmpDir,'thumb.png'),resized,{mode:0o600});
      thumb=true;
     }
    }catch{thumb=false;}
   }

   if(finished.exifStripped){
    debug('%j',{schemaVersion:1,event:'prime_upload_exif_stripped',uploadId:id});
   }

   const meta:UploadMeta={
    id,
    name:finalName,
    type:finalMime,
    bytes:finished.bytes,
    sha256:finished.sha256,
    created_at:new Date().toISOString(),
    owner,
    kind:kindForMime(finalMime),
    ...(width!==undefined&&height!==undefined?{width,height}:{}),
    ...(duration!==undefined?{duration}:{}),
    ...(finished.pages!==undefined?{pages:finished.pages}:{}),
    ...(finished.exifStripped?{exif_gps_stripped:true}:{}),
    ...(thumb?{thumb:true}:{}),
    ...(tags.length?{tags}:{}),
   };

   await atomicWriteJson(join(tmpDir,'meta.json'),meta);
   const finalDir=this.uploadDir(owner,id);
   await rename(tmpDir,finalDir);
   debug('%j',{schemaVersion:1,event:'prime_upload_completed',uploadId:id,kind:meta.kind,type:meta.type,bytes:meta.bytes,durationMs:Date.now()-started});
   return meta;
  }catch(error){
   if(fh)await fh.close().catch(()=>{});
   await rm(tmpDir,{recursive:true,force:true}).catch(()=>{});
   const status=error instanceof UploadError?error.status:400;
   debug('%j',{schemaVersion:1,event:'prime_upload_refused',uploadId:id,status,durationMs:Date.now()-started});
   if(error instanceof UploadError)throw error;
   throw new UploadError(400,'Upload failed');
  }
 }

 private async readMeta(owner:string,id:string):Promise<UploadMeta>{
  const dir=this.uploadDir(owner,id);
  let raw:string;
  try{raw=await readFile(join(dir,'meta.json'),'utf8');}
  catch{throw new UploadError(404,'Upload not found');}
  let parsed:UploadMeta;
  try{parsed=JSON.parse(raw) as UploadMeta;}
  catch{throw new UploadError(500,'Corrupt upload metadata');}
  if(parsed.id!==id||parsed.owner!==owner)throw new UploadError(404,'Upload not found');
  return parsed;
 }

 async get(owner:string,id:string):Promise<UploadMeta>{
  return this.readMeta(owner,id);
 }

 async list(owner:string,filter:{kind?:string;q?:string}={}):Promise<UploadMeta[]>{
  const acctDir=this.accountRoot(owner);
  let entries:string[];
  try{entries=await readdir(acctDir);}
  catch{return [];}
  const metas:UploadMeta[]=[];
  for(const entry of entries){
   if(!UPLOAD_ID_RE.test(entry))continue;
   try{
    const meta=await this.readMeta(owner,entry);
    if(filter.kind&&filter.kind!=='all'&&meta.kind!==filter.kind)continue;
    if(filter.q){
     const needle=filter.q.trim().toLowerCase();
     const hay=`${meta.name} ${(meta.tags??[]).join(' ')} ${meta.type}`.toLowerCase();
     if(needle&&!hay.includes(needle))continue;
    }
    metas.push(meta);
   }catch{/* skip removed/in-flight */}
  }
  metas.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  return metas.slice(0,500);
 }

 async update(owner:string,id:string,patch:unknown):Promise<UploadMeta>{
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new UploadError(400,'Invalid upload update');
  const data=patch as Record<string,unknown>;
  for(const k of Object.keys(data))if(!['name','tags'].includes(k))throw new UploadError(400,'Unknown upload update field');
  const meta=await this.readMeta(owner,id);
  if(data.name!==undefined){
   const nextName=sanitizeUploadName(data.name);
   if(OOXML_EXT[meta.type]&&extOf(nextName)!==OOXML_EXT[meta.type]){
    throw new UploadError(415,'Renamed OOXML document must keep its extension');
   }
   meta.name=nextName;
  }
  if(data.tags!==undefined){
   meta.tags=sanitizeTags(data.tags);
  }
  meta.updated_at=new Date().toISOString();
  await atomicWriteJson(join(this.uploadDir(owner,id),'meta.json'),meta);
  debug('%j',{schemaVersion:1,event:'prime_upload_updated',uploadId:id});
  return meta;
 }

 async remove(owner:string,id:string):Promise<{id:string;deleted:true}>{
  await this.readMeta(owner,id);
  await rm(this.uploadDir(owner,id),{recursive:true,force:true});
  debug('%j',{schemaVersion:1,event:'prime_upload_deleted',uploadId:id});
  return {id,deleted:true};
 }

 async serveFile(req:IncomingMessage,res:ServerResponse,owner:string,id:string,opts:{thumb?:boolean;download?:boolean}={}):Promise<void>{
  const meta=await this.readMeta(owner,id);
  const dir=this.uploadDir(owner,id);
  const useThumb=opts.thumb===true&&meta.thumb===true;
  const targetPath=join(dir,useThumb?'thumb.png':'blob');
  let fileStat;
  try{fileStat=await stat(targetPath);}
  catch{throw new UploadError(404,'Upload payload missing');}
  const total=fileStat.size;
  const contentType=useThumb?'image/png':meta.type;
  const inlineSafe=!opts.download&&(contentType.startsWith('image/')||contentType.startsWith('video/')||contentType.startsWith('audio/')||contentType==='application/pdf'||contentType==='text/plain');
  const dispMode=inlineSafe?'inline':'attachment';

  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',contentType==='application/pdf'
   ?"default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'"
   :"default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox");
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Type',contentType);
  res.setHeader('Content-Disposition',contentDisposition(dispMode,useThumb?`thumb-${meta.name}.png`:meta.name));

  const rangeHeader=req.headers.range;
  if(typeof rangeHeader==='string'&&rangeHeader.trim()){
   const m=/^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
   if(!m||(m[1]===''&&m[2]==='')){
    res.setHeader('Content-Range',`bytes */${total}`);
    res.writeHead(416);res.end();return;
   }
   let start:number,end:number;
   if(m[1]===''){
    const suffix=Number(m[2]);
    if(!Number.isSafeInteger(suffix)||suffix<=0){
     res.setHeader('Content-Range',`bytes */${total}`);
     res.writeHead(416);res.end();return;
    }
    start=Math.max(0,total-suffix);
    end=total-1;
   }else{
    start=Number(m[1]);
    end=m[2]===''?total-1:Number(m[2]);
   }
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=total||end<start){
    res.setHeader('Content-Range',`bytes */${total}`);
    res.writeHead(416);res.end();return;
   }
   end=Math.min(end,total-1);
   res.setHeader('Content-Range',`bytes ${start}-${end}/${total}`);
   res.setHeader('Content-Length',String(end-start+1));
   res.writeHead(206);
   await streamRangeToResponse(targetPath,start,end,res);
   return;
  }

  res.setHeader('Content-Length',String(total));
  res.writeHead(200);
  if(total===0){res.end();return;}
  await streamRangeToResponse(targetPath,0,total-1,res);
 }

 /**
  * Extracts bounded UTF-8 text for chat Q&A over uploaded documents (`pdf`, `txt`, `md`, `csv`, `json`).
  * Never Fabricates text: oversized or non-extractable files return `extracted: false` with an honest reason.
  */
 async extractForChat(owner:string,id:string):Promise<{meta:UploadMeta;extracted:boolean;text:string;truncated?:boolean;reason?:string}>{
  const meta=await this.readMeta(owner,id);
  const blobPath=join(this.uploadDir(owner,id),'blob');
  if(meta.bytes>TEXT_EXTRACT_FILE_CAP){
   const reason=`text not extracted: file size (${meta.bytes} bytes) exceeds ${TEXT_EXTRACT_FILE_CAP} byte extraction cap`;
   debug('%j',{schemaVersion:1,event:'prime_upload_text_extracted',uploadId:id,extracted:false,reason:'size_cap'});
   return {meta,extracted:false,text:'',reason};
  }
  if(meta.type==='text/plain'||meta.type==='text/markdown'||meta.type==='text/csv'||meta.type==='application/json'){
   const buf=await readFile(blobPath);
   const decoded=redact(new TextDecoder('utf-8',{fatal:false}).decode(buf));
   const truncated=decoded.length>TEXT_EXTRACT_CHAR_CAP;
   const text=truncated?decoded.slice(0,TEXT_EXTRACT_CHAR_CAP):decoded;
   debug('%j',{schemaVersion:1,event:'prime_upload_text_extracted',uploadId:id,extracted:true,chars:text.length,truncated});
   return {meta,extracted:true,text,...(truncated?{truncated:true}:{})};
  }
  if(meta.type==='application/pdf'){
   const buf=await readFile(blobPath);
   const pdfRes=extractPdfText(buf);
   if(!pdfRes.extracted){
    debug('%j',{schemaVersion:1,event:'prime_upload_text_extracted',uploadId:id,extracted:false,reason:'pdf_unextractable'});
    return {meta,extracted:false,text:'',reason:pdfRes.reason??'text not extracted'};
   }
   const text=redact(pdfRes.text);
   debug('%j',{schemaVersion:1,event:'prime_upload_text_extracted',uploadId:id,extracted:true,chars:text.length});
   return {meta,extracted:true,text};
  }
  const reason=`text not extracted: ${meta.type} does not support server-side text extraction in v1`;
  debug('%j',{schemaVersion:1,event:'prime_upload_text_extracted',uploadId:id,extracted:false,reason:'unsupported_type'});
  return {meta,extracted:false,text:'',reason};
 }

 // ---- Artifact Center Registry ------------------------------------------------
 async registerArtifact(owner:string,input:unknown):Promise<ArtifactRecord>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new UploadError(400,'Invalid artifact payload');
  const data=input as Record<string,unknown>;
  const allowedKeys=['title','kind','type','content','upload_id','external_url','summary','tags','provenance'];
  for(const k of Object.keys(data))if(!allowedKeys.includes(k))throw new UploadError(400,'Unknown artifact field: '+k);

  if(typeof data.title!=='string'||!data.title.trim()||data.title.length>200){
   throw new UploadError(400,'Artifact title must be 1–200 characters');
  }
  const validKinds:ArtifactKind[]=['image','video','music','sound','voice','code','proof','chat','document','other'];
  const kind:ArtifactKind=typeof data.kind==='string'&&(validKinds as string[]).includes(data.kind)?(data.kind as ArtifactKind):'other';
  const tags=sanitizeTags(data.tags);

  if(!data.provenance||typeof data.provenance!=='object'||Array.isArray(data.provenance)){
   throw new UploadError(400,'Artifact provenance object required');
  }
  const rawProv=data.provenance as Record<string,unknown>;
  const validSources:ArtifactSource[]=['studio','build','adk','chat_export','library','other'];
  const source:ArtifactSource=typeof rawProv.source==='string'&&(validSources as string[]).includes(rawProv.source)?(rawProv.source as ArtifactSource):'other';

  let parsedInputs:Array<{upload_id:string;role:StudioInputRole}>|undefined;
  if(rawProv.inputs!==undefined){
   parsedInputs=validateStudioInputs(rawProv.inputs);
  }

  const provenance:ArtifactProvenance={
   source,
   ...(typeof rawProv.prompt==='string'&&rawProv.prompt.trim()?{prompt:redact(rawProv.prompt.trim().slice(0,4000))}:{}),
   ...(typeof rawProv.model==='string'&&rawProv.model.trim()?{model:redact(rawProv.model.trim().slice(0,160))}:{}),
   ...(typeof rawProv.capability==='string'&&rawProv.capability.trim()?{capability:redact(rawProv.capability.trim().slice(0,180))}:{}),
   ...(typeof rawProv.run_id==='string'&&rawProv.run_id.trim()?{run_id:redact(rawProv.run_id.trim().slice(0,120))}:{}),
   ...(typeof rawProv.chat_id==='string'&&rawProv.chat_id.trim()?{chat_id:redact(rawProv.chat_id.trim().slice(0,120))}:{}),
   ...(typeof rawProv.agent==='string'&&rawProv.agent.trim()?{agent:redact(rawProv.agent.trim().slice(0,120))}:{}),
   ...(typeof rawProv.verdict==='string'&&rawProv.verdict.trim()?{verdict:redact(rawProv.verdict.trim().slice(0,40))}:{}),
   ...(typeof rawProv.events_sha256==='string'&&rawProv.events_sha256.trim()?{events_sha256:redact(rawProv.events_sha256.trim().slice(0,80))}:{}),
   ...(parsedInputs?.length?{inputs:parsedInputs}:{}),
  };

  let linkedMeta:UploadMeta|undefined;
  if(data.upload_id!==undefined){
   if(typeof data.upload_id!=='string'||!UPLOAD_ID_RE.test(data.upload_id))throw new UploadError(400,'Invalid linked upload_id');
   linkedMeta=await this.readMeta(owner,data.upload_id);
  }

  let contentBuf:Buffer|undefined;
  let contentType:string=linkedMeta?linkedMeta.type:'application/json';
  if(typeof data.type==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(data.type.trim())){
   contentType=data.type.trim().toLowerCase();
  }

  if(data.content!==undefined){
   const text=typeof data.content==='string'?redact(data.content):redact(JSON.stringify(data.content,null,2));
   contentBuf=Buffer.from(text,'utf8');
   if(contentBuf.length>2*1024*1024)throw new UploadError(413,'Inline artifact content exceeds 2 MiB');
   if(data.type===undefined)contentType=typeof data.content==='string'?'text/plain':'application/json';
  }

  const id='art_'+randomBytes(16).toString('hex');
  const artRoot=this.artifactRoot(owner);
  const tmpDir=join(artRoot,`.tmp_${randomUUID()}`);
  await mkdir(tmpDir,{recursive:true});

  try{
   let bytes=linkedMeta?.bytes??0;
   let sha256=linkedMeta?.sha256;
   if(contentBuf){
    await writeFile(join(tmpDir,'content'),contentBuf,{mode:0o600});
    bytes=contentBuf.length;
    sha256=createHash('sha256').update(contentBuf).digest('hex');
   }
   const record:ArtifactRecord={
    id,
    title:redact(data.title.trim()),
    kind,
    type:contentType,
    bytes,
    ...(sha256?{sha256}:{}),
    created_at:new Date().toISOString(),
    owner,
    ...(linkedMeta?{upload_id:linkedMeta.id}:{}),
    ...(typeof data.external_url==='string'&&/^https?:\/\/|^\//.test(data.external_url.trim())?{external_url:redact(data.external_url.trim().slice(0,600))}:{}),
    ...(typeof data.summary==='string'&&data.summary.trim()?{summary:redact(data.summary.trim().slice(0,1000))}:{}),
    tags,
    provenance,
   };
   await atomicWriteJson(join(tmpDir,'meta.json'),record);
   await rename(tmpDir,this.artifactDir(owner,id));
   debug('%j',{schemaVersion:1,event:'prime_artifact_registered',artifactId:id,kind:record.kind,source:provenance.source});
   return record;
  }catch(err){
   await rm(tmpDir,{recursive:true,force:true}).catch(()=>{});
   throw err;
  }
 }

 private async readArtifactMeta(owner:string,id:string):Promise<ArtifactRecord>{
  const dir=this.artifactDir(owner,id);
  let raw:string;
  try{raw=await readFile(join(dir,'meta.json'),'utf8');}
  catch{throw new UploadError(404,'Artifact not found');}
  const parsed=JSON.parse(raw) as ArtifactRecord;
  if(parsed.id!==id||parsed.owner!==owner)throw new UploadError(404,'Artifact not found');
  return parsed;
 }

 async getArtifact(owner:string,id:string):Promise<ArtifactRecord&{content?:string}>{
  const meta=await this.readArtifactMeta(owner,id);
  try{
   const content=await readFile(join(this.artifactDir(owner,id),'content'),'utf8');
   return {...meta,content};
  }catch{
   return meta;
  }
 }

 async listArtifacts(owner:string,filter:{kind?:string;source?:string;q?:string}={}):Promise<ArtifactRecord[]>{
  let entries:string[];
  try{entries=await readdir(this.artifactRoot(owner));}
  catch{return [];}
  const out:ArtifactRecord[]=[];
  for(const entry of entries){
   if(!ARTIFACT_ID_RE.test(entry))continue;
   try{
    const rec=await this.readArtifactMeta(owner,entry);
    if(filter.kind&&filter.kind!=='all'&&rec.kind!==filter.kind)continue;
    if(filter.source&&filter.source!=='all'&&rec.provenance.source!==filter.source)continue;
    if(filter.q){
     const needle=filter.q.trim().toLowerCase();
     const hay=`${rec.title} ${rec.tags.join(' ')} ${rec.provenance.prompt??''} ${rec.provenance.model??''} ${rec.provenance.capability??''} ${rec.provenance.run_id??''}`.toLowerCase();
     if(needle&&!hay.includes(needle))continue;
    }
    out.push(rec);
   }catch{/* skip removed */}
  }
  out.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  return out.slice(0,500);
 }

 async removeArtifact(owner:string,id:string):Promise<{id:string;deleted:true}>{
  await this.readArtifactMeta(owner,id);
  await rm(this.artifactDir(owner,id),{recursive:true,force:true});
  debug('%j',{schemaVersion:1,event:'prime_artifact_deleted',artifactId:id});
  return {id,deleted:true};
 }

 async serveArtifactFile(req:IncomingMessage,res:ServerResponse,owner:string,id:string,download=true):Promise<void>{
  const meta=await this.readArtifactMeta(owner,id);
  if(meta.upload_id){
   await this.serveFile(req,res,owner,meta.upload_id,{download});
   return;
  }
  const contentPath=join(this.artifactDir(owner,id),'content');
  let fileStat;
  try{fileStat=await stat(contentPath);}
  catch{
   const fallback=Buffer.from(JSON.stringify(meta,null,2),'utf8');
   res.setHeader('X-Content-Type-Options','nosniff');
   res.setHeader('Cache-Control','private, no-store');
   res.setHeader('Content-Type','application/json; charset=utf-8');
   res.setHeader('Content-Disposition',contentDisposition('attachment',`${meta.title.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,80)||meta.id}.json`));
   res.writeHead(200);res.end(fallback);return;
  }
  const ext=meta.type==='application/json'?'.json':meta.type==='text/markdown'?'.md':'.txt';
  const baseName=meta.title.replace(/[^A-Za-z0-9._ -]/g,'_').trim().slice(0,80)||meta.id;
  const fileName=baseName.includes('.')?baseName:baseName+ext;
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Type',meta.type);
  res.setHeader('Content-Disposition',contentDisposition(download?'attachment':'inline',fileName));
  res.setHeader('Content-Length',String(fileStat.size));
  res.writeHead(200);
  if(fileStat.size===0){res.end();return;}
  await streamRangeToResponse(contentPath,0,fileStat.size-1,res);
 }
}

export function validateStudioInputs(raw:unknown):Array<{upload_id:string;role:StudioInputRole}>{
 if(!Array.isArray(raw))throw new UploadError(400,'Studio inputs must be an array');
 if(raw.length>8)throw new UploadError(400,'Studio accepts at most 8 reference upload inputs');
 return raw.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw new UploadError(400,'Invalid Studio input entry');
  const rec=item as Record<string,unknown>;
  for(const k of Object.keys(rec))if(!['upload_id','role'].includes(k))throw new UploadError(400,'Unknown Studio input field: '+k);
  if(typeof rec.upload_id!=='string'||!UPLOAD_ID_RE.test(rec.upload_id))throw new UploadError(400,'Invalid Studio input upload_id');
  if(typeof rec.role!=='string'||!(STUDIO_INPUT_ROLES as readonly string[]).includes(rec.role)){
   throw new UploadError(400,'Invalid Studio input role');
  }
  return {upload_id:rec.upload_id,role:rec.role as StudioInputRole};
 });
}

async function streamRangeToResponse(filePath:string,start:number,end:number,res:ServerResponse):Promise<void>{
 await new Promise<void>((resolvePromise,rejectPromise)=>{
  const stream=createReadStream(filePath,{start,end});
  const onClose=()=>{stream.destroy();resolvePromise();};
  res.once('close',onClose);
  stream.on('error',err=>{res.off('close',onClose);rejectPromise(err);});
  stream.on('end',()=>{res.off('close',onClose);resolvePromise();});
  stream.pipe(res);
 });
}
