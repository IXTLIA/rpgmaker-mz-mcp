// Transport adapted from DiegoLopez0208/RpgMakerMVUltimate-MCP (MIT).
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFile, realpath, unlink, writeFile } from 'fs/promises';
import { startWsServer, WsConnection, WsServer } from './wsServer.js';
import {
  COMMANDS,
  DEFAULT_PORT,
  HANDSHAKE_FILE,
  RuntimeCommand,
  RuntimeFrame,
  TELEMETRY_LIMIT,
} from './protocol.js';
import { projectFile } from './projectPaths.js';

let server: WsServer | undefined;
let projectRoot: string | undefined;
let token = '';
let handshakePath: string | undefined;
let sequence = 0;
let dropped = 0;
const frames: RuntimeFrame[] = [];
const frameSizes = new Map<RuntimeFrame, number>();
let bufferedBytes = 0;
const pending = new Map<
  string,
  { resolve: (frame: RuntimeFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>();

function clients(): WsConnection[] {
  return (
    server
      ?.connections()
      .filter((connection) => connection.meta.authenticated && !connection.closed) ?? []
  );
}

export function runtimeStatus() {
  return {
    running: !!server,
    projectPath: projectRoot ?? null,
    port: server?.port ?? null,
    connected: clients().length === 1,
    buffered: frames.length,
    bufferedBytes,
    droppedFrames: dropped,
  };
}

export async function assertRuntimeProject(project: string): Promise<void> {
  if (!server || projectRoot !== (await realpath(project))) {
    if (server) await stopBridge();
    throw new Error(
      'No runtime bridge for the active project. Start its bridge and connect a playtest.',
    );
  }
}

/** One authenticated client prevents commands from controlling multiple playtests at once. */
export async function startBridge(project: string, port = DEFAULT_PORT) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid bridge port.');
  const root = await realpath(project);
  if (server && projectRoot === root) return runtimeStatus();
  await stopBridge();
  const file = await projectFile(root, HANDSHAKE_FILE);
  // Do not replace another MCP session's handshake. A stale file requires explicit cleanup.
  const newToken = randomBytes(24).toString('hex');
  const newServer = await startWsServer(port, {
    onConnection(connection) {
      connection.meta.timer = setTimeout(
        () => connection.close(4408, 'authentication timeout'),
        5000,
      );
    },
    onMessage(connection, text) {
      let message: RuntimeFrame;
      try {
        message = JSON.parse(text);
      } catch {
        connection.close(1003, 'expected JSON');
        return;
      }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'auth') {
        const value =
          typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0);
        const expected = Buffer.from(token);
        if (
          !token ||
          value.length !== expected.length ||
          !timingSafeEqual(value, expected) ||
          message.projectPath !== projectRoot
        ) {
          connection.close(4401, 'invalid token');
          return;
        }
        if (clients().some((other) => other !== connection)) {
          connection.close(4409, 'a playtest is already connected');
          return;
        }
        clearTimeout(connection.meta.timer as NodeJS.Timeout);
        connection.meta.authenticated = true;
        connection.send(JSON.stringify({ action: 'ping', requestId: 'authenticated' }));
        return;
      }
      if (!connection.meta.authenticated) {
        connection.close(4401, 'authenticate first');
        return;
      }
      const frame = { ...message, receivedAt: new Date().toISOString() };
      if (message.type !== 'screenshot_result') {
        const size = Buffer.byteLength(text);
        if (size > 65536) dropped++;
        else {
          frames.push(frame);
          frameSizes.set(frame, size);
          bufferedBytes += size;
          while (frames.length > TELEMETRY_LIMIT || bufferedBytes > 2 * 1024 * 1024) {
            const removed = frames.shift()!;
            bufferedBytes -= frameSizes.get(removed)!;
            frameSizes.delete(removed);
            dropped++;
          }
        }
      }
      const waiter = message.requestId && pending.get(message.requestId);
      if (waiter) {
        pending.delete(message.requestId!);
        clearTimeout(waiter.timer);
        if (message.type === 'error')
          waiter.reject(new Error(String(message.message ?? 'Runtime rejected command')));
        else waiter.resolve(frame);
      }
    },
    onClose(connection) {
      clearTimeout(connection.meta.timer as NodeJS.Timeout);
      if (connection.meta.authenticated) {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('Playtest disconnected.'));
        }
        pending.clear();
      }
    },
  });
  try {
    await writeFile(
      file,
      JSON.stringify({ port: newServer.port, token: newToken, pid: process.pid }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    await newServer.close();
    throw error;
  }
  server = newServer;
  projectRoot = root;
  token = newToken;
  handshakePath = file;
  frames.length = 0;
  frameSizes.clear();
  bufferedBytes = 0;
  dropped = 0;
  return runtimeStatus();
}

export async function stopBridge() {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Runtime bridge stopped.'));
  }
  pending.clear();
  const previous = server;
  server = undefined;
  if (previous) await previous.close();
  if (handshakePath) {
    try {
      const handshake = JSON.parse(await readFile(handshakePath, 'utf8'));
      if (handshake.token === token) await unlink(handshakePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  projectRoot = undefined;
  token = '';
  handshakePath = undefined;
  frames.length = 0;
  frameSizes.clear();
  bufferedBytes = 0;
  return runtimeStatus();
}

export function readTelemetry(limit = 100, types?: string[], peek = true) {
  const matching = frames.filter((frame) => !types?.length || types.includes(frame.type));
  const selected = matching.slice(-Math.max(1, Math.min(TELEMETRY_LIMIT, limit)));
  if (!peek)
    for (const frame of selected) {
      frames.splice(frames.indexOf(frame), 1);
      bufferedBytes -= frameSizes.get(frame)!;
      frameSizes.delete(frame);
    }
  return { frames: selected, count: selected.length, droppedFrames: dropped };
}

export async function requestRuntime(
  project: string,
  command: RuntimeCommand,
  timeoutMs = 8000,
): Promise<RuntimeFrame> {
  await assertRuntimeProject(project);
  if (!(COMMANDS as readonly string[]).includes(command.action))
    throw new Error('Unsupported runtime command.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid runtime timeout.');
  const [client] = clients();
  if (!client) throw new Error('No authenticated MZ playtest is connected.');
  const requestId = `${++sequence}-${randomBytes(4).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Runtime ${command.action} timed out.`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    client.send(JSON.stringify({ ...command, requestId }));
  });
}
