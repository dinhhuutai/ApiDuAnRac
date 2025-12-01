// src/jobs/lunchToday11h25Job.js
const cron = require('node-cron');
const sql = require('mssql');
const { poolPromise } = require('../db');
const webpush = require('web-push');

// NOTE: đảm bảo ở bootstrap (index.js/app.js) đã set VAPID:
// webpush.setVapidDetails('mailto:you@domain', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

// ───────────────────────────────────────────────────────────────────────────────
// Utils nhỏ: format YYYYMMDD theo giờ VN
async function getTodayVNYYYYMMDD(pool) {
  const rs = await pool.request().query(`
    DECLARE @now_vn DATETIMEOFFSET = SYSDATETIMEOFFSET() AT TIME ZONE 'SE Asia Standard Time';
    SELECT CONVERT(varchar(8), CONVERT(date, @now_vn), 112) AS yyyymmdd;
  `);
  return rs.recordset?.[0]?.yyyymmdd;
}

// Lấy danh sách (1 dòng / user) đã đặt cho NGÀY HÔM NAY (theo giờ VN)
// - Dồn 1 dòng / user bằng GROUP BY để tránh trùng (do join/ghi nhiều lần)
// - Lọc module 'datcom' bằng EXISTS để tránh nhân bản
async function fetchTodaysSelectionsVN() {
  const pool = await poolPromise;

  const rs = await pool.request().query(`
    SET DATEFIRST 1; -- Thứ 2 = 1
    DECLARE @now_vn  DATETIMEOFFSET = SYSDATETIMEOFFSET() AT TIME ZONE 'Se Asia Standard Time';
    DECLARE @today   DATE = CONVERT(date, @now_vn);
    DECLARE @dow     INT  = DATEPART(WEEKDAY, @today); -- 1..7 (Th2..CN)
    DECLARE @wstart  DATE = DATEADD(DAY, 1 - DATEPART(WEEKDAY, @today), @today); -- Monday

    ;WITH base AS (
      SELECT
        u.userID,
        u.fullName,
        f.foodName,
        f.imageUrl
      FROM dbo.dc_UserWeeklySelections uws
      JOIN dbo.dc_WeeklyMenuEntries e
        ON e.weeklyMenuEntryId = uws.weeklyMenuEntryId
       AND uws.isAction = 1
      JOIN dbo.dc_WeeklyMenus wm
        ON wm.weeklyMenuId = e.weeklyMenuId
      JOIN dbo.dc_Foods f
        ON f.foodId = e.foodId
      JOIN dbo.Users u
        ON u.userID = uws.userID
       AND uws.isAction = 1
      WHERE wm.weekStartMonday = @wstart
        AND e.dayOfWeek = @dow
        AND e.statusType = 're'
        AND EXISTS (
          SELECT 1
          FROM dbo.UserModules um
          JOIN dbo.Modules m
            ON m.moduleId = um.moduleId
          WHERE um.userId = u.userID
            AND m.moduleKey = 'datcom'
        )
    )
    SELECT
      userID,
      MAX(fullName) AS fullName,
      MAX(foodName) AS foodName,
      MAX(imageUrl) AS imageUrl
    FROM base
    GROUP BY userID
  `);

  return rs.recordset || [];
}

// Lấy subscriptions cho 1 user (DISTINCT để tránh trùng)
async function fetchUserSubs(userID) {
  const pool = await poolPromise;
  const rs = await pool.request()
    .input('uid', sql.Int, userID)
    .query(`
      SELECT DISTINCT endpoint, p256dh, auth
      FROM dbo.push_subscriptions
      WHERE userID = @uid
    `);
  return rs.recordset || [];
}

// Gửi push 1 user (tới tất cả thiết bị user đó)
async function sendPushToOneUser(userID, payload) {
  const subs = await fetchUserSubs(userID);
  if (!subs.length) return { sent: 0, total: 0, failed: 0 };

  const body = JSON.stringify(payload);

  const results = await Promise.allSettled(
    subs.map(row =>
      webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { TTL: 3600 }
      )
    )
  );

  // dọn endpoint hỏng
  let sent = 0, failed = 0;
  const pool = await poolPromise;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') { sent++; continue; }
    failed++;
    const status = r.reason?.statusCode || r.reason?.status || 0;
    if (status === 404 || status === 410) {
      const badEndpoint = subs[i]?.endpoint;
      if (badEndpoint) {
        await pool.request()
          .input('ep', sql.NVarChar(500), badEndpoint)
          .query('DELETE FROM dbo.push_subscriptions WHERE endpoint = @ep');
      }
    }
  }
  return { sent, total: results.length, failed };
}

// Job: Gửi 11:25 hằng ngày theo giờ VN
async function runLunchTodayAt1125() {
  const pool = await poolPromise;

  // ── Applock theo NGÀY để đảm bảo mỗi ngày chỉ chạy 1 lần ──
  const todayKey = await getTodayVNYYYYMMDD(pool); // vd: 20250110
  const lockRes = await pool.request()
    .input('res', sql.NVarChar(200), `lunch-today-1125-${todayKey}`)
    .query(`
      DECLARE @r INT;
      EXEC @r = sp_getapplock
        @Resource   = @res,
        @LockMode   = 'Exclusive',
        @LockOwner  = 'Session',
        @LockTimeout= 0;
      SELECT result = @r;
    `);
  const gotLock = (lockRes.recordset?.[0]?.result >= 0);
  if (!gotLock) {
    console.log('[cron][11:25] skip: already processed today');
    return;
  }

  try {
    const rows = await fetchTodaysSelectionsVN();
    console.log('[cron] rows today =', rows.length);
    if (!rows.length) return;

    for (const row of rows) {
      const { userID, foodName } = row;

      const payload = {
        title: 'Bữa trưa hôm nay',
        body: `Hôm nay bạn ăn: ${foodName}. Chúc ngon miệng!`,
        url: 'https://noibo.thuanhunglongan.com/lunch-order/me',
        tag: 'lunch-today',   // tránh nhân bản
        renotify: false
      };

      await sendPushToOneUser(userID, payload);
    }
    console.log(`[cron][11:25] sent ${rows.length} personalized lunch notifications`);
  } catch (e) {
    console.error('[cron][11:25] error', e);
  } finally {
    // Nhả lock
    await pool.request()
      .input('res', sql.NVarChar(200), `lunch-today-1125-${await getTodayVNYYYYMMDD(pool)}`)
      .query(`
        EXEC sp_releaseapplock
          @Resource  = @res,
          @LockOwner = 'Session';
      `);
  }
}

// ── Đăng ký lịch cron: 11:25 mỗi ngày (Asia/Ho_Chi_Minh)
//   CHỐT: tránh đăng ký trùng do hot reload/import nhiều lần
if (!global.__lunchToday11h25Scheduled) {
  cron.schedule('0 25 11 * * *', () => {
    console.log('[cron] lunchToday11h25Job started: 11:25 daily (Asia/Ho_Chi_Minh)');
    runLunchTodayAt1125();
  }, { timezone: 'Asia/Ho_Chi_Minh' });
  global.__lunchToday11h25Scheduled = true;
}

module.exports = { runLunchTodayAt1125 };
