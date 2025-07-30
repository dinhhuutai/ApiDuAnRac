// src/middleware/uploadMiddleware.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // tối đa 5MB mỗi file
  }
}); // ⬅️ đây là object có .array()

module.exports = upload;
