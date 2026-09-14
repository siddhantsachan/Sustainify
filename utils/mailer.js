const nodemailer = require("nodemailer");

/**
 * Shared nodemailer transporter.
 * Design decision: Single transporter instance reused across all routes.
 * Previously each route file created its own transporter — redundant setup.
 * Credentials come from .env so they are never committed to source control.
 */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.PASS,
  },
});

function sendMail(to, subject, text) {
  return transporter.sendMail({
    from: process.env.EMAIL,
    to,
    subject,
    text,
  });
}

module.exports = { sendMail };
