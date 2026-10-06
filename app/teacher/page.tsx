'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, CalendarDays, Download, LogOut, RefreshCw, Trash2, UserRound, Users, X } from 'lucide-react';
import { writeAuditLog } from '../../lib/auditLog';

const rememberedTeacherUsernameKey = 'udti-remembered-teacher-username';
const rememberedTeacherPasswordKey = 'udti-remembered-teacher-password';

type Teacher = {
  id: string;
  name: string;
  subjects: string[];
};

type Student = {
  id: string;
  fullName: string;
  avatarUrl: string;
  className: string;
  phone: string;
  year: string;
};

type AttendanceRecord = {
  id: string;
  studentId: string;
  subject: string;
  status: string;
  date: string;
  details: string;
  className: string;
};

type TeacherAlert = {
  id: number;
  student_id: string;
  subject: string;
  message: string;
  created_at: string;
};

const getAttendanceStatus = (status: string) => {
  const value = status.trim().toLowerCase();
  if (value === 'حاضر' || value === 'present') return 'present';
  if (value === 'غائب' || value === 'absent') return 'absent';
  return 'other';
};

const formatDate = (value: string) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ar-SY');
};

const normalizeClassName = (value: string) => {
  const normalized = value.trim().replace(/^فئة\s*/i, '');
  return !normalized || ['—', '-', 'غير محدد', 'بدون فئة', 'بلا فئة'].includes(normalized)
    ? 'بلا فئة'
    : normalized;
};

const compareStudentsByName = (first: Student, second: Student) =>
  first.fullName.localeCompare(second.fullName, 'ar', { sensitivity: 'base' })
  || first.id.localeCompare(second.id, 'ar');

