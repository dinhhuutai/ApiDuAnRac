const express = require('express');
const router = express.Router();
const multer = require("multer");
const { poolPromise, sql } = require('../db');
const { requireAuth } = require('../middleware/auth');

const { uploadToS3 } = require("../middleware/s3Upload");

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');


// lưu file vào RAM
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // tối đa 20MB / file
    files: 10,                  // tối đa 10 file / lần
  },
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

/* ========== LIST: /api/task-management/my (lọc + phân trang) ========== */
router.get('/my', requireAuth, async (req, res) => {
  try {
    const {
      status,
      priority,
      search,
      page = 1,
      pageSize = 20,
      startDateFilter, // lọc ngày bắt đầu
    } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('userID', sql.Int, req.user.userID)
      .input('status', sql.NVarChar(50), status || null)
      .input('priority', sql.NVarChar(20), priority || null)
      .input('search', sql.NVarChar(200), search || null)
      .input('startDateFilter', sql.Date, startDateFilter || null)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);

        SELECT 
          t.taskId,
          t.title,
          ws.code AS statusCode,
          t.priority,
          t.projectId,
          p.code AS projectCode,
          t.startDate,
          t.dueDate,
          t.startTime,
          t.dueTime,
          t.repeatDaily,
          t.progressPercent,
          t.completedDate,
          uCreator.fullName AS createdByName,
          Assignees.assigneeNames,

          -- 🔹 Thông tin file đính kèm
          ISNULL(Atts.attachmentCount, 0)              AS attachmentCount,
          ISNULL(Atts.attachmentHasImage, 0)           AS attachmentHasImage,
          ISNULL(Atts.attachmentHasPdf, 0)             AS attachmentHasPdf,
          ISNULL(Atts.attachmentHasDoc, 0)             AS attachmentHasDoc,
          ISNULL(Atts.attachmentHasSheet, 0)           AS attachmentHasSheet,
          ISNULL(Atts.attachmentHasOther, 0)           AS attachmentHasOther

        FROM dbo.cv_Tasks t
        JOIN dbo.cv_WorkflowStatuses ws 
          ON ws.statusId = t.statusId 
         AND ws.isDeleted = 0
        LEFT JOIN dbo.cv_Projects p 
          ON p.projectId = t.projectId
        LEFT JOIN dbo.Users uCreator
          ON uCreator.userID = t.createdBy

        OUTER APPLY (
          SELECT STRING_AGG(u.fullName, ', ') AS assigneeNames
          FROM dbo.cv_TaskAssignees a
          JOIN dbo.Users u ON u.userID = a.userID
          WHERE a.taskId = t.taskId
            AND a.isDeleted = 0
        ) Assignees

        OUTER APPLY (
          SELECT
            COUNT(*) AS attachmentCount,
            MAX(CASE WHEN a.mimeType LIKE 'image/%' THEN 1 ELSE 0 END) AS attachmentHasImage,
            MAX(CASE WHEN a.mimeType = 'application/pdf' THEN 1 ELSE 0 END) AS attachmentHasPdf,
            MAX(CASE WHEN a.mimeType IN (
                    'application/msword',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                ) THEN 1 ELSE 0 END) AS attachmentHasDoc,
            MAX(CASE WHEN a.mimeType IN (
                    'application/vnd.ms-excel',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                ) THEN 1 ELSE 0 END) AS attachmentHasSheet,
            MAX(CASE 
                  WHEN a.mimeType NOT LIKE 'image/%'
                   AND a.mimeType <> 'application/pdf'
                   AND a.mimeType NOT IN (
                        'application/msword',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        'application/vnd.ms-excel',
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                    )
                THEN 1 ELSE 0 END) AS attachmentHasOther
          FROM dbo.cv_Attachments a
          WHERE a.taskId = t.taskId
            AND a.isDeleted = 0
        ) Atts

        WHERE 
          t.isDeleted = 0
          AND EXISTS (
            SELECT 1 
            FROM dbo.cv_TaskAssignees a 
            WHERE a.taskId = t.taskId 
              AND a.userID = @userID 
              AND a.isDeleted = 0
          )
          -- ⭐ Logic hiển thị:
          -- Nếu KHÔNG chọn ngày lọc:
          --   1) Task có startDate = hôm nay
          --   2) Task startDate < hôm nay và chưa hoàn thành (statusCode <> 'done')
          -- Nếu CÓ chọn ngày lọc:
          --   → chỉ lấy task có startDate = ngày đó
          AND (
            (@startDateFilter IS NULL AND (
              CAST(t.startDate AS DATE) = @today
              OR (
                t.startDate < @today 
                AND ws.code <> 'done'
              )
            ))
            OR (
              @startDateFilter IS NOT NULL
              AND CAST(t.startDate AS DATE) = @startDateFilter
            )
          )
          -- Bộ lọc thêm nếu có
          AND (@status  IS NULL OR ws.code = @status)
          AND (@priority IS NULL OR t.priority = @priority)
          AND (@search  IS NULL OR t.title LIKE N'%' + @search + N'%')
        ORDER BY 
          CASE 
            WHEN ws.code = 'done' THEN 2 
            ELSE 1 
          END,
          CASE t.priority 
            WHEN 'urgent' THEN 1
            WHEN 'high'   THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low'    THEN 4
            ELSE 5
          END,
          ISNULL(t.dueDate, '9999-12-31'),
          t.taskId;
      `);

    const all = r.recordset || [];
    const p = +page || 1;
    const ps = +pageSize || 20;
    const slice = all.slice((p - 1) * ps, p * ps);

    res.json({ success: true, data: slice, totalRows: all.length });
  } catch (err) {
    console.error('tasks/my error:', err);
    res
      .status(500)
      .json({ success: false, message: 'Lỗi tải danh sách công việc của tôi' });
  }
});

// /api/task-management/my/calendar
router.get('/my/calendar', requireAuth, async (req, res) => {
  try {
    const { range = 'week', date } = req.query;
    if (!date) {
      return res
        .status(400)
        .json({ success: false, message: 'Thiếu tham số date' });
    }

    const pool = await poolPromise;
    const r = await pool.request()
      .input('userID', sql.Int, req.user.userID)
      .input('date', sql.Date, date)
      .input('range', sql.NVarChar(10), range)
      .query(`
        DECLARE @d DATE = @date;
        DECLARE @from DATE, @to DATE;

        IF @range = 'day' 
          SET @from = @d;
        ELSE 
          SET @from = DATEADD(
            DAY, 
            1 - DATEPART(WEEKDAY, @d) + CASE WHEN @@DATEFIRST = 7 THEN 1 ELSE 0 END, 
            CAST(@d AS DATE)
          );

        IF @range = 'day' 
          SET @to = @d;
        ELSE 
          SET @to = DATEADD(DAY, 6, @from);

        ;WITH TaskBase AS (
          SELECT
            -- 👇 workDate = NGÀY BẮT ĐẦU, nếu không có thì fallback về dueDate
            CAST(ISNULL(t.startDate, t.dueDate) AS DATE) AS workDate,
            t.taskId,
            t.title,
            ws.code AS statusCode,
            t.priority,
            t.projectId,
            p.code AS projectCode,
            t.startDate,
            t.dueDate,
            t.startTime,
            t.dueTime,
            t.repeatDaily,
            t.progressPercent,
            t.completedDate,

            uCreator.fullName AS createdByName,
            Assignees.assigneeNames,
            
            -- 🔹 Số lượng tệp đính kèm
            ISNULL(Atts.attachmentCount, 0) AS attachmentCount

          FROM dbo.cv_Tasks t
          JOIN dbo.cv_WorkflowStatuses ws 
            ON ws.statusId = t.statusId 
           AND ws.isDeleted = 0
          LEFT JOIN dbo.cv_Projects p 
            ON p.projectId = t.projectId

          -- người tạo
          LEFT JOIN dbo.Users uCreator
            ON uCreator.userID = t.createdBy

          -- người được giao (gom string)
          OUTER APPLY (
            SELECT STRING_AGG(u.fullName, ', ') AS assigneeNames
            FROM dbo.cv_TaskAssignees a
            JOIN dbo.Users u ON u.userID = a.userID
            WHERE a.taskId = t.taskId
              AND a.isDeleted = 0
          ) Assignees

          -- 🔹 Đếm attachments
          OUTER APPLY (
            SELECT COUNT(*) AS attachmentCount
            FROM dbo.cv_Attachments at
            WHERE at.taskId = t.taskId
              AND at.isDeleted = 0
          ) Atts

          WHERE t.isDeleted = 0
            AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a 
              WHERE a.taskId = t.taskId 
                AND a.userID = @userID 
                AND a.isDeleted = 0
            )
        )
        SELECT *
        FROM TaskBase
        WHERE workDate BETWEEN @from AND @to
        ORDER BY 
          workDate,
          CASE priority
            WHEN 'urgent' THEN 1
            WHEN 'high'   THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low'    THEN 4
            ELSE 5
          END,
          ISNULL(dueTime, '23:59:59'),
          taskId;
      `);

    res.json({ success: true, data: r.recordset });
  } catch (err) {
    console.error('tasks/calendar error:', err);
    res
      .status(500)
      .json({ success: false, message: 'Lỗi tải lịch công việc' });
  }
});

/* ========== BOARD: /api/task-management/my/board ========== */
router.get('/my/board', requireAuth, async (req, res) => {
  try {
    const { status, priority, search, startDateFilter } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('userID', sql.Int, req.user.userID)
      .input('status', sql.NVarChar(50), status || null)
      .input('priority', sql.NVarChar(20), priority || null)
      .input('search', sql.NVarChar(200), search || null)
      .input('startDateFilter', sql.Date, startDateFilter || null)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);

        SELECT 
          ws.statusId,
          ws.code        AS statusCode,
          ws.name        AS statusName,
          ws.orderIndex,

          t.taskId,
          t.title,
          t.description,
          t.priority,
          t.dueDate,
          t.startDate,
          t.startTime,
          t.dueTime,
          t.repeatDaily,
          t.progressPercent,
          t.completedDate,

          uCreator.fullName AS createdByName,
          Assignees.assigneeNames,

          -- 🔹 tổng số file đính kèm của task
          ISNULL(Atts.attachmentCount, 0) AS attachmentCount

        FROM dbo.cv_WorkflowStatuses ws
        LEFT JOIN dbo.cv_Tasks t
          ON t.statusId = ws.statusId
         AND t.isDeleted = 0
         AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a
              WHERE a.taskId = t.taskId
                AND a.userID = @userID
                AND a.isDeleted = 0
            )
         AND (
            (@startDateFilter IS NOT NULL 
              AND CAST(t.startDate AS DATE) = @startDateFilter)
            OR (
              @startDateFilter IS NULL
              AND (
                CAST(t.startDate AS DATE) = @today
                OR (t.startDate < @today AND ws.code <> 'done')
              )
            )
          )
         AND (@priority IS NULL OR t.priority = @priority)
         AND (@search   IS NULL OR t.title LIKE N'%' + @search + N'%')

        -- join người tạo
        LEFT JOIN dbo.Users uCreator
          ON uCreator.userID = t.createdBy

        -- gom người được giao
        OUTER APPLY (
          SELECT STRING_AGG(u.fullName, ', ') AS assigneeNames
          FROM dbo.cv_TaskAssignees a
          JOIN dbo.Users u ON u.userID = a.userID
          WHERE a.taskId = t.taskId
            AND a.isDeleted = 0
        ) Assignees

        -- gom file đính kèm
        OUTER APPLY (
          SELECT COUNT(*) AS attachmentCount
          FROM dbo.cv_Attachments a
          WHERE a.taskId = t.taskId
            AND a.isDeleted = 0
        ) Atts

        WHERE 
          ws.isDeleted = 0
          AND (@status IS NULL OR ws.code = @status)

        ORDER BY 
          ws.orderIndex,
          CASE t.priority
            WHEN 'urgent' THEN 1
            WHEN 'high'   THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low'    THEN 4
            ELSE 5
          END,
          ISNULL(t.dueDate, '9999-12-31'),
          t.taskId;
      `);

    const cols = new Map();

    for (const row of r.recordset || []) {
      if (!cols.has(row.statusId)) {
        cols.set(row.statusId, {
          statusId: row.statusId,
          statusCode: row.statusCode,
          statusName: row.statusName,
          items: [],
        });
      }
      if (row.taskId) {
        cols.get(row.statusId).items.push({
          taskId: row.taskId,
          title: row.title,
          description: row.description,
          statusId: row.statusId,
          statusCode: row.statusCode,
          statusName: row.statusName,
          priority: row.priority,
          startDate: row.startDate,
          dueDate: row.dueDate,
          startTime: row.startTime,
          dueTime: row.dueTime,
          repeatDaily: row.repeatDaily,
          progressPercent: row.progressPercent,
          completedDate: row.completedDate,
          createdByName: row.createdByName,
          assigneeNames: row.assigneeNames,
          attachmentCount: row.attachmentCount || 0, // 👈 thêm vào item
        });
      }
    }

    res.json({ success: true, data: Array.from(cols.values()) });
  } catch (err) {
    console.error('tasks/my/board error:', err);
    res
      .status(500)
      .json({ success: false, message: 'Lỗi tải board' });
  }
});

