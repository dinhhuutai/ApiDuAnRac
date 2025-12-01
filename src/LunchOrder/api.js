const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");

const uploadLunchOrder = require('../middleware/uploadLunchOrder');
const { sendPushToUsers } = require('../WebPush/pushService');
const { getLatestUnlockedMenu, getUsersNotOrderedForMenu } = require('../utils/lunchOrder');
const { getDatcomAdminUserIDs } = require('./helpers/datcomAdmins');
const { getCancelInfo } = require('./helpers/cancelInfo');

const repo = require('./lunchRepo');

const dayNameVN = (d) => (['','Thứ 2','Thứ 3','Thứ 4','Thứ 5','Thứ 6','Thứ 7','Chủ nhật'][d] || 'Ngày');
const tabLabel  = (s) => (s === 'ws' ? 'Đi ca' : s === 'ot' ? 'Tăng ca' : 'Ca ngày');

function normalizeFoodCode(name = "") {
    return String(name)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  // Parse branches từ body (JSON hoặc multipart)
  function parseBranches(req) {
    try {
      const raw = req.body.branches;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      // nếu là string (multipart), parse JSON
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

function apiLunchOrder(app) {

    // ===== List foods =====
  app.get("/api/foods", async (req, res) => {
    const q = (req.query.q || "").trim();
    try {
      const pool = await poolPromise;
      let rs;
      if (q) {
        rs = await pool.request()
          .input("q", sql.NVarChar, `%${q}%`)
          .query(`
            SELECT foodId, foodName, foodCode, description, imageUrl, colorCode
            FROM dbo.dc_Foods
            WHERE foodName LIKE @q OR foodCode LIKE @q
            ORDER BY foodName
          `);
      } else {
        rs = await pool.request().query(`
          SELECT foodId, foodName, foodCode, description, imageUrl, colorCode
          FROM dbo.dc_Foods
          ORDER BY createdAt DESC
        `);
      }
      res.json(rs.recordset || []);
    } catch (err) {
      console.error("Foods list error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ===== Get branches by food =====
  app.get("/api/foods/:id/branches", async (req, res) => {
    try {
      const pool = await poolPromise;
      const rs = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          SELECT branchId, foodId, branchName, isActive, sortOrder, createdAt, updatedAt
          FROM dbo.dc_FoodBranches
          WHERE foodId=@id
          ORDER BY sortOrder, branchId
        `);
      res.json(rs.recordset || []);
    } catch (err) {
      console.error("Get branches error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Create food (with optional branches) =====
  app.post("/api/foods", uploadLunchOrder.single("image"), async (req, res) => {
  const { foodName, description, colorCode } = req.body || {};
  const imageUrl = req.file?.path || req.body?.imageUrl || null;
  const foodCode = normalizeFoodCode(foodName);
  const branches = parseBranches(req); // [{branchId?, branchName, isActive?, sortOrder?}, ...]

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // Insert food
    const rsFood = await new sql.Request(tx)
      .input("foodName", sql.NVarChar(100), foodName)
      .input("foodCode", sql.NVarChar(100), foodCode)
      .input("description", sql.NVarChar(500), description || "")
      .input("imageUrl", sql.NVarChar(500), imageUrl)
      .input("colorCode", sql.NVarChar(10), colorCode || "#fef3c7")
      .query(`
        INSERT INTO dbo.dc_Foods (foodName, foodCode, description, imageUrl, colorCode, createdAt)
        OUTPUT INSERTED.foodId
        VALUES (@foodName, @foodCode, @description, @imageUrl, @colorCode, SYSUTCDATETIME())
      `);

    const newFoodId = rsFood.recordset?.[0]?.foodId;

    // Insert branches nếu có
    if (Array.isArray(branches) && branches.length) {
      for (const b of branches) {
        const name = String(b?.branchName || "").trim();
        if (!name) continue;
        const isActive = typeof b?.isActive === "boolean" ? b.isActive : true;
        const sortOrder = Number.isFinite(+b?.sortOrder) ? parseInt(b.sortOrder, 10) : 0;

        await new sql.Request(tx)
          .input("foodId", sql.Int, newFoodId)
          .input("branchName", sql.NVarChar(200), name)
          .input("isActive", sql.Bit, isActive ? 1 : 0)
          .input("sortOrder", sql.Int, sortOrder)
          .query(`
            INSERT INTO dbo.dc_FoodBranches (foodId, branchName, isActive, sortOrder, createdAt)
            VALUES (@foodId, @branchName, @isActive, @sortOrder, SYSUTCDATETIME())
          `);
      }
    }

    await tx.commit();
    res.json({ success: true, message: "Tạo món ăn thành công", foodId: newFoodId });
  } catch (err) {
    if (tx._aborted !== true) { try { await tx.rollback(); } catch {} }
    console.error("Create food error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

  // ===== Update food (with optional branches upsert + prune) =====
  app.put("/api/foods/:id", uploadLunchOrder.single("image"), async (req, res) => {
  const { id } = req.params;
  const { foodName, description, imageUrl: imageUrlBody, colorCode } = req.body || {};
  const imageUrl = req.file?.path || imageUrlBody || null;
  const branches = parseBranches(req);

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // Update food
    await new sql.Request(tx)
      .input("id", sql.Int, id)
      .input("foodName", sql.NVarChar(100), foodName)
      .input("description", sql.NVarChar(500), description || "")
      .input("imageUrl", sql.NVarChar(500), imageUrl)
      .input("colorCode", sql.NVarChar(10), colorCode || "#fef3c7")
      .query(`
        UPDATE dbo.dc_Foods
        SET foodName=@foodName, description=@description, imageUrl=@imageUrl, colorCode=@colorCode, updatedAt=SYSUTCDATETIME()
        WHERE foodId=@id
      `);

    if (Array.isArray(branches)) {
      // lấy branches hiện có
      const cur = await new sql.Request(tx)
        .input("id", sql.Int, id)
        .query(`SELECT branchId FROM dbo.dc_FoodBranches WHERE foodId=@id`);

      const currentIds = new Set(cur.recordset.map(r => r.branchId));
      const keepIds = new Set(
        branches.filter(b => Number.isInteger(+b.branchId)).map(b => parseInt(b.branchId, 10))
      );

      // xoá những cái không còn
      for (const existingId of currentIds) {
        if (!keepIds.has(existingId)) {
          await new sql.Request(tx)
            .input("bid", sql.Int, existingId)
            .query(`DELETE FROM dbo.dc_FoodBranches WHERE branchId=@bid`);
        }
      }

      // upsert
      for (const b of branches) {
        const name = String(b?.branchName || "").trim();
        if (!name) continue;
        const isActive = typeof b?.isActive === "boolean" ? b.isActive : true;
        const sortOrder = Number.isFinite(+b?.sortOrder) ? parseInt(b.sortOrder, 10) : 0;

        if (Number.isInteger(+b.branchId)) {
          await new sql.Request(tx)
            .input("branchId", sql.Int, parseInt(b.branchId, 10))
            .input("branchName", sql.NVarChar(200), name)
            .input("isActive", sql.Bit, isActive ? 1 : 0)
            .input("sortOrder", sql.Int, sortOrder)
            .query(`
              UPDATE dbo.dc_FoodBranches
              SET branchName=@branchName, isActive=@isActive, sortOrder=@sortOrder, updatedAt=SYSUTCDATETIME()
              WHERE branchId=@branchId
            `);
        } else {
          await new sql.Request(tx)
            .input("foodId", sql.Int, id)
            .input("branchName", sql.NVarChar(200), name)
            .input("isActive", sql.Bit, isActive ? 1 : 0)
            .input("sortOrder", sql.Int, sortOrder)
            .query(`
              INSERT INTO dbo.dc_FoodBranches (foodId, branchName, isActive, sortOrder, createdAt)
              VALUES (@foodId, @branchName, @isActive, @sortOrder, SYSUTCDATETIME())
            `);
        }
      }
    }

    await tx.commit();
    res.json({ success: true });
  } catch (err) {
    if (tx._aborted !== true) { try { await tx.rollback(); } catch {} }
    console.error("Update food error:", err);
    res.status(500).json({ error: err.message });
  }
});

  // ===== Delete food =====
  app.delete("/api/foods/:id", async (req, res) => {
    try {
      const pool = await poolPromise;
      await pool.request().input("id", sql.Int, req.params.id)
        .query("DELETE FROM dbo.dc_Foods WHERE foodId=@id");
      // FK ON DELETE CASCADE sẽ tự xoá branches
      res.json({ success: true });
    } catch (err) {
      console.log(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Bulk upsert branches riêng (tuỳ chọn) =====
  app.post("/api/foods/:id/branches/bulk", async (req, res) => {
  const { id } = req.params;
  const branches = Array.isArray(req.body?.branches) ? req.body.branches : [];

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const cur = await new sql.Request(tx)
      .input("id", sql.Int, id)
      .query(`SELECT branchId FROM dbo.dc_FoodBranches WHERE foodId=@id`);

    const currentIds = new Set(cur.recordset.map(r => r.branchId));
    const keepIds = new Set(
      branches.filter(b => Number.isInteger(+b.branchId)).map(b => parseInt(b.branchId, 10))
    );

    for (const existingId of currentIds) {
      if (!keepIds.has(existingId)) {
        await new sql.Request(tx)
          .input("bid", sql.Int, existingId)
          .query(`DELETE FROM dbo.dc_FoodBranches WHERE branchId=@bid`);
      }
    }

    for (const b of branches) {
      const name = String(b?.branchName || "").trim();
      if (!name) continue;
      const isActive = typeof b?.isActive === "boolean" ? b.isActive : true;
      const sortOrder = Number.isFinite(+b?.sortOrder) ? parseInt(b.sortOrder, 10) : 0;

      if (Number.isInteger(+b.branchId)) {
        await new sql.Request(tx)
          .input("branchId", sql.Int, parseInt(b.branchId, 10))
          .input("branchName", sql.NVarChar(200), name)
          .input("isActive", sql.Bit, isActive ? 1 : 0)
          .input("sortOrder", sql.Int, sortOrder)
          .query(`
            UPDATE dbo.dc_FoodBranches
            SET branchName=@branchName, isActive=@isActive, sortOrder=@sortOrder, updatedAt=SYSUTCDATETIME()
            WHERE branchId=@branchId
          `);
      } else {
        await new sql.Request(tx)
          .input("foodId", sql.Int, id)
          .input("branchName", sql.NVarChar(200), name)
          .input("isActive", sql.Bit, isActive ? 1 : 0)
          .input("sortOrder", sql.Int, sortOrder)
          .query(`
            INSERT INTO dbo.dc_FoodBranches (foodId, branchName, isActive, sortOrder, createdAt)
            VALUES (@foodId, @branchName, @isActive, @sortOrder, SYSUTCDATETIME())
          `);
      }
    }

    await tx.commit();
    res.json({ success: true });
  } catch (err) {
    if (tx._aborted !== true) { try { await tx.rollback(); } catch {} }
    console.error("Bulk branches error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET: /api/foods/with-branches
// Trả về [{ foodId, foodName, ..., branches: [{branchId, branchName, isActive, sortOrder}] }]
app.get("/api/foods/with-branches", async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const pool = await poolPromise;

    // 1) lấy foods
    const foodsRs = q
      ? await pool.request()
          .input("q", sql.NVarChar, `%${q}%`)
          .query(`
            SELECT foodId, foodName, foodCode, description, imageUrl, colorCode
            FROM dbo.dc_Foods
            WHERE foodName LIKE @q OR foodCode LIKE @q
            ORDER BY foodName
          `)
      : await pool.request().query(`
            SELECT foodId, foodName, foodCode, description, imageUrl, colorCode
            FROM dbo.dc_Foods
            ORDER BY createdAt DESC
        `);

    const foods = foodsRs.recordset || [];
    if (foods.length === 0) return res.json([]);

    // 2) lấy tất cả branches theo danh sách foodId
    const ids = foods.map(f => f.foodId);
    // tạo bảng tạm cho IN list
    const tvp = new sql.Table(); // Table-Valued Param (tạm)
    tvp.columns.add('id', sql.Int);
    ids.forEach(id => tvp.rows.add(id));

    const branchesRs = await pool.request()
      .input('ids', tvp)
      .query(`
        WITH ids AS (
          SELECT id FROM @ids
        )
        SELECT b.branchId, b.foodId, b.branchName, b.isActive, b.sortOrder
        FROM dbo.dc_FoodBranches b
        INNER JOIN ids ON ids.id = b.foodId
        ORDER BY b.foodId, b.sortOrder, b.branchId
      `);

    const byFood = new Map();
    for (const b of branchesRs.recordset || []) {
      if (!byFood.has(b.foodId)) byFood.set(b.foodId, []);
      byFood.get(b.foodId).push({
        branchId: b.branchId,
        branchName: b.branchName,
        isActive: !!b.isActive,
        sortOrder: b.sortOrder ?? 0,
      });
    }

    const merged = foods.map(f => ({
      ...f,
      branches: byFood.get(f.foodId) || [],
    }));

    res.json(merged);
  } catch (err) {
    console.error("foods/with-branches error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

  // ===== Delete 1 branch =====
  app.delete("/api/foods/:id/branches/:branchId", async (req, res) => {
    try {
      const pool = await poolPromise;
      await pool.request()
        .input("bid", sql.Int, req.params.branchId)
        .input("fid", sql.Int, req.params.id)
        .query(`
          DELETE FROM dbo.dc_FoodBranches
          WHERE branchId=@bid AND foodId=@fid
        `);
      res.json({ success: true });
    } catch (err) {
      console.error("Delete branch error:", err);
      res.status(500).json({ error: err.message });
    }
  });


    //---API của trang tạo thực đơn

    // ---- assumption: đã có poolPromise, sql từ mssql, app = express() ----

// POST /api/weekly-menus  body: { weekStartMonday: 'YYYY-MM-DD' }
app.post("/api/weekly-menus", async (req, res) => {
  const { weekStartMonday } = req.body || {};
  if (!weekStartMonday) return res.status(400).json({ success:false, message:"Missing weekStartMonday" });

  // preset theo yêu cầu
  const PRESETS = {
    re: { foods: [66,65,83,67,80,93] },     // pos 1..6
    ws: { foods: [93] },                    // pos 1
    ot: { foods: [80,93] },                 // pos 1..2
  };
  const DAYS = [1,2,3,4,5,6,7];

  try {
    const pool = await poolPromise;

    // upsert weekly menu for that Monday
    const c = await pool.request()
      .input("weekStartMonday", sql.Date, weekStartMonday)
      .query(`SELECT weeklyMenuId, isLocked FROM dbo.dc_WeeklyMenus WHERE weekStartMonday=@weekStartMonday`);

    let weeklyMenuId;
    if (c.recordset.length) {
      weeklyMenuId = c.recordset[0].weeklyMenuId;
    } else {
      const i = await pool.request()
        .input("weekStartMonday", sql.Date, weekStartMonday)
        .query(`
          INSERT INTO dbo.dc_WeeklyMenus(weekStartMonday, isAction, isLocked, createdAt, lastRemindedAt)
          OUTPUT INSERTED.weeklyMenuId
          VALUES(@weekStartMonday, 1, 0, SYSUTCDATETIME(), DATEADD(MINUTE,-240,SYSUTCDATETIME()))
        `);
      weeklyMenuId = i.recordset[0].weeklyMenuId;
    }

    // backfill 3 loại (isLocked=0 để xóa/sửa được)
    const trx = new sql.Transaction(pool);
    try {
      await trx.begin();

      for (const [stype, { foods }] of Object.entries(PRESETS)) {
        for (const day of DAYS) {
          for (let i = 0; i < foods.length; i++) {
            let position; // 1..N
            if(stype === 're') {
              position = i + 6
            } else if(stype === 'ot') {
              position = i + 4;
            } else {
              position = i + 1;
            }

            await new sql.Request(trx)
              .input("weeklyMenuId", sql.Int, weeklyMenuId)
              .input("statusType", sql.NVarChar(20), stype)
              .input("dayOfWeek", sql.TinyInt, day)
              .input("position", sql.TinyInt, position)
              .input("foodId", sql.Int, foods[i])
              .query(`
                IF NOT EXISTS (
                  SELECT 1 FROM dbo.dc_WeeklyMenuEntries
                  WHERE weeklyMenuId=@weeklyMenuId
                    AND statusType=@statusType
                    AND dayOfWeek=@dayOfWeek
                    AND position=@position
                )
                INSERT INTO dbo.dc_WeeklyMenuEntries
                  (weeklyMenuId, foodId, dayOfWeek, position, statusType, isAction, isLocked, createdAt)
                VALUES
                  (@weeklyMenuId, @foodId, @dayOfWeek, @position, @statusType, 1, 0, SYSUTCDATETIME());
              `);
          }
        }
      }

      await trx.commit();
    } catch (e) {
      try { await trx.rollback(); } catch {}
      console.error("[weekly-menus:create] presets error:", e);
    }

    // trả về menu + entries
    const eRs = await pool.request()
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .query(`
        SELECT e.weeklyMenuEntryId, e.weeklyMenuId, e.foodId, e.dayOfWeek, e.position,
               e.statusType, e.isLocked, f.foodName, f.imageUrl
        FROM dbo.dc_WeeklyMenuEntries e
        LEFT JOIN dbo.dc_Foods f ON f.foodId = e.foodId
        WHERE e.weeklyMenuId=@weeklyMenuId
      `);

    return res.json({
      success:true,
      data:{ weeklyMenuId, weekStartMonday, isLocked:false, entries:eRs.recordset || [] }
    });
  } catch (err) {
    console.error("Create weekly menu error:", err);
    return res.status(500).json({ success:false, message:"Server error" });
  }
});

// GET /api/weekly-menus?weekStartMonday=YYYY-MM-DD
app.get("/api/weekly-menus", async (req, res) => {
  const { weekStartMonday } = req.query || {};
  if (!weekStartMonday) return res.status(400).json({ success:false, message:"Missing weekStartMonday" });

  try {
    const pool = await poolPromise;
    const m = await pool.request()
      .input("weekStartMonday", sql.Date, weekStartMonday)
      .query(`SELECT weeklyMenuId, isLocked FROM dbo.dc_WeeklyMenus WHERE weekStartMonday=@weekStartMonday`);

    if (!m.recordset.length) return res.json({ success:true, data:null });

    const weeklyMenuId = m.recordset[0].weeklyMenuId;
    const e = await pool.request()
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .query(`
        SELECT e.weeklyMenuEntryId, e.weeklyMenuId, e.foodId, e.dayOfWeek, e.position,
               e.statusType, e.isLocked, f.foodName, f.imageUrl
        FROM dbo.dc_WeeklyMenuEntries e
        LEFT JOIN dbo.dc_Foods f ON f.foodId = e.foodId
        WHERE e.weeklyMenuId=@weeklyMenuId
      `);

    return res.json({
      success:true,
      data:{ weeklyMenuId, weekStartMonday, isLocked: !!m.recordset[0].isLocked, entries: e.recordset || [] }
    });
  } catch (err) {
    console.error("Get weekly menu error:", err);
    return res.status(500).json({ success:false, message:"Server error" });
  }
});

// POST /api/weekly-menus/:weeklyMenuId/entries
// body: { statusType: 're'|'ws'|'ot', entries: [{ dayOfWeek, position, foodId }, ...] }
app.post("/api/weekly-menus/:weeklyMenuId/entries", async (req, res) => {
  const weeklyMenuId = Number(req.params.weeklyMenuId);
  const { statusType, entries } = req.body || {};
  if (!weeklyMenuId || !statusType || !Array.isArray(entries)) {
    return res.status(400).json({ success:false, message:"Bad payload" });
  }

  try {
    const pool = await poolPromise;
    const trx = new sql.Transaction(pool);
    await trx.begin();

    // XÓA HẾT theo statusType, sau đó THÊM MỚI
    await new sql.Request(trx)
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .input("statusType", sql.NVarChar(20), statusType)
      .query(`
        DELETE FROM dbo.dc_WeeklyMenuEntries
        WHERE weeklyMenuId=@weeklyMenuId AND statusType=@statusType
      `);

    for (const e of entries) {
      await new sql.Request(trx)
        .input("weeklyMenuId", sql.Int, weeklyMenuId)
        .input("statusType", sql.NVarChar(20), statusType)
        .input("dayOfWeek", sql.TinyInt, e.dayOfWeek)
        .input("position", sql.TinyInt, e.position)
        .input("foodId", sql.Int, e.foodId)
        .query(`
          INSERT INTO dbo.dc_WeeklyMenuEntries
            (weeklyMenuId, foodId, dayOfWeek, position, statusType, isAction, isLocked, createdAt)
          VALUES
            (@weeklyMenuId, @foodId, @dayOfWeek, @position, @statusType, 1, 0, SYSUTCDATETIME())
        `);
    }

    await trx.commit();

  
const rsW = await pool.request()
  .input('id', sql.Int, weeklyMenuId)
  .query(`SELECT TOP 1 weekStartMonday FROM dbo.dc_WeeklyMenus WHERE weeklyMenuId=@id`);
const monday = rsW.recordset[0]?.weekStartMonday;
const weekVN = monday ? new Date(monday).toLocaleDateString('vi-VN') : 'tuần mới';

// Nội dung vui nhộn + deeplink về đúng tuần & tab hiện tại
const bodies = [
  `Thực đơn ${weekVN} đã sẵn sàng! Vào đặt món kẻo hết suất ngon nha 😋`,
  `Đã mở thực đơn ${weekVN}! Chốt món hôm nay cho ấm bụng thôi 🥢`,
  `Tuần mới – món mới! Vào đặt ngay trước khi khóa menu nha 🍱`,
  `Chuông báo bụng reo 🔔 Menu ${weekVN} đã lên sóng, mời bạn chọn món!`,
  `Đặt cơm cùng đồng đội? Menu ${weekVN} vừa cập bến nè 🚀`
];
//const body = bodies[Math.floor(Math.random() * bodies.length)];

const body = `Menu ${weekVN} đã sẵn sàng! Vào đặt món kẻo hết suất ngon nha 😋`;

// URL có thể là relative để SW mở trong cùng domain
const payload = {
  title: 'Đặt Cơm THLA – Thực đơn mới',
  body,
  url: `/lunch-order?menu=${weeklyMenuId}&tab=${statusType}`,
  ttl: 3600
};

// Gửi cho TẤT CẢ user có module = 'datcom'
const stats = await sendPushToUsers(payload, null);

// trả response kèm thống kê gửi
return res.json({ success: true, broadcast: stats });

  } catch (err) {
    try { await trx.rollback(); } catch {}
    console.error("Save entries error:", err);
    return res.status(500).json({ success:false, message:"Server error" });
  }
});

// (tuỳ chọn) DELETE 1 ô theo statusType/day/pos — dùng cho nút ✕
app.delete("/api/weekly-menus/:weeklyMenuId/entries", async (req, res) => {
  const weeklyMenuId = Number(req.params.weeklyMenuId);
  const { statusType, dayOfWeek, position } = req.body || {};
  if (!weeklyMenuId || !statusType || !dayOfWeek || !position) {
    return res.status(400).json({ success:false, message:"Missing params" });
  }
  try {
    const pool = await poolPromise;
    const del = await pool.request()
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .input("statusType", sql.NVarChar(20), statusType)
      .input("dayOfWeek", sql.TinyInt, dayOfWeek)
      .input("position", sql.TinyInt, position)
      .query(`
        DELETE TOP(1)
        FROM dbo.dc_WeeklyMenuEntries
        WHERE weeklyMenuId=@weeklyMenuId AND statusType=@statusType
          AND dayOfWeek=@dayOfWeek AND position=@position
      `);
    return res.json({ success:true, deleted: del.rowsAffected?.[0] || 0 });
  } catch (err) {
    console.error("Delete one entry error:", err);
    return res.status(500).json({ success:false, message:"Server error" });
  }
});

app.put("/api/weekly-menus/:id/lock", async (req, res) => {
  const weeklyMenuId = +req.params.id;
  try {
    const pool = await poolPromise;
    await pool.request()
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .query(`UPDATE dbo.dc_WeeklyMenus SET isLocked=1 WHERE weeklyMenuId=@weeklyMenuId`);
    res.json({ success: true });
  } catch (err) {
    console.error("Lock error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/api/weekly-menus/:id/unlock", async (req, res) => {
  const weeklyMenuId = +req.params.id;
  try {
    const pool = await poolPromise;
    await pool.request()
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .query(`UPDATE dbo.dc_WeeklyMenus SET isLocked=0 WHERE weeklyMenuId=@weeklyMenuId`);
    res.json({ success: true });
  } catch (err) {
    console.error("Unlock error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});



//-----------API quản lý bộ phận
app.get("/api/lunch-order/departments", async (req, res) => {
  try {
    const pool = await poolPromise;
    const rs = await pool.request().query(`
      SELECT departmentId, departmentName, departmentCode, isAction, createdAt, updatedAt
      FROM dbo.dc_Department
      ORDER BY createdAt DESC
    `);
    res.json(rs.recordset);
  } catch (err) {
    console.error("Get departments error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * POST /api/departments
 * Thêm bộ phận
 */
function toDepartmentCode(str) {
  if (!str) return "";
  return str
    .normalize("NFD")                 // tách dấu
    .replace(/[\u0300-\u036f]/g, "")  // xoá dấu
    .replace(/đ/g, "d")               // thay đ -> d
    .replace(/Đ/g, "d")               // thay Đ -> d
    .replace(/[^a-zA-Z0-9\s]/g, "")   // xoá ký tự đặc biệt
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");             // xoá khoảng trắng
}


app.post("/api/lunch-order/departments", async (req, res) => {
  const { departmentName, createdBy } = req.body;
  if (!departmentName) {
    return res.status(400).json({ success: false, message: "Thiếu thông tin" });
  }

  const departmentCode = toDepartmentCode(departmentName);

  try {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input("departmentName", sql.NVarChar(200), departmentName)
      .input("departmentCode", sql.NVarChar(100), departmentCode)
      .input("createdBy", sql.NVarChar(100), createdBy || null)
      .query(`
        INSERT INTO dbo.dc_Department(departmentName, departmentCode, createdBy)
        OUTPUT INSERTED.*
        VALUES (@departmentName, @departmentCode, @createdBy)
      `);

    res.json({ success: true, data: rs.recordset[0] });
  } catch (err) {
    if (err.number === 2627) {
      return res.status(400).json({ success: false, message: "Mã bộ phận đã tồn tại" });
    }
    console.error("Create department error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * PUT /api/departments/:id
 * Sửa bộ phận
 */
app.put("/api/lunch-order/departments/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { departmentName, updatedBy } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "Invalid id" });
  
  const departmentCode = toDepartmentCode(departmentName);

  try {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input("id", sql.Int, id)
      .input("departmentName", sql.NVarChar(200), departmentName)
      .input("departmentCode", sql.NVarChar(100), departmentCode)
      .input("updatedBy", sql.NVarChar(100), updatedBy || null)
      .query(`
            UPDATE dbo.dc_Department
            SET departmentName = @departmentName,
                departmentCode = @departmentCode,
                updatedAt = SYSUTCDATETIME(),
                updatedBy = @updatedBy
            WHERE departmentId = @id;

            SELECT departmentId, departmentName, departmentCode, updatedAt, updatedBy
            FROM dbo.dc_Department
            WHERE departmentId = @id;
      `);

    if (!rs.recordset.length) {
      return res.status(404).json({ success: false, message: "Không tìm thấy bộ phận" });
    }

    res.json({ success: true, data: rs.recordset[0] });
  } catch (err) {
    if (err.number === 2627) {
      return res.status(400).json({ success: false, message: "Mã bộ phận đã tồn tại" });
    }
    console.error("Update department error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * DELETE /api/departments/:id
 * Xoá bộ phận
 */
app.delete("/api/lunch-order/departments/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

  try {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input("id", sql.Int, id)
      .query(`
        DELETE FROM dbo.dc_Department WHERE departmentId=@id
      `);

    if (rs.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: "Không tìm thấy bộ phận" });
    }

    res.json({ success: true, message: "Xoá thành công" });
  } catch (err) {
    console.error("Delete department error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


///------------API trang gán user vào bộ phận
/**
 * GET: danh sách users có module datcom
 */
app.get("/api/lunch-order/department-assign/users-datcom", async (req, res) => {
  try {
    const pool = await poolPromise;
    const rs = await pool.request().query(`
      SELECT u.userID, u.username, u.fullName, u.phone, u.dc_DepartmentID,
             d.departmentName
      FROM dbo.Users u
      INNER JOIN dbo.UserModules um ON u.userID = um.userId
      INNER JOIN dbo.Modules m ON um.moduleId = m.moduleId
      LEFT JOIN dbo.dc_Department d ON u.dc_DepartmentID = d.departmentId
      WHERE m.moduleKey = 'datcom' AND u.isActive = 1
      ORDER BY u.fullName;
    `);
    res.json({ success: true, data: rs.recordset });
  } catch (err) {
    console.error("Get users-datcom error:", err);
    res.status(500).json({ success: false, message: "Lỗi lấy user datcom" });
  }
});

/**
 * GET: danh sách departments
 */
app.get("/api/lunch-order/department-assign/departments", async (req, res) => {
  try {
    const pool = await poolPromise;
    const rs = await pool.request().query(`
      SELECT departmentId, departmentName
      FROM dbo.dc_Department
      WHERE isAction = 1
      ORDER BY departmentName;
    `);
    res.json({ success: true, data: rs.recordset });
  } catch (err) {
    console.error("Get departments error:", err);
    res.status(500).json({ success: false, message: "Lỗi lấy bộ phận" });
  }
});

/**
 * PUT: update danh sách gán user -> department
 * body = { assignments: [{ userId, departmentId }], updatedBy }
 */
    app.put("/api/lunch-order/department-assign/assign", async (req, res) => {
    try {
      const { assignments, updatedBy } = req.body || {};

      if (!Array.isArray(assignments)) {
        return res.status(400).json({ success: false, message: "Payload không hợp lệ." });
      }

      // lọc assignment trùng userId (lấy cái cuối cùng)
      const lastMap = new Map();
      for (const a of assignments) {
        if (!a || typeof a.userId !== "number") continue;
        lastMap.set(a.userId, a.departmentId === null ? null : Number(a.departmentId));
      }
      const finalAssignments = Array.from(lastMap.entries()).map(([userId, departmentId]) => ({
        userId,
        departmentId,
      }));

      const pool = await poolPromise;

      const summary = {
        total: finalAssignments.length,
        updated: 0,
        failed: [], // { userId, reason }
      };

      // Lặp từng user và update
      for (const a of finalAssignments) {
        try {
          // 1) check user tồn tại
          const chkUser = await new sql.Request(pool)
            .input("uid", sql.Int, a.userId)
            .query(`SELECT 1 AS ok FROM dbo.Users WHERE userID = @uid;`);

          if (chkUser.recordset.length === 0) {
            summary.failed.push({ userId: a.userId, reason: "User không tồn tại" });
            continue;
          }

          // 2) nếu departmentId != null thì check department tồn tại
          if (a.departmentId !== null) {
            const chkDept = await new sql.Request(pool)
              .input("depId", sql.Int, a.departmentId)
              .query(`SELECT 1 AS ok FROM dbo.dc_Department WHERE departmentId = @depId;`);

            if (chkDept.recordset.length === 0) {
              summary.failed.push({ userId: a.userId, reason: "Department không tồn tại" });
              continue;
            }
          }

          // 3) update (không dùng OUTPUT để tránh xung đột trigger)
          const rs = await new sql.Request(pool)
            .input("uid", sql.Int, a.userId)
            .input("depId", sql.Int, a.departmentId) // có thể null
            .input("updatedBy", sql.Int, updatedBy || null)
            .query(`
              UPDATE dbo.Users
              SET dc_DepartmentID = @depId,
                  updatedAt       = SYSUTCDATETIME(),
                  updatedBy       = @updatedBy
              WHERE userID = @uid;
            `);

          if (rs.rowsAffected && rs.rowsAffected[0] > 0) {
            summary.updated += 1;
          } else {
            summary.failed.push({ userId: a.userId, reason: "Không có hàng nào được cập nhật" });
          }
        } catch (e) {
          // lỗi riêng lẻ user này -> không làm đổ cả batch
          summary.failed.push({ userId: a.userId, reason: e.message || "Lỗi không xác định" });
        }
      }

      return res.json({
        success: true,
        message: `Cập nhật xong: ${summary.updated}/${summary.total}`,
        summary,
      });
    } catch (err) {
      console.error("Assign users error:", err);
      return res.status(500).json({
        success: false,
        message: "Lỗi gán user vào bộ phận",
        detail: err.message,
      });
    }
  });



  //----------API Trang User đặt cơm
  // Lấy thực đơn tuần theo ngày Thứ 2
app.get("/api/lunch-order/user/weekly-menu/:monday", async (req, res) => {
  try {
    const { monday } = req.params;
    const pool = await poolPromise;

    const wm = await pool.request()
      .input("monday", sql.Date, monday)
      .query(`
        SELECT TOP 1 *
        FROM dbo.dc_WeeklyMenus
        WHERE weekStartMonday = @monday
        ORDER BY createdAt DESC;
      `);

    if (wm.recordset.length === 0) {
      return res.json({ success: true, data: null });
    }

    const weeklyMenuId = wm.recordset[0].weeklyMenuId;

    // lấy entries + food
    const entries = await pool.request()
      .input("id", sql.Int, weeklyMenuId)
      .query(`
        SELECT e.weeklyMenuEntryId, e.weeklyMenuId, e.dayOfWeek, e.position,
               f.foodId, f.foodName, f.imageUrl, f.colorCode
        FROM dbo.dc_WeeklyMenuEntries e
        JOIN dbo.dc_Foods f ON e.foodId = f.foodId
        WHERE e.weeklyMenuId = @id
        ORDER BY e.dayOfWeek, e.position;
      `);

    res.json({
      success: true,
      data: {
        ...wm.recordset[0],
        entries: entries.recordset,
      }
    });
  } catch (err) {
    console.error("Get weekly menu error:", err);
    res.status(500).json({ success: false, message: "Lỗi lấy thực đơn tuần" });
  }
});


// Lấy danh sách lựa chọn user đã chọn trong tuần
app.get('/api/lunch-order/user/selections/:weeklyMenuId/:userId', async (req, res) => {
  try {
    const { weeklyMenuId, userId } = req.params;
    const pool = await poolPromise;

    const rs = await pool.request()
      .input('wmid', sql.Int, weeklyMenuId)
      .input('uid', sql.Int, userId)
      .query(`
        SELECT 
          s.weeklyMenuEntryId, 
          ISNULL(s.isAction, 1) AS isAction,
          ISNULL(s.quantity, 1) AS quantity,
          s.branchId
        FROM dbo.dc_UserWeeklySelections s
        JOIN dbo.dc_WeeklyMenuEntries e ON s.weeklyMenuEntryId = e.weeklyMenuEntryId
        WHERE e.weeklyMenuId = @wmid AND s.userID = @uid;
      `);

    res.json({
      success: true,
      data: rs.recordset.map(r => [r.weeklyMenuEntryId, r.isAction, r.quantity, r.branchId ?? null]),
    });
  } catch (err) {
    console.error('Get user selections error:', err);
    res.status(500).json({ success: false, message: 'Lỗi lấy lựa chọn của user' });
  }
});


app.post('/api/lunch-order/user/selections/save', async (req, res) => {
  try {
    const { userId, weeklyMenuId, selections, createdBy, statusType } = req.body || {};
    if (!userId || !weeklyMenuId || !Array.isArray(selections)) {
      return res.status(400).json({ success: false, message: 'Payload không hợp lệ' });
    }
    const st = String(statusType || 're').toLowerCase();
    const createdBySafe =
      typeof createdBy === 'string' ? createdBy :
      (createdBy === null || createdBy === undefined ? null : String(createdBy));

    const pool = await poolPromise;

    /* 1) SNAPSHOT CŨ: lấy full để so sánh (key=entry|branch -> qty) */
    const oldRs = await pool.request()
      .input('uid', sql.Int, userId)
      .input('wmid', sql.Int, weeklyMenuId)
      .input('stype', sql.NVarChar(10), st)
      .query(`
        SELECT
          s.weeklyMenuEntryId     AS entryId,
          s.branchId,
          s.quantity,
          e.dayOfWeek,
          LOWER(ISNULL(e.statusType,'re')) AS statusType,
          f.foodName
        FROM dbo.dc_UserWeeklySelections s
        JOIN dbo.dc_WeeklyMenuEntries e ON e.weeklyMenuEntryId = s.weeklyMenuEntryId
        JOIN dbo.dc_Foods f ON f.foodId = e.foodId
        WHERE s.userID = @uid
          AND e.weeklyMenuId = @wmid
          AND LOWER(ISNULL(e.statusType, 're')) = @stype
          AND s.isAction = 1
      `);
    const oldList = oldRs.recordset || [];
    const oldMap = new Map(); // key -> { qty, entryId, branchId }
    for (const r of oldList) {
      const key = `${r.entryId}|${r.branchId ?? 'NULL'}`;
      oldMap.set(key, { quantity: Number(r.quantity)||0, entryId: r.entryId, branchId: r.branchId });
    }

    /* 2) DEDUPE selections mới => agg: key = "entry|branch" -> qty */
    const agg = new Map();
    for (const it of selections) {
      if (!it) continue;
      let entryId, qty, branchId;
      if (typeof it === 'object') {
        entryId  = Number(it.entryId);
        qty      = Number.isFinite(+it.quantity) ? Math.max(1, parseInt(it.quantity, 10)) : 1;
        branchId = it.branchId != null ? Number(it.branchId) : null;
      } else {
        entryId  = Number(it);
        qty      = 1;
        branchId = null;
      }
      if (!Number.isFinite(entryId) || entryId <= 0) continue;
      const key = `${entryId}|${branchId === null ? 'NULL' : branchId}`;
      agg.set(key, (agg.get(key) ?? 0) + qty);
    }

    /* 3) TX: xoá cũ + insert mới */
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input('uid', sql.Int, userId)
        .input('wmid', sql.Int, weeklyMenuId)
        .input('stype', sql.NVarChar(10), st)
        .query(`
          DELETE s
          FROM dbo.dc_UserWeeklySelections s
          JOIN dbo.dc_WeeklyMenuEntries e ON e.weeklyMenuEntryId = s.weeklyMenuEntryId
          WHERE s.userID = @uid
            AND e.weeklyMenuId = @wmid
            AND LOWER(ISNULL(e.statusType, 're')) = @stype
            AND s.quantityWorkShift IS NULL;
        `);

      const keys = Array.from(agg.keys()).sort((a, b) => {
        const [eidA, bidA] = a.split('|'); const [eidB, bidB] = b.split('|');
        if (Number(eidA) !== Number(eidB)) return Number(eidA) - Number(eidB);
        if (bidA === 'NULL' && bidB !== 'NULL') return -1;
        if (bidA !== 'NULL' && bidB === 'NULL') return 1;
        return Number(bidA) - Number(bidB);
      });

      // validateBranch nếu có branch cụ thể
      const validateBranch = async (entryId, branchId) => {
        const rs = await new sql.Request(tx)
          .input('eid', sql.Int, entryId)
          .input('bid', sql.Int, Number.isFinite(branchId) && branchId > 0 ? branchId : null)
          .query(`
            SELECT 1
            FROM dbo.dc_WeeklyMenuEntries e
            JOIN dbo.dc_FoodBranches fb ON fb.branchId = @bid
            WHERE e.weeklyMenuEntryId = @eid
              AND e.foodId = fb.foodId;
          `);
        return rs.recordset.length > 0;
      };

      for (const key of keys) {
        const [eidStr, bidStr] = key.split('|');
        const entryId  = Number(eidStr);
        const branchId = bidStr === 'NULL' ? null : Number(bidStr);
        const qty = agg.get(key);

        if (branchId !== null) {
          const ok = await validateBranch(entryId, branchId);
          if (!ok) {
            await tx.rollback();
            return res.status(400).json({ success: false, message: `Branch ${branchId} không thuộc món của entry ${entryId}` });
          }
        }

        await new sql.Request(tx)
          .input('eid', sql.Int, entryId)
          .input('uid', sql.Int, userId)
          .input('qty', sql.Int, qty)
          .input('bid', branchId === null ? sql.Int : sql.Int, branchId)
          .input('createdBy', sql.NVarChar(100), createdBySafe)
          .query(`
            INSERT INTO dbo.dc_UserWeeklySelections
              (weeklyMenuEntryId, userID, quantity, branchId, isAction, createdBy)
            VALUES
              (@eid, @uid, @qty, @bid, 1, @createdBy);
          `);
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    res.json({ success: true, message: 'Lưu lựa chọn thành công' });

    /* 4) TÍNH DIFF & PUSH
          - BẮT MỌI THAY ĐỔI: add / remove / qty change (kể cả 're')
          - Ngoài ra, nếu st in ('ws','ot') và agg.size>0 mà KHÔNG có diff, vẫn có thể push (tuỳ bạn)
    */
    try {
      // newMap: key -> { qty, entryId, branchId }
      const newMap = new Map();
      for (const [key, qty] of agg.entries()) {
        const [eidStr, bidStr] = key.split('|');
        newMap.set(key, {
          quantity: Number(qty)||0,
          entryId: Number(eidStr),
          branchId: bidStr === 'NULL' ? null : Number(bidStr),
        });
      }

      // Tính diff
      const diffs = []; // {type:'add'|'remove'|'qty', entryId, branchId, qtyFrom?, qtyTo?}
      const unionKeys = new Set([...oldMap.keys(), ...newMap.keys()]);
      for (const k of unionKeys) {
        const o = oldMap.get(k);
        const n = newMap.get(k);
        if (!o && n) {
          diffs.push({ type: 'add', entryId: n.entryId, branchId: n.branchId, qtyTo: n.quantity });
        } else if (o && !n) {
          diffs.push({ type: 'remove', entryId: o.entryId, branchId: o.branchId, qtyFrom: o.quantity });
        } else if (o && n && Number(o.quantity) !== Number(n.quantity)) {
          diffs.push({ type: 'qty', entryId: n.entryId, branchId: n.branchId, qtyFrom: o.quantity, qtyTo: n.quantity });
        }
      }

      const hasDiff = diffs.length > 0;
      const shouldNotifyWsOtEvenNoDiff = (st === 'ws' || st === 'ot') && agg.size > 0;
      if (!hasDiff && !shouldNotifyWsOtEvenNoDiff) return;

      const pool2 = await poolPromise;

      // Lấy info user + tuần
      const infoRs = await pool2.request()
        .input('uid', sql.Int, userId)
        .input('wmid', sql.Int, weeklyMenuId)
        .query(`
          SELECT TOP 1 u.fullName, wm.weekStartMonday
          FROM dbo.Users u
          CROSS JOIN (SELECT weekStartMonday FROM dbo.dc_WeeklyMenus WHERE weeklyMenuId=@wmid) wm
          WHERE u.userID = @uid
        `);
      const info = infoRs.recordset?.[0] || {};
      const who = info.fullName || `User #${userId}`;
      const weekVN = info.weekStartMonday ? new Date(info.weekStartMonday).toLocaleDateString('vi-VN') : '';

      // Lấy meta entryId -> dayOfWeek,statusType,foodName
      const needEntryIds = hasDiff
        ? Array.from(new Set(diffs.map(d => d.entryId)))
        : Array.from(new Set([...newMap.values()].map(v => v.entryId)));
      const entryInfoMap = new Map();
      if (needEntryIds.length) {
        const rsE = await pool2.request().query(`
          SELECT e.weeklyMenuEntryId AS entryId,
                 e.dayOfWeek,
                 LOWER(ISNULL(e.statusType,'re')) AS statusType,
                 f.foodName
          FROM dbo.dc_WeeklyMenuEntries e
          JOIN dbo.dc_Foods f ON f.foodId = e.foodId
          WHERE e.weeklyMenuEntryId IN (${needEntryIds.join(',')})
        `);
        for (const r of (rsE.recordset || [])) entryInfoMap.set(r.entryId, r);
      }

      // Lấy tên branch liên quan
      const branchIdSet = new Set();
      if (hasDiff) {
        for (const d of diffs) if (d.branchId != null) branchIdSet.add(d.branchId);
      } else {
        for (const v of newMap.values()) if (v.branchId != null) branchIdSet.add(v.branchId);
      }
      const branchNameMap = new Map();
      if (branchIdSet.size) {
        const rsB = await pool2.request().query(`
          SELECT branchId, branchName FROM dbo.dc_FoodBranches
          WHERE branchId IN (${[...branchIdSet].join(',')})
        `);
        for (const r of (rsB.recordset || [])) branchNameMap.set(r.branchId, r.branchName);
      }

      // Render nội dung
      const adminIDs = await getDatcomAdminUserIDs(userId); // loại trừ chính user nếu là admin
      if (!adminIDs.length) return;

      if (hasDiff) {
        // Gộp theo entry để dễ đọc
        const byEntry = new Map(); // entryId -> {adds:[], removes:[], qtys:[]}
        for (const d of diffs) {
          if (!byEntry.has(d.entryId)) byEntry.set(d.entryId, { adds: [], removes: [], qtys: [] });
          const bucket = byEntry.get(d.entryId);
          const bname = d.branchId == null ? null : (branchNameMap.get(d.branchId) || null);
          const label = bname ? `— ${bname}` : ''; // foodName sẽ lấy ở meta
          if (d.type === 'add')    bucket.adds.push({ label, qty: d.qtyTo });
          if (d.type === 'remove') bucket.removes.push({ label, qty: d.qtyFrom });
          if (d.type === 'qty')    bucket.qtys.push({ label, from: d.qtyFrom, to: d.qtyTo });
        }

        const lines = [];
        for (const [entryId, buckets] of byEntry.entries()) {
          const meta = entryInfoMap.get(entryId);
          if (!meta) continue;
          const dname  = dayNameVN(meta.dayOfWeek);
          const tlabel = tabLabel(meta.statusType);
          const parts = [];
          for (const it of buckets.adds)    parts.push(`Chọn ${meta.foodName} ${it.label} x${it.qty}`.trim());
          for (const it of buckets.removes) parts.push(`Bỏ ${meta.foodName} ${it.label} x${it.qty}`.trim());
          for (const it of buckets.qtys)    parts.push(`Đổi số lượng: ${meta.foodName} ${it.label} x${it.from}→x${it.to}`.trim());
          if (parts.length) lines.push(`${dname} (${tlabel}): ${parts.join('; ')}`);
          if (lines.length >= 5) break;
        }
        const more = byEntry.size > 5 ? `\n… +${byEntry.size - 5} ngày khác` : '';

        const title = 'Cập nhật đặt cơm – thông báo quản trị';
        const body  = `${who} vừa cập nhật lựa chọn ${weekVN ? `(tuần ${weekVN})` : ''}\n${lines.join('\n')}${more}`;
        const url   = `/lunch-order/admin?menu=${weeklyMenuId}&user=${userId}&tab=${st}`;

        await sendPushToUsers({ title, body, url, tag: 'lunch-change', renotify: false, ttl: 600 }, adminIDs);
      } else if (shouldNotifyWsOtEvenNoDiff) {
        // Không có diff nhưng là ws/ot và có chọn -> vẫn báo
        const lines = [];
        for (const [key, v] of newMap.entries()) {
          const meta = entryInfoMap.get(v.entryId);
          if (!meta) continue;
          const dname  = dayNameVN(meta.dayOfWeek);
          const tlabel = tabLabel(meta.statusType);
          const bidStr = key.split('|')[1];
          const bname  = bidStr === 'NULL' ? null : (branchNameMap.get(Number(bidStr)) || null);
          const dish   = [meta.foodName, bname].filter(Boolean).join(' — ');
          lines.push(`${dname} (${tlabel}): ${dish} x${v.quantity}`);
          if (lines.length >= 5) break;
        }

        const title = 'Đặt suất Đi ca/Tăng ca – thông báo quản trị';
        const body  = `${who} vừa đặt suất ${tabLabel(st)} ${weekVN ? `(tuần ${weekVN})` : ''}\n${lines.join('\n')}`;
        const url   = `/lunch-order/admin?menu=${weeklyMenuId}&user=${userId}&tab=${st}`;

        await sendPushToUsers({ title, body, url, tag: 'lunch-ws-ot', renotify: false, ttl: 600 }, adminIDs);
      }
    } catch (pushErr) {
      console.error('[push admin on selections/save] error:', pushErr);
    }

  } catch (err) {
    console.error('Save user selections error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi lưu lựa chọn cơm' });
  }
});

// helper: tên thứ tiếng Việt từ dayOfWeek (1..7: Th2..CN)
function viDayOfWeek(dow) {
  const map = {1:'Thứ 2',2:'Thứ 3',3:'Thứ 4',4:'Thứ 5',5:'Thứ 6',6:'Thứ 7',7:'Chủ nhật'};
  return map[dow] || `Thứ ${dow}`;
}

// Lấy danh sách admin theo “chỉ định” (ví dụ: moduleKey=datcom & role admin/manager)
async function fetchAdminUserIDs(pool) {
  const rs = await pool.request().query(`
    SELECT DISTINCT um.userId AS userID
    FROM dbo.UserModules um
    JOIN dbo.Modules m ON m.moduleId = um.moduleId
    WHERE m.moduleKey = 'datcom'
      AND (
        um.role IN ('admin','manager')
        OR um.role LIKE '%admin%'
        OR um.role LIKE '%manager%'
      )
  `);
  return rs.recordset.map(r => r.userID);
}

app.post('/api/lunch-order/user/selections/item-action', async (req, res) => {
  const { userId, weeklyMenuId, weeklyMenuEntryId, branchId, updatedBy } = req.body || {};
  if (!userId || !weeklyMenuId || !weeklyMenuEntryId) {
    return res.status(400).json({ success: false, message: 'Thiếu tham số' });
  }

  try {
    const pool = await poolPromise;

    const result = await pool.request()
      .input('uid', sql.Int, userId)
      .input('wmid', sql.Int, weeklyMenuId)
      .input('weid', sql.Int, weeklyMenuEntryId)
      .input('bid', sql.Int, branchId || null)
      .input('updatedBy', sql.NVarChar, updatedBy || 'system')
      .query(`
        UPDATE s
        SET s.isAction = 0,
            s.updatedBy = @updatedBy,
            s.updatedAt = SYSDATETIME()
        FROM dbo.dc_UserWeeklySelections s
        JOIN dbo.dc_WeeklyMenuEntries e ON e.weeklyMenuEntryId = s.weeklyMenuEntryId
        WHERE s.userID = @uid
          AND e.weeklyMenuId = @wmid
          AND s.weeklyMenuEntryId = @weid
          AND s.isAction = 1
          AND (@bid IS NULL OR s.branchId = @bid);
      `);

    const affected = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : (result.rowsAffected || 0);
    res.json({ success: true, affected, message: affected ? 'Cancelled' : 'Nothing to cancel' });

    // ───────────────── Push cho admin khi có HUỶ ─────────────────
    if (affected > 0) {
      // Lấy thông tin để hiển thị trong thông báo
      const info = await getCancelInfo({ userId, weeklyMenuId, weeklyMenuEntryId });
      const dayNameVN = (d) => (['','Thứ 2','Thứ 3','Thứ 4','Thứ 5','Thứ 6','Thứ 7','Chủ nhật'][d] || 'Ngày');
      const tabLabel = (s) => (s === 'ws' ? 'Đi ca' : s === 'ot' ? 'Tăng ca' : 'Ca ngày');

      const weekVN = info?.weekStartMonday
        ? new Date(info.weekStartMonday).toLocaleDateString('vi-VN')
        : '';
      const who = info?.fullName || `User #${userId}`;
      const dish = [info?.foodName, info?.branchName].filter(Boolean).join(' — ');
      const dayLabel = info?.dayOfWeek ? dayNameVN(info.dayOfWeek) : 'Hôm nay';
      const tab = tabLabel((info?.statusType || 're').toLowerCase());

      const title = 'Huỷ cơm – thông báo quản trị';
      const body =
        `${who} vừa HUỶ món (${tab}, ${dayLabel}${weekVN ? ` • tuần ${weekVN}` : ''}).\n` +
        (dish ? `Món: ${dish}` : '—');

      // Deep-link tới trang admin theo tuần/entry (bạn chỉnh route UI cho khớp)
      const url = `/lunch-order/admin?menu=${weeklyMenuId}&entry=${weeklyMenuEntryId}`;

      // Lấy danh sách admin module=datcom, loại trừ chính người huỷ nếu họ cũng là admin
      const adminIDs = await getDatcomAdminUserIDs(userId);
      if (adminIDs.length) {
        await sendPushToUsers(
          { title, body, url, tag: 'lunch-cancel', renotify: false, ttl: 600 },
          adminIDs
        );
      }
    }
    // ─────────────────────────────────────────────────────────────

    // (tuỳ bạn) gửi push cho admin ở đây...
  } catch (err) {
    console.error('Cancel item error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Lỗi huỷ món' });
    }
  }
});

// Lấy thực đơn tuần hiện tại (nếu tồn tại) + entries
// Lấy thực đơn tuần mới nhất (bất kể hôm nay thuộc tuần nào)
app.get('/api/lunch-order/user/weekly-menu-latest', async (req, res) => {
  try {
    const pool = await poolPromise;

    // Lấy menu mới nhất theo weekStartMonday
    const menuRs = await pool.request().query(`
      SELECT TOP 1 *
      FROM dbo.dc_WeeklyMenus
      ORDER BY weekStartMonday DESC;
    `);

    if (!menuRs.recordset?.length) {
      return res.json({ success: true, data: null });
    }

    const menu = menuRs.recordset[0];

    // Lấy Entries + thông tin món + danh sách nhánh (branches) dưới dạng JSON
    const entryRs = await pool.request()
      .input('wmId', sql.Int, menu.weeklyMenuId)
      .query(`
        SELECT 
          e.weeklyMenuEntryId, e.weeklyMenuId, e.foodId, e.dayOfWeek, e.position, e.statusType,
          e.isAction, e.isLocked,
          f.foodName, f.imageUrl, f.colorCode,
          (
            SELECT fb.branchId, fb.branchCode, fb.branchName, fb.isDefault
            FROM dbo.dc_FoodBranches fb
            WHERE fb.foodId = e.foodId AND (fb.isActive = 1 OR fb.isActive IS NULL)
            ORDER BY 
              CASE WHEN fb.isDefault = 1 THEN 0 ELSE 1 END,
              ISNULL(fb.sortOrder, 9999),
              fb.branchName
            FOR JSON PATH
          ) AS branchesJson
        FROM dbo.dc_WeeklyMenuEntries e
        JOIN dbo.dc_Foods f ON f.foodId = e.foodId
        WHERE e.weeklyMenuId = @wmId
        ORDER BY e.dayOfWeek, e.position;
      `);

    const entries = entryRs.recordset.map(r => ({
      weeklyMenuEntryId: r.weeklyMenuEntryId,
      weeklyMenuId: r.weeklyMenuId,
      foodId: r.foodId,
      dayOfWeek: r.dayOfWeek,
      position: r.position,
      statusType: r.statusType,
      isAction: r.isAction,
      isLocked: r.isLocked,
      foodName: r.foodName,
      imageUrl: r.imageUrl,
      colorCode: r.colorCode,
      branches: JSON.parse(r.branchesJson || '[]'),
    }));

    const data = { ...menu, entries };
    res.json({ success: true, data });
  } catch (err) {
    console.error('Get latest weekly menu error:', err);
    res.status(500).json({ success: false, message: 'Lỗi lấy menu mới nhất' });
  }
});


// routes/lunchSecretary.js (ví dụ) hoặc nhét ngay dưới các route lunch-order hiện có
function viDayOfWeek(d) {
  const map = {1: "Thứ 2", 2: "Thứ 3", 3: "Thứ 4", 4: "Thứ 5", 5: "Thứ 6", 6: "Thứ 7", 7: "Chủ nhật"};
  return map[d] || `Thứ ${d}`;
}

app.post("/api/lunch-order/secretary/update-quantity", async (req, res) => {
  const {
    weeklyMenuId,
    dayOfWeek,
    weeklyMenuEntryId,
    quantity,
    updatedBy,
    userId: bodyUserId,
  } = req.body || {};

  // Nếu bạn có middleware auth -> có thể map ra đây
  const userId = bodyUserId || req.user?.userID;

  // Validate đầu vào
  if (!weeklyMenuId || !dayOfWeek || !weeklyMenuEntryId || typeof quantity !== "number" || !userId) {
    return res.status(400).json({ success: false, message: "Thiếu tham số" });
  }
  if (quantity < 0) {
    return res.status(400).json({ success: false, message: "Số lượng không hợp lệ" });
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  // Giữ lại dữ liệu để đẩy thông báo sau khi phản hồi
  let beforeQty = 0;
  let afterQty  = 0;
  let infoForPush = null; // { fullName, foodName, dayOfWeek, weekStartMonday }

  try {
    await tx.begin();

    const reqTx = new sql.Request(tx);
    reqTx.input("weeklyMenuId", sql.Int, weeklyMenuId);
    reqTx.input("dayOfWeek", sql.Int, dayOfWeek);
    reqTx.input("entryId", sql.Int, weeklyMenuEntryId);
    reqTx.input("userId", sql.Int, userId);

    // 1) Kiểm tra entry thuộc menu + đúng ngày
    const checkEntry = await reqTx.query(`
      SELECT TOP 1 e.weeklyMenuEntryId
      FROM dbo.dc_WeeklyMenuEntries e
      WHERE e.weeklyMenuEntryId = @entryId
        AND e.weeklyMenuId = @weeklyMenuId
        AND e.dayOfWeek = @dayOfWeek
    `);
    if (!checkEntry.recordset?.length) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: "Món ăn/Ngày không hợp lệ" });
    }

    // 2) Tồn tại bản ghi chọn món của user?
    const selectExist = await reqTx.query(`
      SELECT TOP 1 uws.userWeeklySelectionId, uws.isAction, ISNULL(uws.quantity, 1) AS quantity
      FROM dbo.dc_UserWeeklySelections uws
      WHERE uws.weeklyMenuEntryId = @entryId
        AND uws.userID = @userId
    `);

    if (!selectExist.recordset?.length) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: "Không tìm thấy lựa chọn để cập nhật" });
    }

    beforeQty = selectExist.recordset[0].quantity || 1;

    // Không cho tăng vượt số hiện tại (theo yêu cầu UX hiện tại)
    if (quantity > beforeQty) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: "Số lượng vượt quá số hiện tại" });
    }

    // Nếu không thay đổi → trả luôn (không push)
    if (quantity === beforeQty) {
      await tx.rollback();
      return res.json({ success: true, unchanged: true, message: "Không có thay đổi" });
    }

    // 3) Cập nhật số lượng
    const now = new Date();
    const reqUpdate = new sql.Request(tx);
    reqUpdate.input("entryId", sql.Int, weeklyMenuEntryId);
    reqUpdate.input("userId", sql.Int, userId);
    reqUpdate.input("quantity", sql.Int, quantity);
    reqUpdate.input("updatedBy", sql.NVarChar(200), String(updatedBy || userId));
    reqUpdate.input("updatedAt", sql.DateTime, now);

    let updated;
    if (quantity === 0) {
      updated = await reqUpdate.query(`
        UPDATE dbo.dc_UserWeeklySelections
        SET isAction = 0,
            updatedBy = @updatedBy,
            updatedAt = @updatedAt
        WHERE weeklyMenuEntryId = @entryId AND userID = @userId;

        SELECT weeklyMenuEntryId, userID, isAction, quantity
        FROM dbo.dc_UserWeeklySelections
        WHERE weeklyMenuEntryId = @entryId AND userID = @userId;
      `);
    } else {
      updated = await reqUpdate.query(`
        UPDATE dbo.dc_UserWeeklySelections
        SET isAction = 1,
            quantity = @quantity,
            updatedBy = @updatedBy,
            updatedAt = @updatedAt
        WHERE weeklyMenuEntryId = @entryId AND userID = @userId;

        SELECT weeklyMenuEntryId, userID, isAction, quantity
        FROM dbo.dc_UserWeeklySelections
        WHERE weeklyMenuEntryId = @entryId AND userID = @userId;
      `);
    }

    afterQty = updated.recordset?.[0]?.quantity ?? quantity;

    // 4) Lấy info để push (trong transaction để đảm bảo nhất quán)
    const infoRs = await reqTx.query(`
      SELECT 
        u.fullName,
        f.foodName,
        e.dayOfWeek,
        wm.weekStartMonday
      FROM dbo.Users u
      JOIN dbo.dc_WeeklyMenuEntries e ON e.weeklyMenuEntryId = @entryId
      JOIN dbo.dc_WeeklyMenus wm      ON wm.weeklyMenuId = e.weeklyMenuId
      JOIN dbo.dc_Foods f            ON f.foodId = e.foodId
      WHERE u.userID = @userId
    `);
    infoForPush = infoRs.recordset?.[0] || null;

    await tx.commit();

    // 5) Phản hồi cho client NGAY
    res.json({
      success: true,
      data: updated.recordset?.[0] || null,
      beforeQty,
      afterQty,
      message: "Đã cập nhật số lượng",
    });

    // 6) Gửi push cho admin (không chặn response)
    (async () => {
      try {
        if (!infoForPush) return;
        const { fullName, foodName, dayOfWeek: d, weekStartMonday } = infoForPush;

        // Nếu số lượng về 0 coi như “bỏ hết suất” (nhưng đây là case thư ký chỉnh qty, không phải huỷ 1-món-user-thường)
        const changedText = `${beforeQty} → ${afterQty}`;
        const dayText = viDayOfWeek(d);

        // Tuỳ bạn: lọc vai trò admin
        const adminIDs = await fetchAdminUserIDs(pool); // ví dụ bạn đã có sẵn
        if (!adminIDs || !adminIDs.length) return;

        const body = `[Thư ký] ${fullName} vừa cập nhật số lượng "${foodName}" (${dayText}) từ ${beforeQty} → ${afterQty}`;
        const payload = {
          title: "Cập nhật số lượng cơm",
          body,
          url: `https://noibo.thuanhunglongan.com/lunch-order/admin?menuId=${weeklyMenuId}`,
          tag: "lunch-qty-update",
          renotify: false,
          ttl: 3600,
        };

        await sendPushToUsers(payload, adminIDs);
        console.log(`[push][qty-update] sent to ${adminIDs.length} admins: ${body}`);
      } catch (pushErr) {
        console.error("[push][qty-update] error", pushErr);
      }
    })();

  } catch (err) {
    console.error("POST /secretary/update-quantity error:", err);
    try { await tx.rollback(); } catch {}
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/api/weekly-overtime/tien", async (req, res) => {
  try {
    const { weeklyMenuId, userId } = req.query;
    if (!weeklyMenuId || !userId) return res.status(400).json({ message: "weeklyMenuId, userId required" });

    const pool = await poolPromise;
    const q = await pool.request()
      .input("weeklyMenuId", sql.Int, +weeklyMenuId)
      .input("userId",       sql.Int, +userId)
      .query(`
        ;WITH entries AS (
          SELECT e.weeklyMenuEntryId, e.weeklyMenuId, e.dayOfWeek
          FROM dbo.dc_WeeklyMenuEntries e
          JOIN dbo.dc_Foods f ON f.foodId = e.foodId
          WHERE e.weeklyMenuId = @weeklyMenuId
            AND f.foodCode = 'tien'
        )
        SELECT 
          e.weeklyMenuEntryId,
          e.dayOfWeek,
          ISNULL(s.quantityWorkShift, 0) AS quantityWorkShift
        FROM entries e
        LEFT JOIN dbo.dc_UserWeeklySelections s
          ON s.weeklyMenuEntryId = e.weeklyMenuEntryId
         AND s.userID = @userId
        ORDER BY e.dayOfWeek;
      `);

    res.json(q.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// === OPTION 2: Upsert per item, delete only qty=0 ===
app.post("/api/weekly-workShift/tien", async (req, res) => {
  const { userId, actorId, weeklyMenuId, items } = req.body;
  if (!userId || !Array.isArray(items)) {
    return res.status(400).json({ message: "userId & items required" });
  }

  // 1) Làm sạch: dedup theo weeklyMenuEntryId, ép số >= 0 (KHÔNG filter 0)
  const map = new Map();
  for (const it of items) {
    const eid = Number(it?.weeklyMenuEntryId);
    const qty = Math.max(0, parseInt(it?.quantityWorkShift ?? 0, 10));
    if (!Number.isFinite(eid) || eid <= 0) continue;
    map.set(eid, qty); // nếu trùng, lấy giá trị cuối
  }
  const cleaned = Array.from(map.entries()).map(([weeklyMenuEntryId, quantityWorkShift]) => ({
    weeklyMenuEntryId,
    quantityWorkShift,
  }));

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  // rollback-safe
  let rolledBack = false;
  tx.on("rollback", () => { rolledBack = true; });

  try {
    await tx.begin();

    for (const { weeklyMenuEntryId: eid, quantityWorkShift: qty } of cleaned) {
      if (qty === 0) {
        // DELETE đúng bản ghi OT của entry này (nếu có)
        await new sql.Request(tx)
          .input("uid", sql.Int, +userId)
          .input("eid", sql.Int, +eid)
          .query(`
            DELETE FROM dbo.dc_UserWeeklySelections
            WHERE userID = @uid
              AND weeklyMenuEntryId = @eid
              AND quantityWorkShift IS NOT NULL;
          `);
      } else {
        // UPDATE trước, nếu chưa có thì INSERT
        const upd = await new sql.Request(tx)
          .input("uid", sql.Int, +userId)
          .input("eid", sql.Int, +eid)
          .input("qty", sql.Int, +qty)
          .input("actorId", sql.Int, actorId ? +actorId : null)
          .query(`
            UPDATE dbo.dc_UserWeeklySelections
               SET quantityWorkShift = @qty,
                   updatedAt        = SYSUTCDATETIME(),
                   updatedBy        = @actorId
             WHERE userID = @uid
               AND weeklyMenuEntryId = @eid
               AND quantityWorkShift IS NOT NULL;

            SELECT @@ROWCOUNT AS rc;
          `);

        const rc = upd.recordset?.[0]?.rc ?? 0;
        if (!rc) {
          await new sql.Request(tx)
            .input("uid", sql.Int, +userId)
            .input("eid", sql.Int, +eid)
            .input("qty", sql.Int, +qty)
            .input("actorId", sql.Int, actorId ? +actorId : null)
            .query(`
              INSERT INTO dbo.dc_UserWeeklySelections
                (weeklyMenuEntryId, userID, quantityWorkShift, isAction, isLocked, createdAt, createdBy)
              VALUES
                (@eid, @uid, @qty, 1, 0, SYSUTCDATETIME(), @actorId);
            `);
        }
      }
    }

    await tx.commit();
    return res.json({ ok: true, upsertedOrDeleted: cleaned.length });
  } catch (err) {
    try { if (!rolledBack) await tx.rollback(); } catch (_) {}
    console.error("OT upsert error:", {
      message: err?.message,
      number: err?.number,
      state: err?.state,
      class: err?.class,
      lineNumber: err?.lineNumber,
      serverName: err?.serverName,
      originalError: err?.originalError?.info,
    });
    return res.status(500).json({ message: "Server error", detail: err?.message });
  }
});

// ĐẶT THEO NGÀY — CHỌN NHIỀU MÓN (kiểu thư ký)
app.post("/api/lunch-order/day/secretary/save", async (req, res) => {
  const { date, userId, createdBy, selections } = req.body || {};
  // selections: [{ weeklyMenuEntryId, quantity }...]

  if (!date || !userId || !Array.isArray(selections)) {
    return res.status(400).json({ success: false, message: "Thiếu tham số" });
  }

  // Cutoff 09:00 của ngày đó
  try {
    const now = new Date();
    const cutoff = new Date(date + "T09:00:00");
    if (now > cutoff) {
      return res.status(400).json({ success: false, message: "Đã quá 09:00 của ngày này" });
    }
  } catch {} // nếu parse lỗi thì cứ cho BE xử lý tiếp

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  const viDayOfWeek = (d) => ["", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật"][d] || "";

  try {
    await tx.begin();

    // Tính Monday + dayOfWeek
    const calc = await new sql.Request(tx)
      .input("selectedDate", sql.Date, date)
      .query(`
        DECLARE @monday DATE, @dow INT;
        SET @monday = DATEADD(DAY, -(DATEPART(WEEKDAY, @selectedDate) + @@DATEFIRST - 2) % 7, @selectedDate);
        SET @dow = ((DATEDIFF(DAY, @monday, @selectedDate)) + 1);
        SELECT @monday AS monday, @dow AS dayOfWeek;
      `);
    const meta = calc.recordset?.[0];
    if (!meta) throw new Error("Cannot compute monday/dayOfWeek");
    const { monday, dayOfWeek } = meta;

    // Lấy weekly menu tuần đó (phải có sẵn menu — nếu không có thì coi như không có món)
    const wm = await new sql.Request(tx)
      .input("monday", sql.Date, monday)
      .query(`SELECT TOP 1 weeklyMenuId, isLocked FROM dbo.dc_WeeklyMenus WHERE weekStartMonday=@monday;`);

    const weeklyMenuId = wm.recordset?.[0]?.weeklyMenuId;
    const isLocked = !!wm.recordset?.[0]?.isLocked;

    if (!weeklyMenuId) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: "Chưa có menu cho tuần này" });
    }
    if (isLocked) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: "Menu đã khoá" });
    }

    // Lấy các entry hợp lệ của NGÀY đó để validate
    const validEntriesRs = await new sql.Request(tx)
      .input("wmid", sql.Int, weeklyMenuId)
      .input("dow", sql.Int, dayOfWeek)
      .query(`
        SELECT e.weeklyMenuEntryId
        FROM dbo.dc_WeeklyMenuEntries e
        WHERE e.weeklyMenuId=@wmid AND e.dayOfWeek=@dow
      `);
    const validSet = new Set(validEntriesRs.recordset.map((r) => r.weeklyMenuEntryId));

    // Lọc selections: chỉ nhận entryId hợp lệ, qty >= 1, và không quá lớn tùy bạn muốn
    const clean = [];
    for (const row of selections) {
      const eid = parseInt(row.weeklyMenuEntryId, 10);
      const qty = Math.max(1, parseInt(row.quantity, 10) || 0);
      if (!Number.isFinite(eid) || !eid || !validSet.has(eid)) continue;
      clean.push({ eid, qty });
    }
    if (!clean.length) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: "Không có món hợp lệ" });
    }

    // Gỡ hết các lựa chọn của user cho NGÀY này trước (để tránh rác) → set isAction=0 cho entries cùng ngày
    await new sql.Request(tx)
      .input("uid", sql.Int, userId)
      .input("wmid", sql.Int, weeklyMenuId)
      .input("dow", sql.Int, dayOfWeek)
      .input("by", sql.NVarChar(200), String(createdBy || userId))
      .query(`
        UPDATE uws
           SET isAction = 0,
               updatedBy = @by,
               updatedAt = SYSDATETIME()
        FROM dbo.dc_UserWeeklySelections uws
        JOIN dbo.dc_WeeklyMenuEntries e ON e.weeklyMenuEntryId = uws.weeklyMenuEntryId
        WHERE uws.userID = @uid
          AND e.weeklyMenuId = @wmid
          AND e.dayOfWeek = @dow;
      `);

    // Upsert selections mới (kiểu thư ký)
    for (const { eid, qty } of clean) {
      await new sql.Request(tx)
        .input("uid", sql.Int, userId)
        .input("eid", sql.Int, eid)
        .input("q", sql.Int, qty)
        .input("by", sql.NVarChar(200), String(createdBy || userId))
        .query(`
          MERGE dbo.dc_UserWeeklySelections AS t
          USING (SELECT @uid AS userID, @eid AS weeklyMenuEntryId) s
          ON (t.userID=s.userID AND t.weeklyMenuEntryId=s.weeklyMenuEntryId)
          WHEN MATCHED THEN UPDATE SET isAction=1, quantity=@q, updatedBy=@by, updatedAt=SYSDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (userID, weeklyMenuEntryId, isAction, quantity, createdAt, updatedAt, updatedBy)
            VALUES (@uid, @eid, 1, @q, SYSDATETIME(), SYSDATETIME(), @by);
        `);
    }

    await tx.commit();
    res.json({ success: true, data: { weeklyMenuId, dayOfWeek } });

    // Push báo admin (không chặn response)
    try {
      const totalQty = clean.reduce((s, r) => s + r.qty, 0);
      const body = `${createdBy || "Ai đó"} vừa đặt theo ngày ${viDayOfWeek(dayOfWeek)} (${date}) – ${clean.length} món, tổng SL ${totalQty}`;
      const adminIDs = [1]; // thay bằng fetch danh sách admin nếu có
      if (adminIDs.length) {
        await sendPushToUsers({
          title: "Đặt cơm theo ngày",
          body,
          url: `https://noibo.thuanhunglongan.com/lunch-order/admin?date=${encodeURIComponent(date)}`,
          tag: "lunch-day-secretary",
          ttl: 3600
        }, adminIDs);
      }
    } catch (e) {
      console.error("[push][day-secretary]", e);
    }
  } catch (err) {
    console.error("POST /day/secretary/save", err);
    try { await tx.rollback(); } catch {}
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/api/lunch-order/day/entries", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: "Thiếu tham số date" });

    const pool = await poolPromise;

    // Tính Monday (tuần chứa date) và dayOfWeek 1..7
    const meta = await pool.request()
      .input("selectedDate", sql.Date, date)
      .query(`
        DECLARE @monday DATE, @dow INT;
        SET @monday = DATEADD(DAY, -(DATEPART(WEEKDAY, @selectedDate) + @@DATEFIRST - 2) % 7, @selectedDate);
        SET @dow = ((DATEDIFF(DAY, @monday, @selectedDate)) + 1);
        SELECT @monday AS monday, @dow AS dayOfWeek;
      `);

    const info = meta.recordset?.[0];
    if (!info) return res.status(500).json({ success: false, message: "Không tính được thứ/tuần" });
    const { monday, dayOfWeek } = info;

    // Lấy weekly menu tuần đó
    const wm = await pool.request()
      .input("monday", sql.Date, monday)
      .query(`SELECT TOP 1 weeklyMenuId, isLocked FROM dbo.dc_WeeklyMenus WHERE weekStartMonday=@monday;`);

    const weeklyMenuId = wm.recordset?.[0]?.weeklyMenuId;
    if (!weeklyMenuId) {
      // Không có menu → trả về rỗng nhưng success để FE xử lý gracefully
      return res.json({ success: true, data: { entries: [] } });
    }

    // Lấy entries cho NGÀY
    const rs = await pool.request()
      .input("wmid", sql.Int, weeklyMenuId)
      .input("dow", sql.Int, dayOfWeek)
      .query(`
        SELECT 
          e.weeklyMenuEntryId,
          e.dayOfWeek,
          f.foodName,
          f.imageUrl
        FROM dbo.dc_WeeklyMenuEntries e
        JOIN dbo.dc_Foods f ON f.foodId = e.foodId
        WHERE e.weeklyMenuId=@wmid AND e.dayOfWeek=@dow
        ORDER BY e.position ASC, e.weeklyMenuEntryId ASC;
      `);

    return res.json({ success: true, data: { entries: rs.recordset } });
  } catch (err) {
    console.error("GET /day/entries error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


// GET: /api/lunch-order/history?date=YYYY-MM-DD&userId=123
app.get("/api/lunch-order/history", async (req, res) => {
  try {
    const { date, userId } = req.query;
    // optional: re | ws | ot
    let { statusType } = req.query;

    if (!date || !userId) {
      return res.status(400).json({ success: false, message: "Thiếu tham số" });
    }

    // chuẩn hóa statusType nếu có
    if (typeof statusType === "string") {
      statusType = statusType.trim().toLowerCase();
      if (!["re", "ws", "ot"].includes(statusType)) statusType = null;
    } else {
      statusType = null;
    }

    const pool = await poolPromise;

    const rs = await pool.request()
      .input("selectedDate", sql.Date, date)
      .input("userId", sql.Int, userId)
      .input("statusType", sql.NVarChar(10), statusType) // có thể là null
      .query(`
        SET NOCOUNT ON;
        -- Lấy thứ 2 của tuần chứa @selectedDate (đặt Monday là ngày đầu tuần)
        SET DATEFIRST 1;
        DECLARE @monday DATE = DATEADD(DAY, 1 - DATEPART(WEEKDAY, @selectedDate), @selectedDate);

        /*
          Gộp theo entry + branch để:
          - quantity: SUM
          - selectedAt: MIN (lần chọn đầu tiên)
        */
        SELECT
          w.weeklyMenuId,
          w.weekStartMonday,
          w.isLocked,
          e.weeklyMenuEntryId,
          e.dayOfWeek,
          e.position,
          LOWER(ISNULL(e.statusType, 're')) AS statusType,
          f.foodName,
          f.imageUrl,
          uws.branchId,
          fb.branchCode,
          fb.branchName,
          MIN(uws.createdAt) AS selectedAt,
          SUM(ISNULL(NULLIF(uws.quantity, 0), 1)) AS quantity
        FROM dbo.dc_WeeklyMenus w
        JOIN dbo.dc_WeeklyMenuEntries e
          ON w.weeklyMenuId = e.weeklyMenuId
        JOIN dbo.dc_Foods f
          ON e.foodId = f.foodId
        JOIN dbo.dc_UserWeeklySelections uws
          ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
         AND uws.userID = @userId
         AND uws.isAction = 1
        LEFT JOIN dbo.dc_FoodBranches fb
          ON fb.branchId = uws.branchId
        WHERE w.weekStartMonday = @monday
          AND (@statusType IS NULL OR LOWER(ISNULL(e.statusType, 're')) = @statusType)
        GROUP BY
          w.weeklyMenuId, w.weekStartMonday, w.isLocked,
          e.weeklyMenuEntryId, e.dayOfWeek, e.position, e.statusType,
          f.foodName, f.imageUrl,
          uws.branchId, fb.branchCode, fb.branchName
        ORDER BY e.dayOfWeek, e.position, fb.branchName;
      `);

    res.json({ success: true, data: rs.recordset });
  } catch (err) {
    console.error("Get history error:", err);
    res.status(500).json({ success: false, message: "Lỗi lấy lịch sử đặt cơm" });
  }
});



//----     API đặt giùm-----------------------------------


// GET /api/lunch-order/proxy/department-users
app.get("/api/lunch-order/proxy/department-users", async (req, res) => {
  try {
    const { requesterId } = req.query;
    const pool = await poolPromise;

    const rs = await pool.request()
      .input("requesterId", sql.Int, requesterId)
      .query(`
        SELECT u.userID, u.fullName
        FROM dbo.Users u
        JOIN dbo.Users me ON me.userID = @requesterId
        WHERE u.dc_DepartmentID = me.dc_DepartmentID
          AND u.userID <> @requesterId
          AND u.isActive = 1
        ORDER BY u.fullName;
      `);

    res.json({ success: true, data: rs.recordset });
  } catch (err) {
    console.error("Dept users error:", err);
    res.status(500).json({ success: false, message: "Lỗi lấy danh sách user cùng bộ phận" });
  }
});

// GET /api/lunch-order/proxy/selections
app.get("/api/lunch-order/proxy/selections", async (req, res) => {
  try {
    const { weeklyMenuId, userId, selectedByUserId } = req.query;
    const pool = await poolPromise;

    const rs = await pool.request()
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .input("userId", sql.Int, userId)
      .input("selectedByUserId", sql.Int, selectedByUserId)
      .query(`
        SELECT uws.weeklyMenuEntryId
        FROM dbo.dc_UserWeeklySelections uws
        JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId AND uws.isAction = 1
        WHERE uws.userID = @userId
          AND uws.selectedByUserId = @selectedByUserId
          AND e.weeklyMenuId = @weeklyMenuId;
      `);

    res.json({ success: true, data: rs.recordset.map(r => r.weeklyMenuEntryId) });
  } catch (err) {
    console.error("Selections proxy error:", err);
    res.status(500).json({ success: false, message: "Lỗi lấy selections đặt giùm" });
  }
});


app.post("/api/lunch-order/proxy/save", async (req, res) => {
  const { userId, selectedByUserId, weeklyMenuId, selections, createdBy } = req.body;
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // 1. Xoá selections cũ
    await new sql.Request(transaction)
      .input("userId", sql.Int, userId)
      .input("selectedByUserId", sql.Int, selectedByUserId)
      .input("weeklyMenuId", sql.Int, weeklyMenuId)
      .query(`
        DELETE uws
        FROM dbo.dc_UserWeeklySelections uws
        JOIN dbo.dc_WeeklyMenuEntries e 
          ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
        WHERE uws.userID = @userId
          AND uws.selectedByUserId = @selectedByUserId
          AND e.weeklyMenuId = @weeklyMenuId;
      `);

    // 2. Thêm selections mới
    for (let entryId of selections) {
        if (entryId === null) continue;

      await new sql.Request(transaction)
        .input("userId", sql.Int, userId)
        .input("selectedByUserId", sql.Int, selectedByUserId)
        .input("entryId", sql.Int, entryId)
        .input("createdBy", sql.Int, createdBy)
        .query(`
          INSERT INTO dbo.dc_UserWeeklySelections
            (weeklyMenuEntryId, userID, selectedByUserId, createdBy, updatedBy)
          VALUES (@entryId, @userId, @selectedByUserId, @createdBy, @createdBy);
        `);
    }

    await transaction.commit();
    res.json({ success: true, message: "Lưu đặt giùm thành công" });
  } catch (err) {
    await transaction.rollback();
    console.error("Save proxy error:", err);
    res.status(500).json({ success: false, message: "Lỗi lưu đặt giùm" });
  }
});


// api.js
app.get("/api/lunch-order/proxy/history", async (req, res) => {
  const { selectedByUserId, date } = req.query;
  if (!selectedByUserId || !date)
    return res.status(400).json({ success: false, message: "Thiếu tham số" });

  try {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input("selectedByUserId", sql.Int, selectedByUserId)
      .input("date", sql.Date, date)
      .query(`
        SELECT u.userID, u.fullName, f.foodName, f.imageUrl, e.dayOfWeek,
               w.weekStartMonday, s.userWeeklySelectionId
        FROM dbo.dc_UserWeeklySelections s
        JOIN dbo.Users u ON s.userID = u.userID
        JOIN dbo.dc_WeeklyMenuEntries e ON s.weeklyMenuEntryId = e.weeklyMenuEntryId
        JOIN dbo.dc_WeeklyMenus w ON e.weeklyMenuId = w.weeklyMenuId
        JOIN dbo.dc_Foods f ON e.foodId = f.foodId
        WHERE s.selectedByUserId = @selectedByUserId
          AND w.weekStartMonday <= @date
          AND DATEADD(DAY, 6, w.weekStartMonday) >= @date
          AND s.isAction = 1
        ORDER BY u.fullName, e.dayOfWeek
      `);

    // Group theo user
    const grouped = rs.recordset.reduce((acc, row) => {
      if (!acc[row.userID]) {
        acc[row.userID] = {
          userID: row.userID,
          fullName: row.fullName,
          items: [],
        };
      }
      acc[row.userID].items.push({
        foodName: row.foodName,
        imageUrl: row.imageUrl,
        dayOfWeek: row.dayOfWeek,
        weekStartMonday: row.weekStartMonday,
        userWeeklySelectionId: row.userWeeklySelectionId,
      });
      return acc;
    }, {});

    res.json({ success: true, data: Object.values(grouped) });
  } catch (err) {
    console.error("Proxy history error:", err);
    res.status(500).json({ success: false, message: "Lỗi lấy lịch sử đặt giùm" });
  }
});


///---------------API Trang lịch sử admin 
// GET /api/lunch-order/admin/history
// app.get("/api/lunch-order/admin/history", async (req, res) => {
//   try {
//     const {
//       weekStartMonday,      // 'YYYY-MM-DD' (thứ 2 của tuần)
//       departmentId,         // INT | null
//       proxyByUserId,        // INT | null - lọc theo người ĐẶT GIÙM
//       search = "",          // text
//       page = 1,
//       pageSize = 20,
//     } = req.query;

//     const _page = Math.max(1, parseInt(page, 10) || 1);
//     const _pageSize = Math.max(1, parseInt(pageSize, 10) || 20);
//     const offset = (_page - 1) * _pageSize;

//     const pool = await poolPromise;
//     const request = pool.request();
//     request.input("weekStartMonday", sql.Date, weekStartMonday || null);
//     request.input("departmentId", sql.Int, departmentId || null);
//     request.input("proxyByUserId", sql.Int, proxyByUserId || null);
//     request.input("search", sql.NVarChar, `%${search || ""}%`);
//     request.input("offset", sql.Int, offset);
//     request.input("pageSize", sql.Int, _pageSize);

//     const query = `
//       WITH filtered AS (
//         SELECT 
//           u.userID,
//           u.fullName,
//           d.departmentName,
//           f.foodName,
//           f.imageUrl,                     -- ảnh món
//           wme.dayOfWeek,
//           uws.createdAt      AS selectedAt,    -- thời gian đặt
//           uws.selectedByUserId,
//           proxy.fullName     AS proxyName,
//           uws.isAction,                     -- << thêm trạng thái để FE biết
//           -- Tổng chỉ tính những bản ghi active (isAction = 1) sau các filter
//           SUM(CASE WHEN uws.isAction = 1 THEN 1 ELSE 0 END) 
//             OVER ()           AS totalActive
//         FROM dbo.dc_UserWeeklySelections uws
//         JOIN dbo.dc_WeeklyMenuEntries wme ON uws.weeklyMenuEntryId = wme.weeklyMenuEntryId
//         JOIN dbo.dc_WeeklyMenus wm ON wm.weeklyMenuId = wme.weeklyMenuId
//         JOIN dbo.dc_Foods f ON wme.foodId = f.foodId
//         JOIN dbo.Users u ON u.userID = uws.userID
//         LEFT JOIN dbo.dc_Department d ON d.departmentId = u.dc_DepartmentID
//         LEFT JOIN dbo.Users proxy ON proxy.userID = uws.selectedByUserId
//         WHERE (@weekStartMonday IS NULL OR wm.weekStartMonday = @weekStartMonday)
//           AND (@departmentId  IS NULL OR u.dc_DepartmentID = @departmentId)
//           AND (@proxyByUserId IS NULL OR uws.selectedByUserId = @proxyByUserId)
//           AND (
//                 @search = '' 
//                 OR u.fullName LIKE @search
//                 OR f.foodName LIKE @search
//               )
//           -- KHÔNG lọc isAction ở đây nữa để trả về cả 0/1
//       )
//       SELECT *
//       FROM filtered
//       ORDER BY fullName, dayOfWeek
//       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
//     `;

//     const result = await request.query(query);

//     // total = tổng active (isAction=1) theo đúng filter, không theo phân trang
//     const totalActive = result.recordset?.[0]?.totalActive ?? 0;

//     res.json({
//       success: true,
//       data: result.recordset || [],
//       total: totalActive,         // chỉ đếm isAction = 1
//       page: _page,
//       pageSize: _pageSize,
//     });
//   } catch (err) {
//     console.error("Error /admin/history", err);
//     res.status(500).json({ success: false, message: "Server error" });
//   }
// });

app.get("/api/lunch-order/admin/history", async (req, res) => {
  try {
    const {
      weekStartMonday,
      departmentId,
      proxyByUserId,
      search = "",
      page = 1,
      pageSize = 20,
      statusType,
    } = req.query;

    const _status = (statusType || "").toLowerCase();
    const statusParam = ["re","ws","ot"].includes(_status) ? _status : null;

    const _page = Math.max(1, parseInt(page, 10) || 1);
    const _pageSize = Math.max(1, parseInt(pageSize, 10) || 20);
    const offset = (_page - 1) * _pageSize;

    const pool = await poolPromise;
    const request = pool.request();
    request.input("weekStartMonday", sql.Date, weekStartMonday || null);
    request.input("departmentId", sql.Int, departmentId || null);      // null = tất cả
    request.input("proxyByUserId", sql.Int, proxyByUserId || null);
    request.input("search", sql.NVarChar, `%${search || ""}%`);
    request.input("offset", sql.Int, offset);
    request.input("pageSize", sql.Int, _pageSize);
    request.input("statusType", sql.NVarChar(10), statusParam);

    const query = `
    IF OBJECT_ID('tempdb..#filtered') IS NOT NULL DROP TABLE #filtered;

-- 1) Dòng dữ liệu đã lọc (món)
SELECT 
  u.userID,
  u.fullName,
  d.departmentName,
  f.foodName,
  f.imageUrl,
  wme.dayOfWeek,
  uws.createdAt                   AS selectedAt,
  uws.selectedByUserId,
  proxy.fullName                  AS proxyName,
  uws.isAction,

  -- Qty chuẩn hoá (active)
  COALESCE(uws.quantity, uws.quantityWorkShift, 1) AS qty,
  uws.quantity,
  uws.quantityWorkShift,
  -- nếu CSDL có cột này thì giữ lại; nếu không có thì xoá 2 dòng dưới
  uws.quantityOvertime,

  -- Loại suất đã chuẩn hoá để FE dùng thẳng
  LOWER(
    CASE 
      WHEN ISNULL(uws.quantityOvertime,0)    > 0 THEN 'ot'       -- nếu không có cột, bỏ dòng này
      WHEN ISNULL(uws.quantityWorkShift,0)   > 0 THEN 'ws'
      ELSE ISNULL(wme.statusType,'re')  -- fallback theo cấu hình entry
    END
  ) AS itemType,

  wme.weeklyMenuEntryId,
  uws.userWeeklySelectionId,
  uws.branchId,
  fb.branchCode,
  fb.branchName
INTO #filtered
FROM dbo.dc_UserWeeklySelections uws
JOIN dbo.dc_WeeklyMenuEntries wme ON uws.weeklyMenuEntryId = wme.weeklyMenuEntryId
JOIN dbo.dc_WeeklyMenus wm        ON wm.weeklyMenuId       = wme.weeklyMenuId
JOIN dbo.dc_Foods f               ON wme.foodId            = f.foodId
JOIN dbo.Users u                  ON u.userID              = uws.userID
LEFT JOIN dbo.dc_Department d     ON d.departmentId        = u.dc_DepartmentID
LEFT JOIN dbo.Users proxy         ON proxy.userID          = uws.selectedByUserId
LEFT JOIN dbo.dc_FoodBranches fb  ON fb.branchId           = uws.branchId
WHERE (@weekStartMonday IS NULL OR wm.weekStartMonday = @weekStartMonday)
  AND (@departmentId  IS NULL OR u.dc_DepartmentID = @departmentId)
  AND (@proxyByUserId IS NULL OR uws.selectedByUserId = @proxyByUserId)
  AND (
        @statusType IS NULL
        OR LOWER(
            CASE 
              WHEN ISNULL(uws.quantityOvertime,0)  > 0 THEN 'ot'   -- nếu không có cột, bỏ dòng này
              WHEN ISNULL(uws.quantityWorkShift,0) > 0 THEN 'ws'
              ELSE ISNULL(wme.statusType,'re')
            END
        ) = @statusType
      )
  AND (
    @search = '' 
    OR u.fullName LIKE @search
    OR f.foodName LIKE @search
  );

-- 2) Danh sách user duy nhất
IF OBJECT_ID('tempdb..#users') IS NOT NULL DROP TABLE #users;
SELECT DISTINCT userID, fullName, departmentName
INTO #users
FROM #filtered;

-- 3) Totals (không phân trang)
SELECT 
  (SELECT COUNT(*) FROM #users) AS totalUsers,
  (SELECT SUM(CASE WHEN isAction = 1 THEN qty ELSE 0 END) FROM #filtered) AS totalQtyActive;

-- 4) Trang user
IF OBJECT_ID('tempdb..#pageUsers') IS NOT NULL DROP TABLE #pageUsers;
SELECT userID
INTO #pageUsers
FROM #users
ORDER BY fullName
OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;

-- 5) Dữ liệu món của các user trong trang
SELECT f.*
FROM #filtered f
JOIN #pageUsers pu ON pu.userID = f.userID
ORDER BY f.fullName, f.dayOfWeek, f.selectedAt DESC;

    `;

    const result = await request.query(query);
    const totals   = result.recordsets?.[0]?.[0] || { totalUsers: 0, totalQtyActive: 0 };
    const pageData = result.recordsets?.[1] || [];

    res.json({
      success: true,
      data: pageData,
      totalQtyActive: totals.totalQtyActive ?? 0,
      totalUsers: totals.totalUsers ?? 0,   // ⭐ tổng người để tính số trang
      page: _page,
      pageSize: _pageSize,
      statusType: statusParam || 'all',
    });
  } catch (err) {
    console.error("Error /admin/history", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// GET /api/lunch-order/admin/departments
app.get("/api/lunch-order/admin/departments", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT departmentId, departmentName
      FROM dbo.dc_Department
      WHERE isAction = 1
      ORDER BY departmentName;
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("Error /admin/departments:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /api/lunch-order/admin/proxy-users
app.get("/api/lunch-order/admin/proxy-users", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT DISTINCT u.userID, u.fullName
      FROM dbo.dc_UserWeeklySelections uws
      JOIN dbo.Users u ON u.userID = uws.selectedByUserId AND uws.isAction = 1
      WHERE uws.selectedByUserId IS NOT NULL
      ORDER BY u.fullName;
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("Error /admin/proxy-users:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


/// ------------ API trang bảng thống kê
// GET /api/lunch-order/admin/summary
app.get("/api/lunch-order/admin/summary", async (req, res) => {
  try {
    const { weekStartMonday, departmentId, statusType } = req.query;

    const statusTypeParam = ['re','ws','ot'].includes((statusType || '').toLowerCase())
      ? (statusType || '').toLowerCase()
      : null;

    const pool = await poolPromise;
    const request = pool.request();
    request.input("weekStartMonday", sql.Date, weekStartMonday || null);
    request.input("departmentId", sql.Int, departmentId || null);
    request.input("statusType", sql.NVarChar(10), statusTypeParam);

    const query = `
      SET NOCOUNT ON;

      IF OBJECT_ID('tempdb..#users')   IS NOT NULL DROP TABLE #users;
      IF OBJECT_ID('tempdb..#picked')  IS NOT NULL DROP TABLE #picked;
      IF OBJECT_ID('tempdb..#sel')     IS NOT NULL DROP TABLE #sel;

      -- 1) Tập người
      SELECT DISTINCT
        u.userID,
        u.fullName,
        u.dc_DepartmentID     AS departmentId,
        d.departmentName
      INTO #users
      FROM dbo.Users u
      JOIN dbo.UserModules um   ON um.userId   = u.userID
      JOIN dbo.Modules m        ON m.moduleId  = um.moduleId AND m.moduleKey = 'datcom'
      LEFT JOIN dbo.dc_Department d ON d.departmentId = u.dc_DepartmentID
      WHERE u.isActive = 1
        AND (@departmentId IS NULL OR u.dc_DepartmentID = @departmentId);

      /* 2) Chi tiết đã lọc theo tuần + statusType (ở WeeklyMenuEntries) + JOIN branch */
      SELECT
        uws.userID,
        wme.dayOfWeek,
        f.foodName,
        wme.statusType,                           -- 're'|'ws'|'ot'
        CAST(COALESCE(uws.quantity,0) AS int) AS qty,
        fb.branchName                             -- <-- đưa branch vào đây
      INTO #picked
      FROM dbo.dc_UserWeeklySelections uws
      JOIN dbo.dc_WeeklyMenuEntries wme ON wme.weeklyMenuEntryId = uws.weeklyMenuEntryId
      JOIN dbo.dc_WeeklyMenus wm        ON wm.weeklyMenuId       = wme.weeklyMenuId
      JOIN dbo.dc_Foods f               ON f.foodId              = wme.foodId
      JOIN #users u                     ON u.userID              = uws.userID
      LEFT JOIN dbo.dc_FoodBranches fb  ON fb.branchId           = uws.branchId   -- <== nếu cột của bạn tên khác, đổi ở đây
      WHERE wm.weekStartMonday = @weekStartMonday
        AND uws.isAction = 1
        AND COALESCE(uws.quantity,0) > 0
        AND (@statusType IS NULL OR wme.statusType = @statusType);

      /* 3) Gom phục vụ bảng chính (string_agg), KHÔNG mất branch ở details */
      SELECT
        p.userID,
        p.dayOfWeek,
        p.foodName,
        p.statusType,
        p.branchName,
        SUM(p.qty) AS qty
      INTO #sel
      FROM #picked p
      GROUP BY p.userID, p.dayOfWeek, p.foodName, p.statusType, p.branchName
      HAVING SUM(p.qty) > 0;

      /* 4) Bảng chính: ghép chuỗi "Món xSL" mỗi ngày cho từng user */
      ;WITH per_day AS (
        SELECT
          s.userID,
          s.dayOfWeek,
          STRING_AGG(CONCAT(s.foodName, N' x', CAST(s.qty AS NVARCHAR(20))), N', ')
            WITHIN GROUP (ORDER BY s.foodName) AS foodsText
        FROM #sel s
        GROUP BY s.userID, s.dayOfWeek
      )
      SELECT
        u.userID,
        u.fullName,
        u.departmentId,
        u.departmentName,
        pd.dayOfWeek,
        pd.foodsText
      FROM #users u
      LEFT JOIN per_day pd ON pd.userID = u.userID
      ORDER BY COALESCE(u.departmentName, N'Zzz'), u.fullName, pd.dayOfWeek;

      /* 5) Trả recordset 2: DETAILS (để FE xuất Excel đẹp, có (branch) + Loại tiếng Việt) */
      SELECT
        u.userID,
        u.fullName,
        u.departmentId,
        u.departmentName,
        s.dayOfWeek,
        s.foodName,
        s.qty,
        s.statusType,
        s.branchName
      FROM #sel s
      JOIN #users u ON u.userID = s.userID
      ORDER BY COALESCE(u.departmentName, N'Zzz'), u.fullName, s.dayOfWeek, s.foodName;

      /* 6) Trả recordset 3: TOTALS toàn cục theo ngày/món (phục vụ hàng “Tổng từng món (toàn bộ)”) */
      SELECT
        s.dayOfWeek,
        s.foodName,
        SUM(s.qty) AS totalQty
      FROM #sel s
      GROUP BY s.dayOfWeek, s.foodName
      ORDER BY s.dayOfWeek, s.foodName;

      DROP TABLE #sel;
      DROP TABLE #picked;
      DROP TABLE #users;
    `;

    const result = await request.query(query);
    // recordsets[0] = data, [1] = details, [2] = totals
    const [dataRs = [], detailsRs = [], totalsRs = []] = result.recordsets || [];
    res.json({
      success: true,
      data: dataRs,
      details: detailsRs,
      totals: totalsRs
    });
  } catch (err) {
    console.error("Error /summary", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// ===== Helpers =====
function toISODate(dateStr) { return new Date(dateStr + 'T00:00:00'); }
function getMonday(dateStr) {
  const d = toISODate(dateStr);
  const day = d.getDay(); // 0 Sun..6 Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ===== Departments (để đổ dropdown) =====
app.get('/api/lunch-order/departments', async (req, res) => {
  try {
    const pool = req.app.get('mssql');
    const rs = await pool.request().query(`
      SELECT departmentId, departmentName
      FROM dbo.dc_Department
      WHERE isAction = 1
      ORDER BY departmentName
    `);
    res.json(rs.recordset || []);
  } catch (err) {
    console.error('GET /api/datcom/departments', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/lunch-order/admin/debt-daily?month=YYYY-MM&departmentId=...&includeSpill=0|1
app.get("/api/lunch-order/admin/debt-daily", async (req, res) => {
  try {
    const { month, departmentId, includeSpill } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, message: "month dạng YYYY-MM" });
    }

    const [y, m] = month.split("-").map(Number);
    const pad2 = (n) => String(n).padStart(2, "0");

    const startDateObj = new Date(y, m - 1, 1);
    const endOfMonthObj = new Date(y, m, 0);
    const spillDays = String(includeSpill) === "1" ? 6 : 0;
    const endDateObj = new Date(
      endOfMonthObj.getFullYear(),
      endOfMonthObj.getMonth(),
      endOfMonthObj.getDate() + spillDays
    );

    const startDate = `${startDateObj.getFullYear()}-${pad2(startDateObj.getMonth() + 1)}-01`;
    const endDate   = `${endDateObj.getFullYear()}-${pad2(endDateObj.getMonth() + 1)}-${pad2(endDateObj.getDate())}`;

    const pool = await poolPromise;
    const reqdb = pool.request();
    reqdb.input("startDate", sql.Date, startDate);
    reqdb.input("endDate",   sql.Date, endDate);
    reqdb.input("departmentId", sql.Int, departmentId || null);

    const query = `
      SET NOCOUNT ON;

      WITH base AS (
        SELECT 
          CAST(DATEADD(DAY, wme.dayOfWeek - 1, wm.weekStartMonday) AS DATE) AS actualDate,
          uws.isAction,
          COALESCE(uws.quantity, 1) AS qty,
          wme.statusType,                 -- 're' | 'ot' | 'ws'
          u.dc_DepartmentID
        FROM dbo.dc_UserWeeklySelections uws
        JOIN dbo.dc_WeeklyMenuEntries wme ON uws.weeklyMenuEntryId = wme.weeklyMenuEntryId
        JOIN dbo.dc_WeeklyMenus       wm  ON wm.weeklyMenuId       = wme.weeklyMenuId
        JOIN dbo.Users                u   ON u.userID              = uws.userID
        JOIN dbo.dc_Foods            f    ON f.foodId              = wme.foodId
        WHERE DATEADD(DAY, wme.dayOfWeek - 1, wm.weekStartMonday) BETWEEN @startDate AND @endDate
          AND (@departmentId IS NULL OR u.dc_DepartmentID = @departmentId)
          -- KHÔNG giới hạn foodCode nữa: lấy tất cả món
      )
      SELECT 
        actualDate,
        SUM(CASE WHEN isAction = 1 AND statusType = 're' THEN qty ELSE 0 END) AS lunchQty, -- Cơm trưa
        SUM(CASE WHEN isAction = 1 AND statusType = 'ot' THEN qty ELSE 0 END) AS otQty,    -- Tăng ca
        SUM(CASE WHEN isAction = 1 AND statusType = 'ws' THEN qty ELSE 0 END) AS wsQty     -- Đi ca
      FROM base
      GROUP BY actualDate
      ORDER BY actualDate;
    `;

    const rs = await reqdb.query(query);
    const rows = rs.recordset || [];

    const totalLunch = rows.reduce((s, r) => s + (r.lunchQty || 0), 0);
    const totalOT    = rows.reduce((s, r) => s + (r.otQty || 0), 0);
    const totalWS    = rows.reduce((s, r) => s + (r.wsQty || 0), 0);

    res.json({
      success: true,
      data: rows, // [{ actualDate, lunchQty, otQty, wsQty }]
      sum: { lunchQty: totalLunch, otQty: totalOT, wsQty: totalWS, total: totalLunch + totalOT + totalWS },
      range: { startDate, endDate },
      note: "Tách theo dc_WeeklyMenuEntries.statusType: re=trưa, ot=tăng ca, ws=đi ca"
    });
  } catch (err) {
    console.error("Error /admin/debt-daily", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


/**
 * GET /api/datcom/unordered-week
 * Query:
 *  - week (YYYY-MM-DD Monday)  hoặc  date (YYYY-MM-DD) -> auto tính Monday
 *  - departmentId (optional)
 *  - q (optional: search fullName/username/phone)
 *  - mode = 'any' | 'incomplete' (default 'any')
 */
app.get('/api/lunch-order/unordered-week', async (req, res) => {
  const pool = await poolPromise;
  try {
    let { week, date, departmentId, q, mode, statusType } = req.query;
    mode = (mode === 'incomplete') ? 'incomplete' : 'any';
    statusType = ['re','ws','ot'].includes((statusType||'').toLowerCase()) ? (statusType||'').toLowerCase() : null; // null = all

    const weekStartMonday = week ? week : (date ? getMonday(date) : null);
    if (!weekStartMonday) return res.status(400).json({ error: 'Missing week (YYYY-MM-DD Monday) or date' });

    // Lấy menu tuần
    const rWeek = await pool.request()
      .input('weekStartMonday', sql.Date, weekStartMonday)
      .query(`
        SELECT TOP(1) weeklyMenuId, isLocked
        FROM dbo.dc_WeeklyMenus
        WHERE weekStartMonday = @weekStartMonday AND isAction = 1
      `);

    if (rWeek.recordset.length === 0) {
      return res.json({
        weekStartMonday, weeklyMenuId: null, isLocked: 0,
        totalEligible: 0, totalUnordered: 0,
        weekAvailableDays: 0,
        items: [], summaryByDepartment: [],
        note: 'Không có thực đơn cho tuần này.'
      });
    }

    const { weeklyMenuId, isLocked } = rWeek.recordset[0];

    // Entry của tuần, lọc theo loại nếu có
    const rEntries = await pool.request()
      .input('weeklyMenuId', sql.Int, weeklyMenuId)
      .input('statusType', sql.NVarChar, statusType)
      .query(`
        SELECT weeklyMenuEntryId, dayOfWeek
        FROM dbo.dc_WeeklyMenuEntries
        WHERE weeklyMenuId = @weeklyMenuId
          AND isAction = 1
          AND (@statusType IS NULL OR statusType = @statusType)
      `);

    const entryIds = rEntries.recordset.map(r => r.weeklyMenuEntryId);
    const weekDays = [...new Set(rEntries.recordset.map(r => r.dayOfWeek))];
    const weekAvailableDays = weekDays.length;

    // Eligible users (có module datcom & active)
    const eligible = await pool.request()
      .input('moduleKey', sql.NVarChar, 'datcom')
      .input('departmentId', sql.Int, departmentId || null)
      .input('q', sql.NVarChar, q ? `%${q}%` : null)
      .query(`
        WITH DatcomUsers AS (
          SELECT DISTINCT u.userID, u.username, u.fullName, u.phone, u.isActive, u.lastLogin,
                 u.dc_DepartmentID, d.departmentName
          FROM dbo.Users u
          JOIN dbo.UserModules um ON um.userId = u.userID
          JOIN dbo.Modules m ON m.moduleId = um.moduleId
          LEFT JOIN dbo.dc_Department d ON d.departmentId = u.dc_DepartmentID
          WHERE u.isActive = 1 AND m.moduleKey = @moduleKey
        )
        SELECT *
        FROM DatcomUsers du
        WHERE (@departmentId IS NULL OR du.dc_DepartmentID = @departmentId)
          AND (@q IS NULL OR du.fullName LIKE @q OR du.username LIKE @q OR du.phone LIKE @q)
        ORDER BY du.fullName
      `);

    const totalEligible = eligible.recordset.length;

    // ❗ Khi không có entry cho loại này trong tuần: trả về rỗng (không xem là "chưa đặt")
    if (entryIds.length === 0) {
      return res.json({
        weekStartMonday, weeklyMenuId, isLocked,
        totalEligible, totalUnordered: 0,
        weekAvailableDays, mode,
        items: [], summaryByDepartment: [],
        note: 'Tuần này không có món cho loại đã chọn.'
      });
    }

    const entriesTable = entryIds.join(',');

    // Đếm số ngày đã chọn (distinct dayOfWeek) trong tuần CHO ĐÚNG LOẠI
    const selectedDaysRS = await pool.request().query(`
      SELECT s.userID, COUNT(DISTINCT e.dayOfWeek) AS selectedDays
      FROM dbo.dc_UserWeeklySelections s
      JOIN dbo.dc_WeeklyMenuEntries e ON e.weeklyMenuEntryId = s.weeklyMenuEntryId
      WHERE s.isAction = 1
        AND s.weeklyMenuEntryId IN (${entriesTable})
      GROUP BY s.userID
    `);

    const selectedMap = new Map(selectedDaysRS.recordset.map(r => [r.userID, r.selectedDays || 0]));

    let items;
    if (mode === 'any') {
      // chưa đặt ngày nào cho LOẠI đã chọn
      items = eligible.recordset
        .filter(x => !selectedMap.has(x.userID))
        .map(x => ({
          userID: x.userID,
          fullName: x.fullName,
          username: x.username,
          phone: x.phone,
          departmentId: x.dc_DepartmentID,
          departmentName: x.departmentName || null,
          lastLogin: x.lastLogin,
          selectedDays: 0,
          status: 'no-selection-in-week'
        }));
    } else {
      // đặt chưa đủ số ngày có món cho LOẠI đó
      items = eligible.recordset
        .filter(x => (selectedMap.get(x.userID) || 0) < weekAvailableDays)
        .map(x => ({
          userID: x.userID,
          fullName: x.fullName,
          username: x.username,
          phone: x.phone,
          departmentId: x.dc_DepartmentID,
          departmentName: x.departmentName || null,
          lastLogin: x.lastLogin,
          selectedDays: selectedMap.get(x.userID) || 0,
          status: (selectedMap.has(x.userID) ? 'incomplete' : 'no-selection-in-week')
        }));
    }

    const byDept = {};
    items.forEach(it => {
      const k = it.departmentName || 'Chưa gán phòng ban';
      byDept[k] = (byDept[k] || 0) + 1;
    });
    const summaryByDepartment = Object.entries(byDept).map(([k, v]) => ({ departmentName: k, count: v }));

    res.json({
      weekStartMonday, weeklyMenuId, isLocked,
      totalEligible, totalUnordered: items.length,
      weekAvailableDays, mode, statusType: statusType || 'all',
      items, summaryByDepartment
    });

  } catch (err) {
    console.error('GET /api/lunch-order/unordered-week error', err);
    res.status(500).json({ error: 'Internal error', detail: String(err?.message || err) });
  }
});


///// ------------------------------- API Trang dashboard

/** Helper: get Monday (YYYY-MM-DD) */
function getMonday(dateStr) {
  const d = new Date(dateStr ?? new Date());
  const day = d.getDay(); // 0 Sun..6 Sat
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * GET /api/lunch-order/dashboard?week=YYYY-MM-DD
 * week: bất kỳ ngày trong tuần -> backend auto về Monday
 * Trả về:
 * {
 *   weekStart: "2025-09-22",
 *   totals: { totalUsers, totalOrdered, totalNotOrdered, orderRate },
 *   topFood: { foodName, totalOrders } | null,
 *   leastFood: { foodName, totalOrders } | null,
 *   chart: [{ dayOfWeek, foodName, totalOrders }...],
 *   perDayTotals: [{ dayOfWeek, totalOrders }...],
 *   byDepartment: [{ departmentName, ordered, notOrdered, total }...]
 * }
 */
// app.get('/api/lunch-order/dashboard', async (req, res) => {
//   try {
//     const { week } = req.query;
//     const weekStart = getMonday(week);
//     const pool = await poolPromise;

//     // 1) Tổng user có module lunch
//     const qTotalUsers = await pool.request().query(`
//       SELECT COUNT(DISTINCT um.userId) AS totalUsers
//       FROM dbo.UserModules um
//       INNER JOIN dbo.Modules m ON um.moduleId = m.moduleId
//       WHERE m.moduleKey = 'datcom'
//     `);
//     const totalUsers = qTotalUsers.recordset[0]?.totalUsers ?? 0;

//     // 2) Tổng user đã đặt tuần này
//     const qOrdered = await pool.request()
//       .input('weekStart', sql.Date, weekStart)
//       .query(`
//         SELECT COUNT(DISTINCT uws.userID) AS totalOrdered
//         FROM dbo.dc_UserWeeklySelections uws
//         INNER JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
//         INNER JOIN dbo.dc_WeeklyMenus wm ON e.weeklyMenuId = wm.weeklyMenuId
//         WHERE wm.weekStartMonday = @weekStart AND uws.isAction = 1
//       `);
//     const totalOrdered = qOrdered.recordset[0]?.totalOrdered ?? 0;
//     const totalNotOrdered = Math.max(totalUsers - totalOrdered, 0);
//     const orderRate = totalUsers ? Math.round((totalOrdered / totalUsers) * 100) : 0;

//     // 3) Top/least món trong tuần
//     const qFoods = await pool.request()
//       .input('weekStart', sql.Date, weekStart)
//       .query(`
//         SELECT f.foodName, f.imageUrl, COUNT(*) AS totalOrders
//         FROM dbo.dc_UserWeeklySelections uws
//         INNER JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
//         INNER JOIN dbo.dc_WeeklyMenus wm ON e.weeklyMenuId = wm.weeklyMenuId
//         INNER JOIN dbo.dc_Foods f ON e.foodId = f.foodId
//         WHERE wm.weekStartMonday = @weekStart AND uws.isAction = 1
//         GROUP BY f.foodName, f.imageUrl
//         ORDER BY totalOrders DESC, f.foodName ASC
//       `);
//     const foods = qFoods.recordset || [];
//     const topFood = foods[0] || null;
//     const leastFood = foods.length ? foods[foods.length - 1] : null;

//     // 4) Dữ liệu chart (stacked theo món x dayOfWeek)
//     const qChart = await pool.request()
//       .input('weekStart', sql.Date, weekStart)
//       .query(`
//         SELECT e.dayOfWeek, f.foodName, COUNT(*) AS totalOrders
//         FROM dbo.dc_UserWeeklySelections uws
//         INNER JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
//         INNER JOIN dbo.dc_WeeklyMenus wm ON e.weeklyMenuId = wm.weeklyMenuId
//         INNER JOIN dbo.dc_Foods f ON e.foodId = f.foodId
//         WHERE wm.weekStartMonday = @weekStart AND uws.isAction = 1
//         GROUP BY e.dayOfWeek, f.foodName
//         ORDER BY e.dayOfWeek ASC
//       `);
//     const chart = qChart.recordset || [];

//     // 5) Tổng theo ngày (để vẽ đường hoặc nhãn)
//     const qPerDay = await pool.request()
//       .input('weekStart', sql.Date, weekStart)
//       .query(`
//         SELECT e.dayOfWeek, COUNT(*) AS totalOrders
//         FROM dbo.dc_UserWeeklySelections uws
//         INNER JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
//         INNER JOIN dbo.dc_WeeklyMenus wm ON e.weeklyMenuId = wm.weeklyMenuId
//         WHERE wm.weekStartMonday = @weekStart AND uws.isAction = 1
//         GROUP BY e.dayOfWeek
//         ORDER BY e.dayOfWeek
//       `);
//     const perDayTotals = qPerDay.recordset || [];

//     // 6) Phân bổ theo phòng ban (ordered / notOrdered)
//     const qDept = await pool.request()
//       .input('weekStart', sql.Date, weekStart)
//       .query(`
//         WITH users_lunch AS (
//           SELECT DISTINCT um.userId, u.fullName, u.dc_DepartmentID
//           FROM dbo.UserModules um
//           JOIN dbo.Modules m ON um.moduleId = m.moduleId
//           JOIN dbo.Users u ON u.userID = um.userId
//           WHERE m.moduleKey = 'datcom'
//         ),
//         ordered_this_week AS (
//           SELECT DISTINCT uws.userID
//           FROM dbo.dc_UserWeeklySelections uws
//           JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
//           JOIN dbo.dc_WeeklyMenus wm ON e.weeklyMenuId = wm.weeklyMenuId
//           WHERE wm.weekStartMonday = @weekStart AND uws.isAction = 1
//         )
//         SELECT
//           COALESCE(d.departmentName, N'Chưa gán') AS departmentName,
//           COUNT(*) AS total,
//           SUM(CASE WHEN otw.userID IS NOT NULL THEN 1 ELSE 0 END) AS ordered,
//           SUM(CASE WHEN otw.userID IS NULL THEN 1 ELSE 0 END) AS notOrdered
//         FROM users_lunch ul
//         LEFT JOIN ordered_this_week otw ON otw.userID = ul.userId
//         LEFT JOIN dbo.dc_Department d ON d.departmentId = ul.dc_DepartmentID
//         GROUP BY COALESCE(d.departmentName, N'Chưa gán')
//         ORDER BY departmentName;
//       `);
//     const byDepartment = qDept.recordset || [];

//     const qLead = await pool.request()
//   .input("weekStart", sql.Date, weekStart)
//   .query(`
// SELECT TOP 1 DATEPART(HOUR, uws.createdAt) AS hourSlot,
//              COUNT(*) AS totalOrders
// FROM dbo.dc_UserWeeklySelections uws
// JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
// JOIN dbo.dc_WeeklyMenus wm ON e.weeklyMenuId = wm.weeklyMenuId
// WHERE wm.weekStartMonday = @weekStart AND uws.isAction = 1
// GROUP BY DATEPART(HOUR, uws.createdAt)
// ORDER BY totalOrders DESC;
//     `);
// const leadTime = qLead.recordset[0] || null;

//     res.json({
//       weekStart,
//       totals: { totalUsers, totalOrdered, totalNotOrdered, orderRate },
//       topFood,
//       leastFood,
//       chart,
//       perDayTotals,
//       byDepartment,
//       leadTime,
//     });
//   } catch (err) {
//     console.error('dashboard error', err);
//     res.status(500).json({ message: 'Internal error' });
//   }
// });

// server: dashboard API
app.get('/api/lunch-order/dashboard', async (req, res) => {
  try {
    const { week } = req.query;
    let { statusType, branchMode } = req.query; // statusType: re/ws/ot/all|undefined, branchMode: 'split'|'aggregate'
    const weekStart = getMonday(week);
    const pool = await poolPromise;

    // chuẩn hoá tham số
    statusType = (statusType || '').toLowerCase();
    if (!['re','ws','ot'].includes(statusType)) statusType = null; // null = all
    branchMode = (branchMode || '').toLowerCase() === 'split' ? 'split' : 'aggregate';

    // ===== CTE dùng chung: lọc theo tuần + loại =====
    // ===== CTE dùng chung (KHÔNG có dấu ';' ở đầu) =====
const baseSql = `
WITH base AS (
  SELECT
    uws.userID,
    uws.weeklyMenuEntryId,
    uws.branchId,
    ISNULL(NULLIF(uws.quantity,0),1) AS qty,
    uws.createdAt
  FROM dbo.dc_UserWeeklySelections uws
  JOIN dbo.dc_WeeklyMenuEntries e ON uws.weeklyMenuEntryId = e.weeklyMenuEntryId
  JOIN dbo.dc_WeeklyMenus wm ON e.weeklyMenuId = wm.weeklyMenuId
  WHERE wm.weekStartMonday = @weekStart
    AND uws.isAction = 1
    AND uws.quantityWorkShift IS NULL
    ${statusType ? `AND LOWER(ISNULL(e.statusType,'re')) = @statusType` : ``}
)
`;

    // 1) Tổng user có module lunch
    const qTotalUsers = await pool.request().query(`
      SELECT COUNT(DISTINCT um.userId) AS totalUsers
      FROM dbo.UserModules um
      JOIN dbo.Modules m ON um.moduleId = m.moduleId
      WHERE m.moduleKey = 'datcom';
    `);
    const totalUsers = qTotalUsers.recordset[0]?.totalUsers ?? 0;

    // 2) Ordered users (đếm người) & 2b) Tổng suất
    const qOrderedUsers = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql}
    SELECT
      (SELECT COUNT(DISTINCT userID) FROM base) AS totalOrderedUsers,
      (SELECT SUM(qty) FROM base)               AS totalMeals;
  `);
    const totalOrdered = qOrderedUsers.recordset[0]?.totalOrderedUsers ?? 0;
    const totalMeals   = qOrderedUsers.recordset[0]?.totalMeals ?? 0;
    const totalNotOrdered = Math.max(totalUsers - totalOrdered, 0);
    const orderRate = totalUsers ? Math.round((totalOrdered / totalUsers) * 100) : 0;

    // 3) Top/least món — có branch
    const qFoods = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql}
    SELECT
      f.foodName, f.imageUrl,
      b.branchId, fb.branchCode, fb.branchName,
      SUM(b.qty) AS totalOrders
    FROM base b
    JOIN dbo.dc_WeeklyMenuEntries e ON b.weeklyMenuEntryId = e.weeklyMenuEntryId
    JOIN dbo.dc_Foods f             ON e.foodId = f.foodId
    LEFT JOIN dbo.dc_FoodBranches fb ON fb.branchId = b.branchId
    GROUP BY f.foodName, f.imageUrl, b.branchId, fb.branchCode, fb.branchName
    ORDER BY totalOrders DESC, f.foodName ASC, fb.branchName ASC;
  `);
    const foods = qFoods.recordset || [];

    // “aggregate” → gộp các branch theo món để tìm top/least
    // “split”     → xếp hạng theo từng (món, branch)
    const topFood   = foods[0] || null;
    const leastFood = foods.length ? foods[foods.length - 1] : null;

    // 4) Chart stacked: dayOfWeek × (món [× branch])
    const qChart = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql}
    SELECT
      e.dayOfWeek,
      f.foodName,
      b.branchId,
      fb.branchName,
      SUM(b.qty) AS totalOrders
    FROM base b
    JOIN dbo.dc_WeeklyMenuEntries e ON b.weeklyMenuEntryId = e.weeklyMenuEntryId
    JOIN dbo.dc_Foods f             ON e.foodId = f.foodId
    LEFT JOIN dbo.dc_FoodBranches fb ON fb.branchId = b.branchId
    GROUP BY e.dayOfWeek, f.foodName, b.branchId, fb.branchName
    ORDER BY e.dayOfWeek, f.foodName, fb.branchName;
  `);

    const chartRaw = qChart.recordset || [];

    // 5) Tổng theo ngày
    const qPerDay = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql}
    SELECT e.dayOfWeek, SUM(b.qty) AS totalOrders
    FROM base b
    JOIN dbo.dc_WeeklyMenuEntries e ON b.weeklyMenuEntryId = e.weeklyMenuEntryId
    GROUP BY e.dayOfWeek
    ORDER BY e.dayOfWeek;
  `);

    const perDayTotals = qPerDay.recordset || [];

    // 6) Phân bổ theo phòng ban (người & suất)
    const qDept = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql},
    users_lunch AS (
      SELECT DISTINCT um.userId, u.fullName, u.dc_DepartmentID
      FROM dbo.UserModules um
      JOIN dbo.Modules m ON um.moduleId = m.moduleId
      JOIN dbo.Users u   ON u.userID = um.userId
      WHERE m.moduleKey = 'datcom'
    ),
    ordered_users AS (
      SELECT DISTINCT userID FROM base
    ),
    meals_dept AS (
      SELECT
        u.userID,
        COALESCE(d.departmentName, N'Chưa gán') AS departmentName,
        SUM(b.qty) AS meals
      FROM base b
      JOIN dbo.Users u         ON u.userID = b.userID
      LEFT JOIN dbo.dc_Department d ON d.departmentId = u.dc_DepartmentID
      GROUP BY u.userID, COALESCE(d.departmentName, N'Chưa gán')
    )
    SELECT
      COALESCE(d.departmentName, N'Chưa gán') AS departmentName,
      COUNT(*) AS total,
      SUM(CASE WHEN ou.userID IS NOT NULL THEN 1 ELSE 0 END) AS ordered,
      SUM(CASE WHEN ou.userID IS NULL  THEN 1 ELSE 0 END)    AS notOrdered,
      ISNULL(SUM(md.meals), 0) AS totalMeals
    FROM users_lunch ul
    LEFT JOIN ordered_users ou ON ou.userID = ul.userId
    LEFT JOIN dbo.dc_Department d ON d.departmentId = ul.dc_DepartmentID
    LEFT JOIN meals_dept md      ON md.userID = ul.userId
    GROUP BY COALESCE(d.departmentName, N'Chưa gán')
    ORDER BY departmentName;
  `);

    const byDepartment = qDept.recordset || [];

    // 7) Dept × Day
    const qDeptDay = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql}
    SELECT
      COALESCE(d.departmentName, N'Chưa gán') AS departmentName,
      e.dayOfWeek,
      SUM(b.qty) AS totalMeals
    FROM base b
    JOIN dbo.Users u               ON u.userID = b.userID
    JOIN dbo.dc_WeeklyMenuEntries e ON b.weeklyMenuEntryId = e.weeklyMenuEntryId
    LEFT JOIN dbo.dc_Department d   ON d.departmentId = u.dc_DepartmentID
    GROUP BY COALESCE(d.departmentName, N'Chưa gán'), e.dayOfWeek
    ORDER BY departmentName, e.dayOfWeek;
  `);

    const deptDay = qDeptDay.recordset || [];

    // 7b) Dept × Day × Food [× Branch]
    const qDeptDayFood = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql}
    SELECT
      COALESCE(d.departmentName, N'Chưa gán') AS departmentName,
      e.dayOfWeek,
      f.foodName,
      b.branchId,
      fb.branchName,
      SUM(b.qty) AS totalMeals
    FROM base b
    JOIN dbo.Users u               ON u.userID = b.userID
    JOIN dbo.dc_WeeklyMenuEntries e ON b.weeklyMenuEntryId = e.weeklyMenuEntryId
    JOIN dbo.dc_Foods f            ON e.foodId = f.foodId
    LEFT JOIN dbo.dc_Department d  ON d.departmentId = u.dc_DepartmentID
    LEFT JOIN dbo.dc_FoodBranches fb ON fb.branchId = b.branchId
    GROUP BY COALESCE(d.departmentName, N'Chưa gán'), e.dayOfWeek, f.foodName, b.branchId, fb.branchName
    ORDER BY departmentName, dayOfWeek, foodName, fb.branchName;
  `);

    const deptDayFood = qDeptDayFood.recordset || [];

    // 8) Giờ cao điểm
    const qLead = await pool.request()
  .input('weekStart', sql.Date, weekStart)
  .input('statusType', sql.NVarChar(10), statusType)
  .query(`
    ${baseSql}
    SELECT TOP 1
      DATEPART(HOUR, b.createdAt) AS hourSlot,
      SUM(b.qty) AS totalOrders
    FROM base b
    GROUP BY DATEPART(HOUR, b.createdAt)
    ORDER BY totalOrders DESC;
  `);

    const leadTime = qLead.recordset[0] || null;

    res.json({
      weekStart,
      statusType: statusType || 'all',
      branchMode,
      totals: { totalUsers, totalOrdered, totalNotOrdered, orderRate, totalMeals },
      topFood,        // có branch
      leastFood,      // có branch
      chart: chartRaw, // có branch
      perDayTotals,
      byDepartment,
      deptDay,
      deptDayFood,     // có branch
      leadTime,
    });
  } catch (err) {
    console.error('dashboard error', err);
    res.status(500).json({ message: 'Internal error' });
  }
});

app.post('/api/lunch-order/admin/remind-latest-unordered', /*authAdmin,*/ async (req, res) => {
  try {
    // 1) Lấy menu mới nhất còn mở
    const latest = await getLatestUnlockedMenu();
    if (!latest) {
      return res.status(200).json({ ok: true, message: 'Không có menu đang mở (isLocked=0).' });
    }

    // 2) Lấy danh sách user chưa đặt cho menu đó
    const unorderedUserIDs = await getUsersNotOrderedForMenu(latest.weeklyMenuId);
    if (!unorderedUserIDs.length) {
      return res.status(200).json({
        ok: true,
        weeklyMenuId: latest.weeklyMenuId,
        message: 'Tất cả user đã đặt/không còn ai cần nhắc.'
      });
    }

    // 3) Gửi push
    const payload = {
      title: 'Nhắc đặt cơm',
      body: 'Đã có thực đơn tuần mới. Vui lòng đặt cơm.',
      url: 'https://noibo.thuanhunglongan.com/lunch-order/me',
      ttl: 3600
    };
    const result = await sendPushToUsers(payload, unorderedUserIDs);

    return res.json({
      ok: true,
      weeklyMenuId: latest.weeklyMenuId,
      unordered: unorderedUserIDs.length,
      push: result
    });
  } catch (e) {
    console.error('remind-latest-unordered error', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});



//====================  API trang đặt món của user



// const ALLOWED_TYPES = new Set(["re", "ws", "ot"]);

// // GET /api/lunch-order/user/weekly-menu-latest?statusType=re|ws|ot
// app.get("/api/lunch-order/user/weekly-menu-latest", async (req, res) => {
//   try {
//     const statusType = String(req.query.statusType || "").toLowerCase();
//     const menu = await repo.getLatestWeeklyMenu();
//     if (!menu) return res.json({ data: null });

//     if (statusType && ALLOWED_TYPES.has(statusType)) {
//       menu.entries = (menu.entries || []).filter(
//         (e) => String(e.statusType || "re").toLowerCase() === statusType
//       );
//     }
//     return res.json({ data: menu });
//   } catch (e) {
//     console.error(e);
//     return res.status(500).json({ message: "Server error" });
//   }
// });

// // GET /api/lunch-order/user/selections/:weeklyMenuId/:userId
// app.get("/api/lunch-order/user/selections/:weeklyMenuId/:userId", async (req, res) => {
//   try {
//     const { weeklyMenuId, userId } = req.params;
//     const rows = await repo.getUserSelections(Number(weeklyMenuId), String(userId));
//     return res.json({ data: rows });
//   } catch (e) {
//     console.error(e);
//     return res.status(500).json({ message: "Server error" });
//   }
// });

// POST /api/lunch-order/user/selections/save
// body: { userId, weeklyMenuId, selections, createdBy }
// selections:
//  - user thường: number[] (entryId list)
//  - thư ký: [{entryId:number, quantity:number}]

// app.post("/api/lunch-order/user/selections/save", async (req, res) => {
//   try {
//     const { userId, weeklyMenuId, selections, createdBy } = req.body || {};
//     if (!userId || !weeklyMenuId || !Array.isArray(selections)) {
//       return res.status(400).json({ message: "Payload không hợp lệ" });
//     }

//     const menu = await repo.getWeeklyMenu(Number(weeklyMenuId));
//     if (!menu || menu.isLocked) {
//       return res.status(400).json({ message: "Menu đã khoá" });
//     }

//     // xác định dạng selections
//     const isSecretaryMode = selections.length > 0 && typeof selections[0] === "object";
//     if (isSecretaryMode) {
//       await repo.saveSecretarySelections(String(userId), Number(weeklyMenuId), selections, String(createdBy || userId));
//     } else {
//       await repo.saveUserDaySelections(String(userId), Number(weeklyMenuId), selections, String(createdBy || userId));
//     }
//     return res.json({ ok: true });
//   } catch (e) {
//     console.error(e);
//     return res.status(500).json({ message: "Server error" });
//   }
// });

// POST /api/lunch-order/user/selections/item-action
// body: { userId, weeklyMenuId, weeklyMenuEntryId, isAction(0|1), updatedBy }

// app.post("/api/lunch-order/user/selections/item-action", async (req, res) => {
//   try {
//     const { userId, weeklyMenuId, weeklyMenuEntryId, isAction, updatedBy } = req.body || {};
//     if (!userId || !weeklyMenuId || !weeklyMenuEntryId || (isAction !== 0 && isAction !== 1)) {
//       return res.status(400).json({ message: "Payload không hợp lệ" });
//     }

//     const menu = await repo.getWeeklyMenu(Number(weeklyMenuId));
//     if (!menu || menu.isLocked) {
//       return res.status(400).json({ message: "Menu đã khoá" });
//     }

//     await repo.setItemAction(
//       String(userId),
//       Number(weeklyMenuId),
//       Number(weeklyMenuEntryId),
//       Number(isAction),
//       String(updatedBy || userId)
//     );
//     return res.json({ ok: true });
//   } catch (e) {
//     console.error(e);
//     return res.status(500).json({ message: "Server error" });
//   }
// });

// POST /api/lunch-order/secretary/update-quantity
// body: { userId, weeklyMenuId, weeklyMenuEntryId, quantity, updatedBy }

// app.post("/api/lunch-order/secretary/update-quantity", async (req, res) => {
//   try {
//     const { userId, weeklyMenuId, weeklyMenuEntryId, quantity, updatedBy } = req.body || {};
//     if (!userId || !weeklyMenuId || !weeklyMenuEntryId) {
//       return res.status(400).json({ message: "Payload không hợp lệ" });
//     }

//     const menu = await repo.getWeeklyMenu(Number(weeklyMenuId));
//     if (!menu || menu.isLocked) {
//       return res.status(400).json({ message: "Menu đã khoá" });
//     }

//     await repo.updateSecretaryQuantity(
//       String(userId),
//       Number(weeklyMenuId),
//       Number(weeklyMenuEntryId),
//       Math.max(1, parseInt(quantity || 1, 10)),
//       String(updatedBy || userId)
//     );
//     return res.json({ ok: true });
//   } catch (e) {
//     console.error(e);
//     return res.status(500).json({ message: "Server error" });
//   }
// });

// GET /api/lunch-order/day/entries?date=YYYY-MM-DD&statusType=re|ws|ot

// app.get("/api/lunch-order/day/entries", async (req, res) => {
//   try {
//     const date = String(req.query.date || "");
//     const statusType = String(req.query.statusType || "re").toLowerCase();
//     if (!date) return res.status(400).json({ message: "Thiếu date" });
//     if (!ALLOWED_TYPES.has(statusType)) return res.status(400).json({ message: "statusType không hợp lệ" });

//     const entries = await repo.getEntriesByDate(date, statusType);
//     return res.json({ data: { entries } });
//   } catch (e) {
//     console.error(e);
//     return res.status(500).json({ message: "Server error" });
//   }
// });

// POST /api/lunch-order/day/secretary/save
// body: { date, userId, createdBy, selections: [{weeklyMenuEntryId, quantity}] }

// app.post("/api/lunch-order/day/secretary/save", async (req, res) => {
//   try {
//     const { date, userId, selections, createdBy } = req.body || {};
//     if (!date || !userId || !Array.isArray(selections)) {
//       return res.status(400).json({ message: "Payload không hợp lệ" });
//     }
//     await repo.saveDaySecretary(String(userId), String(date), selections, String(createdBy || userId));
//     return res.json({ ok: true });
//   } catch (e) {
//     console.error(e);
//     return res.status(500).json({ message: "Server error" });
//   }
// });

//============================ API của phần tra cứu ======================

app.get("/api/lunch-order/search/day", async (req, res) => {
  try {
    const qRaw = (req.query.q || "").trim();
    // format: YYYY-MM-DD (client gửi), mặc định hôm nay (server time)
    const dateStr = (req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);

    const pool = await poolPromise;
    const request = pool.request();
    request.input("date", sql.Date, dateStr);
    request.input("q", sql.NVarChar(80), qRaw ? `%${qRaw}%` : null);

    const result = await request.query(`
      SET NOCOUNT ON;
      SET DATEFIRST 1;

      DECLARE @d DATE       = @date;
      DECLARE @dow INT      = DATEPART(WEEKDAY, @d);
      DECLARE @weekStart DATE = DATEADD(DAY, 1 - DATEPART(WEEKDAY, @d), @d);

      ;WITH u AS (
        SELECT userId, username, fullName, email, isActive
        FROM dbo.Users
        WHERE isActive = 1
          AND (@q IS NULL OR @q = N'' OR username LIKE @q OR fullName LIKE @q)
      ),
      wm AS (
        SELECT weeklyMenuId
        FROM dbo.dc_WeeklyMenus
        WHERE weekStartMonday = @weekStart
      ),
      dayEntries AS (
        SELECT wme.weeklyMenuEntryId, wme.foodId, wme.position, wme.dayOfWeek, wme.statusType
        FROM dbo.dc_WeeklyMenuEntries wme
        JOIN wm ON wm.weeklyMenuId = wme.weeklyMenuId
        WHERE wme.dayOfWeek = @dow
      )
      SELECT
        u.userId,
        u.username,
        u.fullName,
        f.foodId,
        f.foodName,
        COALESCE(f.imageUrl, N'') AS imageUrl,
        de.statusType,  
        sel.quantity,
        sel.quantityOvertime,
        sel.quantityWorkShift,
        fb.branchId,
        fb.branchCode,
        fb.branchName
      FROM u
      JOIN dbo.dc_UserWeeklySelections sel
        ON sel.userId = u.userId
      JOIN dayEntries de
        ON de.weeklyMenuEntryId = sel.weeklyMenuEntryId
      JOIN dbo.dc_Foods f
        ON f.foodId = de.foodId
      LEFT JOIN dbo.dc_FoodBranches fb
        ON fb.branchId = sel.branchId
      WHERE (sel.quantity > 0 OR sel.quantityOvertime > 0 OR sel.quantityWorkShift > 0)
      ORDER BY u.fullName, de.position, f.foodName;
    `);

    // group theo user cho UI dễ render
    const rows = result.recordset || [];
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.userId]) {
        grouped[r.userId] = {
          userId: r.userId,
          username: r.username,
          fullName: r.fullName,
          items: []
        };
      }
      grouped[r.userId].items.push({
        foodId: r.foodId,
        foodName: r.foodName,
        imageUrl: r.imageUrl,
        branchId: r.branchId,
        branchCode: r.branchCode,
        branchName: r.branchName,
        statusType: r.statusType,
        quantity: r.quantity || 0,
        quantityOvertime: r.quantityOvertime || 0,
        quantityWorkShift: r.quantityWorkShift || 0,
      });
    }

    res.json({
      ok: true,
      data: Object.values(grouped),
      meta: { date: dateStr, q: qRaw }
    });
  } catch (err) {
    console.error("search/day error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});



}

module.exports = {
    apiLunchOrder,
}