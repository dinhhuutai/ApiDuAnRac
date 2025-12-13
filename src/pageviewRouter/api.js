const express = require("express");
const router = express.Router();
const { poolPromise, sql } = require("../db");
const { requireAuth } = require("../middleware/auth");

router.post("/", requireAuth, async (req, res) => {
  try {
    const userID = req.user.userID;
    const { path, routeKey, pageName } = req.body;

    if (!path) return res.status(400).json({ ok: false, message: "Missing path" });

    const pool = await poolPromise;
    await pool.request()
      .input("userID", sql.Int, userID)
      .input("path", sql.NVarChar(300), path)
      .input("routeKey", sql.NVarChar(100), routeKey || null)
      .input("pageName", sql.NVarChar(200), pageName || null)
      .query(`
        INSERT INTO dbo.UserPageViews (userID, path, routeKey, pageName)
        VALUES (@userID, @path, @routeKey, @pageName)
      `);

    res.json({ ok: true });
  } catch (err) {
    console.error("pageview error:", err);
    res.status(500).json({ ok: false });
  }
});

router.get("/top-pages", requireAuth, async (req, res) => {
  try {
    const { date } = req.query; // YYYY-MM-DD optional
    const pool = await poolPromise;

    const r = await pool.request()
      .input("d", sql.Date, date ? new Date(date) : null)
      .query(`
        DECLARE @workDate DATE = ISNULL(@d, CAST(GETDATE() AS DATE));

        SELECT TOP 50
          COALESCE(pageName, routeKey, path) AS page,
          COUNT(*) AS views
        FROM dbo.UserPageViews
        WHERE CAST(viewTime AS DATE) = @workDate
        GROUP BY COALESCE(pageName, routeKey, path)
        ORDER BY views DESC;
      `);

    res.json({ ok: true, data: r.recordset });
  } catch (err) {
    console.error("pageview top-pages error:", err);
    res.status(500).json({ ok: false });
  }
});

router.get("/top-pages-range", requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query; // YYYY-MM-DD
    const pool = await poolPromise;

    // nếu thiếu from/to thì fallback hôm nay
    const fromDate = from ? new Date(from) : new Date();
    const toDate = to ? new Date(to) : new Date();

    const r = await pool
      .request()
      .input("from", sql.Date, fromDate)
      .input("to", sql.Date, toDate)
      .query(`
        SELECT TOP 50
          COALESCE(pageName, routeKey, path) AS page,
          COUNT(*) AS views
        FROM dbo.UserPageViews
        WHERE viewTime >= @from
          AND viewTime < DATEADD(DAY, 1, @to)
        GROUP BY COALESCE(pageName, routeKey, path)
        ORDER BY views DESC;
      `);

    return res.json({ ok: true, data: r.recordset });
  } catch (err) {
    console.error("pageview top-pages-range error:", err);
    return res.status(500).json({ ok: false });
  }
});

router.get("/top-pages-by-user", requireAuth, async (req, res) => {
  try {
    const { userId, from, to } = req.query; // userId required
    if (!userId) return res.status(400).json({ ok: false, message: "Missing userId" });

    const pool = await poolPromise;

    const fromDate = from ? new Date(from) : new Date();
    const toDate = to ? new Date(to) : new Date();

    const r = await pool
      .request()
      .input("userId", sql.Int, Number(userId))
      .input("from", sql.Date, fromDate)
      .input("to", sql.Date, toDate)
      .query(`
        SELECT TOP 50
          COALESCE(pageName, routeKey, path) AS page,
          COUNT(*) AS views
        FROM dbo.UserPageViews
        WHERE userID = @userId
          AND viewTime >= @from
          AND viewTime < DATEADD(DAY, 1, @to)
        GROUP BY COALESCE(pageName, routeKey, path)
        ORDER BY views DESC;
      `);

    return res.json({ ok: true, data: r.recordset });
  } catch (err) {
    console.error("pageview top-pages-by-user error:", err);
    return res.status(500).json({ ok: false });
  }
});


module.exports = router;
