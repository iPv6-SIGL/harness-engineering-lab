// DeskBook's screens: one ES module, no framework, no build. Same-origin calls
// to /api/v1 (nginx proxies them), the session is an HttpOnly cookie.
const $ = (id) => document.getElementById(id);
let me = null;
let selectedRoom = null;

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function say(text, kind = "info") {
  $("message").textContent = text;
  $("message").className = kind;
}

async function render() {
  const q = new URLSearchParams({
    floor: $("floor").value,
    day: $("day").value,
    half: $("half").value,
  });
  const { ok, body } = await api(`/api/v1/resources?${q}`);
  if (!ok) return say(body?.error?.message ?? "could not load the floor", "error");
  const plan = $("plan");
  plan.replaceChildren();
  const img = await fetch(`/api/v1/floors/${$("floor").value}/plan`);
  if (img.ok) plan.style.backgroundImage = `url(${URL.createObjectURL(await img.blob())})`;
  else plan.style.backgroundImage = "none";
  for (const r of body.resources) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = r.label.split("-")[1];
    b.title = `${r.label}${r.open ? "" : " (closed)"}${r.taken ? " — taken" : ""}`;
    b.className = `${r.kind} ${r.taken ? "taken" : "free"} ${r.mine ? "mine" : ""} ${r.open ? "" : "closed"}`;
    b.style.left = `${r.x}px`;
    b.style.top = `${r.y}px`;
    b.disabled = r.taken || (!r.open && !me.roles.includes("office-manager"));
    b.addEventListener("click", () =>
      r.kind === "room" &&
      me.roles.includes("office-manager") &&
      !$("manager").hidden &&
      selectedRoom?.id !== r.id
        ? selectRoom(r)
        : book(r),
    );
    plan.append(b);
  }
}

function selectRoom(r) {
  selectedRoom = r;
  say(`${r.label} selected — book it again to reserve it, or open/close it below`);
}

async function book(r) {
  const payload = {
    resourceId: r.id,
    day: $("day").value,
    half: $("half").value,
    repeatUntil: $("weekly").checked ? $("until").value : null,
  };
  const { ok, body } = await api("/api/v1/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (ok) say(`Booked ${body.booking.label}`, "ok");
  else if (body?.error?.code === "desk-taken") {
    const alt = body.error.details.suggestions.map((s) => s.label).join(" or ");
    say(`${body.error.message}. Free nearby: ${alt || "none"}`, "error");
  } else say(body?.error?.message ?? "booking failed", "error");
  render();
}

async function boot() {
  const { ok, body } = await api("/api/v1/me");
  if (!ok) return;
  me = body.user;
  $("who").textContent = `${me.name} · ${me.roles.join(", ")}`;
  $("login").hidden = true;
  $("logout").hidden = false;
  $("app").hidden = false;
  $("manager").hidden = !me.roles.includes("office-manager");
  $("day").value = new Date().toISOString().slice(0, 10);
  for (const id of ["day", "half", "floor"]) $(id).addEventListener("change", render);
  $("logout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" });
    location.reload();
  });
  $("planfile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { ok: up, body: res } = await api(`/api/v1/floors/${$("floor").value}/plan`, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    say(
      up ? `Floor plan saved (${res.bytes} bytes)` : (res?.error?.message ?? "upload failed"),
      up ? "ok" : "error",
    );
    render();
  });
  $("toggle").addEventListener("click", async () => {
    if (!selectedRoom) return say("select a room first", "error");
    const { ok: done, body: res } = await api(`/api/v1/resources/${selectedRoom.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ open: !selectedRoom.open }),
    });
    say(
      done
        ? `${res.resource.label} is now ${res.resource.open ? "open" : "closed"}`
        : res?.error?.message,
      done ? "ok" : "error",
    );
    selectedRoom = null;
    render();
  });
  render();
}

boot();
