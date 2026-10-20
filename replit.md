# SafeGPT

Bilingual (Arabic/English) AI Health & Safety assistant for construction sites.

## Stack
- **Framework**: Expo / React Native (TypeScript)
- **Routing**: Expo Router (file-based)
- **Package manager**: pnpm (v10)
- **Port**: 5000 (dev), served via `safegpt/server/serve.js` in production

## Workflow
Install the app's locked dependencies after a fresh import:
```
cd safegpt && pnpm install --frozen-lockfile
```

Then use the **Run** button, or run:
```
cd safegpt && PORT=5000 pnpm run dev
```

## Deployment
- Build: `cd safegpt && pnpm run build`
- Run: `cd safegpt && node server/serve.js`

## Key Services (`safegpt/services/`)
| File | Purpose |
|---|---|
| `aiService.ts` | Main AI orchestrator — model fallback chain, RAG injection, confidence check, web search fallback |
| `webSearchService.ts` | Web search — Serper API (primary) + DuckDuckGo JSON (fallback) |
| `ragService.ts` | PDF/DOC parsing, chunking, indexing |
| `smartRetriever.ts` | Structural + semantic RAG retrieval |
| `queryClassifier.ts` | Detects article/chapter/section queries |
| `ttsService.ts` | TTS via Web Speech API (SpeechSynthesis) |
| `secureKeys.ts` | Bootstrap default API keys (base64-encoded) |

## Key Context
- `safegpt/context/AppContext.tsx` — global state, `ApiKeys` interface
- `safegpt/app/(tabs)/settings.tsx` — API key management, model status

## AI Model Fallback Order
1. Groq (GPT-OSS 120B → Llama 3.3 70B → Llama 3.1 8B)
2. OpenRouter (Hermes 405B → Llama 3.3 70B → Qwen3 Plus)
3. Local via ngrok (Llama 3.1 8B)
4. NVIDIA (Llama 3.3 70B)

Vision: Gemini 2.5 Flash → OpenRouter Gemini → OpenRouter Qwen2.5 VL → Local Llama 3.2 Vision

## Web Search Fallback
- Triggered when model returns a low-confidence response (detected via keyword heuristic)
- **Vercel API**: Serper API (`google.serper.dev`) reads `SERPER_API_KEYS` on the server only. Do not use a browser-prefixed key variable.
- **Fallback**: DuckDuckGo Instant Answer JSON API (no key needed)
- On search hit: re-generates answer via best available model with search context injected

## API Keys (user-configured in Settings)
- `groqApiKey`, `openrouterApiKey`, `geminiApiKey`
- `nvidiaApiKey`, `nvidiaVisionApiKey`, `nvidiaTtsApiKey`, `nvidiaSttApiKey`
- `ngrokUrl` (local Ollama via ngrok)
- `serperApiKey` (web search fallback)

## Emergency API
- The web deployment uses the root `api/emergency.ts` serverless handler, not an Expo API route.
- It requires the existing server-verified SafeGPT session and reads provider keys only from server environment variables: `CEREBRAS_API_KEY(S)`, `GROQ_API_KEY(S)`, `OPENROUTER_API_KEY(S)`, and `GEMINI_API_KEY(S)`. Numbered `_API_KEY_1` … `_API_KEY_50` variables are also supported.
- The emergency handler does not use Tavily. Keep provider credentials out of app settings and browser requests for this endpoint.
- Run the HTTP-level emergency route tests with `cd safegpt && node --test tests/emergency-api.test.cjs`.

## Notable Fixes Applied
- Removed `piper-wasm` → replaced with browser Web Speech API (`SpeechSynthesis`)
- Fixed PDF hex decoding for CIDFont/UTF-16 PDFs in `ragService.ts`
- Fixed delete confirmation dialog in `documents.tsx`
