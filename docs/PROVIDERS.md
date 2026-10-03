# Model providers and costs

Huddle has no paid-provider presets and never silently falls back to a paid service.

## NVIDIA Build

NVIDIA describes free developer access to hosted NIM endpoints **for prototyping**. This is not a promise of unlimited inference or a permanent free production service. Quotas, model availability, licenses, and terms depend on the account and model. Check the current NVIDIA catalog and account before use. A key is required for calls outside the catalog playground.

- [NVIDIA access and pricing context](https://docs.api.nvidia.com/nim/docs/run-anywhere)
- [Official API catalog quickstart](https://docs.api.nvidia.com/nim/re/docs/api-quickstart)
- [Model catalog](https://build.nvidia.com/)

Huddle sends group context to the selected provider when a live run is started. Do not include sensitive information unless you are authorized to share it with that provider. Use your own key; never publish a shared key in a repository. If a key is pasted into chat or committed to source, revoke it and replace it.

## Local Ollama

The local Ollama API runs at `http://localhost:11434/api` and does not require an Ollama cloud subscription or API key. Download a suitable model separately on the same host. Hardware, electricity, and any rented compute still have costs. Model licenses vary: open weights do not automatically mean unrestricted use.

- [Official Ollama API](https://docs.ollama.com/api/introduction)

Several agents may use the same connection and model with different roles and instructions. They are separate conversations/personas, not independently trained systems. Reasoning controls are only available where the chosen endpoint/model supports them.

## Demo

The deterministic demo is explicitly labeled and does not call a model. It exists to exercise the interface and orchestrator without credentials. Demo output is not evidence that a live provider has been tested or that a real-world task was performed.

## Scope

This first version supports collaborative discussion and text deliverables. It does not automatically execute code, browse the web, send email, spend money, or perform external changes. A group can propose a solution; the human checks acceptance criteria and confirms completion. Connecting a model endpoint is not the same as integrating an arbitrary external agent framework or its tools.
