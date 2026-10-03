'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Code2, Download, Pencil, Settings, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { writeAuditLog } from '../lib/auditLog';
import { teacherEvaluationsTemporarilyDisabled } from '../lib/featureFlags';
import {
  getStudentById,
  getTeacherAlertsForStudent,
  getWarningsForStudent,
  getRecordValue,
  normalizeStudentYear,
  normalizeText,
  StudentRow,
} from '../lib/studentData';

type TabKey = 'grades' | 'record' | 'status' | 'schedule' | 'skills' | 'evaluations';

type StudentSkill = {
  category: string;
  detail: string;
};

type TeacherEntry = {
  id: string;
  name: string;
  subjects: string[];
};

type TeacherRating = 0 | 1 | 2 | 3 | 4;

type ScheduleItem = {
  id: string | number;
  day: string;
  start_time: string;
  end_time: string;
  subject: string;
  type: string;
  location: string;
  group_name: string | null;
};

type GradeEntry = {
  subject: string;
  annual: number | null;
  theory: number | null;
  practical: number | null;
  total: number | null;
  assistance: string;
};

const studentSessionStorageKey = 'udti-student-session';
const rememberedStudentIdStorageKey = 'udti-remembered-student-id';
const rememberedStudentPasswordStorageKey = 'udti-remembered-student-password';

const metadataKeys = new Set([
  'id',
  'الرقم الجامعي',
  'كلمة السر',
  'اسم الطالب',
  'اسم الاب',
  'الكنية',
  'القسم',
  'رقم الهاتف',
  'نوع التسجيل',
  'ملاحظة',
  'البريد الإلكتروني',
  'الفئة',
  'تاريخ_تغيير_الفئة',
  'تاريخ الإنشاء',
  'السنه الدراسية',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
]);

const formatStudentValue = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === '') return 'غير متوفر';
  return String(value);
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'غير متوفر';

  try {
    return new Date(value).toLocaleDateString('ar-EG', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return String(value);
  }
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '').replace(/[^0-9.-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const getValueByKeys = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
};

const extractGrades = (rows: Record<string, unknown>[]): GradeEntry[] => {
  if (!rows.length) return [];

  const first = rows[0];
  const gradeRows: GradeEntry[] = [];

  Object.entries(first).forEach(([key, value]) => {
    if (metadataKeys.has(key)) return;
    if (value === null || value === undefined || value === '') return;

    const parsed = toNumber(value);
    if (parsed === null) return;

    gradeRows.push({
      subject: key,
      annual: parsed,
      theory: null,
      practical: null,
      total: parsed,
      assistance: parsed >= 50 ? 'مقبول' : 'غير مقبول',
    });
  });

  if (gradeRows.length) return gradeRows;

  return rows.flatMap((row) => {
    return Object.entries(row)
      .filter(([key, value]) => !metadataKeys.has(key) && value !== null && value !== undefined && value !== '')
      .map(([subject, value]) => {
        const numeric = toNumber(value);
        return {
          subject,
          annual: numeric,
          theory: null,
          practical: null,
          total: numeric,
          assistance: numeric !== null && numeric >= 50 ? 'مقبول' : 'غير مقبول',
        };
      });
  });
};

const getTableRows = async (tableNames: string[], select = '*') => {
  for (const tableName of tableNames) {
    const { data, error } = await supabase.from(tableName).select(select).limit(1);
    if (!error) return { data: data ?? [], tableName };
    const message = String(error.message || '');
    if (message.includes('does not exist') || message.includes('not found') || message.includes('relation')) {
      continue;
    }
    return { data: data ?? [], tableName, error };
  }

  return { data: [], tableName: tableNames[0], error: null };
};

const scheduleDays = ['الأحد', 'الأثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const skillCategories = ['مونتاج', 'رياضة', 'تصوير', 'تصميم جرافيكي', 'برمجة', 'رسم', 'كتابة', 'لغات', 'موسيقى', 'تطوع', 'أخرى'];
const sportTypes = ['كرة القدم', 'كرة السلة', 'كرة الطائرة', 'السباحة', 'الجري', 'رياضة أخرى'];
const teacherRatingOptions: Array<{ value: TeacherRating; label: string }> = [
  { value: 4, label: 'رائع' },
  { value: 3, label: 'جيد' },
  { value: 2, label: 'مقبول' },
  { value: 1, label: 'سيئ' },
  { value: 0, label: 'لا أعلم' },
];

const formatScheduleTime = (value: unknown) => String(value ?? '').slice(0, 5);

const getStudentGroup = (student: Record<string, unknown> | null | undefined) => String(
  student?.['الفئة'] ?? student?.group ?? student?.group_name ?? ''
).trim().replace(/^فئة\s*/i, '');

/* ============================================================
   Click Sound + Press Feedback Utilities
   ============================================================ */

const createClickSound = () => {
  if (typeof window === 'undefined') return null;
  try {
    const AudioContextCtor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;
    const ctx = new AudioContextCtor();

    return () => {
      try {
        if (ctx.state === 'suspended') void ctx.resume();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.06);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.13, now + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.1);
      } catch {
        /* ignore */
      }
    };
  } catch {
    return null;
  }
};

let playClickSound: (() => void) | null = null;

const initClickSound = () => {
  if (playClickSound) return;
  playClickSound = createClickSound();
};

