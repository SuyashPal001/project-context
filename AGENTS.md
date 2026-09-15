# Engineering rules for this app

- Treat every change as production code that will be reviewed by senior engineers. Keep the implementation small, clear, and maintainable; follow the existing architecture and naming conventions rather than adding parallel abstractions.
- Before editing UI, inspect the surrounding components and use the app's existing design tokens, shared components, spacing, typography, and interaction patterns. Do not introduce a separate visual system for a feature.
- Preserve existing behavior, handle loading, empty, and error states, and avoid placeholder functionality that looks operational. Add tests only where they verify meaningful behavior; run the relevant checks before handoff.
- Keep unrelated work and existing user changes untouched. Implement creative-library work in a separate Git worktree and keep Templates, Avatars, Products, and Audio consistent with the existing chat architecture.
- After implementation and local checks, request an independent final code review from the `gpt-6-astra` model. Address material findings and rerun affected checks before reporting completion.
