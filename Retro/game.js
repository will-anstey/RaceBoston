// Retro Race Boston - top-down driving for Netscape Navigator 4 (and any
// later browser). Written for JavaScript 1.1/1.2: no try/catch, no strict
// equality, no array or object literals, no JSON. Every global starts with
// "rb" so nothing clashes with Navigator's own window properties (moveTo,
// stop, find, home...). Navigator 4 moves positioned DIVs as layers.

var rbNS4 = document.layers ? true : false;
var rbVW = 448, rbVH = 336;          // viewport, picked to fit the window (4:3)
var rbLeft = 8, rbTop = 8;

var rbView, rbMap, rbCar, rbFlag, rbHud, rbHelp, rbCarImg;
var rbPics = new Array(16);
var rbKeys = new Object();
var rbCache;

// Car state, in map pixels (1 px = 2 m).
var rbX = 0, rbY = 0, rbHeading = 0, rbSpeed = 0, rbShown = -1;
var rbMAXV = 48, rbMAXV_OFF = 14, rbACC = 26, rbBRAKE = 50, rbDRAG = 8;

// Race state.
var rbNext = 1, rbStarted = false, rbT0 = 0, rbDone = false, rbLastHud = 0, rbLast = 0, rbMsg = '';

// ------------------------------------------------------------ layers
function rbLayer(id) {
  if (rbNS4) {
    if (document.layers[id]) return document.layers[id];
    if (document.layers['view']) return document.layers['view'].document.layers[id];
    return null;
  }
  if (document.getElementById) return document.getElementById(id);
  if (document.all) return document.all[id];
  return null;
}
function rbPlace(l, x, y) {
  if (rbNS4) l.moveTo(x, y);
  else { l.style.left = x + 'px'; l.style.top = y + 'px'; }
}
function rbSize(l, w, h) {
  if (rbNS4) { l.clip.width = w; l.clip.height = h; }
  else { l.style.width = w + 'px'; l.style.height = h + 'px'; l.style.clip = 'rect(0px ' + w + 'px ' + h + 'px 0px)'; }
}
function rbWrite(l, html) {
  if (rbNS4) { l.document.open(); l.document.write(html); l.document.close(); }
  else l.innerHTML = html;
}

// Largest 4:3 play area that fits the browser window (room for the text
// below it), centred: 640x480 on a 1024x768 or bigger screen, 512x384 at
// 800x600, 400x300 at 640x480.
function rbFit() {
  var w = 0, h = 0;
  if (window.innerWidth) { w = window.innerWidth; h = window.innerHeight; }
  else if (document.body && document.body.clientWidth) { w = document.body.clientWidth; h = document.body.clientHeight; }
  if (!w) { w = 640; h = 400; }
  var sizes = new Array(640, 576, 512, 448, 400, 320);
  for (var i = 0; i < sizes.length; i++) {
    rbVW = sizes[i]; rbVH = sizes[i] * 3 / 4;
    if (rbVW <= w - 24 && rbVH <= h - 86) break;
  }
  rbLeft = Math.max(8, Math.floor((w - rbVW) / 2) - 4);
  rbTop = Math.max(4, Math.floor((h - rbVH - 84) / 2));
  rbPlace(rbView, rbLeft, rbTop);
  rbSize(rbView, rbVW, rbVH);
  rbPlace(rbHud, rbLeft, rbTop + rbVH + 6);
  rbPlace(rbHelp, rbLeft, rbTop + rbVH + 44);
}

// ------------------------------------------------------------ collision
// ROWS[y] is run-length coded: a = blocked, b = road, c = off road.
function rbDecodeRow(y) {
  var s = ROWS[y], out = new Array(), i = 0, n = s.length;
  while (i < n) {
    var t = s.charAt(i), j = i + 1;
    while (j < n && s.charAt(j) >= '0' && s.charAt(j) <= '9') j++;
    var len = parseInt(s.substring(i + 1, j), 10);
    for (var k = 0; k < len; k++) out[out.length] = t;
    i = j;
  }
  return out;
}
function rbCell(x, y) {
  var r = Math.floor(y / CELL), c = Math.floor(x / CELL);
  if (r < 0 || c < 0 || r >= ROWS.length) return 'a';
  if (!rbCache[r]) rbCache[r] = rbDecodeRow(r);
  var v = rbCache[r][c];
  return v ? v : 'a';
}

