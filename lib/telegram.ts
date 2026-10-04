const escapeHtml = (value: string | number | null | undefined) => {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
};

export function buildStudentTelegramMessage({
  studentName,
  studentId,
  studentYear,
  studentClass,
  username,
  statusText,
  title = 'تنبيه نظام الحضور والغياب',
}: {
  studentName: string;
  studentId: string;
  studentYear: string;
  studentClass: string;
  username?: string;
  statusText: string;
  title?: string;
}) {
  return [
    `🔔 <b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━',
    `👤 <b>الاسم:</b> ${escapeHtml(studentName)}`,
    ...(username ? [`🔑 <b>اسم المستخدم:</b> ${escapeHtml(username)}`] : []),
    `🆔 <b>الرقم الجامعي:</b> ${escapeHtml(studentId)}`,
    `🎓 <b>السنة الدراسية:</b> ${escapeHtml(studentYear)}`,
    `📌 <b>الفئة:</b> ${escapeHtml(studentClass)}`,
    '━━━━━━━━━━━━━━━━━━━',
    `📢 <b>الحالة:</b> ${escapeHtml(statusText)}`,
  ].join('\n');
}

export async function sendTelegramNotification(
  message: string,
  options?: { chatId?: string; enabled?: boolean; skipValidation?: boolean }
) {
  if (typeof window !== 'undefined') {
    try {
      const response = await fetch('/api/telegram/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          chatId: options?.chatId,
          enabled: options?.enabled,
        }),
      });
      return await response.json();
    } catch (error) {
      console.error('Telegram browser request failed:', error);
      return { ok: false, status: 'telegram_send_failed' };
    }
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const targetChatId = options?.chatId || process.env.TELEGRAM_CHAT_ID || '7259761374';

  if (!botToken) {
    console.error('Telegram notification skipped: TELEGRAM_BOT_TOKEN is not configured.');
    return { ok: false, status: 'missing_bot_token' };
  }

  if (!options?.skipValidation && (options?.enabled === false || !targetChatId || String(targetChatId).trim() === '')) {
    return { ok: false, status: 'disabled_or_missing_chat_id' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const payload = await res.json();
    if (!payload?.ok) {
      const description = String(payload?.description ?? '').toLowerCase();
      if (description.includes('chat not found')) {
        return { ok: false, status: 'chat_not_found', description: 'chat not found' };
      }
    }

    return payload;
  } catch (error) {
    console.error('Telegram Send Error:', error);
    return null;
  }
}
