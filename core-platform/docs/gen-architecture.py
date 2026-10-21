#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml==6.0.2"]
# ///
"""Deterministic architecture diagram of the core platform.

Reads ../podman-compose.yml (the platform) and ../templates/podman-compose.yml
(the canonical app) and writes docs/architecture.html. Same inputs → byte-identical
output: no timestamp, no randomness, every collection is iterated in a fixed order.

Two kinds of edges:
  - DERIVED: read from the compose files — `depends_on`, a `*.internal` hostname
    (or `host.containers.internal:<published port>`) in an env value, an image
    pulled from the local registry, a mounted podman socket.
  - CONTRACT: the dependencies the compose cannot show (they live in
    bootstrap.sh / seed-and-deploy.sh / the README) — declared in CONTRACT_EDGES.

Usage:  uv run docs/gen-architecture.py     (from td/core-platform/)
"""
from __future__ import annotations

import hashlib
import html
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "podman-compose.yml"
APP = ROOT / "templates" / "podman-compose.yml"
OUT = ROOT / "docs" / "architecture.html"

# ── Curated knowledge: the layer, the pattern and the "why" of each service ──
# Every compose service MUST appear here — the script fails otherwise, so a new
# container can never slip into the diagram without an explanation.
META: dict[str, dict] = {
    # Applications (the canonical app template)
    "app/frontend": dict(layer=0, col=0, label="frontend", tech="nginx · TS + Vite",
        pattern="SPA statique servie par nginx",
        why="La surface utilisateur de chaque app métier. Sert le build Vite, en-têtes de sécurité, fallback SPA."),
    "app/api": dict(layer=0, col=1, label="api", tech="TS + Bun",
        pattern="API REST · Health Endpoint Monitoring · proxy first-party",
        why="Le point d'entrée métier : lit ses secrets dans OpenBao au boot, parle à Postgres/S3/Valkey, publie des jobs, relaie le beacon analytics."),
    "app/worker": dict(layer=0, col=2, label="worker", tech="TS + Bun",
        pattern="Competing Consumers (Queue-Based Load Leveling)",
        why="Traite en asynchrone ce que l'API dépose dans Valkey ; n'expose que /health + /ready."),
    # Edge — gateways and user-facing shared services
    "core/apisix": dict(layer=1, col=2, label="apisix", tech="Apache APISIX 3.17 · standalone",
        pattern="API Gateway / Gateway Offloading (AI gateway) · Adapter de fournisseur",
        why="Un seul point de sortie vers les LLM : clé virtuelle + budget de tokens par app, alias de modèles, la vraie clé fournisseur n'est connue que de lui. Bascule OpenAI ⇄ Anthropic sans toucher aux apps."),
    "core/casdoor": dict(layer=1, col=0, label="casdoor", tech="Casdoor · OIDC",
        pattern="Federated Identity (Identity Provider OIDC)",
        why="L'authentification est mutualisée : un client OIDC self-service par app, aucune app ne gère de mots de passe."),
    "core/umami": dict(layer=1, col=1, label="umami", tech="Umami 3 · analytics",
        pattern="Product analytics · beacon proxifié first-party",
        why="Répond à « que font les utilisateurs ? » (navigation + événements de valeur). Un website par app ; séparé de la mesure p99 qui, elle, vient des logs API."),
    # Orchestration & messaging
    "core/temporal": dict(layer=2, col=1, label="temporal", tech="Temporal 1.29 · auto-setup",
        pattern="Durable Execution · Saga orchestrée (compensation, timers, retries)",
        why="Pour les processus qui doivent survivre à un redémarrage, attendre des heures, ou attendre un humain. Un namespace par app. Complète le Stream Valkey, ne le remplace pas."),
    "core/temporal-ui": dict(layer=2, col=0, label="temporal-ui", tech="Temporal UI 2.53",
        pattern="Console opérateur",
        why="Historique des runs, I/O de chaque activité, stack trace d'un workflow bloqué, replay manuel."),
    "core/valkey": dict(layer=2, col=2, label="valkey", tech="Valkey 9 (fork BSD de Redis)",
        pattern="Cache · Pub/Sub · Queue (Streams + consumer groups)",
        why="État partagé rapide et file de fan-out vers les workers. Préfixe <app>: par app. Alias redis.internal conservé → aucune app modifiée."),
    # Data & secrets
    "core/postgres": dict(layer=3, col=0, label="postgres", tech="PostgreSQL 17 + pgvector",
        pattern="Serveur partagé · Database-per-tenant (1 DB + 1 user par app)",
        why="Base relationnelle de toutes les apps, ET persistance de Temporal, Casdoor et Umami. pgvector disponible en opt-in pour le RAG."),
    "core/s3": dict(layer=3, col=1, label="s3", tech="SeaweedFS 4.44 · S3",
        pattern="Object Storage modélisé en service externe · Valet Key (clé scopée par bucket)",
        why="Médias et assets. Volontairement sans alias .internal (comme un S3 cloud) : consommé via host.containers.internal:9000. Un bucket + une clé scopée par app."),
    "core/openbao": dict(layer=3, col=2, label="openbao", tech="OpenBao 2.6 (fork MPL de Vault)",
        pattern="External Configuration Store · Secret Store centralisé",
        why="Aucun secret en clair dans les fichiers : chaque app lit secret/<app>/ au boot, les clés des services core y sont injectées au déploiement. Audit device déclaré dès le premier boot."),
    # Ops & supply chain
    "core/registry": dict(layer=4, col=0, label="registry", tech="distribution/registry 2",
        pattern="Artifact Repository (build once, deploy many)",
        why="Registre OCI local : la CI pousse localhost:5000/<app>/<service>:<tag>, les composes des apps tirent de là."),
    "core/dozzle": dict(layer=4, col=2, label="dozzle", tech="Dozzle",
        pattern="Log Aggregation (logs 12-factor sur stdout)",
        why="Les apps n'écrivent que sur stdout/stderr ; Dozzle lit le socket podman et agrège tout en temps réel, sans agent."),
}

