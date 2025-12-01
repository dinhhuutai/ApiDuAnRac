// src/jobs/lunchFeedback1130Job.js
const cron = require('node-cron');
const sql = require('mssql');
const { poolPromise } = require('../db');      // chỉnh path theo dự án của bạn
const webpush = require('web-push');

// YÊU CẦU: webpush.setVapidDetails(...) đã được gọi ở bootstrap server (index.js/app.js)

/**
 * Lấy danh sách người ĐÃ ĐẶT món CHO HÔM NAY theo giờ VN.
 * Trả về mỗi user 1 dòng: userID, fullName, foodName, imageUrl, weeklyMenuEntryId, foodId
 * (chỉ user thuộc module 'datcom')
 * (DISTINCT để tránh trùng)
 */
async function fetchTodaysOrderedUsersVN() {
  const pool = await poolPromise;
  const rs = await pool.request().query(`
    SET DATEFIRST 1; -- Thứ 2 = 1
    DECLARE @now_vn  DATETIMEOFFSET = SYSDATETIMEOFFSET() AT TIME ZONE 'Se Asia Standard Time';
    DECLARE @today   DATE = CONVERT(date, @now_vn);
    DECLARE @dow     INT  = DATEPART(WEEKDAY, @today); -- 1..7 (Th2..CN)
    DECLARE @wstart  DATE = DATEADD(DAY, 1 - DATEPART(WEEKDAY, @today), @today); -- Monday

    SELECT DISTINCT
      u.userID,
      u.fullName,
      f.foodName,
      f.imageUrl,
      e.weeklyMenuEntryId,
      f.foodId
    FROM dbo.dc_UserWeeklySelections uws
    JOIN dbo.dc_WeeklyMenuEntries e ON e.weeklyMenuEntryId = uws.weeklyMenuEntryId AND uws.isAction = 1
    JOIN dbo.dc_WeeklyMenus wm      ON wm.weeklyMenuId = e.weeklyMenuId
    JOIN dbo.dc_Foods f            ON f.foodId = e.foodId
    JOIN dbo.Users u               ON u.userID = uws.userID AND uws.isAction = 1
    JOIN dbo.UserModules um        ON um.userId = u.userID
    JOIN dbo.Modules m             ON m.moduleId = um.moduleId AND m.moduleKey = 'datcom'
    WHERE wm.weekStartMonday = @wstart
      AND e.dayOfWeek = @dow
      AND e.statusType = 're'
  `);
  return rs.recordset || [];
}

/**
 * (TUỲ CHỌN) Loại user đã đánh giá rồi.
 * Nếu bạn CHƯA có bảng lưu đánh giá thì return nguyên rows.
 * Nếu đã có, ví dụ bảng dbo.dc_FoodRatings(userID, ratingDate, weeklyMenuEntryId, ...),
 * bật đoạn SQL filter bên dưới.
 */
async function filterOutAlreadyRated(rows) {
  // CHƯA có bảng rating → không lọc
  return rows;

  // NẾU ĐÃ CÓ BẢNG RATING, dùng mẫu này:
  /*
  if (!rows.length) return rows;
  const pool = await poolPromise;

  // gom id cần check
  const pairs = rows.map(r => `(${r.userID}, ${r.weeklyMenuEntryId})`).join(',');
  const rs = await pool.request().query(`
    SET DATEFIRST 1;
    DECLARE @now_vn  DATETIMEOFFSET = SYSDATETIMEOFFSET() AT TIME ZONE 'Se Asia Standard Time';
    DECLARE @today   DATE = CONVERT(date, @now_vn);

    SELECT userID, weeklyMenuEntryId
    FROM dbo.dc_FoodRatings
    WHERE ratingDate = @today
      AND (userID, weeklyMenuEntryId) IN (${pairs})
  `);

  const rated = new Set(rs.recordset.map(x => `${x.userID}-${x.weeklyMenuEntryId}`));
  return rows.filter(r => !rated.has(`${r.userID}-${r.weeklyMenuEntryId}`));
  */
}

/** Lấy tất cả subscription của 1 user */
async function fetchUserSubs(userID) {
  const pool = await poolPromise;
  const rs = await pool.request()
    .input('uid', sql.Int, userID)
    .query(`
      SELECT endpoint, p256dh, auth
      FROM dbo.push_subscriptions
      WHERE userID = @uid
    `);
  return rs.recordset || [];
}

/** Gửi push cho 1 user */
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

// server-side: buildFeedbackUrl (gắn tên + tên món, encode an toàn)
function buildFeedbackUrl({ weeklyMenuEntryId, foodId, fullName, foodName }) {
  const base = 'https://noibo.thuanhunglongan.com/feedback-lunch';
  // NOTE: dùng encodeURIComponent cho từng giá trị; URLSearchParams sẽ encode lần nữa => an toàn với tiếng Việt
  const params = new URLSearchParams({
    eid: String(weeklyMenuEntryId || ''),
    fid: String(foodId || ''),
    name: fullName ? encodeURIComponent(String(fullName)) : '',
    food: foodName ? encodeURIComponent(String(foodName)) : ''
  });
  return `${base}?${params.toString()}`;
}

/** Job chính: 11:30 hằng ngày — gửi link đánh giá cho user đã đặt hôm nay */
async function runLunchFeedbackAt1130() {
  try {
    const rowsRaw = await fetchTodaysOrderedUsersVN();
    const rows = await filterOutAlreadyRated(rowsRaw); // hiện tại chưa lọc → rowsRaw

    console.log('[cron][11:30] users ordered today =', rows.length);
    if (!rows.length) return;

    for (const row of rows) {
      // build URL có kèm tên & tên món

      const url = buildFeedbackUrl({
        weeklyMenuEntryId: row.weeklyMenuEntryId,
        foodId: row.foodId,
        fullName: row.fullName,
        foodName: row.foodName
      });

      // payload: đảm bảo trường url có trong body (SW sẽ đọc event.data.json())
      const payload = {
        title: 'Đánh giá bữa trưa hôm nay',
        body: `Bạn thấy món “${row.foodName}” hôm nay thế nào? Nhấn để đánh giá nhanh.`,
        url,               // rất quan trọng
        tag: 'lunch-feedback',
        renotify: true
      };

      await sendPushToOneUser(row.userID, payload);
    }

    console.log(`[cron][11:30] sent ${rows.length} feedback notifications`);
  } catch (e) {
    console.error('[cron][11:30] error', e);
  }
}

// ── Lịch: 11:30 hằng ngày (giờ VN)
cron.schedule('0 50 11 * * *', () => {
  console.log('[cron] feedback 11:50 fired at', new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }));
  runLunchFeedbackAt1130();
}, { timezone: 'Asia/Ho_Chi_Minh' });

console.log('[cron] lunchFeedback1130Job started: 11:30 daily (Asia/Ho_Chi_Minh)');

module.exports = { runLunchFeedbackAt1130 };
