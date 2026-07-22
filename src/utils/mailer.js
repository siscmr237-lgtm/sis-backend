const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_SERVER || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_APP_PASSWORD,
  },
});

function otpEmailHtml({ title, intro, code }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f5f9;margin:0;padding:32px 16px;">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="background:#0f2345;padding:20px 32px;">
      <span style="color:white;font-size:1.125rem;font-weight:600;">SIS — School Information System</span>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#0f2345;margin:0 0 12px;font-size:1.25rem;">${title}</h2>
      <p style="color:#4B5563;line-height:1.6;margin:0 0 24px;">${intro}</p>
      <div style="background:#F3F4F6;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
        <span style="font-size:2.25rem;font-weight:700;letter-spacing:0.6rem;color:#0f2345;font-family:monospace;">${code}</span>
      </div>
      <p style="color:#9CA3AF;font-size:0.8125rem;margin:0;line-height:1.5;">
        This code expires in <strong>10 minutes</strong>. Do not share it with anyone.<br>
        If you did not request this, you can safely ignore this email.
      </p>
    </div>
    <div style="background:#F9FAFB;padding:16px 32px;border-top:1px solid #E5E7EB;">
      <p style="color:#9CA3AF;font-size:0.75rem;margin:0;">SIS Support · siscmr237@gmail.com · +237 679 379 134</p>
    </div>
  </div>
</body>
</html>`;
}

async function sendSignupOtp({ to, name, code }) {
  await transporter.sendMail({
    from: `"SIS Support" <${process.env.MAIL_USERNAME}>`,
    to,
    subject: `${code} — Your SIS verification code`,
    html: otpEmailHtml({
      title: 'Verify your account',
      intro: `Hi ${name}! Enter the code below to complete your SIS account setup.`,
      code,
    }),
  });
}

async function sendPasswordResetOtp({ to, name, code }) {
  await transporter.sendMail({
    from: `"SIS Support" <${process.env.MAIL_USERNAME}>`,
    to,
    subject: `${code} — Reset your SIS password`,
    html: otpEmailHtml({
      title: 'Reset your password',
      intro: `Hi ${name}! Enter the code below to reset your SIS account password.`,
      code,
    }),
  });
}

module.exports = { sendSignupOtp, sendPasswordResetOtp };
