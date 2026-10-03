const deviceIdStorageKey = 'udti-device-id';

type AuditUserType = 'student' | 'teacher' | 'supervisor' | 'system';

type AuditDetails = Record<string, unknown>;

const getDeviceId = () => {
  if (typeof window === 'undefined') return null;

  const existing = window.localStorage.getItem(deviceIdStorageKey);
  if (existing) return existing;

  const generated = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(deviceIdStorageKey, generated);
  return generated;
};

export const writeAuditLog = (input: {
  action: string;
  userType: AuditUserType;
  userId?: string | number | null;
  username?: string | null;
  fullName?: string | null;
  details?: AuditDetails;
}) => {
  if (typeof window === 'undefined') return;

  const payload = {
    action: input.action,
    user_type: input.userType,
    user_id: input.userId === null || input.userId === undefined ? null : String(input.userId),
    username: input.username || null,
    full_name: input.fullName || input.username || null,
    device_id: getDeviceId(),
    user_agent: navigator.userAgent || null,
    device_type: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    platform: navigator.platform || null,
    language: navigator.language || null,
    screen_size: `${window.screen.width}x${window.screen.height}`,
    path: window.location.pathname,
    details: input.details ?? {},
  };

  void fetch('/api/audit-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).then(async (response) => {
    if (response.ok) return;
    const result = await response.json().catch(() => ({})) as { error?: string };
    console.error('[audit] log insert failed:', result.error || response.statusText);
  }).catch((error: unknown) => {
    console.error('[audit] log request failed:', error);
  });
};
