import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createSupabaseAdminClient } from '../../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
const attendanceAudioFrequencies = [1000, 1500, 2000, 17000, 18000, 19000, 20000];
const normalizeGroup = (value: unknown) => clean(value).replace(/^فئة\s*/i, '');
const normalizeYear = (value: unknown) => {
  const year = clean(value).replace(/\s+/g, '').toLocaleLowerCase();
  if (['1', '١', 'اولى', 'أولى', 'first'].includes(year)) return 'اولى';
  if (['2', '٢', 'ثانية', 'الثانية', 'second'].includes(year)) return 'ثانية';
  return year;
};

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ success: false, error: 'student-portal-server-key-missing' }, { status: 503 });

  try {
    const body = await request.json() as {
      studentId?: string;
      password?: string;
      challengeToken?: string;
      source?: 'audio' | 'qr';
      audioFrequencyHz?: number;
    };
    const studentId = clean(body.studentId);
    const password = clean(body.password);
    const challengeToken = clean(body.challengeToken);
    const source = body.source;
    const audioFrequencyHz = Number(body.audioFrequencyHz);

    if (!studentId || !password || !['audio', 'qr'].includes(String(source))) {
      return NextResponse.json({ success: false, error: 'attendance-check-in-invalid-request' }, { status: 400 });
    }
    if (source === 'audio' && !attendanceAudioFrequencies.includes(audioFrequencyHz)) {
      return NextResponse.json({ success: false, error: 'attendance-frequency-invalid' }, { status: 400 });
    }
    if (source === 'qr' && !challengeToken) {
      return NextResponse.json({ success: false, error: 'attendance-challenge-invalid' }, { status: 400 });
    }

    const { data: student, error: studentError } = await supabase.from('students').select('*')
      .eq('الرقم الجامعي', studentId).maybeSingle();
    if (studentError) return NextResponse.json({ success: false, error: 'student-lookup-failed' }, { status: 500 });
    if (!student || clean(student['كلمة السر'] ?? student.password ?? student.pass) !== password) {
      return NextResponse.json({ success: false, error: 'student-credentials-invalid' }, { status: 401 });
    }

    const studentGroup = normalizeGroup(student['الفئة'] ?? student.class ?? student.class_name ?? student['اسم الفئة']);
    const studentYear = normalizeYear(student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year);
    if (!studentGroup || !studentYear) {
      return NextResponse.json({ success: false, error: 'student-class-not-found' }, { status: 403 });
    }

    const { data: sessionRows, error: sessionError } = await supabase.from(encodeURIComponent('جلسات الحضور')).select('*')
      .eq('الحالة', 'نشطة');
    if (sessionError) return NextResponse.json({ success: false, error: 'attendance-session-lookup-failed' }, { status: 500 });

    const now = Date.now();
    const challengeDigest = source === 'qr'
      ? createHash('sha256').update(challengeToken).digest('hex')
      : '';
    const session = (sessionRows ?? [])
      .filter((row) => {
      const groupMatches = normalizeGroup(row['الفئة'] ?? row.class) === studentGroup;
      const yearMatches = normalizeYear(row.student_year) === studentYear;
      const tokenMatches = source === 'audio' || clean(row.challenge_token) === challengeDigest;
      const frequencyMatches = source === 'qr' || Number(row.challenge_frequency_hz) === audioFrequencyHz;
      const expiresAt = Date.parse(clean(row.challenge_expires_at));
      const startedAt = Date.parse(clean(row.started_at));
      return groupMatches && yearMatches && tokenMatches && frequencyMatches && Number.isFinite(expiresAt) && expiresAt > now
        && Number.isFinite(startedAt) && now - startedAt <= 60 * 60 * 1000
        && clean(row['الحالة']) === 'نشطة';
      })
      .sort((left, right) => Date.parse(clean(right.challenge_expires_at)) - Date.parse(clean(left.challenge_expires_at)))[0];

    if (!session) {
      return NextResponse.json({ success: false, error: 'attendance-challenge-expired-or-not-found' }, { status: 404 });
    }

    const course = clean(session['المادة'] ?? session.course);
    const classValue = clean(session['الفئة'] ?? session.class);
    const date = new Date().toISOString().slice(0, 10);
    const { data: existing, error: existingError } = await supabase.from('الحضور').select('*')
      .eq('الرقم الجامعي', studentId).eq('المادة', course).eq('الفئة', classValue)
      .eq('التاريخ', date).eq('session_id', clean(session.session_id));
    if (existingError) {
      console.error('STUDENT_ATTENDANCE_DUPLICATE_CHECK_FAILED:', existingError.message);
      return NextResponse.json({ success: false, error: 'attendance-duplicate-check-failed' }, { status: 500 });
    }
    if (existing?.some((record) => ['حاضر', 'present'].includes(clean(record['الحالة'] ?? record.status).toLocaleLowerCase()))) {
      return NextResponse.json({ success: true, alreadyPresent: true });
    }

    const attendanceTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const absentRows = (existing ?? []).filter((record) => ['غائب', 'absent'].includes(
      clean(record['الحالة'] ?? record.status).toLocaleLowerCase()
    ));
    if (absentRows.length) {
      const { data: updatedRows, error: updateError } = await supabase.from('الحضور')
        .update({
          'الحالة': 'حاضر',
          'الوقت': attendanceTime,
          'المشرف': clean(session['المشرف'] ?? session.supervisor) || 'مشرف غير محدد',
          session_id: clean(session.session_id),
        })
        .eq('الرقم الجامعي', studentId)
        .eq('المادة', course)
        .eq('الفئة', classValue)
        .eq('التاريخ', date)
        .eq('session_id', clean(session.session_id))
        .in('الحالة', ['غائب', 'absent'])
        .select('الرقم الجامعي');
      if (updateError) {
        console.error('STUDENT_ATTENDANCE_ABSENCE_UPDATE_FAILED:', updateError.message);
        return NextResponse.json({ success: false, error: 'attendance-save-failed' }, { status: 500 });
      }
      if (updatedRows?.length) return NextResponse.json({ success: true, course, updatedAbsence: true });
      return NextResponse.json({ success: true, alreadyPresent: true });
    }

    const attendanceRecord = {
      'التاريخ': date,
      'الوقت': attendanceTime,
      'الرقم الجامعي': studentId,
      'اسم الطالب': clean(student['اسم الطالب'] ?? student.name),
      'المادة': course,
      'الفئة': classValue,
      'الحالة': 'حاضر',
      'المشرف': clean(session['المشرف'] ?? session.supervisor) || 'مشرف غير محدد',
      session_id: clean(session.session_id),
    };
    const { error: insertError } = await supabase.from('الحضور').insert([attendanceRecord]);
    if (insertError) {
      console.error('STUDENT_ATTENDANCE_CHECK_IN_FAILED:', insertError.message);
      return NextResponse.json({ success: false, error: 'attendance-save-failed' }, { status: 500 });
    }

    return NextResponse.json({ success: true, course });
  } catch (error) {
    console.error('STUDENT_ATTENDANCE_CHECK_IN_FAILED:', error);
    return NextResponse.json({ success: false, error: 'attendance-check-in-failed' }, { status: 500 });
  }
}
