import {
  AUTHORIZE_URL,
  CLIENT_ID,
  MANUAL_REDIRECT_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from "./constants.js";
import { generatePKCE } from "./pkce.js";

export type ClaudeOAuthTokens = {
  access: string;
  refresh: string;
  expires: number;
};

export type AuthorizationResult = {
  url: string;
  redirectUri: string;
  state: string;
  verifier: string;
};

export class RefreshTokenInvalidError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(
      `Claude token refresh rejected (HTTP ${status}): ${body || "<empty body>"}`,
    );
    this.name = "RefreshTokenInvalidError";
    this.status = status;
    this.body = body;
  }
}

function generateState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function authorizeClaudeMax(): Promise<AuthorizationResult> {
  const pkce = await generatePKCE();
  const state = generateState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", MANUAL_REDIRECT_URL);
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return {
    url: url.toString(),
    redirectUri: MANUAL_REDIRECT_URL,
    state,
    verifier: pkce.verifier,
  };
}

function parseCallbackInput(input: string): { code: string; state: string } | null {
  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return { code, state };
  } catch {
    // fall through
  }

  const hashSplits = trimmed.split("#");
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] };
  }

  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  const state = params.get("state");
  if (code && state) return { code, state };

  return null;
}

async function postToken(body: Record<string, string>): Promise<ClaudeOAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "axios/1.13.6",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new RefreshTokenInvalidError(response.status, text);
    }
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const json = JSON.parse(text) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function exchangeClaudeCode(
  input: string,
  verifier: string,
  expectedState: string,
  redirectUri = MANUAL_REDIRECT_URL,
): Promise<ClaudeOAuthTokens> {
  const callback = parseCallbackInput(input);
  if (!callback) {
    throw new Error(
      "Could not parse OAuth callback. Paste the full redirect URL or code#state.",
    );
  }
  if (callback.state !== expectedState) {
    throw new Error("OAuth state mismatch — restart login.");
  }

  return postToken({
    code: callback.code,
    state: callback.state,
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export async function refreshClaudeToken(
  refreshToken: string,
): Promise<ClaudeOAuthTokens> {
  try {
    return await postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
  } catch (err) {
    if (err instanceof RefreshTokenInvalidError) throw err;
    throw err;
  }
}
