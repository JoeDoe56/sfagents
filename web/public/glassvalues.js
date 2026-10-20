/**
 * The Liquid Glass values every surface uses, so a button or box looks the
 * same in the main sheet, the file manager and the other sheets.
 *
 * Modelled on ChatGPT's iOS composer: a dark neutral body that mostly hides
 * what is behind it (a heavy blur shows only soft shapes), almost no
 * refraction or colour split, and a crisp hairline rim (matched to iOS at
 * 3x) that takes on the colour of what is next to the glass. Controls are a
 * slightly lighter layer of the same glass.
 */
export const GLASS = {
  /** The composer bar, and bars like it (the selection toolbar). */
  bar: { material: -0.5, tint: { color: '#1d1d1d', amount: 0.58 }, frost: 8, refraction: 0.012, dispersion: 0, rim: 0.25, layer: 0 },
  /** Round buttons and chips. */
  control: { material: -0.3, tint: { color: '#262628', amount: 0.35 }, frost: 3, refraction: 0.01, dispersion: 0, rim: 0.22, layer: 1 },
  /** Boxes: the resource monitor, artifact tiles, drive bars. */
  tile: { material: -0.3, tint: { color: '#262628', amount: 0.6 }, frost: 6, refraction: 0.01, dispersion: 0, rim: 0.2, layer: 1 },
};

/** The send circle's glass fades to the iMessage blue while there is something to send. */
export const SEND_TINT = { color: '#4499f8', amount: 0.86 };
