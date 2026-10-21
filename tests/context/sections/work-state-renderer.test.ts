import { describe, it, expect } from 'bun:test';
import type { WorkStateEntry, WorkStateFields } from '../../../src/services/sqlite/work-state.js';
import {
  buildFactsSection,
  buildWorkStateContextSection,
  foldWorkStateList,
  renderWorkStateLines,
  renderWorkStateList,
  WORK_STATE_RULE,
} from '../../../src/services/context/sections/WorkStateRenderer.js';

const NOW_EPOCH = Date.UTC(2026, 9, 2, 12, 0, 0);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let nextEntryId = 1;
function entry(listName: string, fields: WorkStateFields, ageMs: number): WorkStateEntry {
  return { id: nextEntryId++, project: 'acme', list_name: listName, fields, created_at_epoch: NOW_EPOCH - ageMs };
}

// The release the notch fixture modelled: 13.25.2 blocked on the npm token, then 13.25.3.
function releaseEntries(): WorkStateEntry[] {
  return [
    entry('release', { version: '13.25.2', status: 'blocked', blocked_on: 'npm token' }, 3 * DAY_MS),
    entry('release', { task: 'publish', status: 'todo' }, 3 * DAY_MS),
    entry('release', { task: 'pointer-comments', status: 'todo', issues: '3606 3794 4065 3829' }, 3 * DAY_MS),
    entry('release', { task: 'timeout-decision', status: 'todo' }, 3 * DAY_MS),
    entry('release', { version: '13.25.3', status: 'active', blocked_on: null }, 5 * MINUTE_MS),
    entry('release', { task: 'publish', status: 'dropped', reason: 'superseded by 13.25.3' }, 5 * MINUTE_MS),
    entry('release', { task: 'pointer-comments', status: 'doing' }, 5 * MINUTE_MS),
  ];
}

describe('foldWorkStateList', () => {
  it('keeps the latest value of each key, separately for the list state and each task', () => {
    const folded = foldWorkStateList([
      entry('plan', { phase: 'plan', step: 1 }, 10 * MINUTE_MS),
      entry('plan', { task: 'write-tests', status: 'todo' }, 9 * MINUTE_MS),
      entry('plan', { step: 2 }, 8 * MINUTE_MS),
      entry('plan', { task: 'write-tests', status: 'done', note: 'all green' }, 7 * MINUTE_MS),
      entry('plan', { task: 'open-pr' }, 6 * MINUTE_MS),
    ]);

    expect(folded.state).toEqual({ phase: 'plan', step: 2 });
    expect(folded.stateUpdatedAtEpoch).toBe(NOW_EPOCH - 8 * MINUTE_MS);
    expect([...folded.tasks.keys()]).toEqual(['write-tests', 'open-pr']);
    expect(folded.tasks.get('write-tests')).toEqual({
      fields: { task: 'write-tests', status: 'done', note: 'all green' },
      updatedAtEpoch: NOW_EPOCH - 7 * MINUTE_MS,
    });
  });
});

describe('renderWorkStateList', () => {
  it('shows what is open with how long ago each item last changed, skipping cleared keys', () => {
    expect(renderWorkStateList('release', foldWorkStateList(releaseEntries()), NOW_EPOCH)).toEqual([
      '- release: version=13.25.3, status=active, updated 5 minutes ago',
      '  - [doing] pointer-comments (issues=3606 3794 4065 3829), updated 5 minutes ago',
      '  - [todo] timeout-decision, updated about 3 days ago',
    ]);
  });

  it('hides done and dropped tasks, and a list whose own status is done', () => {
    const finished = foldWorkStateList([
      entry('migration', { migration: 'sqlite-v8', status: 'done' }, MINUTE_MS),
      entry('migration', { task: 'backup', status: 'done' }, MINUTE_MS),
      entry('migration', { task: 'rollback-plan', status: 'dropped' }, MINUTE_MS),
    ]);

    expect(renderWorkStateList('migration', finished, NOW_EPOCH)).toEqual([]);
  });

  it('still shows a task left open in a list that was closed', () => {
    const closedWithOpenTask = foldWorkStateList([
      entry('migration', { migration: 'sqlite-v8', status: 'done' }, MINUTE_MS),
      entry('migration', { task: 'drop-old-table', status: 'todo' }, MINUTE_MS),
    ]);

    expect(renderWorkStateList('migration', closedWithOpenTask, NOW_EPOCH)).toEqual([
      '- migration',
      '  - [todo] drop-old-table, updated 1 minute ago',
    ]);
  });

  it('shows closed items when asked to', () => {
    const lines = renderWorkStateList('release', foldWorkStateList(releaseEntries()), NOW_EPOCH, true);

    expect(lines).toContain('  - [dropped] publish (reason=superseded by 13.25.3), updated 5 minutes ago');
  });
});

