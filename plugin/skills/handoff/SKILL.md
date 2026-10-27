---
name: handoff
description: Generate a HANDOFF.md that captures goal, current state, files touched, failed attempts, and next steps — so a fresh Claude session can continue exactly where this one left off. Use when sessions are getting long, Claude keeps retrying the same broken solution, or the user wants to step away and resume later.
---

# Handoff

Generate a structured `HANDOFF.md` file that gives a fresh Claude session everything it needs to continue this work without dragging the current degraded context forward.

claude-mem already injects recent observations into every new session, so the fresh agent starts with a timeline of what happened. The handoff adds what that timeline cannot: the goal, the failed attempts and why they failed, the current theory, and exact next steps, plus pointers into memory for deeper recall.

## When to Use

- The session is long and Claude feels confused or repetitive
- Claude keeps trying the same failing solution over and over
- The user wants to step away and resume later
- `/compact` ran but Claude still lacks clear direction
- The user says "handoff", "generate a handoff", "I want to start fresh", or "write a handoff doc"

## What to Capture

Think hard about the full arc of this conversation before writing. The handoff must be useful to a Claude instance that has never seen this conversation.

### Required Sections

1. **Goal** — In the user's own words: quote the one or two prompts that state what they want, verbatim and in quotation marks, then one paragraph stating the end state, not the current sub-task. Be specific enough that a fresh agent can orient immediately.

2. **Decisions** — Each decision made this session: what was decided, and why. The reason is what lets a fresh agent apply the decision to a case it did not cover.

3. **Current State** — What is working right now? What is broken? What is the exact symptom of the problem? Include error messages verbatim if relevant.

4. **Files in Play** — List every file that has been read, edited, or created during this session that is relevant to the current task. Use absolute or repo-relative paths. Include a one-line note on why each file matters.

5. **What Has Been Tried (and Why It Failed)** — This is the most important section. List every approach attempted that did not work, and explain WHY it failed (not just that it failed). A fresh agent that skips this section will repeat the same mistakes.

6. **Rejected Options (do not re-propose)** — Options that were considered and ruled out, by you or by the user, each with the reason. Include options the user declined before any attempt. This differs from the section above: these were never tried.

7. **Current Best Theory** — What do you currently believe is the right path forward, even if you haven't proven it yet? Include any evidence or reasoning that supports it.

8. **Next Steps** — Concrete, ordered actions for the fresh agent to take. Be specific: file paths, function names, commands to run. The fresh agent should be able to start on step 1 immediately.

9. **Rules in Force** — Rules the fresh agent must keep obeying: permissions granted or withheld (read-only against prod, no pushes, no deploys until approved), people not to contact or route around, style and format preferences, and anything the user explicitly said NOT to do. Say who set each rule when it is not the user's standing preference.

10. **Key Figures and IDs** — The numbers, names and identifiers the work depends on: ticket and PR numbers, commit hashes, versions, counts, costs, dates, account or environment names. Never include secrets, tokens, passwords or keys; name where the secret lives instead.

11. **Artifact Trail** — Exact absolute paths of everything produced, and the git state: repo, branch, last commit hash, whether anything is pushed, uncommitted changes. Copy any output that lives in a scratchpad or temp directory to a durable path and name that path here; a scratchpad may not outlive this session.

12. **Memory Pointers** — If claude-mem's search tools are available, use Smart search: run `search` for this task's key terms, inspect `timeline` around relevant results, then fetch only selected records with `get_observations`. List the few observation IDs that matter most (a decision, the root cause, a failed approach), so the fresh agent can retrieve those records. Also list one or two `search` queries worth re-running. Skip this section if the tools are not available.

Also keep any other non-obvious context a fresh agent would trip over (environment specifics, external dependencies, performance requirements) under Rules in Force or Current State.

## Writing Rules