# Nodes that are not containers but must appear to make the flows readable.
VIRTUAL: dict[str, dict] = {
    "ext/llm": dict(layer=1, col=3, label="OpenAI / Anthropic", tech="API fournisseur (Internet)",
        pattern="Service externe", why="Le vrai fournisseur LLM, joignable uniquement via APISIX."),
    "ext/podman": dict(layer=4, col=3, label="podman.sock", tech="runtime rootless",
        pattern="Runtime de conteneurs", why="Source des logs de tous les conteneurs, montée en lecture seule dans Dozzle."),
}

LAYERS = [
    ("apps", "Applications métier", "gabarit d'app — ×N apps"),
    ("edge", "Passerelles & services exposés", "LLM, identité, analytics"),
    ("orch", "Orchestration & messaging", "asynchrone et durable"),
    ("data", "Données & secrets", "état persistant"),
    ("ops", "Ops & supply chain", "images et logs"),
]

# (source, target, label) — consumer → provider. Dependencies not visible in the
# compose files; the comment says where each one is established.
CONTRACT_EDGES = [
    ("app/frontend", "app/api", "REST"),                       # canonical template
    ("app/frontend", "core/casdoor", "login OIDC"),            # README: Identity contract
    ("app/api", "core/casdoor", "OIDC / JWKS"),
    ("app/api", "core/apisix", "LLM · clé virtuelle"),          # bootstrap.sh: llm.internal:9080
    ("app/api", "core/temporal", "workflows"),                 # bootstrap.sh: temporal.internal:7233
    ("app/worker", "core/temporal", "activités"),
    ("app/api", "core/umami", "beacon proxifié"),               # compose: CLIENT_IP_HEADER comment
    ("core/apisix", "ext/llm", "vraie clé fournisseur"),       # apisix/routes.*.yaml
    ("core/apisix", "core/openbao", "clés injectées au déploiement"),  # apisix/seed-and-deploy.sh
    ("core/casdoor", "core/openbao", "secrets au déploiement"),        # idp/seed-and-deploy.sh
    ("core/umami", "core/openbao", "secrets au déploiement"),          # analytics/seed-and-deploy.sh
]

HOST_RE = re.compile(r"\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.internal)(?::(\d+))?")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def load(path: Path, prefix: str) -> dict[str, dict]:
    doc = yaml.safe_load(path.read_text())
    return {f"{prefix}/{k}": v for k, v in doc["services"].items()}


