const { sql, poolPromise } = require("../db");

function slugify(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function ensureIsDeletedColumn() {
  const pool = await poolPromise;
  await pool.request().query(`
    IF COL_LENGTH('dbo.bm_Forms','isDeleted') IS NULL
      ALTER TABLE dbo.bm_Forms
      ADD isDeleted BIT NOT NULL CONSTRAINT DF_bm_Forms_isDeleted DEFAULT(0);
  `);
}

async function ensureVisibilityTable() {
  const pool = await poolPromise;
  await pool.request().query(`
    IF OBJECT_ID('dbo.bm_FormTargets', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.bm_FormTargets (
        targetId BIGINT IDENTITY(1,1) PRIMARY KEY,
        formId INT NOT NULL,
        targetType NVARCHAR(20) NOT NULL, -- all | user | dept
        targetValue NVARCHAR(200) NULL,
        isActive BIT NOT NULL DEFAULT(1),
        createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX IX_bm_FormTargets_FormId ON dbo.bm_FormTargets(formId);
    END
  `);
}

function mapOptionsPayload(options = []) {
  return options.map((o, idx) => ({
    optionLabel: o.optionLabel ?? o.label ?? "",
    optionValue: o.optionValue ?? o.value ?? o.optionLabel ?? o.label ?? "",
    displayOrder: Number(o.displayOrder || idx + 1),
  })).filter((o) => o.optionLabel.trim());
}

async function nextCode(pool, title) {
  const base = slugify(title) || "form";
  let code = base;
  let i = 1;
  while (true) {
    const chk = await pool.request()
      .input("code", sql.NVarChar(200), code)
      .query("SELECT 1 FROM dbo.bm_Forms WHERE code=@code");
    if (!chk.recordset.length) break;
    i += 1;
    code = `${base}-${i}`;
  }
  return code;
}

async function getFullForm(pool, formId, opts = {}) {
  const { onlyActiveQuestions = false } = opts;
  const formRs = await pool.request()
    .input("formId", sql.Int, formId)
    .query("SELECT * FROM dbo.bm_Forms WHERE formId=@formId AND isDeleted=0");
  const form = formRs.recordset[0];
  if (!form) return null;

  const [sectionsRs, questionsRs, optionsRs] = await Promise.all([
    pool.request().input("formId", sql.Int, formId).query(`
      SELECT * FROM dbo.bm_FormSections
      WHERE formId=@formId
      ORDER BY displayOrder, sectionId
    `),
    pool.request().input("formId", sql.Int, formId).query(`
      SELECT * FROM dbo.bm_Questions
      WHERE formId=@formId
      ${onlyActiveQuestions ? "AND isActive=1" : ""}
      ORDER BY ISNULL(sectionId, 0), displayOrder, questionId
    `),
    pool.request().input("formId", sql.Int, formId).query(`
      SELECT qo.*
      FROM dbo.bm_QuestionOptions qo
      JOIN dbo.bm_Questions q ON q.questionId = qo.questionId
      WHERE q.formId=@formId
      ORDER BY qo.questionId, qo.displayOrder, qo.optionId
    `),
  ]);

  const optByQ = optionsRs.recordset.reduce((acc, o) => {
    (acc[o.questionId] ||= []).push(o);
    return acc;
  }, {});

  const questions = questionsRs.recordset.map((q) => ({
    ...q,
    options: optByQ[q.questionId] || [],
  }));

  return { form, sections: sectionsRs.recordset, questions };
}

function apiForm(app) {
  ensureIsDeletedColumn().catch((e) => console.error("ensureIsDeletedColumn error", e));
  ensureVisibilityTable().catch((e) => console.error("ensureVisibilityTable error", e));

  // ===== Forms =====
  app.get("/api/forms", async (req, res) => {
    try {
      const pool = await poolPromise;
      const forUser = req.query.forUser === "1";
      const userId = String(req.query.userId || "").trim() || null;
      const dept = String(req.query.dept || "").trim() || null;
      const activeOnly = req.query.activeOnly === "1" ? 1 : (req.query.activeOnly === "0" ? 0 : null);
      const q = (req.query.q || "").trim();
      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;
      const hasPaging = req.query.page !== undefined || req.query.pageSize !== undefined;
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
      const offset = (page - 1) * pageSize;

      const baseReq = pool.request()
        .input("activeOnly", sql.Bit, activeOnly)
        .input("forUser", sql.Bit, forUser ? 1 : 0)
        .input("userId", sql.NVarChar(100), userId)
        .input("dept", sql.NVarChar(200), dept)
        .input("q", sql.NVarChar(300), q || null)
        .input("from", sql.DateTime2, from || null)
        .input("to", sql.DateTime2, to || null)
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize);

      const where = `
        WHERE f.isDeleted = 0
          AND (@activeOnly IS NULL OR f.isActive = @activeOnly)
          AND (@from IS NULL OR f.createdAt >= @from)
          AND (@to IS NULL OR f.createdAt < @to)
          AND (@q IS NULL OR f.title LIKE '%'+@q+'%' OR f.code LIKE '%'+@q+'%')
          AND (
            @forUser = 0
            OR NOT EXISTS (
              SELECT 1 FROM dbo.bm_FormTargets t
              WHERE t.formId = f.formId AND t.isActive = 1
            )
            OR EXISTS (
              SELECT 1 FROM dbo.bm_FormTargets t
              WHERE t.formId = f.formId AND t.isActive = 1 AND t.targetType = 'all'
            )
            OR (@userId IS NOT NULL AND EXISTS (
              SELECT 1 FROM dbo.bm_FormTargets t
              WHERE t.formId = f.formId AND t.isActive = 1 AND t.targetType = 'user' AND t.targetValue = @userId
            ))
            OR (@dept IS NOT NULL AND EXISTS (
              SELECT 1 FROM dbo.bm_FormTargets t
              WHERE t.formId = f.formId AND t.isActive = 1 AND t.targetType = 'dept' AND t.targetValue = @dept
            ))
          )
      `;

      const listSql = `
        SELECT formId, title, description, isActive, allowMultiple, allowAnonymous,
               requireName, requirePhone, requireDept, startAt, endAt,
               createdBy, createdAt, updatedAt, publishedAt, code
        FROM dbo.bm_Forms f
        ${where}
        ORDER BY f.updatedAt DESC, f.formId DESC
        ${hasPaging ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""}
      `;

      const listRs = await baseReq.query(listSql);
      if (!hasPaging) return res.json(listRs.recordset);

      const countRs = await pool.request()
        .input("activeOnly", sql.Bit, activeOnly)
        .input("q", sql.NVarChar(300), q || null)
        .input("from", sql.DateTime2, from || null)
        .input("to", sql.DateTime2, to || null)
        .query(`SELECT COUNT(1) AS total FROM dbo.bm_Forms f ${where}`);

      return res.json({
        data: listRs.recordset,
        total: countRs.recordset[0]?.total || 0,
        page,
        pageSize,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/api/forms", async (req, res) => {
    const b = req.body || {};
    if (!b.title?.trim()) return res.status(400).json({ error: "Thiếu tiêu đề" });
    try {
      const pool = await poolPromise;
      const code = await nextCode(pool, b.title);
      const rs = await pool.request()
        .input("title", sql.NVarChar(300), b.title.trim())
        .input("description", sql.NVarChar(sql.MAX), b.description || null)
        .input("isActive", sql.Bit, !!b.isActive)
        .input("allowMultiple", sql.Bit, !!b.allowMultiple)
        .input("allowAnonymous", sql.Bit, !!b.allowAnonymous)
        .input("requireName", sql.Bit, !!b.requireName)
        .input("requirePhone", sql.Bit, !!b.requirePhone)
        .input("requireDept", sql.Bit, !!b.requireDept)
        .input("startAt", sql.DateTime2, b.startAt ? new Date(b.startAt) : null)
        .input("endAt", sql.DateTime2, b.endAt ? new Date(b.endAt) : null)
        .input("createdBy", sql.Int, b.createdBy || null)
        .input("code", sql.NVarChar(200), code)
        .query(`
          INSERT INTO dbo.bm_Forms
          (title, description, isActive, allowMultiple, allowAnonymous, requireName, requirePhone, requireDept, startAt, endAt, createdBy, code)
          VALUES
          (@title, @description, @isActive, @allowMultiple, @allowAnonymous, @requireName, @requirePhone, @requireDept, @startAt, @endAt, @createdBy, @code);
          SELECT CAST(SCOPE_IDENTITY() AS INT) AS formId, @code AS code;
        `);
      return res.status(201).json(rs.recordset[0]);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/forms/:id", async (req, res) => {
    try {
      const pool = await poolPromise;
      const data = await getFullForm(pool, Number(req.params.id));
      if (!data) return res.status(404).json({ error: "Form not found" });
      return res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/forms/code/:code", async (req, res) => {
    try {
      const code = String(req.params.code || "").toLowerCase();
      const userId = String(req.query.userId || "").trim() || null;
      const dept = String(req.query.dept || "").trim() || null;
      const pool = await poolPromise;
      const rs = await pool.request()
        .input("code", sql.NVarChar(200), code)
        .query("SELECT formId FROM dbo.bm_Forms WHERE code=@code AND isDeleted=0");
      const row = rs.recordset[0];
      if (!row) return res.status(404).json({ error: "Form not found" });

      const allowRs = await pool.request()
        .input("formId", sql.Int, row.formId)
        .input("userId", sql.NVarChar(100), userId)
        .input("dept", sql.NVarChar(200), dept)
        .query(`
          SELECT
            CASE
              WHEN NOT EXISTS (SELECT 1 FROM dbo.bm_FormTargets t WHERE t.formId=@formId AND t.isActive=1) THEN 1
              WHEN EXISTS (SELECT 1 FROM dbo.bm_FormTargets t WHERE t.formId=@formId AND t.isActive=1 AND t.targetType='all') THEN 1
              WHEN @userId IS NOT NULL AND EXISTS (SELECT 1 FROM dbo.bm_FormTargets t WHERE t.formId=@formId AND t.isActive=1 AND t.targetType='user' AND t.targetValue=@userId) THEN 1
              WHEN @dept IS NOT NULL AND EXISTS (SELECT 1 FROM dbo.bm_FormTargets t WHERE t.formId=@formId AND t.isActive=1 AND t.targetType='dept' AND t.targetValue=@dept) THEN 1
              ELSE 0
            END AS isAllowed
        `);
      if (!allowRs.recordset[0]?.isAllowed) {
        return res.status(403).json({ error: "Bạn không có quyền xem biểu mẫu này" });
      }

      const data = await getFullForm(pool, row.formId, { onlyActiveQuestions: true });
      if (!data?.form?.isActive) return res.status(404).json({ error: "Form is not active" });
      return res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.patch("/api/forms/:id", async (req, res) => {
    const b = req.body || {};
    if (!b.title?.trim()) return res.status(400).json({ error: "Thiếu tiêu đề" });
    try {
      const pool = await poolPromise;
      await pool.request()
        .input("formId", sql.Int, Number(req.params.id))
        .input("title", sql.NVarChar(300), b.title.trim())
        .input("description", sql.NVarChar(sql.MAX), b.description || null)
        .input("allowMultiple", sql.Bit, !!b.allowMultiple)
        .input("allowAnonymous", sql.Bit, !!b.allowAnonymous)
        .input("requireName", sql.Bit, !!b.requireName)
        .input("requirePhone", sql.Bit, !!b.requirePhone)
        .input("requireDept", sql.Bit, !!b.requireDept)
        .input("startAt", sql.DateTime2, b.startAt ? new Date(b.startAt) : null)
        .input("endAt", sql.DateTime2, b.endAt ? new Date(b.endAt) : null)
        .query(`
          UPDATE dbo.bm_Forms
          SET title=@title, description=@description,
              allowMultiple=@allowMultiple, allowAnonymous=@allowAnonymous,
              requireName=@requireName, requirePhone=@requirePhone, requireDept=@requireDept,
              startAt=@startAt, endAt=@endAt, updatedAt=SYSUTCDATETIME()
          WHERE formId=@formId AND isDeleted=0
        `);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.patch("/api/forms/:id/publish", async (req, res) => {
    try {
      const pool = await poolPromise;
      await pool.request()
        .input("formId", sql.Int, Number(req.params.id))
        .input("isActive", sql.Bit, !!req.body.isActive)
        .query(`
          UPDATE dbo.bm_Forms
          SET isActive=@isActive,
              publishedAt=CASE WHEN @isActive=1 THEN SYSUTCDATETIME() ELSE publishedAt END,
              updatedAt=SYSUTCDATETIME()
          WHERE formId=@formId AND isDeleted=0
        `);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/forms/:id/visibility", async (req, res) => {
    try {
      const formId = Number(req.params.id);
      const pool = await poolPromise;
      const rs = await pool.request()
        .input("formId", sql.Int, formId)
        .query(`
          SELECT targetType, targetValue
          FROM dbo.bm_FormTargets
          WHERE formId=@formId AND isActive=1
        `);
      const rows = rs.recordset || [];
      const hasTargets = rows.length > 0;
      const hasAll = rows.some((x) => x.targetType === "all");
      const users = rows.filter((x) => x.targetType === "user").map((x) => x.targetValue);
      const depts = rows.filter((x) => x.targetType === "dept").map((x) => x.targetValue);
      return res.json({
        scope: !hasTargets || hasAll ? "all" : "restricted",
        users,
        depts,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.put("/api/forms/:id/visibility", async (req, res) => {
    try {
      const formId = Number(req.params.id);
      const b = req.body || {};
      const scope = b.scope === "restricted" ? "restricted" : "all";
      const users = Array.isArray(b.users) ? b.users.map((x) => String(x).trim()).filter(Boolean) : [];
      const depts = Array.isArray(b.depts) ? b.depts.map((x) => String(x).trim()).filter(Boolean) : [];
      const pool = await poolPromise;
      const tx = new sql.Transaction(pool);
      await tx.begin();
      await new sql.Request(tx).input("formId", sql.Int, formId)
        .query("DELETE FROM dbo.bm_FormTargets WHERE formId=@formId");

      if (scope === "all") {
        await new sql.Request(tx)
          .input("formId", sql.Int, formId)
          .input("targetType", sql.NVarChar(20), "all")
          .input("targetValue", sql.NVarChar(200), null)
          .query(`
            INSERT INTO dbo.bm_FormTargets(formId, targetType, targetValue, isActive)
            VALUES(@formId, @targetType, @targetValue, 1)
          `);
      } else {
        for (const userId of users) {
          await new sql.Request(tx)
            .input("formId", sql.Int, formId)
            .input("targetType", sql.NVarChar(20), "user")
            .input("targetValue", sql.NVarChar(200), userId)
            .query(`
              INSERT INTO dbo.bm_FormTargets(formId, targetType, targetValue, isActive)
              VALUES(@formId, @targetType, @targetValue, 1)
            `);
        }
        for (const deptName of depts) {
          await new sql.Request(tx)
            .input("formId", sql.Int, formId)
            .input("targetType", sql.NVarChar(20), "dept")
            .input("targetValue", sql.NVarChar(200), deptName)
            .query(`
              INSERT INTO dbo.bm_FormTargets(formId, targetType, targetValue, isActive)
              VALUES(@formId, @targetType, @targetValue, 1)
            `);
        }
      }
      await tx.commit();
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/api/forms/:id/duplicate", async (req, res) => {
    const srcId = Number(req.params.id);
    try {
      const pool = await poolPromise;
      const source = await getFullForm(pool, srcId);
      if (!source) return res.status(404).json({ error: "Form not found" });

      const tx = new sql.Transaction(pool);
      await tx.begin();
      const newCode = await nextCode(pool, `${source.form.title} copy`);

      const formRs = await new sql.Request(tx)
        .input("title", sql.NVarChar(300), `${source.form.title} (Copy)`)
        .input("description", sql.NVarChar(sql.MAX), source.form.description || null)
        .input("allowMultiple", sql.Bit, !!source.form.allowMultiple)
        .input("allowAnonymous", sql.Bit, !!source.form.allowAnonymous)
        .input("requireName", sql.Bit, !!source.form.requireName)
        .input("requirePhone", sql.Bit, !!source.form.requirePhone)
        .input("requireDept", sql.Bit, !!source.form.requireDept)
        .input("startAt", sql.DateTime2, source.form.startAt || null)
        .input("endAt", sql.DateTime2, source.form.endAt || null)
        .input("createdBy", sql.Int, source.form.createdBy || null)
        .input("code", sql.NVarChar(200), newCode)
        .query(`
          INSERT INTO dbo.bm_Forms
          (title, description, isActive, allowMultiple, allowAnonymous, requireName, requirePhone, requireDept, startAt, endAt, createdBy, code)
          VALUES
          (@title, @description, 0, @allowMultiple, @allowAnonymous, @requireName, @requirePhone, @requireDept, @startAt, @endAt, @createdBy, @code);
          SELECT CAST(SCOPE_IDENTITY() AS INT) AS formId
        `);
      const newFormId = formRs.recordset[0].formId;

      const sectionMap = {};
      for (const s of source.sections) {
        const srs = await new sql.Request(tx)
          .input("formId", sql.Int, newFormId)
          .input("title", sql.NVarChar(300), s.title || null)
          .input("description", sql.NVarChar(sql.MAX), s.description || null)
          .input("displayOrder", sql.Int, Number(s.displayOrder || 1))
          .query(`
            INSERT INTO dbo.bm_FormSections(formId, title, description, displayOrder)
            VALUES (@formId, @title, @description, @displayOrder);
            SELECT CAST(SCOPE_IDENTITY() AS INT) AS sectionId
          `);
        sectionMap[s.sectionId] = srs.recordset[0].sectionId;
      }

      const questionMap = {};
      for (const q of source.questions) {
        const qrs = await new sql.Request(tx)
          .input("formId", sql.Int, newFormId)
          .input("sectionId", sql.Int, q.sectionId ? sectionMap[q.sectionId] : null)
          .input("questionType", sql.NVarChar(50), q.questionType)
          .input("questionText", sql.NVarChar(sql.MAX), q.questionText)
          .input("helpText", sql.NVarChar(sql.MAX), q.helpText || null)
          .input("isRequired", sql.Bit, !!q.isRequired)
          .input("displayOrder", sql.Int, Number(q.displayOrder || 1))
          .input("scaleMin", sql.Int, q.scaleMin ?? null)
          .input("scaleMax", sql.Int, q.scaleMax ?? null)
          .input("scaleMinLabel", sql.NVarChar(200), q.scaleMinLabel || null)
          .input("scaleMaxLabel", sql.NVarChar(200), q.scaleMaxLabel || null)
          .input("allowOtherOption", sql.Bit, !!q.allowOtherOption)
          .query(`
            INSERT INTO dbo.bm_Questions
            (formId, sectionId, questionType, questionText, helpText, isRequired, displayOrder, scaleMin, scaleMax, scaleMinLabel, scaleMaxLabel, allowOtherOption)
            VALUES
            (@formId, @sectionId, @questionType, @questionText, @helpText, @isRequired, @displayOrder, @scaleMin, @scaleMax, @scaleMinLabel, @scaleMaxLabel, @allowOtherOption);
            SELECT CAST(SCOPE_IDENTITY() AS INT) AS questionId
          `);
        questionMap[q.questionId] = qrs.recordset[0].questionId;
      }

      for (const q of source.questions) {
        const opts = q.options || [];
        for (const o of opts) {
          await new sql.Request(tx)
            .input("questionId", sql.Int, questionMap[q.questionId])
            .input("optionLabel", sql.NVarChar(500), o.optionLabel || "")
            .input("optionValue", sql.NVarChar(200), o.optionValue || o.optionLabel || "")
            .input("displayOrder", sql.Int, Number(o.displayOrder || 1))
            .query(`
              INSERT INTO dbo.bm_QuestionOptions(questionId, optionLabel, optionValue, displayOrder)
              VALUES (@questionId, @optionLabel, @optionValue, @displayOrder)
            `);
        }
      }

      await tx.commit();
      return res.json({ ok: true, formId: newFormId, code: newCode });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.delete("/api/forms/:id", async (req, res) => {
    try {
      const pool = await poolPromise;
      await pool.request()
        .input("formId", sql.Int, Number(req.params.id))
        .query(`
          UPDATE dbo.bm_Forms
          SET isDeleted=1, isActive=0, updatedAt=SYSUTCDATETIME()
          WHERE formId=@formId
        `);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ===== Sections =====
  app.post("/api/forms/:id/sections", async (req, res) => {
    const formId = Number(req.params.id);
    const { title, description, displayOrder } = req.body || {};
    try {
      const pool = await poolPromise;
      let order = Number(displayOrder || 0);
      if (!order) {
        const rs = await pool.request().input("formId", sql.Int, formId)
          .query("SELECT ISNULL(MAX(displayOrder),0)+1 AS n FROM dbo.bm_FormSections WHERE formId=@formId");
        order = rs.recordset[0].n;
      }
      const rs = await pool.request()
        .input("formId", sql.Int, formId)
        .input("title", sql.NVarChar(300), title || null)
        .input("description", sql.NVarChar(sql.MAX), description || null)
        .input("displayOrder", sql.Int, order)
        .query(`
          INSERT INTO dbo.bm_FormSections(formId, title, description, displayOrder)
          VALUES (@formId, @title, @description, @displayOrder);
          SELECT CAST(SCOPE_IDENTITY() AS INT) AS sectionId
        `);
      return res.status(201).json({ ok: true, sectionId: rs.recordset[0].sectionId });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.patch("/api/forms/:id/sections/:sectionId", async (req, res) => {
    const formId = Number(req.params.id);
    const sectionId = Number(req.params.sectionId);
    const { title, description, newDisplayOrder } = req.body || {};
    try {
      const pool = await poolPromise;
      await pool.request()
        .input("formId", sql.Int, formId)
        .input("sectionId", sql.Int, sectionId)
        .input("title", sql.NVarChar(300), title ?? null)
        .input("description", sql.NVarChar(sql.MAX), description ?? null)
        .input("displayOrder", sql.Int, newDisplayOrder ?? null)
        .query(`
          UPDATE dbo.bm_FormSections
          SET title = COALESCE(@title, title),
              description = COALESCE(@description, description),
              displayOrder = COALESCE(@displayOrder, displayOrder),
              updatedAt = SYSUTCDATETIME()
          WHERE formId=@formId AND sectionId=@sectionId
        `);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.delete("/api/forms/:id/sections/:sectionId", async (req, res) => {
    const formId = Number(req.params.id);
    const sectionId = Number(req.params.sectionId);
    try {
      const pool = await poolPromise;
      const tx = new sql.Transaction(pool);
      await tx.begin();
      await new sql.Request(tx)
        .input("formId", sql.Int, formId)
        .input("sectionId", sql.Int, sectionId)
        .query("UPDATE dbo.bm_Questions SET sectionId=NULL WHERE formId=@formId AND sectionId=@sectionId");
      await new sql.Request(tx)
        .input("formId", sql.Int, formId)
        .input("sectionId", sql.Int, sectionId)
        .query("DELETE FROM dbo.bm_FormSections WHERE formId=@formId AND sectionId=@sectionId");
      await tx.commit();
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ===== Questions =====
  app.post("/api/forms/:id/questions", async (req, res) => {
    const formId = Number(req.params.id);
    const b = req.body || {};
    if (!b.questionType || !b.questionText?.trim()) {
      return res.status(400).json({ error: "Thiếu loại câu hỏi hoặc nội dung câu hỏi" });
    }
    try {
      const pool = await poolPromise;
      const tx = new sql.Transaction(pool);
      await tx.begin();

      let order = Number(b.displayOrder || 0);
      if (!order) {
        const rs = await new sql.Request(tx)
          .input("formId", sql.Int, formId)
          .input("sectionId", sql.Int, b.sectionId || null)
          .query(`
            SELECT ISNULL(MAX(displayOrder),0)+1 AS n
            FROM dbo.bm_Questions
            WHERE formId=@formId
              AND ((@sectionId IS NULL AND sectionId IS NULL) OR sectionId=@sectionId)
          `);
        order = rs.recordset[0].n;
      }

      const qrs = await new sql.Request(tx)
        .input("formId", sql.Int, formId)
        .input("sectionId", sql.Int, b.sectionId || null)
        .input("questionType", sql.NVarChar(50), b.questionType)
        .input("questionText", sql.NVarChar(sql.MAX), b.questionText.trim())
        .input("helpText", sql.NVarChar(sql.MAX), b.helpText || null)
        .input("isRequired", sql.Bit, !!b.isRequired)
        .input("displayOrder", sql.Int, order)
        .input("scaleMin", sql.Int, b.scaleMin ?? null)
        .input("scaleMax", sql.Int, b.scaleMax ?? null)
        .input("scaleMinLabel", sql.NVarChar(200), b.scaleMinLabel || null)
        .input("scaleMaxLabel", sql.NVarChar(200), b.scaleMaxLabel || null)
        .input("allowOtherOption", sql.Bit, !!b.allowOtherOption)
        .query(`
          INSERT INTO dbo.bm_Questions
          (formId, sectionId, questionType, questionText, helpText, isRequired, displayOrder, scaleMin, scaleMax, scaleMinLabel, scaleMaxLabel, allowOtherOption)
          VALUES
          (@formId, @sectionId, @questionType, @questionText, @helpText, @isRequired, @displayOrder, @scaleMin, @scaleMax, @scaleMinLabel, @scaleMaxLabel, @allowOtherOption);
          SELECT CAST(SCOPE_IDENTITY() AS INT) AS questionId
        `);
      const questionId = qrs.recordset[0].questionId;

      const options = mapOptionsPayload(b.options || []);
      for (const o of options) {
        await new sql.Request(tx)
          .input("questionId", sql.Int, questionId)
          .input("optionLabel", sql.NVarChar(500), o.optionLabel)
          .input("optionValue", sql.NVarChar(200), o.optionValue)
          .input("displayOrder", sql.Int, o.displayOrder)
          .query(`
            INSERT INTO dbo.bm_QuestionOptions(questionId, optionLabel, optionValue, displayOrder)
            VALUES (@questionId, @optionLabel, @optionValue, @displayOrder)
          `);
      }

      await tx.commit();
      return res.status(201).json({ ok: true, questionId });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.patch("/api/forms/:id/questions/:questionId", async (req, res) => {
    const formId = Number(req.params.id);
    const questionId = Number(req.params.questionId);
    const b = req.body || {};
    try {
      const pool = await poolPromise;
      const tx = new sql.Transaction(pool);
      await tx.begin();

      await new sql.Request(tx)
        .input("formId", sql.Int, formId)
        .input("questionId", sql.Int, questionId)
        .input("sectionId", sql.Int, b.sectionId ?? null)
        .input("questionType", sql.NVarChar(50), b.questionType ?? null)
        .input("questionText", sql.NVarChar(sql.MAX), b.questionText ?? null)
        .input("helpText", sql.NVarChar(sql.MAX), b.helpText ?? null)
        .input("isRequired", sql.Bit, b.isRequired !== undefined ? !!b.isRequired : null)
        .input("scaleMin", sql.Int, b.scaleMin ?? null)
        .input("scaleMax", sql.Int, b.scaleMax ?? null)
        .input("scaleMinLabel", sql.NVarChar(200), b.scaleMinLabel ?? null)
        .input("scaleMaxLabel", sql.NVarChar(200), b.scaleMaxLabel ?? null)
        .input("allowOtherOption", sql.Bit, b.allowOtherOption !== undefined ? !!b.allowOtherOption : null)
        .input("displayOrder", sql.Int, b.newDisplayOrder ?? null)
        .query(`
          UPDATE dbo.bm_Questions
          SET sectionId = COALESCE(@sectionId, sectionId),
              questionType = COALESCE(@questionType, questionType),
              questionText = COALESCE(@questionText, questionText),
              helpText = COALESCE(@helpText, helpText),
              isRequired = COALESCE(@isRequired, isRequired),
              scaleMin = @scaleMin,
              scaleMax = @scaleMax,
              scaleMinLabel = @scaleMinLabel,
              scaleMaxLabel = @scaleMaxLabel,
              allowOtherOption = COALESCE(@allowOtherOption, allowOtherOption),
              displayOrder = COALESCE(@displayOrder, displayOrder),
              updatedAt = SYSUTCDATETIME()
          WHERE formId=@formId AND questionId=@questionId
        `);

      if (Array.isArray(b.options)) {
        await new sql.Request(tx)
          .input("questionId", sql.Int, questionId)
          .query("DELETE FROM dbo.bm_QuestionOptions WHERE questionId=@questionId");
        const options = mapOptionsPayload(b.options || []);
        for (const o of options) {
          await new sql.Request(tx)
            .input("questionId", sql.Int, questionId)
            .input("optionLabel", sql.NVarChar(500), o.optionLabel)
            .input("optionValue", sql.NVarChar(200), o.optionValue)
            .input("displayOrder", sql.Int, o.displayOrder)
            .query(`
              INSERT INTO dbo.bm_QuestionOptions(questionId, optionLabel, optionValue, displayOrder)
              VALUES (@questionId, @optionLabel, @optionValue, @displayOrder)
            `);
        }
      }

      await tx.commit();
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.delete("/api/forms/:id/questions/:questionId", async (req, res) => {
    const formId = Number(req.params.id);
    const questionId = Number(req.params.questionId);
    try {
      const pool = await poolPromise;
      const tx = new sql.Transaction(pool);
      await tx.begin();
      await new sql.Request(tx).input("questionId", sql.Int, questionId)
        .query("DELETE FROM dbo.bm_QuestionOptions WHERE questionId=@questionId");
      await new sql.Request(tx)
        .input("formId", sql.Int, formId)
        .input("questionId", sql.Int, questionId)
        .query("DELETE FROM dbo.bm_Questions WHERE formId=@formId AND questionId=@questionId");
      await tx.commit();
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ===== Submit response =====
  app.post("/api/responses/:formId/submit", async (req, res) => {
    const formId = Number(req.params.formId);
    const { respondent = {}, answers = [], clientMeta = null } = req.body || {};
    if (!formId) return res.status(400).json({ message: "Thiếu formId" });

    try {
      const pool = await poolPromise;
      const formRs = await pool.request()
        .input("formId", sql.Int, formId)
        .query("SELECT * FROM dbo.bm_Forms WHERE formId=@formId AND isDeleted=0 AND isActive=1");
      const form = formRs.recordset[0];
      if (!form) return res.status(404).json({ message: "Biểu mẫu không tồn tại hoặc đã đóng" });

      if (form.startAt && new Date() < new Date(form.startAt)) {
        return res.status(400).json({ message: "Biểu mẫu chưa mở nhận phản hồi" });
      }
      if (form.endAt && new Date() > new Date(form.endAt)) {
        return res.status(400).json({ message: "Biểu mẫu đã hết hạn nhận phản hồi" });
      }

      if (form.requireName && !String(respondent.name || "").trim()) {
        return res.status(400).json({ message: "Thiếu họ tên" });
      }
      if (form.requirePhone && !String(respondent.phone || "").trim()) {
        return res.status(400).json({ message: "Thiếu số điện thoại" });
      }
      if (form.requireDept && !String(respondent.department || "").trim()) {
        return res.status(400).json({ message: "Thiếu bộ phận" });
      }

      if (!form.allowMultiple && respondent.phone) {
        const dup = await pool.request()
          .input("formId", sql.Int, formId)
          .input("phone", sql.NVarChar(30), String(respondent.phone))
          .query(`
            SELECT TOP 1 responseId
            FROM dbo.bm_Responses
            WHERE formId=@formId AND respondentPhone=@phone AND isValid=1
          `);
        if (dup.recordset[0]) {
          return res.status(409).json({ message: "SĐT đã gửi biểu mẫu này trước đó" });
        }
      }

      const qRs = await pool.request().input("formId", sql.Int, formId).query(`
        SELECT questionId, questionType, isRequired
        FROM dbo.bm_Questions
        WHERE formId=@formId AND isActive=1
      `);
      const qMap = new Map(qRs.recordset.map((q) => [q.questionId, q]));
      const answerMap = new Map((answers || []).map((a) => [Number(a.questionId), a]));

      for (const q of qRs.recordset) {
        if (!q.isRequired) continue;
        const a = answerMap.get(q.questionId);
        if (!a) return res.status(400).json({ message: `Thiếu câu trả lời bắt buộc (ID ${q.questionId})` });
        const hasText = String(a.answerText || "").trim().length > 0;
        const hasNumber = a.answerNumber !== undefined && a.answerNumber !== null && a.answerNumber !== "";
        const hasOptions = Array.isArray(a.answerOptions) && a.answerOptions.length > 0;
        if (!(hasText || hasNumber || hasOptions)) {
          return res.status(400).json({ message: `Thiếu câu trả lời bắt buộc (ID ${q.questionId})` });
        }
      }

      const tx = new sql.Transaction(pool);
      await tx.begin();

      const responseRs = await new sql.Request(tx)
        .input("formId", sql.Int, formId)
        .input("respondentUserId", sql.Int, Number(respondent.userId || 0) || null)
        .input("clientMeta", sql.NVarChar(sql.MAX), clientMeta ? JSON.stringify(clientMeta) : null)
        .input("name", sql.NVarChar(200), respondent.name || null)
        .input("phone", sql.NVarChar(30), respondent.phone || null)
        .input("dept", sql.NVarChar(200), respondent.department || null)
        .query(`
          INSERT INTO dbo.bm_Responses(formId, respondentUserId, clientMeta, respondentName, respondentPhone, respondentDept)
          VALUES(@formId, @respondentUserId, @clientMeta, @name, @phone, @dept);
          SELECT CAST(SCOPE_IDENTITY() AS INT) AS responseId
        `);
      const responseId = responseRs.recordset[0].responseId;

      for (const a of answers || []) {
        const q = qMap.get(Number(a.questionId));
        if (!q) continue;

        let answerText = null;
        let answerNumber = null;
        let answerOptions = null;

        if (["short_text", "long_text"].includes(q.questionType)) {
          const txt = String(a.answerText || "").trim();
          if (txt) answerText = txt;
        } else if (q.questionType === "linear_scale") {
          if (a.answerNumber !== undefined && a.answerNumber !== null && a.answerNumber !== "") {
            answerNumber = Number(a.answerNumber);
          }
        } else {
          const opts = Array.isArray(a.answerOptions) ? a.answerOptions.filter(Boolean) : [];
          if (opts.length) answerOptions = JSON.stringify(opts);
        }

        if (answerText === null && answerNumber === null && answerOptions === null) continue;

        await new sql.Request(tx)
          .input("responseId", sql.Int, responseId)
          .input("questionId", sql.Int, Number(a.questionId))
          .input("answerText", sql.NVarChar(sql.MAX), answerText)
          .input("answerNumber", sql.Decimal(18, 4), answerNumber)
          .input("answerOptions", sql.NVarChar(sql.MAX), answerOptions)
          .query(`
            INSERT INTO dbo.bm_ResponseAnswers(responseId, questionId, answerText, answerNumber, answerOptions)
            VALUES(@responseId, @questionId, @answerText, @answerNumber, @answerOptions)
          `);
      }

      await tx.commit();
      return res.json({ ok: true, responseId });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Internal Server Error" });
    }
  });

  // ===== Responses admin =====
  app.get("/api/forms/me/history", async (req, res) => {
    try {
      const userId = Number(req.query.userId || 0) || null;
      if (!userId) return res.json([]);
      const pool = await poolPromise;
      const rs = await pool.request()
        .input("userId", sql.Int, userId)
        .query(`
          SELECT TOP 200
            r.responseId, r.formId, r.submittedAt, r.createdAt,
            r.respondentName, r.respondentPhone, r.respondentDept, r.isValid,
            f.title AS formTitle, f.code AS formCode
          FROM dbo.bm_Responses r
          JOIN dbo.bm_Forms f ON f.formId = r.formId
          WHERE r.respondentUserId = @userId
          ORDER BY r.createdAt DESC, r.responseId DESC
        `);
      return res.json(rs.recordset || []);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/forms/:id/responses", async (req, res) => {
    const formId = Number(req.params.id);
    try {
      const pool = await poolPromise;
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 10));
      const offset = (page - 1) * pageSize;
      const q = (req.query.q || "").trim();
      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;

      const request = pool.request()
        .input("formId", sql.Int, formId)
        .input("q", sql.NVarChar(300), q || null)
        .input("from", sql.DateTime2, from || null)
        .input("to", sql.DateTime2, to || null)
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize);

      const where = `
        WHERE formId=@formId
          AND (@from IS NULL OR createdAt >= @from)
          AND (@to IS NULL OR createdAt < @to)
          AND (@q IS NULL OR respondentName LIKE '%'+@q+'%' OR respondentPhone LIKE '%'+@q+'%' OR respondentDept LIKE '%'+@q+'%')
      `;

      const dataRs = await request.query(`
        SELECT responseId, formId, createdAt, isValid, respondentName, respondentPhone, respondentDept
        FROM dbo.bm_Responses
        ${where}
        ORDER BY createdAt DESC, responseId DESC
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
      `);

      const countRs = await pool.request()
        .input("formId", sql.Int, formId)
        .input("q", sql.NVarChar(300), q || null)
        .input("from", sql.DateTime2, from || null)
        .input("to", sql.DateTime2, to || null)
        .query(`SELECT COUNT(1) AS total FROM dbo.bm_Responses ${where}`);

      return res.json({
        data: dataRs.recordset,
        total: countRs.recordset[0]?.total || 0,
        page,
        pageSize,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.patch("/api/responses/:responseId/valid", async (req, res) => {
    try {
      const pool = await poolPromise;
      await pool.request()
        .input("responseId", sql.Int, Number(req.params.responseId))
        .input("isValid", sql.Bit, !!req.body.isValid)
        .query(`
          UPDATE dbo.bm_Responses
          SET isValid=@isValid, updatedAt=SYSUTCDATETIME()
          WHERE responseId=@responseId
        `);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/responses/:responseId", async (req, res) => {
    try {
      const responseId = Number(req.params.responseId);
      const pool = await poolPromise;
      const responseRs = await pool.request()
        .input("responseId", sql.Int, responseId)
        .query(`
          SELECT r.*, f.title AS formTitle
          FROM dbo.bm_Responses r
          JOIN dbo.bm_Forms f ON f.formId = r.formId
          WHERE r.responseId=@responseId
        `);
      const response = responseRs.recordset[0];
      if (!response) return res.status(404).json({ error: "Response not found" });

      const answersRs = await pool.request()
        .input("responseId", sql.Int, responseId)
        .query(`
          SELECT q.questionId, q.questionText, q.helpText, q.questionType,
                 a.answerText, a.answerNumber, a.answerOptions
          FROM dbo.bm_ResponseAnswers a
          JOIN dbo.bm_Questions q ON q.questionId = a.questionId
          WHERE a.responseId=@responseId
          ORDER BY ISNULL(q.sectionId, 0), q.displayOrder, q.questionId
        `);

      return res.json({
        formTitle: response.formTitle,
        response,
        answers: answersRs.recordset.map((a) => ({
          ...a,
          answerOptions: a.answerOptions ? JSON.parse(a.answerOptions) : [],
        })),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/api/forms/:id/responses/export", async (req, res) => {
    const formId = Number(req.params.id);
    const b = req.body || {};
    try {
      const pool = await poolPromise;
      const rs = await pool.request()
        .input("formId", sql.Int, formId)
        .input("q", sql.NVarChar(300), (b.q || "").trim() || null)
        .input("from", sql.DateTime2, b.from ? new Date(b.from) : null)
        .input("to", sql.DateTime2, b.to ? new Date(b.to) : null)
        .query(`
          SELECT r.responseId, r.createdAt, r.isValid,
                 r.respondentName, r.respondentPhone, r.respondentDept,
                 q.questionId, q.questionType, q.questionText,
                 a.answerText, a.answerNumber, a.answerOptions
          FROM dbo.bm_Responses r
          LEFT JOIN dbo.bm_ResponseAnswers a ON a.responseId = r.responseId
          LEFT JOIN dbo.bm_Questions q ON q.questionId = a.questionId
          WHERE r.formId=@formId
            AND (@from IS NULL OR r.createdAt >= @from)
            AND (@to IS NULL OR r.createdAt < @to)
            AND (@q IS NULL OR r.respondentName LIKE '%'+@q+'%' OR r.respondentPhone LIKE '%'+@q+'%' OR r.respondentDept LIKE '%'+@q+'%')
          ORDER BY r.createdAt DESC, r.responseId DESC, q.questionId
        `);

      const lines = [[
        "responseId", "createdAt", "isValid", "name", "phone", "dept",
        "questionId", "questionType", "questionText", "answerText", "answerNumber", "answerOptions",
      ].join(",")];

      for (const row of rs.recordset) {
        lines.push([
          row.responseId,
          row.createdAt ? new Date(row.createdAt).toISOString() : "",
          row.isValid ? 1 : 0,
          row.respondentName || "",
          row.respondentPhone || "",
          row.respondentDept || "",
          row.questionId || "",
          row.questionType || "",
          row.questionText || "",
          row.answerText || "",
          row.answerNumber ?? "",
          row.answerOptions || "",
        ].map(csvEscape).join(","));
      }

      const csv = lines.join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="responses_form_${formId}.csv"`);
      return res.send(csv);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ===== Analytics =====
  app.get("/api/forms/:id/analytics/summary", async (req, res) => {
    const formId = Number(req.params.id);
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    const q = (req.query.q || "").trim();
    try {
      const pool = await poolPromise;
      const request = pool.request()
        .input("formId", sql.Int, formId)
        .input("from", sql.DateTime2, from || null)
        .input("to", sql.DateTime2, to || null)
        .input("q", sql.NVarChar(300), q || null);

      const whereResp = `
        FROM dbo.bm_Responses r
        WHERE r.formId=@formId
          AND (@from IS NULL OR r.createdAt >= @from)
          AND (@to IS NULL OR r.createdAt < @to)
          AND (@q IS NULL OR r.respondentName LIKE '%'+@q+'%' OR r.respondentPhone LIKE '%'+@q+'%' OR r.respondentDept LIKE '%'+@q+'%')
      `;

      const [totals, byDay, byWeek, csat, topOptions] = await Promise.all([
        request.query(`SELECT COUNT(1) AS responses, SUM(CASE WHEN r.isValid=1 THEN 1 ELSE 0 END) AS validResponses ${whereResp}`),
        request.query(`SELECT CAST(r.createdAt AS date) AS d, COUNT(1) AS c ${whereResp} GROUP BY CAST(r.createdAt AS date) ORDER BY d`),
        request.query(`SELECT CONVERT(date, DATEADD(week, DATEDIFF(week,0,r.createdAt),0)) AS weekStart, COUNT(1) AS c ${whereResp} GROUP BY DATEADD(week, DATEDIFF(week,0,r.createdAt),0) ORDER BY weekStart`),
        request.query(`
          SELECT q.questionId, q.questionText, q.scaleMin, q.scaleMax, a.answerNumber AS val, COUNT(*) AS cnt
          FROM dbo.bm_Questions q
          JOIN dbo.bm_ResponseAnswers a ON a.questionId=q.questionId
          JOIN dbo.bm_Responses r ON r.responseId=a.responseId
          WHERE q.formId=@formId AND q.questionType='linear_scale' AND a.answerNumber IS NOT NULL
            AND (@from IS NULL OR r.createdAt >= @from)
            AND (@to IS NULL OR r.createdAt < @to)
            AND (@q IS NULL OR r.respondentName LIKE '%'+@q+'%' OR r.respondentPhone LIKE '%'+@q+'%' OR r.respondentDept LIKE '%'+@q+'%')
          GROUP BY q.questionId, q.questionText, q.scaleMin, q.scaleMax, a.answerNumber
          ORDER BY q.questionId, val
        `),
        request.query(`
          SELECT q.questionId, q.questionText, j.value AS opt, COUNT(*) AS cnt
          FROM dbo.bm_Questions q
          JOIN dbo.bm_ResponseAnswers a ON a.questionId=q.questionId
          JOIN dbo.bm_Responses r ON r.responseId=a.responseId
          CROSS APPLY OPENJSON(a.answerOptions) j
          WHERE q.formId=@formId AND q.questionType IN ('multiple_choice','checkboxes','dropdown')
            AND a.answerOptions IS NOT NULL
            AND (@from IS NULL OR r.createdAt >= @from)
            AND (@to IS NULL OR r.createdAt < @to)
            AND (@q IS NULL OR r.respondentName LIKE '%'+@q+'%' OR r.respondentPhone LIKE '%'+@q+'%' OR r.respondentDept LIKE '%'+@q+'%')
          GROUP BY q.questionId, q.questionText, j.value
          ORDER BY q.questionId, cnt DESC
        `),
      ]);

      const csatMap = new Map();
      for (const r of csat.recordset) {
        if (!csatMap.has(r.questionId)) {
          csatMap.set(r.questionId, {
            questionId: r.questionId,
            questionText: r.questionText,
            min: r.scaleMin,
            max: r.scaleMax,
            dist: [],
          });
        }
        csatMap.get(r.questionId).dist.push({ value: Number(r.val), count: Number(r.cnt) });
      }

      const topMap = new Map();
      for (const r of topOptions.recordset) {
        if (!topMap.has(r.questionId)) {
          topMap.set(r.questionId, {
            questionId: r.questionId,
            questionText: r.questionText,
            items: [],
            total: 0,
          });
        }
        const item = topMap.get(r.questionId);
        item.items.push({ option: r.opt, count: Number(r.cnt) });
        item.total += Number(r.cnt);
      }

      return res.json({
        totals: {
          responses: Number(totals.recordset[0]?.responses || 0),
          validResponses: Number(totals.recordset[0]?.validResponses || 0),
        },
        byDay: byDay.recordset.map((r) => ({ date: r.d?.toISOString().slice(0, 10), count: Number(r.c) })),
        byWeek: byWeek.recordset.map((r) => ({ weekStart: r.weekStart?.toISOString().slice(0, 10), count: Number(r.c) })),
        csat: Array.from(csatMap.values()),
        topOptions: Array.from(topMap.values()),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/forms/:id/analytics/questions/:questionId", async (req, res) => {
    const formId = Number(req.params.id);
    const questionId = Number(req.params.questionId);
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    const q = (req.query.q || "").trim();

    try {
      const pool = await poolPromise;
      const qRs = await pool.request()
        .input("formId", sql.Int, formId)
        .input("questionId", sql.Int, questionId)
        .query(`
          SELECT questionId, questionType, questionText, scaleMin, scaleMax
          FROM dbo.bm_Questions
          WHERE formId=@formId AND questionId=@questionId
        `);
      const question = qRs.recordset[0];
      if (!question) return res.status(404).json({ error: "Question not found" });

      const request = pool.request()
        .input("formId", sql.Int, formId)
        .input("questionId", sql.Int, questionId)
        .input("from", sql.DateTime2, from || null)
        .input("to", sql.DateTime2, to || null)
        .input("q", sql.NVarChar(300), q || null);

      const where = `
        FROM dbo.bm_ResponseAnswers a
        JOIN dbo.bm_Responses r ON r.responseId=a.responseId
        WHERE a.questionId=@questionId AND r.formId=@formId
          AND (@from IS NULL OR r.createdAt >= @from)
          AND (@to IS NULL OR r.createdAt < @to)
          AND (@q IS NULL OR r.respondentName LIKE '%'+@q+'%' OR r.respondentPhone LIKE '%'+@q+'%' OR r.respondentDept LIKE '%'+@q+'%')
      `;

      if (question.questionType === "linear_scale") {
        const rs = await request.query(`
          SELECT a.answerNumber AS val, COUNT(*) AS cnt
          ${where}
          AND a.answerNumber IS NOT NULL
          GROUP BY a.answerNumber
          ORDER BY val
        `);
        const dist = rs.recordset.map((r) => ({ value: Number(r.val), count: Number(r.cnt) }));
        const total = dist.reduce((s, r) => s + r.count, 0);
        const sum = dist.reduce((s, r) => s + r.value * r.count, 0);
        return res.json({
          type: "linear_scale",
          questionId,
          questionText: question.questionText,
          min: question.scaleMin,
          max: question.scaleMax,
          dist,
          avg: total ? Number((sum / total).toFixed(2)) : 0,
        });
      }

      if (["multiple_choice", "checkboxes", "dropdown"].includes(question.questionType)) {
        const rs = await request.query(`
          SELECT j.value AS opt, COUNT(*) AS cnt
          ${where}
          AND a.answerOptions IS NOT NULL
          CROSS APPLY OPENJSON(a.answerOptions) j
          GROUP BY j.value
          ORDER BY cnt DESC, opt
        `);
        const items = rs.recordset.map((r) => ({ option: r.opt, count: Number(r.cnt) }));
        return res.json({
          type: "choice",
          questionId,
          questionText: question.questionText,
          items,
          total: items.reduce((s, i) => s + i.count, 0),
        });
      }

      const [sampleRs, countRs] = await Promise.all([
        request.query(`
          SELECT TOP 100 a.answerText, r.createdAt, r.respondentName, r.respondentDept
          ${where}
          AND a.answerText IS NOT NULL AND LTRIM(RTRIM(a.answerText)) <> ''
          ORDER BY r.createdAt DESC, a.answerId DESC
        `),
        request.query(`
          SELECT COUNT(1) AS totalAnswered
          ${where}
          AND a.answerText IS NOT NULL AND LTRIM(RTRIM(a.answerText)) <> ''
        `),
      ]);
      return res.json({
        type: "text",
        questionId,
        questionText: question.questionText,
        totalAnswered: Number(countRs.recordset[0]?.totalAnswered || 0),
        sample: sampleRs.recordset.map((r) => ({
          answerText: r.answerText,
          createdAt: r.createdAt,
          name: r.respondentName,
          dept: r.respondentDept,
        })),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });
}

module.exports = { apiForm };