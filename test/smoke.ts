/**
 * Smoke tests for opencode-claude — no live Claude CLI required.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync as rmTree } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as joinPaths } from "node:path";

/**
 * Isolate the whole run from the live host BEFORE any module reads its
 * stores: every durable file (accounts, sessions, rate-limit, quota,
 * identity, usage, debug log) lands in a throwaway XDG_DATA_HOME, and the
 * proxy never binds/reuses an operator-pinned production port. A smoke run
 * must not read the operator's real state — and must never gate or pollute
 * a production proxy that is serving live sessions on this machine.
 */
const SMOKE_XDG = mkdtempSync(joinPaths(osTmpdir(), "oc-claude-smoke-xdg-"));
process.env.XDG_DATA_HOME = SMOKE_XDG;
for (const key of [
  "OPENCODE_CLAUDE_PROXY_PORT",
  "OPENCODE_CLAUDE_ACCOUNTS",
  "OPENCODE_CLAUDE_RATE_LIMIT_STORE",
  "OPENCODE_CLAUDE_QUOTA_STORE",
  "OPENCODE_CLAUDE_IDENTITY_STORE",
  "OPENCODE_CLAUDE_USAGE_STORE",
  "OPENCODE_CLAUDE_MODEL_QUOTA",
  "OPENCODE_CLAUDE_PANEL",
  "OPENCODE_CLAUDE_PANEL_HOST",
  "OPENCODE_CLAUDE_TOOLS",
  "OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL",
]) {
  delete process.env[key];
}

