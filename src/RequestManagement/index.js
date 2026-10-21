// RequestManagement — Module 18 "Quản lý đề xuất" (đề xuất / duyệt nhiều cấp / bình luận / chat)
// Mount: app.use('/api/rq', require('./RequestManagement'))
// Bảng rq_* (sql/10), dùng chung org_* (phòng ban, tổ). Tệp/ảnh lưu ở server bk (D:\THLA\QuanLyYeuCau,
// qua API apiWebAppNoiBo cổng 5000) — API này chuyển tiếp nội dung (files.js), DB chỉ lưu thông tin tệp.
//
//   /api/rq/f?k=<mã tệp>&e=&s=  xem/tải tệp — KHÔNG cần đăng nhập (thẻ <img> không gửi token), đường dẫn có chữ ký + hạn
//   /api/rq/files/health        kiểm tra API → server bk (không cần đăng nhập, không lộ địa chỉ server bk)
//   /api/rq/me/*, /directory, /requests*, /comments/*, /notifications*, /files/upload  → requests.js
//   /api/rq/chat/*                                                                      → chat.js
//   /api/rq/admin/import/* (admin) nhập đề xuất cũ từ Base Request (sql/12)            → imports.js
//   /api/rq/admin/*  (admin module 18)                                                  → admin.js
//   /api/rq/reports* (xem: người được chia sẻ + admin · thiết kế: admin)                → reports.js
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const F = require('./files');

const router = express.Router();

router.get('/f', (req, res) => F.proxyView(req, res));
router.get('/files/health', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await F.checkServer());
  } catch (err) {
    console.error('❌ [rq] GET /files/health:', err);
    res.status(500).json({ ok: false, message: 'Lỗi máy chủ' });
  }
});

router.use(requireAuth);
router.use('/chat', require('./chat'));
router.use('/admin/import', require('./imports')); // trước '/admin' — có bộ đọc JSON riêng (tệp Base ~1 MB)
router.use('/admin', require('./admin'));
router.use('/reports', require('./reports'));
router.use('/', require('./requests'));

module.exports = router;
