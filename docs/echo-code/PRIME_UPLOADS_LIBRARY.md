# ECHO Prime Uploads, Unified Library & Artifact Center

This document specifies the opt-in streaming uploads subsystem (`src/prime/uploads.ts`), generation and chat integration, and the unified **Library + Artifact Center** (`ui/echo-prime/library.js`, `ui/echo-prime/library.css`) in ECHO Prime.

---

## 1. Opt-In Configuration (`uploads`)

Uploads and Artifact Center persistence are strictly **opt-in** in the reviewed Prime JSON configuration (`echo prime --config <file>`). When `uploads` is omitted, no upload directory is opened, `GET /api/prime/uploads/list` and `GET /api/prime/artifacts` report `{ "configured": false }`, and mutating routes return `503`.

```json
{
  "uploads": {
    "root": "D:\\ECHO_PRIME_DATA\\uploads",
    "maxBytes": 209715200,
    "types": [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "audio/mpeg",
      "audio/wav",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "docx",
      "xlsx",
      "pptx"
    ]
  }
}
```

### Configuration Rules (`parseUploadsConfig`)
- **Unknown keys refused**: only `root`, `maxBytes`, and `types` are accepted; any extra field throws immediately at startup.
- **`root`** (required): non-empty directory path (filesystem roots such as `/` or `C:\` are refused).
- **`maxBytes`** (optional): default `209715200` (200 MiB), integer `1 .. 2147483648` (2 GiB ceiling).
- **`types`** (optional): subset of the v1 allowlist (`ALLOWED_UPLOAD_TYPES`). Short aliases `docx`, `xlsx`, and `pptx` normalize to their canonical OOXML MIME types (`application/vnd.openxmlformats-officedocument.*`). HTML (`text/html`), SVG (`image/svg+xml`), archives (`application/zip`), and executables are never permitted.

---

## 2. Storage Layout & Account Isolation

Every upload and artifact is isolated under a sanitized per-account directory derived from the authenticated Workspace `session.user.uid` (or `local` when Prime runs in loopback-only mode without a Workspace backend):

```text
<root>/
  <account>/
    upl_<32hex>/
      blob        # Streamed payload (0600 permissions; EXIF GPS stripped for JPEG)
      meta.json   # Atomic sidecar metadata
      thumb.png   # Optional 160px pure-JS thumbnail for 8-bit RGB/RGBA PNGs
    _artifacts/
      art_<32hex>/
        meta.json # Artifact record + provenance
        content   # Optional inline UTF-8/JSON payload (up to 2 MiB)
```

In-flight uploads write to `<root>/<account>/.tmp_<uuid>/` and atomically `rename` to `<upload_id>/` only after size, magic-byte, hygiene, and SHA-256 checks succeed. Any failure or mid-stream `413` size violation closes the file handle and removes `.tmp_<uuid>/`.

### Sidecar `meta.json` Schema (`UploadMeta`)
- `id`: `upl_<32hex>`
- `name`: sanitized filename
- `type`: canonical allowlisted MIME type
- `bytes`: stored byte length
- `sha256`: lowercase hex SHA-256 of the stored file
- `created_at` / `updated_at`: ISO-8601 timestamps
- `owner`: account UID (`session.user.uid` or `local`)
- `kind`: `image | video | audio | document | file`
- Optional cheap media metadata:
  - `width`, `height`: derived from PNG `IHDR`, JPEG `SOF`, GIF header, or WebP `VP8 `/`VP8L`/`VP8X`
  - `duration`: derived in seconds from RIFF WAV (`fmt `/`data`) or ISO BMFF MP4/MOV (`moov`/`mvhd`)
  - `pages`: derived for PDFs by counting `/Type /Page` leaf dictionaries across chunk boundaries
  - `exif_gps_stripped`: `true` when JPEG GPS EXIF/XMP metadata was stripped during upload
  - `thumb`: `true` when `thumb.png` was generated
  - `tags`: up to 16 sanitized tags (`<= 40` chars each)

---

## 3. HTTP Routes & Admission

All `/api/prime/uploads*` and `/api/prime/artifacts*` routes enforce same-origin Prime cookie validation (`echo_prime`), host-rebinding protection, and—when Workspace is configured—`WorkspaceBridge.requireApproved` (admitting both the pinned primary owner and approved Workspace members under their own `uid`, while rejecting anonymous `401` and unapproved/pending `403` callers, and verifying `X-Echo-Csrf` + `Origin` on mutations).

| Method & Path | Purpose |
|---|---|
| `POST /api/prime/uploads` | Streaming `multipart/form-data` or chunked raw binary (`X-Upload-Filename` / `X-Upload-Name`) upload. Never buffers the full file in memory. Returns `201 UploadMeta`. |
| `GET /api/prime/uploads/list` | Lists account uploads (`?kind=` and `?q=` filters) plus `{configured, maxBytes, types}`. |
| `GET /api/prime/uploads/:id` | Returns `UploadMeta` for `upl_<32hex>` (`404` if owned by another account). |
| `GET /api/prime/uploads/:id/file` | Streams the file (or `?thumb=1` PNG thumbnail) with `Accept-Ranges: bytes`, HTTP `206 Partial Content` / `416 Range Not Satisfiable`, exact `Content-Type`, `Content-Disposition` (`inline` for safe media/PDF/plain-text unless `?download=1`, `attachment` for OOXML/CSV/JSON/MD), and `X-Content-Type-Options: nosniff`. Blocks `Sec-Fetch-Site: cross-site` and `same-site`. |
| `POST /api/prime/uploads/:id/update` | Updates `name` and/or `tags` on `meta.json`. |
| `POST /api/prime/uploads/:id/delete` | Removes the upload directory (`200 {id, deleted: true}`). |
| `GET /api/prime/artifacts` | Lists registered artifacts (`?kind=`, `?source=`, `?q=`). |
| `POST /api/prime/artifacts` | Additive registry hook for Studio, Echo Build, ADK runs, and chat exports (`201 ArtifactRecord`). |
| `GET /api/prime/artifacts/:id` | Returns `ArtifactRecord` (and inline `content` when stored). |
| `GET /api/prime/artifacts/:id/file` | Downloads the linked upload or inline artifact payload (`Content-Disposition: attachment`). |
| `POST /api/prime/artifacts/:id/delete` | Deletes the artifact record (`200 {id, deleted: true}`). |

---

## 4. Virus, Executable, Archive & EXIF Hygiene

### Executable, Archive & Credential Refusal
1. **Filename refusal**: credential filenames (`.env*`, `id_rsa`, `id_ed25519`, `*credentials*`, `*secret*`, `.pem`, `.key`, `.pfx`, `.p12`, `.kdbx`, `.jks`) are refused (`400`) and directed to the Vault. Executable, script, library, installer, and archive extensions (`.exe`, `.dll`, `.msi`, `.bat`, `.ps1`, `.sh`, `.js`, `.py`, `.jar`, `.apk`, `.elf`, `.so`, `.dylib`, `.wasm`, `.zip`, `.tar`, `.gz`, `.7z`, `.rar`, etc.) are refused (`415`).
2. **Magic-byte inspection**: the first 512 bytes of every upload are checked mid-stream against executable and archive signatures (`MZ` PE, `\x7fELF`, Mach-O `FEEDFACE`/`FEEDFACF`/`CAFEBABE`, `wasm`, `#!` shebangs, RAR, 7z, gzip, bzip2, xz, zstd, tar `ustar`), and verified against positive magic headers for PNG, JPEG, GIF, WebP, MP4/MOV (`ftyp`), WebM (`\x1A\x45\xDF\xA3`), MP3 (`ID3`/sync), WAV (`RIFF....WAVE`), and PDF (`%PDF-`).
3. **OOXML ZIP inspection**: `PK\x03\x04` headers are permitted **only** for `.docx`, `.xlsx`, and `.pptx`. After streaming to disk, Prime parses the ZIP End of Central Directory (`EOCD`) and Central Directory headers to verify `[Content_Types].xml` and the expected `word/`, `xl/`, or `ppt/` root exist, and **refuses** the file (`415`) if it contains `vbaProject.bin` macros or embedded executable entries.

### JPEG EXIF GPS Stripping Method (`JpegHeaderTransformer` / `stripJpegExifGps`)
JPEG metadata segments always precede the Start-Of-Scan (`0xFFDA` `SOS`) marker. Prime strips location metadata during the streaming write without buffering the entropy-coded image scan:
1. **Pre-`SOS` marker parser**: `JpegHeaderTransformer` inspects JPEG markers (`0xFFxx`) after `SOI` (`0xFFD8`) up to `SOS` (`0xFFDA`, bounded to 4 MiB of header markers), extracting image dimensions from `SOF` markers (`0xFFC0..0xFFCF`) and intercepting every `APP1` (`0xFFE1`) segment. Once `SOS` is reached, all remaining scan bytes stream directly through to disk untouched.
2. **Exif TIFF (`II` / `MM`) in-place sanitization**:
   - Inside `Exif\0\0`, Prime parses the TIFF endianness (`II` little-endian or `MM` big-endian), `0x002A` magic, and IFD chain (`IFD0` -> `IFD1`, with cycle protection).
   - When `GPSInfoIFDPointer` (`0x8825`) is present in an IFD:
     - Prime locates the pointed-to GPS IFD, walks every 12-byte GPS tag entry, zeroes any external GPS value byte ranges (such as `RATIONAL` latitude/longitude/altitude/timestamp arrays), and zeroes the entire GPS IFD table itself so raw coordinate bytes no longer exist anywhere in the segment.
     - Prime removes the 12-byte `0x8825` directory entry from the parent IFD by shifting subsequent entries in that same IFD left by 12 bytes, decrementing the IFD entry count by 1, preserving the 4-byte `nextIFD` pointer immediately after the shortened entry list, and zeroing the vacated 12-byte slack slot.
     - Because the `APP1` segment length is unchanged and external TIFF value offsets are absolute offsets from the TIFF header start, **all non-GPS EXIF tags (camera make/model, orientation, exposure, color profile) remain intact at valid offsets**.
3. **XMP & fail-closed fallback**: `APP1` XMP packets (`http://ns.adobe.com/xap/1.0/\0`) containing `exif:GPS*` properties, or malformed `Exif\0\0` segments that cannot be safely parsed, are dropped cleanly before `SOS`.

### Pure-JS PNG Thumbnails
For 8-bit RGB and RGBA non-interlaced PNGs up to 16 MiB (`<= 36 MP`), Prime decompresses `IDAT` via Node's built-in `node:zlib`, reconstructs PNG scanline filters (`None`, `Sub`, `Up`, `Average`, `Paeth`), box/nearest-neighbor downsamples to `160 px` max edge, and writes `thumb.png` with zero native or npm image dependencies. All other image formats (`JPEG`, `WebP`, `GIF`, 16-bit/indexed PNG) gracefully serve the stored image with CSS `object-fit: cover` scaling.

---

## 5. Generation, Chat Q&A & Artifact Center

### Studio Reference Inputs (`EchoPrimeStudio`)
- `ui/echo-prime/integrations.js` extends Creative Studio (`Image` / `Video` / media modes) with reference upload inputs:
  ```json
  {
    "command": "image_generate",
    "options": { "prompt": "Transform into dusk lighting", "wait": false },
    "inputs": [
      { "upload_id": "upl_0123456789abcdef0123456789abcdef", "role": "init" }
    ]
  }
  ```
- Supported roles (`STUDIO_INPUT_ROLES`): `reference`, `init`, `mask`, `audio`, `script` (max 8 per request). `PrimeHub.prepare` validates schema and verifies each `upload_id` exists in the caller's upload store before issuing a review ticket.

### Chat Document Q&A (`attachments`)
- Composer `＋ Attach` (`ui/echo-prime/composer.js`) and Library `"Attach to chat"` add `upl_<32hex>` IDs to `bridge.state.attachments` (rendering removable chips with thumbnails for images).
- On `POST /api/workspace/chat` (`src/prime/workspace.ts`) and `POST /api/chat` (`src/prime/hub.ts`), Prime resolves `upl_*` IDs for the authenticated account on the server, extracts UTF-8 text (capped at **2 MiB** source file size and **64 KiB** extracted characters per file, redacted via `redact()`), appends an explicitly labeled untrusted document section to the turn, and forwards Workspace library IDs unchanged:
  - `text/plain`, `text/markdown`, `text/csv`, `application/json`: direct UTF-8 extraction.
  - `application/pdf`: dependency-free stream parser (`extractPdfText`) that inflates `/FlateDecode` content streams via `node:zlib` and decodes PDF text blocks (`BT ... ET` operators `Tj`, `TJ`, `'`, `"` with octal/escaped literals and UTF-16BE BOM hex strings). Encrypted PDFs, scanned image-only PDFs, custom `ToUnicode`-only font maps, binary media, OOXML files, and files over 2 MiB never fabricate text—they report `[text not extracted: <reason>]` honestly.

### Unified Library & Artifact Center (`ui/echo-prime/library.js`)
- **Library tab**: merges Prime uploads and Workspace library items with Grid/List toggle, filters by kind (`all`, `image`, `video`, `audio`, `document`, `file`, `workspace`), live search across names/paths/types/tags, modal previews (`<img>`, `<video controls>`, `<audio controls>`, `<iframe class="preview-pdf">`, Range-bounded `<pre>` text), inline rename & tags, inline two-step delete (no `window.confirm()`), `"Use in Studio"`, `"Attach to chat"`, and preserved Workspace note authoring / 100 KB text upload / 1.9 MB chat import.
- **Artifact Center tab**: lists outputs registered via `POST /api/prime/artifacts` (`window.EchoPrimeArtifacts.register` / `hub.registerArtifact`) from Creative Studio, Echo Build (`chat.js`), Echo ADK runs (`agents.js`), and exported conversations, displaying full provenance (`source`, `prompt`, `model`, `capability`, `agent`, `run_id`, `verdict`, `events_sha256`, `chat_id`, `inputs`) with Preview, Download, Re-use, and two-step Delete.

### Structured Diagnostics (`NODE_DEBUG=echo-prime`)
Structured JSON events (never containing file contents or credentials):
- `prime_upload_started`, `prime_upload_completed`, `prime_upload_refused`, `prime_upload_exif_stripped`, `prime_upload_updated`, `prime_upload_deleted`, `prime_upload_text_extracted`
- `prime_artifact_registered`, `prime_artifact_deleted`
