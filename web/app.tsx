/**
 * The web app's entry (Track 4, U2): state, the connection, the service worker, and the bits
 * of "app feel" that live outside the views: the title and Dock badge, and a notification when
 * a turn finishes or a question waits while the app is in the background.
 *
 * Inside VS Code (U4) the app runs in host mode (`host.ts`): it opens the workspace folder,
 * reports status and permission requests to the extension, and takes inserts and answers back.
 * Outside a host it refuses to run in someone else's frame.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientMessage } from '../src/server/protocol.ts';
import { Connection } from './connection.ts';
import { detectHost, parseFromHost, type ToHost } from './host.ts';
import { INITIAL_STATE, reduce, waitingAsks } from './model.ts';
import { insertIntoComposer, OpenFileContext, PairScreen, Shell } from './ui.tsx';

const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
const HOST = detectHost(location.hash, ancestors ? Array.from(ancestors) : []);
const FRAMED = window.top !== window.self;
const toHost = (m: ToHost) => {
  if (HOST) window.parent.postMessage(m, HOST.parentOrigin);
};

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
    if (HOST) return; // the host (VS Code) shows its own notifications
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
    if (HOST) return;
    const ask = () => {
      if ('Notification' in window && Notification.permission === 'default')
        void Notification.requestPermission();
    };
    window.addEventListener('pointerdown', ask, { once: true });
    return () => window.removeEventListener('pointerdown', ask);
  }, []);

  const send = useCallback((m: ClientMessage) => conn.current?.send(m), []);

  // ---- host mode (VS Code, U4) ----
  // Open the workspace folder once connected.
  const openedHostFolder = useRef(false);
  useEffect(() => {
    if (!HOST?.cwd || state.connection !== 'open' || openedHostFolder.current) return;
    openedHostFolder.current = true;
    if (state.order.length === 0) send({ type: 'session.open', cwd: HOST.cwd });
  }, [state.connection, state.order.length, send]);

  // Inserts and answers from the host, from the parent window and its origin only.
  useEffect(() => {
    if (!HOST) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== HOST.parentOrigin) return;
      const m = parseFromHost(e.data);
      if (m?.type === 'insert') insertIntoComposer(m.text);
      else if (m?.type === 'answer') send({ type: 'ask.answer', askId: m.askId, answer: m.answer });
    };
    window.addEventListener('message', onMessage);
    toHost({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [send]);

  // Status for the host's status bar.
  const active = state.active ? state.conversations[state.active] : undefined;
  const statusKey = JSON.stringify([
    active?.status.model,
    active?.status.cost,
    active?.running,
    asks,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: statusKey covers what is sent
  useEffect(() => {
    if (!HOST || !active) return;
    toHost({
      type: 'status',
      model: active.status.model,
      ...(active.status.cost !== undefined ? { cost: active.status.cost } : {}),
      running: active.running,
      waiting: asks,
    });
  }, [statusKey]);

  // Permission requests for the host, with the diff of the call they are about.
  const posted = useRef(new Set<string>());
  useEffect(() => {
    if (!HOST) return;
    const open = new Set<string>();
    for (const conv of Object.values(state.conversations)) {
      for (const ask of conv.asks) {
        open.add(ask.askId);
        if (posted.current.has(ask.askId)) continue;
        posted.current.add(ask.askId);
        const card = [...conv.entries]
          .reverse()
          .find((e) => e.kind === 'tool' && e.card.status === 'running');
        const display = card?.kind === 'tool' ? card.card.display : undefined;
        toHost({
          type: 'ask',
          askId: ask.askId,
          summary: ask.summary,
          ...(display ? { display } : {}),
        });
      }
    }
    for (const id of posted.current) {
      if (!open.has(id)) {
        posted.current.delete(id);
        toHost({ type: 'ask.closed', askId: id });
      }
    }
  }, [state.conversations]);

  const openFile = useCallback((ref: { path: string; line?: number }) => {
    toHost({ type: 'open', path: ref.path, ...(ref.line ? { line: ref.line } : {}) });
  }, []);

  // Outside a host, never run inside another page's frame (no clickjacking).
  if (FRAMED && !HOST) {
    return (
      <main className="connecting">mrig can't be shown inside another page. Open it directly.</main>
    );
  }

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
  return (
    <OpenFileContext.Provider value={HOST ? openFile : undefined}>
      <Shell state={state} send={send} act={dispatch} {...(token ? { token } : {})} />
    </OpenFileContext.Provider>
  );
}

if ('serviceWorker' in navigator && !HOST && !FRAMED) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // No service worker (a private window, for example): the app still works online.
  });
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
