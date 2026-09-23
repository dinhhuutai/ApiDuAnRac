// FormManagement/api.js — Module 9 "Biểu mẫu nội bộ" (bản xây lại)
// Mount: app.use('/api/fm', require('./FormManagement/api'))
// Bảng: fm_* (biểu mẫu) và org_* (phòng ban / chức danh dùng chung) — xem sql/06.
//
// Quy ước thời gian: cột DATETIME2 lưu giờ server (VN). Luôn đọc ra bằng
// CONVERT(varchar(19), x, 126) → 'YYYY-MM-DDTHH:mm:ss' (không có múi giờ) và ghi
// vào bằng chuỗi → CONVERT(datetime2, @x, 126). Không truyền JS Date vào vì
// driver mssql mặc định coi Date là UTC → lệch 7 tiếng.
const express = require('express');
const { sql, poolPromise } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireModuleRole } = require('../middleware/moduleRole');
const D = require('./definition');

const router = express.Router();
const MODULE_ID = 9;

router.use(requireAuth);
const moduleUser = requireModuleRole(MODULE_ID, ['user', 'admin']);
const moduleAdmin = requireModuleRole(MODULE_ID, ['admin']);

/* ================================ HELPERS ================================ */

const dt = (col, alias) => `CONVERT(varchar(19), ${col}, 126) AS ${alias}`;

/** Người dùng có quyền module 9, đang hoạt động, kèm phòng ban/chức danh hiện tại */
const BASE_USERS_CTE = `
  base AS (
    SELECT u.userID AS userId, u.fullName, u.msnv, p.departmentId, p.jobTitleId
    FROM dbo.Users u
    JOIN dbo.UserModules um ON um.userId = u.userID AND um.moduleId = ${MODULE_ID}
    LEFT JOIN dbo.org_UserProfiles p ON p.userId = u.userID
    WHERE u.isDeleted = 0 AND ISNULL(u.isActive, 0) = 1
  )`;

/** Biểu thức: người dùng (alias u có userId/departmentId/jobTitleId) thuộc đối tượng của form f */
const audienceMatch = (f, u) => `(${f}.audienceType = N'all' OR EXISTS (
    SELECT 1 FROM dbo.fm_FormAudiences a
    WHERE a.formId = ${f}.formId AND (
      (a.targetType = N'user' AND a.targetId = ${u}.userId) OR
      (a.targetType = N'department' AND a.targetId = ${u}.departmentId) OR
      (a.targetType = N'jobTitle' AND a.targetId = ${u}.jobTitleId))))`;

const isOpenNowExpr = (f) => `CAST(CASE WHEN ${f}.acceptResponses = 1
    AND (${f}.openAt IS NULL OR ${f}.openAt <= SYSDATETIME())
    AND (${f}.closeAt IS NULL OR ${f}.closeAt >= SYSDATETIME()) THEN 1 ELSE 0 END AS bit)`;

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(res, err, where) {
  if (err instanceof D.ValidationError || err?.status === 400) {
    return res.status(400).json({ success: false, message: err.message });
  }
  // THROW 5xxxx trong batch SQL = lỗi nghiệp vụ có thông báo cho người dùng
  if (err?.number >= 50000 && err?.number < 51000) {
    return res.status(409).json({ success: false, code: err.number, message: err.message });
  }
  if (err?.number === 2627 || err?.number === 2601) {
    return res.status(409).json({ success: false, message: 'Tên này đã tồn tại' });
  }
  console.error(`❌ [fm] ${where}:`, err);
  return res.status(500).json({ success: false, message: 'Lỗi máy chủ, vui lòng thử lại' });
}

const ok = (res, data) => res.json({ success: true, data });

async function getProfile(pool, userId) {
  const r = await pool.request().input('uid', sql.Int, userId).query(`
    SELECT u.userID AS userId, u.fullName, u.msnv,
           p.departmentId, d.name AS departmentName,
           p.jobTitleId, j.name AS jobTitleName, p.source
    FROM dbo.Users u
    LEFT JOIN dbo.org_UserProfiles p ON p.userId = u.userID
    LEFT JOIN dbo.org_Departments d ON d.departmentId = p.departmentId
    LEFT JOIN dbo.org_JobTitles j ON j.jobTitleId = p.jobTitleId
    WHERE u.userID = @uid`);
  const p = r.recordset[0] || null;
  if (p) p.isComplete = !!(p.departmentId && p.jobTitleId);
  return p;
}

async function getOrgOptions(pool) {
  const r = await pool.request().query(`
    SELECT departmentId AS id, name FROM dbo.org_Departments WHERE isActive = 1 ORDER BY sortOrder, name;
    SELECT jobTitleId AS id, name FROM dbo.org_JobTitles WHERE isActive = 1 ORDER BY sortOrder, name;`);
  return { departments: r.recordsets[0], jobTitles: r.recordsets[1] };
}

/** Câu hỏi của form. activeOnly=false: gồm cả câu đã gỡ còn câu trả lời (cho thống kê/xuất) */
async function getQuestions(pool, formId, { activeOnly = true, withAnswerCount = false } = {}) {
  const r = await pool.request().input('fid', sql.Int, formId).query(`
    SELECT q.questionId, q.questionKey, q.type, q.label, q.description, q.isRequired, q.sortOrder, q.settings, q.isActive
      ${withAnswerCount ? ', (SELECT COUNT(*) FROM dbo.fm_Answers a WHERE a.questionId = q.questionId) AS answerCount' : ''}
    FROM dbo.fm_Questions q
    WHERE q.formId = @fid ${activeOnly ? 'AND q.isActive = 1' : ''}
    ORDER BY q.isActive DESC, q.sortOrder, q.questionId`);
  return r.recordset.map((q) => ({ ...q, settings: D.parseSettings(q.settings) }));
}

/* ============================ NGƯỜI DÙNG (module 9) ============================ */

router.get('/me/profile', moduleUser, async (req, res) => {
  try {
    const pool = await poolPromise;
    const [profile, options] = await Promise.all([getProfile(pool, req.user.userID), getOrgOptions(pool)]);
    ok(res, { profile, ...options });
  } catch (err) { handleError(res, err, 'GET /me/profile'); }
});