describe('renderWorkStateLines', () => {
  it('puts the most recently written list first', () => {
    const entries = [
      entry('todo', { task: 'update-docs', status: 'todo' }, 2 * DAY_MS),
      ...releaseEntries(),
    ];

    const lines = renderWorkStateLines(entries, NOW_EPOCH);

    expect(lines[0]).toStartWith('- release:');
    expect(lines.slice(-2)).toEqual(['- todo', '  - [todo] update-docs, updated about 2 days ago']);
  });
});

describe('buildWorkStateContextSection', () => {
  it('gives the rule, naming the tools, then what is still open', () => {
    const section = buildWorkStateContextSection(releaseEntries(), NOW_EPOCH);

    expect(section).toStartWith("# Work state: your to-do lists and working state\nUse claude-mem's work_state_write tool to track all to-do lists and multi-step work.");
    expect(section).toContain('It is your canonical to-do list: use it instead of any built-in to-do tool.');
    // The block leaves details out, so the rule says where they are; a bare
    // work_state_read shows only what is open, so the hint names the flag.
    expect(section).toContain('\n- Shown below without details: work_state_read has them (includeClosed=true adds closed items)\n');
    expect(section).toContain('\n\nStill open:\n- release: version=13.25.3');
    expect(section).toEndWith('  - [todo] timeout-decision, updated about 3 days ago');
  });

  it('keeps the rule short', () => {
    expect(WORK_STATE_RULE.length).toBeLessThanOrEqual(620);
  });

  it('shows each open item on one line, without its detail fields', () => {
    const section = buildWorkStateContextSection(releaseEntries(), NOW_EPOCH);

    expect(section).toContain('\n  - [doing] pointer-comments, updated 5 minutes ago\n');
    expect(section).not.toContain('issues=3606');
  });

  it('cuts each state value to 60 characters', () => {
    const section = buildWorkStateContextSection([entry('ticket', { url: 'u'.repeat(200) }, MINUTE_MS)], NOW_EPOCH);

    expect(section).toContain(`- ticket: url=${'u'.repeat(59)}…, updated 1 minute ago`);
  });

  it('collapses a list untouched for longer than staleDays to one line', () => {
    const stale = [
      ...['a', 'b', 'c', 'd', 'e'].map(task => entry('old-plan', { task, status: 'todo', detail: 'x'.repeat(100) }, 21 * DAY_MS)),
      entry('old-plan', { task: 'f', status: 'done' }, 21 * DAY_MS),
    ];

    const section = buildWorkStateContextSection([...stale, ...releaseEntries()], NOW_EPOCH, undefined, 14);

    expect(section).toContain('\n- old-plan: 5 open, stale 21d');
    expect(section).not.toContain('  - [todo] a,');
    // A list within staleDays is still shown in full.
    expect(section).toContain('  - [doing] pointer-comments,');
  });

  it('leaves out lists untouched for 90 days and counts them in one trailing line', () => {
    const ancient = [
      entry('ancient-1', { task: 'a', status: 'todo' }, 100 * DAY_MS),
      entry('ancient-2', { topic: 'x' }, 200 * DAY_MS),
    ];

    const section = buildWorkStateContextSection([...ancient, ...releaseEntries()], NOW_EPOCH);

    expect(section).not.toContain('ancient-1');
    expect(section).not.toContain('ancient-2');
    expect(section).toEndWith('\n- ...2 lists untouched for 90+ days; read them with work_state_read');
  });

  it('stays within 1800 characters for 40 lists of 10 items and points at work_state_read', () => {
    const entries = Array.from({ length: 40 }, (_, list) =>
      Array.from({ length: 10 }, (_, item) =>
        entry(`list-${list}`, { task: `task-${item} ${'n'.repeat(40)}`, status: 'todo', note: 'd'.repeat(300) }, (list * 10 + item) * MINUTE_MS)),
    ).flat();

    const section = buildWorkStateContextSection(entries, NOW_EPOCH);

    expect(section.length).toBeLessThanOrEqual(1800);
    expect(section).toMatch(/; read them with work_state_read$/);
  });

  it('still prints every detail outside the SessionStart block', () => {
    expect(renderWorkStateLines(releaseEntries(), NOW_EPOCH)).toContain(
      '  - [doing] pointer-comments (issues=3606 3794 4065 3829), updated 5 minutes ago',
    );
  });

  it('says nothing is open when nothing has been written', () => {
    expect(buildWorkStateContextSection([], NOW_EPOCH)).toEndWith('\n\nNothing open yet.');
  });

  it('stays within its character limit and says how many lines it left out', () => {
    const entries = releaseEntries();
    const fullSection = buildWorkStateContextSection(entries, NOW_EPOCH);
    const characterLimit = fullSection.length - 40;

    const truncatedSection = buildWorkStateContextSection(entries, NOW_EPOCH, characterLimit);

    expect(truncatedSection.length).toBeLessThanOrEqual(characterLimit);
    expect(truncatedSection).toMatch(/\n- \.\.\.\d+ more lines?; read them with work_state_read$/);
    const keptPart = truncatedSection.slice(0, truncatedSection.lastIndexOf('\n- ...'));
    expect(fullSection.startsWith(keptPart)).toBe(true);
  });
});

