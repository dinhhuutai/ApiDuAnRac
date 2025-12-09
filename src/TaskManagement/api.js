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

//-------------------------------- Task Project -----------------
// POST /api/task-management/tasks
router.post('/tasks', requireAuth, async (req, res) => {
  const {
    projectId,        // optional
    title,
    description,
    statusCode,       // optional, default 'todo'
    priority,         // 'low'|'normal'|'high'|'urgent'|null
    startDate,        // 'yyyy-MM-dd' or null
    dueDate,          // 'yyyy-MM-dd' or null
    startTime,        // 'HH:mm' or null
    dueTime,          // 'HH:mm' or null
    repeatDaily,      // bool
    estimateHours,    // number
    assigneeIds,      // [int]
  } = req.body;

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ success: false, message: 'Tiêu đề công việc bắt buộc' });
  }

  try {
    const pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    const request = new sql.Request(tx);

    // Lấy statusId cho code (mặc định 'todo')
    const rStatus = await request
      .input('statusCode', sql.NVarChar(50), statusCode || 'todo')
      .query(`
        SELECT TOP 1 statusId
        FROM dbo.cv_WorkflowStatuses
        WHERE isDeleted = 0
          AND code = @statusCode
        ORDER BY orderIndex;
      `);

    if (!rStatus.recordset.length) {
      await tx.rollback();
      return res.status(400).json({
        success: false,
        message: 'Không tìm thấy trạng thái mặc định cho công việc (vd: todo)',
      });
    }

    const statusId = rStatus.recordset[0].statusId;

    // Insert task
    const rTask = await request
      .input('projectId', sql.Int, projectId || null)
      .input('title', sql.NVarChar(500), title)
      .input('description', sql.NVarChar(sql.MAX), description || null)
      .input('statusId', sql.Int, statusId)
      .input('priority', sql.NVarChar(20), priority || null)
      .input('startDate', sql.Date, startDate || null)
      .input('dueDate', sql.Date, dueDate || null)
      .input('estimateHours', sql.Decimal(10, 2), estimateHours ?? null)
      .input('createdBy', sql.Int, req.user.userID)
      .input('startTime', sql.Time, startTime || null)
      .input('dueTime', sql.Time, dueTime || null)
      .input('repeatDaily', sql.Bit, repeatDaily ? 1 : 0)
      .query(`
        INSERT INTO dbo.cv_Tasks
        (
          projectId, title, description, statusId, priority,
          startDate, dueDate, estimateHours,
          progressPercent,
          createdBy,
          startTime, dueTime, repeatDaily
        )
        OUTPUT INSERTED.taskId
        VALUES
        (
          @projectId, @title, @description, @statusId, @priority,
          @startDate, @dueDate, @estimateHours,
          0,
          @createdBy,
          @startTime, @dueTime, @repeatDaily
        );
      `);

    const newTaskId = rTask.recordset[0].taskId;

    // Insert assignees
    const assignees = Array.isArray(assigneeIds)
      ? [...new Set(assigneeIds.map((x) => +x).filter((x) => Number.isFinite(x)))]
      : [];

    if (assignees.length > 0) {
      const reqAss = new sql.Request(tx);
      reqAss.input('taskId', sql.Int, newTaskId);
      reqAss.input('createdBy', sql.Int, req.user.userID);

      let values = '';
      assignees.forEach((uid, idx) => {
        values += (idx ? ', ' : '') + `(@taskId, ${uid}, SYSUTCDATETIME(), 0, @createdBy, SYSUTCDATETIME(), NULL, NULL, NULL, NULL)`;
      });

      await reqAss.query(`
        INSERT INTO dbo.cv_TaskAssignees
        (
          taskId,
          userId,
          assignedAt,
          isDeleted,
          createdBy,
          createdAt,
          updatedBy,
          updatedAt,
          deletedBy,
          deletedAt
        )
        VALUES ${values};
      `);
    }

    // Ghi lịch sử trạng thái lần đầu
    const reqHist = new sql.Request(tx);
    await reqHist
      .input('taskId', sql.Int, newTaskId)
      .input('toStatusId', sql.Int, statusId)
      .input('changedBy', sql.Int, req.user.userID)
      .query(`
        INSERT INTO dbo.cv_TaskStatusHistory
        (
          taskId,
          fromStatusId,
          toStatusId,
          changedBy,
          changedAt,
          note,
          isDeleted,
          createdBy,
          createdAt,
          changeType
        )
        VALUES
        (
          @taskId,
          NULL,
          @toStatusId,
          @changedBy,
          SYSUTCDATETIME(),
          N'Khởi tạo công việc',
          0,
          @changedBy,
          SYSUTCDATETIME(),
          N'create'
        );
      `);

    await tx.commit();

    res.json({
      success: true,
      data: {
        taskId: newTaskId,
      },
    });
  } catch (err) {
    console.error('create task error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tạo công việc' });
  }
});

//--------------------------------------------

