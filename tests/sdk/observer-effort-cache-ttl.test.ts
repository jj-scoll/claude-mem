import { describe, expect, it, spyOn, afterEach } from 'bun:test';
import {
  buildHardenedSdkOptions,
  resolveObserverEffort,
  resolveObserverCacheTtl,
  DEFAULT_OBSERVER_EFFORT,
  DEFAULT_OBSERVER_CACHE_TTL,
} from '../../src/sdk/hardened-options.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

/**
 * CLAUDE_MEM_OBSERVER_EFFORT (default `low`) and CLAUDE_MEM_OBSERVER_CACHE_TTL
 * (default `5m`) shrink the cost of one-shot observer prompts: effort is the
 * only lever on Haiku 5.5's adaptive thinking, and a 1h prompt-cache write
 * costs 2x input for a prefix that is never read back.
 */
describe('observer effort / cache TTL settings', () => {
  let warnSpy: ReturnType<typeof spyOn>;
  afterEach(() => warnSpy?.mockRestore());

  it('registers the shipped defaults', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults() as unknown as Record<string, string>;
    expect(defaults.CLAUDE_MEM_OBSERVER_EFFORT).toBe('low');
    expect(defaults.CLAUDE_MEM_OBSERVER_CACHE_TTL).toBe('5m');
    expect(DEFAULT_OBSERVER_EFFORT).toBe('low');
    expect(DEFAULT_OBSERVER_CACHE_TTL).toBe('5m');
  });

  it('resolveObserverEffort accepts the SDK effort levels, case-insensitively', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolveObserverEffort(level)).toBe(level);
    }
    expect(resolveObserverEffort(' HIGH ')).toBe('high');
  });

  it('resolveObserverEffort falls back to low for unset, empty, or invalid values', () => {
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    expect(resolveObserverEffort(undefined)).toBe('low');
    expect(resolveObserverEffort('')).toBe('low');
    expect(resolveObserverEffort('turbo')).toBe('low');
    expect(resolveObserverEffort(42 as unknown as string)).toBe('low');
    expect(warnSpy).toHaveBeenCalledTimes(2); // 'turbo' and 42; unset/empty are silent
  });

  it('resolveObserverCacheTtl accepts 5m and 1h', () => {
    expect(resolveObserverCacheTtl('5m')).toBe('5m');
    expect(resolveObserverCacheTtl(' 1H ')).toBe('1h');
  });

  it('resolveObserverCacheTtl falls back to 5m for unset, empty, or invalid values', () => {
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    expect(resolveObserverCacheTtl(undefined)).toBe('5m');
    expect(resolveObserverCacheTtl('')).toBe('5m');
    expect(resolveObserverCacheTtl('24h')).toBe('5m');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  const base = {
    source: 'Observer' as const,
    model: 'claude-haiku-5-5',
    env: { PATH: '/bin' } as NodeJS.ProcessEnv,
    pathToClaudeCodeExecutable: '/mock/claude',
  };

  it('buildHardenedSdkOptions leaves effort and cache TTL untouched when the caller passes none (generation path)', () => {
    const opts = buildHardenedSdkOptions(base);
    expect('effort' in opts).toBe(false);
    expect(opts.env?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
  });

  it('buildHardenedSdkOptions sets the SDK effort option and CLAUDE_CODE_PROMPT_CACHE_TTL for Observer', () => {
    const opts = buildHardenedSdkOptions({ ...base, effort: 'low', promptCacheTtl: '5m' });
    expect(opts.effort).toBe('low');
    expect(opts.env?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
    expect(opts.env?.PATH).toBe('/bin');
  });

  it('buildHardenedSdkOptions does not mutate the caller env', () => {
    const env = { PATH: '/bin' } as NodeJS.ProcessEnv;
    buildHardenedSdkOptions({ ...base, env, promptCacheTtl: '1h' });
    expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
  });

  it('buildHardenedSdkOptions never applies them to KnowledgeAgent', () => {
    const opts = buildHardenedSdkOptions({ ...base, source: 'KnowledgeAgent', effort: 'low', promptCacheTtl: '5m' });
    expect('effort' in opts).toBe(false);
    expect(opts.env?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
  });
});
