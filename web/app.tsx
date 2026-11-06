/**
 * The web app's entry (Track 4, U2): state, the connection, the service worker, and the bits
 * of "app feel" that live outside the views: the title and Dock badge, and a notification when
 * a turn finishes or a question waits while the app is in the background.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientMessage } from '../src/server/protocol.ts';
import { Connection } from './connection.ts';
import { INITIAL_STATE, reduce, waitingAsks } from './model.ts';
import { PairScreen, Shell } from './ui.tsx';
import './styles.css';

function App() {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const conn = useRef<Connection | null>(null);

  const start = useCallback(() => {
    conn.current?.stop();
    const c = new Connection(dispatch, () => {
      const s = stateRef.current;
      return {
        sessions: s.order.flatMap((id) => {
          const v = s.conversations[id];
          return v ? [{ cwd: v.cwd, sessionId: v.sessionId }] : [];
        }),
        ...(s.active && s.conversations[s.active]
          ? { active: s.conversations[s.active]?.sessionId }
          : {}),
      };
    });
    conn.current = c;
    dispatch({ type: 'local.connection', connection: 'connecting' });
    void c.start();
  }, []);

  useEffect(() => {
    start();
    return () => conn.current?.stop();
  }, [start]);

  // The title and the Dock or home-screen badge show questions waiting for an answer.
  const asks = waitingAsks(state);
  useEffect(() => {
    document.title = asks > 0 ? `(${asks}) mrig` : 'mrig';
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (asks > 0) void nav.setAppBadge?.(asks).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  }, [asks]);

  // A notification when the app is in the background and something needs you.
  const prev = useRef({ asks: 0, running: new Set<string>() });
  useEffect(() => {
    const running = new Set(
      Object.values(state.conversations)
        .filter((c) => c.running)
        .map((c) => c.conversation),
    );
    const finished = [...prev.current.running].filter((id) => !running.has(id));
    const notify = (body: string) => {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('mrig', { body, tag: 'mrig' });
      }
    };
    if (asks > prev.current.asks) notify('mrig is waiting for your permission.');
    else if (finished.length > 0) notify('mrig finished.');
    prev.current = { asks, running };
  }, [state.conversations, asks]);

  // Ask once for notification permission, on the first click (browsers require a gesture).
  useEffect(() => {
    const ask = () => {
      if ('Notification' in window && Notification.permission === 'default')
        void Notification.requestPermission();
    };
    window.addEventListener('pointerdown', ask, { once: true });
    return () => window.removeEventListener('pointerdown', ask);
  }, []);

  const send = useCallback((m: ClientMessage) => conn.current?.send(m), []);

  if (state.connection === 'unauthorized') return <PairScreen onPaired={start} />;
  // Until the login check answers, show neither the app nor the pairing screen.
  if (state.connection === 'connecting' && state.order.length === 0) {
    return (
      <main className="connecting" aria-busy="true">
        Connecting to mrig…
      </main>
    );
  }
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? undefined;
  return <Shell state={state} send={send} act={dispatch} {...(token ? { token } : {})} />;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // No service worker (a private window, for example): the app still works online.
  });
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