router.get("/me/role", requireAuth, async (req, res) => {
  const userId = req.user.userID;

  try {
    const pool = await sql.connect();

    const result = await pool.request()
      .input("userId", sql.Int, userId)
      .query(`
        SELECT TOP (1)
          ur.userRoleId,
          ur.userId,
          ur.roleId,

          r.code       AS roleCode,
          r.name       AS roleName,
          r.isDeleted  AS roleIsDeleted,

          -- 👇 Thông tin phòng ban của user
          u.cv_DepartmentId,
          d.code       AS departmentCode,
          d.name       AS departmentName,
          d.isDeleted  AS departmentIsDeleted,

          -- 👇 Thông tin tổ/nhóm của user
          u.cv_TeamId,
          t.code       AS teamCode,
          t.name       AS teamName,
          t.isDeleted  AS teamIsDeleted

        FROM cv_UserRoles ur
        INNER JOIN cv_Roles r
          ON r.roleId = ur.roleId
        INNER JOIN dbo.Users u
          ON u.userID = ur.userId
        LEFT JOIN cv_Departments d
          ON d.departmentId = u.cv_DepartmentId
        LEFT JOIN cv_Teams t
          ON t.teamId = u.cv_TeamId
        WHERE
          ur.userId = @userId
          AND ISNULL(ur.isDeleted, 0) = 0
          AND ISNULL(r.isDeleted, 0) = 0
        ORDER BY ur.createdAt DESC
      `);

    if (result.recordset.length === 0) {
      // Không có role => cho null
      return res.json({
        success: true,
        data: null,
      });
    }

    const row = result.recordset[0];

    return res.json({
      success: true,
      data: {
        userRoleId: row.userRoleId,
        roleId: row.roleId,
        code: row.roleCode,
        name: row.roleName,

        // 👇 Gói phòng ban (nếu có)
        cv_department: row.cv_DepartmentId
          ? {
              departmentId: row.cv_DepartmentId,
              code: row.departmentCode,
              name: row.departmentName,
            }
          : null,

        // 👇 Gói tổ/nhóm (nếu có)
        cv_team: row.cv_TeamId
          ? {
              teamId: row.cv_TeamId,
              code: row.teamCode,
              name: row.teamName,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("get task-management role error", err);
    return res
      .status(500)
      .json({ success: false, message: "Lỗi server khi lấy vai trò công việc" });
  }
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
      startDateFilter,
      createdForOthers,
    } = req.query;

    const createdForOthersFlag =
      createdForOthers === "1" || createdForOthers === "true";

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('userID', sql.Int, req.user.userID)
      .input('status', sql.NVarChar(50), status || null)
      .input('priority', sql.NVarChar(20), priority || null)
      .input('search', sql.NVarChar(200), search || null)
      .input('startDateFilter', sql.Date, startDateFilter || null)
      .input('createdForOthers', sql.Bit, createdForOthersFlag ? 1 : 0)
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
          JOIN dbo.Users u ON u.userID = a.userId
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
          AND (
            -- 👇 chế độ bình thường: task mà user là assignee
            (@createdForOthers = 0 AND EXISTS (
              SELECT 1
              FROM dbo.cv_TaskAssignees a
              WHERE a.taskId = t.taskId
                AND a.userID = @userID
                AND a.isDeleted = 0
            ))
            OR
            -- 👇 chế độ "công việc tôi tạo cho user khác"
            (@createdForOthers = 1 
              AND t.createdBy = @userID
              AND NOT EXISTS (      -- ⬅️ THÊM KHÚC NÀY
                SELECT 1 
                FROM dbo.cv_TaskAssignees a
                WHERE a.taskId = t.taskId
                  AND a.userID = @userID
                  AND a.isDeleted = 0
              )
            )
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
// router.get('/lookup/users', requireAuth, async (req, res) => {
//   try {
//     const { q = '' } = req.query;
//     const pool = await poolPromise;
//     const r = await pool
//       .request()
//       .input('q', sql.NVarChar(200), q || '')
//       .query(`
//         SELECT
//           u.userID,
//           u.fullName,
//           u.userName,
//           d.name
//         FROM dbo.Users u
//         LEFT JOIN dbo.cv_Departments d ON d.departmentId = u.cv_DepartmentId
//         JOIN dbo.UserModules um ON um.userId = u.userID
//         JOIN dbo.Modules m ON m.moduleId = um.moduleId
//         WHERE u.isActive = 1 AND m.moduleKey = 'qlcongviec'
//           AND (
//             @q = '' 
//             OR u.fullName LIKE N'%' + @q + N'%'
//             OR u.userName LIKE N'%' + @q + N'%'
//           )
//         ORDER BY u.fullName;
//       `);

//     // FE có thể map thành options cho react-select
//     res.json({
//       success: true,
//       data: (r.recordset || []).map((x) => ({
//         userID: x.userID,
//         fullName: x.fullName,
//         userName: x.userName,
//         departmentName: x.name,
//       })),
//     });
//   } catch (err) {
//     console.error('lookup users error:', err);
//     res.status(500).json({ success: false, message: 'Lỗi tải danh sách user' });
//   }
// });

router.get('/lookup/users', requireAuth, async (req, res) => {
  try {
    const { q = '' } = req.query;
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('q', sql.NVarChar(200), q || '')
      .input('userID', sql.Int, req.user.userID)
      .query(`
        DECLARE @qLocal NVARCHAR(200) = @q;
        DECLARE @userIdLocal INT      = @userID;
        DECLARE @deptId INT, @teamId INT;

        DECLARE @isCompanyManager BIT = 0; -- bangiamdoc, giamdocnhamay
        DECLARE @isDeptManager   BIT = 0; -- truongphong, phophong
        DECLARE @isTeamLead      BIT = 0; -- totruong

        -- Lấy phòng / tổ của user hiện tại
        SELECT 
          @deptId = cv_DepartmentId,
          @teamId = cv_TeamId
        FROM dbo.Users
        WHERE userID = @userIdLocal;

        -- Check role quản lý cấp công ty
        IF EXISTS (
          SELECT 1
          FROM dbo.cv_UserRoles ur
          JOIN dbo.cv_Roles r
            ON r.roleId = ur.roleId
           AND ISNULL(r.isDeleted, 0) = 0
          WHERE ur.userId = @userIdLocal
            AND ISNULL(ur.isDeleted, 0) = 0
            AND r.code IN ('bangiamdoc', 'giamdocnhamay')
        )
        BEGIN
          SET @isCompanyManager = 1;
        END

        -- Check role trưởng/phó phòng
        IF EXISTS (
          SELECT 1
          FROM dbo.cv_UserRoles ur
          JOIN dbo.cv_Roles r
            ON r.roleId = ur.roleId
           AND ISNULL(r.isDeleted, 0) = 0
          WHERE ur.userId = @userIdLocal
            AND ISNULL(ur.isDeleted, 0) = 0
            AND r.code IN ('truongphong', 'phophong')
        )
        BEGIN
          SET @isDeptManager = 1;
        END

        -- Check role tổ trưởng
        IF EXISTS (
          SELECT 1
          FROM dbo.cv_UserRoles ur
          JOIN dbo.cv_Roles r
            ON r.roleId = ur.roleId
           AND ISNULL(r.isDeleted, 0) = 0
          WHERE ur.userId = @userIdLocal
            AND ISNULL(ur.isDeleted, 0) = 0
            AND r.code = 'totruong'
        )
        BEGIN
          SET @isTeamLead = 1;
        END

        SELECT
          u.userID,
          u.fullName,
          u.userName,
          d.name AS departmentName,
          t.name AS teamName,
          u.cv_DepartmentId,
          u.cv_TeamId
        FROM dbo.Users u
        LEFT JOIN dbo.cv_Departments d ON d.departmentId = u.cv_DepartmentId
        LEFT JOIN dbo.cv_Teams       t ON t.teamId      = u.cv_TeamId
        JOIN dbo.UserModules um ON um.userId  = u.userID
        JOIN dbo.Modules     m  ON m.moduleId = um.moduleId
        WHERE 
          ISNULL(u.isDeleted, 0) = 0
          AND m.moduleKey = 'qlcongviec'
          -- loại trừ chính mình
          AND u.userID <> @userIdLocal
          -- search
          AND (
            @qLocal = '' 
            OR u.fullName LIKE N'%' + @qLocal + N'%'
            OR u.userName LIKE N'%' + @qLocal + N'%'
          )
          -- phạm vi xem user
          AND (
            -- 1) Ban giám đốc / giám đốc nhà máy: toàn công ty
            @isCompanyManager = 1

            -- 2) Trưởng/phó phòng: chỉ cùng phòng
            OR (
              @isCompanyManager = 0
              AND @isDeptManager = 1
              AND @deptId IS NOT NULL
              AND u.cv_DepartmentId = @deptId
            )

            -- 3) Tổ trưởng: chỉ cùng team
            OR (
              @isCompanyManager = 0
              AND @isDeptManager = 0
              AND @isTeamLead = 1
              AND @teamId IS NOT NULL
              AND u.cv_TeamId = @teamId
            )

            -- 4) Nhân viên thường: cũng chỉ cùng team
            OR (
              @isCompanyManager = 0
              AND @isDeptManager = 0
              AND @isTeamLead = 0
              AND @teamId IS NOT NULL
              AND u.cv_TeamId = @teamId
            )
          )
        ORDER BY d.name, t.name, u.fullName;
      `);

    res.json({
      success: true,
      data: (r.recordset || []).map((x) => ({
        userID: x.userID,
        fullName: x.fullName,
        userName: x.userName,
        departmentName: x.departmentName,
        teamName: x.teamName,
        cv_DepartmentId: x.cv_DepartmentId,
        cv_TeamId: x.cv_TeamId,
      })),
    });
  } catch (err) {
    console.error('lookup users error:', err);
    res.status(500).json({
      success: false,
      message: 'Lỗi tải danh sách user',
    });
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

// helper: convert latin1 -> utf8 để giữ tiếng Việt
function toUtf8FileName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
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
            AND (
              -- user là NGƯỜI ĐƯỢC GIAO
              EXISTS (
                SELECT 1 
                FROM dbo.cv_TaskAssignees a
                WHERE a.taskId = t.taskId 
                  AND a.userID = @userID
                  AND a.isDeleted = 0
              )
              -- HOẶC user là NGƯỜI TẠO
              OR t.createdBy = @userID
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
        const originalName = toUtf8FileName(file.originalname);

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
          .input('fileName', sql.NVarChar(500), originalName)
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

        
        const row = rIns.recordset[0];
        // đảm bảo FE nhận đúng tên UTF-8
        row.fileName = originalName;
        results.push(row);
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
              AND x.userId = @userID OR x.createdBy = @userID
              AND a.createdBy = @userID
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
        JOIN dbo.cv_Tasks t 
          ON t.taskId = a.taskId 
         AND t.isDeleted = 0
        -- 👇 join thêm: người tạo task + user đang đăng nhập
        LEFT JOIN dbo.Users uCreator
          ON uCreator.userID = t.createdBy
        LEFT JOIN dbo.Users uReq
          ON uReq.userID = @userID
        WHERE 
          a.attachmentId = @attachmentId
          AND a.isDeleted = 0
          AND (
            -- 1) user là người được giao
            EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees x
              WHERE x.taskId = a.taskId
                AND x.userID = @userID
                AND x.isDeleted = 0
            )
            -- 2) HOẶC user là người tạo task
            OR t.createdBy = @userID
            -- 3) HOẶC user là QUẢN LÝ cùng phòng với người tạo
            OR (
              uCreator.cv_DepartmentId IS NOT NULL
              AND uReq.cv_DepartmentId = uCreator.cv_DepartmentId
              AND EXISTS (
                SELECT 1
                FROM dbo.cv_UserRoles ur
                JOIN dbo.cv_Roles r 
                  ON r.roleId = ur.roleId
                 AND ISNULL(r.isDeleted, 0) = 0
                WHERE ur.userId = @userID
                  AND ISNULL(ur.isDeleted, 0) = 0
                  AND r.code IN (
                    'truongphong',
                    'phophong',
                    'totruong',
                    'bangiamdoc',
                    'giamdocnhamay'
                  )
              )
            )
              
            OR EXISTS (
              SELECT 1
              FROM dbo.cv_UserRoles ur
              JOIN dbo.cv_Roles r 
                ON r.roleId = ur.roleId
               AND ISNULL(r.isDeleted, 0) = 0
              WHERE ur.userId = @userID
                AND ISNULL(ur.isDeleted, 0) = 0
                AND r.code IN ('bangiamdoc', 'giamdocnhamay')
            )
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

// helper: build comment tree 2 cấp
function buildCommentTree(rows) {
  const byId = new Map();
  const roots = [];

  rows.forEach((r) => {
    byId.set(r.commentId, { ...r, replies: [] });
  });

  rows.forEach((r) => {
    const node = byId.get(r.commentId);
    if (!r.parentCommentId) {
      roots.push(node);
    } else {
      const parent = byId.get(r.parentCommentId);
      if (parent) {
        parent.replies.push(node);
      } else {
        roots.push(node);
      }
    }
  });

  return roots;
}

// GET /api/task-management/:taskId/comments
router.get("/:taskId/comments", requireAuth, async (req, res) => {
  const { taskId } = req.params;

  try {
    const pool = await sql.connect();
    const result = await pool
      .request()
      .input("taskId", sql.Int, taskId)
      .query(`
        SELECT
          c.commentId,
          c.taskId,
          c.authorId,
          c.body,
          c.createdAt,
          c.parentCommentId,
          u.fullName AS authorName,
          u.userName AS authorUserName
        FROM dbo.cv_Comments c
        LEFT JOIN dbo.Users u ON u.userID = c.authorId
        WHERE c.taskId = @taskId
          AND (c.isDeleted = 0 OR c.isDeleted IS NULL)
        ORDER BY c.createdAt ASC;
      `);

    const tree = buildCommentTree(result.recordset || []);
    return res.json({ ok: true, data: tree });
  } catch (err) {
    console.error("get task comments error", err);
    return res
      .status(500)
      .json({ ok: false, message: "Lỗi tải bình luận công việc." });
  }
});

// body: { body: string, parentCommentId?: number }
router.post("/:taskId/comments", requireAuth, async (req, res) => {
  const { taskId } = req.params;
  const { body, parentCommentId } = req.body;
  const userId = req.user?.userID; // tuỳ anh đang lưu user ở đâu

  if (!body || !body.trim()) {
    return res.status(400).json({ ok: false, message: "Nội dung không được rỗng." });
  }

  try {
    const pool = await sql.connect();
    const result = await pool
      .request()
      .input("taskId", sql.Int, taskId)
      .input("authorId", sql.Int, userId)
      .input("body", sql.NVarChar(sql.MAX), body.trim())
      .input(
        "parentCommentId",
        sql.Int,
        parentCommentId ? Number(parentCommentId) : null
      )
      .query(`
        INSERT INTO dbo.cv_Comments
          (taskId, authorId, body, createdAt, isDeleted, createdBy, parentCommentId)
        OUTPUT INSERTED.commentId, INSERTED.taskId, INSERTED.authorId, 
               INSERTED.body, INSERTED.createdAt, INSERTED.parentCommentId
        VALUES
          (@taskId, @authorId, @body,
           SYSDATETIME(), 0, @authorId,
           @parentCommentId);
      `);

    const inserted = result.recordset[0];

    return res.status(201).json({ ok: true, data: inserted });
  } catch (err) {
    console.error("create task comment error", err);
    return res
      .status(500)
      .json({ ok: false, message: "Lỗi lưu bình luận công việc." });
  }
});

// DELETE /api/task-management/comments/:commentId
router.delete("/comments/:commentId", requireAuth, async (req, res) => {
    const { commentId } = req.params;
    const userId = req.user.userID; // lấy từ token

    try {
      
      const pool = await sql.connect();
      const result = await pool
        .request()
        .input("commentId", sql.BigInt, commentId)
        .input("userId", sql.Int, userId)
        .query(`
          SELECT c.commentId, c.authorId, c.taskId,
                 t.createdBy,
                 CASE 
                   WHEN a.userID IS NOT NULL THEN 1 ELSE 0 
                 END AS isAssignee
          FROM cv_Comments c
          JOIN cv_Tasks t ON t.taskId = c.taskId
          LEFT JOIN cv_TaskAssignees a 
             ON a.taskId = c.taskId AND a.userID = @userId
          WHERE c.commentId = @commentId AND ISNULL(c.isDeleted,0) = 0
        `);

      if (result.recordset.length === 0) {
        return res.status(404).json({ message: "Comment không tồn tại" });
      }

      const row = result.recordset[0];

      // chỉ cho xoá nếu:
      // - là người viết comment
      // - hoặc là người tạo task
      // - hoặc là admin (tuỳ bạn, ví dụ role từ req.user)
      const isAuthor = row.authorId === userId;
      const isTaskCreator = row.createdBy === userId;
      const isAdmin = req.user.role === "admin";

      if (!isAuthor && !isTaskCreator && !isAdmin) {
        return res.status(403).json({ message: "Không có quyền xoá bình luận" });
      }

      await pool
      .request()
      .input("commentId", sql.BigInt, commentId)
      .input("userId", sql.Int, userId)
      .query(`
        UPDATE cv_Comments
        SET isDeleted = 1,
            deletedAt = SYSDATETIME(),
            deletedBy = @userId
        WHERE commentId = @commentId
          OR parentCommentId = @commentId   -- 👈 xoá mềm luôn các comment con
      `);

      return res.json({ success: true });
    } catch (err) {
      console.error("delete comment error", err);
      return res.status(500).json({ message: "Lỗi server khi xoá bình luận" });
    }
  }
);


//--------------------------------------------

// Chuẩn hoá code
function normalizeCode(code) {
  return (code || "").trim().toUpperCase();
}

/** Bỏ dấu tiếng Việt + chỉ giữ a-z0-9, viết thường, dính liền */
function slugifyName(name) {
  if (!name) return "";

  // Bảng chuẩn hoá tiếng Việt đầy đủ
  const map = {
    a: "áàảãạăắằẳẵặâấầẩẫậ",
    e: "éèẻẽẹêếềểễệ",
    i: "íìỉĩị",
    o: "óòỏõọôốồổỗộơớờởỡợ",
    u: "úùủũụưứừửữự",
    y: "ýỳỷỹỵ",
    d: "đ",
  };

  let str = name.toLowerCase();

  // Thay từng ký tự có dấu sang không dấu
  for (const nonAccent in map) {
    const accents = map[nonAccent];
    const regex = new RegExp("[" + accents + "]", "g");
    str = str.replace(regex, nonAccent);
  }

  // Chỉ giữ a-z0-9 dính liền
  return str.replace(/[^a-z0-9]+/g, "").slice(0, 50);
}

/** Sinh mã phòng ban duy nhất dựa trên name */
async function generateUniqueDeptCode(name, pool) {
  let base = slugifyName(name);
  if (!base) base = "phongban";

  let code = base;
  let suffix = 1;

  // Lặp đến khi không trùng (trong các bản ghi chưa xoá)
  /* ví dụ:
     name = "Tổng Hợp" -> "tonghop"
     nếu đã có "tonghop" thì dùng "tonghop2", "tonghop3", ...
  */
  // cẩn thận vòng lặp vô hạn, nhưng số phòng ban ít nên OK
  while (true) {
    const dup = await pool
      .request()
      .input("code", sql.NVarChar(50), code)
      .query(`
        SELECT TOP 1 departmentId
        FROM cv_Departments
        WHERE code = @code AND ISNULL(isDeleted,0) = 0
      `);

    if (dup.recordset.length === 0) {
      return code;
    }

    suffix += 1;
    code = `${base}${suffix}`;
  }
}

/**
 * GET /api/task-management/admin/departments
 * Lấy danh sách phòng ban (bao gồm cả đã xoá, để Admin xem được trạng thái)
 */
router.get("/admin/departments", requireAuth, async (req, res) => {
  try {
    const pool = await sql.connect();
    const result = await pool.request().query(`
      SELECT departmentId,
             code,
             name,
             orderIndex,
             isDeleted,
             createdAt,
             updatedAt
      FROM cv_Departments
      ORDER BY ISNULL(isDeleted,0), ISNULL(orderIndex, 9999), name
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("list departments error", err);
    res.status(500).json({ success: false, message: "Lỗi server khi lấy phòng ban" });
  }
});

// POST /api/task-management/admin/departments
router.post("/admin/departments", requireAuth, async (req, res) => {
  let { name } = req.body;
  const userId = req.user.userID;

  name = (name || "").trim();
  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Tên phòng ban là bắt buộc" });
  }

  try {
    const pool = await sql.connect();

    // Sinh code tự động
    const code = await generateUniqueDeptCode(name, pool);

    // Lấy orderIndex tiếp theo
    const ordRes = await pool.request().query(`
      SELECT MAX(orderIndex) AS maxOrder
      FROM cv_Departments
      WHERE ISNULL(isDeleted,0) = 0
    `);
    const maxOrder = ordRes.recordset[0]?.maxOrder ?? 0;
    const nextOrder = (maxOrder || 0) + 1;

    const result = await pool
      .request()
      .input("code", sql.NVarChar(50), code)
      .input("name", sql.NVarChar(200), name)
      .input("orderIndex", sql.Int, nextOrder)
      .input("createdBy", sql.Int, userId)
      .query(`
        INSERT INTO cv_Departments(code, name, orderIndex, createdAt, createdBy)
        OUTPUT INSERTED.*
        VALUES (@code, @name, @orderIndex, SYSUTCDATETIME(), @createdBy)
      `);

    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("create department error", err);
    res.status(500).json({ success: false, message: "Lỗi server khi tạo phòng ban" });
  }
});

// PATCH /api/task-management/admin/departments/:id
router.patch("/admin/departments/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  let { name, orderIndex } = req.body;
  const userId = req.user.userID;

  name = (name || "").trim();
  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Tên phòng ban là bắt buộc" });
  }

  try {
    const pool = await sql.connect();

    const code = slugifyName(name);

    // Check tồn tại & chưa xoá
    const exists = await pool
      .request()
      .input("departmentId", sql.Int, id)
      .query(`
        SELECT departmentId, isDeleted
        FROM cv_Departments
        WHERE departmentId = @departmentId
      `);

    if (exists.recordset.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy phòng ban" });
    }
    if (exists.recordset[0].isDeleted) {
      return res.status(400).json({
        success: false,
        message: "Không thể sửa phòng ban đã bị xoá",
      });
    }

    // UPDATE không dùng OUTPUT
    const updateResult = await pool
      .request()
      .input("departmentId", sql.Int, id)
      .input("name", sql.NVarChar(200), name)
      .input("code", sql.NVarChar(50), code)
      .input("orderIndex", sql.Int, orderIndex ?? null)
      .input("updatedBy", sql.Int, userId)
      .query(`
        UPDATE cv_Departments
        SET
          name       = @name,
          code       = @code,
          orderIndex = @orderIndex,
          updatedAt  = SYSUTCDATETIME(),
          updatedBy  = @updatedBy
        WHERE departmentId = @departmentId
          AND ISNULL(isDeleted, 0) = 0;

        SELECT
          departmentId,
          name,
          code,
          orderIndex,
          isDeleted,
          createdAt,
          updatedAt
        FROM cv_Departments
        WHERE departmentId = @departmentId;
      `);

    const row = updateResult.recordset?.[0];
    if (!row) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy phòng ban" });
    }

    res.json({ success: true, data: row });
  } catch (err) {
    console.error("update department error", err);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi cập nhật phòng ban",
    });
  }
});

// PATCH /api/task-management/admin/departments/:id/reorder
// body: { direction: 'up' | 'down' }
router.patch("/admin/departments/:id/reorder", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { direction } = req.body; // 'up' | 'down'
  if (!["up", "down"].includes(direction)) {
    return res.status(400).json({ success: false, message: "direction phải là 'up' hoặc 'down'" });
  }

  try {
    const pool = await sql.connect();

    // Lấy current
    const curRes = await pool
      .request()
      .input("departmentId", sql.Int, id)
      .query(`
        SELECT departmentId, orderIndex
        FROM cv_Departments
        WHERE departmentId = @departmentId AND ISNULL(isDeleted,0) = 0
      `);

    if (curRes.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phòng ban" });
    }

    const current = curRes.recordset[0];
    const curOrder = current.orderIndex ?? 0;

    let neighborQuery;
    if (direction === "up") {
      neighborQuery = `
        SELECT TOP 1 departmentId, orderIndex
        FROM cv_Departments
        WHERE ISNULL(isDeleted,0) = 0
          AND orderIndex < @curOrder
        ORDER BY orderIndex DESC
      `;
    } else {
      neighborQuery = `
        SELECT TOP 1 departmentId, orderIndex
        FROM cv_Departments
        WHERE ISNULL(isDeleted,0) = 0
          AND orderIndex > @curOrder
        ORDER BY orderIndex ASC
      `;
    }

    const neighborRes = await pool
      .request()
      .input("curOrder", sql.Int, curOrder)
      .query(neighborQuery);

    if (neighborRes.recordset.length === 0) {
      // Không có thằng trên/dưới -> không làm gì
      return res.json({ success: true, data: current });
    }

    const neighbor = neighborRes.recordset[0];

    // Hoán đổi orderIndex
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      await new sql.Request(tx)
        .input("id1", sql.Int, current.departmentId)
        .input("ord1", sql.Int, neighbor.orderIndex)
        .query(`
          UPDATE cv_Departments
          SET orderIndex = @ord1
          WHERE departmentId = @id1
        `);

      await new sql.Request(tx)
        .input("id2", sql.Int, neighbor.departmentId)
        .input("ord2", sql.Int, curOrder)
        .query(`
          UPDATE cv_Departments
          SET orderIndex = @ord2
          WHERE departmentId = @id2
        `);

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("reorder department error", err);
    res.status(500).json({ success: false, message: "Lỗi server khi sắp xếp phòng ban" });
  }
});

router.delete("/admin/departments/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userID;

  try {
    const pool = await sql.connect();

    // Cho trigger audit biết user
    await pool
      .request()
      .input("name", sql.NVarChar(128), "user_id")
      .input("value", sql.NVarChar(128), String(userId))
      .query(`EXEC sys.sp_set_session_context @key=@name, @value=@value, @read_only=0;`);

    const result = await pool
      .request()
      .input("departmentId", sql.Int, id)
      .query(`
        DELETE FROM cv_Departments
        WHERE departmentId = @departmentId
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: "Không tìm thấy phòng ban" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("delete department error", err);
    res.status(500).json({ success: false, message: "Lỗi server khi xoá (soft) phòng ban" });
  }
});

//------------------------------------

// GET /api/task-management/admin/teams?includeDeleted=0|1
router.get("/admin/teams", requireAuth, async (req, res) => {
  const includeDeleted = req.query.includeDeleted === "1";

  try {
    const pool = await sql.connect();
    const result = await pool
      .request()
      .input("includeDeleted", sql.Bit, includeDeleted ? 1 : 0)
      .query(`
        SELECT 
          t.teamId,
          t.departmentId,
          d.name AS departmentName,
          t.code,
          t.name,
          t.orderIndex,
          ISNULL(t.isDeleted,0) AS isDeleted,
          t.createdAt,
          t.updatedAt
        FROM cv_Teams t
        LEFT JOIN cv_Departments d ON d.departmentId = t.departmentId
        WHERE (@includeDeleted = 1 OR ISNULL(t.isDeleted,0) = 0)
        ORDER BY 
          d.name,
          ISNULL(t.orderIndex, 9999),
          t.name;
      `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("list teams error", err);
    res.status(500).json({ message: "Lỗi server khi lấy tổ/nhóm" });
  }
});

// POST /api/task-management/admin/teams
// body: { departmentId, name }
router.post("/admin/teams", requireAuth, async (req, res) => {
  const { departmentId, name } = req.body;
  const userId = req.user.userID;

  if (!departmentId || !name || !name.trim()) {
    return res
      .status(400)
      .json({ message: "Thiếu phòng ban hoặc tên tổ/nhóm" });
  }

  const code = slugifyName(name);
  if (!code) {
    return res.status(400).json({ message: "Không tạo được mã tổ/nhóm" });
  }

  try {
    const pool = await sql.connect();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    const reqNext = new sql.Request(tx);
    const nextOrderResult = await reqNext
      .input("departmentId", sql.Int, departmentId)
      .query(`
        SELECT ISNULL(MAX(orderIndex), 0) + 1 AS nextOrder
        FROM cv_Teams
        WHERE departmentId = @departmentId AND ISNULL(isDeleted,0) = 0;
      `);

    const nextOrder =
      nextOrderResult.recordset[0]?.nextOrder ?? 1;

    const reqInsert = new sql.Request(tx);
    const insertResult = await reqInsert
      .input("departmentId", sql.Int, departmentId)
      .input("code", sql.NVarChar(50), code)
      .input("name", sql.NVarChar(200), name.trim())
      .input("orderIndex", sql.Int, nextOrder)
      .input("createdBy", sql.Int, userId)
      .query(`
        INSERT INTO cv_Teams(departmentId, code, name, orderIndex, isDeleted, createdBy, createdAt)
        OUTPUT INSERTED.*
        VALUES (@departmentId, @code, @name, @orderIndex, 0, @createdBy, SYSDATETIME());
      `);

    await tx.commit();

    res.json({ success: true, data: insertResult.recordset[0] });
  } catch (err) {
    console.error("create team error", err);

    if (err && err.originalError && err.originalError.info &&
        err.originalError.info.message &&
        err.originalError.info.message.includes("UX_cv_Teams_Department_Code_active")) {
      return res.status(400).json({
        message: "Mã tổ/nhóm đã tồn tại trong phòng ban này (tên bị trùng).",
      });
    }

    res.status(500).json({ message: "Lỗi server khi tạo tổ/nhóm" });
  }
});

// PATCH /api/task-management/admin/teams/:id
router.patch("/admin/teams/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { departmentId, name, orderIndex } = req.body;
  const userId = req.user.userID;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: "Tên tổ/nhóm không được trống" });
  }

  const trimmedName = name.trim();
  const code = slugifyName(trimmedName);

  try {
    const pool = await sql.connect();

    const result = await pool
      .request()
      .input("teamId", sql.Int, id)
      .input("departmentId", sql.Int, departmentId ?? null)
      .input("name", sql.NVarChar(200), trimmedName)
      .input("code", sql.NVarChar(50), code)
      .input("orderIndex", sql.Int, orderIndex ?? null)
      .input("updatedBy", sql.Int, userId)
      .query(`
        UPDATE cv_Teams
        SET 
          departmentId = ISNULL(@departmentId, departmentId),
          name         = @name,
          code         = @code,
          orderIndex   = @orderIndex,
          updatedAt    = SYSDATETIME(),
          updatedBy    = @updatedBy
        WHERE teamId = @teamId
          AND ISNULL(isDeleted, 0) = 0;

        SELECT
          teamId,
          departmentId,
          name,
          code,
          orderIndex,
          isDeleted,
          createdAt,
          updatedAt
        FROM cv_Teams
        WHERE teamId = @teamId;
      `);

    const row = result.recordset?.[0];

    if (!row) {
      return res
        .status(404)
        .json({ message: "Không tìm thấy tổ/nhóm" });
    }

    res.json({ success: true, data: row });
  } catch (err) {
    console.error("update team error", err);
    res
      .status(500)
      .json({ message: "Lỗi server khi cập nhật tổ/nhóm" });
  }
});

// DELETE (soft) /api/task-management/admin/teams/:id
router.delete("/admin/teams/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userID;

  try {
    const pool = await sql.connect();
    const result = await pool
      .request()
      .input("teamId", sql.Int, id)
      .input("userId", sql.Int, userId)
      .query(`
        UPDATE cv_Teams
        SET 
          isDeleted = 1,
          updatedAt = SYSDATETIME(),
          updatedBy = @userId,
          deletedAt = SYSDATETIME(),
          deletedBy = @userId
        WHERE teamId = @teamId AND ISNULL(isDeleted,0) = 0;
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ message: "Không tìm thấy tổ/nhóm" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("delete team error", err);
    res.status(500).json({ message: "Lỗi server khi xoá tổ/nhóm" });
  }
});

// PATCH /api/task-management/admin/teams/:id/reorder
router.patch("/admin/teams/:id/reorder", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { direction } = req.body;
  const userId = req.user.userID;

  if (!["up", "down"].includes(direction)) {
    return res.status(400).json({ message: "direction không hợp lệ" });
  }

  try {
    const pool = await sql.connect();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    const r1 = new sql.Request(tx);
    const cur = await r1
      .input("teamId", sql.Int, id)
      .query(`
        SELECT teamId, departmentId, ISNULL(orderIndex, 9999) AS orderIndex
        FROM cv_Teams
        WHERE teamId = @teamId AND ISNULL(isDeleted,0) = 0;
      `);

    if (cur.recordset.length === 0) {
      await tx.rollback();
      return res.status(404).json({ message: "Không tìm thấy tổ/nhóm" });
    }

    const team = cur.recordset[0];

    const r2 = new sql.Request(tx);
    const neighborQuery =
      direction === "up"
        ? `
          SELECT TOP 1 teamId, ISNULL(orderIndex, 9999) AS orderIndex
          FROM cv_Teams
          WHERE departmentId = @departmentId
            AND ISNULL(isDeleted,0) = 0
            AND ISNULL(orderIndex,9999) < @orderIndex
          ORDER BY ISNULL(orderIndex,9999) DESC, teamId DESC;
        `
        : `
          SELECT TOP 1 teamId, ISNULL(orderIndex, 9999) AS orderIndex
          FROM cv_Teams
          WHERE departmentId = @departmentId
            AND ISNULL(isDeleted,0) = 0
            AND ISNULL(orderIndex,9999) > @orderIndex
          ORDER BY ISNULL(orderIndex,9999) ASC, teamId ASC;
        `;

    const neighbor = await r2
      .input("departmentId", sql.Int, team.departmentId)
      .input("orderIndex", sql.Int, team.orderIndex)
      .query(neighborQuery);

    if (neighbor.recordset.length === 0) {
      await tx.rollback();
      return res.json({ success: true }); // ở đầu/ cuối rồi
    }

    const other = neighbor.recordset[0];

    const r3 = new sql.Request(tx);
    await r3
      .input("teamId", sql.Int, team.teamId)
      .input("otherId", sql.Int, other.teamId)
      .input("order1", sql.Int, team.orderIndex)
      .input("order2", sql.Int, other.orderIndex)
      .input("userId", sql.Int, userId)
      .query(`
        UPDATE cv_Teams
        SET orderIndex = @order2,
            updatedAt  = SYSDATETIME(),
            updatedBy  = @userId
        WHERE teamId = @teamId;

        UPDATE cv_Teams
        SET orderIndex = @order1,
            updatedAt  = SYSDATETIME(),
            updatedBy  = @userId
        WHERE teamId = @otherId;
      `);

    await tx.commit();
    res.json({ success: true });
  } catch (err) {
    console.error("reorder team error", err);
    res.status(500).json({ message: "Lỗi server khi sắp xếp tổ/nhóm" });
  }
});


//----------------------  ROLES  ---------------

/* ============================================================
   1) COMPANY ROLES (cv_Roles)
   ============================================================ */

// GET /api/task-management/admin/company-roles?includeDeleted=1
router.get("/admin/company-roles", requireAuth, async (req, res) => {
  const includeDeleted = req.query.includeDeleted === "1";

  try {
    const pool = await sql.connect();
    let query = `
      SELECT roleId, code, name, isDeleted, createdAt, updatedAt
      FROM cv_Roles
    `;
    if (!includeDeleted) {
      query += ` WHERE isDeleted = 0`;
    }
    query += ` ORDER BY code`;

    const result = await pool.request().query(query);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("list company roles error", err);
    res.status(500).json({ message: "Lỗi server khi lấy vai trò công ty" });
  }
});

// POST /api/task-management/admin/company-roles
router.post("/admin/company-roles", requireAuth, async (req, res) => {
  const { name, code } = req.body;
  const userId = req.user.userID;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: "Tên vai trò không được trống" });
  }

  const finalCode = (code && code.trim()) ? code.trim().toLowerCase() : slugifyName(name);

  try {
    const pool = await sql.connect();
    const result = await pool.request()
      .input("code", sql.NVarChar(50), finalCode)
      .input("name", sql.NVarChar(200), name.trim())
      .input("createdBy", sql.Int, userId)
      .query(`
        INSERT INTO cv_Roles(code, name, createdBy)
        OUTPUT INSERTED.roleId, INSERTED.code, INSERTED.name,
               INSERTED.isDeleted, INSERTED.createdAt, INSERTED.updatedAt
        VALUES (@code, @name, @createdBy)
      `);

    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("create company role error", err);

    if (err.number === 2601 || err.number === 2627) {
      return res.status(400).json({ message: "Mã vai trò đã tồn tại" });
    }

    res.status(500).json({ message: "Lỗi server khi tạo vai trò công ty" });
  }
});

// PATCH /api/task-management/admin/company-roles/:id
router.patch("/admin/company-roles/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, code, isDeleted } = req.body;
  const userId = req.user.userID;

  try {
    const pool = await sql.connect();
    const finalCode = code ? code.trim().toLowerCase() : slugifyName(name);

    const result = await pool.request()
      .input("roleId", sql.Int, id)
      .input("name", sql.NVarChar(200), name ?? null)
      .input("code", sql.NVarChar(50), finalCode)
      .input(
        "isDeleted",
        sql.Bit,
        typeof isDeleted === "boolean" ? (isDeleted ? 1 : 0) : null
      )
      .input("updatedBy", sql.Int, userId)
      .query(`
        -- Cập nhật
        UPDATE cv_Roles
        SET
          name      = COALESCE(@name, name),
          code      = COALESCE(@code, code),
          isDeleted = COALESCE(@isDeleted, isDeleted),
          updatedBy = @updatedBy,
          updatedAt = SYSDATETIME()
        WHERE roleId = @roleId;

        -- Lấy lại bản ghi sau khi update
        SELECT 
          roleId,
          code,
          name,
          isDeleted,
          createdAt,
          updatedAt
        FROM cv_Roles
        WHERE roleId = @roleId;
      `);

    // result.recordset là result của SELECT cuối cùng
    if (!result.recordset || result.recordset.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy vai trò" });
    }

    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("update company role error", err);

    // trùng code (unique)
    if (err.number === 2601 || err.number === 2627) {
      return res.status(400).json({ message: "Mã vai trò đã tồn tại" });
    }

    res
      .status(500)
      .json({ message: "Lỗi server khi cập nhật vai trò công ty" });
  }
});

// DELETE (soft) /api/task-management/admin/company-roles/:id
// Nếu đã có trigger SoftDelete thì dùng DELETE, trigger sẽ set isDeleted = 1
router.delete("/admin/company-roles/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const pool = await sql.connect();

    await pool.request()
      .input("roleId", sql.Int, id)
      .query(`
        DELETE FROM cv_Roles WHERE roleId = @roleId;
      `);

    res.json({ success: true });
  } catch (err) {
    console.error("delete company role error", err);
    res.status(500).json({ message: "Lỗi server khi xoá vai trò công ty" });
  }
});

/* ============================================================
   2) PROJECT ROLES (cv_ProjectRoles)
   ============================================================ */

// GET /api/task-management/admin/project-roles?includeDeleted=1
router.get("/admin/project-roles", requireAuth, async (req, res) => {
  const includeDeleted = req.query.includeDeleted === "1";

  try {
    const pool = await sql.connect();
    let query = `
      SELECT projectRoleId, code, name, isManagerial, isDeleted, createdAt, updatedAt
      FROM cv_ProjectRoles
    `;
    if (!includeDeleted) {
      query += ` WHERE isDeleted = 0`;
    }
    query += ` ORDER BY code`;

    const result = await pool.request().query(query);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("list project roles error", err);
    res.status(500).json({ message: "Lỗi server khi lấy vai trò dự án" });
  }
});

// POST /api/task-management/admin/project-roles
router.post("/admin/project-roles", requireAuth, async (req, res) => {
  const { name, code, isManagerial } = req.body;
  const userId = req.user.userID;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: "Tên vai trò không được trống" });
  }

  const finalCode = (code && code.trim()) ? code.trim().toLowerCase() : slugifyName(name);

  try {
    const pool = await sql.connect();
    const result = await pool.request()
      .input("code", sql.NVarChar(50), finalCode)
      .input("name", sql.NVarChar(200), name.trim())
      .input("isManagerial", sql.Bit, isManagerial ? 1 : 0)
      .input("createdBy", sql.Int, userId)
      .query(`
        INSERT INTO cv_ProjectRoles(code, name, isManagerial, createdBy)
        OUTPUT INSERTED.projectRoleId, INSERTED.code, INSERTED.name,
               INSERTED.isManagerial, INSERTED.isDeleted, INSERTED.createdAt, INSERTED.updatedAt
        VALUES (@code, @name, @isManagerial, @createdBy)
      `);

    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("create project role error", err);

    if (err.number === 2601 || err.number === 2627) {
      return res.status(400).json({ message: "Mã vai trò đã tồn tại" });
    }

    res.status(500).json({ message: "Lỗi server khi tạo vai trò dự án" });
  }
});

// PATCH /api/task-management/admin/project-roles/:id
router.patch("/admin/project-roles/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, code, isManagerial, isDeleted } = req.body;
  const userId = req.user.userID;

  try {
    const pool = await sql.connect();
    const finalCode = code ? code.trim().toLowerCase() : slugifyName(name);

    const result = await pool.request()
      .input("projectRoleId", sql.Int, id)
      .input("name", sql.NVarChar(200), name ?? null)
      .input("code", sql.NVarChar(50), finalCode)
      .input(
        "isManagerial",
        sql.Bit,
        typeof isManagerial === "boolean" ? (isManagerial ? 1 : 0) : null
      )
      .input(
        "isDeleted",
        sql.Bit,
        typeof isDeleted === "boolean" ? (isDeleted ? 1 : 0) : null
      )
      .input("updatedBy", sql.Int, userId)
      .query(`
        -- Cập nhật
        UPDATE cv_ProjectRoles
        SET
          name         = COALESCE(@name, name),
          code         = COALESCE(@code, code),
          isManagerial = COALESCE(@isManagerial, isManagerial),
          isDeleted    = COALESCE(@isDeleted, isDeleted),
          updatedBy    = @updatedBy,
          updatedAt    = SYSDATETIME()
        WHERE projectRoleId = @projectRoleId;

        -- Lấy lại bản ghi sau khi update
        SELECT
          projectRoleId,
          code,
          name,
          isManagerial,
          isDeleted,
          createdAt,
          updatedAt
        FROM cv_ProjectRoles
        WHERE projectRoleId = @projectRoleId;
      `);

    if (!result.recordset || result.recordset.length === 0) {
      return res
        .status(404)
        .json({ message: "Không tìm thấy vai trò dự án" });
    }

    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("update project role error", err);

    // trùng code (unique)
    if (err.number === 2601 || err.number === 2627) {
      return res.status(400).json({ message: "Mã vai trò đã tồn tại" });
    }

    res
      .status(500)
      .json({ message: "Lỗi server khi cập nhật vai trò dự án" });
  }
});

// DELETE /api/task-management/admin/project-roles/:id
router.delete("/admin/project-roles/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const pool = await sql.connect();
    await pool.request()
      .input("projectRoleId", sql.Int, id)
      .query(`DELETE FROM cv_ProjectRoles WHERE projectRoleId = @projectRoleId;`);

    res.json({ success: true });
  } catch (err) {
    console.error("delete project role error", err);
    res.status(500).json({ message: "Lỗi server khi xoá vai trò dự án" });
  }
});


//------------------ gán role công ty + phòng ban + tổ nhóm ----------------

// GET /api/task-management/admin/company/meta
router.get("/admin/company/meta", requireAuth, async (req, res) => {
  try {
    const pool = await sql.connect();

    // roles công ty (cv_Roles)
    const rolesResult = await pool.request().query(`
      SELECT roleId, code, name
      FROM cv_Roles
      WHERE isDeleted = 0
      ORDER BY name
    `);

    // phòng ban
    const deptResult = await pool.request().query(`
      SELECT departmentId, code, name
      FROM cv_Departments
      WHERE isDeleted = 0
      ORDER BY ISNULL(orderIndex, 9999), name
    `);

    // tổ/nhóm
    const teamResult = await pool.request().query(`
      SELECT teamId, departmentId, code, name
      FROM cv_Teams
      WHERE isDeleted = 0
      ORDER BY name
    `);

    res.json({
      success: true,
      data: {
        roles: rolesResult.recordset,
        departments: deptResult.recordset,
        teams: teamResult.recordset,
      },
    });
  } catch (err) {
    console.error("company meta error", err);
    res.status(500).json({ message: "Lỗi server khi lấy danh mục" });
  }
});

// GET /api/task-management/admin/company/users (có phân trang)
router.get("/admin/company/users", requireAuth, async (req, res) => {
  // page & pageSize từ query, default: 1 & 12
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 12, 1);

  try {
    const pool = await sql.connect();
    const request = pool.request();

    request.input("page", sql.Int, page);
    request.input("pageSize", sql.Int, pageSize);

    const resultUsers = await request.query(`
      IF OBJECT_ID('tempdb..#UsersAll') IS NOT NULL DROP TABLE #UsersAll;

      SELECT DISTINCT
        u.userID       AS userId,
        u.username,
        u.fullName,
        u.email,
        u.isActive,
        u.isDeleted,
        u.cv_DepartmentId AS departmentId,
        u.cv_TeamId       AS teamId,
        d.name AS departmentName,
        t.name AS teamName
      INTO #UsersAll
      FROM Users u
      INNER JOIN UserModules um ON um.userId = u.userID
      INNER JOIN Modules m ON m.moduleId = um.moduleId
      LEFT JOIN cv_Departments d ON d.departmentId = u.cv_DepartmentId AND d.isDeleted = 0
      LEFT JOIN cv_Teams t ON t.teamId = u.cv_TeamId AND t.isDeleted = 0
      WHERE 
        m.moduleKey = 'qlcongviec'
        AND u.isDeleted = 0;

      SELECT COUNT(*) AS total FROM #UsersAll;

      SELECT
        userId,
        username,
        fullName,
        email,
        isActive,
        isDeleted,
        departmentId,
        teamId,
        departmentName,
        teamName
      FROM #UsersAll
      ORDER BY fullName, username
      OFFSET (@page - 1) * @pageSize ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    const total = resultUsers.recordsets[0][0]?.total || 0;
    const users = resultUsers.recordsets[1] || [];

    if (users.length === 0) {
      return res.json({
        success: true,
        data: [],
        pagination: {
          total,
          page,
          pageSize,
          totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
        },
      });
    }

    // Lấy roles cho list userId trong page
    const ids = users.map((u) => u.userId).join(",");
    const rolesResult = await pool.request().query(`
      SELECT ur.userRoleId, ur.userId, ur.roleId, r.name AS roleName
      FROM cv_UserRoles ur
      INNER JOIN cv_Roles r ON r.roleId = ur.roleId AND r.isDeleted = 0
      WHERE ur.isDeleted = 0 AND ur.userId IN (${ids});
    `);

    const rolesByUser = {};
    rolesResult.recordset.forEach((row) => {
      if (!rolesByUser[row.userId]) rolesByUser[row.userId] = [];
      rolesByUser[row.userId].push({
        userRoleId: row.userRoleId,
        roleId: row.roleId,
        roleName: row.roleName,
      });
    });

    const data = users.map((u) => ({
      ...u,
      roles: rolesByUser[u.userId] || [],
      roleIds: (rolesByUser[u.userId] || []).map((r) => r.roleId),
    }));

    res.json({
      success: true,
      data,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error("company users error", err);
    res.status(500).json({ message: "Lỗi server khi lấy danh sách người dùng" });
  }
});

// PATCH /api/task-management/admin/company/users/:userId
router.patch(
  "/admin/company/users/:userId",
  requireAuth,
  async (req, res) => {
    const { userId } = req.params;
    const { departmentId, teamId, roleIds } = req.body; // roleIds: array<int>
    const actorId = req.user.userID;

    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ message: "roleIds phải là mảng" });
    }

    try {
      const pool = await sql.connect();
      const tx = new sql.Transaction(pool);
      await tx.begin();

      try {
        // set session context cho trigger / log nếu có
        await new sql.Request(tx)
          .input("actor", sql.Int, actorId)
          .query(
            "EXEC sys.sp_set_session_context @key = N'user_id', @value = @actor;"
          );

        // 1) Cập nhật phòng ban + tổ nhóm
        await new sql.Request(tx)
          .input("userId", sql.Int, userId)
          .input(
            "departmentId",
            sql.Int,
            departmentId ? Number(departmentId) : null
          )
          .input("teamId", sql.Int, teamId ? Number(teamId) : null)
          .query(`
            UPDATE Users
            SET
              cv_DepartmentId = @departmentId,
              cv_TeamId       = @teamId
            WHERE userID = @userId;
          `);

        // 2) Soft delete toàn bộ role hiện tại của user này
        await new sql.Request(tx)
          .input("userId", sql.Int, userId)
          .input("actor", sql.Int, actorId)
          .query(`
            UPDATE cv_UserRoles
            SET
              isDeleted = 1,
              deletedBy = @actor,
              deletedAt = SYSDATETIME()
            WHERE userId = @userId AND ISNULL(isDeleted,0) = 0;
          `);

        // 3) Thêm / hồi sinh role mới (UPSERT)
        const distinctRoleIds = [...new Set(roleIds.map((r) => Number(r)))];

        for (const rid of distinctRoleIds) {
          await new sql.Request(tx)
            .input("userId", sql.Int, userId)
            .input("roleId", sql.Int, rid)
            .input("actor", sql.Int, actorId)
            .query(`
              IF EXISTS (
                SELECT 1 
                FROM cv_UserRoles 
                WHERE userId = @userId AND roleId = @roleId
              )
              BEGIN
                -- Nếu đã có record (dù đang isDeleted = 1 hay 0) thì "hồi sinh" / cập nhật
                UPDATE cv_UserRoles
                SET 
                  isDeleted = 0,
                  deletedBy = NULL,
                  deletedAt = NULL,
                  updatedBy = @actor,
                  updatedAt = SYSDATETIME()
                WHERE userId = @userId AND roleId = @roleId;
              END
              ELSE
              BEGIN
                INSERT INTO cv_UserRoles(userId, roleId, isDeleted, createdBy, createdAt)
                VALUES (@userId, @roleId, 0, @actor, SYSDATETIME());
              END
            `);
        }

        await tx.commit();
        res.json({ success: true });
      } catch (errTx) {
        await tx.rollback();
        console.error("update company user error", errTx);
        res
          .status(500)
          .json({ message: "Lỗi server khi cập nhật vai trò / phòng ban" });
      }
    } catch (err) {
      console.error("update company user outer error", err);
      res
        .status(500)
        .json({ message: "Lỗi server khi cập nhật vai trò / phòng ban" });
    }
  }
);


// -----------   cv_WorkflowStatuses --------------

// sinh code unique (nếu trùng thì thêm số 2,3,4...)
async function generateUniqueStatusCode(pool, baseName) {
  const base = slugifyName(baseName);
  let code = base;
  let i = 1;

  // tránh loop vô hạn, nhưng thực tế ít khi loop nhiều
  while (i < 50) {
    const r = await pool
      .request()
      .input("code", sql.VarChar(100), code)
      .query(`
        SELECT COUNT(*) AS cnt
        FROM cv_WorkflowStatuses
        WHERE code = @code
      `);

    const cnt = r.recordset[0].cnt || 0;
    if (cnt === 0) break;

    i++;
    code = `${base}${i}`;
  }

  return code;
}

// GET /api/task-management/admin/workflow-statuses
router.get("/admin/workflow-statuses", requireAuth, async (req, res) => {
  try {
    const pool = await sql.connect();
    const result = await pool.request().query(`
      SELECT
        statusId,
        code,
        name,
        orderIndex,
        isDeleted,
        createdBy,
        createdAt,
        updatedBy,
        updatedAt,
        deletedBy,
        deletedAt
      FROM cv_WorkflowStatuses
      ORDER BY ISNULL(orderIndex, 9999), statusId;
    `);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (err) {
    console.error("workflow-statuses list error", err);
    res
      .status(500)
      .json({ message: "Lỗi server khi lấy danh sách trạng thái công việc" });
  }
});

// POST /api/task-management/admin/workflow-statuses
router.post("/admin/workflow-statuses", requireAuth, async (req, res) => {
  const { name } = req.body;
  const actorId = req.user.userID;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: "Tên trạng thái không được trống" });
  }

  try {
    const pool = await sql.connect();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      await new sql.Request(tx)
        .input("actor", sql.Int, actorId)
        .query(
          "EXEC sys.sp_set_session_context @key = N'user_id', @value = @actor;"
        );

      // tạo code unique
      const code = await generateUniqueStatusCode(pool, name);

      // tính orderIndex: lấy max + 1
      const oiResult = await new sql.Request(tx).query(`
        SELECT MAX(orderIndex) AS maxOrder
        FROM cv_WorkflowStatuses
        WHERE isDeleted = 0;
      `);
      const maxOrder = oiResult.recordset[0].maxOrder || 0;
      const newOrderIndex = maxOrder + 1;

      const insertResult = await new sql.Request(tx)
        .input("code", sql.VarChar(100), code)
        .input("name", sql.NVarChar(200), name)
        .input("orderIndex", sql.Int, newOrderIndex)
        .input("actor", sql.Int, actorId)
        .query(`
          INSERT INTO cv_WorkflowStatuses
            (code, name, orderIndex, isDeleted, createdBy, createdAt)
          OUTPUT INSERTED.statusId, INSERTED.code, INSERTED.name, INSERTED.orderIndex, INSERTED.isDeleted
          VALUES
            (@code, @name, @orderIndex, 0, @actor, SYSDATETIME());
        `);

      await tx.commit();

      res.status(201).json({
        success: true,
        data: insertResult.recordset[0],
      });
    } catch (errTx) {
      await tx.rollback();
      console.error("workflow-statuses create error", errTx);
      res
        .status(500)
        .json({ message: "Lỗi server khi tạo trạng thái công việc" });
    }
  } catch (err) {
    console.error("workflow-statuses create outer error", err);
    res
      .status(500)
      .json({ message: "Lỗi server khi tạo trạng thái công việc" });
  }
});

// PATCH /api/task-management/admin/workflow-statuses/:statusId
router.patch(
  "/admin/workflow-statuses/:statusId",
  requireAuth,
  async (req, res) => {
    const { statusId } = req.params;
    const { name, orderIndex } = req.body;
    const actorId = req.user.userID;

    if (!name || !name.trim()) {
      return res
        .status(400)
        .json({ message: "Tên trạng thái không được trống" });
    }

    try {
      const pool = await sql.connect();
      const tx = new sql.Transaction(pool);
      await tx.begin();

      const code = await generateUniqueStatusCode(pool, name);

      try {
        await new sql.Request(tx)
          .input("actor", sql.Int, actorId)
          .query(
            "EXEC sys.sp_set_session_context @key = N'user_id', @value = @actor;"
          );

        await new sql.Request(tx)
          .input("statusId", sql.Int, statusId)
          .input("name", sql.NVarChar(200), name)
          .input("code", sql.NVarChar(50), code)
          .input(
            "orderIndex",
            sql.Int,
            typeof orderIndex === "number" ? orderIndex : null
          )
          .input("actor", sql.Int, actorId)
          .query(`
            UPDATE cv_WorkflowStatuses
            SET
              name       = @name,
              code       = @code,
              orderIndex = @orderIndex,
              updatedBy  = @actor,
              updatedAt  = SYSDATETIME()
            WHERE statusId = @statusId;
          `);

        await tx.commit();
        res.json({ success: true });
      } catch (errTx) {
        await tx.rollback();
        console.error("workflow-statuses update error", errTx);
        res
          .status(500)
          .json({ message: "Lỗi server khi cập nhật trạng thái công việc" });
      }
    } catch (err) {
      console.error("workflow-statuses update outer error", err);
      res
        .status(500)
        .json({ message: "Lỗi server khi cập nhật trạng thái công việc" });
    }
  }
);

// PATCH /api/task-management/admin/workflow-statuses/:statusId/reorder
router.patch(
  "/admin/workflow-statuses/:statusId/reorder",
  requireAuth,
  async (req, res) => {
    const { statusId } = req.params;
    const { direction } = req.body; // "up" | "down"
    const actorId = req.user.userID;

    if (!["up", "down"].includes(direction)) {
      return res.status(400).json({ message: "direction không hợp lệ" });
    }

    try {
      const pool = await sql.connect();
      const tx = new sql.Transaction(pool);
      await tx.begin();

      try {
        await new sql.Request(tx)
          .input("actor", sql.Int, actorId)
          .query(
            "EXEC sys.sp_set_session_context @key = N'user_id', @value = @actor;"
          );

        const rCurrent = await new sql.Request(tx)
          .input("statusId", sql.Int, statusId)
          .query(`
            SELECT statusId, orderIndex
            FROM cv_WorkflowStatuses
            WHERE statusId = @statusId AND isDeleted = 0;
          `);

        if (rCurrent.recordset.length === 0) {
          await tx.rollback();
          return res.status(404).json({ message: "Không tìm thấy trạng thái" });
        }

        const current = rCurrent.recordset[0];
        const curOrder = current.orderIndex ?? 9999;

        let neighborQuery;
        if (direction === "up") {
          neighborQuery = `
            SELECT TOP 1 statusId, orderIndex
            FROM cv_WorkflowStatuses
            WHERE isDeleted = 0 AND ISNULL(orderIndex, 9999) < ${curOrder}
            ORDER BY ISNULL(orderIndex, 9999) DESC;
          `;
        } else {
          neighborQuery = `
            SELECT TOP 1 statusId, orderIndex
            FROM cv_WorkflowStatuses
            WHERE isDeleted = 0 AND ISNULL(orderIndex, 9999) > ${curOrder}
            ORDER BY ISNULL(orderIndex, 9999) ASC;
          `;
        }

        const rNeighbor = await new sql.Request(tx).query(neighborQuery);
        if (rNeighbor.recordset.length === 0) {
          await tx.commit(); // không swap được nhưng không lỗi
          return res.json({ success: true });
        }

        const neighbor = rNeighbor.recordset[0];
        const neighborOrder = neighbor.orderIndex ?? 9999;

        await new sql.Request(tx)
          .input("statusId", sql.Int, current.statusId)
          .input("orderIndex", sql.Int, neighborOrder)
          .query(`
            UPDATE cv_WorkflowStatuses
            SET orderIndex = @orderIndex
            WHERE statusId = @statusId;
          `);

        await new sql.Request(tx)
          .input("neighborId", sql.Int, neighbor.statusId)
          .input("orderIndex", sql.Int, curOrder)
          .query(`
            UPDATE cv_WorkflowStatuses
            SET orderIndex = @orderIndex
            WHERE statusId = @neighborId;
          `);

        await tx.commit();
        res.json({ success: true });
      } catch (errTx) {
        await tx.rollback();
        console.error("workflow-statuses reorder error", errTx);
        res
          .status(500)
          .json({ message: "Lỗi server khi sắp xếp thứ tự trạng thái" });
      }
    } catch (err) {
      console.error("workflow-statuses reorder outer error", err);
      res
        .status(500)
        .json({ message: "Lỗi server khi sắp xếp thứ tự trạng thái" });
    }
  }
);

// DELETE /api/task-management/admin/workflow-statuses/:statusId
router.delete(
  "/admin/workflow-statuses/:statusId",
  requireAuth,
  async (req, res) => {
    const { statusId } = req.params;
    const actorId = req.user.userID;

    try {
      const pool = await sql.connect();
      await pool
        .request()
        .input("actor", sql.Int, actorId)
        .input("statusId", sql.Int, statusId)
        .query(`
          EXEC sys.sp_set_session_context @key = N'user_id', @value = @actor;

          UPDATE cv_WorkflowStatuses
          SET 
            isDeleted = 1,
            deletedBy = @actor,
            deletedAt = SYSDATETIME()
          WHERE statusId = @statusId;
        `);

      res.json({ success: true });
    } catch (err) {
      console.error("workflow-statuses delete error", err);
      res
        .status(500)
        .json({ message: "Lỗi server khi xoá trạng thái công việc" });
    }
  }
);


//------------------------API theo team--------------------
// GET /api/task-management/team/members
router.get("/team/members", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;

    const r = await pool.request()
      .input("userID", sql.Int, req.user.userID)
      .query(`
        DECLARE @teamId INT;

        SELECT @teamId = cv_TeamId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @teamId IS NULL
        BEGIN
          SELECT TOP 0
            userID,
            fullName,
            userName
          FROM dbo.Users;
          RETURN;
        END

        SELECT 
          u.userID,
          u.fullName,
          u.userName
        FROM dbo.Users u
        WHERE u.cv_TeamId = @teamId
          AND u.userID <> @userID
        ORDER BY u.fullName;
      `);

    return res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error("team members error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách thành viên nhóm" });
  }
});

