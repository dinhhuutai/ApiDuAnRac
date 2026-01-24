// // payrollImport.js
// const { sql, poolPromise } = require("../db");
// const multer = require("multer");
// const XLSX = require("xlsx");
// const { requireAuth } = require("../middleware/auth");
// const { notifyPayslipPublished } = require("../WebPush/pushServicePayslip");

// const importJobs = new Map();

// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
// });

// /* ==== Toggle debug ==== */
// const DEBUG = false;
// const log = (...args) => DEBUG && console.log("[payroll]", ...args);

// /* ==== Helpers ==== */
// function moneyStr(x) {
//   if (x == null || x === "") return null;
//   return String(x).trim();
// }
// function numOrNull(x) {
//   if (x == null || x === "") return null;
//   const n = Number(String(x).replace(/[^\d.-]/g, ""));
//   return Number.isFinite(n) ? n : null;
// }
// const norm = (s = "") =>
//   String(s)
//     .normalize("NFD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .replace(/[^a-zA-Z0-9]+/g, " ")
//     .trim()
//     .toUpperCase();

// const buildRx = (aliases = []) => {
//   const parts = aliases.map((a) => norm(a).replace(/\s+/g, "\\s*"));
//   return new RegExp(`^(${parts.join("|")})$`, "i");
// };
// const getIdxN = (header, ...aliases) => {
//   const rx = buildRx(aliases);
//   for (let i = 0; i < header.length; i++) {
//     if (rx.test(norm(header[i] || ""))) return i;
//   }
//   return -1;
// };

// function getCellText(ws, r, c) {
//   const addr = XLSX.utils.encode_cell({ r, c });
//   const cell = ws[addr];
//   if (!cell) return "";
//   if (cell.w != null) return String(cell.w).trim();
//   if (cell.v != null) return String(cell.v).trim();
//   return "";
// }

// function createJobId() {
//   return (
//     Date.now().toString(36) +
//     "-" +
//     Math.random().toString(36).slice(2, 8)
//   );
// }

// /* ==== API ==== */
// function apiPayrollCalculation(app) {
//   app.post("/api/paylips/import-start", requireAuth,
//     upload.single("file"),
//     async (req, res) => {
//       if (!req.file) {
//         return res.status(400).json({ success: false, message: "Thiếu file" });
//       }

//       try {
//         const wb = XLSX.read(req.file.buffer, { type: "buffer" });
//         const wsName = wb.SheetNames[0];
//         const ws = wb.Sheets[wsName];

//         // Lấy Title từ A2 y như logic cũ
//         const A2 = ws["A2"]?.v ? String(ws["A2"].v).trim() : "";
//         let title = "";
//         if (/BẢNG LƯƠNG GIỮA KỲ/i.test(A2)) {
//           const m = A2.match(/BẢNG LƯƠNG GIỮA KỲ.*?(\d{2}\/\d{4})/i);
//           title = `Phiếu lương kỳ I tháng ${(m?.[1] || "").trim()}`;
//         } else {
//           const m = A2.match(/BẢNG LƯƠNG THÁNG.*?(\d{2}\/\d{4})/i);
//           title = `Phiếu lương tháng ${(m?.[1] || "").trim()}`;
//         }

//         const jobId = createJobId();
//         importJobs.set(jobId, {
//           buffer: req.file.buffer,
//           title,
//           createdAt: Date.now(),
//         });

//         return res.json({
//           success: true,
//           jobId,
//           title,
//         });
//       } catch (e) {
//         console.error("import-start error:", e);
//         return res
//           .status(500)
//           .json({ success: false, message: "Không thể đọc file Excel" });
//       }
//     }
//   );

//   app.get("/api/paylips/import-stream/:jobId", async (req, res) => {
//     const { jobId } = req.params;
//     const job = importJobs.get(jobId);

//     if (!job) {
//       return res.status(404).end("job not found");
//     }

//     // SSE headers
//     res.setHeader("Content-Type", "text/event-stream");
//     res.setHeader("Cache-Control", "no-cache");
//     res.setHeader("Connection", "keep-alive");
//     // Nếu có dùng compression, nhớ bỏ qua route này trong middleware compression

//     const sendEvent = (event, data) => {
//       res.write(`event: ${event}\n`);
//       res.write(`data: ${JSON.stringify(data)}\n\n`);
//     };

//     try {
//       const { buffer, title } = job;

//       // === TỪ ĐÂY TRỞ XUỐNG: copy gần như Y NGUYÊN logic parse cũ ===
//       const wb = XLSX.read(buffer, { type: "buffer" });
//       const wsName = wb.SheetNames[0];
//       const ws = wb.Sheets[wsName];

//       // AOA
//       const aoa = XLSX.utils.sheet_to_json(ws, {
//         header: 1,
//         raw: false,
//         blankrows: false,
//         defval: "",
//         cellText: true,
//       });
//       const colCount = Math.max(
//         ...aoa.map((r) => (Array.isArray(r) ? r.length : 0))
//       );

//       // locate header row
//       const headerRowIdx = aoa.findIndex(
//         (rowArr) =>
//           Array.isArray(rowArr) &&
//           rowArr.some((c) => /MSNV/i.test(String(c || ""))) &&
//           rowArr.some((c) => /HỌ\s*VÀ\s*TÊN/i.test(String(c || "")))
//       );
//       if (headerRowIdx < 0) {
//         sendEvent("error", {
//           message: "Không tìm thấy dòng tiêu đề (MSNV, HỌ VÀ TÊN).",
//         });
//         res.end();
//         return;
//       }

//       // headerEff (row -> below -> above)
//       const rowAbove = aoa[headerRowIdx - 1] || [];
//       const headerRow = aoa[headerRowIdx] || [];
//       const rowBelow = aoa[headerRowIdx + 1] || [];
//       const headerEff = Array.from({ length: colCount }, (_, i) => {
//         const h = String(headerRow[i] || "").trim();
//         if (h) return h;
//         const b = String(rowBelow[i] || "").trim();
//         if (b) return b;
//         return String(rowAbove[i] || "").trim();
//       });

//       // first data row
//       const colMSNV = getIdxN(headerEff, "MSNV");
//       const colNAME = getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN");
//       let firstDataIdx = headerRowIdx + 1;

