// RequestManagement/imports.js — Quản trị → "Nhập từ Base": đưa đề xuất cũ từ Base Request (tệp Excel xuất ở
// request.base.vn) vào module 18. Bảng rq_ImportBatches + rq_ImportRefs (sql/12). Phân tích / dựng đề xuất ở baseImport.js.
// Mount trong RequestManagement/index.js: /api/rq/admin/import (admin module 18)
//   POST /base/analyze             { header, rows, settings }  xem trước: khớp người theo tên, nhóm → mẫu, trường, nhập / bỏ qua
//   POST /base/batches             { header, rows, settings, fileName }  tạo lần nhập (+ mẫu mới nếu chọn) → { batchId }
//   POST /base/batches/:id/rows    { header, rows }  nhập 1 phần (trình duyệt chia ≤ 50 dòng/lần, có thanh tiến trình)
//   POST /base/batches/:id/finish
//   GET  /batches                  lịch sử nhập
//   POST /batches/:id/undo         hoàn tác: xoá mềm các đề xuất của lần nhập mà chưa ai thao tác sau khi nhập
// Trình duyệt đọc tệp Excel (SheetJS) rồi gửi tiêu đề + các dòng dạng chữ (nén gzip) với Content-Type riêng
// IMPORT_TYPE — express.json() toàn cục chỉ nhận 100 KB, tệp Base 640 đề xuất ≈ 1 MB.
// Nhập KHÔNG gửi thông báo / Web Push. Mã đề xuất Base đã nhập (rq_ImportRefs) → nhập lại cùng tệp không tạo trùng.
const express = require('express');
const { sql, poolPromise } = require('../db');
const C = require('./common');
const D = require('./definition');
const B = require('./baseImport');
const { saveType } = require('./admin');

const router = express.Router();
const { moduleAdmin, dt, parseId, handleError, httpError, ok, activeUserIds, profileApply } = C;
const IMPORT_TYPE = 'application/vnd.noibo.import+json';
const MAX_CHUNK = 100;

router.use(moduleAdmin);
router.use(express.json({ type: IMPORT_TYPE, limit: '8mb' }));

/** Chưa chạy sql/12 → báo rõ thay vì "Lỗi máy chủ" */
function fail(res, err, where) {
  if (err?.number === 208 && /rq_Import/.test(err.message || '')) {
    return res.status(503).json({ success: false, message: 'Chưa tạo bảng nhập dữ liệu — cần chạy sql/12_request_import_base.sql' });
  }
  return handleError(res, err, where);
}

/** { header, rows } từ trình duyệt → mảng chữ (giới hạn kích thước) */
function readInput(b) {
  const header = Array.isArray(b?.header) ? b.header.slice(0, 100).map((c) => String(c ?? '').slice(0, 200)) : [];
  if (!header.length) throw new D.ValidationError('Thiếu dòng tiêu đề của tệp');
  const rows = (Array.isArray(b?.rows) ? b.rows : []).slice(0, 20000)
    .map((r) => (Array.isArray(r) ? r.slice(0, 100).map((c) => String(c ?? '').slice(0, 20000)) : []));
  if (!rows.length) throw new D.ValidationError('Tệp không có dòng dữ liệu');
  return { header, rows };
}