// /api/task-management/team
router.get("/team", requireAuth, async (req, res) => {
  try {
    const {
      status,
      priority,
      search,
      page = 1,
      pageSize = 20,
      startDateFilter,
      memberId,
    } = req.query;
    
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("status", sql.NVarChar(50), status || null)
      .input("priority", sql.NVarChar(20), priority || null)
      .input("search", sql.NVarChar(200), search || null)
      .input("startDateFilter", sql.Date, startDateFilter || null)
      .input("memberId", sql.Int, memberId || null)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);
        DECLARE @teamId INT;

        -- Lấy teamId của user hiện tại
        SELECT @teamId = cv_TeamId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @teamId IS NULL
        BEGIN
          SELECT TOP 0
            t.taskId,
            t.title
          FROM dbo.cv_Tasks t;
          RETURN;
        END

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
            JOIN dbo.Users uA ON uA.userID = a.userID
            WHERE a.taskId = t.taskId
              AND a.isDeleted = 0
              AND uA.cv_TeamId = @teamId
              AND uA.userID <> @userID
              AND (@memberId IS NULL OR uA.userID = @memberId)
          )
          -- ⭐ Logic hiển thị (giống /my):
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
    console.error("tasks/team error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách công việc theo nhóm" });
  }
});

// /api/task-management/team/calendar
router.get("/team/calendar", requireAuth, async (req, res) => {
  try {
    const { range = "week", date, memberId } = req.query;
    if (!date) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu tham số date" });
    }

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("date", sql.Date, date)
      .input("range", sql.NVarChar(10), range)
      .input("memberId", sql.Int, memberId || null)
      .query(`
        DECLARE @d DATE = @date;
        DECLARE @from DATE, @to DATE;
        DECLARE @teamId INT;

        SELECT @teamId = cv_TeamId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @teamId IS NULL
        BEGIN
          SELECT TOP 0
            taskId
          FROM dbo.cv_Tasks;
          RETURN;
        END

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
            
            ISNULL(Atts.attachmentCount, 0) AS attachmentCount

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
            SELECT COUNT(*) AS attachmentCount
            FROM dbo.cv_Attachments at
            WHERE at.taskId = t.taskId
              AND at.isDeleted = 0
          ) Atts

          WHERE t.isDeleted = 0
            AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a 
              JOIN dbo.Users uA ON uA.userID = a.userID
              WHERE a.taskId = t.taskId 
                AND a.isDeleted = 0
                AND uA.cv_TeamId = @teamId
                AND uA.userID <> @userID
                AND (@memberId IS NULL OR uA.userID = @memberId)
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
    console.error("tasks/team/calendar error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải lịch công việc theo nhóm" });
  }
});

// /api/task-management/team/board
router.get("/team/board", requireAuth, async (req, res) => {
  try {
    const { status, priority, search, startDateFilter, memberId } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("status", sql.NVarChar(50), status || null)
      .input("priority", sql.NVarChar(20), priority || null)
      .input("search", sql.NVarChar(200), search || null)
      .input("startDateFilter", sql.Date, startDateFilter || null)
      .input("memberId", sql.Int, memberId || null)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);
        DECLARE @teamId INT;

        SELECT @teamId = cv_TeamId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @teamId IS NULL
        BEGIN
          SELECT TOP 0
            ws.statusId,
            ws.code AS statusCode,
            ws.name AS statusName,
            ws.orderIndex,
            NULL AS taskId
          FROM dbo.cv_WorkflowStatuses ws;
          RETURN;
        END

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

          ISNULL(Atts.attachmentCount, 0) AS attachmentCount

        FROM dbo.cv_WorkflowStatuses ws
        LEFT JOIN dbo.cv_Tasks t
          ON t.statusId = ws.statusId
         AND t.isDeleted = 0
         AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a
              JOIN dbo.Users uA ON uA.userID = a.userID
              WHERE a.taskId = t.taskId
                AND a.isDeleted = 0
                AND uA.cv_TeamId = @teamId
                AND uA.userID <> @userID
                AND (@memberId IS NULL OR uA.userID = @memberId)
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
          attachmentCount: row.attachmentCount || 0,
        });
      }
    }

    res.json({ success: true, data: Array.from(cols.values()) });
  } catch (err) {
    console.error("tasks/team/board error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải board công việc theo nhóm" });
  }
});



//------------------------API theo PHÒNG (department)--------------------

// 1) Danh sách nhóm/tổ trong PHÒNG (bạn đã có)
router.get("/department/teams", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;

    const r = await pool.request()
      .input("userID", sql.Int, req.user.userID)
      .query(`
        DECLARE @deptId INT;

        SELECT @deptId = cv_DepartmentId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @deptId IS NULL
        BEGIN
          SELECT TOP 0
            teamId,
            name AS teamName
          FROM dbo.cv_Teams;
          RETURN;
        END

        SELECT 
          t.teamId,
          t.name AS teamName
        FROM dbo.cv_Teams t
        WHERE t.departmentId = @deptId
          AND ISNULL(t.isDeleted, 0) = 0
        ORDER BY t.name;
      `);

    return res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error("department teams error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách nhóm/tổ trong phòng" });
  }
});

// 2) Danh sách thành viên trong PHÒNG (kèm team)
router.get("/department/members", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;

    const r = await pool.request()
      .input("userID", sql.Int, req.user.userID)
      .query(`
        DECLARE @deptId INT;

        SELECT @deptId = cv_DepartmentId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @deptId IS NULL
        BEGIN
          SELECT TOP 0
            u.userID,
            u.fullName,
            u.userName,
            u.cv_TeamId,
            t.name AS teamName
          FROM dbo.Users u
          LEFT JOIN dbo.cv_Teams t ON t.teamId = u.cv_TeamId;
          RETURN;
        END

        SELECT 
          u.userID,
          u.fullName,
          u.userName,
          u.cv_TeamId,
          t.name AS teamName
        FROM dbo.Users u
        LEFT JOIN dbo.cv_Teams t 
          ON t.teamId = u.cv_TeamId
         AND ISNULL(t.isDeleted, 0) = 0
        WHERE u.cv_DepartmentId = @deptId
          AND u.userID <> @userID
        ORDER BY u.fullName;
      `);

    return res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error("department members error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách thành viên trong phòng" });
  }
});

// 3) List công việc của PHÒNG: /api/task-management/department
router.get("/department", requireAuth, async (req, res) => {
  try {
    const {
      status,
      priority,
      search,
      page = 1,
      pageSize = 20,
      startDateFilter,
      memberId,
      teamId,
    } = req.query;
    
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("status", sql.NVarChar(50), status || null)
      .input("priority", sql.NVarChar(20), priority || null)
      .input("search", sql.NVarChar(200), search || null)
      .input("startDateFilter", sql.Date, startDateFilter || null)
      .input("memberId", sql.Int, memberId || null)
      .input("teamId", sql.Int, teamId || null)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);
        DECLARE @deptId INT;

        -- Lấy phòng ban của user hiện tại
        SELECT @deptId = cv_DepartmentId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @deptId IS NULL
        BEGIN
          SELECT TOP 0
            t.taskId,
            t.title
          FROM dbo.cv_Tasks t;
          RETURN;
        END

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
            JOIN dbo.Users uA ON uA.userID = a.userID
            WHERE a.taskId = t.taskId
              AND a.isDeleted = 0
              AND uA.cv_DepartmentId = @deptId
              AND uA.userID <> @userID
              AND (@teamId   IS NULL OR uA.cv_TeamId = @teamId)
              AND (@memberId IS NULL OR uA.userID    = @memberId)
          )
          -- ⭐ Logic ngày giống /my
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
    console.error("tasks/department error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách công việc theo phòng" });
  }
});

// 4) Lịch công việc của PHÒNG: /api/task-management/department/calendar
router.get("/department/calendar", requireAuth, async (req, res) => {
  try {
    const { range = "week", date, memberId, teamId } = req.query;
    if (!date) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu tham số date" });
    }

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("date", sql.Date, date)
      .input("range", sql.NVarChar(10), range)
      .input("memberId", sql.Int, memberId || null)
      .input("teamId", sql.Int, teamId || null)
      .query(`
        DECLARE @d DATE = @date;
        DECLARE @from DATE, @to DATE;
        DECLARE @deptId INT;

        SELECT @deptId = cv_DepartmentId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @deptId IS NULL
        BEGIN
          SELECT TOP 0
            taskId
          FROM dbo.cv_Tasks;
          RETURN;
        END

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
            
            ISNULL(Atts.attachmentCount, 0) AS attachmentCount

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
            SELECT COUNT(*) AS attachmentCount
            FROM dbo.cv_Attachments at
            WHERE at.taskId = t.taskId
              AND at.isDeleted = 0
          ) Atts

          WHERE t.isDeleted = 0
            AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a 
              JOIN dbo.Users uA ON uA.userID = a.userID
              WHERE a.taskId = t.taskId 
                AND a.isDeleted = 0
                AND uA.cv_DepartmentId = @deptId
                AND uA.userID <> @userID
                AND (@teamId   IS NULL OR uA.cv_TeamId = @teamId)
                AND (@memberId IS NULL OR uA.userID    = @memberId)
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
    console.error("tasks/department/calendar error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải lịch công việc theo phòng" });
  }
});

