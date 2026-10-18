// RequestManagement/reports.js — Module 18: báo cáo tự thiết kế theo mẫu đề xuất (bảng rq_Reports, sql/11).
// Mount trong RequestManagement/index.js: /api/rq/reports
//   GET    /                danh sách báo cáo mình được xem (admin module 18: tất cả; người khác: có tên trong viewerIds)
//   GET    /:id             thiết kế + trường của mẫu (để hiển thị)
//   GET    /:id/run         chạy báo cáo đã lưu (?period=&from=&to= đổi kỳ khi xem)
//   POST   /preview         (admin) chạy thử thiết kế chưa lưu — trang thiết kế xem trước ngay
//   POST   / · PUT /:id · DELETE /:id   (admin) tạo / sửa / xoá (xoá mềm)
// Tính toán ở report.js (không DB). Server yếu → tối đa MAX_REQUESTS đề xuất mỗi lần chạy.
const express = require('express');
const { DateTime } = require('luxon');
const { sql, poolPromise } = require('../db');
const C = require('./common');
const D = require('./definition');
const RP = require('./report');

const router = express.Router();
const { moduleUser, moduleAdmin, dt, parseId, handleError, httpError, ok, isAdmin } = C;
const MAX_REQUESTS = 20000;

/** Chưa chạy sql/11 (thiếu bảng rq_Reports) → báo rõ thay vì "Lỗi máy chủ" */
function fail(res, err, where) {
  if (err?.number === 208 && /rq_Reports/.test(err.message || '')) {
    return res.status(503).json({ success: false, message: 'Chưa tạo bảng báo cáo — cần chạy sql/11_request_reports.sql' });
  }
  return handleError(res, err, where);
}

const today = () => DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd');
const VISIBLE = `r.isDeleted = 0 AND (@isAdmin = 1 OR EXISTS (SELECT 1 FROM OPENJSON(r.viewerIds) v WHERE TRY_CAST(v.[value] AS INT) = @uid))`;

/** Số báo cáo user được xem — cho menu trái (bootstrap). Chưa có bảng → 0 */
async function countVisible(pool, uid, admin) {
  try {
    const r = await pool.request().input('uid', sql.Int, uid).input('isAdmin', sql.Bit, admin)
      .query(`SELECT COUNT(*) AS n FROM dbo.rq_Reports r WHERE ${VISIBLE}`);
    return r.recordset[0]?.n || 0;
  } catch {
    return 0;
  }
}

async function loadTypeFields(pool, typeId) {
  if (!typeId) return null;
  const r = await pool.request().input('tid', sql.Int, typeId)
    .query(`SELECT typeId, name, icon, color, fields, isDeleted FROM dbo.rq_Types WHERE typeId = @tid`);
  const t = r.recordset[0];
  if (!t) return null;
  return { typeId: t.typeId, name: t.name, icon: t.icon, color: t.color, isDeleted: !!t.isDeleted, fields: D.parseJson(t.fields, []) };
}

async function loadReport(pool, id, uid, admin) {
  const r = await pool.request().input('id', sql.Int, id).input('uid', sql.Int, uid).input('isAdmin', sql.Bit, admin).query(`
    SELECT r.reportId, r.name, r.description, r.typeId, r.definition, r.viewerIds, r.sortOrder,
           ${dt('ISNULL(r.updatedAt, r.createdAt)', 'updatedAt')}, u.fullName AS updatedByName
    FROM dbo.rq_Reports r LEFT JOIN dbo.Users u ON u.userID = ISNULL(r.updatedBy, r.createdBy)
    WHERE r.reportId = @id AND ${VISIBLE}`);
  const row = r.recordset[0];
  if (!row) return null;
  return { ...row, definition: D.parseJson(row.definition, {}), viewerIds: D.parseJson(row.viewerIds, []) };
}

/**
 * Chạy 1 thiết kế: lọc ở SQL (mẫu, kỳ, trạng thái, phòng, mức độ), nhóm + tính ở report.js.
 * @param range { from, to } đã giải từ kỳ
 */
