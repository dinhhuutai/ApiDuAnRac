// middleware/moduleRole.js
// Kiểm tra quyền theo module ở SERVER (trước đây chỉ frontend chặn bằng RequireModule).
// Dùng sau requireAuth: router.get('/x', requireAuth, requireModuleRole(9, ['admin']), handler)
const { sql, poolPromise } = require('../db');

const requireModuleRole = (moduleId, roles = ['admin']) => async (req, res, next) => {
  try {
    const userId = req.user?.userID;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const pool = await poolPromise;
    const r = await pool.request()
      .input('uid', sql.Int, userId)
      .input('mid', sql.Int, moduleId)
      .query(`SELECT TOP 1 role FROM dbo.UserModules WHERE userId = @uid AND moduleId = @mid`);

    const role = String(r.recordset[0]?.role || '').toLowerCase();
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền sử dụng chức năng này' });
    }
    req.moduleRole = role;
    next();
  } catch (err) {
    console.error('❌ requireModuleRole error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi kiểm tra quyền' });
  }
};

module.exports = { requireModuleRole };