// 5) Board công việc của PHÒNG: /api/task-management/department/board
router.get("/department/board", requireAuth, async (req, res) => {
  try {
    const { status, priority, search, startDateFilter, memberId, teamId } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("status", sql.NVarChar(50), status || null)
      .input("priority", sql.NVarChar(20), priority || null)
      .input("search", sql.NVarChar(200), search || null)
      .input("startDateFilter", sql.Date, startDateFilter || null)
      .input("memberId", sql.Int, memberId || null)
      .input("teamId", sql.Int, teamId || null)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);
        DECLARE @deptId INT;

        SELECT @deptId = cv_DepartmentId
        FROM dbo.Users
        WHERE userID = @userID;

        IF @deptId IS NULL
        BEGIN
          SELECT TOP 0
            ws.statusId,
            ws.code AS statusCode,
            ws.name AS statusName,
            ws.orderIndex,
            NULL AS taskId
          FROM dbo.cv_WorkflowStatuses ws;
          RETURN;
        END

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

          ISNULL(Atts.attachmentCount, 0) AS attachmentCount

        FROM dbo.cv_WorkflowStatuses ws
        LEFT JOIN dbo.cv_Tasks t
          ON t.statusId = ws.statusId
         AND t.isDeleted = 0
         AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a
              JOIN dbo.Users uA ON uA.userID = a.userID
              WHERE a.taskId = t.taskId
                AND a.isDeleted = 0
                AND uA.cv_DepartmentId = @deptId
                AND uA.userID <> @userID
                AND (@teamId   IS NULL OR uA.cv_TeamId = @teamId)
                AND (@memberId IS NULL OR uA.userID    = @memberId)
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
          attachmentCount: row.attachmentCount || 0,
        });
      }
    }

    res.json({ success: true, data: Array.from(cols.values()) });
  } catch (err) {
    console.error("tasks/department/board error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải board công việc theo phòng" });
  }
});


