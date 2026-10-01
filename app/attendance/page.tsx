'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { CheckCircle2, ScanLine, UserRound } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { writeAuditLog } from '../../lib/auditLog';
import { getClassAvailabilityOptions } from '../../lib/studentData';
import { teacherEvaluationsTemporarilyDisabled } from '../../lib/featureFlags';
import { buildStudentTelegramMessage, sendTelegramNotification } from '../../lib/telegram';

type StudentRow = {
  id?: number | string;
  'الرقم الجامعي'?: string | number;
  'كلمة السر'?: string;
  'اسم الطالب'?: string;
  'اسم الاب'?: string;
  'الكنية'?: string;
  'القسم'?: string;
  'رقم الهاتف'?: string;
  'نوع التسجيل'?: string;
  'ملاحظة'?: string;
  'البريد الإلكتروني'?: string;
  'الفئة'?: string;
  'تاريخ_تغيير_الفئة'?: string | null;
  'تاريخ الإنشاء'?: string | null;
  'السنه الدراسية'?: string | number;
  'telegram_chat_id'?: string | number | null;
  'telegram_notifications_enabled'?: boolean | string;
  avatar_url?: string | null;
  class?: string;
  year?: string;
  password?: string;
  name?: string;
  student_id?: string | number;
  studentId?: string | number;
  ['الرقم']?: string | number;
};

type AttendanceStatus = 'pending' | 'present' | 'absent';
type AbsenceReason = 'غياب مبرر' | 'غياب غير مبرر';
type SupervisorFeature = 'attendance' | 'admin' | 'supervisors' | 'logs' | 'students' | 'create_student' | 'profile';
type AdminRecord = Record<string, unknown>;

type AttendanceEntry = {
  id: string;
  name: string;
  status: AttendanceStatus;
  timestamp: string | null;
  year: string;
  absenceReason?: AbsenceReason | '';
};

type PendingAttendanceJob = {
  type: 'attendance' | 'warning';
  student: StudentRow;
  course: string;
  classValue: string;
  status: AttendanceStatus;
  absenceReason?: AbsenceReason | '';
  supervisor: string;
  queuedAt: string;
};

const normalizeAbsenceReason = (value?: string | null): AbsenceReason => {
  const reason = normalizeText(value).trim();
  return reason === 'غياب غير مبرر' ? 'غياب غير مبرر' : 'غياب مبرر';
};

type RecentAttendanceSession = {
  id: string;
  course: string;
  classValue: string;
  supervisor: string;
  startedAt: string;
};

type SupervisorRow = {
  'اسم المستخدم'?: string;
  username?: string;
  'كلمة المرور'?: string;
  password?: string;
  'الدرجة'?: string | number;
  degree?: string | number;
};

const tableCandidates = {
  students: ['students'],
  attendance: ['الحضور'],
  warnings: ['الإنذارات'],
  sessions: ['جلسات الحضور'],
  supervisorWarnings: ['إنذارات المشرفين'],
};

const courseOptions = [
  'تشريح الأسنان',
  'مواد طب الأسنان الوقائي',
  'علم الأدوية',
  'علم الأمراض',
  'الاستعاضة الصناعية',
  'الوقاية الفموية',
  'تقويم الأسنان',
];

const classOptions = ['أ', 'ب', 'ج', 'د'];
const yearOptions = ['أولى', 'ثانية'];
const allowedStudentClasses = ['أ', 'ب', 'ج', 'د'];
const allowedStudentYears = ['أولى', 'ثانية'];
const defaultStudentSection = 'تعويضات أسنان';
const pendingAttendanceStorageKey = 'udti-pending-attendance-jobs';
const studentCacheStorageKey = 'udti-attendance-student-cache';
const recentSessionWindowMs = 60 * 60 * 1000;
const supervisorSessionStorageKey = 'udti-supervisor-session';
const rememberedSupervisorUsernameKey = 'udti-remembered-supervisor-username';
const rememberedSupervisorPasswordKey = 'udti-remembered-supervisor-password';

type StoredSupervisorSession = {
  username: string;
  degree: string;
  features: SupervisorFeature[];
  selectedFeature?: SupervisorFeature | null;
};

const normalizeText = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 'غير متوفر';
  return String(value).trim();
};

const normalizeSupervisorDegree = (value: unknown) => {
  const text = normalizeText(value).replace(/\s+/g, '').toLowerCase();
  const compact = text.replace(/الدرجة|درجة|درجه/g, '');
  const normalized = compact.replace(/[\-_]/g, '');

  if (['1', '١', 'one', 'first', 'اولى', 'الأولى', '1st', 'moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور'].some((item) => normalized.includes(item))) return '1';
  if (['2', '٢', 'two', 'second', 'ثانية', 'الثانية', '2nd', 'supervisor', 'super', 'سوبر', 'سوبرفايزور', 'supervisor2', 'level2', 'فايزور', 'fayzor', 'fayzur', 'faizur'].some((item) => normalized.includes(item))) return '2';
  if (['3', '٣', 'three', 'third', 'ثالثة', 'الثالثة', '3rd', 'level3', 'supervisor3', 'senior', 'قائد', 'رئيس', 'adminlevel'].some((item) => normalized.includes(item))) return '3';

  if (/^\d$/.test(normalized)) return normalized;
  return normalized || text;
};

const resolveSupervisorDegreeFromRow = (row: Record<string, unknown>) => {
  const directCandidates = [
    row['الدرجة'],
    row.degree,
    row['degree'],
    row['درجه'],
    row['rank'],
    row['role'],
    row['level'],
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeSupervisorDegree(candidate);
    if (['1', '2', '3'].includes(normalized)) return normalized;
  }

  for (const [key, value] of Object.entries(row)) {
    const lowerKey = String(key).toLowerCase();
    if (!/(درجة|degree|rank|level|role)/i.test(lowerKey) && !/(1|2|3|اولى|ثانية|ثالثة|moderator|supervisor|فايزور|سوبر|مراقب)/i.test(String(value ?? ''))) {
      continue;
    }

    const parsed = normalizeSupervisorDegree(value);
    if (['1', '2', '3'].includes(parsed)) return parsed;
  }

  return '3';
};

const getSupervisorDegreeLabel = (degree: string) => {
  const normalized = normalizeSupervisorDegree(degree);
  if (normalized === '1' || ['moderator', 'مودرييتور', 'monitor', 'مراقب'].includes(normalizeText(degree).replace(/\s+/g, '').toLowerCase())) return 'مودرييتور';
  if (normalized === '2' || ['supervisor', 'super', 'سوبر', 'سوبرفايزور'].includes(normalizeText(degree).replace(/\s+/g, '').toLowerCase())) return 'سوبر فيزور';
  if (normalized === '3' || ['fayzor', 'fayzur', 'فايزور', 'faizur'].includes(normalizeText(degree).replace(/\s+/g, '').toLowerCase())) return 'فايزور';
  return 'مشرف';
};

const normalizeSupervisorValue = (value: unknown) => {
  return normalizeText(value).replace(/\s+/g, '').toLowerCase();
};

const getSupervisorDegree = (row: Record<string, unknown>) => {
  return resolveSupervisorDegreeFromRow(row);
};

const getSupervisorFeatures = (degree: string): SupervisorFeature[] => {
  const normalizedDegree = normalizeSupervisorDegree(degree);
  const lowerDegree = normalizeText(degree).replace(/\s+/g, '').toLowerCase();

  if (normalizedDegree === '1' || ['moderator', 'مودرييتور', 'monitor', 'مراقب', 'المودرييتور'].includes(lowerDegree)) {
    return ['admin', 'attendance', 'supervisors', 'logs', 'students', 'profile'];
  }

  if (normalizedDegree === '2' || ['supervisor', 'سوبر', 'سوبرفايزور', 'super', 'supervisor2', 'fayzor', 'fayzur', 'فايزور', 'faizur'].includes(lowerDegree)) {
    return ['attendance', 'create_student', 'profile'];
  }

  if (['3'].includes(normalizedDegree)) {
    return ['attendance', 'profile'];
  }

  return [];
};

const getAdminRecordValue = (row: AdminRecord, keys: string[]) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return '';
};

const getFullStudentName = (row: AdminRecord | StudentRow) => {
  const firstName = String(row['اسم الطالب'] ?? '').trim();
  const fatherName = String(row['اسم الاب'] ?? '').trim();
  const familyName = String(row['الكنية'] ?? '').trim();
  return [firstName, fatherName, familyName].filter(Boolean).join(' ') || 'غير محدد';
};

const getStudentDisplayName = (student: StudentRow) => {
  const firstName = String(student['اسم الطالب'] ?? student.name ?? '').trim();
  const fatherName = String(student['اسم الاب'] ?? '').trim();
  const familyName = String(student['الكنية'] ?? '').trim();
  return [firstName, fatherName, familyName].filter(Boolean).join(' ') || 'غير محدد';
};

const adminIdCandidates = ['warnig_id', 'warning_id', 'warningId', 'warnigId', 'attendance_id', 'id'];

const getAdminRecordId = (row: AdminRecord) => {
  const key = adminIdCandidates.find((candidate) => row[candidate] !== undefined && row[candidate] !== null && row[candidate] !== '');
  return key ? String(row[key]).trim() : '';
};

const getAdminRecordDate = (row: AdminRecord) => String(getAdminRecordValue(row, ['التاريخ', 'started_at', 'created_at', 'date']) || '');

const getAdminRecordSupervisor = (row: AdminRecord) => String(getAdminRecordValue(row, ['المشرف', 'اسم المشرف', 'supervisor', 'username']) || 'غير محدد');

const getAdminRecordCourse = (row: AdminRecord) => {
  const directCourse = String(getAdminRecordValue(row, ['المادة', 'course', 'subject']) || '').trim();
  if (directCourse) return directCourse;
  const reason = String(getAdminRecordValue(row, ['السبب', 'التفاصيل']) || '');
  return reason.match(/مادة\s+(.+)$/)?.[1]?.trim() || '';
};

const isDatabaseTableMissing = (error: { code?: string; message?: string } | null | undefined) => {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === 'PGRST205' || message.includes('does not exist') || message.includes('relation') || message.includes('not found');
};

const loadAdminRecords = async () => {
  const [attendanceResult, warningsResult, studentsResult, supervisorsResult, supervisorWarningsResult] = await Promise.all([
    supabase.from('الحضور').select('*'),
    supabase.from('الإنذارات').select('*'),
    supabase.from('students').select('*'),
    supabase.from('المشرفين').select('*'),
    supabase.from(tableCandidates.supervisorWarnings[0]).select('*'),
  ]);

  if (attendanceResult.error && !isDatabaseTableMissing(attendanceResult.error)) throw attendanceResult.error;
  if (warningsResult.error && !isDatabaseTableMissing(warningsResult.error)) throw warningsResult.error;

  const studentNames: Record<string, string> = {};
  if (!studentsResult.error && Array.isArray(studentsResult.data)) {
    (studentsResult.data as AdminRecord[]).forEach((student) => {
      const studentId = String(getAdminRecordValue(student, ['الرقم الجامعي', 'student_id', 'studentId', 'id'])).trim();
      if (studentId) studentNames[studentId] = getFullStudentName(student);
    });
  }

  return {
    attendance: Array.isArray(attendanceResult.data) ? attendanceResult.data as AdminRecord[] : [],
    warnings: Array.isArray(warningsResult.data) ? warningsResult.data as AdminRecord[] : [],
    studentNames,
    supervisors: !supervisorsResult.error && Array.isArray(supervisorsResult.data)
      ? supervisorsResult.data as AdminRecord[]
      : [],
    supervisorWarnings: !supervisorWarningsResult.error && Array.isArray(supervisorWarningsResult.data)
      ? supervisorWarningsResult.data as AdminRecord[]
      : [],
    auditLogs: [],
  };
};

const loadAuditLogs = async () => {
  const { data, error } = await supabase
    .from('سجلات النظام')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return Array.isArray(data) ? data as AdminRecord[] : [];
};

const insertAdminAttendance = async (warning: AdminRecord, supervisor: string) => {
  const payload = {
    'الرقم الجامعي': getAdminRecordValue(warning, ['الرقم الجامعي', 'student_id', 'studentId']),
    'اسم الطالب': getAdminRecordValue(warning, ['اسم الطالب', 'student_name', 'name']),
    'المادة': getAdminRecordCourse(warning),
    'الفئة': getAdminRecordValue(warning, ['الفئة', 'class', 'class_name']),
    'الحالة': 'حاضر',
    'التاريخ': new Date().toISOString(),
    'الوقت': new Date().toLocaleTimeString('en-GB', { hour12: false }),
    'المشرف': supervisor || 'مشرف الدرجة الأولى',
  };

  const firstAttempt = await supabase.from('الحضور').insert([payload]);
  if (!firstAttempt.error) return { success: true };
  if (!String(firstAttempt.error.message || '').toLowerCase().includes('column')) {
    return { success: false, error: firstAttempt.error.message };
  }

  const { 'الحالة': _status, ...legacyPayload } = payload;
  const fallbackAttempt = await supabase.from('الحضور').insert([legacyPayload]);
  return fallbackAttempt.error ? { success: false, error: fallbackAttempt.error.message } : { success: true };
};

const deleteAdminWarning = async (warning: AdminRecord) => {
  const warningId = getAdminRecordId(warning);
  if (!warningId) return { success: false, error: 'لا يوجد معرف للإنذار' };
  const idKey = adminIdCandidates.find((candidate) => String(warning[candidate] ?? '') === warningId) ?? 'warnig_id';
  const { error } = await supabase.from('الإنذارات').delete().eq(idKey, warningId);
  return error ? { success: false, error: error.message } : { success: true };
};

const deleteAdminAttendance = async (record: AdminRecord) => {
  const recordId = getAdminRecordId(record);
  if (!recordId) return { success: false, error: 'لا يوجد معرف لسجل الحضور' };
  const idKey = adminIdCandidates.find((candidate) => String(record[candidate] ?? '') === recordId) ?? 'id';
  const { error } = await supabase.from('الحضور').delete().eq(idKey, recordId);
  return error ? { success: false, error: error.message } : { success: true };
};

const updateAdminWarning = async (warning: AdminRecord, details: string) => {
  const warningId = getAdminRecordId(warning);
  if (!warningId) return { success: false, error: 'لا يوجد معرف للإنذار' };
  const idKey = adminIdCandidates.find((candidate) => String(warning[candidate] ?? '') === warningId) ?? 'warnig_id';
  const updates: AdminRecord = { 'التفاصيل': details };
  if (warning['السبب'] !== undefined) updates['السبب'] = details;
  const { error } = await supabase.from('الإنذارات').update(updates).eq(idKey, warningId);
  return error ? { success: false, error: error.message } : { success: true };
};

const updateAdminAttendance = async (record: AdminRecord, status: 'حاضر' | 'غائب', absenceDetails = '') => {
  const recordId = getAdminRecordId(record);
  if (!recordId) return { success: false, error: 'لا يوجد معرف لسجل الحضور' };
  const idKey = adminIdCandidates.find((candidate) => String(record[candidate] ?? '') === recordId) ?? 'id';
  const updates: AdminRecord = {};
  if (record['الحالة'] !== undefined) updates['الحالة'] = status;
  if (record['تفاصيل الغياب'] !== undefined) updates['تفاصيل الغياب'] = absenceDetails;
  else if (record['التفاصيل'] !== undefined) updates['التفاصيل'] = absenceDetails;
  else if (record['ملاحظة'] !== undefined) updates['ملاحظة'] = absenceDetails;
  if (status === 'غائب' && record['تفاصيل الغياب'] === undefined && record['التفاصيل'] === undefined && record['ملاحظة'] === undefined) {
    updates['تفاصيل الغياب'] = absenceDetails;
  }
  if (!Object.keys(updates).length) return { success: false, error: 'جدول الحضور لا يحتوي حقول تعديل الحالة' };

  const { error } = await supabase.from('الحضور').update(updates).eq(idKey, recordId);
  return error ? { success: false, error: error.message } : { success: true };
};

const createSupervisorWarning = async (username: string, degree: string, details: string, issuer: string) => {
  const { error } = await supabase.from(tableCandidates.supervisorWarnings[0]).insert([{
    'اسم المستخدم': username,
    'الدرجة': degree,
    'التفاصيل': details,
    'أنشأه': issuer,
    'التاريخ': new Date().toISOString().split('T')[0],
    'الوقت': new Date().toLocaleTimeString('en-GB', { hour12: false }),
  }]);
  return error ? { success: false, error: error.message } : { success: true };
};

const supervisorIdCandidates = ['id', 'supervisor_id', 'معرف المشرف', 'رقم المشرف'];

const getSupervisorRecordId = (row: AdminRecord) => {
  const key = supervisorIdCandidates.find((candidate) => row[candidate] !== undefined && row[candidate] !== null && row[candidate] !== '');
  return key ? String(row[key]).trim() : '';
};

const getSupervisorFieldKey = (row: AdminRecord, kind: 'username' | 'password' | 'degree') => {
  const candidates = kind === 'username'
    ? ['اسم المستخدم', 'username', 'اسم_المستخدم', 'user_name']
    : kind === 'password'
      ? ['كلمة المرور', 'password', 'كلمة_المرور', 'pass']
      : ['الدرجة', 'degree', 'درجه', 'rank'];
  return candidates.find((candidate) => candidate in row) ?? candidates[0];
};

const createSupervisorRecord = async (username: string, password: string, degree: string) => {
  const { error } = await supabase.from('المشرفين').insert([{
    'اسم المستخدم': username,
    'كلمة المرور': password,
    'الدرجة': degree,
  }]);
  return error ? { success: false, error: error.message } : { success: true };
};

const updateSupervisorRecord = async (row: AdminRecord, values: { username: string; password: string; degree: string }) => {
  const id = getSupervisorRecordId(row);
  if (!id) return { success: false, error: 'لا يوجد معرف لهذا المشرف' };
  const updates: AdminRecord = {
    [getSupervisorFieldKey(row, 'username')]: values.username,
    [getSupervisorFieldKey(row, 'degree')]: values.degree,
  };
  if (values.password.trim()) updates[getSupervisorFieldKey(row, 'password')] = values.password;
  const idKey = supervisorIdCandidates.find((candidate) => String(row[candidate] ?? '') === id) ?? 'id';
  const { error } = await supabase.from('المشرفين').update(updates).eq(idKey, id);
  return error ? { success: false, error: error.message } : { success: true };
};

const deleteSupervisorRecord = async (row: AdminRecord) => {
  const id = getSupervisorRecordId(row);
  if (!id) return { success: false, error: 'لا يوجد معرف لهذا المشرف' };
  const idKey = supervisorIdCandidates.find((candidate) => String(row[candidate] ?? '') === id) ?? 'id';
  const { error } = await supabase.from('المشرفين').delete().eq(idKey, id);
  return error ? { success: false, error: error.message } : { success: true };
};

