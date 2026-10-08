// RequestManagement/files.js — tệp/ảnh đính kèm của module 18, lưu ở SERVER BK (sv-backup 10.84.40.34)
// trong D:\THLA\QuanLyYeuCau, qua API của server bk (apiWebAppNoiBo cổng 5000, router QuanLyYeuCau —
// bản để chép nằm ở ApiDuAnRac/apiWebAppNoiBo/src/QuanLyYeuCau/api.js).
//
// RQ_FILE_SERVER_URL = gốc router đó:  máy dev     http://10.84.40.34:5000/api/server/backup/quan-ly-yeu-cau
//                                      production  http://118.69.134.179:5000/api/server/backup/quan-ly-yeu-cau
//                                      (máy chủ online không vào thẳng 10.84.40.34 — đi qua cổng 5000 router chuyển, như MES)
// Trình duyệt chỉ nói chuyện với API này (https). API chuyển tiếp sang server bk (http):
//   tải lên : PUT /api/rq/files/upload (đăng nhập)                 → PUT <RQ_FILE_SERVER_URL>/files?u=<userId>
//             ảnh thu nhỏ (header X-Thumb-For)                      → PUT <…>/thumb?u=<userId>&key=<mã tệp>
//   xem/tải : GET /api/rq/f?k=<mã tệp>&e=&s= (đường dẫn có chữ ký —
//             dùng được trong <img>, không cần token)               → GET <…>/file?key=<mã tệp>
// Mã tệp (rq_Files.storageKey) = đường dẫn trên server bk do server bk đặt: "HinhAnh/2026-10-08/Hoá đơn.jpg".
// Nội dung tệp chỉ CHẢY QUA (stream) — không lưu trên máy chủ API, không đọc hết vào RAM.
//
// Mỗi request sang server bk ký HMAC bằng RQ_FILE_SECRET (== QLYC_FILE_SECRET ở .env server bk):
//   X-Noibo-Ts = giây unix, X-Noibo-Sig = HMAC(`s|<METHOD>|<đường dẫn đầy đủ + query>|<ts>`)
// Công thức phải khớp apiWebAppNoiBo/src/QuanLyYeuCau/api.js — sửa một bên phải sửa cả hai.
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const secret = () => process.env.RQ_FILE_SECRET || '';
const serverUrl = () => String(process.env.RQ_FILE_SERVER_URL || '').trim().replace(/\/+$/, '');
const maxMb = () => Math.max(1, Number(process.env.RQ_FILE_MAX_MB) || 50);