//-------------API toàn công ty--------------------
// GET /api/task-management/company/departments
router.get("/company/departments", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;

    const r = await pool.request().query(`
      SELECT 
        departmentId,
        name AS departmentName
      FROM dbo.cv_Departments
      WHERE ISNULL(isDeleted, 0) = 0
      ORDER BY name;
    `);

    return res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error("company departments error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách phòng ban" });
  }
});

// GET /api/task-management/company/teams
router.get("/company/teams", requireAuth, async (req, res) => {
  try {
    const { departmentId } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("departmentId", sql.Int, departmentId || null)
      .query(`
        SELECT 
          t.teamId,
          t.name AS teamName,
          t.departmentId AS departmentId
        FROM dbo.cv_Teams t
        WHERE ISNULL(t.isDeleted, 0) = 0
          AND (@departmentId IS NULL OR t.departmentId = @departmentId)
        ORDER BY t.name;
      `);

    return res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error("company teams error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách nhóm/tổ" });
  }
});

// GET /api/task-management/company/members
router.get("/company/members", requireAuth, async (req, res) => {
  try {
    const { departmentId, teamId } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("departmentId", sql.Int, departmentId || null)
      .input("teamId", sql.Int, teamId || null)
      .input("userID", sql.Int, req.user.userID)
      .query(`
        SELECT 
          u.userID,
          u.fullName,
          u.userName,
          u.cv_DepartmentId,
          u.cv_TeamId,
          d.name  AS departmentName,
          t.name  AS teamName
        FROM dbo.Users u
        LEFT JOIN dbo.cv_Departments d
          ON d.departmentId = u.cv_DepartmentId
        LEFT JOIN dbo.cv_Teams t
          ON t.teamId = u.cv_TeamId
        JOIN dbo.UserModules um ON um.userId = u.userID
        JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE m.moduleKey = 'qlcongviec'
          AND ISNULL(u.isDeleted, 0) = 0
          AND (@departmentId IS NULL OR u.cv_DepartmentId = @departmentId)
          AND (@teamId IS NULL OR u.cv_TeamId = @teamId)
          AND u.userID <> @userID
        ORDER BY d.name, t.name, u.fullName;
      `);

    return res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error("company members error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách nhân viên" });
  }
});

// /api/task-management/company
router.get("/company", requireAuth, async (req, res) => {
  try {
    const {
      status,
      priority,
      search,
      page = 1,
      pageSize = 20,
      startDateFilter,
      departmentId,
      teamId,
      memberId,
    } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("status", sql.NVarChar(50), status || null)
      .input("priority", sql.NVarChar(20), priority || null)
      .input("search", sql.NVarChar(200), search || null)
      .input("startDateFilter", sql.Date, startDateFilter || null)
      .input("departmentId", sql.Int, departmentId || null)
      .input("teamId", sql.Int, teamId || null)
      .input("memberId", sql.Int, memberId || null)
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

          -- Thông tin file đính kèm
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
            JOIN dbo.Users uA ON uA.userID = a.userID
            WHERE a.taskId = t.taskId
              AND a.isDeleted = 0
              -- 🔴 BỎ TASK CỦA CHÍNH USER ĐANG ĐĂNG NHẬP
              AND uA.userID <> @userID
              -- 🔎 Lọc theo phòng / nhóm / user (nếu có)
              AND (@departmentId IS NULL OR uA.cv_DepartmentId = @departmentId)
              AND (@teamId IS NULL OR uA.cv_TeamId = @teamId)
              AND (@memberId IS NULL OR uA.userID = @memberId)
          )
          -- logic ngày bắt đầu giống /my
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
    console.error("tasks/company error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách công việc toàn công ty" });
  }
});

// /api/task-management/company/calendar
router.get("/company/calendar", requireAuth, async (req, res) => {
  try {
    const { range = "week", date, departmentId, teamId, memberId } = req.query;
    if (!date) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu tham số date" });
    }

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("date", sql.Date, date)
      .input("range", sql.NVarChar(10), range)
      .input("departmentId", sql.Int, departmentId || null)
      .input("teamId", sql.Int, teamId || null)
      .input("memberId", sql.Int, memberId || null)
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
            
            ISNULL(Atts.attachmentCount, 0) AS attachmentCount

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
            SELECT COUNT(*) AS attachmentCount
            FROM dbo.cv_Attachments at
            WHERE at.taskId = t.taskId
              AND at.isDeleted = 0
          ) Atts

          WHERE t.isDeleted = 0
            AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a 
              JOIN dbo.Users uA ON uA.userID = a.userID
              WHERE a.taskId = t.taskId 
                AND a.isDeleted = 0
                -- 🔴 BỎ TASK CỦA CHÍNH USER
                AND uA.userID <> @userID
                -- lọc theo phòng / nhóm / user nếu có
                AND (@departmentId IS NULL OR uA.cv_DepartmentId = @departmentId)
                AND (@teamId IS NULL OR uA.cv_TeamId = @teamId)
                AND (@memberId IS NULL OR uA.userID = @memberId)
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
    console.error("tasks/company/calendar error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải lịch công việc toàn công ty" });
  }
});

// /api/task-management/company/board
router.get("/company/board", requireAuth, async (req, res) => {
  try {
    const { status, priority, search, startDateFilter, departmentId, teamId, memberId } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("status", sql.NVarChar(50), status || null)
      .input("priority", sql.NVarChar(20), priority || null)
      .input("search", sql.NVarChar(200), search || null)
      .input("startDateFilter", sql.Date, startDateFilter || null)
      .input("departmentId", sql.Int, departmentId || null)
      .input("teamId", sql.Int, teamId || null)
      .input("memberId", sql.Int, memberId || null)
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

          ISNULL(Atts.attachmentCount, 0) AS attachmentCount

        FROM dbo.cv_WorkflowStatuses ws
        LEFT JOIN dbo.cv_Tasks t
          ON t.statusId = ws.statusId
         AND t.isDeleted = 0
         AND EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a
              JOIN dbo.Users uA ON uA.userID = a.userID
              WHERE a.taskId = t.taskId
                AND a.isDeleted = 0
                -- 🔴 BỎ TASK CỦA CHÍNH USER
                AND uA.userID <> @userID
                AND (@departmentId IS NULL OR uA.cv_DepartmentId = @departmentId)
                AND (@teamId IS NULL OR uA.cv_TeamId = @teamId)
                AND (@memberId IS NULL OR uA.userID = @memberId)
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
          attachmentCount: row.attachmentCount || 0,
        });
      }
    }

    res.json({ success: true, data: Array.from(cols.values()) });
  } catch (err) {
    console.error("tasks/company/board error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải board công việc toàn công ty" });
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
          uCreator.fullName  AS createdByName,
          uCreator.userName  AS createdByUserName,
          t.createdAt,

          t.updatedBy,
          uUpdater.fullName  AS updatedByName,
          uUpdater.userName  AS updatedByUserName,
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
        -- 👇 thêm join user đang đăng nhập để biết phòng ban
        LEFT JOIN dbo.Users uReq
          ON uReq.userID = @userID
        WHERE t.isDeleted = 0
          AND t.taskId = @taskId
          AND (
            -- 1) user là NGƯỜI ĐƯỢC GIAO
            EXISTS (
              SELECT 1 
              FROM dbo.cv_TaskAssignees a
              WHERE a.taskId = t.taskId 
                AND a.userID = @userID
                AND a.isDeleted = 0
            )
            -- 2) HOẶC user là NGƯỜI TẠO
            OR t.createdBy = @userID
            -- 3) HOẶC user là QUẢN LÝ cùng phòng với người tạo
            OR (
              uCreator.cv_DepartmentId IS NOT NULL
              AND uReq.cv_DepartmentId = uCreator.cv_DepartmentId
              AND EXISTS (
                SELECT 1
                FROM dbo.cv_UserRoles ur
                JOIN dbo.cv_Roles r 
                  ON r.roleId = ur.roleId
                 AND ISNULL(r.isDeleted, 0) = 0
                WHERE ur.userId = @userID
                  AND ISNULL(ur.isDeleted, 0) = 0
                  AND r.code IN ('truongphong', 'phophong', 'totruong', 'bangiamdoc', 'giamdocnhamay')
              )
            )
              -- 4) HOẶC user là CẤP CÔNG TY (ban giám đốc / giám đốc nhà máy)
            OR EXISTS (
              SELECT 1
              FROM dbo.cv_UserRoles ur
              JOIN dbo.cv_Roles r 
                ON r.roleId = ur.roleId
               AND ISNULL(r.isDeleted, 0) = 0
              WHERE ur.userId = @userID
                AND ISNULL(ur.isDeleted, 0) = 0
                AND r.code IN ('bangiamdoc', 'giamdocnhamay')
            )
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
          uploadedAt,
          createdBy
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

