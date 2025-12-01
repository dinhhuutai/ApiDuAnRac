const webpush =  require('web-push');
const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");

const { requireAuth } = require('../middleware/auth');


function webPushLunchOrder(app) {

    
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

app.get('/api/push/lunch-order/publicKey', (req, res) => {
  res.type('text/plain').send(process.env.VAPID_PUBLIC_KEY);
});

app.post('/api/push/lunch-order/subscribe', requireAuth, async (req, res, next) => {
  try {
    const sub = req.body;
    const userID = Number(req.user.userID ?? 0);

    if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription payload' });
    }
    if (!Number.isInteger(userID) || userID < 0) {
      return res.status(400).json({ error: 'Invalid userID' });
    }

    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const pool = await poolPromise;

    await pool.request()
      .input('userID', sql.Int, userID)
      .input('endpoint', sql.NVarChar(500), sub.endpoint)
      .input('p256dh', sql.NVarChar(200), sub.keys.p256dh)
      .input('auth', sql.NVarChar(100), sub.keys.auth)
      .input('ua', sql.NVarChar(300), ua)
      .query(`
        MERGE dbo.push_subscriptions AS t
        USING (SELECT @userID AS userID, @endpoint AS endpoint) AS s
        ON t.userID = s.userID AND t.endpoint = s.endpoint
        WHEN MATCHED THEN UPDATE
          SET p256dh = @p256dh,
              auth = @auth,
              userAgent = @ua,
              updatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (userID, endpoint, p256dh, auth, userAgent, createdAt)
        VALUES (@userID, @endpoint, @p256dh, @auth, @ua, SYSUTCDATETIME());
      `);

    res.sendStatus(201);
  } catch (e) { next(e); }
});

// POST /api/push/lunch-order/unsubscribe
app.post('/api/push/lunch-order/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

    const pool = await poolPromise;
    await pool.request()
      .input('ep', sql.NVarChar(500), endpoint)
      .query('DELETE FROM dbo.push_subscriptions WHERE endpoint=@ep');

    res.json({ ok: true });
  } catch (e) { 
    console.log(e);
   }
});


// test gửi 1 notification
app.post('/api/push/lunch-order/notify/:userID', async (req, res, next) => {
  try {
    const userID = Number(req.params.userID);
    const { title, body, url, icon, badge, ttl } = req.body || {};

    if (!Number.isInteger(userID) || userID <= 0) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const payload = JSON.stringify({
      title: title || 'THLA',
      body: body || 'Thông báo đặt cơm',
      url: url || '/lunch',
      icon,   // ví dụ '/icons/icon-192.png'
      badge,  // ví dụ '/icons/badge-72.png'
    });

    const pool = await poolPromise;
    const rs = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        SELECT endpoint, p256dh, auth
        FROM dbo.push_subscriptions
        WHERE userID = @userID
      `);

    const subs = rs.recordset || [];
    if (!subs.length) {
      return res.status(404).json({ error: 'No subscription for this user' });
    }

    const results = await Promise.allSettled(
      subs.map(row =>
        webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          { TTL: Number.isInteger(ttl) ? ttl : 3600 }
        )
        .then(() => ({ ok: true, endpoint: row.endpoint }))
        .catch(err => ({
          ok: false,
          endpoint: row.endpoint,
          status: err.statusCode || err.status,
          body: err.body
        }))
      )
    );

    // dọn endpoint hỏng
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok === false) {
        const { status, endpoint } = r.value;
        if (status === 404 || status === 410) {
          await pool.request().input('ep', sql.NVarChar(500), endpoint)
            .query('DELETE FROM dbo.push_subscriptions WHERE endpoint=@ep');
        }
      } else if (r.status === 'rejected') {
        // trường hợp hiếm
        console.error('[PUSH rejected]', r.reason);
      }
    }

    const flat = results.map(r => (r.status === 'fulfilled' ? r.value : { ok: false, error: 'promise rejected' }));
    const sent = flat.filter(x => x.ok).length;
    const failed = flat.length - sent;

    return res.json({ ok: true, total: flat.length, sent, failed, details: flat });
  } catch (e) {
    console.error('[PUSH notify error]', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
});


}

module.exports = {
    webPushLunchOrder,
}
