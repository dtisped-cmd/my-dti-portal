import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown, maxLength = 500) => String(value ?? '').trim().slice(0, maxLength);
const normalize = (value: unknown) => clean(value, 200).replace(/\s+/g, '').toLocaleLowerCase();

const isFirstDegreeSupervisor = (value: unknown) => {
  const degree = normalize(value)
    .replace(/الدرجة|درجة|درجه/g, '')
    .replace(/[\-_]/g, '');
  return ['1', '١', 'one', 'first', 'اولى', 'أولى', 'الأولى', '1st', 'moderator', 'مودرييتور', 'monitor', 'مراقب']
    .includes(degree);
};

const getSupervisorValue = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
};

const studentColumns = [
  'الرقم الجامعي',
  'كلمة السر',
  'اسم الطالب',
  'اسم الاب',
  'الكنية',
  'القسم',
  'الفئة',
  'السنه الدراسية',
  'رقم الهاتف',
  'البريد الإلكتروني',
  'نوع التسجيل',
  'ملاحظة',
] as const;

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
  const username = clean(payload.supervisorUsername, 160);
  const password = clean(payload.supervisorPassword, 300);
  if (!username || !password) {
    return NextResponse.json({ success: false, error: 'supervisor-credentials-required' }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: 'student-account-service-not-configured' }, { status: 503 });
  }

  const { data: supervisors, error: supervisorsError } = await supabase.from('المشرفين').select('*');
  if (supervisorsError) {
    console.error('[student-accounts] supervisor lookup failed:', supervisorsError.message);
    return NextResponse.json({ success: false, error: 'supervisor-lookup-failed' }, { status: 500 });
  }

  const supervisor = (supervisors ?? []).find((row) => {
    const record = row as Record<string, unknown>;
    return normalize(getSupervisorValue(record, ['اسم المستخدم', 'username', 'اسم_المستخدم', 'user_name'])) === normalize(username)
      && clean(getSupervisorValue(record, ['كلمة المرور', 'كلمة السر', 'كلمة_المرور', 'password', 'pass']), 300) === password;
  }) as Record<string, unknown> | undefined;

  if (!supervisor) {
    return NextResponse.json({ success: false, error: 'supervisor-credentials-invalid' }, { status: 401 });
  }

  const degree = getSupervisorValue(supervisor, ['الدرجة', 'degree', 'درجه', 'rank', 'role', 'level']);
  if (!isFirstDegreeSupervisor(degree)) {
    return NextResponse.json({ success: false, error: 'first-degree-supervisor-required' }, { status: 403 });
  }

  if (!payload.student || typeof payload.student !== 'object' || Array.isArray(payload.student)) {
    return NextResponse.json({ success: false, error: 'invalid-student-account' }, { status: 400 });
  }

  const studentInput = payload.student as Record<string, unknown>;
  const student = Object.fromEntries(studentColumns
    .filter((column) => column !== 'الفئة' || clean(studentInput[column], 300) !== '')
    .map((column) => [column, clean(studentInput[column], column === 'ملاحظة' ? 1000 : 300)]));
  const studentId = String(student['الرقم الجامعي'] ?? '');
  const studentPassword = String(student['كلمة السر'] ?? '');
  const requiredFields = ['اسم الطالب', 'اسم الاب', 'الكنية', 'رقم الهاتف', 'البريد الإلكتروني', 'القسم'] as const;
  if (!studentId || !studentPassword || requiredFields.some((field) => !student[field])) {
    return NextResponse.json({ success: false, error: 'required-student-fields-missing' }, { status: 400 });
  }

  if (!['أولى', 'ثانية'].includes(String(student['السنه الدراسية'] ?? ''))) {
    return NextResponse.json({ success: false, error: 'invalid-student-year' }, { status: 400 });
  }

  const { error: insertError } = await supabase.from('students').insert([student]);
  if (insertError) {
    if (insertError.code === '23505') {
      return NextResponse.json({
        success: false,
        error: 'student-id-already-exists',
        code: insertError.code,
        message: insertError.message,
      }, { status: 409 });
    }
    if (insertError.code === '23502' && /\bnum\b/i.test(insertError.message)) {
      return NextResponse.json({
        success: false,
        error: 'student-num-sequence-not-configured',
      }, { status: 500 });
    }
    console.error('[student-accounts] student insert failed:', {
      code: insertError.code,
      message: insertError.message,
      details: insertError.details,
      hint: insertError.hint,
    });
    return NextResponse.json({
      success: false,
      error: 'student-account-save-failed',
      code: insertError.code,
      detail: insertError.message,
    }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
