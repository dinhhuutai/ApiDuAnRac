const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");
const upload = require('../middleware/upload');
const multer = require("multer");
const cloudinary = require("cloudinary").v2;


function apiSuggestion(app) {

app.post("/api/suggestions/submit", upload.array("images", 10), async (req, res) => {
  try {
    const pool = await poolPromise;
    const {
      suggestionCategorieId,
      content,
      wantContact,
      sender_name,
      sender_department,
      sender_phone,
    } = req.body;

    const isAnonymous = wantContact === "false"; // từ FormData gửi lên là string

    const resultInsert = await pool
      .request()
      .input("suggestionCategorieId", sql.Int, suggestionCategorieId)
      .input("content", sql.NVarChar, content)
      .input("is_anonymous", sql.Bit, isAnonymous)
      .input("sender_name", sql.NVarChar, isAnonymous ? null : sender_name)
      .input("sender_department", sql.NVarChar, isAnonymous ? null : sender_department)
      .input("sender_phone", sql.NVarChar, isAnonymous ? null : sender_phone)
      .query(`
        INSERT INTO Suggestions (suggestionCategorieId, content, is_anonymous, sender_name, sender_department, sender_phone)
        OUTPUT INSERTED.suggestionId
        VALUES (@suggestionCategorieId, @content, @is_anonymous, @sender_name, @sender_department, @sender_phone)
      `);

    const suggestionId = resultInsert.recordset[0].suggestionId;

    // Lưu hình ảnh
    const files = req.files || [];
    for (const file of files) {
      await pool
        .request()
        .input("suggestionId", sql.Int, suggestionId)
        .input("image_url", sql.NVarChar, file.path)
        .query(`
          INSERT INTO SuggestionImages (suggestionId, image_url)
          VALUES (@suggestionId, @image_url)
        `);
    }

    res.json({ success: true, message: "Góp ý đã được lưu!" });
  } catch (err) {
    console.error("❌ Lỗi khi lưu góp ý:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
  }
});


app.get("/api/suggestions/categories", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query("SELECT * FROM SuggestionCategories");
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Lỗi khi lấy danh mục góp ý" });
  }
});


}

module.exports = {
    apiSuggestion,
}