"""
Empty Container Repositioning Optimization — FastAPI Backend
Implements LP solver for 3 strategies across 5 Vietnamese ports.
Matches the exact model from Empty_Container_Model.xlsx
"""

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

# ─── Constants / Default Parameters (from Excel model) ───────────────────────

PORTS = ["cat_lai", "cai_mep", "hai_phong", "da_nang", "long_an"]
PORT_LABELS = {
    "cat_lai": "Cat Lai",
    "cai_mep": "Cai Mep",
    "hai_phong": "Hai Phong",
    "da_nang": "Da Nang",
    "long_an": "Long An",
}
N = len(PORTS)

# Default port parameters — exact values from Parameters sheet
DEFAULT_PARAMS = {
    "ports": {
        "cat_lai":   {"capacity": 50000, "storage_cost": 8.0,   "lease_cost": 850.0,  "import_rate": 38000, "export_rate": 62000},
        "cai_mep":   {"capacity": 65000, "storage_cost": 5.0,   "lease_cost": 900.0,  "import_rate": 31500, "export_rate": 43500},
        "hai_phong":  {"capacity": 70000, "storage_cost": 5.5,  "lease_cost": 880.0,  "import_rate": 81923, "export_rate": 54615},
        "da_nang":   {"capacity": 15000, "storage_cost": 5.5,   "lease_cost": 1050.0, "import_rate": 7015,  "export_rate": 7600},
        "long_an":   {"capacity": 12000, "storage_cost": 4.0,   "lease_cost": 1100.0, "import_rate": 2885,  "export_rate": 6731},
    },
    # Combined transport cost c_ij (USD/TEU) — includes base + carbon
    # From the Excel Parameters sheet "Unit Cost Matrix c_ij"
    # Order: cat_lai, cai_mep, hai_phong, da_nang, long_an
    "transport_cost": [
        [0,      50.52,  148.14, 118.48, 46.76],   # from Cat Lai
        [50.52,  0,      149.34, 119.68, 53.46],   # from Cai Mep
        [148.14, 149.34, 0,      111.26, 149.94],  # from Hai Phong
        [118.48, 119.68, 111.26, 0,      120.28],  # from Da Nang
        [46.76,  53.46,  149.94, 120.28, 0     ],  # from Long An
    ],
    # Transport mode labels for each route
    "transport_modes": [
        ["—",    "Road",  "Sea",  "Sea",  "Road" ],
        ["Road", "—",     "Sea",  "Sea",  "Barge"],
        ["Sea",  "Sea",   "—",    "Sea",  "Sea"  ],
        ["Sea",  "Sea",   "Sea",  "—",    "Sea"  ],
        ["Road", "Barge", "Sea",  "Sea",  "—"    ],
    ],
    # Distance matrix (km)
    "distances": [
        [0,    70,   1700, 960,  45  ],
        [70,   0,    1730, 990,  115 ],
        [1700, 1730, 0,    780,  1745],
        [960,  990,  780,  0,    1005],
        [45,   115,  1745, 1005, 0   ],
    ],
    # Carbon emission factors (kg CO2 / TEU-km)
    "carbon_factors": {
        "sea": 0.016,
        "barge": 0.020,
        "road": 0.062,
    },
    # Carbon price: 5 USD/tonne CO2 = 0.005 USD/kg CO2
    "carbon_price_per_kg": 0.005,
    # Storage carbon cost (USD/TEU/week)
    "storage_carbon_cost": 0.5,
}

# Default initial inventories from Excel Input sheet
DEFAULT_INITIAL_INVENTORY = {
    "cat_lai": 25000,
    "cai_mep": 30000,
    "hai_phong": 60000,
    "da_nang": 8000,
    "long_an": 3000,
}

DEFAULT_BARRIER = 0.5


# ─── Request / Response Models ──────────────────────────────────────────────

class SolveRequest(BaseModel):
    initial_inventory: Dict[str, float]
    barrier_coefficient: float = DEFAULT_BARRIER
    parameters: Optional[dict] = None


class CostBreakdown(BaseModel):
    TC_H: float
    TC_R: float
    TC_W: float
    TC_C: float
    total: float


class StrategyResult(BaseModel):
    name: str
    label: str
    costs: CostBreakdown
    flow_matrix: List[List[float]]
    leasing: Dict[str, float]
    end_inventory: Dict[str, float]


class SolveResponse(BaseModel):
    strategies: List[StrategyResult]
    savings_s2_vs_s1: float
    savings_s3_vs_s1: float
    port_labels: Dict[str, str]
    ports: List[str]
    initial_inventory: Dict[str, float]
    barrier_coefficient: float


# ─── Solver Logic ────────────────────────────────────────────────────────────

