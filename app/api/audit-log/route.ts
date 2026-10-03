import { NextResponse } from 'next/server';
import { writeServerAuditLog } from '../../../lib/auditLogServer';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown, maxLength = 500) => String(value ?? '').trim().slice(0, maxLength);
const isAuditUserType = (value: string): value is 'student' | 'teacher' | 'supervisor' | 'system' =>
  ['student', 'teacher', 'supervisor', 'system'].includes(value);
const normalize = (value: unknown) => clean(value, 200).replace(/\s+/g, '').toLocaleLowerCase();

const readAuditLogs = async (username: string, password: string) => {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ success: false, error: 'audit-service-not-configured' }, { status: 503 });
  if (!username || !password) return NextResponse.json({ success: false, error: 'supervisor-credentials-required' }, { status: 400 });

  const { data: supervisors, error: supervisorsError } = await supabase.from('المشرفين').select('*');
  if (supervisorsError) {
    console.error('[audit] supervisor lookup failed:', supervisorsError.message);
    return NextResponse.json({ success: false, error: 'audit-supervisor-lookup-failed' }, { status: 500 });
  }
  const supervisor = (supervisors ?? []).find((row) => {
    const record = row as Record<string, unknown>;
    return normalize(record['اسم المستخدم'] ?? record.username ?? record['اسم_المستخدم'] ?? record.user_name) === normalize(username)
      && clean(record['كلمة المرور'] ?? record['كلمة السر'] ?? record['كلمة_المرور'] ?? record.password ?? record.pass) === password;
  }) as Record<string, unknown> | undefined;
  if (!supervisor) return NextResponse.json({ success: false, error: 'supervisor-credentials-invalid' }, { status: 401 });

  const degree = normalize(supervisor['الدرجة'] ?? supervisor.degree ?? supervisor.rank ?? supervisor.role ?? supervisor.level);
  const firstDegree = ['1', '١', 'one', 'first', 'اولى', 'الأولى', '1st', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور'];
  if (!firstDegree.some((value) => degree.includes(normalize(value)))) {
    return NextResponse.json({ success: false, error: 'audit-access-denied' }, { status: 403 });
  }

  const { data: logs, error: logsError } = await supabase.from('سجلات النظام')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (logsError) {
    console.error('[audit] log read failed:', logsError.message);
    return NextResponse.json({ success: false, error: 'audit-log-read-failed' }, { status: 500 });
  }
  return NextResponse.json({ success: true, logs: logs ?? [] });
};

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid-json-body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ success: false, error: 'invalid-request-body' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  if (payload.mode === 'read') {
    return readAuditLogs(clean(payload.username, 160), clean(payload.password, 300));
  }

  const action = clean(payload.action, 120);
  const userType = clean(payload.user_type, 20);
  if (!action || !isAuditUserType(userType)) {
    return NextResponse.json({ success: false, error: 'invalid-audit-event' }, { status: 400 });
  }

  try {
    const details = payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details)
      ? payload.details as Record<string, unknown>
      : {};
    await writeServerAuditLog(request, {
      action,
      userType,
      userId: payload.user_id === null || payload.user_id === undefined ? null : clean(payload.user_id, 160),
      username: clean(payload.username, 160) || null,
      fullName: clean(payload.full_name, 240) || null,
      deviceId: clean(payload.device_id, 160) || null,
      platform: clean(payload.platform, 160) || null,
      language: clean(payload.language, 80) || null,
      screenSize: clean(payload.screen_size, 40) || null,
      path: clean(payload.path, 500) || null,
      details,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[audit] request failed:', error);
    return NextResponse.json({ success: false, error: 'audit-request-failed' }, { status: 500 });
  }
}