// ------------------------------------------------------------ input
// Navigator 4 gives character codes (no arrow keys); later browsers key codes.
function rbCode(e) {
  if (rbNS4) return e.which;
  if (!e) e = window.event;
  return e.keyCode ? e.keyCode : e.which;
}
function rbKeyName(k) {
  if (k == 119 || k == 87 || k == 105 || k == 73 || k == 38) return 'up';
  if (k == 115 || k == 83 || k == 107 || k == 75 || k == 40) return 'down';
  if (k == 97 || k == 65 || k == 106 || k == 74 || k == 37) return 'left';
  if (k == 100 || k == 68 || k == 108 || k == 76 || k == 39) return 'right';
  if (k == 114 || k == 82) return 'reset';
  return '';
}
function rbKeyDown(e) {
  var n = rbKeyName(rbCode(e));
  if (n == 'reset') rbRestart();
  else if (n != '') rbKeys[n] = true;
  return n == '';
}
function rbKeyUp(e) {
  var n = rbKeyName(rbCode(e));
  if (n != '') rbKeys[n] = false;
  return n == '';
}

// ------------------------------------------------------------ game
function rbRestart() {
  rbX = CHECKS[0][1]; rbY = CHECKS[0][2];
  rbHeading = 0; rbSpeed = 0; rbNext = 1; rbStarted = false; rbDone = false;
  rbMsg = 'Drive to ' + CHECKS[1][0];
  rbLastHud = 0;
}
function rbFmt(ms) {
  var s = Math.floor(ms / 1000), t = Math.floor((ms % 1000) / 100);
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + t;
}
function rbBest() {
  var c = document.cookie, i = c.indexOf('rbbest=');
  if (i < 0) return 0;
  return parseInt(c.substring(i + 7), 10);
}

function rbStep(dt) {
  var on = rbCell(rbX, rbY);
  var vmax = on == 'b' ? rbMAXV : rbMAXV_OFF;
  if (rbKeys['up']) rbSpeed += rbACC * dt;
  else if (rbKeys['down']) rbSpeed -= (rbSpeed > 0 ? rbBRAKE : rbACC * 0.5) * dt;
  else rbSpeed -= (rbSpeed > 0 ? 1 : -1) * Math.min(Math.abs(rbSpeed), rbDRAG * dt);
  if (rbSpeed > vmax) rbSpeed = Math.max(vmax, rbSpeed - 60 * dt);
  if (rbSpeed < -10) rbSpeed = -10;
  var turn = 2.6 * Math.min(1, Math.abs(rbSpeed) / 12) * (rbSpeed < 0 ? -1 : 1);
  if (rbKeys['left']) rbHeading -= turn * dt;
  if (rbKeys['right']) rbHeading += turn * dt;
  var nx = rbX + Math.sin(rbHeading) * rbSpeed * dt, ny = rbY - Math.cos(rbHeading) * rbSpeed * dt;
  if (rbCell(nx, ny) == 'a') rbSpeed = -rbSpeed * 0.3;   // bumped a building or the water
  else { rbX = nx; rbY = ny; }
  if (rbSpeed != 0 && !rbStarted && !rbDone) { rbStarted = true; rbT0 = new Date().getTime(); }
  if (!rbDone && rbNext < CHECKS.length) {
    var dx = rbX - CHECKS[rbNext][1], dy = rbY - CHECKS[rbNext][2];
    if (dx * dx + dy * dy < 14 * 14) {
      rbNext++;
      if (rbNext >= CHECKS.length) {
        rbDone = true;
        var tm = new Date().getTime() - rbT0, best = rbBest();
        if (!best || tm < best) {
          document.cookie = 'rbbest=' + tm + '; expires=Fri, 31 Dec 2037 23:59:59 GMT';
          rbMsg = 'FINISHED in ' + rbFmt(tm) + ' - new best!  Press R to race again.';
        } else rbMsg = 'FINISHED in ' + rbFmt(tm) + ' (best ' + rbFmt(best) + ').  Press R to race again.';
      } else rbMsg = 'Drive to ' + CHECKS[rbNext][0];
    }
  }
}

