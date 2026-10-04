import { randomInt } from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import { sendEmail } from '../../../../../lib/email';
import { buildStudentTelegramMessage, sendTelegramNotification } from '../../../../../lib/telegram';
import { normalizeStudentIdentifier } from '../../../../../lib/studentData';

export const dynamic = 'force-dynamic';

const normalize = (value: unknown) => String(value ?? '').trim();
const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const maskEmail = (email: string) => {
  const [name, domain] = email.split('@');
  if (!name || !domain) return 'البريد الإلكتروني المرتبط';
  return `${name.slice(0, 2)}***@${domain}`;
};

const getErrorDetails = (error: unknown) => ({
  message: error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error),
  code: (error as { code?: string })?.code,
  details: (error as { details?: string })?.details,
  hint: (error as { hint?: string })?.hint,
});

const jsonError = (error: string, status: number, details?: unknown) => NextResponse.json({
  success: false,
  error,
  ...(details ? { details } : {}),
}, { status });

export async function POST(request: Request) {
  let stage = 'start';

  try {
    stage = 'parse-request';
    const body = await request.json() as { identifier?: string; method?: 'telegram' | 'email' };
    const identifier = normalize(body.identifier);
    const normalizedIdentifier = normalizeStudentIdentifier(identifier);

    if (!identifier) return jsonError('missing-identifier', 400, 'أدخل البريد الإلكتروني أو الرقم أو الهاتف.');

    stage = 'find-student';
    const studentLookup = await supabase.from('students').select('*');
    if (studentLookup.error) {
      console.error('RESET_PASSWORD_ERROR:', studentLookup.error);
      return jsonError('student-query-failed', 500, getErrorDetails(studentLookup.error));
    }

    const student = (Array.isArray(studentLookup.data) ? studentLookup.data : []).find((row) => {
      const record = row as Record<string, unknown>;
      return [record['الرقم الجامعي'], record.student_id, record.studentId, record.id]
        .some((value) => normalizeStudentIdentifier(value) === normalizedIdentifier)
        || [record['رقم الهاتف'], record.phone]
          .some((value) => normalize(value) === identifier)
        || [record['البريد الإلكتروني'], record.email]
          .some((value) => normalize(value).toLowerCase() === identifier.toLowerCase());
    }) as Record<string, unknown> | undefined;

    if (!student) return jsonError('student-not-found', 404, 'لم يتم العثور على حساب مطابق للبيانات المدخلة.');

    const email = normalize(student['البريد الإلكتروني'] ?? student.email);
    if (!email) return jsonError('student-email-missing', 400, 'لا يوجد بريد إلكتروني مسجل لهذا الحساب.');

    const studentId = normalize(student['الرقم الجامعي'] ?? student.student_id ?? student.studentId ?? student.id) || identifier;
    const chatId = normalize(student.telegram_chat_id ?? student['telegram_chat_id']);
    const enabledValue = student.telegram_notifications_enabled ?? student['telegram_notifications_enabled'];
    const telegramEnabled = enabledValue === true || ['true', '1', 'yes'].includes(normalize(enabledValue).toLowerCase());
    const methods = [
      ...(telegramEnabled && chatId ? ['telegram' as const] : []),
      ...(email ? ['email' as const] : []),
    ];

    if (!methods.length) return jsonError('no-recovery-method', 400, 'لا توجد وسيلة استعادة مرتبطة بهذا الحساب.');
    if (!body.method && methods.length > 1) {
      return NextResponse.json({ success: true, methods, requiresMethod: true });
    }

    const method = methods.includes(body.method as 'telegram' | 'email') ? body.method : methods[0];
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    stage = 'save-reset-code';
    const { error: saveError } = await supabase.from('password_reset_requests').insert([{
      email,
      code,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      used: false,
    }]);
    if (saveError) {
      console.error('RESET_PASSWORD_ERROR:', saveError);
      const tableMissing = saveError.code === '42P01'
        || saveError.code === 'PGRST205'
        || saveError.message.toLowerCase().includes('password_reset_requests');
      return jsonError(tableMissing ? 'password-reset-table-missing' : 'reset-code-save-failed', 500, getErrorDetails(saveError));
    }

    const studentName = [
      student['اسم الطالب'] ?? student.name ?? student.student_name,
      student['اسم الاب'] ?? student['اسم الأب'] ?? student.father_name,
      student['الكنية'] ?? student.family_name ?? student.surname,
    ].map(normalize).filter(Boolean).join(' ') || 'الطالب';
    const username = normalize(
      student['اسم المستخدم'] ?? student.username ?? student.user_name ?? student.login_username
    ) || studentId;
    stage = method === 'telegram' ? 'send-telegram-code' : 'send-email-code';

    if (method === 'telegram' && chatId) {
      if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return jsonError('telegram-not-configured', 503, 'متغير TELEGRAM_BOT_TOKEN غير موجود في بيئة الخادم.');
      }

      const message = buildStudentTelegramMessage({
        studentName,
        studentId,
        studentYear: normalize(student['السنه الدراسية'] ?? student['السنة الدراسية']) || 'غير محدد',
        studentClass: normalize(student['الفئة']) || 'غير محددة',
        username,
        statusText: `رمز استعادة كلمة المرور الخاص بك هو: ${code}\nصالح لمدة 15 دقيقة.`,
        title: 'استعادة كلمة المرور',
      });
      const result = await sendTelegramNotification(message, { chatId, enabled: true });
      if (result?.ok !== true) {
        return jsonError('telegram-send-failed', 502, result?.description ?? result?.status ?? 'تعذر إرسال الرسالة عبر التليجرام.');
      }
    } else if (method === 'email') {
      const result = await sendEmail({
        to: email,
        subject: 'رمز استعادة كلمة المرور',
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8"><h2>استعادة كلمة المرور</h2><p>مرحبًا ${escapeHtml(studentName)}،</p><p><strong>اسم المستخدم:</strong> ${escapeHtml(username)}</p><p><strong>الرقم الجامعي:</strong> ${escapeHtml(studentId)}</p><p>رمز التحقق الخاص بك:</p><div style="font-size:30px;font-weight:800;letter-spacing:8px;color:#0f766e">${escapeHtml(code)}</div><p>الرمز صالح لمدة 15 دقيقة.</p></div>`,
      });
      if (!result.success) return jsonError('email-send-failed', 502, result.error ?? 'تعذر إرسال البريد الإلكتروني.');
    } else {
      return jsonError('code-send-failed', 502, 'طريقة الإرسال غير متاحة لهذا الحساب.');
    }

    return NextResponse.json({
      success: true,
      method,
      methods,
      destination: method === 'email' ? maskEmail(email) : 'حساب التليجرام المرتبط',
    });
  } catch (error) {
    console.error('RESET_PASSWORD_ERROR:', error);
    console.error('RESET_PASSWORD_STAGE:', stage);
    return jsonError('password-reset-request-failed', 500, error instanceof Error ? error.message : String(error));
  }
}