function normalizeTime(t) {
  if (!t || typeof t !== 'string') return null;
  const trimmed = t.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(':');
  if (parts.length < 2) return null;
  let [hh, mm] = parts;
  if (isNaN(+hh) || isNaN(+mm)) return null;

  hh = String(hh).padStart(2, '0');
  mm = String(mm).padStart(2, '0');
  return `${hh}:${mm}:00`; // "HH:mm:00"
}

/* ========== CREATE: /api/task-management (bỏ SP, dùng query thường) ========== */
// TẠO TASK + (tuỳ chọn) FILE ĐÍNH KÈM
router.post('/', requireAuth, upload.array('attachments', 10), async (req, res) => {
    try {
      const isMultipart = req.is('multipart/form-data');
      const body = req.body || {};

      // Lấy field từ body (support cả JSON & multipart)
      const projectId = body.projectId || null;
      const title = body.title;
      const description = body.description ?? null;
      const statusCode = body.statusCode || 'todo';
      const priority = body.priority || 'normal';
      const startDate = body.startDate || null;
      const dueDate = body.dueDate || null;
      const startTime = body.startTime || null;
      const dueTime = body.dueTime || null;
      const estimateHours = body.estimateHours || null;
      const progressPercent = body.progressPercent || 0;
      const repeatDaily =
        body.repeatDaily === '1' || body.repeatDaily === 'true' || body.repeatDaily === true;

      if (!title || typeof title !== 'string') {
        return res
          .status(400)
          .json({ success: false, message: 'Tiêu đề không hợp lệ' });
      }

      // Assignees
      let assignees = [];
      if (isMultipart) {
        // FE gửi JSON string
        if (typeof body.assignees === 'string') {
          try {
            const parsed = JSON.parse(body.assignees);
            if (Array.isArray(parsed)) assignees = parsed;
          } catch (e) {
            assignees = [];
          }
        }
      } else {
        // JSON thuần như cũ
        if (Array.isArray(body.assignees)) assignees = body.assignees;
      }

      let finalAssignees = assignees
        .filter((x) => Number.isFinite(+x))
        .map((x) => +x);

      if (!finalAssignees.length) {
        finalAssignees = [req.user.userID];
      }

      const startTimeSql = normalizeTime(startTime);
      const dueTimeSql = normalizeTime(dueTime);

      const pool = await poolPromise;
      const tx = new sql.Transaction(pool);
      await tx.begin();

      try {
        // 1) Lấy statusId từ code
        const reqStatus = new sql.Request(tx);
        const statusRes = await reqStatus
          .input('statusCode', sql.NVarChar(50), statusCode)
          .query(`
            SELECT TOP 1 statusId
            FROM dbo.cv_WorkflowStatuses
            WHERE isDeleted = 0
              AND code = @statusCode;
          `);

        if (!statusRes.recordset.length) {
          await tx.rollback();
          return res.status(400).json({
            success: false,
            message: `Không tìm thấy trạng thái với code = '${statusCode}'`,
          });
        }

        const statusId = statusRes.recordset[0].statusId;

        // 2) INSERT Task
        const reqTask = new sql.Request(tx);
        const taskRes = await reqTask
          .input('projectId', sql.Int, projectId || null)
          .input('title', sql.NVarChar(500), title.trim())
          .input('description', sql.NVarChar(sql.MAX), description || null)
          .input('statusId', sql.Int, statusId)
          .input('priority', sql.NVarChar(20), priority)
          .input('startDate', sql.Date, startDate || null)
          .input('dueDate', sql.Date, dueDate || null)
          .input('startTime', sql.VarChar(8), startTimeSql)
          .input('dueTime', sql.VarChar(8), dueTimeSql)
          .input('estimateHours', sql.Decimal(10, 2), estimateHours || null)
          .input('progressPercent', sql.Int, progressPercent || 0)
          .input('repeatDaily', sql.Bit, repeatDaily ? 1 : 0)
          .input('createdBy', sql.Int, req.user.userID)
          .query(`
            DECLARE @NewTasks TABLE (taskId INT);

            INSERT INTO dbo.cv_Tasks
              (projectId, title, description, statusId, priority,
               startDate, dueDate, startTime, dueTime,
               estimateHours, progressPercent, repeatDaily,
               isDeleted, createdBy, createdAt)
            OUTPUT INSERTED.taskId INTO @NewTasks(taskId)
            VALUES
              (@projectId, @title, @description, @statusId, @priority,
               @startDate, @dueDate, @startTime, @dueTime,
               @estimateHours, @progressPercent, @repeatDaily,
               0, @createdBy, GETDATE());

            SELECT taskId FROM @NewTasks;
          `);

        const taskId = taskRes.recordset[0].taskId;

        // 3) INSERT Assignees
        for (const uid of finalAssignees) {
          await new sql.Request(tx)
            .input('taskId', sql.Int, taskId)
            .input('userID', sql.Int, uid)
            .input('createdBy', sql.Int, req.user.userID)
            .query(`
              INSERT INTO dbo.cv_TaskAssignees
                (taskId, userID, isDeleted, createdBy, createdAt)
              VALUES
                (@taskId, @userID, 0, @createdBy, GETDATE());
            `);
        }

        // 4) Upload file lên S3 + ghi cv_Attachments
        const files = req.files || [];

        for (const file of files) {
          const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
          const key = `tasks/${taskId}/${Date.now()}-${safeName}`;

          const { key: s3Key } = await uploadToS3({
            buffer: file.buffer,
            key,
            contentType: file.mimetype,
          });

          await new sql.Request(tx)
            .input('taskId', sql.Int, taskId)
            .input('fileName', sql.NVarChar(255), file.originalname)
            .input('mimeType', sql.NVarChar(100), file.mimetype)
            .input('fileSize', sql.BigInt, file.size)
            .input('storagePath', sql.NVarChar(500), s3Key)
            .input('uploadedBy', sql.Int, req.user.userID)
            .query(`
              INSERT INTO dbo.cv_Attachments
                (taskId, fileName, mimeType, fileSize, storagePath,
                 uploadedBy, uploadedAt, isDeleted, createdBy, createdAt)
              VALUES
                (@taskId, @fileName, @mimeType, @fileSize, @storagePath,
                 @uploadedBy, GETDATE(), 0, @uploadedBy, GETDATE());
            `);
        }

        await tx.commit();
        return res.status(201).json({
          success: true,
          message: 'Tạo công việc thành công',
          data: { taskId, attachmentCount: (req.files || []).length },
        });
      } catch (e) {
        await tx.rollback();
        console.error('tasks create tx error:', e);
        return res
          .status(500)
          .json({ success: false, message: 'Lỗi tạo công việc (TX)' });
      }
    } catch (err) {
      console.error('tasks create error:', err);
      res
        .status(500)
        .json({ success: false, message: 'Lỗi tạo công việc' });
    }
  }
);