//       if (headerRowIdx + 1 < aoa.length) {
//         const maybeHdr = aoa[headerRowIdx + 1] || [];
//         const ms = norm(maybeHdr[colMSNV] || "");
//         const nm = norm(maybeHdr[colNAME] || "");
//         if (ms === "MSNV" || nm === "HO VA TEN") firstDataIdx++;
//       }
//       for (let r = firstDataIdx; r < aoa.length; r++) {
//         const row = aoa[r] || [];
//         const msnv = String(row[colMSNV] || "").trim();
//         const theName = String(row[colNAME] || "").trim();
//         const isProbablyHeader =
//           norm(msnv) === "MSNV" || norm(theName) === "HO VA TEN";
//         const isEmpty = row.every((v) => String(v || "").trim() === "");
//         if (!isEmpty && !isProbablyHeader) {
//           firstDataIdx = r;
//           break;
//         }
//       }

//       // body
//       const body = aoa.slice(firstDataIdx).map((row) => {
//         const out = new Array(colCount).fill("");
//         for (let i = 0; i < Math.min(colCount, row.length); i++) out[i] = row[i];
//         return out;
//       });

//       // carry (để biết cột dưới KHẤU TRỪ)
//       const up2 = aoa[headerRowIdx - 2] || [];
//       const up1 = aoa[headerRowIdx - 1] || [];
//       const dn1 = aoa[headerRowIdx + 1] || [];
//       const dn2 = aoa[headerRowIdx + 2] || [];
//       const carry = new Array(colCount).fill("");
//       for (let i = 0; i < colCount; i++) {
//         const t2 = norm(up2[i] || "");
//         const t1 = norm(up1[i] || "");
//         carry[i] = t2 || t1 || "";
//       }

//       // index map (copy y nguyên anh đang dùng)
//       const idx = {
//         STT: getIdxN(headerEff, "STT"),
//         DEP: getIdxN(headerEff, "BP1", "BỘ PHẬN", "BP"),
//         MSNV: getIdxN(headerEff, "MSNV"),
//         NAME: getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN"),

//         BASIC: getIdxN(
//           headerEff,
//           "LƯƠNG CB",
//           "LUONG CB",
//           "LƯƠNG CƠ BẢN",
//           "LUONG CO BAN"
//         ),
//         RESP: getIdxN(
//           headerEff,
//           "PC TRÁCH NHIỆM",
//           "PC TRACH NHIEM",
//           "PHỤ CẤP TRÁCH NHIỆM",
//           "PHU CAP TRACH NHIEM"
//         ),

//         WDAY: getIdxN(
//           headerEff,
//           "NGÀY CÔNG CÓ HỆ SỐ",
//           "NGAY CONG CO HE SO",
//           "NGÀY CÔNG",
//           "NGAY CONG"
//         ),
//         HOLI: getIdxN(headerEff, "NGHỈ LỄ", "NGHI LE"),
//         ACTUAL: getIdxN(headerEff, "LƯƠNG THỰC TẾ", "LUONG THUC TE"),

//         OT15: getIdxN(
//           headerEff,
//           "TCA NGÀY",
//           "TCA NGAY",
//           "CA NGÀY",
//           "CA NGAY"
//         ),
//         OTS15: getIdxN(headerEff, "LƯƠNG TCA 1.5", "LUONG TCA 1.5"),
//         OT18: getIdxN(headerEff, "TCA ĐÊM", "TCA DEM", "CA ĐÊM", "CA DEM"),
//         OTS18: getIdxN(headerEff, "LƯƠNG TCA 1.8", "LUONG TCA 1.8"),
//         OT05: getIdxN(headerEff, "TCA 0.5"),
//         OTS05: getIdxN(headerEff, "LƯƠNG TCA 0.5", "LUONG TCA 0.5"),

//         AL: getIdxN(headerEff, "NGHỈ PHÉP", "NGHI PHEP"),
//         ALPAY: getIdxN(headerEff, "TIỀN PHÉP", "TIEN PHEP"),

//         RENT: (() => {
//           const pri = getIdxN(headerEff, "NHÀ TRỌ XE", "NHA TRO XE");
//           if (pri >= 0) return pri;
//           const headerNorm = headerEff.map((h) => norm(h || ""));
//           let cand = headerNorm.findIndex(
//             (h) =>
//               h.includes("NHA TRO") &&
//               h.includes("XE") &&
//               !h.includes("QUY DINH")
//           );
//           if (cand >= 0) return cand;
//           cand = headerNorm.findIndex(
//             (h) => h.includes("NHA TRO") && h.includes("XE")
//           );
//           return cand;
//         })(),

//         QBON: getIdxN(
//           headerEff,
//           "THƯỞNG HIỆU QUẢ CÔNG VIỆC",
//           "THUONG HIEU QUA CONG VIEC"
//         ),
//         TOTAL: getIdxN(headerEff, "TỔNG LƯƠNG", "TONG LUONG"),

