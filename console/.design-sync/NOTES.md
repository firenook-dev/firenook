# Design-sync notes for the Firenook console

The library is `@firenook/kit` (`design-system/kit/`): every `@cloudflare/kumo` component
re-exported under the Firenook theme, plus the console's own pieces from
`src/components/kit`. Build it with `node design-system/kit/scripts/build.mjs` (tsc for
the entry and `.d.ts`, the Tailwind CLI for `dist/kit.css`, one doc per Kumo component
from `kumo docs` into `docs/`). Run the converter from `console/`:

```
node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules \
  --entry ./design-system/kit/dist/design-system/kit/src/index.js --out ./ds-bundle
```

- The entry sits under `dist/design-system/kit/src/` because the kit's tsconfig has
  `rootDir: ../../` so it can compile `src/components/kit` alongside its own entry.
- `kit.css` must `@source` the previews folder and enumerate every arbitrary value the
  console uses (`text-[0.9em]`, `h-[420px]`…): the design tool's stylesheet is compiled
  once and never purged against a design, so anything not compiled renders nothing.
- Kumo's brand tokens come out of its `@theme` block unlayered; the Firenook override
  in `src/theme.css` is unlayered too, which is what makes it win.
- Kumo's `Switch` default is hard-coded blue; the console uses `variant="neutral"`.
  `Switch` and `Checkbox` take `checked` (no `defaultChecked` on `Switch`).
- Open overlays autofocus a control; the previews blur it after mount so the still
  shows no focus ring. `Sidebar.Provider` needs `mobileBreakpoint={0}` in a narrow
  capture or it renders as a closed mobile sheet.
- The chart and map components (`Chart`, `BubbleMap`, `ChoroplethMap`, `GlobeMap`,
  `SankeyChart`, `TimeseriesChart`) need an echarts instance passed in and are excluded
  from the component list; `CloudflareLogo` and `PoweredByCloudflare` are excluded as
  another company's marks. Provider and compound sub-part exports are excluded from the
  list but remain on `window.Firenook`.
- Playwright: the converter's deps in `.ds-sync/` pin `playwright@1.63.0`, which matches
  the cached `chromium_headless_shell-1243` the console's own Playwright uses.

## Known render warns

- `[TOKENS_MISSING]` for `--active-tab-*`, `--toast-index`, `--collapsible-panel-height`,
  `--available-*`, `--anchor-*`: Kumo sets these inline at runtime; nothing to ship.
- `[RENDER_THIN]` on `Dialog` and `CommandPalette` (height 0 measured): both portal to
  the body; the screenshots show them rendered.
- `[GRID_OVERFLOW]` was resolved with `cardMode` overrides (column for wide stories,
  single for overlays and the meter).

## Re-sync risks

- The kit re-exports whatever `@cloudflare/kumo` version the console pins; a Kumo bump
  changes every component's render hash, so expect a full re-verify after one.
- The Kumo docs in `design-system/kit/docs/` are regenerated from the installed package
  on every build; the truncation warnings for `Select.md` and `Sidebar.md` are expected.
- Previews inline synthetic data (`demo-shop-local`, `ada@example.test`); nothing is
  read from a running engine, so they cannot go stale against it.
- Fonts are copied from `public/fonts` through `design-system/kit/src/fonts.css`; if the
  console changes its typeface, update that file and `src/theme.css` together.
