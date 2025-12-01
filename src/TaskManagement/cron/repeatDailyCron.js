const sql = require('mssql');
const cron = require('node-cron');
const { poolPromise } = require('../../db'); // tuỳ file của anh

// chạy mỗi ngày lúc 00:05
cron.schedule('05 00 * * *', async () => {
  console.log('[CRON] Generate daily recurring tasks...');
  try {
    const pool = await poolPromise;
    await pool.request().execute('dbo.cv_Tasks_GenerateDailyRecurring');
    console.log('[CRON] Done cv_Tasks_GenerateDailyRecurring');
  } catch (err) {
    console.error('[CRON] Error cv_Tasks_GenerateDailyRecurring:', err);
  }
});
