import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
const normalizeYear = (value: unknown): 'أولى' | 'ثانية' | '' => {
  const year = clean(value).replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١'].includes(year) || year.includes('اولى') || year.includes('أولى') || year.includes('first')) return 'أولى';
  if (['2', '٢'].includes(year) || year.includes('ثانية') || year.includes('second')) return 'ثانية';
  return '';
};
const normalizeClass = (value: unknown) => clean(value).replace(/^فئة\s*/, '').replace(/\s+/g, '');

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ success: false, error: 'student-portal-server-key-missing' }, { status: 503 });

  try {
    const body = await request.json() as { studentId?: string; password?: string };
    const studentId = clean(body.studentId);
    const password = clean(body.password);
    if (!studentId || !password) return NextResponse.json({ success: false, error: 'student-credentials-required' }, { status: 400 });

    const { data: student, error: studentError } = await supabase.from('students').select('*')
      .eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) return NextResponse.json({ success: false, error: 'student-lookup-failed' }, { status: 500 });
    if (!student || clean(student['كلمة السر'] ?? student.password ?? student.pass) !== password) {
      return NextResponse.json({ success: false, error: 'student-credentials-invalid' }, { status: 401 });
    }

    const year = normalizeYear(student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year);
    if (!year) return NextResponse.json({ success: false, error: 'student-year-missing' }, { status: 400 });
    const [{ data: classes, error: classesError }, { data: students, error: studentsError }] = await Promise.all([
      supabase.from('student_classes').select('id, name, capacity').eq('student_year', year).order('name'),
      supabase.from('students').select('*'),
    ]);
    if (classesError || studentsError) return NextResponse.json({ success: false, error: 'student-classes-load-failed' }, { status: 500 });

    const options = (classes ?? []).map((academicClass) => {
      const occupied = (students ?? []).filter((row) => {
        const enrolledStudent = row as Record<string, unknown>;
        const enrolledYear = normalizeYear(enrolledStudent['السنه الدراسية'] ?? enrolledStudent['السنة الدراسية'] ?? enrolledStudent.year ?? enrolledStudent.student_year);
        const className = enrolledStudent['الفئة'] ?? enrolledStudent.class ?? enrolledStudent.class_name ?? enrolledStudent['اسم الفئة'];
        return enrolledYear === year && normalizeClass(className) === normalizeClass(academicClass.name);
      }).length;
      const capacity = typeof academicClass.capacity === 'number' ? academicClass.capacity : null;
      return {
        name: clean(academicClass.name),
        capacity,
        occupied,
        available: capacity === null ? null : Math.max(capacity - occupied, 0),
      };
    });
    return NextResponse.json({ success: true, year, classes: options });
  } catch (error) {
    console.error('STUDENT_CLASSES_REQUEST_FAILED:', error);
    return NextResponse.json({ success: false, error: 'student-classes-load-failed' }, { status: 500 });
  }
}
