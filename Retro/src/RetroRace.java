// Retro Race Boston as a Java 1.0 applet, for Netscape Navigator 3.
//
// Only Java 1.0.2 APIs: the AWT 1.0 event methods (keyDown, mouseDown),
// Applet.getImage, MediaTracker, URL.openStream, StringBuffer. No inner
// classes, no Swing, and no "+" on strings (modern javac turns that into
// StringBuilder, which Java 1.0 doesn't have). Inherited methods are called
// through "comp" (Component) and "app" (Applet): modern javac records a call
// like size() as RetroRace.size(), and Navigator 3's Java only finds methods
// in the class a call names, so it must name the class that declares them.
// tools/compile-applet.sh compiles it, checks that, and stamps the class
// file as version 45.3 (JDK 1.0/1.1).
//
// The map is the same pre-rendered GIF tiles as the Navigator 4 version;
// retro.txt holds the run-length coded collision grid and the checkpoints.

import java.applet.Applet;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Event;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Image;
import java.awt.MediaTracker;
import java.io.InputStream;
import java.net.URL;

public class RetroRace extends Applet implements Runnable {
  // Map (from retro.txt): size in pixels, tiles, collision cell, metres per pixel.
  int mapW, mapH, tile, tilesX, tilesY, cell, mpp;
  int nChecks;
  int[] chkX = new int[16], chkY = new int[16];
  String[] chkName = new String[16];
  String[] rows;
  byte[][] decoded;

  Image[] tiles;
  Image[] cars = new Image[16];
  Image flag;
  Image buf;
  Graphics bg;
  int vw, vh;
  Font font = new Font("Helvetica", Font.BOLD, 12);
  Font small = new Font("Helvetica", Font.PLAIN, 11);
  Color water = new Color(44, 84, 140), panel = new Color(16, 24, 32), gold = new Color(244, 197, 66);

  Component comp = this;
  Applet app = this;
  Thread runner;
  boolean up, down, left, right, focused, ready;
  String status = "Loading Boston...";

  // Car, in map pixels (1 px = 2 m).
  double x, y, heading, speed;
  static final double MAXV = 48, MAXV_OFF = 14, ACC = 26, BRAKE = 50, DRAG = 8;

  // Race.
  int next;
  boolean started, done;
  long t0, best, lastHud;
  String msg = "", hud1 = "", hud2 = "";

  public void init() {
    Dimension d = comp.size();
    vw = d.width; vh = d.height;
    buf = comp.createImage(vw, vh);
    bg = buf.getGraphics();
  }

  public void start() {
    if (runner == null) { runner = new Thread(this); runner.start(); }
  }

  public void stop() { runner = null; }

  // ------------------------------------------------------------ loading
  String fetch(String name) throws Exception {
    InputStream in = new URL(app.getCodeBase(), name).openStream();
    byte[] data = new byte[65536];
    int n = 0;
    for (;;) {
      if (n == data.length) {
        byte[] more = new byte[data.length * 2];
        System.arraycopy(data, 0, more, 0, n);
        data = more;
      }
      int k = in.read(data, n, data.length - n);
      if (k < 0) break;
      n += k;
    }
    in.close();
    return new String(data, 0, 0, n);
  }

  int intAt(String line, int[] pos) {
    int i = pos[0];
    while (i < line.length() && line.charAt(i) == ' ') i++;
    int j = i;
    while (j < line.length() && line.charAt(j) != ' ') j++;
    pos[0] = j;
    return Integer.parseInt(line.substring(i, j));
  }

  void load() throws Exception {
    String text = fetch("retro.txt");
    int at = 0, row = -1;
    while (at < text.length()) {
      int end = text.indexOf('\n', at);
      if (end < 0) end = text.length();
      String line = text.substring(at, end);
      at = end + 1;
      if (row >= 0) { if (row < rows.length) rows[row++] = line; continue; }
      int[] pos = new int[1];
      if (line.startsWith("MAP ")) {
        pos[0] = 4;
        mapW = intAt(line, pos); mapH = intAt(line, pos); tile = intAt(line, pos);
        tilesX = intAt(line, pos); tilesY = intAt(line, pos); cell = intAt(line, pos); mpp = intAt(line, pos);
      } else if (line.startsWith("CHECK ") && nChecks < 16) {
        pos[0] = 6;
        chkX[nChecks] = intAt(line, pos); chkY[nChecks] = intAt(line, pos);
        chkName[nChecks++] = line.substring(pos[0] + 1);
      } else if (line.startsWith("ROWS ")) {
        pos[0] = 5;
        rows = new String[intAt(line, pos)];
        decoded = new byte[rows.length][];
        row = 0;
      }
    }
    tiles = new Image[tilesX * tilesY];
    MediaTracker mt = new MediaTracker(this);
    for (int i = 0; i < 16; i++) {
      cars[i] = app.getImage(app.getCodeBase(), join3("tiles/car", Integer.toString(i), ".gif"));
      mt.addImage(cars[i], 0);
    }
    flag = app.getImage(app.getCodeBase(), "tiles/check.gif");
    mt.addImage(flag, 0);
    mt.waitForAll();
  }