//-------------------------QUẢN LÝ DỰ ÁN-------------------------

// GET /api/task-management/projects/my
router.get("/projects/my", requireAuth, async (req, res) => {
  try {
    const {
      status,    // active|done|hold|cancel
      search,
      page = 1,
      pageSize = 20,
    } = req.query;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("userID", sql.Int, req.user.userID)
      .input("status", sql.NVarChar(50), status || null)
      .input("search", sql.NVarChar(200), search || null)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);

        ;WITH ProjectBase AS (
          SELECT
            p.projectId,
            p.code,
            p.name,
            p.description,
            p.scope,        -- department|multi|company
            p.startDate,
            p.dueDate,
            p.status,       -- active|done|hold|cancel
            p.createdAt,
            p.createdBy,

            uCreator.fullName AS createdByName,
            uCreator.userName AS createdByUserName,

            ownerDept.name    AS ownerDepartmentName,

            pm.projectRoleId,
            pr.name           AS projectRoleName,
            pr.isManagerial   AS isManagerialRole
          FROM dbo.cv_Projects p
          LEFT JOIN dbo.cv_ProjectMemberships pm
            ON pm.projectId = p.projectId
           AND pm.isDeleted = 0
           AND pm.userId    = @userID
          LEFT JOIN dbo.cv_ProjectRoles pr
            ON pr.projectRoleId = pm.projectRoleId
           AND pr.isDeleted = 0
          LEFT JOIN dbo.Users uCreator
            ON uCreator.userID = p.createdBy
          LEFT JOIN dbo.cv_ProjectDepartments pd
            ON pd.projectId   = p.projectId
           AND pd.isDeleted   = 0
           AND pd.roleInOrg   = N'owner'
          LEFT JOIN dbo.cv_Departments ownerDept
            ON ownerDept.departmentId = pd.departmentId
          WHERE p.isDeleted = 0
            -- user tham gia (membership) hoặc là người tạo
            AND (
              pm.userId IS NOT NULL
              OR p.createdBy = @userID
            )
            AND (@status IS NULL OR p.status = @status)
            AND (
              @search IS NULL
              OR p.name LIKE N'%' + @search + N'%'
              OR p.code LIKE N'%' + @search + N'%'
            )
        )
        SELECT 
          pb.*,
          ISNULL(stat.totalTasks,   0) AS totalTasks,
          ISNULL(stat.openTasks,    0) AS openTasks,
          ISNULL(stat.doneTasks,    0) AS doneTasks,
          ISNULL(stat.overdueTasks, 0) AS overdueTasks
        FROM ProjectBase pb
        OUTER APPLY (
          SELECT
            COUNT(*) AS totalTasks,
            SUM(CASE WHEN ws.code = N'done' THEN 1 ELSE 0 END) AS doneTasks,
            SUM(CASE WHEN ws.code <> N'done' THEN 1 ELSE 0 END) AS openTasks,
            SUM(CASE WHEN ws.code <> N'done'
                     AND t.dueDate < @today THEN 1 ELSE 0 END) AS overdueTasks
          FROM dbo.cv_Tasks t
          JOIN dbo.cv_WorkflowStatuses ws
            ON ws.statusId = t.statusId
           AND ws.isDeleted = 0
          WHERE t.isDeleted = 0
            AND t.projectId = pb.projectId
        ) stat
        ORDER BY 
          CASE 
            WHEN pb.status = N'active' THEN 1
            WHEN pb.status = N'hold'   THEN 2
            WHEN pb.status = N'done'   THEN 3
            WHEN pb.status = N'cancel' THEN 4
            ELSE 5
          END,
          ISNULL(pb.dueDate, '9999-12-31'),
          pb.projectId;
      `);

    const all = r.recordset || [];
    const p  = +page || 1;
    const ps = +pageSize || 20;
    const slice = all.slice((p - 1) * ps, p * ps);

    return res.json({
      success: true,
      data: slice,
      totalRows: all.length,
    });
  } catch (err) {
    console.error("projects/my error:", err);
    res
      .status(500)
      .json({ success: false, message: "Lỗi tải danh sách dự án" });
  }
});

// GET /api/task-management/projects/lookup
router.get('/projects/lookup', requireAuth, async (req, res) => {
  try {
    const { q = '' } = req.query;

    const pool = await poolPromise;
    const r = await pool.request()
      .input('userId', sql.Int, req.user.userID)
      .input('q', sql.NVarChar(200), q || '')
      .query(`
        SELECT DISTINCT
          p.projectId,
          p.code,
          p.name,
          p.status
        FROM dbo.cv_Projects p
        LEFT JOIN dbo.cv_ProjectMemberships pm
          ON pm.projectId = p.projectId
         AND ISNULL(pm.isDeleted,0) = 0
        WHERE p.isDeleted = 0
          AND p.status IN (N'active', N'hold')   -- ưu tiên dự án đang chạy / tạm dừng
          AND (
            -- user là thành viên dự án
            pm.userId = @userId
            -- hoặc là người tạo
            OR p.createdBy = @userId
          )
          AND (
            @q = N''
            OR p.name LIKE N'%' + @q + N'%'
            OR p.code LIKE N'%' + @q + N'%'
          )
        ORDER BY p.name;
      `);

    res.json({
      success: true,
      data: (r.recordset || []).map(p => ({
        projectId: p.projectId,
        code: p.code,
        name: p.name,
        status: p.status,
        label: `${p.name} (${p.code})`,
      })),
    });
  } catch (err) {
    console.error('projects/lookup error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tải danh sách dự án' });
  }
});

// Ví dụ đầu file đã có:
// const express = require("express");
// const router = express.Router();
// const sql = require("mssql");
// const { poolPromise } = require("../db");
// const { requireAuth } = require("../middlewares/auth");

// ======================= LOOKUP PHÒNG BAN (cho Tạo dự án) =======================
router.get("/departments/lookup", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT departmentId, name, code
      FROM dbo.cv_Departments
      WHERE isDeleted = 0
      ORDER BY ISNULL(orderIndex, 9999), name;
    `);

    res.json({
      success: true,
      data: (r.recordset || []).map((d) => ({
        departmentId: d.departmentId,
        name: d.name,
        code: d.code,
        label: d.code ? `${d.code} - ${d.name}` : d.name,
      })),
    });
  } catch (err) {
    console.error("departments/lookup error:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi tải danh sách phòng ban",
    });
  }
});

// ======================= TẠO DỰ ÁN =======================
router.post("/projects", requireAuth, async (req, res) => {
  const {
    code,
    name,
    description,
    scope, // 'department' | 'multi' | 'company'
    startDate,
    dueDate,
    ownerDepartmentId, // phòng chính
  } = req.body;

  if (!code || !code.trim()) {
    return res
      .status(400)
      .json({ success: false, message: "Mã dự án là bắt buộc." });
  }
  if (!name || !name.trim()) {
    return res
      .status(400)
      .json({ success: false, message: "Tên dự án là bắt buộc." });
  }
  if (!scope || !["department", "multi", "company"].includes(scope)) {
    return res.status(400).json({
      success: false,
      message: "Scope dự án không hợp lệ.",
    });
  }
  if (scope !== "company" && !ownerDepartmentId) {
    return res.status(400).json({
      success: false,
      message: "Vui lòng chọn phòng chính cho dự án.",
    });
  }

  try {
    const pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    const creatorId = req.user.userID;

    // ---- 1) Insert cv_Projects ----
    const reqProj = new sql.Request(tx);
    const rProj = await reqProj
      .input("code", sql.NVarChar(100), code.trim())
      .input("name", sql.NVarChar(300), name.trim())
      .input("description", sql.NVarChar(sql.MAX), description || null)
      .input("scope", sql.NVarChar(20), scope)
      .input("startDate", sql.Date, startDate || null)
      .input("dueDate", sql.Date, dueDate || null)
      .input("createdBy", sql.Int, creatorId)
      .query(`
        INSERT INTO dbo.cv_Projects
        (
          code, name, description, scope,
          startDate, dueDate,
          status,
          createdBy
        )
        OUTPUT INSERTED.projectId
        VALUES
        (
          @code, @name, @description, @scope,
          @startDate, @dueDate,
          N'active',
          @createdBy
        );
      `);

    const newProjectId = rProj.recordset[0].projectId;

    // ---- 2) Gắn phòng chính vào cv_ProjectDepartments (nếu có) ----
    if (scope !== "company" && ownerDepartmentId) {
      const reqPD = new sql.Request(tx);
      await reqPD
        .input("projectId", sql.Int, newProjectId)
        .input("departmentId", sql.Int, ownerDepartmentId)
        .input("createdBy", sql.Int, creatorId)
        .query(`
          INSERT INTO dbo.cv_ProjectDepartments
          (
            projectId,
            departmentId,
            roleInOrg,
            isDeleted,
            createdBy,
            createdAt
          )
          VALUES
          (
            @projectId,
            @departmentId,
            N'owner',
            0,
            @createdBy,
            SYSUTCDATETIME()
          );
        `);
    }

    // ---- 3) Gắn người tạo vào cv_ProjectMemberships (nếu có role quản lý) ----
    const reqRole = new sql.Request(tx);
    const rRole = await reqRole.query(`
      SELECT TOP 1 projectRoleId
      FROM dbo.cv_ProjectRoles
      WHERE isDeleted = 0
        AND (code = N'OWNER' OR isManagerial = 1)
      ORDER BY CASE WHEN code = N'OWNER' THEN 0 ELSE 1 END,
               projectRoleId;
    `);

    if (rRole.recordset.length) {
      const projectRoleId = rRole.recordset[0].projectRoleId;
      const reqMem = new sql.Request(tx);
      await reqMem
        .input("projectId", sql.Int, newProjectId)
        .input("userId", sql.Int, creatorId)
        .input("projectRoleId", sql.Int, projectRoleId)
        .input("createdBy", sql.Int, creatorId)
        .query(`
          INSERT INTO dbo.cv_ProjectMemberships
          (
            projectId,
            userId,
            projectRoleId,
            joinedAt,
            note,
            isDeleted,
            createdBy,
            createdAt
          )
          VALUES
          (
            @projectId,
            @userId,
            @projectRoleId,
            SYSUTCDATETIME(),
            NULL,
            0,
            @createdBy,
            SYSUTCDATETIME()
          );
        `);
    }

    await tx.commit();

    res.json({
      success: true,
      data: { projectId: newProjectId },
    });
  } catch (err) {
    console.error("create project error:", err);
    try {
      if (tx) await tx.rollback();
    } catch (e) {}
    // Nếu lỗi unique code
    if (err && err.number === 2601) {
      return res.status(400).json({
        success: false,
        message: "Mã dự án đã tồn tại (chưa bị xoá).",
      });
    }

    res.status(500).json({
      success: false,
      message: "Lỗi tạo dự án.",
    });
  }
});


async function checkProjectAccess(pool, projectId, userID) {
  const r = await pool
    .request()
    .input("projectId", sql.Int, projectId)
    .input("userID", sql.Int, userID)
    .query(`
      SELECT 1
      FROM dbo.cv_Projects p
      LEFT JOIN dbo.cv_ProjectDepartments pd
        ON pd.projectId = p.projectId
       AND ISNULL(pd.isDeleted,0) = 0
       AND pd.roleInOrg = N'owner'
      LEFT JOIN dbo.cv_Departments dOwner
        ON dOwner.departmentId = pd.departmentId
      LEFT JOIN dbo.Users uReq
        ON uReq.userID = @userID
      WHERE p.projectId = @projectId
        AND ISNULL(p.isDeleted,0) = 0
        AND (
          -- 1) Là thành viên dự án
          EXISTS (
            SELECT 1
            FROM dbo.cv_ProjectMemberships pm
            WHERE pm.projectId = p.projectId
              AND pm.userId = @userID
              AND ISNULL(pm.isDeleted,0) = 0
          )
          -- 2) Là người tạo dự án
          OR p.createdBy = @userID
          -- 3) Quản lý cùng phòng với phòng owner
          OR (
            uReq.cv_DepartmentId = dOwner.departmentId
            AND EXISTS (
              SELECT 1
              FROM dbo.cv_UserRoles ur
              JOIN dbo.cv_Roles r
                ON r.roleId = ur.roleId
               AND ISNULL(r.isDeleted,0) = 0
              WHERE ur.userId = @userID
                AND ISNULL(ur.isDeleted,0) = 0
                AND r.code IN (
                  'truongphong','phophong','totruong',
                  'bangiamdoc','giamdocnhamay'
                )
            )
          )
          -- 4) Ban giám đốc / Giám đốc nhà máy (full quyền)
          OR EXISTS (
            SELECT 1
            FROM dbo.cv_UserRoles ur
            JOIN dbo.cv_Roles r
              ON r.roleId = ur.roleId
             AND ISNULL(r.isDeleted,0) = 0
            WHERE ur.userId = @userID
              AND ISNULL(ur.isDeleted,0) = 0
              AND r.code IN ('bangiamdoc','giamdocnhamay')
          )
        );
    `);

  return r.recordset.length > 0;
}

