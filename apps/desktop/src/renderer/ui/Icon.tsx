/**
 * The small inline-SVG icon set (16-unit grid, 1.6 stroke, Lucide-like) lifted from the v2 mockup.
 * No icon package: CSP + no extra dependencies. Colour comes from currentColor.
 */
import type { ReactElement } from "react";
import { MARK, type MarkRing } from "../../shared/brandMark";

const PATHS = {
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  // Six chunky flat-ended teeth on a solid ring plus a centre hole, so it can't read as the sun beside it.
  gear: (
    <>
      <path d="M6.4 3.16L6.65 1.13L9.35 1.13L9.6 3.16A5.1 5.1 0 0 1 11.39 4.19L13.27 3.4L14.62 5.73L12.99 6.96A5.1 5.1 0 0 1 12.99 9.04L14.62 10.27L13.27 12.6L11.39 11.81A5.1 5.1 0 0 1 9.6 12.84L9.35 14.87L6.65 14.87L6.4 12.84A5.1 5.1 0 0 1 4.61 11.81L2.73 12.6L1.38 10.27L3.01 9.04A5.1 5.1 0 0 1 3.01 6.96L1.38 5.73L2.73 3.4L4.61 4.19A5.1 5.1 0 0 1 6.4 3.16z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
    </>
  ),
  down: <path d="M4 6l4 4 4-4" />,
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  cursor: <path d="M3.5 2.5l9 4.2-3.9 1.2-1.3 3.9z" />,
  hand: (
    <path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7.2V4a1 1 0 0 1 2 0v5.5c0 2.8-1.8 4.5-4.2 4.5-1.6 0-2.6-.8-3.4-2L2.5 9.6a1 1 0 0 1 1.6-1.2L5.5 10" />
  ),
  region: (
    <>
      <path d="M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11" />
      <path d="M7 2.5h2M7 13.5h2M2.5 7v2M13.5 7v2" opacity=".6" />
    </>
  ),
  minus: <path d="M3.5 8h9" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  layers: (
    <>
      <path d="M8 2l6 3.2-6 3.2-6-3.2z" />
      <path d="M2 8.2l6 3.2 6-3.2M2 11l6 3.2 6-3.2" opacity=".7" />
    </>
  ),
  compare: (
    <>
      <rect x="2" y="3" width="5" height="10" rx="1" />
      <rect x="9" y="3" width="5" height="10" rx="1" strokeDasharray="2 1.6" />
    </>
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2.5 2.5v2.5H5M8 5v3.2l2 1.3" />
    </>
  ),
  send: <path d="M8 13V3.5M3.8 7.5L8 3.3l4.2 4.2" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.2" />,
  edit: <path d="M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z" />,
  at: <path d="M5 11l-2.5 2.5V4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11z" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r=".6" />
      <circle cx="8" cy="8" r=".6" />
      <circle cx="12.5" cy="8" r=".6" />
    </>
  ),
  play: <path d="M5 3.5l7 4.5-7 4.5z" />,
  ext: <path d="M9.5 2.5h4v4M13.5 2.5L8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2l3.3 3.3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <path d="M2.5 13.5l11-11" />
    </>
  ),
  left: <path d="M10 4L6 8l4 4" />,
  right: <path d="M6 4l4 4-4 4" />,
  retry: (
    <>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1" />
      <path d="M13.5 2.5V5H11" />
    </>
  ),
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.8" cy="6.5" r="1.1" />
      <path d="M2.5 12l4-4 3 3 1.5-1.5L14 12" />
    </>
  ),
  folder: (
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  ),
  hammer: <path d="M9 4.5l2.5 2.5M3 13l6-6M7.5 3l3-1 3.5 3.5-1 3" />,
  warn: (
    <>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 6.5v3M8 11.2v.3" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.2v3.6M8 5.2v.3" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8v3.8M8 10.8v.3" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="M7.7 8.3l5.8-5.8M11 5l1.8 1.8M12.5 3.5l1 1" />
    </>
  ),
  file: <path d="M4 1.8h5l3 3V14a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5V2.3a.5.5 0 0 1 .5-.5zM9 1.8V5h3" />,
  pin: <path d="M8 14.5V9.5M4.5 9.5h7L10 7V3h1V1.5H5V3h1v4z" />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size,
  className,
}: {
  name: IconName;
  size?: "xs" | "sm" | "lg";
  className?: string;
}) {
  const cls = ["icon", size ? `icon--${size}` : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** Normalised logo coordinate (-1…1) to the 0…100 tile units of the <Mark> viewBox. */
const mu = (n: number) => Math.round((n + 1) * 5000) / 100;

/** One ring of the logo as an open square path whose ends frame its gap. */
function ringPath({ half, gap }: MarkRing): string {
  const [a, b] = [mu(-half), mu(half)];
  const [g1, g2] = [mu(-MARK.gapHalfLength), mu(MARK.gapHalfLength)];
  return gap === "bottom"
    ? `M${String(g1)} ${String(b)}H${String(a)}V${String(a)}H${String(b)}V${String(b)}H${String(g2)}`
    : `M${String(a)} ${String(g1)}V${String(a)}H${String(b)}V${String(b)}H${String(a)}V${String(g2)}`;
}

const MARK_RINGS = MARK.rings.map(ringPath).join("");
const MARK_STONE = { at: mu(-MARK.centreHalf), size: mu(MARK.centreHalf) - mu(-MARK.centreHalf) };

/**
 * The Slabyrinth logo, the same mark as the website and the app icon (geometry: shared/brandMark.ts):
 * a dark tile with a gold labyrinth. Colours come from --brand-tile / --brand-ink.
 */
export function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={["mark", className ?? ""].join(" ")}
      width={size}
      height={size}
      viewBox="-4 -4 108 108"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="mark__tile" width="100" height="100" rx={mu(MARK.tileRadius) - 50} />
      <path className="mark__maze" d={MARK_RINGS} strokeWidth={MARK.ringHalfWidth * 100} />
      <rect
        className="mark__stone"
        x={MARK_STONE.at}
        y={MARK_STONE.at}
        width={MARK_STONE.size}
        height={MARK_STONE.size}
      />
    </svg>
  );
}