  // ------------------------------------------------------------ strings
  static String join3(String a, String b, String c) {
    StringBuffer s = new StringBuffer(a);
    s.append(b); s.append(c);
    return s.toString();
  }

  static void time(StringBuffer s, long ms) {
    long sec = ms / 1000;
    s.append(sec / 60); s.append(':');
    if (sec % 60 < 10) s.append('0');
    s.append(sec % 60); s.append('.'); s.append((ms % 1000) / 100);
  }

  // ------------------------------------------------------------ collision
  // Rows are run-length coded: a = blocked, b = road, c = off road.
  byte cellAt(double px, double py) {
    int r = (int) Math.floor(py / cell), c = (int) Math.floor(px / cell);
    if (r < 0 || c < 0 || r >= rows.length) return (byte) 'a';
    byte[] d = decoded[r];
    if (d == null) {
      String s = rows[r];
      d = new byte[mapW / cell];
      int i = 0, o = 0, n = s.length();
      while (i < n) {
        char t = s.charAt(i);
        int j = i + 1, len = 0;
        while (j < n && s.charAt(j) >= '0' && s.charAt(j) <= '9') { len = len * 10 + (s.charAt(j) - '0'); j++; }
        for (int k = 0; k < len && o < d.length; k++) d[o++] = (byte) t;
        i = j;
      }
      decoded[r] = d;
    }
    return c < d.length ? d[c] : (byte) 'a';
  }

  // ------------------------------------------------------------ game
  void restart() {
    x = chkX[0]; y = chkY[0];
    heading = 0; speed = 0; next = 1; started = false; done = false;
    msg = join3("Drive to ", chkName[1], "");
    lastHud = 0;
  }

  void step(double dt) {
    double vmax = cellAt(x, y) == 'b' ? MAXV : MAXV_OFF;
    if (up) speed += ACC * dt;
    else if (down) speed -= (speed > 0 ? BRAKE : ACC * 0.5) * dt;
    else speed -= (speed > 0 ? 1 : -1) * Math.min(Math.abs(speed), DRAG * dt);
    if (speed > vmax) speed = Math.max(vmax, speed - 60 * dt);
    if (speed < -10) speed = -10;
    double turn = 2.6 * Math.min(1, Math.abs(speed) / 12) * (speed < 0 ? -1 : 1);
    if (left) heading -= turn * dt;
    if (right) heading += turn * dt;
    double nx = x + Math.sin(heading) * speed * dt, ny = y - Math.cos(heading) * speed * dt;
    if (cellAt(nx, ny) == 'a') speed = -speed * 0.3;   // bumped a building or the water
    else { x = nx; y = ny; }
    if (speed != 0 && !started && !done) { started = true; t0 = System.currentTimeMillis(); }
    if (!done && next < nChecks) {
      double dx = x - chkX[next], dy = y - chkY[next];
      if (dx * dx + dy * dy < 14 * 14) {
        next++;
        if (next >= nChecks) {
          done = true;
          long t = System.currentTimeMillis() - t0;
          StringBuffer s = new StringBuffer("FINISHED in ");
          time(s, t);
          if (best == 0 || t < best) { best = t; s.append(" - new best!"); }
          s.append("  Press R to race again.");
          msg = s.toString();
        } else msg = join3("Drive to ", chkName[next], "");
      }
    }
  }

  void hudText(long now) {
    if (now - lastHud < 250) return;
    lastHud = now;
    StringBuffer s = new StringBuffer();
    s.append(Math.round(Math.abs(speed) * mpp * 2.237)); s.append(" MPH   ");
    if (!started) s.append("0:00.0"); else if (!done) time(s, now - t0);
    s.append("   Checkpoint "); s.append(Math.min(next, nChecks - 1)); s.append('/'); s.append(nChecks - 1);
    if (best > 0) { s.append("   Best "); time(s, best); }
    hud1 = s.toString();
    s = new StringBuffer(msg);
    if (!done && next < nChecks) {
      double dx = chkX[next] - x, dy = chkY[next] - y;
      String[] dirs = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
      int k = (int) Math.round(Math.atan2(dx, -dy) / (2 * Math.PI) * 8);
      s.append("   "); s.append(Math.round(Math.sqrt(dx * dx + dy * dy) * mpp / 10) * 10); s.append(" m "); s.append(dirs[(k + 8) % 8]);
    }
    hud2 = s.toString();
  }

