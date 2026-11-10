# Race Boston

An open-world driving game set in Boston, MA, playable in the browser. The city comes from
[OpenStreetMap](https://www.openstreetmap.org) data. It includes 51,000 buildings with their real heights,
14,800 streets with real names, lanes and one-way rules, the Charles River from the Museum of Science up
past Harvard Square and the Eliot Bridge, the harbor, East Boston and Logan Airport, and 31,000 trees.
The ground comes from USGS elevation data, so Beacon Hill, Mission Hill and Bunker Hill are real hills.

The roads are 3D: drive over the Zakim and the Harvard Bridge, down the Mass Pike trench, through the
Big Dig tunnels under downtown, and under the harbor through the Sumner and Callahan tunnels. The whole
subway is there too, with tunnels and 45 stations, and you can drive the trains yourself: the Red, Orange
and Blue Lines, all four Green Line branches and the commuter rail. Trains also run the Red Line over the
Longfellow, the Green Line down Huntington and Comm Ave, and commuter rail and Amtrak into North and South
Station. Planes land on 4R over Castle Island, taxi to the gates, and take off from 4L. You can also leave
the car and fly around. The weather changes as you play (clear, cloudy, rain, thunderstorms, snow and
fog), with wet, reflective streets, snow on the roofs and trees, and HDR lighting with bloom.

Out on the river you can take a motorboat, a canoe, a rowboat, a single scull, an eight or an icebreaker, and
race the Head of the Charles: three miles upstream under six bridges, against nine other crews. Crews
row and coach launches putter up and down the river. When it snows, the Charles and the harbor freeze
over from the shore outward. You can drive on the ice, and icebreakers come out to cut channels through
it. Caught out in a boat when it freezes, you can radio for one to break you out. She leads a bigger
boat in to the bank; a canoe, rowboat or scull she takes aboard, crane and all, and puts you ashore at
the nearest landing. Out in the harbor there are ships too: cruise ships, container ships and tankers
coming and going or riding at anchor, with tugs, harbor ferries and fishing boats. You can take the tug,
the ferry or a fishing boat out yourself, and race them at sea against a field of other boats, all on the
course at once, along with a powerboat grand prix. Or take the helm of an icebreaker: run the ferry,
carrying commuters between landings on the frozen river (they walk down to the landing, up the gangway and
onto the foredeck, and off again at their stop), answer a Harbor Rescue call, racing the clock to boats
capsized in the harbor ice, or tow a big ship frozen in out at sea back into port.

Or take to the skies. Fly a Cessna 172 on your own, or fly airline flights gate to gate in a Cessna 402
island hopper, an Embraer E175, an A320, a 787-9 Dreamliner or an A380, each with its own weight, thrust,
handling and takeoff and approach speeds. Taxi from a remote stand to your gate, wait while the passengers
board, push back, taxi out and hold short until the tower clears you, then take off. At the other end, land,
taxi in and park so they can get off. Once you're up, fly wherever you like; thunderstorms throw you around.
The Boodyear Glimp, a 60 m airship, casts off from a mooring mast at Logan. Out over the ocean, about 110
and 150 km south-east of the city, lie Martha's Vineyard and Nantucket, built from OpenStreetMap the same
way as Boston: 24,000 buildings and 5,600 streets on the Vineyard, 14,700 and 3,100 on Nantucket, with
their towns, harbors, lighthouses and airports. Land on an island and it unlocks. After that you can start
there, drive its roads, take boats out of its harbors, and race on land and sea.

## Play

The game is a set of static files, so any local web server works. Browsers won't load the
map from a `file://` URL.

```sh
cd RaceBoston
./run.sh                           # or: python3 -m http.server 8080
```

Then open <http://localhost:8080> in Chrome, Edge, Firefox or Safari and pick a mode.

With Node 18+ installed, `run.sh` uses a small dependency-free server (`tools/serve.mjs`) that gzips
the 15 MB map file, which helps if you host the game on a network; otherwise it falls back to Python.

`Retro/` is a separate, slimmed-down version for old PCs running Netscape Navigator: see
`Retro/README.txt`.

## Modes

- **Garage** – the Sports Coupe does 200 mph flat out and 0-60 in 3.3 s. The Boston Cab and the Townie SUV
  trade speed for weight.
- **Drive a Train** – pick a line and a direction (Red Line from Harvard to Broadway, Orange Line from
  Ruggles to Sullivan Square, Blue Line out to Wood Island, the Green Line B, C, D and E branches, or the
  commuter rail into South Station) and drive it from the cab. **W** is power, **S** the brake and
  **Space** the emergency brake. Keep to the speed limit, which drops for curves and tunnels; the HUD
  warns you when a lower limit is coming. If you go well over it, the train protection stops you. At each
  station, stop with the train along the platform, close to the mark: the closer, the more points. The
  doors open, and after the dwell you're off to the next stop. Missed stops and speeding cost points, and
  each line keeps your best score. **C** switches between the cab and chase cameras.
- **On the Water** – take a boat out on the Charles. Pick one from the menu, or stop the car beside the
  river or the harbor and press **E**, which launches the last boat you used. Press **E** by the bank to go
  ashore.
  - The **motorboat** does 90 mph flat out and planes off. **Shift** gives it more punch, and it throws a
    wake.
  - In the **canoe** there are two of you, one paddling each side; hold **W** to paddle, **Shift** to sprint,
    **S** to back-paddle and **A D** to steer. It launches from Herter Park on the upper Charles.
  - In the **rowboat**, **single scull** and **eight**, hold **W** to row. The stroke rate builds over a
    few strokes, and every stroke surges the boat. **Shift** is a "power ten": a higher rate and more
    speed, while your stamina lasts. **S** holds water (blades squared in the river) and then backs the
    boat down. **A D** steer with the rudder, or spin the boat when it's stopped. The HUD shows the stroke
    rate and the split per 500 m, and **C** includes the cox's seat in the stern of the eight.
  - The **icebreaker** is a 26 m river icebreaker. It does 60 mph flat out but is slow to get going:
    0-30 mph takes about 11 s, and it needs most of a minute to reach 60. Stopping from 60 takes about
    165 m, so plan your stops. Solid ice slows it a few mph, and it smashes a channel of broken slabs
    as it goes. It fits under the BU and Eliot bridges, but the low bridges stop it, so it keeps to its
    reach of the river. When it's barely moving, a bow thruster turns it. **H** sounds the horn, and
    at night a deck light and a searchlight come on.
  - The sea boats go out from the harbor (and keep to it):
    - The **tugboat** does 15 knots, with a big push, and her thrusters turn her on a dime.
    - The **harbor ferry**, a catamaran, does 35 knots but is wide in the turns.
    - The **fishing boat** is a stern trawler, steady at 12 knots.

    They're diesels like the icebreaker: **W** ahead, **S** astern, **H** the horn. From the car, **E**
    by the harbor takes one out; by the river, they stay put.
  - On the islands (once unlocked), boats go out of Vineyard Haven, Oak Bluffs, Edgartown and Menemsha,
    and Nantucket town, Madaket and Polpis: a motorboat, the harbor ferry or a fishing boat. **E** by the
    water takes one out there too.
  - **Head of the Charles** (Championship Eights or Singles) – a three-mile head race on the real course.
    You start below the BU boathouse, go under the BU, River Street, Western Avenue, Weeks, Anderson and
    Eliot bridges, and finish by Herter Park. Ten crews start 12 s apart, and you're bow 6. It's a rolling
    start, and the clock runs from the start line. You get a split and your place at each bridge. Buoys
    mark the course, and each one you hit costs 5 s. Spectators line the banks and bridges. You finish
    with a place, a medal for the podium, the standings and your best time. On a frozen river, the race
    is rowed in a channel cleared through the ice.
  - **Icebreaker Ferry** – a shift at the helm of the icebreaker, like the taxi shift but on the river.
    There are three routes, one per reach the ship fits:
    - **BU & MIT** has six landings, including Riverside Boat Club, Magazine Beach, the DeWolfe
      Boathouse and Deerfield Street Dock.
    - **The Esplanade** runs past the sailing pavilions to the Hatch Shell.
    - **Upper Charles** runs from Herter Park and the boat clubs to past the Eliot Bridge.

    A cold snap freezes the Charles for the shift, and your weather setting comes back afterwards.

    Each landing is a floating pontoon with a shelter, a walkway up the bank and a name board.
    Passengers walk down to it in groups bound for other landings. A green beam means someone is
    waiting, and blue means you have passengers for that stop. A label over each landing lists who's
    waiting and where they're going.

    To dock, come alongside the landing slowly, with the gangway port just ahead of the deckhouse
    beside it. The lines go out and the gangway swings across. You watch the passengers for that stop
    walk off and up the bank, then the people waiting walk aboard and take their places on the
    foredeck (20 fit). The camera swings round to watch.

    Fares pay by river distance, with a tip for a quick trip. Every hard bump costs some of the tip.
    Taking a group aboard adds time to the shift clock, and delivering them adds a little more. Groups
    that wait too long give up, and your best shift is saved.
  - **Harbor Rescue** – a cold snap has frozen Boston Harbor and boats have capsized in the ice. You take
    the icebreaker out against the clock and have to get everyone aboard before it runs out. There are
    three calls:
    - **Inner Harbor**: one launch, 3 people, 2:45.
    - **Off the Seaport**: two boats between the Seaport and Logan, 6 people, 6:00.
    - **President Roads**: three wrecks strung out past Castle Island, 10 people, 8:00.

    Each upturned hull lies in a pool of broken ice under a red beam, with a label saying who's on it
    and who's in the water. To take people off a hull, come alongside slowly, with the wreck beside the
    foredeck rail. The plank goes across and they climb over one by one, while the ship is held still.
    For anyone in the water (each has an orange beam), get within 40 m and hold **Space**: a meter
    swings up and back. Let go when it's on their mark. Dead on, they catch the life ring; close, they
    swim for it; a miss is hauled back for another try. Once they have it, the line reels them in to the
    hull and they're hoisted aboard. Keep the ship steady, because at more than about 7 mph they lose
    the ring. Everyone you rescue stands on the foredeck. Your medal depends on how much time is left,
    and your best is saved. Icebreakers on patrol keep clear of the wrecks.
  - **Sea Races** – head-to-head races at sea. The whole field is out on the course at once, like a
    motor race. The other boats use the same hull physics as yours, each a shade quicker or slower and on
    its own line, and they ease off for the hard turns. Everyone bumps everyone. There are six:
    - **Powerboat Grand Prix**: six motorboats, two laps round President Roads at 90 mph.
    - **Tugboat Derby**: five tugs flat out down the Inner Harbor, slaloming the buoys.
    - **Harbor Ferry Dash**: catamarans from Long Wharf out to Castle Island.
    - **Fishing Fleet Run**: trawlers racing home from Castle Island to the Fish Pier.
    - **Nantucket Sound Sprint** (Martha's Vineyard): two laps off Oak Bluffs and East Chop in open water.
    - **Nantucket Harbor Run** (Nantucket): from Brant Point up the harbor past Pocomo, and back by Coatue.

    The course is a line of gates, each a pair of buoys (red to port, green to starboard, yellow for
    the start and finish), with a beam over the next one. Pass each between its buoys, or go back.
    After a countdown on the grid it's a standing start, and you get your place at every gate. **R**
    puts you back at the last gate you passed. You finish with a place, a medal for the podium and the
    standings. The harbor is closed to other traffic for the race, and if it's frozen, race day clears
    it.
  - **Icebreaker Tow** – a cold snap has frozen the harbor, and a big ship is frozen in out in the ice.
    There are three jobs:
    - the tanker **Bay Pioneer**, off the Seaport, back up the Inner Harbor;
    - the container ship **Northern Light**, off Castle Island, to Conley Terminal;
    - the cruise ship **Sea Aurora**, in President Roads, to the cruise terminal.

    Take the icebreaker out to her and break her free by running your bow down both her sides (the HUD
    counts the ice that's clear). Then back your stern up to her bow and stop: a line goes across from
    your towing hook. She's seven to nine times your weight, so take up the slack gently. Yank the line
    taut, or hold it past its strength, and it parts, and you'll have to come round for a new one. The
    HUD shows the strain. She follows the line like a trailer, slow to turn, and carries way long after
    you ease off, so start slowing her early. Stop her in her berth (outlined in green) to deliver her.
    Groundings, bumps and parted lines come off the fee, and a quick tow earns a bonus. While the tow is
    under way, only the ships at anchor stay in the harbor.
- **Take to the Skies** – fly from Logan, or from an island airport once you've unlocked it.
  - **Solo and free flight** – the Cessna 172 on your own, or any of the airliners empty. You start lined
    up on the runway into the wind. Take off and go where you like: over the city, out over the harbor or
    down to the islands. Each type rotates at its real speed: 55 kt for the Cessna 172, 90 for the
    Cessna 402, about 130 for the E175, 140 for the A320, 150 for the A380 and 155 for the 787, and the
    big jets need most of a long runway.
  - **Airline Flights** – 15 routes, from the Cessna 402 island hop to the Vineyard to a superjumbo dare
    into Nantucket's 6,300 ft runway; the island routes open once you've landed there. You start on a
    remote stand with the engines running. Follow the green taxi lights to your gate and stop on the mark.
    The passengers walk aboard over the jet bridge at Logan's terminals, or across the apron and up the
    stairs on the islands, and a tug pushes a jet back. Taxi to the runway the tower gives you (into the
    wind, and long enough for your type; the first officer sets the takeoff flaps as you start rolling),
    hold short until you're cleared, line up and take off. **J** skips ahead to the approach, and **[ ]**
    speed up time in the cruise. Land, taxi to the arrival gate, and the passengers get off. The pay
    depends on the landing (how many feet per minute you touched down at), how comfortable the ride was
    (g-loads and bank), and how tidily you taxied and parked. Wingtip, tail and engine strikes come off
    it, and each route keeps your best score. Logan's traffic plays along: arrivals go around if you're on
    the runway, and planes on the ground give way and keep clear of your route.
  - **The Boodyear Glimp** – a 60 m airship moored nose-first to a mast by the airfield. Open the
    throttle to cast off, climb with **↓** and descend with **↑** (like a stick, as in the planes), steer
    with **A D** and trim her with ballast (**Z X**). She cruises at 35 mph and drifts with the wind. To
    moor again, nose her up to a mast (every airfield has one), slow and low, and the ground crew takes
    her lines.
- **Fly Around** – a ghost camera that goes anywhere, through buildings and underground. Press **G** to
  start or stop flying, and **Enter** to drop the car on the road below you. On the map (**M**), click
  a spot to jump there.
- **Free Roam** – drive anywhere and discover 46 landmarks, including Fenway Park, the State House, the
  USS Constitution, MIT, Northeastern and Logan Airport. Press **M** and click the map to set a GPS
  waypoint. Once you've landed on an island you can start there too: 23 landmarks on Martha's Vineyard,
  from the Gay Head Cliffs and the Flying Horses Carousel to the Jaws bridge, and 21 on Nantucket, from
  Brant Point Light and the Whaling Museum out to Sankaty Head.
- **Races** – 8 checkpoint races between real landmarks, such as the Freedom Trail Dash, Back Bay Sprint,
  Charles River Loop and The Grand Tour. The Logan Express runs from South Station to the terminals through
  the Ted Williams Tunnel, then back to the North End under the harbor. Gold, silver and bronze times come
  from an ideal lap of each route (road types, bends, braking), and your best times are saved. The
  islands add four more once you've landed there: the Down-Island Dash (Vineyard Haven to Edgartown by
  Oak Bluffs and the Jaws bridge), the Up-Island Run (the airport to the Gay Head cliffs by way of
  Menemsha), the Sconset Sprint across Nantucket's moors to Sankaty Head, and the Madaket Run.
- **Taxi Shift** – pick up passengers, stop in the zone, and drop them off before the shift clock runs out.
  Fast, clean rides earn tips. Passengers have opinions about the Pike.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake, then reverse |
| A D / ← → | Steer |
| Space | Handbrake (drift) |
| Shift | Boost |
| H | Horn |
| B | Look back |
| C | Change camera (chase, far, hood, overhead; cab and chase in a train) |
| Drag | Look around (the view eases back when you let go) |
| M | Full map with click-to-set GPS waypoints |
| R | Reset the car onto the nearest road |
| N | Cycle day / sunset / night |
| T | Cycle the weather: clear, cloudy, rain, thunderstorm, snow, fog |
| G | Fly mode on/off (mouse look, WASD, Space/Q up and down, Shift fast, wheel for speed, Enter drops the car) |
| E | Take a boat out (stopped beside the water) / go ashore |
| Q | In a boat on frozen water: radio for an icebreaker |
| K | Mute |
| F | Fullscreen |
| Esc / P | Pause |

Flying:

| Key | Action |
| --- | --- |
| W / S | Throttle up / down (S at idle on the ground: brakes, and reverse thrust on a jet) |
| ↑ ↓ | Pitch: ↑ is nose down, like a stick (Settings can swap it) |
| A D / ← → | Roll (on the ground: steer the nosewheel) |
| Q E | Rudder |
| Space | Wheel brakes |
| Z X | Flaps up / down (the Glimp: ballast) |
| G | Gear up / down |
| B | Speed brakes |
| U | Autopilot: hold altitude, heading and speed |
| [ ] | Time compression, in the air above 1,000 ft |
| J | Skip ahead to the approach (airline flights) |
| C | Camera: chase, far chase, cockpit (with a primary flight display), tower |
| Enter | Climb out onto the nearest road (stopped on the ground) |

In a train, W/↑ is power, S/↓ the brake and Space the emergency brake. In a rowing boat, hold W to
row, Shift for a power ten, S to hold water and back down, and A D to steer. In the icebreaker, W is
ahead, S astern, A D the helm (the bow thruster turns her when stopped) and H the horn. On a Harbor
Rescue, hold Space and let go to throw a life ring. In any other boat on frozen water, **Q** radios for
an icebreaker.

In **Settings** you can set the amount of traffic, trains (Off to Max: about 22 trains around you),
planes (Off to Max: a landing and a takeoff every minute, six overflights and a full terminal), boats on
the river and the weather (Dynamic changes every few minutes, or pick one). For flying, **Flight
controls** is Assisted (fly-by-wire: she holds her attitude and bank when you let go, and won't stall) or
Direct (the raw aircraft, which you can stall), and the tower's voice can be turned off.

Gamepads work too: RT/LT for gas and brake, A handbrake, B boost, X reset, Y camera, Start pause.
On touch devices, on-screen buttons appear automatically.

## What's in the world

Everything is generated from OSM tags at load time. There are no texture or 3D model files; textures are
painted on canvases in the browser:

- **Graphics** – the scene renders into a multisampled HDR buffer, then gets bloom on lamps, windows and
  headlights, a colour grade by time of day and weather, a vignette and ACES tone mapping. Medium uses
  FXAA instead of MSAA, and Low renders straight to the screen. The sky has a drifting cloud layer with
  silver linings. The cars have clear-coat paint, and shadows have soft edges.
- **Weather** – six kinds, and Dynamic moves between them every few minutes, blending over about a
  minute.
  - Rain and snow fall around the camera (16,000 streaks, 12,000 flakes, one draw each, none in
    tunnels).
  - In the rain, streets darken and turn glossy over half a minute, with puddles you can see rings
    spreading in, and take a couple of minutes to dry. Street lights reflect brighter on wet asphalt.
  - Snow settles on the ground, roofs and trees and stays thinner on plowed roads, with darker wheel
    tracks.
  - Fog closes in to about 200 m, and the sky disappears into it.
  - Thunderstorms flash (sky, clouds and light) with thunder a few seconds later.
  - Overcast dims the sun and softens the shadows. Rain adds a hiss.
  - Headlights come on in rain, snow and fog, and their beams show in the air. Your tyres throw up
    spray on wet roads, and raindrops bead and slide on the windscreen in the hood view and the train
    cab.
  - Grip drops by about 16% on wet roads and about 40% on snow.
- **Ice** – while it snows, the Charles freezes from the banks inward. Pancake floes drift ahead of
  the edge, and in about a minute and a half the ice closes across the river. The harbor freezes out
  from its shores at the same time and closes as the river does. The ponds ice over too (the Public
  Garden lagoon, the Fens, Jamaica Pond).
  - Each sheet is drawn by the water shader from its own grid: 4 m over the river and 6 m over the
    harbor. The grid stores each spot's distance to the shore, plus where and when the ice was broken.
  - Once it's frozen, the ice carries a car, with a fifth of the grip, so have fun sliding. Boats are
    locked in except in open water.
  - Icebreakers work the reaches between the bridges they fit under. Each pass is in a new lane, and
    they turn around at the ends. Out in the harbor they work the main channel, from the Inner Harbor
    past Logan and Castle Island to the outer harbor, which is found the way the river's centre line is.
  - Frozen in, press **Q** to radio for help. The nearest icebreaker on that reach comes, or one is sent
    from along it. She circles you once, and the sheet inside her turn cracks up as she goes. Under the
    low bridges no icebreaker can reach you; walk ashore across the ice instead (**E**).
    - In the motorboat or the eight, she then bears off toward the nearest bank with a road behind it,
      cutting a channel and peeling off short of the bank so you can follow her in. At the bank, **E**
      takes you ashore, and she goes back to her patrol.
    - A canoe, rowboat or single scull she takes aboard. She stops beside you, and a life ring comes
      across on a line: you're hauled alongside and hoisted up her side onto the deck. Her deck crane
      swings out, the lines go on your boat, and it's lifted aboard and set down on the foredeck. Then
      she sails for the nearest landing (an Icebreaker Ferry stop on the river, a pier such as Long Wharf
      or Piers Park in the harbor), comes alongside and runs out the gangway. You walk ashore and carry
      on in your car on the street above, while your boat sails off on her deck. **E** on the way skips
      ahead to the landing.
  - Their bow cuts a channel of broken slabs that tumble aside, with a grinding sound nearby. The
    channel freezes grey after a minute and white again a couple of minutes later. Drive into one and
    you'll go through.
  - Once the snow stops, it all thaws over a few minutes.
- **Boats** – the river's centre line is built when the map is. The river is
  rasterised, every cell gets its distance to the bank, and a path that keeps clear of both banks is found
  from Watertown down to the Museum of Science dam. Boats follow it.
  - Rowing crews (eights, fours and singles) keep to the right and spin to row back at the ends. Coach
    launches shadow them, and motorboats roam the basin.
  - Crews steer between bridge piles, ease off behind you, and turn back.
  - Shells have riggers and sliding seats, and their oars are animated through the catch, drive, finish,
    feathered recovery and squaring up. Coxes sit in the stern.
  - Your hull collides with the banks, piers, bridge piles, other boats and solid ice (an icebreaker
    rams through ice instead, but stops at a bridge lower than its 6.4 m superstructure). Ferry
    landings are fendered: the hull slides along them rather than sticking. Wakes spread in two arms
    behind anything with an engine.
  - **Ships at sea** keep to the harbor, on its main channel line: cruise ships, container ships stacked
    with boxes, and tankers, coming in to the terminals or heading out to sea, each with a tug off her
    bow. More ride at anchor in President Roads. At the Many setting for boats it's a busy port, with
    twenty-odd ships about the harbor: half a dozen at anchor and four under way. Harbor ferries run the length of the
    channel and fishing boats work the outer harbor. The ships keep to starboard and slow behind one
    another, and the icebreakers keep clear of them. When the harbor freezes, the ferries and fishing
    boats stay in port, while the big ships keep going at reduced speed, crushing a channel. Their window
    bands light up at night, and they show at much longer range than small boats.
  - Ferry passengers are instanced figures in winter coats and hats, with arms and legs that swing as
    they walk. They walk paths from the street down the walkway to the landing, then over the gangway.
    Once aboard they ride in the ship's own frame, so nobody is left floating when she casts off.
  - Footbridges over the water, such as the Weeks Bridge, rise into arches on piers that boats pass
    between and cars can cross.
- **Terrain** – heights come from the USGS 3D Elevation Program, through the AWS Terrain Tiles
  open dataset, resampled to a 10 m grid. The highest point is 67 m on Parker Hill above
  Mission Hill; the State House sits at 27 m on Beacon Hill and the Bunker Hill Monument at 24 m.
  Water is flat at its own level and the banks stay above it. Every map layer (parks, streets,
  sidewalks, crosswalks, runways, rail) is draped over the ground, and buildings stand on the lowest
  ground under their footprint. Road and rail heights from the elevation solver are relative to the
  ground, and decks are smoothed between their ends, so a bridge doesn't step with the riverbank
  under it. The car climbs and coasts on real slopes.
- **Roads** – widths come from the lane count and road class. Lane markings follow US conventions
  (double yellow lines, dashed white lane lines, edge lines) and stop cleanly at intersections.
  There are also sidewalks with curbs, mapped crosswalks and rail lines, including the Green Line tracks.
- **Bridges, ramps and tunnels** – OSM only records vertical *order* (`bridge`, `tunnel`, `layer`), so
  the map builder infers heights. Decks clear whatever they cross (6.5 m over roads, 3 m over water)
  and tunnels sit 7.5 m down per layer. Where a street crosses an at-grade highway, the highway drops into
  a trench, which is how the Pike runs through Back Bay. Everything in between is solved as a smooth ramp,
  with grades capped at about 11%. Bridges get decks, pillars and railings or jersey barriers. Tunnels get
  tiled walls, ceilings and lights, and open cuts get retaining walls. A stencil mask hides anything
  underground except where the ground is actually open. The car has real vertical physics: it follows
  ramps, catches air off crests and can fall off an edge, so stay on the deck.
- **Logan Airport** – all six runways have FAA-style markings and painted numbers, plus taxiways with yellow
  lines, hold-short bars and 166 real stands. At night there are edge, centreline, threshold and taxiway
  lights, and a sequenced strobe on the approach. Airliners (narrowbody, widebody and regional, in
  fictional liveries) work on a loop:
  - Arrivals join a 3° glidepath to 4R, flare, roll out, take a high-speed exit and taxi to a free stand,
    holding short of 4L when departures are rolling.
  - Departures push back, taxi, hold short, line up and take off from 4L, then turn toward their
    destinations over the city.
  - Arrivals are spaced about a minute apart, and go around if the runway is still occupied.
  - Overflights cross at altitude.
  - Planes on the ground stop for your car and are solid. You can hear the jets.
- **Flying** – each aircraft is a rigid body. Lift, drag and side force come from the angle of attack and
  sideslip. The engines lose power as the air thins with height (the standard atmosphere), a propeller's
  thrust also falls with airspeed, and close to the ground the wing gets extra lift (ground effect).
  Flaps add lift and drag and have speed limits. The wheels are springs with brakes and a steerable
  nosewheel, and a tail strike, an engine pod in the grass or a wingtip on a terminal all register. A
  hard enough contact, or the water, ends the flight. With assisted controls the keys command pitch and
  roll: let go and she holds her attitude and bank (levelling out from a shallow one), with stall and
  over-bank protection and a yaw damper. The cockpit view has a primary flight display: the attitude,
  speed and altitude tapes, vertical speed, heading, flaps, gear, thrust and warnings. The autopilot
  holds altitude, heading and speed.
- **Weather in the air** – the wind comes from the weather, with gusts that build in rain and get rough
  in a thunderstorm: storm cells with up- and downdrafts, sudden jolts, and microburst outflow near the
  ground. Cloud layers have a base and a top, and flying into them fogs the view.
- **The islands** – Martha's Vineyard and Nantucket are built the same way as Boston, with their own
  ground from the elevation data, shingled houses (their heights guessed where OSM has none), ponds,
  beaches, harbors and the airports at MVY and ACK, each with its runways, taxiways and stands. They load
  in the background as you fly toward them. Between them and Boston there's a coarse backdrop of eastern
  Massachusetts, Cape Cod and Buzzards Bay (300 m height cells) and the open ocean, so the coast is there
  as you fly down it, and the full map shows the whole coast while you're in the air.
- **Trains** – OSM route relations tell which track each line uses. Red, Orange and Blue Line cars,
  two-car Green Line trolleys with pantographs, MBTA bilevel commuter trains, Amtrak and Grand Junction
  freight all follow the real track. They stop at stations, reverse at terminals, and slip into tunnel
  portals. Trains are solid, so don't park on the tracks. While you drive a train, the others run in the
  tunnels too, but stay off your line.
- **The subway** – tunnels follow the ground about 9-11 m down. They go deeper per OSM `layer`, and
  where two lines cross, the lower one passes at least 8 m under the other, ramping down at 4%. Tracks
  side by side share one box with tiled walls, lamps and a ceiling, and ramp up at 4.5% to their
  portals through open cuts with retaining walls. Station platforms come from their OSM outlines: high
  platforms for the Red, Orange and Blue Lines and low ones for the Green Line and commuter rail, with a
  yellow edge strip. Underground stations have bright ceiling lights and a taller hall, and the wall
  steps back behind each platform. Name boards carry each line's colour. In a tunnel the daylight dims
  and the distance fades to dark.
- **Street signs** – Boston-green name blades on a corner pole at about 2,200 named intersections, with
  standard abbreviations (St, Ave, Sq).
- **Landmarks** – Fenway Park has a brick arched facade, seating that slopes down to the field, the
  infield, foul lines and bases, the Green Monster with its hand-operated scoreboard, the Pesky Pole,
  light towers and a "FENWAY PARK" marquee. The State House has its gilded dome. Other
  landmarks: the Custom House clock tower, the 200 Clarendon mirror-glass tower, the Prudential with its
  mast, the Bunker Hill obelisk, the USS Constitution with masts and rigging, and Faneuil Hall's golden
  grasshopper. Trinity Church, the Boston Public Library and Quincy Market have brownstone and granite
  facades.
- **Buildings** – extruded from footprints using the `height` and `building:levels` tags, with
  Simple-3D-Buildings parts. Windows are drawn procedurally and light up at night.
- **Water** – the OSM coastline is assembled into land and sea polygons, plus the Charles River and ponds.
  Bridges over water get railings. Drive into the river and you'll splash, then get put back on the road.
- **Traffic** – AI cars drive the real road graph, respect one-way streets, stop at the 1,400+ mapped
  traffic signals, and get knocked around if you hit them.
- **GPS** – A* routing over the road network, shown on a rotating minimap and a 3D arrow. It will cut the
  wrong way down a one-way street, but never up a highway or a ramp.

## Project layout

```
index.html            entry point (import map -> vendored three.js)
src/                  game code (ES modules, no build step)
  main.js             bootstrap, state machine, main loop
  world.js            all static geometry (roads, buildings, water, trees)
  structures.js       bridge decks, pillars, railings, tunnels, cuts, ground mask
  terrain.js          ground heights and draping map layers over the hills
  railworld.js        subway tunnels, rail cuts, portals, station platforms and name boards
  trainmode.js        driving a train: lines, controls, speed limits, stops, cab/chase camera
  landmarks.js        Fenway Park, the State House dome and other dressed landmarks
  signs.js            street name signs
  trains.js           AI trains on the rail network (and drawing yours)
  airport.js          Logan's runways, taxiways, markings and airfield lights
  planes.js           aircraft: arrivals, taxiing, departures, overflights
  flight.js           flight physics: the airframe, engines, wheels, atmosphere, fly-by-wire, turbulence
  aircraft.js         the types you can fly (Cessna 172 to A380, the Glimp): specs, models, crash points
  flightmode.js       flying: controls, cameras, autopilot, landings, strikes and crashes, the mast, sounds
  airports.js         Logan, MVY and ACK for flying: runway ends, taxi routes, hold-short points, stands
  airline.js          Airline Flights: the routes, taxi lights, boarding and deboarding, pushback, the tower, pay
  pfd.js              the cockpit's primary flight display
  regions.js          Boston and the islands: loading a map in the background, switching between them
  backdrop.js         the low-detail coast and the ocean between the maps
  fly.js              ghost camera for fly mode
  boats.js            boats: river and harbor channel lines, hull physics, rowing and paddling, models, AI crews, icebreakers, ships, wakes
  boatmode.js         on the water: boat mode, E to board / go ashore, Q for an icebreaker, the Head of the Charles race
  ferry.js            Icebreaker Ferry: landings, passengers boarding and getting off, the shift
  rescue.js           Harbor Rescue: capsized boats in the harbor ice, the plank, life rings, the clock
  pickup.js           an icebreaker taking a small boat aboard: life ring, hoist, crane, to a landing and ashore
  searace.js          Sea Races: buoy-gate courses in the harbor, AI racers with the same physics, positions, results
  tow.js              Icebreaker Tow: a frozen-in ship, breaking her free, the towline and its physics, the berth
  ice.js              river and harbor ice: freezing and thawing, the ice grids, broken channels
  materials.js        shader patches: windows, lane markings, curbs, water waves and ice, wet / snowy surfaces
  post.js             post-processing: HDR, bloom, colour grade, lens rain, tone mapping, FXAA
  weather.js          weather states, rain and snow, lightning, wetness and snow cover
  effects.js          skid marks, tyre spray, headlight beams
  vehicle.js          arcade car physics; collision.js: walls/trees/surfaces
  traffic.js          AI cars + traffic signals; roadgraph.js: graph + A*
  missions.js         free roam, races, taxi; hud.js: HUD, minimap, big map
data/boston.json      processed map, built from OpenStreetMap
data/terrain.bin      10 m ground height grid, from USGS elevation data
data/vineyard.*       Martha's Vineyard: map (.json) and ground heights (.terrain.bin)
data/nantucket.*      Nantucket: map and ground heights
data/backdrop.*       300 m heights of the coast and sea floor between the maps
tools/serve.mjs       the small web server run.sh uses
vendor/               three.js r186 (with its post-processing add-ons) and earcut (MIT / ISC)
Retro/                a slimmed-down version for old PCs (Netscape Navigator)
```

## Notes

The game is plain JavaScript and WebGL (Three.js). WebAssembly wasn't needed: rendering runs on the
GPU, and the car physics, collision queries and traffic AI take well under a millisecond per frame.

The map data (`data/`) was built from OpenStreetMap and USGS elevation data with a set of local tools
that aren't part of this repository, which holds just what the game needs to run.

Road and tunnel heights are an educated guess from OSM's vertical-order tags. The ground is real, but
the solver still works relative to it: a road keeps its height above the ground, so a highway on a
hillside follows the hill. Subway depths are a guess too: OSM records which tunnel is below which, not how
deep they are. Garage and loading-dock ramps on service roads are left out.

The flight models are tuned to each type's published speeds, weights and thrust, but they are a game's
approximation, not a certified simulator. Most island buildings have no height in OSM, so they get a
typical one for their kind (one and a half to two and a half storeys for a house).

## Credits

- Map data © OpenStreetMap contributors, available under the
  [Open Database License](https://www.openstreetmap.org/copyright).
- Elevation: USGS 3D Elevation Program (3DEP), via the
  [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) open dataset (terrarium format).
- [three.js](https://threejs.org) (MIT) and [earcut](https://github.com/mapbox/earcut) (ISC).
