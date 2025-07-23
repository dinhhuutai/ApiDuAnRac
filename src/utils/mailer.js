// mailer.js
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", // Hoặc SMTP server của bạn
  port: 587,
  secure: false,
  auth: {
    user: "dinhhuutai20023107@gmail.com", // Email gửi
    pass: "pmcw jvrt jrjg bkkq",    // App password (không phải mật khẩu đăng nhập Gmail)
  },
});

async function sendSuggestionEmail({ to, subject, html }) {
  const info = await transporter.sendMail({
    from: '"Hệ thống góp ý Thuận Hưng Long An"',
    to, // chuỗi email phân cách bằng dấu phẩy
    subject,
    html,
  });

  console.log("📧 Đã gửi email:", info.messageId);
}

module.exports = { sendSuggestionEmail };
