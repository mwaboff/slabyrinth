/**
 * Room recipes (generator 4): a room is dressed and lit from its purpose, toward the measures of a well-dressed
 * interior (about two props per floor tile, nearly all furniture against a wall, a third of the props resting on other
 * pieces, every room lit and no floor far from a light).
 *
 *   1. an anchor that names the purpose (a bed, a long table, a counter, a forge, an altar), on the wall away from the
 *      door, with its seats on the open side;
 *   2. wall furniture (corners first), the middle of the room and the way between doors left clear;
 *   3. small things ON the furniture (plates, books, tools, jars) and on a shelf plank along one wall, from the
 *      purpose's goods family;
 *   4. a rug where the purpose has one;
 *   5. lights: candles on the anchor, a lantern on a chest, wall torches, a brazier in a big room; every inhabited room
 *      has one, a dark abandoned room keeps one at most.
 *
 * Theme-neutral: everything is written in feature types (and clutter families), and each item is dropped where the
 * theme's palette has no piece for it (PlacementGrid.piece4). Rooms of one purpose draw different recipe variants
 * (PlacementGrid.roomMemory) and different seeded positions, so sibling rooms are never copies of each other.
 * Generator 4 only; the weighted tables of gen/place.ts stay frozen for the earlier generators.
 *
 * The modules: `recipes` (the recipe table and the dressing measures), `room` (the room model: cells, doors, the way,
 * what is placed), `wall` (the wall placer and seats), `things` (small things on tops, the shelf plank, the rug),
 * `lights` (how many lights and where), `dress` (the steps in order).
 */
export { dressRoom, type RoomDressParams } from "./dress";
export { dressDeadEnd, dressSet, type DeadEndParams } from "./deadEnd";
export { SMALLEST_FURNISHED } from "./furnish";
export { lightArea, lightTarget } from "./lights";
export { ROOM_RECIPES_4, SHELF_TOP, type Family } from "./recipes";
export { REGIMES, drawLighting, type LitNeighbour, type RoomLightPlan } from "./regimes";
