// NOIBO — Máy chủ tệp nội bộ (module 18 "Quản lý yêu cầu")
// ---------------------------------------------------------------------------
// Chạy trên 1 máy TRONG MẠNG CÔNG TY. Trình duyệt của nhân viên (đang dùng mạng công ty)
// tải tệp/ảnh THẲNG lên đây và xem/tải về THẲNG từ đây — không đi qua API Internet.
// Ngoài mạng công ty → không vào được máy này → ứng dụng hiện "cần dùng mạng công ty".
//
// Không cần cài thư viện (chỉ dùng Node.js có sẵn). Cấu hình trong file .env cạnh file này
// (xem .env.example) — hướng dẫn đầy đủ: README.md.
//
//   GET  /health                 → kiểm tra (frontend dùng để biết đang ở mạng công ty)
//   PUT  /upload                 → tải 1 tệp lên (body = nội dung tệp), cần vé do API cấp
//   PUT  /upload  + X-Thumb-For  → tải ảnh thu nhỏ của tệp vừa tải
//   GET  /f/<key>?e=&s=          → xem / tải tệp (đường dẫn có chữ ký + hạn do API cấp)
//
// Chữ ký dùng chung khoá FILE_SECRET với API (biến RQ_FILE_SECRET) — công thức phải khớp
// ApiDuAnRac/src/RequestManagement/files.js.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/* ================================ CẤU HÌNH ================================ */
function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* không có .env → dùng biến môi trường */ }
}
loadDotEnv(path.join(__dirname, '.env'));

const CFG = {
  port: Number(process.env.PORT || 8443),
  host: process.env.HOST || '0.0.0.0',
  root: path.resolve(process.env.STORAGE_ROOT || 'D:\\NOIBO_FILES'),
  secret: process.env.FILE_SECRET || '',
  origins: String(process.env.ALLOWED_ORIGINS || 'https://noibo.thuanhunglongan.com,http://localhost:3001')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  maxBytes: Math.max(1, Number(process.env.MAX_FILE_MB || 50)) * 1024 * 1024,
  pfx: process.env.HTTPS_PFX || '',
  pfxPass: process.env.HTTPS_PFX_PASSPHRASE || '',
  key: process.env.HTTPS_KEY || '',
  cert: process.env.HTTPS_CERT || '',
};

if (CFG.secret.length < 16) {
  console.error('❌ Thiếu FILE_SECRET (≥ 16 ký tự, phải giống RQ_FILE_SECRET của API). Xem README.md');
  process.exit(1);
}

// Tệp chạy được trên Windows — không nhận (tránh lây mã độc qua tệp đính kèm)
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'cpl', 'dll', 'jar', 'lnk', 'reg', 'msc', 'sys', 'inf', 'gadget', 'application', 'appx', 'msix', 'iso', 'img', 'vhd', 'vhdx']);
// Loại được xem trực tiếp trên trình duyệt; còn lại luôn tải về
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|bmp|avif)|application\/pdf|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|webm|aac)|text\/plain)$/i;
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  heic: 'image/heic', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', wav: 'audio/wav', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  dwg: 'application/acad', ai: 'application/postscript', psd: 'image/vnd.adobe.photoshop', svg: 'image/svg+xml',
};
const KEY_RE = /^[a-z0-9]{1,10}\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/;

/* ================================ CHỮ KÝ ================================ */
const hmac = (s) => crypto.createHmac('sha256', CFG.secret).update(s).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/** Vé tải lên do API cấp: base64url(JSON {u,p,m,e}).HMAC('t|'+body) */
function readTicket(header) {
  const tok = /^Bearer\s+(.+)$/i.exec(header || '')?.[1] || '';
  const [body, sig] = tok.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(`t|${body}`))) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isInteger(t.u) || !(t.e > Date.now() / 1000) || !/^[a-z0-9]{1,10}$/.test(t.p || '')) return null;
    return t;
  } catch { return null; }
}

/* ================================ TIỆN ÍCH ================================ */
const filePath = (key) => path.join(CFG.root, ...key.split('/'));
const metaPath = (key) => `${filePath(key)}.json`;
const thumbPath = (key) => `${filePath(key)}.thumb.jpg`;