//         // Bổ sung
//         CONGNGAY: getIdxN(
//           headerEff,
//           "CÔNG NGÀY",
//           "CONG NGAY",
//           "CÔNG HÀNH CHÁNH",
//           "CONG HANH CHANH",
//           "CÔNG HÀNH CHÍNH",
//           "CONG HANH CHINH"
//         ),
//         CONGDEM: getIdxN(headerEff, "CÔNG ĐÊM", "CONG DEM"),
//         CHOVIEC: getIdxN(headerEff, "NGHỈ CHỜ VIỆC", "NGHI CHO VIEC"),
//         NGHIKHAC: getIdxN(
//           headerEff,
//           "NGHỈ KHÁC HƯỞNG LƯƠNG",
//           "NGHI KHAC HUONG LUONG",
//           "NGHỈ KHÁC",
//           "NGHI KHAC"
//         ),
//         LUONGCHOVIEC: getIdxN(
//           headerEff,
//           "LƯƠNG CHỜ VIỆC",
//           "LUONG CHO VIEC"
//         ),
//         LUONGKHAC: getIdxN(headerEff, "LƯƠNG KHÁC", "LUONG KHAC"),
//         CHUNHAT: getIdxN(headerEff, "CHủ NHẬT", "CHU NHAT"),
//         LUONGCHUNHAT: getIdxN(
//           headerEff,
//           "LƯƠNG CHỦ NHẬT",
//           "LUONG CHU NHAT"
//         ),
//         HOTRO_CA: getIdxN(
//           headerEff,
//           "HỖ TRỢ NGHỈ GIỮA CA",
//           "HO TRO NGHI GIUA CA"
//         ),
//         HOTRO_HK: getIdxN(
//           headerEff,
//           "HỖ TRỢ NGÀY HÀNH KINH",
//           "HO TRO NGAY HANH KINH"
//         ),
//         CONNHO: getIdxN(headerEff, "CON NHỎ", "CON NHO"),
//         THUONG1CC: getIdxN(
//           headerEff,
//           "THƯỞNG HIỆU QUẢ CÔNG VIỆC 1",
//           "THUONG HIEU QUA CONG VIEC 1"
//         ),
//         HOTRO_KHAC: getIdxN(headerEff, "HỖ TRỢ KHÁC", "HO TRO KHAC"),
//         THUONGLE: getIdxN(headerEff, "THƯỞNG LỄ", "THUONG LE"),
//         COM_TONG: getIdxN(headerEff, "CƠM TỔNG", "COM TONG"),

//         // Khấu trừ (sẽ ưu tiên pick từ hàng 6 ngay dưới)
//         KTBH: getIdxN(headerEff, "BH (XH+YT+TN)", "BH XH YT TN"),
//         KTCONGDOAN: getIdxN(headerEff, "ĐOÀN PHÍ", "DOAN PHI"),
//         KTLUONGKY1: getIdxN(headerEff, "TẠM ỨNG", "TAM UNG"),
//         KTTHUE: getIdxN(headerEff, "THUẾ TNCN", "THUE TNCN"),
//         KTKHAC: getIdxN(headerEff, "KT KHÁC", "KT KHAC"),
//         KTTRUCOM: getIdxN(headerEff, "KT TIỀN CƠM", "KT TIEN COM"),

//         LUONGTHUCLANH: getIdxN(
//           headerEff,
//           "LƯƠNG THỰC LÃNH",
//           "LUONG THUC LANH"
//         ),
//       };

//       // Ưu tiên dò ở hàng 6 cho KTTRUCOM / KTKHAC (giống code cũ)
//       const hRowNorm = headerEff.map((h) => norm(h || ""));
//       const belowNorm1 = dn1.map((h) => norm(h || ""));
//       const belowNorm2 = dn2.map((h) => norm(h || ""));

//       const findUnderKhauTru = (texts, groupCarry, keywords) => {
//         for (let i = 0; i < texts.length; i++) {
//           const t = texts[i];
//           if (!t) continue;
//           const underKT = groupCarry[i] === "KHAU TRU";
//           if (!underKT) continue;
//           for (const kw of keywords) {
//             if (t.includes(kw)) return i;
//           }
//         }
//         return -1;
//       };

//       if (idx.KTTRUCOM < 0) {
//         let pos = belowNorm2.findIndex((h) => h === "KT TIEN COM");
//         if (pos < 0) pos = belowNorm1.findIndex((h) => h === "KT TIEN COM");
//         if (pos < 0) pos = hRowNorm.findIndex((h) => h === "KT TIEN COM");

//         if (pos < 0) {
//           pos = findUnderKhauTru(belowNorm2, carry, ["TIEN COM"]);
//           if (pos < 0) pos = findUnderKhauTru(belowNorm1, carry, ["TIEN COM"]);
//           if (pos < 0) pos = findUnderKhauTru(hRowNorm, carry, ["TIEN COM"]);
//         }
//         if (pos >= 0) idx.KTTRUCOM = pos;
//       }

//       if (idx.KTKHAC < 0) {
//         let pos = belowNorm2.findIndex((h) => h === "KT KHAC");
//         if (pos < 0) pos = belowNorm1.findIndex((h) => h === "KT KHAC");
//         if (pos < 0) pos = hRowNorm.findIndex((h) => h === "KT KHAC");

//         if (pos < 0) {
//           pos = findUnderKhauTru(belowNorm2, carry, ["KHAC"]);
//           if (pos < 0) pos = findUnderKhauTru(belowNorm1, carry, ["KHAC"]);
//           if (pos < 0) pos = findUnderKhauTru(hRowNorm, carry, ["KHAC"]);
//         }
//         if (pos >= 0) idx.KTKHAC = pos;
//       }

//       // Phân biệt TIỀN CƠM thu nhập vs khấu trừ theo group
//       const headerEffNorm = headerEff.map((h) => norm(h || ""));
//       const allTienCom = [];
//       for (let i = 0; i < colCount; i++) {
//         if (headerEffNorm[i] === "TIEN COM") {
//           allTienCom.push({ i, underKhauTru: carry[i] === "KHAU TRU" });
//         }
//       }
//       const incomeTienCom = allTienCom.find((x) => !x.underKhauTru);
//       const ktTienComByGroup = allTienCom.find((x) => x.underKhauTru);
//       const TIENCOM_INCOME = incomeTienCom ? incomeTienCom.i : -1;
//       if (idx.KTTRUCOM < 0 && ktTienComByGroup)
//         idx.KTTRUCOM = ktTienComByGroup.i;

//       // Mandatory
//       for (const k of ["MSNV", "NAME"]) {
//         if (idx[k] < 0) {
//           sendEvent("error", { message: `Thiếu cột bắt buộc: ${k}` });
//           res.end();
//           return;
//         }
//       }

//       const ref = XLSX.utils.decode_range(ws["!ref"] || "A1");

//       // valid users
//       const pool = await poolPromise;
//       const userRows = await pool.request().query(`
//         SELECT username, msnv FROM dbo.Users
//       `);

//       const toKey = (s) => (s ?? "").trim().toUpperCase();
//       const validIdentifiers = new Set();
//       for (const r of userRows.recordset) {
//         if (r.username) validIdentifiers.add(toKey(r.username));
//         if (r.msnv) validIdentifiers.add(toKey(r.msnv));
//       }

