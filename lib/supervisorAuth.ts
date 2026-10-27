import 'server-only';
import { createSupabaseAdminClient } from './supabaseAdmin';

const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalized = (value: unknown) => clean(value).replace(/\s+/g, '').toLocaleLowerCase();

const firstDegreeValues = [
  '1', '١', 'one', 'first', 'firstdegree', 'اولى', 'الأولى', 'الدرجةالأولى', 'درجةالأولى',
  '1st', '1stdegree', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور',
];

export const verifyFirstDegreeSupervisor = async (
  supabase: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  username: string,
  password: string
) => {
  const { data, error } = await supabase.from('المشرفين').select('*');
  if (error) return { valid: false, failed: true };

  const supervisor = (data ?? []).find((row) => {
    const record = row as Record<string, unknown>;
    const savedUsername = record['اسم المستخدم'] ?? record.username ?? record['اسم_المستخدم'] ?? record.user_name;
    const savedPassword = record['كلمة المرور'] ?? record['كلمة السر'] ?? record['كلمة_المرور'] ?? record.password ?? record.pass;
    return normalized(savedUsername) === normalized(username) && clean(savedPassword) === password;
  }) as Record<string, unknown> | undefined;
  const degree = normalized(supervisor?.['الدرجة'] ?? supervisor?.degree ?? supervisor?.rank ?? supervisor?.role ?? supervisor?.level);
  return { valid: Boolean(supervisor && firstDegreeValues.includes(degree)), failed: false };
};
