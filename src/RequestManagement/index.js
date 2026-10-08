// RequestManagement — Module 18 "Quản lý yêu cầu" (đề xuất / duyệt nhiều cấp / bình luận / chat)
// Mount: app.use('/api/rq', require('./RequestManagement'))
// Bảng rq_* (sql/10), dùng chung org_* (phòng ban, tổ). Tệp/ảnh lưu ở máy chủ tệp nội bộ
// (ApiDuAnRac/fileserver) — API chỉ lưu thông tin tệp + ký đường dẫn.
//
//   /api/rq/me/*, /directory, /requests*, /comments/*, /notifications*, /files/ticket  → requests.js
//   /api/rq/chat/*                                                                      → chat.js
//   /api/rq/admin/*  (admin module 18)                                                  → admin.js
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use('/chat', require('./chat'));
router.use('/admin', require('./admin'));
router.use('/', require('./requests'));

module.exports = router;