// User tự khai phòng ban + chức danh (chỉ khi admin chưa gán)
router.put('/me/profile', moduleUser, async (req, res) => {
  try {
    const departmentId = parseId(req.body?.departmentId);
    const jobTitleId = parseId(req.body?.jobTitleId);
    if (!departmentId || !jobTitleId) throw new D.ValidationError('Vui lòng chọn phòng ban và chức danh');
    const pool = await poolPromise;
    await pool.request()
      .input('uid', sql.Int, req.user.userID)
      .input('dept', sql.Int, departmentId)
      .input('title', sql.Int, jobTitleId)
      .query(`
        SET XACT_ABORT ON;
        IF NOT EXISTS (SELECT 1 FROM dbo.org_Departments WHERE departmentId = @dept AND isActive = 1)
          THROW 50021, N'Phòng ban không hợp lệ', 1;
        IF NOT EXISTS (SELECT 1 FROM dbo.org_JobTitles WHERE jobTitleId = @title AND isActive = 1)
          THROW 50022, N'Chức danh không hợp lệ', 1;
        IF EXISTS (SELECT 1 FROM dbo.org_UserProfiles WITH (UPDLOCK, HOLDLOCK) WHERE userId = @uid AND source = N'admin')
          THROW 50020, N'Phòng ban/chức danh của bạn do quản trị viên gán — liên hệ quản trị viên để thay đổi', 1;
        MERGE dbo.org_UserProfiles AS t
        USING (SELECT @uid AS userId) AS s ON t.userId = s.userId
        WHEN MATCHED THEN UPDATE SET departmentId = @dept, jobTitleId = @title, updatedAt = SYSDATETIME(), updatedBy = @uid
        WHEN NOT MATCHED THEN INSERT (userId, departmentId, jobTitleId, source, updatedBy) VALUES (@uid, @dept, @title, N'self', @uid);`);
    ok(res, { profile: await getProfile(pool, req.user.userID) });
  } catch (err) { handleError(res, err, 'PUT /me/profile'); }
});

// Danh sách biểu mẫu đang hiện cho tôi
router.get('/me/forms', moduleUser, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('uid', sql.Int, req.user.userID).query(`
      WITH me AS (
        SELECT @uid AS userId, p.departmentId, p.jobTitleId
        FROM (SELECT 1 AS x) z LEFT JOIN dbo.org_UserProfiles p ON p.userId = @uid
      )
      SELECT f.formId, f.title, f.description, f.themeColor, f.allowEditAfterSubmit, f.allowMultiple,
             ${dt('f.openAt', 'openAt')}, ${dt('f.closeAt', 'closeAt')},
             ${isOpenNowExpr('f')} AS isOpenNow,
             (SELECT COUNT(*) FROM dbo.fm_Questions q WHERE q.formId = f.formId AND q.isActive = 1 AND q.type <> N'section') AS questionCount,
             (SELECT COUNT(*) FROM dbo.fm_Responses r WHERE r.formId = f.formId AND r.userId = @uid) AS myResponseCount,
             (SELECT CONVERT(varchar(19), MAX(ISNULL(r.updatedAt, r.submittedAt)), 126)
                FROM dbo.fm_Responses r WHERE r.formId = f.formId AND r.userId = @uid) AS myLastSubmittedAt
      FROM dbo.fm_Forms f CROSS JOIN me m
      WHERE f.isDeleted = 0 AND f.isVisible = 1 AND ${audienceMatch('f', 'm')}
      ORDER BY ${isOpenNowExpr('f')} DESC, ISNULL(f.closeAt, '9999-12-31') ASC, f.formId DESC`);
    ok(res, r.recordset);
  } catch (err) { handleError(res, err, 'GET /me/forms'); }
});

/** Form (đang hiện với user) + cờ trạng thái. null nếu user không được xem */
async function loadVisibleFormForUser(pool, formId, userId) {
  const r = await pool.request().input('fid', sql.Int, formId).input('uid', sql.Int, userId).query(`
    WITH me AS (
      SELECT @uid AS userId, p.departmentId, p.jobTitleId
      FROM (SELECT 1 AS x) z LEFT JOIN dbo.org_UserProfiles p ON p.userId = @uid
    )
    SELECT f.formId, f.title, f.description, f.themeColor, f.thankYouMessage,
           f.allowEditAfterSubmit, f.allowMultiple, f.requireProfile, f.acceptResponses,
           ${dt('f.openAt', 'openAt')}, ${dt('f.closeAt', 'closeAt')},
           ${isOpenNowExpr('f')} AS isOpenNow
    FROM dbo.fm_Forms f CROSS JOIN me m
    WHERE f.formId = @fid AND f.isDeleted = 0 AND f.isVisible = 1 AND ${audienceMatch('f', 'm')}`);
  return r.recordset[0] || null;
}

// Chi tiết form để điền (kèm phiếu gần nhất của tôi để sửa)
router.get('/me/forms/:id', moduleUser, async (req, res) => {
  try {
    const formId = parseId(req.params.id);
    if (!formId) return res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' });
    const pool = await poolPromise;
    const form = await loadVisibleFormForUser(pool, formId, req.user.userID);
    if (!form) return res.status(404).json({ success: false, message: 'Biểu mẫu không tồn tại hoặc bạn không được xem' });

    const [questions, profile, mine] = await Promise.all([
      getQuestions(pool, formId),
      getProfile(pool, req.user.userID),
      pool.request().input('fid', sql.Int, formId).input('uid', sql.Int, req.user.userID).query(`
        SELECT TOP 1 r.responseId, ${dt('r.submittedAt', 'submittedAt')}, ${dt('r.updatedAt', 'updatedAt')},
               (SELECT COUNT(*) FROM dbo.fm_Responses x WHERE x.formId = @fid AND x.userId = @uid) AS total
        FROM dbo.fm_Responses r WHERE r.formId = @fid AND r.userId = @uid ORDER BY r.responseId DESC`),
    ]);

    let myResponse = null;
    const last = mine.recordset[0];
    if (last) {
      const a = await pool.request().input('rid', sql.BigInt, last.responseId)
        .query(`SELECT questionId, valueText, valueNumber, valueJson FROM dbo.fm_Answers WHERE responseId = @rid`);
      const typeById = new Map(questions.map((q) => [q.questionId, q.type]));
      const answers = {};
      for (const row of a.recordset) {
        const type = typeById.get(row.questionId);
        if (type) answers[row.questionId] = D.answerRowToRaw(type, row);
      }
      myResponse = { responseId: last.responseId, submittedAt: last.submittedAt, updatedAt: last.updatedAt, total: last.total, answers };
    }

    const hasSubmitted = !!last;
    let canSubmit = !!form.isOpenNow && (form.allowMultiple || !hasSubmitted || form.allowEditAfterSubmit);
    let blockReason = null;
    if (!form.isOpenNow) blockReason = 'Biểu mẫu đã đóng hoặc chưa mở nhận phiếu';
    else if (!canSubmit) blockReason = 'Bạn đã nộp biểu mẫu này';
    const profileRequired = !!form.requireProfile && !profile?.isComplete;

    ok(res, {
      form,
      questions: questions.map(({ isActive, sortOrder, ...q }) => q),
      profile,
      profileRequired,
      myResponse,
      canSubmit,
      // allowMultiple: mỗi lần nộp là 1 phiếu mới → không nạp lại câu trả lời cũ
      mode: form.allowMultiple ? 'new' : hasSubmitted ? 'edit' : 'new',
      blockReason,
    });
  } catch (err) { handleError(res, err, 'GET /me/forms/:id'); }
});