/** Dữ liệu DB cho baseImport.analyze: tài khoản (cả đã khoá — người gửi cũ đã nghỉ), mẫu, nhóm, mã đã nhập, lần nhập trước */
async function loadEnv(pool, input) {
  const { idx } = B.mapHeader(input.header);
  const codes = idx.code === undefined ? [] : [...new Set(input.rows.map((r) => String(r[idx.code] || '').trim()).filter(Boolean))];
  const r = await pool.request().input('codes', sql.NVarChar(sql.MAX), JSON.stringify(codes)).query(`
    SELECT u.userID, u.username, u.fullName, u.email, u.msnv, CAST(ISNULL(u.isActive, 0) AS bit) AS isActive, u.isDeleted,
           CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.UserModules um WHERE um.userId = u.userID AND um.moduleId = ${C.MODULE_ID})
                THEN 1 ELSE 0 END AS bit) AS hasModule
    FROM dbo.Users u;
    SELECT typeId, groupId, name, fields, flow, isActive FROM dbo.rq_Types WHERE isDeleted = 0 ORDER BY isActive DESC, name;
    SELECT groupId, name FROM dbo.rq_Groups WHERE isActive = 1 ORDER BY sortOrder, name;
    SELECT x.externalId FROM dbo.rq_ImportRefs x
    WHERE x.source = N'base' AND x.externalId IN (SELECT CAST([value] AS NVARCHAR(50)) FROM OPENJSON(@codes));
    SELECT TOP 1 mapping FROM dbo.rq_ImportBatches WHERE source = N'base' AND status <> N'undone' ORDER BY batchId DESC;`);
  const [users, types, groups, refs, last] = r.recordsets;
  return {
    users,
    types: types.map((t) => ({ ...t, isActive: !!t.isActive, fields: D.parseJson(t.fields, []), flow: D.parseJson(t.flow, []) })),
    rqGroups: groups,
    existing: new Set(refs.map((x) => x.externalId)),
    previousPeople: D.parseJson(last[0]?.mapping, {})?.people || {},
  };
}

const typeChoices = (types) => types.map((t) => ({
  typeId: t.typeId, name: t.name, groupId: t.groupId, isActive: t.isActive,
  fields: t.fields.filter((f) => f.type !== 'section').map((f) => ({ key: f.key, label: f.label, type: f.type })),
}));

router.post('/base/analyze', async (req, res) => {
  try {
    const input = readInput(req.body);
    const pool = await poolPromise;
    const env = await loadEnv(pool, input);
    const { config, ...a } = B.analyze(input, { ...env, importerId: req.user.userID }, req.body?.settings || {});
    ok(req, res, { ...a, types: typeChoices(env.types), rqGroups: env.rqGroups });
  } catch (err) { fail(res, err, 'POST /admin/import/base/analyze'); }
});

/* ================================ NHẬP ================================ */

// Tạo lần nhập: phân tích lại cả tệp (cấu hình trường + lựa chọn tính trên TOÀN BỘ dòng, dùng chung cho mọi phần),
// tạo mẫu mới cho nhóm Base chọn "Tạo mẫu mới" (đang ẩn), lưu cấu hình vào rq_ImportBatches.mapping.
router.post('/base/batches', async (req, res) => {
  try {
    const input = readInput(req.body);
    const uid = req.user.userID;
    const pool = await poolPromise;
    const env = await loadEnv(pool, input);
    const a = B.analyze(input, { ...env, importerId: uid }, req.body?.settings || {});
    if (a.missing.length) throw new D.ValidationError(`Tệp thiếu cột: ${a.missing.join(', ')}`);
    if (!a.willCreate) throw new D.ValidationError('Không có đề xuất nào để nhập (đã nhập hết hoặc đều bị bỏ qua)');

    const createdTypes = [];
    for (const [name, g] of Object.entries(a.config.groups)) {
      if (!g.isNew || g.skip) continue;
      if (!a.rows.some((r) => r.group === name && r.state === 'ok')) { g.skip = true; continue; }
      const active = await activeUserIds(pool, g.approverSeq);
      const def = D.normalizeType(B.newTypeBody(name, g, g.approverSeq.filter((id) => active.has(id)), g.groupId));
      const typeId = await saveType(pool, null, def, uid);
      Object.assign(g, { isNew: false, typeId, typeName: def.name, groupId: def.groupId, flow: def.flow, fields: def.fields });
      createdTypes.push({ typeId, name: def.name, group: name });
    }
    const groups = Object.fromEntries(Object.entries(a.config.groups).map(([name, g]) => [name, {
      skip: g.skip, typeId: g.typeId, typeName: g.typeName, groupId: g.groupId, flow: g.flow, fields: g.fields, plan: g.plan,
    }]));
    const mapping = { v: 1, people: a.config.people, pendingMode: a.config.pendingMode, groups, createdTypes };
    const r = await pool.request()
      .input('file', sql.NVarChar(255), String(req.body?.fileName || '').slice(0, 255) || null)
      .input('total', sql.Int, a.total)
      .input('mapping', sql.NVarChar(sql.MAX), JSON.stringify(mapping))
      .input('uid', sql.Int, uid)
      .query(`INSERT INTO dbo.rq_ImportBatches (source, fileName, totalRows, mapping, createdBy)
              OUTPUT INSERTED.batchId VALUES (N'base', @file, @total, @mapping, @uid)`);
    ok(req, res, { batchId: r.recordset[0].batchId, willCreate: a.willCreate, createdTypes });
  } catch (err) { fail(res, err, 'POST /admin/import/base/batches'); }
});

