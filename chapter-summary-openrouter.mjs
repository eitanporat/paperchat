// chapter-summary-openrouter.mjs
//
// Alternative chapter-summary pipeline for non-Anthropic models routed
// through OpenRouter. The original `handleChapterSummary` in
// dev-server.mjs uses Claude Agent SDK, which only speaks Anthropic's
// API. To unlock Kimi K2.6 / DeepSeek V4 Pro / GLM-4.6 etc., we use
// Vercel AI SDK 6 (provider-agnostic) + @openrouter/ai-sdk-provider.
//
// The setup phase (rasterize, composite, figures, _lib copy, crop)
// is identical to the Anthropic path — that lives in shared helpers
// imported from dev-server.mjs. The agent loop is the part that
// differs: streamText + tool() + ToolLoopAgent replaces query().
//
// SSE event protocol is preserved 1:1 with the Anthropic path so the
// browser-side UI panel doesn't need to change.

import { streamText, tool, stepCountIs } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// ---- Tool implementations -------------------------------------------
//
// Each tool runs in the chapter workdir; the cwd is captured at agent
// kickoff so subagent calls share it. File paths are resolved relative
// to the workdir; absolute paths outside the workdir are rejected to
// keep the agent contained.

function makeWorkdirTools(workdir) {
  const safePath = (p) => {
    const abs = resolve(workdir, p);
    if (!abs.startsWith(workdir + '/') && abs !== workdir) {
      throw new Error(`path outside workdir: ${p}`);
    }
    return abs;
  };

  return {
    Read: tool({
      description: 'Read the contents of a file in the chapter workdir. Accepts text and image files (PNG/JPG return as image_url for multimodal models).',
      inputSchema: z.object({ file_path: z.string().describe('Path relative to workdir (e.g. "_lib/pc.css")') }),
      execute: async ({ file_path }) => {
        const abs = safePath(file_path);
        const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file_path);
        if (isImage) {
          const buf = await readFile(abs);
          const mime = file_path.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
          return { content: [{ type: 'image', data: buf.toString('base64'), mediaType: mime }] };
        }
        const text = await readFile(abs, 'utf8');
        // Standard cat-n format so the agent sees line numbers like
        // Claude Code's Read tool does.
        const numbered = text.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n');
        return numbered;
      },
    }),

    Write: tool({
      description: 'Write a file in the chapter workdir (creates parents as needed; overwrites if it exists).',
      inputSchema: z.object({
        file_path: z.string(),
        content: z.string(),
      }),
      execute: async ({ file_path, content }) => {
        const abs = safePath(file_path);
        await mkdir(join(abs, '..'), { recursive: true });
        await writeFile(abs, content, 'utf8');
        return `File written: ${file_path} (${content.length} chars)`;
      },
    }),

    Edit: tool({
      description: 'Replace exact text in an existing file. Use for surgical updates.',
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        const abs = safePath(file_path);
        const text = await readFile(abs, 'utf8');
        if (!text.includes(old_string)) throw new Error('old_string not found in file');
        if (text.split(old_string).length > 2) throw new Error('old_string is ambiguous (matches multiple times)');
        await writeFile(abs, text.replace(old_string, new_string), 'utf8');
        return `Edited: ${file_path}`;
      },
    }),

    Bash: tool({
      description: 'Run a shell command in the chapter workdir. Use for ls, mkdir, ./crop, etc. Output is truncated at 8KB.',
      inputSchema: z.object({
        command: z.string(),
        timeout_ms: z.number().optional().default(60000),
      }),
      execute: async ({ command, timeout_ms = 60000 }) => {
        return new Promise((res) => {
          const p = spawn('bash', ['-lc', command], { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '', err = '';
          const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeout_ms);
          p.stdout.on('data', d => { out += d.toString(); });
          p.stderr.on('data', d => { err += d.toString(); });
          p.on('close', code => {
            clearTimeout(t);
            const combined = (out + (err ? '\n[stderr]\n' + err : '')).slice(0, 8192);
            res(`exit=${code ?? -1}\n${combined}`);
          });
        });
      },
    }),

    Glob: tool({
      description: 'List files matching a shell glob pattern relative to the workdir.',
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => {
        return new Promise((res) => {
          const p = spawn('bash', ['-lc', `ls -1d ${pattern} 2>/dev/null || true`], { cwd: workdir });
          let out = '';
          p.stdout.on('data', d => { out += d.toString(); });
          p.on('close', () => res(out.trim() || '(no matches)'));
        });
      },
    }),
  };
}

