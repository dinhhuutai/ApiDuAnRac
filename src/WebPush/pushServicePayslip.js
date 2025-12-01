// src/utils/payslipNotify.js
const sql = require('mssql');
const { poolPromise } = require('../db');
const webpush = require('web-push');

// Lấy userID có moduleKey (Modules, UserModules)
async function getUsersByModuleKey(moduleKey = 'tinhluong') {
  const pool = await poolPromise;
  const rs = await pool.request()
    .input('mkey', sql.NVarChar(100), moduleKey)
    .query(`
      SELECT DISTINCT um.userId AS userID
      FROM dbo.UserModules um
      JOIN dbo.Modules m ON m.moduleId = um.moduleId
      WHERE m.moduleKey = @mkey
    `);
  return rs.recordset.map(r => r.userID);
}

async function getSubsByUserIDs(userIDs = []) {
  if (!userIDs.length) return [];
  const pool = await poolPromise;
  const idsCsv = userIDs.join(',');

  const rs = await pool.request()
    .input('csv', sql.NVarChar(sql.MAX), idsCsv)
    .query(`
      ;WITH ids AS (
        SELECT TRY_CAST(value AS INT) AS userID
        FROM STRING_SPLIT(@csv, ',')
        WHERE TRY_CAST(value AS INT) IS NOT NULL
      )
      SELECT s.userID, s.endpoint, s.p256dh, s.auth
      FROM ids i
      JOIN dbo.push_subscriptions s ON s.userID = i.userID
    `);

  return rs.recordset || [];
}

async function sendPushToMany(payload, userIDs) {
  const subs = await getSubsByUserIDs(userIDs);
  if (!subs.length) return { total: 0, sent: 0 };

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((row) =>
      webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { TTL: payload.ttl ?? 3600 }
      )
    )
  );

  // dọn endpoint hỏng
  let sent = 0;
  const pool = await poolPromise;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') { sent++; continue; }
    const status = r.reason?.statusCode || r.reason?.status || 0;
    if (status === 404 || status === 410) {
      const badEndpoint = subs[i]?.endpoint;
      if (badEndpoint) {
        await pool.request().input('ep', sql.NVarChar(500), badEndpoint)
          .query('DELETE FROM dbo.push_subscriptions WHERE endpoint=@ep');
      }
    }
  }
  return { total: results.length, sent };
}

/** Notify sau khi import xong */
async function notifyPayslipPublished(periodTitle = 'Phiếu lương mới') {
  const userIDs = await getUsersByModuleKey('tinhluong');
  if (!userIDs.length) return { total: 0, sent: 0 };

  const payload = {
    title: 'Đã có bảng lương',
    body: `${periodTitle}: Bấm để xem chi tiết phiếu lương của bạn.`,
    url: 'https://noibo.thuanhunglongan.com/me/view-payslip', // đổi đúng route FE
    tag: 'payroll-latest',
    renotify: false,
    ttl: 3600
  };
  return await sendPushToMany(payload, userIDs);
}

module.exports = { notifyPayslipPublished };
