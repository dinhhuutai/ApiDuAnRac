// src/jobs/lunchReminderJob.js
const cron = require('node-cron');
const sql = require('mssql');
const { poolPromise } = require('../db');
const { getLatestUnlockedMenu, getUsersNotOrderedForMenu } = require('../utils/lunchOrder');
const { sendPushToUsers } = require('../WebPush/pushService');

/**
 * Trả về danh sách userID trong mảng đầu vào có quyền moduleKey (vd: 'datcom').
 * Schema dùng:
 *  - dbo.Modules(moduleId, moduleKey, ...)
 *  - dbo.UserModules(userId, moduleId, role)
 */
async function filterUsersByModule(pool, userIDs, moduleKey = 'datcom') {
  if (!Array.isArray(userIDs) || userIDs.length === 0) return [];

  // Ghép CSV an toàn: tất cả đều là số nguyên
  const idsCsv = userIDs.join(',');

  const rs = await pool.request()
    .input('csv', sql.NVarChar(sql.MAX), idsCsv)
    .input('moduleKey', sql.NVarChar(100), moduleKey)
    .query(`
      ;WITH ids AS (
        SELECT TRY_CAST(value AS INT) AS userID
        FROM STRING_SPLIT(@csv, ',')
        WHERE TRY_CAST(value AS INT) IS NOT NULL
      )
      SELECT DISTINCT i.userID
      FROM ids i
      JOIN dbo.UserModules um
        ON um.userId = i.userID
      JOIN dbo.Modules mo
        ON mo.moduleId = um.moduleId
      WHERE mo.moduleKey = @moduleKey
    `);

  return (rs.recordset || []).map(r => r.userID);
}

/**
 * Job: gửi nhắc đặt cơm cho những user có module 'datcom' nhưng chưa đặt
 * cho weekly menu mới nhất (và menu đó đang mở - isLocked = 0).
 */
async function lunchReminderJob(label = '') {
  const pool = await poolPromise;

  // 1) Lấy weekly menu mới nhất đang mở (isLocked = 0)
  const latest = await getLatestUnlockedMenu();
  if (!latest) {
    console.log('[remind] skip: no unlocked weekly menu');
    return;
  }
  const { weeklyMenuId } = latest;

  // 2) Khóa để tránh chạy trùng giữa nhiều instance (LockOwner = Session)
  const lockRes = await pool.request()
    .input('res', sql.NVarChar(100), `lunch-reminder-${weeklyMenuId}`)
    .query(`
      DECLARE @r INT;
      EXEC @r = sp_getapplock
        @Resource   = @res,
        @LockMode   = 'Exclusive',
        @LockOwner  = 'Session',     -- quan trọng: không cần transaction
        @LockTimeout= 0;
      SELECT result = @r;
    `);

  const gotLock = (lockRes.recordset?.[0]?.result >= 0);
  if (!gotLock) {
    console.log('[remind] skip: cannot acquire applock');
    return;
  }

  try {
    // 3) Lấy danh sách user chưa đặt cho menu này
    const unorderedUserIDs = await getUsersNotOrderedForMenu(weeklyMenuId);
    if (!unorderedUserIDs.length) {
      console.log('[remind] nobody to remind (no unordered users)');
      return;
    }

    // 4) Lọc theo module 'datcom'
    const targetUserIDs = await filterUsersByModule(pool, unorderedUserIDs, 'datcom');
    if (!targetUserIDs.length) {
      console.log('[remind] nobody to remind (no users with module=datcom)');
      return;
    }

    // 5) Gửi push
    const payload = {
      title: 'Nhắc đặt cơm',
      body: 'Đã có thực đơn tuần mới. Vui lòng đặt cơm.',
      url: 'https://noibo.thuanhunglongan.com/lunch-order/me',
      ttl: 3600,
      tag: 'lunch-weekly-menu',
      renotify: false,
    };

    await sendPushToUsers(payload, targetUserIDs);
    console.log(`[remind][${label}] sent ${targetUserIDs.length} notifications (weeklyMenuId=${weeklyMenuId})`);
  } catch (e) {
    console.error('[remind] error', e);
  } finally {
    // 6) Nhả khóa (phải dùng cùng LockOwner = 'Session')
    await pool.request()
      .input('res', sql.NVarChar(100), `lunch-reminder-${weeklyMenuId}`)
      .query(`
        EXEC sp_releaseapplock
          @Resource  = @res,
          @LockOwner = 'Session';
      `);
  }
}

/* ================== LỊCH CHẠY CỐ ĐỊNH ==================
 * node-cron (có seconds): "sec min hour dayOfMonth month dayOfWeek"
 * - 16:30 Thứ 6 (Asia/Ho_Chi_Minh): '0 30 16 * * 5'
 * - 07:30 Thứ 7 (Asia/Ho_Chi_Minh): '0 30 7  * * 6'
 * ====================================================== */

// 16:30 chiều Thứ 6
cron.schedule('0 30 16 * * 5', () => {
  console.log('[cron] lunchReminderJob Fri 16:30 (Asia/Ho_Chi_Minh)');
  lunchReminderJob('Fri-16:30').catch(e => console.error('cron remind error', e));
}, { timezone: 'Asia/Ho_Chi_Minh' });

// 07:30 sáng Thứ 7
cron.schedule('0 30 7 * * 6', () => {
  console.log('[cron] lunchReminderJob Sat 07:30 (Asia/Ho_Chi_Minh)');
  lunchReminderJob('Sat-07:30').catch(e => console.error('cron remind error', e));
}, { timezone: 'Asia/Ho_Chi_Minh' });

module.exports = { lunchReminderJob };
