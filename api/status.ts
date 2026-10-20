import { getKeyPool, json, methodNotAllowed } from "./_utils";
import { requireSession } from "./_auth";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireSession(req, res))) return;
  return json(res, 200, {
    groq:        getKeyPool("groq").length > 0,
    openrouter:  getKeyPool("openrouter").length > 0,
    gemini:      getKeyPool("gemini").length > 0,
    nvidia:      getKeyPool("nvidia").length > 0,
    cerebras:    getKeyPool("cerebras").length > 0,
    serper:      getKeyPool("serper").length > 0,
  });
}
