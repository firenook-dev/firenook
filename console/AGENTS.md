# Working in the console

Read the repository `AGENTS.md` first; its independence rule applies to every
file here, screenshots and seed data included.

- Stack and state rules: `.claude/skills/firenook-console/SKILL.md`.
- Visual rules: `.claude/skills/kumo-design/SKILL.md` (Kumo's own rules, MIT).
- Component APIs: `npx @cloudflare/kumo doc <Component>`; tokens and patterns:
  `npx @cloudflare/kumo ai`.
- TanStack docs: `npx @tanstack/cli search-docs "<query>"`.

Hard rules:

1. Semantic Kumo tokens only; never raw Tailwind colours, never `dark:`.
2. No polling. Server data goes through TanStack Query and the live channel.
3. Every long list is virtualized.
4. The Console API types are generated from Rust. Change the Rust type, run
   `cargo test -p firenook-console-front`, commit the generated files.
5. The first route stays under its gzip budget (`npm run budget`).
6. A section that is not finished says so on screen; nothing is presented as
   available before it works end to end against the engine.
7. Tests: unit with Vitest, behaviour with Playwright against a real engine.
   No mocked API in end-to-end tests.