const enabled = () => secret().length >= 16 && /^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(serverUrl());
const hmac = (s) => crypto.createHmac('sha256', secret()).update(s).digest('base64url');
const MB = 1024 * 1024;
const NOT_CONFIGURED = 'Chưa cấu hình nơi lưu tệp — liên hệ IT (RQ_FILE_SERVER_URL, RQ_FILE_SECRET)';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// <nhóm>/<yyyy-mm-dd>/<tên tệp> (vd HinhAnh/2026-10-08/Hoá đơn (1).jpg) — chặn đường dẫn lạ (../, \, ký tự cấm của Windows).
// GIỐNG HỆT KEY_RE trong apiWebAppNoiBo/src/QuanLyYeuCau/api.js
const KEY_RE = /^(HinhAnh|TaiLieu|Video|Khac)\/\d{4}-\d{2}-\d{2}\/(?![. ])[^\\/:*?"<>|\u0000-\u001f]{1,160}(?<![. ])$/;
// Tệp chạy được trên Windows — không nhận (server bk cũng chặn)
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'cpl', 'dll', 'jar', 'lnk', 'reg', 'msc', 'sys', 'inf', 'gadget', 'application', 'appx', 'msix', 'iso', 'img', 'vhd', 'vhdx']);

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};
function decodeName(raw) {
  let s = 'tep';
  try { s = decodeURIComponent(String(raw || '')); } catch { s = String(raw || ''); }
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 255) || 'tep';
}
function cleanMime(v) {
  const m = String(v || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m.slice(0, 150) : '';
}

/** Chữ ký API cấp sau khi tải lên xong: HMAC('u|key|size|userId') — kiểm lại khi gắn tệp vào đề xuất/bình luận/tin nhắn */
const uploadSig = (key, size, userId) => hmac(`u|${key}|${size}|${userId}`);
function verifyUpload(file, userId) {
  if (!file || !KEY_RE.test(String(file.key || ''))) return false;
  const size = Number(file.size);
  if (!Number.isInteger(size) || size < 0) return false;
  return safeEqual(file.sig, uploadSig(file.key, size, userId));
}

const HALF_DAY = 12 * 3600;
/**
 * Đường dẫn xem/tải tệp (TƯƠNG ĐỐI — frontend ghép với địa chỉ API). Hạn làm tròn theo mốc 12 giờ →
 * cùng 1 tệp có cùng URL trong ít nhất 12 giờ, trình duyệt dùng lại bản đã cache.
 */
function fileUrl(key, { thumb = false, download = false, name = '' } = {}) {
  if (!enabled() || !key) return null;
  const exp = (Math.floor(Date.now() / 1000 / HALF_DAY) + 2) * HALF_DAY;
  let url = `/api/rq/f?k=${encodeURIComponent(key)}&e=${exp}&s=${hmac(`d|${key}|${exp}`)}`;
  if (thumb) url += '&t=1';
  if (download) url += `&dl=1&n=${encodeURIComponent(name || 'tep')}`;
  return url;
}
function verifyView(key, e, s) {
  const exp = Number(e);
  return KEY_RE.test(key) && exp > Date.now() / 1000 && safeEqual(s, hmac(`d|${key}|${exp}`));
}

const IMAGE_RE = /^image\/(jpeg|png|gif|webp|bmp|avif)$/i;

/** Dòng rq_Files → object trả cho frontend (kèm URL đã ký) */
function fileOut(f) {
  const isImage = IMAGE_RE.test(f.mimeType || '');
  return {
    fileId: f.fileId,
    name: f.fileName,
    mime: f.mimeType,
    size: Number(f.sizeBytes),
    isImage,
    width: f.width || null,
    height: f.height || null,
    fieldKey: f.fieldKey || null,
    ownerType: f.ownerType,
    ownerId: f.ownerId === undefined || f.ownerId === null ? null : Number(f.ownerId),
    uploadedBy: f.uploadedBy,
    createdAt: f.createdAt,
    url: fileUrl(f.storageKey),
    thumbUrl: isImage && f.hasThumb ? fileUrl(f.storageKey, { thumb: true }) : isImage ? fileUrl(f.storageKey) : null,
    downloadUrl: fileUrl(f.storageKey, { download: true, name: f.fileName }),
  };
}

/**
 * Kiểm tra danh sách tệp client gửi kèm (sau khi đã tải lên qua PUT /files/upload).
 * @returns mảng đã chuẩn hoá để ghi rq_Files
 */
function readAttachments(list, userId, { max = 20, allowFieldKey = false } = {}) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > max) {
    const e = new Error(`Tối đa ${max} tệp mỗi lần`);
    e.status = 400;
    throw e;
  }
  if (arr.length && !enabled()) {
    const e = new Error(NOT_CONFIGURED);
    e.status = 400;
    throw e;
  }
  const seen = new Set();
  return arr.map((f) => {
    if (!verifyUpload(f, userId)) {
      const e = new Error('Tệp đính kèm không hợp lệ hoặc chưa tải lên xong — vui lòng tải lại tệp');
      e.status = 400;
      throw e;
    }
    if (seen.has(f.key)) return null;
    seen.add(f.key);
    return {
      key: f.key,
      name: String(f.name || 'tep').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 255),
      mime: String(f.mime || 'application/octet-stream').slice(0, 150),
      size: Number(f.size),
      hasThumb: !!f.hasThumb,
      width: Number.isInteger(f.width) ? f.width : null,
      height: Number.isInteger(f.height) ? f.height : null,
      fieldKey: allowFieldKey && /^[A-Za-z0-9_-]{1,40}$/.test(f.fieldKey || '') ? f.fieldKey : null,
    };
  }).filter(Boolean);
}

function clientConfig() {
  return { enabled: enabled(), maxMb: maxMb() };
}

/* ======================= GỌI SERVER BK (http) ======================= */
// giữ kết nối để không bắt tay TCP lại mỗi ảnh (server bk ở xa, qua Internet)
const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 16 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 16 }) };

/**
 * Mở request có chữ ký tới server bk. pathAndQuery bắt đầu bằng '/' (vd '/files?u=5'), ghép sau
 * đường dẫn gốc của RQ_FILE_SERVER_URL. Chữ ký tính trên ĐƯỜNG DẪN ĐẦY ĐỦ gửi đi (= req.originalUrl ở server bk).
 */
function serverRequest(method, pathAndQuery, headers = {}) {
  const base = new URL(serverUrl());
  const fullPath = base.pathname.replace(/\/+$/, '') + pathAndQuery;
  const ts = Math.floor(Date.now() / 1000);
  const lib = base.protocol === 'https:' ? https : http;
  return lib.request({
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || undefined,
    method,
    path: fullPath,
    agent: agents[base.protocol],
    headers: { ...headers, 'X-Noibo-Ts': String(ts), 'X-Noibo-Sig': hmac(`s|${method}|${fullPath}|${ts}`) },
  });
}

