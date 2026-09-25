import { connect } from 'node:net';

/**
 * Asking ClamAV whether a file is malware (SR-5.5, T10, AC-5.3).
 *
 * ## What this is actually for
 *
 * Not for AC-5.3's EICAR case, which never reaches here: EICAR is a text file, and a text file
 * is refused by `@gth/security` three steps earlier for not being an image. Not for the
 * polyglot either, which is refused for having data after the image ends, and would in any case
 * not survive the re-encode.
 *
 * It is for the thing those two cannot catch: **a genuine, well-formed image that happens to
 * carry a known exploit for an image decoder.** Our own decoders are pure JavaScript and so are
 * a poor target, but the photo is served to browsers, and a browser's decoder is written in C.
 * A signature database is the only control here that knows about attacks nobody in this
 * repository has heard of.
 *
 * That makes it defence in depth in the real sense: it covers a different class of problem from
 * everything around it, rather than checking the same thing twice.
 *
 * ## INSTREAM, written out
 *
 * clamd's protocol is four commands and a length-prefixed stream. A client library for it would
 * be a dependency with one user, for something that is forty lines of `node:net` — and the
 * forty lines are easier to audit than the dependency.
 *
 * The host comes from configuration and the payload is bytes we already hold. There is no URL
 * and nothing a request can steer, which is why the outbound rule excepts this file by name.
 */

/** clamd refuses a stream larger than its `StreamMaxLength`; ours is bounded well below it. */
const CHUNK_BYTES = 64 * 1024;

export type ScanVerdict =
  /** clamd looked and found nothing. */
  | { clean: true }
  /** clamd recognised something. `signature` is its name for it. */
  | { clean: false; signature: string };

export class ScannerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScannerUnavailableError';
  }
}

export interface ScannerConfig {
  host: string;
  port: number;
  /**
   * How long to wait before giving up.
   *
   * A scanner that is not answering must not become an upload queue that never drains. The
   * caller decides what to do with the refusal — and the answer is to leave the photo pending
   * and try again, never to approve it unscanned.
   */
  timeoutMs?: number | undefined;
}

export interface Scanner {
  scan: (bytes: Uint8Array) => Promise<ScanVerdict>;
  /** Is clamd there at all? For the readiness check and the operations page. */
  ping: () => Promise<boolean>;
}

/** `zCOMMAND\0`, which is the framing clamd expects for a null-terminated command. */
function command(name: string): Buffer {
  return Buffer.from(`z${name}\0`, 'utf8');
}

function talk(
  config: ScannerConfig,
  write: (socket: NodeJS.WritableStream) => void,
): Promise<string> {
  const timeoutMs = config.timeoutMs ?? 30_000;
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: config.host, port: config.port });
    socket.setTimeout(timeoutMs);

    const fail = (error: unknown): void => {
      socket.destroy();
      reject(new ScannerUnavailableError('the virus scanner did not answer', { cause: error }));
    };

    socket.on('connect', () => {
      write(socket);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', fail);
    socket.on('timeout', () => {
      fail(new Error(`no answer within ${String(timeoutMs)}ms`));
    });
    socket.on('end', () => {
      // A `z`-prefixed command gets a **null-terminated** reply, so the answer is
      // `stream: OK\0` rather than `stream: OK`. `trim()` does not remove a NUL, which made
      // every verdict fall through to "the scanner is broken" — a failure that looked like an
      // outage and was a missing byte.
      resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/u, '').trim());
    });
  });
}

export function createScanner(config: ScannerConfig): Scanner {
  return {
    ping: async () => {
      try {
        return (await talk(config, (socket) => socket.end(command('PING')))) === 'PONG';
      } catch {
        return false;
      }
    },

    scan: async (bytes) => {
      const reply = await talk(config, (socket) => {
        socket.write(command('INSTREAM'));
        // Each chunk is a four-byte big-endian length followed by the bytes; a zero length
        // ends the stream. Getting the framing wrong makes clamd hang rather than complain,
        // which is why the socket has a timeout.
        for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
          const slice = bytes.subarray(at, Math.min(at + CHUNK_BYTES, bytes.length));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(slice.length, 0);
          socket.write(header);
          socket.write(slice);
        }
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.end(terminator);
      });

      // `stream: OK` or `stream: Eicar-Signature FOUND`, and `... ERROR` when clamd itself
      // could not do the work.
      if (reply.endsWith('OK')) return { clean: true };
      if (reply.endsWith('FOUND')) {
        const signature = reply.replace(/^stream:\s*/u, '').replace(/\s*FOUND$/u, '');
        return { clean: false, signature };
      }

      /**
       * Anything else is the scanner failing rather than the file being bad, and the two must
       * not be confused in either direction.
       *
       * Treating a scanner error as "infected" would reject good photos during an outage.
       * Treating it as "clean" would approve unscanned files during one — which is the failure
       * this whole module exists to prevent. So it is neither: it is an error, and the caller
       * leaves the photo pending.
       */
      throw new ScannerUnavailableError(`the virus scanner answered: ${reply}`);
    },
  };
}
