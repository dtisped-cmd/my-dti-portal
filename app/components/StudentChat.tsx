'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Paperclip, Pencil, Send, Trash2, X } from 'lucide-react';
import Image from 'next/image';

type ChatMessage = {
  id: string;
  student_id: string;
  student_name: string;
  student_year: 'أولى' | 'ثانية' | '';
  message: string;
  created_at: string;
  edited_at?: string | null;
  attachment_name?: string | null;
  attachment_type?: string | null;
  attachment_size?: number | null;
  avatar_url?: string | null;
  viewer_count?: number;
  pending?: boolean;
};

type StudentChatProps = {
  studentId: string;
  password: string;
  studentYear: 'أولى' | 'ثانية' | '';
  selectedMessageId?: string;
  onIncomingMessage?: (messageIds: string[]) => void;
};

const allowedAttachmentTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);
const maxAttachmentBytes = 1024 * 1024;
const messageEditWindowMs = 15 * 60 * 1000;
const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'avif']);

const requestErrorMessages: Record<string, string> = {
  'chat-closed': 'الدردشة مغلقة حاليًا من قبل المشرف.',
  'student-chat-banned': 'تم حظرك من الدردشة. تواصل مع المشرف إذا كنت تعتقد أن ذلك حدث بالخطأ.',
  'chat-settings-not-configured': 'الدردشة غير مفعّلة بعد. يرجى إبلاغ المشرف.',
  'chat-service-not-configured': 'تعذر الاتصال بخدمة الدردشة. يرجى المحاولة لاحقًا.',
  'student-credentials-invalid': 'انتهت جلسة الطالب. سجّل الخروج ثم ادخل مجددًا.',
  'student-year-not-configured': 'تعذر تحديد السنة الدراسية لحسابك. يرجى التواصل مع إدارة المعهد لتحديث بياناتك.',
  'message-not-allowed': 'لم يتم إرسال الرسالة لأنها تتضمن ألفاظًا غير مناسبة.',
  'invalid-message': 'اكتب رسالة أو أرفق ملفًا، على ألا يتجاوز النص 1000 حرف.',
  'attachment-type-or-size-invalid': 'يسمح فقط بصور أو PDF أو TXT وبحجم لا يتجاوز 1 ميغابايت.',
  'attachment-content-invalid': 'تعذر التحقق من نوع الملف. اختر صورة أو PDF أو TXT صالحًا.',
  'chat-schema-out-of-date': 'إعداد الدردشة في قاعدة البيانات يحتاج تحديثًا. أعد تشغيل ملف supabase-student-chat.sql وأبلغ المشرف.',
  'chat-read-receipts-unavailable': 'تعذر تحميل حالات مشاهدة الرسائل. حدّث إعداد الدردشة في قاعدة البيانات.',
  'attachment-save-failed': 'تعذر حفظ المرفق. لم يتم إرسال الرسالة.',
  'attachment-load-failed': 'تعذر تحميل المرفق.',
  'attachment-not-found': 'لم يعد هذا المرفق متاحًا.',
  'chat-messages-load-failed': 'تعذر تحميل الرسائل.',
  'message-save-failed': 'تعذر إرسال الرسالة.',
  'message-edit-failed': 'تعذر تعديل الرسالة.',
  'message-edit-window-expired': 'انتهت مهلة تعديل الرسالة؛ يمكن تعديلها خلال أول 15 دقيقة من إرسالها فقط.',
  'message-delete-failed': 'تعذر حذف الرسالة.',
  'message-not-found': 'لم تعد الرسالة موجودة.',
};

const formatSize = (size: number) => size < 1024 * 1024
  ? `${Math.max(1, Math.round(size / 1024))} ك.ب`
  : `${(size / (1024 * 1024)).toFixed(1)} م.ب`;

const blobToJpeg = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob | null>((resolve) => {
  canvas.toBlob(resolve, 'image/jpeg', quality);
});

const compressImage = async (file: File) => {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('image-canvas-unavailable');
    context.fillStyle = '#ffffff';

    let blob: Blob | null = null;
    const baseScale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    for (let sizePass = 0; sizePass < 5 && (!blob || blob.size > 950 * 1024); sizePass += 1) {
      const scale = baseScale * (0.82 ** sizePass);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.78, 0.68, 0.58, 0.48]) {
        blob = await blobToJpeg(canvas, quality);
        if (blob && blob.size <= 950 * 1024) break;
      }
    }
    if (!blob || blob.size > maxAttachmentBytes) throw new Error('image-compression-too-large');
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
};

