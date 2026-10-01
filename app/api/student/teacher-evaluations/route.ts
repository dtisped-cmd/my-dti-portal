import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';
import { teacherEvaluationsTemporarilyDisabled } from '../../../../lib/featureFlags';

export const dynamic = 'force-dynamic';

const responseError = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });
const clean = (value: unknown) => String(value ?? '').trim();
const isEnabled = (value: unknown) => value === true || ['true', '1', 'yes'].includes(clean(value).toLowerCase());
const getStudentName = (row: Record<string, unknown>) => [
  row['اسم الطالب'] ?? row.name ?? row.student_name,
  row['اسم الاب'] ?? row['اسم الأب'] ?? row.father_name,
  row['الكنية'] ?? row.family_name ?? row.surname,
].map(clean).filter((value) => value && value !== '.' && value !== 'غير متوفر').join(' ');

export async function POST(request: Request) {
  try {
    if (teacherEvaluationsTemporarilyDisabled) return responseError('teacher-evaluation-temporarily-disabled', 503);
    const supabase = createSupabaseAdminClient();
    if (!supabase) return responseError('teacher-evaluation-server-key-missing', 503);

    const body = await request.json() as {
      action?: 'load' | 'save';
      studentId?: string;
      password?: string;
      teacherId?: string;
      subject?: string;
      rating?: number;
      note?: string;
    };
    const studentId = clean(body.studentId);
    const password = clean(body.password);
    if (!studentId || !password) return responseError('student-credentials-required', 400);

    const { data: student, error: studentError } = await supabase
      .from('students')
      .select('*')
      .eq('الرقم الجامعي', studentId)
      .maybeSingle();
    if (studentError) return responseError('student-verification-failed', 500);
    if (!student || clean(student['كلمة السر'] ?? student.password ?? student.pass) !== password) {
      return responseError('student-credentials-invalid', 401);
    }

    const { data: setting, error: settingError } = await supabase
      .from('portal_feature_settings')
      .select('enabled')
      .eq('feature_key', 'teacher_evaluation')
      .maybeSingle();
    if (settingError) return responseError('teacher-evaluation-setting-failed', 500);
    if (!isEnabled(setting?.enabled)) {
      return NextResponse.json({ success: true, enabled: false, teachers: [], ratings: [] });
    }

    if (body.action === 'load') {
      const [teachersResult, ratingsResult] = await Promise.all([
        supabase.from('teachers').select('id, teacher_name, subjects').eq('is_active', true).order('teacher_name'),
        supabase.from('teacher_evaluations')
          .select('teacher_id, subject, rating, note')
          .eq('student_id', studentId),
      ]);
      if (teachersResult.error || ratingsResult.error) return responseError('teacher-evaluation-data-failed', 500);

      return NextResponse.json({
        success: true,
        enabled: true,
        teachers: teachersResult.data ?? [],
        ratings: ratingsResult.data ?? [],
      });
    }

    if (body.action !== 'save') return responseError('invalid-action', 400);
    const teacherId = clean(body.teacherId);
    const subject = clean(body.subject);
    const rating = Number(body.rating);
    const note = clean(body.note);
    if (!teacherId || !subject || !Number.isInteger(rating) || rating < 0 || rating > 4 || note.length > 1000) {
      return responseError('invalid-teacher-evaluation', 400);
    }

    const { data: teacher, error: teacherError } = await supabase
      .from('teachers')
      .select('subjects')
      .eq('id', teacherId)
      .eq('is_active', true)
      .maybeSingle();
    if (teacherError) return responseError('teacher-verification-failed', 500);
    const teacherSubjects = Array.isArray(teacher?.subjects) ? teacher.subjects.map(clean) : [];
    if (!teacher || !teacherSubjects.includes(subject)) return responseError('teacher-subject-invalid', 400);

    const { data: savedEvaluation, error: saveError } = await supabase
      .from('teacher_evaluations')
      .upsert({
        student_id: studentId,
        student_name: getStudentName(student),
        teacher_id: teacherId,
        subject,
        rating,
        note,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'student_id,teacher_id,subject' })
      .select('teacher_id, subject, rating, note')
      .single();
    if (saveError) return responseError('teacher-evaluation-save-failed', 500);

    return NextResponse.json({ success: true, evaluation: savedEvaluation });
  } catch (error) {
    console.error('STUDENT_TEACHER_EVALUATION_POST_FAILED:', error);
    return responseError('teacher-evaluation-request-failed', 500);
  }
}