const getSupervisorCredentials = (row: Record<string, unknown>) => {
  const values = Object.values(row)
    .filter((item) => item !== null && item !== undefined && String(item).trim() !== '')
    .map((item) => String(item).trim());

  const namedUsername = row['اسم المستخدم'] ?? row.username ?? row['username'] ?? row['اسم_المستخدم'] ?? row['user_name'] ?? '';
  const namedPassword = row['كلمة المرور'] ?? row.password ?? row['password'] ?? row['كلمة_المرور'] ?? row['pass'] ?? '';
  const namedDegree = row['الدرجة'] ?? row.degree ?? row['degree'] ?? row['درجه'] ?? row['rank'] ?? '';

  return {
    username: String(namedUsername || values[0] || ''),
    password: String(namedPassword || values[1] || ''),
    degree: String(namedDegree || values[2] || ''),
  };
};

const normalizeYearValue = (value: unknown) => {
  const text = normalizeText(value).toLowerCase();
  const cleaned = text.replace(/[_\-\s]/g, '').replace(/السنة|سنة|الدراسية|دراسية/g, '');

  if (/اول|first|1/.test(cleaned) && !/ثان|second|2/.test(cleaned)) return 'أولى';
  if (/ثان|second|2/.test(cleaned)) return 'ثانية';
  return cleaned || 'غير محدد';
};

const normalizeClassValue = (value: unknown) => {
  const text = normalizeText(value).toLowerCase().replace(/[_\-\s]/g, '');
  const cleaned = text.replace(/فئة|class/g, '').trim();
  return cleaned || 'غير محدد';
};

function readStudentField(student: StudentRow, keys: string[]) {
  for (const key of keys) {
    const value = student[key as keyof StudentRow];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const getSupabaseErrorText = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'خطأ غير معروف في قاعدة البيانات';
  }
};

const getTeacherEvaluationErrorText = (error: unknown) => {
  const message = getSupabaseErrorText(error);
  return message.includes('teacher-evaluation-server-key-missing')
    ? 'أضف SUPABASE_SERVICE_ROLE_KEY إلى بيئة الخادم لتأمين التقييمات.'
    : message;
};

const isDuplicateStudentIdError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;

  const status = 'status' in error ? Number((error as { status?: number }).status) : undefined;
  const code = 'code' in error ? String((error as { code?: string }).code ?? '') : '';
  const message = 'message' in error ? String((error as { message?: string }).message ?? '').toLowerCase() : '';

  return status === 409 || code === '23505' || message.includes('duplicate') || message.includes('already exists');
};

const getStudentIdentifier = (student: StudentRow) => {
  const direct = [
    student['الرقم الجامعي'],
    student['الرقم'],
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');

  if (direct !== undefined) return String(direct).trim();
  return '';
};

const normalizeStudentClassValue = (value: string) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase().replace(/\s+/g, '');
  if (['a', 'أ'].includes(normalized)) return 'أ';
  if (['b', 'ب'].includes(normalized)) return 'ب';
  if (['c', 'ج'].includes(normalized)) return 'ج';
  if (['d', 'د'].includes(normalized)) return 'د';
  return '';
};

const normalizeStudentYearValue = (value: string) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase().replace(/\s+/g, '');
  if (['1', 'اولى', 'أولى', 'first'].includes(normalized)) return 'أولى';
  if (['2', 'ثانية', 'second'].includes(normalized)) return 'ثانية';
  return '';
};

const getStudentValidationError = (draft: Record<string, string>) => {
  const requiredFields = [
    'اسم الطالب',
    'اسم الاب',
    'الكنية',
    'رقم الهاتف',
    'البريد الإلكتروني',
  ] as const;

  for (const field of requiredFields) {
    const value = String(draft[field] ?? '').trim();
    if (!value) {
      return `الحقل ${field} مطلوب ولا يمكن تركه فارغاً`;
    }
  }

  const rawClassValue = String(draft['الفئة'] ?? '').trim();
  const classValue = normalizeStudentClassValue(rawClassValue);
  if (rawClassValue && rawClassValue !== 'بدون فئة' && classValue && !allowedStudentClasses.includes(classValue as typeof allowedStudentClasses[number])) {
    return 'الفئة يجب أن تكون واحدة من: أ، ب، ج، د فقط';
  }

  const yearValue = normalizeStudentYearValue(String(draft['السنه الدراسية'] ?? ''));
  if (!yearValue || !allowedStudentYears.includes(yearValue as typeof allowedStudentYears[number])) {
    return 'السنة الدراسية يجب أن تكون: أولى أو ثانية فقط';
  }

  if (!String(draft['القسم'] ?? '').trim()) {
    return 'القسم مطلوب ويجب أن يكون تلقائياً تعويضات أسنان';
  }

  return '';
};

const normalizeStudentDraftValues = (draft: Record<string, string>) => {
  const rawClassValue = String(draft['الفئة'] ?? '').trim();
  const normalized: Record<string, string> = {
    ...draft,
    'القسم': String(draft['القسم'] ?? defaultStudentSection).trim() || defaultStudentSection,
    'الفئة': rawClassValue === 'بدون فئة' ? '' : normalizeStudentClassValue(rawClassValue) || '',
    'السنه الدراسية': normalizeStudentYearValue(draft['السنه الدراسية'] ?? '') || '',
  };
  return normalized;
};

const buildStudentEditDraft = (student: StudentRow) => ({
  'الرقم الجامعي': String(getStudentIdentifier(student) || student['الرقم الجامعي'] || student['الرقم'] || ''),
  'كلمة السر': String(student['كلمة السر'] ?? student.password ?? ''),
  'اسم الطالب': String(student['اسم الطالب'] ?? student.name ?? ''),
  'اسم الاب': String(student['اسم الاب'] ?? ''),
  'الكنية': String(student['الكنية'] ?? ''),
  'القسم': String(student['القسم'] ?? ''),
  'الفئة': String(student['الفئة'] ?? ''),
  'السنه الدراسية': String(student['السنه الدراسية'] ?? student.year ?? ''),
  'رقم الهاتف': String(student['رقم الهاتف'] ?? ''),
  'البريد الإلكتروني': String(student['البريد الإلكتروني'] ?? ''),
  'نوع التسجيل': String(student['نوع التسجيل'] ?? ''),
  'ملاحظة': String(student['ملاحظة'] ?? ''),
});

const readPendingAttendanceJobs = (): PendingAttendanceJob[] => {
  if (typeof window === 'undefined') return [];

  try {
    const stored = window.localStorage.getItem(pendingAttendanceStorageKey);
    const jobs = stored ? JSON.parse(stored) : [];
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
};

const writePendingAttendanceJobs = (jobs: PendingAttendanceJob[]) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(pendingAttendanceStorageKey, JSON.stringify(jobs));
};

const enqueueAttendanceJobs = (jobs: PendingAttendanceJob[]) => {
  const existingJobs = readPendingAttendanceJobs();
  writePendingAttendanceJobs([...existingJobs, ...jobs]);
};

const getStudentCacheKey = (classValue: string, year: string) => `${studentCacheStorageKey}:${classValue}:${year}`;

const readCachedStudents = (classValue: string, year: string): StudentRow[] => {
  if (typeof window === 'undefined') return [];

  try {
    const stored = window.localStorage.getItem(getStudentCacheKey(classValue, year));
    const students = stored ? JSON.parse(stored) : [];
    return Array.isArray(students) ? students as StudentRow[] : [];
  } catch {
    return [];
  }
};

const writeCachedStudents = (classValue: string, year: string, students: StudentRow[]) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(getStudentCacheKey(classValue, year), JSON.stringify(students));
};

const getSessionKey = (course: string, classValue: string) => `${course.trim()}::${classValue.trim()}`;

const normalizeSessionRow = (row: Record<string, unknown>): RecentAttendanceSession | null => {
  const id = String(row['session_id'] ?? row['معرف الجلسة'] ?? row['id'] ?? '').trim();
  const course = String(row['المادة'] ?? row['course'] ?? '').trim();
  const classValue = String(row['الفئة'] ?? row['class'] ?? '').trim();
  const supervisor = String(row['المشرف'] ?? row['supervisor'] ?? '').trim();
  const startedAt = String(row['بدأت في'] ?? row['started_at'] ?? row['التاريخ'] ?? '').trim();
  if (!id || !course || !classValue || !startedAt) return null;
  return { id, course, classValue, supervisor, startedAt };
};

const isMissingSessionTableError = (error: { code?: string; message?: string } | null | undefined) => {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === 'PGRST205'
    || message.includes('could not find the table')
    || message.includes('does not exist')
    || message.includes('relation')
    || message.includes('not found');
};

const loadRecentAttendanceSessions = async () => {
  const cutoff = Date.now() - recentSessionWindowMs;
  const { data, error } = await supabase.from(tableCandidates.sessions[0]).select('*');
  if (error) {
    if (isMissingSessionTableError(error)) return [];
    throw error;
  }

  return (Array.isArray(data) ? data as Record<string, unknown>[] : [])
    .map(normalizeSessionRow)
    .filter((session): session is RecentAttendanceSession => Boolean(session))
    .filter((session) => Date.parse(session.startedAt) >= cutoff)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
};

const closeExpiredAttendanceSessions = async () => {
  const cutoff = new Date(Date.now() - recentSessionWindowMs).toISOString();
  const { error } = await supabase
    .from(tableCandidates.sessions[0])
    .update({ الحالة: 'منتهية', ended_at: new Date().toISOString() })
    .eq('الحالة', 'نشطة')
    .lt('started_at', cutoff);
  if (error && !isMissingSessionTableError(error)) console.error('Expired session cleanup failed:', error.message);
};

const createAttendanceSession = async (course: string, classValue: string, supervisor: string) => {
  const session: RecentAttendanceSession = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    course,
    classValue,
    supervisor: supervisor || 'مشرف غير محدد',
    startedAt: new Date().toISOString(),
  };

  await closeExpiredAttendanceSessions();

  const { error } = await supabase.from(tableCandidates.sessions[0]).insert([{
    session_id: session.id,
    session_key: `${getSessionKey(session.course, session.classValue)}::${session.id}`,
    المادة: session.course,
    الفئة: session.classValue,
    المشرف: session.supervisor,
    started_at: session.startedAt,
    الحالة: 'نشطة',
  }]);

  if (error && !isMissingSessionTableError(error)) return { session: null, error };
  return { session, error: null };
};

const closeAttendanceSession = async (sessionId: string) => {
  const { error } = await supabase
    .from(tableCandidates.sessions[0])
    .update({ الحالة: 'منتهية', ended_at: new Date().toISOString() })
    .eq('session_id', sessionId);

  return !error || isMissingSessionTableError(error);
};

const stripAutoGeneratedWarningIds = (payload: Record<string, unknown>) => {
  const sanitized = { ...payload };
  ['warnig_id', 'warning_id', 'warningId', 'warnigId', 'id'].forEach((key) => {
    delete sanitized[key];
  });
  return sanitized;
};

const findSupervisorLogin = async (username: string, password: string) => {
  const tableName = 'المشرفين';
  const normalizedInputUser = normalizeSupervisorValue(username);
  const normalizedInputPassword = normalizeSupervisorValue(password);

  const usernameColumns = ['اسم المستخدم', 'username', 'اسم_المستخدم', 'user_name'];
  let row: Record<string, unknown> | null = null;
  for (const column of usernameColumns) {
    const lookup = await supabase.from(tableName).select('*').eq(column, username).maybeSingle();
    if (!lookup.error && lookup.data) {
      row = lookup.data as Record<string, unknown>;
      break;
    }
    if (lookup.error) {
      const message = lookup.error.message.toLowerCase();
      if (message.includes('column') || message.includes('does not exist') || message.includes('not found')) continue;
      throw lookup.error;
    }
  }

  if (row) {
    const rawPassword = row['كلمة المرور'] ?? row.password ?? row['password'] ?? row['كلمة_المرور'] ?? row['pass'] ?? '';
    const rawDegree = row['الدرجة'] ?? row.degree ?? row['degree'] ?? row['درجه'] ?? row['rank'] ?? '';
    const degreeValue = getSupervisorDegree(row);
    const isAllowedDegree = ['1', '2', '3'].includes(degreeValue)
      || ['moderator', 'مودرييتور', 'monitor', 'مراقب', 'supervisor', 'سوبر', 'فايزور', 'faizur', 'fayzor'].includes(normalizeText(rawDegree).replace(/\s+/g, '').toLowerCase());

    if (normalizeSupervisorValue(rawPassword) !== normalizedInputPassword) return { match: false, reason: 'password', row, tableName };
    if (!isAllowedDegree) return { match: false, reason: 'degree', row, expectedDegree: rawDegree, tableName };
    return { match: true, row, tableName };
  }

  return { match: false, reason: 'username', tableName };
};

const fetchStudentsByClass = async (selectedClass: string, selectedYear: string) => {
  for (const tableName of tableCandidates.students) {
    const { data, error } = await supabase.from(tableName).select('*');
    if (error) {
      const lowerMessage = error.message.toLowerCase();
      if (lowerMessage.includes('does not exist') || lowerMessage.includes('relation')) continue;
      throw error;
    }

    const rows = Array.isArray(data) ? (data as StudentRow[]) : [];
    const filtered = rows.filter((student) => {
      const classValue = normalizeClassValue(
        readStudentField(student, ['الفئة', 'class', 'class_name', 'الفئة_الجامعية'])
      );
      const yearValue = normalizeYearValue(
        readStudentField(student, ['السنه الدراسية', 'السنة الدراسية', 'year', 'student_year'])
      );
      const normalizedClass = normalizeClassValue(selectedClass);
      const normalizedYear = normalizeYearValue(selectedYear);

      const matchesClass = !selectedClass || classValue === normalizedClass || classValue === `فئة${normalizedClass}` || classValue.includes(normalizedClass) || normalizedClass.includes(classValue);
      const matchesYear = !selectedYear || yearValue === normalizedYear || yearValue.includes(normalizedYear) || normalizedYear.includes(yearValue);
      return matchesClass && matchesYear;
    });

    if (filtered.length > 0 || tableName === tableCandidates.students[tableCandidates.students.length - 1]) {
      return filtered;
    }
  }

  return [] as StudentRow[];
};

const saveWarningRecord = async (student: StudentRow, course: string, classValue: string, status: 'absent' | 'present', supervisor: string, absenceReason?: AbsenceReason | '', warningDateOverride?: string) => {
  const studentId = getStudentIdentifier(student);
  if (!studentId) {
    console.warn('[attendance][warning] student id missing before insert', { student, course, classValue, status });
    return false;
  }

  if (!course || !classValue) {
    console.warn('[attendance][warning] missing course/class before insert', { studentId, course, classValue, status });
    return false;
  }

  const warningDate = warningDateOverride?.trim()
    ? warningDateOverride.trim().slice(0, 10)
    : new Date().toISOString().split('T')[0];
  const warningTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const courseName = course || 'غير محددة';
  const finalReason = status === 'absent' ? normalizeAbsenceReason(absenceReason) : 'حضور';
  const reasonText = status === 'absent' ? `غياب في مادة ${courseName}` : `حضور في مادة ${courseName}`;
  const detailsText = status === 'absent' ? finalReason : '';

  const baseRecord = stripAutoGeneratedWarningIds({
    'الرقم الجامعي': studentId,
    'اسم الطالب': getFullStudentName(student),
    'نوع الإنذار': status === 'absent' ? 'إنذار غياب' : 'حضور',
    'السبب': reasonText,
    'التفاصيل': detailsText,
    'التاريخ': warningDate,
    'الوقت': warningTime,
    'المشرف': supervisor || 'مشرف غير محدد',
    'تم الإرسال': true,
  });

  const payloadVariants = [baseRecord, { ...baseRecord, 'الوقت': undefined, 'المشرف': undefined }];

  for (const tableName of tableCandidates.warnings) {
    for (const payload of payloadVariants) {
      console.log('[attendance][warning] attempting insert', {
        tableName,
        payloadKeys: Object.keys(payload),
        payload,
        studentId,
        course,
        classValue,
        status,
      });

      try {
        const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
        const { data, error } = await supabase.from(tableName).insert([cleanPayload]).select();
        console.log('[attendance][warning] insert response', { tableName, data, error: error ? error.message : null });

        if (!error) return true;
        const lowerMessage = error.message.toLowerCase();
        if (lowerMessage.includes('does not exist') || lowerMessage.includes('relation') || lowerMessage.includes('column') || lowerMessage.includes('not found')) {
          console.warn('[attendance][warning] table/column mismatch', { tableName, error: error.message, payloadKeys: Object.keys(payload) });
          continue;
        }

        console.error('[attendance][warning] insert failed', { tableName, error: error.message, payloadKeys: Object.keys(payload), payload });
        return false;
      } catch (error) {
        console.error('[attendance][warning] api exception', { tableName, error: getSupabaseErrorText(error), payloadKeys: Object.keys(payload), payload });
      }
    }
  }

  console.warn('[attendance][warning] all warning insert attempts failed', { studentId, course, classValue, status, attemptedTables: tableCandidates.warnings });
  return false;
};

const saveAttendanceRecord = async (student: StudentRow, course: string, classValue: string, status: AttendanceStatus, supervisor: string, absenceReason?: AbsenceReason | '') => {
  const studentId = getStudentIdentifier(student);
  if (!studentId) {
    console.warn('[attendance][save] student id missing before insert', { student, course, classValue, status });
    return false;
  }

  if (!course || !classValue) {
    console.warn('[attendance][save] missing course/class before insert', { studentId, course, classValue, status });
    return false;
  }

  const attendanceDate = new Date().toISOString().split('T')[0];
  const attendanceTime = new Date().toLocaleTimeString('en-GB', { hour12: false });

  const finalAbsenceReason = status === 'absent' ? normalizeAbsenceReason(absenceReason) : '';
  const baseRecord = {
    'التاريخ': attendanceDate,
    'الوقت': attendanceTime,
    'الرقم الجامعي': studentId,
    'اسم الطالب': getFullStudentName(student),
    'المادة': course,
    'الفئة': classValue,
    'الحالة': status === 'present' ? 'حاضر' : status === 'absent' ? 'غائب' : 'بانتظار',
    'المشرف': supervisor || 'مشرف غير محدد',
    ...(status === 'absent' ? { 'تفاصيل الغياب': finalAbsenceReason, 'التفاصيل': finalAbsenceReason } : {}),
  };

  const payloadVariants = [
    baseRecord,
    { ...baseRecord, 'الحالة': undefined },
    { ...baseRecord, 'الحالة': undefined, 'المشرف': undefined },
  ];

  for (const tableName of tableCandidates.attendance) {
    for (const payload of payloadVariants) {
      console.log('[attendance][save] attempting insert', {
        tableName,
        payloadKeys: Object.keys(payload),
        payload,
        studentId,
        course,
        classValue,
        status,
      });

      try {
        const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
        const { data, error } = await supabase.from(tableName).insert([cleanPayload]).select();
        console.log('[attendance][save] insert response', { tableName, data, error: error ? error.message : null });

        if (!error) return true;
        const lowerMessage = error.message.toLowerCase();
        if (lowerMessage.includes('does not exist') || lowerMessage.includes('relation') || lowerMessage.includes('column') || lowerMessage.includes('not found')) {
          console.warn('[attendance][save] table/column mismatch', { tableName, error: error.message, payloadKeys: Object.keys(payload) });
          continue;
        }

        console.error('[attendance][save] insert failed', { tableName, error: error.message, payloadKeys: Object.keys(payload), payload });
        return false;
      } catch (error) {
        console.error('[attendance][save] api exception', { tableName, error: getSupabaseErrorText(error), payloadKeys: Object.keys(payload), payload });
      }
    }
  }

  console.warn('[attendance][save] all attendance insert attempts failed', { studentId, course, classValue, status, attemptedTables: tableCandidates.attendance });
  return false;
};

