require('dotenv').config();
const webpush = require('web-push');
const { poolPromise, sql } = require("../db");

webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

/* Subscriptions table (tạo nếu chưa có):
CREATE TABLE dbo.PushSubscriptions(
  id INT IDENTITY PRIMARY KEY,
  userId INT NOT NULL,
  endpoint NVARCHAR(500) NOT NULL,
  p256dh NVARCHAR(200) NOT NULL,
  auth NVARCHAR(200) NOT NULL,
  createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
*/


function apiNotiLunchOrder(app) {

    app.post('/api/lunch-order/notify/subscribe', async (req, res) => {
    try {
        const { userId, subscription } = req.body; // {endpoint, keys:{p256dh, auth}}
        await (await poolPromise).request()
        .input('uid', sql.Int, userId)
        .input('endpoint', sql.NVarChar(500), subscription.endpoint)
        .input('p256dh', sql.NVarChar(200), subscription.keys.p256dh)
        .input('auth', sql.NVarChar(200), subscription.keys.auth)
        .query(`IF NOT EXISTS (SELECT 1 FROM dbo.PushSubscriptions WHERE endpoint=@endpoint)
                INSERT dbo.PushSubscriptions(userId, endpoint, p256dh, auth) VALUES (@uid, @endpoint, @p256dh, @auth)`);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ success:false }); }
    });

    app.post('/api/lunch-order/notify/send', async (req, res) => {
    try {
        const { userId, title, body } = req.body;
        const rs = await (await poolPromise).request().input('uid', sql.Int, userId)
        .query(`SELECT endpoint, p256dh, auth FROM dbo.PushSubscriptions WHERE userId=@uid`);
        const payload = JSON.stringify({ title, body });
        await Promise.all(rs.recordset.map(s => webpush.sendNotification({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
        }, payload).catch(()=>null)));
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ success:false }); }
    });

};


module.exports = {
    apiNotiLunchOrder,
}