function rbDraw() {
  // Camera centred on the car, kept inside the map.
  var vx = Math.round(rbX - rbVW / 2), vy = Math.round(rbY - rbVH / 2);
  if (vx > MAPW - rbVW) vx = MAPW - rbVW;
  if (vy > MAPH - rbVH) vy = MAPH - rbVH;
  if (vx < 0) vx = 0;
  if (vy < 0) vy = 0;
  rbPlace(rbMap, -vx, -vy);
  rbPlace(rbCar, Math.round(rbX) - vx - 8, Math.round(rbY) - vy - 8);
  if (rbNext < CHECKS.length) rbPlace(rbFlag, CHECKS[rbNext][1] - vx - 8, CHECKS[rbNext][2] - vy - 8);
  else rbPlace(rbFlag, -100, -100);
  var a = rbHeading % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  var pic = Math.round(a / (2 * Math.PI) * 16) % 16;
  if (pic != rbShown) { rbCarImg.src = rbPics[pic].src; rbShown = pic; }
}

function rbShowHud(now) {
  // Rewriting a layer is slow in Navigator 4: a few times a second only.
  if (now - rbLastHud < 400) return;
  rbLastHud = now;
  var t = rbStarted ? (rbDone ? '' : rbFmt(now - rbT0)) : '0:00.0';
  var mph = Math.round(Math.abs(rbSpeed) * MPP * 2.237);
  var best = rbBest(), where = '';
  if (!rbDone && rbNext < CHECKS.length) {
    var dx = CHECKS[rbNext][1] - rbX, dy = CHECKS[rbNext][2] - rbY;
    var dirs = new Array('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW');
    var d = Math.round(Math.atan2(dx, -dy) / (2 * Math.PI) * 8);
    where = ' &nbsp; ' + Math.round(Math.sqrt(dx * dx + dy * dy) * MPP / 10) * 10 + ' m ' + dirs[(d + 8) % 8];
  }
  rbWrite(rbHud, '<font face="Arial,Helvetica" size="2" color="#ffffff"><b>' + mph + ' MPH</b> &nbsp; ' + t +
    ' &nbsp; Checkpoint ' + Math.min(rbNext, CHECKS.length - 1) + '/' + (CHECKS.length - 1) +
    (best ? ' &nbsp; Best ' + rbFmt(best) : '') + '<br>' + rbMsg + where + '</font>');
}

function rbTick() {
  var now = new Date().getTime(), dt = (now - rbLast) / 1000;
  rbLast = now;
  if (dt > 0.1) dt = 0.1;
  rbStep(dt);
  rbDraw();
  rbShowHud(now);
  setTimeout('rbTick()', 40);
}

// Navigator 4 forgets layer positions when the window is resized: reload.
function rbResized() {
  if (rbNS4) location.reload();
  else rbFit();
}

function rbStart() {
  rbView = rbLayer('view'); rbMap = rbLayer('map'); rbCar = rbLayer('car'); rbFlag = rbLayer('flag');
  rbHud = rbLayer('hud'); rbHelp = rbLayer('help');
  if (!rbView || !rbMap || !rbCar || !rbFlag || !rbHud || !rbHelp) { alert('Sorry, Retro Race Boston needs Netscape Navigator 4 or later.'); return; }
  rbCarImg = rbNS4 ? rbCar.document.images['carimg'] : document.images['carimg'];
  rbCache = new Array(ROWS.length);
  for (var i = 0; i < 16; i++) { rbPics[i] = new Image(); rbPics[i].src = 'tiles/car' + i + '.gif'; }
  if (rbNS4) document.captureEvents(Event.KEYDOWN | Event.KEYUP);
  document.onkeydown = rbKeyDown;
  document.onkeyup = rbKeyUp;
  window.onresize = rbResized;
  rbFit();
  rbRestart();
  rbLast = new Date().getTime();
  rbTick();
}
