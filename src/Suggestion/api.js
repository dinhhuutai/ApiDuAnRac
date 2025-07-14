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

    const isAnonymous = wantContact === false || 'false'; // từ FormData gửi lên là string

    const resultInsert = await pool
      .request()
      .input("suggestionCategorieId", sql.Int, suggestionCategorieId)
      .input("content", sql.NVarChar, content)
      .input("is_anonymous", sql.Bit, isAnonymous)
      .input("sender_name", sql.NVarChar, sender_name)
      .input("sender_department", sql.NVarChar, sender_department)
      .input("sender_phone", sql.NVarChar, sender_phone)
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

// GET /api/suggestions/categories
app.get("/api/suggestions/categories", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT suggestionCategorieId, name, icon
      FROM SuggestionCategories
      ORDER BY suggestionCategorieId
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("Lỗi lấy danh mục góp ý:", err);
    res.status(500).json({ success: false, message: "Không thể tải danh mục" });
  }
});


// GET /api/suggestions?date=2025-07-11&categoryId=3
app.get("/api/suggestions", async (req, res) => {
  try {
    const pool = await poolPromise;
    const { date, categoryId } = req.query;

    let query = `
      SELECT s.*, c.name AS categoryName
      FROM Suggestions s
      JOIN SuggestionCategories c ON s.suggestionCategorieId = c.suggestionCategorieId
      WHERE 1 = 1
    `;

    if (date) {
      query += ` AND CONVERT(DATE, s.created_at) = @date`;
    }
    if (categoryId) {
      query += ` AND s.suggestionCategorieId = @categoryId`;
    }

    const request = pool.request();
    if (date) request.input("date", sql.Date, date);
    if (categoryId) request.input("categoryId", sql.Int, categoryId);

    const result = await request.query(query);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("Lỗi lấy góp ý:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/suggestions/categories
app.post("/api/suggestions/categories", async (req, res) => {
  const { name, icon } = req.body;
  try {
    const pool = await poolPromise;
    await pool.request()
      .input("name", sql.NVarChar, name)
      .input("icon", sql.NVarChar, icon)
      .query(`
        INSERT INTO SuggestionCategories (name, icon)
        VALUES (@name, @icon)
      `);
    res.json({ success: true });
  } catch (err) {
    console.error("Insert category error:", err);
    res.status(500).json({ success: false, message: "DB insert error" });
  }
});

// route: DELETE /api/suggestions/categories/:id
app.delete("/api/suggestions/categories/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await poolPromise;
    await pool.request()
      .input("id", sql.Int, id)
      .query("DELETE FROM SuggestionCategories WHERE suggestionCategorieId = @id");

    return res.json({ success: true, message: "Xóa thành công" });
  } catch (error) {
    console.error("Lỗi xóa danh mục:", error);
    return res.status(500).json({ success: false, message: "Lỗi máy chủ" });
  }
});



}

module.exports = {
    apiSuggestion,
}