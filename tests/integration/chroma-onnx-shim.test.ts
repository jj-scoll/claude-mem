/**
 * Real-env check of the ONNX patch claude-mem injects ahead of chroma-mcp.
 *
 * chroma-mcp rebuilds the collection's embedding function on every call, and
 * chromadb's ONNXMiniLM_L6_V2 caches its InferenceSession per instance, so
 * every add/query reloaded the model. onnxruntime's default pool also spins
 * one thread per core. The patch must make every instance share one session
 * that runs single-threaded. Runs the patch inside the same uvx env the
 * worker launches (pinned chromadb), so a chromadb upgrade that moves these
 * internals fails here instead of silently losing the fix.
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { CHROMA_ONNX_PATCH_PY, ChromaMcpManager } from '../../src/services/sync/ChromaMcpManager.js';

const RUN_CHROMA = process.env.CLAUDE_MEM_TEST_CHROMA === '1';

const PROBE_PY = `
from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2
a, b = ONNXMiniLM_L6_V2(), ONNXMiniLM_L6_V2()
a(["warm up"]); b(["warm up"])
so = a.model.get_session_options()
print("SHARED", a.model is b.model, a.tokenizer is b.tokenizer)
print("THREADS", so.intra_op_num_threads, so.inter_op_num_threads)
print("SPIN", so.get_session_config_entry("session.intra_op.allow_spinning"))
`;

describe.skipIf(!RUN_CHROMA)('chroma-mcp ONNX patch (real uvx env)', () => {
  it('shares one single-threaded, non-spinning session across embedding functions', () => {
    const prefix = ChromaMcpManager.buildLauncherPrefixForTesting('3.13');
    const pythonAt = prefix.indexOf('python');
    const result = spawnSync('uvx', [...prefix.slice(0, pythonAt + 1), '-c', CHROMA_ONNX_PATCH_PY + PROBE_PY], {
      encoding: 'utf-8',
      timeout: 600_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SHARED True True');
    expect(result.stdout).toContain('THREADS 1 1');
    expect(result.stdout).toContain('SPIN 0');
    // stdout is chroma-mcp's MCP channel: the patch itself must print nothing there.
    expect(result.stdout.trim().split('\n')[0]).toStartWith('SHARED');
  }, 600_000);
});
