// QuanLyYeuCau — lưu tệp / hình ảnh đính kèm của module 18 "Quản lý yêu cầu" (web NOIBO)
// ---------------------------------------------------------------------------------------------
// Chép file này vào API server bk:  apiWebAppNoiBo\src\QuanLyYeuCau\api.js
// Gắn trong src\index.js (cạnh các dòng app.use khác):
//   app.use('/api/server/backup/quan-ly-yeu-cau', require('./QuanLyYeuCau/api'));
// Biến môi trường (.env của API server bk):
//   QLYC_FILE_SECRET=<khoá bí mật — GIỐNG HỆT RQ_FILE_SECRET trong .env của API NOIBO>
//   QLYC_FILE_ROOT=D:\THLA\QuanLyYeuCau      (tuỳ chọn, mặc định như vậy)
//   QLYC_MAX_FILE_MB=50                       (tuỳ chọn)
//
// Chỉ API NOIBO (https://api.thuanhunglongan.com) gọi vào đây. Mọi route (trừ /health) phải có chữ ký:
//   X-Noibo-Ts : giây unix lúc gửi (lệch giờ tối đa 5 phút)
//   X-Noibo-Sig: base64url(HMAC_SHA256(QLYC_FILE_SECRET, `s|<METHOD>|<đường dẫn đầy đủ + query>|<ts>`))
// Công thức phải khớp ApiDuAnRac/src/RequestManagement/files.js (repo NOIBO) — sửa một bên phải sửa cả hai.
//
// Thư mục lưu (QLYC_FILE_ROOT):
//   HinhAnh\2026-10-08\Hoá đơn tháng 10.jpg     ← ảnh
//   TaiLieu\2026-10-08\Bảng kê vật tư.xlsx       ← Word, Excel, PDF, PowerPoint, txt, csv
//   Video\2026-10-08\…                           ← video
//   Khac\2026-10-08\…                            ← zip, rar, dwg, âm thanh… (còn lại)
//   _HeThong\anh-thu-nho, thong-tin, tam         ← dùng nội bộ, ĐỪNG xoá / sửa
// Tên tệp = tên gốc người dùng đặt; trùng tên trong cùng ngày → "Tên (1).jpg", "Tên (2).jpg"…
// ĐỪNG đổi tên / di chuyển tệp trong các thư mục này — web lưu đường dẫn, đổi là mất liên kết.
//
//   GET  /health                                       kiểm tra (không cần chữ ký)
//   PUT  /files?u=<userId>                             lưu tệp (body = nội dung). Header X-File-Name, X-File-Type
//   PUT  /thumb?u=<userId>&key=<mã tệp>                lưu ảnh thu nhỏ của 1 ảnh (chỉ người tải ảnh gốc)
//   GET  /file?key=<mã tệp>[&thumb=1][&dl=1&n=<tên>]   đọc tệp (Range, ETag)
// Mã tệp (key) = đường dẫn tương đối, vd "HinhAnh/2026-10-08/Hoá đơn tháng 10.jpg" — lưu ở rq_Files.storageKey.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

/* ================================ CẤU HÌNH ================================ */
const ROOT = path.resolve(process.env.QLYC_FILE_ROOT || 'D:\\THLA\\QuanLyYeuCau');
const SYS = path.join(ROOT, '_HeThong');
const THUMB_DIR = path.join(SYS, 'anh-thu-nho');
const META_DIR = path.join(SYS, 'thong-tin');
const TMP_DIR = path.join(SYS, 'tam');
const MAX_BYTES = Math.max(1, Number(process.env.QLYC_MAX_FILE_MB || 50)) * 1024 * 1024;
const THUMB_MAX = 2 * 1024 * 1024;
const MAX_SKEW_SEC = 300;
const secret = () => process.env.QLYC_FILE_SECRET || '';

const EXT_GROUPS = {
  HinhAnh: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff'],
  TaiLieu: ['doc', 'docx', 'xls', 'xlsx', 'xlsm', 'csv', 'ppt', 'pptx', 'pdf', 'txt', 'rtf', 'odt', 'ods', 'odp'],
  Video: ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', '3gp'],
};
const GROUP_BY_EXT = {};
for (const [g, list] of Object.entries(EXT_GROUPS)) for (const e of list) GROUP_BY_EXT[e] = g;

