import {createHash} from 'node:crypto';
import {mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PrimeHub } from '../src/prime/hub.js';
import { startPrimeServer } from '../src/prime/server.js';
import {
 ALLOWED_UPLOAD_TYPES,
 DEFAULT_UPLOAD_MAX_BYTES,
 DOCX_MIME,
 UploadStore,
 parseUploadsConfig,
 stripJpegExifGps,
} from '../src/prime/uploads.js';

// ---- Binary fixture builders (zero external dependencies) --------------------
function crc32(buf: Buffer): number {
 let c = 0xffffffff;
 for (let i = 0; i < buf.length; i++) {
  c ^= buf[i];
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
 }
 return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
 const len = Buffer.alloc(4);
 len.writeUInt32BE(data.length, 0);
 const typeBuf = Buffer.from(type, 'ascii');
 const crc = Buffer.alloc(4);
 crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
 return Buffer.concat([len, typeBuf, data, crc]);
}

function makeValidPng(width = 8, height = 6): Buffer {
 const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
 const ihdr = Buffer.alloc(13);
 ihdr.writeUInt32BE(width, 0);
 ihdr.writeUInt32BE(height, 4);
 ihdr[8] = 8; // 8-bit
 ihdr[9] = 6; // RGBA
 const raw = Buffer.alloc(height * (1 + width * 4));
 for (let y = 0; y < height; y++) {
  const rowOff = y * (1 + width * 4);
  raw[rowOff] = 0; // filter None
  for (let x = 0; x < width; x++) {
   const px = rowOff + 1 + x * 4;
   raw[px] = (x * 30) & 0xff;
   raw[px + 1] = (y * 40) & 0xff;
   raw[px + 2] = 180;
   raw[px + 3] = 255;
  }
 }
 return Buffer.concat([
  sig,
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', deflateSync(raw)),
  pngChunk('IEND', Buffer.alloc(0)),
 ]);
}

function makeJpegWithExifGps(littleEndian = true, width = 64, height = 48): { jpeg: Buffer; secretMarker: Buffer } {
 // Build TIFF payload inside Exif APP1:
 // Offset 0..7: TIFF header
 // Offset 8..9: IFD0 count = 2 (0x010F Make + 0x8825 GPSInfoIFDPointer)
 // Offset 10..33: 2 * 12-byte entries
 // Offset 34..37: nextIFD = 0
 // Offset 38..49: Make string "EchoCam\0\0\0\0\0"
 // Offset 50..85: GPS IFD: count=1 (tag 0x0002 GPSLatitude, type=5 RATIONAL, count=3, valueOffset=68) + next=0 + 24 bytes rational coords
 const secretMarker = Buffer.from('SECRET_GPS_LAT_37_7749_N', 'ascii'); // 24 bytes at offset 68
 const tiff = Buffer.alloc(92);
 const w16 = (off: number, v: number) => (littleEndian ? tiff.writeUInt16LE(v, off) : tiff.writeUInt16BE(v, off));
 const w32 = (off: number, v: number) => (littleEndian ? tiff.writeUInt32LE(v, off) : tiff.writeUInt32BE(v, off));

 tiff.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
 w16(2, 0x002a);
 w32(4, 8); // IFD0 at 8
 w16(8, 2); // 2 entries in IFD0
 // Entry 0 at 10: Make (0x010f), ASCII (2), count 8, valueOffset 38
 w16(10, 0x010f);
 w16(12, 2);
 w32(14, 8);
 w32(18, 38);
 // Entry 1 at 22: GPSInfo (0x8825), LONG (4), count 1, valueOffset 50
 w16(22, 0x8825);
 w16(24, 4);
 w32(26, 1);
 w32(30, 50);
 w32(34, 0); // next IFD = 0
 tiff.write('EchoCam\0', 38, 'ascii');

 // GPS IFD at 50: 1 entry -> tag 0x0002, RATIONAL (5), count 3 (24 bytes), offset 68
 w16(50, 1);
 w16(52, 0x0002);
 w16(54, 5);
 w32(56, 3);
 w32(60, 68);
 w32(64, 0);
 secretMarker.copy(tiff, 68);

 const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
 const app1 = Buffer.alloc(4 + app1Payload.length);
 app1[0] = 0xff;
 app1[1] = 0xe1;
 app1.writeUInt16BE(app1Payload.length + 2, 2);
 app1Payload.copy(app1, 4);

 // SOF0 segment (0xFFC0)
 const sofPayload = Buffer.from([8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
 const sof = Buffer.alloc(4 + sofPayload.length);
 sof[0] = 0xff;
 sof[1] = 0xc0;
 sof.writeUInt16BE(sofPayload.length + 2, 2);
 sofPayload.copy(sof, 4);

 // SOS segment (0xFFDA) + scan data + EOI (0xFFD9)
 const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xab, 0xcd, 0xef, 0x12, 0xff, 0xd9]);
 return {
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, sos]),
  secretMarker,
 };
}

function makeValidWav(durationSec = 2, sampleRate = 8000): Buffer {
 const dataBytes = durationSec * sampleRate * 2; // mono 16-bit
 const buf = Buffer.alloc(44 + dataBytes);
 buf.write('RIFF', 0, 'ascii');
 buf.writeUInt32LE(36 + dataBytes, 4);
 buf.write('WAVE', 8, 'ascii');
 buf.write('fmt ', 12, 'ascii');
 buf.writeUInt32LE(16, 16);
 buf.writeUInt16LE(1, 20); // PCM
 buf.writeUInt16LE(1, 22); // 1 ch
 buf.writeUInt32LE(sampleRate, 24);
 buf.writeUInt32LE(sampleRate * 2, 28); // byteRate
 buf.writeUInt16LE(2, 32);
 buf.writeUInt16LE(16, 34);
 buf.write('data', 36, 'ascii');
 buf.writeUInt32LE(dataBytes, 40);
 return buf;
}

