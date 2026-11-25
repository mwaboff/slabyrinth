# Changelog

All notable changes to Slabyrinth are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The section for a tagged version becomes the GitHub
Release notes, which the app shows under "What's new" when it offers that update.

## [Unreleased]

### Added

- **Changes per message.** Choose how many times Claude may change the map for one message before it asks you (Settings › AI › Changes per message, default 4). When Claude reaches that limit, the chat says so, with what the message has cost so far: Keep going or That's enough.
- **A 3D view of your map**, between Map and Build: every piece as TaleSpire will get it, in plain colours by kind. Turn, move and zoom around it, pick a level tab to look inside lower levels, hide roofs, hide kinds of piece from the colour key, and click a piece to see what it is, show it on the map or mention it in the chat.
- Claude can look at your map in 3D while revising it, up to a set number of pictures per message (Settings › AI › 3D view).
- **The 3D piece cache.** The shapes of TaleSpire's pieces are read from your own TaleSpire install and kept in the app data folder (512 MB at most).

### Changed

- When you have changed the plan since building, Approve & rebuild is the main button and the old map is "Copy vN anyway".
- Build problems show above the paste guide button, which then says "anyway".
- Changing the level layout asks first if you have marked slabs as pasted.

### Fixed

- Things set on tables, desks and altars now sit on them instead of hovering above.
- A build that fails now says what happened and offers Build again.
- Stopping a build is no longer reported as an error.

## [0.4.0] - 2026-11-24

### Added

- **Rooms furnished by purpose.** A room named for its use is laid out like one: a bed with its nightstand and a light, a bar with stools and a back store, a desk with its chair. Taverns and dining halls get tables with seats in the middle, barracks and wards rows of beds, classrooms rows of desks, stores aisles of stock. New kinds of room: shops, stables, sitting rooms, classrooms, command rooms and infirmary wards. Tidy rooms stay square; lived-in and working rooms look used.
- **Buildings with rooms inside.** A building's ground floor is split into rooms by what the building is: an inn's taproom with the kitchen behind it, a shop floor and its store, a workshop, a shrine, a guardroom and armoury, a warehouse office, or a home with a kitchen and a bedroom. Small houses are one room with a sleeping corner by the hearth.
- **Light that follows the mood.** A dim tavern has a few warm pools of light, a hospital ward is lit at every bed, a crypt stays dark. Lights stand where they make sense: candles on tables, lanterns on counters, torches on the walls, fires only where a fire belongs. The AI tells you which board lighting suits the scene.
- **Towns with character.** Quarters can be rich and bright or poor, run-down and gloomy, and their houses follow with small differences of their own. Neighbouring buildings are drawn to differ in walls, roofs and height.
- **Say how lit, kept and rich a place is.** The AI can set the light, the upkeep (including ramshackle) and the wealth of a whole map, a quarter, a building or a single room, so a mine called "The Lost Mine" can still be busy and bright. Anything left unsaid is still judged from the names and the place around it.
- **Streets with detail.** Posts at doors and corners, bands along the floor lines, low plinths and pilasters, and ground cover gathered in clusters along walls and paths, chosen per building so a street repeats a few treatments, never one.
- **Wear and ruins.** Worn houses get patched roofs and growth at their feet; ramshackle ones get boarded windows and a lean-to. A ruin loses a few whole bays, roof and all, with rubble spilling from the breach. Temples and grand buildings get a pair of statues at the door and lights along the approach.
- **Halls, cells and dead ends.** A great hall, throne room or temple nave gets rows of columns or a pair at each third, a clear way down the middle and its high table, throne or altar at the far end. Prisons, stables, infirmary wards and barracks can be divided into a row of cells, stalls or bays, a few left empty or untidy. In a dungeon, a dead-end room holds something (a cache, remains, stores or a small shrine), and doors between rooms suit the rooms they join.
- **A review that knows rooms and dungeons.** The AI's design review judges each room by its kind, and a dungeon by its layout: rooms all of one size, too much corridor, empty dead ends, a single way in, a drop with no way back up.

