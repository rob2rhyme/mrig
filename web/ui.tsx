/**
 * The web app's views (Track 4, U2). They only draw `AppState` (model.ts) and send protocol
 * messages; the behaviour lives in the reducer and the server.
 */
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ClientMessage } from '../src/server/protocol.ts';
import type { ToolDisplay } from '../src/tools/types.ts';
import { pair, upload } from './connection.ts';
import { lineDiff } from './diff.ts';
import { highlight } from './highlight.ts';
import { fileRef } from './host.ts';
import { type Block, type Inline, parseMarkdown } from './markdown.ts';
import type { AppState, ConversationView, Entry, LocalAction, ToolCard } from './model.ts';

export type Send = (m: ClientMessage) => void;
export type Act = (a: LocalAction) => void;

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- markdown ----------

/** Opens a file in the host's editor (VS Code, U4); absent in a plain browser. */
export const OpenFileContext = createContext<
  ((ref: { path: string; line?: number }) => void) | undefined
>(undefined);

/** Put text in the message box: appended, or (`replace`) instead of what is there. */
export function insertIntoComposer(text: string, replace = false): void {
  window.dispatchEvent(new CustomEvent('mrig:insert', { detail: { text, replace } }));
}

/** Inline code, clickable when it names a file and a host can open it. */
function CodeSpan({ text }: { text: string }) {
  const open = useContext(OpenFileContext);
  const ref = open ? fileRef(text) : undefined;
  if (!open || !ref) return <code>{text}</code>;
  return (
    <button type="button" className="file-ref" title="Open in the editor" onClick={() => open(ref)}>
      <code>{text}</code>
    </button>
  );
}

/** A path on a tool card, clickable when a host can open it. */
function PathLabel({ path }: { path: string }) {
  const open = useContext(OpenFileContext);
  if (!open) return <div className="path">{path}</div>;
  return (
    <button
      type="button"
      className="path file-ref"
      title="Open in the editor"
      onClick={() => open({ path })}
    >
      {path}
    </button>
  );
}

function Inlines({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>;
      case 'code':
        return <CodeSpan key={i} text={n.text} />;
      case 'strong':
        return (
          <strong key={i}>
            <Inlines nodes={n.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <Inlines nodes={n.children} />
          </em>
        );
      case 'del':
        return (
          <del key={i}>
            <Inlines nodes={n.children} />
          </del>
        );
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            <Inlines nodes={n.children} />
          </a>
        );
      case 'break':
        return <br key={i} />;
      default:
        return null;
    }
  });
}

