import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalized = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();
const complaintCategories = ['مدرس', 'طالب', 'أخرى'];
const suggestionCategories = ['البوابة', 'المعهد', 'أخرى'];
const firstDegreeValues = [
  '1', '١', 'one', 'first', 'firstdegree', 'اولى', 'الأولى', 'الدرجةالأولى', 'درجةالأولى',
  '1st', '1stdegree', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور',
];

const errorResponse = (
  error: string,
  status: number,
  diagnostics?: { databaseCode?: string; databaseConstraint?: string }
) => NextResponse.json({
  success: false,
  error,
  ...(diagnostics?.databaseCode ? { databaseCode: diagnostics.databaseCode } : {}),
  ...(diagnostics?.databaseConstraint ? { databaseConstraint: diagnostics.databaseConstraint } : {}),
}, { status });

const feedbackInsertErrorResponse = (error: { code?: string; message?: string; details?: string; hint?: string }) => {
  console.error('STUDENT_FEEDBACK_INSERT_FAILED:', {
    code: error.code,
    message: error.message,
  });

  const publicErrors: Record<string, string> = {
    '42P01': 'feedback-table-not-found',
    'PGRST205': 'feedback-table-not-found',
    'PGRST204': 'feedback-schema-out-of-date',
    '42501': 'feedback-write-permission-denied',
    '23514': 'feedback-check-constraint-failed',
    '22001': 'feedback-field-too-long',
    '23502': 'feedback-required-field-missing',
  };
  const constraint = error.code === '23514'
    ? error.message?.match(/violates check constraint "([^"]+)"/i)?.[1]
    : undefined;
  return errorResponse(publicErrors[error.code ?? ''] ?? 'submission-failed', 500, {
    databaseCode: error.code,
    databaseConstraint: constraint,
  });
};

const getStudentName = (student: Record<string, unknown>) =>
  ['اسم الطالب', 'اسم الاب', 'اسم الأب', 'الكنية']
    .map((key) => clean(student[key]))
    .filter(Boolean)
    .join(' ') || clean(student.name ?? student.student_name) || 'غير متوفر';

const verifyFirstDegreeSupervisor = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('المشرفين').select('*');
  if (error) return { valid: false, failed: true };
  const supervisor = (data ?? []).find((row) => {
    const record = row as Record<string, unknown>;
    const savedUsername = record['اسم المستخدم'] ?? record.username ?? record['اسم_المستخدم'] ?? record.user_name;
    const savedPassword = record['كلمة المرور'] ?? record['كلمة السر'] ?? record['كلمة_المرور'] ?? record.password ?? record.pass;
    return normalized(savedUsername) === normalized(username) && clean(savedPassword) === password;
  }) as Record<string, unknown> | undefined;
  const degree = normalized(supervisor?.['الدرجة'] ?? supervisor?.degree ?? supervisor?.rank ?? supervisor?.role ?? supervisor?.level);
  return { valid: Boolean(supervisor && firstDegreeValues.includes(degree)), failed: false };
};

export async function POST(request: Request) {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse('invalid-request', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return errorResponse('invalid-request', 400);
  }
  const body = parsed as Record<string, unknown>;
  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('server-not-configured', 503);

  if (body.action === 'submit') {
    const studentId = clean(body.studentId);
    const password = clean(body.password);
    const kind = clean(body.kind);
    const category = clean(body.category);
    const details = clean(body.details);
    if (!studentId || studentId.length > 80 || !password || password.length > 256) {
      return errorResponse('student-credentials-required', 400);
    }
    if ((kind !== 'complaint' && kind !== 'suggestion')
      || !(kind === 'complaint' ? complaintCategories : suggestionCategories).includes(category)
      || !details || details.length > 3000) {
      return errorResponse('invalid-submission', 400);
    }

    const { data: student, error: studentError } = await supabase.from('students')
      .select('*').eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) return errorResponse('student-lookup-failed', 500);
    if (!student || clean(student['كلمة السر'] ?? student.password ?? student.pass) !== password) {
      return errorResponse('student-credentials-invalid', 401);
    }

    const { error } = await supabase.from('student_feedback').insert({
      kind,
      category,
      details,
      student_id: clean(student['الرقم الجامعي']),
      student_name: getStudentName(student as Record<string, unknown>),
    });
    if (error) return feedbackInsertErrorResponse(error);
    return NextResponse.json({ success: true });
  }

  if (body.action === 'list' || body.action === 'delete') {
    const username = clean(body.supervisorUsername);
    const password = clean(body.supervisorPassword);
    if (!username || username.length > 80 || !password || password.length > 256) {
      return errorResponse('supervisor-credentials-required', 400);
    }
    const verification = await verifyFirstDegreeSupervisor(supabase, username, password);
    if (verification.failed) return errorResponse('supervisor-lookup-failed', 500);
    if (!verification.valid) return errorResponse('first-degree-supervisor-required', 403);

    if (body.action === 'delete') {
      const id = clean(body.id);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return errorResponse('invalid-feedback-id', 400);
      }
      const { data, error } = await supabase.from('student_feedback').delete().eq('id', id).select('id').maybeSingle();
      if (error) return errorResponse('feedback-delete-failed', 500);
      if (!data) return errorResponse('feedback-not-found', 404);
      return NextResponse.json({ success: true });
    }

    const submissions = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase.from('student_feedback')
        .select('id, kind, category, details, student_id, student_name, created_at')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) return errorResponse('feedback-load-failed', 500);
      submissions.push(...(data ?? []));
      if (!data || data.length < pageSize) break;
    }
    return NextResponse.json({ success: true, submissions });
  }

  return errorResponse('invalid-action', 400);
}
