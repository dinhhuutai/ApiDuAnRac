const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");
const upload = require('../middleware/upload');
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { sendSuggestionEmail } = require("../utils/mailer");


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
      rating // <--- new
    } = req.body;

    // parse rating: bắt buộc nếu client gửi phải là 1..5
    let ratingVal = null;
    if (rating !== undefined && rating !== null && String(rating).trim() !== '') {
      const r = Number(rating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        return res.status(400).json({ success: false, message: 'rating phải là số nguyên 1..5' });
      }
      ratingVal = r;
    } else {
      // Nếu bạn muốn bắt buộc luôn phải có rating, uncomment dòng dưới:
      // return res.status(400).json({ success:false, message: 'rating bị thiếu (1..5)' });
      // Hiện để cho phép không gửi rating -> lưu NULL
      ratingVal = null;
    }

    // NOTE: giữ nguyên cách bạn xử lý isAnonymous (mình không thay đổi)
    const isAnonymous = wantContact === false || 'false'; // giữ y nguyên theo yêu cầu

    const resultInsert = await pool
      .request()
      .input("suggestionCategorieId", sql.Int, suggestionCategorieId)
      .input("content", sql.NVarChar, content)
      .input("is_anonymous", sql.Bit, isAnonymous)
      .input("sender_name", sql.NVarChar, sender_name)
      .input("sender_department", sql.NVarChar, sender_department)
      .input("sender_phone", sql.NVarChar, sender_phone)
      .input("rating", sql.TinyInt, ratingVal) // <-- thêm param
      .query(`
        INSERT INTO Suggestions
          (suggestionCategorieId, content, is_anonymous, sender_name, sender_department, sender_phone, rating)
        OUTPUT INSERTED.suggestionId
        VALUES (@suggestionCategorieId, @content, @is_anonymous, @sender_name, @sender_department, @sender_phone, @rating)
      `);

    const suggestionId = resultInsert.recordset[0].suggestionId;

    // Lưu hình ảnh (giữ nguyên)
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

    // Gửi email (giữ nguyên)
    const recipients = [
      "hanhchaien@yahoo.com",
      "paul@thuanhung.group",
      "lttnguyen328@gmail.com",
      "dinhhuutai20023107@gmail.com",
    ];

    const html = `
      <h3>📢 Có góp ý mới từ CNV</h3>
      <p><strong>Phòng ban:</strong> ${sender_department || "Ẩn danh"}</p>
      <p><strong>Người gửi:</strong> ${sender_name || "Ẩn danh"}</p>
      <p><strong>Số điện thoại:</strong> ${sender_phone || "Ẩn danh"}</p>
      <p><strong>Điểm đánh giá:</strong> ${ratingVal === null ? '—' : ratingVal + '/5'}</p>
      <p><strong>Nội dung góp ý:</strong></p>
      <p>${content}</p>
    `;

    await sendSuggestionEmail({
      to: recipients.join(","),
      subject: `📨 Góp ý mới từ CNV - ${sender_department || "Không rõ"}`,
      html,
    });

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
// app.get("/api/suggestions", async (req, res) => {
//   try {
//     const pool = await poolPromise;
//     const { date, categoryId } = req.query;

//     let query = `
//       SELECT s.*, c.name AS categoryName
//       FROM Suggestions s
//       JOIN SuggestionCategories c ON s.suggestionCategorieId = c.suggestionCategorieId
//       WHERE 1 = 1
//     `;

//     if (date) {
//       query += ` AND CONVERT(DATE, s.created_at) = @date`;
//     }
//     if (categoryId) {
//       query += ` AND s.suggestionCategorieId = @categoryId`;
//     }

//     const request = pool.request();
//     if (date) request.input("date", sql.Date, date);
//     if (categoryId) request.input("categoryId", sql.Int, categoryId);

//     const result = await request.query(query);

//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error("Lỗi lấy góp ý:", err);
//     res.status(500).json({ success: false, message: "Server error" });
//   }
// });
app.get("/api/suggestions", async (req, res) => {
  try {
    const pool = await poolPromise;
    const { fromDate, toDate, categoryId } = req.query;

    let query = `
      SELECT s.*, c.name AS categoryName
      FROM Suggestions s
      JOIN SuggestionCategories c 
        ON s.suggestionCategorieId = c.suggestionCategorieId
      WHERE 1 = 1
    `;

    if (fromDate && toDate) {
      query += `
        AND CONVERT(DATE, s.created_at) 
        BETWEEN @fromDate AND @toDate
      `;
    }

    if (categoryId) {
      query += ` AND s.suggestionCategorieId = @categoryId`;
    }

    query += ` ORDER BY s.created_at DESC`;

    const request = pool.request();

    if (fromDate && toDate) {
      request.input("fromDate", sql.Date, fromDate);
      request.input("toDate", sql.Date, toDate);
    }

    if (categoryId) {
      request.input("categoryId", sql.Int, categoryId);
    }

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