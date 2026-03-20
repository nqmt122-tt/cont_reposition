/* ═══════════════════════════════════════════════════════════════════════════
   Empty Container Repositioning Optimizer — Frontend Logic
   Uses Mapbox GL JS for the map with animated flow arrows.
   Parameters match Empty_Container_Model.xlsx exactly.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── State ──────────────────────────────────────────────────────────────────
const PORTS = ['cat_lai', 'cai_mep', 'hai_phong', 'da_nang', 'long_an'];
const PORT_LABELS = {
  cat_lai: 'Cat Lai', cai_mep: 'Cai Mep', hai_phong: 'Hai Phong',
  da_nang: 'Da Nang', long_an: 'Long An'
};
const PORT_REGIONS = {
  cat_lai: 'South', cai_mep: 'South', hai_phong: 'North',
  da_nang: 'Central', long_an: 'Mekong'
};

// Geo-coordinates for each port (lng, lat)
const PORT_COORDS = {
  cat_lai:   [106.7555, 10.7580],   // Cat Lai terminal, HCMC
  cai_mep:   [107.0143, 10.5070],   // Cai Mep, Ba Ria-Vung Tau
  hai_phong: [106.7520, 20.8449],   // Hai Phong port
  da_nang:   [108.2120, 16.0680],   // Da Nang port
  long_an:   [106.5760, 10.5260],   // Long An port (Mekong Delta)
};

// Port marker colors
const PORT_COLORS = {
  cat_lai: '#ef4444', cai_mep: '#f59e0b', hai_phong: '#3b82f6',
  da_nang: '#a855f7', long_an: '#00d4aa'
};

let solveResult = null;
let map = null;
let mapLoaded = false;

// Default parameters (from Excel model Parameters sheet)
const params = {
  ports: {
    cat_lai:   { capacity: 50000, storage_cost: 8,    lease_cost: 850,  import_rate: 38000, export_rate: 62000 },
    cai_mep:   { capacity: 65000, storage_cost: 5,    lease_cost: 900,  import_rate: 31500, export_rate: 43500 },
    hai_phong: { capacity: 70000, storage_cost: 5.5,  lease_cost: 880,  import_rate: 81923, export_rate: 54615 },
    da_nang:   { capacity: 15000, storage_cost: 5.5,  lease_cost: 1050, import_rate: 7015,  export_rate: 7600 },
    long_an:   { capacity: 12000, storage_cost: 4,    lease_cost: 1100, import_rate: 2885,  export_rate: 6731 },
  },
  transport_cost: [
    [0,      50.52,  148.14, 118.48, 46.76],
    [50.52,  0,      149.34, 119.68, 53.46],
    [148.14, 149.34, 0,      111.26, 149.94],
    [118.48, 119.68, 111.26, 0,      120.28],
    [46.76,  53.46,  149.94, 120.28, 0     ],
  ],
  transport_modes: [
    ['—',    'Road',  'Sea',  'Sea',  'Road' ],
    ['Road', '—',     'Sea',  'Sea',  'Barge'],
    ['Sea',  'Sea',   '—',    'Sea',  'Sea'  ],
    ['Sea',  'Sea',   'Sea',  '—',    'Sea'  ],
    ['Road', 'Barge', 'Sea',  'Sea',  '—'    ],
  ],
  carbon_factors: { sea: 0.016, barge: 0.020, road: 0.062 },
  carbon_price_per_kg: 0.005,
  storage_carbon_cost: 0.5,
  distance_km: [
    [0,    70,   1700, 960,  45  ],
    [70,   0,    1730, 990,  115 ],
    [1700, 1730, 0,    780,  1745],
    [960,  990,  780,  0,    1005],
    [45,   115,  1745, 1005, 0   ],
  ],
};


// ─── DOM Ready ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initBarrierSlider();
  initSettingsModal();
  initSolveButton();
  initMapTabs();
  initMapbox();
  updateCapacityLabels();
});


// ─── Mapbox Map ─────────────────────────────────────────────────────────────
function initMapbox() {
  mapboxgl.accessToken = typeof MAPBOX_TOKEN !== 'undefined' ? MAPBOX_TOKEN : 'YOUR_MAPBOX_ACCESS_TOKEN';

  map = new mapboxgl.Map({
    container: 'mapbox-map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [107.5, 14.5],    // Center of Vietnam
    zoom: 5.2,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
  });

  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    mapLoaded = true;
    addPortMarkers();
    addFlowSources();
  });
}

function addPortMarkers() {
  for (const [id, coords] of Object.entries(PORT_COORDS)) {
    const color = PORT_COLORS[id];
    const label = PORT_LABELS[id];

    // Create marker element
    const el = document.createElement('div');
    el.className = 'mapbox-port-marker';
    el.id = `marker-${id}`;
    el.innerHTML = `
      <div class="marker-pulse" style="background: ${color}"></div>
      <div class="marker-dot" style="background: ${color}"></div>
      <div class="marker-label" style="color: ${color}">${label}</div>
      <div class="marker-inv" id="inv-label-${id}"></div>
    `;

    new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat(coords)
      .addTo(map);
  }
}

function addFlowSources() {
  // Add empty GeoJSON source for flow lines (will be updated when solver runs)
  map.addSource('flow-lines', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  // Sea lines (blue)
  map.addLayer({
    id: 'flow-sea',
    type: 'line',
    source: 'flow-lines',
    filter: ['==', ['get', 'mode'], 'Sea'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#3b82f6',
      'line-width': ['get', 'width'],
      'line-opacity': 0.8
    }
  });

  // Barge lines (teal)
  map.addLayer({
    id: 'flow-barge',
    type: 'line',
    source: 'flow-lines',
    filter: ['==', ['get', 'mode'], 'Barge'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#00d4aa',
      'line-width': ['get', 'width'],
      'line-opacity': 0.8
    }
  });

  // Road lines (amber)
  map.addLayer({
    id: 'flow-road',
    type: 'line',
    source: 'flow-lines',
    filter: ['==', ['get', 'mode'], 'Road'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#f59e0b',
      'line-width': ['get', 'width'],
      'line-opacity': 0.8
    }
  });

  // Arrow heads along the lines
  map.addLayer({
    id: 'flow-arrows',
    type: 'symbol',
    source: 'flow-lines',
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 80,
      'text-field': '▶',
      'text-size': 24,
      'text-keep-upright': false,
      'text-allow-overlap': true,
      'text-ignore-placement': true
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': 'rgba(6, 11, 24, 0.85)',
      'text-halo-width': 1.5
    }
  });

  // Volume labels
  map.addSource('flow-labels', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'flow-label-layer',
    type: 'symbol',
    source: 'flow-labels',
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 11,
      'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
      'text-offset': [0, -1],
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': 'rgba(6, 11, 24, 0.85)',
      'text-halo-width': 1.5,
    }
  });
}


function renderMapFlows(strategyName) {
  if (!mapLoaded || !solveResult) return;

  const strategy = solveResult.strategies.find(s => s.name === strategyName);
  if (!strategy) return;

  const flow = strategy.flow_matrix;
  const maxFlow = Math.max(1, ...flow.flat().filter(v => v > 0));

  // Update inventory labels
  for (const p of PORTS) {
    const inv = strategy.end_inventory[p];
    const el = document.getElementById(`inv-label-${p}`);
    if (el) el.textContent = inv > 0 ? `${formatNum(inv)} TEU` : '';
  }

  // Build flow line features with curved paths
  const lineFeatures = [];
  const labelFeatures = [];

  for (let i = 0; i < PORTS.length; i++) {
    for (let j = 0; j < PORTS.length; j++) {
      if (i === j || flow[i][j] <= 0) continue;
      const from = PORT_COORDS[PORTS[i]];
      const to = PORT_COORDS[PORTS[j]];
      const volume = flow[i][j];
      const mode = params.transport_modes[i][j];
      const width = 2 + (volume / maxFlow) * 6;

      // Create an arc (curved line) by adding a midpoint offset
      const midLng = (from[0] + to[0]) / 2;
      const midLat = (from[1] + to[1]) / 2;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      // Perpendicular offset for curve
      const offset = len * 0.15;
      const nx = -dy / len * offset;
      const ny = dx / len * offset;

      const controlLng = midLng + nx;
      const controlLat = midLat + ny;

      // Generate smooth arc points
      const points = [];
      for (let t = 0; t <= 1; t += 0.05) {
        const lng = (1 - t) * (1 - t) * from[0] + 2 * (1 - t) * t * controlLng + t * t * to[0];
        const lat = (1 - t) * (1 - t) * from[1] + 2 * (1 - t) * t * controlLat + t * t * to[1];
        points.push([lng, lat]);
      }
      points.push(to);

      const modeColor = mode === 'Road' ? '#f59e0b' : mode === 'Barge' ? '#00d4aa' : '#3b82f6';

      lineFeatures.push({
        type: 'Feature',
        properties: { mode, width, volume, color: modeColor },
        geometry: { type: 'LineString', coordinates: points }
      });

      // Label at control point
      labelFeatures.push({
        type: 'Feature',
        properties: { label: formatNum(volume), color: modeColor },
        geometry: { type: 'Point', coordinates: [controlLng, controlLat] }
      });
    }
  }

  map.getSource('flow-lines').setData({
    type: 'FeatureCollection', features: lineFeatures
  });
  map.getSource('flow-labels').setData({
    type: 'FeatureCollection', features: labelFeatures
  });
}


// ─── Barrier Slider ─────────────────────────────────────────────────────────
function initBarrierSlider() {
  const slider = document.getElementById('barrier-slider');
  const display = document.getElementById('barrier-value');
  slider.addEventListener('input', () => {
    display.textContent = parseFloat(slider.value).toFixed(2);
  });
}


// ─── Solve Button ───────────────────────────────────────────────────────────
function initSolveButton() {
  document.getElementById('btn-solve').addEventListener('click', runSolve);
}

async function runSolve() {
  const btn = document.getElementById('btn-solve');
  btn.classList.add('btn--loading');
  btn.disabled = true;

  const inventory = {};
  PORTS.forEach(p => {
    inventory[p] = parseFloat(document.getElementById(`inv-${p}`).value) || 0;
  });
  const barrier = parseFloat(document.getElementById('barrier-slider').value);

  try {
    const resp = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initial_inventory: inventory,
        barrier_coefficient: barrier,
        parameters: params,
      }),
    });
    if (!resp.ok) throw new Error(`Server error: ${resp.status}`);
    solveResult = await resp.json();
    renderResults(solveResult);
  } catch (err) {
    console.error(err);
    alert('Solver error: ' + err.message);
  } finally {
    btn.classList.remove('btn--loading');
    btn.disabled = false;
  }
}


// ─── Render Results ─────────────────────────────────────────────────────────
function renderResults(data) {
  const section = document.getElementById('results-section');
  section.classList.add('active');
  setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);

  renderCostCards(data);
  renderFlowTable(data, 's2');
  renderMapFlows('s2');

  // Resize map after results become visible
  setTimeout(() => { if (map) map.resize(); }, 200);
}

function renderCostCards(data) {
  const container = document.getElementById('results-cards');
  const strategies = data.strategies;
  const maxCost = Math.max(...strategies.map(s =>
    Math.max(s.costs.TC_H, s.costs.TC_R, s.costs.TC_W, s.costs.TC_C)));

  container.innerHTML = strategies.map((s, idx) => {
    const savings = idx === 0 ? null :
      idx === 1 ? data.savings_s2_vs_s1 : data.savings_s3_vs_s1;
    const isBest = idx === 2;
    const cls = `result-card result-card--${s.name}${isBest ? ' result-card--best' : ''}`;

    const savingsHTML = savings !== null
      ? `<div class="result-card__savings result-card__savings--positive">↓ ${savings.toFixed(1)}% vs Status Quo</div>`
      : `<div class="result-card__savings result-card__savings--zero">Baseline</div>`;

    return `
      <div class="${cls}">
        <div class="result-card__label">${s.label}</div>
        <div class="result-card__total">$${formatNum(s.costs.total)}</div>
        ${savingsHTML}
        <div class="cost-bars">
          ${costBar('TC_H', s.costs.TC_H, maxCost, 'h')}
          ${costBar('TC_R', s.costs.TC_R, maxCost, 'r')}
          ${costBar('TC_W', s.costs.TC_W, maxCost, 'w')}
          ${costBar('TC_C', s.costs.TC_C, maxCost, 'c')}
        </div>
      </div>`;
  }).join('');
}

function costBar(code, value, maxVal, cls) {
  const pct = maxVal > 0 ? (value / maxVal) * 100 : 0;
  return `
    <div class="cost-bar">
      <span class="cost-bar__label">${code}</span>
      <div class="cost-bar__track">
        <div class="cost-bar__fill cost-bar__fill--${cls}" style="width: ${pct}%"></div>
      </div>
      <span class="cost-bar__value">$${formatNum(value)}</span>
    </div>`;
}


// ─── Flow Table ─────────────────────────────────────────────────────────────
function renderFlowTable(data, strategyName) {
  const container = document.getElementById('flow-table-container');
  const strategy = data.strategies.find(s => s.name === strategyName);
  if (!strategy) return;

  const flow = strategy.flow_matrix;
  const labels = PORTS.map(p => PORT_LABELS[p]);

  let html = `<table class="flow-table"><thead><tr><th>From \\ To</th>`;
  labels.forEach(l => html += `<th>${l}</th>`);
  html += `<th>Leased</th><th>End Inv.</th></tr></thead><tbody>`;

  PORTS.forEach((p, i) => {
    html += `<tr><td><strong>${labels[i]}</strong></td>`;
    flow[i].forEach((val, j) => {
      if (i === j) html += `<td class="flow-cell flow-cell--diag">—</td>`;
      else if (val > 0) html += `<td class="flow-cell flow-cell--active">${formatNum(val)}</td>`;
      else html += `<td class="flow-cell flow-cell--zero">0</td>`;
    });
    html += `<td class="flow-cell ${strategy.leasing[p] > 0 ? 'flow-cell--active' : 'flow-cell--zero'}">${formatNum(strategy.leasing[p])}</td>`;
    html += `<td class="flow-cell">${formatNum(strategy.end_inventory[p])}</td></tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;
}


// ─── Map Tabs ───────────────────────────────────────────────────────────────
function initMapTabs() {
  document.getElementById('map-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.map-tab');
    if (!tab) return;
    document.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const strategy = tab.dataset.strategy;
    renderMapFlows(strategy);
    if (solveResult) renderFlowTable(solveResult, strategy);
  });
}


// ─── Settings Modal ─────────────────────────────────────────────────────────
function initSettingsModal() {
  const modal = document.getElementById('settings-modal');
  document.getElementById('btn-settings').addEventListener('click', () => {
    renderSettingsTables();
    modal.classList.add('active');
  });
  document.getElementById('modal-close').addEventListener('click', () => modal.classList.remove('active'));
  document.getElementById('modal-apply').addEventListener('click', () => {
    readSettingsFromTables();
    updateCapacityLabels();
    modal.classList.remove('active');
  });
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('active');
  });

  // Tab switching
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  });

  // AI interpretation placeholder
  document.getElementById('btn-interpret').addEventListener('click', showInterpretation);
}

function renderSettingsTables() {
  const portsBody = document.getElementById('ports-table-body');
  portsBody.innerHTML = PORTS.map(p => {
    const pp = params.ports[p];
    return `<tr>
      <td><strong>${PORT_LABELS[p]}</strong></td>
      <td><input type="number" data-port="${p}" data-field="capacity" value="${pp.capacity}"></td>
      <td><input type="number" data-port="${p}" data-field="storage_cost" value="${pp.storage_cost}" step="0.5"></td>
      <td><input type="number" data-port="${p}" data-field="lease_cost" value="${pp.lease_cost}" step="10"></td>
      <td><input type="number" data-port="${p}" data-field="import_rate" value="${pp.import_rate}" step="500"></td>
      <td><input type="number" data-port="${p}" data-field="export_rate" value="${pp.export_rate}" step="500"></td>
    </tr>`;
  }).join('');

  const transportBody = document.getElementById('transport-table-body');
  transportBody.innerHTML = PORTS.map((p, i) => {
    return `<tr>
      <td><strong>${PORT_LABELS[p]}</strong></td>
      ${params.transport_cost[i].map((cost, j) => {
        if (i === j) return `<td style="color: var(--text-muted); opacity: 0.3;">—</td>`;
        const mode = params.transport_modes[i][j];
        return `<td><input type="number" data-from="${i}" data-to="${j}" value="${cost}" step="1">
                <br><span style="font-size: 0.6rem; color: var(--text-muted);">${mode}</span></td>`;
      }).join('')}
    </tr>`;
  }).join('');

  const carbonBody = document.getElementById('carbon-table-body');
  carbonBody.innerHTML = `
    <tr><td>Sea Emission Factor</td><td><input type="number" id="set-carbon-sea" value="${params.carbon_factors.sea}" step="0.001"></td><td>kg CO₂/TEU-km</td></tr>
    <tr><td>Barge Emission Factor</td><td><input type="number" id="set-carbon-barge" value="${params.carbon_factors.barge}" step="0.001"></td><td>kg CO₂/TEU-km</td></tr>
    <tr><td>Road Emission Factor</td><td><input type="number" id="set-carbon-road" value="${params.carbon_factors.road}" step="0.001"></td><td>kg CO₂/TEU-km</td></tr>
    <tr><td>Carbon Price</td><td><input type="number" id="set-carbon-price" value="${params.carbon_price_per_kg}" step="0.001"></td><td>USD/kg CO₂</td></tr>
    <tr><td>Storage Carbon Cost</td><td><input type="number" id="set-storage-carbon" value="${params.storage_carbon_cost}" step="0.01"></td><td>USD/TEU/week</td></tr>
  `;

  // Distance matrix (read-only)
  const distBody = document.getElementById('distance-table-body');
  distBody.innerHTML = PORTS.map((p, i) => {
    return `<tr>
      <td><strong>${PORT_LABELS[p]}</strong></td>
      ${params.distance_km[i].map((dist, j) => {
        if (i === j) return `<td style="color: var(--text-muted); opacity: 0.3;">—</td>`;
        const mode = params.transport_modes[i][j];
        return `<td>${dist.toLocaleString()} km<br><span style="font-size: 0.6rem; color: var(--text-muted);">${mode}</span></td>`;
      }).join('')}
    </tr>`;
  }).join('');
}

function readSettingsFromTables() {
  document.querySelectorAll('#ports-table-body input').forEach(inp => {
    const port = inp.dataset.port;
    const field = inp.dataset.field;
    params.ports[port][field] = parseFloat(inp.value) || 0;
  });
  document.querySelectorAll('#transport-table-body input').forEach(inp => {
    const from = parseInt(inp.dataset.from);
    const to = parseInt(inp.dataset.to);
    params.transport_cost[from][to] = parseFloat(inp.value) || 0;
  });
  params.carbon_factors.sea = parseFloat(document.getElementById('set-carbon-sea').value) || 0.016;
  params.carbon_factors.barge = parseFloat(document.getElementById('set-carbon-barge').value) || 0.020;
  params.carbon_factors.road = parseFloat(document.getElementById('set-carbon-road').value) || 0.062;
  params.carbon_price_per_kg = parseFloat(document.getElementById('set-carbon-price').value) || 0.005;
  params.storage_carbon_cost = parseFloat(document.getElementById('set-storage-carbon').value) || 0.5;
}


// ─── AI Interpretation (Gemini Flash) ───────────────────────────────────────
async function showInterpretation() {
  if (!solveResult) return;

  const div = document.getElementById('interpretation');
  const content = document.getElementById('interpretation-content');
  div.classList.add('active');

  // Loading state
  content.innerHTML = `
    <p style="display:flex;align-items:center;gap:10px;">
      <span style="display:inline-block;width:16px;height:16px;border:2px solid var(--accent-teal);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></span>
      <strong>🤖 Asking Gemini Flash…</strong>
    </p>`;
  div.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // ── Build rich context prompt ─────────────────────────────────────────────
  const s = solveResult.strategies;
  const s1 = s[0], s2 = s[1], s3 = s[2];

  // Active strategy on map tab
  const activeTab = document.querySelector('.map-tab.active');
  const activeStrategy = activeTab ? activeTab.dataset.strategy : 's3';

  // Port parameters snapshot
  const portRows = PORTS.map(p => {
    const inv = solveResult.initial_inventory ? solveResult.initial_inventory[p] : '?';
    const pr = params.ports[p];
    return `  - ${PORT_LABELS[p]} (${PORT_REGIONS[p]}): Initial Inventory=${inv} TEU | Capacity=${pr.capacity} TEU | Storage=$${pr.storage_cost}/TEU/wk | Lease=$${pr.lease_cost}/TEU | Import=${pr.import_rate} TEU/wk | Export=${pr.export_rate} TEU/wk`;
  }).join('\n');

  // Flow table for S2 and S3
  const buildFlowText = (strat) => {
    const rows = [];
    strat.flow_matrix.forEach((row, i) => {
      row.forEach((val, j) => {
        if (i !== j && val > 0) {
          rows.push(`    ${PORT_LABELS[PORTS[i]]} → ${PORT_LABELS[PORTS[j]]}: ${val.toLocaleString()} TEU (${params.transport_modes[i][j]}, ${params.distance_km[i][j]} km)`);
        }
      });
    });
    return rows.length ? rows.join('\n') : '    (no repositioning flows)';
  };

  // Leasing summary
  const buildLeasingText = (strat) => {
    return PORTS.map(p => `    ${PORT_LABELS[p]}: ${strat.leasing[p].toLocaleString()} TEU leased`).join('\n');
  };

  const prompt = `You are an expert logistics analyst specializing in maritime container operations in Vietnam. Analyze the following solver output from an empty container repositioning optimization model and provide a concise, insightful interpretation for a research/academic audience.

## CONTEXT: The Optimization Model
The model minimizes total weekly cost across Vietnam's port network under 3 strategies:
- **S1 (Status Quo):** No inter-port coordination. Each port leases containers independently when stock runs low.
- **S2 (Regional Thresholds):** Ports share containers only when inventory exceeds a threshold (barrier coefficient s=${solveResult.barrier_coefficient ?? 0.5} × capacity). More realistic, requires basic coordination.
- **S3 (National Network):** Full LP optimization — the solver freely moves containers across all ports to minimize total cost. Represents the theoretical optimum.

Cost components:
- **TC_H** — Holding/storage cost for containers sitting at port
- **TC_R** — Repositioning transport cost (moving containers between ports)
- **TC_W** — Leasing/penalty cost (when a port runs out and must rent from external sources)
- **TC_C** — Carbon emission cost from transport

## PORT PARAMETERS (this simulation run)
${portRows}

## SIMULATION RESULTS

### S1: Status Quo (Baseline)
- Total Weekly Cost: $${s1.costs.total.toLocaleString()}
- TC_H (Holding): $${s1.costs.TC_H.toLocaleString()}
- TC_R (Repositioning): $${s1.costs.TC_R.toLocaleString()}
- TC_W (Leasing): $${s1.costs.TC_W.toLocaleString()}
- TC_C (Carbon): $${s1.costs.TC_C.toLocaleString()}
- Repositioning flows: ${buildFlowText(s1)}
- Leasing: ${buildLeasingText(s1)}

### S2: Regional Thresholds
- Total Weekly Cost: $${s2.costs.total.toLocaleString()} (${solveResult.savings_s2_vs_s1.toFixed(1)}% savings vs S1)
- TC_H / TC_R / TC_W / TC_C: $${s2.costs.TC_H.toLocaleString()} / $${s2.costs.TC_R.toLocaleString()} / $${s2.costs.TC_W.toLocaleString()} / $${s2.costs.TC_C.toLocaleString()}
- Repositioning flows:
${buildFlowText(s2)}
- Leasing:
${buildLeasingText(s2)}

### S3: National Network (Optimal)
- Total Weekly Cost: $${s3.costs.total.toLocaleString()} (${solveResult.savings_s3_vs_s1.toFixed(1)}% savings vs S1)
- TC_H / TC_R / TC_W / TC_C: $${s3.costs.TC_H.toLocaleString()} / $${s3.costs.TC_R.toLocaleString()} / $${s3.costs.TC_W.toLocaleString()} / $${s3.costs.TC_C.toLocaleString()}
- Repositioning flows:
${buildFlowText(s3)}
- Leasing:
${buildLeasingText(s3)}

## ANNUAL IMPACT
- S2 annual savings vs S1: ~$${((s1.costs.total - s2.costs.total) * 52).toLocaleString()}
- S3 annual savings vs S1: ~$${((s1.costs.total - s3.costs.total) * 52).toLocaleString()}

## YOUR TASK
Write a comprehensive, highly detailed analysis of these results. Structure your response in depth:
1. **Status Quo Inefficiencies (S1)** — deep dive into why costs are so high under the current fragmented model, detailing the dominant cost factors.
2. **Impact of Regional Coordination (S2)** — detailed flow analysis, specifying which ports are acting as surplus/deficit hubs, and exactly how the threshold strategy drives cost reductions.
3. **National Network Optimization (S3)** — explain how the fully optimized network unlocks the lowest possible costs and where the most significant structural shifts occur compared to S1/S2.
4. **Strategic Recommendations** — provide practical, concrete policy takeaways for Vietnamese port authorities or shipping lines.

Use precise numbers from the results. Keep the tone analytical but accessible. Do not use markdown headers — use bold text and paragraph breaks only.`;

  // ── Call Gemini Flash API ─────────────────────────────────────────────────
  const apiKey = typeof GEMINI_API_KEY !== 'undefined' ? GEMINI_API_KEY : '';
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${apiKey}&alt=sse`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err?.error?.message || `HTTP ${response.status}`);
    }

    // Stream response using SSE reader
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    content.innerHTML = `<p><strong>🤖 Gemini Flash Analysis</strong></p><div id="gemini-stream" style="white-space:pre-wrap;line-height:1.75;"></div>`;
    const streamEl = document.getElementById('gemini-stream');

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        // Normalize Windows CRLF newlines to standard Unix newlines
        buffer = buffer.replace(/\r\n/g, '\n');
      }
      
      let eventBoundary = buffer.indexOf('\n\n');
      while (eventBoundary !== -1) {
        const eventStr = buffer.slice(0, eventBoundary);
        buffer = buffer.slice(eventBoundary + 2);
        
        // Extract all 'data: ' lines from this event block
        let dataPayload = '';
        for (const line of eventStr.split('\n')) {
          if (line.startsWith('data: ')) {
            dataPayload += line.slice(6);
          } else if (line.startsWith('data:')) {
            dataPayload += line.slice(5);
          }
        }
        
        dataPayload = dataPayload.trim();
        if (dataPayload && dataPayload !== '[DONE]') {
          try {
            const parsed = JSON.parse(dataPayload);
            const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (part) {
              fullText += part;
              // Render with basic bold/paragraph support
              streamEl.innerHTML = fullText
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\n\n/g, '</p><p>')
                .replace(/\n/g, '<br>');
            }
          } catch (e) {
            console.error("Gemini SSE parse error:", e, dataPayload);
          }
        }
        eventBoundary = buffer.indexOf('\n\n');
      }

      if (done) break;
    }
  } catch (err) {
    content.innerHTML = `
      <p><strong>🤖 Gemini Flash</strong> — <span style="color:var(--accent-red);">Error: ${err.message}</span></p>
      <p style="font-size:0.8rem;color:var(--text-muted);">Check your API key in config.js or browser console for details.</p>`;
  }

  div.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// ─── Utilities ──────────────────────────────────────────────────────────────
function formatNum(n) {
  if (n === undefined || n === null) return '0';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function updateCapacityLabels() {
  PORTS.forEach(p => {
    const el = document.getElementById(`cap-${p}`);
    if (el) {
      el.textContent = `Capacity: ${formatNum(params.ports[p].capacity)} TEU`;
    }
  });
}
