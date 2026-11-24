import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { KEY_MAX, cleanKey, freeKey, isKey } from "./project-key";

// A project key suggested by Claude from the project's name and justification. A rule can make
// a key from a name (./project-key.ts), but it cannot tell which word in "Automate generation
// of electrical schematics" is the one people will say: a model can, and gives SCHEM.
//
// It is a suggestion and nothing depends on it. No key configured, a slow answer, a refusal or
// an answer that is not a usable key all come back as null, and the form keeps the rule's key.
//
// Settings (.env): TRACKER_AI_API_KEY, the tracker's own key so its spend is seen on its own;
// TRACKER_AI_MODEL, optional, to run it on a different model.

const DEFAULT_MODEL = "claude-opus-5-5";
/** Long enough for a short answer, short enough that nobody waits on a suggestion. */
const TIMEOUT_MS = 8_000;

const SYSTEM = `You choose the short code for an internal project at a company that builds custom automation equipment.
The code appears in the project's web address and in front of every task number, like VISION-12, so people say it and type it often.

Rules for the code:
- 2 to ${KEY_MAX} characters, capital letters and digits only, starting with a letter.
- Readable and easy to say: a real word or a clear shortening of the project's main subject (SCHEM for electrical schematics, OPENPO for the open purchase orders page), not a string of initials unless the project is known by them (PLC, HMI, SSO).
- Name the subject, not the activity: avoid generic words such as AUTO, PROJECT, NEW, FIX, DATA or TOOL on their own.
- It must not be one of the codes already in use.

Reply with the code alone: no explanation, no punctuation, no quotes.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic | null {
  const apiKey = process.env.TRACKER_AI_API_KEY?.trim();
  if (!apiKey) return null;
  // No retries: a suggestion that needs a second try has already taken too long to be one.
  client ??= new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  return client;
}

/** True when a key is set, so the form can say where a suggestion came from. */
export function keySuggestionConfigured(): boolean {
  return Boolean(process.env.TRACKER_AI_API_KEY?.trim());
}

/**
 * Claude's suggestion for a project's key, already checked: well formed and not taken. Null
 * when there is none to give, for any reason. Never throws.
 */
export async function suggestProjectKey(input: {
  name: string;
  justification: string;
  taken: string[];
}): Promise<string | null> {
  const api = anthropic();
  const name = input.name.trim();
  if (!api || !name) return null;
  try {
    const response = await api.beta.messages.create({
      // If the model declines, the API reruns the request on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      model: process.env.TRACKER_AI_MODEL?.trim() || DEFAULT_MODEL,
      // Thinking is always on for this model and counts against this; the answer is one word.
      max_tokens: 2000,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `Project name: ${name.slice(0, 200)}`,
            input.justification.trim() ? `Why it is being done: ${input.justification.trim().slice(0, 1000)}` : null,
            `Codes already in use: ${input.taken.length ? input.taken.join(", ") : "none"}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
    // A refusal, or an answer cut short, is not an answer.
    if (response.stop_reason !== "end_turn") return null;
    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") return null;
    const key = cleanKey(text.text.trim().split(/\s+/)[0] ?? "");
    if (!isKey(key)) return null;
    return freeKey(key, input.taken);
  } catch (error) {
    // Recorded for whoever runs the server; the person creating a project sees the rule's key.
    if (error instanceof Anthropic.APIError) {
      console.warn(`[tracker] key suggestion failed: ${error.status ?? "no status"} ${error.name}`);
    } else {
      console.warn("[tracker] key suggestion failed", error instanceof Error ? error.name : "unknown error");
    }
    return null;
  }
}
