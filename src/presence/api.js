const express = require('express');
const router = express.Router();
const { poolPromise, sql } = require('../db');
const { requireAuth } = require('../middleware/auth');

const MAX_GAP_SECONDS = 120; // ping 30s => giới hạn 120s để khỏi cộng bậy
const ONLINE_MINUTES = 2;    // coi online nếu lastOnline trong 2 phút gần nhất

// 1) FE gọi mỗi 30s: cộng dồn totalSeconds + update lastOnline
router.post("/ping", requireAuth, async (req, res) => {
  try {
    const userID = req.user.userID; // requireAuth phải set req.user

    const pool = await poolPromise;
    const r = await pool.request()
      .input("userID", sql.Int, userID)
      .input("maxGap", sql.Int, MAX_GAP_SECONDS)
      .query(`
        DECLARE @now DATETIME2 = SYSDATETIME();
        DECLARE @today DATE = CAST(@now AS DATE);

        -- cập nhật lần hoạt động cuối
        UPDATE dbo.Users
        SET lastOnline = @now
        WHERE userID = @userID;

        -- cộng dồn online theo ngày
        MERGE dbo.UserPresenceDaily AS t
        USING (SELECT @userID AS userID, @today AS workDate) AS s
        ON (t.userID = s.userID AND t.workDate = s.workDate)
        WHEN MATCHED THEN
          UPDATE SET
            totalSeconds = t.totalSeconds +
              CASE
                WHEN DATEDIFF(SECOND, t.lastPingAt, @now) < 0 THEN 0
                WHEN DATEDIFF(SECOND, t.lastPingAt, @now) > @maxGap THEN @maxGap
                ELSE DATEDIFF(SECOND, t.lastPingAt, @now)
              END,
            lastPingAt = @now,
            lastSeenAt = @now
        WHEN NOT MATCHED THEN
          INSERT (userID, workDate, lastSeenAt, lastPingAt, totalSeconds)
          VALUES (@userID, @today, @now, @now, 0);

        SELECT userID, workDate, lastSeenAt, totalSeconds
        FROM dbo.UserPresenceDaily
        WHERE userID = @userID AND workDate = @today;
      `);

    return res.json({ ok: true, data: r.recordset?.[0] });
  } catch (err) {
    console.error("presence ping error:", err);
    return res.status(500).json({ ok: false, message: "presence ping failed" });
  }
});

// 2) Lấy trạng thái hôm nay (cho admin / dashboard)
router.get("/today", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request()
      .input("onlineMinutes", sql.Int, ONLINE_MINUTES)
      .query(`
        DECLARE @today DATE = CAST(GETDATE() AS DATE);

        SELECT
          u.userID,
          u.username,
          u.fullName,
          u.role,
          u.lastOnline,
          CASE
            WHEN u.lastOnline >= DATEADD(MINUTE, -@onlineMinutes, GETDATE()) THEN 1
            ELSE 0
          END AS isOnline,
          ISNULL(p.totalSeconds, 0) AS totalOnlineTodaySeconds
        FROM dbo.Users u
        LEFT JOIN dbo.UserPresenceDaily p
          ON p.userID = u.userID AND p.workDate = @today
        WHERE u.isDeleted = 0 AND u.isActive = 1
        ORDER BY u.lastOnline DESC;
      `);

    return res.json({ ok: true, data: r.recordset });
  } catch (err) {
    console.error("presence today error:", err);
    return res.status(500).json({ ok: false });
  }
});

router.get("/top-users", requireAuth, async (req, res) => {
  try {
    const { date } = req.query; // YYYY-MM-DD optional
    const pool = await poolPromise;

    const r = await pool.request()
      .input("d", sql.Date, date ? new Date(date) : null)
      .query(`
        DECLARE @workDate DATE = ISNULL(@d, CAST(GETDATE() AS DATE));

        SELECT TOP 50
          u.userID,
          u.username,
          u.fullName,
          u.role,
          u.lastOnline,
          ISNULL(p.totalSeconds, 0) AS totalSeconds
        FROM dbo.Users u
        LEFT JOIN dbo.UserPresenceDaily p
          ON p.userID = u.userID AND p.workDate = @workDate
        WHERE u.isDeleted = 0 AND u.isActive = 1
        ORDER BY ISNULL(p.totalSeconds, 0) DESC, u.lastOnline DESC;
      `);

    res.json({ ok: true, data: r.recordset });
  } catch (err) {
    console.error("presence top-users error:", err);
    res.status(500).json({ ok: false });
  }
});

router.get("/top-users-range", requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query; // YYYY-MM-DD
    const pool = await poolPromise;

    const fromDate = from ? new Date(from) : new Date();
    const toDate = to ? new Date(to) : new Date();

    const r = await pool.request()
      .input("from", sql.Date, fromDate)
      .input("to", sql.Date, toDate)
      .query(`
        SELECT TOP 50
          u.userID,
          u.username,
          u.fullName,
          u.role,
          MAX(u.lastOnline) AS lastOnline,
          SUM(ISNULL(p.totalSeconds, 0)) AS totalSeconds
        FROM dbo.Users u
        LEFT JOIN dbo.UserPresenceDaily p
          ON p.userID = u.userID
         AND p.workDate >= @from
         AND p.workDate <= @to
        WHERE u.isDeleted = 0 AND u.isActive = 1
        GROUP BY u.userID, u.username, u.fullName, u.role
        ORDER BY SUM(ISNULL(p.totalSeconds, 0)) DESC;
      `);

    return res.json({ ok: true, data: r.recordset });
  } catch (err) {
    console.error("presence top-users-range error:", err);
    return res.status(500).json({ ok: false });
  }
});



module.exports = router;