  void render() {
    if (!ready) {
      bg.setColor(panel); bg.fillRect(0, 0, vw, vh);
      bg.setColor(Color.white); bg.setFont(font);
      bg.drawString("RETRO RACE BOSTON", 16, 30);
      bg.setFont(small); bg.drawString(status, 16, 50);
      return;
    }
    int vx = (int) Math.round(x - vw / 2.0), vy = (int) Math.round(y - vh / 2.0);
    if (vx > mapW - vw) vx = mapW - vw;
    if (vy > mapH - vh) vy = mapH - vh;
    if (vx < 0) vx = 0;
    if (vy < 0) vy = 0;
    // Tiles under the view (loaded on demand); far ones are let go.
    int c0 = vx / tile, c1 = (vx + vw - 1) / tile, r0 = vy / tile, r1 = (vy + vh - 1) / tile;
    for (int ty = 0; ty < tilesY; ty++) {
      for (int tx = 0; tx < tilesX; tx++) {
        int i = ty * tilesX + tx;
        boolean need = tx >= c0 - 1 && tx <= c1 + 1 && ty >= r0 - 1 && ty <= r1 + 1;
        if (need && tiles[i] == null) {
          StringBuffer s = new StringBuffer("tiles/t");
          s.append(tx); s.append('_'); s.append(ty); s.append(".gif");
          tiles[i] = app.getImage(app.getCodeBase(), s.toString());
          comp.prepareImage(tiles[i], this);
        } else if (!need && tiles[i] != null && (tx < c0 - 2 || tx > c1 + 2 || ty < r0 - 2 || ty > r1 + 2)) {
          tiles[i].flush();
          tiles[i] = null;
        }
      }
    }
    bg.setColor(water); bg.fillRect(0, 0, vw, vh);
    for (int ty = r0; ty <= r1; ty++) for (int tx = c0; tx <= c1; tx++) bg.drawImage(tiles[ty * tilesX + tx], tx * tile - vx, ty * tile - vy, this);
    if (next < nChecks) bg.drawImage(flag, chkX[next] - vx - 8, chkY[next] - vy - 8, this);
    double a = heading % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    int pic = (int) Math.round(a / (2 * Math.PI) * 16) % 16;
    bg.drawImage(cars[pic], (int) Math.round(x) - vx - 8, (int) Math.round(y) - vy - 8, this);
    // Text panel along the top.
    bg.setColor(panel); bg.fillRect(0, 0, vw, 34);
    bg.setFont(font); bg.setColor(Color.white); bg.drawString(hud1, 6, 14);
    bg.setFont(small); bg.setColor(gold); bg.drawString(focused ? hud2 : "Click here to drive (arrows or W A S D, R restarts)", 6, 29);
  }

  public void run() {
    if (!ready) {
      try { load(); ready = true; restart(); }
      catch (Exception e) { Throwable t = e; status = join3("Could not load the map: ", t.toString(), ""); }
    }
    long last = System.currentTimeMillis();
    while (runner == Thread.currentThread()) {
      long now = System.currentTimeMillis();
      double dt = (now - last) / 1000.0;
      last = now;
      if (dt > 0.1) dt = 0.1;
      if (ready) { step(dt); hudText(now); }
      render();
      comp.repaint();
      try { Thread.sleep(40); } catch (InterruptedException e) { }
    }
  }

  public void update(Graphics g) { paint(g); }
  public void paint(Graphics g) { if (buf != null) g.drawImage(buf, 0, 0, this); }

  // ------------------------------------------------------------ input (AWT 1.0)
  boolean key(int k, boolean on) {
    if (k == Event.UP || k == 'w' || k == 'W' || k == 'i' || k == 'I') up = on;
    else if (k == Event.DOWN || k == 's' || k == 'S' || k == 'k' || k == 'K') down = on;
    else if (k == Event.LEFT || k == 'a' || k == 'A' || k == 'j' || k == 'J') left = on;
    else if (k == Event.RIGHT || k == 'd' || k == 'D' || k == 'l' || k == 'L') right = on;
    else if ((k == 'r' || k == 'R') && on && ready) restart();
    else return false;
    return true;
  }
  public boolean keyDown(Event e, int k) { return key(k, true); }
  public boolean keyUp(Event e, int k) { return key(k, false); }
  public boolean mouseDown(Event e, int mx, int my) { comp.requestFocus(); return true; }
  public boolean gotFocus(Event e, Object o) { focused = true; return true; }
  public boolean lostFocus(Event e, Object o) { focused = false; up = down = left = right = false; return true; }
}
