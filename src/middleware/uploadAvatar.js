const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const { cloudinary } = require("../config/cloudinary");

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "avatar",
    allowed_formats: ["jpg", "png", "jpeg", "webp"],
  },
});

const uploadAvatar = multer({ storage });

module.exports = uploadAvatar;