def network_aliases(svc: dict) -> list[str]:
    nets = svc.get("networks") or {}
    if isinstance(nets, list):
        return []
    out: list[str] = []
    for cfg in nets.values():
        out += (cfg or {}).get("aliases", [])
    return out


def host_ports(svc: dict) -> list[tuple[str, str]]:
    out = []
    for p in svc.get("ports", []):
        host, _, ctr = str(p).rpartition(":")
        out.append((host, ctr))
    return out


def env_values(svc: dict) -> list[str]:
    env = svc.get("environment") or {}
    if isinstance(env, list):
        return [str(e).split("=", 1)[-1] for e in env]
    return [str(v) for v in env.values()]


def build():
    services = {**load(CORE, "core"), **load(APP, "app")}
    missing = sorted(set(services) - set(META))
    extra = sorted(set(META) - set(services))
    if missing or extra:
        sys.exit(f"META out of sync with the compose files: missing={missing} extra={extra}")

    # name → service id (container_name, hostname, aliases, compose key)
    names: dict[str, str] = {}
    published: dict[str, str] = {}  # host port → service id
    for sid in sorted(services):
        svc = services[sid]
        for n in [svc.get("container_name"), svc.get("hostname"), *network_aliases(svc)]:
            if n and "${" not in n:
                names[n] = sid
        if sid.startswith("core/"):
            for host, _ in host_ports(svc):
                published[host] = sid

    edges: dict[tuple[str, str], dict] = {}

    def add(src, dst, kind, label):
        if src == dst:
            return
        e = edges.setdefault((src, dst), {"kinds": set(), "labels": []})
        e["kinds"].add(kind)
        if label not in e["labels"]:
            e["labels"].append(label)

    for sid in sorted(services):
        svc = services[sid]
        deps = svc.get("depends_on") or {}
        for d in sorted(deps):
            add(sid, f"{sid.split('/')[0]}/{d}", "derived", "depends_on")
        for val in env_values(svc):
            for host, port in HOST_RE.findall(val):
                if host == "host.containers.internal":
                    tgt = published.get(port)
                    if tgt:
                        add(sid, tgt, "derived", f"host.containers.internal:{port}")
                elif host in names:
                    add(sid, names[host], "derived", host + (f":{port}" if port else ""))
        img = str(svc.get("image", ""))
        if img.startswith("localhost:"):
            port = img.split(":", 1)[1].split("/", 1)[0]
            if port in published:
                add(sid, published[port], "derived", "pull image")
        for v in svc.get("volumes", []):
            if "podman.sock" in str(v):
                add(sid, "ext/podman", "derived", "podman.sock (ro)")

    for src, dst, label in CONTRACT_EDGES:
        add(src, dst, "contract", label)

    return services, edges


# ── Layout: a fixed grid (band = layer, column = META col) ─────────────────────
NCOLS, NODE_W, NODE_H = 4, 200, 78
BAND_H, BAND_TOP, LEFT, PITCH = 170, 30, 230, 280
W = LEFT + NCOLS * PITCH + 10
GAP = (BAND_H - NODE_H) / 2          # free height above/below a node in its band


def layout(nodes: dict[str, dict]) -> dict[str, tuple[float, float]]:
    pos, seen = {}, set()
    for n, m in nodes.items():
        cell = (m["layer"], m["col"])
        if cell in seen:
            sys.exit(f"two nodes on the same grid cell {cell}")
        seen.add(cell)
        pos[n] = (LEFT + m["col"] * PITCH + (PITCH - NODE_W) / 2, BAND_TOP + m["layer"] * BAND_H + GAP)
    return pos


def rounded(points: list[tuple[float, float]], r: float = 10) -> str:
    """An orthogonal polyline with rounded corners, as an SVG path."""
    d = [f"M{points[0][0]:.1f},{points[0][1]:.1f}"]
    for i in range(1, len(points) - 1):
        (x0, y0), (x1, y1), (x2, y2) = points[i - 1], points[i], points[i + 1]
        l1, l2 = abs(x1 - x0) + abs(y1 - y0), abs(x2 - x1) + abs(y2 - y1)
        if l1 == 0 or l2 == 0:
            continue
        k = min(r, l1 / 2, l2 / 2)
        ax, ay = x1 - (x1 - x0) / l1 * k, y1 - (y1 - y0) / l1 * k
        bx, by = x1 + (x2 - x1) / l2 * k, y1 + (y2 - y1) / l2 * k
        d.append(f"L{ax:.1f},{ay:.1f} Q{x1:.1f},{y1:.1f} {bx:.1f},{by:.1f}")
    d.append(f"L{points[-1][0]:.1f},{points[-1][1]:.1f}")
    return " ".join(d)


