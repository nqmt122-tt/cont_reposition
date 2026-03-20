/* ═══════════════════════════════════════════════════════════════════════════
   Empty Container Repositioning Optimizer — Frontend Logic
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

let solveResult = null;

// Default parameters (mirrors server defaults — editable via settings)
const params = {
  ports: {
    cat_lai:  { capacity: 50000, storage_cost: 8,  lease_cost: 950,  import_rate: 25000, export_rate: 45000 },
    cai_mep:  { capacity: 30000, storage_cost: 5,  lease_cost: 900,  import_rate: 20000, export_rate: 15000 },
    hai_phong:{ capacity: 40000, storage_cost: 6,  lease_cost: 850,  import_rate: 30000, export_rate: 20000 },
    da_nang:  { capacity: 15000, storage_cost: 5,  lease_cost: 1000, import_rate: 2000,  export_rate: 3200 },
    long_an:  { capacity: 12000, storage_cost: 4,  lease_cost: 1100, import_rate: 2000,  export_rate: 5000 },
  },
  transport_cost: [
    [0, 45, 130, 100, 60],
    [45, 0, 140, 110, 55],
    [130, 140, 0, 85, 160],
    [100, 110, 85, 0, 140],
    [60, 55, 160, 140, 0],
  ],
  transport_modes: [
    ['—','Road','Coastal','Coastal','Barge'],
    ['Road','—','Coastal','Coastal','Barge'],
    ['Coastal','Coastal','—','Coastal','Coastal'],
    ['Coastal','Coastal','Coastal','—','Coastal'],
    ['Barge','Barge','Coastal','Coastal','—'],
  ],
  carbon_factors: { sea: 0.016, barge: 0.020, road: 0.062 },
  carbon_price: 0.01,
  storage_carbon_cost: 0.05,
};


// ─── DOM Ready ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initBarrierSlider();
  initSettingsModal();
  initSolveButton();
  initMapTabs();
  renderVietnamMap();
});


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
  const btn = document.getElementById('btn-solve');
  btn.addEventListener('click', runSolve);
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

  // Scroll to results
  setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);

  renderCostCards(data);
  renderFlowTable(data, 's2');
  renderMapFlows('s2');
}


function renderCostCards(data) {
  const container = document.getElementById('results-cards');
  const strategies = data.strategies;
  const s1Total = strategies[0].costs.total;
  const maxCost = Math.max(...strategies.map(s => Math.max(s.costs.TC_H, s.costs.TC_R, s.costs.TC_W, s.costs.TC_C)));

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
          ${costBar('TC_H', 'Storage', s.costs.TC_H, maxCost, 'h')}
          ${costBar('TC_R', 'Reposition', s.costs.TC_R, maxCost, 'r')}
          ${costBar('TC_W', 'Leasing', s.costs.TC_W, maxCost, 'w')}
          ${costBar('TC_C', 'Carbon', s.costs.TC_C, maxCost, 'c')}
        </div>
      </div>
    `;
  }).join('');
}

function costBar(code, label, value, maxVal, cls) {
  const pct = maxVal > 0 ? (value / maxVal) * 100 : 0;
  return `
    <div class="cost-bar">
      <span class="cost-bar__label">${code}</span>
      <div class="cost-bar__track">
        <div class="cost-bar__fill cost-bar__fill--${cls}" style="width: ${pct}%"></div>
      </div>
      <span class="cost-bar__value">$${formatNum(value)}</span>
    </div>
  `;
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
      if (i === j) {
        html += `<td class="flow-cell flow-cell--diag">—</td>`;
      } else if (val > 0) {
        html += `<td class="flow-cell flow-cell--active">${formatNum(val)}</td>`;
      } else {
        html += `<td class="flow-cell flow-cell--zero">0</td>`;
      }
    });
    html += `<td class="flow-cell ${strategy.leasing[p] > 0 ? 'flow-cell--active' : 'flow-cell--zero'}">${formatNum(strategy.leasing[p])}</td>`;
    html += `<td class="flow-cell">${formatNum(strategy.end_inventory[p])}</td>`;
    html += `</tr>`;
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


// ─── Vietnam SVG Map ────────────────────────────────────────────────────────
// Approximate positions on a 600x820 canvas
const MAP_PORTS = {
  hai_phong: { x: 395, y: 175, color: '#3b82f6' },
  da_nang:   { x: 370, y: 395, color: '#a855f7' },
  cat_lai:   { x: 330, y: 620, color: '#ef4444' },
  cai_mep:   { x: 365, y: 650, color: '#f59e0b' },
  long_an:   { x: 290, y: 660, color: '#00d4aa' },
};

function renderVietnamMap() {
  const container = document.getElementById('map-svg-container');
  container.innerHTML = buildMapSVG();
}

function buildMapSVG() {
  return `
  <svg viewBox="0 0 600 820" xmlns="http://www.w3.org/2000/svg" id="vietnam-map">
    <defs>
      <!-- Glow filter for ports -->
      <filter id="port-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <!-- Arrow markers by mode -->
      <marker id="arrow-sea" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto" fill="#3b82f6">
        <polygon points="0 0, 8 3, 0 6"/>
      </marker>
      <marker id="arrow-barge" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto" fill="#00d4aa">
        <polygon points="0 0, 8 3, 0 6"/>
      </marker>
      <marker id="arrow-road" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto" fill="#f59e0b">
        <polygon points="0 0, 8 3, 0 6"/>
      </marker>
      <!-- Animated dash -->
      <style>
        @keyframes dash-flow { to { stroke-dashoffset: -30; } }
        .flow-line { animation: dash-flow 1.2s linear infinite; stroke-dasharray: 8 6; }
        .port-pulse { animation: port-pulse-anim 2.5s ease-in-out infinite; }
        @keyframes port-pulse-anim {
          0%, 100% { r: 18; opacity: 0.15; }
          50% { r: 24; opacity: 0.08; }
        }
      </style>
    </defs>

    <!-- Vietnam coastline (simplified sketch path) -->
    <path d="
      M 380 60
      C 400 70, 420 90, 415 110
      C 410 130, 420 150, 410 170
      L 400 180
      C 405 200, 395 230, 400 250
      C 405 270, 400 290, 390 310
      C 385 330, 380 350, 375 370
      C 370 385, 375 400, 370 410
      C 360 440, 350 460, 345 480
      C 340 500, 335 520, 340 540
      C 345 555, 350 570, 345 585
      C 340 600, 335 620, 340 640
      C 345 660, 335 680, 310 700
      C 290 720, 260 710, 240 700
      C 220 690, 240 670, 260 660
      C 280 650, 295 635, 310 620
      C 320 610, 325 590, 320 570
      C 315 550, 310 530, 315 510
      C 318 495, 315 480, 310 465
      C 305 450, 300 435, 305 420
      C 308 405, 310 390, 305 375
      C 298 350, 295 330, 300 310
      C 305 290, 310 275, 305 255
      C 300 240, 295 220, 300 200
      C 305 180, 320 170, 330 155
      C 335 145, 340 135, 345 120
      C 350 105, 355 90, 360 80
      C 365 70, 375 65, 380 60
      Z
    " fill="rgba(30, 55, 95, 0.25)" stroke="rgba(100, 180, 255, 0.2)" stroke-width="1.5"/>

    <!-- Northern border region (sketch) -->
    <path d="
      M 380 60
      C 370 50, 350 40, 330 45
      C 310 50, 290 55, 275 65
      C 260 75, 250 90, 240 100
      C 230 115, 245 130, 260 140
      C 280 148, 300 155, 320 155
      C 330 155, 340 135, 345 120
      C 350 105, 355 90, 360 80
      C 365 70, 375 65, 380 60
    " fill="none" stroke="rgba(100, 180, 255, 0.15)" stroke-width="1" stroke-dasharray="4 4"/>

    <!-- Mekong Delta fan (sketch) -->
    <path d="
      M 310 640
      C 300 660, 280 680, 260 690
      C 250 695, 240 700, 230 695
      M 310 640
      C 305 665, 290 685, 275 695
      M 310 640
      C 315 665, 300 690, 285 700
    " fill="none" stroke="rgba(100, 180, 255, 0.12)" stroke-width="1"/>

    <!-- Paracel Islands (Hoàng Sa) -->
    <g transform="translate(460, 330)">
      <circle r="3" fill="rgba(100, 180, 255, 0.3)" stroke="rgba(100, 180, 255, 0.4)" stroke-width="0.8"/>
      <circle cx="10" cy="-5" r="2" fill="rgba(100, 180, 255, 0.25)"/>
      <circle cx="5" cy="8" r="2.5" fill="rgba(100, 180, 255, 0.25)"/>
      <circle cx="-7" cy="4" r="1.8" fill="rgba(100, 180, 255, 0.2)"/>
      <circle cx="15" cy="6" r="1.5" fill="rgba(100, 180, 255, 0.2)"/>
      <!-- Dashed sovereignty circle -->
      <circle r="28" fill="none" stroke="rgba(100, 180, 255, 0.12)" stroke-width="0.8" stroke-dasharray="3 3"/>
      <text y="40" text-anchor="middle" fill="rgba(100, 180, 255, 0.35)" font-size="8" font-family="Inter, sans-serif" font-weight="600">
        Hoàng Sa
      </text>
      <text y="50" text-anchor="middle" fill="rgba(100, 180, 255, 0.22)" font-size="6" font-family="Inter, sans-serif">
        (Paracel Is.)
      </text>
    </g>

    <!-- Spratly Islands (Trường Sa) -->
    <g transform="translate(490, 560)">
      <circle r="2" fill="rgba(100, 180, 255, 0.25)" stroke="rgba(100, 180, 255, 0.35)" stroke-width="0.8"/>
      <circle cx="12" cy="-8" r="1.5" fill="rgba(100, 180, 255, 0.2)"/>
      <circle cx="-8" cy="10" r="1.8" fill="rgba(100, 180, 255, 0.2)"/>
      <circle cx="8" cy="12" r="1.3" fill="rgba(100, 180, 255, 0.18)"/>
      <circle cx="-12" cy="-5" r="1.5" fill="rgba(100, 180, 255, 0.18)"/>
      <circle cx="18" cy="5" r="1" fill="rgba(100, 180, 255, 0.15)"/>
      <!-- Dashed sovereignty circle -->
      <circle r="32" fill="none" stroke="rgba(100, 180, 255, 0.12)" stroke-width="0.8" stroke-dasharray="3 3"/>
      <text y="45" text-anchor="middle" fill="rgba(100, 180, 255, 0.35)" font-size="8" font-family="Inter, sans-serif" font-weight="600">
        Trường Sa
      </text>
      <text y="55" text-anchor="middle" fill="rgba(100, 180, 255, 0.22)" font-size="6" font-family="Inter, sans-serif">
        (Spratly Is.)
      </text>
    </g>

    <!-- Sea label -->
    <text x="500" y="450" fill="rgba(100, 180, 255, 0.12)" font-size="14" font-family="Inter, sans-serif"
          font-weight="700" letter-spacing="6" transform="rotate(90, 500, 450)">EAST SEA</text>

    <!-- Flow arrows group (populated dynamically) -->
    <g id="flow-arrows"></g>

    <!-- Port markers -->
    ${Object.entries(MAP_PORTS).map(([id, p]) => `
      <g class="port-marker" data-port="${id}">
        <circle class="port-pulse" cx="${p.x}" cy="${p.y}" fill="${p.color}" opacity="0.15" r="18"/>
        <circle cx="${p.x}" cy="${p.y}" r="7" fill="${p.color}" filter="url(#port-glow)" opacity="0.9"/>
        <circle cx="${p.x}" cy="${p.y}" r="3.5" fill="white" opacity="0.9"/>
        <text x="${p.x}" y="${p.y - 16}" text-anchor="middle" fill="${p.color}"
              font-size="10" font-weight="700" font-family="Inter, sans-serif">${PORT_LABELS[id]}</text>
        <text x="${p.x}" y="${p.y + 22}" text-anchor="middle" fill="rgba(200,220,255,0.4)"
              font-size="7" font-family="Inter, sans-serif" class="port-inv-label" data-port="${id}"></text>
      </g>
    `).join('')}
  </svg>
  `;
}


function renderMapFlows(strategyName) {
  const arrowGroup = document.getElementById('flow-arrows');
  if (!arrowGroup || !solveResult) return;
  arrowGroup.innerHTML = '';

  const strategy = solveResult.strategies.find(s => s.name === strategyName);
  if (!strategy) return;

  const flow = strategy.flow_matrix;
  const maxFlow = Math.max(1, ...flow.flat());

  // Update inventory labels on map
  document.querySelectorAll('.port-inv-label').forEach(el => {
    const p = el.dataset.port;
    const inv = strategy.end_inventory[p];
    el.textContent = inv > 0 ? `${formatNum(inv)} TEU` : '';
  });

  // Draw flow arrows
  for (let i = 0; i < PORTS.length; i++) {
    for (let j = 0; j < PORTS.length; j++) {
      if (i === j || flow[i][j] <= 0) continue;
      const from = MAP_PORTS[PORTS[i]];
      const to = MAP_PORTS[PORTS[j]];
      const volume = flow[i][j];
      const mode = params.transport_modes[i][j];

      const modeClass = mode === 'Road' ? 'road' : mode === 'Barge' ? 'barge' : 'sea';
      const color = mode === 'Road' ? '#f59e0b' : mode === 'Barge' ? '#00d4aa' : '#3b82f6';
      const width = 1.5 + (volume / maxFlow) * 4;

      // Offset path so bidirectional flows don't overlap
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / len * 8;
      const ny = dx / len * 8;

      // Curved path via control point
      const mx = (from.x + to.x) / 2 + nx;
      const my = (from.y + to.y) / 2 + ny;

      const path = `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;

      arrowGroup.innerHTML += `
        <path d="${path}" fill="none" stroke="${color}" stroke-width="${width}"
              stroke-opacity="0.6" class="flow-line"
              marker-end="url(#arrow-${modeClass})"/>
      `;

      // Volume label at midpoint
      const labelX = mx;
      const labelY = my - 6;
      arrowGroup.innerHTML += `
        <text x="${labelX}" y="${labelY}" text-anchor="middle" fill="${color}"
              font-size="8" font-weight="700" font-family="JetBrains Mono, monospace"
              opacity="0.8">${formatNum(volume)}</text>
      `;
    }
  }
}


// ─── Settings Modal ─────────────────────────────────────────────────────────
function initSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const btnOpen = document.getElementById('btn-settings');
  const btnClose = document.getElementById('modal-close');
  const btnApply = document.getElementById('modal-apply');

  btnOpen.addEventListener('click', () => {
    renderSettingsTables();
    modal.classList.add('active');
  });

  btnClose.addEventListener('click', () => modal.classList.remove('active'));
  btnApply.addEventListener('click', () => {
    readSettingsFromTables();
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

  // AI interpretation (placeholder)
  document.getElementById('btn-interpret').addEventListener('click', showInterpretation);
}

function renderSettingsTables() {
  // Port parameters
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

  // Transport costs
  const transportBody = document.getElementById('transport-table-body');
  transportBody.innerHTML = PORTS.map((p, i) => {
    return `<tr>
      <td><strong>${PORT_LABELS[p]}</strong></td>
      ${params.transport_cost[i].map((cost, j) => {
        if (i === j) return `<td style="color: var(--text-muted); opacity: 0.3;">—</td>`;
        const mode = params.transport_modes[i][j];
        return `<td><input type="number" data-from="${i}" data-to="${j}" value="${cost}" step="5">
                <br><span style="font-size: 0.6rem; color: var(--text-muted);">${mode}</span></td>`;
      }).join('')}
    </tr>`;
  }).join('');

  // Carbon parameters
  const carbonBody = document.getElementById('carbon-table-body');
  carbonBody.innerHTML = `
    <tr><td>Sea Emission Factor</td><td><input type="number" id="set-carbon-sea" value="${params.carbon_factors.sea}" step="0.001"></td><td>kg CO₂/TEU-km</td></tr>
    <tr><td>Barge Emission Factor</td><td><input type="number" id="set-carbon-barge" value="${params.carbon_factors.barge}" step="0.001"></td><td>kg CO₂/TEU-km</td></tr>
    <tr><td>Road Emission Factor</td><td><input type="number" id="set-carbon-road" value="${params.carbon_factors.road}" step="0.001"></td><td>kg CO₂/TEU-km</td></tr>
    <tr><td>Carbon Price</td><td><input type="number" id="set-carbon-price" value="${params.carbon_price}" step="0.001"></td><td>USD/kg CO₂</td></tr>
    <tr><td>Storage Carbon Cost</td><td><input type="number" id="set-storage-carbon" value="${params.storage_carbon_cost}" step="0.01"></td><td>USD/TEU/week</td></tr>
  `;
}

function readSettingsFromTables() {
  // Port parameters
  document.querySelectorAll('#ports-table-body input').forEach(inp => {
    const port = inp.dataset.port;
    const field = inp.dataset.field;
    params.ports[port][field] = parseFloat(inp.value) || 0;
  });

  // Transport costs
  document.querySelectorAll('#transport-table-body input').forEach(inp => {
    const from = parseInt(inp.dataset.from);
    const to = parseInt(inp.dataset.to);
    params.transport_cost[from][to] = parseFloat(inp.value) || 0;
  });

  // Carbon
  params.carbon_factors.sea = parseFloat(document.getElementById('set-carbon-sea').value) || 0.016;
  params.carbon_factors.barge = parseFloat(document.getElementById('set-carbon-barge').value) || 0.020;
  params.carbon_factors.road = parseFloat(document.getElementById('set-carbon-road').value) || 0.062;
  params.carbon_price = parseFloat(document.getElementById('set-carbon-price').value) || 0.01;
  params.storage_carbon_cost = parseFloat(document.getElementById('set-storage-carbon').value) || 0.05;
}


// ─── AI Interpretation (Placeholder) ────────────────────────────────────────
function showInterpretation() {
  if (!solveResult) return;
  const div = document.getElementById('interpretation');
  const content = document.getElementById('interpretation-content');
  div.classList.add('active');

  const s = solveResult.strategies;
  const s1 = s[0].costs;
  const s2 = s[1].costs;
  const s3 = s[2].costs;

  // Generate a structured interpretation from the data
  const s2Savings = solveResult.savings_s2_vs_s1;
  const s3Savings = solveResult.savings_s3_vs_s1;
  const biggestS1Cost = Object.entries({ Storage: s1.TC_H, Repositioning: s1.TC_R, Leasing: s1.TC_W, Carbon: s1.TC_C })
    .sort((a, b) => b[1] - a[1])[0];

  content.innerHTML = `
    <p><strong>🤖 AI Interpretation</strong> <span style="color: var(--text-muted); font-size: 0.78rem;">(Placeholder — connect your LLM API for dynamic insights)</span></p>
    <p>Under the <strong>Status Quo (S1)</strong>, the total weekly cost is <strong>$${formatNum(s1.total)}</strong>, 
    with <strong>${biggestS1Cost[0]}</strong> being the dominant cost driver at $${formatNum(biggestS1Cost[1])}. 
    This reflects the inefficiency of disconnected port operations.</p>
    <p>The <strong>Regional Threshold (S2)</strong> strategy reduces costs by <strong>${s2Savings.toFixed(1)}%</strong> 
    to $${formatNum(s2.total)}/week. Repositioning costs of $${formatNum(s2.TC_R)} are introduced 
    but are more than offset by reductions in leasing ($${formatNum(s1.TC_W)} → $${formatNum(s2.TC_W)}).</p>
    <p>The <strong>National Network (S3)</strong> achieves the optimal solution at <strong>$${formatNum(s3.total)}/week</strong>, 
    a <strong>${s3Savings.toFixed(1)}%</strong> reduction. This scenario requires full inter-port coordination 
    and unified digital infrastructure.</p>
    <p>💡 <strong>Annual savings potential:</strong> S2 saves ~$${formatNum((s1.total - s2.total) * 52)}/year, 
    while S3 saves ~$${formatNum((s1.total - s3.total) * 52)}/year compared to the status quo.</p>
  `;

  div.scrollIntoView({ behavior: 'smooth', block: 'center' });
}


// ─── Utilities ──────────────────────────────────────────────────────────────
function formatNum(n) {
  if (n === undefined || n === null) return '0';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
