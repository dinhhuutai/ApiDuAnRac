const { sql, poolPromise } = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { requireAuth } = require("../middleware/auth");
const { notifyPayslipPublished } = require("../WebPush/pushServicePayslip");

const importJobs = new Map();

function getPayTypeValue(type) {
  const t = String(type || "").trim().toLowerCase();
  if (t === "luong") return 1;
  if (t === "thuong") return 2;
  return null;
}

function normalizePayType(v) {
  return String(v || "").trim().toLowerCase();
}

function buildKySortCase(fieldName = "kyTime") {
  return `
    CASE
      WHEN UPPER(LTRIM(RTRIM(CAST(${fieldName} AS NVARCHAR(50))))) IN (N'2', N'II', N'KỲ II', N'KY II', N'KỲ 2', N'KY 2') THEN 2
      WHEN UPPER(LTRIM(RTRIM(CAST(${fieldName} AS NVARCHAR(50))))) IN (N'1', N'I', N'KỲ I', N'KY I', N'KỲ 1', N'KY 1') THEN 1
      ELSE 0
    END
  `;
}

function formatKyLabel(ky) {
  const raw = String(ky || "").trim().toUpperCase();
  if (["1", "I", "KỲ I", "KY I", "KỲ 1", "KY 1"].includes(raw)) return "Kỳ I";
  if (["2", "II", "KỲ II", "KY II", "KỲ 2", "KY 2"].includes(raw)) return "Kỳ II";
  return String(ky || "-");
}

async function getCurrentUserMsnv(pool, loginId) {
  const rs = await pool
    .request()
    .input("loginId", sql.NVarChar(50), loginId)
    .query(`
      SELECT TOP 1 LTRIM(RTRIM(msnv)) AS msnv
      FROM dbo.Users
      WHERE username = @loginId
    `);

  return rs.recordset[0]?.msnv || null;
}

async function getSalaryPeriods(pool, loginId, userMsnv) {
  const kySortCase = buildKySortCase("x.kyTime");

  const rs = await pool
    .request()
    .input("loginId", sql.NVarChar(50), loginId)
    .input("userMsnv", sql.NVarChar(50), userMsnv || null)
    .input("payTypeLuong", sql.Int, 1)
    .query(`
      SELECT
        x.kyTime,
        x.thangTime,
        x.namTime,
        ${kySortCase} AS kySort
      FROM (
        SELECT DISTINCT
          CAST(p.kyTime AS NVARCHAR(50)) AS kyTime,
          CAST(p.thangTime AS INT) AS thangTime,
          CAST(p.namTime AS INT) AS namTime
        FROM dbo.tl_Paylips p
        WHERE p.IdTypePaylip = @payTypeLuong
          AND (
            LTRIM(RTRIM(p.msnv)) = @loginId
            OR (@userMsnv IS NOT NULL AND LTRIM(RTRIM(p.msnv)) = @userMsnv)
          )
      ) x
      ORDER BY
        x.namTime DESC,
        x.thangTime DESC,
        ${kySortCase} DESC,
        x.kyTime DESC
    `);

  return rs.recordset.map((r) => ({
    kyTime: r.kyTime,
    thangTime: r.thangTime,
    namTime: r.namTime,
    kyLabel: formatKyLabel(r.kyTime),
  }));
}

async function getBonusDates(pool, loginId, userMsnv) {
  const rs = await pool
    .request()
    .input("loginId", sql.NVarChar(50), loginId)
    .input("userMsnv", sql.NVarChar(50), userMsnv || null)
    .input("payTypeThuong", sql.Int, 2)
    .query(`
      SELECT DISTINCT
        CONVERT(VARCHAR(10), p.createdAt, 23) AS dateValue
      FROM dbo.tl_Paylips p
      WHERE p.IdTypePaylip = @payTypeThuong
        AND (
          LTRIM(RTRIM(p.msnv)) = @loginId
          OR (@userMsnv IS NOT NULL AND LTRIM(RTRIM(p.msnv)) = @userMsnv)
        )
        AND p.createdAt IS NOT NULL
      ORDER BY dateValue DESC
    `);

  return rs.recordset.map((r) => r.dateValue).filter(Boolean);
}

async function getLatestSalaryPayslip(pool, loginId, userMsnv) {
  const kySortCase = buildKySortCase("p.kyTime");

  const rs = await pool
    .request()
    .input("loginId", sql.NVarChar(50), loginId)
    .input("userMsnv", sql.NVarChar(50), userMsnv || null)
    .input("payTypeLuong", sql.Int, 1)
    .query(`
      SELECT TOP 1 p.*
      FROM dbo.tl_Paylips p
      WHERE p.IdTypePaylip = @payTypeLuong
        AND (
          LTRIM(RTRIM(p.msnv)) = @loginId
          OR (@userMsnv IS NOT NULL AND LTRIM(RTRIM(p.msnv)) = @userMsnv)
        )
      ORDER BY
        CAST(p.namTime AS INT) DESC,
        CAST(p.thangTime AS INT) DESC,
        ${kySortCase} DESC,
        p.createdAt DESC,
        p.paylipId DESC
    `);

  return rs.recordset[0] || null;
}

async function getPayslipBySalaryPeriod(pool, loginId, userMsnv, kyTime, thangTime, namTime) {
  const rs = await pool
    .request()
    .input("loginId", sql.NVarChar(50), loginId)
    .input("userMsnv", sql.NVarChar(50), userMsnv || null)
    .input("payTypeLuong", sql.Int, 1)
    .input("kyTime", sql.NVarChar(50), String(kyTime || "").trim())
    .input("thangTime", sql.Int, Number(thangTime))
    .input("namTime", sql.Int, Number(namTime))
    .query(`
      SELECT TOP 1 p.*
      FROM dbo.tl_Paylips p
      WHERE p.IdTypePaylip = @payTypeLuong
        AND CAST(p.kyTime AS NVARCHAR(50)) = @kyTime
        AND CAST(p.thangTime AS INT) = @thangTime
        AND CAST(p.namTime AS INT) = @namTime
        AND (
          LTRIM(RTRIM(p.msnv)) = @loginId
          OR (@userMsnv IS NOT NULL AND LTRIM(RTRIM(p.msnv)) = @userMsnv)
        )
      ORDER BY p.createdAt DESC, p.paylipId DESC
    `);

  return rs.recordset[0] || null;
}