export function CodeBlock({ text, lang }: { text: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const tokens = useMemo(() => highlight(text, lang), [text, lang]);
  return (
    <div className="code">
      <div className="code-bar">
        <span>{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((t, i) => (
            <span key={i} className={`tok-${t.type}`}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function Blocks({ blocks }: { blocks: Block[] }): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'heading': {
        const Tag = `h${Math.min(6, b.level + 2)}` as 'h3';
        return (
          <Tag key={i}>
            <Inlines nodes={b.children} />
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={i}>
            <Inlines nodes={b.children} />
          </p>
        );
      case 'code':
        return <CodeBlock key={i} text={b.text} lang={b.lang} />;
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag key={i} start={b.ordered ? b.start : undefined}>
            {b.items.map((item, j) => (
              <li key={j} style={{ marginLeft: `${item.level * 1.25}rem` }}>
                <Inlines nodes={item.children} />
              </li>
            ))}
          </Tag>
        );
      }
      case 'quote':
        return (
          <blockquote key={i}>
            <Blocks blocks={b.children} />
          </blockquote>
        );
      case 'table':
        return (
          <div key={i} className="table-wrap">
            <table>
              <thead>
                <tr>
                  {b.header.map((c, j) => (
                    <th key={j}>
                      <Inlines nodes={c} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k}>
                        <Inlines nodes={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'rule':
        return <hr key={i} />;
      default:
        return null;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      <Blocks blocks={blocks} />
    </div>
  );
}

// ---------- tool cards ----------

const EXT_LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  json: 'json',
  py: 'py',
  sh: 'sh',
  rs: 'rust',
  go: 'go',
  css: 'css',
  html: 'html',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
};
const langOfPath = (p: string) => EXT_LANG[(p.split('.').pop() ?? '').toLowerCase()] ?? '';

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'same'}>
          <span className="op">{l.op}</span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function DisplayView({ display }: { display: ToolDisplay }) {
  switch (display.kind) {
    case 'diff':
      return (
        <>
          <PathLabel path={display.path} />
          <DiffView before={display.before} after={display.after} />
        </>
      );
    case 'file':
      return (
        <>
          <PathLabel path={display.path} />
          <CodeBlock text={display.content} lang={langOfPath(display.path)} />
        </>
      );
    case 'command':
      return <CodeBlock text={display.command} lang="sh" />;
    case 'path':
      return <PathLabel path={display.path} />;
  }
}

const STATUS_ICON: Record<ToolCard['status'], string> = {
  running: '◌',
  ok: '✓',
  error: '✗',
  denied: '⊘',
};

function ToolCardView({ card }: { card: ToolCard }) {
  const hasBody = card.display || card.output || card.media?.length;
  return (
    <details className={`tool ${card.status}`} open={card.status === 'running' && !!card.display}>
      <summary>
        <span className={`icon ${card.status}`} role="img" aria-label={card.status}>
          {STATUS_ICON[card.status]}
        </span>
        <span className="summary">{card.summary}</span>
        {card.ms !== undefined && <span className="ms">{(card.ms / 1000).toFixed(1)}s</span>}
      </summary>
      {hasBody && (
        <div className="tool-body">
          {card.display && <DisplayView display={card.display} />}
          {card.media?.map((m) =>
            m.kind === 'image' ? (
              <img key={m.url} src={m.url} alt={m.name} className="media" />
            ) : m.kind === 'audio' ? (
              // biome-ignore lint/a11y/useMediaCaption: generated speech has no caption track
              <audio key={m.url} src={m.url} controls className="media" />
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: generated video has no caption track
              <video key={m.url} src={m.url} controls className="media" />
            ),
          )}
          {card.output && <pre className="output">{card.output}</pre>}
        </div>
      )}
    </details>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="bubble">{entry.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg assistant">
          <Markdown text={entry.text} />
        </div>
      );
    case 'reasoning':
      return (
        <details className="reasoning">
          <summary>Reasoning</summary>
          <div>{entry.text}</div>
        </details>
      );
    case 'tool':
      return <ToolCardView card={entry.card} />;
    case 'notice':
      return <div className="notice">{entry.text}</div>;
    case 'command':
      return <pre className="command-output">{entry.text}</pre>;
    case 'error':
      return (
        <div className="error-msg" role="alert">
          {entry.text}
        </div>
      );
  }
}

// ---------- the conversation ----------

function Transcript({ conv }: { conv: ConversationView }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the content grows
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [conv.entries.length, conv.live, conv.reasoning, conv.asks.length]);
  return (
    <div
      className="transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {conv.entries.length === 0 && !conv.live && (
        <div className="empty">
          <p>New conversation in</p>
          <p className="path">{conv.cwd}</p>
        </div>
      )}
      {conv.entries.map((e) => (
        <EntryView key={e.id} entry={e} />
      ))}
      {conv.reasoning && <div className="reasoning live">{conv.reasoning}</div>}
      {conv.live && (
        <div className="msg assistant">
          <Markdown text={conv.live} />
        </div>
      )}
      {conv.running && !conv.live && conv.asks.length === 0 && (
        <div className="working" aria-live="polite">
          Working…
        </div>
      )}
    </div>
  );
}

function AskPanel({ conv, send }: { conv: ConversationView; send: Send }) {
  const ask = conv.asks[0];
  if (!ask) return null;
  const answer = (a: 'yes' | 'no' | 'always') =>
    send({ type: 'ask.answer', askId: ask.askId, answer: a });
  return (
    <section className="ask" aria-label="Permission request">
      <div className="ask-title">
        mrig wants to: <strong>{ask.summary}</strong>
        {conv.asks.length > 1 && (
          <span className="more"> · {conv.asks.length - 1} more waiting</span>
        )}
      </div>
      {ask.preview && <pre className="preview">{ask.preview}</pre>}
      <div className="ask-buttons">
        <button type="button" className="primary" onClick={() => answer('yes')}>
          Allow once <kbd>y</kbd>
        </button>
        <button
          type="button"
          onClick={() => answer('always')}
          title={`Adds the rule ${ask.alwaysRule}`}
        >
          Always allow <kbd>a</kbd>
        </button>
        <button type="button" className="danger" onClick={() => answer('no')}>
          Deny <kbd>n</kbd>
        </button>
      </div>
      <div className="ask-rule">Always adds the allow rule {ask.alwaysRule}</div>
    </section>
  );
}

function Composer({ conv, send, token }: { conv: ConversationView; send: Send; token?: string }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Array<{ name: string; path: string; preview: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  const attach = async (list: FileList | File[]) => {
    setError('');
    for (const file of Array.from(list)) {
      if (!file.type.startsWith('image/')) {
        setError(`${file.name} is not an image.`);
        continue;
      }
      setBusy(true);
      try {
        const path = await upload(file, token);
        setFiles((f) => [...f, { name: file.name, path, preview: URL.createObjectURL(file) }]);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    }
  };

  const submit = () => {
    const body = text.trim();
    if ((!body && files.length === 0) || conv.running) return;
    if (body.startsWith('/') && files.length === 0) {
      send({ type: 'command.run', conversation: conv.conversation, text: body });
    } else {
      const paths = files.map((f) => `"${f.path}"`).join(' ');
      send({
        type: 'turn.send',
        conversation: conv.conversation,
        text: [body, paths].filter(Boolean).join('\n\n'),
      });
    }
    setText('');
    setFiles([]);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus on conversation change
  useEffect(() => box.current?.focus(), [conv.conversation]);

  // Text from the command palette or the host (VS Code's "Ask mrig about this").
  useEffect(() => {
    const onInsert = (e: Event) => {
      const { text: add, replace } = (e as CustomEvent<{ text: string; replace: boolean }>).detail;
      setText((t) => (replace || !t.trim() ? add : `${t.trimEnd()}\n${add}`));
      box.current?.focus();
    };
    window.addEventListener('mrig:insert', onInsert);
    return () => window.removeEventListener('mrig:insert', onInsert);
  }, []);

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void attach(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f) => (
            <span key={f.path} className="chip">
              <img src={f.preview} alt="" />
              {f.name}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((all) => all.filter((x) => x !== f))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      <div className="composer-row">
        <label className="attach" title="Attach an image">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(e) => {
              if (e.target.files) void attach(e.target.files);
              e.target.value = '';
            }}
          />
          <span aria-hidden="true">＋</span>
          <span className="sr-only">Attach an image</span>
        </label>
        <textarea
          ref={box}
          value={text}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder={conv.running ? 'mrig is working…' : 'Message mrig, or / for commands'}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith('image/'),
            );
            if (images.length) {
              e.preventDefault();
              void attach(images);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          className="send primary"
          disabled={conv.running || busy || (!text.trim() && !files.length)}
        >
          Send
        </button>
      </div>
    </form>
  );
}

function StatusBar({
  conv,
  connection,
}: {
  conv?: ConversationView;
  connection: AppState['connection'];
}) {
  const s = conv?.status;
  return (
    <footer className="status">
      <span className={`dot ${connection}`} title={connection} />
      {connection !== 'open' && (
        <span>{connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span>
      )}
      {s && (
        <>
          <span>{s.model}</span>
          <span>
            {s.tokensIn.toLocaleString()} in / {s.tokensOut.toLocaleString()} out
          </span>
          {s.cost !== undefined && <span>~${s.cost.toFixed(4)}</span>}
          <span>context {s.contextPct}%</span>
          {s.mode && <span>{s.mode} mode</span>}
          {s.mcp && <span>mcp {s.mcp}</span>}
          {s.offline && <span className="warn">{s.offline}</span>}
          {s.yolo && <span className="warn">yolo</span>}
        </>
      )}
    </footer>
  );
}

function Header({
  conv,
  send,
  onMenu,
}: {
  conv?: ConversationView;
  send: Send;
  onMenu: () => void;
}) {
  const provider = conv?.status.model.split('/')[0] ?? '';
  const mode = conv?.status.mode?.split(' ')[0] ?? 'default';
  const [variety, setVariety] = useState('');
  return (
    <header className="top">
      <button type="button" className="menu" aria-label="Show conversations" onClick={onMenu}>
        ☰
      </button>
      <div className="title">
        <div className="name">{conv ? conv.title || 'New conversation' : 'mrig'}</div>
        {conv && <div className="where">{conv.cwd}</div>}
      </div>
      {conv && (
        <div className="pickers">
          <label>
            <span className="sr-only">Model</span>
            <select
              value={provider}
              disabled={conv.running}
              onChange={(e) =>
                send({
                  type: 'model.set',
                  conversation: conv.conversation,
                  provider: e.target.value,
                })
              }
            >
              {!conv.options.providers.includes(provider) && (
                <option value={provider}>{provider}</option>
              )}
              {conv.options.providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Mode</span>
            <select
              value={mode}
              disabled={conv.running}
              onChange={(e) => {
                const m = e.target.value;
                if (m === 'tutor') {
                  const v = variety || conv.options.varieties[0] || '';
                  setVariety(v);
                  send({ type: 'mode.set', conversation: conv.conversation, mode: m, variety: v });
                } else send({ type: 'mode.set', conversation: conv.conversation, mode: m });
              }}
            >
              {conv.options.modes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          {mode === 'tutor' && (
            <label>
              <span className="sr-only">Variety</span>
              <select
                value={variety || conv.status.mode?.match(/\((\w+)\)/)?.[1] || ''}
                onChange={(e) => {
                  setVariety(e.target.value);
                  send({
                    type: 'mode.set',
                    conversation: conv.conversation,
                    mode: 'tutor',
                    variety: e.target.value,
                  });
                }}
              >
                {conv.options.varieties.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}
          {conv.running && (
            <button
              type="button"
              className="stop danger"
              onClick={() => send({ type: 'turn.abort', conversation: conv.conversation })}
            >
              Stop
            </button>
          )}
        </div>
      )}
    </header>
  );
}

// ---------- sidebar ----------

function Sidebar({
  state,
  send,
  act,
  onPick,
}: {
  state: AppState;
  send: Send;
  act: Act;
  onPick: () => void;
}) {
  const [open, setOpen] = useState<string | undefined>();
  const [folder, setFolder] = useState('');
  // A conversation opened or closed: refresh the projects, so a new folder shows up.
  const opened = state.order.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the open set changes
  useEffect(() => send({ type: 'projects.list' }), [opened, send]);
  const openFolder = (cwd: string, resume?: string) => {
    act({ type: 'local.opening' });
    send({ type: 'session.open', cwd, ...(resume ? { resume } : {}) });
    onPick();
  };
  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="brand">mrig</div>
      {state.order.length > 0 && (
        <section>
          <h2>Open</h2>
          <ul>
            {state.order.map((id) => {
              const c = state.conversations[id];
              if (!c) return null;
              return (
                <li key={id} className={state.active === id ? 'active' : ''}>
                  <button
                    type="button"
                    className="conv"
                    onClick={() => {
                      act({ type: 'local.select', conversation: id });
                      onPick();
                    }}
                  >
                    <span className="conv-title">{c.title || 'New conversation'}</span>
                    <span className="conv-where">{base(c.cwd)}</span>
                    {c.asks.length > 0 && <span className="badge">{c.asks.length}</span>}
                    {c.running && c.asks.length === 0 && (
                      <span className="spinner" role="img" aria-label="working" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="close"
                    aria-label={`Close ${c.title || 'conversation'}`}
                    onClick={() => {
                      send({ type: 'session.close', conversation: id });
                      act({ type: 'local.close', conversation: id });
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section>
        <h2>Projects</h2>
        <ul>
          {state.projects.map((p) => (
            <li key={p.cwd}>
              <button
                type="button"
                className="project"
                title={p.cwd}
                aria-expanded={open === p.cwd}
                onClick={() => {
                  const next = open === p.cwd ? undefined : p.cwd;
                  setOpen(next);
                  if (next) send({ type: 'sessions.list', cwd: next });
                }}
              >
                {base(p.cwd)}
              </button>
              {open === p.cwd && (
                <ul className="sessions">
                  <li>
                    <button type="button" className="new" onClick={() => openFolder(p.cwd)}>
                      ＋ New conversation
                    </button>
                  </li>
                  {(state.sessions[p.cwd] ?? []).slice(0, 30).map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => openFolder(s.cwd, s.id)}>
                        <span className="conv-title">{s.title || '(empty)'}</span>
                        <span className="conv-where">
                          {s.updatedAt.slice(0, 16).replace('T', ' ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <form
          className="open-folder"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder.trim()) openFolder(folder.trim());
            setFolder('');
          }}
        >
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="/path/to/a/project"
            aria-label="Open a folder by path"
          />
          <button type="submit">Open</button>
        </form>
      </section>
    </nav>
  );
}

// ---------- command palette ----------

export const COMMANDS: Array<{ name: string; help: string; arg?: string }> = [
  { name: '/help', help: 'Every command' },
  { name: '/cost', help: 'Tokens and cost so far' },
  { name: '/context', help: 'How full the context is' },
  { name: '/compact', help: 'Summarize the conversation to free context' },
  { name: '/clear', help: 'Start over in this conversation' },
  { name: '/model', help: 'Switch model', arg: '<id>' },
  { name: '/provider', help: 'Switch profile', arg: '<name>' },
  { name: '/mode', help: 'Switch mode', arg: '<name>' },
  { name: '/route', help: 'Model routing on, off, easy or hard', arg: '<on|off|easy|hard>' },
  { name: '/verbose', help: 'Show the model’s reasoning' },
  { name: '/lang', help: 'Language memory' },
  { name: '/learned', help: 'What you have learned' },
  { name: '/mcp', help: 'MCP servers' },
  { name: '/sessions', help: 'Saved sessions' },
  { name: '/yolo', help: 'Skip permission prompts (careful)' },
];

function Palette({
  onRun,
  onFill,
  onClose,
}: {
  onRun: (c: string) => void;
  onFill: (c: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = COMMANDS.filter((c) =>
    `${c.name} ${c.help}`.toLowerCase().includes(q.toLowerCase().replace(/^\//, '')),
  );
  const choose = (i: number) => {
    const c = items[i];
    if (!c) return;
    if (c.arg) onFill(`${c.name} `);
    else onRun(c.name);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes the dialog on click
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it from the input
    <div
      className="backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Commands">
        <input
          // biome-ignore lint/a11y/noAutofocus: a command palette opens ready to type
          autoFocus
          value={q}
          placeholder="Type a command"
          aria-label="Search commands"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((s) => Math.min(items.length - 1, s + 1));
            else if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            else if (e.key === 'Enter') choose(sel);
            else if (e.key === 'Escape') onClose();
          }}
        />
        <ul>
          {items.map((c, i) => (
            <li key={c.name}>
              <button type="button" className={i === sel ? 'sel' : ''} onClick={() => choose(i)}>
                <span className="cmd">
                  {c.name}
                  {c.arg ? ` ${c.arg}` : ''}
                </span>
                <span className="help">{c.help}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------- pairing ----------

const PAIR_ERRORS: Record<string, string> = {
  wrong: "That code isn't right. Check it and try again.",
  expired: 'That code has expired. Make a new one on your Mac.',
  burned: 'Too many wrong tries, so that code was cancelled. Make a new one on your Mac.',
  'no-code': 'There is no open pairing code for that device. Make one on your Mac.',
  unknown: "That device isn't on the allowlist. Add it on your Mac first.",
  'slow-down': 'Too many tries. Wait a minute, then try again.',
  offline: "Can't reach mrig. Is `mrig app` running on your Mac?",
};

export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const params = new URLSearchParams(location.hash.slice(1));
  const [device, setDevice] = useState(params.get('device') ?? '');
  const [code, setCode] = useState(params.get('pair') ?? '');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const tried = useRef(false);

  const submit = async () => {
    setWorking(true);
    setError('');
    const result = await pair(device.trim().toLowerCase(), code.trim());
    setWorking(false);
    if (result.ok) {
      history.replaceState(null, '', location.pathname); // drop the code from the address bar
      onPaired();
    } else setError(PAIR_ERRORS[result.reason] ?? `Pairing failed (${result.reason}).`);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once, when mrig app opened us with a code
  useEffect(() => {
    if (!tried.current && params.get('pair') && params.get('device')) {
      tried.current = true;
      void submit();
    }
  }, []);

  return (
    <main className="pair">
      <h1>Pair this device with mrig</h1>
      <p>
        Only devices on your allowlist can use mrig. On your Mac, run{' '}
        <code>mrig app allow add {device || '<name>'}</code> and enter the code it shows.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Device name
          <input
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            placeholder="phone"
            autoComplete="off"
          />
        </label>
        <label>
          Pairing code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD2345"
            autoComplete="one-time-code"
            inputMode="text"
          />
        </label>
        {error && (
          <p className="error-msg" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="primary"
          disabled={working || !device.trim() || code.trim().length < 8}
        >
          {working ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </main>
  );
}

// ---------- the shell ----------

export function Shell({
  state,
  send,
  act,
  token,
}: {
  state: AppState;
  send: Send;
  act: Act;
  token?: string;
}) {
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const conv = state.active ? state.conversations[state.active] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.key === 'Escape') {
        setPalette(false);
        setDrawer(false);
        return;
      }
      const target = e.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      const ask = conv?.asks[0];
      if (ask && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const answer = ({ y: 'yes', a: 'always', n: 'no' } as const)[e.key as 'y' | 'a' | 'n'];
        if (answer) {
          e.preventDefault();
          send({ type: 'ask.answer', askId: ask.askId, answer });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conv, send]);

  const fill = (text: string) => {
    setPalette(false);
    insertIntoComposer(text, true);
  };

  return (
    <div className={`shell${drawer ? ' drawer-open' : ''}`}>
      <Sidebar state={state} send={send} act={act} onPick={() => setDrawer(false)} />
      {drawer && (
        // biome-ignore lint/a11y/noStaticElementInteractions: tapping outside closes the drawer
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it too
        <div className="scrim" onClick={() => setDrawer(false)} />
      )}
      <main className="main">
        <Header conv={conv} send={send} onMenu={() => setDrawer(true)} />
        {state.error && (
          <div className="banner error-msg" role="alert">
            {state.error}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => act({ type: 'local.dismissError' })}
            >
              ×
            </button>
          </div>
        )}
        {conv ? (
          <>
            <Transcript conv={conv} />
            <AskPanel conv={conv} send={send} />
            <Composer conv={conv} send={send} {...(token ? { token } : {})} />
          </>
        ) : (
          <div className="welcome">
            <h1>mrig</h1>
            <p>
              Pick a project on the left, or open a folder by its path, to start a conversation.
            </p>
            <p className="hint">
              <kbd>⌘K</kbd> commands · <kbd>y</kbd> <kbd>a</kbd> <kbd>n</kbd> answer a permission
              request
            </p>
          </div>
        )}
        <StatusBar conv={conv} connection={state.connection} />
      </main>
      {palette && conv && (
        <Palette
          onClose={() => setPalette(false)}
          onFill={fill}
          onRun={(c) => {
            setPalette(false);
            send({ type: 'command.run', conversation: conv.conversation, text: c });
          }}
        />
      )}
    </div>
  );
}

export { plural };
