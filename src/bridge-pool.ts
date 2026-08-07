/**
 * Parked Claude Agent SDK turns waiting for OpenCode tool results
 * (Cursor bridge-pool pattern).
 */
import type { ClaudeQueryHandle } from "./query.js";

export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
};

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  handle: ClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  createdAt: number;
  /** Continues consuming the SDK stream after tools resolve. */
  continueStream?: () => AsyncGenerator<unknown, void, unknown>;
};

const bridges = new Map<string, ParkedBridge>();

export function putBridge(bridge: ParkedBridge): void {
  bridges.set(bridge.id, bridge);
}

export function getBridge(id: string): ParkedBridge | undefined {
  return bridges.get(id);
}

export function findBridgeByConversation(
  conversationKey: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.conversationKey === conversationKey) return bridge;
  }
  return undefined;
}

export function deleteBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  for (const tool of bridge.pendingTools.values()) {
    tool.reject(new Error("Bridge closed"));
  }
  bridge.handle.close();
  bridges.delete(id);
}

export function clearAllBridges(): void {
  for (const id of [...bridges.keys()]) {
    deleteBridge(id);
  }
}
