#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import { basename } from 'path';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';

import { validateProjectPath } from './utils/fileHandler.js';
import { ToolContext, ToolDefinition, buildRegistry, schemaFor, shapeResult } from './registry.js';
import { CommitContext, commitStore } from './utils/commit.js';
import { allToolDefinitions } from './tools/allTools.js';
import { loadProjectTextMetrics } from './tools/projectConfig.js';
import { setActiveTextMetrics } from './validation/textMetrics.js';
import { stopBridge } from './bridge/bridge.js';

/**
 * RPG Maker MZ MCP Server
 *
 * A Model Context Protocol server for reading and writing RPG Maker MZ project
 * data. Tool schemas (Zod) and handlers live in each `tools/*` module and are
 * registered here on a high-level `McpServer`, which validates incoming
 * arguments against each tool's schema before its handler runs.
 */

const PROJECT_PATH = process.env.RPGMAKER_PROJECT_PATH || '';

/**
 * Advertised MCP server version, read from package.json so it tracks releases
 * instead of drifting from a hardcoded string. Resolved relative to this module
 * (dist/index.js → ../package.json). Falls back to '0.0.0' if unreadable.
 */
function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Run a tool. Mutating tools execute inside a commit context so that, when
 * `dryRun` is requested, every write is intercepted and returned as a preview
 * diff instead of being applied.
 *
 * A tool that declares a `summarize` function has its result condensed on the
 * way out — including the dry-run `wouldReturn`, so a preview and the real call
 * report the same shape. `verbose: true` opts out per call.
 */
async function runTool(
  tool: ToolDefinition,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!tool.mutates) {
    return shapeResult(tool, await tool.handler(ctx, args), args);
  }

  const dryRun = args.dryRun === true;
  const commitCtx: CommitContext = { dryRun, commits: [] };
  const result = await commitStore.run(commitCtx, () => tool.handler(ctx, args));

  if (!dryRun) {
    return shapeResult(tool, result, args);
  }

  const wouldReturn = shapeResult(tool, result, args);

  return {
    dryRun: true,
    wouldChange: commitCtx.commits.map((commit) => ({
      file: basename(commit.path),
      changed: commit.changed,
      ...(commit.deleted ? { deleted: true } : {}),
      diff: commit.diff,
    })),
    // The handler's return value (e.g. `{ event, warnings }`) — surfaced so a
    // dry-run preview shows validation warnings that would otherwise be
    // discarded (the documented dry-run gap). Omitted when the handler returns
    // nothing.
    ...(wouldReturn === undefined ? {} : { wouldReturn }),
  };
}

function progressReporter(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification> | undefined,
): ToolContext['reportProgress'] {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let last = -Infinity;
  return (progress, total, message) => {
    if (!(progress > last)) return;
    last = progress;
    extra!
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message ? { message } : {}),
        },
      })
      .catch(() => undefined);
  };
}

function buildServer(initialProjectPath: string) {
  const server = new McpServer({ name: 'rpgmaker-mz-server', version: serverVersion() });

  // The project path is session state, not a constant: it starts from the env
  // var and `set_project` may retarget it without a server restart.
  let projectPath = initialProjectPath;
  const setProjectPath = async (path: string): Promise<void> => {
    if (path !== projectPath) await stopBridge();
    projectPath = path;
  };

  // Project selection, text metrics, generated-map IDs and live runtime state
  // are shared by this connection. Keep calls ordered to prevent cross-target
  // operations or concurrent map creation from overwriting a peer's changes.
  let toolQueue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let cleanup: Promise<void> | undefined;
  const closeRuntime = (): Promise<void> => {
    if (!cleanup) {
      closing = true;
      cleanup = (async () => {
        // Reject pending runtime requests so draining never waits on the game.
        // A bridge start already in progress may finish after this first stop.
        let firstError: unknown;
        try {
          await stopBridge();
        } catch (error) {
          firstError = error;
        }
        await toolQueue.catch(() => undefined);
        await stopBridge();
        if (firstError) throw firstError;
      })();
    }
    return cleanup;
  };
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    previousClose?.();
    void closeRuntime().catch((error) => console.error('Bridge cleanup failed:', error));
  };

  // Fail loudly on duplicate tool names before wiring anything up.
  buildRegistry(allToolDefinitions);

  for (const def of allToolDefinitions) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: schemaFor(def), annotations: def.annotations },
      async (
        args: Record<string, unknown>,
        extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ): Promise<CallToolResult> => {
        const execution = toolQueue.then(async (): Promise<CallToolResult> => {
          try {
            if (closing)
              throw new Error('MCP connection is closing; no new tool operations accepted.');
            if (def.requiresProject !== false) {
              if (!projectPath) {
                throw new Error(
                  'No project path set. Set RPGMAKER_PROJECT_PATH or call set_project.',
                );
              }
              if (!(await validateProjectPath(projectPath))) {
                throw new Error(`Invalid RPG Maker MZ project path: ${projectPath}`);
              }
              // Install this project's Show Text width metrics before anything runs.
              // The line-width check sits deep inside validateCommandList, which has no
              // project path in scope and eight call sites across six modules — setting
              // it once here beats making all of them async for a per-project constant.
              // Cached by mtime, fails soft to the built-in character estimate.
              setActiveTextMetrics(await loadProjectTextMetrics(projectPath));
            }

            const reportProgress = progressReporter(extra);
            const result = await runTool(
              def,
              { projectPath, setProjectPath, reportProgress },
              args,
            );
            const content: CallToolResult['content'] = [
              { type: 'text', text: JSON.stringify(result, null, 2) },
            ];
            for (const file of def.images?.(result, args) ?? []) {
              try {
                const data = (await readFile(file)).toString('base64');
                content.push({ type: 'image', data, mimeType: 'image/png' });
              } catch {
                // The file path remains in the JSON result if inline reading fails.
              }
            }
            return { content };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
          }
        });
        toolQueue = execution.then(
          () => undefined,
          () => undefined,
        );
        return execution;
      },
    );
  }

  return { server, closeRuntime };
}

async function main(): Promise<void> {
  const { server, closeRuntime } = buildServer(PROJECT_PATH);
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeRuntime();
    await server.close();
  };
  const beginShutdown = (): void => {
    void shutdown().catch((error) => {
      console.error('MCP cleanup failed:', error);
      process.exitCode = 1;
    });
  };
  // The SDK transport does not handle stdin EOF itself. Without this, an open
  // bridge socket keeps an abandoned stdio server alive with a stale handshake.
  process.stdin.once('end', beginShutdown);
  process.once('SIGINT', beginShutdown);
  process.once('SIGTERM', beginShutdown);
  await server.connect(transport);
  console.error('RPG Maker MZ MCP server running on stdio');
}

main().catch((error) => {
  console.error('[MCP Fatal]', error);
  process.exit(1);
});
