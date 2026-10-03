import { randomBytes, scryptSync } from 'crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
const normalized = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();
const errorResponse = (error: string, status: number, message?: string, code?: string) => NextResponse.json({
  success: false,
  error,
  ...(message ? { message } : {}),
  ...(code ? { code } : {}),
}, { status });
const databaseErrorResponse = (operation: string, error: unknown, status = 500) => {
  const databaseError = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = clean(databaseError.message) || (error instanceof Error ? error.message : 'Unknown database error');
  const code = clean(databaseError.code) || undefined;
  console.error(`ACADEMIC_MANAGEMENT_${operation.toUpperCase()}_FAILED:`, {
    message,
    code,
    details: clean(databaseError.details) || undefined,
    hint: clean(databaseError.hint) || undefined,
  });
  return errorResponse(operation, status, message, code);
};
const validYear = (value: unknown): value is 'أولى' | 'ثانية' => value === 'أولى' || value === 'ثانية';
const validLoginUsername = (value: string) => /^[\p{L}\p{N}_.-]{3,80}$/u.test(value);
const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};
const normalizeYear = (value: unknown): 'أولى' | 'ثانية' | '' => {
  const year = clean(value).replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١'].includes(year) || year.includes('اولى') || year.includes('أولى') || year.includes('first')) return 'أولى';
  if (['2', '٢'].includes(year) || year.includes('ثانية') || year.includes('second')) return 'ثانية';
  return '';
};

const verifySupervisor = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('المشرفين').select('*');
  if (error) throw new Error(`supervisor-lookup-failed: ${error.message}`);
  const supervisor = (Array.isArray(data) ? data : []).find((row) => {
    if (!row || typeof row !== 'object') return false;
    const record = row as Record<string, unknown>;
    return normalized(record['اسم المستخدم'] ?? record.username ?? record['اسم_المستخدم'] ?? record.user_name) === normalized(username)
      && clean(record['كلمة المرور'] ?? record['كلمة السر'] ?? record['كلمة_المرور'] ?? record.password ?? record.pass) === password;
  }) as Record<string, unknown> | undefined;
  if (!supervisor) return false;
  const degree = normalized(supervisor['الدرجة'] ?? supervisor.degree ?? supervisor.rank ?? supervisor.role ?? supervisor.level);
  return ['1', '١', 'one', 'first', 'اولى', 'الأولى', '1st', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور']
    .some((value) => degree.includes(normalized(value)));
};

async function syncTeacherSubjectNames(
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  teacherId: string
) {
  const [{ data, error }, { data: teacher, error: teacherError }] = await Promise.all([
    supabase.from('academic_subjects').select('name').eq('teacher_id', teacherId),
    supabase.from('teachers').select('subjects').eq('id', teacherId).maybeSingle(),
  ]);
  if (error) throw error;
  if (teacherError) throw teacherError;
  const legacySubjects = Array.isArray(teacher?.subjects) ? teacher.subjects.map(clean).filter(Boolean) : [];
  const subjects = [...new Set([...legacySubjects, ...(data ?? []).map((row) => clean(row.name)).filter(Boolean)])];
  const { error: updateError } = await supabase.from('teachers').update({ subjects }).eq('id', teacherId);
  if (updateError) throw updateError;
}