//       let inserted = 0;
//       let skippedNoUser = 0;
//       let failed = 0;
//       let processed = 0;

//       const totalRows = body.filter((row) => {
//         const rawMSNV = (row[idx.MSNV] || "").toString().trim();
//         const name = (row[idx.NAME] || "").toString().trim();
//         return !!(rawMSNV || name);
//       }).length;

//       // Gửi event start cho FE biết tổng số dòng
//       sendEvent("start", { title, totalRows });

//       for (let rAOA = 0; rAOA < body.length; rAOA++) {
//         const row = body[rAOA];

//         const rawMSNV = (row[idx.MSNV] || "").toString().trim();
//         const name = (row[idx.NAME] || "").toString().trim();
//         if (!rawMSNV && !name) continue;

//         processed++;

//         // Mặc định status
//         let status = "pending";
//         let reason = "";

//         if (!validIdentifiers.has(toKey(rawMSNV))) {
//           skippedNoUser++;
//           status = "skipped_no_user";
//           reason = "Không tìm thấy user tương ứng trong hệ thống";
//           sendEvent("row", {
//             index: processed - 1,
//             msnv: rawMSNV,
//             name,
//             status,
//             reason,
//             totalRows,
//           });
//           continue;
//         }

//         // STT theo TEXT hiển thị
//         let stt = null;
//         if (idx.STT >= 0) {
//           const wsRow = ref.s.r + firstDataIdx + rAOA;
//           const wsCol = ref.s.c + idx.STT;
//           const sttText = getCellText(ws, wsRow, wsCol);
//           stt = sttText ? Number(sttText.replace(/[^\d.-]/g, "")) : null;
//         }

//         const departmentCell =
//           idx.DEP >= 0 ? row[idx.DEP] : ws["F6"]?.v ?? null;
//         const department =
//           departmentCell != null ? String(departmentCell).trim() : null;

//         const reqSql = pool.request();
//         reqSql
//           .input("title", sql.NVarChar(50), title)
//           .input("msnv", sql.NVarChar(50), rawMSNV)
//           .input("stt", sql.Int, Number.isFinite(stt) ? stt : null)
//           .input("department", sql.NVarChar(15), department)
//           .input("name", sql.NVarChar(50), name)
//           .input("basicSalary", sql.NVarChar(10), moneyStr(row[idx.BASIC]))
//           .input("responsibility", sql.NVarChar(10), moneyStr(row[idx.RESP]))
//           .input("totalWorkingDays", sql.Float, numOrNull(row[idx.WDAY]))
//           .input("holiday", sql.Float, numOrNull(row[idx.HOLI]))
//           .input("actualSalary", sql.NVarChar(10), moneyStr(row[idx.ACTUAL]))
//           .input("ot15", sql.Float, numOrNull(row[idx.OT15]))
//           .input("otSalary15", sql.NVarChar(10), moneyStr(row[idx.OTS15]))
//           .input("ot18", sql.Float, numOrNull(row[idx.OT18]))
//           .input("otSalary18", sql.NVarChar(10), moneyStr(row[idx.OTS18]))
//           .input("ot05", sql.Float, numOrNull(row[idx.OT05]))
//           .input("otSalary05", sql.NVarChar(10), moneyStr(row[idx.OTS05]))
//           .input("annualLeave", sql.Float, numOrNull(row[idx.AL]))
//           .input("leavePay", sql.NVarChar(10), moneyStr(row[idx.ALPAY]))
//           .input("rent", sql.NVarChar(10), moneyStr(row[idx.RENT]))
//           .input("qualityBonus", sql.NVarChar(10), moneyStr(row[idx.QBON]))
//           .input("totalSalary", sql.NVarChar(10), moneyStr(row[idx.TOTAL]))

//           .input("conghanhchanh", sql.Float, numOrNull(row[idx.CONGNGAY]))
//           .input("congcadem", sql.Float, numOrNull(row[idx.CONGDEM]))
//           .input("choviec", sql.NVarChar(10), moneyStr(row[idx.CHOVIEC]))
//           .input("nghikhac", sql.NVarChar(10), moneyStr(row[idx.NGHIKHAC]))
//           .input(
//             "luongchoviec",
//             sql.NVarChar(10),
//             moneyStr(row[idx.LUONGCHOVIEC])
//           )
//           .input(
//             "luongkhac",
//             sql.NVarChar(10),
//             moneyStr(row[idx.LUONGKHAC])
//           )
//           .input("chunhat", sql.NVarChar(10), moneyStr(row[idx.CHUNHAT]))
//           .input(
//             "luongchunhat",
//             sql.NVarChar(10),
//             moneyStr(row[idx.LUONGCHUNHAT])
//           )
//           .input(
//             "hotronghigiuaca",
//             sql.NVarChar(10),
//             moneyStr(row[idx.HOTRO_CA])
//           )
//           .input(
//             "hotrongayhanhkinh",
//             sql.NVarChar(10),
//             moneyStr(row[idx.HOTRO_HK])
//           )
//           .input("connho", sql.NVarChar(10), moneyStr(row[idx.CONNHO]))
//           .input("thuong1CC", sql.NVarChar(10), moneyStr(row[idx.THUONG1CC]))
//           .input("hotrokhac", sql.NVarChar(10), moneyStr(row[idx.HOTRO_KHAC]))
//           .input("thuongle", sql.NVarChar(10), moneyStr(row[idx.THUONGLE]))
//           .input("tiencomSL", sql.Float, numOrNull(row[idx.COM_TONG]))
//           .input(
//             "tiencom",
//             sql.NVarChar(10),
//             moneyStr(TIENCOM_INCOME >= 0 ? row[TIENCOM_INCOME] : null)
//           )
//           .input("ktbh", sql.NVarChar(10), moneyStr(row[idx.KTBH]))
//           .input(
//             "ktcongdoan",
//             sql.NVarChar(10),
//             moneyStr(row[idx.KTCONGDOAN])
//           )
//           .input(
//             "ktluongky1",
//             sql.NVarChar(10),
//             moneyStr(row[idx.KTLUONGKY1])
//           )
//           .input(
//             "kttrucom",
//             sql.NVarChar(10),
//             moneyStr(idx.KTTRUCOM >= 0 ? row[idx.KTTRUCOM] : null)
//           )
//           .input("ktthue", sql.NVarChar(10), moneyStr(row[idx.KTTHUE]))
//           .input(
//             "ktkhac",
//             sql.NVarChar(10),
//             moneyStr(idx.KTKHAC >= 0 ? row[idx.KTKHAC] : null)
//           )
//           .input(
//             "luongthuclanh",
//             sql.NVarChar(10),
//             moneyStr(row[idx.LUONGTHUCLANH])
//           );

