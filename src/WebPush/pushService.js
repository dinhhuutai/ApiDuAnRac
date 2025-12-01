const webpush = require('web-push');
const sql = require('mssql');
const { poolPromise } = require('../db'); // chỉnh path cho đúng

/**
 * Gửi push tới các subscription trong DB thỏa userIDs (hoặc tất cả nếu null)
 * @param {Object} payload {title, body, url, icon?, badge?, ttl?}
 * @param {number[]|null} userIDs - danh sách userID; null = tất cả lunch users
 * @returns { sent, failed, total }
 */
async function sendPushToUsers(payload, userIDs = null) {
  const pool = await poolPromise;

  // Lấy subscription của toàn bộ user có module 'datcom' (đặt cơm),
  // nếu có userIDs thì lọc theo.
  let query = `
    SELECT s.endpoint, s.p256dh, s.auth
    FROM dbo.push_subscriptions s
    JOIN dbo.UserModules um ON um.userId = s.userID
    JOIN dbo.Modules m ON m.moduleId = um.moduleId
    WHERE m.moduleKey = 'datcom'
  `;
  if (userIDs && userIDs.length) {
    query += ` AND s.userID IN (${userIDs.map(id => Number(id)).filter(n => Number.isInteger(n)).join(',') || 'NULL'})`;
  }

  const rs = await pool.request().query(query);
  const subs = rs.recordset || [];
  if (!subs.length) return { sent: 0, failed: 0, total: 0 };

  const body = JSON.stringify({
    title: payload.title || 'THLA',
    body: payload.body || '',
    url: payload.url || 'https://noibo.thuanhunglongan.com/lunch-order/me',
    icon: payload.icon,   // có thể undefined -> SW dùng mặc định
    badge: payload.badge,
    tag: 'lunch-weekly-menu',  // gom/thay thế thông báo cũ
    renotify: false,
  });

  const results = await Promise.allSettled(
    subs.map(row => webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      body,
      { TTL: Number.isInteger(payload.ttl) ? payload.ttl : 3600 }
    ))
  );

  // dọn endpoint hỏng
  let sent = 0, failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') { sent++; continue; }
    failed++;
    const reason = r.reason || {};
    const status = reason.statusCode || reason.status || 0;
    if (status === 404 || status === 410) {
      const badEndpoint = subs[i]?.endpoint;
      if (badEndpoint) {
        await pool.request()
          .input('ep', sql.NVarChar(500), badEndpoint)
          .query('DELETE FROM dbo.push_subscriptions WHERE endpoint = @ep');
      }
    }
  }

  return { sent, failed, total: results.length };
}

module.exports = { sendPushToUsers };