const savePendingAttendanceJob = async (job: PendingAttendanceJob) => {
  if (job.type === 'warning') {
    return saveWarningRecord(job.student, job.course, job.classValue, 'absent', job.supervisor, job.absenceReason);
  }

  return saveAttendanceRecord(job.student, job.course, job.classValue, job.status, job.supervisor, job.absenceReason);
};

const flushPendingAttendanceJobs = async () => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;

  const jobs = readPendingAttendanceJobs();
  if (!jobs.length) return 0;

  const results = await Promise.all(jobs.map(async (job) => ({
    job,
    saved: await savePendingAttendanceJob(job),
  })));
  const remainingJobs = results.filter((result) => !result.saved).map((result) => result.job);
  writePendingAttendanceJobs(remainingJobs);
  return jobs.length - remainingJobs.length;
};

export default function AttendancePage() {
  const [selectedCourse, setSelectedCourse] = useState('');
  const [selectedClass, setSelectedClass] = useState('أ');
  const [selectedYear, setSelectedYear] = useState('أولى');
  const [notice, setNotice] = useState('يرجى تسجيل دخول المشرف لبدء الجلسة');
  const [messageComposer, setMessageComposer] = useState<{ student: StudentRow; channel: 'telegram' | 'email' } | null>(null);
  const [messageComposerText, setMessageComposerText] = useState('');
  const [messageComposerSending, setMessageComposerSending] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [attendanceData, setAttendanceData] = useState<Record<string, AttendanceEntry>>({});
  const [loading, setLoading] = useState(false);
  const [isSendingTelegramToAll, setIsSendingTelegramToAll] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [qrScannerLoading, setQrScannerLoading] = useState(false);
  const [qrScannerError, setQrScannerError] = useState('');
  const [qrScanSuccess, setQrScanSuccess] = useState(false);
  const [scannedStudentName, setScannedStudentName] = useState('');
  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const qrScannerControlsRef = useRef<{ stop: () => void } | null>(null);
  const qrScanHandlerRef = useRef<(rawValue: string) => void>(() => undefined);
  const scannedQrStudentIdsRef = useRef<Set<string>>(new Set());
  const qrScanSuccessTimerRef = useRef<number | null>(null);
  const [supervisorLoggedIn, setSupervisorLoggedIn] = useState(false);
  const [supervisorUsername, setSupervisorUsername] = useState<string>('');
  const [supervisorPassword, setSupervisorPassword] = useState('');
  const [rememberSupervisorCredentials, setRememberSupervisorCredentials] = useState(true);
  const [supervisorFeatures, setSupervisorFeatures] = useState<SupervisorFeature[]>([]);
  const [supervisorDegree, setSupervisorDegree] = useState('');
  const [selectedFeature, setSelectedFeature] = useState<SupervisorFeature | null>(null);
  const [recentSessions, setRecentSessions] = useState<RecentAttendanceSession[]>([]);
  const [activeSession, setActiveSession] = useState<RecentAttendanceSession | null>(null);
  const saveInProgressRef = useRef(false);
  const [adminAttendance, setAdminAttendance] = useState<AdminRecord[]>([]);
  const [adminWarnings, setAdminWarnings] = useState<AdminRecord[]>([]);
  const [adminStudentNames, setAdminStudentNames] = useState<Record<string, string>>({});
  const [adminSupervisors, setAdminSupervisors] = useState<AdminRecord[]>([]);
  const [adminSupervisorWarnings, setAdminSupervisorWarnings] = useState<AdminRecord[]>([]);
  const [supervisorRecords, setSupervisorRecords] = useState<AdminRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminRecord[]>([]);
  const [supervisorForm, setSupervisorForm] = useState({ username: '', password: '', degree: '3' });
  const [supervisorProfileForm, setSupervisorProfileForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [supervisorProfileLoading, setSupervisorProfileLoading] = useState(false);
  const [teacherEvaluationEnabled, setTeacherEvaluationEnabled] = useState(false);
  const [teacherEvaluationSettingsLoading, setTeacherEvaluationSettingsLoading] = useState(false);
  const [teacherEvaluationSettingsSaving, setTeacherEvaluationSettingsSaving] = useState(false);
  const [teacherEvaluationSettingsNotice, setTeacherEvaluationSettingsNotice] = useState('');
  const [showTeacherEvaluationReport, setShowTeacherEvaluationReport] = useState(false);
  const [teacherEvaluationReportLoading, setTeacherEvaluationReportLoading] = useState(false);
  const [teacherEvaluationReportTeachers, setTeacherEvaluationReportTeachers] = useState<AdminRecord[]>([]);
  const [teacherEvaluationReportRows, setTeacherEvaluationReportRows] = useState<AdminRecord[]>([]);
  const [teacherEvaluationReportError, setTeacherEvaluationReportError] = useState('');
  const [editingSupervisorId, setEditingSupervisorId] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminSearch, setAdminSearch] = useState('');
  const [adminCourseFilter, setAdminCourseFilter] = useState('');
  const [adminDateFrom, setAdminDateFrom] = useState('');
  const [adminDateTo, setAdminDateTo] = useState('');
  const [adminRecordType, setAdminRecordType] = useState<'all' | 'attendance' | 'warnings'>('all');
  const [selectedAdminStudentId, setSelectedAdminStudentId] = useState('');
  const [selectedAdminAttendanceKey, setSelectedAdminAttendanceKey] = useState('');
  const [selectedAdminWarningKey, setSelectedAdminWarningKey] = useState('');
  const [studentDirectory, setStudentDirectory] = useState<StudentRow[]>([]);
  const [studentDirectorySearch, setStudentDirectorySearch] = useState('');
  const [studentClassFilter, setStudentClassFilter] = useState('');
  const [studentYearFilter, setStudentYearFilter] = useState('');
  const [studentSectionFilter, setStudentSectionFilter] = useState('');
  const [editingStudentId, setEditingStudentId] = useState('');
  const [editingStudentDraft, setEditingStudentDraft] = useState<Record<string, string>>({});
  const [showCreateStudentForm, setShowCreateStudentForm] = useState(false);
  const [newStudentForm, setNewStudentForm] = useState<Record<string, string>>({
    'الرقم الجامعي': '',
    'كلمة السر': '',
    'اسم الطالب': '',
    'اسم الاب': '',
    'الكنية': '',
    'القسم': defaultStudentSection,
    'الفئة': '',
    'السنه الدراسية': '',
    'رقم الهاتف': '',
    'البريد الإلكتروني': '',
    'نوع التسجيل': 'جديد',
    'ملاحظة': '',
  });

  const refreshSupervisorSessionFromDatabase = async (usernameOverride?: string, currentSupervisorUsername?: string) => {
    const activeUsername = (usernameOverride ?? currentSupervisorUsername ?? supervisorUsername).trim();
    if (!activeUsername || typeof window === 'undefined') return;

    try {
      const { data, error } = await supabase.from('المشرفين').select('*');
      if (error) throw error;

      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      const match = rows.find((row) => normalizeSupervisorValue(row['اسم المستخدم'] ?? row.username ?? row['username'] ?? row['اسم_المستخدم'] ?? row['user_name']) === normalizeSupervisorValue(activeUsername));
      if (!match) return;

      const liveDegree = getSupervisorDegree(match) || '3';
      const liveFeatures = getSupervisorFeatures(liveDegree);
      setSupervisorDegree(liveDegree);
      setSupervisorFeatures(liveFeatures);

      const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as Partial<StoredSupervisorSession>;
      const allowedSelectedFeature = stored.selectedFeature && liveFeatures.includes(stored.selectedFeature) ? stored.selectedFeature : null;
      setSelectedFeature(allowedSelectedFeature);

      window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({
        username: activeUsername,
        degree: liveDegree,
        features: liveFeatures,
        selectedFeature: allowedSelectedFeature,
      } satisfies StoredSupervisorSession));
    } catch {
      // Ignore background sync failures; the session remains usable and refreshes on next login.
    }
  };

  const syncCurrentSupervisorSession = (nextDegree: string, nextUsername: string) => {
    const nextFeatures = getSupervisorFeatures(nextDegree);
    setSupervisorDegree(nextDegree);
    setSupervisorFeatures(nextFeatures);
    setSupervisorUsername(nextUsername);

    if (nextUsername) {
      const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as Partial<StoredSupervisorSession>;
      const nextSelectedFeature = stored.selectedFeature && nextFeatures.includes(stored.selectedFeature) ? stored.selectedFeature : null;
      setSelectedFeature(nextSelectedFeature);
      window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({
        username: nextUsername,
        degree: nextDegree,
        features: nextFeatures,
        selectedFeature: nextSelectedFeature,
      } satisfies StoredSupervisorSession));
    }
  };

  useEffect(() => {
    try {
      const storedSupervisor = window.localStorage.getItem(supervisorSessionStorageKey);
      if (!storedSupervisor) return;
      const session = JSON.parse(storedSupervisor) as StoredSupervisorSession;
      if (session?.username && Array.isArray(session.features)) {
        setSupervisorUsername(session.username);
        setSupervisorDegree(session.degree || '');
        setSupervisorFeatures(session.features);
        setSelectedFeature(session.selectedFeature ?? null);
        setSupervisorLoggedIn(true);
        setNotice('تمت استعادة جلسة المشرف. اختر الوظيفة للمتابعة.');
      }
    } catch {
      window.localStorage.removeItem(supervisorSessionStorageKey);
    }
  }, []);

  useEffect(() => {
    const syncPendingAttendance = async () => {
      const savedCount = await flushPendingAttendanceJobs();
      if (savedCount > 0) {
        setNotice(`تمت مزامنة ${savedCount} عملية حضور معلقة بعد عودة الاتصال.`);
      }
    };

    window.addEventListener('online', syncPendingAttendance);
    void syncPendingAttendance();

    return () => window.removeEventListener('online', syncPendingAttendance);
  }, []);

  const refreshRecentSessions = async () => {
    try {
      setRecentSessions(await loadRecentAttendanceSessions());
    } catch (error) {
      console.error('Recent attendance sessions load failed:', getSupabaseErrorText(error));
    }
  };

  const refreshAdminData = async () => {
    setAdminLoading(true);
    try {
      const records = await loadAdminRecords();
      setAdminAttendance(records.attendance);
      setAdminWarnings(records.warnings);
      setAdminStudentNames(records.studentNames);
      setAdminSupervisors(records.supervisors);
      setAdminSupervisorWarnings(records.supervisorWarnings);
      setSupervisorRecords(records.supervisors);
    } catch (error) {
      setNotice(`تعذر تحميل بيانات لوحة الإدارة: ${getSupabaseErrorText(error)}`);
    } finally {
      setAdminLoading(false);
    }
  };

  const refreshAuditLogs = async () => {
    setAdminLoading(true);
    try {
      setAuditLogs(await loadAuditLogs());
    } catch (error) {
      setNotice(`تعذر تحميل سجلات النظام: ${getSupabaseErrorText(error)}`);
    } finally {
      setAdminLoading(false);
    }
  };

  const refreshStudentDirectory = async () => {
    setAdminLoading(true);
    try {
      const { data, error } = await supabase.from('students').select('*');
      if (error) throw error;
      setStudentDirectory(Array.isArray(data) ? (data as StudentRow[]) : []);
    } catch (error) {
      setNotice(`تعذر تحميل بيانات الطلاب: ${getSupabaseErrorText(error)}`);
    } finally {
      setAdminLoading(false);
    }
  };

  const refreshTeacherEvaluationSetting = async () => {
    if (teacherEvaluationsTemporarilyDisabled) {
      setTeacherEvaluationEnabled(false);
      setTeacherEvaluationSettingsNotice('تقييم المدرسين متوقف مؤقتًا.');
      return;
    }
    setTeacherEvaluationSettingsLoading(true);
    setTeacherEvaluationSettingsNotice('');
    try {
      const response = await fetch('/api/supervisor/teacher-evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settings', username: supervisorUsername, password: supervisorPassword }),
      });
      const result = await response.json() as { success?: boolean; enabled?: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(result.error || 'teacher-evaluation-settings-failed');
      setTeacherEvaluationEnabled(result.enabled === true);
    } catch (error) {
      setTeacherEvaluationSettingsNotice(`تعذر تحميل الإعداد: ${getTeacherEvaluationErrorText(error)}`);
    } finally {
      setTeacherEvaluationSettingsLoading(false);
    }
  };

  const toggleTeacherEvaluation = async () => {
    if (teacherEvaluationsTemporarilyDisabled) {
      setTeacherEvaluationSettingsNotice('تقييم المدرسين متوقف مؤقتًا.');
      return;
    }
    const nextValue = !teacherEvaluationEnabled;
    setTeacherEvaluationSettingsSaving(true);
    setTeacherEvaluationSettingsNotice('');
    try {
      const response = await fetch('/api/supervisor/teacher-evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-enabled', username: supervisorUsername, password: supervisorPassword, enabled: nextValue }),
      });
      const result = await response.json() as { success?: boolean; enabled?: boolean; error?: string };
      if (!response.ok || !result.success || result.enabled !== nextValue) {
        throw new Error(result.error || 'لم يتم تثبيت حالة التفعيل في قاعدة البيانات.');
      }
      setTeacherEvaluationEnabled(nextValue);
      setTeacherEvaluationSettingsNotice(nextValue ? 'تم تفعيل تقييم المدرسين للطلاب.' : 'تم إيقاف تقييم المدرسين.');
    } catch (error) {
      setTeacherEvaluationSettingsNotice(`تعذر حفظ الإعداد: ${getTeacherEvaluationErrorText(error)}`);
    } finally {
      setTeacherEvaluationSettingsSaving(false);
    }
  };

  const refreshTeacherEvaluationReport = async () => {
    setTeacherEvaluationReportLoading(true);
    setTeacherEvaluationReportError('');
    try {
      const response = await fetch('/api/supervisor/teacher-evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'report', username: supervisorUsername, password: supervisorPassword }),
      });
      const result = await response.json() as { success?: boolean; teachers?: AdminRecord[]; evaluations?: AdminRecord[]; error?: string };
      if (!response.ok || !result.success) throw new Error(result.error || 'teacher-evaluation-report-failed');
      setTeacherEvaluationReportTeachers(result.teachers ?? []);
      setTeacherEvaluationReportRows(result.evaluations ?? []);
    } catch (error) {
      setTeacherEvaluationReportError(`تعذر تحميل التقييمات: ${getTeacherEvaluationErrorText(error)}`);
    } finally {
      setTeacherEvaluationReportLoading(false);
    }
  };

  const sanitizedStudentUpdatePayload = (payload: Record<string, string>) => {
    return Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    );
  };

  const handleOpenStudentEditor = (student: StudentRow) => {
    const selectedStudentId = getStudentIdentifier(student);
    if (!selectedStudentId) {
      const fallbackId = Object.entries(student).find(([key, value]) => {
        if (value === undefined || value === null || String(value).trim() === '') return false;
        return /(?:رقم|id|student)/i.test(key);
      });

      const fallbackValue = fallbackId ? String(fallbackId[1]).trim() : '';
      if (!fallbackValue) {
        setNotice('هذا الطالب لا يحتوي على معرف صالح للتعديل.');
        return;
      }

      setEditingStudentId(fallbackValue);
      setEditingStudentDraft(buildStudentEditDraft({ ...student, ['الرقم الجامعي']: fallbackValue }));
      return;
    }

    setEditingStudentId(selectedStudentId);
    setEditingStudentDraft(buildStudentEditDraft(student));
  };

  const saveEditedStudent = async () => {
    if (!editingStudentId) return;

    const draftCopy: Record<string, string> = {
      ...editingStudentDraft,
      'القسم': String(editingStudentDraft['القسم'] ?? defaultStudentSection).trim() || defaultStudentSection,
    };

    const validationError = getStudentValidationError(draftCopy);
    if (validationError) {
      setNotice(validationError);
      return;
    }

    const normalizedDraft: Record<string, string> = normalizeStudentDraftValues(draftCopy);
    normalizedDraft['القسم'] = defaultStudentSection;

    const payload: Record<string, string> = {};
    const editableFields = [
      'الرقم الجامعي',
      'كلمة السر',
      'اسم الطالب',
      'اسم الاب',
      'الكنية',
      'القسم',
      'الفئة',
      'السنه الدراسية',
      'رقم الهاتف',
      'البريد الإلكتروني',
      'نوع التسجيل',
      'ملاحظة',
    ];

    editableFields.forEach((field) => {
      if (normalizedDraft[field] !== undefined) {
        const value = String(normalizedDraft[field] ?? '').trim();
        if (value !== '') payload[field] = value;
      }
    });

    if (!Object.keys(payload).length) {
      setNotice('لا توجد بيانات جديدة لتحديثها');
      return;
    }

    const nextStudentId = String(normalizedDraft['الرقم الجامعي'] ?? editingStudentId).trim();
    if (!nextStudentId) {
      setNotice('لا يوجد رقم جامعي صالح لتحديث الطالب');
      return;
    }

    const cleanPayload = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
    ) as Record<string, string>;
    const originalStudent = studentDirectory.find((student) => getStudentIdentifier(student) === editingStudentId);
    const originalIdKey = originalStudent?.['الرقم الجامعي'] !== undefined
      ? 'الرقم الجامعي'
      : originalStudent?.student_id !== undefined
        ? 'student_id'
        : originalStudent?.studentId !== undefined
          ? 'studentId'
          : 'id';
    const originalIdValue = String(originalStudent?.[originalIdKey as keyof StudentRow] ?? editingStudentId).trim();
    if (!originalIdValue) {
      setNotice('لا يوجد معرّف أصلي صالح لتحديث الطالب');
      return;
    }
    const changedFields = editableFields.filter((field) => {
      const oldValue = String(originalStudent?.[field as keyof StudentRow] ?? '').trim();
      const newValue = String(cleanPayload[field] ?? '').trim();
      return oldValue !== newValue;
    });

    console.log('[attendance][student-update] payload', cleanPayload);

    const { data, error } = await supabase
      .from('students')
      .update(cleanPayload)
      .eq(originalIdKey, originalIdValue)
      .select();

    if (error) {
      console.error('Supabase Error Detail:', error);
      console.error('[attendance][student-update] failed payload', cleanPayload);

      if (isDuplicateStudentIdError(error)) {
        setNotice('الرقم الجامعي موجود مسبقاً، يرجى استخدام رقم جامعي آخر أو تعديل بيانات الطالب الحالي.');
        return;
      }

      setNotice(`تعذر تحديث بيانات الطالب: ${getSupabaseErrorText(error)}`);
      return;
    }

    if (!data || data.length === 0) {
      setNotice('لم يتم العثور على سجل الطالب لتحديثه. أعد تحميل قائمة الطلاب وحاول مرة أخرى.');
      return;
    }

    console.log('[attendance][student-update] success', data);

    setNotice('تم تحديث بيانات الطالب بنجاح');
    setEditingStudentId('');
    setEditingStudentDraft({});
    await refreshStudentDirectory();

    const updatedEmail = String(cleanPayload['البريد الإلكتروني'] ?? originalStudent?.['البريد الإلكتروني'] ?? '').trim();
    if (updatedEmail && changedFields.length) {
      const changes = changedFields.map((field) => {
        const oldValue = String(originalStudent?.[field as keyof StudentRow] ?? 'غير محدد').trim() || 'غير محدد';
        const newValue = String(cleanPayload[field] ?? 'غير محدد').trim() || 'غير محدد';
        return `- ${field}: من «${oldValue}» إلى «${newValue}»`;
      }).join('\n');
      void fetch('/api/supervisor/student-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: updatedEmail,
          studentName: getFullStudentName(originalStudent ?? {}),
          studentId: cleanPayload['الرقم الجامعي'] ?? editingStudentId,
          studentYear: cleanPayload['السنه الدراسية'] ?? originalStudent?.['السنه الدراسية'],
          studentClass: cleanPayload['الفئة'] ?? originalStudent?.['الفئة'],
          message: `تم تعديل بياناتك بواسطة نظام الإدارة:\n${changes}`,
        }),
      }).catch((error) => console.error('Student update email failed:', error));
    }
  };

  const createStudentAccount = async () => {
    const draft: Record<string, string> = {
      ...newStudentForm,
      'القسم': defaultStudentSection,
    };

    const canAssignClass = supervisorDegree === '2';
    const validationError = getStudentValidationError(draft);
    if (validationError) {
      setNotice(validationError);
      return;
    }

    const normalizedDraft: Record<string, string> = normalizeStudentDraftValues(draft);
    normalizedDraft['القسم'] = defaultStudentSection;

    const chosenClass = normalizeStudentClassValue(String(normalizedDraft['الفئة'] ?? ''));
    if (chosenClass && canAssignClass) {
      const classSummary = await getClassAvailabilityOptions();
      const seatInfo = classSummary.find((item) => item.name === chosenClass);
      if (seatInfo && typeof seatInfo.available === 'number' && seatInfo.available <= 0) {
        setNotice(`لا توجد مقاعد متاحة في الفئة ${chosenClass} الآن.`);
        return;
      }
    }

    const payload: Record<string, string> = {
      'الرقم الجامعي': String(normalizedDraft['الرقم الجامعي'] ?? '').trim(),
      'كلمة السر': String(normalizedDraft['كلمة السر'] ?? '').trim() || '123456',
      'اسم الطالب': String(normalizedDraft['اسم الطالب'] ?? '').trim(),
      'اسم الاب': String(normalizedDraft['اسم الاب'] ?? '').trim(),
      'الكنية': String(normalizedDraft['الكنية'] ?? '').trim(),
      'القسم': defaultStudentSection,
      'السنه الدراسية': String(normalizedDraft['السنه الدراسية'] ?? '').trim(),
      'رقم الهاتف': String(normalizedDraft['رقم الهاتف'] ?? '').trim(),
      'البريد الإلكتروني': String(normalizedDraft['البريد الإلكتروني'] ?? '').trim(),
      'نوع التسجيل': String(normalizedDraft['نوع التسجيل'] ?? 'جديد').trim() || 'جديد',
      'ملاحظة': String(normalizedDraft['ملاحظة'] ?? '').trim(),
    };

    if (chosenClass) {
      payload['الفئة'] = chosenClass;
    }

    const canCreateAccount = ['1', '2'].includes(supervisorDegree) || supervisorFeatures.includes('students');
    if (!canCreateAccount) {
      setNotice('لا توجد صلاحية لإنشاء حساب طالب في هذا المستوى.');
      return;
    }

    try {
      const { error } = await supabase.from('students').insert([payload]);
      if (error) {
        console.error('Supabase Error Detail:', error);

        if (isDuplicateStudentIdError(error)) {
          setNotice('الرقم الجامعي موجود مسبقاً، يرجى استخدام رقم جامعي آخر أو تعديل بيانات الطالب الحالي.');
          return;
        }

        setNotice(`تعذر إنشاء حساب الطالب: ${error.message}`);
        return;
      }

      setNotice('تم إنشاء حساب الطالب بنجاح');
      setShowCreateStudentForm(false);
      setNewStudentForm({
        'الرقم الجامعي': '',
        'كلمة السر': '',
        'اسم الطالب': '',
        'اسم الاب': '',
        'الكنية': '',
        'القسم': defaultStudentSection,
        'الفئة': '',
        'السنه الدراسية': '',
        'رقم الهاتف': '',
        'البريد الإلكتروني': '',
        'نوع التسجيل': 'جديد',
        'ملاحظة': '',
      });
      await refreshStudentDirectory();
    } catch (error) {
      console.error('Supabase Error Detail:', error);

      if (isDuplicateStudentIdError(error)) {
        setNotice('الرقم الجامعي موجود مسبقاً، يرجى استخدام رقم جامعي آخر أو تعديل بيانات الطالب الحالي.');
        return;
      }

      setNotice(`تعذر إنشاء حساب الطالب: ${getSupabaseErrorText(error)}`);
    }
  };

  const normalizedAdminSearch = adminSearch.trim().toLowerCase();
  const getAdminStudentName = (record: AdminRecord) => {
    const studentId = String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId'])).trim();
    return adminStudentNames[studentId] || getFullStudentName(record);
  };
  const filteredAdminAttendance = useMemo(() => adminAttendance.filter((record) => {
    const searchable = [
      getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId']),
      getAdminStudentName(record),
      getAdminRecordCourse(record),
    ].join(' ').toLowerCase();
    const course = getAdminRecordCourse(record);
    const date = getAdminRecordDate(record).slice(0, 10);
    return (!normalizedAdminSearch || searchable.includes(normalizedAdminSearch))
      && (!adminCourseFilter || course === adminCourseFilter)
      && (!adminDateFrom || date >= adminDateFrom)
      && (!adminDateTo || date <= adminDateTo);
  }), [adminAttendance, normalizedAdminSearch, adminCourseFilter, adminDateFrom, adminDateTo, adminStudentNames]);

  const filteredAdminWarnings = useMemo(() => adminWarnings.filter((record) => {
    const searchable = [
      getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId']),
      getAdminStudentName(record),
      getAdminRecordCourse(record),
      getAdminRecordValue(record, ['السبب', 'التفاصيل']),
    ].join(' ').toLowerCase();
    const course = getAdminRecordCourse(record);
    const date = getAdminRecordDate(record).slice(0, 10);
    return (!normalizedAdminSearch || searchable.includes(normalizedAdminSearch))
      && (!adminCourseFilter || course === adminCourseFilter)
      && (!adminDateFrom || date >= adminDateFrom)
      && (!adminDateTo || date <= adminDateTo);
  }), [adminWarnings, normalizedAdminSearch, adminCourseFilter, adminDateFrom, adminDateTo, adminStudentNames]);

  const adminStudentIds = useMemo(() => Array.from(new Set([
    ...filteredAdminAttendance,
    ...filteredAdminWarnings,
  ].map((record) => String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId']))).filter(Boolean))), [filteredAdminAttendance, filteredAdminWarnings]);

  const studentClassOptions = useMemo(() => {
    const options = new Set<string>(['بدون فئة', 'أ', 'ب', 'ج', 'د']);
    studentDirectory.forEach((student) => {
      const className = String(student['الفئة'] ?? '').trim();
      if (className) options.add(className);
      if (!className || className === 'غير محدد') options.add('بدون فئة');
    });
    return Array.from(options);
  }, [studentDirectory]);

  const filteredStudentDirectory = useMemo(() => {
    const normalizedSearch = studentDirectorySearch.trim().toLowerCase();
    return studentDirectory.filter((student) => {
      const studentId = String(student['الرقم الجامعي'] ?? student.id ?? '').trim();
      const studentName = String(student['اسم الطالب'] ?? '').trim();
      const fatherName = String(student['اسم الاب'] ?? '').trim();
      const familyName = String(student['الكنية'] ?? '').trim();
      const section = String(student['القسم'] ?? '').trim();
      const rawClassName = String(student['الفئة'] ?? '').trim();
      const className = rawClassName || 'بدون فئة';
      const normalizedClassName = className === 'غير محدد' ? 'بدون فئة' : className;
      const year = String(student['السنه الدراسية'] ?? '').trim();
      const searchable = `${studentId} ${studentName} ${fatherName} ${familyName} ${section} ${normalizedClassName}`.toLowerCase();

      const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
      const matchesClass = !studentClassFilter || (studentClassFilter === 'بدون فئة' ? (!rawClassName || rawClassName === 'غير محدد') : normalizedClassName === studentClassFilter);
      const matchesYear = !studentYearFilter || year === studentYearFilter;
      const matchesSection = !studentSectionFilter || section === studentSectionFilter;

      return matchesSearch && matchesClass && matchesYear && matchesSection;
    });
  }, [studentDirectory, studentDirectorySearch, studentClassFilter, studentYearFilter, studentSectionFilter]);

  const selectedStudentAttendance = selectedAdminStudentId
    ? filteredAdminAttendance.filter((record) => String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId'])) === selectedAdminStudentId)
    : [];
  const selectedStudentWarnings = selectedAdminStudentId
    ? filteredAdminWarnings.filter((record) => String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId'])) === selectedAdminStudentId)
    : [];

  const handleWarningToAttendance = async (warning: AdminRecord) => {
    setAdminLoading(true);
    const attendanceResult = await insertAdminAttendance({ ...warning, 'اسم الطالب': getAdminStudentName(warning) }, supervisorUsername);
    if (!attendanceResult.success) {
      setNotice(`تعذر تسجيل الحضور: ${attendanceResult.error}`);
      setAdminLoading(false);
      return;
    }

    const deleteResult = await deleteAdminWarning(warning);
    if (!deleteResult.success) {
      setNotice(`تم تسجيل الحضور، لكن تعذر حذف الإنذار: ${deleteResult.error}`);
    } else {
      setNotice('تم تحويل الإنذار إلى سجل حضور بنجاح.');
      writeAuditLog({
        action: 'warning_to_attendance',
        userType: 'supervisor',
        username: supervisorUsername,
        details: { studentId: getAdminRecordValue(warning, ['الرقم الجامعي']), warningId: getAdminRecordId(warning) },
      });
    }
    await refreshAdminData();
  };

  const handleAttendanceToWarning = async (record: AdminRecord) => {
    if (!window.confirm(`هل تريد تحويل حضور الطالب ${getAdminStudentName(record)} إلى إنذار غياب؟`)) return;
    setAdminLoading(true);

    const student: StudentRow = {
      'الرقم الجامعي': String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId']) || ''),
      'اسم الطالب': getAdminStudentName(record),
      'الفئة': String(getAdminRecordValue(record, ['الفئة', 'class', 'class_name']) || 'غير محدد'),
    };
    const warningSaved = await saveWarningRecord(
      student,
      getAdminRecordCourse(record) || 'غير محددة',
      String(getAdminRecordValue(record, ['الفئة', 'class', 'class_name']) || 'غير محدد'),
      'absent',
      supervisorUsername,
      'غياب مبرر',
      getAdminRecordDate(record),
    );

    if (!warningSaved) {
      setNotice('تعذر إنشاء إنذار الغياب، لذلك لم يتم حذف سجل الحضور.');
      setAdminLoading(false);
      return;
    }

    const attendanceDeleted = await deleteAdminAttendance(record);
    writeAuditLog({
      action: 'attendance_to_warning',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { studentId: getAdminRecordValue(record, ['الرقم الجامعي']), attendanceId: getAdminRecordId(record), warningDate: getAdminRecordDate(record) },
    });
    setNotice(attendanceDeleted.success
      ? 'تم تحويل سجل الحضور إلى إنذار غياب بنجاح.'
      : `تم إنشاء الإنذار، لكن تعذر حذف سجل الحضور: ${attendanceDeleted.error}`);
    await refreshAdminData();
  };

  const handleDeleteWarning = async (warning: AdminRecord) => {
    if (!window.confirm('هل تريد حذف هذا الإنذار نهائيًا؟')) return;
    setAdminLoading(true);
    const result = await deleteAdminWarning(warning);
    writeAuditLog({
      action: 'warning_deleted',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { studentId: getAdminRecordValue(warning, ['الرقم الجامعي']), warningId: getAdminRecordId(warning) },
    });
    setNotice(result.success ? 'تم حذف الإنذار بنجاح.' : `تعذر حذف الإنذار: ${result.error}`);
    await refreshAdminData();
  };

  const handleWarningDetails = async (warning: AdminRecord, details: string) => {
    setAdminLoading(true);
    const result = await updateAdminWarning(warning, details);
    writeAuditLog({
      action: 'warning_updated',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { studentId: getAdminRecordValue(warning, ['الرقم الجامعي']), warningId: getAdminRecordId(warning), details },
    });
    setNotice(result.success ? 'تم تحديث تفاصيل الغياب.' : `تعذر تحديث الإنذار: ${result.error}`);
    await refreshAdminData();
  };

  const handleAttendanceStatus = async (record: AdminRecord, status: 'حاضر' | 'غائب', details = '') => {
    setAdminLoading(true);
    const result = await updateAdminAttendance(record, status, details || (status === 'غائب' ? 'غياب مبرر' : ''));
    writeAuditLog({
      action: 'attendance_updated',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { studentId: getAdminRecordValue(record, ['الرقم الجامعي']), status, absenceReason: details || (status === 'غائب' ? 'غياب مبرر' : '') },
    });
    setNotice(result.success ? 'تم تحديث حالة الحضور.' : `تعذر تحديث سجل الحضور: ${result.error}`);
    await refreshAdminData();
  };

  const handleDeleteAttendance = async (record: AdminRecord) => {
    if (!window.confirm('هل تريد حذف سجل الحضور هذا نهائيًا؟')) return;
    setAdminLoading(true);
    const result = await deleteAdminAttendance(record);
    writeAuditLog({
      action: 'attendance_deleted',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { studentId: getAdminRecordValue(record, ['الرقم الجامعي']), attendanceId: getAdminRecordId(record) },
    });
    setNotice(result.success ? 'تم حذف سجل الحضور بنجاح.' : `تعذر حذف سجل الحضور: ${result.error}`);
    await refreshAdminData();
  };

  const handleSupervisorWarning = async (username: string, degree: string) => {
    const details = window.prompt(`اكتب تفاصيل الإنذار للمشرف ${username}`);
    if (!details?.trim()) return;
    setAdminLoading(true);
    const result = await createSupervisorWarning(username, degree, details.trim(), supervisorUsername);
    writeAuditLog({
      action: 'supervisor_warning_created',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { targetUsername: username, targetDegree: degree, warningDetails: details.trim() },
    });
    setNotice(result.success ? 'تم تسجيل إنذار المشرف.' : `تعذر تسجيل إنذار المشرف: ${result.error}`);
    await refreshAdminData();
  };

  const handleSupervisorFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supervisorForm.username.trim() || (!editingSupervisorId && !supervisorForm.password.trim())) {
      setNotice('أدخل اسم المستخدم وكلمة المرور للمشرف الجديد.');
      return;
    }
    setAdminLoading(true);
    const current = supervisorRecords.find((row) => getSupervisorRecordId(row) === editingSupervisorId);
    const result = current
      ? await updateSupervisorRecord(current, supervisorForm)
      : await createSupervisorRecord(supervisorForm.username.trim(), supervisorForm.password.trim(), supervisorForm.degree);
    writeAuditLog({
      action: current ? 'supervisor_updated' : 'supervisor_created',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { targetUsername: supervisorForm.username.trim(), targetDegree: supervisorForm.degree },
    });

    if (result.success && supervisorLoggedIn && supervisorUsername.trim() === supervisorForm.username.trim()) {
      const updatedDegree = normalizeSupervisorDegree(supervisorForm.degree) || supervisorForm.degree || '3';
      syncCurrentSupervisorSession(updatedDegree, supervisorForm.username.trim());
      setSelectedFeature((previous) => previous && getSupervisorFeatures(updatedDegree).includes(previous) ? previous : null);
      setNotice('تم تحديث درجة المشرف وحُدّثت صلاحيات الحساب فوراً.');
    } else {
      setNotice(result.success ? 'تم حفظ بيانات المشرف.' : `تعذر حفظ المشرف: ${result.error}`);
    }

    setSupervisorForm({ username: '', password: '', degree: '3' });
    setEditingSupervisorId('');
    await refreshAdminData();
  };

  const handleSupervisorDelete = async (row: AdminRecord) => {
    if (!window.confirm('هل تريد حذف حساب المشرف نهائيًا؟')) return;
    setAdminLoading(true);
    const result = await deleteSupervisorRecord(row);
    writeAuditLog({ action: 'supervisor_deleted', userType: 'supervisor', username: supervisorUsername, details: { targetUsername: getSupervisorCredentials(row).username, targetDegree: getSupervisorDegree(row) } });
    setNotice(result.success ? 'تم حذف المشرف.' : `تعذر حذف المشرف: ${result.error}`);
    await refreshAdminData();
  };

  const handleSupervisorProfileSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { currentPassword, newPassword, confirmPassword } = supervisorProfileForm;
    if (!currentPassword || !newPassword || !confirmPassword) {
      setNotice('أدخل كلمة المرور الحالية والجديدة وتأكيد كلمة المرور الجديدة.');
      return;
    }
    if (newPassword.length < 6) {
      setNotice('يجب أن تتكون كلمة المرور الجديدة من 6 محارف على الأقل.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setNotice('كلمة المرور الجديدة وتأكيدها غير متطابقين.');
      return;
    }

    setSupervisorProfileLoading(true);
    try {
      const { data, error } = await supabase.from('المشرفين').select('*');
      if (error) throw error;
      const rows = Array.isArray(data) ? data as AdminRecord[] : [];
      const current = rows.find((row) => normalizeSupervisorValue(
        row['اسم المستخدم'] ?? row.username ?? row['اسم_المستخدم'] ?? row.user_name
      ) === normalizeSupervisorValue(supervisorUsername));
      if (!current) {
        setNotice('تعذر العثور على حساب المشرف الحالي.');
        return;
      }

      const credentials = getSupervisorCredentials(current);
      if (normalizeSupervisorValue(credentials.password) !== normalizeSupervisorValue(currentPassword)) {
        setNotice('كلمة المرور الحالية غير صحيحة.');
        return;
      }

      const id = getSupervisorRecordId(current);
      const idKey = supervisorIdCandidates.find((candidate) => String(current[candidate] ?? '') === id) ?? 'id';
      const passwordKey = getSupervisorFieldKey(current, 'password');
      const { error: updateError } = await supabase
        .from('المشرفين')
        .update({ [passwordKey]: newPassword })
        .eq(idKey, id);
      if (updateError) throw updateError;

      setSupervisorPassword('');
      setSupervisorProfileForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setNotice('تم تغيير كلمة مرور المشرف بنجاح.');
      writeAuditLog({ action: 'supervisor_password_changed', userType: 'supervisor', username: supervisorUsername });
    } catch (error) {
      console.error('Supervisor profile update failed:', error);
      setNotice(`تعذر تحديث بيانات المشرف: ${getSupabaseErrorText(error)}`);
    } finally {
      setSupervisorProfileLoading(false);
    }
  };

  useEffect(() => {
    void refreshRecentSessions();
  }, []);

  useEffect(() => {
    const rememberedUsername = window.localStorage.getItem(rememberedSupervisorUsernameKey) ?? '';
    const rememberedPassword = window.localStorage.getItem(rememberedSupervisorPasswordKey) ?? '';
    if (rememberedUsername || rememberedPassword) {
      setSupervisorUsername(rememberedUsername);
      setSupervisorPassword(rememberedPassword);
    }
  }, []);

  useEffect(() => {
    if (supervisorLoggedIn && supervisorUsername) {
      void refreshSupervisorSessionFromDatabase(supervisorUsername);
    }
  }, [supervisorLoggedIn, supervisorUsername]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && supervisorLoggedIn && supervisorUsername) {
        void refreshSupervisorSessionFromDatabase(supervisorUsername);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [supervisorLoggedIn, supervisorUsername]);

  useEffect(() => {
    if (supervisorLoggedIn && selectedFeature === 'students') {
      void refreshStudentDirectory();
    }
  }, [supervisorLoggedIn, selectedFeature]);

  useEffect(() => {
    if (supervisorLoggedIn && selectedFeature === 'supervisors') {
      void refreshTeacherEvaluationSetting();
    }
  }, [supervisorLoggedIn, selectedFeature]);

  const handleSupervisorLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const username = supervisorUsername.trim();
    const password = supervisorPassword.trim();

    if (!username || !password) {
      setNotice('يرجى إدخال اسم المستخدم وكلمة المرور');
      return;
    }

    setLoading(true);
    try {
      const supervisor = await findSupervisorLogin(username, password);
      if (!supervisor || !('match' in supervisor) || supervisor.match !== true) {
        const failedReason = supervisor && 'reason' in supervisor ? supervisor.reason : 'username';

        if (failedReason === 'username' || failedReason === 'password') {
          setNotice('اسم المستخدم أو كلمة المرور غير صحيحة');
        } else if (failedReason === 'degree') {
          setNotice('لا توجد صلاحيات مفعلة لهذا الحساب');
        } else {
          setNotice('اسم المستخدم أو كلمة المرور غير صحيحة أو الدرجة غير مسموحة');
        }

        setLoading(false);
        return;
      }

      const row = supervisor.row as Record<string, unknown>;
      const features = getSupervisorFeatures(getSupervisorDegree(row));
      if (!features.length) {
        setNotice('تم التحقق من الحساب، لكن لا توجد وظائف متاحة لهذه الدرجة');
        return;
      }
      setSupervisorLoggedIn(true);
      setSupervisorFeatures(features);
      setSupervisorDegree(getSupervisorDegree(row));
      if (rememberSupervisorCredentials) {
        window.localStorage.setItem(rememberedSupervisorUsernameKey, username);
        window.localStorage.setItem(rememberedSupervisorPasswordKey, password);
      } else {
        window.localStorage.removeItem(rememberedSupervisorUsernameKey);
        window.localStorage.removeItem(rememberedSupervisorPasswordKey);
      }
      window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({
        username,
        degree: getSupervisorDegree(row),
        features,
        selectedFeature: null,
      } satisfies StoredSupervisorSession));
      writeAuditLog({
        action: 'supervisor_login',
        userType: 'supervisor',
        username,
        details: { degree: getSupervisorDegree(row), features },
      });
      setSelectedFeature(null);
      setNotice('تم تسجيل الدخول بأمان. اختر الوظيفة المطلوبة للمتابعة.');
    } catch (error) {
      const message = getSupabaseErrorText(error);
      console.error('Supervisor auth error:', message);
      setNotice(`حدث خطأ في تسجيل دخول المشرف: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => {
    const total = Object.keys(attendanceData).length;
    const present = Object.values(attendanceData).filter((item) => item.status === 'present').length;
    const absent = Object.values(attendanceData).filter((item) => item.status === 'absent').length;
    const pending = total - present - absent;

    return { total, present, absent, pending };
  }, [attendanceData]);

  const startSession = async () => {
    if (loading || sessionActive) return;
    if (!selectedCourse || !selectedClass) {
      setNotice('يرجى اختيار المادة والفئة أولاً');
      return;
    }

    setLoading(true);
    let openedSessionId: string | null = null;
    try {
      const currentSessions = await loadRecentAttendanceSessions();
      const created = await createAttendanceSession(selectedCourse, selectedClass, supervisorUsername);
      if (created.error || !created.session) {
        const message = getSupabaseErrorText(created.error);
        const lowerMessage = message.toLowerCase();
        setNotice(lowerMessage.includes('does not exist') || lowerMessage.includes('relation')
          ? 'يجب إنشاء جدول جلسات الحضور في Supabase أولاً لمنع فتح جلسات متزامنة.'
          : lowerMessage.includes('duplicate') || lowerMessage.includes('unique') || lowerMessage.includes('23505')
            ? 'لا يمكن فتح الجلسة: يوجد مشرف آخر يسجل الحضور للمادة والفئة نفسها حالياً.'
          : `تعذر فتح جلسة الحضور: ${message}`);
        return;
      }
      openedSessionId = created.session.id;

      let rows: StudentRow[];
      try {
        rows = await fetchStudentsByClass(selectedClass, selectedYear);
        writeCachedStudents(selectedClass, selectedYear, rows);
      } catch (error) {
        rows = readCachedStudents(selectedClass, selectedYear);
        if (!rows.length) throw error;
        setNotice('تعذر الاتصال مؤقتاً، تم تحميل آخر قائمة طلاب محفوظة محلياً.');
      }

      if (!rows.length) {
        await closeAttendanceSession(created.session.id);
        setActiveSession(null);
        setNotice('لا يوجد طلاب مسجلون في هذه الفئة والسنة المحددة');
        return;
      }

      const map = rows.reduce<Record<string, AttendanceEntry>>((acc, row) => {
        const studentId = getStudentIdentifier(row);
        if (!studentId) return acc;
        acc[studentId] = {
          id: studentId,
          name: normalizeText(row['اسم الطالب']),
          status: 'pending',
          timestamp: null,
          year: normalizeText(row['السنه الدراسية']),
        };
        return acc;
      }, {});

      setStudents(rows);
      setAttendanceData(map);
      setSessionActive(true);
      setActiveSession(created.session);
      setRecentSessions([created.session, ...currentSessions]);
      writeAuditLog({
        action: 'attendance_session_started',
        userType: 'supervisor',
        username: supervisorUsername,
        details: { course: selectedCourse, classValue: selectedClass, year: selectedYear, studentCount: rows.length },
      });
      setNotice(`تم بدء جلسة الحضور للفئة ${selectedClass} في مادة ${selectedCourse}`);
    } catch (error) {
      if (openedSessionId) await closeAttendanceSession(openedSessionId);
      const message = getSupabaseErrorText(error);
      console.error('Attendance fetch failed:', message);
      setNotice(`حدث خطأ أثناء جلب الطلاب من قاعدة البيانات: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const updateStudentStatus = async (student: StudentRow, status: AttendanceStatus, absenceReason?: AbsenceReason) => {
    const studentId = getStudentIdentifier(student);
    if (!studentId) return;

    const normalizedReason = status === 'absent' ? normalizeAbsenceReason(absenceReason) : '';

    const timestamp = new Date().toLocaleTimeString('ar-EG', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    setAttendanceData((prev) => ({
      ...prev,
      [studentId]: {
        id: studentId,
        name: getFullStudentName(student),
        status,
        timestamp,
        year: normalizeText(student['السنه الدراسية']),
        absenceReason: normalizedReason,
      },
    }));

    setNotice(`تم تسجيل حالة الطالب ${getFullStudentName(student)} ${status === 'absent' ? `على أنه غائب (${normalizedReason})` : 'بنجاح'}. اضغط حفظ الجلسة للمزامنة.`);
    writeAuditLog({
      action: 'attendance_status_selected',
      userType: 'supervisor',
      username: supervisorUsername,
      details: { studentId, studentName: getFullStudentName(student), status, absenceReason: normalizedReason || undefined, course: selectedCourse, classValue: selectedClass },
    });
  };

  const handleScannedStudentQr = (rawValue: string) => {
    const qrParts = rawValue.trim().split('|');
    const studentId = qrParts[0]?.toUpperCase() === 'UDTI' ? String(qrParts[2] ?? '').trim() : rawValue.trim();
    if (!studentId) {
      setNotice('رمز QR لا يحتوي على رقم جامعي صالح.');
      return;
    }

    const student = students.find((candidate) => getStudentIdentifier(candidate) === studentId);
    if (!student) {
      setNotice(`لم يتم العثور على الطالب صاحب الرقم ${studentId} ضمن طلاب هذه الجلسة.`);
      return;
    }

    if (scannedQrStudentIdsRef.current.has(studentId)) return;
    scannedQrStudentIdsRef.current.add(studentId);

    if (attendanceData[studentId]?.status === 'present') {
      setNotice(`الطالب ${getFullStudentName(student)} مسجل حاضر مسبقًا.`);
      return;
    }

    void updateStudentStatus(student, 'present');
    setScannedStudentName(getFullStudentName(student));
    setQrScanSuccess(true);
    if (qrScanSuccessTimerRef.current !== null) window.clearTimeout(qrScanSuccessTimerRef.current);
    qrScanSuccessTimerRef.current = window.setTimeout(() => {
      setQrScanSuccess(false);
      setScannedStudentName('');
      qrScanSuccessTimerRef.current = null;
    }, 2000);
  };
  qrScanHandlerRef.current = handleScannedStudentQr;

  useEffect(() => {
    if (!showQrScanner || !sessionActive) return;

    let cancelled = false;
    const videoElement = qrVideoRef.current;
    if (!videoElement) return;

    const reader = new BrowserMultiFormatReader();
    setQrScannerLoading(true);
    setQrScannerError('');

    void reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, videoElement, (result) => {
      if (!result || cancelled) return;
      qrScanHandlerRef.current(result.getText());
    }).then((controls) => {
      if (cancelled) {
        controls.stop();
        return;
      }
      qrScannerControlsRef.current = controls;
      setQrScannerLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setQrScannerLoading(false);
      setQrScannerError('تعذر تشغيل الكاميرا. اسمح للمتصفح باستخدام الكاميرا ثم أعد المحاولة.');
    });

    return () => {
      cancelled = true;
      qrScannerControlsRef.current?.stop();
      qrScannerControlsRef.current = null;
    };
  }, [showQrScanner, sessionActive]);

  useEffect(() => () => {
    if (qrScanSuccessTimerRef.current !== null) window.clearTimeout(qrScanSuccessTimerRef.current);
  }, []);

  const handleSendTelegramForStudent = async (student: StudentRow, messageText = 'تذكير بالحضور') => {
    const studentName = getFullStudentName(student);
    const studentYear = normalizeText(student['السنه الدراسية']);
    const studentClass = normalizeText(student['الفئة']) !== 'غير متوفر' ? normalizeText(student['الفئة']) : 'بدون فئة';
    const studentId = getStudentIdentifier(student) || 'غير محدد';
    const notificationEnabled = student.telegram_notifications_enabled ?? student['telegram_notifications_enabled'] ?? false;
    const isNotificationEnabled = typeof notificationEnabled === 'string'
      ? notificationEnabled.toLowerCase() === 'true' || notificationEnabled === '1' || notificationEnabled.toLowerCase() === 'yes'
      : Boolean(notificationEnabled);
    const chatId = String(student.telegram_chat_id ?? student['telegram_chat_id'] ?? '').trim();

    if (!isNotificationEnabled || !chatId) {
      setNotice(`تم إيقاف تنبيهات التليجرام لهذا الطالب (${studentName}) أو لا يوجد له Chat ID.`);
      return;
    }

    const message = buildStudentTelegramMessage({
      studentName,
      studentId,
      studentYear,
      studentClass,
      statusText: messageText,
      title: 'نظام الإدارة',
    });

    try {
      const result = await sendTelegramNotification(message, { chatId, enabled: isNotificationEnabled });
      if (result && result.ok !== false) {
        setNotice(`تم إرسال تنبيه الطالب ${studentName} إلى التليجرام بنجاح.`);
      } else if (result?.status === 'chat_not_found' || String(result?.description ?? '').toLowerCase().includes('chat not found')) {
        setNotice('يرجى التأكد من فتح بوت المعهد على التلجرام والضغط على Start أولاً');
      } else {
        setNotice(`فشل إرسال تنبيه الطالب ${studentName} إلى التليجرام.`);
      }
    } catch (error) {
      console.error('Telegram student notify failed:', error);
      setNotice(`تعذر إرسال تنبيه الطالب ${studentName} إلى التليجرام.`);
    }
  };

  const handleSendTelegramToAll = async () => {
    const recipients = students.filter((student) => {
      const enabled = student.telegram_notifications_enabled ?? student['telegram_notifications_enabled'] ?? false;
      const notificationEnabled = typeof enabled === 'string'
        ? ['true', '1', 'yes'].includes(enabled.trim().toLowerCase())
        : Boolean(enabled);
      const chatId = String(student.telegram_chat_id ?? student['telegram_chat_id'] ?? '').trim();
      return notificationEnabled && Boolean(chatId);
    });

    if (!recipients.length) {
      setNotice('لا يوجد طلاب في الجلسة فعّلوا تنبيهات تلجرام وربطوا حساباتهم.');
      return;
    }

    setIsSendingTelegramToAll(true);
    let sent = 0;
    let failed = 0;
    const statusText = `تنبيه حضور: جلسة مادة ${selectedCourse} للفئة ${selectedClass} قائمة الآن. يرجى التوجه إلى القاعة.`;

    try {
      for (const student of recipients) {
        const chatId = String(student.telegram_chat_id ?? student['telegram_chat_id'] ?? '').trim();
        const message = buildStudentTelegramMessage({
          studentName: getFullStudentName(student),
          studentId: getStudentIdentifier(student) || 'غير محدد',
          studentYear: String(student['السنه الدراسية'] ?? 'غير محددة'),
          studentClass: String(student['الفئة'] ?? 'غير محددة'),
          statusText,
          title: 'تنبيه الحضور',
        });
        try {
          const result = await sendTelegramNotification(message, { chatId, enabled: true });
          if (result && result.ok !== false) sent += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      setNotice(`اكتمل إرسال تنبيه تلجرام: تم إرساله إلى ${sent} طالب${failed ? `، وتعذر إرساله إلى ${failed}` : ''}.`);
    } finally {
      setIsSendingTelegramToAll(false);
    }
  };

  const handleSendStudentEmail = async (student: StudentRow, messageText = 'تذكير بالحضور') => {
    const studentName = getFullStudentName(student);
    const email = String(student['البريد الإلكتروني'] ?? '').trim();
    if (!email) {
      setNotice(`لا يوجد بريد إلكتروني مسجل للطالب ${studentName}.`);
      return;
    }

    try {
      const response = await fetch('/api/supervisor/student-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          studentName,
          studentId: getStudentIdentifier(student),
          studentYear: String(student['السنه الدراسية'] ?? 'غير محددة'),
          studentClass: String(student['الفئة'] ?? 'غير محددة'),
          message: messageText,
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      setNotice(result.success ? `تم إرسال البريد الإلكتروني للطالب ${studentName} بنجاح.` : `تعذر إرسال البريد الإلكتروني للطالب ${studentName}.`);
    } catch (error) {
      console.error('Student email notify failed:', error);
      setNotice(`تعذر إرسال البريد الإلكتروني للطالب ${studentName}.`);
    }
  };

  const openStudentMessageComposer = (student: StudentRow, channel: 'telegram' | 'email') => {
    setMessageComposer({ student, channel });
    setMessageComposerText('');
  };

  const sendComposedStudentMessage = async () => {
    if (!messageComposer || !messageComposerText.trim()) {
      setNotice('اكتب محتوى الرسالة أولاً.');
      return;
    }

    setMessageComposerSending(true);
    try {
      if (messageComposer.channel === 'telegram') {
        await handleSendTelegramForStudent(messageComposer.student, messageComposerText.trim());
      } else {
        await handleSendStudentEmail(messageComposer.student, messageComposerText.trim());
      }
      setMessageComposer(null);
      setMessageComposerText('');
    } finally {
      setMessageComposerSending(false);
    }
  };

  const resetSession = () => {
    const pendingStudents = students.filter((student) => {
      const studentId = getStudentIdentifier(student);
      return attendanceData[studentId]?.status !== 'present' && attendanceData[studentId]?.status !== 'absent';
    });

    if (pendingStudents.length > 0) {
      setNotice(`لا يمكن إغلاق الجلسة بعد. يجب تسجيل كل الطلاب أولاً: بقي ${pendingStudents.length} طالب بانتظار التسجيل.`);
      return;
    }

    if (activeSession) void closeAttendanceSession(activeSession.id);
    setAttendanceData({});
    setStudents([]);
    setSessionActive(false);
    setActiveSession(null);
    setNotice('تم إلغاء الجلسة بنجاح');
  };

  const saveSession = async () => {
    if (saveInProgressRef.current || loading) return;
    const pendingStudents = students.filter((student) => {
      const studentId = getStudentIdentifier(student);
      return attendanceData[studentId]?.status !== 'present' && attendanceData[studentId]?.status !== 'absent';
    });

    if (pendingStudents.length > 0) {
      setNotice(`لا يمكن إنهاء الجلسة بعد. يجب تسجيل كل الطلاب أولاً: بقي ${pendingStudents.length} طالب بانتظار التسجيل.`);
      return;
    }

    saveInProgressRef.current = true;
    const attendanceKeys = Object.keys(attendanceData);

    console.log('[attendance][saveSession] begin save', {
      studentsCount: students.length,
      attendanceKeys,
      selectedCourse,
      selectedClass,
      selectedYear,
      attendanceData,
    });

    if (!students.length || !attendanceKeys.length) {
      console.warn('[attendance][saveSession] attendance state is empty before save', {
        studentsCount: students.length,
        attendanceKeys,
        attendanceData,
      });
      setNotice('لا توجد بيانات للحضور لحفظها؛ حالة الحضور فارغة أو لا تحتوي على أرقام الطلاب');
      saveInProgressRef.current = false;
      return;
    }

    setLoading(true);
    try {
      const jobs: PendingAttendanceJob[] = [];

      for (const student of students) {
        const studentId = getStudentIdentifier(student);
        const entry = attendanceData[studentId];

        console.log('[attendance][saveSession] processing student', { studentId, student, entry, status: entry?.status });

        if (!entry) {
          console.warn('[attendance][saveSession] no attendance entry for student', { studentId, student });
          continue;
        }

        const status = entry.status;
        if (!status || !['pending', 'present', 'absent'].includes(status)) {
          console.warn('[attendance][saveSession] invalid attendance status for student', { studentId, status, entry });
          continue;
        }

        jobs.push({
          type: 'attendance',
          student,
          course: selectedCourse,
          classValue: selectedClass,
          status,
          absenceReason: entry.absenceReason || 'غياب مبرر',
          supervisor: supervisorUsername,
          queuedAt: new Date().toISOString(),
        });

        if (status === 'absent') {
          jobs.push({
            type: 'warning',
            student,
            course: selectedCourse,
            classValue: selectedClass,
            status: 'absent',
            absenceReason: entry.absenceReason || 'غياب مبرر',
            supervisor: supervisorUsername,
            queuedAt: new Date().toISOString(),
          });
        }
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        enqueueAttendanceJobs(jobs);
        setNotice(`لا يوجد اتصال حالياً. تم حفظ ${jobs.length} عملية محلياً وستتم مزامنتها تلقائياً عند عودة الإنترنت.`);
        return;
      }

      const results = await Promise.all(jobs.map(async (job) => ({
        job,
        saved: await savePendingAttendanceJob(job),
      })));
      const failedJobs = results.filter((result) => !result.saved).map((result) => result.job);
      if (failedJobs.length) enqueueAttendanceJobs(failedJobs);

      const savedRecords = results.filter((result) => result.saved && result.job.type === 'attendance').length;
      const savedWarnings = results.filter((result) => result.saved && result.job.type === 'warning').length;
      console.log('[attendance][saveSession] final save summary', { savedRecords, savedWarnings, failedJobs: failedJobs.length, attendanceKeys });
      setNotice(failedJobs.length
        ? `تم حفظ ${savedRecords} سجل و${savedWarnings} إنذار، وتعذر حفظ ${failedJobs.length} عملية. ستتم إعادة المحاولة تلقائياً.`
        : `تم حفظ البيانات بنجاح: ${savedRecords} سجل حضور و ${savedWarnings} إنذار`);
      if (!failedJobs.length) {
        if (activeSession) await closeAttendanceSession(activeSession.id);
        setActiveSession(null);
        setSessionActive(false);
        setStudents([]);
        setAttendanceData({});
        await refreshRecentSessions();
      }
      writeAuditLog({
        action: 'attendance_session_saved',
        userType: 'supervisor',
        username: supervisorUsername,
        details: { course: selectedCourse, classValue: selectedClass, savedRecords, savedWarnings, failedJobs: failedJobs.length },
      });
    } catch (error) {
      console.error('[attendance][saveSession] fatal save error:', error);
      setNotice('حدث خطأ أثناء حفظ بيانات الحضور');
    } finally {
      saveInProgressRef.current = false;
      setLoading(false);
    }
  };

  const currentCourseText = selectedCourse || 'غير محدد';
  const currentClassText = selectedClass || 'غير محدد';

  return (
    <main className="attendance-shell" dir="rtl">
      <div className="attendance-page">
        <div className="attendance-topbar">
          {supervisorLoggedIn ? (
            <button
              type="button"
              className="inline-flex items-center gap-2 px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg font-semibold transition-all cursor-pointer z-50"
              onClick={async () => {
                if (supervisorUsername) {
                  await refreshSupervisorSessionFromDatabase(supervisorUsername);
                }
                if (activeSession) void closeAttendanceSession(activeSession.id);
                setSelectedFeature(null);
                setSessionActive(false);
                setStudents([]);
                setAttendanceData({});
                setActiveSession(null);
                setNotice('تمت العودة إلى صفحة وظائف المشرفين.');
              }}
            >
              ← العودة للوحة التحكم
            </button>
          ) : (
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg font-semibold transition-all cursor-pointer z-50"
            >
              ← العودة للصفحة الرئيسية
            </Link>
          )}
          {supervisorLoggedIn && (
            <div
              className="supervisor-identity-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                background: '#f8fafc',
                border: '1px solid #cbd5e1',
                color: '#0f172a',
                borderRadius: 999,
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 700,
                margin: '0 8px',
              }}
            >
              <span>المشرف: {supervisorUsername || 'غير محدد'}</span>
              <span>•</span>
              <span>الدرجة: {getSupervisorDegreeLabel(supervisorDegree) || 'مشرف'}</span>
              <span>•</span>
              <span>اسم الدرجة: {getSupervisorDegreeLabel(supervisorDegree) || 'مشرف'}</span>
            </div>
          )}
          {supervisorLoggedIn && (
            <button
              type="button"
              className="back-link"
              onClick={() => {
                if (activeSession) void closeAttendanceSession(activeSession.id);
                writeAuditLog({ action: 'supervisor_logout', userType: 'supervisor', username: supervisorUsername });
                window.localStorage.removeItem(supervisorSessionStorageKey);
                setSupervisorLoggedIn(false);
                setSupervisorUsername('');
                setSupervisorPassword('');
                setSupervisorFeatures([]);
                setSupervisorDegree('');
                setSelectedFeature(null);
                setSelectedAdminStudentId('');
                setNotice('تم تسجيل خروج المشرف');
              }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              تسجيل خروج المشرف
            </button>
          )}
        </div>

        {messageComposer && (
          <div className="student-message-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="student-message-title">
            <section className="student-message-modal">
              <div className="student-message-modal-header">
                <div>
                  <span className="feature-panel-kicker">نظام الإدارة</span>
                  <h2 id="student-message-title">إرسال رسالة إلى {getFullStudentName(messageComposer.student)}</h2>
                </div>
                <button type="button" className="student-message-close" onClick={() => setMessageComposer(null)} aria-label="إغلاق">×</button>
              </div>
              <div className="student-message-meta">
                العنوان تلقائيًا: <strong>نظام الإدارة</strong> · وسيلة الإرسال: <strong>{messageComposer.channel === 'telegram' ? 'تلجرام' : 'البريد الإلكتروني'}</strong>
              </div>
              <textarea
                value={messageComposerText}
                onChange={(event) => setMessageComposerText(event.target.value)}
                placeholder="اكتب محتوى الرسالة هنا..."
                rows={6}
                autoFocus
              />
              <div className="student-message-modal-actions">
                <button type="button" className="action-button warning" onClick={() => setMessageComposer(null)}>إلغاء</button>
                <button type="button" className="action-button primary" onClick={() => void sendComposedStudentMessage()} disabled={messageComposerSending || !messageComposerText.trim()}>
                  {messageComposerSending ? 'جاري الإرسال...' : 'إرسال الرسالة'}
                </button>
              </div>
            </section>
          </div>
        )}

        {!supervisorLoggedIn && (
          <section className="panel">
            <div className="panel-header">
              <span>تسجيل دخول المشرف</span>
            </div>

            <form onSubmit={handleSupervisorLogin}>
              <div className="field-group">
                <label htmlFor="supervisor-user">اسم المستخدم</label>
                <input
                  id="supervisor-user"
                  type="text"
                  autoComplete="username"
                  value={supervisorUsername}
                  onChange={(event) => setSupervisorUsername(event.target.value)}
                  placeholder="أدخل اسم المستخدم"
                  required
                />
              </div>

              <div className="field-group">
                <label htmlFor="supervisor-password">كلمة المرور</label>
                <input
                  id="supervisor-password"
                  type="password"
                  autoComplete="current-password"
                  value={supervisorPassword}
                  onChange={(event) => setSupervisorPassword(event.target.value)}
                  placeholder="أدخل كلمة المرور"
                  required
                />
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 12px', color: '#64748b', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={rememberSupervisorCredentials}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setRememberSupervisorCredentials(checked);
                    if (!checked) {
                      window.localStorage.removeItem(rememberedSupervisorUsernameKey);
                      window.localStorage.removeItem(rememberedSupervisorPasswordKey);
                    }
                  }}
                  style={{ width: 14, height: 14, margin: 0 }}
                />
                تذكر اسم المستخدم وكلمة المرور
              </label>

              <button className="action-button primary" type="submit" disabled={loading}>
                {loading ? 'جاري التحقق...' : 'دخول المشرف'}
              </button>
            </form>

          </section>
        )}

        {notice && <div className="notice-box">{notice}</div>}

        {!supervisorLoggedIn && <div className="loading-box">يجب تسجيل دخول المشرف قبل استخدام نظام الحضور والغياب</div>}

        {supervisorLoggedIn && !selectedFeature && (
          <section className="supervisor-feature-panel">
            <div className="feature-panel-heading">
              <span className="feature-panel-kicker">مساحة المشرف</span>
              <h1>اختر الوظيفة المطلوبة</h1>
              <p>الوظائف الظاهرة هنا تعتمد على صلاحيات حسابك.</p>
            </div>

            <div className="supervisor-feature-grid">
              {supervisorFeatures.includes('attendance') && (
                <button
                  type="button"
                  className="supervisor-feature-card"
                  onClick={() => {
                    setSelectedFeature('attendance');
                    const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as StoredSupervisorSession;
                    window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({ ...stored, selectedFeature: 'attendance' }));
                    writeAuditLog({ action: 'feature_opened', userType: 'supervisor', username: supervisorUsername, details: { feature: 'attendance' } });
                    setNotice('تم فتح وظيفة تسجيل الحضور والغياب.');
                  }}
                >
                  <span className="feature-icon" aria-hidden="true">✓</span>
                  <span>
                    <strong>الحضور والغياب</strong>
                    <small>إدارة جلسات الحضور وتسجيل حالة الطلاب</small>
                  </span>
                  <span className="feature-arrow" aria-hidden="true">←</span>
                </button>
              )}
              {supervisorFeatures.includes('admin') && (
                <button
                  type="button"
                  className="supervisor-feature-card"
                  onClick={() => {
                    setSelectedFeature('admin');
                    const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as StoredSupervisorSession;
                    window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({ ...stored, selectedFeature: 'admin' }));
                    writeAuditLog({ action: 'feature_opened', userType: 'supervisor', username: supervisorUsername, details: { feature: 'admin' } });
                    void refreshAdminData();
                    setNotice('تم فتح لوحة الإدارة للدرجة الأولى.');
                  }}
                >
                  <span className="feature-icon" aria-hidden="true">⌘</span>
                  <span>
                    <strong>لوحة إدارة الحضور والإنذارات</strong>
                    <small>بحث وتصفية وتعديل سجلات الطلاب بالكامل</small>
                  </span>
                  <span className="feature-arrow" aria-hidden="true">←</span>
                </button>
              )}
              {supervisorFeatures.includes('create_student') && (
                <button type="button" className="supervisor-feature-card" onClick={() => {
                  setSelectedFeature('create_student');
                  const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as StoredSupervisorSession;
                  window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({ ...stored, selectedFeature: 'create_student' }));
                  writeAuditLog({ action: 'feature_opened', userType: 'supervisor', username: supervisorUsername, details: { feature: 'create_student' } });
                  setNotice('تم فتح إنشاء حساب طالب جديد.');
                }}>
                  <span className="feature-icon" aria-hidden="true">＋</span>
                  <span>
                    <strong>إنشاء حساب</strong>
                    <small>إنشاء حساب طالب جديد فقط للرتبة 2</small>
                  </span>
                  <span className="feature-arrow" aria-hidden="true">←</span>
                </button>
              )}
              {supervisorFeatures.includes('students') && (
                <button type="button" className="supervisor-feature-card" onClick={() => {
                  setSelectedFeature('students');
                  const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as StoredSupervisorSession;
                  window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({ ...stored, selectedFeature: 'students' }));
                  void refreshStudentDirectory();
                  writeAuditLog({ action: 'feature_opened', userType: 'supervisor', username: supervisorUsername, details: { feature: 'students' } });
                  setNotice('تم فتح قائمة الطلاب وتعديل بياناتهم.');
                }}>
                  <span className="feature-icon" aria-hidden="true">👥</span>
                  <span>
                    <strong>الطلاب</strong>
                    <small>البحث، التصفية، وتعديل بيانات جميع الطلاب</small>
                  </span>
                  <span className="feature-arrow" aria-hidden="true">←</span>
                </button>
              )}
              {supervisorFeatures.includes('supervisors') && (
                <button type="button" className="supervisor-feature-card" onClick={() => {
                  setSelectedFeature('supervisors');
                  const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as StoredSupervisorSession;
                  window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({ ...stored, selectedFeature: 'supervisors' }));
                  void refreshAdminData();
                  writeAuditLog({ action: 'feature_opened', userType: 'supervisor', username: supervisorUsername, details: { feature: 'supervisors' } });
                }}>
                  <span className="feature-icon" aria-hidden="true">+</span>
                  <span><strong>إدارة المشرفين</strong><small>إضافة وتعديل وحذف وترقية وخفض الحسابات</small></span>
                  <span className="feature-arrow" aria-hidden="true">←</span>
                </button>
              )}
              {supervisorFeatures.includes('logs') && (
                <button type="button" className="supervisor-feature-card" onClick={() => {
                  setSelectedFeature('logs');
                  const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as StoredSupervisorSession;
                  window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({ ...stored, selectedFeature: 'logs' }));
                  void refreshAuditLogs();
                  writeAuditLog({ action: 'feature_opened', userType: 'supervisor', username: supervisorUsername, details: { feature: 'logs' } });
                }}>
                  <span className="feature-icon" aria-hidden="true">≡</span>
                  <span><strong>سجلات النظام</strong><small>متابعة حركات الطلاب والمشرفين والعمليات</small></span>
                  <span className="feature-arrow" aria-hidden="true">←</span>
                </button>
              )}
              <button type="button" className="supervisor-feature-card" onClick={() => {
                setSelectedFeature('profile');
                setSupervisorProfileForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
                const stored = JSON.parse(window.localStorage.getItem(supervisorSessionStorageKey) || '{}') as StoredSupervisorSession;
                window.localStorage.setItem(supervisorSessionStorageKey, JSON.stringify({ ...stored, selectedFeature: 'profile' }));
                writeAuditLog({ action: 'feature_opened', userType: 'supervisor', username: supervisorUsername, details: { feature: 'profile' } });
              }}>
                <span className="feature-icon" aria-hidden="true">⚙</span>
                <span><strong>بيانات حسابي</strong><small>تغيير كلمة مرور المشرف وتحديث بيانات الدخول</small></span>
                <span className="feature-arrow" aria-hidden="true">←</span>
              </button>
            </div>
          </section>
        )}

        {supervisorLoggedIn && selectedFeature === 'profile' && (
          <section className="admin-dashboard-panel">
            <div className="admin-dashboard-heading">
              <div>
                <span className="feature-panel-kicker">بيانات الحساب</span>
                <h1>تعديل بيانات المشرف</h1>
                <p>المستخدم الحالي: {supervisorUsername}</p>
              </div>
            </div>
            <form className="supervisor-profile-form" onSubmit={handleSupervisorProfileSubmit}>
              <label htmlFor="supervisor-current-password">كلمة المرور الحالية</label>
              <input id="supervisor-current-password" type="password" value={supervisorProfileForm.currentPassword} onChange={(event) => setSupervisorProfileForm({ ...supervisorProfileForm, currentPassword: event.target.value })} autoComplete="current-password" required />
              <label htmlFor="supervisor-new-password">كلمة المرور الجديدة</label>
              <input id="supervisor-new-password" type="password" value={supervisorProfileForm.newPassword} onChange={(event) => setSupervisorProfileForm({ ...supervisorProfileForm, newPassword: event.target.value })} autoComplete="new-password" minLength={6} required />
              <label htmlFor="supervisor-confirm-password">تأكيد كلمة المرور الجديدة</label>
              <input id="supervisor-confirm-password" type="password" value={supervisorProfileForm.confirmPassword} onChange={(event) => setSupervisorProfileForm({ ...supervisorProfileForm, confirmPassword: event.target.value })} autoComplete="new-password" minLength={6} required />
              <button type="submit" className="action-button primary" disabled={supervisorProfileLoading}>
                {supervisorProfileLoading ? 'جاري الحفظ...' : 'حفظ كلمة المرور الجديدة'}
              </button>
            </form>
          </section>
        )}

        {supervisorLoggedIn && selectedFeature === 'admin' && (
          <section className="admin-dashboard-panel">
            <div className="admin-dashboard-heading">
              <div>
                <span className="feature-panel-kicker">صلاحيات الدرجة {supervisorDegree}</span>
                <h1>إدارة الحضور والإنذارات</h1>
                <p>ابحث عن أي طالب، راجع سجله الكامل، وعدّل حالة الحضور أو تفاصيل الغياب.</p>
              </div>
              <button type="button" className="action-button primary" onClick={() => void refreshAdminData()} disabled={adminLoading}>
                {adminLoading ? 'جاري التحديث...' : 'تحديث البيانات'}
              </button>
            </div>

            <div className="admin-filter-grid">
              <div className="field-group">
                <label htmlFor="admin-search">بحث بالاسم أو الرقم الجامعي</label>
                <input id="admin-search" value={adminSearch} onChange={(event) => setAdminSearch(event.target.value)} placeholder="اكتب اسم الطالب أو رقمه" />
              </div>
              <div className="field-group">
                <label htmlFor="admin-course">المادة</label>
                <select id="admin-course" value={adminCourseFilter} onChange={(event) => setAdminCourseFilter(event.target.value)}>
                  <option value="">كل المواد</option>
                  {Array.from(new Set([...adminAttendance, ...adminWarnings].map(getAdminRecordCourse).filter(Boolean))).map((course) => <option key={course} value={course}>{course}</option>)}
                </select>
              </div>
              <div className="field-group">
                <label htmlFor="admin-from">من تاريخ</label>
                <input id="admin-from" type="date" value={adminDateFrom} onChange={(event) => setAdminDateFrom(event.target.value)} />
              </div>
              <div className="field-group">
                <label htmlFor="admin-to">إلى تاريخ</label>
                <input id="admin-to" type="date" value={adminDateTo} onChange={(event) => setAdminDateTo(event.target.value)} />
              </div>
            </div>

            <div className="admin-view-tabs">
              {([
                ['all', 'الكل'],
                ['attendance', 'الحضور'],
                ['warnings', 'الإنذارات'],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" className={adminRecordType === value ? 'active' : ''} onClick={() => setAdminRecordType(value)}>{label}</button>
              ))}
            </div>

            <div className="admin-stats-row">
              <span>سجلات الحضور: <strong>{filteredAdminAttendance.length}</strong></span>
              <span>الإنذارات: <strong>{filteredAdminWarnings.length}</strong></span>
              <span>طلاب مطابقون: <strong>{adminStudentIds.length}</strong></span>
            </div>

            <div className="admin-supervisor-section">
              <div className="admin-section-heading">
                <h2>المشرفون وسجل الجلسات</h2>
                <span>لا تظهر كلمات المرور أو أي بيانات سرية</span>
              </div>
              <div className="admin-supervisor-list">
                {adminSupervisors.filter((supervisor) => getSupervisorDegree(supervisor) !== '1').map((supervisor, index) => {
                  const credentials = getSupervisorCredentials(supervisor);
                  const username = String(credentials.username || 'مشرف');
                  const degree = String(getSupervisorDegree(supervisor) || 'غير محدد');
                  return (
                  <div className="admin-supervisor-item" key={`${username}-${degree}-${index}`}>
                    <strong>{username}</strong>
                    <span>الدرجة {degree}</span>
                    <button type="button" onClick={() => void handleSupervisorWarning(username, degree)}>إعطاء إنذار</button>
                  </div>
                ); })}
                {adminSupervisors.filter((supervisor) => supervisor.degree !== '1').length === 0 && <span>لا توجد حسابات مشرفين أدنى مسجلة.</span>}
              </div>
              {adminSupervisorWarnings.length > 0 && (
                <div className="admin-record-list">
                  {adminSupervisorWarnings.slice(0, 20).map((warning, index) => <div className="admin-record-item warning-record" key={`${getAdminRecordId(warning)}-${index}`}><strong>{String(getAdminRecordValue(warning, ['اسم المستخدم', 'username']))}</strong><span>{String(getAdminRecordValue(warning, ['التفاصيل']))}</span><span>أنشأه: {String(getAdminRecordValue(warning, ['أنشأه', 'issuer']))}</span><span>{getAdminRecordDate(warning)} {String(getAdminRecordValue(warning, ['الوقت', 'time']))}</span></div>)}
                </div>
              )}
            </div>

            <div className="admin-student-picker">
              <label htmlFor="admin-student-details">عرض سجل طالب كامل</label>
              <select id="admin-student-details" value={selectedAdminStudentId} onChange={(event) => setSelectedAdminStudentId(event.target.value)}>
                <option value="">اختر طالبًا لعرض تفاصيل حضوره وإنذاراته</option>
                {adminStudentIds.map((studentId) => {
                  const source = [...filteredAdminAttendance, ...filteredAdminWarnings].find((record) => String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId'])) === studentId);
                  return <option key={studentId} value={studentId}>{getAdminStudentName(source ?? {})} - {studentId}</option>;
                })}
              </select>
            </div>

            {selectedAdminStudentId && (
              <div className="admin-student-detail">
                <h2>السجل الكامل للطالب {getAdminStudentName(selectedStudentAttendance[0] ?? selectedStudentWarnings[0] ?? {})} - {selectedAdminStudentId}</h2>
                <div className="admin-detail-columns">
                  <div>
                    <h3>الحضور والغياب</h3>
                    {selectedStudentAttendance.length === 0 ? <p>لا توجد سجلات حضور.</p> : selectedStudentAttendance.map((record, index) => (
                      <div className={`admin-record-item admin-record-selectable ${selectedAdminAttendanceKey === `${getAdminRecordId(record)}-${index}` ? 'selected' : ''}`} key={`${getAdminRecordId(record)}-${index}`} onClick={() => setSelectedAdminAttendanceKey(`${getAdminRecordId(record)}-${index}`)}>
                        <strong>{getAdminRecordCourse(record) || 'مادة غير محددة'}</strong>
                        <span>{getAdminRecordDate(record)} - {String(getAdminRecordValue(record, ['الوقت', 'time']) || '')}</span>
                        <span>{String(getAdminRecordValue(record, ['الحالة', 'status']) || 'غير محدد')}</span><span>المشرف: {getAdminRecordSupervisor(record)}</span><span>{String(getAdminRecordValue(record, ['الوقت', 'time']) || '')}</span>
                        <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedAdminAttendanceKey(`${getAdminRecordId(record)}-${index}`); }}>التعديلات</button>
                        {getAdminRecordValue(record, ['الحالة', 'status']) !== undefined && selectedAdminAttendanceKey === `${getAdminRecordId(record)}-${index}` && <div className="admin-record-actions"><button type="button" onClick={() => void handleAttendanceToWarning(record)}>تحويل لإنذار غياب</button><button type="button" className="danger" onClick={() => void handleDeleteAttendance(record)}>حذف الحضور</button></div>}
                      </div>
                    ))}
                  </div>
                  <div>
                    <h3>الإنذارات</h3>
                    {selectedStudentWarnings.length === 0 ? <p>لا توجد إنذارات.</p> : selectedStudentWarnings.map((warning, index) => (
                      <div className={`admin-record-item warning-record admin-record-selectable ${selectedAdminWarningKey === `${getAdminRecordId(warning)}-${index}` ? 'selected' : ''}`} key={`${getAdminRecordId(warning)}-${index}`} onClick={() => setSelectedAdminWarningKey(`${getAdminRecordId(warning)}-${index}`)}>
                        <strong>{getAdminRecordCourse(warning) || 'إنذار غياب'}</strong>
                        <span>{String(getAdminRecordValue(warning, ['السبب']) || '')}</span>
                        <span>{String(getAdminRecordValue(warning, ['التفاصيل']) || '')}</span><span>المشرف: {getAdminRecordSupervisor(warning)}</span><span>{String(getAdminRecordValue(warning, ['الوقت', 'time']) || '')}</span>
                        <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedAdminWarningKey(`${getAdminRecordId(warning)}-${index}`); }}>التعديلات</button>
                        {selectedAdminWarningKey === `${getAdminRecordId(warning)}-${index}` && <div className="admin-record-actions"><button type="button" onClick={() => void handleWarningDetails(warning, 'غياب مبرر')}>غياب مبرر</button><button type="button" onClick={() => void handleWarningDetails(warning, 'غياب غير مبرر')}>غير مبرر</button><button type="button" onClick={() => void handleWarningToAttendance(warning)}>تحويل لحضور</button><button type="button" className="danger" onClick={() => void handleDeleteWarning(warning)}>حذف</button></div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {(adminRecordType === 'all' || adminRecordType === 'attendance') && (
              <div className="admin-table-section"><h2>آخر سجلات الحضور</h2><div className="admin-record-list">{filteredAdminAttendance.slice(0, 50).map((record, index) => <div className="admin-record-item" key={`${getAdminRecordId(record)}-${index}`}><strong>{getAdminStudentName(record)}</strong><span>{String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId']))}</span><span>{getAdminRecordCourse(record)} - {getAdminRecordDate(record)}</span><span>المشرف: {getAdminRecordSupervisor(record)} - {String(getAdminRecordValue(record, ['الوقت', 'time']) || '')}</span><button type="button" onClick={() => setSelectedAdminStudentId(String(getAdminRecordValue(record, ['الرقم الجامعي', 'student_id', 'studentId'])))}>تفاصيل الطالب</button></div>)}</div></div>
            )}

            {(adminRecordType === 'all' || adminRecordType === 'warnings') && (
              <div className="admin-table-section"><h2>آخر الإنذارات</h2><div className="admin-record-list">{filteredAdminWarnings.slice(0, 50).map((warning, index) => <div className="admin-record-item warning-record" key={`${getAdminRecordId(warning)}-${index}`}><strong>{getAdminStudentName(warning)}</strong><span>{getAdminRecordCourse(warning)} - {getAdminRecordDate(warning)}</span><span>المشرف: {getAdminRecordSupervisor(warning)} - {String(getAdminRecordValue(warning, ['الوقت', 'time']) || '')}</span><button type="button" onClick={() => setSelectedAdminStudentId(String(getAdminRecordValue(warning, ['الرقم الجامعي', 'student_id', 'studentId'])))}>تفاصيل</button></div>)}</div></div>
            )}
          </section>
        )}

        {supervisorLoggedIn && selectedFeature === 'create_student' && (
          <section className="admin-dashboard-panel">
            <div className="admin-dashboard-heading">
              <div>
                <span className="feature-panel-kicker">إنشاء حساب</span>
                <h1>إنشاء حساب طالب</h1>
                <p>هذه الوظيفة مخصصة لمشرفي الدرجة 2 فقط لإنشاء حساب لطالب جديد.</p>
              </div>
              <button type="button" className="action-button primary" onClick={() => void refreshStudentDirectory()} disabled={adminLoading}>
                {adminLoading ? 'جاري التحديث...' : 'تحديث الطلاب'}
              </button>
            </div>

            <form className="admin-supervisor-form" onSubmit={(event) => {
              event.preventDefault();
              void createStudentAccount();
            }}>
              <input value={newStudentForm['الرقم الجامعي'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'الرقم الجامعي': event.target.value })} placeholder="الرقم الجامعي" required />
              <input value={newStudentForm['كلمة السر'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'كلمة السر': event.target.value })} placeholder="كلمة السر" type="text" />
              <input value={newStudentForm['اسم الطالب'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'اسم الطالب': event.target.value })} placeholder="اسم الطالب" required />
              <input value={newStudentForm['اسم الاب'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'اسم الاب': event.target.value })} placeholder="اسم الأب" required />
              <input value={newStudentForm['الكنية'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'الكنية': event.target.value })} placeholder="الكنية" required />
              <select value={newStudentForm['الفئة'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'الفئة': event.target.value })} required={supervisorDegree !== '2'}>
                <option value="">{supervisorDegree === '2' ? 'بدون فئة (اختياري)' : 'اختر الفئة'}</option>
                {allowedStudentClasses.map((className) => <option key={className} value={className}>{className}</option>)}
              </select>
              <select value={newStudentForm['السنه الدراسية'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'السنه الدراسية': event.target.value })} required>
                <option value="">اختر السنة</option>
                {allowedStudentYears.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
              <input value={newStudentForm['القسم'] ?? defaultStudentSection} readOnly />
              <input value={newStudentForm['رقم الهاتف'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'رقم الهاتف': event.target.value })} placeholder="رقم الهاتف" required />
              <input value={newStudentForm['البريد الإلكتروني'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'البريد الإلكتروني': event.target.value })} placeholder="البريد الإلكتروني" type="email" required />
              <input value={newStudentForm['نوع التسجيل'] ?? 'جديد'} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'نوع التسجيل': event.target.value })} placeholder="نوع التسجيل" />
              <textarea value={newStudentForm['ملاحظة'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'ملاحظة': event.target.value })} placeholder="ملاحظة" rows={3} />
              <div className="admin-record-actions">
                <button type="submit" className="action-button primary">حفظ الحساب</button>
                <button type="button" className="action-button warning" onClick={() => { setShowCreateStudentForm(false); setNewStudentForm({ ...newStudentForm, 'القسم': defaultStudentSection }); }}>إلغاء</button>
              </div>
            </form>
          </section>
        )}

        {supervisorLoggedIn && selectedFeature === 'students' && (
          <section className="student-management-panel">
            <div className="student-management-header">
              <div>
                <span className="feature-panel-kicker">إدارة الطلاب</span>
                <h1>قائمة الطلاب</h1>
                <p>بحث، فلترة، إنشاء حساب، وتعديل بيانات الطلاب من شاشة واحدة.</p>
              </div>
              <button type="button" className="action-button primary" onClick={() => void refreshStudentDirectory()} disabled={adminLoading}>
                {adminLoading ? 'جاري التحديث...' : 'تحديث الطلاب'}
              </button>
            </div>

            <div className="student-management-toolbar">
              <div className="field-group">
                <label htmlFor="student-directory-search">بحث</label>
                <input id="student-directory-search" value={studentDirectorySearch} onChange={(event) => setStudentDirectorySearch(event.target.value)} placeholder="اسم الطالب، الرقم، الفئة أو القسم" />
              </div>
              <div className="field-group">
                <label htmlFor="student-directory-class">الفئة</label>
                <select id="student-directory-class" value={studentClassFilter} onChange={(event) => setStudentClassFilter(event.target.value)}>
                  <option value="">الكل</option>
                  {studentClassOptions.map((className) => (
                    <option key={className} value={className}>{className === 'بدون فئة' ? 'بدون فئة' : `فئة ${className}`}</option>
                  ))}
                </select>
              </div>
              <div className="field-group">
                <label htmlFor="student-directory-year">السنة</label>
                <select id="student-directory-year" value={studentYearFilter} onChange={(event) => setStudentYearFilter(event.target.value)}>
                  <option value="">كل السنوات</option>
                  {Array.from(new Set(studentDirectory.map((student) => String(student['السنه الدراسية'] ?? '')).filter(Boolean))).map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </div>
              <div className="field-group">
                <label htmlFor="student-directory-section">القسم</label>
                <select id="student-directory-section" value={studentSectionFilter} onChange={(event) => setStudentSectionFilter(event.target.value)}>
                  <option value="">كل الأقسام</option>
                  {Array.from(new Set(studentDirectory.map((student) => String(student['القسم'] ?? '')).filter(Boolean))).map((section) => (
                    <option key={section} value={section}>{section}</option>
                  ))}
                </select>
              </div>
            </div>

            {['1', '2'].includes(supervisorDegree) && (
              <div className="student-management-actions">
                <button type="button" className="action-button primary" onClick={() => setShowCreateStudentForm((state) => !state)}>
                  {showCreateStudentForm ? 'إغلاق' : 'إنشاء حساب طالب'}
                </button>
              </div>
            )}

            {showCreateStudentForm && (
              <form className="student-form-grid" onSubmit={(event) => {
                event.preventDefault();
                void createStudentAccount();
              }}>
                <input value={newStudentForm['الرقم الجامعي'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'الرقم الجامعي': event.target.value })} placeholder="الرقم الجامعي" required />
                <input value={newStudentForm['كلمة السر'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'كلمة السر': event.target.value })} placeholder="كلمة السر" type="text" />
                <input value={newStudentForm['اسم الطالب'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'اسم الطالب': event.target.value })} placeholder="اسم الطالب" required />
                <input value={newStudentForm['اسم الاب'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'اسم الاب': event.target.value })} placeholder="اسم الأب" required />
                <input value={newStudentForm['الكنية'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'الكنية': event.target.value })} placeholder="الكنية" required />
                <select value={newStudentForm['الفئة'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'الفئة': event.target.value })} required={supervisorDegree !== '2'}>
                  <option value="">{supervisorDegree === '2' ? 'بدون فئة (اختياري)' : 'اختر الفئة'}</option>
                  {allowedStudentClasses.map((className) => <option key={className} value={className}>{className}</option>)}
                </select>
                <select value={newStudentForm['السنه الدراسية'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'السنه الدراسية': event.target.value })} required>
                  <option value="">اختر السنة</option>
                  {allowedStudentYears.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
                <input value={newStudentForm['القسم'] ?? defaultStudentSection} readOnly />
                <input value={newStudentForm['رقم الهاتف'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'رقم الهاتف': event.target.value })} placeholder="رقم الهاتف" required />
                <input value={newStudentForm['البريد الإلكتروني'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'البريد الإلكتروني': event.target.value })} placeholder="البريد الإلكتروني" type="email" required />
                <input value={newStudentForm['نوع التسجيل'] ?? 'جديد'} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'نوع التسجيل': event.target.value })} placeholder="نوع التسجيل" />
                <textarea value={newStudentForm['ملاحظة'] ?? ''} onChange={(event) => setNewStudentForm({ ...newStudentForm, 'ملاحظة': event.target.value })} placeholder="ملاحظة" rows={3} />
                <div className="student-form-actions">
                  <button type="submit" className="action-button primary">حفظ الحساب</button>
                  <button type="button" className="action-button warning" onClick={() => { setShowCreateStudentForm(false); setNewStudentForm({ ...newStudentForm, 'القسم': defaultStudentSection }); }}>إلغاء</button>
                </div>
              </form>
            )}

            <div className="student-management-summary">
              <span>عدد النتائج: {filteredStudentDirectory.length}</span>
              <span>عامل التصفية الحالي: {studentClassFilter || 'الكل'}</span>
            </div>

            <div className="student-management-grid">
              {filteredStudentDirectory.length === 0 ? (
                <div className="empty-state">لا توجد بيانات مطابقة للبحث أو الفلتر الحالي.</div>
              ) : filteredStudentDirectory.map((student) => {
                const id = String(student['الرقم الجامعي'] ?? student.id ?? '').trim();
                const name = getStudentDisplayName(student);
                const className = String(student['الفئة'] ?? '').trim() || 'بدون فئة';
                const email = String(student['البريد الإلكتروني'] ?? '').trim();
                const phone = String(student['رقم الهاتف'] ?? '').trim();
                const chatId = String(student.telegram_chat_id ?? student['telegram_chat_id'] ?? '').trim();
                const telegramEnabled = student.telegram_notifications_enabled === true
                  || ['true', '1', 'yes'].includes(String(student.telegram_notifications_enabled ?? student['telegram_notifications_enabled'] ?? '').toLowerCase());
                return (
                  <article className="student-management-card" key={`${id || name}-${className}`}>
                    <div className="student-management-card-header">
                      <div className="student-management-identity">
                        {student.avatar_url ? (
                          <img className="student-management-avatar" src={student.avatar_url} alt={`صورة ${name}`} loading="lazy" />
                        ) : (
                          <span className="student-management-avatar-placeholder" aria-label="لا توجد صورة شخصية">
                            <UserRound size={32} aria-hidden="true" />
                          </span>
                        )}
                        <strong>{name}</strong>
                      </div>
                      <span className="student-management-badge">{className}</span>
                    </div>
                    <div className="student-management-card-body">
                      <span>الرقم: {id || 'غير محدد'}</span>
                      <span>القسم: {String(student['القسم'] ?? 'غير محدد')}</span>
                      <span>السنة: {String(student['السنه الدراسية'] ?? 'غير محدد')}</span>
                      <span>الهاتف: {String(student['رقم الهاتف'] ?? 'غير محدد')}</span>
                    </div>
                    <div className="student-management-card-actions">
                      <button type="button" className="action-button primary" onClick={() => handleOpenStudentEditor(student)}>تعديل</button>
                      {telegramEnabled && chatId ? (
                        <button type="button" className="action-button" style={{ background: '#2563eb', color: '#fff' }} onClick={() => openStudentMessageComposer(student, 'telegram')}>إرسال تلجرام</button>
                      ) : email ? (
                        <button type="button" className="action-button" style={{ background: '#0f766e', color: '#fff' }} onClick={() => openStudentMessageComposer(student, 'email')}>إرسال بريد إلكتروني</button>
                      ) : phone ? (
                        <a className="action-button student-call-button" href={`tel:${phone.replace(/[^+\d]/g, '')}`}>اتصال بالطالب</a>
                      ) : (
                        <span className="student-no-contact">لا توجد وسيلة تواصل</span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            {editingStudentId && (
              <form className="student-form-grid student-edit-form" onSubmit={(event) => {
                event.preventDefault();
                void saveEditedStudent();
              }}>
                <input value={editingStudentDraft['اسم الطالب'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'اسم الطالب': event.target.value })} placeholder="اسم الطالب" required />
                <input value={editingStudentDraft['اسم الاب'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'اسم الاب': event.target.value })} placeholder="اسم الأب" required />
                <input value={editingStudentDraft['الكنية'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'الكنية': event.target.value })} placeholder="الكنية" required />
                <input value={editingStudentDraft['الرقم الجامعي'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'الرقم الجامعي': event.target.value })} placeholder="الرقم الجامعي" required />
                <input value={editingStudentDraft['كلمة السر'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'كلمة السر': event.target.value })} placeholder="كلمة السر" type="text" />
                <input value={editingStudentDraft['القسم'] ?? defaultStudentSection} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'القسم': event.target.value })} placeholder="القسم" readOnly />
                <select value={editingStudentDraft['الفئة'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'الفئة': event.target.value })}>
                  <option value="">بدون فئة</option>
                  {allowedStudentClasses.map((className) => <option key={className} value={className}>{className}</option>)}
                </select>
                <select value={editingStudentDraft['السنه الدراسية'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'السنه الدراسية': event.target.value })} required>
                  <option value="">اختر السنة</option>
                  {allowedStudentYears.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
                <input value={editingStudentDraft['رقم الهاتف'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'رقم الهاتف': event.target.value })} placeholder="رقم الهاتف" required />
                <input value={editingStudentDraft['البريد الإلكتروني'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'البريد الإلكتروني': event.target.value })} placeholder="البريد الإلكتروني" type="email" required />
                <input value={editingStudentDraft['نوع التسجيل'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'نوع التسجيل': event.target.value })} placeholder="نوع التسجيل" />
                <textarea value={editingStudentDraft['ملاحظة'] ?? ''} onChange={(event) => setEditingStudentDraft({ ...editingStudentDraft, 'ملاحظة': event.target.value })} placeholder="ملاحظة" rows={3} />
                <div className="student-form-actions">
                  <button type="submit" className="action-button primary">حفظ التعديل</button>
                  <button type="button" className="action-button warning" onClick={() => { setEditingStudentId(''); setEditingStudentDraft({}); }}>إلغاء</button>
                </div>
              </form>
            )}
          </section>
        )}

        {supervisorLoggedIn && selectedFeature === 'supervisors' && (
          <section className="admin-dashboard-panel">
            <div className="admin-dashboard-heading"><div><span className="feature-panel-kicker">إدارة الحسابات</span><h1>إدارة المشرفين</h1><p>يمكن للدرجة الأولى إنشاء الحسابات وتغيير الدرجات وكلمات المرور.</p></div><button type="button" className="action-button primary" onClick={() => void refreshAdminData()}>تحديث</button></div>
            <div className="teacher-evaluation-admin-setting">
              <div>
                <strong>تقييم المدرسين</strong>
                <p>{teacherEvaluationsTemporarilyDisabled ? 'الميزة متوقفة مؤقتًا حتى استقرار التقييمات.' : 'عند التفعيل، تظهر قائمة المدرسين ومقرراتهم في حساب الطالب ليقيّم الشرح.'}</p>
              </div>
              <button
                type="button"
                className={`action-button teacher-evaluation-toggle${teacherEvaluationEnabled ? ' is-enabled' : ''}`}
                aria-pressed={teacherEvaluationEnabled}
                onClick={() => void toggleTeacherEvaluation()}
                disabled={teacherEvaluationsTemporarilyDisabled || teacherEvaluationSettingsLoading || teacherEvaluationSettingsSaving}
              >
                {teacherEvaluationsTemporarilyDisabled ? 'متوقفة مؤقتًا' : teacherEvaluationSettingsLoading ? 'جارٍ تحميل الإعداد...' : teacherEvaluationSettingsSaving ? 'جارٍ الحفظ...' : teacherEvaluationEnabled ? 'إيقاف الميزة' : 'تفعيل الميزة'}
              </button>
              <button
                type="button"
                className="action-button"
                disabled={teacherEvaluationsTemporarilyDisabled}
                onClick={() => {
                  const nextVisibility = !showTeacherEvaluationReport;
                  setShowTeacherEvaluationReport(nextVisibility);
                  if (nextVisibility) void refreshTeacherEvaluationReport();
                }}
              >
                {teacherEvaluationsTemporarilyDisabled ? 'التقييمات موقوفة' : showTeacherEvaluationReport ? 'إخفاء التقييمات' : 'عرض التقييمات'}
              </button>
              {teacherEvaluationSettingsNotice && <span className="teacher-evaluation-admin-notice" role="status">{teacherEvaluationSettingsNotice}</span>}
            </div>
            {showTeacherEvaluationReport && !teacherEvaluationsTemporarilyDisabled && (
              <section className="teacher-evaluation-report" aria-label="تقييمات المدرسين">
                <div className="teacher-evaluation-report-heading">
                  <h2>تقييمات المدرسين والمواد</h2>
                  <button type="button" className="action-button" onClick={() => void refreshTeacherEvaluationReport()} disabled={teacherEvaluationReportLoading}>
                    {teacherEvaluationReportLoading ? 'جارٍ التحديث...' : 'تحديث النتائج'}
                  </button>
                </div>
                {teacherEvaluationReportError && <p className="teacher-evaluation-report-error" role="alert">{teacherEvaluationReportError}</p>}
                {teacherEvaluationReportLoading ? (
                  <div className="loading-box">جارٍ تحميل التقييمات...</div>
                ) : teacherEvaluationReportTeachers.length === 0 ? (
                  <div className="loading-box">لا يوجد مدرسون في الجدول.</div>
                ) : (
                  <div className="teacher-evaluation-report-list">
                    {teacherEvaluationReportTeachers.map((teacher) => {
                      const teacherId = String(teacher.id ?? '');
                      const teacherRows = teacherEvaluationReportRows.filter((row) => String(row.teacher_id ?? '') === teacherId);
                      const scoredRows = teacherRows.map((row) => Number(row.rating)).filter((rating) => rating > 0);
                      const average = scoredRows.length
                        ? (scoredRows.reduce((total, rating) => total + rating, 0) / scoredRows.length).toFixed(1)
                        : '—';
                      const subjects = Array.isArray(teacher.subjects) ? teacher.subjects.map(String).join('، ') : 'لا توجد مقررات';

                      return (
                        <article className="teacher-evaluation-report-card" key={teacherId}>
                          <header>
                            <div>
                              <h3>{String(teacher.teacher_name ?? 'مدرس')}</h3>
                              <p>المقررات: {subjects}</p>
                            </div>
                            <div className="teacher-evaluation-report-summary">
                              <span>عدد التقييمات: {teacherRows.length}</span>
                              <span>المعدل (باستثناء لا أعلم): {average}</span>
                            </div>
                          </header>
                          {teacherRows.length === 0 ? (
                            <p className="teacher-evaluation-report-empty">لم يقيّم الطلاب هذا المدرس بعد.</p>
                          ) : (
                            <div className="teacher-evaluation-report-entries">
                              {teacherRows.map((row) => {
                                const rating = Number(row.rating);
                                const ratingLabel = ['لا أعلم', 'سيئ', 'مقبول', 'جيد', 'رائع'][rating] ?? 'غير معروف';
                                return (
                                  <div className="teacher-evaluation-report-entry" key={String(row.id)}>
                                    <strong>{String(row.student_name ?? 'اسم غير مسجل')}</strong>
                                    <span>الرقم الجامعي: {String(row.student_id ?? 'غير متوفر')}</span>
                                    <span>المقرر: {String(row.subject ?? 'غير محدد')}</span>
                                    <span>التقييم: {ratingLabel}</span>
                                    <p>الملاحظة: {String(row.note ?? '').trim() || 'لا توجد ملاحظة'}</p>
                                    <time>{String(row.updated_at ?? '')}</time>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
            <form className="admin-supervisor-form" onSubmit={handleSupervisorFormSubmit}>
              <input value={supervisorForm.username} onChange={(event) => setSupervisorForm({ ...supervisorForm, username: event.target.value })} placeholder="اسم المستخدم" required />
              <input value={supervisorForm.password} onChange={(event) => setSupervisorForm({ ...supervisorForm, password: event.target.value })} placeholder={editingSupervisorId ? 'كلمة مرور جديدة (اختياري)' : 'كلمة المرور'} type="password" required={!editingSupervisorId} />
              <select value={supervisorForm.degree} onChange={(event) => setSupervisorForm({ ...supervisorForm, degree: event.target.value })}><option value="1">الدرجة 1</option><option value="2">الدرجة 2</option><option value="3">الدرجة 3</option></select>
              <button type="submit" className="action-button primary">{editingSupervisorId ? 'حفظ التعديل' : 'إضافة مشرف'}</button>
              {editingSupervisorId && <button type="button" className="action-button warning" onClick={() => { setEditingSupervisorId(''); setSupervisorForm({ username: '', password: '', degree: '3' }); }}>إلغاء</button>}
            </form>
            <div className="admin-record-list">
              {supervisorRecords.map((row, index) => { const credentials = getSupervisorCredentials(row); const id = getSupervisorRecordId(row); const username = String(credentials.username || 'مشرف'); const degree = String(getSupervisorDegree(row) || 'غير محدد'); return <div className="admin-supervisor-item" key={`${id || username}-${index}`}><strong>{username}</strong><span>الدرجة {degree}</span><button type="button" onClick={() => { setEditingSupervisorId(id); setSupervisorForm({ username, password: '', degree: degree === 'غير محدد' ? '3' : degree }); }}>تعديل</button><button type="button" onClick={() => void handleSupervisorDelete(row)}>حذف</button></div>; })}
            </div>
          </section>
        )}

        {supervisorLoggedIn && selectedFeature === 'logs' && (
          <section className="admin-dashboard-panel">
            <div className="admin-dashboard-heading"><div><span className="feature-panel-kicker">المتابعة والتدقيق</span><h1>سجلات الطلاب والمشرفين</h1><p>كل عملية مسجلة مع المستخدم والجهاز والتاريخ والوقت.</p></div><button type="button" className="action-button primary" onClick={() => void refreshAuditLogs()}>تحديث السجلات</button></div>
            <div className="admin-record-list">{auditLogs.map((log, index) => <div className="admin-record-item" key={`${getAdminRecordValue(log, ['log_id'])}-${index}`}><strong>{String(getAdminRecordValue(log, ['action']) || 'عملية')}</strong><span>المستخدم: {String(getAdminRecordValue(log, ['username']) || 'غير محدد')}</span><span>النوع: {String(getAdminRecordValue(log, ['user_type']) || '')}</span><span>{String(getAdminRecordValue(log, ['created_at']) || '')}</span><span>الجهاز: {String(getAdminRecordValue(log, ['device_type']) || '')} / {String(getAdminRecordValue(log, ['platform']) || '')}</span><span>المسار: {String(getAdminRecordValue(log, ['path']) || '')}</span></div>)}</div>
            {auditLogs.length === 0 && <div className="loading-box">لا توجد سجلات أو لم يتم إنشاء جدول سجلات النظام بعد.</div>}
          </section>
        )}

        {supervisorLoggedIn && selectedFeature === 'attendance' && (
          <>
            <header className="attendance-header">
          <div className="attendance-header-inner">
            <img
              src="/institute-logo.png"
              alt="شعار المعهد"
              className="attendance-logo"
            />
            <div>
              <h1>المعهد التقاني لطب الأسنان</h1>
              <p>جامعة اللاذقية - نظام الحضور والغياب الإلكتروني</p>
            </div>
          </div>
        </header>

        <div className="attendance-title">نظام الحضور والغياب الإلكتروني</div>

        {supervisorLoggedIn && selectedFeature === 'attendance' && !sessionActive && (
          <section className="panel">
            <div className="panel-header">
              <span>إعدادات الجلسة</span>
            </div>

            <div className="field-group">
              <label htmlFor="course-select">اختر المادة</label>
              <select id="course-select" value={selectedCourse} onChange={(e) => setSelectedCourse(e.target.value)}>
                <option value="">-- اختر المادة --</option>
                {courseOptions.map((course) => (
                  <option value={course} key={course}>{course}</option>
                ))}
              </select>
            </div>

            <div className="field-group">
              <label htmlFor="year-select">السنة الدراسية</label>
              <select id="year-select" value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)}>
                {yearOptions.map((year) => (
                  <option value={year} key={year}>سنة {year}</option>
                ))}
              </select>
            </div>

            <div className="field-group">
              <label htmlFor="class-select">اختر الفئة</label>
              <select id="class-select" value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                <option value="">-- اختر الفئة --</option>
                {classOptions.map((className) => (
                  <option value={className} key={className}>فئة {className}</option>
                ))}
              </select>
            </div>

            <button className="action-button primary" type="button" onClick={startSession} disabled={loading}>
              {loading ? 'جاري تحميل البيانات...' : 'بدء جلسة الحضور'}
            </button>

            <div className="session-info" style={{ marginTop: 20 }}>
              <strong>الجلسات خلال آخر ساعة</strong>
              {recentSessions.length === 0 ? (
                <div style={{ marginTop: 8 }}>لا توجد جلسات مسجلة خلال آخر ساعة.</div>
              ) : (
                <div style={{ marginTop: 8 }}>
                  {recentSessions.map((session) => (
                    <div key={session.id} style={{ marginTop: 6 }}>
                      {session.course} - الفئة {session.classValue} - {session.supervisor} - {new Date(session.startedAt).toLocaleTimeString('ar-EG')}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {supervisorLoggedIn && loading && <div className="loading-box">جاري تحميل البيانات...</div>}

        {supervisorLoggedIn && sessionActive && (
          <section className="panel">
            <div className="panel-header attendance-scanner-header">
              <span>جلسة الحضور النشطة</span>
              <button
                type="button"
                className="action-button primary attendance-qr-scan-button"
                onClick={() => { scannedQrStudentIdsRef.current.clear(); setQrScannerError(''); setShowQrScanner(true); }}
              >
                <ScanLine size={17} aria-hidden="true" />
                <span>مسح QR للطالب</span>
              </button>
              <button
                type="button"
                className="action-button attendance-telegram-all-button"
                onClick={() => void handleSendTelegramToAll()}
                disabled={isSendingTelegramToAll || !students.some((student) => {
                  const enabled = student.telegram_notifications_enabled ?? student['telegram_notifications_enabled'] ?? false;
                  const isEnabled = typeof enabled === 'string'
                    ? ['true', '1', 'yes'].includes(enabled.trim().toLowerCase())
                    : Boolean(enabled);
                  return isEnabled && Boolean(String(student.telegram_chat_id ?? student['telegram_chat_id'] ?? '').trim());
                })}
              >
                {isSendingTelegramToAll ? 'جارٍ الإرسال للكل...' : 'إرسال تلجرام للكل'}
              </button>
            </div>

            <div className="session-info">
              جلسة الحضور النشطة: <strong>{currentCourseText}</strong> - الفئة <strong>{currentClassText}</strong>
            </div>

            <div className="stats-grid">
              <div className="stat-box">
                <div className="stat-value">{stats.total}</div>
                <div className="stat-label">إجمالي الطلاب</div>
              </div>
              <div className="stat-box">
                <div className="stat-value">{stats.present}</div>
                <div className="stat-label">الحاضرين</div>
              </div>
              <div className="stat-box">
                <div className="stat-value">{stats.absent}</div>
                <div className="stat-label">الغائبين</div>
              </div>
              <div className="stat-box">
                <div className="stat-value">{stats.pending}</div>
                <div className="stat-label">بانتظار التسجيل</div>
              </div>
            </div>

            {showQrScanner && (
              <div className="attendance-qr-scanner-backdrop">
                <section className="attendance-qr-scanner-dialog" role="dialog" aria-modal="true" aria-labelledby="attendance-qr-scanner-title">
                  <div className="attendance-qr-scanner-heading">
                    <div>
                      <h2 id="attendance-qr-scanner-title">مسح باركود الطالب</h2>
                      <p>وجّه كاميرا الجهاز نحو رمز QR الخاص بالطالب.</p>
                    </div>
                    <button
                      type="button"
                      className="attendance-qr-scanner-close"
                      onClick={() => setShowQrScanner(false)}
                      aria-label="إغلاق ماسح QR"
                    >
                      إغلاق
                    </button>
                  </div>
                  <div className={`attendance-qr-scan-success${qrScanSuccess ? ' is-visible' : ''}`} role="status" aria-live="polite">
                    <CheckCircle2 size={19} aria-hidden="true" />
                    <span>تم تسجيل حضور {scannedStudentName}</span>
                  </div>
                  <video ref={qrVideoRef} className={`attendance-qr-scanner-video${qrScanSuccess ? ' is-success' : ''}`} muted playsInline />
                  {qrScannerLoading && <p className="attendance-qr-scanner-status">جارٍ تشغيل الكاميرا...</p>}
                  {qrScannerError && (
                    <div className="attendance-qr-scanner-error" role="alert">
                      <span>{qrScannerError}</span>
                      <button type="button" className="action-button primary" onClick={() => { setQrScannerError(''); setShowQrScanner(false); window.setTimeout(() => setShowQrScanner(true), 0); }}>
                        إعادة المحاولة
                      </button>
                    </div>
                  )}
                </section>
              </div>
            )}

            <div className="student-grid">
              {students.map((student) => {
                const studentId = getStudentIdentifier(student);
                const entry = attendanceData[studentId];
                const status = entry?.status ?? 'pending';

                return (
                  <div key={studentId || getFullStudentName(student)} className={`student-card ${status}`}>
                    <div className="student-card-top">
                      <div className="student-name">{getFullStudentName(student)}</div>
                      <div className="student-id">{studentId || 'بدون رقم'}</div>
                    </div>

                    <div className="student-meta">السنة: {student['السنه الدراسية'] ?? 'غير محدد'}</div>

                    <div className="student-actions">
                      <button type="button" className="mini-btn success" onClick={() => updateStudentStatus(student, 'present')}>
                        حاضر
                      </button>
                      <button type="button" className="mini-btn danger" onClick={() => updateStudentStatus(student, 'absent', 'غياب غير مبرر')}>
                        غياب
                      </button>
                    </div>

                    <div className={`status-pill ${status}`}>
                      {status === 'present' ? 'حاضر' : status === 'absent' ? 'غائب' : 'بانتظار'}
                    </div>

                    {entry?.timestamp && <div className="timestamp">تم التسجيل: {entry.timestamp}</div>}
                  </div>
                );
              })}
            </div>

            <div className="session-actions">
              <button
                type="button"
                className="action-button warning"
                onClick={resetSession}
                disabled={students.some((student) => {
                  const studentId = getStudentIdentifier(student);
                  return attendanceData[studentId]?.status !== 'present' && attendanceData[studentId]?.status !== 'absent';
                })}
              >
                إعادة تعيين
              </button>
              <button
                type="button"
                className="action-button primary"
                onClick={saveSession}
                disabled={loading || saveInProgressRef.current || students.some((student) => {
                  const studentId = getStudentIdentifier(student);
                  return attendanceData[studentId]?.status !== 'present' && attendanceData[studentId]?.status !== 'absent';
                })}
              >
                {loading ? 'جاري الحفظ...' : 'إنهاء الجلسة وحفظ البيانات'}
              </button>
            </div>
          </section>
        )}
          </>
        )}
      </div>
    </main>
  );
}
