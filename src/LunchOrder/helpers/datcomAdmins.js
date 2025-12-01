// helpers/datcomAdmins.js
const { sql, poolPromise } = require('../../db');

async function getDatcomAdminUserIDs(excludeUserId = null) {
  const pool = await poolPromise;

  // Mặc định: admin theo Users.role
  const rs = await pool.request()
    .input('exclude', sql.Int, excludeUserId ?? null)
    .query(`
      SELECT DISTINCT u.userID
      FROM dbo.Users u
      JOIN dbo.UserModules um ON um.userId = u.userID
      JOIN dbo.Modules m ON m.moduleId = um.moduleId
      WHERE m.moduleKey = 'datcom'
        AND ISNULL(u.isActive,1) = 1
        AND u.role = 'admin'
        AND (@exclude IS NULL OR u.userID <> @exclude)
    `);

  return rs.recordset.map(r => r.userID);
}

/*
 * Nếu admin nằm ở UserModules:
 *   AND (um.role = 'admin' OR ISNULL(um.isAdmin,0) = 1)
 * hoặc nếu bạn có bảng/quan hệ khác — chỉ cần thay WHERE là xong.
 */

module.exports = { getDatcomAdminUserIDs };