// 1 lô ≤ MAX_CHUNK đề xuất = 1 transaction. MERGE … OUTPUT để biết requestId của từng dòng nguồn.
// Đề xuất đã có trong rq_ImportRefs (nhập trước / 2 người bấm cùng lúc) bị bỏ qua nhờ UPDLOCK, HOLDLOCK.
const INSERT_SQL = `
  SET XACT_ABORT ON;
  BEGIN TRAN;
  DECLARE @src TABLE (idx INT PRIMARY KEY, externalId NVARCHAR(50) NOT NULL, externalCode NVARCHAR(50) NULL, g INT,
    typeId INT, typeName NVARCHAR(200), groupId INT, title NVARCHAR(300), requesterId INT, requesterName NVARCHAR(200),
    msnv NVARCHAR(50), departmentId INT, departmentName NVARCHAR(150), teamId INT, teamName NVARCHAR(150), jobTitleName NVARCHAR(150),
    fieldValues NVARCHAR(MAX), flow NVARCHAR(MAX), status NVARCHAR(20), currentStep INT, stepCount INT,
    createdAt VARCHAR(19), updatedAt VARCHAR(19), finishedAt VARCHAR(19), commentCount INT, editCount INT);
  DECLARE @map TABLE (idx INT PRIMARY KEY, requestId INT NOT NULL);

  INSERT INTO @src (idx, externalId, externalCode, g, typeId, typeName, groupId, title, requesterId, requesterName, msnv,
    departmentId, departmentName, teamId, teamName, jobTitleName, fieldValues, flow, status, currentStep, stepCount,
    createdAt, updatedAt, finishedAt, commentCount, editCount)
  SELECT j.idx, j.externalId, j.externalCode, j.g, j.typeId, j.typeName, j.groupId, j.title, j.requesterId, j.requesterName, j.msnv,
    j.departmentId, j.departmentName, j.teamId, j.teamName, j.jobTitleName, j.fieldValues, j.flow, j.status, j.currentStep, j.stepCount,
    j.createdAt, j.updatedAt, j.finishedAt, j.commentCount, j.editCount
  FROM OPENJSON(@reqs) WITH (
    idx INT '$.idx', externalId NVARCHAR(50) '$.externalId', externalCode NVARCHAR(50) '$.externalCode', g INT '$.g',
    typeId INT '$.typeId', typeName NVARCHAR(200) '$.typeName', groupId INT '$.groupId', title NVARCHAR(300) '$.title',
    requesterId INT '$.requesterId', requesterName NVARCHAR(200) '$.requesterName', msnv NVARCHAR(50) '$.msnv',
    departmentId INT '$.departmentId', departmentName NVARCHAR(150) '$.departmentName', teamId INT '$.teamId',
    teamName NVARCHAR(150) '$.teamName', jobTitleName NVARCHAR(150) '$.jobTitleName',
    fieldValues NVARCHAR(MAX) '$.fieldValues' AS JSON, flow NVARCHAR(MAX) '$.flow' AS JSON,
    status NVARCHAR(20) '$.status', currentStep INT '$.currentStep', stepCount INT '$.stepCount',
    createdAt VARCHAR(19) '$.createdAt', updatedAt VARCHAR(19) '$.updatedAt', finishedAt VARCHAR(19) '$.finishedAt',
    commentCount INT '$.commentCount', editCount INT '$.editCount') j
  WHERE NOT EXISTS (SELECT 1 FROM dbo.rq_ImportRefs x WITH (UPDLOCK, HOLDLOCK) WHERE x.source = N'base' AND x.externalId = j.externalId);

  MERGE dbo.rq_Requests AS t
  USING (SELECT s.*, sc.fields FROM @src s
         JOIN OPENJSON(@schemas) WITH (g INT '$.g', fields NVARCHAR(MAX) '$.fields' AS JSON) sc ON sc.g = s.g) AS s
  ON 1 = 0
  WHEN NOT MATCHED THEN
    INSERT (typeId, typeName, groupId, title, requesterId, requesterName, msnv, departmentId, departmentName, teamId, teamName,
      jobTitleName, fields, fieldValues, flow, status, priority, currentStep, stepCount, createdAt, updatedAt, finishedAt,
      lastActivityAt, commentCount, editCount)
    VALUES (s.typeId, s.typeName, s.groupId, s.title, s.requesterId, s.requesterName, s.msnv, s.departmentId, s.departmentName,
      s.teamId, s.teamName, s.jobTitleName, s.fields, s.fieldValues, s.flow, s.status, N'normal', s.currentStep, s.stepCount,
      CONVERT(datetime2, s.createdAt, 126), CONVERT(datetime2, s.updatedAt, 126), CONVERT(datetime2, s.finishedAt, 126),
      CONVERT(datetime2, s.updatedAt, 126), s.commentCount, s.editCount)
  OUTPUT s.idx, INSERTED.requestId INTO @map (idx, requestId);

  INSERT INTO dbo.rq_ImportRefs (source, externalId, externalCode, requestId, batchId)
  SELECT N'base', s.externalId, s.externalCode, m.requestId, @batchId FROM @src s JOIN @map m ON m.idx = s.idx;

  INSERT INTO dbo.rq_RequestApprovers (requestId, stepNo, stepName, stepMode, userId, status, note, actedAt)
  SELECT m.requestId, j.stepNo, j.stepName, j.stepMode, j.userId, j.status, j.note, CONVERT(datetime2, j.actedAt, 126)
  FROM OPENJSON(@approvers) WITH (idx INT '$.idx', stepNo INT '$.stepNo', stepName NVARCHAR(150) '$.stepName',
    stepMode NVARCHAR(5) '$.stepMode', userId INT '$.userId', status NVARCHAR(10) '$.status', note NVARCHAR(1000) '$.note',
    actedAt VARCHAR(19) '$.actedAt') j
  JOIN @map m ON m.idx = j.idx
  ORDER BY j.idx, j.stepNo;

  INSERT INTO dbo.rq_RequestFollowers (requestId, userId, addedBy, createdAt)
  SELECT m.requestId, j.userId, s.requesterId, CONVERT(datetime2, s.createdAt, 126)
  FROM OPENJSON(@followers) WITH (idx INT '$.idx', userId INT '$.userId') j
  JOIN @map m ON m.idx = j.idx JOIN @src s ON s.idx = j.idx;

  INSERT INTO dbo.rq_Comments (requestId, userId, body, createdAt)
  SELECT m.requestId, j.userId, j.body, CONVERT(datetime2, j.at, 126)
  FROM OPENJSON(@comments) WITH (idx INT '$.idx', seq INT '$.seq', userId INT '$.userId', body NVARCHAR(4000) '$.body', at VARCHAR(19) '$.at') j
  JOIN @map m ON m.idx = j.idx
  ORDER BY j.idx, j.seq;

  INSERT INTO dbo.rq_Activities (requestId, userId, action, stepNo, note, createdAt)
  SELECT m.requestId, j.userId, j.action, j.stepNo, j.note, ISNULL(CONVERT(datetime2, j.at, 126), SYSDATETIME())
  FROM OPENJSON(@activities) WITH (idx INT '$.idx', seq INT '$.seq', userId INT '$.userId', action NVARCHAR(30) '$.action',
    stepNo INT '$.stepNo', note NVARCHAR(1000) '$.note', at VARCHAR(19) '$.at') j
  JOIN @map m ON m.idx = j.idx
  ORDER BY j.idx, j.seq;

  DECLARE @created INT = (SELECT COUNT(*) FROM @map);
  UPDATE dbo.rq_ImportBatches
  SET createdCount = createdCount + @created, skippedCount = skippedCount + @skipped + (@sent - @created)
  WHERE batchId = @batchId;
  COMMIT;
  SELECT s.externalId, m.requestId FROM @src s JOIN @map m ON m.idx = s.idx;`;