async function main() {
  const { buildClaudeCodeChildEnv } = await import("../src/auth-env.ts");
  const {
    interpretClaudeAuthStatus,
  } = await import("../src/detect.ts");
  const {
    CLAUDE_CODE_MODELS,
    buildEffortVariants,
    getClaudeModels,
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
  const {
    applyClaudeRequestContextHeaders,
    buildAuthMethods,
    manualInstallResponse,
    ClaudeCodePlugin,
  } = await import("../src/index.ts");
  const {
    startProxy,
    stopProxy,
    getProxyPort,
    getClaudeProxyBaseUrl,
    PROXY_IDLE_TIMEOUT_SECONDS,
  } = await import("../src/proxy.ts");

  // Auth env stripping: API-billing keys are removed so subscription auth
  // wins, but an operator-provided CLAUDE_CODE_OAUTH_TOKEN (CI / headless)
  // passes through untouched — the plugin never sets or rotates it.
  const cleaned = buildClaudeCodeChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-secret",
    ANTHROPIC_AUTH_TOKEN: "tok",
    CLAUDE_CODE_OAUTH_TOKEN: "operator-token",
    KEEP: "1",
  });
  assert.equal(cleaned.ANTHROPIC_API_KEY, undefined);
  assert.equal(cleaned.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(cleaned.CLAUDE_CODE_OAUTH_TOKEN, "operator-token");
  assert.equal(cleaned.KEEP, "1");
  assert.equal(cleaned.PATH, "/usr/bin");

  // The UI login relays the official CLI flow: its authorize URL comes back to
  // the host, and the code the user pastes goes into the CLI's stdin.
  {
    const {
      getClaudeCliLoginStatus,
      resetClaudeCliLoginForTests,
      startClaudeCliLogin,
      submitClaudeCliLoginCode,
    } = await import("../src/cli-login.ts");

    const createFakeCli = () => {
      const makeStream = () =>
        Object.assign(new EventEmitter(), { setEncoding() {} });
      const writes: string[] = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 1234,
        exitCode: null as number | null,
        killed: false,
        stdout: makeStream(),
        stderr: makeStream(),
        stdin: Object.assign(new EventEmitter(), {
          writable: true,
          write(chunk: string) {
            writes.push(chunk);
            return true;
          },
        }),
        kill() {
          this.killed = true;
          return true;
        },
      });
      return { child, writes };
    };
    const authorizeUrl =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
    const cliBanner = (url: string) =>
      `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    // Accepted code: URL relayed out, code relayed in, exit 0 is the success.
    {
      const { child, writes } = createFakeCli();
      let invocation: {
        executable: string;
        args: string[];
        options: Record<string, unknown>;
      } | null = null;
      const pending = startClaudeCliLogin({
        binaryPath: "/usr/local/bin/claude",
        env: {
          PATH: "/usr/local/bin",
          ANTHROPIC_API_KEY: "must-not-leak",
          CLAUDE_CODE_OAUTH_TOKEN: "operator-passthrough",
        },
        spawnLogin(executable, args, options) {
          invocation = {
            executable,
            args,
            options: options as Record<string, unknown>,
          };
          return child as any;
        },
      });
      await tick();
      child.stdout.emit("data", cliBanner(authorizeUrl));
      const started = await pending;

      assert.deepEqual(started, { state: "awaiting-code", url: authorizeUrl });
      assert.equal(invocation!.executable, "/usr/local/bin/claude");
      assert.deepEqual(invocation!.args, ["auth", "login", "--claudeai"]);
      assert.deepEqual(invocation!.options.stdio, ["pipe", "pipe", "pipe"]);
      // API-billing keys are stripped from the login child; an operator-set
      // OAuth token is forwarded unchanged (the plugin never fabricates one).
      assert.equal(
        (invocation!.options.env as Record<string, unknown>)
          .ANTHROPIC_API_KEY,
        undefined,
      );
      assert.equal(
        (invocation!.options.env as Record<string, unknown>)
          .CLAUDE_CODE_OAUTH_TOKEN,
        "operator-passthrough",
      );

      const submitted = submitClaudeCliLoginCode("  pasted-code  ");
      assert.deepEqual(writes, ["pasted-code\n"]);
      await tick();
      child.exitCode = 0;
      child.emit("exit", 0, null);
      assert.deepEqual(await submitted, { ok: true });
      assert.deepEqual(getClaudeCliLoginStatus(), { state: "succeeded" });
      resetClaudeCliLoginForTests();
    }

    // Rejected code: the CLI keeps prompting on the same challenge, so failure
    // is reported from its stderr rather than from an exit that never comes.
    {
      const { child, writes } = createFakeCli();
      const pending = startClaudeCliLogin({
        binaryPath: "/usr/local/bin/claude",
        env: { PATH: "/usr/local/bin" },
        spawnLogin: () => child as any,
      });
      await tick();
      child.stdout.emit("data", cliBanner(authorizeUrl));
      await pending;

      const submitted = submitClaudeCliLoginCode("wrong-code");
      await tick();
      child.stderr.emit(
        "data",
        "Invalid code. Please make sure the full code was copied.\n",
      );
      const result = await submitted;
      assert.equal(result.ok, false);
      assert.match(
        result.ok ? "" : result.message,
        /Invalid code\. Please make sure the full code was copied\./,
      );

      // Retrying reuses the live sign-in and its still-valid URL — respawning
      // would abandon the verifier the CLI holds in memory.
      const resumed = await startClaudeCliLogin({
        binaryPath: "/usr/local/bin/claude",
        env: { PATH: "/usr/local/bin" },
        spawnLogin: () => {
          throw new Error("a live sign-in must be reused, not respawned");
        },
      });
      assert.deepEqual(resumed, { state: "awaiting-code", url: authorizeUrl });

      // The stale rejection must not fail the next code before the CLI reads it.
      const retried = submitClaudeCliLoginCode("second-code");
      assert.deepEqual(writes, ["wrong-code\n", "second-code\n"]);
      await tick();
      child.exitCode = 0;
      child.emit("exit", 0, null);
      assert.deepEqual(await retried, { ok: true });
      resetClaudeCliLoginForTests();
    }

    // No CLI found: the host falls back to terminal instructions.
    {
      const missing = await startClaudeCliLogin({
        binaryPath: null,
        env: { PATH: "/usr/local/bin", HOME: "/nonexistent" },
        spawnLogin: () => {
          throw new Error("must not spawn without a binary");
        },
      });
      assert.equal(missing.state, "failed");
      assert.match(
        missing.state === "failed" ? missing.message : "",
        /npm install -g @anthropic-ai\/claude-code/,
      );
      resetClaudeCliLoginForTests();
    }

    // A code submitted with no sign-in running is refused, not written blind.
    {
      const orphan = await submitClaudeCliLoginCode("code-without-session");
      assert.equal(orphan.ok, false);
    }
  }

  // CLI resolution finds install locations a clean server PATH misses.
  {
    const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolveClaudeCli } = await import("../src/executable-path.ts");

    const home = mkdtempSync(join(tmpdir(), "oc-claude-home-"));
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, "claude");
    writeFileSync(
      fake,
      '#!/bin/sh\necho "2.1.226 (Claude Code)"\n',
      { mode: 0o755 },
    );
    chmodSync(fake, 0o755);

    assert.equal(resolveClaudeCli({ PATH: "/usr/bin:/bin", HOME: home }), fake);
    // And PATH itself still wins when the CLI is on it.
    assert.equal(
      resolveClaudeCli({ PATH: "/usr/bin:/bin", HOME: home }).length > 0,
      true,
    );
  }

  // The one-click install path: official npm package, script as fallback.
  {
    const { installClaudeCli } = await import("../src/cli-install.ts");
    const { EventEmitter: CliEventEmitter } = await import("node:events");

    const fakeCli = () => {
      const streams = { stdout: new CliEventEmitter(), stderr: new CliEventEmitter() };
      const child = Object.assign(new CliEventEmitter(), {
        pid: 7,
        stdout: streams.stdout,
        stderr: streams.stderr,
        kill() {
          return true;
        },
      });
      return { child, streams };
    };

    // npm succeeds → no script fallback runs.
    {
      const { child, streams } = fakeCli();
      const calls: string[][] = [];
      const pending = installClaudeCli({
        env: { PATH: "/usr/bin" },
        spawnInstall(command, args) {
          calls.push([command, ...args]);
          return child as any;
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      streams.stdout.emit("data", "added 1 package\n");
      child.emit("exit", 0);
      assert.deepEqual(await pending, { ok: true });
      assert.deepEqual(calls, [["npm", "install", "-g", "@anthropic-ai/claude-code"]]);
    }

    // npm fails → the official install script runs; its failure is reported.
    {
      const failures = [fakeCli(), fakeCli()];
      let call = 0;
      const pending = installClaudeCli({
        env: { PATH: "/usr/bin" },
        spawnInstall(command) {
          const { child, streams } = failures[call]!;
          call += 1;
          process.nextTick(() => {
            if (command === "npm") {
              streams.stderr.emit("data", "npm: not found\n");
              child.emit("exit", 127);
            } else {
              streams.stderr.emit("data", "curl: could not resolve host\n");
              child.emit("exit", 6);
            }
          });
          return child as any;
        },
      });
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(
        result.ok ? "" : result.message,
        /curl: could not resolve host/,
      );
    }
  }


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

  // ---- Host-transcript fingerprinting + divergence detection ----
  {
    const {
      detectHostTranscriptDivergence,
      divergenceRebuildEnabled,
      fingerprintHostMessages,
      hostOwnsTranscript,
    } = await import("../src/host-transcript.ts");

    const turn1 = [
      { role: "system", content: "internal prompt v1" },
      { role: "user", content: "remember AXIOM" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "next question" },
    ];
    const fp1 = fingerprintHostMessages(turn1);
    assert.equal(fp1.count, 3, "system messages are excluded");
    assert.equal(fp1.chain.length, 3);

    // System prompt churn between turns must never register as divergence
    // (the proxy drops system messages deliberately).
    const systemChanged = fingerprintHostMessages([
      { role: "system", content: "internal prompt v2 CHANGED" },
      ...turn1.slice(1),
    ]);
    assert.equal(systemChanged.hash, fp1.hash);

    // Same text as a string vs a part array is not a rewrite.
    const partArray = fingerprintHostMessages([
      turn1[0]!,
      { role: "user", content: [{ type: "text", text: "remember AXIOM" }] },
      ...turn1.slice(2),
    ]);
    assert.equal(partArray.hash, fp1.hash);

    const stored = { count: fp1.count, hash: fp1.hash };

    // Normal growth (assistant reply + new user turn) extends the prefix.
    assert.deepEqual(
      detectHostTranscriptDivergence(
        stored,
        fingerprintHostMessages([
          ...turn1,
          { role: "assistant", content: "an answer" },
          { role: "user", content: "another question" },
        ]),
      ),
      { diverged: false },
    );

    // A retry with the identical array is not a divergence.
    assert.deepEqual(detectHostTranscriptDivergence(stored, fp1), {
      diverged: false,
    });

    // Messages dropped → shrunk.
    const shrunk = detectHostTranscriptDivergence(
      stored,
      fingerprintHostMessages(turn1.slice(0, 2)),
    );
    assert.equal(shrunk.diverged, true);
    assert.equal(shrunk.diverged && shrunk.reason, "shrunk");

    // A prior message replaced (DCP-style pruning) → rewritten.
    const rewritten = detectHostTranscriptDivergence(
      stored,
      fingerprintHostMessages([
        turn1[0]!,
        { role: "user", content: "[[pruned]]" },
        ...turn1.slice(2),
      ]),
    );
    assert.equal(rewritten.diverged, true);
    assert.equal(rewritten.diverged && rewritten.reason, "rewritten");

    // No stored digest (first turn / migrated store) → never diverged.
    assert.deepEqual(detectHostTranscriptDivergence(undefined, fp1), {
      diverged: false,
    });

    // Env flags: host mode is opt-in, divergence rebuild is default-on.
    const prevHost = process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
    const prevDivergence = process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD;
    try {
      delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
      delete process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD;
      assert.equal(hostOwnsTranscript(), false);
      assert.equal(divergenceRebuildEnabled(), true);
      process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT = "1";
      process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD = "0";
      assert.equal(hostOwnsTranscript(), true);
      assert.equal(divergenceRebuildEnabled(), false);
    } finally {
      if (prevHost === undefined) {
        delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
      } else {
        process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT = prevHost;
      }
      if (prevDivergence === undefined) {
        delete process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD;
      } else {
        process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD = prevDivergence;
      }
    }
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
  // prompt_tokens follows the OpenAI contract: inclusive of cached tokens
  // (Anthropic's input_tokens excludes them, so 50 + 5 + 0 = 55).
  assert.equal(usage?.prompt_tokens, 55);
  assert.equal(usage?.completion_tokens, 10);
  assert.equal(usage?.prompt_tokens_details?.cached_tokens, 5);

  // Per-call usage from assistant events (the only usage signal available
  // for parked tool-call turns) + accumulation across API calls.
  const {
    usageFromAssistantEvent,
    addOpenAIUsage,
    addUniqueAssistantUsage,
    resolveTurnUsage,
  } = await import("../src/usage.ts");
  const callUsage = usageFromAssistantEvent({
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 30,
      },
    },
  });
  assert.equal(callUsage?.prompt_tokens, 1030);
  assert.equal(callUsage?.completion_tokens, 20);
  assert.equal(callUsage?.prompt_tokens_details?.cached_tokens, 900);
  assert.equal(callUsage?.prompt_tokens_details?.cache_write_tokens, 30);
  assert.equal(
    usageFromAssistantEvent({ type: "result", usage: { input_tokens: 1 } }),
    null,
  );

  const summed = addOpenAIUsage(callUsage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 7 },
  });
  assert.equal(summed.prompt_tokens, 1040);
  assert.equal(summed.completion_tokens, 25);
  assert.equal(summed.total_tokens, 1065);
  assert.equal(summed.prompt_tokens_details?.cached_tokens, 907);
  assert.equal(summed.prompt_tokens_details?.cache_write_tokens, 30);

  const seenAssistantUsageIds = new Set<string>();
  const firstUnique = addUniqueAssistantUsage(
    null,
    callUsage!,
    "sdk-message-1",
    seenAssistantUsageIds,
  );
  const replayed = addUniqueAssistantUsage(
    firstUnique,
    callUsage!,
    "sdk-message-1",
    seenAssistantUsageIds,
  );
  assert.deepEqual(replayed, firstUnique);
  const secondUnique = addUniqueAssistantUsage(
    replayed,
    callUsage!,
    "sdk-message-2",
    seenAssistantUsageIds,
  );
  assert.equal(secondUnique?.total_tokens, callUsage!.total_tokens * 2);

  // Accumulated per-response usage wins over the cumulative result snapshot
  // (which would double-count prior turns of a continued Claude query), but
  // inherits cost/model breakdown metadata from it.
  const resolved = resolveTurnUsage(summed, {
    prompt_tokens: 999999,
    completion_tokens: 999999,
    total_tokens: 999999,
    cost_usd: 0.42,
  });
  assert.equal(resolved?.prompt_tokens, 1040);
  assert.equal(resolved?.cost_usd, 0.42);
  assert.equal(resolveTurnUsage(null, null), null);
  assert.match(
    formatCompactNote({ trigger: "auto", pre_tokens: 1000, post_tokens: 100 }),
    /1000 → 100/,
  );

  // Session auto-naming: detect title/summary meta requests.
  {
    const {
      detectMetaRequestKind,
      isTitleGenerationRequest,
      requestKeyNamespace,
    } = await import("../src/request-kind.ts");

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
    // The spawned children inherit this run's isolated XDG_DATA_HOME.
    const logPath = join(SMOKE_XDG, "opencode-claude", "debug.log");
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

  // Auth methods mirror CLI presence: install only when missing, relay only
  // when present, and every path carries the terminal alternative. The method
  // bodies are not invoked here — on a CI host without the CLI the install
  // method would run a real `npm install -g` — so the terminal fallback is
  // exercised through its pure builder instead.
  {
    const withoutCli = buildAuthMethods(false, "/tmp");
    assert.equal(withoutCli.length, 1);
    assert.equal(
      withoutCli[0]!.label,
      "Install Claude Code CLI and sign in",
    );

    const withCli = buildAuthMethods(true, "/tmp");
    assert.equal(withCli.length, 1);
    assert.equal(withCli[0]!.label, "Sign in with Claude Code CLI");

    // The fallback instructions always name both the install and the auth
    // command, whatever the launch failure message was.
    const fallback = manualInstallResponse("boom");
    assert.match(fallback.instructions, /npm install -g @anthropic-ai\/claude-code/);
    assert.match(fallback.instructions, /claude auth login --claudeai/);
    assert.equal(fallback.method, "auto");
  }

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
  // Proxy health (without Agent SDK turn)
  await stopProxy();
  const port = await startProxy();
  assert.ok(port > 0);
  assert.equal(getProxyPort(), port);
  assert.ok(getClaudeProxyBaseUrl().includes(String(port)));
  // Bun's default 10s idleTimeout RSTs the socket while we probe the Claude
  // turn (no HTTP bytes until first content). 0 disables, matching OpenCode.
  assert.equal(PROXY_IDLE_TIMEOUT_SECONDS, 0);

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const healthJson = (await health.json()) as { ok: boolean };
  assert.equal(healthJson.ok, true);

  const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(modelsRes.status, 200);
  const modelsJson = (await modelsRes.json()) as { data: unknown[] };
  assert.ok(Array.isArray(modelsJson.data));
  assert.ok(modelsJson.data.length > 0);

  // Title meta requests use a constrained, tool-free Agent SDK turn.
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const prevEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const prevEnvApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "smoke-operator-token";
    process.env.ANTHROPIC_API_KEY = "smoke-api-key-must-strip";
    let titleOptions: Record<string, unknown> | null = null;
    setClaudeQueryStarter(async (params) => {
      titleOptions = params as unknown as Record<string, unknown>;
      return {
        stream: (async function* () {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Binary search trees" },
            },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });
    try {
      const titleRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Selected effort must NOT reach the meta turn: thinking is
            // force-disabled there, and the API rejects effort+disabled
            // (400 output_config.effort 'max' is not supported...).
            "x-opencode-claude-effort": encodeClaudeModelSelection({
              modelId: "haiku",
              effort: "max",
            }),
          },
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
      assert.match(titleBody, /data: /);
      assert.match(titleBody, /\[DONE\]/);
      assert.match(titleBody, /Binary search trees/);
      assert.ok(titleOptions, "title request reached Agent SDK");
      // The child env never carries API-billing keys, and the plugin never
      // fabricates an OAuth token — only the operator-set one passes through.
      assert.equal(
        (titleOptions!.env as Record<string, unknown>).ANTHROPIC_API_KEY,
        undefined,
      );
      assert.equal(
        (titleOptions!.env as Record<string, unknown>).CLAUDE_CODE_OAUTH_TOKEN,
        "smoke-operator-token",
      );
      assert.deepEqual(titleOptions!.tools, []);
      assert.deepEqual(titleOptions!.settingSources, []);
      assert.deepEqual(titleOptions!.skills, []);
      assert.equal(titleOptions!.maxTurns, 1);
      assert.equal(titleOptions!.autoCompactEnabled, false);
      assert.deepEqual(titleOptions!.thinking, { type: "disabled" });
      assert.equal(
        titleOptions!.effort,
        undefined,
        "meta requests must not forward effort while thinking is disabled",
      );
      assert.equal(titleOptions!.resume, undefined);
      assert.equal(
        titleOptions!.systemPrompt,
        "You generate short session titles. Follow the requested output format exactly.",
      );
      assert.match(String(titleOptions!.prompt), /<request>\nExplain how binary search trees work\n<\/request>/);
    } finally {
      setClaudeQueryStarter(null);
      if (prevEnvToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = prevEnvToken;
      }
      if (prevEnvApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = prevEnvApiKey;
      }
    }
  }

  // startClaudeQuery defensively drops effort when thinking is disabled —
  // the API rejects that combination (400 output_config.effort ... is not
  // supported when thinking is disabled).
  {
    const { startClaudeQuery } = await import("../src/query.ts");
    const captureOptions = async (
      extra: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      let captured: Record<string, unknown> | null = null;
      const handle = await startClaudeQuery({
        prompt: "hi",
        cwd: "/tmp",
        pathToClaudeCodeExecutable: "/bin/true",
        ...extra,
        queryImpl:
          () =>
          (input: { options: Record<string, unknown> }) => {
            captured = input.options;
            return (async function* () {})();
          },
      } as never);
      handle.close();
      assert.ok(captured, "queryImpl was invoked");
      return captured!;
    };

    const disabledThinking = await captureOptions({
      effort: "max",
      thinking: { type: "disabled" },
    });
    assert.equal(
      disabledThinking.effort,
      undefined,
      "effort must be dropped when thinking is disabled",
    );
    assert.deepEqual(disabledThinking.thinking, { type: "disabled" });

    const adaptive = await captureOptions({ effort: "max" });
    assert.equal(adaptive.effort, "max");
    assert.deepEqual(adaptive.thinking, { type: "adaptive" });
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

      // Meta requests during a confirmed hard limit are answered LOCALLY
      // (zero API calls) instead of burning the host's retry budget on a
      // doomed 429: titles fall back to a heuristic of the request text.
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
      assert.equal(metaRes.status, 200, "meta title falls back locally");
      const metaJson = (await metaRes.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      assert.equal(metaJson.choices?.[0]?.message?.content, "Explain quicksort");

      // Summary meta requests fall back to a locally assembled transcript so
      // the conversation can continue with SOME context instead of none.
      const summaryRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "sonnet",
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "You are tasked with summarizing conversations for compaction.",
              },
              { role: "user", content: "we discussed the AXIOM-9042 codename" },
            ],
          }),
        },
      );
      assert.equal(summaryRes.status, 200, "meta summary falls back locally");
      const summaryJson = (await summaryRes.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summaryText = String(summaryJson.choices?.[0]?.message?.content ?? "");
      assert.match(summaryText, /Summary unavailable/);
      assert.match(summaryText, /AXIOM-9042/, "fallback preserves context");

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

      // Regression: if the limit is exhausted after the run already produced
      // content/tool work, Claude emits a synthetic assistant API-error event.
      // There is no new user request to trigger the pre-flight gate, so this
      // event itself must activate the timer immediately.
      rmSync(storeFile, { force: true });
      const midRunLimitText =
        "You've hit your session limit · resets 1:10am (Europe/Kyiv)";
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "mock-sess-mid-run" };
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "work completed before limit" },
            },
          };
          yield {
            type: "assistant",
            error: "rate_limit",
            message: {
              role: "assistant",
              content: [{ type: "text", text: midRunLimitText }],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));

      const midRunRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-mid-run-limit",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "keep working" }],
          }),
        },
      );
      assert.equal(midRunRes.status, 200);
      const midRunBody = await midRunRes.text();
      assert.match(midRunBody, /work completed before limit/);
      assert.match(midRunBody, /claude_session_limit/);
      assert.match(midRunBody, /server_error/);
      assert.doesNotMatch(midRunBody, /\[claude-code error\]/);
      assert.match(midRunBody, /limit resets in/);

      const midRunSnapshot = getRateLimitSnapshot();
      assert.equal(midRunSnapshot.limited, true);
      assert.ok((midRunSnapshot.resetInSeconds ?? 0) > 0);
      const midRunCounter = await fetch(
        `http://127.0.0.1:${port}/v1/rate-limit`,
      );
      const midRunCounterBody = (await midRunCounter.json()) as {
        limited?: boolean;
        resetInSeconds?: number;
      };
      assert.equal(midRunCounterBody.limited, true);
      assert.ok((midRunCounterBody.resetInSeconds ?? 0) > 0);

      // The stream error makes OpenCode retry once; that retry must receive
      // the stored reset as a real 429 + Retry-After, which drives the timer.
      const midRunRetry = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-mid-run-limit",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "keep working" }],
          }),
        },
      );
      assert.equal(midRunRetry.status, 429);
      assert.ok(midRunRetry.headers.get("retry-after"));
      assert.match(await midRunRetry.text(), /limit resets in/);

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
    const { mkdirSync, rmSync, writeFileSync, mkdtempSync } = await import(
      "node:fs"
    );
    const { homedir, tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    // Isolate the rate-limit store: this block mocks healthy turns, so a
    // confirmed limit in the HOST's real store (e.g. the dev machine is
    // actually rate-limited right now) must not gate them into 429s.
    const histTmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-hist-"));
    const histPrevStoreEnv = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = joinPath(
      histTmpDir,
      "rate-limit.json",
    );

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

      // 4. Host-side history transform between turns (DCP-style pruning via
      //    experimental.chat.messages.transform) → divergence detected,
      //    resume abandoned, the TRANSFORMED history is injected.
      const prevHostEnv = process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
      const prevDivergenceEnv = process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD;
      delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
      delete process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD;
      clearForeignSessionId("smoke-history-diverge");
      const divProjectsDir = joinPath(
        homedir(),
        ".claude",
        "projects",
        "opencode-claude-smoke-div",
      );
      mkdirSync(divProjectsDir, { recursive: true });
      writeFileSync(joinPath(divProjectsDir, "mock-sess-div.jsonl"), "{}\n");
      try {
        // Turn A: binding exists, no digest yet → resumes, records digest.
        setForeignSessionId("smoke-history-diverge", "mock-sess-div");
        const seenA = { params: null as Record<string, unknown> | null };
        mockTurn(seenA, "mock-sess-div");
        const resA = await postChat("smoke-history-diverge", historyMessages);
        assert.equal(resA.status, 200);
        await resA.text();
        assert.equal(seenA.params!.resume, "mock-sess-div");

        // Turn B: a transform plugin replaced a prior user message while the
        // conversation grew — the stored digest is no longer a prefix.
        const transformed = [
          { role: "system", content: "internal system prompt" },
          { role: "user", content: "[[pruned by DCP]]" },
          { role: "assistant", content: "Codename AXIOM-9042 noted." },
          { role: "user", content: "what is the codename?" },
          { role: "assistant", content: "It is AXIOM-9042." },
          { role: "user", content: "and what did I originally say?" },
        ];
        const seenB = { params: null as Record<string, unknown> | null };
        mockTurn(seenB, "mock-sess-div");
        const resB = await postChat("smoke-history-diverge", transformed);
        assert.equal(resB.status, 200);
        await resB.text();
        assert.equal(
          seenB.params!.resume,
          undefined,
          "diverged history must rebuild instead of resuming",
        );
        const promptB = String(seenB.params!.prompt ?? "");
        assert.match(promptB, /<conversation_history>/);
        assert.match(
          promptB,
          /\[\[pruned by DCP\]\]/,
          "the transformed history is what reaches Claude",
        );

        // Turn C: extends turn B's transformed array → no divergence, resume
        // returns (turn B's init event re-established the binding).
        const seenC = { params: null as Record<string, unknown> | null };
        mockTurn(seenC, "mock-sess-div");
        const resC = await postChat("smoke-history-diverge", [
          ...transformed,
          { role: "assistant", content: "You asked me to remember it." },
          { role: "user", content: "great, thanks" },
        ]);
        assert.equal(resC.status, 200);
        await resC.text();
        assert.equal(seenC.params!.resume, "mock-sess-div");
        assert.doesNotMatch(
          String(seenC.params!.prompt ?? ""),
          /<conversation_history>/,
        );

        // 5. Shrunk host array (messages dropped outright) → also a rebuild.
        const seenShrunk = { params: null as Record<string, unknown> | null };
        mockTurn(seenShrunk, "mock-sess-div");
        const resShrunk = await postChat(
          "smoke-history-diverge",
          transformed.slice(0, 4),
        );
        assert.equal(resShrunk.status, 200);
        await resShrunk.text();
        assert.equal(
          seenShrunk.params!.resume,
          undefined,
          "shrunk host array must rebuild instead of resuming",
        );

        // 6. Warn-only mode: divergence is logged but resume is kept.
        process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD = "0";
        const warnMessages = [
          { role: "system", content: "internal system prompt" },
          { role: "user", content: "[[a different transform]]" },
          { role: "assistant", content: "noted" },
          { role: "user", content: "next" },
        ];
        const seenWarn = { params: null as Record<string, unknown> | null };
        mockTurn(seenWarn, "mock-sess-div");
        const resWarn = await postChat("smoke-history-diverge", warnMessages);
        assert.equal(resWarn.status, 200);
        await resWarn.text();
        assert.equal(
          seenWarn.params!.resume,
          "mock-sess-div",
          "warn-only mode must keep resuming despite divergence",
        );
        delete process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD;

        // 7. Host-transcript mode: never resume, rebuild every turn — even
        //    when the incoming array extends the previous one cleanly.
        process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT = "1";
        const seenHost = { params: null as Record<string, unknown> | null };
        mockTurn(seenHost, "mock-sess-div");
        const resHost = await postChat("smoke-history-diverge", [
          ...warnMessages,
          { role: "assistant", content: "ok" },
          { role: "user", content: "continue" },
        ]);
        assert.equal(resHost.status, 200);
        await resHost.text();
        assert.equal(
          seenHost.params!.resume,
          undefined,
          "host-transcript mode must never resume",
        );
        assert.match(
          String(seenHost.params!.prompt ?? ""),
          /<conversation_history>/,
        );
        delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
      } finally {
        if (prevHostEnv === undefined) {
          delete process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT;
        } else {
          process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT = prevHostEnv;
        }
        if (prevDivergenceEnv === undefined) {
          delete process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD;
        } else {
          process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD = prevDivergenceEnv;
        }
        rmSync(divProjectsDir, { recursive: true, force: true });
        clearForeignSessionId("smoke-history-diverge");
      }

      clearForeignSessionId("smoke-history-fresh");
      clearForeignSessionId("smoke-history-resume");
      clearForeignSessionId("smoke-history-dead");
    } finally {
      setClaudeQueryStarter(null);
      if (histPrevStoreEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = histPrevStoreEnv;
      }
      rmSync(histTmpDir, { recursive: true, force: true });
    }
  }

  // ---- Fail-fast taxonomy: dead turns get truthful HTTP statuses ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
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
      assert.match(authStreamJson.error?.message ?? "", /claude auth login/);

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

      // First content after Bun's default 10s idleTimeout must not RST.
      // OpenCode surfaces that as retryable "Connection reset by server".
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          await new Promise((r) => setTimeout(r, 11_000));
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "SLOW_OK" },
            },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
      const slowStarted = Date.now();
      const slowRes = await postTurn("ff-slow-first-byte", true);
      assert.equal(
        slowRes.status,
        200,
        "probe longer than Bun's 10s default must not RST the socket",
      );
      const slowBody = await slowRes.text();
      assert.match(slowBody, /SLOW_OK/);
      assert.match(slowBody, /\[DONE\]/);
      assert.ok(
        Date.now() - slowStarted >= 11_000,
        "slow-first-byte test did not actually wait out the default idleTimeout",
      );
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

  // ---- Turn stall watchdog + client-cancel teardown + CLI resolution cache ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const { mkdtempSync, rmSync, writeFileSync, chmodSync, unlinkSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const { resolveClaudeCli, resetClaudeCliResolutionCache } = await import(
      "../src/executable-path.ts"
    );

    const postStream = (sessionHeader: string) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({
          model: "sonnet",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const prevStallEnv = process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
    process.env.OPENCODE_CLAUDE_TURN_STALL_MS = "2000";
    try {
      // A turn that goes silent after init must fail truthfully (HTTP 500
      // via the pre-content probe), not hold the response open forever.
      let stalledCloseCalled = false;
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "stall-sess" };
          await new Promise(() => {}); // never produces another event
        })(),
        interrupt: async () => {},
        close: () => {
          stalledCloseCalled = true;
        },
        getPid: () => null,
      }));
      const stallStarted = Date.now();
      const stallRes = await postStream("smoke-stall");
      assert.equal(
        stallRes.status,
        500,
        "silent turn must fail with a truthful HTTP error",
      );
      const stallJson = (await stallRes.json()) as {
        error?: { message?: string };
      };
      assert.match(String(stallJson.error?.message ?? ""), /no output/);
      assert.ok(
        Date.now() - stallStarted < 15_000,
        "stall watchdog took too long to fire",
      );
      assert.ok(stalledCloseCalled, "stalled turn must close the CLI handle");

      // Client disconnect mid-turn must tear the turn down (close handle)
      // instead of leaking a live CLI + bridge nobody can resume. The stall
      // watchdog is moved out of the way so only cancel() can do it.
      process.env.OPENCODE_CLAUDE_TURN_STALL_MS = "60000";
      let cancelCloseCalled = false;
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "FIRST_CHUNK" },
            },
          };
          await new Promise(() => {}); // turn continues forever
        })(),
        interrupt: async () => {},
        close: () => {
          cancelCloseCalled = true;
        },
        getPid: () => null,
      }));
      const abort = new AbortController();
      const cancelRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-cancel",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: abort.signal,
        },
      );
      assert.equal(cancelRes.status, 200);
      const reader = cancelRes.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /FIRST_CHUNK/);
      // A real client abort (OpenCode timeout/session stop) destroys the
      // socket — the server-side stream must observe it via cancel().
      abort.abort();
      const cancelDeadline = Date.now() + 5_000;
      while (!cancelCloseCalled && Date.now() < cancelDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        cancelCloseCalled,
        "client cancel must close the orphaned CLI handle",
      );
    } finally {
      setClaudeQueryStarter(null);
      if (prevStallEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
      } else {
        process.env.OPENCODE_CLAUDE_TURN_STALL_MS = prevStallEnv;
      }
    }

    // CLI resolution is memoized per PATH+HOME: re-probing spawns sync
    // child processes that hard-block the host's event loop on every query.
    const binDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-bin-"));
    try {
      const fakeCli = joinPath(binDir, "claude");
      writeFileSync(fakeCli, "#!/bin/sh\necho 9.9.9-smoke\n");
      chmodSync(fakeCli, 0o755);
      // HOME points at the temp dir so the well-known-location fallback
      // (~/.local/bin/claude on this dev box) cannot mask a negative result.
      const env = { PATH: binDir, HOME: binDir };
      resetClaudeCliResolutionCache();
      const first = resolveClaudeCli(env);
      assert.ok(first && first.endsWith("claude"), "fake CLI resolved");
      unlinkSync(fakeCli);
      const second = resolveClaudeCli(env);
      assert.equal(second, first, "resolution must be memoized");
      resetClaudeCliResolutionCache();
      assert.equal(
        resolveClaudeCli(env),
        null,
        "cache reset must re-probe (and negatives stay uncached)",
      );
      resetClaudeCliResolutionCache();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }

  // ---- Failure taxonomy: 529 overload + $0 group budget ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const {
      classifyClaudeFailure,
      failureStatusFor,
      failureTypeFor,
    } = await import("../src/failure.ts");
    const {
      isClaudeOverloadedText,
      isClaudeRateLimitText,
      recordRateLimitErrorText,
      rateLimitGate,
    } = await import("../src/rate-limit.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const tmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-529-"));
    const prevStoreEnv = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = joinPath(
      tmpDir,
      "rate-limit.json",
    );

    const postTurn = (sessionHeader: string) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({
          model: "sonnet",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const mockDeath = (text: string) => {
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "tax-sess" };
          yield { type: "result", is_error: true, result: text };
          throw new Error(`Claude Code returned an error result: ${text}`);
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
    };

    try {
      // Unit: classification. Overload outranks the generic limit patterns
      // and must never be recorded as a hard subscription limit.
      assert.equal(
        classifyClaudeFailure("API is temporarily overloaded (overloaded_error)"),
        "overloaded",
      );
      assert.equal(classifyClaudeFailure("upstream returned 529"), "overloaded");
      assert.equal(failureStatusFor("overloaded"), 529);
      assert.equal(failureTypeFor("overloaded"), "overloaded_error");
      assert.equal(isClaudeOverloadedText("overloaded_error"), true);
      assert.equal(
        recordRateLimitErrorText("529 overloaded_error: try later"),
        null,
        "a transient overload must never activate the hard-limit gate",
      );

      // Unit: an org admin setting the group budget to $0 is a hard limit.
      assert.equal(
        isClaudeRateLimitText("Your group's usage limit is set to $0"),
        true,
      );
      assert.equal(
        classifyClaudeFailure(
          "This request would exceed your group's usage limit is set to $0",
        ),
        "rate_limit",
      );

      // Proxy: overload death → 529 + short Retry-After, gate untouched.
      mockDeath("API is temporarily overloaded (529 overloaded_error)");
      const overloadedRes = await postTurn("tax-overload");
      assert.equal(overloadedRes.status, 529);
      assert.ok(overloadedRes.headers.get("retry-after"));
      const overloadedJson = (await overloadedRes.json()) as {
        error?: { type?: string; code?: string };
      };
      assert.equal(overloadedJson.error?.type, "overloaded_error");
      assert.equal(overloadedJson.error?.code, "claude_overloaded");
      assert.equal(
        rateLimitGate().blocked,
        false,
        "529 must not gate follow-up turns",
      );

      // Follow-up turn goes straight through (no doomed fast-fail).
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "RECOVERED" },
            },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
      const recoveredRes = await postTurn("tax-recovered");
      assert.equal(recoveredRes.status, 200);
      assert.match(await recoveredRes.text(), /RECOVERED/);

      // Proxy: $0 group budget death → 429 + gate active.
      mockDeath("Your group's usage limit is set to $0 — request refused");
      const groupRes = await postTurn("tax-group-zero");
      assert.equal(groupRes.status, 429);
      assert.equal(rateLimitGate().blocked, true, "$0 group budget gates");
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

  // ---- Quota + identity stores (SDK control channel parsing) ----
  {
    const {
      __resetQuotaStore,
      formatQuotaSummary,
      getAccountQuota,
      mergeSdkRateLimitEvent,
      parsePlanUsage,
      recordQuotaFromPlanUsage,
    } = await import("../src/quota.ts");
    const {
      __resetIdentityStore,
      accountsSharingLogin,
      labelLoginMismatch,
      parseAccountInfo,
      recordAccountIdentity,
    } = await import("../src/identity.ts");
    const { quotaNameSuffix } = await import("../src/models.ts");

    __resetQuotaStore();
    // Control-channel payload: utilization is 0-100, resets_at is ISO.
    const resetsIso = new Date(Date.now() + 2 * 3600_000).toISOString();
    const weeklyIso = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
    const parsed = parsePlanUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 57, resets_at: resetsIso },
        seven_day: { utilization: 93, resets_at: weeklyIso },
      },
    });
    assert.ok(parsed, "plan usage parsed");
    assert.ok(
      Math.abs(parsed!.windows.fiveHour!.remaining - 0.43) < 1e-9,
      "0-100 utilization converts to 0..1 remaining",
    );
    assert.equal(parsed!.windows.fiveHour!.resetsAt, Date.parse(resetsIso));
    assert.ok(Math.abs(parsed!.windows.sevenDay!.remaining - 0.07) < 1e-9);
    assert.equal(parsePlanUsage({ rate_limits_available: false }), null);
    assert.equal(parsePlanUsage({}), null);
    assert.equal(parsePlanUsage(null), null);

    recordQuotaFromPlanUsage("work", {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 57, resets_at: resetsIso },
        seven_day: { utilization: 93, resets_at: weeklyIso },
      },
    });

    // A rate_limit_event reports ONE window — merging must not erase the
    // sibling window (five-hour healthy while weekly nearly spent is exactly
    // the case that matters).
    mergeSdkRateLimitEvent("work", {
      rateLimitType: "five_hour",
      status: "allowed",
      utilization: 0.61,
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const merged = getAccountQuota("work");
    assert.ok(merged);
    assert.ok(
      Math.abs(merged!.windows.fiveHour!.utilization - 0.61) < 1e-9,
      "event window merged",
    );
    assert.ok(
      merged!.windows.sevenDay &&
        Math.abs(merged!.windows.sevenDay.remaining - 0.07) < 1e-9,
      "sibling window survives the merge",
    );
    const summary = formatQuotaSummary(merged);
    assert.match(summary ?? "", /5h 39% left/);
    assert.match(summary ?? "", /7d 7% left/);

    // Model-name quota suffix (percent LEFT — what the operator reads while
    // picking a model). Stale windows (reset already behind us) show "?".
    const suffix = quotaNameSuffix("work");
    assert.match(suffix, /5h 39%/);
    assert.match(suffix, /7d 7%/);
    process.env.OPENCODE_CLAUDE_MODEL_QUOTA = "0";
    assert.equal(quotaNameSuffix("work"), "");
    delete process.env.OPENCODE_CLAUDE_MODEL_QUOTA;

    // Identity: resolved by the CLI, recorded as reported, duplicate logins
    // across accounts are flagged (one quota pool wearing two labels).
    __resetIdentityStore();
    assert.equal(parseAccountInfo({}), null);
    assert.equal(parseAccountInfo(null), null);
    recordAccountIdentity("work", {
      email: "alice@corp.com",
      organization: "Corp",
      subscriptionType: "max",
    });
    recordAccountIdentity("personal", { email: "ALICE@corp.com" });
    assert.deepEqual(accountsSharingLogin("work"), ["personal"]);
    const mismatch = labelLoginMismatch("work", "Work · bob@corp.com");
    assert.equal(mismatch?.claimed, "bob@corp.com");
    assert.equal(mismatch?.actual, "alice@corp.com");
    assert.equal(labelLoginMismatch("work", "Just Work"), null);
    __resetIdentityStore();
    __resetQuotaStore();
  }

  // ---- Usage counters (per-account turn/token accounting) ----
  {
    const {
      __resetUsageStore,
      getAccountUsage,
      recordTurnUsage,
    } = await import("../src/usage-store.ts");
    __resetUsageStore();
    recordTurnUsage("work", {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 },
    });
    // A parked (tool-call) response is a fragment of a turn: tokens count,
    // the turn does not.
    recordTurnUsage("work", { prompt_tokens: 50, completion_tokens: 10 }, {
      countTurn: false,
    });
    const usage = getAccountUsage("work");
    assert.equal(usage.turns, 1);
    assert.equal(usage.inputTokens, 150);
    assert.equal(usage.outputTokens, 30);
    assert.equal(usage.cacheReadTokens, 60);
    assert.equal(usage.today.turns, 1);
    assert.equal(usage.last7Days.inputTokens, 150);
    __resetUsageStore();
  }

  // ---- Account registry: file-managed roster (CLI-owned config dirs) ----
  {
    const {
      AccountError,
      addAccount,
      applyAccountEnv,
      findAccount,
      getAccounts,
      getAccountsFilePath,
      getDefaultAccount,
      isMultiAccount,
      removeAccount,
      renameAccount,
      requireAccount,
      resetAccounts,
      setDefaultAccount,
      slugifyAccountId,
      assertLabelNamesNoLogin,
    } = await import("../src/accounts.ts");
    const { bindConversationAccount, clearForeignSessionId } = await import(
      "../src/session-store.ts"
    );
    const { rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    // Nothing configured → one implicit ambient account, single-account mode.
    resetAccounts();
    assert.equal(isMultiAccount(), false);
    assert.equal(getAccounts().length, 1);
    assert.equal(getDefaultAccount().id, "default");
    // The ambient account leaves the child env untouched (operator tokens
    // pass through; the CLI decides what to honor).
    const ambientEnv = applyAccountEnv(getDefaultAccount(), {
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "keep",
    });
    assert.equal(ambientEnv.CLAUDE_CODE_OAUTH_TOKEN, "keep");

    // Slug + label hygiene.
    assert.equal(slugifyAccountId("Cuenta Diseño"), "cuenta-diseno");
    assert.equal(slugifyAccountId("Work Shared"), "work-shared");
    assert.throws(
      () => assertLabelNamesNoLogin("Work alice@corp.com"),
      AccountError,
      "labels must not hardcode a login",
    );

    try {
      // Add: id derived from the label, config dir created, ambient account
      // persisted alongside so it stays addressable.
      const teamDir = join(SMOKE_XDG, "claude-team");
      const added = addAccount({ label: "Team Rocket", configDir: teamDir });
      assert.equal(added.id, "team-rocket");
      assert.equal(added.configDir, teamDir);
      resetAccounts();
      assert.equal(isMultiAccount(), true);
      assert.ok(findAccount("team-rocket"));
      assert.ok(findAccount("default"), "ambient account persisted");

      // A scoped account pins CLAUDE_CONFIG_DIR and drops the ambient env
      // token (the CLI would prefer it over the account's credential file).
      const scoped = applyAccountEnv(requireAccount("team-rocket"), {
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "ambient-token",
      });
      assert.equal(scoped.CLAUDE_CONFIG_DIR, teamDir);
      assert.equal(scoped.CLAUDE_CODE_OAUTH_TOKEN, undefined);

      // Duplicate config dir refused — one Claude home per account.
      assert.throws(
        () => addAccount({ label: "Impostor", configDir: teamDir }),
        AccountError,
      );
      // Email in a label refused at add time too.
      assert.throws(
        () => addAccount({ label: "x alice@corp.com" }),
        AccountError,
      );

      // Rename with id migration: every per-account store must be carried.
      let migrated: [string, string, string] | null = null;
      const renamed = renameAccount("team-rocket", "Team", {
        newId: "team",
        migrate: (oldId, newId, label) => {
          migrated = [oldId, newId, label];
        },
      });
      assert.equal(renamed.id, "team");
      assert.equal(renamed.label, "Team");
      assert.deepEqual(migrated, ["team-rocket", "team", "Team"]);

      setDefaultAccount("team");
      resetAccounts();
      assert.equal(getDefaultAccount().id, "team");

      // Removing an account that still owns conversations requires force.
      bindConversationAccount("smoke-registry-bound", "team", "Team");
      assert.throws(() => removeAccount("team"), AccountError);
      removeAccount("default", false);
      resetAccounts();
      assert.equal(getAccounts().length, 1);
      assert.throws(
        () => removeAccount("team"),
        AccountError,
        "cannot remove the only account",
      );
      clearForeignSessionId("smoke-registry-bound");

      // Env-configured rosters are read-only: mutations would write a file
      // the env override shadows, so they are refused loudly.
      process.env.OPENCODE_CLAUDE_ACCOUNTS = "solo:Solo";
      resetAccounts();
      assert.throws(() => addAccount({ label: "Nope" }), AccountError);
      assert.throws(() => setDefaultAccount("solo"), AccountError);
    } finally {
      delete process.env.OPENCODE_CLAUDE_ACCOUNTS;
      rmSync(getAccountsFilePath(), { force: true });
      resetAccounts();
    }
  }

  // ---- Multi-account routing through the proxy (mocked Agent SDK) ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const { resetAccounts } = await import("../src/accounts.ts");
    const { recordRateLimitErrorText } = await import("../src/rate-limit.ts");
    const {
      bindConversationAccount,
      getSessionBinding,
      clearForeignSessionId,
    } = await import("../src/session-store.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const tmpRoot = mkdtempSync(joinPath(tmpdir(), "oc-claude-acct-"));
    const workDir = joinPath(tmpRoot, "work");
    const personalDir = joinPath(tmpRoot, "personal");
    const prevRateStore = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = joinPath(
      tmpRoot,
      "rate-limit.json",
    );
    process.env.OPENCODE_CLAUDE_ACCOUNTS = `work:Work:${workDir},personal:Personal:${personalDir}`;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-shell-token";
    resetAccounts();

    const seen = { params: null as Record<string, unknown> | null };
    const mockOk = () => {
      setClaudeQueryStarter(async (params) => {
        seen.params = params as unknown as Record<string, unknown>;
        return {
          stream: (async function* () {
            yield { type: "system", subtype: "init", session_id: "acct-sess" };
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "ACCT_OK" },
              },
            };
            yield {
              type: "result",
              is_error: false,
              usage: { input_tokens: 5, output_tokens: 2 },
            };
          })(),
          interrupt: async () => {},
          close: () => {},
          getPid: () => null,
        };
      });
    };

    const postChat = (
      sessionHeader: string,
      model: string,
      messages: unknown[] = [{ role: "user", content: "hi" }],
    ) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({ model, stream: false, messages }),
      });

    try {
      // Explicit account in the model id → that account's Claude home, and
      // the ambient env token is dropped so the CLI cannot prefer it.
      mockOk();
      const workRes = await postChat("acct-conv-1", "claude-code/sonnet@work");
      assert.equal(workRes.status, 200);
      assert.equal(
        workRes.headers.get("x-opencode-claude-account"),
        "work",
        "account echoed on the response",
      );
      await workRes.text();
      const workEnv = seen.params!.env as Record<string, string | undefined>;
      assert.equal(workEnv.CLAUDE_CONFIG_DIR, workDir);
      assert.equal(workEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(seen.params!.model, "sonnet", "account suffix stripped");

      // Sticky binding: the follow-up carries NO account — it must stay on
      // the bound one, not drift to the default.
      const binding1 = getSessionBinding("acct-conv-1");
      assert.equal(binding1?.accountId, "work");
      mockOk();
      const stickyRes = await postChat("acct-conv-1", "sonnet");
      assert.equal(stickyRes.status, 200);
      await stickyRes.text();
      assert.equal(
        (seen.params!.env as Record<string, string | undefined>)
          .CLAUDE_CONFIG_DIR,
        workDir,
        "session stays on its bound account",
      );

      // Unknown account ids are REJECTED, never silently rerouted.
      const unknownRes = await postChat("acct-conv-2", "sonnet@nope");
      assert.equal(unknownRes.status, 400);
      const unknownJson = (await unknownRes.json()) as {
        error?: { message?: string };
      };
      assert.match(unknownJson.error?.message ?? "", /unknown Claude account/);
      assert.match(unknownJson.error?.message ?? "", /work, personal/);

      // Model catalog: default account keeps bare ids; others get @suffix,
      // and every name carries its account label.
      const catalogRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
      const catalog = (await catalogRes.json()) as {
        data: Array<{ id: string }>;
      };
      const ids = catalog.data.map((m) => m.id);
      assert.ok(ids.includes("sonnet"), "default account keeps bare ids");
      assert.ok(ids.includes("sonnet@personal"), "other accounts get @suffix");
      const { getClaudeModels } = await import("../src/models.ts");
      const named = getClaudeModels();
      assert.ok(named.some((m) => m.name.includes("(Work)")));
      assert.ok(named.some((m) => m.name.includes("(Personal)")));

      // Selection header with an account rides through end to end.
      mockOk();
      const headerRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "acct-conv-3",
            "x-opencode-claude-effort": encodeClaudeModelSelection({
              modelId: "opus",
              effort: "high",
              account: "personal",
            }),
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: false,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      assert.equal(headerRes.status, 200);
      assert.equal(headerRes.headers.get("x-opencode-claude-account"), "personal");
      await headerRes.text();
      assert.equal(
        (seen.params!.env as Record<string, string | undefined>)
          .CLAUDE_CONFIG_DIR,
        personalDir,
      );
      assert.equal(seen.params!.model, "opus");
      assert.equal(seen.params!.effort, "high");

      // Removed account: the stored binding is repaired onto the default
      // account, the dead resume target is cleared, and the next turn starts
      // FRESH (no history transfer nobody asked to pay for).
      bindConversationAccount("acct-conv-gone", "gone", "Gone");
      mockOk();
      const reboundRes = await postChat("acct-conv-gone", "sonnet", [
        { role: "user", content: "remember AXIOM-9042" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "next question" },
      ]);
      assert.equal(reboundRes.status, 200);
      await reboundRes.text();
      assert.equal(
        (seen.params!.env as Record<string, string | undefined>)
          .CLAUDE_CONFIG_DIR,
        workDir,
        "repaired binding lands on the default account",
      );
      assert.doesNotMatch(
        String(seen.params!.prompt ?? ""),
        /<conversation_history>/,
        "machinery rebinds skip the history transfer",
      );
      const repaired = getSessionBinding("acct-conv-gone");
      assert.equal(repaired?.accountId, "work");
      assert.equal(repaired?.rebound, undefined, "rebound absorbed by the turn");

      // Operator moves a session between accounts: resume target cleared,
      // next turn transfers history into the NEW account.
      const moveRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent("acct-conv-1")}/account`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ account: "personal" }),
        },
      );
      assert.equal(moveRes.status, 200);
      mockOk();
      const movedTurn = await postChat("acct-conv-1", "sonnet", [
        { role: "user", content: "remember AXIOM-9042" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "what was it?" },
      ]);
      assert.equal(movedTurn.status, 200);
      await movedTurn.text();
      assert.equal(
        (seen.params!.env as Record<string, string | undefined>)
          .CLAUDE_CONFIG_DIR,
        personalDir,
        "moved session runs on the new account",
      );
      assert.equal(seen.params!.resume, undefined);
      assert.match(
        String(seen.params!.prompt ?? ""),
        /<conversation_history>/,
        "operator moves DO transfer history",
      );

      // Read-only account/quota/usage/session endpoints.
      const accountsRes = await fetch(`http://127.0.0.1:${port}/accounts`);
      assert.equal(accountsRes.status, 200);
      const accountsJson = (await accountsRes.json()) as {
        multiAccount?: boolean;
        data?: Array<{ id: string; sessions: number; quotaSummary?: unknown }>;
      };
      assert.equal(accountsJson.multiAccount, true);
      assert.deepEqual(
        accountsJson.data?.map((a) => a.id).sort(),
        ["personal", "work"],
      );
      const quotaRes = await fetch(`http://127.0.0.1:${port}/quota`);
      assert.equal(quotaRes.status, 200);
      const usageRes = await fetch(`http://127.0.0.1:${port}/usage`);
      assert.equal(usageRes.status, 200);
      const usageJson = (await usageRes.json()) as {
        accounts?: Record<string, { turns?: number }>;
      };
      assert.ok(
        (usageJson.accounts?.work?.turns ?? 0) >= 1,
        "turn usage recorded per account",
      );
      const sessionsRes = await fetch(
        `http://127.0.0.1:${port}/sessions?account=personal`,
      );
      const sessionsJson = (await sessionsRes.json()) as {
        data?: Array<{ conversationKey: string; account: string }>;
      };
      assert.ok(
        sessionsJson.data?.some((s) => s.conversationKey === "acct-conv-1"),
        "moved session listed under its new account",
      );

      // Per-account limits: work hits its window; personal keeps working.
      recordRateLimitErrorText(
        "You've hit your usage limit · resets at 2099-01-02T03:04:05Z",
        "work",
      );
      const gatedRes = await postChat("acct-conv-4", "sonnet@work");
      assert.equal(gatedRes.status, 429, "limited account fails fast");
      assert.equal(gatedRes.headers.get("x-opencode-claude-account"), "work");
      mockOk();
      const freeRes = await postChat("acct-conv-3", "sonnet@personal");
      assert.equal(
        freeRes.status,
        200,
        "an unrelated account must not be gated",
      );
      await freeRes.text();

      // Meta title on the LIMITED account → local fallback, zero API calls.
      const metaLocal = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "haiku@work",
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "You are a title generator. Generate a brief title. Output only the title.",
              },
              { role: "user", content: "Refactor the billing module" },
            ],
          }),
        },
      );
      assert.equal(metaLocal.status, 200);
      const metaLocalJson = (await metaLocal.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      assert.equal(
        metaLocalJson.choices?.[0]?.message?.content,
        "Refactor the billing module",
      );

      // Health and rate-limit are account-scoped on demand.
      const healthWork = await fetch(
        `http://127.0.0.1:${port}/health?account=work`,
      );
      const healthWorkJson = (await healthWork.json()) as {
        account?: string;
        rateLimit?: { limited?: boolean };
      };
      assert.equal(healthWorkJson.account, "work");
      assert.equal(healthWorkJson.rateLimit?.limited, true);
      const healthUnknown = await fetch(
        `http://127.0.0.1:${port}/health?account=nope`,
      );
      assert.equal(healthUnknown.status, 404);

      // Mutations under an env-configured roster are refused (409) — and
      // cross-origin browser requests are refused regardless (403).
      const envMutation = await fetch(`http://127.0.0.1:${port}/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Nope" }),
      });
      assert.equal(envMutation.status, 409);
      const crossOrigin = await fetch(`http://127.0.0.1:${port}/accounts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example",
        },
        body: JSON.stringify({ label: "Evil" }),
      });
      assert.equal(crossOrigin.status, 403);

      clearForeignSessionId("acct-conv-1");
      clearForeignSessionId("acct-conv-3");
      clearForeignSessionId("acct-conv-gone");
    } finally {
      setClaudeQueryStarter(null);
      delete process.env.OPENCODE_CLAUDE_ACCOUNTS;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (prevRateStore === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = prevRateStore;
      }
      resetAccounts();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ---- Control panel + management tools ----
  {
    const panelRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(panelRes.status, 200);
    assert.match(panelRes.headers.get("content-type") ?? "", /text\/html/);
    const panelHtml = await panelRes.text();
    assert.match(panelHtml, /opencode-claude/);
    assert.doesNotMatch(
      panelHtml,
      /src="http|href="http/,
      "panel must be self-contained (no external assets)",
    );

    // Reverse-proxy prefix lands in <base>; garbage prefixes are ignored.
    const prefixed = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "x-forwarded-prefix": "/claude" },
    });
    assert.match(await prefixed.text(), /<base href="\/claude\/">/);
    const { basePathFromPrefix } = await import("../src/panel.ts");
    assert.equal(basePathFromPrefix('/x"><script>'), "/");
    assert.equal(basePathFromPrefix("not-a-path"), "/");
    assert.equal(basePathFromPrefix(null), "/");

    // Kill switch.
    process.env.OPENCODE_CLAUDE_PANEL = "0";
    const disabled = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(disabled.status, 404);
    delete process.env.OPENCODE_CLAUDE_PANEL;

    // Tools: registered by default, removable via env, and the read tool
    // reports the roster without any Claude turn.
    const { buildClaudeTools, claudeToolsEnabled } = await import(
      "../src/tools.ts"
    );
    assert.equal(claudeToolsEnabled(), true);
    const tools = buildClaudeTools();
    assert.deepEqual(Object.keys(tools).sort(), [
      "claude_account_manage",
      "claude_accounts",
    ]);
    process.env.OPENCODE_CLAUDE_TOOLS = "0";
    assert.deepEqual(buildClaudeTools(), {});
    delete process.env.OPENCODE_CLAUDE_TOOLS;

    const listResult = (await tools.claude_accounts!.execute(
      {} as never,
      {} as never,
    )) as { title?: string; output?: string };
    assert.match(listResult.output ?? "", /"accounts"/);
    assert.match(listResult.output ?? "", /"default"/);

    const badAction = (await tools.claude_account_manage!.execute(
      { action: "remove", account: "does-not-exist" } as never,
      {} as never,
    )) as { output?: string };
    assert.match(badAction.output ?? "", /unknown account/);

    // Add + remove through the tool (file-managed registry).
    const { getAccountsFilePath, resetAccounts } = await import(
      "../src/accounts.ts"
    );
    const { rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    try {
      const addResult = (await tools.claude_account_manage!.execute(
        {
          action: "add",
          label: "Tool Made",
          configDir: join(SMOKE_XDG, "claude-tool-made"),
        } as never,
        {} as never,
      )) as { output?: string };
      assert.match(addResult.output ?? "", /claude auth login/);
      assert.match(addResult.output ?? "", /tool-made/);
      const removeResult = (await tools.claude_account_manage!.execute(
        { action: "remove", account: "tool-made" } as never,
        {} as never,
      )) as { output?: string };
      assert.match(removeResult.output ?? "", /"removed"/);
    } finally {
      rmSync(getAccountsFilePath(), { force: true });
      resetAccounts();
    }
  }

  await stopProxy();

  // Nothing during the run may have escaped into the operator's real stores;
  // drop the throwaway XDG home.
  rmTree(SMOKE_XDG, { recursive: true, force: true });

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