// Nộp / sửa phiếu
router.post('/me/forms/:id/submit', moduleUser, async (req, res) => {
  try {
    const formId = parseId(req.params.id);
    if (!formId) return res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' });
    const pool = await poolPromise;
    const form = await loadVisibleFormForUser(pool, formId, req.user.userID);
    if (!form) return res.status(404).json({ success: false, message: 'Biểu mẫu không tồn tại hoặc bạn không được xem' });
    if (!form.isOpenNow) return res.status(409).json({ success: false, message: 'Biểu mẫu đã đóng hoặc chưa mở nhận phiếu' });

    const profile = await getProfile(pool, req.user.userID);
    if (form.requireProfile && !profile?.isComplete) {
      return res.status(409).json({ success: false, code: 'PROFILE_REQUIRED', message: 'Vui lòng cập nhật phòng ban và chức danh trước khi nộp' });
    }

    const questions = await getQuestions(pool, formId);
    const rows = D.buildAnswerRows(questions, req.body?.answers);
    if (rows.length === 0) throw new D.ValidationError('Bạn chưa trả lời câu nào');

    const r = await pool.request()
      .input('fid', sql.Int, formId)
      .input('uid', sql.Int, req.user.userID)
      .input('allowMultiple', sql.Bit, form.allowMultiple)
      .input('allowEdit', sql.Bit, form.allowEditAfterSubmit)
      .input('fullName', sql.NVarChar(200), profile?.fullName || null)
      .input('msnv', sql.NVarChar(50), profile?.msnv || null)
      .input('deptId', sql.Int, profile?.departmentId || null)
      .input('deptName', sql.NVarChar(150), profile?.departmentName || null)
      .input('titleId', sql.Int, profile?.jobTitleId || null)
      .input('titleName', sql.NVarChar(150), profile?.jobTitleName || null)
      .input('answers', sql.NVarChar(sql.MAX), JSON.stringify(rows))
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @rid BIGINT = NULL, @isEdit BIT = 0;
        IF @allowMultiple = 0
          SELECT TOP 1 @rid = responseId FROM dbo.fm_Responses WITH (UPDLOCK, HOLDLOCK)
          WHERE formId = @fid AND userId = @uid ORDER BY responseId DESC;

        IF @rid IS NOT NULL AND @allowEdit = 0
          THROW 50010, N'Bạn đã nộp biểu mẫu này, không thể nộp lại', 1;

        IF @rid IS NULL
        BEGIN
          INSERT INTO dbo.fm_Responses (formId, userId, fullName, msnv, departmentId, departmentName, jobTitleId, jobTitleName)
          VALUES (@fid, @uid, @fullName, @msnv, @deptId, @deptName, @titleId, @titleName);
          SET @rid = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
          SET @isEdit = 1;
          UPDATE dbo.fm_Responses
          SET fullName = @fullName, msnv = @msnv, departmentId = @deptId, departmentName = @deptName,
              jobTitleId = @titleId, jobTitleName = @titleName,
              updatedAt = SYSDATETIME(), editCount = editCount + 1
          WHERE responseId = @rid;
          DELETE FROM dbo.fm_Answers WHERE responseId = @rid;
        END

        INSERT INTO dbo.fm_Answers (responseId, questionId, valueText, valueNumber, valueJson, valueDisplay)
        SELECT @rid, j.questionId, j.valueText, j.valueNumber, j.valueJson, j.valueDisplay
        FROM OPENJSON(@answers) WITH (
          questionId INT '$.questionId', valueText NVARCHAR(MAX) '$.valueText', valueNumber DECIMAL(18,2) '$.valueNumber',
          valueJson NVARCHAR(MAX) '$.valueJson', valueDisplay NVARCHAR(MAX) '$.valueDisplay') j;
        COMMIT;

        SELECT @rid AS responseId, @isEdit AS isEdit, CONVERT(varchar(19), SYSDATETIME(), 126) AS savedAt;`);

    ok(res, { ...r.recordset[0], thankYouMessage: form.thankYouMessage });
  } catch (err) { handleError(res, err, 'POST /me/forms/:id/submit'); }
});

/* ================================ ADMIN — BIỂU MẪU ================================ */

router.get('/admin/forms', moduleAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      WITH ${BASE_USERS_CTE}
      SELECT f.formId, f.title, f.isVisible, f.acceptResponses, f.audienceType, f.allowMultiple, f.themeColor,
             ${dt('f.openAt', 'openAt')}, ${dt('f.closeAt', 'closeAt')},
             ${dt('f.createdAt', 'createdAt')}, ${dt('ISNULL(f.updatedAt, f.createdAt)', 'updatedAt')},
             cu.fullName AS createdByName,
             ${isOpenNowExpr('f')} AS isOpenNow,
             (SELECT COUNT(*) FROM dbo.fm_Questions q WHERE q.formId = f.formId AND q.isActive = 1 AND q.type <> N'section') AS questionCount,
             (SELECT COUNT(*) FROM dbo.fm_Responses r WHERE r.formId = f.formId) AS responseCount,
             (SELECT CONVERT(varchar(19), MAX(r.submittedAt), 126) FROM dbo.fm_Responses r WHERE r.formId = f.formId) AS lastSubmittedAt,
             (SELECT COUNT(*) FROM base b WHERE ${audienceMatch('f', 'b')}) AS targetCount,
             (SELECT COUNT(*) FROM base b WHERE ${audienceMatch('f', 'b')}
                AND EXISTS (SELECT 1 FROM dbo.fm_Responses r WHERE r.formId = f.formId AND r.userId = b.userId)) AS targetDoneCount
      FROM dbo.fm_Forms f
      LEFT JOIN dbo.Users cu ON cu.userID = f.createdBy
      WHERE f.isDeleted = 0
      ORDER BY ISNULL(f.updatedAt, f.createdAt) DESC`);
    ok(res, r.recordset);
  } catch (err) { handleError(res, err, 'GET /admin/forms'); }
});