function cors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin && CFG.origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}
function send(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};
function decodeName(raw) {
  let s = 'tep';
  try { s = decodeURIComponent(String(raw || '')); } catch { s = String(raw || ''); }
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 255) || 'tep';
}
function log(...a) {
  console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
}

/* ================================ TẢI LÊN ================================ */
async function handleUpload(req, res) {
  const t = readTicket(req.headers.authorization);
  if (!t) return send(res, 401, { message: 'Vé tải lên không hợp lệ hoặc đã hết hạn — tải lại trang rồi thử lại' });
  const max = Math.min(CFG.maxBytes, Number(t.m) || CFG.maxBytes);
  const len = Number(req.headers['content-length']);
  if (!Number.isFinite(len) || len <= 0) return send(res, 411, { message: 'Thiếu dung lượng tệp' });
  if (len > max) return send(res, 413, { message: `Tệp quá lớn (tối đa ${Math.round(max / 1048576)} MB)` });

  const thumbFor = String(req.headers['x-thumb-for'] || '');
  let key, name, mime, dest;
  if (thumbFor) {
    // ảnh thu nhỏ của tệp vừa tải — chỉ người đã tải tệp gốc mới được gắn
    if (!KEY_RE.test(thumbFor)) return send(res, 400, { message: 'Mã tệp không hợp lệ' });
    let meta;
    try { meta = JSON.parse(await fsp.readFile(metaPath(thumbFor), 'utf8')); } catch { return send(res, 404, { message: 'Không tìm thấy tệp gốc' }); }
    if (meta.u !== t.u) return send(res, 403, { message: 'Không phải tệp của bạn' });
    if (len > 2 * 1024 * 1024) return send(res, 413, { message: 'Ảnh thu nhỏ quá lớn' });
    key = thumbFor;
    dest = thumbPath(thumbFor);
  } else {
    name = decodeName(req.headers['x-file-name']);
    const ext = extOf(name);
    if (BLOCKED_EXT.has(ext)) return send(res, 415, { message: `Không nhận tệp .${ext} (tệp chạy chương trình)` });
    mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || MIME_BY_EXT[ext] || 'application/octet-stream';
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) mime = 'application/octet-stream';
    const d = new Date();
    key = `${t.p}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}${ext ? `.${ext}` : ''}`;
    dest = filePath(key);
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmpDir = path.join(CFG.root, '.tmp');
  await fsp.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${crypto.randomUUID()}.part`);
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  let size = 0;
  let aborted = false;

  const fail = async (status, message) => {
    if (aborted) return;
    aborted = true;
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (!res.headersSent) send(res, status, { message });
    req.destroy();
  };

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > max) { fail(413, 'Tệp quá lớn'); return; }
    if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
  });
  req.on('aborted', () => fail(400, 'Mất kết nối khi đang tải'));
  req.on('error', () => fail(400, 'Lỗi khi nhận tệp'));
  out.on('error', (e) => { log('❌ ghi đĩa:', e.message); fail(500, 'Máy chủ tệp không ghi được (đầy đĩa / không có quyền?)'); });
  req.on('end', () => {
    if (aborted) return;
    out.end(async () => {
      try {
        if (size !== len) return fail(400, 'Tệp nhận được không đủ dung lượng');
        await fsp.rename(tmp, dest);
        if (thumbFor) {
          log('thumb', key, size, 'u' + t.u);
          return send(res, 200, { key, thumb: true });
        }
        await fsp.writeFile(metaPath(key), JSON.stringify({ name, mime, size, u: t.u, at: new Date().toISOString() }));
        log('upload', key, size, 'u' + t.u, name);
        send(res, 200, { key, name, size, mime, sig: hmac(`u|${key}|${size}|${t.u}`) });
      } catch (e) {
        log('❌ lưu tệp:', e.message);
        fail(500, 'Không lưu được tệp');
      }
    });
  });
}

/* ================================ XEM / TẢI VỀ ================================ */
async function handleGet(req, res, url) {
  const key = decodeURIComponent(url.pathname.slice(3)); // bỏ "/f/"
  if (!KEY_RE.test(key)) return send(res, 404, { message: 'Không tìm thấy' });
  const exp = Number(url.searchParams.get('e'));
  if (!(exp > Date.now() / 1000) || !safeEqual(url.searchParams.get('s'), hmac(`d|${key}|${exp}`))) {
    return send(res, 403, { message: 'Đường dẫn đã hết hạn — tải lại trang để lấy đường dẫn mới' });
  }
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(metaPath(key), 'utf8')); } catch { /* tệp cũ không có meta */ }

  let p = filePath(key);
  let mime = meta.mime || MIME_BY_EXT[extOf(key)] || 'application/octet-stream';
  if (url.searchParams.get('t') === '1') {
    try { await fsp.access(thumbPath(key)); p = thumbPath(key); mime = 'image/jpeg'; } catch { /* không có ảnh thu nhỏ → ảnh gốc */ }
  }
  let st;
  try { st = await fsp.stat(p); } catch { return send(res, 404, { message: 'Tệp không còn trên máy chủ' }); }

  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const download = url.searchParams.get('dl') === '1' || !INLINE_TYPES.test(mime);
  const name = decodeName(url.searchParams.get('n') ? encodeURIComponent(url.searchParams.get('n')) : meta.name || path.basename(key));
  const asciiName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    // nội dung không đổi theo key → cho trình duyệt cache lâu (đường dẫn có hạn riêng)
    'Cache-Control': 'private, max-age=604800, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  // PDF cần trình xem của trình duyệt → không đặt sandbox; loại khác chặn chạy script
  if (mime !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    if (start < 0) start = 0;
    if (start > end || end >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
}

/* ================================ MÁY CHỦ ================================ */
async function handler(req, res) {
  cors(req, res);
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      // Preflight: CORS + Private Network Access (trang Internet gọi vào máy trong mạng LAN)
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name, X-Thumb-For, Range',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (url.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return send(res, 200, { ok: true, name: 'NOIBO file server', time: new Date().toISOString() });
    }
    if (url.pathname === '/upload' && req.method === 'PUT') return await handleUpload(req, res);
    if (url.pathname.startsWith('/f/') && (req.method === 'GET' || req.method === 'HEAD')) return await handleGet(req, res, url);
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('NOIBO - may chu tep noi bo dang chay. Kiem tra: /health');
    }
    send(res, 404, { message: 'Không tìm thấy' });
  } catch (e) {
    log('❌', req.method, url.pathname, e.message);
    if (!res.headersSent) send(res, 500, { message: 'Lỗi máy chủ tệp' });
    else res.destroy();
  }
}

function tlsOptions() {
  if (CFG.pfx) return { pfx: fs.readFileSync(CFG.pfx), passphrase: CFG.pfxPass };
  if (CFG.key && CFG.cert) return { key: fs.readFileSync(CFG.key), cert: fs.readFileSync(CFG.cert) };
  return null;
}

fs.mkdirSync(CFG.root, { recursive: true });
const tls = tlsOptions();
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
server.requestTimeout = 30 * 60 * 1000; // tệp lớn qua Wi-Fi yếu
server.headersTimeout = 60 * 1000;
server.listen(CFG.port, CFG.host, () => {
  log(`✅ Máy chủ tệp NOIBO chạy ${tls ? 'HTTPS' : 'HTTP (chưa có chứng chỉ — chỉ dùng để thử)'} cổng ${CFG.port}`);
  log(`   Thư mục lưu: ${CFG.root} · tối đa ${CFG.maxBytes / 1048576} MB/tệp · cho phép web: ${CFG.origins.join(', ')}`);
});
server.on('error', (e) => { console.error('❌ Không mở được cổng:', e.message); process.exit(1); });

// Dọn tệp tải dở (.tmp) cũ hơn 1 ngày — mỗi 6 giờ
setInterval(async () => {
  try {
    const dir = path.join(CFG.root, '.tmp');
    for (const f of await fsp.readdir(dir)) {
      const p = path.join(dir, f);
      const st = await fsp.stat(p);
      if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) await fsp.rm(p, { force: true });
    }
  } catch { /* chưa có thư mục .tmp */ }
}, 6 * 3600 * 1000).unref();