//         try {
//           await reqSql.query(`
//             INSERT INTO dbo.tl_Paylips
//             (
//               title, msnv, stt, department, name,
//               basicSalary, responsibility, totalWorkingDays, holiday, actualSalary,
//               ot15, otSalary15, ot18, otSalary18, ot05, otSalary05,
//               annualLeave, leavePay, rent, qualityBonus, totalSalary,
//               conghanhchanh, congcadem, choviec, nghikhac, luongchoviec, luongkhac,
//               chunhat, luongchunhat, hotronghigiuaca, hotrongayhanhkinh, connho,
//               thuong1CC, hotrokhac, thuongle, tiencomSL, tiencom,
//               ktbh, ktcongdoan, ktluongky1, kttrucom, ktthue, ktkhac, luongthuclanh
//             )
//             VALUES
//             (
//               @title, @msnv, @stt, @department, @name,
//               @basicSalary, @responsibility, @totalWorkingDays, @holiday, @actualSalary,
//               @ot15, @otSalary15, @ot18, @otSalary18, @ot05, @otSalary05,
//               @annualLeave, @leavePay, @rent, @qualityBonus, @totalSalary,
//               @conghanhchanh, @congcadem, @choviec, @nghikhac, @luongchoviec, @luongkhac,
//               @chunhat, @luongchunhat, @hotronghigiuaca, @hotrongayhanhkinh, @connho,
//               @thuong1CC, @hotrokhac, @thuongle, @tiencomSL, @tiencom,
//               @ktbh, @ktcongdoan, @ktluongky1, @kttrucom, @ktthue, @ktkhac, @luongthuclanh
//             )
//           `);

//           inserted++;
//           status = "inserted";
//         } catch (rowErr) {
//           failed++;
//           status = "failed";
//           reason = rowErr?.message || "Lỗi insert";
//           log("Row insert error:", rowErr?.message);
//         }

//         // gửi event row cho FE
//         sendEvent("row", {
//           index: processed - 1,
//           msnv: rawMSNV,
//           name,
//           status,
//           reason,
//           totalRows,
//         });
//       }

//       // Gửi push notify khi đã import xong
// try {
//   const info = await notifyPayslipPublished(title);
//   log("pushed:", info);
// } catch (e) {
//   log("push failed:", e?.message);
// }

//       // done
//       sendEvent("done", {
//         title,
//         totalRows,
//         processed,
//         inserted,
//         skippedNoUser,
//         failed,
//       });

//       importJobs.delete(jobId);
//       res.end();
//     } catch (e) {
//       console.error("import-stream error:", e);
//       try {
//         sendEvent("error", { message: "Lỗi xử lý file hoặc lưu dữ liệu" });
//       } catch (_) {}
//       importJobs.delete(jobId);
//       res.end();
//     }
//   });

//   app.get("/api/payroll/me/latest", requireAuth, async (req, res) => {
//     try {
//       const pool = await poolPromise;

//       // loginId là thứ người dùng đăng nhập (thường là username; đôi khi chính là msnv)
//       const loginId = (req.user?.username || "").trim();

//       const rs = await pool
//         .request()
//         .input("loginId", sql.NVarChar(50), loginId)
//         .query(`
//           SELECT TOP 1 p.*
//           FROM dbo.tl_Paylips AS p
//           LEFT JOIN dbo.Users AS u
//             ON u.msnv = p.msnv
//           WHERE
//             p.msnv = @loginId       -- khớp trực tiếp nếu msnv trong phiếu = username đăng nhập
//             OR u.username = @loginId -- hoặc khớp nếu msnv của phiếu là msnv của user có username = loginId
//           ORDER BY p.createdAt DESC, p.paylipId DESC
//         `);

//       return res.json({ success: true, data: rs.recordset[0] || null });
//     } catch (e) {
//       console.error("get payroll latest error:", e);
//       return res.status(500).json({ success: false, message: "Server error" });
//     }
//   });

// }

// module.exports = { apiPayrollCalculation };





// payrollImport.js
const { sql, poolPromise } = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { requireAuth } = require("../middleware/auth");
const { notifyPayslipPublished } = require("../WebPush/pushServicePayslip");

const importJobs = new Map();

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

