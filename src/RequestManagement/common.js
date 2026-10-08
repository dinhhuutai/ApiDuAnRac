// RequestManagement/common.js — hằng số, phân quyền, hàm dùng chung của module 18
const zlib = require('zlib');
const { sql } = require('../db');
const { requireModuleRole } = require('../middleware/moduleRole');
const { profileApply } = require('../utils/orgProfile');
const D = require('./definition');

const MODULE_ID = 18;
const moduleUser = requireModuleRole(MODULE_ID, ['user', 'admin']);
const moduleAdmin = requireModuleRole(MODULE_ID, ['admin']);

/** Cột DATETIME2 → 'YYYY-MM-DDTHH:mm:ss' giờ VN (không múi giờ) — quy ước như module 9 */
const dt = (col, alias) => `CONVERT(varchar(19), ${col}, 126) AS ${alias}`;

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(res, err, where) {
  if (err instanceof D.ValidationError || err?.status === 400) {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err?.status === 403 || err?.status === 404 || err?.status === 409) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  // THROW 50xxx trong batch SQL = lỗi nghiệp vụ có thông báo cho người dùng
  if (err?.number >= 50000 && err?.number < 51000) {
    return res.status(409).json({ success: false, code: err.number, message: err.message });
  }
  if (err?.number === 2627 || err?.number === 2601) {
    return res.status(409).json({ success: false, message: 'Dữ liệu bị trùng (tên đã tồn tại)' });
  }
  console.error(`❌ [rq] ${where}:`, err);
  return res.status(500).json({ success: false, message: 'Lỗi máy chủ, vui lòng thử lại' });
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Trả JSON { success, data } — nén gzip khi trình duyệt hỗ trợ và nội dung > 2 KB
 * (API không có middleware nén; danh sách/chi tiết đề xuất nhỏ đi 5–10 lần).
 */
function ok(req, res, data) {
  const body = JSON.stringify({ success: true, data });
  res.set('Cache-Control', 'no-store');
  if (body.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    return res.end(zlib.gzipSync(body, { level: 6 }));
  }
  res.type('application/json').send(body);
}

/** Hồ sơ user: họ tên, MSNV, phòng ban, tổ, chức danh */
async function getProfile(pool, userId) {
  const r = await pool.request().input('uid', sql.Int, userId).query(`
    SELECT u.userID AS userId, u.fullName, u.msnv, u.avatar,
           p.departmentId, d.name AS departmentName,
           p.teamId, t.name AS teamName,
           p.jobTitleId, j.name AS jobTitleName, p.source
    FROM dbo.Users u
    ${profileApply('u')}
    LEFT JOIN dbo.org_Departments d ON d.departmentId = p.departmentId
    LEFT JOIN dbo.org_Teams t ON t.teamId = p.teamId
    LEFT JOIN dbo.org_JobTitles j ON j.jobTitleId = p.jobTitleId
    WHERE u.userID = @uid`);
  return r.recordset[0] || null;
}

/** Lọc id người dùng còn hoạt động */
async function activeUserIds(pool, list) {
  const arr = D.ids(list, 5000);
  if (!arr.length) return new Set();
  const r = await pool.request().input('ids', sql.NVarChar(sql.MAX), JSON.stringify(arr)).query(`
    SELECT u.userID FROM dbo.Users u
    WHERE u.userID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))
      AND u.isDeleted = 0 AND ISNULL(u.isActive, 0) = 1`);
  return new Set(r.recordset.map((x) => x.userID));
}

/**
 * Điều kiện "user @uid được xem đề xuất r": người gửi, người duyệt (mọi bước), người theo dõi.
 * Admin module 18 (@isAdmin = 1) xem được tất cả.
 */
const canViewExpr = (r = 'r') => `(@isAdmin = 1 OR ${r}.requesterId = @uid
    OR EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers va WHERE va.requestId = ${r}.requestId AND va.userId = @uid)
    OR EXISTS (SELECT 1 FROM dbo.rq_RequestFollowers vf WHERE vf.requestId = ${r}.requestId AND vf.userId = @uid))`;

const isAdmin = (req) => req.moduleRole === 'admin';

module.exports = {
  MODULE_ID, moduleUser, moduleAdmin, dt, parseId, handleError, httpError, ok,
  getProfile, activeUserIds, canViewExpr, isAdmin, profileApply,
};