// ---- Main pipeline entry point --------------------------------------
//
// Called from dev-server.mjs's handleChapterSummary when the selected
// plannerModel slug is an OpenRouter model (e.g. "moonshotai/kimi-k2.6"
// or "deepseek/deepseek-v4-pro"). Receives the workdir (already set up:
// composites/, figures/, pages/, _lib/, params.json, crop, etc.) and
// the existing `send` SSE function to forward events.
//
// Returns when the agent loop completes.

export async function runChapterAgentOpenRouter({
  workdir,
  systemPrompt,
  userPrompt,
  plannerModel,
  writerModel,
  composedSectionWriterPrompt,
  apiKey,
  send,
  abortSignal,
}) {
  const openrouter = createOpenRouter({ apiKey });
  const tools = makeWorkdirTools(workdir);

  // Subagent dispatch: a Task tool that internally spawns another
  // streamText with the section-writer prompt. Parallel invocations
  // happen because Vercel AI SDK fires parallel tool calls
  // concurrently — multiple Task tool_calls in the same assistant
  // message run via Promise.all.
  const taskTool = tool({
    description: 'Dispatch a section-writer subagent. The subagent runs as ' + writerModel + ' and produces one sections/<id>.html fragment. Use one Task per section, all in the same assistant turn — they execute in parallel.',
    inputSchema: z.object({
      description: z.string().describe('Short label, e.g. "Write sections/atomic-structure.html"'),
      prompt: z.string().describe('The section-writer brief — concept, source pages, figures, target component'),
    }),
    execute: async ({ description, prompt }) => {
      send({ type: 'tool_use', id: `task_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, name: 'Task', args: { description } });
      try {
        const result = await streamText({
          model: openrouter(writerModel),
          system: composedSectionWriterPrompt,
          prompt,
          tools,  // section-writer gets the same file tools (no Task — no recursion)
          stopWhen: stepCountIs(40),
          abortSignal,
        });
        let out = '';
        for await (const chunk of result.textStream) out += chunk;
        return `Subagent done. Final message:\n${out.slice(0, 2000)}`;
      } catch (e) {
        return `Subagent failed: ${e.message}`;
      }
    },
  });

  // Top-level planner loop.
  const result = streamText({
    model: openrouter(plannerModel),
    system: systemPrompt,
    prompt: userPrompt,
    tools: { ...tools, Task: taskTool },
    stopWhen: stepCountIs(80),
    abortSignal,
    onStepFinish(step) {
      // Translate AI-SDK step events to our SSE protocol.
      for (const tc of step.toolCalls || []) {
        send({ type: 'tool_use', id: tc.toolCallId, name: tc.toolName, args: tc.input });
      }
      for (const tr of step.toolResults || []) {
        const txt = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output);
        send({ type: 'tool_result', id: tr.toolCallId, ok: true, result: txt });
      }
      if (step.text) send({ type: 'text', content: step.text });
      if (step.reasoning) send({ type: 'thinking_complete', content: step.reasoning });
      if (step.usage) {
        send({
          type: 'usage',
          msgId: `step_${Date.now()}`,
          input: step.usage.inputTokens || 0,
          output: step.usage.outputTokens || 0,
          cacheCreation: step.usage.cachedInputTokens || 0,
          cacheRead: 0,
        });
      }
    },
  });

  // Consume the stream so the loop actually runs.
  for await (const _ of result.textStream) { /* drain */ }
  const final = await result;
  send({
    type: 'done',
    stopReason: final.finishReason,
    totalCostUsd: 0,  // AI SDK doesn't compute cost; we'd need to multiply usage by per-model rates ourselves
    workdir,
  });
}

// Helper: detect whether a model slug should route through OpenRouter.
// Anthropic models keep using the Claude Agent SDK path; everything
// else (with a / in the slug, which is the OpenRouter convention)
// routes here.
export function isOpenRouterModel(slug) {
  if (!slug) return false;
  return slug.includes('/') && !slug.startsWith('claude-');
}
