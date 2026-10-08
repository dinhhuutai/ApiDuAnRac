// utils/orgProfile.js — hồ sơ phòng ban / tổ / chức danh hiệu lực (bảng org_*, sql/06 + sql/09).
// Dùng chung cho module 9 (Biểu mẫu) và 18 (Quản lý yêu cầu).
//
// Hồ sơ hiệu lực: org_UserProfiles, nếu user chưa có hồ sơ thì lấy org_PendingProfiles theo MSNV
// (người được gán trước khi có tài khoản). Ghi luôn vào org_UserProfiles.
// KHÔNG join view dbo.org_vUserProfiles trong truy vấn danh sách: SQL Server chọn kế hoạch rất tệ
// (danh sách nhân viên 25 giây, đo 2026-09-25) — OUTER APPLY dưới đây cùng kết quả, ~0,2 giây.

/** OUTER APPLY → alias p (departmentId, teamId, jobTitleId, source, fromMsnv) cho user alias `u` (có userID, msnv) */
const profileApply = (u, p = 'p') => `
    OUTER APPLY (
      SELECT TOP 1 x.departmentId, x.teamId, x.jobTitleId, x.source, x.fromMsnv FROM (
        SELECT up.departmentId, up.teamId, up.jobTitleId, up.source, CAST(0 AS BIT) AS fromMsnv, 0 AS pri
        FROM dbo.org_UserProfiles up WHERE up.userId = ${u}.userID
        UNION ALL
        SELECT e.departmentId, e.teamId, e.jobTitleId, N'admin', CAST(1 AS BIT), 1
        FROM dbo.org_PendingProfiles e WHERE e.msnv = LTRIM(RTRIM(${u}.msnv))
      ) x ORDER BY x.pri) ${p}`;

module.exports = { profileApply };