function ChatAttachment({
  message,
  studentId,
  password,
}: {
  message: ChatMessage;
  studentId: string;
  password: string;
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
        body: JSON.stringify({
          action: 'get-attachment',
          studentId,
          password,
          messageId: message.id,
        }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        setError(requestErrorMessages[result.error ?? ''] ?? 'تعذر تحميل المرفق.');
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return objectUrl;
      });
      if (!message.attachment_type?.startsWith('image/')) {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = message.attachment_name || 'attachment';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    } catch {
      setError('تعذر الاتصال بالخادم لتحميل المرفق.');
    } finally {
      setLoading(false);
    }
  }, [message.attachment_name, message.attachment_type, message.id, password, studentId]);

  useEffect(() => {
    if (isImage) void openAttachment();
  }, [isImage, openAttachment]);

  return (
    <div className="chat-attachment">
      {isImage && url ? (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`عرض ${message.attachment_name}`}>
          <Image
            className="chat-attachment-image"
            src={url}
            width={360}
            height={300}
            unoptimized
            alt={message.attachment_name || 'صورة مرفقة'}
          />
        </a>
      ) : (
        <button type="button" className="chat-attachment-link" onClick={() => void openAttachment()} disabled={loading}>
          {isImage ? <ImageIcon size={19} /> : <FileText size={19} />}
          <span>{loading ? (isImage ? 'جارٍ تحميل الصورة...' : 'جارٍ التحميل...') : isImage && error ? 'إعادة تحميل الصورة' : message.attachment_name}</span>
          <small>{message.attachment_size ? formatSize(message.attachment_size) : ''}</small>
        </button>
      )}
      {error && <span className="chat-inline-error" role="alert">{error}</span>}
    </div>
  );
}

