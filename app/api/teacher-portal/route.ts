import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type TeacherRow = {
  id: string;
  teacher_name: string;
  subjects: unknown;
  is_active: boolean;
  login_username?: string | null;
  password_hash?: string | null;
};

const clean = (value: unknown) => String(value ?? '').trim();
const normalized = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();
const errorResponse = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });
const normalizeYear = (value: unknown): 'أولى' | 'ثانية' | '' => {
  const year = clean(value).replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١'].includes(year) || year.includes('اولى') || year.includes('أولى') || year.includes('first')) return 'أولى';
  if (['2', '٢'].includes(year) || year.includes('ثانية') || year.includes('second')) return 'ثانية';
  return '';
};
const getAssignmentLabel = (name: string, year: string) => `${name} · ${year}`;

const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyPassword = (password: string, storedHash: string) => {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash || !/^[a-f\d]{128}$/i.test(hash)) return false;
  const actualHash = scryptSync(password, salt, 64);
  return timingSafeEqual(actualHash, Buffer.from(hash, 'hex'));
};

const getTeacher = async (supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>, username: string, password: string) => {
  const { data, error } = await supabase
    .from('teachers')
    .select('id, teacher_name, subjects, is_active, login_username, password_hash')
    .eq('login_username', normalized(username))
    .maybeSingle();
  if (error) throw error;

  const teacher = data as TeacherRow | null;
  if (!teacher || teacher.is_active !== true || !teacher.password_hash || !verifyPassword(password, teacher.password_hash)) {
    return null;
  }
  return teacher;
};

const verifySupervisor = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('المشرفين').select('*');
  if (error) throw error;
  const supervisor = (Array.isArray(data) ? data : []).find((row) => {
    const record = row as Record<string, unknown>;
    return normalized(record['اسم المستخدم'] ?? record.username ?? record['اسم_المستخدم'] ?? record.user_name) === normalized(username)
      && clean(record['كلمة المرور'] ?? record['كلمة السر'] ?? record['كلمة_المرور'] ?? record.password ?? record.pass) === password;
  }) as Record<string, unknown> | undefined;
  if (!supervisor) return false;
  const degree = normalized(supervisor['الدرجة'] ?? supervisor.degree ?? supervisor.rank ?? supervisor.role ?? supervisor.level);
  return ['1', '١', 'one', 'first', 'اولى', 'الأولى', '1st', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور']
    .some((value) => degree.includes(normalized(value)));
};

const getStudentName = (student: Record<string, unknown>) => [
  student['اسم الطالب'] ?? student.name ?? student.student_name,
  student['اسم الاب'] ?? student['اسم الأب'] ?? student.father_name,
  student['الكنية'] ?? student.family_name ?? student.surname,
].map(clean).filter((part) => part && part !== '.').join(' ');