function makeValidMp4(durationSec = 5, timescale = 1000): Buffer {
 const ftyp = Buffer.alloc(20);
 ftyp.writeUInt32BE(20, 0);
 ftyp.write('ftyp', 4, 'ascii');
 ftyp.write('isom', 8, 'ascii');

 const mvhd = Buffer.alloc(32);
 mvhd.writeUInt32BE(32, 0);
 mvhd.write('mvhd', 4, 'ascii');
 mvhd[8] = 0; // version 0
 mvhd.writeUInt32BE(timescale, 20);
 mvhd.writeUInt32BE(durationSec * timescale, 24);

 const moov = Buffer.alloc(8 + mvhd.length);
 moov.writeUInt32BE(moov.length, 0);
 moov.write('moov', 4, 'ascii');
 mvhd.copy(moov, 8);

 return Buffer.concat([ftyp, moov]);
}

function makeMinimalPdf(textLines: string[], compress = true): Buffer {
 const contentStream = `BT /F1 12 Tf 72 720 Td ${textLines.map(l => `(${l}) Tj`).join(' T* ')} ET`;
 const streamBytes = compress ? deflateSync(Buffer.from(contentStream, 'latin1')) : Buffer.from(contentStream, 'latin1');
 const filterSpec = compress ? '/Filter /FlateDecode ' : '';
 const head = Buffer.from(
  `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
  `2 0 obj << /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >> endobj\n` +
  `3 0 obj << /Type /Page /Parent 2 0 R /Contents 5 0 R >> endobj\n` +
  `4 0 obj << /Type /Page /Parent 2 0 R >> endobj\n` +
  `5 0 obj << ${filterSpec}/Length ${streamBytes.length} >>\nstream\n`,
  'latin1',
 );
 const tail = Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1');
 return Buffer.concat([head, streamBytes, tail]);
}

function makeStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
 const locals: Buffer[] = [];
 const centrals: Buffer[] = [];
 let offset = 0;
 for (const entry of entries) {
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const crc = crc32(entry.data);
  const local = Buffer.alloc(30 + nameBuf.length + entry.data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // store
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(entry.data.length, 18);
  local.writeUInt32LE(entry.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  entry.data.copy(local, 30 + nameBuf.length);
  locals.push(local);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(entry.data.length, 20);
  central.writeUInt32LE(entry.data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  nameBuf.copy(central, 46);
  centrals.push(central);
  offset += local.length;
 }
 const cdBuf = Buffer.concat(centrals);
 const eocd = Buffer.alloc(22);
 eocd.writeUInt32LE(0x06054b50, 0);
 eocd.writeUInt16LE(entries.length, 8);
 eocd.writeUInt16LE(entries.length, 10);
 eocd.writeUInt32LE(cdBuf.length, 12);
 eocd.writeUInt32LE(offset, 16);
 return Buffer.concat([...locals, cdBuf, eocd]);
}

function buildMultipart(boundary: string, fields: Record<string, string>, file: { filename: string; contentType: string; data: Buffer }): Buffer {
 const parts: Buffer[] = [];
 for (const [k, v] of Object.entries(fields)) {
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
 }
 parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, 'utf8'));
 parts.push(file.data);
 parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
 return Buffer.concat(parts);
}

// ---- Test lifecycle helpers --------------------------------------------------
const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

function makeTempDir(prefix = 'prime-uploads-'): string {
 const d = mkdtempSync(join(tmpdir(), prefix));
 tempDirs.push(d);
 return d;
}

afterEach(async () => {
 while (closers.length) {
  const fn = closers.pop()!;
  await fn().catch(() => {});
 }
 while (tempDirs.length) {
  const d = tempDirs.pop()!;
  rmSync(d, { recursive: true, force: true });
 }
});

async function bootLocalServer(uploadsCfg?: unknown) {
 const uiDir = makeTempDir('prime-ui-');
 writeFileSync(join(uiDir, 'index.html'), '<!doctype html><html>Prime</html>');
 const store = uploadsCfg !== undefined ? new UploadStore(parseUploadsConfig(uploadsCfg)) : undefined;
 const hub = new PrimeHub({
  capabilities: [{ id: 'echo.media.image_generate', registered: true, health: 'green', scope: 'media.write', tier: 1, category: 'image', description: 'Image gen' }],
  uploads: store,
  sdk: {
   search: async () => [],
   read: async id => ({ kind: 'sdk_cap', registration_state: 'registered', health_status: 'green', capability: { id, required_scope: 'media.write' } }),
   invoke: async req => ({ ok: true, run_id: 'job_1', params: req.params }),
  },
 });
 const srv = await startPrimeServer(hub, uiDir, 0, store ? { uploads: store } : {});
 closers.push(srv.close);
 const page = await fetch(srv.url);
 const cookie = page.headers.get('set-cookie')!.split(';')[0];
 return { url: srv.url, cookie, hub, store };
}

describe('parseUploadsConfig', () => {
 it('applies 200 MiB default, maps docx/xlsx/pptx aliases, and refuses unknown keys or disallowed MIME types', () => {
  const root = makeTempDir('cfg-');
  const parsed = parseUploadsConfig({ root });
  expect(parsed.maxBytes).toBe(DEFAULT_UPLOAD_MAX_BYTES);
  expect(parsed.types).toEqual([...ALLOWED_UPLOAD_TYPES]);

  const subset = parseUploadsConfig({ root, maxBytes: 4096, types: ['image/png', 'docx'] });
  expect(subset.maxBytes).toBe(4096);
  expect(subset.types).toEqual(['image/png', DOCX_MIME]);

  expect(() => parseUploadsConfig({ root, extraKey: true })).toThrow(/unknown field extraKey/i);
  expect(() => parseUploadsConfig({ root, types: ['text/html'] })).toThrow(/unsupported MIME/i);
  expect(() => parseUploadsConfig({ root, types: ['application/zip'] })).toThrow(/unsupported MIME/i);
  expect(() => parseUploadsConfig({ root: '', maxBytes: 100 })).toThrow(/root/i);
  expect(() => parseUploadsConfig({ root, maxBytes: -5 })).toThrow(/maxBytes/i);
 });
});

describe('Prime streaming uploads & hygiene', () => {
 it('reports configured:false on list when opt-in uploads config is omitted and refuses POST with 503', async () => {
  const { url, cookie } = await bootLocalServer(undefined);
  const listRes = await fetch(`${url}/api/prime/uploads/list`, { headers: { cookie, 'x-prime-request': '1' } });
  expect(listRes.status).toBe(200);
  expect(await listRes.json()).toMatchObject({ configured: false, uploads: [] });

  const artRes = await fetch(`${url}/api/prime/artifacts`, { headers: { cookie, 'x-prime-request': '1' } });
  expect(artRes.status).toBe(200);
  expect(await artRes.json()).toMatchObject({ configured: false, artifacts: [] });

  const postRes = await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'text/plain', 'x-upload-filename': 'a.txt' },
   body: 'hello',
  });
  expect(postRes.status).toBe(503);
 });

 it('streams multipart PNG uploads, derives dimensions + sha256 + pure-JS PNG thumbnail, and serves nosniff files', async () => {
  const root = makeTempDir('store-');
  const { url, cookie } = await bootLocalServer({ root });
  const png = makeValidPng(320, 240);
  const expectedSha = createHash('sha256').update(png).digest('hex');
  const boundary = '----EchoTestBoundary99';
  const mpBody = buildMultipart(boundary, { tags: 'hero, concept' }, { filename: 'scene.png', contentType: 'image/png', data: png });

  const upRes = await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
   body: mpBody,
  });
  expect(upRes.status).toBe(201);
  const meta = await upRes.json();
  expect(meta).toMatchObject({
   name: 'scene.png',
   type: 'image/png',
   bytes: png.length,
   sha256: expectedSha,
   owner: 'local',
   kind: 'image',
   width: 320,
   height: 240,
   thumb: true,
   tags: ['hero', 'concept'],
  });
  expect(meta.id).toMatch(/^upl_[0-9a-f]{32}$/);

  // Metadata GET
  const metaGet = await fetch(`${url}/api/prime/uploads/${meta.id}`, { headers: { cookie, 'x-prime-request': '1' } });
  expect(metaGet.status).toBe(200);
  expect((await metaGet.json()).sha256).toBe(expectedSha);

  // Thumbnail GET (works as native browser <img> with cookie and no custom X-Prime-Request header)
  const thumbRes = await fetch(`${url}/api/prime/uploads/${meta.id}/file?thumb=1`, { headers: { cookie } });
  expect(thumbRes.status).toBe(200);
  expect(thumbRes.headers.get('content-type')).toBe('image/png');
  expect(thumbRes.headers.get('x-content-type-options')).toBe('nosniff');
  const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
  // Scaled down to maxEdge 160 -> width=160, height=120 in PNG IHDR
  expect(thumbBuf.readUInt32BE(16)).toBe(160);
  expect(thumbBuf.readUInt32BE(20)).toBe(120);

  // Full file GET
  const fileRes = await fetch(`${url}/api/prime/uploads/${meta.id}/file`, { headers: { cookie } });
  expect(fileRes.status).toBe(200);
  expect(fileRes.headers.get('content-disposition')).toContain('inline; filename="scene.png"');
  expect(Buffer.from(await fileRes.arrayBuffer()).equals(png)).toBe(true);
 });

 it('streams chunked binary uploads across small chunks and supports Range 206, suffix Range, and 416', async () => {
  const root = makeTempDir('chunked-');
  const { url, cookie } = await bootLocalServer({ root });
  const content = Buffer.from(Array.from({ length: 4000 }, (_, i) => `line-${String(i).padStart(4, '0')}\n`).join(''), 'utf8');
  const expectedSha = createHash('sha256').update(content).digest('hex');
  const parsedUrl = new URL(`${url}/api/prime/uploads`);

  const meta: any = await new Promise((resolve, reject) => {
   const req = httpRequest(
    {
     hostname: parsedUrl.hostname,
     port: parsedUrl.port,
     path: parsedUrl.pathname,
     method: 'POST',
     headers: {
      cookie,
      origin: url,
      host: parsedUrl.host,
      'x-prime-request': '1',
      'content-type': 'text/plain',
      'x-upload-filename': 'notes.txt',
      'transfer-encoding': 'chunked',
     },
    },
    res => {
     const parts: Buffer[] = [];
     res.on('data', d => parts.push(d));
     res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    },
   );
   req.on('error', reject);
   for (let off = 0; off < content.length; off += 512) {
    req.write(content.subarray(off, Math.min(content.length, off + 512)));
   }
   req.end();
  });

  expect(meta.status).toBe(201);
  expect(meta.body.sha256).toBe(expectedSha);
  expect(meta.body.bytes).toBe(content.length);

  // Range 206: bytes=10-49
  const r1 = await fetch(`${url}/api/prime/uploads/${meta.body.id}/file`, {
   headers: { cookie, Range: 'bytes=10-49' },
  });
  expect(r1.status).toBe(206);
  expect(r1.headers.get('content-range')).toBe(`bytes 10-49/${content.length}`);
  expect(r1.headers.get('content-length')).toBe('40');
  expect(Buffer.from(await r1.arrayBuffer()).equals(content.subarray(10, 50))).toBe(true);

  // Suffix Range: bytes=-25
  const r2 = await fetch(`${url}/api/prime/uploads/${meta.body.id}/file`, {
   headers: { cookie, Range: 'bytes=-25' },
  });
  expect(r2.status).toBe(206);
  expect(Buffer.from(await r2.arrayBuffer()).equals(content.subarray(content.length - 25))).toBe(true);

  // Unsatisfiable Range: 416
  const r3 = await fetch(`${url}/api/prime/uploads/${meta.body.id}/file`, {
   headers: { cookie, Range: `bytes=${content.length + 100}-${content.length + 200}` },
  });
  expect(r3.status).toBe(416);
  expect(r3.headers.get('content-range')).toBe(`bytes */${content.length}`);
 });

 it('enforces maxBytes mid-stream with 413 and cleans up temporary files', async () => {
  const root = makeTempDir('cap-');
  const { url, cookie } = await bootLocalServer({ root, maxBytes: 1024 });
  const oversized = Buffer.alloc(2048, 0x61);

  const res = await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'text/plain', 'x-upload-filename': 'big.txt' },
   body: oversized,
  });
  expect(res.status).toBe(413);

  // Verify no .tmp_ or upload directories remain in local account dir
  const acctEntries = readdirSync(join(root, 'local'));
  expect(acctEntries).toEqual([]);
 });

 it('refuses executables, archives, scripts, macro-OOXML and credential filenames while accepting clean DOCX', async () => {
  const root = makeTempDir('hygiene-');
  const { url, cookie } = await bootLocalServer({ root });

  const postRaw = (filename: string, contentType: string, data: Buffer) =>
   fetch(`${url}/api/prime/uploads`, {
    method: 'POST',
    headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': contentType, 'x-upload-filename': filename },
    body: data,
   });

  // 1. PE executable disguised as PNG
  expect((await postRaw('photo.png', 'image/png', Buffer.from('MZ\x90\x00\x03\x00\x00\x00FakePE', 'binary'))).status).toBe(415);
  // 2. ELF binary disguised as PDF
  expect((await postRaw('doc.pdf', 'application/pdf', Buffer.from('\x7fELF\x02\x01\x01\x00FakeELF', 'binary'))).status).toBe(415);
  // 3. Plain ZIP archive
  const plainZip = makeStoredZip([{ name: 'readme.txt', data: Buffer.from('hello') }]);
  expect((await postRaw('bundle.zip', 'application/zip', plainZip)).status).toBe(415);
  // 4. Executable / script extension
  expect((await postRaw('install.exe', 'application/octet-stream', Buffer.from('hello'))).status).toBe(415);
  expect((await postRaw('deploy.sh', 'text/plain', Buffer.from('#!/bin/sh\necho hi'))).status).toBe(415);
  // 5. Credential file names
  expect((await postRaw('.env', 'text/plain', Buffer.from('FOO=1'))).status).toBe(400);
  expect((await postRaw('id_ed25519', 'text/plain', Buffer.from('key'))).status).toBe(400);
  expect((await postRaw('service-credentials.json', 'application/json', Buffer.from('{}'))).status).toBe(400);
  // 6. Macro-infected DOCX (vbaProject.bin)
  const macroDocx = makeStoredZip([
   { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
   { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
   { name: 'word/vbaProject.bin', data: Buffer.from('MACRO') },
  ]);
  expect((await postRaw('report.docx', DOCX_MIME, macroDocx)).status).toBe(415);

  // 7. Clean DOCX succeeds and serves as attachment (never inline)
  const cleanDocx = makeStoredZip([
   { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
   { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
  ]);
  const okDocx = await postRaw('report.docx', DOCX_MIME, cleanDocx);
  expect(okDocx.status).toBe(201);
  const docxMeta = await okDocx.json();
  expect(docxMeta.kind).toBe('document');
  const docxGet = await fetch(`${url}/api/prime/uploads/${docxMeta.id}/file`, { headers: { cookie } });
  expect(docxGet.headers.get('content-disposition')).toMatch(/^attachment;/);
 });

 it('strips EXIF GPS IFD and wipes coordinate bytes in both little-endian and big-endian JPEGs on upload', async () => {
  for (const le of [true, false]) {
   const { jpeg, secretMarker } = makeJpegWithExifGps(le, 64, 48);
   expect(jpeg.includes(secretMarker)).toBe(true);

   // Direct unit check
   const stripped = stripJpegExifGps(jpeg);
   expect(stripped.stripped).toBe(true);
   expect(stripped.width).toBe(64);
   expect(stripped.height).toBe(48);
   expect(stripped.buffer.includes(secretMarker)).toBe(false);
   expect(stripped.buffer.includes(Buffer.from('EchoCam', 'ascii'))).toBe(true); // Non-GPS Make tag preserved!
   expect(stripped.buffer[0]).toBe(0xff);
   expect(stripped.buffer[1]).toBe(0xd8);
   expect(stripped.buffer[stripped.buffer.length - 2]).toBe(0xff);
   expect(stripped.buffer[stripped.buffer.length - 1]).toBe(0xd9);
  }

  // End-to-end streaming upload across tiny 7-byte chunks + XMP GPS segment
  const root = makeTempDir('exif-');
  const { url, cookie } = await bootLocalServer({ root });
  const { jpeg, secretMarker } = makeJpegWithExifGps(true, 80, 60);
  // Also inject an XMP APP1 with exif:GPSLatitude right after SOI
  const xmpPayload = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude="37,46.49N"/>', 'utf8');
  const xmpSeg = Buffer.alloc(4 + xmpPayload.length);
  xmpSeg[0] = 0xff;
  xmpSeg[1] = 0xe1;
  xmpSeg.writeUInt16BE(xmpPayload.length + 2, 2);
  xmpPayload.copy(xmpSeg, 4);
  const combinedJpeg = Buffer.concat([jpeg.subarray(0, 2), xmpSeg, jpeg.subarray(2)]);

  const parsedUrl = new URL(`${url}/api/prime/uploads`);
  const uploaded: any = await new Promise((resolve, reject) => {
   const req = httpRequest(
    {
     hostname: parsedUrl.hostname,
     port: parsedUrl.port,
     path: parsedUrl.pathname,
     method: 'POST',
     headers: {
      cookie,
      origin: url,
      host: parsedUrl.host,
      'x-prime-request': '1',
      'content-type': 'image/jpeg',
      'x-upload-filename': 'photo.jpg',
      'transfer-encoding': 'chunked',
     },
    },
    res => {
     const parts: Buffer[] = [];
     res.on('data', d => parts.push(d));
     res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    },
   );
   req.on('error', reject);
   for (let i = 0; i < combinedJpeg.length; i += 7) {
    req.write(combinedJpeg.subarray(i, Math.min(combinedJpeg.length, i + 7)));
   }
   req.end();
  });

  expect(uploaded.status).toBe(201);
  expect(uploaded.body).toMatchObject({
   kind: 'image',
   type: 'image/jpeg',
   width: 80,
   height: 60,
   exif_gps_stripped: true,
  });

  const saved = Buffer.from(await (await fetch(`${url}/api/prime/uploads/${uploaded.body.id}/file`, { headers: { cookie } })).arrayBuffer());
  expect(saved.includes(secretMarker)).toBe(false);
  expect(saved.toString('latin1')).not.toContain('GPSLatitude');
  expect(saved.includes(Buffer.from('EchoCam', 'ascii'))).toBe(true);
  expect(createHash('sha256').update(saved).digest('hex')).toBe(uploaded.body.sha256);
 });

 it('derives WAV duration, MP4 duration, PDF page count, and supports rename, tags update, and delete', async () => {
  const root = makeTempDir('media-meta-');
  const { url, cookie } = await bootLocalServer({ root });

  const post = async (name: string, type: string, data: Buffer) => {
   const r = await fetch(`${url}/api/prime/uploads`, {
    method: 'POST',
    headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': type, 'x-upload-filename': name },
    body: data,
   });
   expect(r.status).toBe(201);
   return r.json();
  };

  const wavMeta = await post('clip.wav', 'audio/wav', makeValidWav(3, 8000));
  expect(wavMeta.kind).toBe('audio');
  expect(wavMeta.duration).toBe(3);

  const mp4Meta = await post('demo.mp4', 'video/mp4', makeValidMp4(7, 1000));
  expect(mp4Meta.kind).toBe('video');
  expect(mp4Meta.duration).toBe(7);

  const pdfMeta = await post('spec.pdf', 'application/pdf', makeMinimalPdf(['Hello Prime']));
  expect(pdfMeta.kind).toBe('document');
  expect(pdfMeta.pages).toBe(2);

  // Filter list by kind
  const videoList = await (await fetch(`${url}/api/prime/uploads/list?kind=video`, { headers: { cookie, 'x-prime-request': '1' } })).json();
  expect(videoList.uploads.map((u: any) => u.id)).toEqual([mp4Meta.id]);

  // Rename + tags update
  const updRes = await fetch(`${url}/api/prime/uploads/${mp4Meta.id}/update`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/json' },
   body: JSON.stringify({ name: 'final-cut.mp4', tags: ['v2', 'studio'] }),
  });
  expect(updRes.status).toBe(200);
  expect(await updRes.json()).toMatchObject({ id: mp4Meta.id, name: 'final-cut.mp4', tags: ['v2', 'studio'] });

  // Delete upload
  const delRes = await fetch(`${url}/api/prime/uploads/${mp4Meta.id}/delete`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/json' },
   body: '{}',
  });
  expect(delRes.status).toBe(200);
  expect((await fetch(`${url}/api/prime/uploads/${mp4Meta.id}`, { headers: { cookie, 'x-prime-request': '1' } })).status).toBe(404);
 });

 it('gates uploads by owner + approved member with CSRF/Origin and isolates accounts on disk', async () => {
  const root = makeTempDir('ws-iso-');
  const uiDir = makeTempDir('ws-ui-');
  writeFileSync(join(uiDir, 'index.html'), '<html>Prime</html>');

  let lastUpstreamChatBody: any = null;
  const wsBackend: Server = createServer(async (req, res) => {
   const cookie = req.headers.cookie || '';
   if (req.url === '/api/auth/session') {
    if (!cookie) {
     res.writeHead(200, { 'content-type': 'application/json' });
     res.end(JSON.stringify({ authenticated: false, user: null, csrf: null }));
     return;
    }
    if (cookie.includes('owner_tok')) {
     res.writeHead(200, { 'content-type': 'application/json' });
     res.end(JSON.stringify({ authenticated: true, user: { uid: 'owner-1', role: 'owner', status: 'approved' }, csrf: 'csrf-owner-1234' }));
     return;
    }
    if (cookie.includes('member_tok')) {
     res.writeHead(200, { 'content-type': 'application/json' });
     res.end(JSON.stringify({ authenticated: true, user: { uid: 'member-2', role: 'member', status: 'approved' }, csrf: 'csrf-member-5678' }));
     return;
    }
    if (cookie.includes('pending_tok')) {
     res.writeHead(200, { 'content-type': 'application/json' });
     res.end(JSON.stringify({ authenticated: true, user: { uid: 'pending-3', role: 'member', status: 'pending' }, csrf: 'csrf-pending-9999' }));
     return;
    }
   }
   if (req.url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tenant_isolation: true, auth_enabled: true, user: { uid: 'member-2' }, csrf: 'csrf-member-5678' }));
    return;
   }
   if (req.url === '/api/chat' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    lastUpstreamChatBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ type: 'done', chat: { id: lastUpstreamChatBody.chat_id, messages: [] } }) + '\n');
    return;
   }
   res.writeHead(404);
   res.end();
  });
  await new Promise<void>(r => wsBackend.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>(r => wsBackend.close(() => r())));
  const wsAddr = wsBackend.address() as { port: number };

  const store = new UploadStore(parseUploadsConfig({ root }));
  const hub = new PrimeHub({ capabilities: [], uploads: store, uploadsOwner: 'owner-1' });
  const srv = await startPrimeServer(hub, uiDir, 0, {
   workspace: { baseUrl: `http://127.0.0.1:${wsAddr.port}`, ownerUid: 'owner-1' },
   uploads: store,
  });
  closers.push(srv.close);

  const primeCookie = (await fetch(srv.url)).headers.get('set-cookie')!.split(';')[0];
  const ownerCookie = `${primeCookie}; echo_workspace_session=${'owner_tok_'.padEnd(36, 'a')}`;
  const memberCookie = `${primeCookie}; echo_workspace_session=${'member_tok_'.padEnd(36, 'b')}`;
  const pendingCookie = `${primeCookie}; echo_workspace_session=${'pending_tok_'.padEnd(36, 'c')}`;

  // Anonymous -> 401
  expect((await fetch(`${srv.url}/api/prime/uploads/list`, { headers: { cookie: primeCookie, 'x-prime-request': '1' } })).status).toBe(401);

  // Pending member -> 403
  expect((await fetch(`${srv.url}/api/prime/uploads/list`, { headers: { cookie: pendingCookie, 'x-prime-request': '1', 'x-echo-csrf': 'csrf-pending-9999' } })).status).toBe(403);

  // Approved member missing CSRF -> 403
  expect(
   (
    await fetch(`${srv.url}/api/prime/uploads`, {
     method: 'POST',
     headers: { cookie: memberCookie, origin: srv.url, 'x-prime-request': '1', 'content-type': 'text/plain', 'x-upload-filename': 'm.txt' },
     body: 'member doc',
    })
   ).status,
  ).toBe(403);

  // Approved member with valid CSRF + Origin -> 201!
  const memUpRes = await fetch(`${srv.url}/api/prime/uploads`, {
   method: 'POST',
   headers: {
    cookie: memberCookie,
    origin: srv.url,
    'x-prime-request': '1',
    'x-echo-csrf': 'csrf-member-5678',
    'content-type': 'application/pdf',
    'x-upload-filename': 'handbook.pdf',
   },
   body: makeMinimalPdf(['Quarterly Revenue 42M']),
  });
  expect(memUpRes.status).toBe(201);
  const memPdf = await memUpRes.json();
  expect(memPdf.owner).toBe('member-2');

  // Member uploads a PNG too (non-text-extractable)
  const memImg = await (
   await fetch(`${srv.url}/api/prime/uploads`, {
    method: 'POST',
    headers: {
     cookie: memberCookie,
     origin: srv.url,
     'x-prime-request': '1',
     'x-echo-csrf': 'csrf-member-5678',
     'content-type': 'image/png',
     'x-upload-filename': 'chart.png',
    },
    body: makeValidPng(16, 16),
   })
  ).json();

  // Owner CANNOT read, download or delete member's upload (strict per-account isolation -> 404)
  expect(
   (
    await fetch(`${srv.url}/api/prime/uploads/${memPdf.id}`, {
     headers: { cookie: ownerCookie, 'x-prime-request': '1', 'x-echo-csrf': 'csrf-owner-1234' },
    })
   ).status,
  ).toBe(404);
  expect(
   (
    await fetch(`${srv.url}/api/prime/uploads/${memPdf.id}/file`, {
     headers: { cookie: ownerCookie },
    })
   ).status,
  ).toBe(404);

  // Member attaches handbook.pdf + chart.png + Workspace library 'lib_note_1' in /api/workspace/chat
  const chatRes = await fetch(`${srv.url}/api/workspace/chat`, {
   method: 'POST',
   headers: {
    cookie: memberCookie,
    origin: srv.url,
    'x-prime-request': '1',
    'x-echo-csrf': 'csrf-member-5678',
    'content-type': 'application/json',
   },
   body: JSON.stringify({
    chat_id: 'chat_1',
    content: 'Summarize the attached PDF.',
    attachments: [memPdf.id, memImg.id, 'lib_note_1'],
   }),
  });
  expect(chatRes.status).toBe(200);
  expect(lastUpstreamChatBody.attachments).toEqual(['lib_note_1']);
  expect(lastUpstreamChatBody.content).toContain('Quarterly Revenue 42M');
  expect(lastUpstreamChatBody.content).toContain('[text not extracted: image/png does not support server-side text extraction in v1]');
 });

 it('validates Studio reference upload inputs on prepare and registers/serves Artifact Center records', async () => {
  const root = makeTempDir('studio-art-');
  const { url, cookie, hub } = await bootLocalServer({ root });

  const pngRes = await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'image/png', 'x-upload-filename': 'init.png' },
   body: makeValidPng(32, 32),
  });
  const pngMeta = await pngRes.json();

  // Valid Studio prepare with inputs:[{upload_id, role}]
  const ticket = await hub.prepare({
   target: 'sdk',
   name: 'echo.media.image_generate',
   arguments: {
    command: 'image_generate',
    options: { prompt: 'cyberpunk skyline', wait: false },
    inputs: [{ upload_id: pngMeta.id, role: 'init' }],
   },
  });
  expect(ticket.request.arguments.inputs).toEqual([{ upload_id: pngMeta.id, role: 'init' }]);

  // Invalid role or missing upload refused
  await expect(
   hub.prepare({
    target: 'sdk',
    name: 'echo.media.image_generate',
    arguments: { command: 'image_generate', options: {}, inputs: [{ upload_id: pngMeta.id, role: 'evil' }] },
   }),
  ).rejects.toThrow(/Invalid Studio input role/i);
  await expect(
   hub.prepare({
    target: 'sdk',
    name: 'echo.media.image_generate',
    arguments: { command: 'image_generate', options: {}, inputs: [{ upload_id: 'upl_' + '0'.repeat(32), role: 'reference' }] },
   }),
  ).rejects.toThrow(/Reference upload not found/i);

  // Register artifact via POST /api/prime/artifacts
  const artPost = await fetch(`${url}/api/prime/artifacts`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/json' },
   body: JSON.stringify({
    title: 'Cyberpunk Skyline Render',
    kind: 'image',
    upload_id: pngMeta.id,
    tags: ['neon', 'city'],
    provenance: {
     source: 'studio',
     prompt: 'cyberpunk skyline',
     model: 'flux-dev',
     capability: 'echo.media.image_generate',
     run_id: 'job_42',
     inputs: [{ upload_id: pngMeta.id, role: 'init' }],
    },
   }),
  });
  expect(artPost.status).toBe(201);
  const art = await artPost.json();
  expect(art.id).toMatch(/^art_[0-9a-f]{32}$/);
  expect(art.provenance).toMatchObject({
   source: 'studio',
   prompt: 'cyberpunk skyline',
   model: 'flux-dev',
   capability: 'echo.media.image_generate',
   run_id: 'job_42',
  });

  // List & filter artifacts
  const listRes = await (await fetch(`${url}/api/prime/artifacts?source=studio&q=flux-dev`, { headers: { cookie, 'x-prime-request': '1' } })).json();
  expect(listRes.artifacts).toHaveLength(1);
  expect(listRes.artifacts[0].id).toBe(art.id);

  // Download artifact file (serves linked upload with attachment disposition)
  const dlRes = await fetch(`${url}/api/prime/artifacts/${art.id}/file?download=1`, { headers: { cookie } });
  expect(dlRes.status).toBe(200);
  expect(dlRes.headers.get('content-disposition')).toMatch(/^attachment;/);

  // Delete artifact
  const delArt = await fetch(`${url}/api/prime/artifacts/${art.id}/delete`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/json' },
   body: '{}',
  });
  expect(delArt.status).toBe(200);
  expect((await fetch(`${url}/api/prime/artifacts/${art.id}`, { headers: { cookie, 'x-prime-request': '1' } })).status).toBe(404);
 });

 it('extracts text for txt, md, csv, json and truncates beyond 64 KiB', async () => {
  const root = makeTempDir('extract-text-');
  const { url, cookie, store } = await bootLocalServer({ root });

  const post = async (name: string, type: string, text: string) => {
   const r = await fetch(`${url}/api/prime/uploads`, {
    method: 'POST',
    headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': type, 'x-upload-filename': name },
    body: text,
   });
   return r.json();
  };

  const md = await post('arch.md', 'text/markdown', '# Architecture\nZero buffering.');
  const csv = await post('metrics.csv', 'text/csv', 'node,latency\nforge,12');
  const json = await post('cfg.json', 'application/json', '{"seats":40}');
  const huge = await post('huge.txt', 'text/plain', 'A'.repeat(80000));

  expect((await store!.extractForChat('local', md.id)).text).toContain('# Architecture');
  expect((await store!.extractForChat('local', csv.id)).text).toContain('forge,12');
  expect((await store!.extractForChat('local', json.id)).text).toContain('"seats":40');

  const hugeEx = await store!.extractForChat('local', huge.id);
  expect(hugeEx.extracted).toBe(true);
  expect(hugeEx.truncated).toBe(true);
  expect(hugeEx.text.length).toBe(65536);
 });

 it('honestly reports text not extracted for scanned/image-only PDFs and encrypted PDFs', async () => {
  const root = makeTempDir('pdf-honest-');
  const { url, cookie, store } = await bootLocalServer({ root });

  const scannedPdf = Buffer.from(
   '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
   '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n' +
   '3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF\n',
   'latin1',
  );
  const encPdf = Buffer.from(
   '%PDF-1.4\n1 0 obj << /Type /Catalog /Encrypt 9 0 R >> endobj\n%%EOF\n',
   'latin1',
  );

  const up1 = await (await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/pdf', 'x-upload-filename': 'scan.pdf' },
   body: scannedPdf,
  })).json();
  const res1 = await store!.extractForChat('local', up1.id);
  expect(res1.extracted).toBe(false);
  expect(res1.reason).toMatch(/text not extracted/i);

  const up2 = await (await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/pdf', 'x-upload-filename': 'locked.pdf' },
   body: encPdf,
  })).json();
  const res2 = await store!.extractForChat('local', up2.id);
  expect(res2.extracted).toBe(false);
  expect(res2.reason).toMatch(/encrypted/i);
 });

 it('honestly reports text not extracted when document exceeds 2 MiB extraction size cap', async () => {
  const root = makeTempDir('extract-cap-');
  const { url, cookie, store } = await bootLocalServer({ root });
  const bigTxt = Buffer.alloc(2 * 1024 * 1024 + 128, 0x62);

  const meta = await (await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'text/plain', 'x-upload-filename': 'log.txt' },
   body: bigTxt,
  })).json();

  const res = await store!.extractForChat('local', meta.id);
  expect(res.extracted).toBe(false);
  expect(res.reason).toMatch(/exceeds .* byte extraction cap/i);
 });

 it('injects extracted upload text into local PrimeHub.chat attachments', async () => {
  const root = makeTempDir('hub-chat-');
  const store = new UploadStore(parseUploadsConfig({ root }));
  let receivedPrompt = '';
  const hub = new PrimeHub({
   capabilities: [],
   uploads: store,
   chat: {
    status: () => ({ state: 'attached', routing: false, detail: 'ok' }),
    submit: async (input: any) => {
     receivedPrompt = input.prompt;
     return { status: 'completed', sessionId: 's1', answer: 'Done' };
    },
   } as any,
  });
  const uiDir = makeTempDir('ui-chat-');
  writeFileSync(join(uiDir, 'index.html'), '<html>Prime</html>');
  const srv = await startPrimeServer(hub, uiDir, 0, { uploads: store });
  closers.push(srv.close);
  const cookie = (await fetch(srv.url)).headers.get('set-cookie')!.split(';')[0];

  const meta = await (await fetch(`${srv.url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: srv.url, 'x-prime-request': '1', 'content-type': 'text/plain', 'x-upload-filename': 'brief.txt' },
   body: 'Mission Alpha Parameter 77',
  })).json();

  await hub.chat({ prompt: 'What is the parameter?', attachments: [meta.id] });
  expect(receivedPrompt).toContain('Mission Alpha Parameter 77');
 });

 it('blocks cross-site Sec-Fetch-Site requests on /file and rejects malformed upload/artifact IDs with 400', async () => {
  const root = makeTempDir('csrf-file-');
  const { url, cookie } = await bootLocalServer({ root });

  const meta = await (await fetch(`${url}/api/prime/uploads`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'image/png', 'x-upload-filename': 'pic.png' },
   body: makeValidPng(8, 8),
  })).json();

  // Cross-site fetch on /file must be blocked with 403
  const cross = await fetch(`${url}/api/prime/uploads/${meta.id}/file`, {
   headers: { cookie, 'sec-fetch-site': 'cross-site' },
  });
  expect(cross.status).toBe(403);

  // Same-site subdomain fetch on /file must also be blocked with 403
  const sameSite = await fetch(`${url}/api/prime/uploads/${meta.id}/file`, {
   headers: { cookie, 'sec-fetch-site': 'same-site' },
  });
  expect(sameSite.status).toBe(403);

  // Malformed IDs -> 400
  expect((await fetch(`${url}/api/prime/uploads/not-valid-id`, { headers: { cookie, 'x-prime-request': '1' } })).status).toBe(400);
  expect((await fetch(`${url}/api/prime/artifacts/not-valid-id`, { headers: { cookie, 'x-prime-request': '1' } })).status).toBe(400);
 });

 it('Rejects unknown artifact fields and serves inline artifact text downloads', async () => {
  const root = makeTempDir('art-inline-');
  const { url, cookie } = await bootLocalServer({ root });

  const bad = await fetch(`${url}/api/prime/artifacts`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/json' },
   body: JSON.stringify({ title: 'Bad', unexpectedField: 1, provenance: { source: 'build' } }),
  });
  expect(bad.status).toBe(400);

  const ok = await fetch(`${url}/api/prime/artifacts`, {
   method: 'POST',
   headers: { cookie, origin: url, 'x-prime-request': '1', 'content-type': 'application/json' },
   body: JSON.stringify({
    title: 'Build Summary',
    kind: 'code',
    type: 'text/markdown',
    content: '# Build Output\nAll green.',
    provenance: { source: 'build', prompt: 'build module', model: 'qwen2.5-coder' },
   }),
  });
  expect(ok.status).toBe(201);
  const art = await ok.json();
  const detail = await (await fetch(`${url}/api/prime/artifacts/${art.id}`, { headers: { cookie, 'x-prime-request': '1' } })).json();
  expect(detail.content).toContain('# Build Output');

  const dl = await fetch(`${url}/api/prime/artifacts/${art.id}/file?download=1`, { headers: { cookie } });
  expect(dl.status).toBe(200);
  expect(await dl.text()).toContain('# Build Output');
 });
});