/* ========== MOVE: /api/task-management/:taskId/move (đổi trạng thái, bỏ SP) ========== */
router.post('/:taskId/move', requireAuth, async (req, res) => {
  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    const taskId = +req.params.taskId;
    const { toStatusId, note = null } = req.body;

    if (!Number.isFinite(taskId) || taskId <= 0 || !Number.isFinite(+toStatusId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Payload không hợp lệ' });
    }

    await tx.begin();

    // 1) Kiểm tra user có quyền với task này không (là assignee hoặc người tạo)
    const reqCheck = new sql.Request(tx);
    const checkRes = await reqCheck
      .input('taskId', sql.Int, taskId)
      .input('userID', sql.Int, req.user.userID)
      .query(`
        SELECT TOP 1 t.taskId
        FROM dbo.cv_Tasks t
        WHERE t.taskId = @taskId
          AND t.isDeleted = 0
          AND (
            t.createdBy = @userID
            OR EXISTS (
              SELECT 1 FROM dbo.cv_TaskAssignees a
              WHERE a.taskId = t.taskId
                AND a.userID = @userID
                AND a.isDeleted = 0
            )
          );
      `);

    if (!checkRes.recordset.length) {
      await tx.rollback();
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền đổi trạng thái task này.',
      });
    }

    // 2) Kiểm tra statusId mới có hợp lệ không
    const reqStatus = new sql.Request(tx);
    const statusRes = await reqStatus
      .input('statusId', sql.Int, +toStatusId)
      .query(`
        SELECT TOP 1 statusId
        FROM dbo.cv_WorkflowStatuses
        WHERE statusId = @statusId
          AND isDeleted = 0;
      `);

    if (!statusRes.recordset.length) {
      await tx.rollback();
      return res.status(400).json({
        success: false,
        message: 'Trạng thái mới không hợp lệ.',
      });
    }

    // 3) Cập nhật trạng thái
    const reqUpdate = new sql.Request(tx);
    await reqUpdate
      .input('taskId', sql.Int, taskId)
      .input('statusId', sql.Int, +toStatusId)
      .input('userID', sql.Int, req.user.userID)
      .input('note', sql.NVarChar(1000), note)
      .query(`
        UPDATE dbo.cv_Tasks
        SET statusId = @statusId,
            updatedBy = @userID,
            updatedAt = SYSDATETIME()
        WHERE taskId = @taskId;

        -- TODO: nếu sau này có bảng lịch sử trạng thái, insert thêm vào đây,
        -- sử dụng @note nếu cần.
      `);

    await tx.commit();

    res.json({ success: true, message: 'Đổi trạng thái thành công' });
  } catch (err) {
    console.error('task move error:', err);
    try {
      await tx.rollback();
    } catch {}
    res
      .status(500)
      .json({ success: false, message: 'Lỗi đổi trạng thái task' });
  }
});