def route(nodes, pos, edges) -> dict[tuple[str, str], str]:
    """Deterministic orthogonal routing. Every edge leaves its source by the side
    facing the target, runs in the horizontal corridor between two bands, and —
    when it spans more than one band — goes down a vertical lane that no node
    of the crossed bands occupies."""
    layer = {n: nodes[n]["layer"] for n in nodes}
    keys = sorted(edges, key=lambda e: (layer[e[0]], nodes[e[0]]["col"], layer[e[1]], nodes[e[1]]["col"], e))

    # 1. the endpoints, spread along each node side
    ends: dict[tuple[str, str], list] = {}
    for e in keys:
        s, d = e
        if layer[s] == layer[d]:
            ss = ds = "top"
        else:
            ss, ds = ("bottom", "top") if layer[s] < layer[d] else ("top", "bottom")
        ends.setdefault((s, ss), []).append((pos[d][0], e))
        ends.setdefault((d, ds), []).append((pos[s][0], e))
    anchor = {}
    for (n, side), items in sorted(ends.items()):
        items.sort()
        for i, (_, e) in enumerate(items):
            x = pos[n][0] + 18 + (NODE_W - 36) * (i + 1) / (len(items) + 1)
            y = pos[n][1] + (NODE_H if side == "bottom" else 0)
            anchor[(n, e)] = (x, y)

    # 2. the vertical lane of each edge spanning more than one band
    def free(lo, hi):
        """x intervals free of any node in bands lo..hi (inclusive)."""
        blocked = sorted((pos[n][0] - 14, pos[n][0] + NODE_W + 14) for n in nodes if lo <= layer[n] <= hi)
        out, x = [], LEFT
        for a, b in blocked:
            if a > x:
                out.append((x, a))
            x = max(x, b)
        if x < W - 6:
            out.append((x, W - 6))
        return out

    lanes: dict[tuple[float, float], list] = {}
    lane_of = {}
    for e in keys:
        s, d = e
        lo, hi = sorted((layer[s], layer[d]))
        if hi - lo < 2:
            continue
        x1, x2 = anchor[(s, e)][0], anchor[(d, e)][0]
        def dist(x, iv):
            return 0 if iv[0] <= x <= iv[1] else min(abs(x - iv[0]), abs(x - iv[1]))
        iv = min(free(lo + 1, hi - 1), key=lambda iv: (dist(x1, iv) + dist(x2, iv), iv))
        lanes.setdefault(iv, []).append((x1, x2, e))
        lane_of[e] = iv
    lane_x = {}
    for iv, items in sorted(lanes.items()):
        items.sort()
        width = min(iv[1] - iv[0], 18.0 * (len(items) + 1))
        start = (iv[0] + iv[1]) / 2 - width / 2
        for i, (_, _, e) in enumerate(items):
            lane_x[e] = start + width * (i + 1) / (len(items) + 1)

    # 3. the corridor height of each horizontal run, spread per corridor
    runs: dict[int, list] = {}
    for e in keys:
        s, d = e
        ls, ld = layer[s], layer[d]
        if ls == ld:
            runs.setdefault(ls, []).append((e, "first"))
        elif ld > ls:
            runs.setdefault(ls + 1, []).append((e, "first"))
            if e in lane_of:
                runs.setdefault(ld, []).append((e, "last"))
        else:
            runs.setdefault(ls, []).append((e, "first"))
            if e in lane_of:
                runs.setdefault(ld + 1, []).append((e, "last"))
    run_y = {}
    for boundary, items in sorted(runs.items()):
        yb = BAND_TOP + boundary * BAND_H
        span = 2 * GAP - 22
        for i, item in enumerate(items):
            run_y[item] = yb - span / 2 + span * (i + 1) / (len(items) + 1)

    paths = {}
    for e in keys:
        s, d = e
        (x1, y1), (x2, y2) = anchor[(s, e)], anchor[(d, e)]
        ya = run_y[(e, "first")]
        if e in lane_of:
            lx, yb = lane_x[e], run_y[(e, "last")]
            pts = [(x1, y1), (x1, ya), (lx, ya), (lx, yb), (x2, yb), (x2, y2)]
        else:
            pts = [(x1, y1), (x1, ya), (x2, ya), (x2, y2)]
        paths[e] = rounded(pts)
    return paths