async function loadAdminForm(pool, formId) {
  const r = await pool.request().input('fid', sql.Int, formId).query(`
    SELECT f.formId, f.title, f.description, f.isVisible, f.acceptResponses, f.audienceType,
           f.allowEditAfterSubmit, f.allowMultiple, f.requireProfile, f.themeColor, f.thankYouMessage,
           ${dt('f.openAt', 'openAt')}, ${dt('f.closeAt', 'closeAt')},
           ${dt('f.createdAt', 'createdAt')}, ${dt('f.updatedAt', 'updatedAt')},
           (SELECT COUNT(*) FROM dbo.fm_Responses r WHERE r.formId = f.formId) AS responseCount
    FROM dbo.fm_Forms f WHERE f.formId = @fid AND f.isDeleted = 0;

    SELECT a.targetType, a.targetId,
           CASE a.targetType
             WHEN N'department' THEN (SELECT name FROM dbo.org_Departments WHERE departmentId = a.targetId)
             WHEN N'jobTitle'   THEN (SELECT name FROM dbo.org_JobTitles WHERE jobTitleId = a.targetId)
             WHEN N'user'       THEN (SELECT fullName + ISNULL(N' (' + msnv + N')', N'') FROM dbo.Users WHERE userID = a.targetId)
           END AS name
    FROM dbo.fm_FormAudiences a WHERE a.formId = @fid;`);
  const form = r.recordsets[0][0];
  if (!form) return null;
  form.audiences = r.recordsets[1];
  form.questions = await getQuestions(pool, formId, { withAnswerCount: true });
  return form;
}

router.get('/admin/forms/:id', moduleAdmin, async (req, res) => {
  try {
    const formId = parseId(req.params.id);
    if (!formId) return res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' });
    const pool = await poolPromise;
    const form = await loadAdminForm(pool, formId);
    if (!form) return res.status(404).json({ success: false, message: 'Không tìm thấy biểu mẫu' });
    ok(res, form);
  } catch (err) { handleError(res, err, 'GET /admin/forms/:id'); }
});

/** Tạo (formId=null) hoặc cập nhật form + đối tượng + câu hỏi trong 1 transaction */
async function saveForm(pool, formId, def, actorId) {
  const questionsJson = JSON.stringify(def.questions.map((q, i) => ({ ...q, sortOrder: i + 1 })));
  const r = await pool.request()
    .input('inFormId', sql.Int, formId)
    .input('actor', sql.Int, actorId)
    .input('title', sql.NVarChar(300), def.title)
    .input('description', sql.NVarChar(sql.MAX), def.description)
    .input('isVisible', sql.Bit, def.isVisible)
    .input('acceptResponses', sql.Bit, def.acceptResponses)
    .input('openAt', sql.VarChar(19), def.openAt)
    .input('closeAt', sql.VarChar(19), def.closeAt)
    .input('audienceType', sql.NVarChar(20), def.audienceType)
    .input('allowEdit', sql.Bit, def.allowEditAfterSubmit)
    .input('allowMultiple', sql.Bit, def.allowMultiple)
    .input('requireProfile', sql.Bit, def.requireProfile)
    .input('themeColor', sql.NVarChar(20), def.themeColor)
    .input('thankYou', sql.NVarChar(1000), def.thankYouMessage)
    .input('audiences', sql.NVarChar(sql.MAX), JSON.stringify(def.audiences))
    .input('questions', sql.NVarChar(sql.MAX), questionsJson)
    .query(`
      SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @formId INT = @inFormId;
      DECLARE @openDt DATETIME2 = CONVERT(datetime2, @openAt, 126);
      DECLARE @closeDt DATETIME2 = CONVERT(datetime2, @closeAt, 126);

      IF @formId IS NULL
      BEGIN
        INSERT INTO dbo.fm_Forms (title, description, isVisible, acceptResponses, openAt, closeAt, audienceType,
                                  allowEditAfterSubmit, allowMultiple, requireProfile, themeColor, thankYouMessage, createdBy)
        VALUES (@title, @description, @isVisible, @acceptResponses, @openDt, @closeDt, @audienceType,
                @allowEdit, @allowMultiple, @requireProfile, @themeColor, @thankYou, @actor);
        SET @formId = SCOPE_IDENTITY();
      END
      ELSE
      BEGIN
        UPDATE dbo.fm_Forms
        SET title = @title, description = @description, isVisible = @isVisible, acceptResponses = @acceptResponses,
            openAt = @openDt, closeAt = @closeDt, audienceType = @audienceType,
            allowEditAfterSubmit = @allowEdit, allowMultiple = @allowMultiple, requireProfile = @requireProfile,
            themeColor = @themeColor, thankYouMessage = @thankYou, updatedBy = @actor, updatedAt = SYSDATETIME()
        WHERE formId = @formId AND isDeleted = 0;
        IF @@ROWCOUNT = 0 THROW 50004, N'Không tìm thấy biểu mẫu', 1;
      END

      -- Đối tượng
      DELETE FROM dbo.fm_FormAudiences WHERE formId = @formId;
      INSERT INTO dbo.fm_FormAudiences (formId, targetType, targetId)
      SELECT @formId, j.targetType, j.targetId
      FROM OPENJSON(@audiences) WITH (targetType NVARCHAR(20) '$.targetType', targetId INT '$.targetId') j;

      -- Câu hỏi
      DECLARE @q TABLE (questionKey NVARCHAR(40) PRIMARY KEY, type NVARCHAR(30), label NVARCHAR(1000),
                        description NVARCHAR(2000), isRequired BIT, sortOrder INT, settings NVARCHAR(MAX));
      INSERT INTO @q
      SELECT questionKey, type, label, description, isRequired, sortOrder, settings
      FROM OPENJSON(@questions) WITH (
        questionKey NVARCHAR(40) '$.questionKey', type NVARCHAR(30) '$.type', label NVARCHAR(1000) '$.label',
        description NVARCHAR(2000) '$.description', isRequired BIT '$.isRequired', sortOrder INT '$.sortOrder',
        settings NVARCHAR(MAX) '$.settings' AS JSON);

      DECLARE @changed NVARCHAR(1000) = (
        SELECT TOP 1 q.label FROM dbo.fm_Questions q JOIN @q s ON s.questionKey = q.questionKey
        WHERE q.formId = @formId AND q.type <> s.type
          AND EXISTS (SELECT 1 FROM dbo.fm_Answers a WHERE a.questionId = q.questionId));
      IF @changed IS NOT NULL
      BEGIN
        DECLARE @msg NVARCHAR(2048) = N'Câu "' + LEFT(@changed, 200) + N'" đã có người trả lời nên không đổi loại câu hỏi được. Hãy thêm câu hỏi mới.';
        THROW 50005, @msg, 1;
      END

      UPDATE q
      SET type = s.type, label = s.label, description = s.description, isRequired = s.isRequired,
          sortOrder = s.sortOrder, settings = s.settings, isActive = 1, updatedAt = SYSDATETIME()
      FROM dbo.fm_Questions q JOIN @q s ON s.questionKey = q.questionKey
      WHERE q.formId = @formId;

      INSERT INTO dbo.fm_Questions (formId, questionKey, type, label, description, isRequired, sortOrder, settings)
      SELECT @formId, s.questionKey, s.type, s.label, s.description, s.isRequired, s.sortOrder, s.settings
      FROM @q s
      WHERE NOT EXISTS (SELECT 1 FROM dbo.fm_Questions q WHERE q.formId = @formId AND q.questionKey = s.questionKey);

      -- Câu bị gỡ: còn câu trả lời → ẩn (giữ dữ liệu); chưa có → xoá
      UPDATE q SET isActive = 0, updatedAt = SYSDATETIME()
      FROM dbo.fm_Questions q
      WHERE q.formId = @formId AND q.isActive = 1
        AND NOT EXISTS (SELECT 1 FROM @q s WHERE s.questionKey = q.questionKey)
        AND EXISTS (SELECT 1 FROM dbo.fm_Answers a WHERE a.questionId = q.questionId);
      DELETE q FROM dbo.fm_Questions q
      WHERE q.formId = @formId
        AND NOT EXISTS (SELECT 1 FROM @q s WHERE s.questionKey = q.questionKey)
        AND NOT EXISTS (SELECT 1 FROM dbo.fm_Answers a WHERE a.questionId = q.questionId);
      COMMIT;

      SELECT @formId AS formId;`);
  return r.recordset[0].formId;
}