### Changed

- The water height the build suggests stays below the floor of a cellar or lower level standing in the water.
- Rooms in use stay tidy: no rubble or remains in a kept room, only in ruined, ramshackle or abandoned places, crypts and cells. Lights on a room's floor stand against a wall or a piece, never alone mid-floor, and furniture never cuts a room's doors off from each other. A dark room divided into cells stays dark.
- By the water, no land plants grow under the water line, and a wharf's edge is straight.
- Rich and poor read from the street. A poor building leans to rough plank walls and odd-matched roofs, a rich one to dressed stone, a quarter's roofs alike and more trim; a rich house may get a lit approach, and a rich home or temple a pair of statues at its door (never an inn or a shop). A map that says nothing about wealth looks as before. Worn roofs show patches, not holes; only a ruin's roof is open. Roofs fit their house: no tall one-sided roof over a deep house, and no flat tops in a timber village unless asked for.
- Blocked rooms and stairs are caught before they reach you. Nothing the generator places stands where you step on or off stairs, a ramp or a ladder, rubble at a wall's foot never closes the way through a room, and a cliff's rocks keep off a walkway that climbs to it. Before a release, every test map is now built many times over and checked that each room and stair can be walked to.
- Maps you made with earlier versions rebuild unchanged. The new rules are for new maps only.

### Fixed

- Maps of several slabs now carry their two alignment pillars again, so the slabs land in line instead of piling up under the cursor. A build made without them says so and asks you to build again; the add-on will not send it. If your palettes have no pillar piece at all, the build page says that instead, since building again cannot add one.
- Settings that could not be saved now save: the TaleSpire level layout and alignment pillar options (in Settings and on the build page), the spending warnings, and the projects folder.

### Known limits

- Upper storeys of buildings are still empty shells; only the ground floor is furnished.
- A level still holds at most 32 buildings. Larger cities come in a later release.
- Maps of 512 × 512 tiles with alignment pillars have not been tried in the game yet.
- Ships built from the game's own ship kit (hull, decks, masts, sails, cannon and furnished cabins) are in the generator and have been checked in renders from the game's meshes, but the AI cannot place one yet; asking for a ship comes in a later release.
- The new rooms, lights, streets and ruins have been checked by the app's own tests but not yet looked at in TaleSpire.

## [0.3.0] - 2026-11-22

### Added

- **Send to TaleSpire.** A built map now goes straight into TaleSpire through the Slabyrinth Helper add-on, on Windows and Linux. Install the add-on from the app, then turn on Symbiotes in TaleSpire under Game Settings > Modding Settings. Press Send to TaleSpire and the add-on puts each slab in your hand in turn and says what to do next. While you place a map, Ctrl+Alt+D puts the next slab in your hand, Ctrl+Alt+A goes back one and Ctrl+Alt+S puts the current slab in your hand again. The app keeps the add-on up to date and can remove it.
- **Bigger maps.** Maps can be up to 320 × 320 tiles. An experimental setting (Settings > Experimental > Maximum map size) goes up to 1024 × 1024; very large maps take longer to build and use more memory.
- **Caves with shape.** Cave chambers and passages get ragged outlines, flat cave floors get shelves and steps, and rock is filled in layers.
- **Rooms that tell their purpose.** Name a room for its use (kitchen, guard room, library, barracks) and it gets its own floor, furniture, things on the furniture and lights, different in every room. A crypt or a ruined room stays sparse and dark.
- **Covered market stalls** with posts, cloth canopies, counters and goods, in several sizes.
- **Better floor openings, roofs and doors.** A collapsed floor has a broken rim and a heap of debris below, shafts have a kerb and balconies a railing. Roofs are filled underneath and capped along the ridge, and lean-tos slope properly. Secret doors are one piece you can lift out.
- **More design-review notes** for stalls, caves, roofs, rooms and floors.

### Changed