// Tệp chạy được trên Windows — không nhận (tránh lây mã độc qua tệp đính kèm). API NOIBO cũng chặn trước.
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'cpl', 'dll', 'jar', 'lnk', 'reg', 'msc', 'sys', 'inf', 'gadget', 'application', 'appx', 'msix', 'iso', 'img', 'vhd', 'vhdx']);
// Loại được xem trực tiếp trên trình duyệt; còn lại luôn tải về
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|bmp|avif)|application\/pdf|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|webm|aac)|text\/plain)$/i;
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf', mp4: 'video/mp4',
  webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', txt: 'text/plain', csv: 'text/csv',
  rtf: 'application/rtf', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', dwg: 'application/acad', ai: 'application/postscript',
  psd: 'image/vnd.adobe.photoshop', svg: 'image/svg+xml',
};
// <nhóm>/<yyyy-mm-dd>/<tên tệp> — tên không chứa \ / : * ? " < > |, không bắt đầu/kết thúc bằng dấu chấm/khoảng trắng
const KEY_RE = /^(HinhAnh|TaiLieu|Video|Khac)\/\d{4}-\d{2}-\d{2}\/(?![. ])[^\\/:*?"<>|\u0000-\u001f]{1,160}(?<![. ])$/;

try { for (const d of [ROOT, THUMB_DIR, META_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('❌ [QuanLyYeuCau] không tạo được thư mục lưu:', e.message); }
if (secret().length < 16) console.error('⚠️ [QuanLyYeuCau] chưa đặt QLYC_FILE_SECRET (≥ 16 ký tự) trong .env — chưa lưu tệp được');

/* ================================ TIỆN ÍCH ================================ */
const hmac = (s) => crypto.createHmac('sha256', secret()).update(s).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function send(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
// từ chối trước khi đọc nội dung tệp: bỏ phần còn lại + đóng kết nối
const reject = (req, res, status, message) => { req.resume(); send(res, status, { message }, { Connection: 'close' }); };
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), '[QuanLyYeuCau]', ...a);
const exists = (p) => fsp.access(p).then(() => true, () => false);
const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const extOf = (name) => (/\.([A-Za-z0-9]{1,10})$/.exec(String(name || ''))?.[1] || '').toLowerCase();
const isKey = (k) => typeof k === 'string' && KEY_RE.test(k);
const keyPath = (base, key, suffix = '') => path.join(base, ...key.split('/')) + suffix;
/** Ngày theo giờ Việt Nam: 2026-10-08 */
const todayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

/** Tên gốc → { base, ext } an toàn cho Windows (giữ tiếng Việt) */
function cleanName(raw) {
  let s = 'tep';
  try { s = decodeURIComponent(String(raw || '')); } catch { s = String(raw || ''); }
  s = s.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  const ext = extOf(s);
  let base = (ext ? s.slice(0, -(ext.length + 1)) : s).replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  base = Array.from(base).slice(0, 120).join('').replace(/[. ]+$/, '') || 'tep';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`; // tên Windows cấm
  return { base, ext };
}

/** Kiểm chữ ký API NOIBO. Trả null nếu đúng, hoặc câu báo lỗi. */
function checkAuth(req) {
  if (secret().length < 16) return 'Chưa cấu hình QLYC_FILE_SECRET ở API server bk';
  const ts = Number(req.headers['x-noibo-ts']);
  const sig = req.headers['x-noibo-sig'];
  if (!Number.isFinite(ts) || !sig) return 'Thiếu chữ ký của API NOIBO';
  const skew = Math.round(ts - Date.now() / 1000);
  if (Math.abs(skew) > MAX_SKEW_SEC) {
    return `Đồng hồ máy chủ API NOIBO và server bk lệch nhau ${skew} giây (cho phép ±${MAX_SKEW_SEC}) — chỉnh lại giờ Windows`;
  }
  if (!safeEqual(sig, hmac(`s|${req.method}|${req.originalUrl}|${ts}`))) {
    return 'Sai chữ ký — QLYC_FILE_SECRET (server bk) khác RQ_FILE_SECRET (API NOIBO)';
  }
  return null;
}

/**
 * Nhận body của request vào tệp tạm (đếm dung lượng, chặn quá lớn).
 * @returns Promise<{ tmp, size }> — reject(err với err.status) khi lỗi (đã xoá tệp tạm)
 */
function receiveToTemp(req, max) {
  return new Promise((resolve, reject2) => {
    const lenHeader = req.headers['content-length'];
    const len = lenHeader === undefined ? null : Number(lenHeader);
    const tmp = path.join(TMP_DIR, `${crypto.randomUUID()}.part`);
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let size = 0;
    let failed = false;
    const fail = (status, message) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fsp.rm(tmp, { force: true }).catch(() => {});
      reject2(Object.assign(new Error(message), { status }));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) { fail(413, `Tệp quá lớn (tối đa ${Math.round(max / 1048576)} MB)`); req.destroy(); return; }
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('aborted', () => fail(400, 'Mất kết nối khi đang tải'));
    req.on('error', () => fail(400, 'Lỗi khi nhận tệp'));
    out.on('error', (e) => { log('❌ ghi đĩa:', e.message); fail(500, 'Server bk không ghi được tệp (đầy đĩa / không có quyền?)'); });
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        if (failed) return;
        if (size === 0) return fail(400, 'Tệp rỗng');
        if (len !== null && size !== len) return fail(400, 'Tệp nhận được không đủ dung lượng');
        resolve({ tmp, size });
      });
    });
  });
}

/** Giữ chỗ tên chưa dùng trong thư mục (tạo tệp rỗng 'wx' — không bao giờ ghi đè) → "Tên.jpg", "Tên (1).jpg"… */
async function reserveName(dir, base, ext) {
  await fsp.mkdir(dir, { recursive: true });
  const dot = ext ? `.${ext}` : '';
  for (let i = 0; i < 1000; i++) {
    const name = i ? `${base} (${i})${dot}` : `${base}${dot}`;
    try {
      const fh = await fsp.open(path.join(dir, name), 'wx');
      await fh.close();
      return name;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw Object.assign(new Error('Quá nhiều tệp trùng tên trong ngày'), { status: 409 });
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.status) return send(res, e.status, { message: e.message }, { Connection: 'close' });
  log('❌', req.method, req.originalUrl.split('?')[0], e.message);
  if (!res.headersSent) send(res, 500, { message: 'Lỗi server bk khi xử lý tệp' });
  else res.destroy();
});

/* ================================ ROUTE ================================ */
router.get('/health', wrap(async (req, res) => {
  let freeGB = null;
  try {
    if (fsp.statfs) { const s = await fsp.statfs(ROOT); freeGB = Math.round((s.bavail * s.bsize) / 1073741824 * 10) / 10; }
  } catch { /* Node cũ không có statfs */ }
  const out = { ok: true, name: 'NOIBO QuanLyYeuCau (server bk)', time: new Date().toISOString(), freeGB, maxMb: MAX_BYTES / 1048576 };
  if (req.headers['x-noibo-sig']) {
    const err = checkAuth(req);
    out.auth = !err;
    if (err) out.authError = err;
  }
  send(res, 200, out);
}));

// các route còn lại: bắt buộc chữ ký của API NOIBO
router.use((req, res, next) => {
  const err = checkAuth(req);
  if (!err) return next();
  log('⛔ từ chối', req.method, req.originalUrl.split('?')[0], clientIp(req), '—', err);
  reject(req, res, 401, err);
});

// Lưu 1 tệp → { key, name, size, mime }
router.put('/files', wrap(async (req, res) => {
  const uid = Number(req.query.u);
  if (!Number.isInteger(uid) || uid <= 0) return reject(req, res, 400, 'Thiếu người tải');
  const len = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
  if (len !== null && len > MAX_BYTES) return reject(req, res, 413, `Tệp quá lớn (tối đa ${MAX_BYTES / 1048576} MB)`);
  const { base, ext } = cleanName(req.headers['x-file-name']);
  if (BLOCKED_EXT.has(ext)) return reject(req, res, 415, `Không nhận tệp .${ext} (tệp chạy chương trình)`);

  const { tmp, size } = await receiveToTemp(req, MAX_BYTES);
  let placeholder = null;
  try {
    const group = GROUP_BY_EXT[ext] || 'Khac';
    const day = todayVN();
    const name = await reserveName(path.join(ROOT, group, day), base, ext);
    const key = `${group}/${day}/${name}`;
    placeholder = keyPath(ROOT, key);
    await fsp.rename(tmp, placeholder); // thay tệp rỗng giữ chỗ bằng nội dung thật
    placeholder = null;
    let mime = String(req.headers['x-file-type'] || '').split(';')[0].trim().toLowerCase();
    if (MIME_BY_EXT[ext] || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    const metaFile = keyPath(META_DIR, key, '.json');
    await fsp.mkdir(path.dirname(metaFile), { recursive: true });
    await fsp.writeFile(metaFile, JSON.stringify({ name, mime, size, u: uid, at: new Date().toISOString() }));
    log('lưu', key, size, `u${uid}`, clientIp(req));
    send(res, 200, { key, name, size, mime });
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (placeholder) await fsp.rm(placeholder, { force: true }).catch(() => {}); // tệp rỗng giữ chỗ
    throw e;
  }
}));

// Lưu ảnh thu nhỏ (JPEG ~480px do trình duyệt tạo) của 1 tệp đã tải — chỉ người tải tệp gốc
router.put('/thumb', wrap(async (req, res) => {
  const uid = Number(req.query.u);
  const key = String(req.query.key || '');
  if (!Number.isInteger(uid) || uid <= 0 || !isKey(key)) return reject(req, res, 400, 'Thiếu người tải / mã tệp không hợp lệ');
  let meta;
  try { meta = JSON.parse(await fsp.readFile(keyPath(META_DIR, key, '.json'), 'utf8')); } catch { return reject(req, res, 404, 'Không tìm thấy tệp gốc'); }
  if (meta.u !== uid) return reject(req, res, 403, 'Không phải tệp của bạn');
  const dest = keyPath(THUMB_DIR, key, '.jpg');
  if (await exists(dest)) return reject(req, res, 409, 'Ảnh thu nhỏ đã có'); // không ghi đè

  const { tmp, size } = await receiveToTemp(req, THUMB_MAX);
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const fh = await fsp.open(dest, 'wx'); // giữ chỗ — 2 request cùng lúc thì 1 cái nhận 409
    await fh.close();
    await fsp.rename(tmp, dest);
    log('ảnh thu nhỏ', key, size, `u${uid}`);
    send(res, 200, { key, size, thumb: true });
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (e.code === 'EEXIST') return send(res, 409, { message: 'Ảnh thu nhỏ đã có' });
    throw e;
  }
}));

// Đọc tệp (API NOIBO chuyển nguyên nội dung + header cho trình duyệt)
router.get('/file', wrap(async (req, res) => {
  const key = String(req.query.key || '');
  if (!isKey(key)) return send(res, 404, { message: 'Không tìm thấy' });
  const ext = extOf(key);
  let p = keyPath(ROOT, key);
  let mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  if (req.query.thumb === '1' && await exists(keyPath(THUMB_DIR, key, '.jpg'))) {
    p = keyPath(THUMB_DIR, key, '.jpg'); // không có ảnh thu nhỏ → trả ảnh gốc
    mime = 'image/jpeg';
  }
  let st;
  try { st = await fsp.stat(p); } catch { return send(res, 404, { message: 'Tệp không còn trên server bk (bị xoá / đổi tên?)' }); }

  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const download = req.query.dl === '1' || !INLINE_TYPES.test(mime);
  // tên khi tải về: ?n= (tên hiển thị trên web) hoặc tên tệp trên đĩa
  const want = req.query.n ? cleanName(encodeURIComponent(String(req.query.n))) : null;
  const name = want ? `${want.base}${want.ext ? `.${want.ext}` : ''}` : key.split('/').pop();
  const asciiName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    // nội dung không đổi theo key → cho trình duyệt cache lâu (đường dẫn do API NOIBO ký có hạn riêng)
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
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start < 0) start = 0;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(p, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
}));

// Dọn tệp tải dở (_HeThong\tam) cũ hơn 1 ngày — mỗi 6 giờ
setInterval(async () => {
  try {
    for (const f of await fsp.readdir(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      const st = await fsp.stat(p);
      if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) await fsp.rm(p, { force: true });
    }
  } catch { /* chưa có thư mục */ }
}, 6 * 3600 * 1000).unref();

module.exports = router;