export default function TeacherPortalPage() {
  const [loginDraft, setLoginDraft] = useState({ username: '', password: '' });
  const [rememberCredentials, setRememberCredentials] = useState(false);
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [teacher, setTeacher] = useState<Teacher | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [alerts, setAlerts] = useState<TeacherAlert[]>([]);
  const [selectedSubject, setSelectedSubject] = useState('');
  const [search, setSearch] = useState('');
  const [selectedClass, setSelectedClass] = useState('__all__');
  const [studentView, setStudentView] = useState<'cards' | 'table'>('cards');
  const [selectedStudentPhoto, setSelectedStudentPhoto] = useState<{ url: string; name: string } | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const alertMessageRef = useRef<HTMLTextAreaElement>(null);
  const [loading, setLoading] = useState(false);
  const [exportingStudents, setExportingStudents] = useState(false);
  const [savingAlert, setSavingAlert] = useState(false);
  const [deletingAlertId, setDeletingAlertId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ message: string; type: 'error' | 'success' } | null>(null);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const welcomeTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const username = window.localStorage.getItem(rememberedTeacherUsernameKey);
    const password = window.localStorage.getItem(rememberedTeacherPasswordKey);
    if (username && password) {
      setLoginDraft({ username, password });
      setRememberCredentials(true);
    }
  }, []);

  useEffect(() => () => {
    if (welcomeTimeoutRef.current !== null) window.clearTimeout(welcomeTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!selectedStudentPhoto) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedStudentPhoto(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedStudentPhoto]);

  const request = async (payload: Record<string, unknown>) => {
    const response = await fetch('/api/teacher-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as {
      success?: boolean;
      error?: string;
      teacher?: Teacher;
      students?: Student[];
      attendance?: AttendanceRecord[];
      alerts?: TeacherAlert[];
      alert?: TeacherAlert;
    };
    if (!response.ok || !result.success) {
      const messages: Record<string, string> = {
        'teacher-portal-server-key-missing': 'خدمة حسابات المدرسين غير مهيأة على الخادم.',
        'teacher-credentials-invalid': 'اسم المستخدم أو كلمة المرور غير صحيحة أو الحساب غير فعال.',
        'teacher-dashboard-load-failed': 'تعذر تحميل بيانات الطلاب والحضور.',
        'teacher-subjects-load-failed': 'تعذر تحميل المواد المسندة. تأكد من تشغيل ملف إدارة الفئات والبرنامج.',
        'teacher-alert-save-failed': 'تعذر حفظ التنبيه.',
        'teacher-alert-delete-failed': 'تعذر حذف التنبيه.',
        'teacher-alert-not-found': 'لم يتم العثور على التنبيه أو لا تملك صلاحية حذفه.',
        'student-year-mismatch': 'لا يمكن إرسال تنبيه لطالب من سنة دراسية مختلفة عن المادة.',
      };
      throw new Error(messages[result.error ?? ''] ?? 'حدث خطأ أثناء تنفيذ الطلب. حاول مرة أخرى.');
    }
    return result;
  };

  const loadDashboard = async (username: string, password: string) => {
    const result = await request({ action: 'dashboard', username, password });
    const nextTeacher = result.teacher ?? null;
    setTeacher(nextTeacher);
    setStudents(result.students ?? []);
    setAttendance(result.attendance ?? []);
    setAlerts(result.alerts ?? []);
    setSelectedSubject((current) => current && nextTeacher?.subjects.includes(current)
      ? current
      : nextTeacher?.subjects[0] ?? '');
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setNotice(null);
    const username = loginDraft.username.trim();
    const password = loginDraft.password;
    try {
      const result = await request({ action: 'login', username, password });
      if (!result.teacher) throw new Error('تعذر تحميل بيانات حساب المدرس.');
      setCredentials({ username, password });
      await loadDashboard(username, password);
      writeAuditLog({
        action: 'teacher_login',
        userType: 'teacher',
        userId: result.teacher.id,
        username,
        fullName: result.teacher.name,
      });
      if (rememberCredentials) {
        window.localStorage.setItem(rememberedTeacherUsernameKey, username);
        window.localStorage.setItem(rememberedTeacherPasswordKey, password);
        setLoginDraft({ username, password });
      } else {
        window.localStorage.removeItem(rememberedTeacherUsernameKey);
        window.localStorage.removeItem(rememberedTeacherPasswordKey);
      }
      if (welcomeTimeoutRef.current !== null) window.clearTimeout(welcomeTimeoutRef.current);
      const welcome = `أهلاً بالدكتور ${result.teacher.name}`;
      setWelcomeMessage(welcome);
      welcomeTimeoutRef.current = window.setTimeout(() => {
        setWelcomeMessage((current) => current === welcome ? '' : current);
        welcomeTimeoutRef.current = null;
      }, 4000);
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر تسجيل الدخول.', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const refreshDashboard = async () => {
    if (!credentials.username) return;
    setLoading(true);
    setNotice(null);
    try {
      await loadDashboard(credentials.username, credentials.password);
      setNotice({ message: 'تم تحديث البيانات.', type: 'success' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر تحديث البيانات.', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const currentAttendance = useMemo(
    () => attendance.filter((record) => record.subject === selectedSubject),
    [attendance, selectedSubject]
  );
  const subjectYearSeparator = selectedSubject.lastIndexOf(' · ');
  const selectedSubjectYear = subjectYearSeparator >= 0 ? selectedSubject.slice(subjectYearSeparator + 3) : '';
  const studentsForSubject = useMemo(
    () => students
      .filter((student) => selectedSubjectYear && student.year === selectedSubjectYear)
      .sort(compareStudentsByName),
    [students, selectedSubjectYear]
  );
  const studentClasses = useMemo(
    () => [...new Set(studentsForSubject.map((student) => normalizeClassName(student.className)))].sort((first, second) => first.localeCompare(second, 'ar')),
    [studentsForSubject]
  );
  const visibleStudents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const studentIds = new Set(currentAttendance.map((record) => record.studentId));
    return studentsForSubject.filter((student) => {
      if (selectedClass === '__unassigned__' && normalizeClassName(student.className) !== 'بلا فئة') return false;
      if (selectedClass !== '__all__' && selectedClass !== '__unassigned__' && normalizeClassName(student.className) !== selectedClass) return false;
      if (!query) return true;
      return [student.fullName, student.id, student.className, student.phone, student.year]
        .some((value) => value.toLocaleLowerCase().includes(query));
    }).map((student) => {
      const studentRecords = currentAttendance.filter((record) => record.studentId === student.id);
      return {
        ...student,
        presentCount: studentRecords.filter((record) => getAttendanceStatus(record.status) === 'present').length,
        absentCount: studentRecords.filter((record) => getAttendanceStatus(record.status) === 'absent').length,
        hasAttendance: studentIds.has(student.id),
      };
    });
  }, [studentsForSubject, currentAttendance, search, selectedClass]);
  const studentsForAlert = useMemo(
    () => studentsForSubject,
    [studentsForSubject]
  );
  const visibleAlerts = useMemo(
    () => alerts.filter((alert) => alert.subject === selectedSubject),
    [alerts, selectedSubject]
  );
  const sortedVisibleStudents = useMemo(
    () => visibleStudents.slice().sort(compareStudentsByName),
    [visibleStudents]
  );

  const exportStudents = async () => {
    if (!visibleStudents.length) return;
    setExportingStudents(true);
    try {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'بوابة المدرسين - المعهد التقاني لطب الأسنان';
      workbook.created = new Date();
      workbook.modified = new Date();

      const worksheet = workbook.addWorksheet('قائمة الطلاب', {
        views: [{ state: 'frozen', ySplit: 1, rightToLeft: true }],
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
      });
      worksheet.columns = [
        { header: 'رقم التسلسل', key: 'sequence', width: 14 },
        { header: 'اسم الطالب الكامل', key: 'fullName', width: 30 },
        { header: 'الرقم الجامعي', key: 'studentId', width: 18, style: { numFmt: '@' } },
        { header: 'رقم الموبايل', key: 'phone', width: 20, style: { numFmt: '@' } },
        { header: 'الفئة', key: 'className', width: 14 },
        { header: 'عنوان المادة', key: 'subject', width: 30 },
        { header: 'السنة الدراسية', key: 'year', width: 16 },
        { header: 'حضور المادة', key: 'presentCount', width: 15 },
        { header: 'غياب المادة', key: 'absentCount', width: 15 },
      ];

      const subjectName = selectedSubject.split(' · ')[0] || selectedSubject;
      worksheet.addRows(sortedVisibleStudents.map((student, index) => ({
        sequence: index + 1,
        fullName: student.fullName || 'غير مسجل',
        studentId: student.id,
        phone: student.phone || '',
        className: normalizeClassName(student.className),
        subject: subjectName,
        year: student.year,
        presentCount: student.presentCount,
        absentCount: student.absentCount,
      })));

      const header = worksheet.getRow(1);
      header.height = 30;
      header.eachCell((cell) => {
        cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = { bottom: { style: 'medium', color: { argb: 'FF0B5F59' } } };
      });

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.height = 24;
        row.eachCell((cell) => {
          cell.font = { name: 'Arial', size: 11, color: { argb: 'FF1F2937' } };
          cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
          cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
          if (rowNumber % 2 === 0) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F7F6' } };
          }
        });
      });
      worksheet.autoFilter = { from: 'A1', to: 'I1' };

      const workbookBuffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([workbookBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const fileSafeName = `${selectedSubject}-${selectedClass === '__all__' ? 'كل-الفئات' : selectedClass === '__unassigned__' ? 'بلا-فئة' : selectedClass}`
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/\s+/g, '-');
      link.href = blobUrl;
      link.download = `${fileSafeName || 'طلاب'}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      setNotice({ message: `تم تنزيل ملف Excel منسق يتضمن ${visibleStudents.length} طالبًا.`, type: 'success' });
    } catch (error) {
      console.error('Teacher Excel export failed:', error);
      setNotice({ message: 'تعذر إنشاء ملف Excel. حاول تحديث الصفحة ثم أعد المحاولة.', type: 'error' });
    } finally {
      setExportingStudents(false);
    }
  };

  const submitAlert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedStudentId || !selectedSubject || alertMessage.trim().length < 3) return;
    setSavingAlert(true);
    setNotice(null);
    try {
      const result = await request({
        action: 'add-alert',
        ...credentials,
        studentId: selectedStudentId,
        subject: selectedSubject,
        message: alertMessage.trim(),
      });
      if (result.alert) setAlerts((current) => [result.alert as TeacherAlert, ...current]);
      writeAuditLog({
        action: 'teacher_alert_created',
        userType: 'teacher',
        userId: teacher?.id,
        username: credentials.username,
        fullName: teacher?.name,
        details: { studentId: selectedStudentId, subject: selectedSubject },
      });
      setAlertMessage('');
      setSelectedStudentId('');
      setNotice({ message: 'تم إرسال التنبيه وسيظهر للطالب باللون الأصفر.', type: 'success' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر إرسال التنبيه.', type: 'error' });
    } finally {
      setSavingAlert(false);
    }
  };

  const selectStudentForAlert = (studentId: string) => {
    setSelectedStudentId(studentId);
    alertMessageRef.current?.focus();
  };

  const deleteAlert = async (alertId: number) => {
    setDeletingAlertId(alertId);
    setNotice(null);
    try {
      await request({ action: 'delete-alert', ...credentials, alertId });
      const deletedAlert = alerts.find((alert) => alert.id === alertId);
      setAlerts((current) => current.filter((alert) => alert.id !== alertId));
      writeAuditLog({
        action: 'teacher_alert_deleted',
        userType: 'teacher',
        userId: teacher?.id,
        username: credentials.username,
        fullName: teacher?.name,
        details: { alertId, studentId: deletedAlert?.student_id, subject: deletedAlert?.subject },
      });
      setNotice({ message: 'تم حذف التنبيه.', type: 'success' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر حذف التنبيه.', type: 'error' });
    } finally {
      setDeletingAlertId(null);
    }
  };

  const logout = () => {
    writeAuditLog({
      action: 'teacher_logout',
      userType: 'teacher',
      userId: teacher?.id,
      username: credentials.username,
      fullName: teacher?.name,
    });
    if (welcomeTimeoutRef.current !== null) {
      window.clearTimeout(welcomeTimeoutRef.current);
      welcomeTimeoutRef.current = null;
    }
    setWelcomeMessage('');
    setTeacher(null);
    setCredentials({ username: '', password: '' });
    if (!rememberCredentials) setLoginDraft({ username: '', password: '' });
    setStudents([]);
    setAttendance([]);
    setAlerts([]);
    setNotice(null);
  };

  return (
    <main className="teacher-portal" dir="rtl">
      <div className="teacher-portal-container">
        <header className="teacher-portal-header">
          <div>
            <span className="teacher-portal-kicker">المعهد التقاني لطب الأسنان · جامعة اللاذقية</span>
            <h1>{teacher ? `أهلًا ${teacher.name}` : 'بوابة المدرسين'}</h1>
            <p>{teacher ? 'بيانات طلابك وسجل الحضور والتنبيهات الخاصة بمقرراتك.' : 'سجّل الدخول لعرض الطلاب وحضور مقرراتك.'}</p>
          </div>
          <div className="teacher-portal-header-actions">
            <Link href="/dashboard" className="teacher-portal-link">لوحة التحكم</Link>
            {teacher && (
              <>
                <button type="button" className="teacher-portal-icon-button" onClick={() => void refreshDashboard()} disabled={loading} aria-label="تحديث البيانات">
                  <RefreshCw size={17} aria-hidden="true" />
                </button>
                <button type="button" className="teacher-portal-link" onClick={logout}>
                  <LogOut size={16} aria-hidden="true" /> تسجيل الخروج
                </button>
              </>
            )}
          </div>
        </header>

        {welcomeMessage && <div className="teacher-portal-notice welcome" role="status">{welcomeMessage}</div>}
        {notice && <div className={`teacher-portal-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.message}</div>}

        {!teacher ? (
          <section className="teacher-login-card">
            <div className="teacher-login-icon"><BookOpen size={25} aria-hidden="true" /></div>
            <h2>تسجيل دخول المدرس</h2>
            <p>بيانات الدخول يجهزها مشرف النظام.</p>
            <form onSubmit={handleLogin}>
              <label>
                <span>اسم المستخدم</span>
                <input
                  value={loginDraft.username}
                  onChange={(event) => setLoginDraft((current) => ({ ...current, username: event.target.value }))}
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                <span>كلمة المرور</span>
                <input
                  type="password"
                  value={loginDraft.password}
                  onChange={(event) => setLoginDraft((current) => ({ ...current, password: event.target.value }))}
                  autoComplete="current-password"
                  required
                />
              </label>
              <label className="teacher-remember-credentials">
                <input
                  type="checkbox"
                  checked={rememberCredentials}
                  onChange={(event) => {
                    const shouldRemember = event.target.checked;
                    setRememberCredentials(shouldRemember);
                    if (!shouldRemember) {
                      window.localStorage.removeItem(rememberedTeacherUsernameKey);
                      window.localStorage.removeItem(rememberedTeacherPasswordKey);
                    }
                  }}
                />
                <span>تذكر اسم المستخدم وكلمة المرور</span>
              </label>
              <button type="submit" disabled={loading}>{loading ? 'جارٍ التحقق...' : 'دخول المدرس'}</button>
            </form>
          </section>
        ) : (
          <>
            <section className="teacher-subject-selector">
              <label htmlFor="teacher-subject">المادة</label>
              <select id="teacher-subject" value={selectedSubject} onChange={(event) => {
                setSelectedSubject(event.target.value);
                setSelectedStudentId('');
                setSelectedClass('__all__');
              }}>
                {teacher.subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select>
              <span><BookOpen size={16} aria-hidden="true" /> تظهر هنا سجلات المادة المختارة فقط</span>
            </section>

            <section className="teacher-stats-grid" aria-label="ملخص المادة">
              <article><Users size={20} aria-hidden="true" /><span>طلاب الفئة المحددة</span><strong>{visibleStudents.length}</strong></article>
              <article><span className="teacher-status-dot present" /><span>سجلات الحضور</span><strong>{currentAttendance.filter((record) => getAttendanceStatus(record.status) === 'present').length}</strong></article>
              <article><span className="teacher-status-dot absent" /><span>سجلات الغياب</span><strong>{currentAttendance.filter((record) => getAttendanceStatus(record.status) === 'absent').length}</strong></article>
              <article><AlertTriangle size={20} aria-hidden="true" /><span>تنبيهات المادة</span><strong>{visibleAlerts.length}</strong></article>
            </section>

            <section className="teacher-panel">
              <div className="teacher-panel-heading">
                <div><h2>قائمة الطلاب</h2><p>ابحث عن طالب، أو اعرض فئة محددة ونزّلها كجدول متوافق مع Excel.</p></div>
              </div>
              <div className="teacher-student-tools">
                <label className="teacher-student-search">
                  <span>بحث بالاسم أو الرقم الجامعي أو الموبايل</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="اكتب اسم الطالب أو رقمه..." aria-label="بحث عن طالب" />
                </label>
                <label className="teacher-class-filter">
                  <span>تصفية حسب الفئة</span>
                  <select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>
                    <option value="__all__">كل الفئات</option>
                    {studentClasses.includes('بلا فئة') && <option value="__unassigned__">بلا فئة</option>}
                    {studentClasses.filter((className) => className !== 'بلا فئة').map((className) => <option key={className} value={className}>{className}</option>)}
                  </select>
                </label>
                <button type="button" className="teacher-export-button" onClick={() => void exportStudents()} disabled={!visibleStudents.length || exportingStudents}>
                  <Download size={17} aria-hidden="true" />
                  {exportingStudents ? 'جارٍ تجهيز الملف...' : `تنزيل Excel (${visibleStudents.length})`}
                </button>
              </div>
              <div className="teacher-student-view-toggle" role="group" aria-label="طريقة عرض الطلاب">
                <button
                  type="button"
                  className={studentView === 'cards' ? 'is-active' : ''}
                  onClick={() => setStudentView('cards')}
                  aria-pressed={studentView === 'cards'}
                >
                  كل طالب بمفرده
                </button>
                <button
                  type="button"
                  className={studentView === 'table' ? 'is-active' : ''}
                  onClick={() => setStudentView('table')}
                  aria-pressed={studentView === 'table'}
                >
                  عرض كجدول
                </button>
              </div>
              <div className={`teacher-table-wrap${studentView === 'table' ? ' is-active' : ''}`}>
                <table className="teacher-table">
                  <thead><tr><th>الطالب</th><th>الرقم الجامعي</th><th>الفئة</th><th>رقم الموبايل</th><th>السنة</th><th>حضور المادة</th><th>غياب المادة</th><th>إجراء</th></tr></thead>
                  <tbody>
                    {sortedVisibleStudents.map((student) => (
                      <tr key={student.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              {student.avatarUrl ? (
                                <button
                                  type="button"
                                  onClick={() => setSelectedStudentPhoto({
                                    url: student.avatarUrl,
                                    name: student.fullName || student.id,
                                  })}
                                  aria-label={`تكبير صورة ${student.fullName || student.id}`}
                                  style={{ padding: 0, border: 0, borderRadius: '50%', background: 'none', cursor: 'zoom-in', lineHeight: 0 }}
                                >
                                  <img
                                    src={student.avatarUrl}
                                    alt={`صورة ${student.fullName || student.id}`}
                                    loading="lazy"
                                    style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                                  />
                                </button>
                              ) : (
                                <span
                                  role="img"
                                  aria-label="لا توجد صورة شخصية"
                                  style={{ width: 40, height: 40, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                                >
                                  <UserRound size={20} aria-hidden="true" />
                                </span>
                              )}
                              <span>{student.fullName || 'غير مسجل'}</span>
                            </div>
                          </td><td>{student.id}</td><td>{student.className}</td><td dir="ltr">{student.phone || '—'}</td><td>{student.year}</td>
                        <td><span className="teacher-count present">{student.presentCount}</span></td>
                        <td><span className="teacher-count absent">{student.absentCount}</span></td>
                        <td>
                          <button
                            type="button"
                            className="teacher-student-alert-action"
                            onClick={() => selectStudentForAlert(student.id)}
                            aria-label={`إضافة تنبيه للطالب ${student.fullName || student.id}`}
                          >
                            <AlertTriangle size={15} aria-hidden="true" />
                            تنبيه
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!visibleStudents.length && <tr><td colSpan={8} className="teacher-empty">لا يوجد طلاب مطابقون للبحث والفئة المحددة.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className={`teacher-mobile-students${studentView === 'cards' ? ' is-active' : ''}`}>
                {sortedVisibleStudents.map((student) => (
                  <article className="teacher-mobile-student" key={student.id}>
                    <div className="teacher-mobile-student-heading">
                      {student.avatarUrl ? (
                        <button
                          type="button"
                          className="teacher-mobile-student-avatar-button"
                          onClick={() => setSelectedStudentPhoto({
                            url: student.avatarUrl,
                            name: student.fullName || student.id,
                          })}
                          aria-label={`تكبير صورة ${student.fullName || student.id}`}
                        >
                          <img
                            src={student.avatarUrl}
                            alt={`صورة ${student.fullName || student.id}`}
                            loading="lazy"
                          />
                        </button>
                      ) : (
                        <span className="teacher-mobile-student-avatar-placeholder" role="img" aria-label="لا توجد صورة شخصية">
                          <UserRound size={21} aria-hidden="true" />
                        </span>
                      )}
                      <div className="teacher-mobile-student-name">
                        <strong>{student.fullName || 'غير مسجل'}</strong>
                        <span dir="ltr">{student.id}</span>
                      </div>
                    </div>
                    <dl className="teacher-mobile-student-details">
                      <div><dt>الفئة</dt><dd>{student.className}</dd></div>
                      <div><dt>الموبايل</dt><dd dir="ltr">{student.phone || '—'}</dd></div>
                      <div><dt>السنة</dt><dd>{student.year}</dd></div>
                    </dl>
                    <div className="teacher-mobile-student-footer">
                      <span>حضور <b className="teacher-count present">{student.presentCount}</b></span>
                      <span>غياب <b className="teacher-count absent">{student.absentCount}</b></span>
                      <button
                        type="button"
                        className="teacher-student-alert-action"
                        onClick={() => selectStudentForAlert(student.id)}
                        aria-label={`إضافة تنبيه للطالب ${student.fullName || student.id}`}
                      >
                        <AlertTriangle size={15} aria-hidden="true" />
                        تنبيه
                      </button>
                    </div>
                  </article>
                ))}
                {!sortedVisibleStudents.length && (
                  <p className="teacher-empty">لا يوجد طلاب مطابقون للبحث والفئة المحددة.</p>
                )}
              </div>
            </section>

            <section className="teacher-panel">
              <div className="teacher-panel-heading">
                <div><h2>سجل الحضور والغياب</h2><p>السجلات المعروضة تخص مادة {selectedSubject} فقط.</p></div>
                <CalendarDays size={20} aria-hidden="true" />
              </div>
              <div className="teacher-record-list">
                {currentAttendance.length ? currentAttendance
                  .slice()
                  .sort((first, second) => second.date.localeCompare(first.date))
                  .map((record) => {
                    const student = students.find((item) => item.id === record.studentId);
                    const status = getAttendanceStatus(record.status);
                    return (
                      <article className="teacher-record" key={record.id}>
                        <strong>{student?.fullName || record.studentId}</strong>
                        <span>الرقم الجامعي: {record.studentId}</span>
                        <span>الفئة: {record.className}</span>
                        <time>{formatDate(record.date)}</time>
                        <b className={`teacher-record-status ${status}`}>{record.status}</b>
                        {record.details && <small>{record.details}</small>}
                      </article>
                    );
                  }) : <p className="teacher-empty">لا توجد سجلات حضور أو غياب لهذه المادة بعد.</p>}
              </div>
            </section>

            <section className="teacher-panel teacher-alert-panel">
              <div className="teacher-panel-heading">
                <div><h2>تنبيه طالب</h2><p>سيظهر التنبيه في سجل الطالب بخلفية صفراء.</p></div>
                <AlertTriangle size={20} aria-hidden="true" />
              </div>
              <form className="teacher-alert-form" onSubmit={submitAlert}>
                <label><span>الطالب</span>
                  <select value={selectedStudentId} onChange={(event) => setSelectedStudentId(event.target.value)} required>
                    <option value="">اختر الطالب</option>
                    {studentsForAlert.map((student) => <option key={student.id} value={student.id}>{student.fullName} — {student.id}</option>)}
                  </select>
                </label>
                <label className="teacher-alert-message"><span>نص التنبيه</span>
                  <textarea ref={alertMessageRef} value={alertMessage} onChange={(event) => setAlertMessage(event.target.value)} minLength={3} maxLength={1000} rows={3} required />
                </label>
                <button type="submit" disabled={savingAlert || !selectedSubject}>{savingAlert ? 'جارٍ الإرسال...' : 'إرسال التنبيه'}</button>
              </form>
              <div className="teacher-alert-list">
                {visibleAlerts.map((alert) => (
                  <article className="teacher-alert-item" key={alert.id}>
                    <div><strong>{students.find((student) => student.id === alert.student_id)?.fullName ?? alert.student_id}</strong><p>{alert.message}</p><time>{formatDate(alert.created_at)}</time></div>
                    <button type="button" onClick={() => void deleteAlert(alert.id)} disabled={deletingAlertId === alert.id} aria-label="حذف التنبيه">
                      <Trash2 size={16} aria-hidden="true" />{deletingAlertId === alert.id ? 'جارٍ الحذف...' : 'حذف'}
                    </button>
                  </article>
                ))}
                {!visibleAlerts.length && <p className="teacher-empty">لا توجد تنبيهات لهذه المادة.</p>}
              </div>
            </section>
          </>
        )}
        {selectedStudentPhoto && (
          <div
            onClick={() => setSelectedStudentPhoto(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0, 0, 0, 0.78)' }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-label={`صورة ${selectedStudentPhoto.name}`}
              onClick={(event) => event.stopPropagation()}
              style={{ position: 'relative', maxWidth: 'min(90vw, 800px)', maxHeight: '90vh' }}
            >
              <button
                type="button"
                onClick={() => setSelectedStudentPhoto(null)}
                aria-label="إغلاق الصورة"
                style={{ position: 'absolute', top: 8, insetInlineEnd: 8, zIndex: 1, display: 'grid', placeItems: 'center', width: 40, height: 40, border: 0, borderRadius: '50%', background: 'rgba(0, 0, 0, 0.65)', color: '#fff', cursor: 'pointer' }}
              >
                <X size={22} aria-hidden="true" />
              </button>
              <img
                src={selectedStudentPhoto.url}
                alt={`صورة ${selectedStudentPhoto.name}`}
                style={{ display: 'block', maxWidth: '100%', maxHeight: '85vh', objectFit: 'contain', borderRadius: 12 }}
              />
              <p style={{ margin: '10px 0 0', textAlign: 'center', color: '#fff' }}>{selectedStudentPhoto.name}</p>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
