import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TOKEN_PREFIX = "bouncer.v1.";
const ENCODED_PART = /^[A-Za-z0-9_-]+$/;

export interface RunTokenClaims {
  runId: string;
  principalId: string;
  grantId: string;
  exp: number;
}

export type VerifiedRunToken = RunTokenClaims;

export class RunTokenVerificationError extends Error {
  constructor() {
    super("Invalid run token");
    this.name = "RunTokenVerificationError";
  }
}

function validClaims(value: unknown): value is RunTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.runId === "string" &&
    claims.runId.length > 0 &&
    typeof claims.principalId === "string" &&
    claims.principalId.length > 0 &&
    typeof claims.grantId === "string" &&
    claims.grantId.length > 0 &&
    typeof claims.exp === "number" &&
    Number.isSafeInteger(claims.exp)
  );
}

export class RunTokenService {
  private readonly secret: Buffer;

  constructor(secret: Buffer = randomBytes(32)) {
    if (secret.length < 32) {
      throw new Error("Run token signing key must contain at least 32 bytes");
    }
    this.secret = Buffer.from(secret);
  }

  static hasTokenMarker(token: string): boolean {
    return token.startsWith("bouncer.");
  }

  mint(input: RunTokenClaims): string {
    if (!validClaims(input)) {
      throw new Error("Invalid run token input");
    }
    const payload = Buffer.from(
      JSON.stringify({
        runId: input.runId,
        principalId: input.principalId,
        grantId: input.grantId,
        exp: input.exp,
      }),
      "utf8",
    ).toString("base64url");
    return TOKEN_PREFIX + payload + "." + this.sign(payload).toString("base64url");
  }

  verify(
    token: string,
    nowEpochSeconds = Math.floor(Date.now() / 1_000),
  ): VerifiedRunToken {
    try {
      if (!Number.isSafeInteger(nowEpochSeconds)) {
        throw new RunTokenVerificationError();
      }
      const parts = token.split(".");
      if (
        parts.length !== 4 ||
        parts[0] !== "bouncer" ||
        parts[1] !== "v1" ||
        !parts[2] ||
        !parts[3] ||
        !ENCODED_PART.test(parts[2]) ||
        !ENCODED_PART.test(parts[3])
      ) {
        throw new RunTokenVerificationError();
      }

      const expected = this.sign(parts[2]);
      const supplied = Buffer.from(parts[3], "base64url");
      if (
        supplied.length !== expected.length ||
        supplied.toString("base64url") !== parts[3] ||
        !timingSafeEqual(supplied, expected)
      ) {
        throw new RunTokenVerificationError();
      }

      const claims = JSON.parse(
        Buffer.from(parts[2], "base64url").toString("utf8"),
      ) as unknown;
      if (!validClaims(claims) || nowEpochSeconds >= claims.exp) {
        throw new RunTokenVerificationError();
      }
      return {
        runId: claims.runId,
        principalId: claims.principalId,
        grantId: claims.grantId,
        exp: claims.exp,
      };
    } catch (error) {
      if (error instanceof RunTokenVerificationError) throw error;
      throw new RunTokenVerificationError();
    }
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(payload).digest();
  }
}
