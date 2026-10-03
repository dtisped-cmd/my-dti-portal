import 'server-only';
import { isIP } from 'net';
import { createClient } from '@supabase/supabase-js';

type AuditUserType = 'student' | 'teacher' | 'supervisor' | 'system';

type AuditEvent = {
  action: string;
  userType: AuditUserType;
  userId?: string | null;
  username?: string | null;
  fullName?: string | null;
  details?: Record<string, unknown>;
  deviceId?: string | null;
  platform?: string | null;
  language?: string | null;
  screenSize?: string | null;
  path?: string | null;
};

const getClientIp = (request: Request) => {
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  const candidate = forwardedIp || realIp || '';
  return isIP(candidate) ? candidate : null;
};

export const writeServerAuditLog = async (request: Request, event: AuditEvent) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anonKey) throw new Error('Audit logging requires Supabase URL and anon key.');

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const userAgent = request.headers.get('user-agent')?.slice(0, 1000) || null;
  const { error } = await supabase.from('سجلات النظام').insert({
    action: event.action,
    user_type: event.userType,
    user_id: event.userId || null,
    username: event.username || null,
    full_name: event.fullName || event.username || null,
    ip_address: getClientIp(request),
    device_id: event.deviceId || null,
    device_type: /Mobi|Android|iPhone|iPad/i.test(userAgent ?? '') ? 'mobile' : 'desktop',
    user_agent: userAgent,
    platform: event.platform || null,
    language: event.language || null,
    screen_size: event.screenSize || null,
    path: event.path || new URL(request.url).pathname,
    details: event.details ?? {},
  });
  if (error) throw new Error(`Audit log insert failed: ${error.message}`);
};
