import { NextResponse } from 'next/server';
import { buildClassChangeEmail, sendEmail } from '../../../../lib/email';
import { buildStudentTelegramMessage, sendTelegramNotification } from '../../../../lib/telegram';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type ClassChangeRequest = {
  studentId?: string;
  password?: string;
  nextClass?: string;
};

export async function POST(request: Request) {
  try {
    const supabase = createSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'student-portal-server-key-missing' }, { status: 503 });
    }
    const body = await request.json() as ClassChangeRequest;
    const studentId = String(body.studentId ?? '').trim();
    const password = String(body.password ?? '');
    const nextClass = String(body.nextClass ?? '').trim();

    if (!studentId || !password || !nextClass) {
      return NextResponse.json({ success: false, error: 'missing-class-or-student' }, { status: 400 });
    }

    const { data: student, error: studentError } = await supabase.from('students').select('*')
      .eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) return NextResponse.json({ success: false, error: 'student-lookup-failed' }, { status: 500 });
    if (!student || String(student['كلمة السر'] ?? student.password ?? student.pass ?? '') !== password) {
      return NextResponse.json({ success: false, error: 'student-not-found' }, { status: 404 });
    }

    const previousClass = String(student['الفئة'] ?? '').trim();
    const studentYear = normalizeYear(student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year);
    if (!studentYear) return NextResponse.json({ success: false, error: 'student-year-missing' }, { status: 400 });
    const { data: availableClasses, error: classesError } = await supabase.from('student_classes')
      .select('name, capacity').eq('student_year', studentYear);
    if (classesError) return NextResponse.json({ success: false, error: 'student-classes-load-failed' }, { status: 500 });
    const selectedClass = (availableClasses ?? []).find((item) => normalizeClass(item.name) === normalizeClass(nextClass));
    if (!selectedClass) return NextResponse.json({ success: false, error: 'class-not-available-for-student-year' }, { status: 400 });

    if (typeof selectedClass.capacity === 'number') {
      const { data: students, error: studentsError } = await supabase.from('students').select('*');
      if (studentsError) return NextResponse.json({ success: false, error: 'student-classes-load-failed' }, { status: 500 });
      const occupied = (students ?? []).filter((row) => {
        const enrolledStudent = row as Record<string, unknown>;
        const year = normalizeYear(enrolledStudent['السنه الدراسية'] ?? enrolledStudent['السنة الدراسية'] ?? enrolledStudent.year ?? enrolledStudent.student_year);
        const className = enrolledStudent['الفئة'] ?? enrolledStudent.class ?? enrolledStudent.class_name ?? enrolledStudent['اسم الفئة'];
        return year === studentYear && normalizeClass(className) === normalizeClass(selectedClass.name);
      }).length;
      if (occupied >= selectedClass.capacity) return NextResponse.json({ success: false, error: 'class-full' }, { status: 400 });
    }
    const { error: updateError } = await supabase.from('students').update({
      'الفئة': nextClass,
      'تاريخ_تغيير_الفئة': new Date().toISOString(),
    }).eq('الرقم الجامعي', studentId);
    if (updateError) return NextResponse.json({ success: false, error: 'student-update-failed' }, { status: 500 });

    const studentName = String(student['اسم الطالب'] ?? student.student_name ?? student.name ?? 'الطالب');
    const email = String(student['البريد الإلكتروني'] ?? student.email ?? '').trim();
    const emailResult = email
      ? await sendEmail({
        to: email,
        subject: 'تغيير الفئة',
        html: buildClassChangeEmail({ studentName, previousClass, nextClass }),
      })
      : { success: false, error: 'student-email-missing' };

    const notificationsEnabled = Boolean(student.telegram_notifications_enabled);
    const chatId = String(student.telegram_chat_id ?? '').trim();
    let telegramResult: { ok?: boolean; status?: string } = { status: 'disabled_or_missing_chat_id' };

    if (notificationsEnabled && chatId) {
      const telegramMessage = buildStudentTelegramMessage({
        studentName,
        studentId,
        studentYear: String(student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year ?? 'غير محدد'),
        studentClass: nextClass,
        statusText: `تم تغيير الفئة بنجاح من ${previousClass || 'غير محددة'} إلى ${nextClass}.`,
        title: 'تغيير الفئة',
      });
      telegramResult = await sendTelegramNotification(telegramMessage, { chatId, enabled: true });
    }

    return NextResponse.json({ success: true, emailSent: emailResult.success, telegramSent: telegramResult.ok === true });
  } catch (error) {
    console.error('Class change API failed:', error);
    return NextResponse.json({ success: false, error: 'class-change-failed' }, { status: 500 });
  }
}

const normalizeYear = (value: unknown): 'أولى' | 'ثانية' | '' => {
  const year = String(value ?? '').trim().replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١'].includes(year) || year.includes('اولى') || year.includes('أولى') || year.includes('first')) return 'أولى';
  if (['2', '٢'].includes(year) || year.includes('ثانية') || year.includes('second')) return 'ثانية';
  return '';
};

const normalizeClass = (value: unknown) => String(value ?? '').trim().replace(/^فئة\s*/, '').replace(/\s+/g, '');
