'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';

type ChatBan = {
  student_id: string;
  student_name: string;
  created_at: string;
  banned_by: string;
};

type ChatMessage = {
  id: string;
  student_id: string;
  student_name: string;
  student_year: 'أولى' | 'ثانية';
  message: string;
  created_at: string;
  edited_at?: string | null;
  attachment_name?: string | null;
  attachment_type?: string | null;
  attachment_size?: number | null;
  avatar_url?: string | null;
};

type SupervisorChatManagementProps = {
  supervisorUsername: string;
  supervisorPassword: string;
};

const requestErrorMessages: Record<string, string> = {
  'first-degree-supervisor-required': 'إدارة الدردشة متاحة لمشرفي الدرجة الأولى فقط.',
  'supervisor-credentials-invalid': 'انتهت صلاحية جلسة المشرف. سجّل الدخول مجددًا.',
  'student-not-found': 'لم يُعثر على طالب بهذا الرقم الجامعي.',
  'chat-settings-not-configured': 'شغّل ملف supabase-student-chat.sql في مشروع Supabase.',
  'chat-service-not-configured': 'تعذر الاتصال بخدمة الدردشة. تحقق من إعداد الخادم.',
  'chat-bans-load-failed': 'تعذر تحميل قائمة المحظورين.',
  'chat-settings-update-failed': 'تعذر حفظ حالة الدردشة.',
  'chat-ban-save-failed': 'تعذر حظر الطالب.',
  'chat-unban-failed': 'تعذر إلغاء الحظر.',
};