const getStudentYear = (student: Record<string, unknown>) => normalizeYear(
  student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year
);
const attendanceKey = (studentId: string, subject: string, date: string) => [
  studentId,
  normalized(subject),
  date.slice(0, 10),
].join('|');

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return errorResponse('teacher-portal-server-key-missing', 503);

  try {
    const body = await request.json() as {
      action?: string;
      username?: string;
      password?: string;
      supervisorUsername?: string;
      supervisorPassword?: string;
      teacherId?: string;
      teacherName?: string;
      loginUsername?: string;
      newPassword?: string;
      isActive?: boolean;
      studentId?: string;
      subject?: string;
      message?: string;
      alertId?: number;
    };

    if (body.action === 'student-alerts') {
      const studentId = clean(body.studentId);
      const password = clean(body.password);
      if (!studentId || !password) return errorResponse('student-credentials-required', 400);
      const { data: student, error: studentError } = await supabase
        .from('students')
        .select('*')
        .eq('الرقم الجامعي', studentId)
        .maybeSingle();
      if (studentError) return errorResponse('student-verification-failed', 500);
      if (!student || clean(student['كلمة السر'] ?? student.password ?? student.pass) !== password) {
        return errorResponse('student-credentials-invalid', 401);
      }

      const { data: alerts, error } = await supabase
        .from('teacher_alerts')
        .select('id, student_id, teacher_name, subject, message, created_at')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false });
      if (error) return errorResponse('teacher-alerts-load-failed', 500);

      return NextResponse.json({
        success: true,
        alerts: (alerts ?? []).map((alert) => ({
          warning_id: alert.id,
          'الرقم الجامعي': alert.student_id,
          'اسم الطالب': getStudentName(student as Record<string, unknown>),
          'نوع الإنذار': 'تنبيه من المدرس',
          'السبب': `تنبيه في مادة ${alert.subject}`,
          'التفاصيل': alert.message,
          'التاريخ': alert.created_at,
          'مصدر التنبيه': 'teacher',
          'اسم المدرس': alert.teacher_name,
        })),
      });
    }

    if (body.action === 'list-accounts' || body.action === 'set-account') {
      const supervisorUsername = clean(body.supervisorUsername);
      const supervisorPassword = clean(body.supervisorPassword);
      if (!supervisorUsername || !supervisorPassword) return errorResponse('supervisor-credentials-required', 400);
      if (!await verifySupervisor(supabase, supervisorUsername, supervisorPassword)) {
        return errorResponse('supervisor-credentials-invalid', 401);
      }

      if (body.action === 'list-accounts') {
        const { data, error } = await supabase
          .from('teachers')
          .select('id, teacher_name, subjects, is_active, login_username')
          .order('teacher_name');
        if (error) return errorResponse('teacher-accounts-load-failed', 500);
        return NextResponse.json({ success: true, teachers: data ?? [] });
      }

      const teacherId = clean(body.teacherId);
      const teacherName = clean(body.teacherName);
      const loginUsername = normalized(body.loginUsername);
      const newPassword = clean(body.newPassword);
      const isCreatingTeacher = !teacherId;
      if (!teacherName || teacherName.length > 160
        || !/^[\p{L}\p{N}_.-]{3,80}$/u.test(loginUsername)
        || (isCreatingTeacher && newPassword.length < 8)
        || (newPassword && newPassword.length < 8)) {
        return errorResponse('invalid-teacher-account', 400);
      }
      const accountPayload: Record<string, unknown> = {
        teacher_name: teacherName,
        login_username: loginUsername,
        is_active: body.isActive !== false,
      };
      if (newPassword) accountPayload.password_hash = hashPassword(newPassword);
      const { data, error } = isCreatingTeacher
        ? await supabase.from('teachers')
          .insert({ ...accountPayload, subjects: [] })
          .select('id, teacher_name, subjects, is_active, login_username')
          .single()
        : await supabase.from('teachers')
          .update(accountPayload)
          .eq('id', teacherId)
          .select('id, teacher_name, subjects, is_active, login_username')
          .maybeSingle();
      if (error) return errorResponse('teacher-account-save-failed', 500);
      if (!data) return errorResponse('teacher-not-found', 404);
      return NextResponse.json({ success: true, teacher: data });
    }

    const username = clean(body.username);
    const password = clean(body.password);
    if (!username || !password) return errorResponse('teacher-credentials-required', 400);
    const teacher = await getTeacher(supabase, username, password);
    if (!teacher) return errorResponse('teacher-credentials-invalid', 401);
    const { data: assignedSubjects, error: assignedSubjectsError } = await supabase
      .from('academic_subjects')
      .select('name, student_year')
      .eq('teacher_id', teacher.id)
      .order('student_year')
      .order('name');
    if (assignedSubjectsError) return errorResponse('teacher-subjects-load-failed', 500);
    const assignments = (assignedSubjects ?? []).flatMap((row) => {
      const name = clean(row.name);
      const year = normalizeYear(row.student_year);
      return name && year ? [{ name, year, label: getAssignmentLabel(name, year) }] : [];
    });
    const assignmentLabels = assignments.map((assignment) => assignment.label);

    if (body.action === 'login') {
      return NextResponse.json({
        success: true,
        teacher: { id: teacher.id, name: teacher.teacher_name, subjects: assignmentLabels },
      });
    }

    if (body.action === 'dashboard') {
      const [studentsResult, attendanceResult, warningsResult, alertsResult] = await Promise.all([
        supabase.from('students').select('*'),
        supabase.from('الحضور').select('*'),
        supabase.from('الإنذارات').select('*'),
        supabase.from('teacher_alerts')
          .select('id, student_id, subject, student_year, message, created_at')
          .eq('teacher_id', teacher.id)
          .order('created_at', { ascending: false }),
      ]);
      const warningsTableMissing = warningsResult.error
        && (warningsResult.error.code === 'PGRST205'
          || /does not exist|relation|not found/i.test(warningsResult.error.message));
      if (studentsResult.error || attendanceResult.error || alertsResult.error || (warningsResult.error && !warningsTableMissing)) {
        return errorResponse('teacher-dashboard-load-failed', 500);
      }
      const students = (studentsResult.data ?? []).map((row) => {
        const student = row as Record<string, unknown>;
        return {
          id: clean(student['الرقم الجامعي'] ?? student.student_id ?? student.studentId ?? student.id),
          fullName: getStudentName(student),
          avatarUrl: clean(student.avatar_url) || '',
          className: clean(student['الفئة'] ?? student.class ?? student.class_name) || 'غير محدد',
          phone: clean(student['رقم الهاتف'] ?? student.phone),
          year: getStudentYear(student) || 'غير محدد',
        };
      }).filter((student) => student.id && assignments.some((assignment) => assignment.year === student.year));
      const studentYears = new Map(students.map((student) => [student.id, student.year]));
      const studentClasses = new Map(students.map((student) => [student.id, student.className]));
      const attendance = (attendanceResult.data ?? []).flatMap((row) => {
        const record = row as Record<string, unknown>;
        const subjectName = clean(record['المادة'] ?? record.course ?? record.subject);
        const studentId = clean(record['الرقم الجامعي'] ?? record.student_id ?? record.studentId);
        const year = normalizeYear(studentYears.get(studentId));
        const assignment = assignments.find((item) => item.name === subjectName && item.year === year);
        if (!assignment) return [];
        return [{
          id: clean(record.id ?? record.attendance_id ?? record['معرف الحضور'] ?? `${studentId}-${record['التاريخ'] ?? record.date}-${subjectName}`),
          studentId,
          subject: assignment.label,
          status: clean(record['الحالة'] ?? record.status) || 'غير محدد',
          date: clean(record['التاريخ'] ?? record.date ?? record.created_at),
          details: clean(record['تفاصيل الغياب'] ?? record['التفاصيل'] ?? record.note),
          className: clean(record['الفئة'] ?? record.class ?? record.class_name) || 'غير محدد',
        }];
      });
      const attendanceKeys = new Set(attendance
        .filter((record) => ['غائب', 'غياب', 'متغيب', 'absent'].includes(normalized(record.status)))
        .map((record) => attendanceKey(record.studentId, record.subject, record.date)));
      const absenceWarnings = (warningsResult.data ?? []).flatMap((row) => {
        const warning = row as Record<string, unknown>;
        const studentId = clean(warning['الرقم الجامعي'] ?? warning.student_id ?? warning.studentId);
        const warningType = clean(warning['نوع الإنذار'] ?? warning.type);
        const reason = clean(warning['السبب'] ?? warning.reason);
        if (!studentId || (!warningType.includes('غياب') && !/^غياب(?:\s|$)/.test(reason))) return [];

        const reasonCourse = reason.match(/غياب\s+في\s+مادة\s+(.+)$/)?.[1]?.trim() ?? '';
        const subjectName = clean(warning['المادة'] ?? warning.course ?? warning.subject) || reasonCourse;
        const year = normalizeYear(studentYears.get(studentId));
        const assignment = assignments.find((item) => normalized(item.name) === normalized(subjectName) && item.year === year);
        if (!assignment) return [];

        const date = clean(warning['التاريخ'] ?? warning.date ?? warning.created_at);
        const subject = assignment.label;
        if (date && attendanceKeys.has(attendanceKey(studentId, subject, date))) return [];
        return [{
          id: `warning-${clean(warning.warnig_id ?? warning.warning_id ?? warning.id) || `${studentId}-${date}-${subject}`}`,
          studentId,
          subject,
          status: 'غائب',
          date,
          details: clean(warning['التفاصيل'] ?? warning.details ?? reason),
          className: clean(warning['الفئة'] ?? warning.class ?? warning.class_name) || studentClasses.get(studentId) || 'غير محدد',
        }];
      });
      attendance.push(...absenceWarnings);
      const alerts = (alertsResult.data ?? []).flatMap((alert) => {
        const year = normalizeYear(alert.student_year);
        const assignment = assignments.find((item) => item.name === clean(alert.subject) && item.year === year);
        return assignment ? [{ ...alert, subject: assignment.label }] : [];
      });
      return NextResponse.json({
        success: true,
        teacher: { id: teacher.id, name: teacher.teacher_name, subjects: assignmentLabels },
        students,
        attendance,
        alerts,
      });
    }

    if (body.action === 'add-alert') {
      const studentId = clean(body.studentId);
      const assignmentLabel = clean(body.subject);
      const message = clean(body.message);
      const assignment = assignments.find((item) => item.label === assignmentLabel);
      if (!studentId || !assignment || message.length < 3 || message.length > 1000) {
        return errorResponse('invalid-teacher-alert', 400);
      }
      const { data: student, error: studentError } = await supabase
        .from('students')
        .select('*')
        .eq('الرقم الجامعي', studentId)
        .maybeSingle();
      if (studentError) return errorResponse('student-lookup-failed', 500);
      if (!student) return errorResponse('student-not-found', 404);
      const studentYear = getStudentYear(student as Record<string, unknown>);
      if (studentYear !== assignment.year) return errorResponse('student-year-mismatch', 403);
      const { data, error } = await supabase.from('teacher_alerts').insert({
        teacher_id: teacher.id,
        teacher_name: teacher.teacher_name,
        student_id: studentId,
        student_name: getStudentName(student as Record<string, unknown>),
        subject: assignment.name,
        student_year: assignment.year,
        message,
      }).select('id, student_id, subject, student_year, message, created_at').single();
      if (error) return errorResponse('teacher-alert-save-failed', 500);
      return NextResponse.json({ success: true, alert: { ...data, subject: assignment.label } });
    }

    if (body.action === 'delete-alert') {
      const alertId = Number(body.alertId);
      if (!Number.isSafeInteger(alertId) || alertId <= 0) return errorResponse('invalid-alert-id', 400);
      const { data, error } = await supabase.from('teacher_alerts')
        .delete()
        .eq('id', alertId)
        .eq('teacher_id', teacher.id)
        .select('id')
        .maybeSingle();
      if (error) return errorResponse('teacher-alert-delete-failed', 500);
      if (!data) return errorResponse('teacher-alert-not-found', 404);
      return NextResponse.json({ success: true });
    }

    return errorResponse('invalid-action', 400);
  } catch (error) {
    console.error('TEACHER_PORTAL_REQUEST_FAILED:', error);
    return errorResponse('teacher-portal-request-failed', 500);
  }
}
