// RequestManagement/files.js — chữ ký cho MÁY CHỦ TỆP NỘI BỘ (ApiDuAnRac/fileserver)
//
// Nội dung tệp/ảnh KHÔNG đi qua API này: trình duyệt (đang ở mạng công ty) tải thẳng lên / xuống
// máy chủ tệp nội bộ. API chỉ:
//   1. cấp "vé tải lên" (ticket) có hạn cho user đang đăng nhập;
//   2. kiểm tra chữ ký máy chủ tệp trả về sau khi tải lên (tệp có thật, đúng người tải);
//   3. ký đường dẫn xem/tải tệp có hạn cho người được xem đề xuất.
// Hai bên dùng chung khoá bí mật RQ_FILE_SECRET (== FILE_SECRET của fileserver).
// Công thức phải khớp fileserver/server.js — sửa một bên phải sửa cả hai.
const crypto = require('crypto');

const secret = () => process.env.RQ_FILE_SECRET || '';
const baseUrl = () => String(process.env.RQ_FILE_SERVER_URL || '').trim().replace(/\/+$/, '');
const maxMb = () => Math.max(1, Number(process.env.RQ_FILE_MAX_MB) || 50);

const enabled = () => secret().length >= 16 && /^https?:\/\//.test(baseUrl());
const hmac = (s) => crypto.createHmac('sha256', secret()).update(s).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// rq/2026/10/<uuid>.jpg — chặn đường dẫn lạ (../, \, ký tự đặc biệt)
const KEY_RE = /^[a-z0-9]{1,10}\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/;

/** Vé tải lên: base64url(JSON {u,p,m,e}) + '.' + HMAC('t|'+body). Hạn 2 giờ. */
function uploadTicket(userId, prefix = 'rq') {
  const body = Buffer.from(JSON.stringify({
    u: userId,
    p: prefix,
    m: maxMb() * 1024 * 1024,
    e: Math.floor(Date.now() / 1000) + 2 * 3600,
  })).toString('base64url');
  return `${body}.${hmac(`t|${body}`)}`;
}

/** Chữ ký fileserver trả về sau khi tải lên: HMAC('u|key|size|userId') */
function verifyUpload(file, userId) {
  if (!file || !KEY_RE.test(String(file.key || ''))) return false;
  const size = Number(file.size);
  if (!Number.isInteger(size) || size < 0) return false;
  return safeEqual(file.sig, hmac(`u|${file.key}|${size}|${userId}`));
}

const HALF_DAY = 12 * 3600;
/**
 * Đường dẫn xem/tải tệp có hạn. Hạn làm tròn theo mốc 12 giờ → cùng 1 tệp có cùng URL
 * trong ít nhất 12 giờ, trình duyệt dùng lại bản đã cache (ảnh không tải lại mỗi lần mở).
 */
function fileUrl(key, { thumb = false, download = false, name = '' } = {}) {
  if (!enabled() || !key) return null;
  const exp = (Math.floor(Date.now() / 1000 / HALF_DAY) + 2) * HALF_DAY;
  let url = `${baseUrl()}/f/${key}?e=${exp}&s=${hmac(`d|${key}|${exp}`)}`;
  if (thumb) url += '&t=1';
  if (download) url += `&dl=1&n=${encodeURIComponent(name || 'tep')}`;
  return url;
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
 * Kiểm tra danh sách tệp client gửi kèm (sau khi đã tải lên fileserver).
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
    const e = new Error('Chưa cấu hình máy chủ tệp nội bộ — liên hệ IT');
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
  return { enabled: enabled(), url: enabled() ? baseUrl() : null, maxMb: maxMb() };
}

module.exports = { enabled, uploadTicket, verifyUpload, fileUrl, fileOut, readAttachments, clientConfig, KEY_RE, hmac };
