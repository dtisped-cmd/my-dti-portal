import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '../../../../lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const clean = (value: unknown) => String(value ?? '').trim();
const attendanceAudioFrequencies = [1000, 1500, 2000, 17000, 18000, 19000, 20000];
const normalize = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();

export async function POST(request: Request) {
  const supabase = createSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: 'attendance-challenge-server-key-missing' }, { status: 503 });
  }

  try {
    const body = await request.json() as {
      sessionId?: string;
      supervisorUsername?: string;
      tokenDigest?: string;
      frequencyHz?: number;
    };
    const sessionId = clean(body.sessionId);
    const username = clean(body.supervisorUsername);
    const tokenDigest = clean(body.tokenDigest);
    const frequencyHz = Number(body.frequencyHz);

    if (!sessionId || !username || !/^[a-f\d]{64}$/i.test(tokenDigest)
      || !attendanceAudioFrequencies.includes(frequencyHz)) {
      return NextResponse.json({ success: false, error: 'attendance-challenge-invalid-request' }, { status: 400 });
    }

    const { data, error: sessionError } = await supabase.from(encodeURIComponent('جلسات الحضور'))
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (sessionError) {
      console.error('ATTENDANCE_CHALLENGE_SESSION_LOOKUP_FAILED:', sessionError.message);
      const missingTable = sessionError.code === 'PGRST205'
        || /does not exist|could not find the table|relation .* not found/i.test(sessionError.message);
      if (missingTable) {
        return NextResponse.json({ success: false, error: 'attendance-sessions-table-missing' }, { status: 503 });
      }
      return NextResponse.json({ success: false, error: 'attendance-challenge-session-lookup-failed' }, { status: 500 });
    }
    const session = data as Record<string, unknown> | null;
    const startedAt = Date.parse(clean(session?.started_at));
    if (!session || clean(session['الحالة']) !== 'نشطة' || !Number.isFinite(startedAt) || Date.now() - startedAt > 60 * 60 * 1000) {
      return NextResponse.json({ success: false, error: 'attendance-challenge-session-inactive' }, { status: 404 });
    }
    if (normalize(session['المشرف'] ?? session.supervisor) !== normalize(username)) {
      return NextResponse.json({ success: false, error: 'attendance-challenge-supervisor-invalid' }, { status: 403 });
    }

    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const { error: updateError } = await supabase.from(encodeURIComponent('جلسات الحضور'))
      .update({
        challenge_token: tokenDigest.toLowerCase(),
        challenge_expires_at: expiresAt,
        challenge_frequency_hz: frequencyHz,
      })
      .eq('session_id', sessionId)
      .eq('الحالة', 'نشطة');
    if (updateError) {
      console.error('ATTENDANCE_CHALLENGE_PUBLISH_FAILED:', updateError.message);
      return NextResponse.json({ success: false, error: 'attendance-challenge-publish-failed' }, { status: 502 });
    }

    return NextResponse.json({ success: true, expiresAt });
  } catch (error) {
    console.error('ATTENDANCE_CHALLENGE_REQUEST_FAILED:', error);
    return NextResponse.json({ success: false, error: 'attendance-challenge-request-failed' }, { status: 500 });
  }
}
