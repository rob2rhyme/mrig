import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, type ProviderProfile } from '../src/config.ts';
import {
  checkOllamaContext,
  checkProfile,
  doctor,
  hasProblems,
  isOllama,
  modelMatches,
  modelMaxContext,
  modelsUrl,
  ollamaApiRoot,
  parseNumCtx,
} from '../src/doctor.ts';

type Call = { url: string; headers: Record<string, string> };

/** A fake fetch that records calls and replies per URL prefix. Never touches the network. */
function fakeFetch(reply: (url: string) => Response | Error): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const r = reply(url);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

const list = (...ids: string[]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const claude: ProviderProfile = { kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-test' };

describe('doctor: model-id check against /v1/models', () => {
  test('modelsUrl mirrors the base URL conventions of each provider', () => {
    expect(modelsUrl(claude)).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(modelsUrl({ ...claude, baseURL: 'https://api.anthropic.com' })).toBe(
      'https://api.anthropic.com/v1/models?limit=1000',
    );
    expect(modelsUrl({ kind: 'openai', model: 'gpt-5' })).toBe('https://api.openai.com/v1/models');
    expect(
      modelsUrl({ kind: 'openai-compatible', model: 'x', baseURL: 'http://localhost:11434/v1/' }),
    ).toBe('http://localhost:11434/v1/models');
  });

  test('modelMatches accepts exact ids and the Ollama :latest tag', () => {
    expect(modelMatches('qwen3-coder', ['qwen3-coder:latest', 'gemma'])).toBe(true);
    expect(modelMatches('qwen3-coder:30b', ['qwen3-coder:30b'])).toBe(true);
    expect(modelMatches('qwen3-coder', ['qwen3-coder:30b'])).toBe(false);
  });

  test('anthropic: sends the key and version headers, reports ok when listed', async () => {
    const { fetch, calls } = fakeFetch(() => list('claude-opus-5', 'claude-sonnet-5'));
    const c = await checkProfile('claude', claude, { fetch, env: {} });
    expect(c.status).toBe('ok');
    expect(c.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[0]?.headers).toEqual({
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
    });
  });

  test('unknown model is flagged with suggestions and counts as a problem', async () => {
    const { fetch, calls } = fakeFetch(() => list('gpt-5.5', 'gpt-5.5-mini', 'o9', 'dall-e-9'));
    const c = await checkProfile(
      'openai',
      { kind: 'openai', model: 'gpt-5', apiKeyEnv: 'OPENAI_API_KEY' },
      { fetch, env: { OPENAI_API_KEY: 'k' } },
    );
    expect(c.status).toBe('unknown-model');
    expect(c.message).toMatch(/"gpt-5" is not listed/);
    expect(c.message).toContain('gpt-5.5, gpt-5.5-mini'); // same stem first, not dall-e
    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer k' });
    expect(hasProblems([c])).toBe(true);
  });

  test('missing key is a skip, not a network call', async () => {
    const { fetch, calls } = fakeFetch(() => list());
    const c = await checkProfile('claude', { kind: 'anthropic', model: 'm' }, { fetch, env: {} });
    expect(c.status).toBe('no-key');
    expect(c.message).toContain('ANTHROPIC_API_KEY');
    expect(calls.length).toBe(0);
    expect(hasProblems([c])).toBe(false);
  });

  test('local server: :latest match, placeholder "none" key sends no auth header', async () => {
    const { fetch, calls } = fakeFetch(() => list('qwen3-coder:latest'));
    const ollama = DEFAULT_CONFIG.providers.ollama as ProviderProfile;
    expect((await checkProfile('ollama', ollama, { fetch, env: {} })).status).toBe('ok');
    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer ollama' });
    const llamacpp = DEFAULT_CONFIG.providers.llamacpp as ProviderProfile;
    const c = await checkProfile('llamacpp', llamacpp, { fetch, env: {} });
    expect(c.status).toBe('unknown-model');
    expect(calls[1]?.headers).toEqual({});
  });

  test('unreachable, auth failure, no list, and bad JSON are each distinct', async () => {
    const down = fakeFetch(() => new Error('Unable to connect'));
    const ollama = DEFAULT_CONFIG.providers.ollama as ProviderProfile;
    const c1 = await checkProfile('ollama', ollama, { fetch: down.fetch, env: {} });
    expect(c1.status).toBe('unreachable');
    expect(c1.message).toMatch(/Is the server running\?/);

    const denied = fakeFetch(() => new Response('{}', { status: 401 }));
    expect((await checkProfile('claude', claude, { fetch: denied.fetch, env: {} })).status).toBe(
      'auth',
    );

    const missing = fakeFetch(() => new Response('nope', { status: 404 }));
    const c3 = await checkProfile('claude', claude, { fetch: missing.fetch, env: {} });
    expect(c3.status).toBe('no-list');
    expect(hasProblems([c3])).toBe(false);

    const html = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect((await checkProfile('claude', claude, { fetch: html.fetch, env: {} })).status).toBe(
      'no-list',
    );
  });

  test('doctor() checks every profile, or only one, and rejects unknown names', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.includes('anthropic')
        ? list('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1')
        : list(),
    );
    const all = await doctor(DEFAULT_CONFIG, { fetch, env: { ANTHROPIC_API_KEY: 'k' } });
    expect(all.map((c) => c.name)).toEqual(Object.keys(DEFAULT_CONFIG.providers));
    const byName = Object.fromEntries(all.map((c) => [c.name, c.status]));
    expect(byName.claude).toBe('ok');
    expect(byName.haiku).toBe('unknown-model'); // not in the fake list
    expect(byName.openai).toBe('no-key');
    expect(byName.ollama).toBe('unknown-model'); // empty list from the fake local server
    expect(calls.length).toBe(all.length - 1); // every profile but the key-less one hit the wire

    const one = await doctor(DEFAULT_CONFIG, {
      fetch,
      env: { ANTHROPIC_API_KEY: 'k' },
      only: 'opus',
    });
    expect(one.length).toBe(1);
    expect(one[0]?.status).toBe('ok');
    await expect(doctor(DEFAULT_CONFIG, { fetch, env: {}, only: 'nope' })).rejects.toThrow(
      /Unknown provider "nope"/,
    );
  });
});

