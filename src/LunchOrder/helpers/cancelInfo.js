// helpers/cancelInfo.js
const { sql, poolPromise } = require('../../db');

async function getCancelInfo({ userId, weeklyMenuId, weeklyMenuEntryId }) {
  const pool = await poolPromise;
  const rs = await pool.request()
    .input('uid', sql.Int, userId)
    .input('wmid', sql.Int, weeklyMenuId)
    .input('weid', sql.Int, weeklyMenuEntryId)
    .query(`
      SELECT TOP 1
        u.fullName,
        wm.weekStartMonday,
        e.dayOfWeek,
        e.statusType,
        f.foodName,
        fb.branchName
      FROM dbo.dc_WeeklyMenuEntries e
      JOIN dbo.dc_WeeklyMenus wm ON wm.weeklyMenuId = e.weeklyMenuId
      JOIN dbo.dc_Foods f ON f.foodId = e.foodId
      LEFT JOIN dbo.dc_FoodBranches fb ON fb.branchId = (
        SELECT TOP 1 branchId
        FROM dbo.dc_UserWeeklySelections s
        WHERE s.userID = @uid AND s.weeklyMenuEntryId = e.weeklyMenuEntryId
        ORDER BY s.updatedAt DESC
      )
      JOIN dbo.Users u ON u.userID = @uid
      WHERE e.weeklyMenuEntryId = @weid
        AND e.weeklyMenuId = @wmid
    `);

  return rs.recordset?.[0] || null;
}

module.exports = { getCancelInfo };
