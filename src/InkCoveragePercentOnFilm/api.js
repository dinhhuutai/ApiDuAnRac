// routes/inkCoverage.js
const express = require("express");
const router = express.Router();
const multer = require("multer");

const { requireAuth } = require("../middleware/auth");

// ================== CONFIG ==================
const PY_BASE_URL =
  process.env.PY_INK_API_URL || "http://127.0.0.1:8000";
const PY_ENDPOINT = "/calc-image";

// ================== MULTER ==================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
    files: 1,
  },
});

// ================== HELPERS ==================
function isPdf(file) {
  const name = (file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();
  return name.endsWith(".pdf") || mime === "application/pdf";
}

function parseBool(v, defaultValue = false) {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function parseIntSafe(v, defaultValue) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

// ================== ROUTE ==================
/**
 * POST /api/ink-coverage/calc-image
 *
 * multipart/form-data:
 *  - file (PDF)
 *  - page_index (optional, default 0)
 *  - dpi (optional, default 300)
 *
 * Response:
 *  - image/png
 *  - headers:
 *      X-Ink-Percent
 *      X-Ink-BBox
 */
router.post(
  "/calc-image",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      // ===== 1. VALIDATE FILE =====
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Thiếu file PDF (field name: file)",
        });
      }

      if (!isPdf(req.file)) {
        return res.status(400).json({
          success: false,
          message: "Chỉ hỗ trợ file PDF",
        });
      }

      // ===== 2. READ PARAMS =====
      const page_index = parseIntSafe(req.body.page_index, 0);
      const dpi = parseIntSafe(req.body.dpi, 300);
      const show_mask_overlay = parseBool(
        req.body.show_mask_overlay,
        false
      );

      if (dpi < 72 || dpi > 600) {
        return res.status(400).json({
          success: false,
          message: "dpi không hợp lệ (72–600)",
        });
      }

      // ===== 3. BUILD FormData (QUAN TRỌNG) =====
      // Node 18+ / 22: dùng global FormData + Blob
      const form = new FormData();

      const pdfBlob = new Blob([req.file.buffer], {
        type: req.file.mimetype || "application/pdf",
      });

      form.append(
        "file",
        pdfBlob,
        req.file.originalname || "upload.pdf"
      );
      form.append("page_index", String(page_index));
      form.append("dpi", String(dpi));
      form.append("show_mask_overlay", String(show_mask_overlay));

      const pyUrl = `${PY_BASE_URL}${PY_ENDPOINT}`;

      // ===== 4. CALL PYTHON API =====
      const controller = new AbortController();
      const timeoutMs = Number(
        process.env.PY_INK_TIMEOUT_MS || 120000
      );

      const timeout = setTimeout(
        () => controller.abort(),
        timeoutMs
      );

      let pyResp;
      try {
        pyResp = await fetch(pyUrl, {
          method: "POST",
          body: form,
          signal: controller.signal,
          // ❌ KHÔNG set Content-Type
        });
      } finally {
        clearTimeout(timeout);
      }

      // ===== 5. PYTHON ERROR =====
      if (!pyResp.ok) {
        const text = await pyResp.text().catch(() => "");
        return res.status(502).json({
          success: false,
          message: "Python API lỗi",
          status: pyResp.status,
          detail: text,
        });
      }

      // ===== 6. READ HEADERS =====
      const percent =
        pyResp.headers.get("x-ink-percent") || "";
      const bbox = pyResp.headers.get("x-ink-bbox") || "";

      // ===== 7. STREAM IMAGE BACK =====
      const buf = Buffer.from(await pyResp.arrayBuffer());

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");

      console.log(percent)
      if (percent) res.setHeader("X-Ink-Percent", percent);
      if (bbox) res.setHeader("X-Ink-BBox", bbox);

      res.setHeader(
  "Access-Control-Expose-Headers",
  "X-Ink-Percent, X-Ink-BBox"
);

      return res.status(200).send(buf);
    } catch (err) {
      const isAbort =
        err?.name === "AbortError" ||
        String(err).includes("aborted");

      console.error("InkCoverage error:", err);

      return res.status(isAbort ? 504 : 500).json({
        success: false,
        message: isAbort
          ? "Timeout khi gọi Python API"
          : "Lỗi server",
        error: err?.message || String(err),
      });
    }
  }
);

module.exports = router;
