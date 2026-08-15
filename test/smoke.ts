/**
 * Smoke tests for opencode-claude — no live Claude CLI required.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

async function main() {
  // Isolate the data dir for the run. Without this the suite reads whatever
  // accounts the operator has configured (so "nothing configured" is not true),
  // writes fixture sessions into their real store, and the credential-sync
  // guards target their real $XDG_DATA_HOME/opencode/auth.json.
  const { mkdtempSync: mkTmp, rmSync: rmTmp } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const { join: joinTmp } = await import("node:path");
  const suiteDataDir = mkTmp(joinTmp(osTmpdir(), "oc-claude-suite-"));
  const prevSuiteXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = suiteDataDir;
  const restoreSuiteEnv = () => {
    if (prevSuiteXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevSuiteXdg;
    rmTmp(suiteDataDir, { recursive: true, force: true });
  };

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
  const { applyClaudeRequestContextHeaders, ClaudeCodePlugin } = await import(
    "../src/index.ts"
  );
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
  // Key must be stable as the conversation grows — a per-turn changing key
  // defeats Claude session resume when the session header is absent.
  const keyLater = conversationKeyFromMessages([
    { role: "user", content: "hello world" },
    { role: "assistant", content: "hi!" },
    { role: "user", content: "follow up" },
  ]);
  assert.equal(keyLater, key);

  // ---- Conversation-history transfer (context when resume is impossible) ----
  {
    const {
      buildConversationTranscript,
      priorMessagesOf,
      withConversationContext,
    } = await import("../src/prompt.ts");

    const history = [
      { role: "system", content: "You are a huge internal system prompt." },
      { role: "user", content: "remember the codename AXIOM-9042" },
      { role: "assistant", content: "Got it — codename AXIOM-9042 noted." },
      { role: "user", content: "what is the codename?" },
    ];

    // priorMessagesOf excludes the latest user turn
    const prior = priorMessagesOf(history);
    assert.equal(prior.length, 3);
    assert.equal(prior[prior.length - 1]?.role, "assistant");

    const transcript = buildConversationTranscript(prior);
    assert.match(transcript, /AXIOM-9042/);
    assert.match(transcript, /^User:/m);
    assert.match(transcript, /^Assistant:/m);
    // system prompt never leaks into the transfer
    assert.doesNotMatch(transcript, /huge internal system prompt/);

    // tool calls/results are condensed but present
    const withTools = buildConversationTranscript([
      { role: "user", content: "run tests" },
      {
        role: "assistant",
        content: "running",
        tool_calls: [
          { id: "c1", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "x".repeat(5000) },
    ]);
    assert.match(withTools, /\[called tool: bash\]/);
    assert.match(withTools, /Tool result/);
    assert.match(withTools, /chars omitted/);

    // budget keeps the NEWEST messages, drops oldest first
    const tight = buildConversationTranscript(
      [
        { role: "user", content: "OLD-MESSAGE-MARKER " + "y".repeat(200) },
        { role: "user", content: "NEW-MESSAGE-MARKER" },
      ],
      100,
    );
    assert.match(tight, /NEW-MESSAGE-MARKER/);
    assert.doesNotMatch(tight, /OLD-MESSAGE-MARKER/);
    assert.match(tight, /earlier message\(s\) omitted/);

    // zero budget disables transfer entirely
    assert.equal(buildConversationTranscript(prior, 0), "");

    // attachments in history leave an explicit note
    const withImage = buildConversationTranscript([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
        ],
      },
    ]);
    assert.match(withImage, /attachment\(s\) omitted/);

    // withConversationContext: string prompt gets the history prefix
    const wrapped = withConversationContext("what is the codename?", transcript);
    assert.equal(typeof wrapped, "string");
    assert.match(wrapped as string, /<conversation_history>/);
    assert.match(wrapped as string, /AXIOM-9042/);
    assert.match(wrapped as string, /Latest user message:\nwhat is the codename\?/);

    // empty transcript leaves the prompt untouched
    assert.equal(withConversationContext("hi", ""), "hi");

    // multimodal prompt gets a leading text block, attachments preserved
    const multiWrapped = withConversationContext(
      {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "see this" },
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png",
                data: "AA",
              },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      transcript,
    );
    assert.equal(typeof multiWrapped, "object");
    const mwContent = (multiWrapped as { message: { content: unknown[] } })
      .message.content;
    assert.equal((mwContent[0] as { type: string }).type, "text");
    assert.match(
      (mwContent[0] as { text: string }).text,
      /<conversation_history>/,
    );
    assert.equal((mwContent[2] as { type: string }).type, "image");
  }

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
    // Mirror log.ts's own resolution — hardcoding ~/.local/share made this
    // test read (and unlink) the operator's real debug.log.
    const logPath = join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "opencode-claude",
      "debug.log",
    );
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
  const requestHeaders: Record<string, string> = {};
  applyClaudeRequestContextHeaders(
    requestHeaders,
    "/data/projects/infra",
    "ses_test",
  );
  assert.equal(
    requestHeaders["x-opencode-claude-directory"],
    "/data/projects/infra",
  );
  assert.equal(requestHeaders["x-opencode-claude-session"], "ses_test");
  assert.equal(PROVIDER_ID, "claude-code");
  assert.ok(RefreshTokenInvalidError);

  // Proxy health (without Agent SDK turn)
  await stopProxy();
  const port = await startProxy(async () => null);
  // Deterministic pre-flight: pretend CLI credentials exist (the smoke host
  // may or may not have real ones). The dedicated pre-flight test below
  // overrides this with `false`.
  const { setClaudeCredentialProbe } = await import("../src/proxy.ts");
  setClaudeCredentialProbe(() => true);
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

      // Regression: an "allowed" event that omits utilization (the SDK does
      // this on plenty of events) must NOT resurrect the previous window's
      // stale 99% — the store drops utilization and no warning note fires.
      const staleResetSec = futureSec + 3600; // new window
      const staleState = recordRateLimitInfo({
        status: "allowed",
        resetsAt: staleResetSec,
        rateLimitType: "five_hour",
        // utilization deliberately absent
      });
      assert.equal(
        staleState!.utilization,
        undefined,
        "stale utilization must be cleared by an allowed event",
      );
      __resetRateLimitNoteDedupe();
      assert.equal(
        maybeRateLimitNote(staleState, {
          status: "allowed",
          resetsAt: staleResetSec,
          rateLimitType: "five_hour",
        }),
        null,
        "no warning note for an allowed event without fresh utilization",
      );
      // Fresh utilization the event itself reports still surfaces.
      const freshWarn = maybeRateLimitNote(staleState, {
        status: "allowed_warning",
        resetsAt: staleResetSec,
        rateLimitType: "five_hour",
        utilization: 0.95,
      });
      assert.ok(freshWarn && /95%/.test(freshWarn), "fresh warning noted");
      __resetRateLimitNoteDedupe();

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
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              resetsAt: futureSec,
              rateLimitType: "five_hour",
              // utilization deliberately absent — stale 0.99 must NOT
              // produce a second bogus "99% of window used" note
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
          "x-opencode-claude-directory": "/data/projects/infra",
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
      // rate-limit note surfaced once (two identical warning events → one
      // note; the trailing "allowed" event without utilization must NOT add
      // a stale-utilization note — regression for the 99%-after-reset bug)
      const okReasoning = String(okMsg.reasoning_content ?? "");
      assert.equal(okReasoning.match(/\[rate-limit\]/g)?.length ?? 0, 1);
      assert.match(okReasoning, /99%/);
      assert.equal(okJson.usage?.prompt_tokens, 11);

      // Query starter received the todo alias + plan-persistence append
      assert.ok(seenParams, "query starter params captured");
      assert.equal(seenParams.cwd, "/data/projects/infra");
      const aliases = (seenParams as { toolAliases?: Record<string, string> })
        .toolAliases;
      assert.equal(aliases?.TodoWrite, "mcp__opencode__todowrite");
      assert.equal(aliases?.todowrite, "mcp__opencode__todowrite");
      const sysPrompt = seenParams.systemPrompt as { append?: string };
      assert.match(sysPrompt.append ?? "", /mcp__opencode__todowrite/);
      assert.match(sysPrompt.append ?? "", /[Bb]atch independent tool calls/);

      // Proxy + mock SDK: hard limit error BEFORE any content — the proxy
      // must answer with a truthful HTTP 429 (not a fake-200 error stream),
      // flip the store to limited, and fail fast on the next request.
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
      assert.equal(errRes.status, 429, "hard limit must fail fast with 429");
      assert.ok(errRes.headers.get("retry-after"), "429 carries Retry-After");
      const errJson = (await errRes.json()) as {
        error?: { type?: string; message?: string; code?: string };
      };
      assert.equal(errJson.error?.type, "rate_limit_error");
      assert.equal(errJson.error?.code, "claude_session_limit");
      assert.match(errJson.error?.message ?? "", /session limit/);
      assert.match(errJson.error?.message ?? "", /limit resets in/);

      // Same death on the non-streaming path → same 429, not a fake-200.
      const errRes2 = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-err2",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: false,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      assert.equal(errRes2.status, 429, "non-stream hard limit also 429");

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

  // ---- History injection through the proxy (mocked Agent SDK) ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const {
      clearForeignSessionId,
      findClaudeSessionFile,
      getForeignSessionId,
      setForeignSessionId,
    } = await import("../src/session-store.ts");
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const mockTurn = (
      seen: { params: Record<string, unknown> | null },
      sessionId: string | null,
    ) => {
      setClaudeQueryStarter(async (params) => {
        seen.params = params as unknown as Record<string, unknown>;
        return {
          stream: (async function* () {
            if (sessionId) {
              yield { type: "system", subtype: "init", session_id: sessionId };
            }
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "MOCK_OK" },
              },
            };
            yield { type: "result", is_error: false, usage: {} };
          })(),
          interrupt: async () => {},
          close: () => {},
          getPid: () => null,
        };
      });
    };

    const postChat = (sessionHeader: string, messages: unknown[]) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({ model: "sonnet", stream: false, messages }),
      });

    try {
      const historyMessages = [
        { role: "system", content: "internal system prompt" },
        { role: "user", content: "remember the codename AXIOM-9042" },
        { role: "assistant", content: "Codename AXIOM-9042 noted." },
        { role: "user", content: "what is the codename?" },
      ];

      // 1. No stored binding → history injected, no resume attempted
      clearForeignSessionId("smoke-history-fresh");
      const seen1 = { params: null as Record<string, unknown> | null };
      mockTurn(seen1, "mock-sess-fresh");
      const res1 = await postChat("smoke-history-fresh", historyMessages);
      assert.equal(res1.status, 200);
      const res1Json = (await res1.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      assert.match(String(res1Json.choices?.[0]?.message?.content ?? ""), /MOCK_OK/);
      assert.ok(seen1.params, "query starter called");
      assert.equal(seen1.params!.resume, undefined);
      const promptText = String(seen1.params!.prompt ?? "");
      assert.match(promptText, /<conversation_history>/);
      assert.match(promptText, /AXIOM-9042/);
      assert.match(promptText, /Latest user message:\nwhat is the codename\?/);
      assert.doesNotMatch(promptText, /internal system prompt/);
      // turn stored the new foreign session for follow-up resume
      assert.equal(
        getForeignSessionId("smoke-history-fresh"),
        "mock-sess-fresh",
      );

      // 2. Stored binding whose transcript file EXISTS → resume, no injection
      const fakeProjectsDir = joinPath(
        homedir(),
        ".claude",
        "projects",
        "opencode-claude-smoke",
      );
      mkdirSync(fakeProjectsDir, { recursive: true });
      writeFileSync(joinPath(fakeProjectsDir, "mock-sess-live.jsonl"), "{}\n");
      assert.ok(findClaudeSessionFile("mock-sess-live"));
      setForeignSessionId("smoke-history-resume", "mock-sess-live");
      const seen2 = { params: null as Record<string, unknown> | null };
      mockTurn(seen2, "mock-sess-live");
      const res2 = await postChat("smoke-history-resume", historyMessages);
      assert.equal(res2.status, 200);
      await res2.text();
      assert.equal(seen2.params!.resume, "mock-sess-live");
      assert.doesNotMatch(
        String(seen2.params!.prompt ?? ""),
        /<conversation_history>/,
      );
      rmSync(fakeProjectsDir, { recursive: true, force: true });

      // 3. Stored binding with a MISSING transcript file → binding dropped,
      //    history injected instead of a doomed resume
      setForeignSessionId("smoke-history-dead", "mock-sess-gone");
      const seen3 = { params: null as Record<string, unknown> | null };
      mockTurn(seen3, null); // no init event → store not rewritten
      const res3 = await postChat("smoke-history-dead", historyMessages);
      assert.equal(res3.status, 200);
      await res3.text();
      assert.equal(seen3.params!.resume, undefined);
      assert.match(String(seen3.params!.prompt ?? ""), /<conversation_history>/);
      assert.equal(getForeignSessionId("smoke-history-dead"), undefined);

      clearForeignSessionId("smoke-history-fresh");
      clearForeignSessionId("smoke-history-resume");
      clearForeignSessionId("smoke-history-dead");
    } finally {
      setClaudeQueryStarter(null);
    }
  }

  // ---- Fail-fast taxonomy: dead turns get truthful HTTP statuses ----
  {
    const { setClaudeQueryStarter, setClaudeCredentialProbe } = await import(
      "../src/proxy.ts"
    );
    const { classifyClaudeFailure } = await import("../src/failure.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    // Isolate the rate-limit store so this section starts clean.
    const tmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-ff-"));
    const prevStoreEnv = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = joinPath(
      tmpDir,
      "rate-limit.json",
    );

    const postTurn = (sessionHeader: string, stream: boolean) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({
          model: "sonnet",
          stream,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const mockDeath = (text: string) => {
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "ff-sess" };
          yield { type: "result", is_error: true, result: text };
          throw new Error(`Claude Code returned an error result: ${text}`);
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
    };

    try {
      // Unit: classifier
      assert.equal(
        classifyClaudeFailure(
          "token refresh rejected (HTTP 400): invalid_grant",
        ),
        "auth",
      );
      assert.equal(
        classifyClaudeFailure("Invalid API key · Please run /login"),
        "auth",
      );
      assert.equal(
        classifyClaudeFailure("You've hit your session limit · resets 1:10am"),
        "rate_limit",
      );
      assert.equal(classifyClaudeFailure("boom"), "unknown");

      // Auth death before content → 401 (non-retryable), both modes
      mockDeath("Invalid API key · Please run /login");
      const authStream = await postTurn("ff-auth-stream", true);
      assert.equal(authStream.status, 401);
      const authStreamJson = (await authStream.json()) as {
        error?: { type?: string; code?: string; message?: string };
      };
      assert.equal(authStreamJson.error?.type, "authentication_error");
      assert.equal(authStreamJson.error?.code, "claude_auth");
      assert.match(authStreamJson.error?.message ?? "", /Re-authenticate/);

      const authBuffered = await postTurn("ff-auth-buffered", false);
      assert.equal(authBuffered.status, 401);
      assert.equal(
        ((await authBuffered.json()) as { error?: { type?: string } }).error
          ?.type,
        "authentication_error",
      );

      // Unknown death before content → 500
      mockDeath("Claude Code process exploded unexpectedly");
      const boomRes = await postTurn("ff-boom", true);
      assert.equal(boomRes.status, 500);
      assert.equal(
        ((await boomRes.json()) as { error?: { type?: string } }).error?.type,
        "server_error",
      );

      // Error AFTER content → still a 200 stream with the inline note once
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "ff-late" };
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "partial answer" },
            },
          };
          yield {
            type: "result",
            is_error: true,
            result: "Claude Code process exploded unexpectedly",
          };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
      const lateRes = await postTurn("ff-late-content", true);
      assert.equal(lateRes.status, 200);
      const lateBody = await lateRes.text();
      assert.match(lateBody, /partial answer/);
      assert.equal(
        lateBody.match(/\[claude-code error\]/g)?.length ?? 0,
        1,
        "mid-stream error note appears exactly once",
      );
      assert.match(lateBody, /\[DONE\]/);

      // Empty-but-successful turn → legit 200 with empty content
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "ff-empty" };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
      const emptyRes = await postTurn("ff-empty-ok", true);
      assert.equal(emptyRes.status, 200);
      assert.match(await emptyRes.text(), /\[DONE\]/);

      // Pre-flight: no token provider result AND no CLI credentials → 401
      // without ever starting a turn.
      let starterCalled = false;
      setClaudeQueryStarter(async () => {
        starterCalled = true;
        throw new Error("must not be called");
      });
      setClaudeCredentialProbe(() => false);
      const noCredRes = await postTurn("ff-no-creds", true);
      assert.equal(noCredRes.status, 401);
      const noCredJson = (await noCredRes.json()) as {
        error?: { code?: string };
      };
      assert.equal(noCredJson.error?.code, "claude_auth_required");
      assert.equal(starterCalled, false, "no doomed turn was spawned");
      setClaudeCredentialProbe(() => true);
    } finally {
      setClaudeQueryStarter(null);
      setClaudeCredentialProbe(null);
      if (prevStoreEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = prevStoreEnv;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---- Multi-account: registry, model namespacing, session binding ----
  {
    const {
      configureAccounts,
      resetAccounts,
      getAccounts,
      getDefaultAccount,
      isMultiAccount,
      resolveAccount,
      accountConfigDir,
      applyAccountEnv,
    } = await import("../src/accounts.ts");
    const {
      getClaudeModels: accountModels,
      parseAccountModelId,
      composeAccountModelId,
      resolveClaudeModelId: resolveWithAccount,
      accountIdFromModelId,
    } = await import("../src/models.ts");
    const { resolveClaudeModelSelection: selectWithAccount } = await import(
      "../src/model-selection.ts"
    );
    const { withAccountTitleTag } = await import("../src/proxy.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const prevAccountsEnv = process.env.OPENCODE_CLAUDE_ACCOUNTS;
    delete process.env.OPENCODE_CLAUDE_ACCOUNTS;

    // No accounts configured → single implicit account, catalog unchanged.
    resetAccounts();
    configureAccounts(undefined);
    assert.equal(isMultiAccount(), false);
    assert.equal(getAccounts().length, 1);
    assert.deepEqual(
      accountModels().map((m) => m.id),
      CLAUDE_CODE_MODELS.map((m) => m.id),
      "single-account catalog is byte-identical to the plain one",
    );
    assert.equal(withAccountTitleTag("Fix the proxy", getDefaultAccount()),
      "Fix the proxy", "no title tag without multiple accounts");

    // Two accounts.
    configureAccounts([
      { id: "work", label: "Work", configDir: "/tmp/oc-claude-work", default: true },
      { id: "personal", label: "Personal", configDir: "/tmp/oc-claude-personal" },
    ]);
    assert.equal(isMultiAccount(), true);
    assert.equal(getDefaultAccount().id, "work");
    assert.equal(resolveAccount("personal").label, "Personal");
    assert.equal(resolveAccount("nope").id, "work", "unknown id falls back to default");
    assert.equal(accountConfigDir(resolveAccount("personal")), "/tmp/oc-claude-personal");
    assert.equal(
      applyAccountEnv(resolveAccount("personal"), { PATH: "/usr/bin" })
        .CLAUDE_CONFIG_DIR,
      "/tmp/oc-claude-personal",
    );

    // Default account keeps bare ids; others are suffixed. Both carry the label.
    assert.equal(composeAccountModelId("opus", resolveAccount("work")), "opus");
    assert.equal(
      composeAccountModelId("opus", resolveAccount("personal")),
      "opus@personal",
    );
    const ids = accountModels().map((m) => m.id);
    assert.ok(ids.includes("opus"), "default account keeps the bare id");
    assert.ok(ids.includes("opus@personal"));
    assert.ok(
      accountModels()
        .find((m) => m.id === "opus@personal")
        ?.name.includes("Personal"),
      "the account label rides the model name into the picker",
    );

    assert.deepEqual(parseAccountModelId("opus@personal"), {
      baseModelId: "opus",
      accountId: "personal",
    });
    assert.deepEqual(parseAccountModelId("opus"), {
      baseModelId: "opus",
      accountId: null,
    });
    assert.equal(resolveWithAccount("haiku@personal"), "claude-haiku-4-5",
      "the account suffix never reaches Anthropic");
    assert.equal(accountIdFromModelId("opus"), "work", "bare ids mean the default");
    assert.equal(accountIdFromModelId("opus@personal"), "personal");

    const picked = selectWithAccount("opus@personal", "high");
    assert.equal(picked.modelId, "opus");
    assert.equal(picked.account, "personal");
    assert.equal(picked.effort, "high");

    // Titles carry the account, idempotently, and follow a session that moves.
    assert.equal(
      withAccountTitleTag("Fix the proxy", resolveAccount("personal")),
      "[personal] Fix the proxy",
    );
    assert.equal(
      withAccountTitleTag("[personal] Fix the proxy", resolveAccount("personal")),
      "[personal] Fix the proxy",
      "re-titling does not stack tags",
    );
    assert.equal(
      withAccountTitleTag("[personal] Fix the proxy", resolveAccount("work")),
      "[work] Fix the proxy",
      "a moved session is re-tagged, not double-tagged",
    );

    // Session bindings survive a dead transcript and block cross-account resume.
    const sessDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-sess-"));
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = sessDir;
    try {
      const {
        bindConversationAccount,
        getBoundAccountId,
        setForeignSessionId,
        getForeignSessionId,
        clearForeignSessionId,
        getSessionBinding,
        listSessionBindings,
      } = await import("../src/session-store.ts");

      bindConversationAccount("ses_a", "work", "Work");
      assert.equal(getBoundAccountId("ses_a"), "work");
      setForeignSessionId("ses_a", "uuid-work-1", { modelId: "opus" });
      assert.equal(getSessionBinding("ses_a")?.accountId, "work",
        "the account survives a later foreign-session write");

      // Moving the session to another account drops the resume target: that
      // transcript lives in the other account's Claude home.
      bindConversationAccount("ses_a", "personal", "Personal");
      assert.equal(
        getForeignSessionId("ses_a"),
        undefined,
        "moving account drops the other home's resume target",
      );
      assert.equal(getBoundAccountId("ses_a"), "personal");

      // A dead transcript must not erase which subscription owns the session.
      setForeignSessionId("ses_a", "uuid-personal-1");
      clearForeignSessionId("ses_a");
      assert.equal(getBoundAccountId("ses_a"), "personal",
        "clearing a dead session keeps the account binding");

      bindConversationAccount("ses_b", "work", "Work");
      const bindings = listSessionBindings();
      assert.equal(bindings.length, 2);
      assert.ok(bindings.every((b) => typeof b.accountId === "string"));
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      rmSync(sessDir, { recursive: true, force: true });
    }

    // Rate limits are per subscription: one exhausted account must not gate
    // turns running on another.
    const rlDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-rl-acct-"));
    const prevRlStore = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = joinPath(rlDir, "rl.json");
    try {
      const { recordRateLimitErrorText, rateLimitGate, getRateLimitSnapshot } =
        await import("../src/rate-limit.ts");
      recordRateLimitErrorText(
        "You've hit your session limit · resets 1:10am (Europe/Kyiv)",
        "work",
      );
      assert.equal(rateLimitGate(Date.now(), "work").blocked, true);
      assert.equal(
        rateLimitGate(Date.now(), "personal").blocked,
        false,
        "an exhausted account does not block the other one",
      );
      assert.equal(getRateLimitSnapshot(Date.now(), "personal").limited, false);
    } finally {
      if (prevRlStore === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = prevRlStore;
      }
      rmSync(rlDir, { recursive: true, force: true });
    }

    // A scoped account reads ONLY its own Claude home — never the ambient one.
    {
      const scoped = listClaudeCredentialsCandidates("/home/tester", {}, {
        scopedConfigDir: "/home/tester/.claude-work",
      });
      assert.deepEqual(scoped, [
        "/home/tester/.claude-work/.credentials.json",
        "/home/tester/.claude-work/credentials.json",
      ]);
      assert.ok(
        !scoped.some((p) => p === "/home/tester/.claude/.credentials.json"),
        "no fallback to the default account's credentials",
      );
    }

    // Back to single-account for the rest of the suite.
    resetAccounts();
    configureAccounts(undefined);
    if (prevAccountsEnv === undefined) {
      delete process.env.OPENCODE_CLAUDE_ACCOUNTS;
    } else {
      process.env.OPENCODE_CLAUDE_ACCOUNTS = prevAccountsEnv;
    }
  }

  // ---- CLI credential sync poisoning guards ----
  {
    const { syncClaudeCliCredentialsToOpenCode } = await import(
      "../src/auth-login.ts"
    );
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const tmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-sync-"));
    const fakeHome = joinPath(tmpDir, "home");
    mkdirSync(joinPath(fakeHome, ".claude"), { recursive: true });
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = joinPath(tmpDir, "data");
    const authFile = joinPath(tmpDir, "data", "opencode", "auth.json");
    const writeCliCreds = (accessToken: string, expiresAt: number) =>
      writeFileSync(
        joinPath(fakeHome, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken,
            refreshToken: "cli-refresh",
            expiresAt,
            scopes: ["user:inference"],
          },
        }),
      );

    try {
      // 1. Expired CLI token must NOT be synced (would shadow healthy creds
      //    and block the CLI's own auto-refresh via env override).
      writeCliCreds("dead-access", Date.now() - 60_000);
      const syncedDead = syncClaudeCliCredentialsToOpenCode({
        homeDir: fakeHome,
        env: {},
      });
      assert.equal(syncedDead, null, "expired CLI token is not synced");

      // 2. Fresh-but-older CLI token must not clobber a newer auth entry.
      writeCliCreds("cli-access", Date.now() + 3600_000);
      mkdirSync(joinPath(tmpDir, "data", "opencode"), { recursive: true });
      writeFileSync(
        authFile,
        JSON.stringify({
          "claude-code": {
            type: "oauth",
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 8 * 3600_000,
          },
        }),
      );
      const syncedOlder = syncClaudeCliCredentialsToOpenCode({
        homeDir: fakeHome,
        env: {},
      });
      assert.equal(syncedOlder, null, "older CLI creds do not clobber newer");
      const kept = JSON.parse(readFileSync(authFile, "utf8")) as {
        "claude-code": { access: string };
      };
      assert.equal(kept["claude-code"].access, "oauth-access");

      // 3. Newer CLI token wins and is written through. The refresh token is
      //    TAGGED as CLI-owned so the plugin never rotates it (rotation is
      //    the CLI's job — dual ownership gets grants revoked).
      writeCliCreds("cli-access-new", Date.now() + 9 * 3600_000);
      const syncedNewer = syncClaudeCliCredentialsToOpenCode({
        homeDir: fakeHome,
        env: {},
      });
      assert.equal(syncedNewer?.access, "cli-access-new");
      const rewritten = JSON.parse(readFileSync(authFile, "utf8")) as {
        "claude-code": { access: string; refresh: string };
      };
      assert.equal(rewritten["claude-code"].access, "cli-access-new");
      assert.equal(rewritten["claude-code"].refresh, "cli-shared-cli-refresh");

      const { isCliOwnedRefreshToken, readStoredClaudeOAuth } = await import(
        "../src/auth-login.ts"
      );
      assert.equal(isCliOwnedRefreshToken("cli-shared-cli-refresh"), true);
      assert.equal(isCliOwnedRefreshToken("cli-sync-credentials-file"), true);
      assert.equal(isCliOwnedRefreshToken("sk-ant-ort01-real"), false);

      // On-disk OAuth entry is readable regardless of the host's auth store
      const stored = readStoredClaudeOAuth();
      assert.equal(stored?.access, "cli-access-new");
      assert.equal(stored?.refresh, "cli-shared-cli-refresh");
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = prevXdg;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---- Meta fast path is wire-identical to Claude Code CLI ----
  {
    const { completeMetaRequest } = await import("../src/meta-completion.ts");
    const realFetch = globalThis.fetch;
    let captured: { url: unknown; init?: RequestInit } | null = null;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "Mock Title" }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await completeMetaRequest({
        body: {
          messages: [
            { role: "system", content: "You are a title generator." },
            { role: "user", content: "hello there" },
          ],
        },
        kind: "title",
        accessToken: "oauth-token-xyz",
      });
      assert.equal(result.text, "Mock Title");
      assert.ok(captured, "meta request captured");
      const headers = captured!.init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer oauth-token-xyz");
      assert.equal(headers["anthropic-version"], "2023-06-01");
      assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
      assert.equal(headers["x-app"], "cli");
      assert.equal(
        headers["anthropic-dangerous-direct-browser-access"],
        "true",
      );
      assert.match(headers["user-agent"] ?? "", /^claude-cli\/\d+\.\d+\.\d+ /);
      const body = JSON.parse(String(captured!.init?.body)) as {
        system?: Array<{ type: string; text: string }>;
      };
      assert.ok(Array.isArray(body.system), "system sent as block array");
      assert.equal(
        body.system![0]!.text,
        "You are Claude Code, Anthropic's official CLI.",
        "CLI preamble is the first system block",
      );
      assert.match(body.system![1]?.text ?? "", /title generator/);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  await stopProxy();
  setClaudeCredentialProbe(null);

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

  restoreSuiteEnv();
  console.log("ok — opencode-claude smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
