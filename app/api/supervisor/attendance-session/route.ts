import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';
import { verifyFirstDegreeSupervisor } from '../../../../lib/supervisorAuth';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export async function DELETE(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: 'بيانات الطلب غير صالحة.' }, { status: 400 });
  }

  const sessionId = clean(body.sessionId);
  const username = clean(body.username);
  const password = clean(body.password);
  if (!sessionId || sessionId.length > 160 || !username || username.length > 120 || !password || password.length > 256) {
    return NextResponse.json({ success: false, error: 'بيانات المشرف والجلسة مطلوبة.' }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: 'خدمة قاعدة البيانات غير متاحة.' }, { status: 503 });
  }

  const verification = await verifyFirstDegreeSupervisor(supabase, username, password);
  if (verification.failed) {
    return NextResponse.json({ success: false, error: 'تعذر التحقق من صلاحية المشرف.' }, { status: 503 });
  }
  if (!verification.valid) {
    return NextResponse.json({ success: false, error: 'حذف الجلسات متاح لمشرفي الدرجة الأولى فقط.' }, { status: 403 });
  }

  const { data, error } = await supabase.rpc('delete_attendance_session', { p_session_id: sessionId });
  if (error) {
    console.error('ATTENDANCE_SESSION_DELETE_FAILED:', error.message);
    if (error.message.includes('attendance_session_active')) {
      return NextResponse.json({ success: false, error: 'لا يمكن حذف جلسة نشطة؛ أنهِ الجلسة أولاً.' }, { status: 409 });
    }
    if (error.message.includes('attendance_session_not_found')) {
      return NextResponse.json({ success: false, error: 'الجلسة غير موجودة أو حُذفت مسبقاً.' }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: 'تعذر حذف الجلسة. تحقق من تطبيق ترحيل قاعدة البيانات.' }, { status: 500 });
  }

  const result = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  return NextResponse.json({
    success: true,
    deletedAttendance: Number(result?.deleted_attendance ?? 0),
    deletedWarnings: Number(result?.deleted_warnings ?? 0),
  });
}
