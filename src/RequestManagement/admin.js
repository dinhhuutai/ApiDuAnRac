// RequestManagement/admin.js — quản trị module 18: nhóm đề xuất, mẫu đề xuất (trường + quy trình duyệt),
// trưởng phòng / tổ trưởng, thống kê. Phòng ban / tổ / gán nhân viên dùng chung trang của module 9
// (/api/fm/admin/org/* — cho phép admin module 9 hoặc 18).
const express = require('express');
const { sql, poolPromise } = require('../db');
const C = require('./common');
const D = require('./definition');
const { clearDirectoryCache } = require('./requests');

const router = express.Router();
const { moduleAdmin, dt, parseId, handleError, httpError, ok, activeUserIds } = C;

router.use(moduleAdmin);

/* ================================ NHÓM ================================ */

router.get('/groups', async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT g.groupId, g.name, g.color, g.sortOrder, g.isActive,
             (SELECT COUNT(*) FROM dbo.rq_Types t WHERE t.groupId = g.groupId AND t.isDeleted = 0) AS typeCount
      FROM dbo.rq_Groups g ORDER BY g.isActive DESC, g.sortOrder, g.name`);
    ok(req, res, r.recordset);
  } catch (err) { handleError(res, err, 'GET /admin/groups'); }
});

function readGroup(b) {
  const name = String(b?.name || '').trim().slice(0, 150);
  if (!name) throw new D.ValidationError('Chưa nhập tên nhóm');
  return {
    name,
    color: /^#[0-9a-fA-F]{6}$/.test(b?.color || '') ? b.color : '#64748b',
    sortOrder: Number.isInteger(Number(b?.sortOrder)) ? Number(b.sortOrder) : 0,
    isActive: b?.isActive === undefined ? true : !!b.isActive,
  };
}

router.post('/groups', async (req, res) => {
  try {
    const g = readGroup(req.body);
    const pool = await poolPromise;
    const r = await pool.request()
      .input('name', sql.NVarChar(150), g.name).input('color', sql.NVarChar(20), g.color)
      .input('sort', sql.Int, g.sortOrder).input('uid', sql.Int, req.user.userID)
      .query(`INSERT INTO dbo.rq_Groups (name, color, sortOrder, createdBy) OUTPUT INSERTED.groupId VALUES (@name, @color, @sort, @uid)`);
    ok(req, res, { groupId: r.recordset[0].groupId });
  } catch (err) { handleError(res, err, 'POST /admin/groups'); }
});

router.put('/groups/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã nhóm không hợp lệ' });
    const g = readGroup(req.body);
    const pool = await poolPromise;
    const r = await pool.request()
      .input('id', sql.Int, id).input('name', sql.NVarChar(150), g.name).input('color', sql.NVarChar(20), g.color)
      .input('sort', sql.Int, g.sortOrder).input('active', sql.Bit, g.isActive).input('uid', sql.Int, req.user.userID)
      .query(`UPDATE dbo.rq_Groups SET name = @name, color = @color, sortOrder = @sort, isActive = @active,
                updatedAt = SYSDATETIME(), updatedBy = @uid WHERE groupId = @id`);
    if (!r.rowsAffected[0]) throw httpError(404, 'Không tìm thấy nhóm');
    ok(req, res, { groupId: id });
  } catch (err) { handleError(res, err, 'PUT /admin/groups/:id'); }
});

/* ================================ MẪU ĐỀ XUẤT ================================ */

router.get('/types', async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT t.typeId, t.groupId, g.name AS groupName, t.name, t.description, t.icon, t.color, t.isActive, t.sortOrder,
             t.flow, t.audience, ${dt('ISNULL(t.updatedAt, t.createdAt)', 'updatedAt')}, u.fullName AS updatedByName,
             (SELECT COUNT(*) FROM dbo.rq_Requests r WHERE r.typeId = t.typeId AND r.isDeleted = 0) AS requestCount,
             (SELECT COUNT(*) FROM dbo.rq_Requests r WHERE r.typeId = t.typeId AND r.isDeleted = 0 AND r.status = N'pending') AS pendingCount
      FROM dbo.rq_Types t
      LEFT JOIN dbo.rq_Groups g ON g.groupId = t.groupId
      LEFT JOIN dbo.Users u ON u.userID = ISNULL(t.updatedBy, t.createdBy)
      WHERE t.isDeleted = 0
      ORDER BY t.isActive DESC, g.sortOrder, t.sortOrder, t.name`);
    ok(req, res, r.recordset.map(({ flow, audience, ...t }) => ({
      ...t,
      stepCount: D.parseJson(flow, []).length,
      audienceType: D.parseJson(audience, {})?.type || 'all',
    })));
  } catch (err) { handleError(res, err, 'GET /admin/types'); }
});

