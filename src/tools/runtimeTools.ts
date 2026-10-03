import { z } from 'zod';
import { spawn } from 'child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { ToolDefinition } from '../registry.js';
import { commitTextBatch } from '../utils/commit.js';
import { buildRuntimePlugin, PLUGIN_NAME } from '../bridge/pluginSource.js';
import {
  assertRuntimeProject,
  readTelemetry,
  requestRuntime,
  runtimeStatus,
  startBridge,
  stopBridge,
} from '../bridge/bridge.js';
import { COMMANDS, HOT_RELOADABLE } from '../bridge/protocol.js';
import { projectFile } from '../bridge/projectPaths.js';

const dryRun = z
  .boolean()
  .optional()
  .describe(
    'Preview the requested runtime operation without starting processes, opening sockets, changing the game, or writing files.',
  );
const timeoutMs = z.number().int().min(1).max(60000).optional();
const runtimeAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Only the editor's JSON assignment form is accepted; plugin JavaScript is never evaluated. */
export function parseRuntimeManifest(source: string): {
  prefix: string;
  entries: Record<string, unknown>[];
} {
  const match = source.match(
    /^([\s\S]*?)(?:var|let|const)\s+\$plugins\s*=\s*(\[[\s\S]*\])\s*;?\s*$/,
  );
  if (!match || match[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim()) {
    throw new Error(
      'js/plugins.js is not a plain editor-generated $plugins JSON assignment. Nothing was changed.',
    );
  }
  const entries: unknown = JSON.parse(match[2]);
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.name !== 'string' ||
        typeof entry.status !== 'boolean',
    )
  ) {
    throw new Error('Invalid plugin manifest entries. Nothing was changed.');
  }
  return { prefix: match[1], entries };
}

export async function installRuntimeBridge(project: string, replaceExisting = false) {
  const pluginPath = await projectFile(project, 'js', 'plugins', `${PLUGIN_NAME}.js`);
  const manifestPath = await projectFile(project, 'js', 'plugins.js');
  const source = buildRuntimePlugin();
  if (
    (await exists(pluginPath)) &&
    (await readFile(pluginPath, 'utf8')) !== source &&
    !replaceExisting
  ) {
    throw new Error(
      `${PLUGIN_NAME}.js already exists with different contents. Review it before setting replaceExisting:true.`,
    );
  }
  const manifestSource = await readFile(manifestPath, 'utf8');
  const { prefix, entries } = parseRuntimeManifest(manifestSource);
  const matching = entries.filter((entry) => entry.name === PLUGIN_NAME);
  if (matching.length > 1)
    throw new Error('Duplicate bridge plugin entries; repair the manifest first.');
  const entry = matching[0];
  if (entry) entry.status = true;
  else
    entries.push({
      name: PLUGIN_NAME,
      status: true,
      description: 'Authenticated local MZ MCP playtest bridge',
      parameters: {},
    });
  const unchangedManifest =
    matching.length === 1 &&
    matching[0].status === true &&
    parseRuntimeManifest(manifestSource).entries.find((item) => item.name === PLUGIN_NAME)
      ?.status === true;
  const text = unchangedManifest
    ? manifestSource
    : `${prefix}var $plugins =\n${JSON.stringify(entries, null, 2)};\n`;
  const changes = await commitTextBatch([
    { path: pluginPath, text: source },
    { path: manifestPath, text },
  ]);
  return {
    plugin: PLUGIN_NAME,
    changed: changes.some((change) => change.changed),
    files: changes.map((change) => ({ path: change.path, changed: change.changed })),
    note: 'Restart the playtest to load the plugin. It runs only in local NW.js test mode.',
  };
}

