// payrollImport.js
const { sql, poolPromise } = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { requireAuth } = require("../middleware/auth");
const { notifyPayslipPublished } = require("../WebPush/pushServicePayslip");

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

function getCellText(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if (!cell) return "";
  if (cell.w != null) return String(cell.w).trim();
  if (cell.v != null) return String(cell.v).trim();
  return "";
}

/* ==== API ==== */
function apiPayrollCalculation(app) {
  app.post("/api/paylips/import", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Thiếu file" });

    try {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const wsName = wb.SheetNames[0];
      const ws = wb.Sheets[wsName];

      // A2 -> Title
      const A2 = ws["A2"]?.v ? String(ws["A2"].v).trim() : "";
      let title = "";
      if (/BẢNG LƯƠNG GIỮA KỲ/i.test(A2)) {
        const m = A2.match(/BẢNG LƯƠNG GIỮA KỲ.*?(\d{2}\/\d{4})/i);
        title = `Phiếu lương kỳ I tháng ${(m?.[1] || "").trim()}`;
      } else {
        const m = A2.match(/BẢNG LƯƠNG THÁNG.*?(\d{2}\/\d{4})/i);
        title = `Phiếu lương tháng ${(m?.[1] || "").trim()}`;
      }

      // AOA
      const aoa = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        raw: false,
        blankrows: false,
        defval: "",
        cellText: true,
      });
      const colCount = Math.max(...aoa.map((r) => (Array.isArray(r) ? r.length : 0)));

      // locate header row
      const headerRowIdx = aoa.findIndex(
        (rowArr) =>
          Array.isArray(rowArr) &&
          rowArr.some((c) => /MSNV/i.test(String(c || ""))) &&
          rowArr.some((c) => /HỌ\s*VÀ\s*TÊN/i.test(String(c || "")))
      );
      if (headerRowIdx < 0) {
        return res.status(400).json({ message: "Không tìm thấy dòng tiêu đề (MSNV, HỌ VÀ TÊN)." });
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

      // ===== carry (để biết cột dưới KHẤU TRỪ) =====
      const up2 = aoa[headerRowIdx - 2] || [];
      const up1 = aoa[headerRowIdx - 1] || [];
      const dn1 = aoa[headerRowIdx + 1] || []; // hàng 5 trong hình
      const dn2 = aoa[headerRowIdx + 2] || []; // hàng 6 trong hình (ưu tiên)
      const carry = new Array(colCount).fill("");
      for (let i = 0; i < colCount; i++) {
        const t2 = norm(up2[i] || "");
        const t1 = norm(up1[i] || "");
        carry[i] = t2 || t1 || "";
      }

      // index map
      const idx = {
        STT: getIdxN(headerEff, "STT"),
        DEP: getIdxN(headerEff, "BP1", "BỘ PHẬN", "BP"),
        MSNV: getIdxN(headerEff, "MSNV"),
        NAME: getIdxN(headerEff, "HỌ VÀ TÊN", "HO VA TEN"),

        BASIC: getIdxN(headerEff, "LƯƠNG CB", "LUONG CB", "LƯƠNG CƠ BẢN", "LUONG CO BAN"),
        RESP: getIdxN(headerEff, "PC TRÁCH NHIỆM", "PC TRACH NHIEM", "PHỤ CẤP TRÁCH NHIỆM", "PHU CAP TRACH NHIEM"),

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

        QBON: getIdxN(headerEff, "THƯỞNG HIỆU QUẢ CÔNG VIỆC", "THUONG HIEU QUA CONG VIEC"),
        TOTAL: getIdxN(headerEff, "TỔNG LƯƠNG", "TONG LUONG"),

        // Bổ sung
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

        // Khấu trừ (sẽ ưu tiên pick từ hàng 6 ngay dưới)
        KTBH: getIdxN(headerEff, "BH (XH+YT+TN)", "BH XH YT TN"),
        KTCONGDOAN: getIdxN(headerEff, "ĐOÀN PHÍ", "DOAN PHI"),
        KTLUONGKY1: getIdxN(headerEff, "TẠM ỨNG", "TAM UNG"),
        KTTHUE: getIdxN(headerEff, "THUẾ TNCN", "THUE TNCN"),
        KTKHAC: getIdxN(headerEff, "KT KHÁC", "KT KHAC"),
        KTTRUCOM: getIdxN(headerEff, "KT TIỀN CƠM", "KT TIEN COM"),

        LUONGTHUCLANH: getIdxN(headerEff, "LƯƠNG THỰC LÃNH", "LUONG THUC LANH"),
      };

      // ===== ƯU TIÊN DÒ Ở HÀNG 6 =====
      const hRowNorm = headerEff.map((h) => norm(h || ""));
      const belowNorm1 = dn1.map((h) => norm(h || "")); // hàng 5
      const belowNorm2 = dn2.map((h) => norm(h || "")); // hàng 6 (ưu tiên)

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

      // KT TRỪ CƠM
      if (idx.KTTRUCOM < 0) {
        let pos = belowNorm2.findIndex((h) => h === "KT TIEN COM"); // hàng 6 trước
        if (pos < 0) pos = belowNorm1.findIndex((h) => h === "KT TIEN COM");
        if (pos < 0) pos = hRowNorm.findIndex((h) => h === "KT TIEN COM");

        if (pos < 0) {
          // "TIEN COM" dưới group KHẤU TRỪ
          pos = findUnderKhauTru(belowNorm2, carry, ["TIEN COM"]);
          if (pos < 0) pos = findUnderKhauTru(belowNorm1, carry, ["TIEN COM"]);
          if (pos < 0) pos = findUnderKhauTru(hRowNorm, carry, ["TIEN COM"]);
        }
        if (pos >= 0) idx.KTTRUCOM = pos;
      }

      // KT KHÁC
      if (idx.KTKHAC < 0) {
        let pos = belowNorm2.findIndex((h) => h === "KT KHAC"); // hàng 6 trước
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
        if (headerEffNorm[i] === "TIEN COM") {
          allTienCom.push({ i, underKhauTru: carry[i] === "KHAU TRU" });
        }
      }
      const incomeTienCom = allTienCom.find((x) => !x.underKhauTru);
      const ktTienComByGroup = allTienCom.find((x) => x.underKhauTru);
      const TIENCOM_INCOME = incomeTienCom ? incomeTienCom.i : -1;
      if (idx.KTTRUCOM < 0 && ktTienComByGroup) idx.KTTRUCOM = ktTienComByGroup.i;

      log("KTTRUCOM idx:", idx.KTTRUCOM, "KTKHAC idx:", idx.KTKHAC);

      // Mandatory
      for (const k of ["MSNV", "NAME"]) {
        if (idx[k] < 0) return res.status(400).json({ message: `Thiếu cột bắt buộc: ${k}` });
      }

      const ref = XLSX.utils.decode_range(ws["!ref"] || "A1");

      // valid users
      const pool = await poolPromise;
      const userRows = await pool.request().query(`SELECT username, msnv FROM dbo.Users`);

      // gom tất cả định danh hợp lệ vào 1 Set (so sánh không phân biệt hoa/thường)
const toKey = (s) => (s ?? "").trim().toUpperCase();
const validIdentifiers = new Set();
for (const r of userRows.recordset) {
  if (r.username) validIdentifiers.add(toKey(r.username));
  if (r.msnv)     validIdentifiers.add(toKey(r.msnv));
}

      const trx = new sql.Transaction(pool);
      await trx.begin();

      let inserted = 0;
      let skippedNoUser = 0;
      let failed = 0;

      try {
        for (let rAOA = 0; rAOA < body.length; rAOA++) {
          const row = body[rAOA];

          const rawMSNV = (row[idx.MSNV] || "").toString().trim();
          const name = (row[idx.NAME] || "").toString().trim();
          if (!rawMSNV && !name) continue;

          if (!validIdentifiers.has(toKey(rawMSNV))) {
            skippedNoUser++;
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

          if (DEBUG) {
            log("Row", rAOA, "KTTRUCOM val:", idx.KTTRUCOM >= 0 ? row[idx.KTTRUCOM] : null);
            log("Row", rAOA, "KTKHAC   val:", idx.KTKHAC >= 0 ? row[idx.KTKHAC] : null);
          }

          const req = new sql.Request(trx);
          req
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

            // Bổ sung
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
            await req.query(`
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
          } catch (rowErr) {
            failed++;
            log("Row insert error:", rowErr?.message);
          }
        }

        await trx.commit();

        try {
          const info = await notifyPayslipPublished(title);
          log("pushed:", info);
        } catch (e) {
          log("push failed:", e?.message);
        }

        return res.json({ success: true, inserted, skippedNoUser, failed });
      } catch (innerErr) {
        try { if (!trx._aborted) await trx.rollback(); } catch (_) {}
        console.error("Import paylips rollback:", innerErr);
        return res.status(500).json({ message: "Lỗi khi lưu dữ liệu.", details: innerErr.message });
      }
    } catch (e) {
      console.error("Import paylips error:", e);
      return res.status(500).json({ message: "Không thể xử lý file Excel", details: e.message });
    }
  });

  app.get("/api/payroll/me/latest", requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;

    // loginId là thứ người dùng đăng nhập (thường là username; đôi khi chính là msnv)
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
          p.msnv = @loginId       -- khớp trực tiếp nếu msnv trong phiếu = username đăng nhập
          OR u.username = @loginId -- hoặc khớp nếu msnv của phiếu là msnv của user có username = loginId
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