export default function StudentChat({
  studentId,
  password,
  studentYear,
  selectedMessageId = '',
  onIncomingMessage,
}: StudentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState('');
  const [attachmentPreparing, setAttachmentPreparing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingMessageId, setSavingMessageId] = useState('');
  const [editingMessageId, setEditingMessageId] = useState('');
  const [editDraft, setEditDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadingRef = useRef(false);
  const messagesByIdRef = useRef(new Map<string, ChatMessage>());
  const deletedMessageIdsRef = useRef(new Set<string>());
  const readMessageIdsRef = useRef(new Set<string>());
  const pendingReadMessageIdsRef = useRef(new Set<string>());
  const readFlushTimerRef = useRef<number | null>(null);
  const lastScrolledMessageIdRef = useRef('');
  const knownMessageIdsRef = useRef<Set<string> | null>(null);
  messagesByIdRef.current = new Map(messages.map((message) => [message.id, message]));

  const loadMessages = useCallback(async (showLoading = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const response = await fetch('/api/student-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ action: 'student-messages', studentId, password }),
      });
      const result = await response.json() as { success?: boolean; error?: string; messages?: ChatMessage[] };
      if (!response.ok || !result.success) {
        setError(requestErrorMessages[result.error ?? ''] ?? 'تعذر تحميل الدردشة.');
        return;
      }
      const loadedMessages = (result.messages ?? []).filter((item) => !deletedMessageIdsRef.current.has(item.id));
      const knownMessageIds = knownMessageIdsRef.current;
      if (knownMessageIds) {
        const receivedNewMessageIds = loadedMessages
          .filter((item) => item.student_id !== studentId && !knownMessageIds.has(item.id))
          .map((item) => item.id);
        if (receivedNewMessageIds.length) onIncomingMessage?.(receivedNewMessageIds);
      }
      knownMessageIdsRef.current = new Set(loadedMessages.map((item) => item.id));
      setMessages((current) => {
        const pendingMessages = current.filter((item) => item.pending && !loadedMessages.some((loaded) =>
          loaded.student_id === item.student_id
          && loaded.message === item.message
          && loaded.attachment_name === item.attachment_name
        ));
        return [...loadedMessages, ...pendingMessages];
      });
      setError('');
    } catch {
      setError('تعذر الاتصال بالخادم لتحميل الدردشة.');
    } finally {
      loadingRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, [onIncomingMessage, studentId, password]);

  useEffect(() => {
    void loadMessages(true);
    const interval = window.setInterval(() => void loadMessages(), 5000);
    return () => window.clearInterval(interval);
  }, [loadMessages]);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  useEffect(() => {
    if (!selectedMessageId || loading || lastScrolledMessageIdRef.current === selectedMessageId) return;
    const target = [...(messagesContainerRef.current?.querySelectorAll<HTMLElement>('[data-chat-message-id]') ?? [])]
      .find((element) => element.dataset.chatMessageId === selectedMessageId);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    lastScrolledMessageIdRef.current = selectedMessageId;
  }, [loading, messages, selectedMessageId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || loading) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const messageId = (entry.target as HTMLElement).dataset.chatMessageId;
        const message = messageId ? messagesByIdRef.current.get(messageId) : undefined;
        if (!messageId || !message || message.pending || message.student_id === studentId
          || readMessageIdsRef.current.has(messageId)) return;
        readMessageIdsRef.current.add(messageId);
        pendingReadMessageIdsRef.current.add(messageId);
      });
      if (pendingReadMessageIdsRef.current.size && readFlushTimerRef.current === null) {
        readFlushTimerRef.current = window.setTimeout(() => {
          readFlushTimerRef.current = null;
          const messageIds = [...pendingReadMessageIdsRef.current].slice(0, 50);
          messageIds.forEach((id) => pendingReadMessageIdsRef.current.delete(id));
          void fetch('/api/student-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'mark-read', studentId, password, messageIds }),
          }).then(async (response) => {
            if (!response.ok) throw new Error('chat-read-receipts-unavailable');
          }).catch(() => {
            messageIds.forEach((id) => readMessageIdsRef.current.delete(id));
          });
        }, 160);
      }
    }, { root: container, threshold: 0.6 });
    container.querySelectorAll<HTMLElement>('[data-chat-message-id]').forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
    };
  }, [loading, messages.length, password, studentId]);

  useEffect(() => () => {
    if (readFlushTimerRef.current !== null) window.clearTimeout(readFlushTimerRef.current);
  }, []);

  useEffect(() => {
    if (!attachment || !attachment.type.startsWith('image/')) {
      setAttachmentPreview('');
      return;
    }
    const previewUrl = URL.createObjectURL(attachment);
    setAttachmentPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [attachment]);

  const selectAttachment = async (file?: File) => {
    if (!file) return;
    const extension = file.name.toLocaleLowerCase().split('.').pop() ?? '';
    const isImage = file.type.startsWith('image/') || imageExtensions.has(extension);
    const inferredType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
    if (!isImage && (!allowedAttachmentTypes.has(inferredType) || file.size > maxAttachmentBytes || file.size === 0)) {
      setError('يسمح فقط بصور أو PDF أو TXT وبحجم لا يتجاوز 1 ميغابايت.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setError('');
    if (!isImage || (allowedAttachmentTypes.has(inferredType) && file.size <= maxAttachmentBytes)) {
      setAttachment(file.type === 'image/jpg' ? new File([file], file.name, { type: 'image/jpeg' }) : file);
      return;
    }

    setAttachmentPreparing(true);
    try {
      setAttachment(await compressImage(file));
    } catch {
      setError('تعذر تجهيز الصورة. جرّب صورة JPEG أو PNG أصغر أو التقط صورة جديدة.');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setAttachmentPreparing(false);
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    const selectedFile = attachment;
    if ((!message && !selectedFile) || sending) return;

    const optimisticId = `pending-${Date.now()}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      student_id: studentId,
      student_name: 'أنت',
      student_year: studentYear,
      message,
      created_at: new Date().toISOString(),
      attachment_name: selectedFile?.name ?? null,
      attachment_type: selectedFile?.type ?? null,
      attachment_size: selectedFile?.size ?? null,
      pending: true,
    };
    setMessages((current) => [...current, optimisticMessage].slice(-200));
    setDraft('');
    setAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSending(true);
    setError('');
    setNotice('');

    try {
      const form = new FormData();
      form.set('action', 'send-message');
      form.set('studentId', studentId);
      form.set('password', password);
      form.set('message', message);
      if (selectedFile) form.set('file', selectedFile);

      const response = await fetch('/api/student-chat', { method: 'POST', body: form });
      const result = await response.json() as { success?: boolean; error?: string; message?: ChatMessage };
      const sentMessage = result.message;
      if (!response.ok || !result.success || !sentMessage) {
        setMessages((current) => current.filter((item) => item.id !== optimisticId));
        setDraft(message);
        if (selectedFile) setAttachment(selectedFile);
        setError(requestErrorMessages[result.error ?? ''] ?? 'تعذر إرسال الرسالة.');
        return;
      }
      setMessages((current) => [
        ...current.filter((item) => item.id !== optimisticId && item.id !== sentMessage.id),
        sentMessage,
      ].slice(-200));
    } catch {
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      setDraft(message);
      if (selectedFile) setAttachment(selectedFile);
      setError('تعذر الاتصال بالخادم لإرسال الرسالة.');
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async (message: ChatMessage) => {
    const nextText = editDraft.trim();
    if (!nextText || savingMessageId) return;
    const previousText = message.message;
    setSavingMessageId(message.id);
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, message: nextText } : item));
    setEditingMessageId('');
    setError('');
    try {
      const response = await fetch('/api/student-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit-message', studentId, password, messageId: message.id, message: nextText }),
      });
      const result = await response.json() as { success?: boolean; error?: string; message?: ChatMessage };
      const updatedMessage = result.message;
      if (!response.ok || !result.success || !updatedMessage) {
        setMessages((current) => current.map((item) => item.id === message.id ? { ...item, message: previousText } : item));
        if (result.error === 'message-edit-window-expired') {
          setNotice(requestErrorMessages[result.error]);
          return;
        }
        setError(requestErrorMessages[result.error ?? ''] ?? 'تعذر تعديل الرسالة.');
        return;
      }
      setMessages((current) => current.map((item) => item.id === message.id ? updatedMessage : item));
      setNotice('تم تعديل الرسالة.');
    } catch {
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, message: previousText } : item));
      setError('تعذر الاتصال بالخادم لتعديل الرسالة.');
    } finally {
      setSavingMessageId('');
    }
  };

  const deleteMessage = async (message: ChatMessage) => {
    if (savingMessageId || !window.confirm('هل تريد حذف هذه الرسالة؟')) return;
    setSavingMessageId(message.id);
    deletedMessageIdsRef.current.add(message.id);
    setMessages((current) => current.filter((item) => item.id !== message.id));
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/student-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-message', studentId, password, messageId: message.id }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !result.success) {
        deletedMessageIdsRef.current.delete(message.id);
        setMessages((current) => current.some((item) => item.id === message.id)
          ? current
          : [...current, message].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)));
        setError(requestErrorMessages[result.error ?? ''] ?? 'تعذر حذف الرسالة.');
        return;
      }
      setMessages((current) => current.filter((item) => item.id !== message.id));
      setNotice('تم حذف الرسالة.');
    } catch {
      deletedMessageIdsRef.current.delete(message.id);
      setMessages((current) => current.some((item) => item.id === message.id)
        ? current
        : [...current, message].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)));
      setError('تعذر الاتصال بالخادم لحذف الرسالة.');
    } finally {
      setSavingMessageId('');
    }
  };

  const canEditMessage = (message: ChatMessage) => {
    const sentAt = Date.parse(message.created_at);
    return Number.isFinite(sentAt) && Date.now() - sentAt <= messageEditWindowMs;
  };

  return (
    <section className="student-chat" dir="rtl">
      <header className="student-chat-header">
        <div className="student-chat-heading-mark">
          <Image src="/institute-logo.png" width={46} height={46} alt="شعار المعهد" />
        </div>
        <div>
          <h2>دردشة الطلاب</h2>
          <p>دردشة السنة {studentYear || 'الدراسية'} — الرسائل والمرفقات تُحذف تلقائيًا بعد 48 ساعة.</p>
        </div>
        <span className="student-chat-online"><i /> مباشرة</span>
      </header>

      <div className="student-chat-body">
        {error && <p className="chat-alert" role="alert">{error}</p>}
        {notice && <p className="chat-notice" role="status">{notice}</p>}
        <div ref={messagesContainerRef} className="student-chat-messages" aria-live="polite" aria-label="رسائل الدردشة">
          {loading ? (
            <div className="chat-loading"><span className="chat-spinner" /> جارٍ تحميل المحادثة...</div>
          ) : messages.length ? messages.map((item) => {
            const isOwnMessage = item.student_id === studentId;
            const isEditable = canEditMessage(item);
            return (
              <article
                className={`chat-message-row ${isOwnMessage ? 'own' : ''}`}
                data-chat-message-id={item.id}
                key={item.id}
              >
                <span className={`chat-avatar${isOwnMessage ? ' own' : ''}`} aria-hidden="true">
                  {item.avatar_url
                    ? <Image src={item.avatar_url} width={38} height={38} unoptimized alt="" />
                    : item.student_name.charAt(0)}
                </span>
                <div className={`chat-bubble ${isOwnMessage ? 'own' : ''}`}>
                  <div className="chat-message-meta">
                    <strong>{isOwnMessage ? 'أنت' : item.student_name}</strong>
                    <time dateTime={item.created_at}>
                      {new Date(item.created_at).toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit' })}
                                  {!item.pending && isOwnMessage && !item.edited_at && ' · تم الإرسال'}
                                  {!item.pending && item.edited_at && <span className="chat-edited-label">تم التعديل</span>}
                    </time>
                  </div>

                  {editingMessageId === item.id ? (
                    <div className="chat-edit-form">
                      <textarea value={editDraft} onChange={(event) => setEditDraft(event.target.value)} maxLength={1000} autoFocus />
                      <div>
                        <button type="button" onClick={() => void saveEdit(item)} disabled={!editDraft.trim() || Boolean(savingMessageId)}>حفظ</button>
                        <button type="button" className="quiet" onClick={() => setEditingMessageId('')}>إلغاء</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {item.message && <p className="chat-message-text">{item.message}</p>}
                      {item.attachment_name && item.attachment_type && (
                        item.pending ? (
                          <div className="chat-attachment-link pending">
                            {item.attachment_type.startsWith('image/') ? <ImageIcon size={19} /> : <FileText size={19} />}
                            <span>{item.attachment_name}</span>
                            <small>جارٍ الإرسال</small>
                          </div>
                        ) : (
                          <ChatAttachment message={item} studentId={studentId} password={password} />
                        )
                      )}
                    </>
                  )}

                  {isOwnMessage && !item.pending && editingMessageId !== item.id && (
                    <div className="chat-message-actions" aria-label="إجراءات الرسالة">
                      {isEditable && (
                        <button type="button" aria-label="تعديل الرسالة" title="تعديل الرسالة (متاح خلال 15 دقيقة)" disabled={Boolean(savingMessageId)} onClick={() => {
                          setEditingMessageId(item.id);
                          setEditDraft(item.message);
                          setError('');
                        }}>
                          <Pencil size={14} />
                        </button>
                      )}
                      <button type="button" aria-label="حذف الرسالة" title="حذف" disabled={Boolean(savingMessageId)} onClick={() => void deleteMessage(item)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                  {isOwnMessage && !item.pending && (
                    <span className="chat-viewer-count" title="عدد الطلاب الذين شاهدوا الرسالة داخل نافذة الدردشة">
                      ✓✓ {item.viewer_count ? `شاهده ${item.viewer_count} من الطلاب` : 'لم يشاهده أحد بعد'}
                    </span>
                  )}
                  {item.pending && <span className="chat-pending-label">جارٍ الإرسال...</span>}
                </div>
              </article>
            );
          }) : (
            <div className="chat-empty-state">
              <span aria-hidden="true">☁</span>
              <strong>ابدأوا أول محادثة</strong>
              <p>اكتب رسالة أو شارك صورة أو ملفًا صغيرًا مع زملائك.</p>
            </div>
          )}
          <div ref={endOfMessagesRef} />
        </div>

        <form className="student-chat-composer" onSubmit={(event) => void sendMessage(event)}>
          {attachment && (
            <div className="chat-selected-file">
              {attachmentPreview ? (
                <Image src={attachmentPreview} width={38} height={38} unoptimized alt="معاينة المرفق" />
              ) : attachment.type.startsWith('image/') ? <ImageIcon size={20} /> : <FileText size={20} />}
              <span>{attachment.name}<small>{formatSize(attachment.size)}</small></span>
              <button type="button" aria-label="إزالة المرفق" onClick={() => {
                setAttachment(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}>
                <X size={17} />
              </button>
            </div>
          )}
          <div className="chat-composer-row">
            <input
              ref={fileInputRef}
              className="chat-file-input"
              type="file"
              accept="image/*,.pdf,.txt"
              onChange={(event) => void selectAttachment(event.currentTarget.files?.[0])}
              aria-label="إرفاق صورة أو ملف"
            />
            <button type="button" className="chat-attach-button" aria-label="إرفاق ملف" title="إرفاق صورة أو ملف (حتى 1 ميغابايت)" disabled={sending || attachmentPreparing} onClick={() => fileInputRef.current?.click()}>
              <Paperclip size={20} />
            </button>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={1000}
              rows={1}
              aria-label="اكتب رسالتك"
              placeholder="اكتب رسالة..."
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" className="chat-send-button" aria-label="إرسال الرسالة" disabled={sending || attachmentPreparing || (!draft.trim() && !attachment)}>
              <Send size={18} />
              <span>{attachmentPreparing ? 'تجهيز الصورة...' : sending ? 'جارٍ...' : 'إرسال'}</span>
            </button>
          </div>
          <div className="chat-composer-hint">
            <span>Enter للإرسال · Shift + Enter لسطر جديد</span>
            <span>الصور الكبيرة تُضغط تلقائيًا · ملفات PDF/TXT حتى 1 ميغابايت</span>
          </div>
        </form>
      </div>
    </section>
  );
}