export default function SupervisorChatManagement({
  supervisorUsername,
  supervisorPassword,
}: SupervisorChatManagementProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isOpenFirst, setIsOpenFirst] = useState(true);
  const [isOpenSecond, setIsOpenSecond] = useState(true);
  const [bans, setBans] = useState<ChatBan[]>([]);
  const [selectedYear, setSelectedYear] = useState<'أولى' | 'ثانية'>('أولى');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [messagesError, setMessagesError] = useState('');
  const messageRequestSequenceRef = useRef(0);
  const [studentId, setStudentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  const request = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch('/api/student-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ action, supervisorUsername, supervisorPassword, ...extra }),
    });
    const result = await response.json() as {
      success?: boolean;
      error?: string;
      isOpen?: boolean;
      isOpenFirst?: boolean;
      isOpenSecond?: boolean;
      isChatOpen?: boolean;
      bans?: ChatBan[];
      messages?: ChatMessage[];
    };
    if (!response.ok || !result.success) {
      throw new Error(requestErrorMessages[result.error ?? ''] ?? 'تعذر تنفيذ العملية.');
    }
    return result;
  }, [supervisorUsername, supervisorPassword]);

  const loadState = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const result = await request('admin-state');
      setIsOpen(Boolean(result.isOpen));
      setIsOpenFirst(Boolean(result.isOpenFirst));
      setIsOpenSecond(Boolean(result.isOpenSecond));
      setBans(result.bans ?? []);
      setMessage('');
      setError(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'تعذر تحميل إعدادات الدردشة.');
      setError(true);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [request]);

  const loadMessages = useCallback(async (studentYear: 'أولى' | 'ثانية', showLoading = false) => {
    const requestSequence = messageRequestSequenceRef.current + 1;
    messageRequestSequenceRef.current = requestSequence;
    if (showLoading) setLoadingMessages(true);
    try {
      const result = await request('admin-messages', { studentYear });
      if (requestSequence !== messageRequestSequenceRef.current) return;
      setChatMessages(result.messages ?? []);
      setMessagesError('');
    } catch (cause) {
      if (requestSequence !== messageRequestSequenceRef.current) return;
      setMessagesError(cause instanceof Error ? cause.message : 'تعذر تحميل الرسائل.');
    } finally {
      if (requestSequence === messageRequestSequenceRef.current && showLoading) setLoadingMessages(false);
    }
  }, [request]);

  useEffect(() => {
    void loadState(true);
  }, [loadState]);

  useEffect(() => {
    void loadMessages(selectedYear, true);
    const interval = window.setInterval(() => void loadMessages(selectedYear), 15000);
    return () => {
      window.clearInterval(interval);
      messageRequestSequenceRef.current += 1;
    };
  }, [loadMessages, selectedYear]);

  const toggleChat = async () => {
    setSaving(true);
    setMessage('');
    try {
      const result = await request('set-open', { isOpen: !isOpen });
      setIsOpen(Boolean(result.isOpen));
      setIsOpenFirst(Boolean(result.isOpenFirst));
      setIsOpenSecond(Boolean(result.isOpenSecond));
      setMessage(result.isOpen ? 'تم فتح دردشتي السنتين. يمكنك إغلاق أي سنة بشكل منفصل.' : 'تم إغلاق الدردشة للسنتين.');
      setError(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'تعذر تغيير حالة الدردشة.');
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const toggleYearChat = async (studentYear: 'أولى' | 'ثانية', currentlyOpen: boolean) => {
    setSaving(true);
    setMessage('');
    try {
      const result = await request('set-year-open', { studentYear, isOpen: !currentlyOpen });
      if (studentYear === 'أولى') setIsOpenFirst(Boolean(result.isOpen));
      else setIsOpenSecond(Boolean(result.isOpen));
      setIsOpen(Boolean(result.isChatOpen));
      setMessage(`تم ${result.isOpen ? 'فتح' : 'إغلاق'} دردشة السنة ${studentYear}.`);
      setError(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'تعذر تغيير حالة دردشة السنة.');
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const banStudent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!studentId.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      await request('ban-student', { studentId: studentId.trim() });
      setStudentId('');
      setMessage('تم حظر الطالب من الدردشة.');
      setError(false);
      await loadState();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'تعذر حظر الطالب.');
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const unbanStudent = async (targetStudentId: string) => {
    setSaving(true);
    setMessage('');
    try {
      await request('unban-student', { studentId: targetStudentId });
      setMessage('تم إلغاء حظر الطالب.');
      setError(false);
      await loadState();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'تعذر إلغاء الحظر.');
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="admin-dashboard-panel">
      <div className="admin-dashboard-heading">
        <div>
          <span className="feature-panel-kicker">إدارة تواصل الطلاب</span>
          <h1>دردشة الطلاب</h1>
          <p>تحكم بالدردشة لكل سنة على حدة، أو أوقف الدردشة عن جميع الطلاب.</p>
        </div>
        <button type="button" className={`action-button ${isOpen ? 'danger' : 'primary'}`} onClick={() => void toggleChat()} disabled={loading || saving}>
          {saving ? 'جارٍ الحفظ...' : isOpen ? 'إغلاق الدردشة للسنتين' : 'فتح الدردشة للسنتين'}
        </button>
      </div>

      <p role={error ? 'alert' : 'status'} className={`teacher-account-notice ${error ? 'error' : 'success'}`}>
        {message || (isOpen ? 'الدردشة مفعّلة؛ حالة كل سنة تظهر أدناه.' : 'الدردشة متوقفة لجميع الطلاب.')}
      </p>

      <div className="supervisor-chat-year-controls">
        {([
          { year: 'أولى' as const, isYearOpen: isOpenFirst },
          { year: 'ثانية' as const, isYearOpen: isOpenSecond },
        ]).map(({ year, isYearOpen }) => {
          const effectiveOpen = isYearOpen;
          return (
            <article className="supervisor-chat-year-card" key={year}>
              <div>
                <strong>السنة {year}</strong>
                <span className={effectiveOpen ? 'is-open' : 'is-closed'}>
                  {effectiveOpen ? 'الدردشة مفتوحة' : 'الدردشة مغلقة'}
                </span>
              </div>
              <button
                type="button"
                className={`action-button ${isYearOpen ? 'danger' : 'primary'}`}
                onClick={() => void toggleYearChat(year, isYearOpen)}
                disabled={loading || saving}
              >
                {saving ? 'جارٍ الحفظ...' : isYearOpen ? 'إغلاق دردشة السنة' : 'فتح دردشة السنة'}
              </button>
            </article>
          );
        })}
      </div>

      <section className="supervisor-chat-messages-panel" aria-labelledby="supervisor-chat-messages-title">
        <div className="supervisor-chat-messages-heading">
          <div>
            <h2 id="supervisor-chat-messages-title">رسائل الطلاب</h2>
            <p>عرض آخر الرسائل خلال مدة الاحتفاظ بها، وتحديث تلقائي كل 15 ثانية.</p>
          </div>
          <div>
            <label>
              <span>السنة الدراسية</span>
              <select value={selectedYear} onChange={(event) => {
                const year = event.currentTarget.value;
                if (year === 'أولى' || year === 'ثانية') setSelectedYear(year);
              }}>
                <option value="أولى">السنة الأولى</option>
                <option value="ثانية">السنة الثانية</option>
              </select>
            </label>
            <button type="button" className="action-button" onClick={() => void loadMessages(selectedYear, true)} disabled={loadingMessages}>
              {loadingMessages ? 'جارٍ التحديث...' : 'تحديث الرسائل'}
            </button>
          </div>
        </div>
        {messagesError && <p role="alert" className="teacher-account-notice error">{messagesError}</p>}
        {loadingMessages ? (
          <div className="loading-box">جارٍ تحميل رسائل السنة {selectedYear}...</div>
        ) : chatMessages.length ? (
          <div className="supervisor-chat-message-list" aria-live="polite">
            {chatMessages.map((chatMessage) => (
              <article className="supervisor-chat-message" key={chatMessage.id}>
                <header>
                  <span className="supervisor-chat-message-avatar" aria-hidden="true">
                    {chatMessage.avatar_url
                      ? <Image src={chatMessage.avatar_url} width={42} height={42} unoptimized alt="" />
                      : chatMessage.student_name.charAt(0)}
                  </span>
                  <div>
                    <strong>{chatMessage.student_name}</strong>
                  </div>
                  <time dateTime={chatMessage.created_at}>
                    {new Date(chatMessage.created_at).toLocaleString('ar-SY')}
                    {chatMessage.edited_at && <span className="chat-edited-label">تم التعديل</span>}
                  </time>
                </header>
                {chatMessage.message && <p>{chatMessage.message}</p>}
                {chatMessage.attachment_name && chatMessage.attachment_type && (
                  <SupervisorChatAttachment
                    message={chatMessage}
                    studentYear={selectedYear}
                    supervisorUsername={supervisorUsername}
                    supervisorPassword={supervisorPassword}
                  />
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="loading-box">لا توجد رسائل حديثة في دردشة السنة {selectedYear}.</div>
        )}
      </section>

      <form onSubmit={(event) => void banStudent(event)} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', margin: '22px 0' }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>حظر طالب بالرقم الجامعي</span>
          <input value={studentId} onChange={(event) => setStudentId(event.target.value)} maxLength={80} required placeholder="الرقم الجامعي" />
        </label>
        <button type="submit" className="action-button danger" disabled={saving || !studentId.trim()}>
          حظر الطالب
        </button>
      </form>

      <h2 style={{ fontSize: 18 }}>الطلاب المحظورون ({bans.length})</h2>
      {loading ? (
        <div className="loading-box">جارٍ تحميل إعدادات الدردشة...</div>
      ) : bans.length ? (
        <div className="admin-record-list">
          {bans.map((ban) => (
            <article className="admin-record-item" key={ban.student_id}>
              <strong>{ban.student_name}</strong>
              <span>الرقم الجامعي: {ban.student_id}</span>
              <span>تاريخ الحظر: {new Date(ban.created_at).toLocaleString('ar-SY')} · المشرف: {ban.banned_by}</span>
              <button type="button" className="action-button" onClick={() => void unbanStudent(ban.student_id)} disabled={saving}>
                إلغاء الحظر
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="loading-box">لا يوجد طلاب محظورون حاليًا.</div>
      )}
    </section>
  );
}

function SupervisorChatAttachment({
  message,
  studentYear,
  supervisorUsername,
  supervisorPassword,
}: {
  message: ChatMessage;
  studentYear: 'أولى' | 'ثانية';
  supervisorUsername: string;
  supervisorPassword: string;
}) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const isImage = message.attachment_type?.startsWith('image/');

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const openAttachment = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/student-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          action: 'admin-get-attachment',
          supervisorUsername,
          supervisorPassword,
          studentYear,
          messageId: message.id,
        }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error === 'first-degree-supervisor-required'
          ? 'هذه الخاصية متاحة لمشرفي الدرجة الأولى فقط.'
          : 'تعذر تحميل المرفق.');
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      if (message.attachment_type?.startsWith('image/')) {
        setUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return objectUrl;
        });
      } else {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = message.attachment_name || 'attachment';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذر الاتصال لتحميل المرفق.');
    } finally {
      setLoading(false);
    }
  }, [message.attachment_name, message.attachment_type, message.id, studentYear, supervisorPassword, supervisorUsername]);

  useEffect(() => {
    if (isImage) void openAttachment();
  }, [isImage, openAttachment]);

  return (
    <div className="supervisor-chat-attachment">
      {isImage && url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <Image
            src={url}
            width={420}
            height={320}
            unoptimized
            alt={message.attachment_name || 'مرفق صورة'}
          />
        </a>
      ) : (
        <button type="button" onClick={() => void openAttachment()} disabled={loading}>
          {loading ? (isImage ? 'جارٍ تحميل الصورة...' : 'جارٍ تحميل المرفق...') : isImage && error ? 'إعادة تحميل الصورة' : `عرض أو تنزيل المرفق: ${message.attachment_name}`}
          {message.attachment_size ? ` (${Math.max(1, Math.round(message.attachment_size / 1024))} ك.ب)` : ''}
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