def solve_s1(initial_inv: list, params: dict) -> StrategyResult:
    """
    S1: Status Quo — No repositioning.
    Leasing covers any deficit: w_i = max(0, l_i - m_i - I_i)
    End inventory: I_end = I_i + m_i - l_i + w_i  (capped at capacity)
    """
    pp = params["ports"]
    c_h_carbon = params.get("storage_carbon_cost", 0.5)

    flow_matrix = [[0.0] * N for _ in range(N)]
    leasing = {}
    end_inv = {}
    tc_h = 0.0
    tc_w = 0.0
    tc_c = 0.0

    for idx, port in enumerate(PORTS):
        p = pp[port]
        inv = initial_inv[idx]

        net = inv + p["import_rate"] - p["export_rate"]

        if net < 0:
            w_i = -net
            end = 0.0
        else:
            w_i = 0.0
            end = min(net, p["capacity"])

        tc_h += end * p["storage_cost"]
        tc_w += w_i * p["lease_cost"]
        tc_c += end * c_h_carbon  # storage carbon

        leasing[port] = round(w_i, 1)
        end_inv[port] = round(end, 1)

    total = tc_h + tc_w + tc_c

    return StrategyResult(
        name="s1",
        label="S1: Status Quo (No Repositioning)",
        costs=CostBreakdown(
            TC_H=round(tc_h, 2), TC_R=0.0, TC_W=round(tc_w, 2),
            TC_C=round(tc_c, 2), total=round(total, 2),
        ),
        flow_matrix=flow_matrix, leasing=leasing, end_inventory=end_inv,
    )