router.post('/admin/forms', moduleAdmin, async (req, res) => {
  try {
    const def = D.normalizeDefinition(req.body);
    const pool = await poolPromise;
    const formId = await saveForm(pool, null, def, req.user.userID);
    ok(res, await loadAdminForm(pool, formId));
  } catch (err) { handleError(res, err, 'POST /admin/forms'); }
});

router.put('/admin/forms/:id', moduleAdmin, async (req, res) => {
  try {
    const formId = parseId(req.params.id);
    if (!formId) return res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' });
    const def = D.normalizeDefinition(req.body);
    const pool = await poolPromise;
    await saveForm(pool, formId, def, req.user.userID);
    ok(res, await loadAdminForm(pool, formId));
  } catch (err) { handleError(res, err, 'PUT /admin/forms/:id'); }
});

// Bật/tắt nhanh: hiện cho user, nhận phiếu
router.patch('/admin/forms/:id/flags', moduleAdmin, async (req, res) => {
  try {
    const formId = parseId(req.params.id);
    if (!formId) return res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' });
    const b = req.body || {};
    const has = (k) => typeof b[k] === 'boolean';
    if (!has('isVisible') && !has('acceptResponses')) throw new D.ValidationError('Không có gì để cập nhật');
    const pool = await poolPromise;
    const r = await pool.request()
      .input('fid', sql.Int, formId)
      .input('actor', sql.Int, req.user.userID)
      .input('isVisible', sql.Bit, has('isVisible') ? b.isVisible : null)
      .input('accept', sql.Bit, has('acceptResponses') ? b.acceptResponses : null)
      .query(`
        UPDATE dbo.fm_Forms
        SET isVisible = ISNULL(@isVisible, isVisible), acceptResponses = ISNULL(@accept, acceptResponses),
            updatedBy = @actor, updatedAt = SYSDATETIME()
        WHERE formId = @fid AND isDeleted = 0;
        SELECT isVisible, acceptResponses, ${isOpenNowExpr('f')} AS isOpenNow FROM dbo.fm_Forms f WHERE formId = @fid AND isDeleted = 0;`);
    if (!r.recordset[0]) return res.status(404).json({ success: false, message: 'Không tìm thấy biểu mẫu' });
    ok(res, r.recordset[0]);
  } catch (err) { handleError(res, err, 'PATCH /admin/forms/:id/flags'); }
});

router.post('/admin/forms/:id/duplicate', moduleAdmin, async (req, res) => {
  try {
    const formId = parseId(req.params.id);
    if (!formId) return res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' });
    const pool = await poolPromise;
    const src = await loadAdminForm(pool, formId);
    if (!src) return res.status(404).json({ success: false, message: 'Không tìm thấy biểu mẫu' });
    const def = D.normalizeDefinition({
      ...src,
      title: `${src.title} (bản sao)`.slice(0, 300),
      isVisible: false,
      questions: src.questions.filter((q) => q.isActive),
    });
    const newId = await saveForm(pool, null, def, req.user.userID);
    ok(res, { formId: newId });
  } catch (err) { handleError(res, err, 'POST /admin/forms/:id/duplicate'); }
});

router.delete('/admin/forms/:id', moduleAdmin, async (req, res) => {
  try {
    const formId = parseId(req.params.id);
    if (!formId) return res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('fid', sql.Int, formId).input('actor', sql.Int, req.user.userID).query(`
      UPDATE dbo.fm_Forms SET isDeleted = 1, isVisible = 0, deletedBy = @actor, deletedAt = SYSDATETIME()
      WHERE formId = @fid AND isDeleted = 0`);
    if (!r.rowsAffected[0]) return res.status(404).json({ success: false, message: 'Không tìm thấy biểu mẫu' });
    ok(res, { formId });
  } catch (err) { handleError(res, err, 'DELETE /admin/forms/:id'); }
});

/* ================================ ADMIN — KẾT QUẢ ================================ */

async function requireAdminForm(pool, formId, res) {
  if (!formId) { res.status(400).json({ success: false, message: 'Mã biểu mẫu không hợp lệ' }); return null; }
  const r = await pool.request().input('fid', sql.Int, formId).query(`
    SELECT formId, title, description, audienceType, allowMultiple, ${dt('closeAt', 'closeAt')}
    FROM dbo.fm_Forms WHERE formId = @fid AND isDeleted = 0`);
  if (!r.recordset[0]) { res.status(404).json({ success: false, message: 'Không tìm thấy biểu mẫu' }); return null; }
  return r.recordset[0];
}

