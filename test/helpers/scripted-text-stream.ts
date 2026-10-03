export interface RecordedStreamOptions {
  apiKey?: string;
  env?: Record<string, string>;
  headers?: Record<string, string | null>;
  reasoning?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export interface RecordedStreamCall {
  context: { messages: unknown; systemPrompt?: string };
  model: { api?: string };
  options: RecordedStreamOptions;
}

export const scriptedTextStream = (text: string) => ({
  async *[Symbol.asyncIterator]() {
    yield { delta: text, type: "text_delta" };
  },
  result: () =>
    Promise.resolve({
      content: [{ text, type: "text" }],
      role: "assistant",
      stopReason: "stop",
    }),
});

export const recordingStream =
  (text: string, calls: RecordedStreamCall[]) =>
  (
    model: RecordedStreamCall["model"],
    context: RecordedStreamCall["context"],
    options?: RecordedStreamOptions
  ) => {
    calls.push({
      context,
      model,
      options: options ?? {},
    });
    return scriptedTextStream(text);
  };
