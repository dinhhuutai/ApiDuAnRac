// RequestManagement/notify.js — thông báo trong ứng dụng (rq_Notifications) + Web Push
// Web Push dùng chung bảng push_subscriptions (nhân viên bật thông báo ở bất kỳ module nào đều nhận được).
// VAPID đã đặt ở src/index.js (webpush.setVapidDetails). Gửi push KHÔNG chặn response: lỗi chỉ ghi log.
const webpush = require('web-push');
const { sql, poolPromise } = require('../db');

const pushReady = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
let vapidSet = false;
function ensureVapid() {
  if (vapidSet || !pushReady()) return pushReady();
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    vapidSet = true;
  } catch (e) {
    console.error('❌ [rq] VAPID:', e.message);
  }
  return vapidSet;
}

const uniqIds = (arr, exclude) =>
  [...new Set((arr || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== exclude))];

/** Gửi Web Push tới mọi thiết bị đã đăng ký của các user. Không ném lỗi. */
async function pushToUsers(userIds, payload) {
  const list = uniqIds(userIds);
  if (!list.length || !ensureVapid()) return;
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('ids', sql.NVarChar(sql.MAX), JSON.stringify(list)).query(`
      SELECT endpoint, p256dh, auth FROM dbo.push_subscriptions
      WHERE userID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))`);
    const body = JSON.stringify({
      title: payload.title || 'Quản lý yêu cầu',
      body: payload.body || '',
      url: payload.url || '/request',
      tag: payload.tag || 'rq',
      renotify: true,
    });
    const results = await Promise.allSettled(r.recordset.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 24 * 3600 })));
    const dead = results
      .map((x, i) => (x.status === 'rejected' && [404, 410].includes(x.reason?.statusCode) ? r.recordset[i].endpoint : null))
      .filter(Boolean);
    for (const ep of dead) {
      await pool.request().input('ep', sql.NVarChar(500), ep).query('DELETE FROM dbo.push_subscriptions WHERE endpoint = @ep');
    }
  } catch (e) {
    console.error('❌ [rq] push:', e.message);
  }
}

/**
 * Tạo thông báo cho nhiều người (trừ người thực hiện) + push. Gọi SAU khi đã trả response
 * hoặc không await — lỗi thông báo không được làm hỏng thao tác chính.
 * @param n { userIds, actorId, type, requestId, title, body, url, push=true }
 */
async function notify(n) {
  const list = uniqIds(n.userIds, n.actorId);
  if (!list.length) return;
  const title = String(n.title || '').slice(0, 300);
  const body = n.body ? String(n.body).slice(0, 500) : null;
  const url = n.url || (n.requestId ? `/request?id=${n.requestId}` : '/request');
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(list))
      .input('type', sql.NVarChar(30), n.type)
      .input('rid', sql.Int, n.requestId || null)
      .input('actor', sql.Int, n.actorId || null)
      .input('title', sql.NVarChar(300), title)
      .input('body', sql.NVarChar(500), body)
      .input('url', sql.NVarChar(300), url)
      .query(`
        INSERT INTO dbo.rq_Notifications (userId, type, requestId, actorId, title, body, url)
        SELECT CAST([value] AS INT), @type, @rid, @actor, @title, @body, @url FROM OPENJSON(@ids)`);
  } catch (e) {
    console.error('❌ [rq] notify:', e.message);
  }
  if (n.push !== false) {
    pushToUsers(list, { title, body: body || '', url, tag: n.requestId ? `rq-${n.requestId}` : `rq-${n.type}` });
  }
}

/** Chạy hàm thông báo nền, không chặn và không ném lỗi */
function later(fn) {
  setImmediate(() => { Promise.resolve().then(fn).catch((e) => console.error('❌ [rq] background:', e.message)); });
}

module.exports = { notify, pushToUsers, later };
