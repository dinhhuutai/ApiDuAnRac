const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: "dvueewtsp",
  api_key: "177995476764214",
  api_secret: "7_RGTKTb4aObkPNQXzu2Y0MAqfY",
});

module.exports = { cloudinary };
