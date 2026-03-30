/**
 * Mở rộng Quản lý dự án — mount vào router /api/task-management (gọi cuối api.js).
 *
 * Giả định (cần khớp DB):
 * - cv_ProjectWorkflow: projectId, statusId, sortOrder, isDefault, isTerminal, isDeleted, createdBy, createdAt
 * - cv_Comments: taskId, body, createdAt, createdBy, isDeleted
 * - cv_TimeEntries: projectId, durationMinutes (hoặc fallback cv_TimeLogs.minutesWorked)
 */
const { poolPromise, sql } = require("../db");

async function canManageProjectMembers(pool, projectId, userID) {
  const r = await pool
    .request()
    .input("projectId", sql.Int, projectId)
    .input("userID", sql.Int, userID)
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
  return r.recordset.length > 0;
}

module.exports = function registerProjectManagementExtended(router, deps) {
  const { requireAuth, ensureProjectAccess } = deps;

  router.get("/workflow-statuses", requireAuth, async (req, res) => {
    try {
      const pool = await poolPromise;
      const r = await pool.request().query(`
        SELECT statusId, code, name, orderIndex
        FROM dbo.cv_WorkflowStatuses
        WHERE ISNULL(isDeleted, 0) = 0
        ORDER BY ISNULL(orderIndex, 9999), statusId;
      `);
      res.json({ success: true, data: r.recordset || [] });
    } catch (err) {
      console.error("GET /workflow-statuses error:", err);
      res.status(500).json({ success: false, message: "Lỗi tải trạng thái workflow" });
    }
  });

  router.get("/:projectId/dashboard", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const ok = await ensureProjectAccess(pool, projectId, userID);
      if (!ok) {
        return res.status(403).json({ success: false, message: "Không có quyền xem dự án" });
      }

      const soon = new Date();
      soon.setDate(soon.getDate() + 7);

      const rMembers = await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .query(`
          SELECT COUNT(*) AS memberCount
          FROM dbo.cv_ProjectMemberships m
          WHERE m.projectId = @projectId AND ISNULL(m.isDeleted, 0) = 0;
        `);

      const rAgg = await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .input("soon", sql.Date, soon)
        .query(`
          DECLARE @today DATE = CAST(GETDATE() AS DATE);
          SELECT
            COUNT(*) AS totalTasks,
            SUM(CASE WHEN ws.code = N'done' THEN 1 ELSE 0 END) AS doneTasks,
            SUM(CASE WHEN ws.code <> N'done' THEN 1 ELSE 0 END) AS openTasks,
            SUM(CASE WHEN ws.code <> N'done' AND t.dueDate IS NOT NULL AND t.dueDate < @today THEN 1 ELSE 0 END) AS overdueTasks,
            SUM(CASE WHEN ws.code <> N'done' AND t.dueDate IS NOT NULL AND t.dueDate >= @today AND t.dueDate <= @soon THEN 1 ELSE 0 END) AS dueSoonTasks
          FROM dbo.cv_Tasks t
          JOIN dbo.cv_WorkflowStatuses ws ON ws.statusId = t.statusId AND ISNULL(ws.isDeleted, 0) = 0
          WHERE t.projectId = @projectId AND ISNULL(t.isDeleted, 0) = 0;
        `);

      const rByStatus = await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .query(`
          SELECT ws.statusId, ws.code, ws.name, COUNT(*) AS taskCount
          FROM dbo.cv_Tasks t
          JOIN dbo.cv_WorkflowStatuses ws ON ws.statusId = t.statusId AND ISNULL(ws.isDeleted, 0) = 0
          WHERE t.projectId = @projectId AND ISNULL(t.isDeleted, 0) = 0
          GROUP BY ws.statusId, ws.code, ws.name
          ORDER BY MIN(ISNULL(ws.orderIndex, 9999));
        `);

      let totalMinutes = 0;
      try {
        const rTime = await pool
          .request()
          .input("projectId", sql.Int, projectId)
          .query(`
            SELECT ISNULL(SUM(CAST(te.durationMinutes AS BIGINT)), 0) AS totalMinutes
            FROM dbo.cv_TimeEntries te
            WHERE te.projectId = @projectId AND ISNULL(te.isDeleted, 0) = 0;
          `);
        totalMinutes = Number(rTime.recordset?.[0]?.totalMinutes) || 0;
      } catch {
        try {
          const rTime2 = await pool
            .request()
            .input("projectId", sql.Int, projectId)
            .query(`
              SELECT ISNULL(SUM(CAST(l.minutesWorked AS BIGINT)), 0) AS totalMinutes
              FROM dbo.cv_TimeLogs l
              WHERE l.projectId = @projectId AND ISNULL(l.isDeleted, 0) = 0;
            `);
          totalMinutes = Number(rTime2.recordset?.[0]?.totalMinutes) || 0;
        } catch {
          totalMinutes = 0;
        }
      }

      const row = rAgg.recordset?.[0] || {};
      const total = +row.totalTasks || 0;
      const done = +row.doneTasks || 0;
      const completionPercent = total > 0 ? Math.round((done / total) * 1000) / 10 : 0;

      res.json({
        success: true,
        data: {
          memberCount: rMembers.recordset?.[0]?.memberCount ?? 0,
          totalTasks: total,
          doneTasks: done,
          openTasks: +row.openTasks || 0,
          overdueTasks: +row.overdueTasks || 0,
          dueSoonTasks: +row.dueSoonTasks || 0,
          completionPercent,
          tasksByStatus: rByStatus.recordset || [],
          totalTimeMinutes: totalMinutes,
        },
      });
    } catch (err) {
      console.error("GET /:projectId/dashboard error:", err);
      res.status(500).json({ success: false, message: "Lỗi tải dashboard dự án" });
    }
  });

  router.get("/:projectId/activity", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const ok = await ensureProjectAccess(pool, projectId, userID);
      if (!ok) {
        return res.status(403).json({ success: false, message: "Không có quyền xem dự án" });
      }

      const rHist = await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .query(`
          SELECT TOP 40
            N'status' AS kind,
            h.changedAt AS at,
            h.note AS text,
            t.title AS taskTitle,
            u.fullName AS actorName
          FROM dbo.cv_TaskStatusHistory h
          JOIN dbo.cv_Tasks t ON t.taskId = h.taskId AND ISNULL(t.isDeleted, 0) = 0
          LEFT JOIN dbo.Users u ON u.userID = h.changedBy
          WHERE t.projectId = @projectId AND ISNULL(h.isDeleted, 0) = 0
          ORDER BY h.changedAt DESC;
        `);

      let comments = [];
      try {
        const rCom = await pool
          .request()
          .input("projectId", sql.Int, projectId)
          .query(`
            SELECT TOP 20
              N'comment' AS kind,
              c.createdAt AS at,
              CAST(c.body AS NVARCHAR(2000)) AS text,
              t.title AS taskTitle,
              u.fullName AS actorName
            FROM dbo.cv_Comments c
            JOIN dbo.cv_Tasks t ON t.taskId = c.taskId AND ISNULL(t.isDeleted, 0) = 0
            LEFT JOIN dbo.Users u ON u.userID = c.createdBy
            WHERE t.projectId = @projectId AND ISNULL(c.isDeleted, 0) = 0
            ORDER BY c.createdAt DESC;
          `);
        comments = rCom.recordset || [];
      } catch (e) {
        console.warn("activity comments:", e.message);
      }

      const merged = [...(rHist.recordset || []), ...comments].sort(
        (a, b) => new Date(b.at) - new Date(a.at)
      );
      res.json({ success: true, data: merged.slice(0, 50) });
    } catch (err) {
      console.error("GET /:projectId/activity error:", err);
      res.status(500).json({ success: false, message: "Lỗi tải hoạt động dự án" });
    }
  });

  router.get("/:projectId/tasks", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const ok = await ensureProjectAccess(pool, projectId, userID);
      if (!ok) {
        return res.status(403).json({ success: false, message: "Không có quyền xem dự án" });
      }

      const statusId = req.query.statusId ? +req.query.statusId : null;
      const assigneeUserId = req.query.assigneeUserId ? +req.query.assigneeUserId : null;
      const priority = req.query.priority ? String(req.query.priority) : null;
      const dueFrom = req.query.dueFrom || null;
      const dueTo = req.query.dueTo || null;
      const q = req.query.q ? String(req.query.q).trim() : null;

      const r = await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .input("statusId", sql.Int, statusId)
        .input("assigneeUserId", sql.Int, assigneeUserId)
        .input("priority", sql.NVarChar(20), priority)
        .input("dueFrom", sql.Date, dueFrom)
        .input("dueTo", sql.Date, dueTo)
        .input("q", sql.NVarChar(200), q ? `%${q}%` : null)
        .query(`
          SELECT DISTINCT
            t.taskId,
            t.projectId,
            t.title,
            t.description,
            t.statusId,
            ws.code AS statusCode,
            ws.name AS statusName,
            t.priority,
            t.startDate,
            t.dueDate,
            t.completedAt,
            t.estimateHours,
            t.progressPercent,
            t.createdBy,
            t.createdAt,
            t.updatedBy,
            t.updatedAt
          FROM dbo.cv_Tasks t
          JOIN dbo.cv_WorkflowStatuses ws ON ws.statusId = t.statusId AND ISNULL(ws.isDeleted, 0) = 0
          LEFT JOIN dbo.cv_TaskAssignees a
            ON a.taskId = t.taskId AND ISNULL(a.isDeleted, 0) = 0
          WHERE t.projectId = @projectId
            AND ISNULL(t.isDeleted, 0) = 0
            AND (@statusId IS NULL OR t.statusId = @statusId)
            AND (@assigneeUserId IS NULL OR a.userId = @assigneeUserId)
            AND (@priority IS NULL OR t.priority = @priority)
            AND (@dueFrom IS NULL OR t.dueDate IS NULL OR t.dueDate >= @dueFrom)
            AND (@dueTo IS NULL OR t.dueDate IS NULL OR t.dueDate <= @dueTo)
            AND (@q IS NULL OR t.title LIKE @q OR CAST(t.description AS NVARCHAR(MAX)) LIKE @q)
          ORDER BY t.createdAt DESC;
        `);

      res.json({ success: true, data: r.recordset || [] });
    } catch (err) {
      console.error("GET /:projectId/tasks error:", err);
      res.status(500).json({ success: false, message: "Lỗi tải danh sách task" });
    }
  });

  router.get("/:projectId/workflow", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const ok = await ensureProjectAccess(pool, projectId, userID);
      if (!ok) {
        return res.status(403).json({ success: false, message: "Không có quyền xem dự án" });
      }

      const rAll = await pool.request().query(`
        SELECT statusId, code, name, orderIndex
        FROM dbo.cv_WorkflowStatuses
        WHERE ISNULL(isDeleted, 0) = 0
        ORDER BY ISNULL(orderIndex, 9999), statusId;
      `);

      try {
        const rMap = await pool
          .request()
          .input("projectId", sql.Int, projectId)
          .query(`
            SELECT pw.projectWorkflowId, pw.statusId, pw.sortOrder,
                   CAST(pw.isDefault AS INT) AS isDefault,
                   CAST(pw.isTerminal AS INT) AS isTerminal,
                   ws.code, ws.name
            FROM dbo.cv_ProjectWorkflow pw
            JOIN dbo.cv_WorkflowStatuses ws ON ws.statusId = pw.statusId AND ISNULL(ws.isDeleted, 0) = 0
            WHERE pw.projectId = @projectId AND ISNULL(pw.isDeleted, 0) = 0
            ORDER BY pw.sortOrder, pw.projectWorkflowId;
          `);
        return res.json({
          success: true,
          data: {
            allStatuses: rAll.recordset || [],
            projectWorkflow: rMap.recordset || [],
            usesProjectWorkflowTable: true,
          },
        });
      } catch (e) {
        if (e.number === 208 || String(e.message || "").includes("Invalid object name")) {
          return res.json({
            success: true,
            data: {
              allStatuses: rAll.recordset || [],
              projectWorkflow: [],
              usesProjectWorkflowTable: false,
              hint:
                "Chưa có bảng dbo.cv_ProjectWorkflow. Dùng cv_WorkflowStatuses làm catalog chung.",
            },
          });
        }
        throw e;
      }
    } catch (err) {
      console.error("GET /:projectId/workflow error:", err);
      res.status(500).json({ success: false, message: "Lỗi tải workflow dự án" });
    }
  });

  router.put("/:projectId/workflow", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      const { items } = req.body || {};
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: "items phải là mảng không rỗng" });
      }

      const pool = await poolPromise;
      const userID = req.user.userID;
      const can = await canManageProjectMembers(pool, projectId, userID);
      if (!can) {
        return res.status(403).json({ success: false, message: "Không có quyền cấu hình workflow" });
      }

      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        await new sql.Request(tx)
          .input("projectId", sql.Int, projectId)
          .query(`DELETE FROM dbo.cv_ProjectWorkflow WHERE projectId = @projectId;`);

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const statusId = +it.statusId;
          const sortOrder = +it.sortOrder || i + 1;
          if (!Number.isFinite(statusId)) continue;
          await new sql.Request(tx)
            .input("projectId", sql.Int, projectId)
            .input("statusId", sql.Int, statusId)
            .input("sortOrder", sql.Int, sortOrder)
            .input("isDefault", sql.Bit, !!it.isDefault)
            .input("isTerminal", sql.Bit, !!it.isTerminal)
            .input("actor", sql.Int, userID)
            .query(`
              INSERT INTO dbo.cv_ProjectWorkflow
                (projectId, statusId, sortOrder, isDefault, isTerminal, isDeleted, createdBy, createdAt)
              VALUES
                (@projectId, @statusId, @sortOrder, @isDefault, @isTerminal, 0, @actor, SYSUTCDATETIME());
            `);
        }
        await tx.commit();
        res.json({ success: true, message: "Đã lưu workflow dự án" });
      } catch (inner) {
        try {
          await tx.rollback();
        } catch {}
        if (inner.number === 208 || String(inner.message || "").includes("Invalid object name")) {
          return res.status(501).json({
            success: false,
            code: "NEED_CV_PROJECT_WORKFLOW_TABLE",
            message:
              "Cần bảng dbo.cv_ProjectWorkflow (projectId, statusId, sortOrder, isDefault, isTerminal, isDeleted, createdBy, createdAt).",
          });
        }
        throw inner;
      }
    } catch (err) {
      console.error("PUT /:projectId/workflow error:", err);
      res.status(500).json({ success: false, message: "Lỗi lưu workflow dự án" });
    }
  });

  router.put("/projects/:projectId", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      const { name, description, scope, startDate, dueDate, code } = req.body || {};
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const can = await canManageProjectMembers(pool, projectId, userID);
      if (!can) {
        return res.status(403).json({ success: false, message: "Không có quyền sửa dự án" });
      }

      await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .input("name", sql.NVarChar(300), name != null ? name : null)
        .input("description", sql.NVarChar(sql.MAX), description != null ? description : null)
        .input("scope", sql.NVarChar(20), scope != null ? scope : null)
        .input("startDate", sql.Date, startDate || null)
        .input("dueDate", sql.Date, dueDate || null)
        .input("code", sql.NVarChar(100), code != null ? String(code).trim() : null)
        .query(`
          UPDATE dbo.cv_Projects
          SET
            name = COALESCE(@name, name),
            description = COALESCE(@description, description),
            scope = COALESCE(@scope, scope),
            startDate = COALESCE(@startDate, startDate),
            dueDate = COALESCE(@dueDate, dueDate),
            code = COALESCE(@code, code)
          WHERE projectId = @projectId AND ISNULL(isDeleted, 0) = 0;
        `);

      res.json({ success: true, message: "Đã cập nhật dự án" });
    } catch (err) {
      console.error("PUT /projects/:projectId error:", err);
      res.status(500).json({ success: false, message: "Lỗi cập nhật dự án" });
    }
  });

  router.patch("/projects/:projectId/status", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      const { status } = req.body || {};
      const allowed = ["active", "hold", "done", "cancel"];
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      if (!status || !allowed.includes(String(status))) {
        return res.status(400).json({ success: false, message: "status không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const can = await canManageProjectMembers(pool, projectId, userID);
      if (!can) {
        return res.status(403).json({ success: false, message: "Không có quyền đổi trạng thái dự án" });
      }
      await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .input("status", sql.NVarChar(20), status)
        .query(`
          UPDATE dbo.cv_Projects
          SET status = @status
          WHERE projectId = @projectId AND ISNULL(isDeleted, 0) = 0;
        `);
      res.json({ success: true, message: "Đã cập nhật trạng thái dự án" });
    } catch (err) {
      console.error("PATCH /projects/:projectId/status error:", err);
      res.status(500).json({ success: false, message: "Lỗi cập nhật trạng thái" });
    }
  });

  router.delete("/projects/:projectId", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const can = await canManageProjectMembers(pool, projectId, userID);
      if (!can) {
        return res.status(403).json({ success: false, message: "Không có quyền xóa dự án" });
      }
      await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .input("userID", sql.Int, userID)
        .query(`
          UPDATE dbo.cv_Projects
          SET isDeleted = 1, deletedAt = SYSUTCDATETIME(), deletedBy = @userID
          WHERE projectId = @projectId;
        `);
      res.json({ success: true, message: "Đã đánh dấu xóa dự án" });
    } catch (err) {
      console.error("DELETE /projects/:projectId error:", err);
      res.status(500).json({ success: false, message: "Lỗi xóa dự án" });
    }
  });

  router.get("/:projectId/members", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ success: false, message: "projectId không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const ok = await ensureProjectAccess(pool, projectId, userID);
      if (!ok) {
        return res.status(403).json({ success: false, message: "Không có quyền xem dự án" });
      }
      const r = await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .query(`
          SELECT
            m.userId,
            m.projectRoleId,
            pr.code AS roleCode,
            pr.name AS projectRoleName,
            pr.isManagerial AS isManagerialRole,
            u.fullName,
            u.userName,
            d.name AS departmentName
          FROM dbo.cv_ProjectMemberships m
          JOIN dbo.Users u ON u.userID = m.userId AND ISNULL(u.isDeleted, 0) = 0
          JOIN dbo.cv_ProjectRoles pr ON pr.projectRoleId = m.projectRoleId AND ISNULL(pr.isDeleted, 0) = 0
          LEFT JOIN dbo.cv_Departments d ON d.departmentId = u.cv_DepartmentId
          WHERE m.projectId = @projectId AND ISNULL(m.isDeleted, 0) = 0
          ORDER BY pr.isManagerial DESC, u.fullName;
        `);
      res.json({ success: true, data: r.recordset || [] });
    } catch (err) {
      console.error("GET /:projectId/members error:", err);
      res.status(500).json({ success: false, message: "Lỗi tải thành viên" });
    }
  });

  router.put("/:projectId/members/:targetUserId", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      const targetUserId = +req.params.targetUserId;
      const { projectRoleId } = req.body || {};
      if (!Number.isFinite(projectId) || !Number.isFinite(targetUserId) || !Number.isFinite(+projectRoleId)) {
        return res.status(400).json({ success: false, message: "Tham số không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const can = await canManageProjectMembers(pool, projectId, userID);
      if (!can) {
        return res.status(403).json({ success: false, message: "Không có quyền sửa thành viên" });
      }
      await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .input("targetUserId", sql.Int, targetUserId)
        .input("projectRoleId", sql.Int, +projectRoleId)
        .query(`
          UPDATE dbo.cv_ProjectMemberships
          SET projectRoleId = @projectRoleId
          WHERE projectId = @projectId AND userId = @targetUserId AND ISNULL(isDeleted, 0) = 0;
        `);
      res.json({ success: true, message: "Đã cập nhật vai trò thành viên" });
    } catch (err) {
      console.error("PUT /:projectId/members/:targetUserId error:", err);
      res.status(500).json({ success: false, message: "Lỗi cập nhật thành viên" });
    }
  });

  router.delete("/:projectId/members/:targetUserId", requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.projectId;
      const targetUserId = +req.params.targetUserId;
      if (!Number.isFinite(projectId) || !Number.isFinite(targetUserId)) {
        return res.status(400).json({ success: false, message: "Tham số không hợp lệ" });
      }
      const pool = await poolPromise;
      const userID = req.user.userID;
      const can = await canManageProjectMembers(pool, projectId, userID);
      if (!can) {
        return res.status(403).json({ success: false, message: "Không có quyền xóa thành viên" });
      }
      if (targetUserId === userID) {
        return res.status(400).json({ success: false, message: "Không thể tự xóa chính mình" });
      }
      await pool
        .request()
        .input("projectId", sql.Int, projectId)
        .input("targetUserId", sql.Int, targetUserId)
        .query(`
          UPDATE dbo.cv_ProjectMemberships
          SET isDeleted = 1
          WHERE projectId = @projectId AND userId = @targetUserId AND ISNULL(isDeleted, 0) = 0;
        `);
      res.json({ success: true, message: "Đã xóa thành viên khỏi dự án" });
    } catch (err) {
      console.error("DELETE /:projectId/members/:targetUserId error:", err);
      res.status(500).json({ success: false, message: "Lỗi xóa thành viên" });
    }
  });
};
