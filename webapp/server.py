"""
Empty Container Repositioning Optimization — FastAPI Backend
Implements LP solver for 3 strategies across 5 Vietnamese ports.
"""

import json
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from scipy.optimize import linprog

# ─── App Setup ───────────────────────────────────────────────────────────────

app = FastAPI(title="Empty Container Repositioning Optimizer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ─── Constants / Default Parameters ─────────────────────────────────────────

PORTS = ["cat_lai", "cai_mep", "hai_phong", "da_nang", "long_an"]
PORT_LABELS = {
    "cat_lai": "Cat Lai",
    "cai_mep": "Cai Mep",
    "hai_phong": "Hai Phong",
    "da_nang": "Da Nang",
    "long_an": "Long An",
}
N = len(PORTS)

# Default port parameters
DEFAULT_PARAMS = {
    "ports": {
        "cat_lai":  {"capacity": 50000, "storage_cost": 8.0,  "lease_cost": 950.0,  "import_rate": 25000, "export_rate": 45000},
        "cai_mep":  {"capacity": 30000, "storage_cost": 5.0,  "lease_cost": 900.0,  "import_rate": 20000, "export_rate": 15000},
        "hai_phong": {"capacity": 40000, "storage_cost": 6.0, "lease_cost": 850.0,  "import_rate": 30000, "export_rate": 20000},
        "da_nang":  {"capacity": 15000, "storage_cost": 5.0,  "lease_cost": 1000.0, "import_rate": 2000,  "export_rate": 3200},
        "long_an":  {"capacity": 12000, "storage_cost": 4.0,  "lease_cost": 1100.0, "import_rate": 2000,  "export_rate": 5000},
    },
    # Transport cost matrix (USD/TEU) — includes combined best-mode cost
    # Row = origin, Col = destination, order: cat_lai, cai_mep, hai_phong, da_nang, long_an
    "transport_cost": [
        [0,    45,   130,  100,  60 ],   # from Cat Lai
        [45,   0,    140,  110,  55 ],   # from Cai Mep
        [130,  140,  0,    85,   160],   # from Hai Phong
        [100,  110,  85,   0,    140],   # from Da Nang
        [60,   55,   160,  140,  0  ],   # from Long An
    ],
    # Transport mode labels for each route (for display)
    "transport_modes": [
        ["—",     "Road",    "Coastal", "Coastal", "Barge"],
        ["Road",  "—",       "Coastal", "Coastal", "Barge"],
        ["Coastal","Coastal", "—",      "Coastal", "Coastal"],
        ["Coastal","Coastal", "Coastal", "—",      "Coastal"],
        ["Barge", "Barge",   "Coastal", "Coastal", "—"    ],
    ],
    # Distance matrix (km)
    "distances": [
        [0,    70,   1700, 960,  50 ],
        [70,   0,    1750, 1000, 80 ],
        [1700, 1750, 0,    770,  1800],
        [960,  1000, 770,  0,    1100],
        [50,   80,   1800, 1100, 0  ],
    ],
    # Carbon emission factors (kg CO2 / TEU-km)
    "carbon_factors": {
        "sea": 0.016,
        "barge": 0.020,
        "road": 0.062,
    },
    # Carbon cost (USD per kg CO2)
    "carbon_price": 0.01,
    # Storage carbon (USD/TEU/week)
    "storage_carbon_cost": 0.05,
}

DEFAULT_INITIAL_INVENTORY = {
    "cat_lai": 25000,
    "cai_mep": 18000,
    "hai_phong": 30000,
    "da_nang": 5000,
    "long_an": 3000,
}

DEFAULT_BARRIER = 0.5


# ─── Request / Response Models ──────────────────────────────────────────────

class SolveRequest(BaseModel):
    initial_inventory: Dict[str, float]
    barrier_coefficient: float = DEFAULT_BARRIER
    parameters: Optional[dict] = None  # overrides for DEFAULT_PARAMS


class CostBreakdown(BaseModel):
    TC_H: float   # storage
    TC_R: float   # repositioning
    TC_W: float   # leasing
    TC_C: float   # carbon
    total: float


class StrategyResult(BaseModel):
    name: str
    label: str
    costs: CostBreakdown
    flow_matrix: List[List[float]]    # NxN repositioning volumes
    leasing: Dict[str, float]         # per-port leasing
    end_inventory: Dict[str, float]   # per-port end inventory


class SolveResponse(BaseModel):
    strategies: List[StrategyResult]
    savings_s2_vs_s1: float  # percentage
    savings_s3_vs_s1: float
    port_labels: Dict[str, str]
    ports: List[str]


# ─── Solver Logic ────────────────────────────────────────────────────────────

def get_carbon_cost_matrix(params: dict) -> list[list[float]]:
    """Calculate carbon cost for each route based on mode, distance, and carbon price."""
    distances = params["distances"]
    modes = params["transport_modes"]
    cf = params["carbon_factors"]
    cp = params["carbon_price"]

    mode_map = {"Road": "road", "Barge": "barge", "Coastal": "sea", "—": "sea"}
    carbon_matrix = []
    for i in range(N):
        row = []
        for j in range(N):
            if i == j:
                row.append(0.0)
            else:
                mode_key = mode_map.get(modes[i][j], "sea")
                row.append(distances[i][j] * cf[mode_key] * cp)
        carbon_matrix.append(row)
    return carbon_matrix


def solve_s1(initial_inv: list[float], params: dict) -> StrategyResult:
    """
    Strategy S1: Status Quo — No repositioning.
    Each port handles its own surplus/deficit independently.
    """
    ports_params = params["ports"]
    carbon_cost_storage = params.get("storage_carbon_cost", 0.05)

    flow_matrix = [[0.0] * N for _ in range(N)]
    leasing = {}
    end_inv_dict = {}
    tc_h = 0.0
    tc_w = 0.0
    tc_c_storage = 0.0

    for idx, port in enumerate(PORTS):
        pp = ports_params[port]
        inv = initial_inv[idx]

        # Flow balance: end = start + import - export + leased
        net = inv + pp["import_rate"] - pp["export_rate"]

        lease_amount = 0.0
        if net < 0:
            lease_amount = -net
            net = 0.0

        # Cap at capacity
        end = min(net, pp["capacity"])
        lease_amount = max(0, lease_amount)  # ensure non-negative

        # Costs
        storage_cost = end * pp["storage_cost"]
        leasing_cost = lease_amount * pp["lease_cost"]
        carbon_storage = end * carbon_cost_storage

        tc_h += storage_cost
        tc_w += leasing_cost
        tc_c_storage += carbon_storage

        leasing[port] = round(lease_amount, 1)
        end_inv_dict[port] = round(end, 1)

    return StrategyResult(
        name="s1",
        label="S1: Status Quo (No Repositioning)",
        costs=CostBreakdown(
            TC_H=round(tc_h, 2),
            TC_R=0.0,
            TC_W=round(tc_w, 2),
            TC_C=round(tc_c_storage, 2),
            total=round(tc_h + tc_w + tc_c_storage, 2),
        ),
        flow_matrix=flow_matrix,
        leasing=leasing,
        end_inventory=end_inv_dict,
    )


def solve_lp(initial_inv: list[float], params: dict, use_threshold: bool, barrier: float) -> StrategyResult:
    """
    Solve LP for S2 (threshold) or S3 (national network).

    Decision variables (flattened):
      x[0..N*N-1]  = flow matrix x_ij  (N*N vars, diagonal forced to 0)
      x[N*N..N*N+N-1] = leasing w_i    (N vars)

    Total vars = N*N + N
    """
    ports_params = params["ports"]
    transport_cost = params["transport_cost"]
    carbon_matrix = get_carbon_cost_matrix(params)
    carbon_cost_storage = params.get("storage_carbon_cost", 0.05)

    n_flow = N * N
    n_lease = N
    n_vars = n_flow + n_lease

    # ── Objective: minimize TC_R + TC_W + TC_C(transport) ──
    # (TC_H and TC_C_storage are computed post-hoc from end inventory)
    c = np.zeros(n_vars)

    # Flow costs (transport + carbon)
    for i in range(N):
        for j in range(N):
            if i != j:
                idx = i * N + j
                c[idx] = transport_cost[i][j] + carbon_matrix[i][j]

    # Leasing costs
    for i in range(N):
        pp = ports_params[PORTS[i]]
        c[n_flow + i] = pp["lease_cost"]

    # ── Inequality constraints: A_ub @ x <= b_ub ──
    A_ub_rows = []
    b_ub_rows = []

    for i in range(N):
        pp = ports_params[PORTS[i]]
        inv_i = initial_inv[i]
        net_i = inv_i + pp["import_rate"] - pp["export_rate"]

        # End inventory = net_i + sum_j(x_ji) - sum_j(x_ij) + w_i
        # Constraint 1: end_inv >= 0  →  -(sum_j x_ji - sum_j x_ij + w_i) <= net_i
        row1 = np.zeros(n_vars)
        for j in range(N):
            if j != i:
                row1[j * N + i] -= 1.0   # inflow x_ji (negated because we flip inequality)
                row1[i * N + j] += 1.0    # outflow x_ij
        row1[n_flow + i] -= 1.0           # leasing w_i
        A_ub_rows.append(row1)
        b_ub_rows.append(net_i)  # end_inv >= 0 → -(inflow - outflow + w) <= net

        # Constraint 2: end_inv <= capacity  →  sum_j x_ji - sum_j x_ij + w_i <= capacity - net_i
        row2 = np.zeros(n_vars)
        for j in range(N):
            if j != i:
                row2[j * N + i] += 1.0
                row2[i * N + j] -= 1.0
        row2[n_flow + i] += 1.0
        A_ub_rows.append(row2)
        b_ub_rows.append(pp["capacity"] - net_i)

        # Threshold constraint (S2 only): total outflow from port i <= max(0, inv_i - H_i)
        if use_threshold:
            H_i = pp["capacity"] * barrier
            max_out = max(0.0, inv_i - H_i)
            row_th = np.zeros(n_vars)
            for j in range(N):
                if j != i:
                    row_th[i * N + j] = 1.0
            A_ub_rows.append(row_th)
            b_ub_rows.append(max_out)

    # ── Equality constraints: diagonal flows = 0 ──
    A_eq_rows = []
    b_eq_rows = []
    for i in range(N):
        row = np.zeros(n_vars)
        row[i * N + i] = 1.0
        A_eq_rows.append(row)
        b_eq_rows.append(0.0)

    A_ub = np.array(A_ub_rows)
    b_ub = np.array(b_ub_rows)
    A_eq = np.array(A_eq_rows) if A_eq_rows else None
    b_eq = np.array(b_eq_rows) if b_eq_rows else None

    bounds = [(0, None)] * n_vars

    result = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq, bounds=bounds, method='highs')

    if not result.success:
        # Fallback: return S1-like result with a warning
        return solve_s1(initial_inv, params)

    x = result.x

    # Extract flow matrix
    flow_matrix = []
    for i in range(N):
        row = []
        for j in range(N):
            row.append(round(max(0, x[i * N + j]), 1))
        flow_matrix.append(row)

    # Extract leasing
    leasing_vals = {}
    for i in range(N):
        leasing_vals[PORTS[i]] = round(max(0, x[n_flow + i]), 1)

    # Compute end inventories and costs
    end_inv = {}
    tc_h = 0.0
    tc_c_storage = 0.0
    for i in range(N):
        pp = ports_params[PORTS[i]]
        net_i = initial_inv[i] + pp["import_rate"] - pp["export_rate"]
        inflow = sum(flow_matrix[j][i] for j in range(N) if j != i)
        outflow = sum(flow_matrix[i][j] for j in range(N) if j != i)
        w_i = leasing_vals[PORTS[i]]
        end = net_i + inflow - outflow + w_i
        end = max(0, min(end, pp["capacity"]))
        end_inv[PORTS[i]] = round(end, 1)
        tc_h += end * pp["storage_cost"]
        tc_c_storage += end * carbon_cost_storage

    # Transport costs
    tc_r = 0.0
    tc_c_transport = 0.0
    for i in range(N):
        for j in range(N):
            if i != j and flow_matrix[i][j] > 0:
                tc_r += flow_matrix[i][j] * transport_cost[i][j]
                tc_c_transport += flow_matrix[i][j] * carbon_matrix[i][j]

    tc_w = sum(leasing_vals[p] * ports_params[p]["lease_cost"] for p in PORTS)
    tc_c = tc_c_storage + tc_c_transport

    strategy_name = "s2" if use_threshold else "s3"
    strategy_label = "S2: Regional Thresholds" if use_threshold else "S3: National Network"

    return StrategyResult(
        name=strategy_name,
        label=strategy_label,
        costs=CostBreakdown(
            TC_H=round(tc_h, 2),
            TC_R=round(tc_r, 2),
            TC_W=round(tc_w, 2),
            TC_C=round(tc_c, 2),
            total=round(tc_h + tc_r + tc_w + tc_c, 2),
        ),
        flow_matrix=flow_matrix,
        leasing=leasing_vals,
        end_inventory=end_inv,
    )


