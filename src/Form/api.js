const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");


function apiForm(app) {

// GET /api/bm/forms?activeOnly=1|0
app.get('/api/forms', async (req, res) => {
    
  try {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input('activeOnly', sql.Bit, req.query.activeOnly === '1')
      .query(`
        SELECT formId, title, description, isActive, allowMultiple, allowAnonymous,
               requireName, requirePhone, requireDept, startAt, endAt,
               createdBy, createdAt, updatedAt, publishedAt, code
        FROM dbo.bm_Forms
        WHERE ((@activeOnly=1 AND isActive=1) OR (@activeOnly=0)) AND isDeleted = 0
        ORDER BY updatedAt DESC, formId DESC
      `);
    res.json(rs.recordset);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal Server Error' });
  }
});


function slugify(input) {
  return String(input || '')
    .normalize('NFD')                      // tách dấu tiếng Việt
    .replace(/[\u0300-\u036f]/g, '')      // bỏ dấu
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')         // bỏ ký tự đặc biệt
    .trim()
    .replace(/\s+/g, '-')                 // space -> -
    .replace(/-+/g, '-');                 // gộp nhiều - thành 1
}
// POST /api/bm/forms
app.post('/api/forms', async (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim()) return res.status(400).json({ error: 'Thiếu title' });

  const raw = slugify(b.title);
  let code = raw || 'form';
  // đảm bảo không trùng: nếu trùng -> thêm -2, -3, ...
  const pool = await poolPromise;
  let i = 1;
  // kiểm tra tồn tại
  // Dùng vòng lặp nhỏ (rất nhanh vì có index unique)
  while (true) {
    const chk = await pool.request()
      .input('code', sql.NVarChar(200), code)
      .query(`SELECT 1 FROM dbo.bm_Forms WHERE code=@code`);
    if (chk.recordset.length === 0) break;
    i += 1;
    code = `${raw}-${i}`;
  }

  try {
    const pool = await poolPromise;
    const r = await pool.request()
      .input('title', sql.NVarChar(300), b.title.trim())
      .input('description', sql.NVarChar(sql.MAX), b.description || null)
      .input('isActive', sql.Bit, !!b.isActive)
      .input('allowMultiple', sql.Bit, !!b.allowMultiple)
      .input('allowAnonymous', sql.Bit, !!b.allowAnonymous)
      .input('requireName', sql.Bit, !!b.requireName)
      .input('requirePhone', sql.Bit, !!b.requirePhone)
      .input('requireDept', sql.Bit, !!b.requireDept)
      .input('startAt', sql.DateTime2, b.startAt || null)
      .input('endAt', sql.DateTime2, b.endAt || null)
      .input('createdBy', sql.Int, b.createdBy || null)
      .input('code', sql.NVarChar(200), code)
      .query(`
        INSERT INTO dbo.bm_Forms
        (title, description, isActive, allowMultiple, allowAnonymous,
         requireName, requirePhone, requireDept, startAt, endAt, createdBy, code)
        VALUES (@title, @description, @isActive, @allowMultiple, @allowAnonymous,
                @requireName, @requirePhone, @requireDept, @startAt, @endAt, @createdBy, @code);
        SELECT SCOPE_IDENTITY() AS formId, @code AS code;
      `);
    res.status(201).json({ formId: r.recordset[0].formId });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /api/bm/forms/:id/publish
app.patch('/api/forms/:id/publish', async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('formId', sql.Int, Number(req.params.id))
      .input('isActive', sql.Bit, !!req.body.isActive)
      .query(`
        UPDATE dbo.bm_Forms
        SET isActive=@isActive,
            publishedAt = CASE WHEN @isActive=1 THEN SYSUTCDATETIME() ELSE publishedAt END,
            updatedAt = SYSUTCDATETIME()
        WHERE formId=@formId;
      `);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/bm/forms/:id/sections
app.post('/api/forms/:id/sections', async (req, res) => {
  const formId = Number(req.params.id);
  const b = req.body || {};
  try {
    const pool = await poolPromise;
    const r = await pool.request()
      .input('formId', sql.Int, formId)
      .input('title', sql.NVarChar(300), b.title || null)
      .input('description', sql.NVarChar(sql.MAX), b.description || null)
      .input('displayOrder', sql.Int, b.displayOrder || 1)
      .query(`
        INSERT INTO dbo.bm_FormSections(formId, title, description, displayOrder)
        VALUES (@formId, @title, @description, @displayOrder);
        SELECT SCOPE_IDENTITY() AS sectionId;
      `);
    res.status(201).json({ sectionId: r.recordset[0].sectionId });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/bm/forms/:id/questions
app.post('/api/forms/:id/questions', async (req, res) => {
  const formId = Number(req.params.id);
  const b = req.body || {};
  if (!b.questionType || !b.questionText) return res.status(400).json({ error: 'Thiếu questionType/questionText' });

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const r1 = await new sql.Request(tx)
      .input('formId', sql.Int, formId)
      .input('sectionId', sql.Int, b.sectionId || null)
      .input('questionType', sql.NVarChar(50), b.questionType)
      .input('questionText', sql.NVarChar(sql.MAX), b.questionText)
      .input('helpText', sql.NVarChar(sql.MAX), b.helpText || null)
      .input('isRequired', sql.Bit, !!b.isRequired)
      .input('displayOrder', sql.Int, b.displayOrder || 1)
      .input('scaleMin', sql.Int, b.scaleMin ?? null)
      .input('scaleMax', sql.Int, b.scaleMax ?? null)
      .input('scaleMinLabel', sql.NVarChar(200), b.scaleMinLabel || null)
      .input('scaleMaxLabel', sql.NVarChar(200), b.scaleMaxLabel || null)
      .input('allowOtherOption', sql.Bit, !!b.allowOtherOption)
      .query(`
        INSERT INTO dbo.bm_Questions
        (formId, sectionId, questionType, questionText, helpText, isRequired, displayOrder,
         scaleMin, scaleMax, scaleMinLabel, scaleMaxLabel, allowOtherOption)
        VALUES (@formId, @sectionId, @questionType, @questionText, @helpText, @isRequired, @displayOrder,
                @scaleMin, @scaleMax, @scaleMinLabel, @scaleMaxLabel, @allowOtherOption);
        SELECT SCOPE_IDENTITY() AS questionId;
      `);

    const questionId = r1.recordset[0].questionId;

    if (Array.isArray(b.options) && b.options.length) {
      for (const [i, opt] of b.options.entries()) {
        await new sql.Request(tx)
          .input('questionId', sql.Int, questionId)
          .input('optionLabel', sql.NVarChar(500), opt.label)
          .input('optionValue', sql.NVarChar(200), opt.value || null)
          .input('displayOrder', sql.Int, opt.displayOrder || i + 1)
          .query(`
            INSERT INTO dbo.bm_QuestionOptions(questionId, optionLabel, optionValue, displayOrder)
            VALUES (@questionId, @optionLabel, @optionValue, @displayOrder);
          `);
      }
    }

    await tx.commit();
    res.status(201).json({ questionId });
  } catch (e) {
    await tx.rollback();
    console.error(e); res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/responses/:formId/submit', async (req, res) => {
  const formId = Number(req.params.formId);
  const { respondent = {}, answers = [], clientMeta = null } = req.body || {};

  if (!formId) return res.status(400).json({ message: 'Thiếu formId' });

  let pool;
  try {
    pool = await poolPromise;

    // lấy cấu hình form để validate và kiểm soát allowMultiple
    const formRs = await pool.request()
      .input('formId', sql.Int, formId)
      .query(`SELECT * FROM dbo.bm_Forms WHERE formId=@formId AND isActive=1`);
    const form = formRs.recordset[0];
    if (!form) return res.status(404).json({ message: 'Form không tồn tại hoặc đã đóng' });

    // validate thông tin người điền theo config
    if (form.requireName && !respondent.name)  return res.status(400).json({ message: 'Thiếu Họ tên' });
    if (form.requirePhone && !respondent.phone) return res.status(400).json({ message: 'Thiếu SĐT' });
    if (form.requireDept && !respondent.department) return res.status(400).json({ message: 'Thiếu Bộ phận' });

    // nếu không cho trùng phone (allowMultiple = 0)
    if (!form.allowMultiple && respondent.phone) {
      const dup = await pool.request()
        .input('formId', sql.Int, formId)
        .input('phone', sql.NVarChar(30), respondent.phone)
        .query(`
          SELECT TOP 1 responseId
          FROM dbo.bm_Responses
          WHERE formId=@formId AND respondentPhone=@phone AND isValid=1
        `);
      if (dup.recordset[0]) return res.status(409).json({ message: 'SĐT này đã gửi biểu mẫu trước đó' });
    }

    // lấy danh sách câu hỏi active để lọc answer hợp lệ
    const qs = await pool.request()
      .input('formId', sql.Int, formId)
      .query(`SELECT questionId, questionType FROM dbo.bm_Questions WHERE formId=@formId AND isActive=1`);
    const qset = new Map(qs.recordset.map(q => [q.questionId, q.questionType]));

    // bắt đầu transaction
    const tx = new sql.Transaction(pool);
    await tx.begin();

    // insert response
    const r1 = await new sql.Request(tx)
      .input('formId', sql.Int, formId)
      .input('respondentUserId', sql.Int, null)
      .input('clientMeta', sql.NVarChar(sql.MAX), clientMeta ? JSON.stringify(clientMeta) : null)
      .input('name', sql.NVarChar(200), respondent.name || null)
      .input('phone', sql.NVarChar(30), respondent.phone || null)
      .input('dept', sql.NVarChar(200), respondent.department || null)
      .query(`
        INSERT INTO dbo.bm_Responses (formId, respondentUserId, clientMeta, respondentName, respondentPhone, respondentDept)
        VALUES (@formId, @respondentUserId, @clientMeta, @name, @phone, @dept);
        SELECT SCOPE_IDENTITY() AS responseId;
      `);

    const responseId = r1.recordset[0].responseId;

    // insert answers (lọc theo questionId hợp lệ)
    for (const a of answers) {
      const qType = qset.get(a.questionId);
      if (!qType) continue;

      let answerText = null, answerNumber = null, answerOptions = null;
      if (qType === 'short_text' || qType === 'long_text') {
        if (a.answerText && String(a.answerText).trim()) answerText = String(a.answerText).trim();
      } else if (qType === 'linear_scale') {
        if (a.answerNumber !== undefined && a.answerNumber !== null && a.answerNumber !== '') {
          answerNumber = Number(a.answerNumber);
        }
      } else { // multiple_choice / checkboxes / dropdown
        const arr = Array.isArray(a.answerOptions) ? a.answerOptions.filter(Boolean) : [];
        if (arr.length) answerOptions = JSON.stringify(arr);
      }

      if (answerText !== null || answerNumber !== null || answerOptions !== null) {
        await new sql.Request(tx)
          .input('responseId', sql.BigInt, responseId)
          .input('questionId', sql.Int, a.questionId)
          .input('answerText', sql.NVarChar(sql.MAX), answerText)
          .input('answerNumber', sql.Decimal(18, 4), answerNumber)
          .input('answerOptions', sql.NVarChar(sql.MAX), answerOptions)
          .query(`
            INSERT INTO dbo.bm_ResponseAnswers (responseId, questionId, answerText, answerNumber, answerOptions)
            VALUES (@responseId, @questionId, @answerText, @answerNumber, @answerOptions);
          `);
      }
    }

    await tx.commit();
    res.json({ ok: true, responseId });
  } catch (e) {
    console.error(e);
    try { if (pool) { /* ignore */ } } catch {}
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// api/src/routes/bmForms.js (thêm mới)
app.get('/api/forms/code/:code', async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  try {
    const pool = await poolPromise;
    const form = await pool.request()
      .input('code', sql.NVarChar(200), code)
      .query(`SELECT * FROM dbo.bm_Forms WHERE code=@code`);

    const f = form.recordset[0];
    if (!f) return res.status(404).json({ error: 'Form not found' });

    const [sections, questions, options] = await Promise.all([
      pool.request().input('formId', sql.Int, f.formId).query(`
        SELECT * FROM dbo.bm_FormSections WHERE formId=@formId ORDER BY displayOrder, sectionId;
      `),
      pool.request().input('formId', sql.Int, f.formId).query(`
        SELECT * FROM dbo.bm_Questions WHERE formId=@formId ORDER BY displayOrder, questionId;
      `),
      pool.request().input('formId', sql.Int, f.formId).query(`
        SELECT qo.*
        FROM dbo.bm_QuestionOptions qo
        JOIN dbo.bm_Questions q ON q.questionId = qo.questionId
        WHERE q.formId = @formId
        ORDER BY qo.questionId, qo.displayOrder, qo.optionId;
      `),
    ]);

    const optByQ = options.recordset.reduce((m, o) => {
      (m[o.questionId] ||= []).push(o);
      return m;
    }, {});
    const qs = questions.recordset.map((q) => ({ ...q, options: optByQ[q.questionId] || [] }));

    res.json({ form: f, sections: sections.recordset, questions: qs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ĐẢM BẢO có cột isDeleted cho soft delete
// (chạy 1 lần khi deploy; bạn có thể chuyển vào script migrate)
async function ensureIsDeletedColumn() {
  const pool = await poolPromise;
  await pool.request().query(`
    IF COL_LENGTH('dbo.bm_Forms','isDeleted') IS NULL
      ALTER TABLE dbo.bm_Forms ADD isDeleted BIT NOT NULL CONSTRAINT DF_bm_Forms_isDeleted DEFAULT(0);
  `);
}
ensureIsDeletedColumn().catch(()=>{});

// GET /api/bm/forms?activeOnly=0|1&from=&to=&q=&page=&pageSize=
app.get('/api/forms', async (req, res) => {
  try {
    const pool = await poolPromise;

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const activeOnly =
      req.query.activeOnly === '1' ? 1 :
      req.query.activeOnly === '0' ? 0 : null;

    const q = (req.query.q || '').trim();
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;

    const request = pool.request()
      .input('activeOnly', sql.Bit, activeOnly !== null ? activeOnly : null)
      .input('q', sql.NVarChar(300), q || null)
      .input('from', sql.DateTime2, from || null)
      .input('to', sql.DateTime2, to || null)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);

    const where = `
      WHERE isDeleted = 0
        AND (@activeOnly IS NULL OR isActive = @activeOnly)
        AND (@from IS NULL OR createdAt >= @from)
        AND (@to   IS NULL OR createdAt <  @to)
        AND (@q IS NULL OR title LIKE '%'+@q+'%' OR code LIKE '%'+@q+'%')
    `;

    const dataQ = `
      SELECT formId, title, description, code, isActive, createdAt, updatedAt
      FROM dbo.bm_Forms
      ${where}
      ORDER BY updatedAt DESC, formId DESC
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
    `;

    const countQ = `
      SELECT COUNT(1) AS total
      FROM dbo.bm_Forms
      ${where};
    `;

    const [data, count] = await Promise.all([
      request.query(dataQ),
      request.query(countQ),
    ]);

    res.json({
      data: data.recordset,
      total: count.recordset[0].total,
      page,
      pageSize,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /api/bm/forms/:id/publish  { isActive: 0|1 }
app.patch('/api/forms/:id/publish', async (req, res) => {
  const formId = Number(req.params.id);
  const isActive = !!req.body.isActive;
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('formId', sql.Int, formId)
      .input('isActive', sql.Bit, isActive)
      .query(`
        UPDATE dbo.bm_Forms
        SET isActive=@isActive,
            publishedAt = CASE WHEN @isActive=1 THEN SYSUTCDATETIME() ELSE publishedAt END,
            updatedAt = SYSUTCDATETIME()
        WHERE formId=@formId AND isDeleted=0;
      `);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/bm/forms/:id/duplicate
app.post('/api/forms/:id/duplicate', async (req, res) => {
  const srcId = Number(req.params.id);
  let pool;
  try {
    pool = await poolPromise;

    // lấy form gốc
    const frs = await pool.request()
      .input('formId', sql.Int, srcId)
      .query(`SELECT * FROM dbo.bm_Forms WHERE formId=@formId AND isDeleted=0`);
    const src = frs.recordset[0];
    if (!src) return res.status(404).json({ error: 'Form not found' });

    // lấy sections, questions, options
    const [sections, questions, options] = await Promise.all([
      pool.request().input('formId', sql.Int, srcId)
        .query(`SELECT * FROM dbo.bm_FormSections WHERE formId=@formId ORDER BY displayOrder, sectionId`),
      pool.request().input('formId', sql.Int, srcId)
        .query(`SELECT * FROM dbo.bm_Questions WHERE formId=@formId ORDER BY displayOrder, questionId`),
      pool.request().input('formId', sql.Int, srcId)
        .query(`
          SELECT qo.*
          FROM dbo.bm_QuestionOptions qo
          JOIN dbo.bm_Questions q ON q.questionId = qo.questionId
          WHERE q.formId=@formId
          ORDER BY qo.questionId, qo.displayOrder, qo.optionId
        `),
    ]);

    const tx = new sql.Transaction(pool);
    await tx.begin();

    // tạo code mới duy nhất
    const base = slugify(src.title);
    let code = base || 'form';
    let i = 1;
    while (true) {
      const chk = await new sql.Request(tx)
        .input('code', sql.NVarChar(200), code)
        .query(`SELECT 1 FROM dbo.bm_Forms WHERE code=@code`);
      if (chk.recordset.length === 0) break;
      i += 1;
      code = `${base}-${i}`;
    }

    // chèn form mới (copy meta, tắt active mặc định)
    const rNew = await new sql.Request(tx)
      .input('title', sql.NVarChar(300), `${src.title} (Copy)`)
      .input('description', sql.NVarChar(sql.MAX), src.description)
      .input('isActive', sql.Bit, 0)
      .input('allowMultiple', sql.Bit, src.allowMultiple)
      .input('allowAnonymous', sql.Bit, src.allowAnonymous)
      .input('requireName', sql.Bit, src.requireName)
      .input('requirePhone', sql.Bit, src.requirePhone)
      .input('requireDept', sql.Bit, src.requireDept)
      .input('startAt', sql.DateTime2, src.startAt)
      .input('endAt', sql.DateTime2, src.endAt)
      .input('createdBy', sql.Int, src.createdBy)
      .input('code', sql.NVarChar(200), code)
      .query(`
        INSERT INTO dbo.bm_Forms
        (title, description, isActive, allowMultiple, allowAnonymous,
         requireName, requirePhone, requireDept, startAt, endAt, createdBy, code)
        VALUES (@title, @description, @isActive, @allowMultiple, @allowAnonymous,
                @requireName, @requirePhone, @requireDept, @startAt, @endAt, @createdBy, @code);
        SELECT SCOPE_IDENTITY() AS formId;
      `);
    const newFormId = rNew.recordset[0].formId;

    // map sectionId cũ -> mới
    const sectionIdMap = {};
    for (const s of sections.recordset) {
      const r = await new sql.Request(tx)
        .input('formId', sql.Int, newFormId)
        .input('title', sql.NVarChar(300), s.title)
        .input('description', sql.NVarChar(sql.MAX), s.description)
        .input('displayOrder', sql.Int, s.displayOrder)
        .query(`
          INSERT INTO dbo.bm_FormSections(formId, title, description, displayOrder)
          VALUES (@formId, @title, @description, @displayOrder);
          SELECT SCOPE_IDENTITY() AS sectionId;
        `);
      sectionIdMap[s.sectionId] = r.recordset[0].sectionId;
    }

    // map questionId cũ -> mới
    const qIdMap = {};
    for (const q of questions.recordset) {
      const r = await new sql.Request(tx)
        .input('formId', sql.Int, newFormId)
        .input('sectionId', sql.Int, q.sectionId ? sectionIdMap[q.sectionId] : null)
        .input('questionType', sql.NVarChar(50), q.questionType)
        .input('questionText', sql.NVarChar(sql.MAX), q.questionText)
        .input('helpText', sql.NVarChar(sql.MAX), q.helpText)
        .input('isRequired', sql.Bit, q.isRequired)
        .input('displayOrder', sql.Int, q.displayOrder)
        .input('scaleMin', sql.Int, q.scaleMin)
        .input('scaleMax', sql.Int, q.scaleMax)
        .input('scaleMinLabel', sql.NVarChar(200), q.scaleMinLabel)
        .input('scaleMaxLabel', sql.NVarChar(200), q.scaleMaxLabel)
        .input('allowOtherOption', sql.Bit, q.allowOtherOption)
        .query(`
          INSERT INTO dbo.bm_Questions
          (formId, sectionId, questionType, questionText, helpText, isRequired, displayOrder,
           scaleMin, scaleMax, scaleMinLabel, scaleMaxLabel, allowOtherOption)
          VALUES (@formId, @sectionId, @questionType, @questionText, @helpText, @isRequired, @displayOrder,
                  @scaleMin, @scaleMax, @scaleMinLabel, @scaleMaxLabel, @allowOtherOption);
          SELECT SCOPE_IDENTITY() AS questionId;
        `);
      qIdMap[q.questionId] = r.recordset[0].questionId;
    }

    // copy options
    for (const o of options.recordset) {
      await new sql.Request(tx)
        .input('questionId', sql.Int, qIdMap[o.questionId])
        .input('optionLabel', sql.NVarChar(500), o.optionLabel)
        .input('optionValue', sql.NVarChar(200), o.optionValue)
        .input('displayOrder', sql.Int, o.displayOrder)
        .query(`
          INSERT INTO dbo.bm_QuestionOptions(questionId, optionLabel, optionValue, displayOrder)
          VALUES (@questionId, @optionLabel, @optionValue, @displayOrder);
        `);
    }

    await tx.commit();
    res.json({ ok: true, formId: newFormId, code, title: `${src.title} (Copy)` });
  } catch (e) {
    try { /* rollback handled by driver if needed */ } catch {}
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /api/bm/forms/:id  (soft delete)
app.delete('/api/forms/:id', async (req, res) => {
  const formId = Number(req.params.id);
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('formId', sql.Int, formId)
      .query(`
        UPDATE dbo.bm_Forms
        SET isDeleted = 1, isActive = 0, updatedAt = SYSUTCDATETIME()
        WHERE formId=@formId AND isDeleted=0;
      `);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// GET /api/bm/forms/:id  -> trả meta + sections + questions (+ options)
app.get('/api/forms/:id', async (req, res) => {
  const formId = Number(req.params.id);
  try {
    const pool = await poolPromise;

    const fr = await pool.request()
      .input('formId', sql.Int, formId)
      .query(`SELECT * FROM dbo.bm_Forms WHERE formId=@formId AND isDeleted=0`);
    const form = fr.recordset[0];
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const [sections, questions, options] = await Promise.all([
      pool.request().input('formId', sql.Int, formId)
        .query(`SELECT * FROM dbo.bm_FormSections WHERE formId=@formId ORDER BY displayOrder, sectionId`),
      pool.request().input('formId', sql.Int, formId)
        .query(`SELECT * FROM dbo.bm_Questions WHERE formId=@formId ORDER BY sectionId, displayOrder, questionId`),
      pool.request().input('formId', sql.Int, formId).query(`
        SELECT qo.*
        FROM dbo.bm_QuestionOptions qo
        JOIN dbo.bm_Questions q ON q.questionId = qo.questionId
        WHERE q.formId=@formId
        ORDER BY qo.questionId, displayOrder, optionId
      `),
    ]);

    const optByQ = options.recordset.reduce((m, o) => {
      (m[o.questionId] ||= []).push(o); return m;
    }, {});
    const qs = questions.recordset.map(q => ({ ...q, options: optByQ[q.questionId] || [] }));

    res.json({ form, sections: sections.recordset, questions: qs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /api/bm/forms/:id  (update meta)
app.patch('/api/forms/:id', async (req, res) => {
  const formId = Number(req.params.id);
  const b = req.body || {};
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('formId', sql.Int, formId)
      .input('title', sql.NVarChar(300), b.title)
      .input('description', sql.NVarChar(sql.MAX), b.description || null)
      .input('allowMultiple', sql.Bit, !!b.allowMultiple)
      .input('allowAnonymous', sql.Bit, !!b.allowAnonymous)
      .input('requireName', sql.Bit, !!b.requireName)
      .input('requirePhone', sql.Bit, !!b.requirePhone)
      .input('requireDept', sql.Bit, !!b.requireDept)
      .input('startAt', sql.DateTime2, b.startAt ? new Date(b.startAt) : null)
      .input('endAt', sql.DateTime2, b.endAt ? new Date(b.endAt) : null)
      .query(`
        UPDATE dbo.bm_Forms
        SET title=@title, description=@description,
            allowMultiple=@allowMultiple, allowAnonymous=@allowAnonymous,
            requireName=@requireName, requirePhone=@requirePhone, requireDept=@requireDept,
            startAt=@startAt, endAt=@endAt,
            updatedAt=SYSUTCDATETIME()
        WHERE formId=@formId AND isDeleted=0;
      `);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal Server Error' }); }
});

/* ===================== Sections ===================== */

// helper: lấy next displayOrder
async function nextSectionOrder(pool, formId) {
  const r = await pool.request().input('formId', sql.Int, formId)
    .query(`SELECT ISNULL(MAX(displayOrder),0)+1 AS nextVal FROM dbo.bm_FormSections WHERE formId=@formId`);
  return r.recordset[0].nextVal || 1;
}

// POST /api/bm/forms/:id/sections
app.post('/api/forms/:id/sections', async (req, res) => {
  const formId = Number(req.params.id);
  const { title, description } = req.body || {};
  try {
    const pool = await poolPromise;
    const order = await nextSectionOrder(pool, formId);
    const r = await pool.request()
      .input('formId', sql.Int, formId)
      .input('title', sql.NVarChar(300), title || null)
      .input('description', sql.NVarChar(sql.MAX), description || null)
      .input('displayOrder', sql.Int, order)
      .query(`
        INSERT INTO dbo.bm_FormSections(formId, title, description, displayOrder)
        VALUES(@formId, @title, @description, @displayOrder);
        SELECT SCOPE_IDENTITY() AS sectionId;
      `);
    res.status(201).json({ ok: true, sectionId: r.recordset[0].sectionId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal Server Error' }); }
});

// PATCH /api/bm/forms/:id/sections/:sectionId
app.patch('/api/forms/:id/sections/:sectionId', async (req, res) => {
  const formId = Number(req.params.id);
  const sectionId = Number(req.params.sectionId);
  const { title, description, newDisplayOrder } = req.body || {};
  let pool;
  try {
    pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    if (newDisplayOrder !== undefined && newDisplayOrder !== null) {
      // đổi DisplayOrder bằng hoán vị 2 record (đơn giản, đã làm từ UI)
      await new sql.Request(tx)
        .input('formId', sql.Int, formId)
        .input('sectionId', sql.Int, sectionId)
        .input('displayOrder', sql.Int, Number(newDisplayOrder))
        .query(`
          UPDATE dbo.bm_FormSections SET displayOrder=@displayOrder
          WHERE formId=@formId AND sectionId=@sectionId;
        `);
    }
    if (title !== undefined || description !== undefined) {
      await new sql.Request(tx)
        .input('formId', sql.Int, formId)
        .input('sectionId', sql.Int, sectionId)
        .input('title', sql.NVarChar(300), title ?? null)
        .input('description', sql.NVarChar(sql.MAX), description ?? null)
        .query(`
          UPDATE dbo.bm_FormSections
          SET title=@title, description=@description
          WHERE formId=@formId AND sectionId=@sectionId;
        `);
    }

    await tx.commit();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal Server Error' }); }
});

// DELETE /api/bm/forms/:id/sections/:sectionId
app.delete('/api/forms/:id/sections/:sectionId', async (req, res) => {
  const formId = Number(req.params.id);
  const sectionId = Number(req.params.sectionId);
  let pool;
  try {
    pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    // chuyển question về null section
    await new sql.Request(tx)
      .input('formId', sql.Int, formId)
      .input('sectionId', sql.Int, sectionId)
      .query(`
        UPDATE dbo.bm_Questions SET sectionId=NULL
        WHERE formId=@formId AND sectionId=@sectionId;
      `);
    // xoá section
    await new sql.Request(tx)
      .input('formId', sql.Int, formId)
      .input('sectionId', sql.Int, sectionId)
      .query(`DELETE FROM dbo.bm_FormSections WHERE formId=@formId AND sectionId=@sectionId;`);

    await tx.commit();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal Server Error' }); }
});

/* ===================== Questions ===================== */

// helper next order per section (NULL section tính riêng)
async function nextQuestionOrder(pool, formId, sectionId) {
  const r = await pool.request()
    .input('formId', sql.Int, formId)
    .input('sectionId', sql.Int, sectionId || null)
    .query(`
      SELECT ISNULL(MAX(displayOrder),0)+1 AS nextVal
      FROM dbo.bm_Questions
      WHERE formId=@formId AND
            ((@sectionId IS NULL AND sectionId IS NULL) OR (sectionId=@sectionId));
    `);
  return r.recordset[0].nextVal || 1;
}

// POST /api/bm/forms/:id/questions
app.post('/api/forms/:id/questions', async (req, res) => {
  const formId = Number(req.params.id);
  const b = req.body || {};
  let pool;
  try {
    pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    const order = b.displayOrder || await nextQuestionOrder(pool, formId, b.sectionId || null);

    const r = await new sql.Request(tx)
      .input('formId', sql.Int, formId)
      .input('sectionId', sql.Int, b.sectionId || null)
      .input('questionType', sql.NVarChar(50), b.questionType)
      .input('questionText', sql.NVarChar(sql.MAX), b.questionText)
      .input('helpText', sql.NVarChar(sql.MAX), b.helpText || null)
      .input('isRequired', sql.Bit, !!b.isRequired)
      .input('displayOrder', sql.Int, order)
      .input('scaleMin', sql.Int, b.scaleMin || null)
      .input('scaleMax', sql.Int, b.scaleMax || null)
      .input('scaleMinLabel', sql.NVarChar(200), b.scaleMinLabel || null)
      .input('scaleMaxLabel', sql.NVarChar(200), b.scaleMaxLabel || null)
      .input('allowOtherOption', sql.Bit, !!b.allowOtherOption)
      .query(`
        INSERT INTO dbo.bm_Questions
        (formId, sectionId, questionType, questionText, helpText, isRequired, displayOrder,
         scaleMin, scaleMax, scaleMinLabel, scaleMaxLabel, allowOtherOption)
        VALUES (@formId, @sectionId, @questionType, @questionText, @helpText, @isRequired, @displayOrder,
                @scaleMin, @scaleMax, @scaleMinLabel, @scaleMaxLabel, @allowOtherOption);
        SELECT SCOPE_IDENTITY() AS questionId;
      `);
    const questionId = r.recordset[0].questionId;

    // options
    if (Array.isArray(b.options) && b.options.length > 0) {
      for (const o of b.options) {
        await new sql.Request(tx)
          .input('questionId', sql.Int, questionId)
          .input('optionLabel', sql.NVarChar(500), o.optionLabel)
          .input('optionValue', sql.NVarChar(200), o.optionValue || o.optionLabel)
          .input('displayOrder', sql.Int, o.displayOrder || 1)
          .query(`
            INSERT INTO dbo.bm_QuestionOptions(questionId, optionLabel, optionValue, displayOrder)
            VALUES (@questionId, @optionLabel, @optionValue, @displayOrder);
          `);
      }
    }

    await tx.commit();
    res.status(201).json({ ok: true, questionId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal Server Error' }); }
});

// PATCH /api/bm/forms/:id/questions/:questionId
app.patch('/api/forms/:id/questions/:questionId', async (req, res) => {
  const formId = Number(req.params.id);
  const questionId = Number(req.params.questionId);
  const b = req.body || {};
  let pool;
  try {
    pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    // đổi order (swap đã thực hiện từ UI, ở đây set trực tiếp newDisplayOrder)
    if (b.newDisplayOrder !== undefined && b.newDisplayOrder !== null) {
      await new sql.Request(tx)
        .input('formId', sql.Int, formId)
        .input('questionId', sql.Int, questionId)
        .input('displayOrder', sql.Int, Number(b.newDisplayOrder))
        .query(`
          UPDATE dbo.bm_Questions SET displayOrder=@displayOrder
          WHERE formId=@formId AND questionId=@questionId;
        `);
    }

    // update các field khác (nếu được truyền)
    const hasMetaField =
      ['sectionId','questionType','questionText','helpText','isRequired','scaleMin','scaleMax','scaleMinLabel','scaleMaxLabel','allowOtherOption']
        .some(k => b[k] !== undefined);

    if (hasMetaField) {
      await new sql.Request(tx)
        .input('formId', sql.Int, formId)
        .input('questionId', sql.Int, questionId)
        .input('sectionId', sql.Int, b.sectionId ?? null)
        .input('questionType', sql.NVarChar(50), b.questionType ?? null)
        .input('questionText', sql.NVarChar(sql.MAX), b.questionText ?? null)
        .input('helpText', sql.NVarChar(sql.MAX), b.helpText ?? null)
        .input('isRequired', sql.Bit, b.isRequired !== undefined ? !!b.isRequired : null)
        .input('scaleMin', sql.Int, b.scaleMin ?? null)
        .input('scaleMax', sql.Int, b.scaleMax ?? null)
        .input('scaleMinLabel', sql.NVarChar(200), b.scaleMinLabel ?? null)
        .input('scaleMaxLabel', sql.NVarChar(200), b.scaleMaxLabel ?? null)
        .input('allowOtherOption', sql.Bit, b.allowOtherOption !== undefined ? !!b.allowOtherOption : null)
        .query(`
          UPDATE dbo.bm_Questions
          SET sectionId=@sectionId,
              questionType=ISNULL(@questionType, questionType),
              questionText=ISNULL(@questionText, questionText),
              helpText=@helpText,
              isRequired=ISNULL(@isRequired, isRequired),
              scaleMin=@scaleMin,
              scaleMax=@scaleMax,
              scaleMinLabel=@scaleMinLabel,
              scaleMaxLabel=@scaleMaxLabel,
              allowOtherOption=ISNULL(@allowOtherOption, allowOtherOption)
          WHERE formId=@formId AND questionId=@questionId;
        `);
    }

    // nếu client gửi mảng options -> replace toàn bộ
    if (Array.isArray(b.options)) {
      await new sql.Request(tx)
        .input('questionId', sql.Int, questionId)
        .query(`DELETE FROM dbo.bm_QuestionOptions WHERE questionId=@questionId;`);

      for (const [i, o] of b.options.entries()) {
        await new sql.Request(tx)
          .input('questionId', sql.Int, questionId)
          .input('optionLabel', sql.NVarChar(500), o.optionLabel)
          .input('optionValue', sql.NVarChar(200), o.optionValue || o.optionLabel)
          .input('displayOrder', sql.Int, o.displayOrder || (i + 1))
          .query(`
            INSERT INTO dbo.bm_QuestionOptions(questionId, optionLabel, optionValue, displayOrder)
            VALUES (@questionId, @optionLabel, @optionValue, @displayOrder);
          `);
      }
    }

    await tx.commit();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal Server Error' }); }
});

// DELETE /api/bm/forms/:id/questions/:questionId
app.delete('/api/forms/:id/questions/:questionId', async (req, res) => {
  const formId = Number(req.params.id);
  const questionId = Number(req.params.questionId);
  let pool;
  try {
    pool = await poolPromise;
    const tx = new sql.Transaction(pool);
    await tx.begin();

    await new sql.Request(tx)
      .input('questionId', sql.Int, questionId)
      .query(`DELETE FROM dbo.bm_QuestionOptions WHERE questionId=@questionId;`);
    await new sql.Request(tx)
      .input('formId', sql.Int, formId)
      .input('questionId', sql.Int, questionId)
      .query(`DELETE FROM dbo.bm_Questions WHERE formId=@formId AND questionId=@questionId;`);

    await tx.commit();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal Server Error' }); }
});

/////=====================================================////////////////////////////////////////////////

// GET /api/bm/forms/:id/responses?from=&to=&q=&page=&pageSize=
app.get('/api/forms/:id/responses', async (req, res) => {
  const formId = Number(req.params.id);
  try {
    const pool = await poolPromise;

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const q = (req.query.q || '').trim();
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;

    const request = pool.request()
      .input('formId', sql.Int, formId)
      .input('from', sql.DateTime2, from || null)
      .input('to', sql.DateTime2, to || null)
      .input('q', sql.NVarChar(300), q || null)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);

    const where = `
      WHERE r.formId=@formId
        AND (@from IS NULL OR r.createdAt >= @from)
        AND (@to   IS NULL OR r.createdAt <  @to)
        AND (@q IS NULL OR r.respondentName LIKE '%'+@q+'%'
                       OR r.respondentPhone LIKE '%'+@q+'%'
                       OR r.respondentDept LIKE '%'+@q+'%')
    `;

    const dataQ = `
      SELECT r.responseId, r.formId, r.createdAt, r.isValid,
             r.respondentName, r.respondentPhone, r.respondentDept
      FROM dbo.bm_Responses r
      ${where}
      ORDER BY r.createdAt DESC, r.responseId DESC
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
    `;

    const countQ = `
      SELECT COUNT(1) AS total
      FROM dbo.bm_Responses r
      ${where};
    `;

    const [data, count] = await Promise.all([
      request.query(dataQ),
      request.query(countQ),
    ]);

    res.json({
      data: data.recordset,
      total: count.recordset[0]?.total ?? 0,
      page, pageSize,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/* =================== EXPORT CSV =================== */
// POST /api/bm/forms/:id/responses/export  (body: {from,to,q})
app.post('/api/forms/:id/responses/export', async (req, res) => {
  const formId = Number(req.params.id);
  const b = req.body || {};
  const fmt = (req.query.fmt || 'csv').toLowerCase();

  try {
    const pool = await poolPromise;

    const request = pool.request()
      .input('formId', sql.Int, formId)
      .input('from', sql.DateTime2, b.from ? new Date(b.from) : null)
      .input('to', sql.DateTime2, b.to ? new Date(b.to) : null)
      .input('q', sql.NVarChar(300), (b.q || '').trim() || null);

    const q = `
      SELECT 
        r.responseId, r.createdAt, r.isValid,
        r.respondentName, r.respondentPhone, r.respondentDept,
        r.clientIp, r.clientUa,
        q.questionId, q.questionText, q.questionType,
        a.answerText, a.answerNumber, a.answerOptions
      FROM dbo.bm_Responses r
      LEFT JOIN dbo.bm_ResponseAnswers a ON a.responseId = r.responseId
      LEFT JOIN dbo.bm_Questions q ON q.questionId = a.questionId
      WHERE r.formId=@formId
        AND (@from IS NULL OR r.createdAt >= @from)
        AND (@to   IS NULL OR r.createdAt <  @to)
        AND (@q IS NULL OR r.respondentName LIKE '%'+@q+'%'
                       OR r.respondentPhone LIKE '%'+@q+'%'
                       OR r.respondentDept LIKE '%'+@q+'%')
      ORDER BY r.createdAt DESC, r.responseId DESC, q.questionId;
    `;
    const rs = await request.query(q);
    const rows = rs.recordset || [];

    if (fmt === 'xlsx') {
      // ====== Build XLSX đẹp với exceljs ======
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Responses', {
        properties: { defaultRowHeight: 18 },
        views: [{ state: 'frozen', xSplit: 0, ySplit: 2 }] // freeze 2 dòng đầu (tiêu đề + header)
      });

      // Title
      const title = `Responses Form #${formId} (xuất lúc ${new Date().toLocaleString('vi-VN')})`;
      ws.mergeCells(1, 1, 1, 14);
      const t = ws.getCell(1, 1);
      t.value = title;
      t.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      t.font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };

      // Header
      const header = [
        'responseId','createdAt','isValid',
        'name','phone','dept','ip','ua',
        'questionId','questionType','questionText',
        'answerText','answerNumber','answerOptions'
      ];
      ws.addRow(header);

      // Style header
      const headerRow = ws.getRow(2);
      headerRow.eachCell((c) => {
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        c.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });
      ws.autoFilter = { from: 'A2', to: 'N2' };

      // Rows
      const toText = (v) => (v === null || v === undefined ? '' : String(v));
      for (const r of rows) {
        const line = [
          r.responseId,
          r.createdAt ? new Date(r.createdAt) : '',
          r.isValid ? 1 : 0,
          toText(r.respondentName),
          toText(r.respondentPhone),
          toText(r.respondentDept),
          toText(r.clientIp),
          toText(r.clientUa),
          r.questionId || '',
          toText(r.questionType),
          toText(r.questionText),
          toText(r.answerText),
          (r.answerNumber !== null && r.answerNumber !== undefined) ? Number(r.answerNumber) : '',
          Array.isArray(r.answerOptions) ? r.answerOptions.join(' | ') : toText(r.answerOptions)
        ];
        ws.addRow(line);
      }

      // Style body: zebra + wrap + border + định dạng cột
      const lastRow = ws.lastRow.number;
      for (let i = 3; i <= lastRow; i++) {
        const row = ws.getRow(i);
        const zebra = i % 2 === 1 ? 'FFF8FAFC' : 'FFFFFFFF'; // nhẹ
        row.eachCell((c, col) => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
          c.border = {
            top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          };
          c.alignment = { vertical: 'middle', horizontal: col === 12 ? 'left' : 'center', wrapText: true };
        });
      }

      // Format cột
      const cols = [
        { key: 'responseId', width: 12 },
        { key: 'createdAt',  width: 20, numFmt: 'yyyy-mm-dd hh:mm' },
        { key: 'isValid',    width: 8 },
        { key: 'name',       width: 20 },
        { key: 'phone',      width: 14 },
        { key: 'dept',       width: 16 },
        { key: 'ip',         width: 16 },
        { key: 'ua',         width: 40 },
        { key: 'questionId', width: 11 },
        { key: 'questionType', width: 14 },
        { key: 'questionText', width: 40 },
        { key: 'answerText',   width: 40 },
        { key: 'answerNumber', width: 14 },
        { key: 'answerOptions', width: 30 },
      ];
      ws.columns = cols.map(c => ({ header: '', key: c.key, width: c.width }));
      ws.getColumn(2).numFmt = 'yyyy-mm-dd hh:mm';

      // Auto height cho text dài
      ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
        if (rowNum >= 3) row.height = undefined; // để excel tự co giãn theo wrapText
      });

      // Xuất buffer
      const buffer = await wb.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="responses_form_${formId}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    // ===== CSV fallback (như bạn đã có) =====
    const header = [
      'responseId','createdAt','isValid',
      'name','phone','dept','ip','ua',
      'questionId','questionType','questionText',
      'answerText','answerNumber','answerOptions'
    ];
    const lines = [header.join(',')];

    for (const row of rows) {
      const vals = [
        row.responseId,
        row.createdAt ? new Date(row.createdAt).toISOString() : '',
        row.isValid ? 1 : 0,
        row.respondentName || '',
        row.respondentPhone || '',
        row.respondentDept || '',
        row.clientIp || '',
        (row.clientUa || '').replace(/"/g, '""'),
        row.questionId || '',
        row.questionType || '',
        (row.questionText || '').replace(/"/g, '""'),
        (row.answerText || '').replace(/"/g, '""'),
        row.answerNumber !== null && row.answerNumber !== undefined ? row.answerNumber : '',
        Array.isArray(row.answerOptions) ? `"${row.answerOptions.join('|').replace(/"/g,'""')}"` : ''
      ];
      const safe = vals.map((v) => {
        const s = String(v);
        return (/[,"\n]/.test(s)) ? `"${s.replace(/"/g,'""')}"` : s;
      });
      lines.push(safe.join(','));
    }

    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="responses_form_${formId}.csv"`);
    res.send(csv);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


/* =================== TOGGLE VALID =================== */
// PATCH /api/bm/responses/:responseId/valid { isValid: 0|1 }
app.patch('/api/responses/:responseId/valid', async (req, res) => {
  const responseId = Number(req.params.responseId);
  const isValid = !!req.body.isValid;
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('responseId', sql.Int, responseId)
      .input('isValid', sql.Bit, isValid)
      .query(`
        UPDATE dbo.bm_Responses
        SET isValid=@isValid, updatedAt=SYSUTCDATETIME()
        WHERE responseId=@responseId;
      `);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/* =================== DETAIL =================== */
// GET /api/bm/responses/:responseId
app.get('/api/responses/:responseId', async (req, res) => {
  const responseId = Number(req.params.responseId);
  try {
    const pool = await poolPromise;

    const rr = await pool.request()
      .input('responseId', sql.Int, responseId)
      .query(`
        SELECT r.*
             , f.title AS formTitle
        FROM dbo.bm_Responses r
        JOIN dbo.bm_Forms f ON f.formId = r.formId
        WHERE r.responseId=@responseId;
      `);
    const response = rr.recordset[0];
    if (!response) return res.status(404).json({ error: 'Response not found' });

    const ans = await pool.request()
      .input('responseId', sql.Int, responseId)
      .query(`
        SELECT a.questionId, q.questionText, q.helpText, q.questionType,
               a.answerText, a.answerNumber, a.answerOptions
        FROM dbo.bm_ResponseAnswers a
        JOIN dbo.bm_Questions q ON q.questionId = a.questionId
        WHERE a.responseId=@responseId
        ORDER BY q.sectionId, q.displayOrder, q.questionId;
      `);

    res.json({
      formTitle: response.formTitle,
      response,
      answers: ans.recordset
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


///////===========================\
/**
 * GET /api/bm/forms/:id/analytics/summary?from=&to=&q=
 * Trả về:
 * {
 *   totals: { responses, validResponses },
 *   byDay: [{ date: '2025-10-01', count: 12 }, ...],
 *   byWeek: [{ weekStart: '2025-09-28', count: 84 }, ...],  // tuần bắt đầu Chủ nhật (SQL Server default)
 *   csat: [{ questionId, questionText, min, max, dist: [{value,count}], avg }, ...],
 *   topOptions: [{ questionId, questionText, items: [{option,count}], total }, ...]
 * }
 */
app.get('/api/forms/:id/analytics/summary', async (req, res) => {
  const formId = Number(req.params.id);
  const from = req.query.from ? new Date(req.query.from) : null;
  const to   = req.query.to   ? new Date(req.query.to)   : null;
  const q    = (req.query.q || '').trim(); // name/phone/dept filter

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('formId', sql.Int, formId)
      .input('from', sql.DateTime2, from || null)
      .input('to', sql.DateTime2, to || null)
      .input('q', sql.NVarChar(300), q || null);

    const whereResp = `
      FROM dbo.bm_Responses r
      WHERE r.formId=@formId
        AND (@from IS NULL OR r.createdAt >= @from)
        AND (@to   IS NULL OR r.createdAt <  @to)
        AND (@q IS NULL OR r.respondentName  LIKE '%'+@q+'%'
                       OR r.respondentPhone LIKE '%'+@q+'%'
                       OR r.respondentDept  LIKE '%'+@q+'%')
    `;

    // 1) Totals
    const totalsQ = `
      SELECT
        COUNT(1) AS responses,
        SUM(CASE WHEN r.isValid=1 THEN 1 ELSE 0 END) AS validResponses
      ${whereResp};
    `;

    // 2) By day
    const byDayQ = `
      SELECT CAST(r.createdAt AS date) AS d, COUNT(*) AS c
      ${whereResp}
      GROUP BY CAST(r.createdAt AS date)
      ORDER BY d;
    `;

    // 3) By week (tuần bắt đầu Chủ nhật: DATEADD(week, DATEDIFF(week,0,createdAt), 0))
    const byWeekQ = `
      SELECT
        CONVERT(date, DATEADD(week, DATEDIFF(week, 0, r.createdAt), 0)) AS weekStart,
        COUNT(*) AS c
      ${whereResp}
      GROUP BY DATEADD(week, DATEDIFF(week, 0, r.createdAt), 0)
      ORDER BY weekStart;
    `;

    // 4) CSAT (linear_scale)
    const csatQ = `
      SELECT
        q.questionId, q.questionText,
        MIN(q.scaleMin) AS minVal, MAX(q.scaleMax) AS maxVal,
        a.answerNumber AS val, COUNT(*) AS cnt,
        AVG(CAST(a.answerNumber AS float)) OVER (PARTITION BY q.questionId) AS avgVal
      FROM dbo.bm_Questions q
      JOIN dbo.bm_ResponseAnswers a ON a.questionId = q.questionId
      JOIN dbo.bm_Responses r ON r.responseId = a.responseId
      WHERE q.formId=@formId
        AND q.questionType = 'linear_scale'
        AND a.answerNumber IS NOT NULL
        AND (@from IS NULL OR r.createdAt >= @from)
        AND (@to   IS NULL OR r.createdAt <  @to)
        AND (@q IS NULL OR r.respondentName  LIKE '%'+@q+'%'
                       OR r.respondentPhone LIKE '%'+@q+'%'
                       OR r.respondentDept  LIKE '%'+@q+'%')
      GROUP BY q.questionId, q.questionText, a.answerNumber, q.scaleMin, q.scaleMax
      ORDER BY q.questionId, val;
    `;

    // 5) Top options (multiple_choice | checkboxes | dropdown), a.answerOptions = JSON array
    const topOptQ = `
      SELECT
        q.questionId, q.questionText,
        j.value AS opt, COUNT(*) AS cnt
      FROM dbo.bm_Questions q
      JOIN dbo.bm_ResponseAnswers a ON a.questionId = q.questionId
      JOIN dbo.bm_Responses r ON r.responseId = a.responseId
      CROSS APPLY OPENJSON(a.answerOptions) j
      WHERE q.formId=@formId
        AND q.questionType IN ('multiple_choice','checkboxes','dropdown')
        AND a.answerOptions IS NOT NULL
        AND (@from IS NULL OR r.createdAt >= @from)
        AND (@to   IS NULL OR r.createdAt <  @to)
        AND (@q IS NULL OR r.respondentName  LIKE '%'+@q+'%'
                       OR r.respondentPhone LIKE '%'+@q+'%'
                       OR r.respondentDept  LIKE '%'+@q+'%')
      GROUP BY q.questionId, q.questionText, j.value
      ORDER BY q.questionId, cnt DESC;
    `;

    const [totals, byDay, byWeek, csat, topOpt] = await Promise.all([
      request.query(totalsQ),
      request.query(byDayQ),
      request.query(byWeekQ),
      request.query(csatQ),
      request.query(topOptQ),
    ]);

    // shape lại dữ liệu
    const byDayArr = byDay.recordset.map(r => ({ date: r.d.toISOString().slice(0,10), count: r.c }));
    const byWeekArr = byWeek.recordset.map(r => ({ weekStart: r.weekStart.toISOString().slice(0,10), count: r.c }));

    // CSAT
    const csatMap = new Map();
    for (const r of csat.recordset) {
      let e = csatMap.get(r.questionId);
      if (!e) {
        e = { questionId: r.questionId, questionText: r.questionText, min: r.minVal, max: r.maxVal, dist: [], avg: Number(r.avgVal?.toFixed(2) || 0) };
        csatMap.set(r.questionId, e);
      }
      e.dist.push({ value: r.val, count: r.cnt });
    }

    // Top options
    const topMap = new Map();
    for (const r of topOpt.recordset) {
      let e = topMap.get(r.questionId);
      if (!e) {
        e = { questionId: r.questionId, questionText: r.questionText, items: [], total: 0 };
        topMap.set(r.questionId, e);
      }
      e.items.push({ option: r.opt, count: r.cnt });
      e.total += r.cnt;
    }

    res.json({
      totals: {
        responses: totals.recordset[0]?.responses || 0,
        validResponses: totals.recordset[0]?.validResponses || 0,
      },
      byDay: byDayArr,
      byWeek: byWeekArr,
      csat: Array.from(csatMap.values()),
      topOptions: Array.from(topMap.values()),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /api/bm/forms/:id/analytics/questions/:questionId?from=&to=&q=
 * - Nếu linear_scale: { type:'linear_scale', dist:[{value,count}], avg, min, max }
 * - Nếu choice: { type:'choice', items:[{option,count}], total }
 * - Nếu text: { type:'text', sample:[{answerText, createdAt, name, dept}], totalAnswered }
 */
app.get('/api/forms/:id/analytics/questions/:questionId', async (req, res) => {
  const formId = Number(req.params.id);
  const questionId = Number(req.params.questionId);
  const from = req.query.from ? new Date(req.query.from) : null;
  const to   = req.query.to   ? new Date(req.query.to)   : null;
  const q    = (req.query.q || '').trim();

  try {
    const pool = await poolPromise;

    // Lấy loại câu hỏi
    const qInfo = await pool.request()
      .input('formId', sql.Int, formId)
      .input('questionId', sql.Int, questionId)
      .query(`
        SELECT questionId, questionType, questionText, scaleMin, scaleMax
        FROM dbo.bm_Questions
        WHERE formId=@formId AND questionId=@questionId;
      `);
    const info = qInfo.recordset[0];
    if (!info) return res.status(404).json({ error: 'Question not found' });

    const baseReq = pool.request()
      .input('formId', sql.Int, formId)
      .input('questionId', sql.Int, questionId)
      .input('from', sql.DateTime2, from || null)
      .input('to', sql.DateTime2, to || null)
      .input('q', sql.NVarChar(300), q || null);

    const where = `
      FROM dbo.bm_ResponseAnswers a
      JOIN dbo.bm_Responses r ON r.responseId = a.responseId
      WHERE a.questionId=@questionId
        AND r.formId=@formId
        AND (@from IS NULL OR r.createdAt >= @from)
        AND (@to   IS NULL OR r.createdAt <  @to)
        AND (@q IS NULL OR r.respondentName  LIKE '%'+@q+'%'
                       OR r.respondentPhone LIKE '%'+@q+'%'
                       OR r.respondentDept  LIKE '%'+@q+'%')
    `;

    if (info.questionType === 'linear_scale') {
      const rs = await baseReq.query(`
        SELECT a.answerNumber AS val, COUNT(*) AS cnt, 
               AVG(CAST(a.answerNumber AS float)) OVER () AS avgVal
        ${where}
        AND a.answerNumber IS NOT NULL
        GROUP BY a.answerNumber
        ORDER BY val;
      `);
      res.json({
        type: 'linear_scale',
        questionId,
        questionText: info.questionText,
        min: info.scaleMin, max: info.scaleMax,
        dist: rs.recordset.map(r => ({ value: r.val, count: r.cnt })),
        avg: rs.recordset[0] ? Number(rs.recordset[0].avgVal?.toFixed(2)) : 0
      });
      return;
    }

    if (['multiple_choice','checkboxes','dropdown'].includes(info.questionType)) {
      const rs = await baseReq.query(`
        SELECT j.value AS opt, COUNT(*) AS cnt
        ${where}
        AND a.answerOptions IS NOT NULL
        CROSS APPLY OPENJSON(a.answerOptions) j
        GROUP BY j.value
        ORDER BY cnt DESC, opt;
      `);
      const total = rs.recordset.reduce((s, r) => s + r.cnt, 0);
      res.json({
        type: 'choice',
        questionId,
        questionText: info.questionText,
        total,
        items: rs.recordset.map(r => ({ option: r.opt, count: r.cnt }))
      });
      return;
    }

    // Text-type
    const rs = await baseReq.query(`
      SELECT TOP 100
        a.answerText, r.createdAt, r.respondentName, r.respondentDept
      ${where}
        AND a.answerText IS NOT NULL AND LTRIM(RTRIM(a.answerText)) <> ''
      ORDER BY r.createdAt DESC, a.answerId DESC;
    `);
    const countAll = await baseReq.query(`
      SELECT COUNT(1) AS totalAnswered
      ${where}
        AND a.answerText IS NOT NULL AND LTRIM(RTRIM(a.answerText)) <> '';
    `);

    res.json({
      type: 'text',
      questionId,
      questionText: info.questionText,
      totalAnswered: countAll.recordset[0]?.totalAnswered || 0,
      sample: rs.recordset.map(r => ({
        answerText: r.answerText,
        createdAt: r.createdAt,
        name: r.respondentName,
        dept: r.respondentDept
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


}

module.exports = {
    apiForm,
}