describe('doctor: Ollama context length (L2)', () => {
  const ollama = DEFAULT_CONFIG.providers.ollama as ProviderProfile;
  const show = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  test('detects Ollama by name, port or host, and derives the native API root', () => {
    expect(isOllama(ollama)).toBe(true);
    expect(
      isOllama({ kind: 'openai-compatible', model: 'm', baseURL: 'http://gpu:11434/v1' }),
    ).toBe(true);
    expect(
      isOllama({ kind: 'openai-compatible', model: 'm', baseURL: 'https://ollama.lan/v1/' }),
    ).toBe(true);
    expect(isOllama(DEFAULT_CONFIG.providers.lmstudio as ProviderProfile)).toBe(false);
    expect(isOllama(claude)).toBe(false);
    expect(ollamaApiRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(ollamaApiRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434');
  });

  test('parses num_ctx and the model maximum from /api/show payloads', () => {
    expect(parseNumCtx('stop "<|im_end|>"\nnum_ctx 65536\ntemperature 0.7')).toBe(65536);
    expect(parseNumCtx('temperature 0.7')).toBeUndefined();
    expect(parseNumCtx(undefined)).toBeUndefined();
    expect(
      modelMaxContext({ 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }),
    ).toBe(40960);
    expect(modelMaxContext({})).toBeUndefined();
    expect(modelMaxContext(null)).toBeUndefined();
  });

  test('POSTs the model name; ok at 64k, low under 32k, unknown without num_ctx', async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = [];
    const mk = (body: unknown) => {
      const f = async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), method: init?.method, body: String(init?.body) });
        return show(body);
      };
      return f as unknown as typeof fetch;
    };
    const ok = await checkOllamaContext(ollama, { fetch: mk({ parameters: 'num_ctx 65536' }) });
    expect(ok.status).toBe('ok');
    expect(ok.contextLength).toBe(65536);
    expect(seen[0]).toEqual({
      url: 'http://localhost:11434/api/show',
      method: 'POST',
      body: JSON.stringify({ model: 'qwen3-coder' }),
    });

    const low = await checkOllamaContext(ollama, { fetch: mk({ parameters: 'num_ctx 8192' }) });
    expect(low.status).toBe('low');
    expect(low.message).toMatch(/num_ctx 8,192; agents need at least 32,768/);
    expect(low.message).toContain('OLLAMA_CONTEXT_LENGTH=65536');

    const small = await checkOllamaContext(ollama, {
      fetch: mk({ model_info: { 'llama.context_length': 8192 } }),
    });
    expect(small.status).toBe('low');
    expect(small.message).toMatch(/supports at most 8,192/);

    const unknown = await checkOllamaContext(ollama, {
      fetch: mk({ model_info: { 'qwen3.context_length': 262144 } }),
    });
    expect(unknown.status).toBe('unknown');
    expect(unknown.message).toMatch(/did not report a context length/);
  });

  test('non-Ollama profiles and unreachable servers are skipped quietly', async () => {
    const down = fakeFetch(() => new Error('ECONNREFUSED'));
    expect((await checkOllamaContext(ollama, { fetch: down.fetch })).status).toBe('skipped');
    expect((await checkOllamaContext(claude, { fetch: down.fetch })).status).toBe('skipped');
    expect(down.calls.length).toBe(1);
    const err = fakeFetch(() => new Response('nope', { status: 404 }));
    expect((await checkOllamaContext(ollama, { fetch: err.fetch })).status).toBe('skipped');
  });
});
