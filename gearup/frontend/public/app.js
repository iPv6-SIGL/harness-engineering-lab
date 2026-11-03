// GearUp's screens: one ES module, no framework, no build. Same-origin calls to
// /api/v1 (nginx proxies them); the session is an HttpOnly cookie.
const $ = (id) => document.getElementById(id);
let me = null;

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

const post = (path, data) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

function say(text, kind = "info") {
  $("message").textContent = text;
  $("message").className = kind;
}

/** The open requests first, then the 8 most recent: what a person acts on, not the whole history. */
const recent = (requests) => [
  ...requests.filter((r) => r.status === "waiting" || r.status === "approved"),
  ...requests.filter((r) => r.status !== "waiting" && r.status !== "approved").slice(0, 8),
];

const eur = (cents) => `${(cents / 100).toLocaleString("en", { minimumFractionDigits: 2 })} EUR`;
const day = (iso) => new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });

function row(text, ...controls) {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.textContent = text;
  li.append(span, ...controls);
  return li;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function badge(r) {
  const s = document.createElement("span");
  s.className = `badge ${r.status}${r.reminderDue ? " due" : ""}`;
  s.textContent = r.reminderDue ? "reminder: answer before tomorrow" : r.status;
  return s;
}

async function render() {
  const cat = await api("/api/v1/catalog");
  if (!cat.ok) return say(cat.body?.error?.message ?? "could not load the catalog", "error");
  $("budget").textContent = `Team budget left: ${eur(cat.body.budget.remainingCents)}`;
  $("catalog").replaceChildren(
    ...cat.body.items.map((i) =>
      row(
        `${i.name} — ${eur(i.priceCents)}`,
        button("Ask", async () => {
          const r = await post("/api/v1/requests", { itemSku: i.sku });
          say(
            r.ok ? `asked: ${i.name}, your manager has 3 days` : r.body?.error?.message,
            r.ok ? "info" : "error",
          );
          render();
        }),
      ),
    ),
  );
  const mine = await api("/api/v1/requests");
  $("mine").replaceChildren(
    ...recent(mine.body.requests).map((r) =>
      row(`${r.item.name} — asked ${day(r.createdAt)}, expires ${day(r.expiresAt)}`, badge(r)),
    ),
  );
  if (!me.roles.includes("manager")) return;
  $("manager").hidden = false;
  const team = await api("/api/v1/requests?scope=team");
  $("team").replaceChildren(
    ...recent(team.body.requests).map((r) => {
      const controls = [badge(r)];
      if (r.status === "waiting") {
        const decide = (approve) => async () => {
          const res = await post(`/api/v1/requests/${r.id}/decision`, { approve });
          say(
            res.ok ? (approve ? "approved: ordering" : "rejected") : res.body?.error?.message,
            res.ok ? "info" : "error",
          );
          render();
        };
        controls.push(button("Approve", decide(true)), button("Reject", decide(false)));
      }
      return row(`${r.requester}: ${r.item.name} — ${eur(r.priceCents)}`, ...controls);
    }),
  );
}

$("logout").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  location.reload();
});

const who = await api("/api/v1/me");
if (who.ok) {
  me = who.body.user;
  $("who").textContent = `${me.name} (${me.roles.join(", ")})`;
  $("login").hidden = true;
  $("logout").hidden = false;
  $("app").hidden = false;
  render();
  setInterval(render, 5000); // statuses move on their own: ordered, cancelled, reminded
}
