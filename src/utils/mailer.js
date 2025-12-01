// mailer.js
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: "dinhhuutai317678@gmail.com",
    pass: "vasj wyfv qsxp uaxb",
  },
});

async function sendSuggestionEmail({ to, subject, html }) {
  try {
    const info = await transporter.sendMail({
      from: '"Hệ thống góp ý Thuận Hưng Long An" <dinhhuutai317678@gmail.com>',
      to,
      subject,
      html,
    });

    console.log("📧 Đã gửi email:", info.messageId);
    return { success: true };
  } catch (err) {
    // ⬇️ Ở đây QUAN TRỌNG: không throw ra ngoài, chỉ log thôi
    console.error("⚠️ Gửi email góp ý thất bại (nhưng góp ý vẫn được lưu):", err);

    // Nếu muốn, có thể check riêng case quota:
    if (err?.responseCode === 550) {
      console.error("⚠️ Gmail báo hết quota / bị giới hạn gửi mail (550).");
    }

    // Trả về false để route biết là gửi mail fail, nhưng KHÔNG throw
    return { success: false, error: err };
  }
}

module.exports = { sendSuggestionEmail };
