const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");
const upload = require('../middleware/upload');
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { sendSuggestionEmail } = require("../utils/mailer");

/** Giữ xuống dòng / khoảng trắng khi đưa vào HTML email; chống XSS */
function escapeHtmlForEmail(s) {
  if (s == null || s === "") return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeSuggestionContent(content) {
  if (content == null || content === undefined) return "";
  const raw = typeof content === "string" ? content : String(content);
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function apiSuggestion(app) {

// app.post("/api/suggestions/submit", upload.array("images", 10), async (req, res) => {
//   try {
//     const pool = await poolPromise;
//     const {
//       suggestionCategorieId,
//       content,
//       wantContact,
//       sender_name,
//       sender_department,
//       sender_phone,
//       rating // <--- new
//     } = req.body;

//     // parse rating: bắt buộc nếu client gửi phải là 1..5
//     let ratingVal = null;
//     if (rating !== undefined && rating !== null && String(rating).trim() !== '') {
//       const r = Number(rating);
//       if (!Number.isInteger(r) || r < 1 || r > 5) {
//         return res.status(400).json({ success: false, message: 'rating phải là số nguyên 1..5' });
//       }
//       ratingVal = r;
//     } else {
//       // Nếu bạn muốn bắt buộc luôn phải có rating, uncomment dòng dưới:
//       // return res.status(400).json({ success:false, message: 'rating bị thiếu (1..5)' });
//       // Hiện để cho phép không gửi rating -> lưu NULL
//       ratingVal = null;
//     }

//     // NOTE: giữ nguyên cách bạn xử lý isAnonymous (mình không thay đổi)
//     const isAnonymous = wantContact === false || 'false'; // giữ y nguyên theo yêu cầu

//     const resultInsert = await pool
//       .request()
//       .input("suggestionCategorieId", sql.Int, suggestionCategorieId)
//       .input("content", sql.NVarChar, content)
//       .input("is_anonymous", sql.Bit, isAnonymous)
//       .input("sender_name", sql.NVarChar, sender_name)
//       .input("sender_department", sql.NVarChar, sender_department)
//       .input("sender_phone", sql.NVarChar, sender_phone)
//       .input("rating", sql.TinyInt, ratingVal) // <-- thêm param
//       .query(`
//         INSERT INTO Suggestions
//           (suggestionCategorieId, content, is_anonymous, sender_name, sender_department, sender_phone, rating)
//         OUTPUT INSERTED.suggestionId
//         VALUES (@suggestionCategorieId, @content, @is_anonymous, @sender_name, @sender_department, @sender_phone, @rating)
//       `);

//     const suggestionId = resultInsert.recordset[0].suggestionId;

//     // Lưu hình ảnh (giữ nguyên)
//     const files = req.files || [];
//     for (const file of files) {
//       await pool
//         .request()
//         .input("suggestionId", sql.Int, suggestionId)
//         .input("image_url", sql.NVarChar, file.path)
//         .query(`
//           INSERT INTO SuggestionImages (suggestionId, image_url)
//           VALUES (@suggestionId, @image_url)
//         `);
//     }

//     // Gửi email (giữ nguyên)
//     const bgdEmails = [
//       "hanhchaien@yahoo.com",
//       "quangthongco@gmail.com",
//     ];

//     const otherEmails = [
//       "lttnguyen328@gmail.com",
//       "dinhhuutai20023107@gmail.com",
//     ];

//     const html = `
//       <h3>📢 Có góp ý mới từ CNV</h3>
//       <p><strong>Phòng ban:</strong> ${sender_department || "Ẩn danh"}</p>
//       <p><strong>Người gửi:</strong> ${sender_name || "Ẩn danh"}</p>
//       <p><strong>Số điện thoại:</strong> ${sender_phone || "Ẩn danh"}</p>
//       <p><strong>Điểm đánh giá:</strong> ${ratingVal === null ? '—' : ratingVal + '/5'}</p>
//       <p><strong>Nội dung góp ý:</strong></p>
//       <p>${content}</p>
//     `;

//     const promises = [];

//     // Gửi riêng BGĐ
//     for (const email of bgdEmails) {
//       promises.push(
//         sendSuggestionEmail({
//           to: email,
//           subject: `📢 [BGĐ] Góp ý mới từ CNV - ${sender_department || "Không rõ"}`,
//           html,
//         })
//       );
//     }

//     // Gửi chung nhóm còn lại
//     if (otherEmails.length > 0) {
//       promises.push(
//         sendSuggestionEmail({
//           to: otherEmails.join(","),
//           subject: `📨 Góp ý mới từ CNV - ${sender_department || "Không rõ"}`,
//           html,
//         })
//       );
//     }

//     // Gửi đồng thời
//     await Promise.all(promises);


//     res.json({ success: true, message: "Góp ý đã được lưu!" });
//   } catch (err) {
//     console.error("❌ Lỗi khi lưu góp ý:", err);
//     res.status(500).json({ success: false, message: "Lỗi server" });
//   }
// });

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
      rating
    } = req.body;

    const contentText = normalizeSuggestionContent(content);

    // parse rating: nếu client gửi thì phải là 1..5
    let ratingVal = null;
    if (rating !== undefined && rating !== null && String(rating).trim() !== "") {
      const r = Number(rating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        return res.status(400).json({
          success: false,
          message: "rating phải là số nguyên 1..5",
        });
      }
      ratingVal = r;
    } else {
      ratingVal = null;
    }

    // giữ nguyên theo yêu cầu của anh
    const isAnonymous = wantContact === false || "false";

    // 1) Lấy thông tin chủ đề
    const cateRs = await pool
      .request()
      .input("suggestionCategorieId", sql.Int, suggestionCategorieId)
      .query(`
        SELECT TOP 1 suggestionCategorieId, name, icon
        FROM SuggestionCategories
        WHERE suggestionCategorieId = @suggestionCategorieId
      `);

    const category = cateRs.recordset[0] || null;
    const categoryName = category?.name || "Không rõ chủ đề";
    const categoryIcon = category?.icon || "📌";

    // 2) Lưu góp ý
    const resultInsert = await pool
      .request()
      .input("suggestionCategorieId", sql.Int, suggestionCategorieId)
      .input("content", sql.NVarChar(sql.MAX), contentText)
      .input("is_anonymous", sql.Bit, isAnonymous)
      .input("sender_name", sql.NVarChar(255), sender_name || null)
      .input("sender_department", sql.NVarChar(255), sender_department || null)
      .input("sender_phone", sql.NVarChar(50), sender_phone || null)
      .input("rating", sql.TinyInt, ratingVal)
      .query(`
        INSERT INTO Suggestions
          (suggestionCategorieId, content, is_anonymous, sender_name, sender_department, sender_phone, rating)
        OUTPUT INSERTED.suggestionId
        VALUES
          (@suggestionCategorieId, @content, @is_anonymous, @sender_name, @sender_department, @sender_phone, @rating)
      `);

    const suggestionId = resultInsert.recordset[0].suggestionId;

    // Helper: chuyển path lưu DB sang URL public để email xem được
    const buildPublicImageUrl = (rawPath) => {
      if (!rawPath) return "";

      // Nếu đã là URL đầy đủ thì giữ nguyên
      if (/^https?:\/\//i.test(rawPath)) return rawPath;

      // Ví dụ: file.path = uploads/suggestions/abc.jpg
      // hoặc /uploads/suggestions/abc.jpg
      const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
      const normalizedPath = String(rawPath).replace(/\\/g, "/");
      const pathWithSlash = normalizedPath.startsWith("/")
        ? normalizedPath
        : `/${normalizedPath}`;

      return `${baseUrl}${pathWithSlash}`;
    };

    // 3) Lưu hình ảnh nếu có
    const files = req.files || [];
    const imageUrls = [];

    for (const file of files) {
      const savedPath = file.path; // giữ nguyên như hệ thống anh đang lưu
      await pool
        .request()
        .input("suggestionId", sql.Int, suggestionId)
        .input("image_url", sql.NVarChar(1000), savedPath)
        .query(`
          INSERT INTO SuggestionImages (suggestionId, image_url)
          VALUES (@suggestionId, @image_url)
        `);

      imageUrls.push(buildPublicImageUrl(savedPath));
    }


    const html = `
<div style="font-family:Segoe UI, Arial; background:#f4f6f8; padding:20px;">
  <div style="width:100%; margin:auto; background:#fff; border-radius:12px; overflow:hidden; border:1px solid #e5e7eb;">

    <!-- HEADER -->
    <div style="background:#2563eb; color:#fff; padding:14px 18px;">
      <div style="font-size:16px; font-weight:600;">
        THLA - Hệ thống góp ý nội bộ
      </div>
      <div style="font-size:13px; opacity:0.9;">
        Thông báo từ hệ thống
      </div>
    </div>

    <!-- BODY -->
    <div style="padding:18px; font-size:14px; color:#222;">

      <!-- INFO -->
      <div style="margin-bottom:14px;">
        <div><strong>Chủ đề:</strong> ${categoryName}</div>
        <div><strong>Phòng ban:</strong> ${sender_department || "Ẩn danh"}</div>
        <div><strong>Người gửi:</strong> ${sender_name || "Ẩn danh"}</div>
        <div><strong>Điện thoại:</strong> ${sender_phone || "Ẩn danh"}</div>
      </div>

      <!-- CONTENT -->
      <div style="margin-top:10px;">
        <div style="font-weight:600; margin-bottom:6px;">Nội dung góp ý</div>
        <div style="
          background:#f9fafb;
          border-left:4px solid #3b82f6;
          padding: 6px 10px;
          border-radius:6px;
          line-height:1.6;
          white-space:pre-wrap;
          word-wrap:break-word;
        ">
          ${escapeHtmlForEmail(contentText)}
        </div>
      </div>

      <!-- IMAGES -->
      ${
        imageUrls.length > 0
          ? `
        <div style="margin-top:16px;">
          <div style="font-weight:600; margin-bottom:10px;">📷 Hình ảnh</div>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
            ${imageUrls
              .reduce((rows, url, index) => {
                if (index % 2 === 0) rows.push([]);
                rows[rows.length - 1].push({ url, index });
                return rows;
              }, [])
              .map(
                (row) => `
                  <tr>
                    ${row
                      .map(
                        ({ url, index }) => `
                          <td style="padding:0 10px 12px 0; width:50%; vertical-align:top;">
                            <a href="${url}" target="_blank">
                              <img
                                src="${url}"
                                alt="Ảnh ${index + 1}"
                                width="100%"
                                style="
                                  max-width:260px;
                                  height:auto;
                                  border-radius:8px;
                                  border:1px solid #ddd;
                                  display:block;
                                "
                              />
                            </a>
                            <div style="font-size:12px; color:#666; margin-top:4px;">
                              Ảnh ${index + 1}
                            </div>
                          </td>
                        `
                      )
                      .join("")}
                    ${row.length === 1 ? `<td style="width:50%;"></td>` : ""}
                  </tr>
                `
              )
              .join("")}
          </table>
        </div>
      `
          : ""
      }

    </div>

    <!-- FOOTER -->
    <div style="background:#f9fafb; padding:12px 18px; font-size:12px; color:#666; line-height:1.6;">
    <div>Mã góp ý: <strong>#${suggestionId}</strong></div>
    <div>Hòm thư góp ý nội bộ THLA</div>
    <div style="margin-top:4px; color:#999;">
      Email này được gửi tự động
    </div>
  </div>

  </div>
</div>
`;

    const bgdEmails = [
      "hanhchaien@yahoo.com",
      "quangthongco@gmail.com",
    ];

    const otherEmails = [
      "lttnguyen328@gmail.com",
      "dinhhuutai20023107@gmail.com",
    ];

    const promises = [];

    // Gửi riêng BGĐ
    for (const email of bgdEmails) {
      promises.push(
        sendSuggestionEmail({
          to: email,
          subject: `[BGĐ] Góp ý từ CNV Thuận Hưng Long An - [${categoryName}]`,
          html,
        })
      );
    }

    // Gửi chung nhóm còn lại
    if (otherEmails.length > 0) {
      promises.push(
        sendSuggestionEmail({
          to: otherEmails.join(","),
          subject: `Góp ý từ CNV Thuận Hưng Long An - [${categoryName}]`,
          html,
        })
      );
    }

    await Promise.all(promises);

    res.json({
      success: true,
      message: "Góp ý đã được lưu!",
      data: {
        suggestionId,
        categoryName,
        imageCount: imageUrls.length,
      },
    });
  } catch (err) {
    console.error("❌ Lỗi khi lưu góp ý:", err);
    res.status(500).json({ success: false, message: "Lỗi server" });
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

app.get("/api/suggestions/statuses", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT statusId, statusName
      FROM SuggestionStatuses
      ORDER BY statusId
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error("Lỗi lấy trạng thái góp ý:", err);
    res.status(500).json({ success: false, message: "Không thể tải trạng thái" });
  }
});

app.patch("/api/suggestions/:id", async (req, res) => {
  const { id } = req.params;
  const { statusId, processing_detail } = req.body;
  if (statusId === undefined || statusId === null) {
    return res.status(400).json({ success: false, message: "Thiếu statusId" });
  }
  try {
    const pool = await poolPromise;
    const detail =
      processing_detail === undefined || processing_detail === null
        ? null
        : String(processing_detail);
    await pool
      .request()
      .input("id", sql.Int, Number(id))
      .input("statusId", sql.Int, Number(statusId))
      .input("processing_detail", sql.NVarChar(sql.MAX), detail)
      .query(`
        UPDATE Suggestions
        SET statusId = @statusId,
            processing_detail = @processing_detail
        WHERE suggestionId = @id
      `);
    res.json({ success: true, message: "Đã cập nhật" });
  } catch (err) {
    console.error("Lỗi cập nhật góp ý:", err);
    res.status(500).json({ success: false, message: "Lỗi máy chủ" });
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
    const { fromDate, toDate, categoryId, statusId, page, pageSize, exportAll } = req.query;

    const exportAllFlag =
      exportAll === "true" || exportAll === "1" || exportAll === "yes";

    let whereSql = `WHERE 1 = 1`;

    if (fromDate && toDate) {
      whereSql += `
        AND CONVERT(DATE, s.created_at)
        BETWEEN @fromDate AND @toDate
      `;
    }

    if (categoryId) {
      whereSql += ` AND s.suggestionCategorieId = @categoryId`;
    }

    if (statusId) {
      whereSql += ` AND s.statusId = @filterStatusId`;
    }

    const baseSelect = `
      SELECT s.*, c.name AS categoryName, ss.statusName
      FROM Suggestions s
      JOIN SuggestionCategories c
        ON s.suggestionCategorieId = c.suggestionCategorieId
      LEFT JOIN SuggestionStatuses ss ON s.statusId = ss.statusId
      ${whereSql}
    `;

    const bindCommon = (request) => {
      if (fromDate && toDate) {
        request.input("fromDate", sql.Date, fromDate);
        request.input("toDate", sql.Date, toDate);
      }
      if (categoryId) {
        request.input("categoryId", sql.Int, Number(categoryId));
      }
      if (statusId) {
        request.input("filterStatusId", sql.Int, Number(statusId));
      }
    };

    if (exportAllFlag) {
      const request = pool.request();
      bindCommon(request);
      const result = await request.query(`${baseSelect} ORDER BY s.created_at DESC`);
      return res.json({
        success: true,
        data: result.recordset,
        total: result.recordset.length,
        page: 1,
        pageSize: result.recordset.length,
      });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sizeRaw = parseInt(pageSize, 10);
    const allowed = [2, 5, 10, 20, 50, 100];
    const size = allowed.includes(sizeRaw) ? sizeRaw : 10;
    const offset = (pageNum - 1) * size;

    const countReq = pool.request();
    bindCommon(countReq);
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total
      FROM Suggestions s
      JOIN SuggestionCategories c
        ON s.suggestionCategorieId = c.suggestionCategorieId
      ${whereSql}
    `);
    const total = countResult.recordset[0].total;

    const dataReq = pool.request();
    bindCommon(dataReq);
    dataReq.input("offset", sql.Int, offset);
    dataReq.input("fetchSize", sql.Int, size);

    const result = await dataReq.query(`
      ${baseSelect}
      ORDER BY s.created_at DESC
      OFFSET @offset ROWS FETCH NEXT @fetchSize ROWS ONLY
    `);

    res.json({
      success: true,
      data: result.recordset,
      total,
      page: pageNum,
      pageSize: size,
    });
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