/** Ảnh chụp người gửi (họ tên, MSNV, phòng, tổ, chức danh) — như lúc gửi đề xuất trên NOIBO */
async function loadProfiles(pool, ids) {
  if (!ids.length) return new Map();
  const r = await pool.request().input('ids', sql.NVarChar(sql.MAX), JSON.stringify(ids)).query(`
    SELECT u.userID AS userId, u.fullName, u.msnv, p.departmentId, d.name AS departmentName,
           p.teamId, t.name AS teamName, j.name AS jobTitleName
    FROM dbo.Users u
    ${profileApply('u')}
    LEFT JOIN dbo.org_Departments d ON d.departmentId = p.departmentId
    LEFT JOIN dbo.org_Teams t ON t.teamId = p.teamId
    LEFT JOIN dbo.org_JobTitles j ON j.jobTitleId = p.jobTitleId
    WHERE u.userID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))`);
  return new Map(r.recordset.map((p) => [p.userId, p]));
}

router.post('/base/batches/:id/rows', async (req, res) => {
  try {
    const batchId = parseId(req.params.id);
    if (!batchId) return res.status(400).json({ success: false, message: 'Mã lần nhập không hợp lệ' });
    const input = readInput(req.body);
    if (input.rows.length > MAX_CHUNK) throw new D.ValidationError(`Mỗi lần gửi tối đa ${MAX_CHUNK} dòng`);
    const uid = req.user.userID;
    const pool = await poolPromise;
    const batch = (await pool.request().input('id', sql.Int, batchId)
      .query(`SELECT batchId, status, mapping FROM dbo.rq_ImportBatches WHERE batchId = @id`)).recordset[0];
    if (!batch) throw httpError(404, 'Không tìm thấy lần nhập');
    if (batch.status !== 'running') throw httpError(409, 'Lần nhập này đã kết thúc — tạo lần nhập mới');
    const cfg = D.parseJson(batch.mapping, {});

    const read = B.readRows(input.header, input.rows);
    if (read.missing.length) throw new D.ValidationError(`Tệp thiếu cột: ${read.missing.join(', ')}`);
    const ctx = { groups: cfg.groups || {}, people: cfg.people || {}, pendingMode: cfg.pendingMode, importerId: uid };
    const built = read.rows.map((r) => ({ r, b: B.buildRequest(r, ctx) }));
    const good = built.filter((x) => x.b.ok);
    const skipped = [...read.errors.map((e) => ({ code: e.code, reason: e.reason })),
      ...built.filter((x) => !x.b.ok).map((x) => ({ code: x.r.code, reason: x.b.reason }))];

    let createdIds = [];
    if (good.length) {
      const profiles = await loadProfiles(pool, [...new Set(good.map((x) => x.b.request.requesterId))]);
      const groupNames = Object.keys(ctx.groups);
      const schemas = groupNames.map((name, g) => ({ g, fields: ctx.groups[name].fields || [] }));
      const reqs = [], approvers = [], followers = [], comments = [], activities = [];
      good.forEach(({ r, b }, idx) => {
        const q = b.request;
        const p = profiles.get(q.requesterId) || {};
        reqs.push({
          idx, g: groupNames.indexOf(r.group), externalId: q.externalId, externalCode: q.externalCode,
          typeId: q.typeId, typeName: q.typeName, groupId: q.groupId, title: q.title, requesterId: q.requesterId,
          requesterName: p.fullName || null, msnv: p.msnv || null, departmentId: p.departmentId || null,
          departmentName: p.departmentName || null, teamId: p.teamId || null, teamName: p.teamName || null, jobTitleName: p.jobTitleName || null,
          fieldValues: q.fieldValues, flow: q.flow, status: q.status, currentStep: q.currentStep, stepCount: q.stepCount,
          createdAt: q.createdAt, updatedAt: q.updatedAt, finishedAt: q.finishedAt, commentCount: q.commentCount, editCount: q.editCount,
        });
        q.approvers.forEach((a) => approvers.push({ idx, ...a }));
        q.followers.forEach((userId) => followers.push({ idx, userId }));
        q.comments.forEach((c, seq) => comments.push({ idx, seq, ...c }));
        q.activities.forEach((a, seq) => activities.push({ idx, seq, ...a }));
      });
      const r = await pool.request()
        .input('batchId', sql.Int, batchId)
        .input('sent', sql.Int, good.length)
        .input('skipped', sql.Int, skipped.length)
        .input('reqs', sql.NVarChar(sql.MAX), JSON.stringify(reqs))
        .input('schemas', sql.NVarChar(sql.MAX), JSON.stringify(schemas))
        .input('approvers', sql.NVarChar(sql.MAX), JSON.stringify(approvers))
        .input('followers', sql.NVarChar(sql.MAX), JSON.stringify(followers))
        .input('comments', sql.NVarChar(sql.MAX), JSON.stringify(comments))
        .input('activities', sql.NVarChar(sql.MAX), JSON.stringify(activities))
        .query(INSERT_SQL);
      createdIds = r.recordset.map((x) => x.requestId);
    } else if (skipped.length) {
      await pool.request().input('id', sql.Int, batchId).input('n', sql.Int, skipped.length)
        .query(`UPDATE dbo.rq_ImportBatches SET skippedCount = skippedCount + @n WHERE batchId = @id`);
    }
    ok(req, res, {
      created: createdIds.length,
      duplicates: good.length - createdIds.length,
      skipped,
      warned: good.filter((x) => x.b.warnings.length).length,
    });
  } catch (err) { fail(res, err, 'POST /admin/import/base/batches/:id/rows'); }
});