const commandSchema = z
  .object({
    action: z.enum(COMMANDS),
    button: z.enum(['ok', 'cancel', 'menu', 'up', 'down', 'left', 'right']).optional(),
    durationMs: z.number().int().min(30).max(1000).optional(),
    mapId: z.number().int().positive().optional(),
    x: z.number().int().nonnegative().optional(),
    y: z.number().int().nonnegative().optional(),
    direction: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).optional(),
    file: z.enum(Object.keys(HOT_RELOADABLE) as [string, ...string[]]).optional(),
    timeoutMs,
    dryRun,
  })
  .superRefine((args, ctx) => {
    if (args.action === 'press_button' && !args.button)
      ctx.addIssue({ code: 'custom', message: 'press_button requires button.' });
    if (args.action === 'teleport_player' && (args.x === undefined || args.y === undefined))
      ctx.addIssue({ code: 'custom', message: 'teleport_player requires x and y.' });
    if (args.action === 'reload_database' && !args.file)
      ctx.addIssue({ code: 'custom', message: 'reload_database requires file.' });
  });

export async function runtimeCommand(project: string, input: unknown) {
  const args = commandSchema.parse(input);
  if (args.dryRun)
    return { dryRun: true, wouldSend: { ...args, dryRun: undefined, timeoutMs: undefined } };
  const { dryRun: _dryRun, timeoutMs: timeout, ...command } = args;
  return requestRuntime(project, command, timeout);
}

