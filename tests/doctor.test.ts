import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, type ProviderProfile } from '../src/config.ts';
import { checkProfile, doctor, hasProblems, modelMatches, modelsUrl } from '../src/doctor.ts';

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
        ? list('claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1')
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
    expect(doctor(DEFAULT_CONFIG, { fetch, env: {}, only: 'nope' })).rejects.toThrow(
      /Unknown provider "nope"/,
    );
  });
});
