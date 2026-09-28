// config/modules.js — Module đã TẮT (không dùng nữa, 2026-09-28).
// Module bị tắt: không nạp route/cron ở server, không trả về trong danh sách module / quyền
// (trang chủ, login, /api/me/permissions, trang quản trị) → người dùng không thấy, không vào được.
// Dữ liệu trong DB giữ nguyên. Bật lại: bỏ id khỏi danh sách hoặc đặt biến môi trường
//   DISABLED_MODULES=none        (bật tất cả)
//   DISABLED_MODULES=2,3,17      (chỉ tắt các id này)
// Id khớp bảng dbo.Modules và dashboardDuanRac/src/contants/modules.js.
const DEFAULT_DISABLED = [
  2,  // canmuc — Quản lý cân mực
  3,  // qlcongviec — Quản lý công việc (kèm cron tạo task lặp 00:05)
  8,  // sanxuat — Quản lý sản xuất
  10, // xephoivai — Xe phơi vải
  11, // bmi — Sức khoẻ với AI
  13, // quality-inspection-oqc — OQC
  14, // quality-inspection-kcs — KCS
  15, // consolidate — Gom hàng
  16, // mes — MES
  17, // capmoney — Quản lý chi tiêu
];

function parseEnv(v) {
  if (v === undefined || v === null || String(v).trim() === '') return DEFAULT_DISABLED;
  if (String(v).trim().toLowerCase() === 'none') return [];
  return String(v).split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

const DISABLED_MODULE_IDS = Object.freeze(parseEnv(process.env.DISABLED_MODULES));

const isModuleEnabled = (id) => !DISABLED_MODULE_IDS.includes(id);

/** Điều kiện SQL loại module đã tắt, vd. `AND m.moduleId NOT IN (2,3)`. Chỉ chứa số nguyên → an toàn khi ghép chuỗi. */
const sqlExcludeDisabled = (col) =>
  DISABLED_MODULE_IDS.length ? ` AND ${col} NOT IN (${DISABLED_MODULE_IDS.join(',')}) ` : '';

module.exports = { DISABLED_MODULE_IDS, isModuleEnabled, sqlExcludeDisabled };