async function loadType(pool, id) {
  const r = await pool.request().input('id', sql.Int, id).query(`
    SELECT typeId, groupId, name, description, icon, color, fields, flow, audience, defaultFollowers, options, sortOrder, isActive,
           (SELECT COUNT(*) FROM dbo.rq_Requests r WHERE r.typeId = t.typeId) AS requestCount
    FROM dbo.rq_Types t WHERE typeId = @id AND isDeleted = 0`);
  const t = r.recordset[0];
  if (!t) return null;
  return {
    ...t,
    fields: D.parseJson(t.fields, []),
    flow: D.parseJson(t.flow, []),
    audience: D.parseJson(t.audience, { type: 'all' }),
    defaultFollowers: D.parseJson(t.defaultFollowers, []),
    options: D.normalizeOptions(D.parseJson(t.options, {})),
  };
}

router.get('/types/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã mẫu không hợp lệ' });
    const t = await loadType(await poolPromise, id);
    if (!t) throw httpError(404, 'Không tìm thấy mẫu đề xuất');
    ok(req, res, t);
  } catch (err) { handleError(res, err, 'GET /admin/types/:id'); }
});

async function saveType(pool, id, def, uid) {
  // người duyệt / theo dõi cố định phải còn hoạt động
  const userIds = [...def.flow.flatMap((s) => s.userIds), ...def.defaultFollowers];
  const active = await activeUserIds(pool, userIds);
  const missing = userIds.filter((x) => !active.has(x));
  if (missing.length) throw new D.ValidationError(`Có ${missing.length} người được chọn không còn hoạt động — bỏ chọn rồi lưu lại`);

  const r = await pool.request()
    .input('id', sql.Int, id).input('uid', sql.Int, uid)
    .input('groupId', sql.Int, def.groupId)
    .input('name', sql.NVarChar(200), def.name)
    .input('description', sql.NVarChar(2000), def.description)
    .input('icon', sql.NVarChar(50), def.icon)
    .input('color', sql.NVarChar(20), def.color)
    .input('fields', sql.NVarChar(sql.MAX), JSON.stringify(def.fields))
    .input('flow', sql.NVarChar(sql.MAX), JSON.stringify(def.flow))
    .input('audience', sql.NVarChar(sql.MAX), JSON.stringify(def.audience))
    .input('followers', sql.NVarChar(sql.MAX), JSON.stringify(def.defaultFollowers))
    .input('options', sql.NVarChar(sql.MAX), JSON.stringify(def.options))
    .input('sort', sql.Int, def.sortOrder)
    .input('active', sql.Bit, def.isActive)
    .query(`
      IF @groupId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.rq_Groups WHERE groupId = @groupId)
        THROW 50070, N'Nhóm đề xuất không tồn tại', 1;
      IF @id IS NULL
      BEGIN
        INSERT INTO dbo.rq_Types (groupId, name, description, icon, color, fields, flow, audience, defaultFollowers, options, sortOrder, isActive, createdBy)
        OUTPUT INSERTED.typeId
        VALUES (@groupId, @name, @description, @icon, @color, @fields, @flow, @audience, @followers, @options, @sort, @active, @uid);
      END
      ELSE
      BEGIN
        UPDATE dbo.rq_Types
        SET groupId = @groupId, name = @name, description = @description, icon = @icon, color = @color,
            fields = @fields, flow = @flow, audience = @audience, defaultFollowers = @followers, options = @options,
            sortOrder = @sort, isActive = @active, updatedAt = SYSDATETIME(), updatedBy = @uid
        OUTPUT INSERTED.typeId
        WHERE typeId = @id AND isDeleted = 0;
      END`);
  if (!r.recordset[0]) throw httpError(404, 'Không tìm thấy mẫu đề xuất');
  return r.recordset[0].typeId;
}

// Sửa mẫu không ảnh hưởng đề xuất đã gửi (đề xuất lưu bản chụp trường + quy trình lúc gửi)
router.post('/types', async (req, res) => {
  try {
    const def = D.normalizeType(req.body);
    const pool = await poolPromise;
    const id = await saveType(pool, null, def, req.user.userID);
    ok(req, res, await loadType(pool, id));
  } catch (err) { handleError(res, err, 'POST /admin/types'); }
});

