/**
 * Published design-principles texts, frozen: a prompt version that embedded them keeps them byte-identical
 * (sp-1.10.0 carries dp-1.0.0 and runs in the owner's second snapshot; sp-1.11.0 carries dp-1.1.0, released in 0.1.2). The current text lives in
 * designPrinciples.ts; add an entry here whenever a principles version ships inside a prompt version.
 */
export const DP_1_0_0 = `## What makes a good map
Judge every draft by these, whatever the theme or asset pack.
- Depth. Use several height levels. One or two bold changes (a cliff, a raised hall, a sunken pit) beat many small steps. Give the map one tall landmark that reads from across it.
- Hierarchy. One primary focal feature, a few secondary ones, everything else supporting it. Never spread interest evenly.
- Cause and effect. Things answer their surroundings: ground changes under trees and along trails, growth follows water, clutter gathers against walls and around whatever makes it, wear shows where people walk.
- Nature is irregular, built places are ordered. Natural edges, trails, streams and rifts wander; nothing natural stands in rows or at even spacing. Streets, halls and yards align and repeat in a rhythm.
- Variety with coherence. Neighbours differ in at least two of shape, height, tone, material and use, but the map stays one family of assets. One dominant material with a few accents, never a patchwork of equals.
- Readability and tone. Everything must read against its background (dark on dark disappears). Light picks out what matters. Ground materials in one field stay close in tone.
- No dead space, no litter. Every area has a purpose. Open space is deliberate, bounded and big enough to fight in. Props come in purposeful groups, never sprinkled; density falls from the edges toward the open middle.
- Lead the eye and the feet. Paths start somewhere and arrive somewhere: entrance to focal point. Water runs sensibly across the map, not along its border. Hard edges are softened or clad.
- The view from above. The GM mostly looks down: roofs, ground and area outlines must be told apart from above.
- Play first. Routes of usable width, more than one way through, cover and chokepoints, every entrance reachable, no landmark blocking the only approach.
- Implied story. A place shows what it is for and what happened there: a camp has bedrolls and a fire, a shop has a front.
- Proportion. A base, a middle and a top; the ground storey differs from those above; pieces sized to the space.
- A wrong object is worse than none. Use what the asset packs actually have.
- Vary like things on purpose. When you place several buildings, groves or rooms, give each its own role, size and silhouette.
Before you finish, read the DESIGN REVIEW in the tool result and revise once for the notes that matter. Do not loop on it.`;

/** dp-1.2.0, released in 0.2.0 inside sp-1.12.0 (generator 3). Kept above dp-1.1.0 only for reading order. */
export const DP_1_2_0 = `## What makes a good map
Judge every draft by these.
- Honour the brief. Everything named in the request is present and every adjective is visibly true (a ruined tower is broken and tall). What cannot be built, say plainly; never swap it for something plain.
- Depth. Use several height levels. One or two bold changes (a cliff, a raised hall, a sunken pit) beat many small steps. Give the map one tall landmark that reads from across it. Stack built levels so they interlock (rooms over rooms, 4 tiles apart for 2-tall walls, a floor_opening to look down), and break a big hall up with pillars, a dais or a change of floor.
- Cliffs are rock, not walls. Shape a hill as two or three terraces 2–3 tiles apart, not many one-tile steps. The rock band carries the contour; a route up it is a diagonal rock ramp or stairs. Natural maps keep a ragged border. Growth follows the rock: roots over lips, bushes in the crest, trees just behind it.
- Hierarchy. One primary focal feature, a few secondary ones, everything else supporting it. Never spread interest evenly.
- Cause and effect. Things answer their surroundings: ground changes under trees and along trails, growth follows water, clutter gathers against walls and around whatever makes it, wear shows where people walk.
- Nature is irregular, built places are ordered. Natural edges, trails, streams and rifts wander; nothing natural stands in rows or at even spacing. Streets, halls and yards align and repeat in a rhythm.
- Variety with coherence. Neighbours differ in at least two of shape, height, tone, material and use, but the map stays one family of assets. One dominant material with a few accents, never a patchwork of equals.
- Relief and contrast. Built places want a pocket of nature and a place to pause; wild places a trace of people (a fire ring, a cairn).
- Readability and tone. Everything must read against its background (dark on dark disappears). Light picks out what matters. Ground materials in one field stay close in tone.
- No dead space, no litter. Every area has a purpose. Props come in purposeful groups, never sprinkled. Open space is deliberate: a chosen clearing or square sized for play. Natural ground is dressed densely, with clearings cut on purpose.
- Lead the eye and the feet. Paths start somewhere and arrive somewhere: one reaches the focal point and each building's door. Water runs across the map, not along its border.
- The view from above. Roofs, ground and area outlines must be told apart from above.
- Play first. Routes of usable width, more than one way through, cover and chokepoints, every entrance reachable, no landmark blocking the only approach.
- Water is one flat level. The board has a single water height: keep a river or pool on one level, low or in a cut, with terraces beside it.
- Solid rock round a cave. A cave keeps about 4 cells of solid rock between its floor and the board edge, except at a passage.
- Implied story. A place shows what it is for: a camp has bedrolls and a fire, a shop has a front, a market has stalls of different goods, an aisle and a line strung overhead (Level.stalls, Level.lines, a trade use on each shopfront).
- Attach things. Vines climb upper walls and rubble lies at wall feet; little stands alone on open floor.
- Proportion. A base, a middle and a top; the ground storey differs from those above; pieces sized to the space. On cottages and inns the roof is the larger half; the top storey can sit inside it.
- A wrong object is worse than none. Use what the asset packs actually have.
- Vary like things on purpose. When you place several buildings, groves or rooms, give each its own role, size and silhouette.
Before you finish, read the DESIGN REVIEW in the tool result and revise once for the notes that matter. Do not loop on it.`;