- Maps made of several slabs are pasted from just south of the map, so the slabs line up without lining them up by hand. The build page and the add-on say where to click.
- The light and dark toggle moved from the title bar to Settings > Appearance, and the app now follows your system's light or dark setting by default.
- Maps you made with earlier versions rebuild unchanged. The new rules are for new maps only.

### Known limits

- The add-on finds TaleSpire's Symbiotes folder on Windows and Linux. On Linux this is new and has not been tried on a real install yet. If the app cannot find the folder, you can choose it yourself.
- Sending to TaleSpire, the hotkeys and the 1024 × 1024 setting have been checked by the app's own tests but not yet in a full game session.

## [0.2.0] - 2026-11-20

### Added

- **Rock-faced cliffs in clusters.** Hills and terraces are faced with real rock. Boulders gather in clusters with bare patches between them instead of standing in even rows, each cliff keeps to one rock tone, and a ledge piece is chosen to fit the height of the step.
- **Cave walls as solid rock.** A cave is now surrounded by a thick mass of overlapping rock instead of a single row of posts, with a few cells of solid rock between the floor and the edge of the map and an open passage where the cave meets the border.
- **Wandering rifts and rivers.** A rift reads as one ragged crack that bends across the cave, with a short bridge across it. Rivers can step down in reaches with falls, and the build tells you the water height to set in TaleSpire.
- **Buildings grow and fall apart better.** A building can be lightly, moderately or heavily overgrown, with vines on upper walls and rubble at the wall feet. Ruins have broken wall tops, collapse from the top down and no longer carry a roof that floats over missing walls. Weathered buildings now look different from intact ones.
- **Trade shop fronts.** Cottages can be a baker, smith, shop, butcher, apothecary, cobbler, tailor or inn, each with a glazed front, a sign, an awning and a few props at the door.
- **Market stalls.** Rows of stalls with different goods, such as fruit, vegetables, potions and weapons, with a clear aisle between them.
- **Lines strung overhead.** Lanterns, strings of lights or flags hung between walls or posts, over a street or square.
- **Floor openings between dungeon levels.** A collapsed floor, a shaft or a balcony lets you look down into the level below, with rubble on the floor beneath. The AI also keeps the levels of a dungeon further apart, so each one is easier to see.
- **Many more design-review notes.** The AI's review now catches rocks in even rows, cliffs that bury the ground, thin or gappy cave walls, mixed rock tones, unlit landmarks, buildings with a blank wall, a map with no real depth, levels packed too close together and more, and it fixes what matters.
- **A "revising" indicator** shows when the AI is going over its own map, so you can see it is still working.

### Changed

- Maps you made with earlier versions rebuild unchanged. The new rules are for new maps only.
- A map's name is saved when you click away from the name box, not only when you press Enter.

### Known limits

- Rivers have no water piece in the game's library for their upper reaches or falls, so those stay dry until you raise the water or place pieces yourself.
- The new stalls, floor openings and cave walls have been checked by the app's own tests but not yet looked at in TaleSpire.

## [0.1.2] - 2026-11-20

### Added

- **Buildings.** The AI can now put real buildings on a map: cottages, keeps, town houses, shops, warehouses, city blocks and a wizard's tower, with doors, windows, a roof and one or more storeys. Buildings next to each other come out different, and any building can be asked for as weathered or ruined. The roof builds as its own layer, so you can also paste a see-inside version without it.
- **Yards:** fenced gardens, farmyards and graveyards with a gate.
- **Height and depth.** Raised daises, sunken pits, terraces, hills with bold rock cliffs, chasms and ravines cut into the floor, and bridges across them. Natural cliffs are faced with real rock instead of square blocks.
- **Water and paths.** Rivers and brooks that cross the map, trails that wind, and streets with pavements, kerbs and crossings. The build tells you what water level to set in TaleSpire after pasting.
- **Richer dressing.** Many more props for caves, dungeons, forests and towns; set pieces by name, such as a ritual circle, a campsite, a ruined shrine or mine works; trees and rocks that cluster like real growth; and floors that mix several tiles.
- **New themes:** Forest, and a modern City built from the game's Cyberpunk and Sci-fi pieces.
- **The AI reviews its own maps.** It follows written design principles and, after every change, reads a short review of the map: flat ground, ruler-straight natural edges, lookalike buildings, paths that lead nowhere, and parts of your request the map does not show yet. It fixes what matters and tells you what it could not do.
- Pieces added by TaleSpire updates are used automatically, and asking for something the app has no name for finds the closest piece in your game.

