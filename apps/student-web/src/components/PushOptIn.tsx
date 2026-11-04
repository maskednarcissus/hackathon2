'use client';

import { useEffect, useState } from 'react';
import { savePushSubscriptionAction } from '@/app/actions';

type PushState = 'unsupported' | 'unconfigured' | 'default' | 'granted' | 'denied' | 'subscribed';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (buffer === null) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const VAPID = process.env['NEXT_PUBLIC_VAPID_PUBLIC_KEY'] ?? '';

/** Web Push opt-in: registers /sw.js and sends the subscription to the notifications service. */
export function PushOptIn(): React.JSX.Element {
  const [state, setState] = useState<PushState>('default');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      setState('unsupported');
      return;
    }
    if (VAPID === '') {
      setState('unconfigured');
      return;
    }
    void navigator.serviceWorker.getRegistration('/sw.js').then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      if (sub !== undefined && sub !== null) setState('subscribed');
      else setState(Notification.permission === 'denied' ? 'denied' : 'default');
    });
  }, []);

  async function enable(): Promise<void> {
    setMessage('');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setState('denied');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID),
      });
      const result = await savePushSubscriptionAction({
        endpoint: sub.endpoint,
        keys: {
          p256dh: arrayBufferToBase64Url(sub.getKey('p256dh')),
          auth: arrayBufferToBase64Url(sub.getKey('auth')),
        },
      });
      if (result.ok) {
        setState('subscribed');
        setMessage('Notificações push ativadas neste dispositivo.');
      } else {
        await sub.unsubscribe();
        setMessage(result.message ?? 'Não foi possível ativar as notificações push.');
      }
    } catch {
      setMessage('Não foi possível ativar as notificações push neste navegador.');
    }
  }

  const text: Record<PushState, string> = {
    unsupported: 'Este navegador não oferece notificações push.',
    unconfigured: 'Notificações push ainda não estão disponíveis nesta instalação.',
    default: 'Receba avisos mesmo com o aplicativo fechado.',
    granted: 'Receba avisos mesmo com o aplicativo fechado.',
    denied:
      'As notificações estão bloqueadas para este site. Libere nas configurações do navegador para ativar.',
    subscribed: 'Notificações push ativas neste dispositivo.',
  };

  return (
    <section className="card" aria-labelledby="push-title">
      <h2 id="push-title">Notificações push</h2>
      <p className="muted small">{text[state]}</p>
      {(state === 'default' || state === 'granted') && (
        <button type="button" className="btn btn--secondary" onClick={() => void enable()}>
          Ativar notificações push
        </button>
      )}
      <p role="status" aria-live="polite" className="small">
        {message}
      </p>
    </section>
  );
}