/* ========== LOOKUP USERS: /api/task-management/lookup/users?q= ========== */
/* Dùng cho ô nhập @mention giống Zalo */
router.get('/lookup/users', requireAuth, async (req, res) => {
  try {
    const { q = '' } = req.query;
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('q', sql.NVarChar(200), q || '')
      .query(`
        SELECT
          u.userID,
          u.fullName,
          u.userName,
          d.departmentName
        FROM dbo.Users u
        LEFT JOIN dbo.Departments d ON d.departmentId = u.cv_DepartmentId
        JOIN dbo.UserModules um ON um.userId = u.userID
        JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE u.isActive = 1 AND m.moduleKey = 'qlcongviec'
          AND (
            @q = '' 
            OR u.fullName LIKE N'%' + @q + N'%'
            OR u.userName LIKE N'%' + @q + N'%'
          )
        ORDER BY u.fullName;
      `);

    // FE có thể map thành options cho react-select
    res.json({
      success: true,
      data: (r.recordset || []).map((x) => ({
        userID: x.userID,
        fullName: x.fullName,
        userName: x.userName,
        departmentName: x.departmentName,
      })),
    });
  } catch (err) {
    console.error('lookup users error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tải danh sách user' });
  }
});

/* ========== LOOKUP PROJECTS: /api/task-management/lookup/projects?q= ========== */
/* Dùng cho ô chọn dự án (searchable) */
router.get('/lookup/projects', requireAuth, async (req, res) => {
  try {
    const { q = '' } = req.query;
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('q', sql.NVarChar(200), q || '')
      .query(`
        SELECT TOP 30
          p.projectId,
          p.code,
          p.name,
          p.status
        FROM dbo.cv_Projects p
        WHERE p.isDeleted = 0
          AND (
            @q = ''
            OR p.code LIKE N'%' + @q + N'%'
            OR p.name LIKE N'%' + @q + N'%'
          )
        ORDER BY p.code, p.name;
      `);

    res.json({
      success: true,
      data: (r.recordset || []).map((x) => ({
        projectId: x.projectId,
        code: x.code,
        name: x.name,
        status: x.status,
      })),
    });
  } catch (err) {
    console.error('lookup projects error:', err);
    res
      .status(500)
      .json({ success: false, message: 'Lỗi tải danh sách dự án' });
  }
});