// GET /api/task-management/projects/:projectId/overview
// routes/taskManagement/projects.js (ví dụ)
router.get('/:projectId/overview', requireAuth, async (req, res) => {
  try {
    const projectId = +req.params.projectId;
    const userId = req.user.userID;

    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'projectId không hợp lệ' });
    }

    const pool = await poolPromise;

    // 1) Lấy thông tin dự án
    const rProject = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT 
          p.projectId,
          p.name,
          p.code,
          p.status,
          p.scope,
          p.description,
          p.startDate,
          p.dueDate,
          p.createdAt,
          p.createdBy,
          d.name AS ownerDepartmentName
        FROM dbo.cv_Projects p
        LEFT JOIN dbo.cv_Departments d
          ON d.departmentId = p.ownerDepartmentId
        WHERE p.projectId = @projectId
          AND ISNULL(p.isDeleted, 0) = 0;
      `);

    if (!rProject.recordset.length) {
      return res
        .status(404)
        .json({ success: false, message: 'Không tìm thấy dự án' });
    }

    const project = rProject.recordset[0];

    // 2) Vai trò của user trong dự án
    const rMyRole = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .input('userId', sql.Int, userId)
      .query(`
        SELECT TOP 1
          m.projectRoleId,
          pr.name AS projectRoleName,
          pr.code,
          pr.isManagerial AS isManagerialRole
        FROM dbo.cv_ProjectMemberships m
        JOIN dbo.cv_ProjectRoles pr
          ON pr.projectRoleId = m.projectRoleId
         AND ISNULL(pr.isDeleted, 0) = 0
        WHERE m.projectId = @projectId
          AND m.userId   = @userId
          AND ISNULL(m.isDeleted, 0) = 0
        ORDER BY pr.isManagerial DESC, pr.name;
      `);

    const myRole = rMyRole.recordset[0] || null;

    // 3) Danh sách thành viên
    const rMembers = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT 
          m.userId,
          u.fullName,
          u.userName,
          d.name AS departmentName,
          t.name AS teamName,
          pr.name AS projectRoleName,
          pr.isManagerial AS isManagerialRole
        FROM dbo.cv_ProjectMemberships m
        JOIN dbo.Users u
          ON u.userID = m.userId
         AND ISNULL(u.isDeleted, 0) = 0
        LEFT JOIN dbo.cv_Departments d
          ON d.departmentId = u.cv_DepartmentId
        LEFT JOIN dbo.cv_Teams t
          ON t.teamId = u.cv_TeamId
        LEFT JOIN dbo.cv_ProjectRoles pr
          ON pr.projectRoleId = m.projectRoleId
         AND ISNULL(pr.isDeleted, 0) = 0
        WHERE m.projectId = @projectId
          AND ISNULL(m.isDeleted, 0) = 0
        ORDER BY pr.isManagerial DESC, u.fullName;
      `);

    const members = rMembers.recordset;

    // 4) Thống kê task
    const rTaskStats = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          COUNT(*) AS totalTasks,
          SUM(CASE WHEN s.code = 'done' THEN 1 ELSE 0 END)       AS doneTasks,
          SUM(CASE WHEN s.code <> 'done' THEN 1 ELSE 0 END)      AS openTasks,
          SUM(CASE WHEN t.dueDate < CAST(GETDATE() AS DATE) 
                     AND s.code <> 'done' THEN 1 ELSE 0 END)     AS overdueTasks
        FROM dbo.cv_Tasks t
        JOIN dbo.cv_TaskStatusCatalog s
          ON s.statusId = t.statusId
        WHERE t.projectId = @projectId
          AND ISNULL(t.isDeleted, 0) = 0;
      `);

    const taskStats = rTaskStats.recordset[0] || {
      totalTasks: 0,
      doneTasks: 0,
      openTasks: 0,
      overdueTasks: 0,
    };

    // 5) Task gần đây
    const rRecentTasks = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT TOP 30
          t.taskId,
          t.title,
          t.dueDate,
          t.priority,
          t.progressPercent,
          s.name AS statusName,
          s.code AS statusCode
        FROM dbo.cv_Tasks t
        JOIN dbo.cv_TaskStatusCatalog s
          ON s.statusId = t.statusId
        WHERE t.projectId = @projectId
          AND ISNULL(t.isDeleted, 0) = 0
        ORDER BY t.createdAt DESC;
      `);

    const recentTasks = rRecentTasks.recordset;

    // 6) Thời gian log (ví dụ từ cv_TimeLogs)
    const rTimeSummary = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          ISNULL(SUM(l.minutesWorked), 0) AS totalMinutes
        FROM dbo.cv_TimeLogs l
        WHERE l.projectId = @projectId
          AND ISNULL(l.isDeleted, 0) = 0;

        SELECT TOP 5
          l.userId,
          u.fullName,
          u.userName,
          SUM(l.minutesWorked) AS minutesWorked
        FROM dbo.cv_TimeLogs l
        JOIN dbo.Users u
          ON u.userID = l.userId
        WHERE l.projectId = @projectId
          AND ISNULL(l.isDeleted, 0) = 0
        GROUP BY l.userId, u.fullName, u.userName
        ORDER BY SUM(l.minutesWorked) DESC;
      `);

    const totalMinutes = rTimeSummary.recordsets?.[0]?.[0]?.totalMinutes || 0;
    const topUsers = rTimeSummary.recordsets?.[1] || [];

    const timeSummary = {
      totalMinutes,
      topUsers,
    };

    // 7) File summary (nếu cần)
    const rFileSummary = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          COUNT(*) AS totalFiles,
          ISNULL(SUM(f.fileSize), 0) AS totalSize
        FROM dbo.cv_ProjectFiles f
        WHERE f.projectId = @projectId
          AND ISNULL(f.isDeleted, 0) = 0;
      `);

    const fileSummary = rFileSummary.recordset[0] || null;

    // 8) Chat summary (ví dụ)
    const rChatSummary = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          COUNT(*) AS totalMessages
        FROM dbo.cv_ProjectChatMessages c
        WHERE c.projectId = @projectId
          AND ISNULL(c.isDeleted, 0) = 0;
      `);

    const chatSummary = rChatSummary.recordset[0] || { totalMessages: 0 };

    // 9) Trả về
    return res.json({
      success: true,
      data: {
        project,
        myRole,
        members,
        taskStats,
        recentTasks,
        timeSummary,
        fileSummary,
        chatSummary,
      },
    });
  } catch (err) {
    console.error('GET /:projectId/overview error:', err);
    res.status(500).json({
      success: false,
      message: 'Lỗi tải overview dự án',
    });
  }
});

// GET /api/task-management/projects/:projectId/files
router.get("/:projectId/files", requireAuth, async (req, res) => {
  try {
    const projectId = +req.params.projectId;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "projectId không hợp lệ" });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    const canView = await checkProjectAccess(pool, projectId, userID);
    if (!canView) {
      return res
        .status(403)
        .json({ success: false, message: "Bạn không có quyền xem tệp của dự án này" });
    }

    const r = await pool.request()
      .input("projectId", sql.Int, projectId)
      .query(`
        SELECT 
          pf.pfileId,
          pf.fileName,
          pf.mimeType,
          pf.fileSize,
          pf.storagePath,
          pf.uploadedBy,
          u.fullName AS uploadedByName,
          u.userName AS uploadedByUserName,
          pf.uploadedAt
        FROM dbo.cv_ProjectFiles pf
        LEFT JOIN dbo.Users u
          ON u.userID = pf.uploadedBy
        WHERE pf.projectId = @projectId
          AND ISNULL(pf.isDeleted,0) = 0
        ORDER BY pf.uploadedAt DESC;
      `);

    return res.json({
      success: true,
      data: r.recordset,
    });
  } catch (err) {
    console.error("list project files error:", err);
    res.status(500).json({ success: false, message: "Lỗi tải danh sách tệp" });
  }
});

// POST /api/task-management/projects/:projectId/files
router.post(
  "/:projectId/files",
  requireAuth,
  upload.array("files", 10),
  async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res
          .status(400)
          .json({ success: false, message: "projectId không hợp lệ" });
      }

      if (!req.files || !req.files.length) {
        return res
          .status(400)
          .json({ success: false, message: "Không có file nào được gửi lên" });
      }

      const pool = await poolPromise;
      const userID = req.user.userID;

      const canView = await checkProjectAccess(pool, projectId, userID);
      if (!canView) {
        return res.status(403).json({
          success: false,
          message: "Bạn không có quyền thêm tệp cho dự án này",
        });
      }

      const uploadedBy = userID;
      const bucket = process.env.AWS_S3_BUCKET;

      const results = [];

      for (const file of req.files) {
        const originalName = toUtf8FileName(file.originalname);

        const key = `projects/${projectId}/${Date.now()}-${Math.random()
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

        const rIns = await pool.request()
          .input("projectId", sql.Int, projectId)
          .input("taskId", sql.Int, null) // nếu sau này muốn gắn taskId thì set
          .input("fileName", sql.NVarChar(500), originalName)
          .input("mimeType", sql.NVarChar(200), file.mimetype)
          .input("fileSize", sql.BigInt, file.size)
          .input("storagePath", sql.NVarChar(1000), key)
          .input("uploadedBy", sql.Int, uploadedBy)
          .query(`
            INSERT INTO dbo.cv_ProjectFiles
              (projectId, taskId, fileName, storagePath, mimeType, fileSize,
               uploadedBy, uploadedAt, isDeleted, createdBy, createdAt)
            OUTPUT INSERTED.pfileId, INSERTED.fileName, INSERTED.mimeType,
                   INSERTED.fileSize, INSERTED.storagePath, INSERTED.uploadedAt
            VALUES
              (@projectId, @taskId, @fileName, @storagePath, @mimeType, @fileSize,
               @uploadedBy, GETDATE(), 0, @uploadedBy, GETDATE());
          `);

        const row = rIns.recordset[0];
        row.fileName = originalName;
        results.push(row);
      }

      return res.json({
        success: true,
        message: "Tải tệp lên thành công",
        data: results,
      });
    } catch (err) {
      console.error("upload project files error:", err);
      res
        .status(500)
        .json({ success: false, message: "Lỗi tải tệp cho dự án" });
    }
  }
);

// DELETE /api/task-management/projects/files/:pfileId
router.delete("/files/:pfileId", requireAuth, async (req, res) => {
  try {
    const pfileId = +req.params.pfileId;
    if (!Number.isFinite(pfileId) || pfileId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "pfileId không hợp lệ" });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    const rCheck = await pool.request()
      .input("pfileId", sql.Int, pfileId)
      .input("userID", sql.Int, userID)
      .query(`
        SELECT TOP 1
          pf.pfileId,
          pf.projectId,
          pf.uploadedBy,
          p.createdBy,
          uReq.userID AS reqUserId
        FROM dbo.cv_ProjectFiles pf
        JOIN dbo.cv_Projects p
          ON p.projectId = pf.projectId
         AND ISNULL(p.isDeleted,0) = 0
        LEFT JOIN dbo.Users uReq
          ON uReq.userID = @userID
        WHERE pf.pfileId = @pfileId
          AND ISNULL(pf.isDeleted,0) = 0
          AND (
            -- 1) là người upload
            pf.uploadedBy = @userID
            -- 2) hoặc là người tạo dự án
            OR p.createdBy = @userID
            -- 3) hoặc là member quản lý trong dự án
            OR EXISTS (
              SELECT 1
              FROM dbo.cv_ProjectMemberships pm
              JOIN dbo.cv_ProjectRoles pr
                ON pr.projectRoleId = pm.projectRoleId
               AND ISNULL(pr.isDeleted,0) = 0
              WHERE pm.projectId = pf.projectId
                AND pm.userId = @userID
                AND ISNULL(pm.isDeleted,0) = 0
                AND pr.isManagerial = 1
            )
            -- 4) hoặc là ban giám đốc
            OR EXISTS (
              SELECT 1
              FROM dbo.cv_UserRoles ur
              JOIN dbo.cv_Roles r
                ON r.roleId = ur.roleId
               AND ISNULL(r.isDeleted,0) = 0
              WHERE ur.userId = @userID
                AND ISNULL(ur.isDeleted,0) = 0
                AND r.code IN ('bangiamdoc','giamdocnhamay')
            )
          );
      `);

    if (!rCheck.recordset.length) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy tệp hoặc bạn không có quyền xoá.",
      });
    }

    await pool.request()
      .input("pfileId", sql.Int, pfileId)
      .input("userID", sql.Int, userID)
      .query(`
        UPDATE dbo.cv_ProjectFiles
        SET isDeleted = 1,
            deletedBy = @userID,
            deletedAt = GETDATE()
        WHERE pfileId = @pfileId
          AND ISNULL(isDeleted,0) = 0;
      `);

    return res.json({ success: true, message: "Đã xoá tệp (soft delete)" });
  } catch (err) {
    console.error("delete project file error:", err);
    res.status(500).json({ success: false, message: "Lỗi xoá tệp dự án" });
  }
});

// GET /api/task-management/projects/files/:pfileId/download
router.get("/files/:pfileId/download", requireAuth, async (req, res) => {
  try {
    const pfileId = +req.params.pfileId;
    if (!Number.isFinite(pfileId) || pfileId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "pfileId không hợp lệ" });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    const r = await pool.request()
      .input("pfileId", sql.Int, pfileId)
      .input("userID", sql.Int, userID)
      .query(`
        SELECT TOP 1
          pf.pfileId,
          pf.projectId,
          pf.fileName,
          pf.mimeType,
          pf.storagePath
        FROM dbo.cv_ProjectFiles pf
        JOIN dbo.cv_Projects p
          ON p.projectId = pf.projectId
         AND ISNULL(p.isDeleted,0) = 0
        WHERE pf.pfileId = @pfileId
          AND ISNULL(pf.isDeleted,0) = 0
          AND (
            -- dùng lại logic checkProjectAccess
            EXISTS (
              SELECT 1
              FROM dbo.cv_ProjectMemberships pm
              WHERE pm.projectId = pf.projectId
                AND pm.userId = @userID
                AND ISNULL(pm.isDeleted,0) = 0
            )
            OR p.createdBy = @userID
            OR EXISTS (
              SELECT 1
              FROM dbo.cv_UserRoles ur
              JOIN dbo.cv_Roles r
                ON r.roleId = ur.roleId
               AND ISNULL(r.isDeleted,0) = 0
              WHERE ur.userId = @userID
                AND ISNULL(ur.isDeleted,0) = 0
                AND r.code IN (
                  'truongphong','phophong','totruong',
                  'bangiamdoc','giamdocnhamay'
                )
            )
          );
      `);

    if (!r.recordset.length) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy tệp hoặc bạn không có quyền",
      });
    }

    const att = r.recordset[0];

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
    console.error("download project file error:", err);
    res.status(500).json({ success: false, message: "Lỗi tải tệp dự án" });
  }
});

/* ======================
   Helper: check quyền dự án
   ====================== */
