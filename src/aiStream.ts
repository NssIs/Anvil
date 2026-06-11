import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Live AI output: the backend tags raw model deltas with a stream id and emits
// them as `ai-stream` events while the request is still running. One global
// listener fans them out to whichever panel started the request.

type AiStreamPayload = { id: string; delta: string };

const handlers = new Map<string, (delta: string) => void>();
let globalListener: Promise<UnlistenFn> | null = null;
let streamSeq = 0;

export const newAiStreamId = () =>
  `ai-${Date.now().toString(36)}-${(streamSeq += 1)}`;

const ensureListener = () => {
  if (!globalListener) {
    globalListener = listen<AiStreamPayload>("ai-stream", (event) => {
      handlers.get(event.payload.id)?.(event.payload.delta);
    });
  }
  return globalListener;
};

/** Subscribe to one stream's deltas. Returns an unsubscribe function. */
export const onAiStream = (id: string, handler: (delta: string) => void) => {
  handlers.set(id, handler);
  // Browser preview has no Tauri event system — the panel just falls back to
  // the non-streaming experience.
  void ensureListener().catch(() => {});
  return () => {
    handlers.delete(id);
  };
};