describe('facts list', () => {
  it('tells the agent where durable facts go', () => {
    expect(WORK_STATE_RULE).toContain('list "facts"');
  });

  it('puts facts between the rule and the open lists, never as an open list', () => {
    const entries = [...releaseEntries(), entry('facts', { units: 'wtok = tokens weighted by base input price' }, MINUTE_MS)];

    const section = buildWorkStateContextSection(entries, NOW_EPOCH);

    expect(section).toStartWith(`${WORK_STATE_RULE}\n\n# Project facts (durable)\n- units: wtok = tokens weighted by base input price\n\nStill open:\n- release:`);
    expect(section).not.toContain('- facts');
  });

  it('shows facts written 400 days ago or closed, without counting them as untouched', () => {
    const entries = [
      entry('facts', { 'shared-config': '~/.claude-work shares settings.json with ~/.claude' }, 400 * DAY_MS),
      entry('facts', { status: 'done' }, 400 * DAY_MS),
    ];

    const section = buildWorkStateContextSection(entries, NOW_EPOCH);

    expect(section).toContain('\n\n# Project facts (durable)\n- shared-config: ~/.claude-work shares settings.json with ~/.claude\n');
    expect(section).not.toContain('untouched for');
    expect(section).not.toContain('stale');
    expect(section).toEndWith('\n\nNothing open yet.');
  });

  it('matches the facts list name in any case', () => {
    const section = buildWorkStateContextSection([entry('Facts', { units: 'wtok' }, MINUTE_MS)], NOW_EPOCH);

    expect(section).toContain('# Project facts (durable)\n- units: wtok');
    expect(section).not.toContain('- Facts');
  });

  it('cuts each fact to 240 characters and the section to 1200, pointing at the facts list', () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry('facts', { [`fact-${index}`]: 'v'.repeat(300) }, MINUTE_MS));

    const facts = buildFactsSection(entries);

    expect(facts).toStartWith(`# Project facts (durable)\n- fact-0: ${'v'.repeat(239)}…\n`);
    expect(facts.length).toBeLessThanOrEqual(1200);
    expect(facts).toMatch(/\n- \.\.\.\d+ more lines?; read them with work_state_read list=facts$/);
  });

  it('drops a fact set to null, and renders nothing when no fact is left', () => {
    expect(buildFactsSection([
      entry('facts', { a: 'x', b: 'y' }, 2 * MINUTE_MS),
      entry('facts', { a: null }, MINUTE_MS),
    ])).toBe('# Project facts (durable)\n- b: y');
    expect(buildFactsSection([
      entry('facts', { a: 'x' }, 2 * MINUTE_MS),
      entry('facts', { a: null }, MINUTE_MS),
    ])).toBe('');
    expect(buildWorkStateContextSection(releaseEntries(), NOW_EPOCH)).not.toContain('# Project facts');
  });

  it('never shows the handoff list as an open list', () => {
    const section = buildWorkStateContextSection([...releaseEntries(), entry('handoff', { text: 'Goal: ship 15.0.2' }, MINUTE_MS)], NOW_EPOCH);

    expect(section).not.toContain('handoff');
    expect(section).not.toContain('Goal: ship');
  });
});
