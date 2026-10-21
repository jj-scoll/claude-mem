import type { WorkStateEntry, WorkStateFields, WorkStateValue } from '../../sqlite/work-state.js';
import { describeDuration } from '../../../shared/observer-health.js';
import { relativeTimePlaceholder } from '../../../shared/context-cache.js';

/**
 * When "updated N ago" is measured from: an epoch, or 'placeholders' to leave
 * the durations as placeholders that `fillContextPlaceholders` measures at read
 * time (the cached SessionStart block, shared/context-cache.ts).
 */
export type WorkStateClock = number | 'placeholders';

/** Keeps the section small enough to leave most of the 8K SessionStart target to memory. */
export const WORK_STATE_SECTION_CHARACTER_LIMIT = 1_800;

/** A list untouched this long shows as one line in the SessionStart section. */
export const WORK_STATE_STALE_DAYS = 14;

/** A list untouched this long is left out of the SessionStart section and only counted. */
const WORK_STATE_HIDDEN_DAYS = 90;

/** Longest state value the SessionStart section shows; work_state_read has the rest. */
const COMPACT_STATE_VALUE_CHARS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

const CLOSED_STATUSES = new Set(['done', 'dropped']);

export const WORK_STATE_RULE = [
  '# Work state: your to-do lists and working state',
  "Use claude-mem's work_state_write tool to track all to-do lists and multi-step work. It is your canonical to-do list: use it instead of any built-in to-do tool.",
  '- Fields {"task": "<name>", "status": "todo"|"doing"|"done"|"dropped", ...} make a to-do item; other keys are list state (latest wins, null clears, "status": "done" closes the list)',
  '- Shown below without details: work_state_read has them (includeClosed=true adds closed items)',
].join('\n');

export interface FoldedWorkStateList {
  /** Latest value of every key written without a `task`. */
  state: WorkStateFields;
  stateUpdatedAtEpoch: number | null;
  /** Latest fields of each task, in first-seen order. */
  tasks: Map<string, { fields: WorkStateFields; updatedAtEpoch: number }>;
}

/** Replay one list's entries in order; the latest value of each key wins. */
export function foldWorkStateList(entries: WorkStateEntry[]): FoldedWorkStateList {
  const folded: FoldedWorkStateList = { state: {}, stateUpdatedAtEpoch: null, tasks: new Map() };
  for (const entry of entries) {
    const taskName = entry.fields.task;
    if (taskName === undefined || taskName === null || taskName === '') {
      folded.state = { ...folded.state, ...entry.fields };
      folded.stateUpdatedAtEpoch = entry.created_at_epoch;
      continue;
    }
    const taskKey = String(taskName);
    folded.tasks.set(taskKey, {
      fields: { ...folded.tasks.get(taskKey)?.fields, ...entry.fields },
      updatedAtEpoch: entry.created_at_epoch,
    });
  }
  return folded;
}

function isClosed(status: WorkStateValue | undefined): boolean {
  return status !== undefined && status !== null && CLOSED_STATUSES.has(String(status).toLowerCase());
}

/** `key=value` pairs; null values are skipped because null clears a key. */
function formatFields(fields: WorkStateFields, omittedKeys: string[], maxValueChars: number = Infinity): string {
  return Object.entries(fields)
    .filter(([key, value]) => !omittedKeys.includes(key) && value !== null)
    .map(([key, value]) => {
      const text = String(value);
      return `${key}=${text.length > maxValueChars ? `${text.slice(0, maxValueChars - 1)}…` : text}`;
    })
    .join(', ');
}

function updatedAgo(epoch: number, nowEpoch: WorkStateClock): string {
  const duration = nowEpoch === 'placeholders' ? relativeTimePlaceholder(epoch) : describeDuration(nowEpoch - epoch);
  return `updated ${duration} ago`;
}

/**
 * Lines for one list. A closed list hides its state line but still shows any
 * task left open in it; `includeClosed` shows everything. `compact` (the
 * SessionStart section) leaves out task details and cuts long state values.
 */
export function renderWorkStateList(
  listName: string,
  folded: FoldedWorkStateList,
  nowEpoch: WorkStateClock,
  includeClosed: boolean = false,
  compact: boolean = false,
): string[] {
  const taskLines = [...folded.tasks.entries()]
    .filter(([, task]) => includeClosed || !isClosed(task.fields.status))
    .map(([taskName, task]) => {
      const status = task.fields.status === undefined || task.fields.status === null ? '' : `[${String(task.fields.status)}] `;
      const details = compact ? '' : formatFields(task.fields, ['task', 'status']);
      return `  - ${status}${taskName}${details ? ` (${details})` : ''}, ${updatedAgo(task.updatedAtEpoch, nowEpoch)}`;
    });

  const stateFields = formatFields(folded.state, ['task'], compact ? COMPACT_STATE_VALUE_CHARS : Infinity);
  const showState = stateFields !== '' && (includeClosed || !isClosed(folded.state.status));
  if (!showState && taskLines.length === 0) return [];

  // A shown state line always has a state entry behind it; the fallback only satisfies the type.
  const stateUpdatedAtEpoch = folded.stateUpdatedAtEpoch ?? (nowEpoch === 'placeholders' ? 0 : nowEpoch);
  const header = showState
    ? `- ${listName}: ${stateFields}, ${updatedAgo(stateUpdatedAtEpoch, nowEpoch)}`
    : `- ${listName}`;
  return [header, ...taskLines];
}

