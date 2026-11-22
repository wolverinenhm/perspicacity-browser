# Changelog

## 0.2.0

- **More agent models.** Besides Ollama and Claude, the agent can now use LM Studio (local), OpenAI, Google Gemini, DeepSeek, Kimi (Moonshot AI), Qwen (Alibaba Cloud Model Studio), Mistral, xAI Grok, GLM (Zhipu / Z.ai), Groq, Together AI, OpenRouter, and any other OpenAI-compatible API.
- Settings: pick a provider, set the model, endpoint and API key per provider, and use **List models** to see which models your key can use. Each provider keeps its own key, encrypted with the OS keystore.
- The agent requests structured JSON in the strongest form each provider supports and falls back automatically when a model does not support it.
- Clearer errors when a provider cannot be reached, rejects the key, or does not know the model.
- Settings and the Anthropic key from 0.1.x carry over.
- Android: version bump only. The agent is a desktop feature.

## 0.1.0

- First release: Windows installer and portable build, Android APKs, Tor bundled, VEIL and SHADOW planes, approval-gated agent with Ollama or Claude.
