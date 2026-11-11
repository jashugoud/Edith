# Edith - your personal AI (phone app)

A chat + voice assistant that installs on your phone. You connect it to the AI "brain" you want.

## 1. Put it online (needs HTTPS, takes ~2 minutes)
Pick one:
- **Netlify Drop**: go to app.netlify.com/drop and drag this unzipped folder onto the page. You get an https link.
- **Cloudflare Pages / GitHub Pages**: upload the folder as a static site.

## 2. Install on your phone
Open the link in **Chrome on Android**, tap the menu (three dots), then **Add to Home screen / Install app**. Edith opens full screen like a normal app.

## 3. Get a real APK (optional)
Go to **pwabuilder.com**, paste your https link, choose **Android**, and download the APK. Install it on your phone (allow "install unknown apps" when asked).

## 4. Connect a brain (tap the gear icon)
| Brain | What you need |
|---|---|
| Claude (Anthropic) | API key from console.anthropic.com. This is separate from a claude.ai subscription. |
| OpenAI (ChatGPT) | API key from platform.openai.com |
| Google Gemini | API key from aistudio.google.com |
| Groq | Free API key from console.groq.com |
| OpenRouter | One key from openrouter.ai that reaches many models |
| Ollama on my PC | Ollama running with `OLLAMA_ORIGINS=*`, reachable from your phone over HTTPS |
| Custom | Any OpenAI-compatible URL ending in /v1 (for example your own OpenJarvis server) |

Press **Test** in Settings to check the connection before saving.

## Voice
- **Phone's built-in voice** works with no setup.
- **Cartesia**: enter your Cartesia key and a voice ID.
- **My Edith voice server**: run the `pal-voice-api` folder on your PC and enter its https URL.
- The mic button uses Chrome's speech recognition.

## Notes
- Keys are stored only on your phone and sent only to the provider you choose. Don't share the hosted link with your keys saved in a shared browser.
- A page served over HTTPS can't call a plain `http://` address on your home network. For Ollama or the voice server on your PC, use an HTTPS tunnel (for example Cloudflare Tunnel or Tailscale Funnel).
