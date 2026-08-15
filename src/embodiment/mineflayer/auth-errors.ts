/**
 * Microsoft/Xbox authentication failure codes, translated into something a
 * person can act on.
 *
 * The token exchange itself is not ours: passing `auth: 'microsoft'` hands the
 * MSA -> Xbox Live -> XSTS -> Minecraft chain to `prismarine-auth`, and
 * hand-rolling it would be both redundant and a good way to get an account
 * suspended. What is ours is the error surface. XSTS reports these five
 * conditions constantly, and every one of them is a specific, fixable account
 * problem that a bare "authentication failed" wastes the user's afternoon on.
 *
 * Kept in its own module so it can be tested without a network.
 */

export type XstsErrorCode =
  | 2148916227
  | 2148916233
  | 2148916235
  | 2148916236
  | 2148916237
  | 2148916238;

export const XSTS_GUIDANCE: Readonly<Record<number, string>> = {
  2148916227: 'this Xbox account has been banned for a terms-of-service violation',
  2148916233:
    'no Xbox account exists for this Microsoft account; create one once at xbox.com, then sign in again',
  2148916235: 'Xbox Live is not available in this account’s region',
  2148916236:
    'this account requires adult verification (South Korea) before it can sign in',
  2148916237:
    'this account requires adult verification (South Korea) before it can sign in',
  2148916238:
    'this is a child account and must be added to a family by an adult before it can sign in',
};

/** An authentication failure we could name, with guidance attached. */
export class MinecraftAuthError extends Error {
  constructor(
    readonly code: number | undefined,
    readonly guidance: string,
    override readonly cause?: unknown,
  ) {
    super(
      code === undefined
        ? `authentication failed: ${guidance}`
        : `authentication failed (XErr ${code}): ${guidance}`,
    );
    this.name = 'MinecraftAuthError';
  }
}

/**
 * Pull an XSTS code out of whatever the auth chain threw.
 *
 * prismarine-auth surfaces the XSTS body as text, so the code arrives embedded
 * in a message rather than as a field. Matching the digits is unglamorous and
 * survives changes to the surrounding JSON.
 */
export function extractXstsCode(error: unknown): number | undefined {
  const text =
    error instanceof Error
      ? `${error.message} ${String((error as { body?: unknown }).body ?? '')}`
      : String(error);

  const direct = /(?:XErr"?\s*[:=]\s*)(\d{10})/.exec(text);
  const code = direct?.[1] ?? /\b(21489162\d{2})\b/.exec(text)?.[1];
  if (code === undefined) return undefined;
  const parsed = Number(code);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Translate an authentication failure, or return undefined when the error is
 * not an authentication problem at all.
 */
export function toAuthError(error: unknown): MinecraftAuthError | undefined {
  const code = extractXstsCode(error);
  if (code !== undefined) {
    return new MinecraftAuthError(
      code,
      XSTS_GUIDANCE[code] ?? 'Xbox Live rejected this account',
      error,
    );
  }

  const text = error instanceof Error ? error.message : String(error);
  if (/invalid[_ ]?(session|token)|unauthori[sz]ed|401|authentication/i.test(text)) {
    return new MinecraftAuthError(
      undefined,
      'the account could not be authenticated; check the credentials or re-run the device-code flow',
      error,
    );
  }
  return undefined;
}