export async function POST(request: Request) {
  try {
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch (error) {
      return errorResponse('invalid-json-body', 400, error instanceof Error ? error.message : 'Request body must be valid JSON.');
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return errorResponse('invalid-request-body', 400, 'Request body must be a JSON object.');
    }
    const body = parsedBody as Record<string, unknown>;
    const action = clean(body.action);
    const username = clean(body.supervisorUsername);
    const password = clean(body.supervisorPassword);
    if (!username || !password) return errorResponse('supervisor-credentials-required', 400);
    const supportedActions = [
      'list', 'save-teacher', 'delete-teacher', 'save-subject', 'delete-subject',
      'save-class', 'delete-class', 'save-schedule', 'delete-schedule',
    ];
    if (!supportedActions.includes(action)) return errorResponse('invalid-action', 400);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!supabaseUrl || !serviceRoleKey) {
      return errorResponse('academic-management-server-key-missing', 503, 'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the server environment.');
    }
    let supabase: ReturnType<typeof createSupabaseAdminClient>;
    try {
      supabase = createSupabaseAdminClient();
    } catch (error) {
      return databaseErrorResponse('supabase-client-configuration-failed', error, 503);
    }
    if (!supabase) return errorResponse('academic-management-server-key-missing', 503, 'Supabase admin client could not be initialized.');
    if (!await verifySupervisor(supabase, username, password)) return errorResponse('supervisor-credentials-invalid', 401);

    if (action === 'list') {
      const [teachers, subjects, classes, schedule] = await Promise.all([
        supabase.from('teachers').select('id, teacher_name, is_active, login_username').order('teacher_name'),
        supabase.from('academic_subjects').select('id, name, student_year, teacher_id').order('student_year').order('name'),
        supabase.from('student_classes').select('id, name, student_year, capacity').order('student_year').order('name'),
        supabase.from('schedule_items').select('id, day, start_time, end_time, subject, type, location, group_name, student_year, teacher_id').order('student_year').order('day').order('start_time'),
      ]);
      const failed = [teachers, subjects, classes, schedule].find((result) => result.error);
      if (failed?.error) return databaseErrorResponse('academic-management-load-failed', failed.error);
      return NextResponse.json({
        success: true,
        teachers: teachers.data ?? [],
        subjects: subjects.data ?? [],
        classes: classes.data ?? [],
        schedule: schedule.data ?? [],
      });
    }

    if (action === 'save-teacher') {
      const id = clean(body.id);
      const teacherName = clean(body.teacherName);
      const loginUsername = normalized(body.loginUsername);
      const newPassword = clean(body.newPassword);
      if (!teacherName || teacherName.length > 160) return errorResponse('invalid-teacher', 400);
      if ((!id && (!validLoginUsername(loginUsername) || newPassword.length < 8))
        || (loginUsername && !validLoginUsername(loginUsername))
        || (newPassword && newPassword.length < 8)) {
        return errorResponse('invalid-teacher-account', 400, 'اسم المستخدم يجب أن يكون 3 محارف على الأقل وكلمة المرور 8 محارف على الأقل.');
      }
      const payload: Record<string, unknown> = { teacher_name: teacherName, is_active: body.isActive !== false };
      if (loginUsername) payload.login_username = loginUsername;
      if (newPassword) payload.password_hash = hashPassword(newPassword);
      const result = id
        ? await supabase.from('teachers').update(payload).eq('id', id).select('id, teacher_name, is_active, login_username').maybeSingle()
        : await supabase.from('teachers').insert({ ...payload, subjects: [] }).select('id, teacher_name, is_active, login_username').single();
      if (result.error) return databaseErrorResponse('teacher-save-failed', result.error);
      if (!result.data) return errorResponse('teacher-not-found', 404);
      return NextResponse.json({ success: true, teacher: result.data });
    }

    if (action === 'delete-teacher') {
      const id = clean(body.id);
      if (!id) return errorResponse('invalid-teacher', 400);
      const { error: scheduleError } = await supabase.from('schedule_items').delete().eq('teacher_id', id);
      if (scheduleError) return databaseErrorResponse('teacher-delete-failed', scheduleError);
      const { error } = await supabase.from('teachers').delete().eq('id', id);
      if (error) return databaseErrorResponse('teacher-delete-failed', error);
      return NextResponse.json({ success: true });
    }

    if (action === 'save-subject') {
      const id = clean(body.id);
      const name = clean(body.name);
      const studentYear = body.studentYear;
      const teacherId = clean(body.teacherId);
      if (!name || name.length > 160 || !validYear(studentYear) || !teacherId) return errorResponse('invalid-subject', 400);
      const { data: teacher, error: teacherError } = await supabase.from('teachers')
        .select('id, is_active').eq('id', teacherId).maybeSingle();
      if (teacherError) return databaseErrorResponse('teacher-lookup-failed', teacherError);
      if (!teacher || teacher.is_active !== true) return errorResponse('teacher-not-found-or-disabled', 400);
      const previousSubject = id
        ? await supabase.from('academic_subjects').select('name, student_year, teacher_id').eq('id', id).maybeSingle()
        : null;
      if (previousSubject?.error) return databaseErrorResponse('subject-lookup-failed', previousSubject.error);
      if (id && !previousSubject?.data) return errorResponse('subject-not-found', 404);
      const payload = { name, student_year: studentYear, teacher_id: teacherId, updated_at: new Date().toISOString() };
      const result = id
        ? await supabase.from('academic_subjects').update(payload).eq('id', id).select('id, teacher_id').maybeSingle()
        : await supabase.from('academic_subjects').insert(payload).select('id, teacher_id').single();
      if (result.error) return errorResponse('subject-save-failed', 409);
      if (!result.data) return errorResponse('subject-not-found', 404);
      if (previousSubject?.data) {
        const { error: scheduleUpdateError } = await supabase.from('schedule_items').update({
          subject: name,
          student_year: studentYear,
          teacher_id: teacherId,
        }).eq('subject', previousSubject.data.name)
          .eq('student_year', previousSubject.data.student_year)
          .eq('teacher_id', previousSubject.data.teacher_id);
        if (scheduleUpdateError) return databaseErrorResponse('schedule-save-failed', scheduleUpdateError);
      }
      await syncTeacherSubjectNames(supabase, result.data.teacher_id);
      if (previousSubject?.data && previousSubject.data.teacher_id !== result.data.teacher_id) {
        await syncTeacherSubjectNames(supabase, previousSubject.data.teacher_id);
      }
      return NextResponse.json({ success: true });
    }

    if (action === 'delete-subject') {
      const id = clean(body.id);
      if (!id) return errorResponse('invalid-subject', 400);
      const { data: subject, error: lookupError } = await supabase.from('academic_subjects')
        .select('name, student_year, teacher_id').eq('id', id).maybeSingle();
      if (lookupError) return databaseErrorResponse('subject-lookup-failed', lookupError);
      if (!subject) return errorResponse('subject-not-found', 404);
      const { error: scheduleError } = await supabase.from('schedule_items').delete()
        .eq('subject', subject.name).eq('student_year', subject.student_year).eq('teacher_id', subject.teacher_id);
      if (scheduleError) return databaseErrorResponse('subject-delete-failed', scheduleError);
      const { data, error } = await supabase.from('academic_subjects').delete().eq('id', id).select('teacher_id').maybeSingle();
      if (error) return databaseErrorResponse('subject-delete-failed', error);
      if (!data) return errorResponse('subject-not-found', 404);
      await syncTeacherSubjectNames(supabase, data.teacher_id);
      return NextResponse.json({ success: true });
    }

    if (action === 'save-class') {
      const id = clean(body.id);
      const name = clean(body.name);
      const studentYear = body.studentYear;
      const capacity = body.capacity === '' || body.capacity === null ? null : Number(body.capacity);
      if (!name || name.length > 80 || !validYear(studentYear) || (capacity !== null && (!Number.isInteger(capacity) || capacity < 0))) {
        return errorResponse('invalid-class', 400);
      }
      const previousClass = id
        ? await supabase.from('student_classes').select('name, student_year').eq('id', id).maybeSingle()
        : null;
      if (previousClass?.error) return databaseErrorResponse('class-lookup-failed', previousClass.error);
      if (id && !previousClass?.data) return errorResponse('class-not-found', 404);
      if (previousClass?.data && (previousClass.data.name !== name || previousClass.data.student_year !== studentYear)) {
        const existingClass = previousClass.data;
        const [{ data: students, error: studentsError }, { data: scheduledItems, error: scheduleError }] = await Promise.all([
          supabase.from('students').select('*'),
          supabase.from('schedule_items').select('id').eq('group_name', existingClass.name).eq('student_year', existingClass.student_year),
        ]);
        if (studentsError || scheduleError) return databaseErrorResponse('class-save-failed', studentsError ?? scheduleError);
        const hasStudents = (students ?? []).some((row) => {
          const student = row as Record<string, unknown>;
          const className = clean(student['الفئة'] ?? student.class ?? student.class_name ?? student['اسم الفئة']).replace(/^فئة\s*/, '');
          const year = clean(student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year);
          return className === existingClass.name && normalizeYear(year) === existingClass.student_year;
        });
        if (hasStudents || (scheduledItems ?? []).length > 0) {
          return errorResponse('class-in-use', 409);
        }
      }
      const payload = { name, student_year: studentYear, capacity, updated_at: new Date().toISOString() };
      const result = id
        ? await supabase.from('student_classes').update(payload).eq('id', id).select('id').maybeSingle()
        : await supabase.from('student_classes').insert(payload).select('id').single();
      if (result.error) return errorResponse('class-save-failed', 409);
      if (!result.data) return errorResponse('class-not-found', 404);
      return NextResponse.json({ success: true });
    }

    if (action === 'delete-class') {
      const id = clean(body.id);
      if (!id) return errorResponse('invalid-class', 400);
      const { data: academicClass, error: lookupError } = await supabase.from('student_classes')
        .select('name, student_year').eq('id', id).maybeSingle();
      if (lookupError) return databaseErrorResponse('class-lookup-failed', lookupError);
      if (!academicClass) return errorResponse('class-not-found', 404);
      const { data: students, error: studentsError } = await supabase.from('students').select('*');
      if (studentsError) return databaseErrorResponse('class-delete-failed', studentsError);
      const hasStudents = (students ?? []).some((row) => {
        const student = row as Record<string, unknown>;
        const className = clean(student['الفئة'] ?? student.class ?? student.class_name ?? student['اسم الفئة']).replace(/^فئة\s*/, '');
        const year = clean(student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year);
        return className === academicClass.name && normalizeYear(year) === academicClass.student_year;
      });
      if (hasStudents) return errorResponse('class-in-use', 409);
      const { data: scheduledItems, error: scheduleError } = await supabase.from('schedule_items').select('id')
        .eq('group_name', academicClass.name).eq('student_year', academicClass.student_year);
      if (scheduleError) return databaseErrorResponse('class-delete-failed', scheduleError);
      if ((scheduledItems ?? []).length) return errorResponse('class-in-use', 409);
      const { error } = await supabase.from('student_classes').delete().eq('id', id);
      if (error) return databaseErrorResponse('class-delete-failed', error);
      return NextResponse.json({ success: true });
    }

    if (action === 'save-schedule') {
      const id = clean(body.id);
      const subject = clean(body.subject);
      const studentYear = body.studentYear;
      const day = clean(body.day);
      const startTime = clean(body.startTime);
      const endTime = clean(body.endTime);
      const location = clean(body.location);
      const groupName = clean(body.groupName);
      const teacherId = clean(body.teacherId);
      const type = clean(body.type) || 'محاضرة';
      if (!subject || !validYear(studentYear) || !day || !startTime || !endTime || !teacherId) {
        return errorResponse('invalid-schedule-item', 400);
      }
      const { data: assignment, error: assignmentError } = await supabase.from('academic_subjects')
        .select('id').eq('name', subject).eq('student_year', studentYear).eq('teacher_id', teacherId).maybeSingle();
      if (assignmentError) return databaseErrorResponse('subject-lookup-failed', assignmentError);
      if (!assignment) return errorResponse('subject-assignment-required', 400);
      const payload = {
        day,
        start_time: startTime,
        end_time: endTime,
        subject,
        type,
        location,
        group_name: groupName,
        student_year: studentYear,
        teacher_id: teacherId,
      };
      const result = id
        ? await supabase.from('schedule_items').update(payload).eq('id', id).select('id').maybeSingle()
        : await supabase.from('schedule_items').insert(payload).select('id').single();
      if (result.error) return databaseErrorResponse('schedule-save-failed', result.error);
      if (!result.data) return errorResponse('schedule-item-not-found', 404);
      return NextResponse.json({ success: true });
    }

    if (action === 'delete-schedule') {
      const id = clean(body.id);
      if (!id) return errorResponse('invalid-schedule-item', 400);
      const { error } = await supabase.from('schedule_items').delete().eq('id', id);
      if (error) return databaseErrorResponse('schedule-delete-failed', error);
      return NextResponse.json({ success: true });
    }

    return errorResponse('invalid-action', 400);
  } catch (error) {
    return databaseErrorResponse('academic-management-request-failed', error);
  }
}