async function execute(pool, typeId, def, range, type) {
  const dateCol = def.dateBasis === 'finished' ? 'r.finishedAt' : 'r.createdAt';
  const q = await pool.request()
    .input('cap', sql.Int, MAX_REQUESTS + 1)
    .input('typeId', sql.Int, typeId || null)
    .input('from', sql.VarChar(10), range.from)
    .input('to', sql.VarChar(10), range.to)
    .input('statuses', sql.NVarChar(sql.MAX), JSON.stringify(def.statuses))
    .input('depts', sql.NVarChar(sql.MAX), JSON.stringify(def.departmentIds))
    .input('priority', sql.NVarChar(10), def.priority)
    .query(`
      SELECT TOP (@cap) r.requestId, r.typeId, r.typeName, r.title, r.requesterId, r.requesterName,
             r.departmentId, r.departmentName, r.teamId, r.teamName, r.status, r.priority,
             ${dt('r.createdAt', 'createdAt')}, ${dt('r.finishedAt', 'finishedAt')}, r.fieldValues
      FROM dbo.rq_Requests r
      WHERE r.isDeleted = 0
        AND (@typeId IS NULL OR r.typeId = @typeId)
        AND (@from IS NULL OR ${dateCol} >= CONVERT(date, @from, 23))
        AND (@to IS NULL OR ${dateCol} < DATEADD(day, 1, CONVERT(date, @to, 23)))
        AND (@statuses = N'[]' OR r.status IN (SELECT [value] FROM OPENJSON(@statuses)))
        AND (@depts = N'[]' OR r.departmentId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@depts)))
        AND (@priority IS NULL OR r.priority = @priority)
      ORDER BY r.createdAt DESC, r.requestId DESC`);
  const truncated = q.recordset.length > MAX_REQUESTS;
  const requests = q.recordset.slice(0, MAX_REQUESTS).map(({ fieldValues, ...x }) => ({ ...x, values: D.parseJson(fieldValues, {}) }));
  const fields = type?.fields || [];

  const ids = RP.userIdsFor(def, requests, fields);
  const names = new Map();
  if (ids.length) {
    const u = await pool.request().input('ids', sql.NVarChar(sql.MAX), JSON.stringify(ids))
      .query(`SELECT userID, fullName FROM dbo.Users WHERE userID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))`);
    u.recordset.forEach((x) => names.set(x.userID, x.fullName));
  }
  const result = RP.runReport(def, requests, { fields, userName: (id) => names.get(id) || `Người dùng #${id}` });
  if (truncated) result.warnings.push(`Kỳ này có hơn ${MAX_REQUESTS.toLocaleString('vi-VN')} đề xuất — chỉ tính ${MAX_REQUESTS.toLocaleString('vi-VN')} đề xuất mới nhất. Hãy chọn kỳ ngắn hơn.`);
  return {
    ...result,
    range,
    truncated,
    list: def.list.show ? RP.listRows(def, requests) : null,
    listTotal: requests.length,
  };
}

/** Kỳ khi xem: tham số trên URL (đổi kỳ) hoặc kỳ mặc định của thiết kế */
function rangeOf(def, query = {}) {
  const period = RP.PERIODS.includes(query.period) ? query.period : def.period;
  const custom = query.period ? { from: query.from, to: query.to } : { from: def.from, to: def.to };
  return { period, ...RP.periodRange(period, today(), custom) };
}

const typeOut = (t) => (t ? { typeId: t.typeId, name: t.name, icon: t.icon, color: t.color, isDeleted: t.isDeleted, fields: t.fields } : null);

/* ================================ XEM ================================ */

router.get('/', moduleUser, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('uid', sql.Int, req.user.userID).input('isAdmin', sql.Bit, isAdmin(req)).query(`
      SELECT r.reportId, r.name, r.description, r.typeId, t.name AS typeName, t.icon, t.color, r.definition, r.viewerIds, r.sortOrder,
             ${dt('ISNULL(r.updatedAt, r.createdAt)', 'updatedAt')}, u.fullName AS updatedByName
      FROM dbo.rq_Reports r
      LEFT JOIN dbo.rq_Types t ON t.typeId = r.typeId
      LEFT JOIN dbo.Users u ON u.userID = ISNULL(r.updatedBy, r.createdBy)
      WHERE ${VISIBLE}
      ORDER BY r.sortOrder, r.name`);
    ok(req, res, r.recordset.map(({ definition, viewerIds, ...x }) => {
      const d = D.parseJson(definition, {});
      return { ...x, viewerCount: D.parseJson(viewerIds, []).length, metricCount: (d.metrics || []).length, groupBy: d.groupBy?.by || 'none', period: d.period };
    }));
  } catch (err) { fail(res, err, 'GET /reports'); }
});

router.get('/:id', moduleUser, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã báo cáo không hợp lệ' });
    const pool = await poolPromise;
    const rep = await loadReport(pool, id, req.user.userID, isAdmin(req));
    if (!rep) throw httpError(404, 'Không tìm thấy báo cáo hoặc bạn không được xem');
    ok(req, res, { ...rep, type: typeOut(await loadTypeFields(pool, rep.typeId)), canEdit: isAdmin(req) });
  } catch (err) { fail(res, err, 'GET /reports/:id'); }
});