/** Đọc body JSON nhỏ (≤ 64 KB) từ server bk */
function readJson(r) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    r.on('data', (c) => { n += c.length; if (n <= 65536) chunks.push(c); });
    r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({}); } });
    r.on('error', () => resolve({}));
  });
}

function sendJson(res, status, obj, extra = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

const unreachable = (e) => `Không kết nối được máy chủ lưu tệp (server bk) (${e.code || e.message}) — báo IT kiểm tra API server bk cổng 5000`;

/**
 * PUT /api/rq/files/upload — nhận tệp từ trình duyệt, chuyển thẳng sang server bk.
 * Header: X-File-Name (encodeURIComponent), X-File-Type (mime thật — Content-Type luôn là octet-stream
 * để không middleware nào đọc body), X-Thumb-For (key) khi tải ảnh thu nhỏ.
 * Server bk tự đặt mã tệp (nhóm/ngày/tên gốc, trùng thì thêm " (1)"). Trả { key, name, size, mime, sig }
 * — client gửi lại khi tạo đề xuất/bình luận/tin nhắn.
 */
function proxyUpload(req, res, userId) {
  const reject = (status, message) => { req.resume(); sendJson(res, status, { success: false, message }, { Connection: 'close' }); };
  if (!enabled()) return reject(409, NOT_CONFIGURED);
  const lenHeader = req.headers['content-length'];
  const len = lenHeader === undefined ? null : Number(lenHeader);
  if (len !== null && !(Number.isInteger(len) && len >= 0)) return reject(400, 'Dung lượng tệp không hợp lệ');
  if (len === 0) return reject(400, 'Tệp rỗng');
  if (len !== null && len > maxMb() * MB) return reject(413, `Tệp quá lớn (tối đa ${maxMb()} MB)`);

  // mã tệp có dấu tiếng Việt → trình duyệt gửi dạng encodeURIComponent (header HTTP chỉ nhận Latin-1)
  let thumbFor = '';
  try { thumbFor = decodeURIComponent(String(req.headers['x-thumb-for'] || '')); } catch { return reject(400, 'Mã tệp không hợp lệ'); }
  let name = '';
  let mime = '';
  if (thumbFor) {
    if (!KEY_RE.test(thumbFor)) return reject(400, 'Mã tệp không hợp lệ');
    if (len !== null && len > 2 * MB) return reject(413, 'Ảnh thu nhỏ quá lớn');
  } else {
    name = decodeName(req.headers['x-file-name']);
    const ext = extOf(name);
    if (BLOCKED_EXT.has(ext)) return reject(415, `Không nhận tệp .${ext} (tệp chạy chương trình)`);
    mime = cleanMime(req.headers['x-file-type']);
  }

  const headers = { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-File-Type': mime };
  if (len !== null) headers['Content-Length'] = String(len);
  const up = serverRequest('PUT', thumbFor
    ? `/thumb?u=${userId}&key=${encodeURIComponent(thumbFor)}`
    : `/files?u=${userId}`, headers);
  let done = false;
  const stopUpload = () => { req.unpipe(up); req.resume(); };

  up.setTimeout(120000, () => up.destroy(Object.assign(new Error('hết thời gian chờ'), { code: 'TIMEOUT' })));
  up.on('response', async (r) => {
    const data = await readJson(r);
    if (done) return;
    done = true;
    if (r.statusCode !== 200) {
      stopUpload();
      if (r.statusCode === 401) console.error('❌ [rq] server bk từ chối chữ ký:', data.message);
      const status = r.statusCode === 401 || r.statusCode >= 500 || r.statusCode === 404 ? 502 : r.statusCode;
      const message = data.message || (r.statusCode === 404
        ? 'Server bk chưa có API lưu tệp (chưa chép QuanLyYeuCau/api.js hoặc chưa khởi động lại) — báo IT'
        : `Server bk báo lỗi ${r.statusCode}`);
      return sendJson(res, status, { success: false, message }, { Connection: 'close' });
    }
    if (thumbFor) return sendJson(res, 200, { success: true, data: { key: thumbFor, thumb: true } });
    const key = String(data.key || '');
    const size = Number(data.size);
    if (!KEY_RE.test(key) || !Number.isInteger(size)) {
      console.error('❌ [rq] server bk trả mã tệp lạ:', key);
      return sendJson(res, 502, { success: false, message: 'Server bk trả kết quả không hợp lệ' });
    }
    sendJson(res, 200, { success: true, data: { key, name, size, mime: data.mime || mime || 'application/octet-stream', sig: uploadSig(key, size, userId) } });
  });
  up.on('error', (e) => {
    if (done) return;
    done = true;
    stopUpload();
    console.error('❌ [rq] tải tệp lên server bk:', e.code || e.message);
    sendJson(res, 502, { success: false, message: unreachable(e) }, { Connection: 'close' });
  });
  // người dùng huỷ / mất mạng giữa chừng → huỷ luôn bên server bk (tệp tạm tự xoá)
  res.on('close', () => { if (!done) { done = true; up.destroy(); } });
  req.pipe(up);
}

// header của server bk được chuyển nguyên cho trình duyệt
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control',
  'content-disposition', 'content-security-policy', 'x-content-type-options'];

/** GET /api/rq/f?k=<mã tệp>&e=&s=[&t=1][&dl=1&n=] — kiểm chữ ký đường dẫn rồi chuyển nội dung từ server bk về */
function proxyView(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const key = q.get('k') || '';
  if (!verifyView(key, q.get('e'), q.get('s'))) {
    return sendJson(res, KEY_RE.test(key) ? 403 : 404, { success: false, message: 'Đường dẫn đã hết hạn — tải lại trang để lấy đường dẫn mới' });
  }
  if (!enabled()) return sendJson(res, 503, { success: false, message: NOT_CONFIGURED });

  const fq = new URLSearchParams({ key });
  if (q.get('t') === '1') fq.set('thumb', '1');
  if (q.get('dl') === '1') { fq.set('dl', '1'); fq.set('n', q.get('n') || 'tep'); }
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

  const up = serverRequest(req.method === 'HEAD' ? 'HEAD' : 'GET', `/file?${fq.toString()}`, headers);
  let done = false;
  up.setTimeout(60000, () => up.destroy(Object.assign(new Error('hết thời gian chờ'), { code: 'TIMEOUT' })));
  up.on('response', async (r) => {
    if (r.statusCode >= 400 && r.statusCode !== 416) {
      const data = await readJson(r);
      done = true;
      if (r.statusCode === 401) console.error('❌ [rq] server bk từ chối chữ ký:', data.message);
      return sendJson(res, r.statusCode === 404 ? 404 : 502, { success: false, message: data.message || `Server bk báo lỗi ${r.statusCode}` });
    }
    const h = {};
    for (const k of PASS_HEADERS) if (r.headers[k] !== undefined) h[k] = r.headers[k];
    res.writeHead(r.statusCode, h);
    r.on('end', () => { done = true; });
    r.on('error', () => res.destroy());
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (done) return;
    done = true;
    if (res.headersSent) { res.destroy(); return; }
    console.error('❌ [rq] đọc tệp từ server bk:', e.code || e.message);
    sendJson(res, 502, { success: false, message: unreachable(e) });
  });
  // người xem đóng trang / cuộn qua ảnh trước khi tải xong → huỷ request sang server bk
  res.on('close', () => { if (!done) { done = true; up.destroy(); } });
  up.end();
}

/** Kiểm tra kết nối API → server bk (nhớ 10 giây). Dùng cho GET /api/rq/files/health */
let healthCache = { at: 0, data: null };
function checkServer() {
  if (!enabled()) return Promise.resolve({ configured: false, ok: false, message: NOT_CONFIGURED });
  if (healthCache.data && Date.now() - healthCache.at < 10000) return Promise.resolve(healthCache.data);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const r = serverRequest('GET', '/health');
    r.setTimeout(8000, () => r.destroy(Object.assign(new Error('hết thời gian chờ'), { code: 'TIMEOUT' })));
    r.on('response', async (x) => {
      const j = await readJson(x);
      const ok = x.statusCode === 200 && j.ok === true;
      resolve({
        configured: true,
        ok: ok && j.auth === true,
        reachable: ok,
        ms: Date.now() - t0,
        auth: j.auth === true,
        message: !ok
          ? (x.statusCode === 404 ? 'Server bk chưa có API lưu tệp (chưa chép QuanLyYeuCau/api.js / chưa thêm app.use / chưa khởi động lại)' : `Server bk trả lời lạ (HTTP ${x.statusCode})`)
          : j.auth !== true ? j.authError || 'Server bk không kiểm chữ ký' : 'Kết nối tốt',
        freeGB: j.freeGB ?? null,
        serverMaxMb: j.maxMb ?? null,
      });
    });
    r.on('error', (e) => resolve({ configured: true, ok: false, reachable: false, ms: Date.now() - t0, message: unreachable(e) }));
    r.end();
  }).then((data) => {
    healthCache = { at: Date.now(), data };
    return data;
  });
}

module.exports = {
  enabled, verifyUpload, uploadSig, fileUrl, verifyView, fileOut, readAttachments, clientConfig,
  proxyUpload, proxyView, checkServer, KEY_RE, hmac,
};
