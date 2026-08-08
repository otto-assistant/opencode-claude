/**
 * Smoke tests for opencode-claude — no live Claude CLI required.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

async function main() {
  const {
    authorizeClaudeMax,
    RefreshTokenInvalidError,
  } = await import("../src/auth.ts");
  const { generatePKCE } = await import("../src/pkce.ts");
  const {
    extractClaudeOAuthCredentials,
    listClaudeCredentialsCandidates,
    readClaudeCodeOAuthTokenFromEnv,
  } = await import("../src/credentials.ts");
  const { buildClaudeCodeChildEnv, withClaudeOAuthToken } = await import(
    "../src/auth-env.ts"
  );
  const {
    interpretClaudeAuthStatus,
  } = await import("../src/detect.ts");
  const {
    CLAUDE_CODE_MODELS,
    buildEffortVariants,
    getClaudeModels,
    isLoginPlaceholderModel,
    resolveClaudeModelId,
  } = await import("../src/models.ts");
  const {
    encodeClaudeModelSelection,
    decodeClaudeModelSelection,
    resolveClaudeModelSelection,
  } = await import("../src/model-selection.ts");
  const { conversationKeyFromMessages } = await import(
    "../src/session-store.ts"
  );
  const { isClaudeEffort, PROVIDER_ID, EFFORT_LEVELS } = await import(
    "../src/constants.ts"
  );
  const { ClaudeCodePlugin } = await import("../src/index.ts");
  const {
    startProxy,
    stopProxy,
    getProxyPort,
    getClaudeProxyBaseUrl,
  } = await import("../src/proxy.ts");

  // PKCE
  const pkce = await generatePKCE();
  assert.equal(typeof pkce.verifier, "string");
  assert.ok(pkce.verifier.length > 20);
  assert.equal(typeof pkce.challenge, "string");

  // OAuth authorize URL
  const auth = await authorizeClaudeMax();
  assert.ok(auth.url.includes("claude.ai/oauth/authorize"));
  assert.ok(auth.url.includes("client_id="));
  assert.ok(auth.verifier);
  assert.ok(auth.state);

  // Credentials parsing
  const extracted = extractClaudeOAuthCredentials({
    claudeAiOauth: {
      accessToken: "access-xyz",
      refreshToken: "refresh-xyz",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
  });
  assert.equal(extracted?.accessToken, "access-xyz");
  assert.equal(extracted?.refreshToken, "refresh-xyz");
  const candidates = listClaudeCredentialsCandidates();
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length > 0);

  assert.equal(
    readClaudeCodeOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: " tok " }),
    "tok",
  );
  assert.equal(readClaudeCodeOAuthTokenFromEnv({}), null);

  // Auth env stripping
  const cleaned = buildClaudeCodeChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-secret",
    ANTHROPIC_AUTH_TOKEN: "tok",
    KEEP: "1",
  });
  assert.equal(cleaned.ANTHROPIC_API_KEY, undefined);
  assert.equal(cleaned.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(cleaned.KEEP, "1");
  assert.equal(cleaned.PATH, "/usr/bin");

  const withTok = withClaudeOAuthToken("oauth-access", { PATH: "/bin" });
  assert.equal(withTok.CLAUDE_CODE_OAUTH_TOKEN, "oauth-access");
  assert.equal(withTok.ANTHROPIC_API_KEY, undefined);

  // Auth status interpretation (subscription vs API-key-only)
  assert.equal(
    interpretClaudeAuthStatus({ loggedIn: true, authMethod: "oauth" }).loggedIn,
    true,
  );
  assert.equal(
    interpretClaudeAuthStatus({ loggedIn: true, authMethod: "api_key" })
      .loggedIn,
    false,
  );
  assert.equal(
    interpretClaudeAuthStatus({ loggedIn: false, authMethod: "none" }).loggedIn,
    false,
  );

  // Models / effort
  const models = getClaudeModels();
  assert.ok(models.length >= 4);
  assert.ok(models.some((m) => m.id === "sonnet"));
  assert.ok(models.some((m) => m.id === "opus"));
  assert.equal(resolveClaudeModelId("haiku"), "claude-haiku-4-5");
  assert.equal(resolveClaudeModelId("sonnet"), "sonnet");
  assert.equal(isLoginPlaceholderModel("login"), true);
  assert.equal(isLoginPlaceholderModel("sonnet"), false);

  const sonnet = CLAUDE_CODE_MODELS.find((m) => m.id === "sonnet")!;
  const variants = buildEffortVariants(sonnet);
  for (const level of EFFORT_LEVELS) {
    assert.ok(variants[level]);
    assert.equal(isClaudeEffort(level), true);
    assert.ok(
      variants[level] &&
        typeof variants[level] === "object" &&
        "effort" in variants[level],
    );
  }
  assert.deepEqual(variants.none, { disabled: true });
  assert.deepEqual(variants.minimal, { disabled: true });
  assert.equal(isClaudeEffort("nope"), false);

  const selection = resolveClaudeModelSelection("sonnet", "high");
  const encoded = encodeClaudeModelSelection(selection);
  const decoded = decodeClaudeModelSelection(encoded);
  assert.deepEqual(decoded, { modelId: "sonnet", effort: "high" });

  // Multimodal prompt conversion
  const {
    openaiContentToAnthropicBlocks,
    latestUserPrompt: buildPrompt,
    contentHasAttachments,
  } = await import("../src/prompt.ts");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const blocks = openaiContentToAnthropicBlocks([
    { type: "text", text: "what color?" },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${png}` },
    },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "text");
  assert.equal(blocks[1]?.type, "image");
  assert.equal(contentHasAttachments([{ type: "image_url", image_url: { url: "x" } }]), true);

  // OpenAI-compatible PDF shape from @ai-sdk/openai-compatible
  const pdfB64 = "JVBERi0xLjAK"; // "%PDF-1.0" stub
  const pdfBlocks = openaiContentToAnthropicBlocks([
    { type: "text", text: "summarise" },
    {
      type: "file",
      file: {
        filename: "note.pdf",
        file_data: `data:application/pdf;base64,${pdfB64}`,
      },
    },
  ]);
  assert.equal(pdfBlocks.length, 2);
  assert.equal(pdfBlocks[0]?.type, "text");
  assert.equal(pdfBlocks[1]?.type, "document");
  assert.equal(
    pdfBlocks[1] && "source" in pdfBlocks[1] && pdfBlocks[1].source.type === "base64"
      ? pdfBlocks[1].source.media_type
      : null,
    "application/pdf",
  );
  assert.equal(
    pdfBlocks[1] && "source" in pdfBlocks[1] && pdfBlocks[1].source.type === "base64"
      ? pdfBlocks[1].source.data
      : null,
    pdfB64,
  );
  const pdfPrompt = buildPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "read this" },
        {
          type: "file",
          file: {
            filename: "note.pdf",
            file_data: `data:application/pdf;base64,${pdfB64}`,
          },
        },
      ],
    },
  ]);
  assert.equal(
    typeof pdfPrompt === "object" &&
      pdfPrompt !== null &&
      pdfPrompt.type === "user" &&
      Array.isArray(pdfPrompt.message.content) &&
      pdfPrompt.message.content.some((b) => b.type === "document"),
    true,
  );

  // AI SDK-style { type: "image", image: dataUrl } must not be dropped
  const sdkImage = openaiContentToAnthropicBlocks([
    { type: "text", text: "see?" },
    { type: "image", image: `data:image/png;base64,${png}` },
  ]);
  assert.equal(sdkImage.some((b) => b.type === "image"), true);
  const namedDataUrl = openaiContentToAnthropicBlocks([
    {
      type: "image_url",
      image_url: { url: `data:image/png;name=x.png;base64,${png}` },
    },
  ]);
  assert.equal(namedDataUrl.length, 1);
  assert.equal(namedDataUrl[0]?.type, "image");

  const multi = buildPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ],
    },
  ]);
  assert.equal(typeof multi === "object" && multi !== null && multi.type === "user", true);

  // Conversation key stability
  const key = conversationKeyFromMessages([
    { role: "user", content: "hello world" },
  ]);
  assert.ok(key.startsWith("conv_"));

  // Plugin export
  assert.equal(typeof ClaudeCodePlugin, "function");
  assert.equal(PROVIDER_ID, "claude-code");
  assert.ok(RefreshTokenInvalidError);

  // Proxy health (without Agent SDK turn)
  await stopProxy();
  const port = await startProxy(async () => null);
  assert.ok(port > 0);
  assert.equal(getProxyPort(), port);
  assert.ok(getClaudeProxyBaseUrl().includes(String(port)));

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const healthJson = (await health.json()) as { ok: boolean };
  assert.equal(healthJson.ok, true);

  const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(modelsRes.status, 200);
  const modelsJson = (await modelsRes.json()) as { data: unknown[] };
  assert.ok(Array.isArray(modelsJson.data));
  assert.ok(modelsJson.data.length > 0);

  await stopProxy();

  // TypeScript build
  const build = spawnSync("bun", ["run", "build"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    throw new Error("build failed");
  }

  console.log("ok — opencode-claude smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