export default function Home() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('record');
  const [notice, setNotice] = useState('يرجى تسجيل الدخول لعرض نتائجك');
  const [loginData, setLoginData] = useState({ studentId: '', password: '' });
  const [rememberStudentId, setRememberStudentId] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [loggedStudent, setLoggedStudent] = useState<StudentRow | null>(null);
  const [grades, setGrades] = useState<GradeEntry[]>([]);
  const [warnings, setWarnings] = useState<Record<string, unknown>[]>([]);
  const [teacherAlertLoadError, setTeacherAlertLoadError] = useState('');
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>([]);
  const [studentSkills, setStudentSkills] = useState<StudentSkill[]>([]);
  const [skillDrafts, setSkillDrafts] = useState<StudentSkill[]>([]);
  const [isEditingSkills, setIsEditingSkills] = useState(false);
  const [isSavingSkills, setIsSavingSkills] = useState(false);
  const [skillsMessage, setSkillsMessage] = useState('');
  const [showProfileCompletion, setShowProfileCompletion] = useState(true);
  const [teacherEvaluationLoading, setTeacherEvaluationLoading] = useState(false);
  const [teacherEvaluationReady, setTeacherEvaluationReady] = useState(false);
  const [teacherEvaluationRequired, setTeacherEvaluationRequired] = useState(false);
  const [teacherEvaluationError, setTeacherEvaluationError] = useState('');
  const [teachers, setTeachers] = useState<TeacherEntry[]>([]);
  const [teacherRatingDrafts, setTeacherRatingDrafts] = useState<Record<string, TeacherRating>>({});
  const [teacherRatingNotes, setTeacherRatingNotes] = useState<Record<string, string>>({});
  const [savedTeacherRatings, setSavedTeacherRatings] = useState<Record<string, TeacherRating>>({});
  const [savedTeacherNotes, setSavedTeacherNotes] = useState<Record<string, string>>({});
  const [savingTeacherRatingKey, setSavingTeacherRatingKey] = useState<string | null>(null);
  const [teacherRatingNotice, setTeacherRatingNotice] = useState('');
  const studentDashboardRef = useRef<HTMLDivElement>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [avatarNotice, setAvatarNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ email: '', phone: '', password: '' });
  const [accountModalNotice, setAccountModalNotice] = useState('');
  const [isSavingAccount, setIsSavingAccount] = useState(false);
  const [isExportingQr, setIsExportingQr] = useState(false);
  const [qrExportError, setQrExportError] = useState('');
  const [studentStatus, setStudentStatus] = useState<string>('غير متوفر');
  const [classOptions, setClassOptions] = useState<Array<{ name: string; capacity: number | null; occupied: number; available: number | null }>>([]);
  const [selectedClassForUpdate, setSelectedClassForUpdate] = useState('');
  const [isChangingClass, setIsChangingClass] = useState(false);
  const [newStudentId, setNewStudentId] = useState('');
  const [studentIdChangeConfirmed, setStudentIdChangeConfirmed] = useState(false);
  const [isChangingStudentId, setIsChangingStudentId] = useState(false);
  const [studentIdChangeCompleted, setStudentIdChangeCompleted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [telegramNotificationsEnabled, setTelegramNotificationsEnabled] = useState(false);
  const [showTelegramSettingsModal, setShowTelegramSettingsModal] = useState(false);
  const [telegramChatIdInput, setTelegramChatIdInput] = useState('');
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [resetMethods, setResetMethods] = useState<Array<'telegram' | 'email'>>([]);
  const [resetMethod, setResetMethod] = useState<'telegram' | 'email'>('email');
  const [resetDestination, setResetDestination] = useState('');
  const [resetCodeSent, setResetCodeSent] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const hasStudentGroup = Boolean(getStudentGroup(loggedStudent as Record<string, unknown> | null));
  const getStudentNamePart = (keys: string[]) => keys
    .map((key) => String((loggedStudent as Record<string, unknown> | null)?.[key] ?? '').trim())
    .find((part) => part && part !== '.' && part !== 'غير متوفر') ?? '';
  const studentFullName = [
    getStudentNamePart(['اسم الطالب', 'name', 'student_name']),
    getStudentNamePart(['اسم الاب', 'اسم الأب', 'father_name']),
    getStudentNamePart(['الكنية', 'family_name', 'surname']),
  ].filter(Boolean).join(' ') || 'اسم الطالب';
  const studentQrId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
  const studentQrData = `UDTI|${studentFullName}|${studentQrId}`;
  const studentQrHighResolutionUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&data=${encodeURIComponent(studentQrData)}`;
  const teacherEvaluationGateOpen = isLoggedIn && (!teacherEvaluationReady || teacherEvaluationRequired);

  useEffect(() => {
    const dashboard = studentDashboardRef.current;
    if (!dashboard) return;
    if (teacherEvaluationGateOpen) dashboard.setAttribute('inert', '');
    else dashboard.removeAttribute('inert');
  }, [teacherEvaluationGateOpen]);
  const profileChecklist = [
    { label: 'الصورة الشخصية', weight: 30, complete: Boolean(loggedStudent?.avatar_url) },
    { label: 'إضافة مهارة', weight: 30, complete: studentSkills.length > 0 },
    { label: 'تغيير الرقم الجامعي', weight: 30, complete: studentIdChangeCompleted },
    { label: 'إشعارات تيليجرام', weight: 10, complete: telegramNotificationsEnabled },
  ];
  const profileCompletion = profileChecklist.reduce(
    (total, task) => total + (task.complete ? task.weight : 0),
    0
  );
  const missingProfileTasks = profileChecklist.filter((task) => !task.complete).map((task) => task.label);
  const getTeacherRatingKey = (teacherId: string, subject: string) => `${teacherId}::${subject}`;
  const teacherEvaluationTasks = teachers.flatMap((teacher) => teacher.subjects.map((subject) => ({
    teacher,
    subject,
    key: getTeacherRatingKey(teacher.id, subject),
  })));
  const pendingTeacherEvaluationCount = teacherEvaluationTasks.filter((task) => savedTeacherRatings[task.key] === undefined).length;

  useEffect(() => {
    if (teacherEvaluationsTemporarilyDisabled || !isLoggedIn || !studentQrId) {
      setTeacherEvaluationLoading(false);
      setTeacherEvaluationReady(false);
      setTeacherEvaluationRequired(false);
      setTeacherEvaluationError('');
      setTeachers([]);
      setTeacherRatingDrafts({});
      setTeacherRatingNotes({});
      setSavedTeacherRatings({});
      setSavedTeacherNotes({});
      if (isLoggedIn && teacherEvaluationsTemporarilyDisabled) setTeacherEvaluationReady(true);
      return;
    }

    let cancelled = false;
    setTeacherEvaluationReady(false);
    setTeacherEvaluationRequired(false);
    setTeacherEvaluationLoading(true);
    setTeacherEvaluationError('');
    setTeacherRatingNotice('');

    const loadTeacherEvaluations = async () => {
      try {
        const response = await fetch('/api/student/teacher-evaluations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'load',
            studentId: studentQrId,
            password: String(loggedStudent?.['كلمة السر'] ?? loggedStudent?.password ?? ''),
          }),
        });
        const result = await response.json() as {
          success?: boolean;
          enabled?: boolean;
          error?: string;
          teachers?: Array<Record<string, unknown>>;
          ratings?: Array<Record<string, unknown>>;
        };
        if (!response.ok || !result.success) throw new Error(result.error || 'teacher-evaluation-load-failed');
        if (cancelled) return;

        if (!result.enabled) {
          setTeacherEvaluationReady(true);
          setTeacherEvaluationRequired(false);
          setTeachers([]);
          setTeacherRatingDrafts({});
          setTeacherRatingNotes({});
          setSavedTeacherRatings({});
          setSavedTeacherNotes({});
          setTeacherEvaluationError('');
          setActiveTab((current) => current === 'evaluations' ? 'record' : current);
          return;
        }

        setTeacherEvaluationRequired(true);
        setActiveTab('evaluations');
        const teacherRows = Array.isArray(result.teachers) ? result.teachers : [];
        const loadedTeachers = teacherRows.flatMap((row) => {
          const id = String(row.id ?? '').trim();
          const name = String(row.teacher_name ?? '').trim();
          const subjects = Array.isArray(row.subjects)
            ? [...new Set(row.subjects.map((subject) => String(subject).trim()).filter(Boolean))]
            : [];
          return id && name ? [{ id, name, subjects }] : [];
        });
        if (!loadedTeachers.length || loadedTeachers.some((teacher) => teacher.subjects.length === 0)) {
          throw new Error('لم تتم إضافة مدرسين مع مقرراتهم. أضف مدرسًا ومادة واحدة على الأقل لكل مدرس من جدول teachers.');
        }
        setTeachers(loadedTeachers);

        const ratingRows = Array.isArray(result.ratings) ? result.ratings : [];
        const storedRatings: Record<string, TeacherRating> = {};
        const storedNotes: Record<string, string> = {};
        ratingRows.forEach((row) => {
          const teacherId = String(row.teacher_id ?? '');
          const subject = String(row.subject ?? '');
          const rating = Number(row.rating);
          if (teacherId && subject && [0, 1, 2, 3, 4].includes(rating)) {
            storedRatings[getTeacherRatingKey(teacherId, subject)] = rating as TeacherRating;
            storedNotes[getTeacherRatingKey(teacherId, subject)] = String(row.note ?? '');
          }
        });
        setSavedTeacherRatings(storedRatings);
        setSavedTeacherNotes(storedNotes);
        setTeacherRatingDrafts(storedRatings);
        setTeacherRatingNotes(storedNotes);
        const pendingCount = loadedTeachers.reduce((total, teacher) => (
          total + teacher.subjects.filter((subject) => storedRatings[getTeacherRatingKey(teacher.id, subject)] === undefined).length
        ), 0);
        setTeacherEvaluationRequired(pendingCount > 0);
        setTeacherEvaluationReady(true);
        setTeacherEvaluationError('');
        setActiveTab(pendingCount > 0 ? 'evaluations' : 'record');
      } catch (error) {
        if (!cancelled) {
          const errorDetail = error instanceof Error ? error.message : String(error);
          const errorMessage = errorDetail.includes('teacher-evaluation-server-key-missing')
            ? 'يجب إعداد SUPABASE_SERVICE_ROLE_KEY في بيئة الخادم لتفعيل بوابة التقييم السرية.'
            : `تعذر تحميل التقييمات: ${errorDetail}`;
          setTeacherEvaluationRequired(true);
          setTeacherEvaluationReady(true);
          setTeacherEvaluationError(errorMessage);
          setActiveTab('evaluations');
        }
      } finally {
        if (!cancelled) setTeacherEvaluationLoading(false);
      }
    };

    void loadTeacherEvaluations();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, studentQrId]);

  const saveTeacherRating = async (teacher: TeacherEntry, subject: string) => {
    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    const key = getTeacherRatingKey(teacher.id, subject);
    const rating = teacherRatingDrafts[key];
    if (!studentId || rating === undefined) return;

    setSavingTeacherRatingKey(key);
    setTeacherRatingNotice('');
    try {
      const response = await fetch('/api/student/teacher-evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          studentId,
          password: String(loggedStudent?.['كلمة السر'] ?? loggedStudent?.password ?? ''),
          teacherId: teacher.id,
          subject,
          rating,
          note: teacherRatingNotes[key]?.trim() ?? '',
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(result.error || 'teacher-evaluation-save-failed');

      const nextRatings = { ...savedTeacherRatings, [key]: rating };
      setSavedTeacherRatings(nextRatings);
      setSavedTeacherNotes((current) => ({ ...current, [key]: teacherRatingNotes[key]?.trim() ?? '' }));
      const pendingCount = teachers.reduce((total, currentTeacher) => (
        total + currentTeacher.subjects.filter((currentSubject) => (
          nextRatings[getTeacherRatingKey(currentTeacher.id, currentSubject)] === undefined
        )).length
      ), 0);
      setTeacherEvaluationRequired(pendingCount > 0);
      setTeacherRatingNotice(pendingCount === 0 ? 'شكرًا، اكتملت جميع التقييمات.' : 'تم حفظ التقييم. أكمل تقييم بقية المقررات.');
      if (pendingCount === 0) setActiveTab('record');
    } catch {
      setTeacherRatingNotice('تعذر حفظ التقييم. شغّل تحديث SQL وتحقق من سياسات جدول تقييم المدرسين.');
    } finally {
      setSavingTeacherRatingKey(null);
    }
  };

  useEffect(() => {
    if (profileCompletion < 100) {
      setShowProfileCompletion(true);
      return;
    }

    const hideCompletionMessage = window.setTimeout(() => setShowProfileCompletion(false), 2000);
    return () => window.clearTimeout(hideCompletionMessage);
  }, [profileCompletion]);

  /* ============================================================
     Click Sound: تهيئة + تشغيل تلقائي عند أي ضغطة على زر/رابط
     ============================================================ */

  useEffect(() => {
    const handleFirstInteraction = () => {
      initClickSound();
      window.removeEventListener('pointerdown', handleFirstInteraction);
    };
    window.addEventListener('pointerdown', handleFirstInteraction, { once: true });
    return () => window.removeEventListener('pointerdown', handleFirstInteraction);
  }, []);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest('button, a, [role="button"], .tab, .logout-button, .login-button, .toggle-password, .forgot-password-button');
      if (!button) return;

      if (soundEnabled) {
        if (!playClickSound) initClickSound();
        playClickSound?.();
      }

      (button as HTMLElement).classList.add('btn-pressed');
      window.setTimeout(() => {
        (button as HTMLElement).classList.remove('btn-pressed');
      }, 130);
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [soundEnabled]);

  /* ============================================================
     Scroll Reveal Animation (IntersectionObserver + GPU transforms)
     ============================================================ */

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const selector = [
      '.student-brand-center',
      '.student-qr-section',
      '.student-info',
      '.student-class-manager',
      '.student-id-change-manager',
      '.student-details-grid',
      '.tabs-container',
      '.student-footer-actions',
      '.last-updated',
      '.info-item',
      '.detail-item',
      '.status-card',
      '.warning-item',
      '.login-card',
      '.password-reset-panel',
      '.login-help',
      '.system-notice',
    ].join(', ');

    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));

    elements.forEach((el) => {
      el.classList.add('reveal-on-scroll');
      // stagger بسيط جداً، بحد أقصى 180ms
      const parent = el.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(el) : 0;
      el.style.transitionDelay = `${Math.min(Math.max(index, 0) * 25, 180)}ms`;
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.06, rootMargin: '0px 0px -30px 0px' }
    );

    elements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [isLoggedIn, activeTab]);

  const getStudentTelegramChatId = (student: any) => {
    const value = student?.telegram_chat_id ?? student?.['telegram_chat_id'];
    if (value === undefined || value === null) return '';
    return String(value).trim();
  };

  const isTelegramEnabled = (value: any): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === 'yes' || normalized === '1';
    }
    return Boolean(value);
  };

  const getStudentTelegramPreference = (student: StudentRow | null | undefined) => {
    const chatId = getStudentTelegramChatId(student);
    const value = student?.telegram_notifications_enabled ?? student?.['telegram_notifications_enabled'];
    return !!chatId && isTelegramEnabled(value);
  };

  const persistTelegramPreference = async (enabled: boolean, nextChatId?: string) => {
    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    if (!studentId) return;

    try {
      const payload: Record<string, unknown> = {
        telegram_notifications_enabled: enabled,
      };
      if (nextChatId !== undefined) {
        payload.telegram_chat_id = nextChatId.trim() || null;
      }

      const { error } = await supabase.from('students').update(payload).eq('الرقم الجامعي', studentId);
      if (!error) {
        const hydratedStudent = {
          ...(loggedStudent ?? {}),
          telegram_notifications_enabled: enabled,
          telegram_chat_id: nextChatId !== undefined ? (nextChatId.trim() || null) : (loggedStudent?.telegram_chat_id ?? loggedStudent?.['telegram_chat_id'] ?? null),
        } as StudentRow;

        setLoggedStudent(hydratedStudent);
        setTelegramNotificationsEnabled(enabled);
        writeAuditLog({
          action: 'student_telegram_preference_updated',
          userType: 'student',
          userId: studentId,
          username: studentFullName,
          fullName: studentFullName,
          details: { enabled, chatIdUpdated: nextChatId !== undefined },
        });
      }
    } catch {
      // Ignore DB column mismatch; keep local UI state for active session.
    }
  };

  const handleTelegramToggle = async () => {
    if (telegramNotificationsEnabled) {
      const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
      if (!studentId) return;

      try {
        const { error } = await supabase.from('students').update({ telegram_notifications_enabled: false }).eq('الرقم الجامعي', studentId);
        if (!error) {
          setTelegramNotificationsEnabled(false);
          setLoggedStudent((previous) => (previous ? { ...previous, telegram_notifications_enabled: false } : previous));
          writeAuditLog({
            action: 'student_telegram_preference_updated',
            userType: 'student',
            userId: studentId,
            username: studentFullName,
            fullName: studentFullName,
            details: { enabled: false },
          });
        }
      } catch {
        setTelegramNotificationsEnabled(false);
      }
      return;
    }

    const currentChatId = getStudentTelegramChatId(loggedStudent);
    if (!currentChatId) {
      setTelegramChatIdInput('');
      setShowTelegramSettingsModal(true);
      return;
    }

    const nextState = true;
    await persistTelegramPreference(nextState);
    setToast({ message: 'تم تفعيل تنبيهات التليجرام بنجاح', type: 'success' });
  };

  const handleTelegramChatIdConfirm = async () => {
    const cleanedChatId = telegramChatIdInput.trim();
    if (!cleanedChatId) {
      setToast({ message: 'يرجى إدخال معرف التلجرام (Chat ID)', type: 'error' });
      return;
    }

    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    if (!studentId) return;

    const nextChatId = cleanedChatId.replace(/[^0-9-]/g, '');
    if (!nextChatId) {
      setToast({ message: 'معرف التلجرام غير صالح', type: 'error' });
      return;
    }

    try {
      const { error } = await supabase.from('students').update({ telegram_chat_id: nextChatId, telegram_notifications_enabled: true }).eq('الرقم الجامعي', studentId);
      if (!error) {
        const updatedStudent = {
          ...(loggedStudent ?? {}),
          telegram_chat_id: nextChatId,
          telegram_notifications_enabled: true,
        } as StudentRow;

        setLoggedStudent(updatedStudent);
        setTelegramNotificationsEnabled(true);
        setShowTelegramSettingsModal(false);
        setTelegramChatIdInput('');
        setToast({ message: 'تم تفعيل التنبيهات وحفظ معرف التلجرام', type: 'success' });
        writeAuditLog({
          action: 'student_telegram_linked',
          userType: 'student',
          userId: studentId,
          username: studentFullName,
          fullName: studentFullName,
          details: { notificationsEnabled: true },
        });
      } else {
        setToast({ message: 'تعذر حفظ معرف التلجرام', type: 'error' });
      }
    } catch {
      setToast({ message: 'حدث خطأ أثناء حفظ معرف التلجرام', type: 'error' });
    }
  };

  const refreshClassOptions = async () => {
    try {
      const studentYear = normalizeStudentYear(getRecordValue(loggedStudent as Record<string, unknown>, ['السنه الدراسية', 'السنة الدراسية', 'year', 'student_year']));
      if (!studentYear) {
        setClassOptions([]);
        return;
      }
      const response = await fetch('/api/student/classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: String(loggedStudent?.['الرقم الجامعي'] ?? ''),
          password: String(getRecordValue(loggedStudent as Record<string, unknown>, ['كلمة السر', 'password', 'pass']) ?? ''),
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string; classes?: Array<{ name: string; capacity: number | null; occupied: number; available: number | null }> };
      if (!response.ok || !result.success) throw new Error(result.error || 'student-classes-load-failed');
      const normalized = (result.classes ?? []).map((item) => ({
        ...item,
        name: String(item.name || '').trim() || 'غير محدد',
        available: item.available !== null ? Math.max(item.available, 0) : null,
      }));
      setClassOptions(normalized);

      if (loggedStudent?.['الفئة']) {
        const currentClass = String(loggedStudent['الفئة']).trim();
        const currentExists = normalized.some((item) => item.name === currentClass || `فئة ${item.name}` === currentClass || item.name === `فئة ${currentClass}`);
        if (!currentExists && normalized[0]) {
          setSelectedClassForUpdate(normalized[0].name);
        } else {
          setSelectedClassForUpdate(currentClass);
        }
      }
    } catch (error) {
      setClassOptions([]);
      setToast({ message: error instanceof Error ? 'تعذر تحميل فئات السنة الدراسية للطالب.' : 'تعذر تحميل الفئات.', type: 'error' });
    }
  };

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const rememberedStudentId = window.localStorage.getItem(rememberedStudentIdStorageKey)?.trim();
    const rememberedStudentPassword = window.localStorage.getItem(rememberedStudentPasswordStorageKey) ?? '';
    if (rememberedStudentId || rememberedStudentPassword) {
      setLoginData((current) => ({
        studentId: rememberedStudentId ?? current.studentId,
        password: rememberedStudentPassword,
      }));
    }
    window.localStorage.removeItem(studentSessionStorageKey);
  }, []);

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'grades', label: 'العلامات' },
    { key: 'record', label: 'السجل' },
    { key: 'status', label: 'الحالة' },
    ...(hasStudentGroup ? [{ key: 'schedule' as const, label: 'برنامج الدوام' }] : []),
    { key: 'skills', label: 'مهاراتي' },
  ];

  useEffect(() => {
    if (loggedStudent) {
      void refreshClassOptions();

      const studentId = String(loggedStudent['الرقم الجامعي'] ?? '').trim();
      if (studentId) {
        void fetch(`/api/student/student-id-change?studentId=${encodeURIComponent(studentId)}`)
          .then((response) => response.json() as Promise<{ success?: boolean; used?: boolean }>)
          .then((result) => {
            if (result.success) setStudentIdChangeCompleted(result.used === true);
          })
          .catch(() => undefined);
      }
    }
  }, [loggedStudent]);

  useEffect(() => {
    if (!isLoggedIn) return;

    const studentHistoryState = { studentPortal: true };
    window.history.pushState(studentHistoryState, '', window.location.pathname || '/');
    const handleStudentBackNavigation = () => {
      window.history.pushState(studentHistoryState, '', '/');
      setNotice('أنت داخل بوابة الطالب. استخدم تسجيل الخروج للعودة إلى صفحة الدخول.');
    };

    window.addEventListener('popstate', handleStudentBackNavigation);
    return () => window.removeEventListener('popstate', handleStudentBackNavigation);
  }, [isLoggedIn]);

  const refreshDashboard = useCallback(async () => {
    if (!loggedStudent || !loggedStudent['الرقم الجامعي']) return;

    const studentId = String(loggedStudent['الرقم الجامعي']);
    const studentYear = normalizeStudentYear(getRecordValue(loggedStudent as Record<string, unknown>, ['السنه الدراسية', 'السنة الدراسية', 'year', 'student_year']));

    try {
      const scheduleQuery = hasStudentGroup && studentYear
        ? fetch('/api/student/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId,
            password: String(getRecordValue(loggedStudent as Record<string, unknown>, ['كلمة السر', 'password', 'pass']) ?? ''),
          }),
        }).then(async (response) => {
          const result = await response.json() as { success?: boolean; error?: string; schedule?: unknown[] };
          if (!response.ok || !result.success) throw new Error(result.error || 'student-schedule-load-failed');
          return { data: result.schedule ?? [], error: null };
        }).catch((error: unknown) => ({
          data: [],
          error: error instanceof Error ? error : new Error(String(error)),
        }))
        : Promise.resolve({ data: [], error: null });
      const [studentResult, warningsResult, teacherAlertsResult, gradesResult, scheduleResult, skillsResult] = await Promise.all([
        getStudentById(studentId),
        getWarningsForStudent(studentId).then((rows) => ({ data: rows })),
        getTeacherAlertsForStudent(
          studentId,
          String(getRecordValue(loggedStudent as Record<string, unknown>, ['كلمة السر', 'password', 'pass']) ?? '')
        ).then((rows) => ({ data: rows, error: null as Error | null }))
          .catch((error: unknown) => ({ data: [] as Record<string, unknown>[], error: error instanceof Error ? error : new Error(String(error)) })),
        getTableRows(['الاعمال', 'الأعمال', 'أعمال', 'العملي', 'النظري']).then(({ data }) => ({
          data: Array.isArray(data) ? data.filter((row) => {
            const rowRecord = row as unknown as Record<string, unknown>;
            const rowStudentId = getValueByKeys(rowRecord, ['الرقم الجامعي', 'student_id', 'studentId']);
            return String(rowStudentId ?? '') === String(studentId);
          }) : [],
        })),
        scheduleQuery,
        supabase.from('student_skills').select('skills').eq('student_id', studentId).maybeSingle(),
      ]);

      const freshStudent = studentResult ?? loggedStudent;
      if (freshStudent && JSON.stringify(freshStudent) !== JSON.stringify(loggedStudent)) {
        setLoggedStudent(freshStudent);
      }

      const gradeRows = gradesResult.data.flatMap((row) => extractGrades([row as unknown as Record<string, unknown>]));
      setGrades(gradeRows);
      setWarnings([...(warningsResult.data as unknown as Record<string, unknown>[]), ...teacherAlertsResult.data]
        .sort((first, second) => String(second['التاريخ'] ?? '').localeCompare(String(first['التاريخ'] ?? ''))));
      setTeacherAlertLoadError(teacherAlertsResult.error?.message ?? '');
      if (!skillsResult.error) {
        const storedSkills = (skillsResult.data as { skills?: unknown } | null)?.skills;
        const normalizedSkills = Array.isArray(storedSkills)
          ? storedSkills.filter((skill): skill is StudentSkill => (
            !!skill
            && typeof skill === 'object'
            && typeof (skill as StudentSkill).category === 'string'
            && typeof (skill as StudentSkill).detail === 'string'
          )).slice(0, 3)
          : [];
        setStudentSkills(normalizedSkills);
        setSkillsMessage('');
      } else {
        setSkillsMessage('تعذر تحميل المهارات. تأكد من تشغيل ملف SQL الخاص بجدول مهارات الطلاب في Supabase.');
      }
      const currentGroup = getStudentGroup(freshStudent as Record<string, unknown>);
      if (!scheduleResult.error) {
        const matchingSchedule = (Array.isArray(scheduleResult.data) ? scheduleResult.data : [])
          .filter((item) => {
            const scheduleItem = item as Record<string, unknown>;
            const itemGroup = String(scheduleItem.group_name ?? '').trim().replace(/^فئة\s*/i, '');
            return normalizeStudentYear(scheduleItem.student_year) === studentYear
              && (!itemGroup || itemGroup === currentGroup);
          })
          .map((item) => item as ScheduleItem)
          .sort((first, second) => `${scheduleDays.indexOf(first.day)}-${first.start_time}`.localeCompare(`${scheduleDays.indexOf(second.day)}-${second.start_time}`));
        setScheduleItems(matchingSchedule);
      } else {
        setScheduleItems([]);
        setToast({ message: 'تعذر تحميل برنامج السنة الدراسية.', type: 'error' });
      }
      if (!currentGroup && activeTab === 'schedule') setActiveTab('record');
      const statusData = (freshStudent as Record<string, unknown> | null) ?? {};
      const statusValue = getValueByKeys(statusData, ['الحالة', 'status', 'الحالة_الدراسية']) ?? 'غير متوفر';
      setStudentStatus(normalizeText(statusValue));
    } catch {
      setNotice('حدث خطأ أثناء تحديث البيانات من قاعدة البيانات');
    }
  }, [loggedStudent]);

  const toggleSkillCategory = (category: string) => {
    setSkillDrafts((current) => {
      const existingSkill = current.find((skill) => skill.category === category);
      if (existingSkill) return current.filter((skill) => skill.category !== category);
      if (current.length >= 3) {
        setToast({ message: 'يمكنك اختيار ثلاث مهارات كحد أقصى', type: 'info' });
        return current;
      }
      return [...current, { category, detail: '' }];
    });
  };

  const updateSkillDetail = (category: string, detail: string) => {
    setSkillDrafts((current) => current.map((skill) => (
      skill.category === category ? { ...skill, detail } : skill
    )));
  };

  const saveStudentSkills = async () => {
    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    if (!studentId) return;
    if (skillDrafts.length < 1 || skillDrafts.length > 3) {
      setToast({ message: 'اختر مهارة واحدة على الأقل وثلاث مهارات كحد أقصى', type: 'error' });
      return;
    }
    if (skillDrafts.some((skill) => ['رياضة', 'أخرى'].includes(skill.category) && !skill.detail.trim())) {
      setToast({ message: 'يرجى تحديد نوع الرياضة أو كتابة المهارة الأخرى', type: 'error' });
      return;
    }

    setIsSavingSkills(true);
    const { error } = await supabase.from('student_skills').upsert({
      student_id: studentId,
      name: [
        getRecordValue(loggedStudent as Record<string, unknown>, ['اسم الطالب', 'name']),
        getRecordValue(loggedStudent as Record<string, unknown>, ['اسم الاب', 'اسم الأب']),
        getRecordValue(loggedStudent as Record<string, unknown>, ['الكنية']),
      ].map((value) => String(value ?? '').trim()).filter(Boolean).join(' '),
      phone: String(getRecordValue(loggedStudent as Record<string, unknown>, ['رقم الهاتف', 'phone']) ?? '').trim(),
      skills: skillDrafts.map((skill) => ({ ...skill, detail: skill.detail.trim() })),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'student_id' });
    setIsSavingSkills(false);

    if (error) {
      setToast({ message: 'تعذر حفظ المهارات. تأكد من إنشاء الجدول وسياسات الوصول في Supabase.', type: 'error' });
      return;
    }

    setStudentSkills(skillDrafts.map((skill) => ({ ...skill, detail: skill.detail.trim() })));
    setIsEditingSkills(false);
    setSkillsMessage('');
    setToast({ message: 'تم حفظ مهاراتك بنجاح', type: 'success' });
    writeAuditLog({
      action: 'student_skills_updated',
      userType: 'student',
      userId: studentId,
      username: studentFullName,
      fullName: studentFullName,
      details: { skillCount: skillDrafts.length },
    });
  };

  const compressStudentAvatar = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      throw new Error('الملف المحدد ليس صورة صالحة.');
    }

    const imageUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const loadedImage = new Image();
        loadedImage.onload = () => resolve(loadedImage);
        loadedImage.onerror = () => reject(new Error('تعذر قراءة الصورة. اختر ملف صورة صالحاً.'));
        loadedImage.src = imageUrl;
      });

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('تعذر تجهيز الصورة في هذا المتصفح.');

      const sourceLongestSide = Math.max(image.naturalWidth, image.naturalHeight);
      const dimensions = [1600, 1280, 1024, 800, 640, 512, 384, 256]
        .map((dimension) => Math.min(dimension, sourceLongestSide))
        .filter((dimension, index, allDimensions) => allDimensions.indexOf(dimension) === index);
      const qualities = [0.84, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36];
      const canvasToBlob = (type: string, quality: number) => new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, type, quality);
      });

      for (const dimension of dimensions) {
        const scale = Math.min(1, dimension / sourceLongestSide);
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        for (const quality of qualities) {
          const webpBlob = await canvasToBlob('image/webp', quality);
          if (webpBlob?.type === 'image/webp' && webpBlob.size <= 300 * 1024) return webpBlob;

          if (!webpBlob || webpBlob.type !== 'image/webp') {
            const jpegBlob = await canvasToBlob('image/jpeg', quality);
            if (jpegBlob?.type === 'image/jpeg' && jpegBlob.size <= 300 * 1024) return jpegBlob;
          }
        }
      }

      throw new Error('تعذر ضغط الصورة إلى الحجم المطلوب. جرّب صورة أخرى.');
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  };

  const uploadStudentAvatar = async (file: File) => {
    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    if (!studentId) return;

    if (isUploadingAvatar) return;

    if (!file.type.startsWith('image/')) {
      setAvatarNotice({ message: 'الملف المحدد ليس صورة. اختر صورة صالحة.', type: 'error' });
      return;
    }

    setIsUploadingAvatar(true);
    setAvatarNotice(null);
    let uploadedPath = '';

    try {
      const compressedFile = await compressStudentAvatar(file);
      const extension = compressedFile.type === 'image/webp' ? 'webp' : 'jpg';
      const safeStudentId = studentId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = `${safeStudentId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
      const { data: uploadedFile, error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, compressedFile, { contentType: compressedFile.type, cacheControl: '3600', upsert: false });

      if (uploadError || !uploadedFile) {
        throw new Error('تعذر رفع الصورة إلى مساحة التخزين. تحقق من إعدادات وسياسات Bucket avatars.');
      }
      uploadedPath = uploadedFile.path;

      const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(uploadedFile.path);
      const avatarUrl = publicUrlData.publicUrl;
      const { data: updatedStudent, error: updateError } = await supabase
        .from('students')
        .update({ avatar_url: avatarUrl })
        .eq('الرقم الجامعي', studentId)
        .select('avatar_url')
        .maybeSingle();

      if (updateError || !updatedStudent) {
        await supabase.storage.from('avatars').remove([uploadedPath]);
        uploadedPath = '';
        throw new Error('تم رفع الصورة لكن تعذر حفظ رابطها في سجل الطالب. تحقق من عمود avatar_url وصلاحية التحديث.');
      }

      setLoggedStudent((current) => current ? { ...current, avatar_url: avatarUrl } : current);
      writeAuditLog({
        action: 'student_avatar_updated',
        userType: 'student',
        userId: studentId,
        username: studentFullName,
        fullName: studentFullName,
      });
      setAvatarNotice({ message: 'تم تحديث الصورة الشخصية بنجاح.', type: 'success' });
    } catch (error) {
      if (uploadedPath) await supabase.storage.from('avatars').remove([uploadedPath]);
      setAvatarNotice({
        message: error instanceof Error ? error.message : 'حدث خطأ غير متوقع أثناء رفع الصورة.',
        type: 'error',
      });
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const openAccountModal = () => {
    const studentRecord = (loggedStudent ?? {}) as Record<string, unknown>;
    setAccountDraft({
      email: String(getRecordValue(studentRecord, ['البريد الإلكتروني', 'email']) ?? ''),
      phone: String(getRecordValue(studentRecord, ['رقم الهاتف', 'phone']) ?? ''),
      password: '',
    });
    setAccountModalNotice('');
    setAvatarNotice(null);
    setShowAccountModal(true);
  };

  const saveAccountChanges = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    const email = accountDraft.email.trim();
    const phone = accountDraft.phone.trim();
    const password = accountDraft.password;
    if (!studentId) return;
    if (password && password.length < 8) {
      setAccountModalNotice('يجب أن تتكون كلمة المرور من 8 محارف على الأقل.');
      return;
    }

    setIsSavingAccount(true);
    setAccountModalNotice('');
    try {
      const studentRecord = loggedStudent as Record<string, unknown>;
      const updatePayload: Record<string, string> = {
      };
      const emailColumns = ['البريد الإلكتروني', 'email'].filter((column) => Object.prototype.hasOwnProperty.call(studentRecord, column));
      const phoneColumns = ['رقم الهاتف', 'phone'].filter((column) => Object.prototype.hasOwnProperty.call(studentRecord, column));
      (emailColumns.length ? emailColumns : ['البريد الإلكتروني']).forEach((column) => { updatePayload[column] = email; });
      (phoneColumns.length ? phoneColumns : ['رقم الهاتف']).forEach((column) => { updatePayload[column] = phone; });
      if (password) {
        const passwordColumns = ['كلمة السر', 'password'].filter((column) => Object.prototype.hasOwnProperty.call(studentRecord, column));
        (passwordColumns.length ? passwordColumns : ['كلمة السر']).forEach((column) => { updatePayload[column] = password; });
      }

      const { data: updatedStudent, error } = await supabase
        .from('students')
        .update(updatePayload)
        .eq('الرقم الجامعي', studentId)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!updatedStudent) throw new Error('لم يتم العثور على سجل الطالب لتحديثه.');

      const updatedRecord = updatedStudent as StudentRow;
      setLoggedStudent((current) => current ? { ...current, ...updatedRecord } : current);
      if (password) {
        setLoginData((current) => ({ ...current, password }));
        if (rememberStudentId) {
          window.localStorage.setItem(rememberedStudentPasswordStorageKey, password);
        }
      }
      setAccountDraft((current) => ({ ...current, password: '' }));
      setShowAccountModal(false);
      setToast({ message: 'تم تحديث بيانات الحساب بنجاح.', type: 'success' });
      writeAuditLog({
        action: 'student_account_updated',
        userType: 'student',
        userId: studentId,
        username: studentFullName,
        details: {
          emailChanged: email !== String(getRecordValue(studentRecord, ['البريد الإلكتروني', 'email']) ?? '').trim(),
          phoneChanged: phone !== String(getRecordValue(studentRecord, ['رقم الهاتف', 'phone']) ?? '').trim(),
          passwordChanged: Boolean(password),
        },
      });
    } catch (error) {
      setAccountModalNotice(error instanceof Error ? error.message : 'حدث خطأ أثناء تحديث بيانات الحساب.');
    } finally {
      setIsSavingAccount(false);
    }
  };

  const loadHighResolutionQrImage = () => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('تعذر تحميل الباركود عالي الدقة. تحقق من اتصال الإنترنت.'));
    image.src = studentQrHighResolutionUrl;
  });

  const createStudentQrCanvas = async () => {
    const qrImage = await loadHighResolutionQrImage();
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 1300;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('تعذر تجهيز ملف الباركود في هذا المتصفح.');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.textAlign = 'center';
    context.direction = 'rtl';
    context.fillStyle = '#173d35';
    context.font = 'bold 48px Arial, sans-serif';
    context.fillText('المعهد التقاني لطب الأسنان', 700, 150);
    context.drawImage(qrImage, 390, 245, 620, 620);

    let nameFontSize = 58;
    context.font = `bold ${nameFontSize}px Arial, sans-serif`;
    while (context.measureText(studentFullName).width > 880 && nameFontSize > 38) {
      nameFontSize -= 2;
      context.font = `bold ${nameFontSize}px Arial, sans-serif`;
    }
    context.fillStyle = '#172b25';
    context.fillText(studentFullName, 700, 930, 880);
    context.font = 'bold 48px Arial, sans-serif';
    context.fillText(`الرقم الجامعي: ${studentQrId}`, 700, 1000, 880);
    context.fillStyle = '#0f513f';
    context.font = 'bold 48px Arial, sans-serif';
    context.fillText('يرجى طباعته على ورقة كرتونية', 700, 1195, 1280);
    return canvas;
  };

  const downloadBlob = (blob: Blob, fileName: string) => {
    const downloadUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = downloadUrl;
    downloadLink.download = fileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  };

  const createStudentQrPdf = async (canvas: HTMLCanvasElement) => {
    const jpegBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.98));
    if (!jpegBlob) throw new Error('تعذر تجهيز محتوى ملف PDF.');

    const imageBytes = new Uint8Array(await jpegBlob.arrayBuffer());
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const offsets = [0, 0, 0, 0, 0, 0];
    let byteLength = 0;
    const appendBytes = (bytes: Uint8Array) => {
      parts.push(bytes);
      byteLength += bytes.byteLength;
    };
    const appendText = (text: string) => appendBytes(encoder.encode(text));
    const addObject = (objectNumber: number, body: string) => {
      offsets[objectNumber] = byteLength;
      appendText(`${objectNumber} 0 obj\n${body}\nendobj\n`);
    };

    appendText('%PDF-1.4\n');
    addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
    addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    addObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');

    offsets[4] = byteLength;
    appendText(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.byteLength} >>\nstream\n`);
    appendBytes(imageBytes);
    appendText('\nendstream\nendobj\n');

    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const pageImageWidth = 315;
    const pageImageHeight = pageImageWidth * (canvas.height / canvas.width);
    const imageScale = pageImageWidth / canvas.width;
    const imageX = pageWidth - pageImageWidth - 36;
    const imageY = pageHeight - pageImageHeight - 36;
    const frameWidth = 1000 * imageScale;
    const frameHeight = frameWidth;
    const frameX = imageX + 200 * imageScale;
    const frameY = imageY + pageImageHeight - (60 + 1000) * imageScale;
    const scissorsX = frameX - 42;
    const scissorsY = frameY + frameHeight / 2;
    const circlePath = (centerX: number, centerY: number, radius: number) => {
      const control = radius * 0.5523;
      return `${(centerX + radius).toFixed(2)} ${centerY.toFixed(2)} m ${(centerX + radius).toFixed(2)} ${(centerY + control).toFixed(2)} ${(centerX + control).toFixed(2)} ${(centerY + radius).toFixed(2)} ${centerX.toFixed(2)} ${(centerY + radius).toFixed(2)} c ${(centerX - control).toFixed(2)} ${(centerY + radius).toFixed(2)} ${(centerX - radius).toFixed(2)} ${(centerY + control).toFixed(2)} ${(centerX - radius).toFixed(2)} ${centerY.toFixed(2)} c ${(centerX - radius).toFixed(2)} ${(centerY - control).toFixed(2)} ${(centerX - control).toFixed(2)} ${(centerY - radius).toFixed(2)} ${centerX.toFixed(2)} ${(centerY - radius).toFixed(2)} c ${(centerX + control).toFixed(2)} ${(centerY - radius).toFixed(2)} ${(centerX + radius).toFixed(2)} ${(centerY - control).toFixed(2)} ${(centerX + radius).toFixed(2)} ${centerY.toFixed(2)} c S`;
    };
    const pageContent = [
      'q',
      'q',
      `${pageImageWidth.toFixed(2)} 0 0 ${pageImageHeight.toFixed(2)} ${imageX.toFixed(2)} ${imageY.toFixed(2)} cm`,
      '/Im0 Do',
      'Q',
      '0.05 0.20 0.16 RG',
      '1.6 w',
      '[1 2] 0 d',
      `${frameX.toFixed(2)} ${frameY.toFixed(2)} ${frameWidth.toFixed(2)} ${frameHeight.toFixed(2)} re S`,
      '[] 0 d',
      '2.2 w',
      circlePath(scissorsX + 6, scissorsY - 7, 5.5),
      circlePath(scissorsX + 6, scissorsY + 7, 5.5),
      `${(scissorsX + 12).toFixed(2)} ${(scissorsY - 4).toFixed(2)} m ${(scissorsX + 33).toFixed(2)} ${(scissorsY + 14).toFixed(2)} l S`,
      `${(scissorsX + 12).toFixed(2)} ${(scissorsY + 4).toFixed(2)} m ${(scissorsX + 33).toFixed(2)} ${(scissorsY - 14).toFixed(2)} l S`,
      'Q',
    ].join('\n');
    const pageContentBytes = encoder.encode(pageContent);
    offsets[5] = byteLength;
    appendText(`5 0 obj\n<< /Length ${pageContentBytes.byteLength} >>\nstream\n`);
    appendBytes(pageContentBytes);
    appendText('\nendstream\nendobj\n');

    const crossReferenceOffset = byteLength;
    appendText('xref\n0 6\n0000000000 65535 f \n');
    for (let objectNumber = 1; objectNumber <= 5; objectNumber += 1) {
      appendText(`${String(offsets[objectNumber]).padStart(10, '0')} 00000 n \n`);
    }
    appendText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF`);

    const pdfBytes = new Uint8Array(byteLength);
    let offset = 0;
    parts.forEach((part) => {
      pdfBytes.set(part, offset);
      offset += part.byteLength;
    });
    return new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  };

  const downloadStudentQrPdf = async () => {
    setIsExportingQr(true);
    setQrExportError('');

    try {
      const canvas = await createStudentQrCanvas();
      const pdfBlob = await createStudentQrPdf(canvas);
      downloadBlob(pdfBlob, `student-${studentQrId || 'qr'}.pdf`);
    } catch (error) {
      setQrExportError(error instanceof Error ? error.message : 'حدث خطأ أثناء إنشاء ملف PDF.');
    } finally {
      setIsExportingQr(false);
    }
  };

  useEffect(() => {
    if (!loggedStudent || !loggedStudent['الرقم الجامعي']) return;

    void refreshDashboard();

    const intervalId = window.setInterval(() => {
      void refreshDashboard();
    }, 15000);

    const handleFocus = () => {
      void refreshDashboard();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshDashboard();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loggedStudent, refreshDashboard]);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();

    const studentId = loginData.studentId.trim();
    const password = loginData.password.trim();

    if (!studentId || !password) {
      setNotice('يرجى إدخال الرقم الجامعي وكلمة السر');
      setToast({ message: 'يرجى إدخال الرقم الجامعي وكلمة السر', type: 'error' });
      return;
    }

    setIsLoading(true);
    setNotice('جاري التحقق من بيانات الدخول...');

    try {
      const user = await getStudentById(studentId);

      if (!user) {
        setNotice('الرقم الجامعي غير موجود في قاعدة البيانات');
        setToast({ message: 'الرقم الجامعي غير موجود', type: 'error' });
        return;
      }

      const storedPassword = String(getRecordValue(user as Record<string, unknown>, ['كلمة السر', 'password']) ?? '').trim();
      if (storedPassword !== password) {
        setNotice('كلمة السر غير صحيحة');
        setToast({ message: 'كلمة السر غير صحيحة', type: 'error' });
        return;
      }

      const preference = getStudentTelegramPreference(user as StudentRow);

      const hydratedUser = {
        ...(user as StudentRow),
        telegram_notifications_enabled: preference
      } as StudentRow;

      setStudentSkills([]);
      setSkillDrafts([]);
      setIsEditingSkills(false);
      setLoggedStudent(hydratedUser);
      setTelegramNotificationsEnabled(preference);
      setActiveTab('record');
      setIsLoggedIn(true);
      if (rememberStudentId) {
        window.localStorage.setItem(rememberedStudentIdStorageKey, studentId);
        window.localStorage.setItem(rememberedStudentPasswordStorageKey, password);
      } else {
        window.localStorage.removeItem(rememberedStudentIdStorageKey);
        window.localStorage.removeItem(rememberedStudentPasswordStorageKey);
      }
      const authenticatedStudentFullName = [
        getRecordValue(user as Record<string, unknown>, ['اسم الطالب', 'name', 'student_name']),
        getRecordValue(user as Record<string, unknown>, ['اسم الاب', 'اسم الأب', 'father_name']),
        getRecordValue(user as Record<string, unknown>, ['الكنية', 'family_name', 'surname']),
      ].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
      writeAuditLog({
        action: 'student_login',
        userType: 'student',
        userId: studentId,
        username: authenticatedStudentFullName,
        fullName: authenticatedStudentFullName,
      });
      const studentName = normalizeText(getRecordValue(user as Record<string, unknown>, ['اسم الطالب', 'student_name', 'name']));
      setNotice(`تم تسجيل الدخول بنجاح، مرحباً ${studentName}`);
      setToast({ message: `مرحباً ${studentName}`, type: 'success' });
    } catch (error) {
      setNotice('حدث خطأ أثناء تسجيل الدخول');
      setToast({ message: 'حدث خطأ أثناء تسجيل الدخول', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const resetErrorMessage = (error?: string) => ({
    'student-not-found': 'لم يتم العثور على طالب بهذا الرقم أو رقم الهاتف.',
    'student-email-missing': 'لا يوجد بريد إلكتروني مسجل لهذا الحساب.',
    'no-recovery-method': 'لا يوجد تلجرام مربوط أو بريد إلكتروني مسجل لهذا الطالب.',
    'student-query-failed': 'تعذر الوصول إلى بيانات الطلاب، حاول مرة أخرى.',
    'password-reset-table-missing': 'ميزة استعادة كلمة المرور غير مفعلة بعد في قاعدة البيانات.',
    'reset-code-save-failed': 'تعذر حفظ رمز التحقق، حاول مرة أخرى.',
    'code-send-failed': 'تعذر إرسال رمز التحقق، حاول مرة أخرى.',
    'telegram-send-failed': 'تعذر إرسال رمز التحقق عبر التليجرام، تحقق من إعدادات البوت.',
    'email-send-failed': 'تعذر إرسال رمز التحقق عبر البريد الإلكتروني.',
    'invalid-code': 'رمز التحقق غير صحيح.',
    'code-expired': 'انتهت صلاحية الرمز، اطلب رمزًا جديدًا.',
    'too-many-attempts': 'تم تجاوز عدد المحاولات، اطلب رمزًا جديدًا.',
    'invalid-reset-input': 'أدخل رمزًا من 6 أرقام وكلمة مرور من 8 محارف على الأقل.',
  }[error ?? ''] ?? 'حدث خطأ أثناء استعادة كلمة المرور.');

  const requestPasswordResetCode = async () => {
    const identifier = resetIdentifier.trim();
    if (!identifier) {
      setToast({ message: 'أدخل الرقم الجامعي أو رقم الهاتف أولًا.', type: 'error' });
      return;
    }

    setResetLoading(true);
    try {
      const response = await fetch('/api/student/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, method: resetMethods.length ? resetMethod : undefined }),
      });
      const result = await response.json() as { success?: boolean; error?: string; methods?: Array<'telegram' | 'email'>; method?: 'telegram' | 'email'; destination?: string; requiresMethod?: boolean };
      if (!result.success) {
        setToast({ message: resetErrorMessage(result.error), type: 'error' });
        return;
      }

      setResetMethods(result.methods ?? []);
      setResetMethod(result.method ?? result.methods?.[0] ?? 'email');
      if (result.requiresMethod) {
        setToast({ message: 'اختر طريقة إرسال رمز التحقق.', type: 'info' });
        return;
      }
      setResetDestination(result.destination ?? 'وسيلة التواصل المرتبطة');
      setResetCodeSent(true);
      setToast({ message: `تم إرسال رمز التحقق عبر ${result.method === 'telegram' ? 'التليجرام' : 'البريد الإلكتروني'}.`, type: 'success' });
    } catch {
      setToast({ message: 'تعذر الاتصال بخدمة استعادة كلمة المرور.', type: 'error' });
    } finally {
      setResetLoading(false);
    }
  };

  const sendSelectedPasswordResetCode = async () => {
    await requestPasswordResetCode();
  };

  const verifyPasswordReset = async () => {
    setResetLoading(true);
    try {
      const response = await fetch('/api/student/password-reset/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: resetIdentifier, code: resetCode, newPassword }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!result.success) {
        setToast({ message: resetErrorMessage(result.error), type: 'error' });
        return;
      }

      setShowPasswordReset(false);
      setResetCodeSent(false);
      setResetIdentifier('');
      setResetCode('');
      setNewPassword('');
      setToast({ message: 'تم تغيير كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن.', type: 'success' });
    } catch {
      setToast({ message: 'تعذر التحقق من رمز الاستعادة.', type: 'error' });
    } finally {
      setResetLoading(false);
    }
  };

  const handleClassChange = async () => {
    const nextClass = String(selectedClassForUpdate ?? '').trim();
    const currentClass = String(loggedStudent?.['الفئة'] ?? '').trim();

    if (!nextClass) {
      setToast({ message: 'يرجى اختيار الفئة المراد الانتقال إليها', type: 'error' });
      return;
    }

    if (nextClass === currentClass || `فئة ${nextClass}` === currentClass || nextClass === `فئة ${currentClass}`) {
      setToast({ message: 'هذه الفئة هي الفئة الحالية', type: 'info' });
      return;
    }

    setIsChangingClass(true);
    try {
      const response = await fetch('/api/student/class-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: String(loggedStudent?.['الرقم الجامعي'] ?? ''),
          password: String(getRecordValue(loggedStudent as Record<string, unknown>, ['كلمة السر', 'password', 'pass']) ?? ''),
          nextClass,
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string; emailSent?: boolean; telegramSent?: boolean };
      if (!result.success) {
        const changeErrors: Record<string, string> = {
          'class-full': 'لا توجد مقاعد متاحة في هذه الفئة.',
          'student-year-missing': 'لا يمكن تغيير الفئة قبل تحديد السنة الدراسية في بيانات الطالب.',
          'class-not-available-for-student-year': 'هذه الفئة غير متاحة لسنتك الدراسية.',
          'student-portal-server-key-missing': 'خدمة تغيير الفئة غير مهيأة على الخادم.',
        };
        const message = changeErrors[result.error ?? ''] ?? 'تعذر تغيير الفئة.';
        setNotice(message);
        setToast({ message, type: 'error' });
        return;
      }

      const updatedStudent = {
        ...(loggedStudent ?? {}),
        'الفئة': nextClass,
        'تاريخ_تغيير_الفئة': new Date().toISOString(),
      };

      setLoggedStudent(updatedStudent as StudentRow);
      const notificationText = [
        result.emailSent ? 'البريد الإلكتروني' : '',
        result.telegramSent ? 'التليجرام' : '',
      ].filter(Boolean).join(' و ');
      setNotice(notificationText
        ? `تم تغيير الفئة إلى ${nextClass} وإرسال إشعار عبر ${notificationText}.`
        : `تم تغيير الفئة إلى ${nextClass}.`);
      setToast({ message: `تم تغيير الفئة إلى ${nextClass}`, type: 'success' });

      await refreshClassOptions();
      writeAuditLog({
        action: 'student_class_changed',
        userType: 'student',
        userId: loggedStudent?.['الرقم الجامعي'],
        username: studentFullName,
        fullName: studentFullName,
        details: { previousClass: currentClass, nextClass },
      });
    } catch {
      setNotice('حدث خطأ أثناء تغيير الفئة');
      setToast({ message: 'حدث خطأ أثناء تغيير الفئة', type: 'error' });
    } finally {
      setIsChangingClass(false);
    }
  };

  const handleStudentIdChange = async () => {
    const currentStudentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    const nextStudentId = newStudentId.trim();

    if (!currentStudentId || !/^\d+$/.test(nextStudentId)) {
      setToast({ message: 'أدخل رقمًا جامعيًا جديدًا صحيحًا.', type: 'error' });
      return;
    }
    if (!studentIdChangeConfirmed) {
      setToast({ message: 'يجب تأكيد مطابقة الرقم للقوائم المنشورة وتحمل مسؤولية إدخاله.', type: 'error' });
      return;
    }

    setIsChangingStudentId(true);
    try {
      const response = await fetch('/api/student/student-id-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentStudentId, newStudentId: nextStudentId, confirmed: true }),
      });
      const result = await response.json() as { success?: boolean; studentId?: string; details?: string; error?: string };
      if (!response.ok || !result.success) {
        setToast({ message: result.details ?? 'تعذر تغيير الرقم الجامعي.', type: 'error' });
        return;
      }

      const updatedStudent = { ...(loggedStudent ?? {}), 'الرقم الجامعي': result.studentId ?? nextStudentId } as StudentRow;
      setLoggedStudent(updatedStudent);
      if (rememberStudentId) {
        window.localStorage.setItem(rememberedStudentIdStorageKey, result.studentId ?? nextStudentId);
      }
      setNewStudentId('');
      setStudentIdChangeConfirmed(false);
      setStudentIdChangeCompleted(true);
      setNotice('تم تغيير الرقم الجامعي بنجاح. هذا التغيير متاح مرة واحدة فقط.');
      setToast({ message: 'تم تغيير الرقم الجامعي بنجاح.', type: 'success' });
      writeAuditLog({
        action: 'student_id_changed',
        userType: 'student',
        userId: result.studentId ?? nextStudentId,
        username: studentFullName,
        fullName: studentFullName,
        details: { previousStudentId: currentStudentId, nextStudentId: result.studentId ?? nextStudentId },
      });
    } catch {
      setToast({ message: 'تعذر الاتصال بخدمة تغيير الرقم الجامعي.', type: 'error' });
    } finally {
      setIsChangingStudentId(false);
    }
  };

  const logout = () => {
    writeAuditLog({
      action: 'student_logout',
      userType: 'student',
      userId: loggedStudent?.['الرقم الجامعي'],
      username: studentFullName,
      fullName: studentFullName,
    });
    window.localStorage.removeItem(studentSessionStorageKey);
    setIsLoggedIn(false);
    setLoggedStudent(null);
    setStudentSkills([]);
    setSkillDrafts([]);
    setIsEditingSkills(false);
    setLoginData({ studentId: '', password: '' });
    setNewStudentId('');
    setStudentIdChangeConfirmed(false);
    setStudentIdChangeCompleted(false);
    setNotice('تم تسجيل الخروج بنجاح');
  };

  if (!isLoggedIn) {
    return (
      <main
        className="login-shell"
        dir="rtl"
        style={{
          backgroundSize: 'cover',
          backgroundPosition: 'center center',
          backgroundRepeat: 'no-repeat',
          position: 'relative',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(255, 255, 255, 0.06)',
            backdropFilter: 'blur(0.5px)',
            zIndex: 0,
          }}
        />

        {toast && (
          <div className={`toast toast-${toast.type}`} role="status" aria-live="polite" style={{ zIndex: 5 }}>
            <span className="toast-icon">{toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'}</span>
            <span>{toast.message}</span>
          </div>
        )}

        <div className={`login-card ${showPasswordReset ? 'password-reset-mode' : ''}`} style={{ position: 'relative', zIndex: 1 }}>
          <div className="institute-header login-institute-header">
            <img
              className="login-logo"
              src="/institute-logo.png"
              alt="شعار المعهد"
            />
            <h2>المعهد التقاني لطب الأسنان</h2>
            <h3>جامعة اللاذقية</h3>
          </div>

          <h1 className="login-title">{showPasswordReset ? 'إعادة تعيين كلمة المرور' : 'استعلام قسم تعويضات أسنان'}</h1>

          <form onSubmit={handleLogin} className="login-form">
            <div className="form-group">
              <input
                type="text"
                value={loginData.studentId}
                onChange={(event) => setLoginData({ ...loginData, studentId: event.target.value })}
                placeholder="الرقم الجامعي"
                inputMode="numeric"
                required
                disabled={isLoading}
              />
            </div>

            <div className="form-group password-container">
              <input
                type={showPassword ? 'text' : 'password'}
                value={loginData.password}
                onChange={(event) => setLoginData({ ...loginData, password: event.target.value })}
                onKeyDown={(event) => setCapsLockOn(event.getModifierState ? event.getModifierState('CapsLock') : false)}
                onKeyUp={(event) => setCapsLockOn(event.getModifierState ? event.getModifierState('CapsLock') : false)}
                placeholder="كلمة السر"
                required
                disabled={isLoading}
              />
              <button
                type="button"
                className="toggle-password"
                aria-label={showPassword ? 'إخفاء كلمة السر' : 'إظهار كلمة السر'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword ? 'إخفاء' : 'إظهار'}
              </button>
            </div>

            {capsLockOn && <div className="caps-warning">⚠️ Caps Lock مفعّل</div>}

            <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: '0 0 7px', color: '#64748b', fontSize: 11 }}>
              <input
                type="checkbox"
                checked={rememberStudentId}
                onChange={(event) => setRememberStudentId(event.target.checked)}
                disabled={isLoading}
                style={{ width: 13, height: 13, margin: 0 }}
              />
              تذكر الرقم الجامعي وكلمة المرور
            </label>

            <button type="submit" className={`login-button ${isLoading ? 'is-loading' : ''}`} disabled={isLoading}>
              {isLoading ? (
                <>
                  <span className="spinner-inline" />
                  <span>جاري التحقق...</span>
                </>
              ) : (
                'عرض'
              )}
            </button>
          </form>

          <button
            type="button"
            className="forgot-password-button"
            aria-expanded={showPasswordReset}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const nextState = !showPasswordReset;
              setShowPasswordReset(nextState);
              setResetCodeSent(false);
              setResetMethods([]);
              if (!nextState) {
                setResetIdentifier('');
                setResetCode('');
                setNewPassword('');
              }
            }}
          >
            {showPasswordReset ? 'العودة إلى تسجيل الدخول' : 'نسيت كلمة المرور؟'}
          </button>

          {showPasswordReset && (
            <section className="password-reset-panel">
              <h3>استعادة كلمة المرور</h3>
              <p>أدخل الرقم الجامعي أو رقم الهاتف للبحث عن حسابك.</p>
              <input
                type="text"
                value={resetIdentifier}
                onChange={(event) => setResetIdentifier(event.target.value)}
                placeholder="الرقم الجامعي أو رقم الهاتف"
                disabled={resetLoading || resetCodeSent}
              />
              <div className="password-reset-phone-hint">
                إذا كنت تستخدم رقم الهاتف، اكتبه بدون الصفر الأول، مثال: 992222222
              </div>

              {!resetCodeSent && resetMethods.length > 1 && (
                <div className="password-reset-methods">
                  <span>اختر طريقة إرسال رمز التحقق:</span>
                  <div>
                    {resetMethods.includes('telegram') && <button type="button" className={resetMethod === 'telegram' ? 'selected' : ''} onClick={() => setResetMethod('telegram')}>التليجرام</button>}
                    {resetMethods.includes('email') && <button type="button" className={resetMethod === 'email' ? 'selected' : ''} onClick={() => setResetMethod('email')}>البريد الإلكتروني</button>}
                  </div>
                </div>
              )}

              {!resetCodeSent ? (
                <button type="button" className="login-button password-reset-action" onClick={sendSelectedPasswordResetCode} disabled={resetLoading}>
                  {resetLoading ? 'جاري الإرسال...' : resetMethods.length > 1 ? 'إرسال رمز التحقق' : 'متابعة'}
                </button>
              ) : (
                <>
                  <div className="password-reset-destination">تم إرسال الرمز عبر {resetMethod === 'telegram' ? 'التليجرام' : `البريد الإلكتروني (${resetDestination})`}</div>
                  <input type="text" inputMode="numeric" maxLength={6} value={resetCode} onChange={(event) => setResetCode(event.target.value.replace(/\D/g, ''))} placeholder="رمز التحقق - 6 أرقام" disabled={resetLoading} />
                  <input type="password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="كلمة المرور الجديدة - 8 محارف على الأقل" disabled={resetLoading} />
                  <button type="button" className="login-button password-reset-action" onClick={() => void verifyPasswordReset()} disabled={resetLoading}>
                    {resetLoading ? 'جاري التحقق...' : 'تغيير كلمة المرور'}
                  </button>
                  <button type="button" className="password-reset-resend" onClick={() => { setResetCodeSent(false); setResetCode(''); setNewPassword(''); }}>
                    إرسال رمز جديد
                  </button>
                </>
              )}
            </section>
          )}

          <div className="login-help">
            <strong>ملاحظات:</strong>
            <span>استخدم الرقم الجامعي وكلمة السر الخاصة بك</span>
          </div>

          <div className="system-notice">{notice}</div>
        </div>

        <div className="login-footer">
          <Link href="/dashboard" className="admin-link">
            لوحة التحكم للمشرفين
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="student-shell" dir="rtl">
      <div className="student-page">
        <div ref={studentDashboardRef} className="container student-dashboard-container" id="mainContainer" aria-hidden={teacherEvaluationGateOpen}>
          <div className="student-brand-center student-identity-hero">
            <img
              className="institute-logo"
              src="/institute-logo.png"
              alt="شعار المعهد"
            />
            <div className="student-brand-text">
              <h2>المعهد التقاني لطب الأسنان</h2>
              <h3>جامعة اللاذقية</h3>
            </div>
          </div>

          <section className="student-avatar-section" aria-label="الصورة الشخصية">
            <div className="student-avatar-frame">
              <input
                id="student-avatar-file"
                className="student-avatar-file"
                type="file"
                accept="image/*"
                disabled={isUploadingAvatar}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void uploadStudentAvatar(file);
                }}
              />
              {loggedStudent?.avatar_url ? (
                <img
                  className="student-avatar-image"
                  src={loggedStudent.avatar_url}
                  alt={`الصورة الشخصية للطالب ${studentFullName}`}
                />
              ) : (
                <div className="student-avatar-placeholder" role="img" aria-label="لا توجد صورة شخصية">
                  <i className="fa-solid fa-user" aria-hidden="true" />
                </div>
              )}
              <label
                className={`student-avatar-camera-button${isUploadingAvatar ? ' is-uploading' : ''}`}
                htmlFor="student-avatar-file"
                aria-label="تعديل الصورة الشخصية"
                title="تعديل الصورة الشخصية"
              >
                {isUploadingAvatar ? <span className="student-avatar-spinner" aria-hidden="true" /> : <Pencil size={17} strokeWidth={2.5} aria-hidden="true" />}
              </label>
            </div>
            <div className="student-avatar-controls">
              <div className="student-avatar-name-row">
                <strong className="student-avatar-name">{studentFullName}</strong>
                <button type="button" className="student-account-edit-trigger" onClick={openAccountModal}>
                  <Settings size={15} aria-hidden="true" />
                  تعديل الحساب
                </button>
              </div>
              {isUploadingAvatar && <span className="student-avatar-hint">جارٍ ضغط الصورة ورفعها...</span>}
              {avatarNotice && (
                <span className={`student-avatar-notice ${avatarNotice.type}`} role="status" aria-live="polite">
                  {avatarNotice.message}
                </span>
              )}
            </div>
          </section>

          {showAccountModal && (
            <div
              className="student-account-modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !isSavingAccount) setShowAccountModal(false);
              }}
            >
              <section className="student-account-modal" role="dialog" aria-modal="true" aria-labelledby="student-account-modal-title">
                <header className="student-account-modal-header">
                  <div>
                    <h2 id="student-account-modal-title">تعديل الحساب</h2>
                    <p>حدّث بيانات التواصل وكلمة المرور وصورتك الشخصية.</p>
                  </div>
                  <button
                    type="button"
                    className="student-account-modal-close"
                    onClick={() => setShowAccountModal(false)}
                    disabled={isSavingAccount}
                    aria-label="إغلاق"
                  >
                    <X size={19} aria-hidden="true" />
                  </button>
                </header>

                <div className="student-account-avatar-editor">
                  {loggedStudent?.avatar_url ? (
                    <img src={loggedStudent.avatar_url} alt="الصورة الشخصية الحالية" />
                  ) : (
                    <span className="student-account-avatar-placeholder" aria-hidden="true"><i className="fa-solid fa-user" /></span>
                  )}
                  <label htmlFor="student-account-avatar-file" className="student-account-avatar-button">
                    {isUploadingAvatar ? 'جارٍ رفع الصورة...' : 'تغيير الصورة'}
                  </label>
                  <input
                    id="student-account-avatar-file"
                    type="file"
                    accept="image/*"
                    disabled={isUploadingAvatar || isSavingAccount}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void uploadStudentAvatar(file);
                    }}
                  />
                  {avatarNotice && <span className={`student-account-avatar-notice ${avatarNotice.type}`} role="status">{avatarNotice.message}</span>}
                </div>

                <form className="student-account-form" onSubmit={saveAccountChanges}>
                  <label className="student-account-field">
                    <span>البريد الإلكتروني</span>
                    <input
                      type="email"
                      autoComplete="email"
                      value={accountDraft.email}
                      onChange={(event) => setAccountDraft((current) => ({ ...current, email: event.target.value }))}
                      required
                    />
                  </label>
                  <label className="student-account-field">
                    <span>رقم الموبايل</span>
                    <input
                      type="tel"
                      autoComplete="tel"
                      value={accountDraft.phone}
                      onChange={(event) => setAccountDraft((current) => ({ ...current, phone: event.target.value }))}
                    />
                  </label>
                  <label className="student-account-field">
                    <span>كلمة المرور الجديدة <small>اتركها فارغة إذا لم ترد تغييرها</small></span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      value={accountDraft.password}
                      onChange={(event) => setAccountDraft((current) => ({ ...current, password: event.target.value }))}
                    />
                  </label>
                  {accountModalNotice && <p className="student-account-modal-notice" role="alert">{accountModalNotice}</p>}
                  <div className="student-account-modal-actions">
                    <button type="button" className="student-account-cancel" onClick={() => setShowAccountModal(false)} disabled={isSavingAccount}>إلغاء</button>
                    <button type="submit" className="student-account-save" disabled={isSavingAccount || isUploadingAvatar}>
                      {isSavingAccount ? 'جارٍ الحفظ...' : 'حفظ التعديلات'}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}

          {showProfileCompletion && (
            <div className="student-profile-completion-wrap">
              <section
                className={`student-profile-completion${profileCompletion === 100 ? ' is-fading' : ''}`}
                aria-labelledby="student-profile-completion-title"
                aria-hidden={profileCompletion === 100}
              >
              <div className="student-profile-completion-heading">
                <h2 id="student-profile-completion-title">اكتمال الملف الشخصي</h2>
                <strong>{profileCompletion}%</strong>
              </div>
              <div
                className="student-profile-completion-track"
                role="progressbar"
                aria-label="نسبة اكتمال الملف الشخصي"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={profileCompletion}
              >
                <span style={{ width: `${profileCompletion}%` }} />
              </div>
              <p className="student-profile-completion-hint">
                المتبقي لإكمال الملف: {missingProfileTasks.join('، ')}.
              </p>
              <div className="student-profile-completion-items">
                {profileChecklist.map((task) => (
                  <span className={task.complete ? 'is-complete' : ''} key={task.label}>
                    <span aria-hidden="true">{task.complete ? '✓' : '○'}</span>
                    {task.label} {task.weight}%
                  </span>
                ))}
                </div>
                </section>
                {profileCompletion === 100 && (
                  <div className="student-profile-completion-success" role="status" aria-live="polite">
                    <span className="student-profile-completion-success-icon" aria-hidden="true">✓</span>
                    <span>
                      <strong>عمل ممتاز!</strong>
                      <small>اكتمل ملفك الشخصي بالكامل.</small>
                    </span>
                  </div>
                )}
              </div>
          )}

          <div className="barcode-section student-qr-section">
            <div className="barcode-box qr-box student-qr-card">
              <img
                className="barcode-svg qr-image"
                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(studentQrData)}`}
                alt="QR code للطالب"
              />
              <div className="barcode-id">{formatStudentValue(loggedStudent?.['الرقم الجامعي'])}</div>
              <button
                className="student-qr-export-trigger"
                type="button"
                onClick={() => { setQrExportError(''); void downloadStudentQrPdf(); }}
                disabled={isExportingQr}
              >
                <Download size={16} aria-hidden="true" />
                <span>{isExportingQr ? 'جارٍ تجهيز PDF...' : 'تنزيل الباركود PDF'}</span>
              </button>
              {qrExportError && <p className="student-qr-export-error" role="alert">{qrExportError}</p>}
            </div>
          </div>

          {notice ? (
            <div className="system-notice">{notice}</div>
          ) : (
            <div className="system-notice student-developer-credit">
              <Code2 size={17} aria-hidden="true" />
              <span>
                Developed by{' '}
                <a href="https://www.facebook.com/salem.y.homisha" target="_blank" rel="noreferrer">
                  Dr. Salem
                </a>
              </span>
            </div>
          )}

          <div className="header student-dashboard-title">
            <h1>الحساب الجامعي</h1>
            <button
              type="button"
              onClick={() => setSoundEnabled((s) => !s)}
              title={soundEnabled ? 'إيقاف صوت النقر' : 'تفعيل صوت النقر'}
              aria-label={soundEnabled ? 'إيقاف صوت النقر' : 'تفعيل صوت النقر'}
              style={{
                marginInlineStart: 12,
                background: 'transparent',
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: 16,
              }}
            >
              {soundEnabled ? '🔊' : '🔇'}
            </button>
          </div>

          <div className="student-info student-profile-grid">
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-id-card" /> الرقم الجامعي</span> {formatStudentValue(loggedStudent?.['الرقم الجامعي'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-building-columns" /> القسم</span> {formatStudentValue(loggedStudent?.['القسم'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-graduation-cap" /> اسم الأب</span> {formatStudentValue(loggedStudent?.['اسم الاب'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-users" /> الكنية</span> {formatStudentValue(loggedStudent?.['الكنية'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-layer-group" /> الفئة</span> {formatStudentValue(loggedStudent?.['الفئة'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-check-circle" /> السنة الدراسية</span> {formatStudentValue(loggedStudent?.['السنه الدراسية'])}</div>
          </div>

          <div className="student-class-manager" style={{ marginTop: 24, padding: '20px 24px', background: '#f8fafc', borderRadius: 16, border: '1px solid #e2e8f0' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
              <h3 className="class-change-title" style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>تغيير الفئة</h3>
              <div className="class-change-muted" style={{ color: '#475569', fontSize: 14 }}>
                {classOptions.length > 0
                  ? classOptions.filter((item) => item.available !== null && item.available > 0).length
                  : 0} فئة متاحة حالياً
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={selectedClassForUpdate}
                onChange={(event) => setSelectedClassForUpdate(event.target.value)}
                className="class-change-select"
                style={{ minWidth: 180, padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
              >
                <option value="">اختر الفئة</option>
                {classOptions.length > 0 ? classOptions.map((item) => {
                  const isDisabled = item.available !== null && item.available <= 0;
                  return (
                    <option key={item.name} value={item.name} disabled={isDisabled}>
                      {item.name} {item.available !== null ? `(${item.available} مقعد متاح)` : ''}{isDisabled ? ' - ممتلئة' : ''}
                    </option>
                  );
                }) : (
                  <option value={String(loggedStudent?.['الفئة'] ?? '')}>{formatStudentValue(loggedStudent?.['الفئة'])}</option>
                )}
              </select>

              <button
                type="button"
                onClick={() => void handleClassChange()}
                disabled={isChangingClass || !selectedClassForUpdate || !!classOptions.find((item) => item.name === selectedClassForUpdate)?.available && classOptions.find((item) => item.name === selectedClassForUpdate)?.available === 0}
                style={{
                  padding: '10px 18px',
                  borderRadius: 10,
                  border: 'none',
                  background: isChangingClass || !selectedClassForUpdate || !!classOptions.find((item) => item.name === selectedClassForUpdate)?.available && classOptions.find((item) => item.name === selectedClassForUpdate)?.available === 0 ? '#cbd5e1' : '#0f766e',
                  color: '#fff',
                  fontWeight: 700,
                  cursor: isChangingClass || !selectedClassForUpdate || !!classOptions.find((item) => item.name === selectedClassForUpdate)?.available && classOptions.find((item) => item.name === selectedClassForUpdate)?.available === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {isChangingClass ? 'جاري التحديث...' : 'تغيير الفئة'}
              </button>
            </div>

            <div className="class-change-muted" style={{ marginTop: 12, color: '#475569', fontSize: 14 }}>
              {classOptions.length > 0 && classOptions.find((item) => item.name === selectedClassForUpdate)?.available !== undefined
                ? `المقاعد المتبقية: ${classOptions.find((item) => item.name === selectedClassForUpdate)?.available ?? 'غير محدد'}`
                : 'لا توجد معلومات سعة مفعلة لهذا الفصل'}
            </div>
          </div>

          {!studentIdChangeCompleted && (
            <div className="student-id-change-manager" style={{ marginTop: 18, padding: '20px 24px', background: '#fffaf0', borderRadius: 16, border: '1px solid #ead7ad' }}>
            <h3 style={{ margin: 0, fontSize: 18, color: '#7c4a03' }}>تغيير الرقم الجامعي</h3>
            <p style={{ margin: '10px 0 6px', color: '#5f4b2b', fontSize: 14, lineHeight: 1.8 }}>
              يمكنك تغيير الرقم الجامعي مرة واحدة فقط. أدخل الرقم الوزاري المطابق للقوائم المنشورة الرسمية.
            </p>
            <p style={{ margin: '0 0 14px', color: '#8a3d12', fontSize: 14, fontWeight: 700, lineHeight: 1.8 }}>
              تنبيه: أي خطأ في تعيين الرقم الجامعي يتحمل الطالب مسؤوليته الكاملة.
            </p>
            <input
              value={newStudentId}
              onChange={(event) => setNewStudentId(event.target.value.replace(/\D/g, ''))}
              placeholder="الرقم الجامعي الجديد حسب القوائم الوزارية"
              inputMode="numeric"
              disabled={studentIdChangeCompleted || isChangingStudentId}
              style={{ width: '100%', minHeight: 44, padding: '10px 12px', border: '1px solid #d6bd87', borderRadius: 9, background: '#fff', color: '#3f2b12', fontFamily: 'inherit' }}
            />
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 12, color: '#5f4b2b', fontSize: 13, lineHeight: 1.7 }}>
              <input
                type="checkbox"
                checked={studentIdChangeConfirmed}
                onChange={(event) => setStudentIdChangeConfirmed(event.target.checked)}
                disabled={studentIdChangeCompleted || isChangingStudentId}
                style={{ marginTop: 4 }}
              />
              أؤكد أن الرقم مطابق للقوائم المنشورة والرقم الوزاري، وأتحمل مسؤولية أي خطأ في إدخاله.
            </label>
            <button
              type="button"
              onClick={() => void handleStudentIdChange()}
              disabled={studentIdChangeCompleted || isChangingStudentId || !newStudentId.trim() || !studentIdChangeConfirmed}
              style={{ marginTop: 14, padding: '10px 18px', border: 'none', borderRadius: 9, background: studentIdChangeCompleted || isChangingStudentId || !newStudentId.trim() || !studentIdChangeConfirmed ? '#c9b98f' : '#9a5b0a', color: '#fff', fontWeight: 700, cursor: studentIdChangeCompleted || isChangingStudentId || !newStudentId.trim() || !studentIdChangeConfirmed ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
            >
              {studentIdChangeCompleted ? 'تم استخدام التغيير' : isChangingStudentId ? 'جاري الحفظ...' : 'تأكيد تغيير الرقم'}
            </button>
            </div>
          )}

          <div className="student-details-grid student-extra-details">
            <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
              <div className="detail-label">إعدادات التنبيهات</div>
              <div className="notification-description" style={{ marginBottom: 12, color: '#475569', fontSize: 14, lineHeight: 1.8 }}>
                فعّل التنبيهات للسماح للمعهد بالتواصل معك عبر التلجرام وإرسال الإعلانات المهمة، مثل توسّع الفئة، بدء تسجيل الحضور، أو تسجيل إنذار على حسابك.
              </div>
              <div className="detail-value" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span>{telegramNotificationsEnabled ? 'التنبيهات مفعلة' : 'التنبيهات متوقفة'}</span>
                <button
                  type="button"
                  onClick={() => void handleTelegramToggle()}
                  style={{
                    position: 'relative',
                    width: 56,
                    height: 30,
                    borderRadius: 999,
                    border: 'none',
                    background: telegramNotificationsEnabled ? '#10b981' : '#cbd5e1',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    padding: 0,
                  }}
                  aria-label={telegramNotificationsEnabled ? 'إيقاف التنبيهات' : 'تفعيل التنبيهات'}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 4,
                      left: telegramNotificationsEnabled ? 28 : 4,
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: '#fff',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      transition: 'all 0.2s ease',
                    }}
                  />
                </button>
              </div>
            </div>

            {showTelegramSettingsModal && (
              <div className="student-telegram-modal" style={{ gridColumn: '1 / -1', background: '#f8fafc', border: '1px solid #dbeafe', borderRadius: 14, padding: 20 }}>
                <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>تفعيل تنبيهات التلجرام 🔔</div>
                <ol style={{ color: '#475569', lineHeight: 1.8, marginBottom: 12, paddingRight: 20 }}>
                  <li>اضغط على زر "فتح بوت المعهد" أدناه.</li>
                  <li>اضغط على زر (Start / ابدأ) داخل التلجرام.</li>
                  <li>قم بنسخ رقم الـ Chat ID الذي سيرسله لك البوت وضعه في الخانة المخصصة أدناه.</li>
                </ol>
                <a
                  href="https://t.me/DTI_Portal_Bot"
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', marginBottom: 12, padding: '10px 14px', background: '#2563eb', color: '#fff', borderRadius: 10, textDecoration: 'none', fontWeight: 700 }}
                >
                  فتح بوت المعهد
                </a>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={telegramChatIdInput}
                    onChange={(event) => setTelegramChatIdInput(event.target.value)}
                    placeholder="ادخل رقم الـ Chat ID"
                    style={{ flex: 1, minWidth: 180, padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1' }}
                  />
                  <button
                    type="button"
                    onClick={() => void handleTelegramChatIdConfirm()}
                    style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 700 }}
                  >
                    تأكيد وحفظ
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTelegramSettingsModal(false)}
                    style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a', fontWeight: 700 }}
                  >
                    إغلاق
                  </button>
                </div>
              </div>
            )}
            <div className="detail-item">
              <div className="detail-label">رقم الهاتف</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['رقم الهاتف'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">البريد الإلكتروني</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['البريد الإلكتروني'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">نوع التسجيل</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['نوع التسجيل'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">تاريخ الإنشاء</div>
              <div className="detail-value">{formatDate(loggedStudent?.['تاريخ الإنشاء'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">تاريخ تغيير الفئة</div>
              <div className="detail-value">{formatDate(loggedStudent?.['تاريخ_تغيير_الفئة'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">ملاحظة</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['ملاحظة'])}</div>
            </div>
          </div>

          <div className="tabs-container">
            <div className="tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  className={`tab ${activeTab === tab.key ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.key);
                    writeAuditLog({
                      action: 'student_tab_opened',
                      userType: 'student',
                      userId: loggedStudent?.['الرقم الجامعي'],
                      username: studentFullName,
                      fullName: studentFullName,
                      details: { tab: tab.key },
                    });
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === 'grades' && (
              <div className="tab-content active">
                {grades.length === 0 ? (
                  <div className="no-data">
                    <i className="fa-solid fa-table-list" />
                    <div>لا توجد بيانات للعلامات حتى الآن.</div>
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>المادة</th>
                        <th>أعمال السنة</th>
                        <th>نظري</th>
                        <th>عملي</th>
                        <th>المجموع</th>
                        <th>مساعدة امتحانية</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grades.map((item) => (
                        <tr key={item.subject}>
                          <td>{item.subject}</td>
                          <td>{item.annual ?? '—'}</td>
                          <td>{item.theory ?? '—'}</td>
                          <td>{item.practical ?? '—'}</td>
                          <td>{item.total ?? '—'}</td>
                          <td>{item.assistance}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {activeTab === 'record' && (
              <div className="tab-content active">
                {warnings.length === 0 ? (
                  <div className="no-data">
                    <i className="fa-solid fa-clipboard-list" />
                    <div>لا يوجد سجل للطالب في الوقت الحالي.</div>
                  </div>
                ) : (
                  <div className="warning-list">
                    {teacherAlertLoadError && <p className="teacher-alert-load-error" role="status">{teacherAlertLoadError}</p>}
                    {warnings.map((warning, index) => (
                      <div
                        key={`${warning['الرقم الجامعي'] ?? 'warning'}-${index}`}
                        className={`warning-item${warning['مصدر التنبيه'] === 'teacher' ? ' teacher-alert-warning' : ''}`}
                      >
                        <div className="warning-header">
                          <strong>{normalizeText(getValueByKeys(warning, ['نوع الإنذار']))}</strong>
                          <span className="warning-type">{normalizeText(getValueByKeys(warning, ['السبب']))}</span>
                        </div>
                        <div className="warning-reason">{normalizeText(getValueByKeys(warning, ['التفاصيل']))}</div>
                      </div>
                    ))}
                  </div>
                )}
                {warnings.length === 0 && teacherAlertLoadError && <p className="teacher-alert-load-error" role="status">{teacherAlertLoadError}</p>}

              </div>
            )}

            {activeTab === 'schedule' && (
              <div className="tab-content active">
                <div style={{ display: 'grid', gap: 18 }}>
                  {scheduleDays.map((day) => {
                    const dayItems = scheduleItems
                      .filter((item) => item.day === day)
                      .sort((first, second) => first.start_time.localeCompare(second.start_time));

                    return (
                      <section key={day} style={{ display: 'grid', gap: 10 }}>
                        <h3 style={{ margin: 0, paddingBottom: 8, borderBottom: '2px solid #e2e8f0', color: '#0f172a', fontSize: 17 }}>
                          {day}
                        </h3>
                        {dayItems.length === 0 ? (
                          <div style={{ padding: '12px 14px', borderRadius: 10, background: '#f8fafc', color: '#64748b', fontSize: 14 }}>
                            لا توجد محاضرات مسجلة
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 }}>
                            {dayItems.map((item) => {
                              const isPractical = item.type.trim() === 'عملي';
                              return (
                                <article
                                  key={item.id}
                                  style={{
                                    padding: 14,
                                    borderRadius: 12,
                                    border: `1px solid ${isPractical ? '#f4c77b' : '#a8c9ed'}`,
                                    background: isPractical ? '#fff8e8' : '#eff7ff',
                                  }}
                                >
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                                    <strong style={{ color: '#0f172a', lineHeight: 1.6 }}>{item.subject}</strong>
                                    <span style={{ color: isPractical ? '#9a5b0a' : '#2563a8', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                      {isPractical ? 'عملي' : 'نظري'}
                                    </span>
                                  </div>
                                  <div style={{ marginTop: 10, color: '#334155', fontSize: 14 }}>
                                    {formatScheduleTime(item.start_time)} - {formatScheduleTime(item.end_time)}
                                  </div>
                                  <div style={{ marginTop: 5, color: '#64748b', fontSize: 13 }}>
                                    {item.location || 'القاعة غير محددة'}
                                    {item.group_name ? ` · المجموعة ${item.group_name}` : ''}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'status' && (
              <div className="tab-content active">
                <div className="status-grid">
                  <div className="status-card">
                    <div className="status-icon"><i className="fa-solid fa-check-circle" /></div>
                    <div className="status-title">الحالة الدراسية</div>
                    <div className="status-data">{studentStatus}</div>
                  </div>
                  <div className="status-card">
                    <div className="status-icon"><i className="fa-solid fa-user-check" /></div>
                    <div className="status-title">الفئة</div>
                    <div className="status-data">{formatStudentValue(loggedStudent?.['الفئة'])}</div>
                  </div>
                  <div className="status-card">
                    <div className="status-icon"><i className="fa-solid fa-calendar-days" /></div>
                    <div className="status-title">السنة الدراسية</div>
                    <div className="status-data">{formatStudentValue(loggedStudent?.['السنه الدراسية'])}</div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'skills' && (
              <div className="tab-content active student-skills-panel">
                <div className="student-skills-heading">
                  <div>
                    <h2>مهاراتي</h2>
                    <p>اختر حتى ثلاث مهارات، ويمكنك تعديلها لاحقاً.</p>
                  </div>
                  {!isEditingSkills && studentSkills.length > 0 && (
                    <button
                      type="button"
                      className="student-skills-edit"
                      onClick={() => {
                        setSkillDrafts(studentSkills.map((skill) => ({ ...skill })));
                        setIsEditingSkills(true);
                      }}
                    >
                      تعديل المهارات
                    </button>
                  )}
                </div>

                {skillsMessage && <p className="student-skills-message" role="status">{skillsMessage}</p>}

                {!isEditingSkills && studentSkills.length > 0 ? (
                  <div className="student-skills-list">
                    {studentSkills.map((skill) => (
                      <article className="student-skill-item" key={skill.category}>
                        <strong>{skill.category}</strong>
                        {skill.detail && <span>{skill.detail}</span>}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="student-skills-editor">
                    <div className="student-skills-options" aria-label="خيارات المهارات">
                      {skillCategories.map((category) => {
                        const selected = skillDrafts.some((skill) => skill.category === category);
                        return (
                          <button
                            type="button"
                            key={category}
                            className={`student-skill-option${selected ? ' selected' : ''}`}
                            aria-pressed={selected}
                            onClick={() => toggleSkillCategory(category)}
                          >
                            <span className="student-skill-check" aria-hidden="true">{selected ? '✓' : '+'}</span>
                            {category}
                          </button>
                        );
                      })}
                    </div>
                    <div className="student-skills-count">المحدد: {skillDrafts.length} من 3</div>

                    {skillDrafts.filter((skill) => ['رياضة', 'أخرى'].includes(skill.category)).map((skill) => (
                      <label className="student-skill-detail" key={skill.category}>
                        <span>{skill.category === 'رياضة' ? 'نوع الرياضة' : 'اكتب مهارتك'}</span>
                        {skill.category === 'رياضة' && (
                          <select
                            value={sportTypes.includes(skill.detail) ? skill.detail : ''}
                            onChange={(event) => updateSkillDetail(skill.category, event.target.value)}
                          >
                            <option value="">اختر نوع الرياضة</option>
                            {sportTypes.filter((sport) => sport !== 'رياضة أخرى').map((sport) => <option key={sport} value={sport}>{sport}</option>)}
                          </select>
                        )}
                        <input
                          type="text"
                          value={skill.category === 'رياضة' && sportTypes.includes(skill.detail) ? '' : skill.detail}
                          onChange={(event) => updateSkillDetail(skill.category, event.target.value)}
                          placeholder={skill.category === 'رياضة' ? 'أو اكتب نوع رياضة آخر' : 'مثال: العزف على العود'}
                          maxLength={80}
                          required={skill.category === 'أخرى'}
                        />
                      </label>
                    ))}

                    <div className="student-skills-actions">
                      {studentSkills.length > 0 && (
                        <button type="button" className="student-skills-cancel" onClick={() => setIsEditingSkills(false)}>
                          إلغاء
                        </button>
                      )}
                      <button
                        type="button"
                        className="student-skills-save"
                        onClick={() => void saveStudentSkills()}
                        disabled={isSavingSkills || skillDrafts.length === 0}
                      >
                        {isSavingSkills ? 'جارٍ الحفظ...' : 'حفظ المهارات'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>

          <div className="last-updated">آخر تحديث للنظام: {formatDate(loggedStudent?.['تاريخ_تغيير_الفئة'])}</div>

          <div className="student-footer-actions">
            <button className="logout-button" type="button" onClick={logout}>تسجيل الخروج</button>
          </div>
        </div>

        {teacherEvaluationGateOpen && (
          <div className="teacher-evaluation-gate-backdrop">
            <section className="teacher-evaluation-gate" role="dialog" aria-modal="true" aria-labelledby="teacher-evaluation-gate-title">
              <header className="teacher-evaluation-gate-header">
                <span className="teacher-evaluation-kicker">إجراء مطلوب قبل متابعة حسابك</span>
                <h2 id="teacher-evaluation-gate-title">تقييم المدرسين</h2>
                <p>يرجى تقييم كل مدرس في المقررات التي شرحها. لن تتمكن من استخدام صفحة الطالب قبل حفظ جميع التقييمات.</p>
                {teacherEvaluationReady && !teacherEvaluationError && teacherEvaluationTasks.length > 0 && (
                  <div className="teacher-evaluation-progress" role="status">
                    اكتمل {teacherEvaluationTasks.length - pendingTeacherEvaluationCount} من {teacherEvaluationTasks.length} مقررات
                  </div>
                )}
              </header>

              <div className="teacher-evaluation-gate-content">
                {!teacherEvaluationReady || teacherEvaluationLoading ? (
                  <div className="teacher-evaluation-gate-status" role="status">جارٍ تحميل المدرسين ومقرراتهم...</div>
                ) : teacherEvaluationError ? (
                  <div className="teacher-evaluation-gate-error" role="alert">
                    <p>{teacherEvaluationError}</p>
                    <button type="button" className="logout-button" onClick={logout}>تسجيل الخروج</button>
                  </div>
                ) : (
                  <div className="teacher-evaluation-gate-list">
                    {teachers.map((teacher) => (
                      <article className="teacher-evaluation-gate-teacher" key={teacher.id}>
                        <h3>{teacher.name}</h3>
                        {teacher.subjects.map((subject) => {
                          const key = getTeacherRatingKey(teacher.id, subject);
                          const selectedRating = teacherRatingDrafts[key];
                          const savedRating = savedTeacherRatings[key];
                          const currentNote = teacherRatingNotes[key] ?? '';
                          const savedNote = savedTeacherNotes[key] ?? '';
                          const isSaving = savingTeacherRatingKey === key;
                          const unchanged = savedRating === selectedRating && savedNote === currentNote;

                          return (
                            <div className="teacher-evaluation-gate-subject" key={key}>
                              <div className="teacher-evaluation-gate-subject-title">
                                <strong>{subject}</strong>
                                {savedRating !== undefined && <span>تم الحفظ</span>}
                              </div>
                              <div className="teacher-rating-options" role="group" aria-label={`تقييم ${teacher.name} في ${subject}`}>
                                {teacherRatingOptions.map((option) => (
                                  <button
                                    type="button"
                                    key={option.value}
                                    className={selectedRating === option.value ? 'is-selected' : ''}
                                    aria-pressed={selectedRating === option.value}
                                    onClick={() => setTeacherRatingDrafts((current) => ({ ...current, [key]: option.value }))}
                                  >
                                    {option.label}
                                  </button>
                                ))}
                              </div>
                              <label className="teacher-evaluation-note">
                                <span>ملاحظة (اختياري)</span>
                                <textarea
                                  value={currentNote}
                                  maxLength={1000}
                                  rows={2}
                                  onChange={(event) => setTeacherRatingNotes((current) => ({ ...current, [key]: event.target.value }))}
                                  placeholder="اكتب ملاحظتك عن شرح المقرر"
                                />
                              </label>
                              <button
                                type="button"
                                className="teacher-rating-save"
                                disabled={selectedRating === undefined || isSaving || unchanged}
                                onClick={() => void saveTeacherRating(teacher, subject)}
                              >
                                {isSaving ? 'جارٍ الحفظ...' : savedRating !== undefined ? 'تحديث التقييم' : 'حفظ التقييم'}
                              </button>
                            </div>
                          );
                        })}
                      </article>
                    ))}
                  </div>
                )}
                {teacherRatingNotice && <p className="teacher-evaluation-gate-notice" role="status">{teacherRatingNotice}</p>}
              </div>

              <footer className="teacher-evaluation-confidentiality">
                <strong>تقييماتك سرية للغاية، لا داعي للقلق.</strong>
                <span>لن تظهر للطلاب الآخرين، ويمكن للمشرفين المخوّلين الاطلاع عليها لتحسين العملية التعليمية.</span>
              </footer>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
