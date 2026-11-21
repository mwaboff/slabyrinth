/**
 * What each facade detail of a drawn building design IS (resolve/structureVariety.ts draws them by weight from a style's
 * `details`; compile/structure.ts builds each one): one row per detail name, read through the helpers below instead of
 * lists of detail names in the code. What a detail looks like stays the compiler's own branch per name.
 */

export interface DesignDetailInfo {
  /**
   * Hung on the facade (a canopy, balconies, a fire escape): a weathered building (generator 3) loses one, the first in
   * table order its design has.
   */
  hung?: boolean;
}

/** Row order is the order a weathered building looks for a hung detail to lose. */
export const DESIGN_DETAIL_INFO: Readonly<Record<string, DesignDetailInfo>> = {
  canopy: { hung: true },
  balconies: { hung: true },
  fire_escape: { hung: true },
  none: {},
  awning: {},
  piers: {},
  services: {},
  // castle and tower details
  bartizans: {},
  turret: {},
  beacon: {},
  banners: {},
  vines: {},
  balcony: {},
};

const HUNG: readonly string[] = Object.keys(DESIGN_DETAIL_INFO).filter(
  (d) => DESIGN_DETAIL_INFO[d]?.hung === true,
);

/** The first hung detail (in table order) among a design's details, if any. */
export function firstHungDetail(details: readonly string[]): string | undefined {
  return HUNG.find((d) => details.includes(d));
}
