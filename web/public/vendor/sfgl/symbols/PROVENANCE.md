# SF Symbols: provenance and licensing

`glyphs/` holds 1,672 SF Symbols as PNG bitmaps, copied unmodified from the
public `wan-kong/sf-symbols-online` repository at revision
`09aa1fb1ed675def165a633b0122724ff882175d`:

<https://github.com/wan-kong/sf-symbols-online/tree/09aa1fb1ed675def165a633b0122724ff882175d/packages/sf-symbols/glyphs>

That repository credits the collection to `@andrewtavis`
(<https://github.com/andrewtavis/sf-symbols-online>), says SF Symbols is a
trademark of Apple Inc., and declares itself MIT licensed. It has no separate
LICENSE file at that revision.

## Read this before you ship them

**These glyphs are Apple's artwork, not sfgl's.** sfgl's MIT License covers
sfgl's code and does not cover `symbols/glyphs/`. A mirror calling itself MIT
does not give anyone rights to Apple's symbols.

Apple's terms for SF Symbols (supplied with the SF Symbols app) limit them to
designing apps and mockups for Apple's platforms, and do not allow
redistributing them. Check Apple's current terms before you use these glyphs.
In particular:
- an app for Android, Windows or the general web may not be allowed to use
  them;
- shipping them from a public repository or package is itself redistribution.

Nothing else in sfgl depends on this folder. To remove the symbols, delete
`symbols/`, `src/symbols.js`, `scripts/build-symbols.mjs` and the `symbols`
entries in `package.json` and `src/index.js`.

## Format

- Each glyph is a small, antialiased bitmap, mostly about 40 px wide, kept
  exactly as the mirror has it. They are used only for their alpha channel, as
  CSS masks, so they take the current text colour. They are sharp at icon
  sizes up to about 20 CSS px on a 2x display and get soft above that.
- The set is the mirror's 1,672 symbols. It is not all of SF Symbols, and it
  has no weights, scales or multicolour variants. `gearshape`, `books.vertical`,
  `network`, `line.3.horizontal` and a few more used by Apple's own apps are
  missing. `symbolAliases` in `src/symbols.js` maps five of them to the
  closest glyph present. Those are approximations, not the real symbols.

## Updating

Replace the PNGs in `glyphs/`, then run `npm run build:symbols` to regenerate
`names.js` and `symbols.css`. The unit tests fail if they fall out of step with
the folder.
