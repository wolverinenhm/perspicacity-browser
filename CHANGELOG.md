# Changelog

## 0.3.0

- **The agent on Android.** Open a Shadow tab (long-press **+**, or menu → New Shadow tab), tap the amber **✦** button, describe a task and tap **Run**. Typing, navigating and clicking each wait for your **Allow once** in the panel; clicks can be pre-approved for the current site.
- Same models as Windows: Ollama and LM Studio (on your network), Claude, OpenAI, Google Gemini, DeepSeek, Kimi, Qwen, Mistral, xAI Grok, GLM, Groq, Together AI, OpenRouter, and any OpenAI-compatible API. Menu → Agent model sets the provider, model, endpoint and key, with **List models**.
- API keys are encrypted with an AES-256 key held in the Android Keystore (hardware-backed where the phone has it). Backups stay disabled.
- Android now keeps the HMAC-chained audit ledger too (menu → Audit ledger verifies it).
- Shadow tabs keep their own persistent storage, separate from VEIL tabs, and survive New Identity. They need an Android System WebView with multi-profile support.
- Desktop: version bump only.

## 0.2.0

- **More agent models.** Besides Ollama and Claude, the agent can now use LM Studio (local), OpenAI, Google Gemini, DeepSeek, Kimi (Moonshot AI), Qwen (Alibaba Cloud Model Studio), Mistral, xAI Grok, GLM (Zhipu / Z.ai), Groq, Together AI, OpenRouter, and any other OpenAI-compatible API.
- Settings: pick a provider, set the model, endpoint and API key per provider, and use **List models** to see which models your key can use. Each provider keeps its own key, encrypted with the OS keystore.
- The agent requests structured JSON in the strongest form each provider supports and falls back automatically when a model does not support it.
- Clearer errors when a provider cannot be reached, rejects the key, or does not know the model.
- Settings and the Anthropic key from 0.1.x carry over.
- Android: version bump only. The agent is a desktop feature.

## 0.1.0

- First release: Windows installer and portable build, Android APKs, Tor bundled, VEIL and SHADOW planes, approval-gated agent with Ollama or Claude.