### Changed

- Maps you made with 0.1.1 keep their layout. The new terrain, buildings and dressing are for new maps.
- The 2D map shows heights, cliffs, bridges, roof outlines and the water level.
- Release notes in the update notice are formatted (headings, lists, bold) instead of shown as raw text.
- The app includes the licence notices for its fonts and libraries (Settings ▸ About ▸ Third-party notices).

### Fixed

- The model list no longer fills up with rows that all read "Opus", "Sonnet" or "Fable". Other models show their full name behind a "Show other models" toggle.
- The AI's "look at the map image" step always timed out. It works again.
- Lava was built as ordinary cave floor, low walls and railings were left out, caves at the edge of the map had gaps in their walls, and a watchtower on posts was reported as sealed off.
- Fewer wasted AI turns: the AI is told when part of its plan changed nothing, and it checks every item of your request before saying it is done.

### Known limits

- Natural maps now have a ragged outline by default. Ask for a rectangular board (`outline: "rect"`) to turn it off.
- A "twisted" tower is built from stepped, offset blocks, not truly rotated ones, and "weathered" buildings are subtle.
- Rock ramps have not been tested yet for moving minis up and down.
- Maps saved by 0.1.2 may not open in 0.1.1.

## [0.1.1] - 2026-11-18

### Changed

- The settings icon is now a gear, so it no longer looks like the theme toggle's sun.
- The app now uses the same logo as the website, and the icon is sharper at small sizes.

### Fixed

- On Linux, the app window and taskbar now show the Slabyrinth icon instead of a generic one.
- On Windows, the running app now groups with its pinned taskbar or Start menu shortcut. If you pinned Slabyrinth while using 0.1.0, you may need to unpin it and pin it again.

## [0.1.0] - 2026-11-18

The first release.

### Added

- Describe a dungeon, crypt or tower by chatting with Claude, using your own Anthropic API key. Slabyrinth
  asks a few questions, keeps a design brief, and draws a first plan.
- Review the plan as a 2D map with a numbered room key, on one or several stacked levels. Edit it by
  chatting ("make room 3 bigger") or directly on the map; every change is a version you can undo,
  compare or restore.
- Approve a version and build it: Slabyrinth compiles the plan into TaleSpire slabs and guides you
  through pasting them, with "Copy & open TaleSpire".
- Export the map as a PNG (with or without the room key) and the room key as Markdown.
- Uses the asset catalog of your own TaleSpire install, or a small built-in set of pieces when TaleSpire
  isn't installed.
- Choose the Claude model and effort per conversation, with a cost estimate before you send and spend
  warnings you can set.
- Your API key is encrypted with your system's keychain and only ever sent to api.anthropic.com. Maps are
  plain files in your Documents folder and never contain the key.
- Dark and light themes, keyboard shortcuts, autosave with crash-safe writes.
- An "Update available" notice: at most once a day the app asks GitHub, anonymously, whether a newer
  version exists, and links to its release page. You can turn the check off in Settings ▸ About.
- Windows installer and portable build, Linux AppImage. The builds are not code-signed yet.

[Unreleased]: https://github.com/mwaboff/slabyrinth/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/mwaboff/slabyrinth/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mwaboff/slabyrinth/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mwaboff/slabyrinth/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/mwaboff/slabyrinth/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mwaboff/slabyrinth/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mwaboff/slabyrinth/releases/tag/v0.1.0