router.put('/types/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã mẫu không hợp lệ' });
    const def = D.normalizeType(req.body);
    const pool = await poolPromise;
    await saveType(pool, id, def, req.user.userID);
    ok(req, res, await loadType(pool, id));
  } catch (err) { handleError(res, err, 'PUT /admin/types/:id'); }
});

router.patch('/types/:id/active', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id || typeof req.body?.isActive !== 'boolean') return res.status(400).json({ success: false, message: 'Tham số không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, id).input('active', sql.Bit, req.body.isActive).input('uid', sql.Int, req.user.userID)
      .query(`UPDATE dbo.rq_Types SET isActive = @active, updatedAt = SYSDATETIME(), updatedBy = @uid WHERE typeId = @id AND isDeleted = 0`);
    if (!r.rowsAffected[0]) throw httpError(404, 'Không tìm thấy mẫu đề xuất');
    ok(req, res, { typeId: id, isActive: req.body.isActive });
  } catch (err) { handleError(res, err, 'PATCH /admin/types/:id/active'); }
});

router.delete('/types/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã mẫu không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, id).input('uid', sql.Int, req.user.userID).query(`
      IF EXISTS (SELECT 1 FROM dbo.rq_Requests WHERE typeId = @id AND status = N'pending' AND isDeleted = 0)
        THROW 50071, N'Mẫu còn đề xuất đang chờ duyệt — ngừng dùng mẫu thay vì xoá', 1;
      UPDATE dbo.rq_Types SET isDeleted = 1, isActive = 0, updatedAt = SYSDATETIME(), updatedBy = @uid WHERE typeId = @id AND isDeleted = 0;`);
    if (!r.rowsAffected.some((n) => n > 0)) throw httpError(404, 'Không tìm thấy mẫu đề xuất');
    ok(req, res, { typeId: id });
  } catch (err) { handleError(res, err, 'DELETE /admin/types/:id'); }
});

/* ================================ TRƯỞNG PHÒNG / TỔ TRƯỞNG ================================ */

router.get('/heads', async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT departmentId AS id, name, code, sortOrder FROM dbo.org_Departments WHERE isActive = 1 ORDER BY sortOrder, name;
      SELECT teamId AS id, name, code, departmentId, sortOrder FROM dbo.org_Teams WHERE isActive = 1 ORDER BY sortOrder, name;
      SELECT h.scopeType, h.scopeId, h.userId, u.fullName
      FROM dbo.rq_OrgHeads h JOIN dbo.Users u ON u.userID = h.userId
      WHERE u.isDeleted = 0 AND ISNULL(u.isActive, 0) = 1;`);
    const heads = r.recordsets[2];
    const pick = (type, id) => heads.filter((h) => h.scopeType === type && h.scopeId === id).map((h) => ({ userId: h.userId, fullName: h.fullName }));
    ok(req, res, {
      departments: r.recordsets[0].map((d) => ({ ...d, heads: pick('department', d.id) })),
      teams: r.recordsets[1].map((t) => ({ ...t, heads: pick('team', t.id) })),
    });
  } catch (err) { handleError(res, err, 'GET /admin/heads'); }
});

router.put('/heads', async (req, res) => {
  try {
    const scopeType = ['department', 'team'].includes(req.body?.scopeType) ? req.body.scopeType : null;
    const scopeId = parseId(req.body?.scopeId);
    if (!scopeType || !scopeId) throw new D.ValidationError('Chưa chọn phòng ban / tổ');
    const pool = await poolPromise;
    const active = [...(await activeUserIds(pool, D.ids(req.body?.userIds, 20)))];
    await pool.request()
      .input('type', sql.NVarChar(10), scopeType).input('sid', sql.Int, scopeId)
      .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(active)).input('uid', sql.Int, req.user.userID)
      .query(`
        SET XACT_ABORT ON;
        IF @type = N'department' AND NOT EXISTS (SELECT 1 FROM dbo.org_Departments WHERE departmentId = @sid) THROW 50072, N'Phòng ban không tồn tại', 1;
        IF @type = N'team' AND NOT EXISTS (SELECT 1 FROM dbo.org_Teams WHERE teamId = @sid) THROW 50073, N'Tổ không tồn tại', 1;
        BEGIN TRAN;
        DELETE FROM dbo.rq_OrgHeads WHERE scopeType = @type AND scopeId = @sid
          AND userId NOT IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids));
        INSERT INTO dbo.rq_OrgHeads (scopeType, scopeId, userId, createdBy)
        SELECT @type, @sid, x.id, @uid FROM (SELECT DISTINCT CAST([value] AS INT) AS id FROM OPENJSON(@ids)) x
        WHERE NOT EXISTS (SELECT 1 FROM dbo.rq_OrgHeads h WHERE h.scopeType = @type AND h.scopeId = @sid AND h.userId = x.id);
        COMMIT;`);
    clearDirectoryCache();
    ok(req, res, { scopeType, scopeId, userIds: active });
  } catch (err) { handleError(res, err, 'PUT /admin/heads'); }
});

