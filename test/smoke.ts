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

  // Usage + compact helpers
  const { usageFromSdkResult, formatCompactNote } = await import(
    "../src/usage.ts"
  );
  const usage = usageFromSdkResult({
    type: "result",
    is_error: false,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
  });
  assert.equal(usage?.prompt_tokens, 50);
  assert.equal(usage?.completion_tokens, 10);
  assert.equal(usage?.prompt_tokens_details?.cached_tokens, 5);
  assert.match(
    formatCompactNote({ trigger: "auto", pre_tokens: 1000, post_tokens: 100 }),
    /1000 → 100/,
  );

  // Session auto-naming: detect title/summary meta requests + sanitize titles
  {
    const {
      detectMetaRequestKind,
      isTitleGenerationRequest,
      requestKeyNamespace,
      buildMetaPrompt,
    } = await import("../src/request-kind.ts");
    const {
      sanitizeMetaOutput,
      heuristicTitle,
      metaChatCompletionResponse,
    } = await import("../src/meta-completion.ts");

    const titleMessages = [
      {
        role: "system",
        content:
          "You are a title generator. Generate a brief title for this conversation. Output only the title.",
      },
      { role: "user", content: "Explain binary trees and their basic operations" },
    ];
    assert.equal(isTitleGenerationRequest(titleMessages), true);
    assert.equal(detectMetaRequestKind(titleMessages), "title");
    assert.equal(requestKeyNamespace("title"), "title:");
    assert.equal(requestKeyNamespace(null), "");

    const meta = buildMetaPrompt(titleMessages);
    assert.match(meta.system, /title generator/i);
    assert.match(meta.prompt, /binary trees/i);

    assert.equal(
      sanitizeMetaOutput('"Binary Trees Basics"', "title"),
      "Binary Trees Basics",
    );
    assert.equal(
      sanitizeMetaOutput("Title: Foo Bar", "title"),
      "Foo Bar",
    );
    assert.equal(
      sanitizeMetaOutput("", "title", "user: Explain hashing"),
      heuristicTitle("user: Explain hashing"),
    );

    const summaryMessages = [
      {
        role: "system",
        content: "You are tasked with summarizing conversations for compaction.",
      },
      { role: "user", content: "Please summarize what was done in this conversation." },
    ];
    assert.equal(detectMetaRequestKind(summaryMessages), "summary");

    const normalMessages = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "fix a bug" },
    ];
    assert.equal(detectMetaRequestKind(normalMessages), null);
  }

  // Logger: errors always emit; info is debug-gated; durable file mirror
  {
    const { spawnSync } = await import("node:child_process");
    const { readFileSync, unlinkSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const logPath = join(homedir(), ".local", "share", "opencode-claude", "debug.log");
    if (existsSync(logPath)) unlinkSync(logPath);

    const off = spawnSync(
      "bun",
      [
        "-e",
        `import { log } from "./src/log.ts"; log.info("SILENT_INFO"); log.error("ALWAYS_ERROR");`,
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
        env: { ...process.env, OPENCODE_CLAUDE_DEBUG: "0" },
      },
    );
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stderr, /SILENT_INFO/);
    assert.match(off.stderr, /ALWAYS_ERROR/);

    const on = spawnSync(
      "bun",
      [
        "-e",
        `import { log } from "./src/log.ts"; log.info("DEBUG_INFO", { ok: true });`,
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
        env: { ...process.env, OPENCODE_CLAUDE_DEBUG: "1" },
      },
    );
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stderr, /DEBUG_INFO/);
    assert.match(on.stderr, /"ok":true/);
    assert.ok(existsSync(logPath), "expected durable debug.log");
    const fileBody = readFileSync(logPath, "utf8");
    assert.match(fileBody, /ALWAYS_ERROR/);
    assert.match(fileBody, /DEBUG_INFO/);
  }

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

  // Title meta path without OAuth → heuristic title via OpenAI SSE (fast)
  {
    const titleStarted = Date.now();
    const titleRes = await fetch(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          stream: true,
          messages: [
            {
              role: "system",
              content:
                "You are a title generator. Generate a brief title. Output only the title.",
            },
            {
              role: "user",
              content: "Explain how binary search trees work",
            },
          ],
        }),
      },
    );
    assert.equal(titleRes.status, 200);
    const titleBody = await titleRes.text();
    const titleMs = Date.now() - titleStarted;
    assert.ok(titleMs < 2000, `title path too slow: ${titleMs}ms`);
    assert.match(titleBody, /data: /);
    assert.match(titleBody, /\[DONE\]/);
    assert.match(titleBody, /binary search trees/i);
    assert.doesNotMatch(titleBody, /reasoning_content/);
  }

  // ---- Rate-limit tracker + tool/plan behavior (mocked Agent SDK) ----
  {
    const {
      __resetRateLimitNoteDedupe,
      formatResetCountdown,
      getRateLimitSnapshot,
      isClaudeRateLimitText,
      maybeRateLimitNote,
      normalizeClaudeErrorText,
      parseResetTimeFromText,
      rateLimitGate,
      recordRateLimitErrorText,
      recordRateLimitInfo,
    } = await import("../src/rate-limit.ts");
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const tmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-rl-"));
    const storeFile = joinPath(tmpDir, "rate-limit.json");
    const prevStoreEnv = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = storeFile;

    try {
      // Unit: text detection + normalization
      assert.equal(
        isClaudeRateLimitText(
          "You've hit your session limit · resets 1:10am (Europe/Kyiv)",
        ),
        true,
      );
      assert.equal(isClaudeRateLimitText("all good"), false);
      assert.equal(
        normalizeClaudeErrorText(
          "Claude Code returned an error result: You've hit your session limit · resets 1:10am (Europe/Kyiv)",
        ),
        normalizeClaudeErrorText(
          "[claude-code error] You've hit your session limit · resets 1:10am (Europe/Kyiv)",
        ),
      );

      // Unit: reset-time parsing (wall clock + IANA zone, ISO, none)
      const wallReset = parseResetTimeFromText(
        "You've hit your session limit · resets 1:10am (Europe/Kyiv)",
      );
      assert.ok(wallReset, "expected wall-clock reset parse");
      assert.ok(wallReset! > Date.now(), "reset must be in the future");
      assert.ok(
        wallReset! <= Date.now() + 26 * 3600_000,
        "reset must be within 26h",
      );
      const isoReset = parseResetTimeFromText(
        "usage limit reached, resets at 2099-01-02T03:04:05Z",
      );
      assert.equal(isoReset, Date.parse("2099-01-02T03:04:05Z"));
      assert.equal(parseResetTimeFromText("no reset hint"), undefined);
      assert.equal(formatResetCountdown(0), "now");
      assert.equal(formatResetCountdown(3_900_000), "65m");
      assert.match(formatResetCountdown(5_700_000), /^1h 35m$/);

      // Unit: structured event recording (SDK emits epoch seconds)
      const futureSec = Math.floor(Date.now() / 1000) + 5400;
      const recorded = recordRateLimitInfo({
        status: "allowed_warning",
        resetsAt: futureSec,
        rateLimitType: "five_hour",
        utilization: 0.99,
      });
      assert.ok(recorded);
      assert.equal(recorded!.limited, false); // events alone never gate
      assert.equal(recorded!.resetsAt, futureSec * 1000);
      assert.equal(recorded!.utilization, 0.99);

      // Unit: note dedupe (first yes, same signature no)
      __resetRateLimitNoteDedupe();
      const note1 = maybeRateLimitNote(recorded);
      assert.ok(note1 && /rate-limit/.test(note1) && /99%/.test(note1));
      assert.equal(maybeRateLimitNote(recorded), null);

      // Proxy: /v1/rate-limit counter endpoint reflects recorded state
      const rlRes = await fetch(`http://127.0.0.1:${port}/v1/rate-limit`);
      assert.equal(rlRes.status, 200);
      const rlBody = (await rlRes.json()) as Record<string, unknown>;
      assert.equal(rlBody.limited, false);
      assert.equal(rlBody.status, "allowed_warning");
      assert.equal(rlBody.utilization, 0.99);
      assert.equal(rlBody.resetsAt, futureSec * 1000);

      // /health carries a compact counter too
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const healthBody = (await healthRes.json()) as {
        rateLimit?: { limited?: boolean; utilization?: number };
      };
      assert.equal(healthBody.rateLimit?.limited, false);
      assert.equal(healthBody.rateLimit?.utilization, 0.99);

      // Proxy + mock SDK: successful turn streams text, note, usage — and the
      // todowrite alias + plan-persistence prompt reach the query starter.
      __resetRateLimitNoteDedupe();
      let seenParams: Record<string, unknown> | null = null;
      setClaudeQueryStarter(async (params) => {
        seenParams = params as unknown as Record<string, unknown>;
        const events = [
          { type: "system", subtype: "init", session_id: "mock-sess-1" },
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed_warning",
              resetsAt: futureSec,
              rateLimitType: "five_hour",
              utilization: 0.99,
            },
          },
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed_warning",
              resetsAt: futureSec,
              rateLimitType: "five_hour",
              utilization: 0.99,
            },
          },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "MOCK_OK" },
            },
          },
          {
            type: "result",
            is_error: false,
            total_cost_usd: 0.001,
            usage: { input_tokens: 11, output_tokens: 3 },
          },
        ];
        return {
          stream: (async function* () {
            for (const ev of events) yield ev;
          })(),
          interrupt: async () => {},
          close: () => {},
          getPid: () => null,
        };
      });

      const okRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": "smoke-mock-ok",
        },
        body: JSON.stringify({
          model: "sonnet",
          stream: false,
          tools: [
            {
              type: "function",
              function: {
                name: "todowrite",
                description: "Write the todo list",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "plan something" }],
        }),
      });
      assert.equal(okRes.status, 200);
      const okJson = (await okRes.json()) as {
        choices?: Array<{ message?: Record<string, unknown> }>;
        usage?: { prompt_tokens?: number };
      };
      const okMsg = okJson.choices?.[0]?.message ?? {};
      assert.match(String(okMsg.content ?? ""), /MOCK_OK/);
      // rate-limit note surfaced once (two identical events → one note)
      const okReasoning = String(okMsg.reasoning_content ?? "");
      assert.equal(okReasoning.match(/\[rate-limit\]/g)?.length ?? 0, 1);
      assert.match(okReasoning, /99%/);
      assert.equal(okJson.usage?.prompt_tokens, 11);

      // Query starter received the todo alias + plan-persistence append
      assert.ok(seenParams, "query starter params captured");
      const aliases = (seenParams as { toolAliases?: Record<string, string> })
        .toolAliases;
      assert.equal(aliases?.TodoWrite, "mcp__opencode__todowrite");
      assert.equal(aliases?.todowrite, "mcp__opencode__todowrite");
      const sysPrompt = seenParams.systemPrompt as { append?: string };
      assert.match(sysPrompt.append ?? "", /mcp__opencode__todowrite/);
      assert.match(sysPrompt.append ?? "", /[Bb]atch independent tool calls/);

      // Proxy + mock SDK: hard limit error — single error note, usage kept,
      // store flips to limited, next request fails fast with 429.
      setClaudeQueryStarter(async () => {
        const limitText =
          "You've hit your session limit · resets 1:10am (Europe/Kyiv)";
        return {
          stream: (async function* () {
            yield { type: "system", subtype: "init", session_id: "mock-sess-2" };
            yield {
              type: "result",
              is_error: true,
              result: limitText,
              total_cost_usd: 0.0005,
              usage: { input_tokens: 7, output_tokens: 1 },
            };
            throw new Error(
              `Claude Code returned an error result: ${limitText}`,
            );
          })(),
          interrupt: async () => {},
          close: () => {},
          getPid: () => null,
        };
      });

      const errRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-err",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      assert.equal(errRes.status, 200);
      const errBody = await errRes.text();
      // error streamed exactly once despite result event + iterator throw
      assert.equal(errBody.match(/\[claude-code error\]/g)?.length ?? 0, 1);
      assert.match(errBody, /session limit/);
      assert.match(errBody, /limit resets in/);
      assert.match(errBody, /"prompt_tokens":7/); // usage forwarded on error
      assert.match(errBody, /\[DONE\]/);

      const snap = getRateLimitSnapshot();
      assert.equal(snap.limited, true);
      assert.ok(
        snap.resetInSeconds !== undefined && snap.resetInSeconds > 0,
        "expected a countdown while limited",
      );

      const gate = rateLimitGate();
      assert.equal(gate.blocked, true);
      if (gate.blocked) assert.ok(gate.retryAfterSeconds > 0);

      // Fast-fail: new main turns get HTTP 429 + Retry-After + reset headers
      const blockedRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-blocked",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: false,
            messages: [{ role: "user", content: "hi again" }],
          }),
        },
      );
      assert.equal(blockedRes.status, 429);
      assert.ok(blockedRes.headers.get("retry-after"));
      const blockedJson = (await blockedRes.json()) as {
        error?: { type?: string; message?: string; retry_after?: number };
      };
      assert.equal(blockedJson.error?.type, "rate_limit_error");
      assert.match(blockedJson.error?.message ?? "", /limit resets in/);
      assert.ok((blockedJson.error?.retry_after ?? 0) > 0);

      // Meta (title) path is NOT gated — sessions still get named while limited
      const metaRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "You are a title generator. Generate a brief title. Output only the title.",
              },
              { role: "user", content: "Explain quicksort" },
            ],
          }),
        },
      );
      assert.equal(metaRes.status, 200);

      // Counter endpoint reports the active limit with countdown
      const limitedRes = await fetch(`http://127.0.0.1:${port}/v1/rate-limit`);
      const limitedBody = (await limitedRes.json()) as {
        limited?: boolean;
        resetInSeconds?: number;
        message?: string;
      };
      assert.equal(limitedBody.limited, true);
      assert.ok((limitedBody.resetInSeconds ?? 0) > 0);
      assert.match(limitedBody.message ?? "", /session limit/);

      // Gate env kill-switch
      process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL = "0";
      assert.equal(rateLimitGate().blocked, false);
      delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL;
      assert.equal(rateLimitGate().blocked, true);

      // Expired hard block self-heals on read
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        storeFile,
        JSON.stringify({
          limited: true,
          limitedUntil: Date.now() - 1000,
          updatedAt: Date.now() - 60_000,
        }),
      );
      assert.equal(getRateLimitSnapshot().limited, false);
      rmSync(storeFile, { force: true });
    } finally {
      setClaudeQueryStarter(null);
      if (prevStoreEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = prevStoreEnv;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

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