router.get('/:id/run', moduleUser, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã báo cáo không hợp lệ' });
    const pool = await poolPromise;
    const rep = await loadReport(pool, id, req.user.userID, isAdmin(req));
    if (!rep) throw httpError(404, 'Không tìm thấy báo cáo hoặc bạn không được xem');
    const type = await loadTypeFields(pool, rep.typeId);
    // chuẩn hoá lại theo mẫu hiện tại; mẫu đã bị sửa (trường bị xoá) → dùng bản đã lưu (đã chuẩn hoá lúc lưu),
    // runReport tự bỏ chỉ số / cách nhóm trỏ tới trường không còn và báo ở warnings
    let def;
    try { def = RP.normalizeDefinition(rep.definition, rep.typeId ? type?.fields || [] : null); } catch { def = rep.definition; }
    ok(req, res, await execute(pool, rep.typeId, def, rangeOf(def, req.query), type));
  } catch (err) { fail(res, err, 'GET /reports/:id/run'); }
});

/* ================================ THIẾT KẾ (admin) ================================ */

router.post('/preview', moduleAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const typeId = parseId(req.body?.typeId);
    const type = await loadTypeFields(pool, typeId);
    if (typeId && !type) throw httpError(404, 'Mẫu đề xuất không tồn tại');
    const def = RP.normalizeDefinition(req.body?.definition, typeId ? type.fields : null);
    ok(req, res, await execute(pool, typeId, def, rangeOf(def, req.body?.range || {}), type));
  } catch (err) { fail(res, err, 'POST /reports/preview'); }
});

async function save(pool, id, b, uid) {
  const typeId = parseId(b?.typeId);
  const type = await loadTypeFields(pool, typeId);
  if (typeId && !type) throw httpError(404, 'Mẫu đề xuất không tồn tại');
  const rep = RP.normalizeReport(b, type?.fields);
  const r = await pool.request()
    .input('id', sql.Int, id).input('uid', sql.Int, uid)
    .input('name', sql.NVarChar(200), rep.name)
    .input('description', sql.NVarChar(1000), rep.description)
    .input('typeId', sql.Int, rep.typeId)
    .input('definition', sql.NVarChar(sql.MAX), JSON.stringify(rep.definition))
    .input('viewers', sql.NVarChar(sql.MAX), JSON.stringify(rep.viewerIds))
    .input('sort', sql.Int, rep.sortOrder)
    .query(`
      IF @id IS NULL
        INSERT INTO dbo.rq_Reports (name, description, typeId, definition, viewerIds, sortOrder, createdBy)
        OUTPUT INSERTED.reportId
        VALUES (@name, @description, @typeId, @definition, @viewers, @sort, @uid);
      ELSE
        UPDATE dbo.rq_Reports
        SET name = @name, description = @description, typeId = @typeId, definition = @definition, viewerIds = @viewers,
            sortOrder = @sort, updatedBy = @uid, updatedAt = SYSDATETIME()
        OUTPUT INSERTED.reportId
        WHERE reportId = @id AND isDeleted = 0;`);
  if (!r.recordset[0]) throw httpError(404, 'Không tìm thấy báo cáo');
  return r.recordset[0].reportId;
}

router.post('/', moduleAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const id = await save(pool, null, req.body, req.user.userID);
    ok(req, res, await loadReport(pool, id, req.user.userID, true));
  } catch (err) { fail(res, err, 'POST /reports'); }
});

router.put('/:id', moduleAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã báo cáo không hợp lệ' });
    const pool = await poolPromise;
    await save(pool, id, req.body, req.user.userID);
    ok(req, res, await loadReport(pool, id, req.user.userID, true));
  } catch (err) { fail(res, err, 'PUT /reports/:id'); }
});

router.delete('/:id', moduleAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã báo cáo không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, id).input('uid', sql.Int, req.user.userID)
      .query(`UPDATE dbo.rq_Reports SET isDeleted = 1, updatedBy = @uid, updatedAt = SYSDATETIME() WHERE reportId = @id AND isDeleted = 0`);
    if (!r.rowsAffected[0]) throw httpError(404, 'Không tìm thấy báo cáo');
    ok(req, res, { reportId: id });
  } catch (err) { fail(res, err, 'DELETE /reports/:id'); }
});

module.exports = router;
module.exports.countVisible = countVisible;