/** Gom thống kê theo từng câu hỏi (tính trong Node — 1 khảo sát vài trăm người là nhỏ) */
function aggregateQuestions(questions, answerRows) {
  const byQ = new Map();
  for (const a of answerRows) {
    if (!byQ.has(a.questionId)) byQ.set(a.questionId, []);
    byQ.get(a.questionId).push(a);
  }
  return questions.filter((q) => q.type !== 'section').map((q) => {
    const rows = byQ.get(q.questionId) || [];
    const s = q.settings || {};
    const base = { questionId: q.questionId, questionKey: q.questionKey, type: q.type, label: q.label, isActive: q.isActive, answered: rows.length };

    if (D.CHOICE_TYPES.includes(q.type) || q.type === 'yes_no') {
      const options = q.type === 'yes_no'
        ? [{ id: 'yes', label: s.yesLabel || 'Có' }, { id: 'no', label: s.noLabel || 'Không' }]
        : [...(s.options || [])];
      const counts = new Map(options.map((o) => [o.id, 0]));
      const others = [];
      for (const r of rows) {
        let json = null;
        try { json = r.valueJson ? JSON.parse(r.valueJson) : null; } catch { json = null; }
        const ids = q.type === 'multiple_choice' ? json?.ids || [] : [r.valueText];
        for (const id of ids) {
          if (!id) continue;
          if (!counts.has(id)) {
            counts.set(id, 0);
            options.push({ id, label: id === D.OTHER_ID ? 'Khác' : '(lựa chọn đã xoá)' });
          }
          counts.set(id, counts.get(id) + 1);
        }
        if (json?.other) others.push(json.other);
      }
      return {
        ...base,
        kind: 'choice',
        options: options.map((o) => ({ ...o, count: counts.get(o.id) || 0 })),
        otherTexts: others.slice(0, 100),
      };
    }

    if (D.NUMERIC_TYPES.includes(q.type)) {
      const nums = rows.map((r) => Number(r.valueNumber)).filter(Number.isFinite);
      const sum = nums.reduce((a, b) => a + b, 0);
      const out = {
        ...base,
        kind: 'number',
        unit: s.unit || null,
        sum,
        avg: nums.length ? sum / nums.length : null,
        min: nums.length ? Math.min(...nums) : null,
        max: nums.length ? Math.max(...nums) : null,
      };
      if (q.type === 'linear_scale' || q.type === 'rating') {
        const lo = q.type === 'rating' ? 1 : s.min ?? 1;
        const hi = s.max ?? 5;
        out.distribution = [];
        for (let v = lo; v <= hi; v++) out.distribution.push({ value: v, count: nums.filter((n) => n === v).length });
        if (s.minLabel) out.minLabel = s.minLabel;
        if (s.maxLabel) out.maxLabel = s.maxLabel;
      }
      return out;
    }

    // text / date: danh sách câu trả lời gần nhất
    return {
      ...base,
      kind: 'text',
      samples: rows
        .slice()
        .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
        .slice(0, 50)
        .map((r) => ({ value: r.valueDisplay, fullName: r.fullName, departmentName: r.departmentName })),
    };
  });
}

router.get('/admin/forms/:id/stats', moduleAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const formId = parseId(req.params.id);
    const form = await requireAdminForm(pool, formId, res);
    if (!form) return;
    const deptFilter = parseId(req.query.departmentId);

    const [questions, r] = await Promise.all([
      getQuestions(pool, formId, { activeOnly: false }),
      pool.request().input('fid', sql.Int, formId).input('dept', sql.Int, deptFilter).query(`
        WITH ${BASE_USERS_CTE},
        target AS (
          SELECT b.* FROM base b JOIN dbo.fm_Forms f ON f.formId = @fid WHERE ${audienceMatch('f', 'b')}
        ),
        done AS (SELECT DISTINCT userId FROM dbo.fm_Responses WHERE formId = @fid)
        SELECT t.departmentId, ISNULL(d.name, N'(Chưa có phòng ban)') AS departmentName,
               COUNT(*) AS target, SUM(CASE WHEN dn.userId IS NOT NULL THEN 1 ELSE 0 END) AS done
        FROM target t
        LEFT JOIN done dn ON dn.userId = t.userId
        LEFT JOIN dbo.org_Departments d ON d.departmentId = t.departmentId
        GROUP BY t.departmentId, d.name, d.sortOrder
        ORDER BY CASE WHEN t.departmentId IS NULL THEN 1 ELSE 0 END, d.sortOrder, d.name;

        SELECT COUNT(*) AS responseCount, COUNT(DISTINCT userId) AS respondentCount,
               ${dt('MAX(submittedAt)', 'lastSubmittedAt')}
        FROM dbo.fm_Responses WHERE formId = @fid AND (@dept IS NULL OR departmentId = @dept);

        SELECT CONVERT(varchar(10), submittedAt, 23) AS day, COUNT(*) AS count
        FROM dbo.fm_Responses WHERE formId = @fid AND (@dept IS NULL OR departmentId = @dept)
        GROUP BY CONVERT(varchar(10), submittedAt, 23) ORDER BY day;

        SELECT a.questionId, a.valueText, a.valueNumber, a.valueJson, a.valueDisplay,
               r.fullName, r.departmentName, ${dt('r.submittedAt', 'submittedAt')}
        FROM dbo.fm_Answers a
        JOIN dbo.fm_Responses r ON r.responseId = a.responseId
        WHERE r.formId = @fid AND (@dept IS NULL OR r.departmentId = @dept);`),
    ]);

    const byDepartment = r.recordsets[0];
    const totals = r.recordsets[1][0] || {};
    const targetCount = byDepartment.reduce((a, x) => a + x.target, 0);
    const targetDone = byDepartment.reduce((a, x) => a + x.done, 0);

    ok(res, {
      form,
      summary: {
        targetCount,
        targetDone,
        completionRate: targetCount ? targetDone / targetCount : null,
        responseCount: totals.responseCount || 0,
        respondentCount: totals.respondentCount || 0,
        lastSubmittedAt: totals.lastSubmittedAt || null,
      },
      byDepartment,
      timeline: r.recordsets[2],
      questions: aggregateQuestions(
        questions.filter((q) => q.isActive || r.recordsets[3].some((a) => a.questionId === q.questionId)),
        r.recordsets[3]
      ),
    });
  } catch (err) { handleError(res, err, 'GET /admin/forms/:id/stats'); }
});

