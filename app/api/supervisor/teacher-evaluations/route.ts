import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';
import { teacherEvaluationsTemporarilyDisabled } from '../../../../lib/featureFlags';

export const dynamic = 'force-dynamic';

const responseError = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });
const clean = (value: unknown) => String(value ?? '').trim();
const normalize = (value: unknown) => clean(value).replace(/\s+/g, '').toLowerCase();

const isEvaluationAdmin = (row: Record<string, unknown>) => {
  const degree = normalize(row['الدرجة'] ?? row.degree ?? row.rank ?? row.role ?? row.level);
  return ['1', '١', 'one', 'first', 'اولى', 'الأولى', '1st', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور']
    .some((value) => degree.includes(normalize(value)));
};

const authorizeEvaluationAdmin = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('المشرفين').select('*');
  if (error) throw new Error('supervisor-verification-failed');

  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  const supervisor = rows.find((row) => (
    normalize(row['اسم المستخدم'] ?? row.username ?? row['اسم_المستخدم'] ?? row.user_name) === normalize(username)
    && normalize(row['كلمة المرور'] ?? row['كلمة السر'] ?? row['كلمة_المرور'] ?? row.password ?? row.pass) === normalize(password)
  ));
  if (!supervisor) return 'invalid';
  if (!isEvaluationAdmin(supervisor)) return 'forbidden';
  return 'authorized';
};

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return responseError('teacher-evaluation-server-key-missing', 503);

  try {
    if (teacherEvaluationsTemporarilyDisabled) return responseError('teacher-evaluation-temporarily-disabled', 503);
    const body = await request.json() as {
      action?: 'settings' | 'set-enabled' | 'report';
      username?: string;
      password?: string;
      enabled?: boolean;
    };
    const username = clean(body.username);
    const password = clean(body.password);
    if (!username || !password) return responseError('supervisor-credentials-required', 400);

    const authorization = await authorizeEvaluationAdmin(supabase, username, password);
    if (authorization === 'invalid') return responseError('supervisor-credentials-invalid', 401);
    if (authorization === 'forbidden') return responseError('supervisor-not-authorized', 403);

    if (body.action === 'settings') {
      const { data, error } = await supabase
        .from('portal_feature_settings')
        .select('enabled')
        .eq('feature_key', 'teacher_evaluation')
        .maybeSingle();
      if (error) return responseError('teacher-evaluation-setting-failed', 500);
      return NextResponse.json({ success: true, enabled: data?.enabled === true });
    }

    if (body.action === 'set-enabled') {
      if (typeof body.enabled !== 'boolean') return responseError('invalid-enabled-value', 400);
      const { data, error } = await supabase.from('portal_feature_settings').upsert({
        feature_key: 'teacher_evaluation',
        enabled: body.enabled,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'feature_key' }).select('enabled').maybeSingle();
      if (error || !data) return responseError('teacher-evaluation-setting-save-failed', 500);
      return NextResponse.json({ success: true, enabled: data.enabled === true });
    }

    if (body.action === 'report') {
      const [teachersResult, evaluationsResult] = await Promise.all([
        supabase.from('teachers').select('id, teacher_name, subjects, is_active').order('teacher_name'),
        supabase.from('teacher_evaluations')
          .select('id, student_id, student_name, teacher_id, subject, rating, note, updated_at')
          .order('updated_at', { ascending: false }),
      ]);
      if (teachersResult.error || evaluationsResult.error) return responseError('teacher-evaluation-report-failed', 500);

      const teachers = (Array.isArray(teachersResult.data) ? teachersResult.data : []) as Array<Record<string, unknown>>;
      const evaluations = (Array.isArray(evaluationsResult.data) ? evaluationsResult.data : []) as Array<Record<string, unknown>>;
      const teacherNames = Object.fromEntries(teachers.map((teacher) => [String(teacher.id ?? ''), String(teacher.teacher_name ?? 'مدرس غير معروف')]));
      return NextResponse.json({
        success: true,
        teachers,
        evaluations: evaluations.map((evaluation) => ({
          ...evaluation,
          teacher_name: teacherNames[String(evaluation.teacher_id ?? '')] ?? 'مدرس غير موجود',
        })),
      });
    }

    return responseError('invalid-action', 400);
  } catch {
    return responseError('teacher-evaluation-request-failed', 500);
  }
}
