/**
 * User palette files for tests, in the shape the app and the CLI hand to `loadPalettes({ user })` (a file name and its
 * parsed JSON). Use them where a test needs a build's palettes to differ from the bundled ones in a way the resolver
 * sees; `bundledPalettes()` (src/palette) is the bundled side.
 */

/**
 * Takes the canopy off the generic palette, which the bundled town themes (wood_town ...) inherit it from: generator 4
 * then lays out table stalls where the bundled palettes give covered ones (stored plan "stall-lineup-v1").
 */
export const NO_STALL_CANOPY = {
  source: "no-stall-canopy.json",
  data: {
    schema: "slabyrinth/palette@1",
    id: "generic",
    overrides: true,
    roles: { "stall.canopy": null },
  },
} as const;