- Write the handoff for a fresh Claude, not for the user. The user knows what happened; the fresh Claude does not.
- Be ruthlessly specific. Vague next steps are useless. "Fix the auth" is bad. "In `src/auth/middleware.ts:47`, the token expiry check uses `Date.now()` but should use `req.timestamp` — change the comparison on line 52" is good.
- Include exact error messages, stack traces, or test output that captures the failure mode.
- Do not pad. Every sentence should be load-bearing information for the fresh agent.
- Do not write the handoff from the user's perspective. Write it as a briefing document addressed to the incoming agent.
- Long-lived facts (decisions that outlast this task, rejected options, conventions) belong in the handoff too, because it is the briefing for this task; also save each with `work_state_write` `list="facts"`, one key per fact, so every future session sees it. The handoff is shown once.
- Keep the whole handoff under about 13K characters. When it runs long, cut narrative (Current State detail, Files in Play, the story of attempts) before cutting Goal, Decisions, Rules in Force, or Rejected Options.

## Output

Write the handoff to `HANDOFF.md` in the current working directory (the project root).

Use this structure:

```markdown
# Handoff

> Generated: [timestamp]  
> Project: [project name or directory]  
> Session summary: [one sentence describing what this session was about]

## Goal

> "[the user's own words, quoted from their prompt]"

[What the user is trying to accomplish — the actual end state]

## Decisions

- [What was decided] — because [why]

## Current State

**Working:**
- [list what is confirmed working]

**Broken:**
- [exact symptom, error message, or failure mode]

## Files in Play

| File | Why It Matters |
|------|---------------|
| `path/to/file.ts` | [one line] |

## What Has Been Tried (and Why It Failed)

### Attempt 1: [short name]
- **What:** [what was done]
- **Why it failed:** [root cause, not just "it didn't work"]

### Attempt 2: [short name]
...

## Rejected Options (do not re-propose)

- [Option] — rejected by [who] because [why]

## Current Best Theory

[What you currently believe is the correct approach and why]

## Next Steps

1. [Specific, actionable step with file path or command]
2. [Next step]
3. ...

## Rules in Force

- [Permission, person not to contact, or style rule, and who set it]

## Key Figures and IDs

- [PR #, commit hash, version, count, environment name; no secrets]

## Artifact Trail

- [`/absolute/path`: what it is]
- Git: [repo, branch, last commit, pushed or not, uncommitted changes]
- Copied from scratchpad: [`/durable/path`]

## Memory Pointers

- Observations: [#ID — one line on why it matters]
- Searches worth re-running: [`search` query]
```

## Store It in claude-mem

If the `work_state_write` tool is available, also store the handoff there, so claude-mem shows it at the start of the next session in this project (`/clear`, a new session, or a compact within 30 minutes), once:

```
work_state_write list="handoff" fields={
  "text": "<Goal in the user's words, Decisions, Rules in Force, Rejected Options, Current State and Next Steps, at most 3000 characters>",
  "obs_ids": "<the observation IDs from Memory Pointers, comma-separated>",
  "project_dir": "<absolute path of the directory the handoff file is in>",
  "handoff_file": "<the handoff file's name or absolute path, exactly as written, e.g. HANDOFF.md>"
}
```

The stored text is the short briefing; the handoff file stays the full copy the stored one points to; `handoff_file` names it, so the next session is not sent to the wrong file. Skip this step if the tool is not available.

## After Writing

Tell the user:

1. That `HANDOFF.md` has been written, and whether the handoff was stored in claude-mem
2. To run `/clear` or start a new Claude Code session
3. If it was stored: the new session receives it automatically, once, so just tell it to continue. Otherwise: open the new session and say **"Read HANDOFF.md and continue from where we left off."**
4. That claude-mem gives the fresh agent the recent timeline automatically, and the handoff is its precise briefing on top of that
5. That `HANDOFF.md` is a scratch file: don't commit it (delete it once the new session has picked up, or add it to `.gitignore`)

Keep the message short. The user is ready to move — don't make them read a wall of text.