async function ensureProjectAccess(pool, projectId, userID) {
  const r = await pool
    .request()
    .input('projectId', sql.Int, projectId)
    .input('userID', sql.Int, userID)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM dbo.cv_Projects p
      LEFT JOIN dbo.cv_ProjectMemberships m
        ON m.projectId = p.projectId
       AND ISNULL(m.isDeleted, 0) = 0
      WHERE p.projectId = @projectId
        AND ISNULL(p.isDeleted, 0) = 0
        AND (
          p.createdBy = @userID
          OR m.userId = @userID
          OR EXISTS (
            SELECT 1
            FROM dbo.cv_UserRoles ur
            JOIN dbo.cv_Roles r
              ON r.roleId = ur.roleId
             AND ISNULL(r.isDeleted, 0) = 0
            WHERE ur.userId = @userID
              AND ISNULL(ur.isDeleted, 0) = 0
              AND r.code IN ('bangiamdoc', 'giamdocnhamay', 'truongphong', 'phophong')
          )
        );
    `);

  return r.recordset.length > 0;
}

/* ======================
   1) OVERVIEW DỰ ÁN
   GET /:projectId/overview
   ====================== */
router.get('/:projectId/overview', requireAuth, async (req, res) => {
  try {
    const projectId = +req.params.projectId;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    // check quyền
    const ok = await ensureProjectAccess(pool, projectId, userID);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền xem dự án này',
      });
    }

    // 1. Thông tin dự án + ownerDepartment
    const rProject = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          p.*,
          od.ownerDepartmentName
        FROM dbo.cv_Projects p
        OUTER APPLY (
          SELECT TOP 1 d.name AS ownerDepartmentName
          FROM dbo.cv_ProjectDepartments pd
          JOIN dbo.cv_Departments d
            ON d.departmentId = pd.departmentId
           AND ISNULL(d.isDeleted, 0) = 0
          WHERE pd.projectId = p.projectId
            AND ISNULL(pd.isDeleted, 0) = 0
            AND pd.roleInOrg = 'owner'
        ) od
        WHERE p.projectId = @projectId
          AND ISNULL(p.isDeleted, 0) = 0;
      `);

    if (!rProject.recordset.length) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy dự án' });
    }
    const project = rProject.recordset[0];

    // 2. Vai trò của mình trong dự án
    const rMyRole = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .input('userID', sql.Int, userID)
      .query(`
        SELECT TOP 1
          m.projectId,
          m.userId,
          m.projectRoleId,
          r.name AS projectRoleName,
          r.isManagerial AS isManagerialRole
        FROM dbo.cv_ProjectMemberships m
        JOIN dbo.cv_ProjectRoles r
          ON r.projectRoleId = m.projectRoleId
         AND ISNULL(r.isDeleted, 0) = 0
        WHERE m.projectId = @projectId
          AND m.userId = @userID
          AND ISNULL(m.isDeleted, 0) = 0;
      `);

    const myRole = rMyRole.recordset[0] || null;

    // 3. Thành viên dự án
    const rMembers = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          m.userId,
          u.fullName,
          u.userName,
          d.name AS departmentName,
          t.name AS teamName,
          pr.name AS projectRoleName,
          pr.isManagerial AS isManagerialRole
        FROM dbo.cv_ProjectMemberships m
        JOIN dbo.Users u
          ON u.userID = m.userId
        LEFT JOIN dbo.cv_Departments d
          ON d.departmentId = u.cv_DepartmentId
        LEFT JOIN dbo.cv_Teams t
          ON t.teamId = u.cv_TeamId
        JOIN dbo.cv_ProjectRoles pr
          ON pr.projectRoleId = m.projectRoleId
         AND ISNULL(pr.isDeleted, 0) = 0
        WHERE m.projectId = @projectId
          AND ISNULL(m.isDeleted, 0) = 0
        ORDER BY pr.isManagerial DESC, u.fullName;
      `);

    const members = rMembers.recordset || [];

    // 4. Thống kê task
    const rTaskStats = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);

        SELECT
          COUNT(*) AS totalTasks,
          SUM(CASE WHEN ws.code = 'done' THEN 1 ELSE 0 END) AS doneTasks,
          SUM(CASE WHEN ws.code <> 'done' THEN 1 ELSE 0 END) AS openTasks,
          SUM(
            CASE 
              WHEN ws.code <> 'done'
               AND t.dueDate IS NOT NULL
               AND t.dueDate < @today
              THEN 1 ELSE 0
            END
          ) AS overdueTasks
        FROM dbo.cv_Tasks t
        JOIN dbo.cv_WorkflowStatuses ws
          ON ws.statusId = t.statusId
         AND ISNULL(ws.isDeleted, 0) = 0
        WHERE t.projectId = @projectId
          AND ISNULL(t.isDeleted, 0) = 0;
      `);

    const taskStats = rTaskStats.recordset[0] || {
      totalTasks: 0,
      doneTasks: 0,
      openTasks: 0,
      overdueTasks: 0,
    };

    // 5. Các task gần đây
    const rRecent = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT TOP 30
          t.taskId,
          t.title,
          t.priority,
          t.dueDate,
          t.progressPercent,
          ws.name AS statusName,
          ws.code AS statusCode
        FROM dbo.cv_Tasks t
        JOIN dbo.cv_WorkflowStatuses ws
          ON ws.statusId = t.statusId
         AND ISNULL(ws.isDeleted, 0) = 0
        WHERE t.projectId = @projectId
          AND ISNULL(t.isDeleted, 0) = 0
        ORDER BY t.createdAt DESC;
      `);

    const recentTasks = rRecent.recordset || [];

    // 6. Thời gian log (tạm thời cho 0 nếu chưa có bảng TimeLog)
    // Nếu bạn có bảng, sửa query này cho đúng.
    const timeSummary = {
      totalMinutes: 0,
      topUsers: [],
    };

    // 7. Thống kê file dự án
    const rFileSummary = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          COUNT(*) AS totalFiles,
          ISNULL(SUM(fileSize), 0) AS totalSize
        FROM dbo.cv_ProjectFiles
        WHERE projectId = @projectId
          AND ISNULL(isDeleted, 0) = 0;
      `);

    const fileSummary = rFileSummary.recordset[0] || {
      totalFiles: 0,
      totalSize: 0,
    };

    // 8. Thống kê chat
    const rChatSummary = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          COUNT(*) AS totalMessages,
          MAX(createdAt) AS lastMessageAt
        FROM dbo.cv_ProjectChatMessages
        WHERE projectId = @projectId
          AND ISNULL(isDeleted, 0) = 0;
      `);
    const chatSummary = rChatSummary.recordset[0] || {
      totalMessages: 0,
      lastMessageAt: null,
    };

    return res.json({
      success: true,
      data: {
        project,
        myRole,
        members,
        taskStats,
        recentTasks,
        timeSummary,
        fileSummary,
        chatSummary,
      },
    });
  } catch (err) {
    console.error('GET /projects/:projectId/overview error:', err);
    res
      .status(500)
      .json({ success: false, message: 'Lỗi tải tổng quan dự án' });
  }
});

/* ======================
   2) TẠO TASK MỚI TRONG DỰ ÁN
   POST /:projectId/tasks
   body: { title, priority, dueDate }
   ====================== */
router.post('/:projectId/tasks', requireAuth, async (req, res) => {
  try {
    const projectId = +req.params.projectId;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
    }

    const { title, priority, dueDate } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập tiêu đề công việc',
      });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    const ok = await ensureProjectAccess(pool, projectId, userID);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền tạo công việc trong dự án này',
      });
    }

    // Lấy statusId mặc định (todo)
    const rStatus = await pool
      .request()
      .query(`
        SELECT TOP 1 statusId
        FROM dbo.cv_WorkflowStatuses
        WHERE code = 'todo'
          AND ISNULL(isDeleted, 0) = 0
        ORDER BY orderIndex;
      `);

    if (!rStatus.recordset.length) {
      return res.status(500).json({
        success: false,
        message: 'Không tìm thấy trạng thái mặc định (todo)',
      });
    }

    const statusId = rStatus.recordset[0].statusId;

    const rIns = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .input('title', sql.NVarChar(500), title.trim())
      .input('priority', sql.NVarChar(20), priority || null)
      .input('dueDate', sql.Date, dueDate || null)
      .input('statusId', sql.Int, statusId)
      .input('createdBy', sql.Int, userID)
      .query(`
        INSERT INTO dbo.cv_Tasks
          (projectId, title, description, statusId, priority,
           startDate, dueDate, estimateHours, progressPercent,
           createdBy, isDeleted, createdAt, repeatDaily)
        OUTPUT INSERTED.taskId
        VALUES
          (@projectId, @title, NULL, @statusId, @priority,
           NULL, @dueDate, NULL, 0,
           @createdBy, 0, GETDATE(), 0);
      `);

    const taskId = rIns.recordset[0].taskId;

    // (Optional) Ghi history trạng thái
    await pool
      .request()
      .input('taskId', sql.Int, taskId)
      .input('statusId', sql.Int, statusId)
      .input('userID', sql.Int, userID)
      .query(`
        INSERT INTO dbo.cv_TaskStatusHistory
          (taskId, fromStatusId, toStatusId, changedBy, changedAt,
           note, isDeleted, createdBy, createdAt, changeType)
        VALUES
          (@taskId, NULL, @statusId, @userID, GETDATE(),
           N'Tạo công việc', 0, @userID, GETDATE(), 'create');
      `);

    return res.json({
      success: true,
      message: 'Tạo công việc thành công',
      data: { taskId },
    });
  } catch (err) {
    console.error('POST /projects/:projectId/tasks error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tạo công việc' });
  }
});

/* ======================
   3) THÊM THÀNH VIÊN DỰ ÁN
   POST /:projectId/members
   body: { userId, projectRoleId, note }
   ====================== */
router.post('/:projectId/members', requireAuth, async (req, res) => {
  try {
    const projectId = +req.params.projectId;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
    }

    const { userId, projectRoleId, note } = req.body || {};
    if (!userId || !projectRoleId) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng gửi userId và projectRoleId',
      });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    // chỉ người tạo dự án hoặc user có quyền quản lý mới được thêm member
    const rCheckOwner = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .input('userID', sql.Int, userID)
      .query(`
        SELECT TOP 1 1 AS ok
        FROM dbo.cv_Projects p
        WHERE p.projectId = @projectId
          AND ISNULL(p.isDeleted, 0) = 0
          AND (
            p.createdBy = @userID
            OR EXISTS (
              SELECT 1
              FROM dbo.cv_ProjectMemberships m
              JOIN dbo.cv_ProjectRoles pr
                ON pr.projectRoleId = m.projectRoleId
               AND ISNULL(pr.isDeleted, 0) = 0
              WHERE m.projectId = p.projectId
                AND m.userId = @userID
                AND ISNULL(m.isDeleted, 0) = 0
                AND pr.isManagerial = 1
            )
            OR EXISTS (
              SELECT 1
              FROM dbo.cv_UserRoles ur
              JOIN dbo.cv_Roles r
                ON r.roleId = ur.roleId
               AND ISNULL(r.isDeleted, 0) = 0
              WHERE ur.userId = @userID
                AND ISNULL(ur.isDeleted, 0) = 0
                AND r.code IN ('bangiamdoc','giamdocnhamay')
            )
          );
      `);

    if (!rCheckOwner.recordset.length) {
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền thêm thành viên cho dự án này',
      });
    }

    // check trùng
    const rExist = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .input('userId', sql.Int, userId)
      .query(`
        SELECT TOP 1 *
        FROM dbo.cv_ProjectMemberships
        WHERE projectId = @projectId
          AND userId = @userId
          AND ISNULL(isDeleted, 0) = 0;
      `);

    if (rExist.recordset.length) {
      return res.status(400).json({
        success: false,
        message: 'Người này đã là thành viên của dự án',
      });
    }

    await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .input('userId', sql.Int, userId)
      .input('projectRoleId', sql.Int, projectRoleId)
      .input('note', sql.NVarChar(500), note || null)
      .input('userID', sql.Int, userID)
      .query(`
        INSERT INTO dbo.cv_ProjectMemberships
          (projectId, userId, projectRoleId, joinedAt,
           note, isDeleted, createdBy, createdAt)
        VALUES
          (@projectId, @userId, @projectRoleId, GETDATE(),
           @note, 0, @userID, GETDATE());
      `);

    return res.json({
      success: true,
      message: 'Thêm thành viên thành công',
    });
  } catch (err) {
    console.error('POST /projects/:projectId/members error:', err);
    res.status(500).json({ success: false, message: 'Lỗi thêm thành viên' });
  }
});

/* ======================
   4) FILE DỰ ÁN – LIST
   GET /:projectId/files
   ====================== */
router.get('/:projectId/files', requireAuth, async (req, res) => {
  try {
    const projectId = +req.params.projectId;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    const ok = await ensureProjectAccess(pool, projectId, userID);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền xem tệp của dự án này',
      });
    }

    const r = await pool
      .request()
      .input('projectId', sql.Int, projectId)
      .query(`
        SELECT
          f.pfileId,
          f.projectId,
          f.taskId,
          f.fileName,
          f.storagePath,
          f.mimeType,
          f.fileSize,
          f.uploadedAt,
          u.fullName AS uploadedByName,
          u.userName AS uploadedByUserName
        FROM dbo.cv_ProjectFiles f
        LEFT JOIN dbo.Users u
          ON u.userID = f.uploadedBy
        WHERE f.projectId = @projectId
          AND ISNULL(f.isDeleted, 0) = 0
        ORDER BY f.uploadedAt DESC;
      `);

    return res.json({
      success: true,
      data: r.recordset || [],
    });
  } catch (err) {
    console.error('GET /projects/:projectId/files error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tải danh sách tệp' });
  }
});

/* ======================
   5) FILE DỰ ÁN – UPLOAD
   POST /:projectId/files
   body: form-data files[]
   ====================== */
router.post(
  '/:projectId/files',
  requireAuth,
  upload.array('files', 10),
  async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
      }

      if (!req.files || !req.files.length) {
        return res.status(400).json({
          success: false,
          message: 'Không có file nào được gửi lên',
        });
      }

      const pool = await poolPromise;
      const userID = req.user.userID;

      const ok = await ensureProjectAccess(pool, projectId, userID);
      if (!ok) {
        return res.status(403).json({
          success: false,
          message: 'Bạn không có quyền thêm tệp cho dự án này',
        });
      }

      const bucket = process.env.AWS_S3_BUCKET;
      const results = [];

      for (const file of req.files) {
        const originalName = toUtf8FileName
          ? toUtf8FileName(file.originalname)
          : file.originalname;

        const key = `projects/${projectId}/${Date.now()}-${Math.random()
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

        const rIns = await pool
          .request()
          .input('projectId', sql.Int, projectId)
          .input('fileName', sql.NVarChar(300), originalName)
          .input('mimeType', sql.NVarChar(100), file.mimetype)
          .input('fileSize', sql.Int, file.size)
          .input('storagePath', sql.NVarChar(500), key)
          .input('uploadedBy', sql.Int, userID)
          .query(`
            INSERT INTO dbo.cv_ProjectFiles
              (projectId, taskId, fileName, storagePath, mimeType, fileSize,
               uploadedBy, uploadedAt, isDeleted, createdBy, createdAt)
            OUTPUT INSERTED.pfileId, INSERTED.projectId, INSERTED.taskId,
                   INSERTED.fileName, INSERTED.storagePath, INSERTED.mimeType,
                   INSERTED.fileSize, INSERTED.uploadedAt
            VALUES
              (@projectId, NULL, @fileName, @storagePath, @mimeType, @fileSize,
               @uploadedBy, GETDATE(), 0, @uploadedBy, GETDATE());
          `);

        const row = rIns.recordset[0];
        row.fileName = originalName;
        results.push(row);
      }

      return res.json({
        success: true,
        message: 'Tải tệp lên thành công',
        data: results,
      });
    } catch (err) {
      console.error('POST /projects/:projectId/files error:', err);
      res.status(500).json({ success: false, message: 'Lỗi tải tệp lên' });
    }
  }
);

/* ======================
   6) FILE DỰ ÁN – XOÁ (SOFT DELETE)
   DELETE /files/:pfileId
   ====================== */
router.delete('/files/:pfileId', requireAuth, async (req, res) => {
  try {
    const pfileId = +req.params.pfileId;
    if (!Number.isFinite(pfileId) || pfileId <= 0) {
      return res.status(400).json({ success: false, message: 'pfileId không hợp lệ' });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    // Lấy projectId + check user có quyền & có phải là người upload
    const rCheck = await pool
      .request()
      .input('pfileId', sql.BigInt, pfileId)
      .input('userID', sql.Int, userID)
      .query(`
        SELECT
          f.pfileId,
          f.projectId,
          f.uploadedBy
        FROM dbo.cv_ProjectFiles f
        JOIN dbo.cv_Projects p
          ON p.projectId = f.projectId
         AND ISNULL(p.isDeleted, 0) = 0
        WHERE f.pfileId = @pfileId
          AND ISNULL(f.isDeleted, 0) = 0;
      `);

    if (!rCheck.recordset.length) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tệp',
      });
    }

    const row = rCheck.recordset[0];

    const ok = await ensureProjectAccess(pool, row.projectId, userID);
    if (!ok || (row.uploadedBy !== userID)) {
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền xoá tệp này',
      });
    }

    await pool
      .request()
      .input('pfileId', sql.BigInt, pfileId)
      .input('userID', sql.Int, userID)
      .query(`
        UPDATE dbo.cv_ProjectFiles
        SET isDeleted = 1,
            deletedBy = @userID,
            deletedAt = GETDATE()
        WHERE pfileId = @pfileId
          AND ISNULL(isDeleted, 0) = 0;
      `);

    return res.json({
      success: true,
      message: 'Đã xoá tệp (soft delete)',
    });
  } catch (err) {
    console.error('DELETE /projects/files/:pfileId error:', err);
    res.status(500).json({ success: false, message: 'Lỗi xoá tệp' });
  }
});

/* ======================
   7) FILE DỰ ÁN – DOWNLOAD (SIGNED URL)
   GET /files/:pfileId/download
   ====================== */
router.get('/files/:pfileId/download', requireAuth, async (req, res) => {
  try {
    const pfileId = +req.params.pfileId;
    if (!Number.isFinite(pfileId) || pfileId <= 0) {
      return res.status(400).json({ success: false, message: 'pfileId không hợp lệ' });
    }

    const pool = await poolPromise;
    const userID = req.user.userID;

    const r = await pool
      .request()
      .input('pfileId', sql.BigInt, pfileId)
      .query(`
        SELECT TOP 1
          f.pfileId,
          f.projectId,
          f.fileName,
          f.mimeType,
          f.storagePath
        FROM dbo.cv_ProjectFiles f
        JOIN dbo.cv_Projects p
          ON p.projectId = f.projectId
         AND ISNULL(p.isDeleted, 0) = 0
        WHERE f.pfileId = @pfileId
          AND ISNULL(f.isDeleted, 0) = 0;
      `);

    if (!r.recordset.length) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tệp',
      });
    }

    const fileRow = r.recordset[0];

    const ok = await ensureProjectAccess(pool, fileRow.projectId, userID);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền tải tệp này',
      });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: fileRow.storagePath,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    return res.json({
      success: true,
      url: signedUrl,
      fileName: fileRow.fileName,
      mimeType: fileRow.mimeType,
    });
  } catch (err) {
    console.error('GET /projects/files/:pfileId/download error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tải tệp' });
  }
});

// GET /api/task-management/users/search?q=...
router.get('/users/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({ success: true, data: [] });
    }

    const pool = await poolPromise;

    const r = await pool.request()
      .input('q', sql.NVarChar(200), `%${q}%`)
      .query(`
        SELECT TOP 20
          u.userID       AS userId,
          u.fullName,
          u.userName,
          d.name         AS departmentName,
          t.name         AS teamName
        FROM dbo.Users u
        LEFT JOIN dbo.cv_Departments d
          ON d.departmentId = u.cv_DepartmentId
        LEFT JOIN dbo.cv_Teams t
          ON t.teamId = u.cv_TeamId
        WHERE ISNULL(u.isDeleted, 0) = 0
          AND (
            u.fullName LIKE @q
            OR u.userName LIKE @q
          )
        ORDER BY u.fullName;
      `);

    res.json({ success: true, data: r.recordset });
  } catch (err) {
    console.error('GET /users/search error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tìm user' });
  }
});

// GET /api/task-management/project-roles
router.get('/project-roles', requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT projectRoleId, name, code, isManagerial
      FROM dbo.cv_ProjectRoles
      WHERE ISNULL(isDeleted, 0) = 0
      ORDER BY isManagerial DESC, name;
    `);

    res.json({ success: true, data: r.recordset });
  } catch (err) {
    console.error('GET /project-roles error:', err);
    res.status(500).json({ success: false, message: 'Lỗi tải vai trò dự án' });
  }
});



module.exports = router;
