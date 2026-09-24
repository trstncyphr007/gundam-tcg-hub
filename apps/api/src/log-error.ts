/**
 * What an error may contribute to a log line (SR-X.20, SR-X.23, T15).
 *
 * pino's default error serialiser copies an error's own properties, which is fine for an error
 * somebody wrote and wrong for one a database driver threw. Drizzle wraps the driver's failure
 * and attaches the failing **statement** and its **bound parameters**, then repeats both inside
 * the message:
 *
 *     Failed query: insert into "app"."api_keys" (...) values ($1, $2, ...)
 *     params: Key ...,SUPERSECRETKEYHASHVALUE,...: duplicate key value violates unique ...
 *
 * Most statements bind nothing worth hiding. Some bind exactly what this system exists to
 * protect — an API key's hash, an encrypted break seed, and through Better Auth the session
 * tokens and magic-link tokens themselves. Any of those failing wrote the secret to the log.
 *
 * So the payload goes and the diagnosis stays. What is kept is the innermost error's own
 * message, its SQLSTATE, the constraint and table it names, and the stack **frames** — which
 * is enough to know what broke and where, and is what someone actually reads at three in the
 * morning. What is dropped is `query`, `params`, and Postgres's `detail`, the last because it
 * helpfully quotes the offending values back ("Key (prefix)=(abc) already exists").
 */
/**
 * `type`, `message` and `stack` are required, and the index signature is there because
 * Fastify's serialiser contract asks for both.
 */
export interface LoggedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
  code?: string;
  constraint?: string;
  table?: string;
}

/** The original failure, not the wrapper: the SQLSTATE and constraint live on it. */
function innermost(error: Error): Error {
  let current: Error = error;
  for (let depth = 0; depth < 10; depth += 1) {
    const cause = (current as { cause?: unknown }).cause;
    if (!(cause instanceof Error)) break;
    current = cause;
  }
  return current;
}

/**
 * One line, and never the part that follows `params:`.
 *
 * Belt and braces: the innermost driver error's message is clean on its own, but a wrapper
 * that has not been seen yet would arrive with the payload glued to it, and this is the last
 * place to notice.
 */
function safeMessage(message: string): string {
  const [first = ''] = message.split('\n');
  const stripped = first.split(/\bparams:/)[0] ?? first;
  return stripped.trim().slice(0, 300);
}

/** Frames only. The first lines of a stack repeat the message, payload and all. */
function frames(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 12)
    .join('\n');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function serialiseError(error: unknown): LoggedError {
  if (!(error instanceof Error)) {
    return { type: 'NonError', message: safeMessage(String(error)), stack: '' };
  }
  const inner = innermost(error);
  const fields = inner as unknown as Record<string, unknown>;
  const code = asString(fields['code']);
  const constraint = asString(fields['constraint_name']);
  const table = asString(fields['table_name']);

  return {
    type: inner.name,
    message: safeMessage(inner.message),
    stack: error.stack === undefined ? '' : frames(error.stack),
    ...(code === undefined ? {} : { code }),
    ...(constraint === undefined ? {} : { constraint }),
    ...(table === undefined ? {} : { table }),
  };
}
