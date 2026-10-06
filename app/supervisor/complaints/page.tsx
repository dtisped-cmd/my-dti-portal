'use client';

import { useCallback, useEffect, useState } from 'react';

type Feedback = {
  id: string;
  kind: 'complaint' | 'suggestion';
  category: string;
  details: string;
  student_id: string;
  student_name: string;
  created_at: string;
};

const usernameKey = 'udti-remembered-supervisor-username';
const passwordKey = 'udti-remembered-supervisor-password';

export default function SupervisorFeedbackPage() {
  const [submissions, setSubmissions] = useState<Feedback[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [deletingId, setDeletingId] = useState('');

  const loadSubmissions = useCallback(async () => {
    const username = window.localStorage.getItem(usernameKey) ?? '';
    const password = window.localStorage.getItem(passwordKey) ?? '';
    if (!username || !password) {
      setMessage('افتح هذه الوظيفة من لوحة المشرف بعد تسجيل الدخول؛ لن تحتاج إلى تسجيل الدخول مرة ثانية داخل الوظيفة.');
      setLoaded(false);
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', supervisorUsername: username, supervisorPassword: password }),
      });
      const result = await response.json() as { success?: boolean; error?: string; submissions?: Feedback[] };
      if (!response.ok || !result.success) {
        const errors: Record<string, string> = {
          'first-degree-supervisor-required': 'هذه الوظيفة متاحة لمشرفي الدرجة الأولى فقط.',
          'supervisor-credentials-invalid': 'انتهت صلاحية جلسة المشرف. ارجع إلى لوحة المشرف وسجّل الدخول مجددًا.',
          'supervisor-lookup-failed': 'تعذر التحقق من حساب المشرف حاليًا.',
          'feedback-load-failed': 'تعذر تحميل الشكاوى والاقتراحات.',
        };
        setSubmissions([]);
        setMessage(errors[result.error ?? ''] ?? 'تعذر تحميل الشكاوى والاقتراحات.');
        setLoaded(false);
        return;
      }
      setSubmissions(result.submissions ?? []);
      setLoaded(true);
    } catch {
      setSubmissions([]);
      setMessage('تعذر الاتصال بالخادم.');
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteSubmission = async (id: string) => {
    if (!window.confirm('هل تريد حذف هذه الرسالة نهائيًا؟ لا يمكن التراجع عن الحذف.')) return;
    const username = window.localStorage.getItem(usernameKey) ?? '';
    const password = window.localStorage.getItem(passwordKey) ?? '';
    if (!username || !password) {
      setMessage('افتح هذه الوظيفة من لوحة المشرف بعد تسجيل الدخول.');
      return;
    }

    setDeletingId(id);
    setMessage('');
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id, supervisorUsername: username, supervisorPassword: password }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !result.success) {
        const errors: Record<string, string> = {
          'first-degree-supervisor-required': 'حذف الرسائل متاح لمشرفي الدرجة الأولى فقط.',
          'supervisor-credentials-invalid': 'انتهت صلاحية جلسة المشرف. يرجى تسجيل الدخول مجددًا.',
          'feedback-not-found': 'هذه الرسالة حُذفت مسبقًا أو لم تعد موجودة.',
          'feedback-delete-failed': 'تعذر حذف الرسالة. حاول مرة أخرى.',
        };
        throw new Error(errors[result.error ?? ''] ?? 'تعذر حذف الرسالة.');
      }
      setSubmissions((current) => current.filter((submission) => submission.id !== id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'تعذر حذف الرسالة.');
    } finally {
      setDeletingId('');
    }
  };

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  return (
    <main dir="rtl" style={{ minHeight: '100vh', padding: '32px 16px', background: '#f1f5f9', color: '#0f172a', fontFamily: 'inherit' }}>
      <section style={{ maxWidth: 960, margin: '0 auto' }}>
        <a href="/dashboard" style={{ color: '#0f766e', textDecoration: 'none' }}>← العودة إلى لوحة المشرفين</a>
        <h1 style={{ margin: '20px 0 8px', fontSize: 28 }}>شكاوى ومقترحات الطلاب</h1>
        <p style={{ margin: '0 0 22px', color: '#475569', lineHeight: 1.8 }}>تظهر الرسائل لمشرفي الدرجة الأولى فقط.</p>
        <button type="button" onClick={() => void loadSubmissions()} disabled={loading} style={{ minHeight: 42, padding: '8px 18px', border: 0, borderRadius: 8, background: loading ? '#94a3b8' : '#0f766e', color: '#fff', font: 'inherit', fontWeight: 700, cursor: loading ? 'wait' : 'pointer' }}>
          {loading ? 'جارٍ التحميل...' : 'تحديث الرسائل'}
        </button>
        {message && <p role="status" style={{ color: '#b91c1c', marginTop: 16 }}>{message}</p>}
        {loading && <p role="status" style={{ marginTop: 22 }}>جارٍ تحميل الرسائل...</p>}
        {loaded && (submissions.length ? (
          <div style={{ display: 'grid', gap: 14, marginTop: 22 }}>
            {submissions.map((submission) => (
              <article key={submission.id} style={{ padding: 18, border: '1px solid #dbe3ec', borderRadius: 14, background: '#fff' }}>
                <header style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center', justifyContent: 'space-between' }}>
                  <strong>{submission.kind === 'complaint' ? 'شكوى' : 'اقتراح'} — {submission.category}</strong>
                  <time dateTime={submission.created_at} style={{ color: '#64748b', fontSize: 13 }}>{new Date(submission.created_at).toLocaleString('ar-SY')}</time>
                </header>
                <p style={{ margin: '12px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8 }}>{submission.details}</p>
                <footer style={{ paddingTop: 10, borderTop: '1px solid #e2e8f0', color: '#475569', fontSize: 14 }}>
                  المرسل: {submission.student_name} · الرقم الجامعي: {submission.student_id}
                </footer>
                <button
                  type="button"
                  onClick={() => void deleteSubmission(submission.id)}
                  disabled={Boolean(deletingId)}
                  style={{ marginTop: 12, padding: '8px 14px', border: 0, borderRadius: 8, background: deletingId ? '#94a3b8' : '#b91c1c', color: '#fff', font: 'inherit', fontWeight: 700, cursor: deletingId ? 'wait' : 'pointer' }}
                >
                  {deletingId === submission.id ? 'جارٍ الحذف...' : 'حذف الرسالة'}
                </button>
              </article>
            ))}
          </div>
        ) : <p role="status" style={{ marginTop: 22, color: '#64748b' }}>لا توجد شكاوى أو اقتراحات مسجلة.</p>)}
      </section>
    </main>
  );
}