/** dp-1.1.0, released in 0.1.2 inside sp-1.11.0. */
export const DP_1_1_0 = `## What makes a good map
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

/** dp-1.3.0, released in 0.3.0 inside sp-1.13.0 (generator 4). */
export const DP_1_3_0 = `## What makes a good map
Judge every draft by these.
- Honour the brief. Everything named in the request is present and every adjective is visibly true (a ruined tower is broken and tall). What cannot be built, say plainly; never swap it for something plain.
- Depth. Use several height levels. One or two bold changes (a cliff, a raised hall, a sunken pit) beat many small steps. Give the map one tall landmark that reads from across it. Stack built levels so they interlock (rooms over rooms, 4 tiles apart for 2-tall walls, a floor_opening to look down), and break a big hall up with pillars, a dais or a change of floor.
- Cliffs are rock, not walls. Shape a hill as two or three terraces 2–3 tiles apart, not many one-tile steps. The rock band carries the contour; a route up it is a diagonal rock ramp or stairs. Natural maps keep a ragged border. Growth follows the rock: roots over lips, bushes in the crest, trees just behind it.
- Hierarchy. One primary focal feature, a few secondary ones, everything else supporting it. Never spread interest evenly.
- Cause and effect. Things answer their surroundings: ground changes under trees and along trails, growth follows water, clutter gathers against walls and around whatever makes it, wear shows where people walk.
- Nature is irregular, built places are ordered. Natural edges, trails, streams and rifts wander; nothing natural stands in rows or at even spacing. Streets, halls and yards align and repeat in a rhythm.
- Variety with coherence. Neighbours differ in at least two of shape, height, tone, material and use, but the map stays one family of assets. One dominant material with a few accents, never a patchwork of equals.
- Relief and contrast. Built places want a pocket of nature and a place to pause; wild places a trace of people (a fire ring, a cairn).
- Readability and tone. Everything must read against its background (dark on dark disappears). Light picks out what matters. Ground materials in one field stay close in tone.
- No dead space, no litter. Every area has a purpose. Props come in purposeful groups, never sprinkled. Open space is deliberate: a chosen clearing or square sized for play. Natural ground is dressed densely, with clearings cut on purpose.
- Lead the eye and the feet. Paths start somewhere and arrive somewhere: one reaches the focal point and each building's door. Water runs across the map, not along its border.
- The view from above. Roofs, ground and area outlines must be told apart from above.
- Play first. Routes of usable width, more than one way through, cover and chokepoints, every entrance reachable, no landmark blocking the only approach.
- Water is one flat level. The board has a single water height: keep a river or pool on one level, low or in a cut, with terraces beside it.
- Solid rock round a cave. A cave keeps about 4 cells of solid rock between its floor and the board edge, except at a passage. A natural cave is no box: its chambers differ in size, bulge and bend.
- Implied story. A place shows what it is for: a camp has bedrolls and a fire, a shop has a front, a market has stalls of different goods along a lane or square with a line strung overhead (Level.stalls, Level.lines, a trade use on each shopfront).
- A room tells its purpose. One anchor piece against a wall, furniture along the walls with the middle left clear, small things on the furniture, its own floor and a light; rooms of the same purpose still differ, so never copy a room. Rooms cut into rock sit in solid mass: keep 2 to 3 cells of rock between them and the level's edge. Rooms of a kept-up building (timber, plaster) share their walls: neighbours touch or stand one cell apart, never more.
- Attach things. Vines climb upper walls and rubble lies at wall feet; little stands alone on open floor.
- Proportion. A base, a middle and a top; the ground storey differs from those above; pieces sized to the space. On cottages and inns the roof is the larger half; the top storey can sit inside it.
- A wrong object is worse than none. Use what the asset packs actually have.
- Vary like things on purpose. When you place several buildings, groves or rooms, give each its own role, size and silhouette.
Before you finish, read the DESIGN REVIEW in the tool result and revise once for the notes that matter. Do not loop on it.`;
