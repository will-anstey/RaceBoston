RETRO RACE BOSTON
=================

A slimmed-down, top-down version of Race Boston for an old PC: an IBM Aptiva
(Pentium, Windows 95/98) running Netscape Navigator 3.x or 4.x. Race through
6 checkpoints in downtown Boston, from the State House to Fenway Park.

The game is a Java 1.0 applet (RetroRace.class), like the browser games of
1996-97: Navigator 3 can't move things around a page with JavaScript, but it
runs Java. The map is 54 pre-rendered 16-colour GIF tiles (about 340 KB)
from the main game's OpenStreetMap data; the car is a 16-direction sprite.

Running it
----------
1. On this Mac:    Retro/run.sh
   It prints the address(es) to use, e.g. http://192.168.2.1:8000/
   ("localhost" only works on the Mac itself; the Aptiva needs the Mac's IP.)
2. On the Aptiva, open that address in Navigator and pick the size for the
   Aptiva's screen resolution (all 4:3, so they suit a square monitor):
     640 x 480   for a 1024x768 desktop
     448 x 336   for 800x600
     320 x 240   for 640x480 (also the fastest on a slow Pentium)
   (Right-click the desktop > Properties > Settings shows the resolution.)
3. Click the map once so the applet gets the keyboard, then drive.
4. If it can't connect: allow node through the Mac firewall (System Settings >
   Network > Firewall), and check both machines are on the same network.
   With a direct Ethernet cable and no router, give them addresses by hand,
   e.g. Mac 192.168.2.1 and Aptiva 192.168.2.2, mask 255.255.255.0.

Controls: arrow keys or W A S D (also I J K L) to drive, R to restart.
Grass is slow; buildings and water stop you. Your best time is kept until
you leave the page.

Troubleshooting
---------------
- A grey box or "needs Java": Options > Network Preferences > Languages,
  tick "Enable Java", then Reload.
- An old copy or errors from before: Options > Network Preferences > Cache,
  Clear Memory Cache and Clear Disk Cache, then hold Shift and click Reload.
- Java errors show in Options > Show Java Console.

Navigator 4 also has a version without Java: nav4.html (it uses layers,
which Navigator 3 doesn't have).

Rebuilding (only after changing the main map or the applet):
  Retro/run.sh --rebuild
The scripts need Node 18+ (the default "node" here is v0.10, which can't run
them); recompiling the applet needs JDK 11 (tools/compile-applet.sh), which
builds a Java 1.0-compatible class file (version 45.3).