// ==== HELPER chuẩn hóa giờ "HH:mm" => "HH:mm:00" ====
function normalizeTimeToSql(t) {
  if (!t || typeof t !== 'string') return null;
  const trimmed = t.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length < 2) return null;
  let [hh, mm] = parts;
  if (isNaN(+hh) || isNaN(+mm)) return null;
  hh = String(hh).padStart(2, '0');
  mm = String(mm).padStart(2, '0');
  return `${hh}:${mm}:00`;
}

router.post('/:taskId/attachments', requireAuth, upload.array('files', 10), async (req, res) => {
    try {
      const taskId = +req.params.taskId;
      if (!Number.isFinite(taskId) || taskId <= 0) {
        return res.status(400).json({ success: false, message: 'taskId không hợp lệ' });
      }

      if (!req.files || !req.files.length) {
        return res.status(400).json({ success: false, message: 'Không có file nào được gửi lên' });
      }

      const pool = await poolPromise;

      // Kiểm tra quyền xem task (đã được giao)
      const rCheck = await pool.request()
        .input('taskId', sql.Int, taskId)
        .input('userID', sql.Int, req.user.userID)
        .query(`
          SELECT 1
          FROM dbo.cv_Tasks t
          WHERE t.taskId = @taskId
            AND t.isDeleted = 0
            AND EXISTS (
              SELECT 1 FROM dbo.cv_TaskAssignees a
              WHERE a.taskId = t.taskId
                AND a.userID = @userID
                AND a.isDeleted = 0
            );
        `);

      if (!rCheck.recordset.length) {
        return res.status(403).json({
          success: false,
          message: 'Bạn không có quyền thêm tệp cho công việc này',
        });
      }

      const uploadedBy = req.user.userID;
      const bucket = process.env.AWS_S3_BUCKET;

      const results = [];

      for (const file of req.files) {
        const key = `tasks/${taskId}/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}-${file.originalname}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          })
        );

        // Lưu DB
        const rIns = await pool.request()
          .input('taskId', sql.Int, taskId)
          .input('fileName', sql.NVarChar(500), file.originalname)
          .input('mimeType', sql.NVarChar(200), file.mimetype)
          .input('fileSize', sql.BigInt, file.size)
          .input('storagePath', sql.NVarChar(1000), key)
          .input('uploadedBy', sql.Int, uploadedBy)
          .query(`
            INSERT INTO dbo.cv_Attachments
              (taskId, fileName, mimeType, fileSize, storagePath,
               uploadedBy, uploadedAt, isDeleted, createdBy, createdAt)
            OUTPUT INSERTED.attachmentId, INSERTED.fileName, INSERTED.mimeType,
                   INSERTED.fileSize, INSERTED.storagePath, INSERTED.uploadedAt
            VALUES
              (@taskId, @fileName, @mimeType, @fileSize, @storagePath,
               @uploadedBy, GETDATE(), 0, @uploadedBy, GETDATE());
          `);

        results.push(rIns.recordset[0]);
      }

      return res.json({
        success: true,
        message: 'Tải tệp lên thành công',
        data: results,
      });
    } catch (err) {
      console.error('upload attachments error:', err);
      res.status(500).json({ success: false, message: 'Lỗi tải tệp lên' });
    }
  }
);

router.delete('/attachments/:attachmentId', requireAuth, async (req, res) => {
  try {
    const attachmentId = +req.params.attachmentId;
    if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
      return res.status(400).json({ success: false, message: 'attachmentId không hợp lệ' });
    }

    const pool = await poolPromise;

    // Kiểm tra attachment + quyền trên task
    const rCheck = await pool.request()
      .input('attachmentId', sql.Int, attachmentId)
      .input('userID', sql.Int, req.user.userID)
      .query(`
        SELECT a.attachmentId, a.taskId
        FROM dbo.cv_Attachments a
        JOIN dbo.cv_Tasks t ON t.taskId = a.taskId AND t.isDeleted = 0
        WHERE a.attachmentId = @attachmentId
          AND a.isDeleted = 0
          AND EXISTS (
            SELECT 1 FROM dbo.cv_TaskAssignees x
            WHERE x.taskId = a.taskId
              AND x.userID = @userID
              AND x.isDeleted = 0
          );
      `);

    if (!rCheck.recordset.length) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tệp hoặc bạn không có quyền xoá.',
      });
    }

    await pool.request()
      .input('attachmentId', sql.Int, attachmentId)
      .input('userID', sql.Int, req.user.userID)
      .query(`
        UPDATE dbo.cv_Attachments
        SET isDeleted = 1,
            deletedBy = @userID,
            deletedAt = GETDATE()
        WHERE attachmentId = @attachmentId
          AND isDeleted = 0;
      `);

    return res.json({ success: true, message: 'Đã xoá tệp (soft delete)' });
  } catch (err) {
    console.error('delete attachment error:', err);
    res.status(500).json({ success: false, message: 'Lỗi xoá tệp' });
  }
});

router.get("/attachments/:attachmentId/download", requireAuth, async (req, res) => {
  try {
    const attachmentId = +req.params.attachmentId;

    if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
      return res.status(400).json({ success: false, message: "attachmentId không hợp lệ" });
    }

    const pool = await poolPromise;
    const rAtt = await pool.request()
      .input("attachmentId", sql.Int, attachmentId)
      .input("userID", sql.Int, req.user.userID)
      .query(`
        SELECT TOP 1
          a.attachmentId,
          a.fileName,
          a.mimeType,
          a.storagePath
        FROM dbo.cv_Attachments a
        JOIN dbo.cv_Tasks t ON t.taskId = a.taskId AND t.isDeleted = 0
        WHERE a.attachmentId = @attachmentId
          AND a.isDeleted = 0
          AND EXISTS (
            SELECT 1 FROM dbo.cv_TaskAssignees x
            WHERE x.taskId = a.taskId
              AND x.userID = @userID
              AND x.isDeleted = 0
          );
      `);

    if (!rAtt.recordset.length) {
      return res.status(404).json({ success: false, message: "Không tìm thấy tệp hoặc không có quyền" });
    }

    const att = rAtt.recordset[0];

    const command = new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: att.storagePath,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    return res.json({
      success: true,
      url: signedUrl,
      fileName: att.fileName,
      mimeType: att.mimeType,
    });
  } catch (err) {
    console.error("download attachment error:", err);
    res.status(500).json({ success: false, message: "Lỗi tải tệp" });
  }
});

/* ========== GET DETAIL: /api/task-management/:taskId ========== */
router.get('/:taskId', requireAuth, async (req, res) => {
  try {
    const taskId = +req.params.taskId;
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return res.status(400).json({ success: false, message: 'taskId không hợp lệ' });
    }

    const pool = await poolPromise;

    const rTask = await pool.request()
      .input('taskId', sql.Int, taskId)
      .input('userID', sql.Int, req.user.userID)
      .query(`
        SELECT TOP 1
          t.taskId,
          t.title,
          t.description,
          t.statusId,
          ws.code      AS statusCode,
          ws.name      AS statusName,
          t.priority,
          t.projectId,
          p.code       AS projectCode,
          p.name       AS projectName,
          t.startDate,
          t.dueDate,
          t.startTime,
          t.dueTime,
          t.repeatDaily,
          t.estimateHours,
          t.progressPercent,
          t.completedDate,

          t.createdBy,
          uCreator.fullName AS createdByName,
          uCreator.userName AS createdByUserName,
          t.createdAt,

          t.updatedBy,
          uUpdater.fullName AS updatedByName,
          uUpdater.userName AS updatedByUserName,
          t.updatedAt
        FROM dbo.cv_Tasks t
        JOIN dbo.cv_WorkflowStatuses ws
          ON ws.statusId = t.statusId AND ws.isDeleted = 0
        LEFT JOIN dbo.cv_Projects p
          ON p.projectId = t.projectId
        LEFT JOIN dbo.Users uCreator
          ON uCreator.userID = t.createdBy
        LEFT JOIN dbo.Users uUpdater
          ON uUpdater.userID = t.updatedBy
        WHERE t.isDeleted = 0
          AND t.taskId = @taskId
          AND EXISTS (
            SELECT 1 FROM dbo.cv_TaskAssignees a
            WHERE a.taskId = t.taskId 
              AND a.userID = @userID
              AND a.isDeleted = 0
          );
      `);

    if (!rTask.recordset.length) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy công việc hoặc bạn không có quyền xem.',
      });
    }

    const task = rTask.recordset[0];

    // Lấy assignees
    const rAss = await pool.request()
      .input('taskId', sql.Int, taskId)
      .query(`
        SELECT 
          a.userID,
          u.fullName,
          u.userName
        FROM dbo.cv_TaskAssignees a
        LEFT JOIN dbo.Users u ON u.userID = a.userID
        WHERE a.taskId = @taskId
          AND a.isDeleted = 0;
      `);

    // 🔹 Lấy danh sách tệp đính kèm
    const rAtt = await pool.request()
      .input('taskId', sql.Int, taskId)
      .query(`
        SELECT 
          attachmentId,
          taskId,
          fileName,
          mimeType,
          fileSize,
          storagePath,
          uploadedBy,
          uploadedAt
        FROM dbo.cv_Attachments
        WHERE taskId = @taskId
          AND isDeleted = 0
        ORDER BY uploadedAt DESC, attachmentId DESC;
      `);

    return res.json({
      success: true,
      data: {
        ...task,
        assignees: rAss.recordset || [],
        attachments: rAtt.recordset || [],
      },
    });
  } catch (err) {
    console.error('task detail error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tải chi tiết công việc' });
  }
});

/* ========== UPDATE BASIC: /api/task-management/:taskId (PATCH) ========== */
router.patch('/:taskId', requireAuth, async (req, res) => {
  try {
    const taskId = +req.params.taskId;
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'taskId không hợp lệ' });
    }

    const {
      description = null,
      statusCode,
      repeatDaily = false,
      progressPercent = 0,
    } = req.body || {};

    if (!statusCode) {
      return res
        .status(400)
        .json({ success: false, message: 'Thiếu statusCode' });
    }

    const safeProgress = Number.isFinite(+progressPercent)
      ? Math.min(100, Math.max(0, Math.round(+progressPercent)))
      : 0;

    const pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      // 1. Lấy statusId từ code
      const rStatus = await new sql.Request(tx)
        .input('statusCode', sql.NVarChar(50), statusCode)
        .query(`
          SELECT TOP 1 statusId
          FROM dbo.cv_WorkflowStatuses
          WHERE isDeleted = 0 AND code = @statusCode;
        `);

      if (!rStatus.recordset.length) {
        await tx.rollback();
        return res.status(400).json({
          success: false,
          message: `Không tìm thấy trạng thái với code = '${statusCode}'`,
        });
      }
      const statusId = rStatus.recordset[0].statusId;

      // 2. Chỉ update mô tả, trạng thái, lặp ngày, tiến độ
      await new sql.Request(tx)
        .input('taskId', sql.Int, taskId)
        .input('description', sql.NVarChar(sql.MAX), description)
        .input('statusId', sql.Int, statusId)
        .input('repeatDaily', sql.Bit, repeatDaily ? 1 : 0)
        .input('progressPercent', sql.Int, safeProgress)
        .input('updatedBy', sql.Int, req.user.userID)
        .query(`
          UPDATE dbo.cv_Tasks
          SET
            description     = @description,
            statusId        = @statusId,
            repeatDaily     = @repeatDaily,
            progressPercent = @progressPercent,
            updatedBy       = @updatedBy,
            updatedAt       = GETDATE()
          WHERE taskId = @taskId
            AND isDeleted = 0;
        `);

      await tx.commit();
      return res.json({
        success: true,
        message: 'Cập nhật công việc thành công',
      });
    } catch (e) {
      await tx.rollback();
      console.error('task update tx error:', e);
      return res
        .status(500)
        .json({ success: false, message: 'Lỗi cập nhật công việc (TX)' });
    }
  } catch (err) {
    console.error('task update error:', err);
    res
      .status(500)
      .json({ success: false, message: 'Lỗi cập nhật công việc' });
  }
});

/* ========== SOFT DELETE: /api/task-management/:taskId (DELETE) ========== */
router.delete('/:taskId', requireAuth, async (req, res) => {
  try {
    const taskId = +req.params.taskId;
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return res.status(400).json({ success: false, message: 'taskId không hợp lệ' });
    }

    const pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      // 1) soft delete task
      await new sql.Request(tx)
        .input('taskId', sql.Int, taskId)
        .input('userID', sql.Int, req.user.userID)
        .query(`
          UPDATE dbo.cv_Tasks
          SET isDeleted = 1,
              deletedBy = @userID,
              deletedAt = GETDATE()
          WHERE taskId = @taskId AND isDeleted = 0;
        `);

      // 2) soft delete assignees
      await new sql.Request(tx)
        .input('taskId', sql.Int, taskId)
        .input('userID', sql.Int, req.user.userID)
        .query(`
          UPDATE dbo.cv_TaskAssignees
          SET isDeleted = 1,
              updatedBy  = @userID,
              updatedAt  = GETDATE()
          WHERE taskId = @taskId AND isDeleted = 0;
        `);

      await tx.commit();
      return res.json({ success: true, message: 'Đã xoá công việc (soft delete)' });
    } catch (e) {
      await tx.rollback();
      console.error('task delete tx error:', e);
      return res.status(500).json({ success: false, message: 'Lỗi xoá công việc (TX)' });
    }
  } catch (err) {
    console.error('task delete error:', err);
    res.status(500).json({ success: false, message: 'Lỗi xoá công việc' });
  }
});


module.exports = router;
