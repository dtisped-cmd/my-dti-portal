import nodemailer from 'nodemailer';

const getSmtpTransporter = () => {
  // استخدام المعرّف الرسمي لخدمة الجيميل لتفادي أخطاء المنافذ محلياً
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: "dtisped@gmail.com",
      pass: "pucckvikxyqcnqtd",
    },
  });
};

const escapeHtml = (value: string | number | null | undefined) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  const transporter = getSmtpTransporter();
  const recipient = to.trim();
  const sender = "dtisped@gmail.com";

  if (!transporter || !sender || !recipient) {
    return { success: false, error: 'smtp-not-configured-or-recipient-missing' };
  }

  try {
    await transporter.sendMail({
      from: `معهد طب الأسنان <${sender}>`,
      to: recipient,
      subject,
      html,
    });
    return { success: true };
  } catch (error) {
    console.error('Email notification failed:', error);
    return { success: false, error: 'email-send-failed' };
  }
}

export const buildClassChangeEmail = ({
  studentName,
  previousClass,
  nextClass,
}: {
  studentName: string;
  previousClass: string;
  nextClass: string;
}) => {
  const safeStudentName = escapeHtml(studentName);
  const safePreviousClass = escapeHtml(previousClass || 'غير محددة');
  const safeNextClass = escapeHtml(nextClass);
  const logoUrl = 'https://netlify.app';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>تحديث الفئة الأكاديمية</title>
  </head>
  <body style="margin:0; padding:0; background-color:#0f172a; font-family:'Segoe UI',Tahoma,Arial,sans-serif; direction:rtl; color:#e2e8f0;">
    <div style="width:100%; padding:30px 0; background-color:#0f172a;">
      <div style="width:92%; max-width:600px; margin:0 auto; overflow:hidden; background:#1e293b; border:1px solid #334155; border-radius:16px; box-shadow:0 10px 25px rgba(0,0,0,.5);">
        <div style="padding:30px 20px; text-align:center; background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%); border-bottom:2px solid #d97706;">
          <img src="${logoUrl}" alt="شعار المعهد" width="90" style="display:block; max-width:90px; height:auto; margin:0 auto 12px; border-radius:12px;">
          <h1 style="margin:0; color:#fff; font-size:22px; font-weight:700;">المعهد التقاني لطب الأسنان</h1>
          <p style="margin:8px 0 0; color:#cbd5e1; font-size:14px;">جامعة اللاذقية</p>
        </div>

        <div style="padding:30px 25px; text-align:right;">
          <div style="margin-bottom:12px; color:#f8fafc; font-size:18px; font-weight:600;">مرحبًا ${safeStudentName}،</div>
          <div style="margin-bottom:25px; color:#94a3b8; font-size:15px; line-height:1.8;">
            نود إعلامك بأنه تم تحديث بياناتك الأكاديمية بنجاح على نظام المعهد، وقد شمل التحديث تغيير الفئة المخصصة لك.
          </div>

          <div style="margin:20px 0; padding:20px; background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%); border:2px solid #f59e0b; border-radius:14px; box-shadow:0 8px 20px rgba(245,158,11,.15);">
            <div style="margin-bottom:15px; text-align:center; color:#fbbf24; font-size:14px; font-weight:700;">✨ تفاصيل الفئة الأكاديمية ✨</div>
            <table role="presentation" width="100%" style="border-collapse:collapse; text-align:center;">
              <tr>
                <td width="42%" style="padding:5px; vertical-align:middle;">
                  <div style="margin-bottom:6px; color:#cbd5e1; font-size:13px;">الفئة السابقة</div>
                  <div style="color:#94a3b8; font-size:20px; font-weight:700; text-decoration:line-through;">${safePreviousClass}</div>
                </td>
                <td width="16%" style="padding:5px; vertical-align:middle; color:#f59e0b; font-size:22px;">←</td>
                <td width="42%" style="padding:5px; vertical-align:middle;">
                  <div style="margin-bottom:6px; color:#cbd5e1; font-size:13px;">الفئة الجديدة</div>
                  <div style="color:#f59e0b; font-size:26px; font-weight:800;">${safeNextClass}</div>
                </td>
              </tr>
            </table>
          </div>
        </div>

        <div style="padding:20px; text-align:center; background:#0f172a; border-top:1px solid #1e293b; color:#64748b; font-size:13px; line-height:1.8;">
          جميع الحقوق محفوظة © المعهد التقاني لطب الأسنان<br>
          هذه الرسالة أُرسلت تلقائيًا، يرجى عدم الرد عليها مباشرة.
        </div>
      </div>
    </div>
  </body>
</html>`;
};