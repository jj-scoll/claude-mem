import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

/**
 * Snapshot the real namespaces EAGERLY, before the mock.module calls below.
 * `import * as x` yields a live namespace object that bun re-points when the
 * module is mocked, so spreading it later (inside afterAll) would copy the
 * stubs back in and leak them into every test file that runs after this one.
 */
const realHookSettingsSnapshot = { ...realHookSettings };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const calls: unknown[][] = [];
let includeAllSources = false;
let contextProjects = 'current';
let excludedProjects = '';
let projectCatalog: string[] | 'reject' = ['other-project', 'repo-project', 'third-project'];
let showTerminalOutput = false;
let workerUnreachable = false;
let provider = 'claude';
let quotaFallbackProvider = '';
let proFallbackAt = '';
let openRouterBaseUrl = '';
let staleReason: string | null = null;
let memoryInstructions: string | undefined = 'false';
let workerBody = 'context from worker';
/** What POST /api/handoff/claim answers: a section, undefined for 204, or 'throw' for a timeout. */
let handoffClaim: string | undefined = undefined;
const outageNoticeRequests: Array<string | undefined> = [];

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: String(showTerminalOutput),
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: String(includeAllSources),
    CLAUDE_MEM_CONTEXT_PROJECTS: contextProjects,
    CLAUDE_MEM_EXCLUDED_PROJECTS: excludedProjects,
    CLAUDE_MEM_PROVIDER: provider,
    CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: quotaFallbackProvider,
    CLAUDE_MEM_PRO_FALLBACK_AT: proFallbackAt,
    CLAUDE_MEM_OPENROUTER_BASE_URL: openRouterBaseUrl,
    CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: memoryInstructions,
  }),
}));

mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => staleReason }));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: 'parent-project',
    isWorktree: true,
    allProjects: ['parent-project', 'repo-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (...args: unknown[]) => {
    calls.push(args);
    if (args[0] === '/api/projects') {
      if (projectCatalog === 'reject') throw new Error('catalog unavailable');
      return { projects: projectCatalog };
    }
    if (args[0] === '/api/handoff/claim') {
      if (handoffClaim === 'throw') throw new Error('The operation timed out.');
      return handoffClaim;
    }
    return workerBody;
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => workerUnreachable,
  consumeWorkerOutageNotice: async (sessionId: string | undefined) => {
    outageNoticeRequests.push(sessionId);
    return 'claude-mem worker unreachable for 3 consecutive hooks';
  },
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

beforeEach(() => {
  provider = 'claude';
  quotaFallbackProvider = '';
  proFallbackAt = '';
  openRouterBaseUrl = '';
  staleReason = null;
  memoryInstructions = 'false';
  workerBody = 'context from worker';
  handoffClaim = undefined;
});

describe('SessionStart block size', () => {
  const HEADER = '# [repo-project] recent context, 2026-10-20 8:43pm EDT';
  // Timeline-shaped lines with a 3-byte glyph each, so bytes run ahead of characters.
  const bodyOfChars = (chars: number) => {
    const lines = [HEADER];
    for (let id = 100_000; lines.join('\n').length < chars; id++) lines.push(`${id} 8:28p ● ${'t'.repeat(60)}`);
    return lines.join('\n').slice(0, chars);
  };
  const jsonBytes = (text: string | undefined) => Buffer.byteLength(JSON.stringify(text ?? ''), 'utf8');

  it('keeps the block within 9,000 JSON-encoded bytes by cutting the timeline tail, not the header or the instructions', async () => {
    memoryInstructions = undefined;
    workerBody = bodyOfChars(7_900);
    staleReason = 'expired keychain entry';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({ sessionId: 'size-guard', cwd: '/tmp/repo', platform: 'claude-code' });
    const block = result.hookSpecificOutput?.additionalContext;

    expect(jsonBytes(block)).toBeLessThanOrEqual(9_000);
    expect(block).toStartWith('[claude-mem] Claude Code OAuth token is stale: expired keychain entry');
    expect(block).toContain(`\n\n${HEADER}\n100000 8:28p ●`);
    expect(block).toContain('save_memory tool is available');
    expect(block).not.toContain(workerBody);
  });

  it('drops an oversize notice rather than the body header', async () => {
    workerBody = bodyOfChars(2_000);
    staleReason = 'x'.repeat(9_500);
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({ sessionId: 'size-guard-notice', cwd: '/tmp/repo', platform: 'claude-code' });
    const block = result.hookSpecificOutput?.additionalContext;

    expect(jsonBytes(block)).toBeLessThanOrEqual(9_000);
    expect(block).toStartWith(HEADER);
    expect(block).toContain(workerBody);
  });

  it('leaves a block that fits exactly as it was', async () => {
    workerBody = bodyOfChars(3_000);
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({ sessionId: 'size-guard-fits', cwd: '/tmp/repo', platform: 'claude-code' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(workerBody);
  });

  it('keeps a whole handoff, the body header and the instructions within 9,000 bytes by cutting the timeline tail', async () => {
    memoryInstructions = undefined;
    workerBody = bodyOfChars(7_900);
    handoffClaim = `# Handoff from a previous session (written 5 minutes ago, shown once)\n${'h'.repeat(3_300)}\nDetails: full text in HANDOFF.md`;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({ sessionId: 'size-guard-handoff', cwd: '/tmp/repo', platform: 'claude-code', sessionSource: 'clear' });
    const block = result.hookSpecificOutput?.additionalContext;

    expect(jsonBytes(block)).toBeLessThanOrEqual(9_000);
    expect(block).toStartWith(`${handoffClaim}\n\n${HEADER}\n100000 8:28p ●`);
    expect(block).toContain('save_memory tool is available');
  });
});

describe('SessionStart handoff', () => {
  const HANDOFF = '# Handoff from a previous session (written 5 minutes ago, shown once)\nGoal: ship\nDetails: full text in HANDOFF.md';

  it('claims the handoff once the body is in hand and starts the block with it', async () => {
    handoffClaim = HANDOFF;
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({ sessionId: 'handoff', cwd: '/tmp/repo', platform: 'claude-code', sessionSource: 'clear' });

    expect(result.hookSpecificOutput?.additionalContext).toBe(`${HANDOFF}\n\ncontext from worker`);
    expect(calls.at(-1)).toEqual(['/api/handoff/claim', 'POST', { cwd: '/tmp/repo', source: 'clear' }, { timeoutMs: 2_000 }]);
  });

  it('ignores what a worker without the claim route answers', async () => {
    // Express's 404 page, which the worker call hands back for a 4xx.
    handoffClaim = '<!DOCTYPE html>\n<html lang="en">\n<body>\n<pre>Cannot POST /api/handoff/claim</pre>\n</body>\n</html>';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({ sessionId: 'handoff-old-worker', cwd: '/tmp/repo', platform: 'claude-code', sessionSource: 'clear' });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
  });

  it('goes on without a handoff when the claim times out', async () => {
    handoffClaim = 'throw';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({ sessionId: 'handoff-timeout', cwd: '/tmp/repo', platform: 'claude-code', sessionSource: 'startup' });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
  });

  it('does not claim when the body could not be read, so the handoff waits for a session that can show it', async () => {
    handoffClaim = HANDOFF;
    workerUnreachable = true;
    calls.length = 0;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      await contextHandler.execute({ sessionId: 'handoff-outage', cwd: '/tmp/repo', platform: 'claude-code', sessionSource: 'clear' });

      expect(calls.some(call => call[0] === '/api/handoff/claim')).toBe(false);
    } finally {
      workerUnreachable = false;
    }
  });
});

describe('contextHandler SessionStart path', () => {
  it('reads only this checkout by default and every project, this checkout last, when CLAUDE_MEM_CONTEXT_PROJECTS is all', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const injectUrl = () => String(calls.filter(call => String(call[0]).startsWith('/api/context/inject')).at(-1)?.[0]);
    const projectsOf = (url: string) => decodeURIComponent(new URL(url, 'http://x').searchParams.get('projects') ?? '');

    calls.length = 0;
    await contextHandler.execute({ sessionId: 'projects-current', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(projectsOf(injectUrl())).toBe('parent-project,repo-project');
    expect(calls.some(call => call[0] === '/api/projects')).toBe(false);

    contextProjects = 'all';
    try {
      calls.length = 0;
      await contextHandler.execute({ sessionId: 'projects-all', cwd: '/tmp/repo', platform: 'claude-code' });
      expect(projectsOf(injectUrl())).toBe('other-project,third-project,parent-project,repo-project');
    } finally { contextProjects = 'current'; }
  });
  describe('CLAUDE_MEM_CONTEXT_PROJECTS=all', () => {
    const injectedProjects = () => {
      const url = String(calls.filter(call => String(call[0]).startsWith('/api/context/inject')).at(-1)?.[0]);
      return decodeURIComponent(new URL(url, 'http://x').searchParams.get('projects') ?? '');
    };
    const runAll = async (sessionId: string) => {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      calls.length = 0;
      return contextHandler.execute({ sessionId, cwd: '/tmp/repo', platform: 'claude-code' });
    };
    beforeEach(() => { contextProjects = 'all'; });
    afterAll(() => {
      contextProjects = 'current';
      excludedProjects = '';
      projectCatalog = ['other-project', 'repo-project', 'third-project'];
    });

    it('asks the catalog with a bounded timeout and falls back to this checkout when it rejects', async () => {
      projectCatalog = 'reject';
      await runAll('catalog-rejects');
      expect(injectedProjects()).toBe('parent-project,repo-project');
      const catalogCall = calls.find(call => call[0] === '/api/projects');
      expect(catalogCall?.[3]).toMatchObject({ timeoutMs: 2_000 });
    });

    it('keeps the projects param stable whatever order the catalog returns', async () => {
      projectCatalog = ['zeta', 'alpha'];
      await runAll('catalog-order-1');
      const first = injectedProjects();
      projectCatalog = ['alpha', 'zeta'];
      await runAll('catalog-order-2');
      expect(injectedProjects()).toBe(first);
      expect(first).toBe('alpha,zeta,parent-project,repo-project');
    });

    it('drops catalog projects matched by CLAUDE_MEM_EXCLUDED_PROJECTS', async () => {
      projectCatalog = ['alpha', 'secret-client', 'zeta'];
      excludedProjects = 'secret-*';
      try {
        await runAll('catalog-excluded');
        expect(injectedProjects()).toBe('alpha,zeta,parent-project,repo-project');
      } finally { excludedProjects = ''; }
    });

    it('does not ask the local catalog in server runtime', async () => {
      const { resolveSessionStartProjects } = await import('../../../src/cli/handlers/context.js');
      calls.length = 0;
      const projects = await resolveSessionStartProjects(
        { CLAUDE_MEM_CONTEXT_PROJECTS: 'all', CLAUDE_MEM_EXCLUDED_PROJECTS: '' },
        ['parent-project', 'repo-project'],
        'server',
      );
      expect(projects).toEqual(['parent-project', 'repo-project']);
      expect(calls.some(call => call[0] === '/api/projects')).toBe(false);
    });
  });
  it('steers note-taking to available plugin tools by default and still injects instructions during a worker outage', async () => {
    memoryInstructions = undefined;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const input = { sessionId: 'memory-instructions', cwd: '/tmp/repo', platform: 'codex' };
    const result = await contextHandler.execute(input);
    expect(result.hookSpecificOutput?.additionalContext).toContain('context from worker');
    expect(result.hookSpecificOutput?.additionalContext).toContain('save_memory tool is available');
    expect(result.hookSpecificOutput?.additionalContext).toContain('concise purpose-specific text');
    expect(result.hookSpecificOutput?.additionalContext).toContain('internal metadata out of model context');
    expect(result.hookSpecificOutput?.additionalContext).toContain('observation_add for the selected server project');
    expect(result.hookSpecificOutput?.additionalContext).toContain('save_memory is local-worker only');
    expect(result.hookSpecificOutput?.additionalContext).toContain('hosted read-only connector');
    workerUnreachable = true;
    try {
      const fallback = await contextHandler.execute(input);
      expect(fallback.hookSpecificOutput?.additionalContext).toContain('save_memory tool is available');
    } finally { workerUnreachable = false; }
  });
  it('skips the model and terminal timeline on Claude resume before contacting the worker', async () => {
    calls.length = 0;
    outageNoticeRequests.length = 0;
    showTerminalOutput = true;
    workerUnreachable = true;
    staleReason = 'expired keychain entry';
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-resume-claude',
        cwd: '/tmp/repo',
        platform: 'claude-code',
        sessionSource: 'resume',
      });

      expect(result).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
        exitCode: 0,
      });
      expect(calls).toEqual([]);
      expect(outageNoticeRequests).toEqual([]);
    } finally {
      showTerminalOutput = false;
      workerUnreachable = false;
    }
  });

  for (const sessionSource of ['startup', 'clear', 'compact'] as const) {
    it(`keeps model and terminal context on Claude ${sessionSource}`, async () => {
      calls.length = 0;
      showTerminalOutput = true;
      try {
        const { contextHandler } = await import('../../../src/cli/handlers/context.js');
        const result = await contextHandler.execute({
          sessionId: `session-${sessionSource}-claude`,
          cwd: '/tmp/repo',
          platform: 'claude-code',
          sessionSource,
        });

        expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
        expect(result.systemMessage).toContain('context from worker');
        expect(calls.map(call => call[0])).toEqual([
          '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude&cwd=%2Ftmp%2Frepo',
          '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude&cwd=%2Ftmp%2Frepo&colors=true',
          '/api/handoff/claim',
        ]);
      } finally {
        showTerminalOutput = false;
      }
    });
  }

  it('keeps context injection for Codex resume', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-resume-codex',
      cwd: '/tmp/repo',
      platform: 'codex',
      sessionSource: 'resume',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(calls).toHaveLength(1);
  });

  for (const memoryProvider of ['codex', 'openai-compatible', 'openrouter', 'gemini']) {
    it(`does not request Claude login when memory uses ${memoryProvider} with the fallback turned off`, async () => {
      provider = memoryProvider;
      quotaFallbackProvider = 'off';
      staleReason = 'expired keychain entry';
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: `session-stale-${memoryProvider}`,
        cwd: '/tmp/repo',
        platform: 'codex',
      });
      expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    });
  }

  for (const memoryProvider of ['claude', '']) {
    it(`keeps the Claude login hint for ${memoryProvider || 'default'} memory`, async () => {
      provider = memoryProvider;
      staleReason = 'expired keychain entry';
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-stale-claude',
        cwd: '/tmp/repo',
        platform: 'codex',
      });
      expect(result.hookSpecificOutput?.additionalContext).toContain('Claude Code OAuth token is stale');
      expect(result.hookSpecificOutput?.additionalContext).toContain('claude auth login');
    });
  }

  it('keeps the Claude login hint for the default (empty) fallback, the Anthropic plan', async () => {
    provider = 'gemini';
    quotaFallbackProvider = '';
    staleReason = 'expired keychain entry';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-stale-default-fallback',
      cwd: '/tmp/repo',
      platform: 'codex',
    });
    expect(result.hookSpecificOutput?.additionalContext).toContain('Claude Code OAuth token is stale');
  });

  it('keeps the Claude login hint for a configured Claude quota fallback', async () => {
    provider = 'codex';
    quotaFallbackProvider = ' claude ';
    staleReason = 'expired keychain entry';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-stale-claude-fallback',
      cwd: '/tmp/repo',
      platform: 'codex',
    });
    expect(result.hookSpecificOutput?.additionalContext).toContain('claude auth login');
  });

  it('keeps the Claude login hint while the primary cmem gateway falls back to Claude', async () => {
    provider = 'openrouter';
    openRouterBaseUrl = 'https://cmem.ai/api/gateway';
    proFallbackAt = new Date().toISOString();
    staleReason = 'expired keychain entry';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-stale-cmem-fallback',
      cwd: '/tmp/repo',
      platform: 'codex',
    });
    expect(result.hookSpecificOutput?.additionalContext).toContain('claude auth login');
  });

  it('injects Codex context with one bounded worker startup and request', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-context',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(calls).toEqual([[
      '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=codex&cwd=%2Ftmp%2Frepo',
      'GET',
      undefined,
      { workerStartupTimeoutMs: 15_000, timeoutMs: 2_000 },
    ]]);
  });

  it('keeps the existing worker lifecycle behavior for Claude', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    await contextHandler.execute({
      sessionId: 'session-context-claude',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(calls).toEqual([
      [
        '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude&cwd=%2Ftmp%2Frepo',
        'GET',
        undefined,
        undefined,
      ],
      ['/api/handoff/claim', 'POST', { cwd: '/tmp/repo' }, { timeoutMs: 2_000 }],
    ]);
  });

  it('includes every source in both Claude startup renders when opted in', async () => {
    calls.length = 0;
    includeAllSources = true;
    showTerminalOutput = true;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-all-sources',
        cwd: '/tmp/repo',
        platform: 'claude-code',
      });

      expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
      expect(result.systemMessage).toContain('context from worker');
      expect(calls.map(call => call[0])).toEqual([
        '/api/context/inject?projects=parent-project%2Crepo-project&cwd=%2Ftmp%2Frepo',
        '/api/context/inject?projects=parent-project%2Crepo-project&cwd=%2Ftmp%2Frepo&colors=true',
        '/api/handoff/claim',
      ]);
    } finally {
      includeAllSources = false;
      showTerminalOutput = false;
    }
  });

  it('shows the worker-outage notice as systemMessage when SessionStart falls back', async () => {
    calls.length = 0;
    outageNoticeRequests.length = 0;
    workerUnreachable = true;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-outage',
        cwd: '/tmp/repo',
        platform: 'claude-code',
      });

      expect(result.hookSpecificOutput?.additionalContext).toBe('');
      expect(result.systemMessage).toBe('claude-mem worker unreachable for 3 consecutive hooks');
      expect(outageNoticeRequests).toEqual(['session-outage']);
    } finally {
      workerUnreachable = false;
    }
  });

  it('includes every source in Codex startup context when opted in', async () => {
    calls.length = 0;
    includeAllSources = true;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      await contextHandler.execute({
        sessionId: 'session-all-sources-codex',
        cwd: '/tmp/repo',
        platform: 'codex',
      });

      expect(calls.map(call => call[0])).toEqual([
        '/api/context/inject?projects=parent-project%2Crepo-project&cwd=%2Ftmp%2Frepo',
      ]);
    } finally {
      includeAllSources = false;
    }
  });
});