router.post('/base/batches/:id/finish', async (req, res) => {
  try {
    const batchId = parseId(req.params.id);
    if (!batchId) return res.status(400).json({ success: false, message: 'Mã lần nhập không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, batchId).query(`
      UPDATE dbo.rq_ImportBatches SET status = N'done', finishedAt = SYSDATETIME() WHERE batchId = @id AND status = N'running';
      SELECT batchId, status, createdCount, skippedCount, totalRows FROM dbo.rq_ImportBatches WHERE batchId = @id;`);
    if (!r.recordset[0]) throw httpError(404, 'Không tìm thấy lần nhập');
    ok(req, res, r.recordset[0]);
  } catch (err) { fail(res, err, 'POST /admin/import/base/batches/:id/finish'); }
});

/* ================================ LỊCH SỬ / HOÀN TÁC ================================ */

router.get('/batches', async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT TOP 50 b.batchId, b.source, b.fileName, b.totalRows, b.createdCount, b.skippedCount, b.status,
             ${dt('b.createdAt', 'createdAt')}, ${dt('b.finishedAt', 'finishedAt')}, ${dt('b.undoneAt', 'undoneAt')},
             u.fullName AS createdByName, uu.fullName AS undoneByName,
             (SELECT COUNT(*) FROM dbo.rq_ImportRefs x WHERE x.batchId = b.batchId) AS currentCount,
             JSON_QUERY(b.mapping, '$.createdTypes') AS createdTypes
      FROM dbo.rq_ImportBatches b
      LEFT JOIN dbo.Users u ON u.userID = b.createdBy
      LEFT JOIN dbo.Users uu ON uu.userID = b.undoneBy
      ORDER BY b.batchId DESC`);
    ok(req, res, r.recordset.map((b) => ({ ...b, createdTypes: D.parseJson(b.createdTypes, []) || [] })));
  } catch (err) { fail(res, err, 'GET /admin/import/batches'); }
});

// Hoàn tác (sửa nhầm khi nhập): xoá mềm đề xuất của lần nhập + bỏ dấu "đã nhập" để nhập lại được. Bỏ qua quy tắc
// "đã duyệt thì không xoá" vì đây là dữ liệu vừa nhập. Đề xuất đã có người thao tác SAU khi nhập (duyệt, bình luận,
// tệp…) thì giữ lại. Mẫu đề xuất tạo khi nhập không bị xoá (xoá tay ở "Mẫu đề xuất" nếu cần).
router.post('/batches/:id/undo', async (req, res) => {
  try {
    const batchId = parseId(req.params.id);
    if (!batchId) return res.status(400).json({ success: false, message: 'Mã lần nhập không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, batchId).input('uid', sql.Int, req.user.userID).query(`
      SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @at DATETIME2, @st NVARCHAR(20);
      SELECT @at = createdAt, @st = status FROM dbo.rq_ImportBatches WITH (UPDLOCK, HOLDLOCK) WHERE batchId = @id;
      IF @at IS NULL THROW 50121, N'Không tìm thấy lần nhập', 1;
      IF @st = N'undone' THROW 50122, N'Lần nhập này đã hoàn tác rồi', 1;
      DECLARE @del TABLE (requestId INT PRIMARY KEY);
      INSERT INTO @del (requestId)
      SELECT x.requestId FROM dbo.rq_ImportRefs x
      WHERE x.batchId = @id
        AND NOT EXISTS (SELECT 1 FROM dbo.rq_Activities a WHERE a.requestId = x.requestId AND a.action <> N'import' AND a.createdAt >= @at)
        AND NOT EXISTS (SELECT 1 FROM dbo.rq_Comments c WHERE c.requestId = x.requestId AND c.createdAt >= @at)
        AND NOT EXISTS (SELECT 1 FROM dbo.rq_Files f WHERE f.requestId = x.requestId);
      UPDATE r SET isDeleted = 1, updatedAt = SYSDATETIME()
      FROM dbo.rq_Requests r JOIN @del d ON d.requestId = r.requestId;
      UPDATE n SET isRead = 1 FROM dbo.rq_Notifications n JOIN @del d ON d.requestId = n.requestId WHERE n.isRead = 0;
      INSERT INTO dbo.rq_Activities (requestId, userId, action, note)
      SELECT requestId, @uid, N'delete', N'Hoàn tác nhập từ Base Request' FROM @del;
      DELETE x FROM dbo.rq_ImportRefs x JOIN @del d ON d.requestId = x.requestId;
      DECLARE @kept INT = (SELECT COUNT(*) FROM dbo.rq_ImportRefs WHERE batchId = @id);
      UPDATE dbo.rq_ImportBatches
      SET status = CASE WHEN @kept = 0 THEN N'undone' ELSE N'done' END, createdCount = @kept,
          finishedAt = ISNULL(finishedAt, SYSDATETIME()), undoneBy = @uid, undoneAt = SYSDATETIME()
      WHERE batchId = @id;
      COMMIT;
      SELECT (SELECT COUNT(*) FROM @del) AS removed, @kept AS kept;`);
    ok(req, res, r.recordset[0]);
  } catch (err) { fail(res, err, 'POST /admin/import/batches/:id/undo'); }
});

// thân request quá lớn / JSON hỏng (parser của router này) → JSON có thông báo thay vì trang lỗi HTML
router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Tệp quá lớn — chia nhỏ tệp Excel rồi nhập từng phần' });
  if (err?.type === 'entity.parse.failed' || err?.type === 'encoding.unsupported') return res.status(400).json({ success: false, message: 'Dữ liệu gửi lên không đọc được' });
  return next(err);
});

module.exports = router;
