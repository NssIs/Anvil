// Shared helpers for turning raw model output into a clean reply. Both AI
// panels (Resource Pack and Shader) speak the same JSON protocol, and models
// wrap that JSON in all kinds of noise: <think> scratchpads, code fences,
// schema examples quoted mid-reasoning, or the object emitted twice.

export type AiJsonMatch<T> = { result: T; start: number; end: number };

// Pull a <think>…</think> (or <thinking>…</thinking>) block out of a raw model
// reply so reasoning models' scratchpad can be shown separately and stripped
// from the visible answer. Handles an unclosed opening tag too.
export const extractAiThinking = (raw: string): { thinking: string; rest: string } => {
  const closed = raw.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  if (closed) {
    const start = closed.index ?? 0;
    const rest = (raw.slice(0, start) + raw.slice(start + closed[0].length)).trim();
    return { thinking: closed[1].trim(), rest };
  }
  const open = raw.match(/<think(?:ing)?>([\s\S]*)$/i);
  if (open) {
    return { thinking: open[1].trim(), rest: raw.slice(0, open.index ?? 0).trim() };
  }
  return { thinking: "", rest: raw };
};

// Scan for every balanced (string-aware) {...} block and return the JSON one
// that looks like our schema. Models often emit a schema EXAMPLE early in their
// reasoning and the REAL answer last — naive indexOf("{")…lastIndexOf("}")
// spans both and fails to parse, dumping the whole reasoning as the reply.
export const findAiJson = <T extends object>(text: string, shapeKeys: string[]): AiJsonMatch<T> | null => {
  const matches: AiJsonMatch<T>[] = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;

        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(i, j + 1)) as T;
            if (parsed && typeof parsed === "object") {
              matches.push({ result: parsed, start: i, end: j + 1 });
            }
          } catch {
            // Not JSON — keep scanning.
          }
          i = j; // resume after this block
          break;
        }
      }
    }
  }

  if (!matches.length) {
    return null;
  }

  const shaped = matches.filter((match) => shapeKeys.some((key) => key in match.result));
  return (shaped.length ? shaped[shaped.length - 1] : matches[matches.length - 1]) ?? null;
};

// Turn a raw model response into a clean reply + the reasoning to fold away.
export const parseAiReply = <T extends { reply?: string; message?: string }>(
  raw: string,
  shapeKeys: string[],
): { result: T | null; reply: string; thinking: string } => {
  const { thinking: tagged, rest } = extractAiThinking(raw);
  const found = findAiJson<T>(rest, shapeKeys);

  if (found) {
    const reply = found.result.reply?.trim() || found.result.message?.trim() || "Done.";
    // Any prose surrounding the JSON object is the model's reasoning — hide it.
    const prose = (rest.slice(0, found.start) + rest.slice(found.end)).trim();
    const thinking = [tagged, prose].filter(Boolean).join("\n\n");
    return { result: found.result, reply, thinking };
  }

  return { result: null, reply: rest.trim() || "Done.", thinking: tagged };
};
