const multer = require("multer");
const path = require("path");
const fs = require('fs');
const { convertExcelsToPdf } = require("../utils/excelToPdfHandler");

const upload = multer({ dest: path.join(__dirname, "../uploads/") });

function apiUtilsConvert(app) {

  // ✅ Route Chuyển nhiều Excel thành PDF
  app.post("/api/convert/excel-pdf", upload.array("files", 10), async (req, res) => {
    try {
      const files = req.files;
      if (!files || files.length === 0) {
        return res.status(400).json({ success: false, message: "Không có file Excel nào được gửi." });
      }

      const result = await convertExcelsToPdf(files);
      res.download(result.filePath, () => {
        fs.unlinkSync(result.filePath); // Xoá sau khi tải xong
      });
    } catch (error) {
      console.error("❌ Lỗi chuyển đổi Excel:", error);
      res.status(500).json({ success: false, message: "Lỗi server khi chuyển đổi file Excel." });
    }
  });
}

module.exports = {
  apiUtilsConvert,
};
