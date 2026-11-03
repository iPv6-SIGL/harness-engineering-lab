// PhotoShelf's screens: one ES module, no framework, no build. Same-origin calls
// to /api/v1 (nginx proxies them); the session is an HttpOnly cookie. The images
// themselves load from the public bucket (decision D3), never through the API.
const $ = (id) => document.getElementById(id);
let me = null;

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function say(text, kind = "info") {
  $("message").textContent = text;
  $("message").className = kind;
}

const sku = () => $("sku").value.trim();

function card(photo, actions) {
  const li = document.createElement("li");
  const small = photo.sizes.find((s) => s.width === 320);
  if (small) {
    const img = document.createElement("img");
    img.src = small.url;
    img.alt = photo.name ?? `photo ${photo.id}`;
    img.loading = "lazy";
    li.append(img);
  } else {
    const p = document.createElement("p");
    p.className = "pending";
    p.textContent = photo.onShop === false ? "off the shop" : "resizing…";
    li.append(p);
  }
  const caption = document.createElement("small");
  caption.textContent = `#${photo.id} · ${photo.sizes.map((s) => s.width).join(" / ") || "—"} px`;
  li.append(caption);
  if (actions) li.append(actions);
  return li;
}

async function render() {
  if (!sku()) return;
  const shop = await api(`/api/v1/shop/${encodeURIComponent(sku())}/photos`);
  $("shop").replaceChildren(...(shop.body?.photos ?? []).map((p) => card(p)));
  if (!me) return;
  const all = await api(`/api/v1/photos?sku=${encodeURIComponent(sku())}`);
  if (!all.ok) return say(all.body?.error?.message ?? "could not load the photos", "error");
  $("all").hidden = false;
  const manager = me.roles.includes("catalog-manager");
  $("photos").replaceChildren(
    ...all.body.photos.map((p) => {
      if (!manager) return card(p);
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = p.onShop ? "Take off the shop" : "Put back";
      b.addEventListener("click", async () => {
        const r = await api(`/api/v1/photos/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ onShop: !p.onShop }),
        });
        say(
          r.ok
            ? p.onShop
              ? "taken off the shop"
              : "back on the shop, resizing"
            : r.body?.error?.message,
          r.ok ? "info" : "error",
        );
        render();
      });
      return card(p, b);
    }),
  );
}

async function watch(batchId) {
  $("progress").hidden = false;
  for (;;) {
    const r = await api(`/api/v1/batches/${batchId}`);
    if (!r.ok) return say(r.body?.error?.message ?? "lost the batch", "error");
    $("progress").max = r.body.batch.total;
    $("progress").value = r.body.batch.done;
    say(`${r.body.batch.done} / ${r.body.batch.total} resized`);
    if (r.body.batch.finished) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  $("progress").hidden = true;
  render();
}

$("find").addEventListener("submit", (e) => {
  e.preventDefault();
  render();
});

$("send").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sku()) return say("type the product SKU first", "error");
  const form = new FormData();
  form.append("sku", sku());
  for (const f of $("files").files) form.append("photos", f);
  say("uploading…");
  const r = await api("/api/v1/batches", { method: "POST", body: form });
  if (!r.ok) return say(r.body?.error?.message ?? "upload refused", "error");
  $("send").reset();
  watch(r.body.batch.id);
});

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
  $("upload").hidden = false;
}