export async function runtimeScreenshot(project: string, input: unknown) {
  const args = z
    .object({
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
        .default('playtest'),
      timeoutMs,
      dryRun,
    })
    .parse(input);
  const directory = await projectFile(project, '.mcp-cache', 'screenshots');
  if (args.dryRun) return { dryRun: true, wouldCapture: 'PNG of the game scene', directory };
  const reply = await requestRuntime(
    project,
    { action: 'capture_screenshot' },
    args.timeoutMs ?? 15000,
  );
  if (
    reply.type !== 'screenshot_result' ||
    reply.mimeType !== 'image/png' ||
    typeof reply.base64 !== 'string'
  )
    throw new Error('Invalid runtime screenshot reply.');
  const bytes = Buffer.from(reply.base64, 'base64');
  if (
    bytes.length > 24 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error('Runtime screenshot is not a bounded PNG.');
  const path = await projectFile(
    project,
    '.mcp-cache',
    'screenshots',
    `${args.name}-${Date.now()}.png`,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return { path, bytes: bytes.length, mimeType: 'image/png' };
}

export async function launchPlaytest(project: string, input: unknown) {
  const args = z
    .object({ install: z.string().optional(), runtimeExecutable: z.string().optional(), dryRun })
    .parse(input);
  const projectPath = await realpath(project);
  for (const file of ['index.html', 'package.json', 'game.rmmzproject']) {
    if (!(await exists(join(projectPath, file))))
      throw new Error(`Not a runnable MZ project: missing ${file}.`);
  }
  const install =
    args.install ||
    process.env.RPGMAKER_MZ_INSTALL ||
    (process.platform === 'win32'
      ? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RPG Maker MZ'
      : undefined);
  if (!args.runtimeExecutable && !install)
    throw new Error('Provide runtimeExecutable or an MZ install directory.');
  const exe = resolve(
    args.runtimeExecutable ||
      join(
        install!,
        process.platform === 'darwin'
          ? 'nwjs-mac/Game.app/Contents/MacOS/nwjs'
          : process.platform === 'win32'
            ? 'nwjs-win/nw.exe'
            : 'nwjs-linux/nw',
      ),
  );
  if (!(await exists(exe))) throw new Error(`NW.js runtime not found: ${exe}`);
  if (await exists(join(dirname(exe), 'package.json')))
    throw new Error(
      'This runtime is bound to a sibling package.json. Choose a standalone NW.js executable.',
    );
  if (args.dryRun)
    return { dryRun: true, executable: exe, projectPath, arguments: [projectPath, 'test'] };
  const child = spawn(exe, [projectPath, 'test'], {
    cwd: projectPath,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return {
    launched: true,
    pid: child.pid,
    executable: exe,
    projectPath,
    testMode: true,
    note: 'Process launched; runtime_status confirms when the bridge connects. Close this playtest when finished.',
  };
}

export const runtimeToolDefinitions: ToolDefinition[] = [
  {
    name: 'install_runtime_bridge',
    mutates: true,
    annotations: runtimeAnnotations,
    description:
      'Install and enable the local NW.js playtest-only MZ bridge. Previews plugin source and manifest together with dryRun; backs up existing text files. Existing different bridge source requires explicit replaceExisting. Other plugins are preserved; JavaScript manifests are never executed.',
    inputSchema: { replaceExisting: z.boolean().optional() },
    handler: async (ctx, args) => installRuntimeBridge(ctx.projectPath, args.replaceExisting),
  },
  {
    name: 'start_runtime_bridge',
    annotations: runtimeAnnotations,
    description:
      'Start an authenticated loopback-only bridge for the active project and write its private handshake. Allows one connected playtest. Existing handshakes from other sessions are not overwritten. dryRun has no side effects.',
    inputSchema: { port: z.number().int().min(0).max(65535).optional(), dryRun },
    handler: async (ctx, args) =>
      args.dryRun
        ? { dryRun: true, wouldStart: ctx.projectPath, port: args.port ?? 32124 }
        : startBridge(ctx.projectPath, args.port),
  },
  {
    name: 'stop_runtime_bridge',
    requiresProject: false,
    annotations: runtimeAnnotations,
    description:
      "Disconnect this MCP server's playtest bridge and remove only its own handshake. Does not terminate the game. dryRun has no side effects.",
    inputSchema: { dryRun },
    handler: async (_ctx, args) =>
      args.dryRun ? { dryRun: true, wouldStop: runtimeStatus() } : stopBridge(),
  },
  {
    name: 'runtime_status',
    requiresProject: false,
    annotations: readAnnotations,
    description:
      "Read this server's bridge connection and project identity without exposing its authentication token.",
    inputSchema: {},
    handler: async () => runtimeStatus(),
  },
  {
    name: 'runtime_telemetry',
    annotations: readAnnotations,
    description:
      'Read recent runtime exceptions/logs, scene changes, player position and executing event commands. Bounded to 500 frames; peek defaults true, false consumes returned frames. Tracing observes execution; it does not pause or step the game.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional(),
      types: z.array(z.string()).optional(),
      peek: z.boolean().optional(),
    },
    handler: async (ctx, args) => {
      await assertRuntimeProject(ctx.projectPath);
      return readTelemetry(args.limit, args.types, args.peek !== false);
    },
  },
  {
    name: 'runtime_command',
    annotations: runtimeAnnotations,
    description:
      'Send a fixed command to the connected MZ playtest: inspect state, press a game button, interact, teleport, reload the map or a supported database file, ping, or return a screenshot. No arbitrary JavaScript. Transfers wait until map load completes and require an idle map; database reload does not recreate existing game objects. dryRun only previews.',
    inputSchema: commandSchema.shape,
    handler: async (ctx, args) => runtimeCommand(ctx.projectPath, args),
  },
  {
    name: 'runtime_screenshot',
    annotations: runtimeAnnotations,
    description:
      'Capture the connected playtest scene as PNG under .mcp-cache/screenshots. Returns a local path, not desktop content. Requires an authenticated playtest; dryRun only reports the destination.',
    inputSchema: {
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
        .optional(),
      timeoutMs,
      dryRun,
    },
    handler: async (ctx, args) => runtimeScreenshot(ctx.projectPath, args),
  },
  {
    name: 'launch_playtest',
    annotations: runtimeAnnotations,
    description:
      'Launch this active MZ project in its local NW.js runtime with test mode. Uses runtimeExecutable, install, RPGMAKER_MZ_INSTALL, or the Windows Steam default. Returns the PID; connection and successful gameplay require separate verification. dryRun validates and previews without launching.',
    inputSchema: {
      install: z.string().optional(),
      runtimeExecutable: z.string().optional(),
      dryRun,
    },
    handler: async (ctx, args) => launchPlaytest(ctx.projectPath, args),
  },
];
