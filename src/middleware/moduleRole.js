// middleware/moduleRole.js
// Kiểm tra quyền theo module ở SERVER (trước đây chỉ frontend chặn bằng RequireModule).
// Dùng sau requireAuth: router.get('/x', requireAuth, requireModuleRole(9, ['admin']), handler)
// moduleId có thể là mảng: requireModuleRole([9, 18], ['admin']) = admin của module 9 HOẶC 18
// (vai trò cao nhất trong các module được tính).
//
// Kết quả được nhớ 20 giây cho mỗi (user, danh sách module) — mỗi request API không phải
// hỏi lại UserModules (server yếu). Đổi quyền trên trang Phân quyền có hiệu lực sau ≤ 20 giây.
const { sql, poolPromise } = require('../db');

const CACHE_MS = 20000;
const cache = new Map(); // `${uid}|${ids}` → { role, at }

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_MS) { cache.delete(key); return undefined; }
  return hit.role;
}
function writeCache(key, role) {
  if (cache.size > 5000) cache.clear(); // không để phình bộ nhớ
  cache.set(key, { role, at: Date.now() });
}

const requireModuleRole = (moduleId, roles = ['admin']) => {
  const ids = (Array.isArray(moduleId) ? moduleId : [moduleId]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error('requireModuleRole: moduleId không hợp lệ');
  const idList = ids.join(','); // chỉ số nguyên → ghép chuỗi an toàn

  return async (req, res, next) => {
    try {
      const userId = req.user?.userID;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const key = `${userId}|${idList}`;
      let role = readCache(key);
      if (role === undefined) {
        const pool = await poolPromise;
        const r = await pool.request()
          .input('uid', sql.Int, userId)
          .query(`SELECT role FROM dbo.UserModules WHERE userId = @uid AND moduleId IN (${idList})`);
        const all = r.recordset.map((x) => String(x.role || '').toLowerCase());
        role = all.includes('admin') ? 'admin' : all.includes('user') ? 'user' : all[0] || '';
        writeCache(key, role);
      }

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
};

module.exports = { requireModuleRole };