def esc(s: str) -> str:
    return html.escape(str(s), quote=True)


def render(services, edges) -> str:
    nodes = {**META, **VIRTUAL}
    nodes = {k: nodes[k] for k in [*META, *VIRTUAL]}
    pos = layout(nodes)
    H = BAND_TOP + len(LAYERS) * BAND_H + 20

    paths = route(nodes, pos, edges)

    svg = []
    for li, (lid, title, sub) in enumerate(LAYERS):
        y = BAND_TOP + li * BAND_H
        svg.append(f'<rect class="band b{li % 2}" x="0" y="{y}" width="{W}" height="{BAND_H}"/>')
        svg.append(f'<text class="band-title" x="16" y="{y + BAND_H / 2 - 4}">{esc(title)}</text>')
        svg.append(f'<text class="band-sub" x="16" y="{y + BAND_H / 2 + 14}">{esc(sub)}</text>')

    for (s, d) in sorted(edges):
        e = edges[(s, d)]
        kind = "contract" if e["kinds"] == {"contract"} else "derived"
        path = paths[(s, d)]
        title = f"{nodes[s]['label']} → {nodes[d]['label']} : " + " · ".join(e["labels"])
        svg.append(
            f'<path class="edge {kind}" data-s="{esc(s)}" data-d="{esc(d)}" d="{path}" '
            f'marker-end="url(#arrow-{kind})"><title>{esc(title)}</title></path>'
        )

    for n in nodes:
        x, y = pos[n]
        m = nodes[n]
        cls = "virtual" if n in VIRTUAL else n.split("/")[0]
        dns = ""
        if n in services:
            svc = services[n]
            dns = svc.get("container_name", "").replace("${APP}", "<app>")
            ports = ",".join(re.sub(r"\$\{\w+:-(\d+)\}", r"\1", h) for h, _ in host_ports(svc))
            if ports:
                dns += f"  :{ports}"
        svg.append(
            f'<g class="node {cls}" data-id="{esc(n)}" tabindex="0">'
            f'<rect x="{x}" y="{y}" width="{NODE_W}" height="{NODE_H}" rx="10"/>'
            f'<text class="n-label" x="{x + 12}" y="{y + 24}">{esc(m["label"])}</text>'
            f'<text class="n-tech" x="{x + 12}" y="{y + 44}">{esc(m["tech"])}</text>'
            f'<text class="n-dns" x="{x + 12}" y="{y + 63}">{esc(dns)}</text>'
            f'<title>{esc(m["pattern"])}</title></g>'
        )

    defs = (
        '<defs>'
        '<marker id="arrow-derived" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah derived"/></marker>'
        '<marker id="arrow-contract" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ah contract"/></marker>'
        '</defs>'
    )
    svg_doc = f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Schéma d\'architecture du core platform">{defs}{"".join(svg)}</svg>'

    # Inventory table — one row per container, compose order within each layer.
    rows = []
    for n in META:
        svc, m = services[n], META[n]
        aliases = [a for a in network_aliases(svc) if a != svc.get("container_name")]
        ports = ", ".join(f"{h}→{c}" for h, c in host_ports(svc)) or "—"
        vols = ", ".join(str(v).split(":")[0] for v in svc.get("volumes", [])) or "—"
        deps = ", ".join(sorted(svc.get("depends_on") or {})) or "—"
        hc = "oui" if svc.get("healthcheck") else "—"
        out_e = [f"{nodes[d]['label']}" for (s, d) in sorted(edges) if s == n]
        rows.append(
            f'<tr data-id="{esc(n)}"><td><b>{esc(m["label"])}</b><br><span class="muted">{esc(n.split("/")[0])}</span></td>'
            f'<td><code>{esc(svc.get("container_name", ""))}</code>'
            + (f'<br><span class="muted">alias : {esc(", ".join(aliases))}</span>' if aliases else "")
            + f'</td><td><code>{esc(svc.get("image", ""))}</code></td><td>{esc(ports)}</td>'
            f'<td>{esc(m["pattern"])}</td><td>{esc(m["why"])}</td>'
            f'<td class="small">{esc(", ".join(out_e) or "—")}</td>'
            f'<td class="small">deps : {esc(deps)}<br>volumes : {esc(vols)}<br>healthcheck : {hc}</td></tr>'
        )

    edge_rows = []
    for (s, d) in sorted(edges):
        e = edges[(s, d)]
        kind = " + ".join(sorted("dérivé" if k == "derived" else "contrat" for k in e["kinds"]))
        edge_rows.append(
            f'<tr><td>{esc(nodes[s]["label"])}</td><td>{esc(nodes[d]["label"])}</td>'
            f'<td>{esc(" · ".join(e["labels"]))}</td><td>{esc(kind)}</td></tr>'
        )

    n_core = sum(1 for n in services if n.startswith("core/"))
    n_app = sum(1 for n in services if n.startswith("app/"))
    fingerprint = f"podman-compose.yml sha256:{sha(CORE)} · templates/podman-compose.yml sha256:{sha(APP)}"

    return TEMPLATE.format(
        svg=svg_doc, rows="\n".join(rows), edge_rows="\n".join(edge_rows),
        n_core=n_core, n_app=n_app, n_edges=len(edges), fingerprint=esc(fingerprint),
    )