async function getPayslipByBonusDate(pool, loginId, userMsnv, dateValue) {
  const rs = await pool
    .request()
    .input("loginId", sql.NVarChar(50), loginId)
    .input("userMsnv", sql.NVarChar(50), userMsnv || null)
    .input("payTypeThuong", sql.Int, 2)
    .input("dateValue", sql.VarChar(10), dateValue)
    .query(`
      SELECT TOP 1 p.*
      FROM dbo.tl_Paylips p
      WHERE p.IdTypePaylip = @payTypeThuong
        AND CONVERT(VARCHAR(10), p.createdAt, 23) = @dateValue
        AND (
          LTRIM(RTRIM(p.msnv)) = @loginId
          OR (@userMsnv IS NOT NULL AND LTRIM(RTRIM(p.msnv)) = @userMsnv)
        )
      ORDER BY p.createdAt DESC, p.paylipId DESC
    `);

  return rs.recordset[0] || null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

/* ==== Toggle debug ==== */
const DEBUG = false;
const log = (...args) => DEBUG && console.log("[payroll]", ...args);

/* ==== Helpers ==== */
function moneyStr(x) {
  if (x == null || x === "") return null;
  return String(x).trim();
}
function numOrNull(x) {
  if (x == null || x === "") return null;
  const n = Number(String(x).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
const norm = (s = "") =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toUpperCase();

const buildRx = (aliases = []) => {
  const parts = aliases.map((a) => norm(a).replace(/\s+/g, "\\s*"));
  return new RegExp(`^(${parts.join("|")})$`, "i");
};

const getIdxN = (header, ...aliases) => {
  const rx = buildRx(aliases);
  for (let i = 0; i < header.length; i++) {
    if (rx.test(norm(header[i] || ""))) return i;
  }
  return -1;
};

// lấy tất cả index match (dùng cho case cột trùng tên)
const getIdxAllN = (header, ...aliases) => {
  const rx = buildRx(aliases);
  const out = [];
  for (let i = 0; i < header.length; i++) {
    if (rx.test(norm(header[i] || ""))) out.push(i);
  }
  return out;
};

function getCellText(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if (!cell) return "";
  if (cell.w != null) return String(cell.w).trim();
  if (cell.v != null) return String(cell.v).trim();
  return "";
}

function createJobId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// ===== tính kỳ/tháng/năm theo ngày upload =====
function buildTimeInfoFromNow(now = new Date()) {
  const day = now.getDate();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentYear = now.getFullYear();

  let kyTime = 1;
  let thangTime = currentMonth;
  let namTime = currentYear;

  // ngày 17 -> 30 => kỳ 1 tháng hiện tại
  if (day >= 17 && day <= 30) {
    kyTime = 1;
    thangTime = currentMonth;
    namTime = currentYear;
  }
  // ngày 2 -> 15 => kỳ 2 tháng hiện tại - 1
  else if (day >= 2 && day <= 15) {
    kyTime = 2;
    thangTime = currentMonth - 1;
    namTime = currentYear;

    if (thangTime === 0) {
      thangTime = 12;
      namTime = currentYear - 1;
    }
  }
  // ngoài khoảng thì mặc định xử lý gần nhất
  else {
    if (day === 1) {
      kyTime = 2;
      thangTime = currentMonth - 1;
      namTime = currentYear;
      if (thangTime === 0) {
        thangTime = 12;
        namTime = currentYear - 1;
      }
    } else if (day === 16) {
      kyTime = 1;
      thangTime = currentMonth;
      namTime = currentYear;
    } else if (day === 31) {
      kyTime = 1;
      thangTime = currentMonth;
      namTime = currentYear;
    }
  }

  return { kyTime, thangTime, namTime };
}

/* ==== API ==== */
function apiPayrollCalculation(app) {
  // =============== IMPORT START ===============
  // app.post(
  //   "/api/paylips/import-start",
  //   requireAuth,
  //   upload.single("file"),
  //   async (req, res) => {
  //     if (!req.file) {
  //       return res.status(400).json({ success: false, message: "Thiếu file" });
  //     }

  //     try {
  //       const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  //       const wsName = wb.SheetNames[0];
  //       const ws = wb.Sheets[wsName];

  //       // Lấy Title từ A2
  //       const A2 = ws["A2"]?.v ? String(ws["A2"].v).trim() : "";

  //       let title = "";
  //       let docType = "PAYSLIP";

  //       if (/DANH\s*SÁCH\s*THƯỞNG\s*NĂM/i.test(A2)) {
  //         docType = "YEAR_BONUS";
  //         const suffix = A2.replace(/DANH\s*SÁCH\s*THƯỞNG\s*NĂM/i, "").trim();
  //         title = `Phiếu tính tiền thưởng năm ${suffix}`.trim();
  //       } else if (/BẢNG LƯƠNG GIỮA KỲ/i.test(A2)) {
  //         const m = A2.match(/BẢNG LƯƠNG GIỮA KỲ.*?(\d{2}\/\d{4})/i);
  //         title = `Phiếu lương kỳ I tháng ${(m?.[1] || "").trim()}`;
  //       } else {
  //         const m = A2.match(/BẢNG LƯƠNG THÁNG.*?(\d{2}\/\d{4})/i);
  //         title = `Phiếu lương tháng ${(m?.[1] || "").trim()}`;
  //       }

  //       const jobId = createJobId();
  //       importJobs.set(jobId, {
  //         buffer: req.file.buffer,
  //         title,
  //         docType,
  //         createdAt: Date.now(),
  //       });

  //       return res.json({ success: true, jobId, title, docType });
  //     } catch (e) {
  //       console.error("import-start error:", e);
  //       return res
  //         .status(500)
  //         .json({ success: false, message: "Không thể đọc file Excel" });
  //     }
  //   }
  // );

  // // =============== IMPORT STREAM (SSE) ===============
  // app.get("/api/paylips/import-stream/:jobId", async (req, res) => {
  //   const { jobId } = req.params;
  //   const job = importJobs.get(jobId);

  //   if (!job) return res.status(404).end("job not found");

  //   // SSE headers
  //   res.setHeader("Content-Type", "text/event-stream");
  //   res.setHeader("Cache-Control", "no-cache");
  //   res.setHeader("Connection", "keep-alive");

  //   const sendEvent = (event, data) => {
  //     res.write(`event: ${event}\n`);
  //     res.write(`data: ${JSON.stringify(data)}\n\n`);
  //   };

  //   try {
  //     const { buffer, title, docType } = job;

  //     const wb = XLSX.read(buffer, { type: "buffer" });
  //     const wsName = wb.SheetNames[0];
  //     const ws = wb.Sheets[wsName];

  //     // AOA
  //     const aoa = XLSX.utils.sheet_to_json(ws, {
  //       header: 1,
  //       raw: false,
  //       blankrows: false,
  //       defval: "",
  //       cellText: true,
  //     });
  //     const colCount = Math.max(...aoa.map((r) => (Array.isArray(r) ? r.length : 0)));

  //     // ✅ locate header row (FIX bằng norm để chịu wrap/Unicode)
  //     const headerRowIdx = aoa.findIndex((rowArr) => {
  //       if (!Array.isArray(rowArr)) return false;
  //       const rowNorm = rowArr.map((c) => norm(c || ""));
  //       return rowNorm.some((x) => x.includes("MSNV")) && rowNorm.some((x) => x.includes("HO VA TEN"));
  //     });

  //     if (headerRowIdx < 0) {
  //       sendEvent("error", { message: "Không tìm thấy dòng tiêu đề (MSNV, HỌ VÀ TÊN)." });
  //       res.end();
  //       return;
  //     }

  //     // headerEff (row -> below -> above)
  //     const rowAbove = aoa[headerRowIdx - 1] || [];
  //     const headerRow = aoa[headerRowIdx] || [];
  //     const rowBelow = aoa[headerRowIdx + 1] || [];
  //     const headerEff = Array.from({ length: colCount }, (_, i) => {
  //       const h = String(headerRow[i] || "").trim();
  //       if (h) return h;
  //       const b = String(rowBelow[i] || "").trim();
  //       if (b) return b;
  //       return String(rowAbove[i] || "").trim();
  //     });

  //     // first data row
  //     const colMSNV = getIdxN(headerEff, "MSNV");
  //     const colNAME = getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN");
  //     let firstDataIdx = headerRowIdx + 1;

  //     if (headerRowIdx + 1 < aoa.length) {
  //       const maybeHdr = aoa[headerRowIdx + 1] || [];
  //       const ms = norm(maybeHdr[colMSNV] || "");
  //       const nm = norm(maybeHdr[colNAME] || "");
  //       if (ms === "MSNV" || nm === "HO VA TEN") firstDataIdx++;
  //     }

  //     for (let r = firstDataIdx; r < aoa.length; r++) {
  //       const row = aoa[r] || [];
  //       const msnv = String(row[colMSNV] || "").trim();
  //       const theName = String(row[colNAME] || "").trim();
  //       const isProbablyHeader = norm(msnv) === "MSNV" || norm(theName) === "HO VA TEN";
  //       const isEmpty = row.every((v) => String(v || "").trim() === "");
  //       if (!isEmpty && !isProbablyHeader) {
  //         firstDataIdx = r;
  //         break;
  //       }
  //     }

  //     // body
  //     const body = aoa.slice(firstDataIdx).map((row) => {
  //       const out = new Array(colCount).fill("");
  //       for (let i = 0; i < Math.min(colCount, row.length); i++) out[i] = row[i];
  //       return out;
  //     });

  //     // carry (để biết cột dưới KHẤU TRỪ)
  //     const up2 = aoa[headerRowIdx - 2] || [];
  //     const up1 = aoa[headerRowIdx - 1] || [];
  //     const dn1 = aoa[headerRowIdx + 1] || [];
  //     const dn2 = aoa[headerRowIdx + 2] || [];
  //     const carry = new Array(colCount).fill("");
  //     for (let i = 0; i < colCount; i++) {
  //       const t2 = norm(up2[i] || "");
  //       const t1 = norm(up1[i] || "");
  //       carry[i] = t2 || t1 || "";
  //     }

  //     const ref = XLSX.utils.decode_range(ws["!ref"] || "A1");

  //     // valid users
  //     const pool = await poolPromise;
  //     const userRows = await pool.request().query(`SELECT username, msnv FROM dbo.Users`);

  //     const toKey = (s) => (s ?? "").trim().toUpperCase();
  //     const validIdentifiers = new Set();
  //     for (const r of userRows.recordset) {
  //       if (r.username) validIdentifiers.add(toKey(r.username));
  //       if (r.msnv) validIdentifiers.add(toKey(r.msnv));
  //     }

  //     // ====================== YEAR BONUS BRANCH ======================
  //     if (docType === "YEAR_BONUS") {
  //       const idxY = {
  //         STT: getIdxN(headerEff, "STT"),
  //         MSNV: getIdxN(headerEff, "MSNV"),
  //         NAME: getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN"),
  //         TO: getIdxN(headerEff, "TỔ", "TO"),
  //         SOTHANG: getIdxN(headerEff, "SỐ THÁNG LÀM VIỆC", "SO THANG LAM VIEC"),
  //         XEPLOAI: getIdxN(headerEff, "XẾP LOẠI", "XEP LOAI"),

  //         LUONG: getIdxN(headerEff, "LƯƠNG", "LUONG"),
  //         TRACHNHIEM: getIdxN(headerEff, "TRÁCH NHIỆM", "TRACH NHIEM"),
  //         TIENXENHATRO: getIdxN(headerEff, "TIỀN XE, NHÀ TRỌ", "TIEN XE NHA TRO"),
  //         THUONGCL: getIdxN(headerEff, "THƯỞNG CL", "THUONG CL"),
  //         TONGCONGLUONG: getIdxN(headerEff, "TỔNG CỘNG LƯƠNG", "TONG CONG LUONG"),

  //         NGAYCONG: getIdxN(headerEff, "NGÀY CÔNG", "NGAY CONG"),
  //         AVG_NAM: getIdxN(headerEff, "NGÀY CÔNG BÌNH QUÂN NĂM", "NGAY CONG BINH QUAN NAM"),
  //         DU_NAM: getIdxN(headerEff, "TỔNG CÔNG ĐỦ TRONG NĂM", "TONG CONG DU TRONG NAM"),
  //         AVG_DU: getIdxN(headerEff, "NGÀY CÔNG BÌNH QUÂN NĂM ĐỦ", "NGAY CONG BINH QUAN NAM DU"),

  //         TONGCONG: getIdxN(headerEff, "TỔNG CỘNG", "TONG CONG"),
  //         THUETAMTHU: getIdxN(headerEff, "TẠM THU THUẾ TNCN", "TAM THU THUE TNCN"),
  //         THUCLANH: getIdxN(headerEff, "THỰC LÃNH", "THUC LANH"),
  //         GHICHU: getIdxN(headerEff, "GHI CHÚ", "GHI CHU"),
  //       };

  //       // 2 cột trùng tên => lấy theo thứ tự xuất hiện
  //       const bonus1Cols = getIdxAllN(
  //         headerEff,
  //         "TIỀN THƯỞNG (1THÁNG LƯƠNG)",
  //         "TIEN THUONG 1THANG LUONG",
  //         "TIEN THUONG 1 THANG LUONG"
  //       );
  //       const abcCols = getIdxAllN(
  //         headerEff,
  //         "TIỀN THƯỞNG THEO ĐÁNH GIÁ A,B,C",
  //         "TIEN THUONG THEO DANH GIA A B C"
  //       );

  //       const B1 = bonus1Cols[0] ?? -1;
  //       const B2 = bonus1Cols[1] ?? -1;
  //       const A1 = abcCols[0] ?? -1;
  //       const A2 = abcCols[1] ?? -1;

  //       // Mandatory
  //       for (const k of ["MSNV", "NAME"]) {
  //         if (idxY[k] < 0) {
  //           sendEvent("error", { message: `Thiếu cột bắt buộc: ${k} (Thưởng năm)` });
  //           res.end();
  //           return;
  //         }
  //       }

  //       let inserted = 0;
  //       let skippedNoUser = 0;
  //       let failed = 0;
  //       let processed = 0;

  //       const totalRows = body.filter((row) => {
  //         const rawMSNV = (row[idxY.MSNV] || "").toString().trim();
  //         const name = (row[idxY.NAME] || "").toString().trim();
  //         return !!(rawMSNV || name);
  //       }).length;

  //       sendEvent("start", { title, totalRows, docType });

  //       for (let rAOA = 0; rAOA < body.length; rAOA++) {
  //         const row = body[rAOA];

  //         const rawMSNV = (row[idxY.MSNV] || "").toString().trim();
  //         const name = (row[idxY.NAME] || "").toString().trim();
  //         if (!rawMSNV && !name) continue;

  //         processed++;

  //         let status = "pending";
  //         let reason = "";

  //         if (!validIdentifiers.has(toKey(rawMSNV))) {
  //           skippedNoUser++;
  //           status = "skipped_no_user";
  //           reason = "Không tìm thấy user tương ứng trong hệ thống";
  //           sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
  //           continue;
  //         }

  //         // STT theo TEXT hiển thị
  //         let stt = null;
  //         if (idxY.STT >= 0) {
  //           const wsRow = ref.s.r + firstDataIdx + rAOA;
  //           const wsCol = ref.s.c + idxY.STT;
  //           const sttText = getCellText(ws, wsRow, wsCol);
  //           stt = sttText ? Number(sttText.replace(/[^\d.-]/g, "")) : null;
  //         }

  //         const reqSql = pool.request();
  //         reqSql
  //           .input("title", sql.NVarChar(100), title)
  //           .input("docType", sql.NVarChar(30), "YEAR_BONUS")
  //           .input("msnv", sql.NVarChar(50), rawMSNV)
  //           .input("stt", sql.Int, Number.isFinite(stt) ? stt : null)
  //           .input("name", sql.NVarChar(50), name)

  //           // Reuse cột cũ (nếu bạn muốn)
  //           .input("basicSalary", sql.NVarChar(10), moneyStr(idxY.LUONG >= 0 ? row[idxY.LUONG] : null))
  //           .input("responsibility", sql.NVarChar(10), moneyStr(idxY.TRACHNHIEM >= 0 ? row[idxY.TRACHNHIEM] : null))
  //           .input("rent", sql.NVarChar(10), moneyStr(idxY.TIENXENHATRO >= 0 ? row[idxY.TIENXENHATRO] : null))
  //           .input("qualityBonus", sql.NVarChar(10), moneyStr(idxY.THUONGCL >= 0 ? row[idxY.THUONGCL] : null))
  //           .input("totalSalary", sql.NVarChar(10), moneyStr(idxY.TONGCONGLUONG >= 0 ? row[idxY.TONGCONGLUONG] : null))
  //           .input("totalWorkingDays", sql.Float, numOrNull(idxY.NGAYCONG >= 0 ? row[idxY.NGAYCONG] : null))
  //           .input("ktthue", sql.NVarChar(10), moneyStr(idxY.THUETAMTHU >= 0 ? row[idxY.THUETAMTHU] : null))
  //           .input("luongthuclanh", sql.NVarChar(10), moneyStr(idxY.THUCLANH >= 0 ? row[idxY.THUCLANH] : null))

  //           // Các cột mới yb_*
  //           .input("yb_team", sql.NVarChar(30), idxY.TO >= 0 ? String(row[idxY.TO] || "").trim() : null)
  //           .input("yb_monthsWorked", sql.Float, numOrNull(idxY.SOTHANG >= 0 ? row[idxY.SOTHANG] : null))
  //           .input("yb_rating", sql.NVarChar(10), idxY.XEPLOAI >= 0 ? String(row[idxY.XEPLOAI] || "").trim() : null)

  //           .input("yb_avgWorkDaysYear", sql.Float, numOrNull(idxY.AVG_NAM >= 0 ? row[idxY.AVG_NAM] : null))
  //           .input("yb_totalEligibleDaysYear", sql.Float, numOrNull(idxY.DU_NAM >= 0 ? row[idxY.DU_NAM] : null))
  //           .input("yb_avgEligibleDaysYear", sql.Float, numOrNull(idxY.AVG_DU >= 0 ? row[idxY.AVG_DU] : null))

  //           .input("yb_bonus1MonthSalary_1", sql.NVarChar(20), moneyStr(B1 >= 0 ? row[B1] : null))
  //           .input("yb_bonus1MonthSalary_2", sql.NVarChar(20), moneyStr(B2 >= 0 ? row[B2] : null))
  //           .input("yb_bonusABC_1", sql.NVarChar(20), moneyStr(A1 >= 0 ? row[A1] : null))
  //           .input("yb_bonusABC_2", sql.NVarChar(20), moneyStr(A2 >= 0 ? row[A2] : null))

  //           .input("yb_totalBonus", sql.NVarChar(20), moneyStr(idxY.TONGCONG >= 0 ? row[idxY.TONGCONG] : null))
  //           .input("yb_taxWithheld", sql.NVarChar(20), moneyStr(idxY.THUETAMTHU >= 0 ? row[idxY.THUETAMTHU] : null))
  //           .input("yb_netPay", sql.NVarChar(20), moneyStr(idxY.THUCLANH >= 0 ? row[idxY.THUCLANH] : null))
  //           .input("yb_note", sql.NVarChar(200), idxY.GHICHU >= 0 ? String(row[idxY.GHICHU] || "").trim() : null);

  //         try {
  //           await reqSql.query(`
  //             INSERT INTO dbo.tl_Paylips
  //             (
  //               title, docType, msnv, stt, name,

  //               -- reuse cột cũ
  //               basicSalary, responsibility, rent, qualityBonus, totalSalary,
  //               totalWorkingDays, ktthue, luongthuclanh,

  //               -- yb_*
  //               yb_team, yb_monthsWorked, yb_rating,
  //               yb_avgWorkDaysYear, yb_totalEligibleDaysYear, yb_avgEligibleDaysYear,
  //               yb_bonus1MonthSalary_1, yb_bonus1MonthSalary_2,
  //               yb_bonusABC_1, yb_bonusABC_2,
  //               yb_totalBonus, yb_taxWithheld, yb_netPay, yb_note
  //             )
  //             VALUES
  //             (
  //               @title, @docType, @msnv, @stt, @name,

  //               @basicSalary, @responsibility, @rent, @qualityBonus, @totalSalary,
  //               @totalWorkingDays, @ktthue, @luongthuclanh,

  //               @yb_team, @yb_monthsWorked, @yb_rating,
  //               @yb_avgWorkDaysYear, @yb_totalEligibleDaysYear, @yb_avgEligibleDaysYear,
  //               @yb_bonus1MonthSalary_1, @yb_bonus1MonthSalary_2,
  //               @yb_bonusABC_1, @yb_bonusABC_2,
  //               @yb_totalBonus, @yb_taxWithheld, @yb_netPay, @yb_note
  //             )
  //           `);

  //           inserted++;
  //           status = "inserted";
  //         } catch (err) {
  //           failed++;
  //           status = "failed";
  //           reason = err?.message || "Lỗi insert";
  //         }

  //         sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
  //       }

  //       // Push notify (nếu bạn muốn giữ cho thưởng năm)
  //       try {
  //         // const info = await notifyPayslipPublished(title);
  //         // log("pushed:", info);
  //       } catch (e) {
  //         log("push failed:", e?.message);
  //       }

  //       sendEvent("done", { title, totalRows, processed, inserted, skippedNoUser, failed, docType });

  //       importJobs.delete(jobId);
  //       res.end();
  //       return;
  //     }

  //     // ====================== PAYSLIP BRANCH (CODE CŨ CỦA BẠN) ======================

  //     // index map (copy y nguyên anh đang dùng)
  //     const idx = {
  //       STT: getIdxN(headerEff, "STT"),
  //       DEP: getIdxN(headerEff, "BP1", "BỘ PHẬN", "BP"),
  //       MSNV: getIdxN(headerEff, "MSNV"),
  //       NAME: getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN"),

  //       BASIC: getIdxN(headerEff, "LƯƠNG CB", "LUONG CB", "LƯƠNG CƠ BẢN", "LUONG CO BAN"),
  //       RESP: getIdxN(
  //         headerEff,
  //         "PC TRÁCH NHIỆM",
  //         "PC TRACH NHIEM",
  //         "PHỤ CẤP TRÁCH NHIỆM",
  //         "PHU CAP TRACH NHIEM"
  //       ),

  //       WDAY: getIdxN(headerEff, "NGÀY CÔNG CÓ HỆ SỐ", "NGAY CONG CO HE SO", "NGÀY CÔNG", "NGAY CONG"),
  //       HOLI: getIdxN(headerEff, "NGHỈ LỄ", "NGHI LE"),
  //       ACTUAL: getIdxN(headerEff, "LƯƠNG THỰC TẾ", "LUONG THUC TE"),

  //       OT15: getIdxN(headerEff, "TCA NGÀY", "TCA NGAY", "CA NGÀY", "CA NGAY"),
  //       OTS15: getIdxN(headerEff, "LƯƠNG TCA 1.5", "LUONG TCA 1.5"),
  //       OT18: getIdxN(headerEff, "TCA ĐÊM", "TCA DEM", "CA ĐÊM", "CA DEM"),
  //       OTS18: getIdxN(headerEff, "LƯƠNG TCA 1.8", "LUONG TCA 1.8"),
  //       OT05: getIdxN(headerEff, "TCA 0.5"),
  //       OTS05: getIdxN(headerEff, "LƯƠNG TCA 0.5", "LUONG TCA 0.5"),

  //       AL: getIdxN(headerEff, "NGHỈ PHÉP", "NGHI PHEP"),
  //       ALPAY: getIdxN(headerEff, "TIỀN PHÉP", "TIEN PHEP"),

  //       RENT: (() => {
  //         const pri = getIdxN(headerEff, "NHÀ TRỌ XE", "NHA TRO XE");
  //         if (pri >= 0) return pri;
  //         const headerNorm = headerEff.map((h) => norm(h || ""));
  //         let cand = headerNorm.findIndex((h) => h.includes("NHA TRO") && h.includes("XE") && !h.includes("QUY DINH"));
  //         if (cand >= 0) return cand;
  //         cand = headerNorm.findIndex((h) => h.includes("NHA TRO") && h.includes("XE"));
  //         return cand;
  //       })(),

  //       QBON: getIdxN(headerEff, "THƯỞNG HIỆU QUẢ CÔNG VIỆC", "THUONG HIEU QUA CONG VIEC"),
  //       TOTAL: getIdxN(headerEff, "TỔNG LƯƠNG", "TONG LUONG"),

  //       // Bổ sung
  //       CONGNGAY: getIdxN(headerEff, "CÔNG NGÀY", "CONG NGAY", "CÔNG HÀNH CHÁNH", "CONG HANH CHANH", "CÔNG HÀNH CHÍNH", "CONG HANH CHINH"),
  //       CONGDEM: getIdxN(headerEff, "CÔNG ĐÊM", "CONG DEM"),
  //       CHOVIEC: getIdxN(headerEff, "NGHỈ CHỜ VIỆC", "NGHI CHO VIEC"),
  //       NGHIKHAC: getIdxN(headerEff, "NGHỈ KHÁC HƯỞNG LƯƠNG", "NGHI KHAC HUONG LUONG", "NGHỈ KHÁC", "NGHI KHAC"),
  //       LUONGCHOVIEC: getIdxN(headerEff, "LƯƠNG CHỜ VIỆC", "LUONG CHO VIEC"),
  //       LUONGKHAC: getIdxN(headerEff, "LƯƠNG KHÁC", "LUONG KHAC"),
  //       CHUNHAT: getIdxN(headerEff, "CHủ NHẬT", "CHU NHAT"),
  //       LUONGCHUNHAT: getIdxN(headerEff, "LƯƠNG CHỦ NHẬT", "LUONG CHU NHAT"),
  //       HOTRO_CA: getIdxN(headerEff, "HỖ TRỢ NGHỈ GIỮA CA", "HO TRO NGHI GIUA CA"),
  //       HOTRO_HK: getIdxN(headerEff, "HỖ TRỢ NGÀY HÀNH KINH", "HO TRO NGAY HANH KINH"),
  //       CONNHO: getIdxN(headerEff, "CON NHỎ", "CON NHO"),
  //       THUONG1CC: getIdxN(headerEff, "THƯỞNG HIỆU QUẢ CÔNG VIỆC 1", "THUONG HIEU QUA CONG VIEC 1"),
  //       HOTRO_KHAC: getIdxN(headerEff, "HỖ TRỢ KHÁC", "HO TRO KHAC"),
  //       THUONGLE: getIdxN(headerEff, "THƯỞNG LỄ", "THUONG LE"),
  //       COM_TONG: getIdxN(headerEff, "CƠM TỔNG", "COM TONG"),

  //       // Khấu trừ
  //       KTBH: getIdxN(headerEff, "BH (XH+YT+TN)", "BH XH YT TN"),
  //       KTCONGDOAN: getIdxN(headerEff, "ĐOÀN PHÍ", "DOAN PHI"),
  //       KTLUONGKY1: getIdxN(headerEff, "TẠM ỨNG", "TAM UNG"),
  //       KTTHUE: getIdxN(headerEff, "THUẾ TNCN", "THUE TNCN"),
  //       KTKHAC: getIdxN(headerEff, "KT KHÁC", "KT KHAC"),
  //       KTTRUCOM: getIdxN(headerEff, "KT TIỀN CƠM", "KT TIEN COM"),

  //       LUONGTHUCLANH: getIdxN(headerEff, "LƯƠNG THỰC LÃNH", "LUONG THUC LANH"),
  //     };

  //     // Ưu tiên dò ở hàng 6 cho KTTRUCOM / KTKHAC (giống code cũ)
  //     const hRowNorm = headerEff.map((h) => norm(h || ""));
  //     const belowNorm1 = dn1.map((h) => norm(h || ""));
  //     const belowNorm2 = dn2.map((h) => norm(h || ""));

  //     const findUnderKhauTru = (texts, groupCarry, keywords) => {
  //       for (let i = 0; i < texts.length; i++) {
  //         const t = texts[i];
  //         if (!t) continue;
  //         const underKT = groupCarry[i] === "KHAU TRU";
  //         if (!underKT) continue;
  //         for (const kw of keywords) if (t.includes(kw)) return i;
  //       }
  //       return -1;
  //     };

  //     if (idx.KTTRUCOM < 0) {
  //       let pos = belowNorm2.findIndex((h) => h === "KT TIEN COM");
  //       if (pos < 0) pos = belowNorm1.findIndex((h) => h === "KT TIEN COM");
  //       if (pos < 0) pos = hRowNorm.findIndex((h) => h === "KT TIEN COM");

  //       if (pos < 0) {
  //         pos = findUnderKhauTru(belowNorm2, carry, ["TIEN COM"]);
  //         if (pos < 0) pos = findUnderKhauTru(belowNorm1, carry, ["TIEN COM"]);
  //         if (pos < 0) pos = findUnderKhauTru(hRowNorm, carry, ["TIEN COM"]);
  //       }
  //       if (pos >= 0) idx.KTTRUCOM = pos;
  //     }

  //     if (idx.KTKHAC < 0) {
  //       let pos = belowNorm2.findIndex((h) => h === "KT KHAC");
  //       if (pos < 0) pos = belowNorm1.findIndex((h) => h === "KT KHAC");
  //       if (pos < 0) pos = hRowNorm.findIndex((h) => h === "KT KHAC");

  //       if (pos < 0) {
  //         pos = findUnderKhauTru(belowNorm2, carry, ["KHAC"]);
  //         if (pos < 0) pos = findUnderKhauTru(belowNorm1, carry, ["KHAC"]);
  //         if (pos < 0) pos = findUnderKhauTru(hRowNorm, carry, ["KHAC"]);
  //       }
  //       if (pos >= 0) idx.KTKHAC = pos;
  //     }

  //     // Phân biệt TIỀN CƠM thu nhập vs khấu trừ theo group
  //     const headerEffNorm = headerEff.map((h) => norm(h || ""));
  //     const allTienCom = [];
  //     for (let i = 0; i < colCount; i++) {
  //       if (headerEffNorm[i] === "TIEN COM") allTienCom.push({ i, underKhauTru: carry[i] === "KHAU TRU" });
  //     }
  //     const incomeTienCom = allTienCom.find((x) => !x.underKhauTru);
  //     const ktTienComByGroup = allTienCom.find((x) => x.underKhauTru);
  //     const TIENCOM_INCOME = incomeTienCom ? incomeTienCom.i : -1;
  //     if (idx.KTTRUCOM < 0 && ktTienComByGroup) idx.KTTRUCOM = ktTienComByGroup.i;

  //     // Mandatory
  //     for (const k of ["MSNV", "NAME"]) {
  //       if (idx[k] < 0) {
  //         sendEvent("error", { message: `Thiếu cột bắt buộc: ${k}` });
  //         res.end();
  //         return;
  //       }
  //     }

  //     let inserted = 0;
  //     let skippedNoUser = 0;
  //     let failed = 0;
  //     let processed = 0;

  //     const totalRows = body.filter((row) => {
  //       const rawMSNV = (row[idx.MSNV] || "").toString().trim();
  //       const name = (row[idx.NAME] || "").toString().trim();
  //       return !!(rawMSNV || name);
  //     }).length;

  //     sendEvent("start", { title, totalRows, docType: "PAYSLIP" });

  //     for (let rAOA = 0; rAOA < body.length; rAOA++) {
  //       const row = body[rAOA];

  //       const rawMSNV = (row[idx.MSNV] || "").toString().trim();
  //       const name = (row[idx.NAME] || "").toString().trim();
  //       if (!rawMSNV && !name) continue;

  //       processed++;

  //       let status = "pending";
  //       let reason = "";

  //       if (!validIdentifiers.has(toKey(rawMSNV))) {
  //         skippedNoUser++;
  //         status = "skipped_no_user";
  //         reason = "Không tìm thấy user tương ứng trong hệ thống";
  //         sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
  //         continue;
  //       }

  //       // STT theo TEXT hiển thị
  //       let stt = null;
  //       if (idx.STT >= 0) {
  //         const wsRow = ref.s.r + firstDataIdx + rAOA;
  //         const wsCol = ref.s.c + idx.STT;
  //         const sttText = getCellText(ws, wsRow, wsCol);
  //         stt = sttText ? Number(sttText.replace(/[^\d.-]/g, "")) : null;
  //       }

  //       const departmentCell = idx.DEP >= 0 ? row[idx.DEP] : ws["F6"]?.v ?? null;
  //       const department = departmentCell != null ? String(departmentCell).trim() : null;

  //       const reqSql = pool.request();
  //       reqSql
  //         .input("title", sql.NVarChar(50), title)
  //         .input("msnv", sql.NVarChar(50), rawMSNV)
  //         .input("stt", sql.Int, Number.isFinite(stt) ? stt : null)
  //         .input("department", sql.NVarChar(15), department)
  //         .input("name", sql.NVarChar(50), name)
  //         .input("basicSalary", sql.NVarChar(10), moneyStr(row[idx.BASIC]))
  //         .input("responsibility", sql.NVarChar(10), moneyStr(row[idx.RESP]))
  //         .input("totalWorkingDays", sql.Float, numOrNull(row[idx.WDAY]))
  //         .input("holiday", sql.Float, numOrNull(row[idx.HOLI]))
  //         .input("actualSalary", sql.NVarChar(10), moneyStr(row[idx.ACTUAL]))
  //         .input("ot15", sql.Float, numOrNull(row[idx.OT15]))
  //         .input("otSalary15", sql.NVarChar(10), moneyStr(row[idx.OTS15]))
  //         .input("ot18", sql.Float, numOrNull(row[idx.OT18]))
  //         .input("otSalary18", sql.NVarChar(10), moneyStr(row[idx.OTS18]))
  //         .input("ot05", sql.Float, numOrNull(row[idx.OT05]))
  //         .input("otSalary05", sql.NVarChar(10), moneyStr(row[idx.OTS05]))
  //         .input("annualLeave", sql.Float, numOrNull(row[idx.AL]))
  //         .input("leavePay", sql.NVarChar(10), moneyStr(row[idx.ALPAY]))
  //         .input("rent", sql.NVarChar(10), moneyStr(row[idx.RENT]))
  //         .input("qualityBonus", sql.NVarChar(10), moneyStr(row[idx.QBON]))
  //         .input("totalSalary", sql.NVarChar(10), moneyStr(row[idx.TOTAL]))

  //         .input("conghanhchanh", sql.Float, numOrNull(row[idx.CONGNGAY]))
  //         .input("congcadem", sql.Float, numOrNull(row[idx.CONGDEM]))
  //         .input("choviec", sql.NVarChar(10), moneyStr(row[idx.CHOVIEC]))
  //         .input("nghikhac", sql.NVarChar(10), moneyStr(row[idx.NGHIKHAC]))
  //         .input("luongchoviec", sql.NVarChar(10), moneyStr(row[idx.LUONGCHOVIEC]))
  //         .input("luongkhac", sql.NVarChar(10), moneyStr(row[idx.LUONGKHAC]))
  //         .input("chunhat", sql.NVarChar(10), moneyStr(row[idx.CHUNHAT]))
  //         .input("luongchunhat", sql.NVarChar(10), moneyStr(row[idx.LUONGCHUNHAT]))
  //         .input("hotronghigiuaca", sql.NVarChar(10), moneyStr(row[idx.HOTRO_CA]))
  //         .input("hotrongayhanhkinh", sql.NVarChar(10), moneyStr(row[idx.HOTRO_HK]))
  //         .input("connho", sql.NVarChar(10), moneyStr(row[idx.CONNHO]))
  //         .input("thuong1CC", sql.NVarChar(10), moneyStr(row[idx.THUONG1CC]))
  //         .input("hotrokhac", sql.NVarChar(10), moneyStr(row[idx.HOTRO_KHAC]))
  //         .input("thuongle", sql.NVarChar(10), moneyStr(row[idx.THUONGLE]))
  //         .input("tiencomSL", sql.Float, numOrNull(row[idx.COM_TONG]))
  //         .input("tiencom", sql.NVarChar(10), moneyStr(TIENCOM_INCOME >= 0 ? row[TIENCOM_INCOME] : null))
  //         .input("ktbh", sql.NVarChar(10), moneyStr(row[idx.KTBH]))
  //         .input("ktcongdoan", sql.NVarChar(10), moneyStr(row[idx.KTCONGDOAN]))
  //         .input("ktluongky1", sql.NVarChar(10), moneyStr(row[idx.KTLUONGKY1]))
  //         .input("kttrucom", sql.NVarChar(10), moneyStr(idx.KTTRUCOM >= 0 ? row[idx.KTTRUCOM] : null))
  //         .input("ktthue", sql.NVarChar(10), moneyStr(row[idx.KTTHUE]))
  //         .input("ktkhac", sql.NVarChar(10), moneyStr(idx.KTKHAC >= 0 ? row[idx.KTKHAC] : null))
  //         .input("luongthuclanh", sql.NVarChar(10), moneyStr(row[idx.LUONGTHUCLANH]));

  //       try {
  //         await reqSql.query(`
  //           INSERT INTO dbo.tl_Paylips
  //           (
  //             title, msnv, stt, department, name,
  //             basicSalary, responsibility, totalWorkingDays, holiday, actualSalary,
  //             ot15, otSalary15, ot18, otSalary18, ot05, otSalary05,
  //             annualLeave, leavePay, rent, qualityBonus, totalSalary,
  //             conghanhchanh, congcadem, choviec, nghikhac, luongchoviec, luongkhac,
  //             chunhat, luongchunhat, hotronghigiuaca, hotrongayhanhkinh, connho,
  //             thuong1CC, hotrokhac, thuongle, tiencomSL, tiencom,
  //             ktbh, ktcongdoan, ktluongky1, kttrucom, ktthue, ktkhac, luongthuclanh
  //           )
  //           VALUES
  //           (
  //             @title, @msnv, @stt, @department, @name,
  //             @basicSalary, @responsibility, @totalWorkingDays, @holiday, @actualSalary,
  //             @ot15, @otSalary15, @ot18, @otSalary18, @ot05, @otSalary05,
  //             @annualLeave, @leavePay, @rent, @qualityBonus, @totalSalary,
  //             @conghanhchanh, @congcadem, @choviec, @nghikhac, @luongchoviec, @luongkhac,
  //             @chunhat, @luongchunhat, @hotronghigiuaca, @hotrongayhanhkinh, @connho,
  //             @thuong1CC, @hotrokhac, @thuongle, @tiencomSL, @tiencom,
  //             @ktbh, @ktcongdoan, @ktluongky1, @kttrucom, @ktthue, @ktkhac, @luongthuclanh
  //           )
  //         `);

  //         inserted++;
  //         status = "inserted";
  //       } catch (rowErr) {
  //         failed++;
  //         status = "failed";
  //         reason = rowErr?.message || "Lỗi insert";
  //         log("Row insert error:", rowErr?.message);
  //       }

  //       sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
  //     }

  //     // Push notify khi import xong (lương)
  //     try {
  //       // const info = await notifyPayslipPublished(title);
  //       // log("pushed:", info);
  //     } catch (e) {
  //       log("push failed:", e?.message);
  //     }

  //     sendEvent("done", { title, totalRows, processed, inserted, skippedNoUser, failed, docType: "PAYSLIP" });

  //     importJobs.delete(jobId);
  //     res.end();
  //   } catch (e) {
  //     console.error("import-stream error:", e);
  //     try {
  //       res.write(`event: error\n`);
  //       res.write(`data: ${JSON.stringify({ message: "Lỗi xử lý file hoặc lưu dữ liệu" })}\n\n`);
  //     } catch (_) {}
  //     importJobs.delete(jobId);
  //     res.end();
  //   }
  // });

  app.post(
  "/api/paylips/import-start",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Thiếu file" });
    }

    try {
      const idTypePaylip = Number(req.body.idTypePaylip);

      if (!idTypePaylip || idTypePaylip <= 0) {
        return res.status(400).json({
          success: false,
          message: "Thiếu kiểu phiếu lương hợp lệ",
        });
      }

      const pool = await poolPromise;

      const typeRs = await pool
        .request()
        .input("Id", sql.Int, idTypePaylip)
        .query(`
          SELECT TOP 1 Id, Code, Name
          FROM dbo.tl_TypePaylip
          WHERE Id = @Id AND IsActive = 1
        `);

      const typeRow = typeRs.recordset[0];

      if (!typeRow) {
        return res.status(400).json({
          success: false,
          message: "Kiểu phiếu lương không tồn tại hoặc đã ngưng hoạt động",
        });
      }

      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const wsName = wb.SheetNames[0];
      const ws = wb.Sheets[wsName];

      const A2 = ws["A2"]?.v ? String(ws["A2"].v).trim() : "";

      let title = "";
      let docType = "PAYSLIP";

      if (/DANH\s*SÁCH\s*THƯỞNG\s*NĂM/i.test(A2)) {
        docType = "YEAR_BONUS";
        const suffix = A2.replace(/DANH\s*SÁCH\s*THƯỞNG\s*NĂM/i, "").trim();
        title = `Phiếu tính tiền thưởng năm ${suffix}`.trim();
      } else if (/BẢNG LƯƠNG GIỮA KỲ/i.test(A2)) {
        const m = A2.match(/BẢNG LƯƠNG GIỮA KỲ.*?(\d{2}\/\d{4})/i);
        title = `Phiếu lương kỳ I tháng ${(m?.[1] || "").trim()}`;
        docType = "PAYSLIP";
      } else {
        const m = A2.match(/BẢNG LƯƠNG THÁNG.*?(\d{2}\/\d{4})/i);
        title = `Phiếu lương tháng ${(m?.[1] || "").trim()}`;
        docType = "PAYSLIP";
      }

      const jobId = createJobId();

      importJobs.set(jobId, {
        buffer: req.file.buffer,
        title,
        docType,
        idTypePaylip: typeRow.Id,
        typePaylipCode: typeRow.Code,
        typePaylipName: typeRow.Name,
        createdAt: Date.now(),
      });

      return res.json({
        success: true,
        jobId,
        title,
        docType,
        idTypePaylip: typeRow.Id,
        typePaylipName: typeRow.Name,
      });
    } catch (e) {
      console.error("import-start error:", e);
      return res.status(500).json({
        success: false,
        message: "Không thể đọc file Excel",
      });
    }
  }
);

app.get("/api/paylips/import-stream/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const job = importJobs.get(jobId);

  if (!job) return res.status(404).end("job not found");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const {
      buffer,
      title,
      docType,
      idTypePaylip,
      typePaylipCode,
      typePaylipName,
    } = job;

    const { kyTime, thangTime, namTime } = buildTimeInfoFromNow(new Date());

    const wb = XLSX.read(buffer, { type: "buffer" });
    const wsName = wb.SheetNames[0];
    const ws = wb.Sheets[wsName];

    const aoa = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      blankrows: false,
      defval: "",
      cellText: true,
    });

    const colCount = Math.max(
      ...aoa.map((r) => (Array.isArray(r) ? r.length : 0))
    );

    const headerRowIdx = aoa.findIndex((rowArr) => {
      if (!Array.isArray(rowArr)) return false;
      const rowNorm = rowArr.map((c) => norm(c || ""));
      return (
        rowNorm.some((x) => x.includes("MSNV")) &&
        rowNorm.some((x) => x.includes("HO VA TEN"))
      );
    });

    if (headerRowIdx < 0) {
      sendEvent("error", {
        message: "Không tìm thấy dòng tiêu đề (MSNV, HỌ VÀ TÊN).",
      });
      res.end();
      return;
    }

    const rowAbove = aoa[headerRowIdx - 1] || [];
    const headerRow = aoa[headerRowIdx] || [];
    const rowBelow = aoa[headerRowIdx + 1] || [];
    const headerEff = Array.from({ length: colCount }, (_, i) => {
      const h = String(headerRow[i] || "").trim();
      if (h) return h;
      const b = String(rowBelow[i] || "").trim();
      if (b) return b;
      return String(rowAbove[i] || "").trim();
    });

    const colMSNV = getIdxN(headerEff, "MSNV");
    const colNAME = getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN");

    let firstDataIdx = headerRowIdx + 1;

    if (headerRowIdx + 1 < aoa.length) {
      const maybeHdr = aoa[headerRowIdx + 1] || [];
      const ms = norm(maybeHdr[colMSNV] || "");
      const nm = norm(maybeHdr[colNAME] || "");
      if (ms === "MSNV" || nm === "HO VA TEN") firstDataIdx++;
    }

    for (let r = firstDataIdx; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const msnv = String(row[colMSNV] || "").trim();
      const theName = String(row[colNAME] || "").trim();
      const isProbablyHeader =
        norm(msnv) === "MSNV" || norm(theName) === "HO VA TEN";
      const isEmpty = row.every((v) => String(v || "").trim() === "");
      if (!isEmpty && !isProbablyHeader) {
        firstDataIdx = r;
        break;
      }
    }

    const body = aoa.slice(firstDataIdx).map((row) => {
      const out = new Array(colCount).fill("");
      for (let i = 0; i < Math.min(colCount, row.length); i++) out[i] = row[i];
      return out;
    });

    const up2 = aoa[headerRowIdx - 2] || [];
    const up1 = aoa[headerRowIdx - 1] || [];
    const dn1 = aoa[headerRowIdx + 1] || [];
    const dn2 = aoa[headerRowIdx + 2] || [];
    const carry = new Array(colCount).fill("");
    for (let i = 0; i < colCount; i++) {
      const t2 = norm(up2[i] || "");
      const t1 = norm(up1[i] || "");
      carry[i] = t2 || t1 || "";
    }

    const ref = XLSX.utils.decode_range(ws["!ref"] || "A1");

    const pool = await poolPromise;
    const userRows = await pool.request().query(`
      SELECT username, msnv 
      FROM dbo.Users
    `);

    const toKey = (s) => (s ?? "").trim().toUpperCase();
    const validIdentifiers = new Set();
    for (const r of userRows.recordset) {
      if (r.username) validIdentifiers.add(toKey(r.username));
      if (r.msnv) validIdentifiers.add(toKey(r.msnv));
    }

    // ====================== YEAR BONUS ======================
    if (docType === "YEAR_BONUS") {
      const idxY = {
        STT: getIdxN(headerEff, "STT"),
        MSNV: getIdxN(headerEff, "MSNV"),
        NAME: getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN"),
        TO: getIdxN(headerEff, "TỔ", "TO"),
        SOTHANG: getIdxN(headerEff, "SỐ THÁNG LÀM VIỆC", "SO THANG LAM VIEC"),
        XEPLOAI: getIdxN(headerEff, "XẾP LOẠI", "XEP LOAI"),

        LUONG: getIdxN(headerEff, "LƯƠNG", "LUONG"),
        TRACHNHIEM: getIdxN(headerEff, "TRÁCH NHIỆM", "TRACH NHIEM"),
        TIENXENHATRO: getIdxN(headerEff, "TIỀN XE, NHÀ TRỌ", "TIEN XE NHA TRO"),
        THUONGCL: getIdxN(headerEff, "THƯỞNG CL", "THUONG CL"),
        TONGCONGLUONG: getIdxN(headerEff, "TỔNG CỘNG LƯƠNG", "TONG CONG LUONG"),

        NGAYCONG: getIdxN(headerEff, "NGÀY CÔNG", "NGAY CONG"),
        AVG_NAM: getIdxN(
          headerEff,
          "NGÀY CÔNG BÌNH QUÂN NĂM",
          "NGAY CONG BINH QUAN NAM"
        ),
        DU_NAM: getIdxN(
          headerEff,
          "TỔNG CÔNG ĐỦ TRONG NĂM",
          "TONG CONG DU TRONG NAM"
        ),
        AVG_DU: getIdxN(
          headerEff,
          "NGÀY CÔNG BÌNH QUÂN NĂM ĐỦ",
          "NGAY CONG BINH QUAN NAM DU"
        ),

        TONGCONG: getIdxN(headerEff, "TỔNG CỘNG", "TONG CONG"),
        THUETAMTHU: getIdxN(
          headerEff,
          "TẠM THU THUẾ TNCN",
          "TAM THU THUE TNCN"
        ),
        THUCLANH: getIdxN(headerEff, "THỰC LÃNH", "THUC LANH"),
        GHICHU: getIdxN(headerEff, "GHI CHÚ", "GHI CHU"),
      };

      const bonus1Cols = getIdxAllN(
        headerEff,
        "TIỀN THƯỞNG (1THÁNG LƯƠNG)",
        "TIEN THUONG 1THANG LUONG",
        "TIEN THUONG 1 THANG LUONG"
      );
      const abcCols = getIdxAllN(
        headerEff,
        "TIỀN THƯỞNG THEO ĐÁNH GIÁ A,B,C",
        "TIEN THUONG THEO DANH GIA A B C"
      );

      const B1 = bonus1Cols[0] ?? -1;
      const B2 = bonus1Cols[1] ?? -1;
      const A1 = abcCols[0] ?? -1;
      const A2 = abcCols[1] ?? -1;

      for (const k of ["MSNV", "NAME"]) {
        if (idxY[k] < 0) {
          sendEvent("error", {
            message: `Thiếu cột bắt buộc: ${k} (Thưởng năm)`,
          });
          res.end();
          return;
        }
      }

      let inserted = 0;
      let skippedNoUser = 0;
      let failed = 0;
      let processed = 0;

      const totalRows = body.filter((row) => {
        const rawMSNV = (row[idxY.MSNV] || "").toString().trim();
        const name = (row[idxY.NAME] || "").toString().trim();
        return !!(rawMSNV || name);
      }).length;

      sendEvent("start", {
        title,
        totalRows,
        docType,
        idTypePaylip,
        typePaylipCode,
        typePaylipName,
        kyTime,
        thangTime,
        namTime,
      });

      for (let rAOA = 0; rAOA < body.length; rAOA++) {
        const row = body[rAOA];

        const rawMSNV = (row[idxY.MSNV] || "").toString().trim();
        const name = (row[idxY.NAME] || "").toString().trim();
        if (!rawMSNV && !name) continue;

        processed++;

        let status = "pending";
        let reason = "";

        if (!validIdentifiers.has(toKey(rawMSNV))) {
          skippedNoUser++;
          status = "skipped_no_user";
          reason = "Không tìm thấy user tương ứng trong hệ thống";
          sendEvent("row", {
            index: processed - 1,
            msnv: rawMSNV,
            name,
            status,
            reason,
            totalRows,
          });
          continue;
        }

        let stt = null;
        if (idxY.STT >= 0) {
          const wsRow = ref.s.r + firstDataIdx + rAOA;
          const wsCol = ref.s.c + idxY.STT;
          const sttText = getCellText(ws, wsRow, wsCol);
          stt = sttText ? Number(sttText.replace(/[^\d.-]/g, "")) : null;
        }

        const reqSql = pool.request();
        reqSql
          .input("title", sql.NVarChar(100), title)
          .input("docType", sql.NVarChar(30), "YEAR_BONUS")
          .input("IdTypePaylip", sql.Int, idTypePaylip)
          .input("kyTime", sql.Int, kyTime)
          .input("thangTime", sql.Int, thangTime)
          .input("namTime", sql.Int, namTime)
          .input("msnv", sql.NVarChar(50), rawMSNV)
          .input("stt", sql.Int, Number.isFinite(stt) ? stt : null)
          .input("name", sql.NVarChar(50), name)
          .input("basicSalary", sql.NVarChar(20), moneyStr(idxY.LUONG >= 0 ? row[idxY.LUONG] : null))
          .input("responsibility", sql.NVarChar(20), moneyStr(idxY.TRACHNHIEM >= 0 ? row[idxY.TRACHNHIEM] : null))
          .input("rent", sql.NVarChar(20), moneyStr(idxY.TIENXENHATRO >= 0 ? row[idxY.TIENXENHATRO] : null))
          .input("qualityBonus", sql.NVarChar(20), moneyStr(idxY.THUONGCL >= 0 ? row[idxY.THUONGCL] : null))
          .input("totalSalary", sql.NVarChar(20), moneyStr(idxY.TONGCONGLUONG >= 0 ? row[idxY.TONGCONGLUONG] : null))
          .input("totalWorkingDays", sql.Float, numOrNull(idxY.NGAYCONG >= 0 ? row[idxY.NGAYCONG] : null))
          .input("ktthue", sql.NVarChar(20), moneyStr(idxY.THUETAMTHU >= 0 ? row[idxY.THUETAMTHU] : null))
          .input("luongthuclanh", sql.NVarChar(20), moneyStr(idxY.THUCLANH >= 0 ? row[idxY.THUCLANH] : null))
          .input("yb_team", sql.NVarChar(30), idxY.TO >= 0 ? String(row[idxY.TO] || "").trim() : null)
          .input("yb_monthsWorked", sql.Float, numOrNull(idxY.SOTHANG >= 0 ? row[idxY.SOTHANG] : null))
          .input("yb_rating", sql.NVarChar(10), idxY.XEPLOAI >= 0 ? String(row[idxY.XEPLOAI] || "").trim() : null)
          .input("yb_avgWorkDaysYear", sql.Float, numOrNull(idxY.AVG_NAM >= 0 ? row[idxY.AVG_NAM] : null))
          .input("yb_totalEligibleDaysYear", sql.Float, numOrNull(idxY.DU_NAM >= 0 ? row[idxY.DU_NAM] : null))
          .input("yb_avgEligibleDaysYear", sql.Float, numOrNull(idxY.AVG_DU >= 0 ? row[idxY.AVG_DU] : null))
          .input("yb_bonus1MonthSalary_1", sql.NVarChar(20), moneyStr(B1 >= 0 ? row[B1] : null))
          .input("yb_bonus1MonthSalary_2", sql.NVarChar(20), moneyStr(B2 >= 0 ? row[B2] : null))
          .input("yb_bonusABC_1", sql.NVarChar(20), moneyStr(A1 >= 0 ? row[A1] : null))
          .input("yb_bonusABC_2", sql.NVarChar(20), moneyStr(A2 >= 0 ? row[A2] : null))
          .input("yb_totalBonus", sql.NVarChar(20), moneyStr(idxY.TONGCONG >= 0 ? row[idxY.TONGCONG] : null))
          .input("yb_taxWithheld", sql.NVarChar(20), moneyStr(idxY.THUETAMTHU >= 0 ? row[idxY.THUETAMTHU] : null))
          .input("yb_netPay", sql.NVarChar(20), moneyStr(idxY.THUCLANH >= 0 ? row[idxY.THUCLANH] : null))
          .input("yb_note", sql.NVarChar(200), idxY.GHICHU >= 0 ? String(row[idxY.GHICHU] || "").trim() : null);

        try {
          if (idTypePaylip === 1) {
            await reqSql.query(`
              DELETE FROM dbo.tl_Paylips
              WHERE IdTypePaylip = @IdTypePaylip
                AND kyTime = @kyTime
                AND thangTime = @thangTime
                AND namTime = @namTime
                AND msnv = @msnv;

              INSERT INTO dbo.tl_Paylips
              (
                title, docType, IdTypePaylip, kyTime, thangTime, namTime,
                msnv, stt, name,
                basicSalary, responsibility, rent, qualityBonus, totalSalary,
                totalWorkingDays, ktthue, luongthuclanh,
                yb_team, yb_monthsWorked, yb_rating,
                yb_avgWorkDaysYear, yb_totalEligibleDaysYear, yb_avgEligibleDaysYear,
                yb_bonus1MonthSalary_1, yb_bonus1MonthSalary_2,
                yb_bonusABC_1, yb_bonusABC_2,
                yb_totalBonus, yb_taxWithheld, yb_netPay, yb_note
              )
              VALUES
              (
                @title, @docType, @IdTypePaylip, @kyTime, @thangTime, @namTime,
                @msnv, @stt, @name,
                @basicSalary, @responsibility, @rent, @qualityBonus, @totalSalary,
                @totalWorkingDays, @ktthue, @luongthuclanh,
                @yb_team, @yb_monthsWorked, @yb_rating,
                @yb_avgWorkDaysYear, @yb_totalEligibleDaysYear, @yb_avgEligibleDaysYear,
                @yb_bonus1MonthSalary_1, @yb_bonus1MonthSalary_2,
                @yb_bonusABC_1, @yb_bonusABC_2,
                @yb_totalBonus, @yb_taxWithheld, @yb_netPay, @yb_note
              )
            `);
          } else {
            await reqSql.query(`
              INSERT INTO dbo.tl_Paylips
              (
                title, docType, IdTypePaylip, kyTime, thangTime, namTime,
                msnv, stt, name,
                basicSalary, responsibility, rent, qualityBonus, totalSalary,
                totalWorkingDays, ktthue, luongthuclanh,
                yb_team, yb_monthsWorked, yb_rating,
                yb_avgWorkDaysYear, yb_totalEligibleDaysYear, yb_avgEligibleDaysYear,
                yb_bonus1MonthSalary_1, yb_bonus1MonthSalary_2,
                yb_bonusABC_1, yb_bonusABC_2,
                yb_totalBonus, yb_taxWithheld, yb_netPay, yb_note
              )
              VALUES
              (
                @title, @docType, @IdTypePaylip, @kyTime, @thangTime, @namTime,
                @msnv, @stt, @name,
                @basicSalary, @responsibility, @rent, @qualityBonus, @totalSalary,
                @totalWorkingDays, @ktthue, @luongthuclanh,
                @yb_team, @yb_monthsWorked, @yb_rating,
                @yb_avgWorkDaysYear, @yb_totalEligibleDaysYear, @yb_avgEligibleDaysYear,
                @yb_bonus1MonthSalary_1, @yb_bonus1MonthSalary_2,
                @yb_bonusABC_1, @yb_bonusABC_2,
                @yb_totalBonus, @yb_taxWithheld, @yb_netPay, @yb_note
              )
            `);
          }

          inserted++;
          status = "inserted";
        } catch (err) {
          failed++;
          status = "failed";
          reason = err?.message || "Lỗi insert";
        }

        sendEvent("row", {
          index: processed - 1,
          msnv: rawMSNV,
          name,
          status,
          reason,
          totalRows,
        });
      }

      
        // Push notify (nếu bạn muốn giữ cho thưởng năm)
        try {
          const info = await notifyPayslipPublished(title);
          log("pushed:", info);
        } catch (e) {
          log("push failed:", e?.message);
        }

      sendEvent("done", {
        title,
        totalRows,
        processed,
        inserted,
        skippedNoUser,
        failed,
        docType,
        idTypePaylip,
        typePaylipCode,
        typePaylipName,
        kyTime,
        thangTime,
        namTime,
      });

      importJobs.delete(jobId);
      res.end();
      return;
    }

    // ====================== PAYSLIP ======================

    const idx = {
      STT: getIdxN(headerEff, "STT"),
      DEP: getIdxN(headerEff, "BP1", "BỘ PHẬN", "BP"),
      MSNV: getIdxN(headerEff, "MSNV"),
      NAME: getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN"),

      BASIC: getIdxN(headerEff, "LƯƠNG CB", "LUONG CB", "LƯƠNG CƠ BẢN", "LUONG CO BAN"),
      RESP: getIdxN(
        headerEff,
        "PC TRÁCH NHIỆM",
        "PC TRACH NHIEM",
        "PHỤ CẤP TRÁCH NHIỆM",
        "PHU CAP TRACH NHIEM"
      ),

      WDAY: getIdxN(headerEff, "NGÀY CÔNG CÓ HỆ SỐ", "NGAY CONG CO HE SO", "NGÀY CÔNG", "NGAY CONG"),
      HOLI: getIdxN(headerEff, "NGHỈ LỄ", "NGHI LE"),
      ACTUAL: getIdxN(headerEff, "LƯƠNG THỰC TẾ", "LUONG THUC TE"),

      OT15: getIdxN(headerEff, "TCA NGÀY", "TCA NGAY", "CA NGÀY", "CA NGAY"),
      OTS15: getIdxN(headerEff, "LƯƠNG TCA 1.5", "LUONG TCA 1.5"),
      OT18: getIdxN(headerEff, "TCA ĐÊM", "TCA DEM", "CA ĐÊM", "CA DEM"),
      OTS18: getIdxN(headerEff, "LƯƠNG TCA 1.8", "LUONG TCA 1.8"),
      OT05: getIdxN(headerEff, "TCA 0.5"),
      OTS05: getIdxN(headerEff, "LƯƠNG TCA 0.5", "LUONG TCA 0.5"),

      AL: getIdxN(headerEff, "NGHỈ PHÉP", "NGHI PHEP"),
      ALPAY: getIdxN(headerEff, "TIỀN PHÉP", "TIEN PHEP"),

      RENT: (() => {
        const pri = getIdxN(headerEff, "NHÀ TRỌ XE", "NHA TRO XE");
        if (pri >= 0) return pri;
        const headerNorm = headerEff.map((h) => norm(h || ""));
        let cand = headerNorm.findIndex(
          (h) => h.includes("NHA TRO") && h.includes("XE") && !h.includes("QUY DINH")
        );
        if (cand >= 0) return cand;
        cand = headerNorm.findIndex((h) => h.includes("NHA TRO") && h.includes("XE"));
        return cand;
      })(),

      QBON: getIdxN(headerEff, "THƯỞNG HIỆU QUẢ CÔNG VIỆC", "THUONG HIEU QUA CONG VIEC", "THƯỞNG HOÀN THÀNH CÔNG VIỆC", "THUONG HOAN THANH CONG VIEC"),
      TOTAL: getIdxN(headerEff, "TỔNG LƯƠNG", "TONG LUONG"),

      CONGNGAY: getIdxN(headerEff, "CÔNG NGÀY", "CONG NGAY", "CÔNG HÀNH CHÁNH", "CONG HANH CHANH", "CÔNG HÀNH CHÍNH", "CONG HANH CHINH"),
      CONGDEM: getIdxN(headerEff, "CÔNG ĐÊM", "CONG DEM"),
      CHOVIEC: getIdxN(headerEff, "NGHỈ CHỜ VIỆC", "NGHI CHO VIEC"),
      NGHIKHAC: getIdxN(headerEff, "NGHỈ KHÁC HƯỞNG LƯƠNG", "NGHI KHAC HUONG LUONG", "NGHỈ KHÁC", "NGHI KHAC"),
      LUONGCHOVIEC: getIdxN(headerEff, "LƯƠNG CHỜ VIỆC", "LUONG CHO VIEC"),
      LUONGKHAC: getIdxN(headerEff, "LƯƠNG KHÁC", "LUONG KHAC"),
      CHUNHAT: getIdxN(headerEff, "CHỦ NHẬT", "CHU NHAT"),
      LUONGCHUNHAT: getIdxN(headerEff, "LƯƠNG CHỦ NHẬT", "LUONG CHU NHAT"),
      HOTRO_CA: getIdxN(headerEff, "HỖ TRỢ NGHỈ GIỮA CA", "HO TRO NGHI GIUA CA"),
      HOTRO_HK: getIdxN(headerEff, "HỖ TRỢ NGÀY HÀNH KINH", "HO TRO NGAY HANH KINH"),
      CONNHO: getIdxN(headerEff, "CON NHỎ", "CON NHO"),
      THUONG1CC: getIdxN(headerEff, "THƯỞNG HIỆU QUẢ CÔNG VIỆC 1", "THUONG HIEU QUA CONG VIEC 1"),
      HOTRO_KHAC: getIdxN(headerEff, "HỖ TRỢ KHÁC", "HO TRO KHAC"),
      THUONGLE: getIdxN(headerEff, "THƯỞNG LỄ", "THUONG LE"),
      COM_TONG: getIdxN(headerEff, "CƠM TỔNG", "COM TONG"),

      KTBH: getIdxN(headerEff, "BH (XH+YT+TN)", "BH XH YT TN"),
      KTCONGDOAN: getIdxN(headerEff, "ĐOÀN PHÍ", "DOAN PHI"),
      KTLUONGKY1: getIdxN(headerEff, "TẠM ỨNG", "TAM UNG"),
      KTTHUE: getIdxN(headerEff, "THUẾ TNCN", "THUE TNCN"),
      KTKHAC: getIdxN(headerEff, "KT KHÁC", "KT KHAC"),
      KTTRUCOM: getIdxN(headerEff, "KT TIỀN CƠM", "KT TIEN COM"),

      LUONGTHUCLANH: getIdxN(headerEff, "LƯƠNG THỰC LÃNH", "LUONG THUC LANH"),
    };

    const hRowNorm = headerEff.map((h) => norm(h || ""));
    const belowNorm1 = dn1.map((h) => norm(h || ""));
    const belowNorm2 = dn2.map((h) => norm(h || ""));

    const findUnderKhauTru = (texts, groupCarry, keywords) => {
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        if (!t) continue;
        const underKT = groupCarry[i] === "KHAU TRU";
        if (!underKT) continue;
        for (const kw of keywords) {
          if (t.includes(kw)) return i;
        }
      }
      return -1;
    };

    if (idx.KTTRUCOM < 0) {
      let pos = belowNorm2.findIndex((h) => h === "KT TIEN COM");
      if (pos < 0) pos = belowNorm1.findIndex((h) => h === "KT TIEN COM");
      if (pos < 0) pos = hRowNorm.findIndex((h) => h === "KT TIEN COM");

      if (pos < 0) {
        pos = findUnderKhauTru(belowNorm2, carry, ["TIEN COM"]);
        if (pos < 0) pos = findUnderKhauTru(belowNorm1, carry, ["TIEN COM"]);
        if (pos < 0) pos = findUnderKhauTru(hRowNorm, carry, ["TIEN COM"]);
      }
      if (pos >= 0) idx.KTTRUCOM = pos;
    }

    if (idx.KTKHAC < 0) {
      let pos = belowNorm2.findIndex((h) => h === "KT KHAC");
      if (pos < 0) pos = belowNorm1.findIndex((h) => h === "KT KHAC");
      if (pos < 0) pos = hRowNorm.findIndex((h) => h === "KT KHAC");

      if (pos < 0) {
        pos = findUnderKhauTru(belowNorm2, carry, ["KHAC"]);
        if (pos < 0) pos = findUnderKhauTru(belowNorm1, carry, ["KHAC"]);
        if (pos < 0) pos = findUnderKhauTru(hRowNorm, carry, ["KHAC"]);
      }
      if (pos >= 0) idx.KTKHAC = pos;
    }

    const headerEffNorm = headerEff.map((h) => norm(h || ""));
    const allTienCom = [];
    for (let i = 0; i < colCount; i++) {
      if (headerEffNorm[i] === "TIEN COM") {
        allTienCom.push({ i, underKhauTru: carry[i] === "KHAU TRU" });
      }
    }
    const incomeTienCom = allTienCom.find((x) => !x.underKhauTru);
    const ktTienComByGroup = allTienCom.find((x) => x.underKhauTru);
    const TIENCOM_INCOME = incomeTienCom ? incomeTienCom.i : -1;
    if (idx.KTTRUCOM < 0 && ktTienComByGroup) idx.KTTRUCOM = ktTienComByGroup.i;

    for (const k of ["MSNV", "NAME"]) {
      if (idx[k] < 0) {
        sendEvent("error", { message: `Thiếu cột bắt buộc: ${k}` });
        res.end();
        return;
      }
    }

    let inserted = 0;
    let skippedNoUser = 0;
    let failed = 0;
    let processed = 0;

    const totalRows = body.filter((row) => {
      const rawMSNV = (row[idx.MSNV] || "").toString().trim();
      const name = (row[idx.NAME] || "").toString().trim();
      return !!(rawMSNV || name);
    }).length;

    sendEvent("start", {
      title,
      totalRows,
      docType: "PAYSLIP",
      idTypePaylip,
      typePaylipCode,
      typePaylipName,
      kyTime,
      thangTime,
      namTime,
    });

    for (let rAOA = 0; rAOA < body.length; rAOA++) {
      const row = body[rAOA];

      const rawMSNV = (row[idx.MSNV] || "").toString().trim();
      const name = (row[idx.NAME] || "").toString().trim();
      if (!rawMSNV && !name) continue;

      processed++;

      let status = "pending";
      let reason = "";

      if (!validIdentifiers.has(toKey(rawMSNV))) {
        skippedNoUser++;
        status = "skipped_no_user";
        reason = "Không tìm thấy user tương ứng trong hệ thống";
        sendEvent("row", {
          index: processed - 1,
          msnv: rawMSNV,
          name,
          status,
          reason,
          totalRows,
        });
        continue;
      }

      let stt = null;
      if (idx.STT >= 0) {
        const wsRow = ref.s.r + firstDataIdx + rAOA;
        const wsCol = ref.s.c + idx.STT;
        const sttText = getCellText(ws, wsRow, wsCol);
        stt = sttText ? Number(sttText.replace(/[^\d.-]/g, "")) : null;
      }

      const departmentCell = idx.DEP >= 0 ? row[idx.DEP] : ws["F6"]?.v ?? null;
      const department = departmentCell != null ? String(departmentCell).trim() : null;

      const reqSql = pool.request();
      reqSql
        .input("title", sql.NVarChar(100), title)
        .input("docType", sql.NVarChar(30), "PAYSLIP")
        .input("IdTypePaylip", sql.Int, idTypePaylip)
        .input("kyTime", sql.Int, kyTime)
        .input("thangTime", sql.Int, thangTime)
        .input("namTime", sql.Int, namTime)
        .input("msnv", sql.NVarChar(50), rawMSNV)
        .input("stt", sql.Int, Number.isFinite(stt) ? stt : null)
        .input("department", sql.NVarChar(50), department)
        .input("name", sql.NVarChar(50), name)
        .input("basicSalary", sql.NVarChar(20), moneyStr(row[idx.BASIC]))
        .input("responsibility", sql.NVarChar(20), moneyStr(row[idx.RESP]))
        .input("totalWorkingDays", sql.Float, numOrNull(row[idx.WDAY]))
        .input("holiday", sql.Float, numOrNull(row[idx.HOLI]))
        .input("actualSalary", sql.NVarChar(20), moneyStr(row[idx.ACTUAL]))
        .input("ot15", sql.Float, numOrNull(row[idx.OT15]))
        .input("otSalary15", sql.NVarChar(20), moneyStr(row[idx.OTS15]))
        .input("ot18", sql.Float, numOrNull(row[idx.OT18]))
        .input("otSalary18", sql.NVarChar(20), moneyStr(row[idx.OTS18]))
        .input("ot05", sql.Float, numOrNull(row[idx.OT05]))
        .input("otSalary05", sql.NVarChar(20), moneyStr(row[idx.OTS05]))
        .input("annualLeave", sql.Float, numOrNull(row[idx.AL]))
        .input("leavePay", sql.NVarChar(20), moneyStr(row[idx.ALPAY]))
        .input("rent", sql.NVarChar(20), moneyStr(row[idx.RENT]))
        .input("qualityBonus", sql.NVarChar(20), moneyStr(row[idx.QBON]))
        .input("totalSalary", sql.NVarChar(20), moneyStr(row[idx.TOTAL]))
        .input("conghanhchanh", sql.Float, numOrNull(row[idx.CONGNGAY]))
        .input("congcadem", sql.Float, numOrNull(row[idx.CONGDEM]))
        .input("choviec", sql.NVarChar(20), moneyStr(row[idx.CHOVIEC]))
        .input("nghikhac", sql.NVarChar(20), moneyStr(row[idx.NGHIKHAC]))
        .input("luongchoviec", sql.NVarChar(20), moneyStr(row[idx.LUONGCHOVIEC]))
        .input("luongkhac", sql.NVarChar(20), moneyStr(row[idx.LUONGKHAC]))
        .input("chunhat", sql.NVarChar(20), moneyStr(row[idx.CHUNHAT]))
        .input("luongchunhat", sql.NVarChar(20), moneyStr(row[idx.LUONGCHUNHAT]))
        .input("hotronghigiuaca", sql.NVarChar(20), moneyStr(row[idx.HOTRO_CA]))
        .input("hotrongayhanhkinh", sql.NVarChar(20), moneyStr(row[idx.HOTRO_HK]))
        .input("connho", sql.NVarChar(20), moneyStr(row[idx.CONNHO]))
        .input("thuong1CC", sql.NVarChar(20), moneyStr(row[idx.THUONG1CC]))
        .input("hotrokhac", sql.NVarChar(20), moneyStr(row[idx.HOTRO_KHAC]))
        .input("thuongle", sql.NVarChar(20), moneyStr(row[idx.THUONGLE]))
        .input("tiencomSL", sql.Float, numOrNull(row[idx.COM_TONG]))
        .input("tiencom", sql.NVarChar(20), moneyStr(TIENCOM_INCOME >= 0 ? row[TIENCOM_INCOME] : null))
        .input("ktbh", sql.NVarChar(20), moneyStr(row[idx.KTBH]))
        .input("ktcongdoan", sql.NVarChar(20), moneyStr(row[idx.KTCONGDOAN]))
        .input("ktluongky1", sql.NVarChar(20), moneyStr(row[idx.KTLUONGKY1]))
        .input("kttrucom", sql.NVarChar(20), moneyStr(idx.KTTRUCOM >= 0 ? row[idx.KTTRUCOM] : null))
        .input("ktthue", sql.NVarChar(20), moneyStr(row[idx.KTTHUE]))
        .input("ktkhac", sql.NVarChar(20), moneyStr(idx.KTKHAC >= 0 ? row[idx.KTKHAC] : null))
        .input("luongthuclanh", sql.NVarChar(20), moneyStr(row[idx.LUONGTHUCLANH]));

      try {
        if (idTypePaylip === 1) {
          await reqSql.query(`
            DELETE FROM dbo.tl_Paylips
            WHERE IdTypePaylip = @IdTypePaylip
              AND kyTime = @kyTime
              AND thangTime = @thangTime
              AND namTime = @namTime
              AND msnv = @msnv;

            INSERT INTO dbo.tl_Paylips
            (
              title, docType, IdTypePaylip, kyTime, thangTime, namTime,
              msnv, stt, department, name,
              basicSalary, responsibility, totalWorkingDays, holiday, actualSalary,
              ot15, otSalary15, ot18, otSalary18, ot05, otSalary05,
              annualLeave, leavePay, rent, qualityBonus, totalSalary,
              conghanhchanh, congcadem, choviec, nghikhac, luongchoviec, luongkhac,
              chunhat, luongchunhat, hotronghigiuaca, hotrongayhanhkinh, connho,
              thuong1CC, hotrokhac, thuongle, tiencomSL, tiencom,
              ktbh, ktcongdoan, ktluongky1, kttrucom, ktthue, ktkhac, luongthuclanh
            )
            VALUES
            (
              @title, @docType, @IdTypePaylip, @kyTime, @thangTime, @namTime,
              @msnv, @stt, @department, @name,
              @basicSalary, @responsibility, @totalWorkingDays, @holiday, @actualSalary,
              @ot15, @otSalary15, @ot18, @otSalary18, @ot05, @otSalary05,
              @annualLeave, @leavePay, @rent, @qualityBonus, @totalSalary,
              @conghanhchanh, @congcadem, @choviec, @nghikhac, @luongchoviec, @luongkhac,
              @chunhat, @luongchunhat, @hotronghigiuaca, @hotrongayhanhkinh, @connho,
              @thuong1CC, @hotrokhac, @thuongle, @tiencomSL, @tiencom,
              @ktbh, @ktcongdoan, @ktluongky1, @kttrucom, @ktthue, @ktkhac, @luongthuclanh
            )
          `);
        } else {
          await reqSql.query(`
            INSERT INTO dbo.tl_Paylips
            (
              title, docType, IdTypePaylip, kyTime, thangTime, namTime,
              msnv, stt, department, name,
              basicSalary, responsibility, totalWorkingDays, holiday, actualSalary,
              ot15, otSalary15, ot18, otSalary18, ot05, otSalary05,
              annualLeave, leavePay, rent, qualityBonus, totalSalary,
              conghanhchanh, congcadem, choviec, nghikhac, luongchoviec, luongkhac,
              chunhat, luongchunhat, hotronghigiuaca, hotrongayhanhkinh, connho,
              thuong1CC, hotrokhac, thuongle, tiencomSL, tiencom,
              ktbh, ktcongdoan, ktluongky1, kttrucom, ktthue, ktkhac, luongthuclanh
            )
            VALUES
            (
              @title, @docType, @IdTypePaylip, @kyTime, @thangTime, @namTime,
              @msnv, @stt, @department, @name,
              @basicSalary, @responsibility, @totalWorkingDays, @holiday, @actualSalary,
              @ot15, @otSalary15, @ot18, @otSalary18, @ot05, @otSalary05,
              @annualLeave, @leavePay, @rent, @qualityBonus, @totalSalary,
              @conghanhchanh, @congcadem, @choviec, @nghikhac, @luongchoviec, @luongkhac,
              @chunhat, @luongchunhat, @hotronghigiuaca, @hotrongayhanhkinh, @connho,
              @thuong1CC, @hotrokhac, @thuongle, @tiencomSL, @tiencom,
              @ktbh, @ktcongdoan, @ktluongky1, @kttrucom, @ktthue, @ktkhac, @luongthuclanh
            )
          `);
        }

        inserted++;
        status = "inserted";
      } catch (rowErr) {
        failed++;
        status = "failed";
        reason = rowErr?.message || "Lỗi insert";
        log("Row insert error:", rowErr?.message);
      }

      sendEvent("row", {
        index: processed - 1,
        msnv: rawMSNV,
        name,
        status,
        reason,
        totalRows,
      });
    }

    
        // Push notify (nếu bạn muốn giữ cho thưởng năm)
        try {
          const info = await notifyPayslipPublished(title);
          log("pushed:", info);
        } catch (e) {
          log("push failed:", e?.message);
        }

    sendEvent("done", {
      title,
      totalRows,
      processed,
      inserted,
      skippedNoUser,
      failed,
      docType: "PAYSLIP",
      idTypePaylip,
      typePaylipCode,
      typePaylipName,
      kyTime,
      thangTime,
      namTime,
    });

    importJobs.delete(jobId);
    res.end();
  } catch (e) {
    console.error("import-stream error:", e);
    try {
      res.write(`event: error\n`);
      res.write(
        `data: ${JSON.stringify({
          message: "Lỗi xử lý file hoặc lưu dữ liệu",
        })}\n\n`
      );
    } catch (_) {}
    importJobs.delete(jobId);
    res.end();
  }
});

  // =============== API LẤY PHIẾU MỚI NHẤT (GIỮ NGUYÊN) ===============
  app.get("/api/payroll/me/latest", requireAuth, async (req, res) => {
    try {
      const pool = await poolPromise;
      const loginId = (req.user?.username || "").trim();

      const rs = await pool
        .request()
        .input("loginId", sql.NVarChar(50), loginId)
        .query(`
          SELECT TOP 1 p.*
          FROM dbo.tl_Paylips AS p
          LEFT JOIN dbo.Users AS u
            ON u.msnv = p.msnv
          WHERE
            p.msnv = @loginId
            OR u.username = @loginId
          ORDER BY p.createdAt DESC, p.paylipId DESC
        `);

      return res.json({ success: true, data: rs.recordset[0] || null });
    } catch (e) {
      console.error("get payroll latest error:", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  /**
 * API khởi tạo filter:
 * - lấy danh sách kỳ lương
 * - lấy danh sách ngày thưởng
 * - mặc định trả luôn phiếu lương mới nhất
 */
app.get("/api/payroll/me/filter-init", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;
    const loginId = String(req.user?.username || "").trim();

    const userMsnv = await getCurrentUserMsnv(pool, loginId);
    const [salaryPeriods, bonusDates, latestSalary] = await Promise.all([
      getSalaryPeriods(pool, loginId, userMsnv),
      getBonusDates(pool, loginId, userMsnv),
      getLatestSalaryPayslip(pool, loginId, userMsnv),
    ]);

    const latestSalaryKey = latestSalary
      ? {
          kyTime: latestSalary.kyTime,
          thangTime: Number(latestSalary.thangTime),
          namTime: Number(latestSalary.namTime),
        }
      : null;

    return res.json({
      success: true,
      data: {
        defaultType: "luong",
        salaryPeriods,
        bonusDates,
        latestSalaryKey,
        record: latestSalary || null,
      },
    });
  } catch (e) {
    console.error("GET /api/payroll/me/filter-init error:", e);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/**
 * API lấy phiếu theo filter
 * query:
 * - type=luong&kyTime=Kỳ I&thangTime=3&namTime=2026
 * - type=thuong&date=2026-03-15
 */
app.get("/api/payroll/me/by-filter", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;
    const loginId = String(req.user?.username || "").trim();
    const userMsnv = await getCurrentUserMsnv(pool, loginId);

    const type = normalizePayType(req.query.type);

    if (type === "luong") {
      const kyTime = String(req.query.kyTime || "").trim();
      const thangTime = Number(req.query.thangTime);
      const namTime = Number(req.query.namTime);

      if (!kyTime || !Number.isFinite(thangTime) || !Number.isFinite(namTime)) {
        return res.status(400).json({
          success: false,
          message: "Thiếu kyTime / thangTime / namTime hợp lệ",
        });
      }

      const record = await getPayslipBySalaryPeriod(
        pool,
        loginId,
        userMsnv,
        kyTime,
        thangTime,
        namTime
      );

      return res.json({
        success: true,
        data: record || null,
      });
    }

    if (type === "thuong") {
      const dateValue = String(req.query.date || "").trim();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
        return res.status(400).json({
          success: false,
          message: "Ngày không hợp lệ, cần dạng YYYY-MM-DD",
        });
      }

      const record = await getPayslipByBonusDate(
        pool,
        loginId,
        userMsnv,
        dateValue
      );

      return res.json({
        success: true,
        data: record || null,
      });
    }

    return res.status(400).json({
      success: false,
      message: "type chỉ nhận 'luong' hoặc 'thuong'",
    });
  } catch (e) {
    console.error("GET /api/payroll/me/by-filter error:", e);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});


  // ================= GET LIST (search + paging) =================
  app.get("/api/type-paylip", requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 10;
      const keyword = (req.query.keyword || "").trim();

      const offset = (page - 1) * pageSize;

      const pool = await poolPromise;

      // COUNT
      const countRs = await pool
        .request()
        .input("keyword", sql.NVarChar, `%${keyword}%`)
        .query(`
          SELECT COUNT(*) AS total
          FROM tl_TypePaylip
          WHERE Code LIKE @keyword OR Name LIKE @keyword
        `);

      const total = countRs.recordset[0].total;

      // DATA
      const dataRs = await pool
        .request()
        .input("keyword", sql.NVarChar, `%${keyword}%`)
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT *
          FROM tl_TypePaylip
          WHERE Code LIKE @keyword OR Name LIKE @keyword
          ORDER BY Id DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

      res.json({
        success: true,
        data: dataRs.recordset,
        total,
        page,
        pageSize,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // ================= CREATE =================
  app.post("/api/type-paylip", requireAuth, async (req, res) => {
    try {
      const { Code, Name } = req.body;

      if (!Code || !Name) {
        return res
          .status(400)
          .json({ success: false, message: "Thiếu Code hoặc Name" });
      }

      const pool = await poolPromise;

      // check duplicate Code
      const check = await pool
        .request()
        .input("Code", sql.NVarChar, Code)
        .query(`
          SELECT 1 FROM tl_TypePaylip WHERE Code = @Code
        `);

      if (check.recordset.length > 0) {
        return res.json({
          success: false,
          message: "Code đã tồn tại",
        });
      }

      await pool
        .request()
        .input("Code", sql.NVarChar, Code)
        .input("Name", sql.NVarChar, Name)
        .query(`
          INSERT INTO tl_TypePaylip (Code, Name, CreatedAt, IsActive)
          VALUES (@Code, @Name, GETDATE(), 1)
        `);

      res.json({ success: true, message: "Thêm thành công" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // ================= UPDATE =================
  app.put("/api/type-paylip/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { Code, Name } = req.body;

      const pool = await poolPromise;

      // check duplicate Code (trừ chính nó)
      const check = await pool
        .request()
        .input("Code", sql.NVarChar, Code)
        .input("Id", sql.Int, id)
        .query(`
          SELECT 1 
          FROM tl_TypePaylip 
          WHERE Code = @Code AND Id <> @Id
        `);

      if (check.recordset.length > 0) {
        return res.json({
          success: false,
          message: "Code đã tồn tại",
        });
      }

      await pool
        .request()
        .input("Id", sql.Int, id)
        .input("Code", sql.NVarChar, Code)
        .input("Name", sql.NVarChar, Name)
        .query(`
          UPDATE tl_TypePaylip
          SET Code = @Code,
              Name = @Name
          WHERE Id = @Id
        `);

      res.json({ success: true, message: "Cập nhật thành công" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // ================= DELETE =================
  app.delete("/api/type-paylip/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const pool = await poolPromise;

      // check đang được dùng
      const checkUse = await pool
        .request()
        .input("Id", sql.Int, id)
        .query(`
          SELECT TOP 1 1 
          FROM tl_Paylips 
          WHERE IdTypePaylip = @Id
        `);

      if (checkUse.recordset.length > 0) {
        return res.json({
          success: false,
          message: "Loại này đang được sử dụng, không thể xóa",
        });
      }

      await pool
        .request()
        .input("Id", sql.Int, id)
        .query(`
          DELETE FROM tl_TypePaylip WHERE Id = @Id
        `);

      res.json({ success: true, message: "Xóa thành công" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // ================= GET ALL (dropdown) =================
  app.get("/api/type-paylip/all", requireAuth, async (req, res) => {
    try {
      const pool = await poolPromise;

      const rs = await pool.request().query(`
        SELECT Id, Code, Name
        FROM tl_TypePaylip
        WHERE IsActive = 1
        ORDER BY Id
      `);

      res.json({ success: true, data: rs.recordset });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false });
    }
  });

  app.delete("/api/paylips/history/:paylipId", requireAuth, async (req, res) => {
  try {
    const paylipId = Number(req.params.paylipId || 0);

    if (!paylipId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu paylipId",
      });
    }

    const pool = await poolPromise;

    const checkRs = await pool.request()
      .input("PaylipId", sql.Int, paylipId)
      .query(`
        SELECT TOP 1 paylipId
        FROM dbo.tl_Paylips
        WHERE paylipId = @PaylipId
      `);

    const found = checkRs.recordset?.[0];
    if (!found) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy phiếu cần xóa",
      });
    }

    await pool.request()
      .input("PaylipId", sql.Int, paylipId)
      .query(`
        DELETE FROM dbo.tl_Paylips
        WHERE paylipId = @PaylipId
      `);

    return res.json({
      success: true,
      message: "Đã xóa phiếu lương",
    });
  } catch (err) {
    console.error("delete paylip error:", err);
    return res.status(500).json({
      success: false,
      message: "Lỗi xóa phiếu lương",
    });
  }
});

  app.get("/api/paylips/history-periods", requireAuth, async (req, res) => {
  try {
    const idTypePaylip = Number(req.query.idTypePaylip || 0);

    if (!idTypePaylip) {
      return res.status(400).json({
        success: false,
        message: "Thiếu idTypePaylip",
      });
    }

    const pool = await poolPromise;
    const rs = await pool.request()
      .input("IdTypePaylip", sql.Int, idTypePaylip)
      .query(`
        SELECT DISTINCT
          kyTime,
          thangTime,
          namTime
        FROM dbo.tl_Paylips
        WHERE IdTypePaylip = @IdTypePaylip
          AND kyTime IS NOT NULL
          AND thangTime IS NOT NULL
          AND namTime IS NOT NULL
        ORDER BY namTime DESC, thangTime DESC, kyTime DESC
      `);

    res.json({
      success: true,
      data: rs.recordset || [],
    });
  } catch (err) {
    console.error("history-periods error:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi lấy danh sách kỳ lương",
    });
  }
});

app.get("/api/paylips/history-periods", requireAuth, async (req, res) => {
  try {
    const idTypePaylip = Number(req.query.idTypePaylip || 0);

    if (!idTypePaylip) {
      return res.status(400).json({
        success: false,
        message: "Thiếu idTypePaylip",
      });
    }

    const pool = await poolPromise;
    const rs = await pool.request()
      .input("IdTypePaylip", sql.Int, idTypePaylip)
      .query(`
        SELECT DISTINCT
          kyTime,
          thangTime,
          namTime
        FROM dbo.tl_Paylips
        WHERE IdTypePaylip = @IdTypePaylip
          AND kyTime IS NOT NULL
          AND thangTime IS NOT NULL
          AND namTime IS NOT NULL
        ORDER BY namTime DESC, thangTime DESC, kyTime DESC
      `);

    res.json({
      success: true,
      data: rs.recordset || [],
    });
  } catch (err) {
    console.error("history-periods error:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi lấy danh sách kỳ lương",
    });
  }
});

app.get("/api/paylips/history", requireAuth, async (req, res) => {
  try {
    const idTypePaylip = Number(req.query.idTypePaylip || 0);
    const kyTime = req.query.kyTime ? Number(req.query.kyTime) : null;
    const thangTime = req.query.thangTime ? Number(req.query.thangTime) : null;
    const namTime = req.query.namTime ? Number(req.query.namTime) : null;
    const createdDate = String(req.query.createdDate || "").trim();
    const keyword = String(req.query.keyword || "").trim();

    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.max(Number(req.query.pageSize || 10), 1);

    if (!idTypePaylip) {
      return res.status(400).json({
        success: false,
        message: "Thiếu idTypePaylip",
      });
    }

    const pool = await poolPromise;
    const reqSql = pool.request();

    reqSql.input("IdTypePaylip", sql.Int, idTypePaylip);
    reqSql.input("OffsetRows", sql.Int, (page - 1) * pageSize);
    reqSql.input("PageSize", sql.Int, pageSize);

    let whereSql = `WHERE p.IdTypePaylip = @IdTypePaylip`;

    if (kyTime != null && thangTime != null && namTime != null) {
      reqSql.input("KyTime", sql.Int, kyTime);
      reqSql.input("ThangTime", sql.Int, thangTime);
      reqSql.input("NamTime", sql.Int, namTime);

      whereSql += `
        AND p.kyTime = @KyTime
        AND p.thangTime = @ThangTime
        AND p.namTime = @NamTime
      `;
    }

    if (createdDate) {
      reqSql.input("CreatedDate", sql.Date, createdDate);
      whereSql += ` AND CONVERT(date, p.createdAt) = @CreatedDate `;
    }

    if (keyword) {
      reqSql.input("Keyword", sql.NVarChar(100), `%${keyword}%`);
      whereSql += `
        AND (
          p.msnv LIKE @Keyword
          OR p.name LIKE @Keyword
        )
      `;
    }

    const query = `
      ;WITH Base AS (
        SELECT
          p.paylipId,
          p.IdTypePaylip,
          p.kyTime,
          p.thangTime,
          p.namTime,
          p.title,
          p.msnv,
          p.name,
          p.basicSalary,
          p.luongthuclanh,
          p.yb_netPay,
          p.docType,
          p.createdAt
        FROM dbo.tl_Paylips p
        ${whereSql}
      )
      SELECT *
      FROM Base
      ORDER BY createdAt DESC, paylipId DESC
      OFFSET @OffsetRows ROWS FETCH NEXT @PageSize ROWS ONLY;

      SELECT COUNT(1) AS total
      FROM dbo.tl_Paylips p
      ${whereSql};
    `;

    const rs = await reqSql.query(query);
    const rows = rs.recordsets?.[0] || [];
    const total = rs.recordsets?.[1]?.[0]?.total || 0;

    res.json({
      success: true,
      data: rows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error("paylips/history error:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi lấy lịch sử phiếu lương",
    });
  }
});

app.get("/api/paylips/history-all-ids", requireAuth, async (req, res) => {
  try {
    const idTypePaylip = Number(req.query.idTypePaylip || 0);
    const kyTime = req.query.kyTime ? Number(req.query.kyTime) : null;
    const thangTime = req.query.thangTime ? Number(req.query.thangTime) : null;
    const namTime = req.query.namTime ? Number(req.query.namTime) : null;
    const createdDate = String(req.query.createdDate || "").trim();
    const keyword = String(req.query.keyword || "").trim();

    if (!idTypePaylip) {
      return res.status(400).json({
        success: false,
        message: "Thiếu idTypePaylip",
      });
    }

    const pool = await poolPromise;
    const reqSql = pool.request();

    reqSql.input("IdTypePaylip", sql.Int, idTypePaylip);

    let whereSql = `WHERE p.IdTypePaylip = @IdTypePaylip`;

    if (kyTime != null && thangTime != null && namTime != null) {
      reqSql.input("KyTime", sql.Int, kyTime);
      reqSql.input("ThangTime", sql.Int, thangTime);
      reqSql.input("NamTime", sql.Int, namTime);

      whereSql += `
        AND p.kyTime = @KyTime
        AND p.thangTime = @ThangTime
        AND p.namTime = @NamTime
      `;
    }

    if (createdDate) {
      reqSql.input("CreatedDate", sql.Date, createdDate);
      whereSql += ` AND CONVERT(date, p.createdAt) = @CreatedDate `;
    }

    if (keyword) {
      reqSql.input("Keyword", sql.NVarChar(100), `%${keyword}%`);
      whereSql += `
        AND (
          p.msnv LIKE @Keyword
          OR p.name LIKE @Keyword
        )
      `;
    }

    const rs = await reqSql.query(`
      SELECT p.paylipId
      FROM dbo.tl_Paylips p
      ${whereSql}
      ORDER BY p.createdAt DESC, p.paylipId DESC
    `);

    res.json({
      success: true,
      data: (rs.recordset || []).map((x) => x.paylipId),
    });
  } catch (err) {
    console.error("history-all-ids error:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi lấy danh sách ID",
    });
  }
});

app.get("/api/paylips/history/:paylipId", requireAuth, async (req, res) => {
  try {
    const paylipId = Number(req.params.paylipId || 0);

    if (!paylipId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu paylipId",
      });
    }

    const pool = await poolPromise;
    const rs = await pool.request()
      .input("PaylipId", sql.Int, paylipId)
      .query(`
        SELECT TOP 1 *
        FROM dbo.tl_Paylips
        WHERE paylipId = @PaylipId
      `);

    const row = rs.recordset?.[0];
    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy phiếu lương",
      });
    }

    res.json({
      success: true,
      data: row,
    });
  } catch (err) {
    console.error("paylip detail error:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi lấy chi tiết phiếu lương",
    });
  }
});

app.post("/api/paylips/history/delete-many", requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const validIds = ids.map((x) => Number(x)).filter((x) => x > 0);

    if (!validIds.length) {
      return res.status(400).json({
        success: false,
        message: "Danh sách ids không hợp lệ",
      });
    }

    const pool = await poolPromise;
    const reqSql = pool.request();

    const params = validIds.map((id, idx) => {
      const p = `id${idx}`;
      reqSql.input(p, sql.Int, id);
      return `@${p}`;
    });

    const rs = await reqSql.query(`
      DELETE FROM dbo.tl_Paylips
      WHERE paylipId IN (${params.join(",")})
    `);

    res.json({
      success: true,
      message: "Đã xóa nhiều phiếu lương",
      affectedRows: rs.rowsAffected?.[0] || 0,
    });
  } catch (err) {
    console.error("delete many paylips error:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi xóa nhiều phiếu lương",
    });
  }
});

}

module.exports = { apiPayrollCalculation };