// Danh sách phiếu (phân trang) — all=1 để xuất Excel
router.get('/admin/forms/:id/responses', moduleAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const formId = parseId(req.params.id);
    const form = await requireAdminForm(pool, formId, res);
    if (!form) return;

    const all = req.query.all === '1';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = all ? 5000 : Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const search = String(req.query.search || '').trim().slice(0, 100);

    const r = await pool.request()
      .input('fid', sql.Int, formId)
      .input('dept', sql.Int, parseId(req.query.departmentId))
      .input('search', sql.NVarChar(100), search)
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('fetch', sql.Int, pageSize)
      .query(`
        SELECT r.responseId, r.userId, r.fullName, r.msnv, r.departmentId, r.departmentName, r.jobTitleName,
               ${dt('r.submittedAt', 'submittedAt')}, ${dt('r.updatedAt', 'updatedAt')}, r.editCount,
               COUNT(*) OVER () AS total
        FROM dbo.fm_Responses r
        WHERE r.formId = @fid AND (@dept IS NULL OR r.departmentId = @dept)
          AND (@search = N''
               OR r.fullName COLLATE Latin1_General_CI_AI LIKE N'%' + @search + N'%' COLLATE Latin1_General_CI_AI
               OR r.msnv LIKE N'%' + @search + N'%')
        ORDER BY CASE WHEN r.departmentName IS NULL THEN 1 ELSE 0 END, r.departmentName, r.fullName, r.responseId
        OFFSET @offset ROWS FETCH NEXT @fetch ROWS ONLY;`);

    const rows = r.recordset;
    const ids = rows.map((x) => x.responseId);
    const answersByResponse = new Map();
    if (ids.length) {
      const a = await pool.request().input('ids', sql.NVarChar(sql.MAX), JSON.stringify(ids)).query(`
        SELECT a.responseId, a.questionId, a.valueDisplay, a.valueNumber
        FROM dbo.fm_Answers a
        WHERE a.responseId IN (SELECT CAST([value] AS BIGINT) FROM OPENJSON(@ids))`);
      for (const x of a.recordset) {
        if (!answersByResponse.has(x.responseId)) answersByResponse.set(x.responseId, {});
        answersByResponse.get(x.responseId)[x.questionId] = { display: x.valueDisplay, number: x.valueNumber === null ? null : Number(x.valueNumber) };
      }
    }

    const questions = await getQuestions(pool, formId, { activeOnly: false, withAnswerCount: true });
    ok(res, {
      form,
      questions: questions
        .filter((q) => q.type !== 'section' && (q.isActive || q.answerCount > 0))
        .map((q) => ({ questionId: q.questionId, type: q.type, label: q.label, isActive: q.isActive, unit: q.settings?.unit || null })),
      total: rows[0]?.total || 0,
      page,
      pageSize,
      rows: rows.map(({ total, ...x }) => ({ ...x, answers: answersByResponse.get(x.responseId) || {} })),
    });
  } catch (err) { handleError(res, err, 'GET /admin/forms/:id/responses'); }
});

// Người thuộc đối tượng nhưng chưa nộp
router.get('/admin/forms/:id/missing', moduleAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const formId = parseId(req.params.id);
    const form = await requireAdminForm(pool, formId, res);
    if (!form) return;
    const r = await pool.request().input('fid', sql.Int, formId).query(`
      WITH ${BASE_USERS_CTE}
      SELECT b.userId, b.fullName, b.msnv, d.name AS departmentName, j.name AS jobTitleName
      FROM base b
      JOIN dbo.fm_Forms f ON f.formId = @fid
      LEFT JOIN dbo.org_Departments d ON d.departmentId = b.departmentId
      LEFT JOIN dbo.org_JobTitles j ON j.jobTitleId = b.jobTitleId
      WHERE ${audienceMatch('f', 'b')}
        AND NOT EXISTS (SELECT 1 FROM dbo.fm_Responses r WHERE r.formId = @fid AND r.userId = b.userId)
      ORDER BY CASE WHEN d.name IS NULL THEN 1 ELSE 0 END, d.sortOrder, d.name, b.fullName`);
    ok(res, r.recordset);
  } catch (err) { handleError(res, err, 'GET /admin/forms/:id/missing'); }
});

