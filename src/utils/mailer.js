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

// Same shell as otpEmailHtml — header bar, card, footer — but the body is a
// call-to-action button instead of a code block. Kept as a sibling rather than
// bolted onto otpEmailHtml with optional args, so neither template can change
// the other's layout by accident.
function actionEmailHtml({ title, intro, buttonLabel, link, footnote }) {
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
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${link}" style="display:inline-block;background:#0f2345;color:white;text-decoration:none;font-weight:600;font-size:1rem;padding:14px 32px;border-radius:12px;">${buttonLabel}</a>
      </div>
      <p style="color:#9CA3AF;font-size:0.8125rem;margin:0 0 16px;line-height:1.5;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <span style="color:#4B5563;word-break:break-all;">${link}</span>
      </p>
      <p style="color:#9CA3AF;font-size:0.8125rem;margin:0;line-height:1.5;">${footnote}</p>
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

// The one-time link that lets a school admin choose a new password.
//
// A sibling of sendTeacherInvite rather than a shared "send a link" helper: the
// two differ in expiry, in copy and in who is being reassured about what, and
// collapsing them would mean a parameter for each of those differences.
//
// `link` arrives already built, for the same reason it does there — the caller
// is what knows the token's lifetime, and the footnote below has to agree with
// it. schoolName is optional because an admin whose school row is not yet
// created still has an account to get back into.
async function sendPasswordResetLink({ to, name, schoolName, link }) {
  await transporter.sendMail({
    from: `"SIS Support" <${process.env.MAIL_USERNAME}>`,
    to,
    subject: 'Reset your SIS password',
    html: actionEmailHtml({
      title: 'Reset your password',
      intro:
        `Hi ${name}! We received a request to reset the password for your ` +
        `${schoolName ? `${schoolName} account on SIS` : 'SIS account'}. ` +
        'Choose a new one below.',
      buttonLabel: 'Reset your password',
      link,
      footnote:
        'This link expires in <strong>1 hour</strong> and can only be used once. ' +
        'Do not share it with anyone.<br>' +
        'If you did not request this, you can safely ignore this email — your ' +
        'password has not been changed.',
    }),
  });
}

// The one-time link that lets a teacher set their own password and log in.
// `link` already carries the invite token as a query param — this function does
// not build it, because the token's lifetime (72h) and the copy below have to
// agree, and the caller is what knows the link's shape.
async function sendTeacherInvite({ to, name, schoolName, link }) {
  await transporter.sendMail({
    from: `"SIS Support" <${process.env.MAIL_USERNAME}>`,
    to,
    subject: `Set up your SIS teacher login`,
    html: actionEmailHtml({
      title: 'Set up your teacher login',
      intro: `Hi ${name}! ${schoolName} has set up an SIS account for you. Choose a password to activate it and sign in.`,
      buttonLabel: 'Set your password',
      link,
      footnote:
        'This invitation expires in <strong>72 hours</strong>. Do not share this link with anyone.<br>' +
        'If you were not expecting this, you can safely ignore this email.',
    }),
  });
}

// The one-time link that lets an invited ADMINISTRATOR set their own password.
// Its own function rather than a parameter on sendTeacherInvite: the two say
// different things about what the person is being given, and an administrator
// told they were "set up as a teacher" would reasonably think the link was a
// mistake and ignore it. `link` already carries the invite token — the caller
// builds it, because the caller is what knows the token's 72h lifetime and the
// copy below has to agree with it.
async function sendAdminInvite({ to, name, schoolName, link }) {
  await transporter.sendMail({
    from: `"SIS Support" <${process.env.MAIL_USERNAME}>`,
    to,
    subject: `You have been invited to administer ${schoolName || 'a school'} on SIS`,
    html: actionEmailHtml({
      title: 'Set up your administrator login',
      intro: `Hi ${name}! ${schoolName || 'A school'} has invited you to help administer its SIS account. Choose a password to activate your login.`,
      buttonLabel: 'Set your password',
      link,
      footnote:
        'This invitation expires in <strong>72 hours</strong>. Do not share this link with anyone.<br>' +
        'If you were not expecting this, you can safely ignore this email.',
    }),
  });
}

module.exports = { sendSignupOtp, sendPasswordResetLink, sendTeacherInvite, sendAdminInvite };
