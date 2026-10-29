// Airport (aeroway) processing for Logan: runways merged by designation with
// named ends, the taxi graph (taxiways, taxilanes, stand lead-in lines and
// runways sharing OSM nodes), runway holding points, stands and aprons.

const MAG_DECLINATION = 14.5; // Boston: magnetic = true + 14.5 deg
export const AERO_WAY = { RUNWAY: 0, TAXIWAY: 1, TAXILANE: 2, LEADIN: 3, CONNECTOR: 4 };

export function buildAero(els, { proj, inBox, box, r1, log = () => {} }) {
  const nodeIndex = new Map(), nodes = [];
  const nodeOf = (id, g) => {
    let i = nodeIndex.get(id);
    if (i === undefined) { i = nodes.length / 2; nodeIndex.set(id, i); nodes.push(r1(proj(g)[0]), r1(proj(g)[1])); }
    return i;
  };
  const P = (i) => [nodes[2 * i], nodes[2 * i + 1]];
  const KIND = { runway: AERO_WAY.RUNWAY, taxiway: AERO_WAY.TAXIWAY, taxilane: AERO_WAY.TAXILANE, parking_position: AERO_WAY.LEADIN };
  const ways = [], aprons = [], gates = [], aerodromes = [];
  const holdIds = new Set();
  const runwaySegs = [];
  for (const el of els) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.aeroway === 'holding_position') holdIds.add(el.id);
      if (t.aeroway === 'gate') { const [x, z] = proj(el); if (inBox(box, x, z)) gates.push([t.ref || '', r1(x), r1(z)]); }
      continue;
    }
    if (!el.geometry || !el.nodes) continue;
    const g = el.geometry;
    if (t.aeroway === 'apron' || t.aeroway === 'aerodrome') {
      if (g.length >= 4 && el.nodes[0] === el.nodes[el.nodes.length - 1]) (t.aeroway === 'apron' ? aprons : aerodromes).push(g.slice(0, -1).map(proj));
      continue;
    }
    const kind = KIND[t.aeroway];
    if (kind === undefined) continue;
    if (!g.some((p) => inBox(box, ...proj(p)))) continue;
    const idx = el.nodes.map((id, k) => nodeOf(id, g[k]));
    let width = parseFloat(t.width);
    if (!(width > 3 && width < 120)) width = [46, 23, 16, 0, 16][kind];
    const w = { kind, width, ref: t.ref || '', nodes: idx, osm: el.nodes };
    if (kind === AERO_WAY.RUNWAY) runwaySegs.push(w); else ways.push(w);
  }

  // ---- runways: chain segments sharing end nodes; unnamed pieces join a named chain.
  const runways = [];
  const used = new Set();
  const named = runwaySegs.filter((s) => s.ref);
  const byRef = new Map();
  for (const s of named) { if (!byRef.has(s.ref)) byRef.set(s.ref, []); byRef.get(s.ref).push(s); }
  for (const [ref, segs] of byRef) {
    // Pull in unnamed segments touching this runway's ends.
    for (const u of runwaySegs) {
      if (u.ref || used.has(u)) continue;
      const ends = new Set(segs.flatMap((s) => [s.nodes[0], s.nodes[s.nodes.length - 1]]));
      if (ends.has(u.nodes[0]) || ends.has(u.nodes[u.nodes.length - 1])) { segs.push(u); used.add(u); }
    }
    let chain = segs[0].nodes.slice();
    const rest = segs.slice(1);
    for (let guard = 0; rest.length && guard < 50; guard++) {
      const k = rest.findIndex((s) => s.nodes[0] === chain[chain.length - 1] || s.nodes[s.nodes.length - 1] === chain[chain.length - 1] || s.nodes[0] === chain[0] || s.nodes[s.nodes.length - 1] === chain[0]);
      if (k < 0) break;
      const s = rest.splice(k, 1)[0];
      let n = s.nodes.slice();
      if (n[0] === chain[chain.length - 1]) chain = chain.concat(n.slice(1));
      else if (n[n.length - 1] === chain[chain.length - 1]) chain = chain.concat(n.reverse().slice(1));
      else if (n[n.length - 1] === chain[0]) chain = n.concat(chain.slice(1));
      else chain = n.reverse().concat(chain.slice(1));
    }
    const [a, b] = [P(chain[0]), P(chain[chain.length - 1])];
    const trueHdg = ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 360;
    const mag = (trueHdg + MAG_DECLINATION + 360) % 360;
    const [d1, d2] = ref.split('/');
    const num = (d) => parseInt(d, 10) * 10;
    const diff = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
    // d1 or d2 is the designation of the end at chain[0] (taking off from there toward chain end).
    const startName = diff(num(d1), mag) <= diff(num(d2), mag) ? d1 : d2;
    const endName = startName === d1 ? d2 : d1;
    let len = 0;
    for (let i = 1; i < chain.length; i++) len += Math.hypot(P(chain[i])[0] - P(chain[i - 1])[0], P(chain[i])[1] - P(chain[i - 1])[1]);
    runways.push({ ref, width: Math.max(...segs.map((s) => s.width)), nodes: chain, ends: [startName.replace(/^0/, ''), endName.replace(/^0/, '')], length: len, heading: trueHdg });
  }

  // ---- stands from lead-in lines: the stand is the end away from the taxi network.
  const taxiNodes = new Set();
  for (const w of ways) if (w.kind !== AERO_WAY.LEADIN) for (const n of w.nodes) taxiNodes.add(n);
  for (const r of runways) for (const n of r.nodes) taxiNodes.add(n);
  const taxiList = [...taxiNodes];
  const nearestTaxi = (p, maxD) => {
    let best = -1, bd = maxD;
    for (const n of taxiList) { const d = Math.hypot(P(n)[0] - p[0], P(n)[1] - p[1]); if (d < bd) { bd = d; best = n; } }
    return best;
  };
  const stands = [];
  let connectors = 0;
  for (const w of ways) {
    if (w.kind !== AERO_WAY.LEADIN || w.nodes.length < 2) continue;
    const s0 = w.nodes[0], s1 = w.nodes[w.nodes.length - 1];
    let taxiEnd;
    if (taxiNodes.has(s0) && !taxiNodes.has(s1)) taxiEnd = 0;
    else if (taxiNodes.has(s1) && !taxiNodes.has(s0)) taxiEnd = 1;
    else {
      // Unconnected: the end nearest the taxi network is the taxi end.
      const d0 = nearestTaxiDist(P(s0)), d1 = nearestTaxiDist(P(s1));
      taxiEnd = d0 <= d1 ? 0 : 1;
    }
    const path = taxiEnd === 0 ? w.nodes.slice() : w.nodes.slice().reverse();
    if (!taxiNodes.has(path[0])) {
      const t = nearestTaxi(P(path[0]), 90);
      if (t < 0) continue;
      ways.push({ kind: AERO_WAY.CONNECTOR, width: 0, ref: '', nodes: [t, path[0]] });
      connectors++;
    }
    stands.push({ ref: w.ref, nodes: path });
  }
  function nearestTaxiDist(p) {
    let bd = Infinity;
    for (const n of taxiList) bd = Math.min(bd, Math.hypot(P(n)[0] - p[0], P(n)[1] - p[1]));
    return bd;
  }
  const holds = [];
  for (const [id, i] of nodeIndex) if (holdIds.has(id)) holds.push(i);
  log(`aero: ${runways.length} runways (${runways.map((r) => `${r.ends[0]}/${r.ends[1]} ${Math.round(r.length)}m`).join(', ')}), ${ways.length} taxi ways, ${stands.length} stands (${connectors} connectors), ${holds.length} holds, ${aprons.length} aprons, ${gates.length} gates`);
  return { nodes, ways, runways, stands, holds, aprons, gates, aerodromes };
}
