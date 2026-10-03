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
const normalizeGroup = (value: unknown) => clean(value).replace(/^فئة\s*/i, '');

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

    const studentYear = normalizeYear(student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year);
    if (!studentYear) return NextResponse.json({ success: true, schedule: [] });
    const studentGroup = normalizeGroup(student['الفئة'] ?? student.class ?? student.class_name ?? student['اسم الفئة']);
    const { data, error } = await supabase.from('schedule_items')
      .select('id, day, start_time, end_time, subject, type, location, group_name, student_year')
      .eq('student_year', studentYear);
    if (error) return NextResponse.json({ success: false, error: 'student-schedule-load-failed' }, { status: 500 });

    const schedule = (data ?? []).filter((item) => {
      const group = clean(item.group_name);
      return normalizeYear(item.student_year) === studentYear && (!group || normalizeGroup(group) === studentGroup);
    });
    return NextResponse.json({ success: true, schedule });
  } catch (error) {
    console.error('STUDENT_SCHEDULE_REQUEST_FAILED:', error);
    return NextResponse.json({ success: false, error: 'student-schedule-load-failed' }, { status: 500 });
  }
}