/* ==== API ==== */
function apiPayrollCalculation(app) {
  // =============== IMPORT START ===============
  app.post(
    "/api/paylips/import-start",
    requireAuth,
    upload.single("file"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ success: false, message: "Thiếu file" });
      }

      try {
        const wb = XLSX.read(req.file.buffer, { type: "buffer" });
        const wsName = wb.SheetNames[0];
        const ws = wb.Sheets[wsName];

        // Lấy Title từ A2
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
        } else {
          const m = A2.match(/BẢNG LƯƠNG THÁNG.*?(\d{2}\/\d{4})/i);
          title = `Phiếu lương tháng ${(m?.[1] || "").trim()}`;
        }

        const jobId = createJobId();
        importJobs.set(jobId, {
          buffer: req.file.buffer,
          title,
          docType,
          createdAt: Date.now(),
        });

        return res.json({ success: true, jobId, title, docType });
      } catch (e) {
        console.error("import-start error:", e);
        return res
          .status(500)
          .json({ success: false, message: "Không thể đọc file Excel" });
      }
    }
  );

  // =============== IMPORT STREAM (SSE) ===============
  app.get("/api/paylips/import-stream/:jobId", async (req, res) => {
    const { jobId } = req.params;
    const job = importJobs.get(jobId);

    if (!job) return res.status(404).end("job not found");

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { buffer, title, docType } = job;

      const wb = XLSX.read(buffer, { type: "buffer" });
      const wsName = wb.SheetNames[0];
      const ws = wb.Sheets[wsName];

      // AOA
      const aoa = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        raw: false,
        blankrows: false,
        defval: "",
        cellText: true,
      });
      const colCount = Math.max(...aoa.map((r) => (Array.isArray(r) ? r.length : 0)));

      // ✅ locate header row (FIX bằng norm để chịu wrap/Unicode)
      const headerRowIdx = aoa.findIndex((rowArr) => {
        if (!Array.isArray(rowArr)) return false;
        const rowNorm = rowArr.map((c) => norm(c || ""));
        return rowNorm.some((x) => x.includes("MSNV")) && rowNorm.some((x) => x.includes("HO VA TEN"));
      });

      if (headerRowIdx < 0) {
        sendEvent("error", { message: "Không tìm thấy dòng tiêu đề (MSNV, HỌ VÀ TÊN)." });
        res.end();
        return;
      }

      // headerEff (row -> below -> above)
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

      // first data row
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
        const isProbablyHeader = norm(msnv) === "MSNV" || norm(theName) === "HO VA TEN";
        const isEmpty = row.every((v) => String(v || "").trim() === "");
        if (!isEmpty && !isProbablyHeader) {
          firstDataIdx = r;
          break;
        }
      }

      // body
      const body = aoa.slice(firstDataIdx).map((row) => {
        const out = new Array(colCount).fill("");
        for (let i = 0; i < Math.min(colCount, row.length); i++) out[i] = row[i];
        return out;
      });

      // carry (để biết cột dưới KHẤU TRỪ)
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

      // valid users
      const pool = await poolPromise;
      const userRows = await pool.request().query(`SELECT username, msnv FROM dbo.Users`);

      const toKey = (s) => (s ?? "").trim().toUpperCase();
      const validIdentifiers = new Set();
      for (const r of userRows.recordset) {
        if (r.username) validIdentifiers.add(toKey(r.username));
        if (r.msnv) validIdentifiers.add(toKey(r.msnv));
      }

      // ====================== YEAR BONUS BRANCH ======================
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
          AVG_NAM: getIdxN(headerEff, "NGÀY CÔNG BÌNH QUÂN NĂM", "NGAY CONG BINH QUAN NAM"),
          DU_NAM: getIdxN(headerEff, "TỔNG CÔNG ĐỦ TRONG NĂM", "TONG CONG DU TRONG NAM"),
          AVG_DU: getIdxN(headerEff, "NGÀY CÔNG BÌNH QUÂN NĂM ĐỦ", "NGAY CONG BINH QUAN NAM DU"),

          TONGCONG: getIdxN(headerEff, "TỔNG CỘNG", "TONG CONG"),
          THUETAMTHU: getIdxN(headerEff, "TẠM THU THUẾ TNCN", "TAM THU THUE TNCN"),
          THUCLANH: getIdxN(headerEff, "THỰC LÃNH", "THUC LANH"),
          GHICHU: getIdxN(headerEff, "GHI CHÚ", "GHI CHU"),
        };

        // 2 cột trùng tên => lấy theo thứ tự xuất hiện
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

        // Mandatory
        for (const k of ["MSNV", "NAME"]) {
          if (idxY[k] < 0) {
            sendEvent("error", { message: `Thiếu cột bắt buộc: ${k} (Thưởng năm)` });
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

        sendEvent("start", { title, totalRows, docType });

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
            sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
            continue;
          }

          // STT theo TEXT hiển thị
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
            .input("msnv", sql.NVarChar(50), rawMSNV)
            .input("stt", sql.Int, Number.isFinite(stt) ? stt : null)
            .input("name", sql.NVarChar(50), name)

            // Reuse cột cũ (nếu bạn muốn)
            .input("basicSalary", sql.NVarChar(10), moneyStr(idxY.LUONG >= 0 ? row[idxY.LUONG] : null))
            .input("responsibility", sql.NVarChar(10), moneyStr(idxY.TRACHNHIEM >= 0 ? row[idxY.TRACHNHIEM] : null))
            .input("rent", sql.NVarChar(10), moneyStr(idxY.TIENXENHATRO >= 0 ? row[idxY.TIENXENHATRO] : null))
            .input("qualityBonus", sql.NVarChar(10), moneyStr(idxY.THUONGCL >= 0 ? row[idxY.THUONGCL] : null))
            .input("totalSalary", sql.NVarChar(10), moneyStr(idxY.TONGCONGLUONG >= 0 ? row[idxY.TONGCONGLUONG] : null))
            .input("totalWorkingDays", sql.Float, numOrNull(idxY.NGAYCONG >= 0 ? row[idxY.NGAYCONG] : null))
            .input("ktthue", sql.NVarChar(10), moneyStr(idxY.THUETAMTHU >= 0 ? row[idxY.THUETAMTHU] : null))
            .input("luongthuclanh", sql.NVarChar(10), moneyStr(idxY.THUCLANH >= 0 ? row[idxY.THUCLANH] : null))

            // Các cột mới yb_*
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
            await reqSql.query(`
              INSERT INTO dbo.tl_Paylips
              (
                title, docType, msnv, stt, name,

                -- reuse cột cũ
                basicSalary, responsibility, rent, qualityBonus, totalSalary,
                totalWorkingDays, ktthue, luongthuclanh,

                -- yb_*
                yb_team, yb_monthsWorked, yb_rating,
                yb_avgWorkDaysYear, yb_totalEligibleDaysYear, yb_avgEligibleDaysYear,
                yb_bonus1MonthSalary_1, yb_bonus1MonthSalary_2,
                yb_bonusABC_1, yb_bonusABC_2,
                yb_totalBonus, yb_taxWithheld, yb_netPay, yb_note
              )
              VALUES
              (
                @title, @docType, @msnv, @stt, @name,

                @basicSalary, @responsibility, @rent, @qualityBonus, @totalSalary,
                @totalWorkingDays, @ktthue, @luongthuclanh,

                @yb_team, @yb_monthsWorked, @yb_rating,
                @yb_avgWorkDaysYear, @yb_totalEligibleDaysYear, @yb_avgEligibleDaysYear,
                @yb_bonus1MonthSalary_1, @yb_bonus1MonthSalary_2,
                @yb_bonusABC_1, @yb_bonusABC_2,
                @yb_totalBonus, @yb_taxWithheld, @yb_netPay, @yb_note
              )
            `);

            inserted++;
            status = "inserted";
          } catch (err) {
            failed++;
            status = "failed";
            reason = err?.message || "Lỗi insert";
          }

          sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
        }

        // Push notify (nếu bạn muốn giữ cho thưởng năm)
        try {
          const info = await notifyPayslipPublished(title);
          log("pushed:", info);
        } catch (e) {
          log("push failed:", e?.message);
        }

        sendEvent("done", { title, totalRows, processed, inserted, skippedNoUser, failed, docType });

        importJobs.delete(jobId);
        res.end();
        return;
      }

      // ====================== PAYSLIP BRANCH (CODE CŨ CỦA BẠN) ======================

      // index map (copy y nguyên anh đang dùng)
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
          let cand = headerNorm.findIndex((h) => h.includes("NHA TRO") && h.includes("XE") && !h.includes("QUY DINH"));
          if (cand >= 0) return cand;
          cand = headerNorm.findIndex((h) => h.includes("NHA TRO") && h.includes("XE"));
          return cand;
        })(),

        QBON: getIdxN(headerEff, "THƯỞNG HIỆU QUẢ CÔNG VIỆC", "THUONG HIEU QUA CONG VIEC"),
        TOTAL: getIdxN(headerEff, "TỔNG LƯƠNG", "TONG LUONG"),

        // Bổ sung
        CONGNGAY: getIdxN(headerEff, "CÔNG NGÀY", "CONG NGAY", "CÔNG HÀNH CHÁNH", "CONG HANH CHANH", "CÔNG HÀNH CHÍNH", "CONG HANH CHINH"),
        CONGDEM: getIdxN(headerEff, "CÔNG ĐÊM", "CONG DEM"),
        CHOVIEC: getIdxN(headerEff, "NGHỈ CHỜ VIỆC", "NGHI CHO VIEC"),
        NGHIKHAC: getIdxN(headerEff, "NGHỈ KHÁC HƯỞNG LƯƠNG", "NGHI KHAC HUONG LUONG", "NGHỈ KHÁC", "NGHI KHAC"),
        LUONGCHOVIEC: getIdxN(headerEff, "LƯƠNG CHỜ VIỆC", "LUONG CHO VIEC"),
        LUONGKHAC: getIdxN(headerEff, "LƯƠNG KHÁC", "LUONG KHAC"),
        CHUNHAT: getIdxN(headerEff, "CHủ NHẬT", "CHU NHAT"),
        LUONGCHUNHAT: getIdxN(headerEff, "LƯƠNG CHỦ NHẬT", "LUONG CHU NHAT"),
        HOTRO_CA: getIdxN(headerEff, "HỖ TRỢ NGHỈ GIỮA CA", "HO TRO NGHI GIUA CA"),
        HOTRO_HK: getIdxN(headerEff, "HỖ TRỢ NGÀY HÀNH KINH", "HO TRO NGAY HANH KINH"),
        CONNHO: getIdxN(headerEff, "CON NHỎ", "CON NHO"),
        THUONG1CC: getIdxN(headerEff, "THƯỞNG HIỆU QUẢ CÔNG VIỆC 1", "THUONG HIEU QUA CONG VIEC 1"),
        HOTRO_KHAC: getIdxN(headerEff, "HỖ TRỢ KHÁC", "HO TRO KHAC"),
        THUONGLE: getIdxN(headerEff, "THƯỞNG LỄ", "THUONG LE"),
        COM_TONG: getIdxN(headerEff, "CƠM TỔNG", "COM TONG"),

        // Khấu trừ
        KTBH: getIdxN(headerEff, "BH (XH+YT+TN)", "BH XH YT TN"),
        KTCONGDOAN: getIdxN(headerEff, "ĐOÀN PHÍ", "DOAN PHI"),
        KTLUONGKY1: getIdxN(headerEff, "TẠM ỨNG", "TAM UNG"),
        KTTHUE: getIdxN(headerEff, "THUẾ TNCN", "THUE TNCN"),
        KTKHAC: getIdxN(headerEff, "KT KHÁC", "KT KHAC"),
        KTTRUCOM: getIdxN(headerEff, "KT TIỀN CƠM", "KT TIEN COM"),

        LUONGTHUCLANH: getIdxN(headerEff, "LƯƠNG THỰC LÃNH", "LUONG THUC LANH"),
      };

      // Ưu tiên dò ở hàng 6 cho KTTRUCOM / KTKHAC (giống code cũ)
      const hRowNorm = headerEff.map((h) => norm(h || ""));
      const belowNorm1 = dn1.map((h) => norm(h || ""));
      const belowNorm2 = dn2.map((h) => norm(h || ""));

      const findUnderKhauTru = (texts, groupCarry, keywords) => {
        for (let i = 0; i < texts.length; i++) {
          const t = texts[i];
          if (!t) continue;
          const underKT = groupCarry[i] === "KHAU TRU";
          if (!underKT) continue;
          for (const kw of keywords) if (t.includes(kw)) return i;
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

      // Phân biệt TIỀN CƠM thu nhập vs khấu trừ theo group
      const headerEffNorm = headerEff.map((h) => norm(h || ""));
      const allTienCom = [];
      for (let i = 0; i < colCount; i++) {
        if (headerEffNorm[i] === "TIEN COM") allTienCom.push({ i, underKhauTru: carry[i] === "KHAU TRU" });
      }
      const incomeTienCom = allTienCom.find((x) => !x.underKhauTru);
      const ktTienComByGroup = allTienCom.find((x) => x.underKhauTru);
      const TIENCOM_INCOME = incomeTienCom ? incomeTienCom.i : -1;
      if (idx.KTTRUCOM < 0 && ktTienComByGroup) idx.KTTRUCOM = ktTienComByGroup.i;

      // Mandatory
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

      sendEvent("start", { title, totalRows, docType: "PAYSLIP" });

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
          sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
          continue;
        }

        // STT theo TEXT hiển thị
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
          .input("title", sql.NVarChar(50), title)
          .input("msnv", sql.NVarChar(50), rawMSNV)
          .input("stt", sql.Int, Number.isFinite(stt) ? stt : null)
          .input("department", sql.NVarChar(15), department)
          .input("name", sql.NVarChar(50), name)
          .input("basicSalary", sql.NVarChar(10), moneyStr(row[idx.BASIC]))
          .input("responsibility", sql.NVarChar(10), moneyStr(row[idx.RESP]))
          .input("totalWorkingDays", sql.Float, numOrNull(row[idx.WDAY]))
          .input("holiday", sql.Float, numOrNull(row[idx.HOLI]))
          .input("actualSalary", sql.NVarChar(10), moneyStr(row[idx.ACTUAL]))
          .input("ot15", sql.Float, numOrNull(row[idx.OT15]))
          .input("otSalary15", sql.NVarChar(10), moneyStr(row[idx.OTS15]))
          .input("ot18", sql.Float, numOrNull(row[idx.OT18]))
          .input("otSalary18", sql.NVarChar(10), moneyStr(row[idx.OTS18]))
          .input("ot05", sql.Float, numOrNull(row[idx.OT05]))
          .input("otSalary05", sql.NVarChar(10), moneyStr(row[idx.OTS05]))
          .input("annualLeave", sql.Float, numOrNull(row[idx.AL]))
          .input("leavePay", sql.NVarChar(10), moneyStr(row[idx.ALPAY]))
          .input("rent", sql.NVarChar(10), moneyStr(row[idx.RENT]))
          .input("qualityBonus", sql.NVarChar(10), moneyStr(row[idx.QBON]))
          .input("totalSalary", sql.NVarChar(10), moneyStr(row[idx.TOTAL]))

          .input("conghanhchanh", sql.Float, numOrNull(row[idx.CONGNGAY]))
          .input("congcadem", sql.Float, numOrNull(row[idx.CONGDEM]))
          .input("choviec", sql.NVarChar(10), moneyStr(row[idx.CHOVIEC]))
          .input("nghikhac", sql.NVarChar(10), moneyStr(row[idx.NGHIKHAC]))
          .input("luongchoviec", sql.NVarChar(10), moneyStr(row[idx.LUONGCHOVIEC]))
          .input("luongkhac", sql.NVarChar(10), moneyStr(row[idx.LUONGKHAC]))
          .input("chunhat", sql.NVarChar(10), moneyStr(row[idx.CHUNHAT]))
          .input("luongchunhat", sql.NVarChar(10), moneyStr(row[idx.LUONGCHUNHAT]))
          .input("hotronghigiuaca", sql.NVarChar(10), moneyStr(row[idx.HOTRO_CA]))
          .input("hotrongayhanhkinh", sql.NVarChar(10), moneyStr(row[idx.HOTRO_HK]))
          .input("connho", sql.NVarChar(10), moneyStr(row[idx.CONNHO]))
          .input("thuong1CC", sql.NVarChar(10), moneyStr(row[idx.THUONG1CC]))
          .input("hotrokhac", sql.NVarChar(10), moneyStr(row[idx.HOTRO_KHAC]))
          .input("thuongle", sql.NVarChar(10), moneyStr(row[idx.THUONGLE]))
          .input("tiencomSL", sql.Float, numOrNull(row[idx.COM_TONG]))
          .input("tiencom", sql.NVarChar(10), moneyStr(TIENCOM_INCOME >= 0 ? row[TIENCOM_INCOME] : null))
          .input("ktbh", sql.NVarChar(10), moneyStr(row[idx.KTBH]))
          .input("ktcongdoan", sql.NVarChar(10), moneyStr(row[idx.KTCONGDOAN]))
          .input("ktluongky1", sql.NVarChar(10), moneyStr(row[idx.KTLUONGKY1]))
          .input("kttrucom", sql.NVarChar(10), moneyStr(idx.KTTRUCOM >= 0 ? row[idx.KTTRUCOM] : null))
          .input("ktthue", sql.NVarChar(10), moneyStr(row[idx.KTTHUE]))
          .input("ktkhac", sql.NVarChar(10), moneyStr(idx.KTKHAC >= 0 ? row[idx.KTKHAC] : null))
          .input("luongthuclanh", sql.NVarChar(10), moneyStr(row[idx.LUONGTHUCLANH]));

        try {
          await reqSql.query(`
            INSERT INTO dbo.tl_Paylips
            (
              title, msnv, stt, department, name,
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
              @title, @msnv, @stt, @department, @name,
              @basicSalary, @responsibility, @totalWorkingDays, @holiday, @actualSalary,
              @ot15, @otSalary15, @ot18, @otSalary18, @ot05, @otSalary05,
              @annualLeave, @leavePay, @rent, @qualityBonus, @totalSalary,
              @conghanhchanh, @congcadem, @choviec, @nghikhac, @luongchoviec, @luongkhac,
              @chunhat, @luongchunhat, @hotronghigiuaca, @hotrongayhanhkinh, @connho,
              @thuong1CC, @hotrokhac, @thuongle, @tiencomSL, @tiencom,
              @ktbh, @ktcongdoan, @ktluongky1, @kttrucom, @ktthue, @ktkhac, @luongthuclanh
            )
          `);

          inserted++;
          status = "inserted";
        } catch (rowErr) {
          failed++;
          status = "failed";
          reason = rowErr?.message || "Lỗi insert";
          log("Row insert error:", rowErr?.message);
        }

        sendEvent("row", { index: processed - 1, msnv: rawMSNV, name, status, reason, totalRows });
      }

      // Push notify khi import xong (lương)
      try {
        const info = await notifyPayslipPublished(title);
        log("pushed:", info);
      } catch (e) {
        log("push failed:", e?.message);
      }

      sendEvent("done", { title, totalRows, processed, inserted, skippedNoUser, failed, docType: "PAYSLIP" });

      importJobs.delete(jobId);
      res.end();
    } catch (e) {
      console.error("import-stream error:", e);
      try {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: "Lỗi xử lý file hoặc lưu dữ liệu" })}\n\n`);
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
}

module.exports = { apiPayrollCalculation };