/* ================================ THỐNG KÊ ================================ */

router.get('/stats', async (req, res) => {
  try {
    const from = D.isValidDate(req.query.from) ? req.query.from : null;
    const to = D.isValidDate(req.query.to) ? req.query.to : null;
    const pool = await poolPromise;
    const r = await pool.request().input('from', sql.VarChar(10), from).input('to', sql.VarChar(10), to).query(`
      DECLARE @f DATE = CONVERT(date, @from, 23), @t DATE = CONVERT(date, @to, 23);
      WITH base AS (
        SELECT * FROM dbo.rq_Requests
        WHERE isDeleted = 0 AND (@f IS NULL OR createdAt >= @f) AND (@t IS NULL OR createdAt < DATEADD(day, 1, @t))
      )
      SELECT status, COUNT(*) AS n FROM base GROUP BY status;

      WITH base AS (
        SELECT * FROM dbo.rq_Requests
        WHERE isDeleted = 0 AND (@f IS NULL OR createdAt >= @f) AND (@t IS NULL OR createdAt < DATEADD(day, 1, @t))
      )
      SELECT typeId, typeName, COUNT(*) AS total,
             SUM(CASE WHEN status = N'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = N'approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN status = N'rejected' THEN 1 ELSE 0 END) AS rejected,
             AVG(CASE WHEN finishedAt IS NOT NULL AND status IN (N'approved', N'rejected')
                      THEN DATEDIFF(minute, createdAt, finishedAt) / 60.0 END) AS avgHours
      FROM base GROUP BY typeId, typeName ORDER BY total DESC;

      WITH base AS (
        SELECT * FROM dbo.rq_Requests
        WHERE isDeleted = 0 AND (@f IS NULL OR createdAt >= @f) AND (@t IS NULL OR createdAt < DATEADD(day, 1, @t))
      )
      SELECT departmentId, ISNULL(departmentName, N'(Chưa có phòng ban)') AS departmentName, COUNT(*) AS total,
             SUM(CASE WHEN status = N'pending' THEN 1 ELSE 0 END) AS pending
      FROM base GROUP BY departmentId, departmentName ORDER BY total DESC;

      -- người đang giữ nhiều đề xuất chờ duyệt nhất (lâu nhất)
      SELECT TOP 15 a.userId, u.fullName, COUNT(*) AS pending,
             MAX(DATEDIFF(hour, r.lastActivityAt, SYSDATETIME())) AS oldestHours
      FROM dbo.rq_RequestApprovers a
      JOIN dbo.rq_Requests r ON r.requestId = a.requestId AND r.status = N'pending' AND r.isDeleted = 0
      JOIN dbo.Users u ON u.userID = a.userId
      WHERE a.status = N'pending'
      GROUP BY a.userId, u.fullName ORDER BY COUNT(*) DESC, MAX(DATEDIFF(hour, r.lastActivityAt, SYSDATETIME())) DESC;

      WITH base AS (
        SELECT * FROM dbo.rq_Requests
        WHERE isDeleted = 0 AND (@f IS NULL OR createdAt >= @f) AND (@t IS NULL OR createdAt < DATEADD(day, 1, @t))
      )
      SELECT CONVERT(varchar(10), createdAt, 23) AS day, COUNT(*) AS n FROM base
      GROUP BY CONVERT(varchar(10), createdAt, 23) ORDER BY day;`);
    ok(req, res, {
      byStatus: r.recordsets[0],
      byType: r.recordsets[1],
      byDepartment: r.recordsets[2],
      pendingByApprover: r.recordsets[3],
      timeline: r.recordsets[4],
    });
  } catch (err) { handleError(res, err, 'GET /admin/stats'); }
});

module.exports = router;
