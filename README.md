# Gemini BYOK Chat

A simple, polished, single-page chat app for Google Gemini — **bring your own key (BYOK)**. No backend, no build step, no account, no analytics.

Open the site, paste your own free Google AI Studio API key once, and chat. Your key stays in your browser's `localStorage` only.

**Live site:** https://armoulingpt.github.io/gemini-byok-chat/
**Repo:** https://github.com/armoulingpt/gemini-byok-chat

## What it does

- **Text chat** — multi-turn conversation with streaming replies, markdown rendering, fenced code blocks with a copy button, and a Stop button.
- **Model picker, loaded live** — the model list comes from `GET https://generativelanguage.googleapis.com/v1beta/models?key=...`, paginated via `nextPageToken`, keeping only models whose `supportedGenerationMethods` include `generateContent`.
- **Image generation** — describe an image; it is made with `gemini-2.5-flash-image` (Nano Banana) via `generateContent` with `responseModalities: ["TEXT", "IMAGE"]`. Returned `inlineData` image parts are decoded and shown inline, with a download button, and kept in the conversation history.
- **Image editing / restyling** — attach an image and an instruction ("remove the background", "make it a watercolour"). The same `gemini-2.5-flash-image` model returns the edited image.
- **Agent mode** — editable system prompt + temperature, saved in the browser, with presets: Assistant, Coder, Image editor.
- **Light / dark mode**, mobile-responsive layout, conversation export to Markdown, clear-chat.

## How to get a free Gemini key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key**.
3. Paste it into the "Your Gemini API key" box on the site and click **Save key**.
4. The model list loads automatically. Pick a model and start chatting.

The free tier has rate limits; if you hit them you will see the error returned by Google (often HTTP 429). Image generation with `gemini-2.5-flash-image` is billed per image on paid tiers — check the current pricing in AI Studio before heavy use.

## Run it locally

No build step. Serve the folder with any static server, for example:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser (all API calls are made from the page, so a local server is the reliable option).

Files: `index.html`, `styles.css`, `app.js` — plus this README. That's the whole app.

## How image gen / edit works

- Both use `POST /v1beta/models/gemini-2.5-flash-image:generateContent?key=...` with `generationConfig.responseModalities: ["TEXT", "IMAGE"]`.
- Generation sends one text part (your prompt).
- Editing sends the attached image as an `inlineData` part (its MIME type + base64 data) plus your instruction as a text part.
- The response's `candidates[0].content.parts` are scanned for `inlineData` parts with an `image/*` MIME type; each is turned into a `data:` URL and shown inline.

### Free fallback (generation only)

If Gemini cannot return an image for your key (HTTP 403 / 404 / 429), the app offers a clearly labelled keyless fallback: [Pollinations](https://image.pollinations.ai/) — `https://image.pollinations.ai/prompt/<encoded prompt>?width=1024&height=1024&nologo=true`. It is **not** Gemini, and it is only offered when you click the fallback button. Image **editing** has no fallback: it needs Gemini, and the app says so plainly when it fails.

## Security / privacy

- The API key is stored only in `localStorage` in your browser. It is sent only to Google's Generative Language API (as the `key` query parameter, which is how that API authenticates). It is never written to disk, a repo, a URL you share, or the console.
- **Warning, shown in the app too:** a BYOK key in a browser is visible to anyone using that browser. Don't use this on a shared computer. Use **Forget key** when you're done.
- Model output is HTML-escaped before it is inserted into the page, so model text cannot inject markup or scripts.
- The only external calls are to Google's Generative Language API and, only if you choose the fallback, to Pollinations. No analytics, no telemetry, no third-party logging.

## Known limits

- Acceptance items 3–5 (streaming chat, image generation, image edit) need a real Gemini key and cannot be verified without one; the deployed site itself was verified to load and render, and the API calls follow Google's documented request/response shapes.
- `gemini-2.5-flash-image` availability and pricing depend on your key's tier/region; if it returns 403/404, use the Pollinations fallback for generation or check the model in AI Studio.
- Chat history (including images) is kept in `localStorage`; if it gets too large the browser may refuse to save it, in which case the app keeps the current session in memory and saves a text-only copy.
- Streaming uses `streamGenerateContent?alt=sse`; if a network/proxy strips SSE, you will see an error rather than a partial reply.
