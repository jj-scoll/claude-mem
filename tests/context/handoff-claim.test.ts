// The handoff the claude-mem:handoff skill leaves in work-state list "handoff"
// is shown to the next session once: SessionStore.claimHandoff returns it when
// it is fresh and unconsumed and appends the entry that consumes it, and
// buildHandoffSection is the block the hook prepends.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { WorkStateFields } from '../../src/services/sqlite/work-state.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { buildHandoffSection } from '../../src/services/context/sections/WorkStateRenderer.js';

const NOW_EPOCH = Date.UTC(2026, 9, 20, 21, 0, 0);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_AGE_MS = 168 * HOUR_MS;

let store: SessionStore;

beforeEach(() => {
  store = new SessionStore(':memory:');
});

afterEach(() => {
  store.close();
});

function writeHandoff(fields: WorkStateFields, ageMs: number, project = 'acme'): void {
  store.appendWorkStateEntry({ project, listName: 'handoff', fields, createdAtEpoch: NOW_EPOCH - ageMs });
}

function handoffRows(project = 'acme'): WorkStateFields[] {
  return store.getWorkStateEntries([project], 'handoff').map(entry => entry.fields);
}

describe('SessionStore.claimHandoff', () => {
  it('returns a fresh handoff once and records who consumed it', () => {
    writeHandoff({ text: 'Goal: ship 15.0.2', obs_ids: '101364,101363' }, HOUR_MS);

    const claimed = store.claimHandoff(['acme'], 'clear', NOW_EPOCH, MAX_AGE_MS);

    expect(claimed?.fields.text).toBe('Goal: ship 15.0.2');
    expect(handoffRows().at(-1)).toEqual({ consumed_at: NOW_EPOCH, consumed_by: 'clear' });
    expect(store.claimHandoff(['acme'], 'startup', NOW_EPOCH + MINUTE_MS, MAX_AGE_MS)).toBeNull();
  });

  it('leaves a handoff older than the maximum age unclaimed and unconsumed', () => {
    writeHandoff({ text: 'Goal: old' }, MAX_AGE_MS + HOUR_MS);

    expect(store.claimHandoff(['acme'], 'startup', NOW_EPOCH, MAX_AGE_MS)).toBeNull();
    expect(handoffRows()).toHaveLength(1);
  });

  it('shows a handoff on compact only when it was written in the last 30 minutes', () => {
    writeHandoff({ text: 'Goal: before compact' }, 31 * MINUTE_MS);
    expect(store.claimHandoff(['acme'], 'compact', NOW_EPOCH, MAX_AGE_MS)).toBeNull();

    writeHandoff({ text: 'Goal: just before compact' }, 29 * MINUTE_MS);
    expect(store.claimHandoff(['acme'], 'compact', NOW_EPOCH, MAX_AGE_MS)?.fields.text).toBe('Goal: just before compact');
  });

  it('never claims on resume', () => {
    writeHandoff({ text: 'Goal: ship' }, MINUTE_MS);

    expect(store.claimHandoff(['acme'], 'resume', NOW_EPOCH, MAX_AGE_MS)).toBeNull();
    expect(handoffRows()).toHaveLength(1);
  });

  it("does not return another project's handoff", () => {
    writeHandoff({ text: 'Goal: elsewhere' }, MINUTE_MS, 'other');

    expect(store.claimHandoff(['acme'], 'startup', NOW_EPOCH, MAX_AGE_MS)).toBeNull();
    expect(handoffRows('other')).toHaveLength(1);
  });

  it('is armed again by a handoff written after the last one was consumed', () => {
    writeHandoff({ text: 'Goal: first' }, 2 * HOUR_MS);
    store.claimHandoff(['acme'], 'clear', NOW_EPOCH - HOUR_MS, MAX_AGE_MS);
    writeHandoff({ text: 'Goal: second' }, 30 * MINUTE_MS);

    expect(store.claimHandoff(['acme'], 'clear', NOW_EPOCH, MAX_AGE_MS)?.fields.text).toBe('Goal: second');
  });

  it('is cancelled by a later entry that clears its text', () => {
    writeHandoff({ text: 'Goal: ship' }, 2 * MINUTE_MS);
    writeHandoff({ text: null }, MINUTE_MS);

    expect(store.claimHandoff(['acme'], 'startup', NOW_EPOCH, MAX_AGE_MS)).toBeNull();
  });

  it('consumes a handoff whose clock ran ahead of this one, so it is not shown again', () => {
    writeHandoff({ text: 'Goal: from a fast clock' }, -5 * MINUTE_MS);

    expect(store.claimHandoff(['acme'], 'startup', NOW_EPOCH, MAX_AGE_MS)?.fields.text).toBe('Goal: from a fast clock');
    expect(store.claimHandoff(['acme'], 'startup', NOW_EPOCH + MINUTE_MS, MAX_AGE_MS)).toBeNull();
  });
});

describe('buildHandoffSection', () => {
  function handoff(fields: WorkStateFields) {
    return { id: 1, project: 'acme', list_name: 'handoff', fields, created_at_epoch: NOW_EPOCH - 2 * HOUR_MS };
  }

  it('gives the text under a heading saying how old it is, then where the details are', () => {
    const section = buildHandoffSection(handoff({ text: 'Goal: ship\nNext: test', obs_ids: '101364,101363', project_dir: '/home/jeff/ask' }), NOW_EPOCH);

    expect(section).toBe([
      '# Handoff from a previous session (written about 2 hours ago, shown once)',
      'Goal: ship',
      'Next: test',
      'Details: get_observations ids 101364,101363; full text in /home/jeff/ask/HANDOFF.md',
    ].join('\n'));
  });

  it('cuts a long handoff to 3500 characters at a line boundary and says so', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `${index} ${'x'.repeat(60)}`);

    const section = buildHandoffSection(handoff({ text: lines.join('\n') }), NOW_EPOCH);

    expect(section.length).toBeLessThanOrEqual(3_500);
    expect(section).toEndWith('\nCut to fit. Details: full text in HANDOFF.md');
    const kept = section.split('\n').slice(1, -1);
    expect(kept.length).toBeGreaterThan(40);
    expect(kept).toEqual(lines.slice(0, kept.length));
  });
});