/** Each list's entries under the label it is shown with, the most recently written list first. */
function groupWorkStateLists(entries: WorkStateEntry[]): Array<{ label: string; entries: WorkStateEntry[] }> {
  const entriesByList = new Map<string, WorkStateEntry[]>();
  const listProjectCounts = new Map<string, number>();
  /** Position of each list's latest entry in `entries`, which arrive in write order. */
  const lastPositionByList = new Map<WorkStateEntry[], number>();
  entries.forEach((entry, position) => {
    // Checkout aliases share one list; adopted source projects keep separate lists.
    const projectKey = (entry.scope_project ?? entry.project).replace(/[A-Z]/g, character => character.toLowerCase());
    const key = JSON.stringify([projectKey, entry.list_name]);
    let listEntries = entriesByList.get(key);
    if (!listEntries) {
      listEntries = [];
      entriesByList.set(key, listEntries);
      listProjectCounts.set(entry.list_name, (listProjectCounts.get(entry.list_name) ?? 0) + 1);
    }
    listEntries.push(entry);
    lastPositionByList.set(listEntries, position);
  });
  // Most recently written list first, by write clock rather than rowid: a list
  // pulled from another device sorts by when it was written, not when it landed.
  // A same-millisecond tie goes by write order, not by this device's rowids,
  // so every device lists them alike.
  return [...entriesByList.values()]
    .sort((a, b) => (b[b.length - 1].created_at_epoch - a[a.length - 1].created_at_epoch)
      || (lastPositionByList.get(b)! - lastPositionByList.get(a)!))
    .map(listEntries => {
      const first = listEntries[0];
      const label = (listProjectCounts.get(first.list_name) ?? 0) > 1
        ? `${first.list_name} [${first.scope_project ?? first.project}]`
        : first.list_name;
      return { label, entries: listEntries };
    });
}

/** Lines for every list in `entries`, the most recently written list first. */
export function renderWorkStateLines(entries: WorkStateEntry[], nowEpoch: WorkStateClock, includeClosed: boolean = false): string[] {
  return groupWorkStateLists(entries).flatMap(list =>
    renderWorkStateList(list.label, foldWorkStateList(list.entries), nowEpoch, includeClosed));
}

/**
 * The SessionStart section: the rule, then what is still open, one line per
 * item, cut to `characterLimit`. A list untouched for `staleDays` is one line;
 * one untouched for 90 days is only counted.
 */
export function buildWorkStateContextSection(
  entries: WorkStateEntry[],
  nowEpoch: WorkStateClock,
  characterLimit: number = WORK_STATE_SECTION_CHARACTER_LIMIT,
  staleDays: number = WORK_STATE_STALE_DAYS,
): string {
  // Age decides what is shown, so it is measured now even when the block
  // leaves its durations as placeholders.
  const ageNowEpoch = nowEpoch === 'placeholders' ? Date.now() : nowEpoch;
  const openLines: string[] = [];
  let hiddenLists = 0;
  for (const list of groupWorkStateLists(entries)) {
    const folded = foldWorkStateList(list.entries);
    const lines = renderWorkStateList(list.label, folded, nowEpoch, false, true);
    if (lines.length === 0) continue;
    const ageMs = ageNowEpoch - list.entries.reduce((latest, entry) => Math.max(latest, entry.created_at_epoch), 0);
    if (ageMs > WORK_STATE_HIDDEN_DAYS * DAY_MS) {
      hiddenLists++;
    } else if (ageMs > staleDays * DAY_MS) {
      const openTasks = [...folded.tasks.values()].filter(task => !isClosed(task.fields.status)).length;
      openLines.push(`- ${list.label}: ${openTasks > 0 ? `${openTasks} open, ` : ''}stale ${Math.floor(ageMs / DAY_MS)}d`);
    } else {
      openLines.push(...lines);
    }
  }
  if (hiddenLists > 0) {
    openLines.push(`- ...${hiddenLists} list${hiddenLists === 1 ? '' : 's'} untouched for ${WORK_STATE_HIDDEN_DAYS}+ days; read them with work_state_read`);
  }
  if (openLines.length === 0) {
    return `${WORK_STATE_RULE}\n\nNothing open yet.`;
  }
  return fitWorkStateLines(`${WORK_STATE_RULE}\n\nStill open:`, openLines, characterLimit);
}

/** `heading`, then as many of `lines` as fit in `characterLimit`, then how many were left out. */
export function fitWorkStateLines(heading: string, lines: string[], characterLimit: number): string {
  let text = heading;
  for (let index = 0; index < lines.length; index++) {
    const remaining = lines.length - index;
    const overflowLine = `\n- ...${remaining} more line${remaining === 1 ? '' : 's'}; read them with work_state_read`;
    const candidate = `${text}\n${lines[index]}`;
    const needsOverflowRoom = index < lines.length - 1;
    if (candidate.length + (needsOverflowRoom ? overflowLine.length : 0) > characterLimit) {
      return text + overflowLine;
    }
    text = candidate;
  }
  return text;
}
