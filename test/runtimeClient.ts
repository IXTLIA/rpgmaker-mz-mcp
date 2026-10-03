// Test client adapted from DiegoLopez0208/RpgMakerMVUltimate-MCP (MIT).
import { randomBytes } from 'crypto';
import { connect, type Socket } from 'net';
const CRLF = String.fromCharCode(13, 10);
function clientFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, mask, masked]);
}

export class TestClient {
  private socket: Socket | null = null;
  private buf = Buffer.alloc(0);
  private handlers: ((msg: Record<string, unknown>) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('handshake timed out')), 4000);
      let handshakeDone = false;

      socket.on('connect', () => {
        const request = [
          'GET / HTTP/1.1',
          'Host: 127.0.0.1:' + port,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: ' + randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join(CRLF);
        socket.write(request);
      });

      socket.on('data', (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!handshakeDone) {
          const end = this.buf.indexOf(CRLF + CRLF);
          if (end === -1) return;
          const head = this.buf.subarray(0, end).toString('utf-8');
          this.buf = this.buf.subarray(end + 4);
          handshakeDone = true;
          clearTimeout(timer);
          if (!head.startsWith('HTTP/1.1 101')) {
            reject(new Error('upgrade refused: ' + head.split(CRLF)[0]));
            return;
          }
          resolve();
        }
        this.drain();
      });

      socket.on('error', () => {
        clearTimeout(timer);
        reject(new Error('socket error'));
      });
      socket.on('close', () => {
        for (const h of this.closeHandlers) h();
      });
    });
  }

  /** Server-to-client frames are never masked, so decodeFrame would reject them. */
  private drain(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      }
      if (this.buf.length < offset + len) return;
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);
      if (opcode !== 0x1) continue; // close/ping/pong are not part of these assertions
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(payload.toString('utf-8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const h of this.handlers) h(msg);
    }
  }

  onMessage(handler: (msg: Record<string, unknown>) => void): void {
    this.handlers.push(handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  send(payload: unknown): void {
    if (!this.socket) throw new Error('not connected');
    this.socket.write(clientFrame(JSON.stringify(payload)));
  }

  close(): void {
    this.socket?.destroy();
  }
}

/** Connect a client and resolve once the server has accepted its token. */
export async function connectAuthed(
  port: number,
  token: string,
  projectPath: string,
): Promise<TestClient> {
  const client = new TestClient();
  await client.connect(port);
  return new Promise<TestClient>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server never acknowledged auth')), 4000);
    // The server answers an accepted auth with a ping command.
    client.onMessage((msg) => {
      if (msg.requestId === 'authenticated') {
        clearTimeout(timer);
        resolve(client);
      }
    });
    client.send({ type: 'auth', token, projectPath });
  });
}
