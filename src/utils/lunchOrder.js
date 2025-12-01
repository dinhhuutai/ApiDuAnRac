// src/services/menuQueries.js
const sql = require('mssql');
const { poolPromise } = require('../db');

async function getLatestUnlockedMenu() {
  const pool = await poolPromise;
  const rs = await pool.request().query(`
    SELECT *
FROM (
  SELECT TOP 1 weeklyMenuId, weekStartMonday, isLocked, lastRemindedAt
  FROM dbo.dc_WeeklyMenus
  ORDER BY weekStartMonday DESC, weeklyMenuId DESC
) x
WHERE x.isLocked = 0;
  `);
  return rs.recordset[0] || null;
}

async function getUsersNotOrderedForMenu(weeklyMenuId) {
  const pool = await poolPromise;
  const rs = await pool.request()
    .input('wmid', sql.Int, weeklyMenuId)
    .query(`
      WITH lunch_users AS (
        SELECT DISTINCT um.userId
        FROM dbo.UserModules um
        JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE m.moduleKey = 'datcom'
      ),
      menu_entries AS (
        SELECT weeklyMenuEntryId
        FROM dbo.dc_WeeklyMenuEntries
        WHERE weeklyMenuId = @wmid
      ),
      ordered_users AS (
        SELECT DISTINCT uws.userID
        FROM dbo.dc_UserWeeklySelections uws
        WHERE uws.weeklyMenuEntryId IN (SELECT weeklyMenuEntryId FROM menu_entries) AND uws.isAction = 1
      )
      SELECT lu.userId
      FROM lunch_users lu
      LEFT JOIN ordered_users ou ON ou.userID = lu.userId
      WHERE ou.userID IS NULL
    `);
  return rs.recordset.map(r => r.userId);
}

module.exports = { getLatestUnlockedMenu, getUsersNotOrderedForMenu };