TEMPLATE = """<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Core Platform Architecture</title>
<style>
:root {{
  --bg:#f7f7f5; --surface:#ffffff; --ink:#1d1d1b; --muted:#6b6b66; --line:#d9d8d2;
  --band0:#f0efe9; --band1:#f7f7f5;
  --core:#2f5d8a; --core-bg:#eaf1f8; --app:#7a4b9c; --app-bg:#f3ecf8; --virt:#7d7d76; --virt-bg:#f1f1ee;
  --derived:#2f5d8a; --contract:#c0612b; --hl:#d4a017;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg:#151513; --surface:#1e1e1c; --ink:#ecebe6; --muted:#9a9993; --line:#34342f;
    --band0:#1b1b19; --band1:#151513;
    --core:#7fb0e0; --core-bg:#1d2a37; --app:#c39be0; --app-bg:#2a2133; --virt:#a3a39c; --virt-bg:#232320;
    --derived:#7fb0e0; --contract:#eb8d55; --hl:#f0c040;
  }}
}}
:root[data-theme="dark"] {{
  --bg:#151513; --surface:#1e1e1c; --ink:#ecebe6; --muted:#9a9993; --line:#34342f;
  --band0:#1b1b19; --band1:#151513;
  --core:#7fb0e0; --core-bg:#1d2a37; --app:#c39be0; --app-bg:#2a2133; --virt:#a3a39c; --virt-bg:#232320;
  --derived:#7fb0e0; --contract:#eb8d55; --hl:#f0c040;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
main {{ max-width:1280px; margin:0 auto; padding:24px 16px 48px; }}
h1 {{ font-size:26px; margin:0 0 4px; }}
h2 {{ font-size:19px; margin:36px 0 10px; }}
p.lead {{ color:var(--muted); margin:0 0 16px; max-width:80ch; }}
.legend {{ display:flex; flex-wrap:wrap; gap:16px; font-size:13px; color:var(--muted); margin:8px 0 12px; }}
.legend span {{ display:inline-flex; align-items:center; gap:6px; }}
.sw {{ width:26px; height:0; border-top:2px solid var(--derived); }}
.sw.c {{ border-top:2px dashed var(--contract); }}
.box {{ width:14px; height:14px; border-radius:3px; border:2px solid var(--core); background:var(--core-bg); }}
.box.a {{ border-color:var(--app); background:var(--app-bg); }}
.box.v {{ border-color:var(--virt); background:var(--virt-bg); border-style:dashed; }}
.diagram {{ background:var(--surface); border:1px solid var(--line); border-radius:12px; overflow-x:auto; }}
.diagram svg {{ display:block; width:100%; min-width:900px; height:auto; }}
.band.b0 {{ fill:var(--band0); }} .band.b1 {{ fill:var(--band1); }}
.band-title {{ font-weight:600; font-size:14px; fill:var(--ink); }}
.band-sub {{ font-size:11px; fill:var(--muted); }}
.node rect {{ stroke-width:2; }}
.node.core rect {{ fill:var(--core-bg); stroke:var(--core); }}
.node.app rect {{ fill:var(--app-bg); stroke:var(--app); }}
.node.virtual rect {{ fill:var(--virt-bg); stroke:var(--virt); stroke-dasharray:5 4; }}
.node {{ cursor:pointer; outline:none; }}
.n-label {{ font-weight:700; font-size:15px; fill:var(--ink); }}
.n-tech {{ font-size:11.5px; fill:var(--muted); }}
.n-dns {{ font:11px ui-monospace, SFMono-Regular, Menlo, monospace; fill:var(--muted); }}
.edge {{ fill:none; stroke-width:1.6; opacity:.75; transition:opacity .15s; }}
.edge.derived {{ stroke:var(--derived); }}
.edge.contract {{ stroke:var(--contract); stroke-dasharray:6 4; }}
.ah.derived {{ fill:var(--derived); }} .ah.contract {{ fill:var(--contract); }}
svg.focus .edge {{ opacity:.08; }}
svg.focus .edge.on {{ opacity:1; stroke-width:2.6; }}
svg.focus .node {{ opacity:.35; }}
svg.focus .node.on {{ opacity:1; }}
.node.sel rect {{ stroke:var(--hl); stroke-width:3; }}
#detail {{ margin-top:12px; padding:12px 14px; background:var(--surface); border:1px solid var(--line); border-radius:10px; min-height:52px; }}
#detail .muted {{ color:var(--muted); }}
.table-wrap {{ overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--surface); }}
table {{ border-collapse:collapse; width:100%; font-size:13.5px; }}
th, td {{ text-align:left; vertical-align:top; padding:9px 10px; border-bottom:1px solid var(--line); }}
th {{ font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); background:var(--band0); position:sticky; top:0; }}
tr:last-child td {{ border-bottom:0; }}
tr.sel td {{ background:color-mix(in srgb, var(--hl) 14%, transparent); }}
td.small {{ font-size:12.5px; color:var(--muted); }}
code {{ font:12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }}
.muted {{ color:var(--muted); font-size:12.5px; }}
ul.patterns {{ padding-left:20px; max-width:90ch; }}
ul.patterns li {{ margin:6px 0; }}
footer {{ margin-top:32px; font-size:12px; color:var(--muted); }}
</style>
</head>
<body>
<main>
<h1>Core Platform — architecture</h1>
<p class="lead">{n_core} conteneurs plateforme (<code>core</code>) + {n_app} conteneurs par app métier (gabarit), tous sur le réseau
externe <code>core-network</code>. {n_edges} dépendances : les <b>dérivées</b> sont lues dans les fichiers compose,
les <b>contrats</b> viennent de <code>bootstrap.sh</code>, des <code>seed-and-deploy.sh</code> et du README.
Cliquez sur un service pour isoler ses flux.</p>

<div class="legend">
  <span><i class="box"></i> service plateforme</span>
  <span><i class="box a"></i> service d'app (×N apps)</span>
  <span><i class="box v"></i> hors conteneur</span>
  <span><i class="sw"></i> dérivé du compose</span>
  <span><i class="sw c"></i> contrat (scripts / README)</span>
</div>

<div class="diagram">{svg}</div>
<div id="detail"><span class="muted">Sélectionnez un service dans le schéma ou le tableau.</span></div>

<h2>Ce qui tourne dans podman</h2>
<div class="table-wrap"><table>
<thead><tr><th>Service</th><th>Conteneur / DNS</th><th>Image</th><th>Ports hôte→conteneur</th><th>Pattern</th><th>Pourquoi il est là</th><th>Dépend de</th><th>Compose</th></tr></thead>
<tbody>
{rows}
</tbody></table></div>

<h2>Patterns transverses</h2>
<ul class="patterns">
<li><b>Service discovery par DNS</b> — chaque service s'annonce en <code>&lt;service&gt;.internal</code> sur <code>core-network</code> ; aucune IP en dur.</li>
<li><b>Alias de compatibilité</b> — <code>redis.internal</code>, <code>vault.internal</code>, <code>idp.internal</code> survivent aux remplacements Redis→Valkey, Vault→OpenBao, authentik→Casdoor : les apps ne voient pas le changement.</li>
<li><b>Multi-tenant par isolation de ressource</b> — une ressource par app sur chaque brique : DB + user Postgres, bucket + clé S3, namespace Temporal, client OIDC, website Umami, clé virtuelle LLM, chemin <code>secret/&lt;app&gt;/</code>. La plateforme ne connaît aucune app par son nom.</li>
<li><b>Backing services 12-factor</b> — config par variables d'environnement, logs sur stdout, health checks <code>/health</code> + <code>/ready</code>.</li>
<li><b>Self-service</b> — chaque app se provisionne elle-même via son <code>bootstrap.sh</code> ; pas de ticket à l'équipe plateforme.</li>
<li><b>100 % open source OSI</b> — pas d'open-core : d'où Valkey, OpenBao, SeaweedFS et Casdoor plutôt que Redis, Vault, MinIO et authentik.</li>
</ul>

<h2>Toutes les dépendances</h2>
<div class="table-wrap"><table>
<thead><tr><th>De</th><th>Vers</th><th>Via</th><th>Source</th></tr></thead>
<tbody>
{edge_rows}
</tbody></table></div>

<footer>Généré par <code>docs/gen-architecture.py</code> — sortie déterministe. Entrées : {fingerprint}</footer>
</main>
<script>
(function () {{
  var svg = document.querySelector('.diagram svg');
  var detail = document.getElementById('detail');
  var info = {{}};
  document.querySelectorAll('tbody tr[data-id]').forEach(function (tr) {{
    var c = tr.children;
    info[tr.dataset.id] = {{ name: c[0].querySelector('b').textContent, pattern: c[4].textContent, why: c[5].textContent }};
  }});
  var current = null;
  function select(id) {{
    current = (current === id) ? null : id;
    svg.classList.toggle('focus', !!current);
    svg.querySelectorAll('.node').forEach(function (n) {{ n.classList.remove('on', 'sel'); }});
    svg.querySelectorAll('.edge').forEach(function (e) {{ e.classList.remove('on'); }});
    document.querySelectorAll('tbody tr[data-id]').forEach(function (r) {{ r.classList.toggle('sel', r.dataset.id === current); }});
    if (!current) {{ detail.innerHTML = '<span class="muted">Sélectionnez un service dans le schéma ou le tableau.</span>'; return; }}
    var on = {{}}; on[current] = 1;
    svg.querySelectorAll('.edge').forEach(function (e) {{
      if (e.dataset.s === current || e.dataset.d === current) {{ e.classList.add('on'); on[e.dataset.s] = 1; on[e.dataset.d] = 1; }}
    }});
    svg.querySelectorAll('.node').forEach(function (n) {{
      if (on[n.dataset.id]) n.classList.add('on');
      if (n.dataset.id === current) n.classList.add('sel');
    }});
    var i = info[current];
    var g = svg.querySelector('.node[data-id="' + current + '"]');
    if (i) {{
      detail.innerHTML = '<b></b> — <i></i><br><span></span>';
      detail.querySelector('b').textContent = i.name;
      detail.querySelector('i').textContent = i.pattern;
      detail.querySelector('span').textContent = i.why;
    }} else {{
      detail.textContent = g.querySelector('.n-label').textContent + ' — ' + g.querySelector('title').textContent;
    }}
  }}
  svg.querySelectorAll('.node').forEach(function (n) {{
    n.addEventListener('click', function () {{ select(n.dataset.id); }});
    n.addEventListener('keydown', function (ev) {{ if (ev.key === 'Enter' || ev.key === ' ') {{ ev.preventDefault(); select(n.dataset.id); }} }});
  }});
  document.querySelectorAll('tbody tr[data-id]').forEach(function (tr) {{
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', function () {{ select(tr.dataset.id); }});
  }});
}})();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    services, edges = build()
    OUT.write_text(render(services, edges))
    print(f"wrote {OUT.relative_to(ROOT)} — {len(services)} services, {len(edges)} edges")