router.delete('/admin/responses/:responseId', moduleAdmin, async (req, res) => {
  try {
    const rid = parseId(req.params.responseId);
    if (!rid) return res.status(400).json({ success: false, message: 'Mã phiếu không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('rid', sql.BigInt, rid)
      .query(`DELETE FROM dbo.fm_Responses WHERE responseId = @rid`); // fm_Answers xoá theo (ON DELETE CASCADE)
    if (!r.rowsAffected[0]) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu' });
    ok(res, { responseId: rid });
  } catch (err) { handleError(res, err, 'DELETE /admin/responses/:id'); }
});

/* ================================ ADMIN — PHÒNG BAN / CHỨC DANH ================================ */

const ORG = {
  departments: { table: 'org_Departments', id: 'departmentId', profileCol: 'departmentId', hasCode: true },
  'job-titles': { table: 'org_JobTitles', id: 'jobTitleId', profileCol: 'jobTitleId', hasCode: false },
};

function readOrgBody(body) {
  const name = String(body?.name || '').trim();
  if (!name) throw new D.ValidationError('Chưa nhập tên');
  if (name.length > 150) throw new D.ValidationError('Tên quá dài');
  const code = String(body?.code || '').trim().slice(0, 50) || null;
  const sortOrder = Number.isInteger(Number(body?.sortOrder)) ? Number(body.sortOrder) : 0;
  const isActive = body?.isActive === undefined ? true : !!body.isActive;
  return { name, code, sortOrder, isActive };
}

// Express 5 không hỗ trợ regex trong path (/:kind(a|b)) → đăng ký riêng từng loại
for (const [kind, o] of Object.entries(ORG)) {
router.get(`/admin/org/${kind}`, moduleAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT t.${o.id} AS id, t.name, ${o.hasCode ? 't.code' : 'NULL AS code'}, t.sortOrder, t.isActive,
             (SELECT COUNT(*) FROM dbo.org_UserProfiles p JOIN dbo.Users u ON u.userID = p.userId
              WHERE p.${o.profileCol} = t.${o.id} AND u.isDeleted = 0 AND ISNULL(u.isActive, 0) = 1) AS userCount
      FROM dbo.${o.table} t
      ORDER BY t.isActive DESC, t.sortOrder, t.name`);
    ok(res, r.recordset);
  } catch (err) { handleError(res, err, `GET /admin/org/${kind}`); }
});

router.post(`/admin/org/${kind}`, moduleAdmin, async (req, res) => {
  try {
    const b = readOrgBody(req.body);
    const pool = await poolPromise;
    const r = await pool.request()
      .input('name', sql.NVarChar(150), b.name).input('code', sql.NVarChar(50), b.code)
      .input('sortOrder', sql.Int, b.sortOrder).input('actor', sql.Int, req.user.userID)
      .query(`
        INSERT INTO dbo.${o.table} (name, ${o.hasCode ? 'code, ' : ''}sortOrder, createdBy)
        OUTPUT INSERTED.${o.id} AS id
        VALUES (@name, ${o.hasCode ? '@code, ' : ''}@sortOrder, @actor)`);
    ok(res, { id: r.recordset[0].id });
  } catch (err) { handleError(res, err, `POST /admin/org/${kind}`); }
});

router.put(`/admin/org/${kind}/:id`, moduleAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Mã không hợp lệ' });
    const b = readOrgBody(req.body);
    const pool = await poolPromise;
    const r = await pool.request()
      .input('id', sql.Int, id).input('name', sql.NVarChar(150), b.name).input('code', sql.NVarChar(50), b.code)
      .input('sortOrder', sql.Int, b.sortOrder).input('isActive', sql.Bit, b.isActive).input('actor', sql.Int, req.user.userID)
      .query(`
        UPDATE dbo.${o.table}
        SET name = @name, ${o.hasCode ? 'code = @code, ' : ''}sortOrder = @sortOrder, isActive = @isActive,
            updatedAt = SYSDATETIME(), updatedBy = @actor
        WHERE ${o.id} = @id`);
    if (!r.rowsAffected[0]) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    ok(res, { id });
  } catch (err) { handleError(res, err, `PUT /admin/org/${kind}/:id`); }
});
}

// Danh sách nhân viên kèm phòng ban/chức danh (lọc, tìm, phân trang)
router.get('/admin/org/users', moduleAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const search = String(req.query.search || '').trim().slice(0, 100);
    const pool = await poolPromise;
    const r = await pool.request()
      .input('search', sql.NVarChar(100), search)
      .input('dept', sql.Int, parseId(req.query.departmentId))
      .input('title', sql.Int, parseId(req.query.jobTitleId))
      .input('missing', sql.Bit, req.query.missing === '1')
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('fetch', sql.Int, pageSize)
      .query(`
        SELECT u.userID AS userId, u.username, u.fullName, u.msnv,
               p.departmentId, d.name AS departmentName, p.jobTitleId, j.name AS jobTitleName, p.source,
               COUNT(*) OVER () AS total
        FROM dbo.Users u
        LEFT JOIN dbo.org_UserProfiles p ON p.userId = u.userID
        LEFT JOIN dbo.org_Departments d ON d.departmentId = p.departmentId
        LEFT JOIN dbo.org_JobTitles j ON j.jobTitleId = p.jobTitleId
        WHERE u.isDeleted = 0 AND ISNULL(u.isActive, 0) = 1
          AND (@search = N''
               OR u.fullName COLLATE Latin1_General_CI_AI LIKE N'%' + @search + N'%' COLLATE Latin1_General_CI_AI
               OR u.msnv LIKE N'%' + @search + N'%'
               OR u.username LIKE N'%' + @search + N'%')
          AND (@dept IS NULL OR p.departmentId = @dept)
          AND (@title IS NULL OR p.jobTitleId = @title)
          AND (@missing = 0 OR p.departmentId IS NULL OR p.jobTitleId IS NULL)
        ORDER BY CASE WHEN d.name IS NULL THEN 0 ELSE 1 END, d.sortOrder, d.name, u.fullName
        OFFSET @offset ROWS FETCH NEXT @fetch ROWS ONLY`);
    ok(res, { total: r.recordset[0]?.total || 0, page, pageSize, rows: r.recordset.map(({ total, ...x }) => x) });
  } catch (err) { handleError(res, err, 'GET /admin/org/users'); }
});

// Gán hàng loạt: chỉ cập nhật trường được gửi lên (departmentId / jobTitleId; null = bỏ gán)
router.put('/admin/org/users/profile', moduleAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const userIds = [...new Set((Array.isArray(b.userIds) ? b.userIds : []).map(parseId).filter(Boolean))];
    if (!userIds.length) throw new D.ValidationError('Chưa chọn nhân viên');
    if (userIds.length > 1000) throw new D.ValidationError('Tối đa 1000 nhân viên mỗi lần');
    const setDept = Object.prototype.hasOwnProperty.call(b, 'departmentId');
    const setTitle = Object.prototype.hasOwnProperty.call(b, 'jobTitleId');
    if (!setDept && !setTitle) throw new D.ValidationError('Chưa chọn phòng ban hoặc chức danh để gán');
    // allowSelfEdit = true: cho nhân viên tự sửa lại (source = 'self')
    const source = b.allowSelfEdit ? 'self' : 'admin';

    const pool = await poolPromise;
    const r = await pool.request()
      .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(userIds))
      .input('setDept', sql.Bit, setDept).input('dept', sql.Int, setDept ? parseId(b.departmentId) : null)
      .input('setTitle', sql.Bit, setTitle).input('title', sql.Int, setTitle ? parseId(b.jobTitleId) : null)
      .input('source', sql.NVarChar(10), source).input('actor', sql.Int, req.user.userID)
      .query(`
        SET XACT_ABORT ON;
        IF @setDept = 1 AND @dept IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.org_Departments WHERE departmentId = @dept)
          THROW 50021, N'Phòng ban không hợp lệ', 1;
        IF @setTitle = 1 AND @title IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.org_JobTitles WHERE jobTitleId = @title)
          THROW 50022, N'Chức danh không hợp lệ', 1;
        MERGE dbo.org_UserProfiles AS t
        USING (
          SELECT DISTINCT u.userID AS userId
          FROM OPENJSON(@ids) j JOIN dbo.Users u ON u.userID = CAST(j.[value] AS INT)
        ) AS s ON t.userId = s.userId
        WHEN MATCHED THEN UPDATE SET
          departmentId = CASE WHEN @setDept = 1 THEN @dept ELSE t.departmentId END,
          jobTitleId   = CASE WHEN @setTitle = 1 THEN @title ELSE t.jobTitleId END,
          source = @source, updatedAt = SYSDATETIME(), updatedBy = @actor
        WHEN NOT MATCHED THEN INSERT (userId, departmentId, jobTitleId, source, updatedBy)
          VALUES (s.userId, CASE WHEN @setDept = 1 THEN @dept END, CASE WHEN @setTitle = 1 THEN @title END, @source, @actor);
        SELECT @@ROWCOUNT AS affected;`);
    ok(res, { affected: r.recordset[0]?.affected || 0 });
  } catch (err) { handleError(res, err, 'PUT /admin/org/users/profile'); }
});

module.exports = router;