# ─── API Endpoint ────────────────────────────────────────────────────────────

@app.post("/api/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    params = dict(DEFAULT_PARAMS)
    if req.parameters:
        # Merge user overrides
        for key, val in req.parameters.items():
            if key in params:
                if isinstance(val, dict) and isinstance(params[key], dict):
                    params[key] = {**params[key], **val}
                else:
                    params[key] = val

    initial_inv = [req.initial_inventory.get(p, 0) for p in PORTS]

    s1 = solve_s1(initial_inv, params)
    s2 = solve_lp(initial_inv, params, use_threshold=True, barrier=req.barrier_coefficient)
    s3 = solve_lp(initial_inv, params, use_threshold=False, barrier=0.0)

    s1_total = s1.costs.total if s1.costs.total > 0 else 1
    savings_s2 = round((1 - s2.costs.total / s1_total) * 100, 2) if s1_total > 0 else 0
    savings_s3 = round((1 - s3.costs.total / s1_total) * 100, 2) if s1_total > 0 else 0

    return SolveResponse(
        strategies=[s1, s2, s3],
        savings_s2_vs_s1=savings_s2,
        savings_s3_vs_s1=savings_s3,
        port_labels=PORT_LABELS,
        ports=PORTS,
    )


# ─── Serve Static Frontend ──────────────────────────────────────────────────

static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    def index():
        return FileResponse(str(static_dir / "index.html"))


# ─── Run ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