def solve_lp(initial_inv: list, params: dict, use_threshold: bool, barrier: float) -> StrategyResult:
    """
    LP for S2 (threshold) or S3 (national network).

    Decision variables (flattened):
      x[0..N*N-1] = flow matrix x_ij  (diagonal forced to 0 via equality)
      x[N*N..N*N+N-1] = leasing w_i

    Objective: min  TOTAL_TC = TC_H + TC_R + TC_W + TC_C
      TC_H = Σ (h_i + c_h_carbon) * end_inv_i
           = Σ (h_i + c_h_carbon) * (net_i + inflow_i - outflow_i + w_i)
           = constant + linear_in_variables
      TC_R = Σ x_ij * c_ij
      TC_W = Σ w_i * ε_i

    Constraints:
      1. end_inv_i >= 0
      2. end_inv_i <= S_i
      3. x_ii = 0 (diagonal)
      4. x_ij >= 0, w_i >= 0
      5. [S2 only] total_outflow_i <= max(0, I_i - H_i)
    """
    pp = params["ports"]
    tc_matrix = params["transport_cost"]
    c_h_carbon = params.get("storage_carbon_cost", 0.5)

    n_flow = N * N
    n_vars = n_flow + N

    # ── Objective: min TC_H + TC_R + TC_W + TC_C ──
    # TC_H + TC_C_storage = Σ (h_i + c_h_carbon) * end_inv_i
    #   end_inv_i = net_i + Σ_j(x_ji) - Σ_j(x_ij) + w_i
    #   The net_i part is a constant (doesn't affect optimization).
    #   For variable x_ji (inflow to i): coefficient += (h_i + c_h_carbon)
    #   For variable x_ij (outflow from i): coefficient -= (h_i + c_h_carbon)
    #   For variable w_i: coefficient += (h_i + c_h_carbon)

    c = np.zeros(n_vars)

    # TC_R: transport cost for each flow x_ij
    for i in range(N):
        for j in range(N):
            if i != j:
                c[i * N + j] = tc_matrix[i][j]

    # TC_H + TC_C_storage contribution from flows:
    # x_ij adds to inventory at j (inflow) and removes from i (outflow)
    for i in range(N):
        hi = pp[PORTS[i]]["storage_cost"] + c_h_carbon
        for j in range(N):
            if i != j:
                # x_ij: outflow from i → reduces end_inv at i by 1
                c[i * N + j] -= hi
                # x_ij: inflow to j → increases end_inv at j by 1
                hj = pp[PORTS[j]]["storage_cost"] + c_h_carbon
                c[i * N + j] += hj

    # TC_W: leasing cost, plus TC_H/TC_C storage for leased containers
    for i in range(N):
        hi = pp[PORTS[i]]["storage_cost"] + c_h_carbon
        c[n_flow + i] = pp[PORTS[i]]["lease_cost"] + hi  # lease + storage of leased units

    # ── Inequality constraints ──
    A_ub_rows = []
    b_ub_rows = []

    for i in range(N):
        p = pp[PORTS[i]]
        inv_i = initial_inv[i]
        net_i = inv_i + p["import_rate"] - p["export_rate"]

        # Constraint: end_inv >= 0
        # → -(Σ_j x_ji) + (Σ_j x_ij) - w_i <= net_i
        row_lo = np.zeros(n_vars)
        for j in range(N):
            if j != i:
                row_lo[j * N + i] -= 1.0  # inflow x_ji
                row_lo[i * N + j] += 1.0  # outflow x_ij
        row_lo[n_flow + i] -= 1.0         # leasing w_i
        A_ub_rows.append(row_lo)
        b_ub_rows.append(net_i)

        # Constraint: end_inv <= capacity
        # → Σ_j x_ji - Σ_j x_ij + w_i <= capacity - net_i
        row_hi = np.zeros(n_vars)
        for j in range(N):
            if j != i:
                row_hi[j * N + i] += 1.0
                row_hi[i * N + j] -= 1.0
        row_hi[n_flow + i] += 1.0
        A_ub_rows.append(row_hi)
        b_ub_rows.append(p["capacity"] - net_i)

        # S2 threshold: total outflow <= max(0, I_i - H_i)
        if use_threshold:
            H_i = p["capacity"] * barrier
            max_out = max(0.0, inv_i - H_i)
            row_th = np.zeros(n_vars)
            for j in range(N):
                if j != i:
                    row_th[i * N + j] = 1.0
            A_ub_rows.append(row_th)
            b_ub_rows.append(max_out)

    # ── Equality: diagonal = 0 ──
    A_eq_rows = []
    b_eq_rows = []
    for i in range(N):
        row = np.zeros(n_vars)
        row[i * N + i] = 1.0
        A_eq_rows.append(row)
        b_eq_rows.append(0.0)

    A_ub = np.array(A_ub_rows)
    b_ub = np.array(b_ub_rows)
    A_eq = np.array(A_eq_rows)
    b_eq = np.array(b_eq_rows)

    bounds = [(0, None)] * n_vars

    result = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq,
                     bounds=bounds, method='highs')

    if not result.success:
        fallback = solve_s1(initial_inv, params)
        fallback.name = "s2" if use_threshold else "s3"
        fallback.label = ("S2: Regional Thresholds (INFEASIBLE)" if use_threshold
                          else "S3: National Network (INFEASIBLE)")
        return fallback

    x = result.x

    # Extract flow matrix
    flow_matrix = []
    for i in range(N):
        row = [round(max(0, x[i * N + j]), 1) for j in range(N)]
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
        p = pp[PORTS[i]]
        net_i = initial_inv[i] + p["import_rate"] - p["export_rate"]
        inflow = sum(flow_matrix[j][i] for j in range(N) if j != i)
        outflow = sum(flow_matrix[i][j] for j in range(N) if j != i)
        w_i = leasing_vals[PORTS[i]]
        end = net_i + inflow - outflow + w_i
        end = max(0, min(end, p["capacity"]))
        end_inv[PORTS[i]] = round(end, 1)
        tc_h += end * p["storage_cost"]
        tc_c_storage += end * c_h_carbon

    # Repositioning cost
    tc_r = 0.0
    for i in range(N):
        for j in range(N):
            if i != j and flow_matrix[i][j] > 0:
                tc_r += flow_matrix[i][j] * tc_matrix[i][j]

    tc_w = sum(leasing_vals[p] * pp[p]["lease_cost"] for p in PORTS)
    tc_c = tc_c_storage

    name = "s2" if use_threshold else "s3"
    label = "S2: Regional Thresholds" if use_threshold else "S3: National Network"

    return StrategyResult(
        name=name, label=label,
        costs=CostBreakdown(
            TC_H=round(tc_h, 2), TC_R=round(tc_r, 2),
            TC_W=round(tc_w, 2), TC_C=round(tc_c, 2),
            total=round(tc_h + tc_r + tc_w + tc_c, 2),
        ),
        flow_matrix=flow_matrix, leasing=leasing_vals, end_inventory=end_inv,
    )


# ─── API Endpoint ────────────────────────────────────────────────────────────

@app.post("/api/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    params = dict(DEFAULT_PARAMS)
    if req.parameters:
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

    s1_total = max(s1.costs.total, 1)
    savings_s2 = round((1 - s2.costs.total / s1_total) * 100, 2) if s1_total > 0 else 0
    savings_s3 = round((1 - s3.costs.total / s1_total) * 100, 2) if s1_total > 0 else 0

    return SolveResponse(
        strategies=[s1, s2, s3],
        savings_s2_vs_s1=savings_s2,
        savings_s3_vs_s1=savings_s3,
        port_labels=PORT_LABELS,
        ports=PORTS,
        initial_inventory=dict(zip(PORTS, initial_inv)),
        barrier_coefficient=req.barrier_coefficient,
    )


# ─── Serve Static Frontend ──────────────────────────────────────────────────

static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    def index():
        return FileResponse(str(static_dir / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
