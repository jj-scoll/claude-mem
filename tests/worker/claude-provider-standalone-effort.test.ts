import { describe, it, expect, afterAll, afterEach, mock } from 'bun:test';

// Provider-level coverage: a standalone observer prompt (the field-condense
// call) must carry CLAUDE_MEM_OBSERVER_EFFORT and CLAUDE_MEM_OBSERVER_CACHE_TTL
// into the SDK options. Settings are driven through their env overrides, which
// SettingsDefaultsManager.loadFromFile applies on top of the settings file.
//
// bun's mock.module is process-global and sticky, so real modules are
// snapshotted and re-registered in afterAll.
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };

const capturedSdkOptions: Array<Record<string, any>> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...actualAgentSdk,
  query: (args: { options: Record<string, any> }) => {
    capturedSdkOptions.push(args.options);
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'condensed' }] } };
    })();
  },
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnvManager,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH ?? '' }),
}));

const priorEffort = process.env.CLAUDE_MEM_OBSERVER_EFFORT;
const priorTtl = process.env.CLAUDE_MEM_OBSERVER_CACHE_TTL;
function restore(key: string, prior: string | undefined) {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}
afterEach(() => {
  restore('CLAUDE_MEM_OBSERVER_EFFORT', priorEffort);
  restore('CLAUDE_MEM_OBSERVER_CACHE_TTL', priorTtl);
  capturedSdkOptions.length = 0;
});
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualAgentSdk);
  mock.module('../../src/shared/EnvManager.js', () => actualEnvManager);
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

async function condenseOnce(): Promise<Record<string, any>> {
  const provider = new ClaudeProvider({} as any, {} as any);
  const session = {
    sessionDbId: 1,
    contentSessionId: 'content-1',
    project: 'p',
    abortController: new AbortController(),
  };
  const result = await (provider as any).compressField(
    'x'.repeat(20_000), 1000, session, 'claude-haiku-5-5', '/mock/claude', new AbortController().signal,
  );
  expect(result?.text).toBe('condensed');
  expect(capturedSdkOptions).toHaveLength(1);
  return capturedSdkOptions[0];
}

describe('standalone observer prompt: effort and prompt-cache TTL', () => {
  it('defaults to low effort and a 5m prompt cache', async () => {
    delete process.env.CLAUDE_MEM_OBSERVER_EFFORT;
    delete process.env.CLAUDE_MEM_OBSERVER_CACHE_TTL;
    const options = await condenseOnce();
    expect(options.effort).toBe('low');
    expect(options.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
    expect(options.maxTurns).toBe(1);
  });

  it('honors configured values', async () => {
    process.env.CLAUDE_MEM_OBSERVER_EFFORT = 'high';
    process.env.CLAUDE_MEM_OBSERVER_CACHE_TTL = '1h';
    const options = await condenseOnce();
    expect(options.effort).toBe('high');
    expect(options.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
  });

  it('falls back to the defaults for invalid values', async () => {
    process.env.CLAUDE_MEM_OBSERVER_EFFORT = 'turbo';
    process.env.CLAUDE_MEM_OBSERVER_CACHE_TTL = 'forever';
    const options = await condenseOnce();
    expect(options.effort).toBe('low');
    expect(options.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
  });
});
