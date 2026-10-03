# Frontend guide

Huddle's browser client lives in `public/`. It is plain HTML, CSS, and ES modules, served by the same Node process as the API. There are no frontend build dependencies, remote fonts, CDNs, or external scripts.

## Use the workspace

1. Create a group with a task and one acceptance criterion per line.
2. Choose the model mode, candidate agent profiles, group-size cap, and turn budget. Sample mode is a clearly labeled, deterministic demonstration, not live inference.
3. Start the group. Profiles assess the goal and can self-nominate into the conversation within the configured candidate pool and cap.
4. Pause or stop at any time. Runs and transcripts are persisted on the server, independently of whether the browser remains open.
5. Send feedback in the group composer. During review, select **Continue** after sending feedback to resume the work.
6. Review the proposed deliverable. When satisfied, check every acceptance criterion and select **Accept & complete**.
7. Archive a non-running group from its menu. Use the Archived tab to restore it. Export downloads a Markdown conversation and deliverable.

## Models and agents

The rail's people button opens agents; its gear opens model connections. The connection summary at the bottom of the sidebar is also a settings entry point, including on mobile.

A connection can be reused by many agents. Connection forms support NVIDIA Build, operator-enabled local Ollama, and operator-allowlisted compatible endpoints. New keys are write-only password input; no browser storage is used. Keys are cleared after submission and dialog closure. Connection status means configured, **not a verified live network test**.

Agent profiles have a name, collaboration role, instructions, model connection, and reasoning setting. Reasoning controls are disabled unless the connection declares support. Editing an agent or connection may interrupt an in-flight response and affects groups using that profile.

## Interaction and accessibility

- Native modal dialogs provide focus containment and Escape dismissal
- Explicit labels, status regions, accessible names, a skip link, progress semantics, and visible keyboard focus
- `N` opens group creation; `/` focuses group search, except while editing a field or using a dialog
- Enter sends a message; Shift+Enter inserts a line break
- Draft composer text is preserved while the transcript polls
- Mobile: drawer for group navigation; Conversation and Goal & team tabs for content
- Reduced-motion media preference disables motion and smooth scrolling
- No drag-only interactions or color-only run-state information

## Rendering and API safety

`ui.js` escapes all text before generating a restricted subset of Markdown (paragraphs, headings, lists, bold, inline code, code blocks). It does not create model-supplied links, image tags, raw HTML, or executable extensions. Dynamic attribute values are escaped.

Mutations send the current `expectedVersion`; conflicts refresh the group and ask the user to retry. Mutations are not blindly replayed. Authentication uses a server-provided HttpOnly session cookie. Run/model errors are shown without silent sample fallback.

The progress display says **budget units**, because the backend reserves conservative token amounts, including abandoned attempts. It does not represent precise billed tokens.

## Tests and verification limits

Run `node --test tests/frontend.test.js` for deterministic rendering, escaping, export, timestamp, and criteria parsing tests. Run `npm test` for the full server and client helper suite.

The application was syntax checked and its DOM structure statically inspected. The available cloud browser refused the local app URL with `ERR_BLOCKED_BY_CLIENT`; no browser rendering, screenshots, or interactive desktop/mobile pass was completed in that environment. Static checks do not establish a WCAG conformance level or replace real browser/screen-reader testing.

Suggested browser checks: 1440px desktop and 380px mobile; create/cancel/reopen; sample start/pause/resume/review/accept; criteria disabled before review; archived restore; model/agent add/edit forms; stale-version recovery; preserved drafts during polling; menu/dialog Escape handling; keyboard tab order; long goals, names, messages, and code blocks.
