'use client';

export type ScoutLiveActivityEvent = {
  id?: string;
  kind?: 'send' | 'auto_scout' | 'schedule' | 'system';
  status?: string;
  title?: string;
  message?: string;
  toEmail?: string;
  fromEmail?: string;
  businessName?: string;
  website?: string;
  countText?: string;
  source?: string;
  createdAt?: string;
};

export function emitLiveActivity(event: ScoutLiveActivityEvent) {
  if (typeof window === 'undefined') return;
  const detail: ScoutLiveActivityEvent = {
    id: event.id || `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: event.kind || 'system',
    status: event.status || 'info',
    title: event.title || '',
    message: event.message || '',
    createdAt: event.createdAt || new Date().toISOString(),
    ...event
  };
  window.dispatchEvent(new CustomEvent('scout-live-activity', { detail }));
  try {
    window.localStorage.setItem('scout:last-live-activity', JSON.stringify(detail));
  } catch {
    // ignore storage errors
  }
}
