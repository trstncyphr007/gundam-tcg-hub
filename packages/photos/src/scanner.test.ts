import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Scanner, ScannerUnavailableError, createScanner } from './scanner.js';

/**
 * The virus scanner, against a real clamd (SR-5.5).
 *
 * Real, because what is under test is a wire protocol. INSTREAM is a length-prefixed stream
 * with a zero-length terminator, and getting the framing wrong makes clamd **hang** rather than
 * complain — a stub would answer cheerfully and prove nothing about the one thing that can go
 * wrong here.
 *
 * Slow, as a result: clamd loads a signature database into memory before it answers anything.
 * That is the price of testing the protocol rather than a mock of it, and this is the only file
 * that pays it.
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

let container: StartedTestContainer;
let scanner: Scanner;

beforeAll(async () => {
  container = await new GenericContainer('clamav/clamav:1.4')
    .withEnvironment({
      // The signature database ships inside this tag. Without this clamd also starts freshclam
      // and waits on a download, which is minutes of nothing on every run.
      CLAMAV_NO_FRESHCLAMD: 'true',
    })
    .withExposedPorts(3310)
    .withWaitStrategy(Wait.forLogMessage(/Self checking every .* seconds|clamd started/iu))
    .withStartupTimeout(300_000)
    .start();

  scanner = createScanner({
    host: container.getHost(),
    port: container.getMappedPort(3310),
    timeoutMs: 60_000,
  });
}, 360_000);

afterAll(async () => {
  await container.stop();
});

describe('talking to clamd', () => {
  it('answers a ping, which is how readiness knows it is there', async () => {
    expect(await scanner.ping()).toBe(true);
  });

  it('passes an ordinary file', async () => {
    const clean = new TextEncoder().encode('just some bytes, nothing to see');
    expect(await scanner.scan(clean)).toEqual({ clean: true });
  });

  it('recognises the EICAR test file and names what it found', async () => {
    /**
     * Not AC-5.3's EICAR case — that one never reaches here, because a text file is refused by
     * `@gth/security` three steps earlier for not being an image. This is the proof that the
     * INSTREAM framing is right, using the one input every scanner in the world agrees about.
     */
    const verdict = await scanner.scan(new TextEncoder().encode(EICAR));
    expect(verdict.clean).toBe(false);
    if (!verdict.clean) expect(verdict.signature.toLowerCase()).toContain('eicar');
  });

  it('streams something larger than one chunk', async () => {
    // The framing is per chunk, so a file that fits in a single 64 kB write exercises none of
    // the loop. A quarter of a megabyte does.
    const big = new Uint8Array(256 * 1024).fill(0x41);
    expect(await scanner.scan(big)).toEqual({ clean: true });
  });

  it('does not flag EICAR buried inside a larger file, and that is ClamAV’s choice', async () => {
    /**
     * Recorded because the obvious assumption is the opposite one.
     *
     * ClamAV's EICAR signature is anchored: it matches the test file as a file, and
     * deliberately not as a fragment of something bigger, because the string turns up inside
     * antivirus documentation and mail archives and flagging those would be useless.
     *
     * **So the scanner would not catch EICAR appended to a JPEG.** That is fine, and it is a
     * good illustration of why the layers here are independent rather than three versions of
     * the same check:
     *
     *  - `@gth/security` refuses it for having data after the image ends.
     *  - the re-encode would drop it regardless, because it is not a pixel.
     *  - this scanner is for the case neither of those covers — a genuine, well-formed image
     *    carrying a known exploit for somebody else's decoder.
     *
     * A test asserting the opposite would have been written against an assumption and would
     * have failed the first time anybody ran it, which is how this one came to exist.
     */
    const padded = new Uint8Array(128 * 1024 + EICAR.length).fill(0x41);
    padded.set(new TextEncoder().encode(EICAR), 128 * 1024);
    expect(await scanner.scan(padded)).toEqual({ clean: true });
  });
});

describe('a scanner that is not there', () => {
  it('refuses rather than pretending the file is clean', async () => {
    /**
     * The failure that matters. Treating an unreachable scanner as "clean" would approve
     * unscanned files during exactly the outage this module exists to cover; treating it as
     * "infected" would reject good photos. It is neither — it throws, and the caller leaves
     * the photo pending.
     */
    const absent = createScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    await expect(absent.scan(new Uint8Array(4))).rejects.toThrow(ScannerUnavailableError);
  });

  it('answers a ping with false instead of throwing', async () => {
    // Readiness asks a question and wants an answer, not an exception.
    const absent = createScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    expect(await absent.ping()).toBe(false);
  });
});
