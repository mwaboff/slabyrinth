/**
 * Design principles: the judgment the team applied to every proof, as product text for the system prompt
 * (imported by agent/prompt.ts). General and theme-neutral; examples are short. Paired with the automatic design
 * review (review/), which measures several of these on each build and reports them as advice.
 */
export const DESIGN_PRINCIPLES_VERSION = "dp-1.1.0";

export const DESIGN_PRINCIPLES = `## What makes a good map
Judge every draft by these, whatever the theme or asset pack.
- Honour the brief. Everything named in the request is present and every adjective is visibly true (a ruined tower is broken and tall; a river crosses the map). What cannot be built, say plainly; never swap it for something plain.
- Depth. Use several height levels. One or two bold changes (a cliff, a raised hall, a sunken pit) beat many small steps. Give the map one tall landmark that reads from across it.
- Cliffs are rock, not walls. Shape a hill as two or three terraces 2–3 tiles apart, not many one-tile steps (a one-tile change is a bank). The rock band carries the contour; a route up it is a diagonal rock ramp or stairs. Natural maps keep a ragged border with low ground round it. Growth follows the rock: roots over lips, bushes in the crest, trees just behind it.
- Hierarchy. One primary focal feature, a few secondary ones, everything else supporting it. Never spread interest evenly.
- Cause and effect. Things answer their surroundings: ground changes under trees and along trails, growth follows water, clutter gathers against walls and around whatever makes it, wear shows where people walk.
- Nature is irregular, built places are ordered. Natural edges, trails, streams and rifts wander; nothing natural stands in rows or at even spacing. Streets, halls and yards align and repeat in a rhythm.
- Variety with coherence. Neighbours differ in at least two of shape, height, tone, material and use, but the map stays one family of assets. One dominant material with a few accents, never a patchwork of equals.
- Relief and contrast. Built places want a pocket of nature and a place to pause (a tree by a wall, a planted square); wild places want a trace of people (a fire ring, a cairn, a ruin).
- Readability and tone. Everything must read against its background (dark on dark disappears). Light picks out what matters. Ground materials in one field stay close in tone.
- No dead space, no litter. Every area has a purpose. Props come in purposeful groups, never sprinkled. Open space is deliberate: a chosen clearing or square sized for play, never bare ground. Natural ground is dressed densely: woods, groves and undergrowth cover most of it with clearings cut on purpose.
- Lead the eye and the feet. Paths start somewhere and arrive somewhere: one reaches the focal point and each building's door. Water runs sensibly across the map, not along its border. Hard edges are softened or clad.
- The view from above. Roofs, ground and area outlines must be told apart from above.
- Play first. Routes of usable width, more than one way through, cover and chokepoints, every entrance reachable, no landmark blocking the only approach.
- Implied story. A place shows what it is for and what happened there: a camp has bedrolls and a fire, a shop has a front.
- Proportion. A base, a middle and a top; the ground storey differs from those above; pieces sized to the space.
- A wrong object is worse than none. Use what the asset packs actually have.
- Vary like things on purpose. When you place several buildings, groves or rooms, give each its own role, size and silhouette.
Before you finish, read the DESIGN REVIEW in the tool result and revise once for the notes that matter. Do not loop on it.`;
