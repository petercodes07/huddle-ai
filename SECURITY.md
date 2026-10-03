# Security

Huddle is a single-owner, local-first application. A public GitHub repository is not a claim that the application is ready for unrestricted multi-tenant hosting.

- Keep the application on loopback unless remote access has been deliberately configured.
- Use TLS, the configured access secret, and the exact public origin for remote hosting.
- Keep runtime databases, provider secrets, and encryption-key files out of Git and public backups.
- Do not enter private or regulated content unless permitted to send it to the chosen model provider.
- Agents cannot grant themselves external tool permissions, change the human's goal, or certify completion.
- Provider responses and user messages are untrusted content.
- Never report vulnerabilities by posting credentials or private conversation exports in public issues.

If a provider key is exposed, revoke it at the provider and replace it through private configuration. Removing it from the latest Git commit is not enough to invalidate an exposed key.
