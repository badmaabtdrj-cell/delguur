const $ = (s) => document.querySelector(s);
const state = {
  products: [], user: null, config: null, cart: loadCart(),
  category: "Бүгд", query: "", sort: "new", view: "shop", statusFilter: "", afterLogin: null,
};

// ---------- Туслах ----------
async function api(url, { method = "GET", body } = {}) {
  // Сервер POST/PUT хүсэлтийг заавал JSON хэлбэрээр хүлээн авна
  if (method === "POST" || method === "PUT") body ??= {};
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Алдаа гарлаа.");
  return data;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const money = (n) => `${Number(n).toLocaleString("en-US")}₮`;
function pimg(p, extraClass = "") {
  const style = p.image ? `background-image:url('${p.image}')` : `background-color:${p.color}`;
  return `<div class="pimg ${extraClass}" style="${esc(style)}">${p.image ? "" : esc(p.emoji)}`;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const byId = (id) => state.products.find((p) => p.id === id);

// ---------- Сагс (хөтөч дээр хадгалагдана) ----------
function loadCart() {
  try { return new Map(JSON.parse(localStorage.getItem("cart") || "[]")); } catch { return new Map(); }
}
function saveCart() {
  try { localStorage.setItem("cart", JSON.stringify([...state.cart])); } catch {}
  $("#cartCount").textContent = [...state.cart.values()].reduce((a, b) => a + b, 0);
}
function cartLines() {
  // Зарагдахаа больсон барааг сагснаас хасна
  return [...state.cart].map(([id, qty]) => ({ p: byId(id), qty })).filter((l) => l.p && l.p.active);
}
function cartTotals() {
  const subtotal = cartLines().reduce((s, l) => s + l.p.price * l.qty, 0);
  const { deliveryFee, freeDeliveryFrom } = state.config.shop;
  const delivery = subtotal === 0 || subtotal >= freeDeliveryFrom ? 0 : deliveryFee;
  return { subtotal, delivery, total: subtotal + delivery };
}
function addToCart(id, qty) {
  const p = byId(id);
  const next = Math.min((state.cart.get(id) || 0) + qty, p.stock);
  if (next <= (state.cart.get(id) || 0)) return toast("Үлдэгдэл хүрэлцэхгүй байна.");
  state.cart.set(id, next);
  saveCart();
  toast(`"${p.name}" сагсанд нэмэгдлээ.`);
}
function setCartQty(id, qty) {
  const p = byId(id);
  if (qty <= 0) state.cart.delete(id);
  else state.cart.set(id, Math.min(qty, p.stock));
  saveCart();
  renderCart();
}

// ---------- Дээд хэсэг ----------
function renderAccount() {
  const u = state.user;
  $("#account").innerHTML = u
    ? `${u.isAdmin ? `
        <button class="btn small" data-action="add-product">+ Бараа нэмэх</button>
        <button class="btn small ghost" data-action="admin-orders">📋 Бүх захиалга</button>` : ""}
       <button class="btn small ghost" data-action="my-orders">Миний захиалга</button>
       <span class="uname">👤 ${esc(u.username)}${u.isAdmin ? "<em>админ</em>" : ""}</span>
       <button class="link" data-action="logout">Гарах</button>`
    : `<button class="btn small ghost" data-action="login">Нэвтрэх</button>
       <button class="btn small" data-action="register">Бүртгүүлэх</button>`;
}

function setView(view) {
  state.view = view;
  $("#view-shop").hidden = view !== "shop";
  $("#view-orders").hidden = view === "shop";
  if (view !== "shop") renderOrders();
  window.scrollTo(0, 0);
}

// ---------- Дэлгүүр ----------
function renderCategories() {
  const all = ["Бүгд", ...new Set(state.products.filter((p) => p.active).map((p) => p.category))];
  if (!all.includes(state.category)) state.category = "Бүгд";
  $("#categories").innerHTML = all.map((c) =>
    `<button class="chip ${c === state.category ? "active" : ""}" data-category="${esc(c)}">${esc(c)}</button>`).join("");
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  const list = state.products.filter((p) =>
    (p.active || state.user?.isAdmin) &&
    (state.category === "Бүгд" || p.category === state.category) &&
    (state.sort !== "sale" || p.old_price) &&
    (!q || p.name.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q)));
  const by = {
    new: (a, b) => b.id - a.id,
    cheap: (a, b) => a.price - b.price,
    expensive: (a, b) => b.price - a.price,
    sale: (a, b) => (b.old_price - b.price) / b.old_price - (a.old_price - a.price) / a.old_price,
  };
  return list.sort(by[state.sort]);
}

function renderGrid() {
  const list = filtered();
  $("#empty").hidden = list.length > 0;
  $("#grid").innerHTML = list.map((p) => `
    <article class="card ${p.active ? "" : "hidden-item"}" data-open="${p.id}">
      ${pimg(p)}
        ${p.old_price ? `<span class="tag sale">-${Math.round((1 - p.price / p.old_price) * 100)}%</span>`
          : p.stock === 0 ? `<span class="tag out">Дууссан</span>` : ""}
        ${p.active ? "" : `<span class="tag hid">Нуугдсан</span>`}
      </div>
      <div class="cbody">
        <small>${esc(p.category)}</small>
        <h3>${esc(p.name)}</h3>
        <div class="price">${money(p.price)}${p.old_price ? `<s>${money(p.old_price)}</s>` : ""}</div>
        <button class="btn small" data-add="${p.id}" ${p.stock && p.active ? "" : "disabled"}>
          ${p.stock ? "🛒 Сагсанд хийх" : "Дууссан"}</button>
      </div>
    </article>`).join("");
}

function renderShop() {
  renderCategories();
  renderGrid();
}

// ---------- Цонх ----------
function showModal(html) {
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal() {
  $("#modal").hidden = true;
  $("#modalBody").innerHTML = "";
  document.body.style.overflow = "";
}

function openProduct(id) {
  const p = byId(id);
  if (!p) return;
  showModal(`
    <div class="product-view">
      ${pimg(p)}</div>
      <div class="mbody">
        <small class="muted">${esc(p.category)}</small>
        <h2>${esc(p.name)}</h2>
        <div class="price">${money(p.price)}${p.old_price ? `<s>${money(p.old_price)}</s>` : ""}</div>
        <div class="stock ${p.stock ? "ok" : "out"}">${p.stock ? `✓ Бэлэн байгаа (${p.stock} ш)` : "✗ Дууссан"}</div>
        <p class="desc">${esc(p.description)}</p>
        ${p.stock && p.active ? `
          <div class="row">
            <div class="qty" id="pqty" data-max="${p.stock}">
              <button type="button" data-step="-1">−</button><span>1</span><button type="button" data-step="1">+</button>
            </div>
            <button class="btn" data-action="add-qty" data-id="${p.id}">🛒 Сагсанд хийх</button>
          </div>` : ""}
        ${state.user?.isAdmin ? `
          <div class="row">
            <button class="btn ghost small" data-action="edit-product" data-id="${p.id}">✎ Засах</button>
            <button class="btn ghost small" data-action="toggle-product" data-id="${p.id}">
              ${p.active ? "🙈 Нуух" : "👁 Дахин харуулах"}</button>
          </div>` : ""}
      </div>
    </div>`);
}

// ---------- Сагсны цонх ----------
function openCart() {
  renderCart();
  $("#cart").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeCart() {
  $("#cart").hidden = true;
  document.body.style.overflow = "";
}
function renderCart() {
  const lines = cartLines();
  $("#cartItems").innerHTML = lines.length ? lines.map(({ p, qty }) => `
    <div class="citem">
      ${pimg(p)}</div>
      <div>
        <h4>${esc(p.name)}</h4>
        <div class="qty">
          <button data-cart="${p.id}" data-qty="${qty - 1}">−</button><span>${qty}</span>
          <button data-cart="${p.id}" data-qty="${qty + 1}" ${qty >= p.stock ? "disabled" : ""}>+</button>
        </div>
      </div>
      <div><b>${money(p.price * qty)}</b><br><button class="link" data-cart="${p.id}" data-qty="0">Хасах</button></div>
    </div>`).join("") : `<p class="empty">Сагс хоосон байна.</p>`;
  const t = cartTotals();
  const { freeDeliveryFrom } = state.config.shop;
  $("#cartFoot").innerHTML = lines.length ? `
    <div class="sum"><span>Барааны дүн</span><span>${money(t.subtotal)}</span></div>
    <div class="sum"><span>Хүргэлт</span><span>${t.delivery ? money(t.delivery) : "Үнэгүй"}</span></div>
    ${t.delivery ? `<small class="muted">${money(freeDeliveryFrom - t.subtotal)}-ийн бараа нэмбэл хүргэлт үнэгүй.</small>` : ""}
    <div class="sum total"><span>Нийт</span><span>${money(t.total)}</span></div>
    <button class="btn block" data-action="checkout">Захиалах →</button>` : "";
}

// ---------- Захиалах ----------
function openCheckout() {
  if (!state.user) {
    state.afterLogin = openCheckout;
    closeCart();
    toast("Захиалга өгөхийн тулд нэвтэрнэ үү.");
    return openAuth("login");
  }
  const t = cartTotals();
  if (!t.subtotal) return toast("Сагс хоосон байна.");
  closeCart();
  const { payments } = state.config;
  showModal(`
    <form class="mbody form narrow" id="checkoutForm">
      <h2>Захиалга баталгаажуулах</h2>
      <label>Нэр *<input name="name" required maxlength="100" autocomplete="name"></label>
      <label>Утас *<input name="phone" required inputmode="tel" placeholder="99112233" autocomplete="tel"></label>
      <label>Хүргэлтийн хаяг *<textarea name="address" required placeholder="Дүүрэг, хороо, байр, орц, тоот"></textarea></label>
      <label>Нэмэлт тайлбар<input name="note" maxlength="500" placeholder="Жишээ нь: 18 цагаас хойш хүргэнэ үү"></label>
      <b>Төлбөрийн хэлбэр</b>
      ${Object.entries(payments).map(([k, v], i) =>
        `<label class="radio"><input type="radio" name="payment" value="${k}" ${i === 0 ? "checked" : ""}> ${esc(v)}</label>`).join("")}
      <div class="sum"><span>Барааны дүн</span><span>${money(t.subtotal)}</span></div>
      <div class="sum"><span>Хүргэлт</span><span>${t.delivery ? money(t.delivery) : "Үнэгүй"}</span></div>
      <div class="sum total"><span>Нийт төлөх</span><span>${money(t.total)}</span></div>
      <p class="error" hidden></p>
      <button class="btn block">Захиалга өгөх</button>
    </form>`);
}

function showOrderSuccess(o) {
  const s = state.config.shop;
  const bank = o.payment === "bank" && s.bankAccount ? `
    <div class="notice">
      Дараах дансанд <b>${money(o.total)}</b> шилжүүлнэ үү:<br>
      ${esc(s.bankName)} · <b>${esc(s.bankAccount)}</b><br>
      Хүлээн авагч: ${esc(s.bankHolder)}<br>
      Гүйлгээний утга: <b>#${o.id}</b> (захиалгын дугаар)
    </div>` : o.payment === "bank" ? `<div class="notice">Төлбөрийн мэдээллийг бид тантай утсаар холбогдож өгнө.</div>`
    : `<div class="notice">Бараагаа хүлээж авахдаа <b>${money(o.total)}</b> бэлнээр төлнө.</div>`;
  showModal(`
    <div class="mbody form narrow">
      <h2>✅ Захиалга амжилттай!</h2>
      <p>Таны захиалгын дугаар: <b>#${o.id}</b></p>
      ${bank}
      <p class="muted">Бид ${esc(o.phone)} дугаарт удахгүй холбогдоно.${s.phone ? ` Асуух зүйл байвал ${esc(s.phone)}.` : ""}</p>
      <button class="btn block" data-action="my-orders">Миний захиалга харах</button>
    </div>`);
}

// ---------- Захиалгын жагсаалт ----------
async function renderOrders() {
  const admin = state.view === "admin-orders";
  $("#ordersTitle").textContent = admin ? "Бүх захиалга" : "Миний захиалга";
  const sf = $("#statusFilter");
  sf.hidden = !admin;
  if (admin && !sf.options.length) {
    sf.innerHTML = `<option value="">Бүх төлөв</option>` +
      Object.entries(state.config.statuses).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  }
  $("#orders").innerHTML = `<p class="muted">Ачаалж байна...</p>`;
  let orders;
  try {
    orders = await api(admin ? "/api/admin/orders" : "/api/orders");
  } catch (err) {
    $("#orders").innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  const stats = $("#orderStats");
  stats.hidden = !admin;
  if (admin) {
    const active = orders.filter((o) => o.status !== "cancelled");
    const today = new Date().toISOString().slice(0, 10);
    stats.innerHTML = `
      <div class="stat">Шинэ захиалга<b>${orders.filter((o) => o.status === "new").length}</b></div>
      <div class="stat">Өнөөдөр<b>${active.filter((o) => o.created_at.startsWith(today)).length}</b></div>
      <div class="stat">Нийт борлуулалт<b>${money(active.reduce((s, o) => s + o.total, 0))}</b></div>
      <div class="stat">Дууссан бараа<b>${state.products.filter((p) => p.active && !p.stock).length}</b></div>`;
  }
  if (admin && state.statusFilter) orders = orders.filter((o) => o.status === state.statusFilter);
  $("#orders").innerHTML = orders.length ? orders.map((o) => `
    <div class="order">
      <div class="ohead">
        <h3>#${o.id} · ${money(o.total)}</h3>
        ${admin ? `<select data-status="${o.id}" ${o.status === "cancelled" ? "disabled" : ""}>
            ${Object.entries(state.config.statuses).map(([k, v]) =>
              `<option value="${k}" ${k === o.status ? "selected" : ""}>${esc(v)}</option>`).join("")}
          </select>`
        : `<span class="badge st-${o.status}">${esc(o.status_label)}</span>`}
      </div>
      <ul>${o.items.map((i) => `<li>${esc(i.name)} × ${i.qty} — ${money(i.price * i.qty)}</li>`).join("")}</ul>
      <div class="meta">
        ${esc(o.created_at.slice(0, 16))} · ${esc(o.payment_label)} · Хүргэлт: ${o.delivery_fee ? money(o.delivery_fee) : "үнэгүй"}<br>
        ${admin ? `👤 ${esc(o.username)} · ` : ""}${esc(o.name)} · 📞 ${esc(o.phone)}<br>
        📍 ${esc(o.address)}${o.note ? `<br>💬 ${esc(o.note)}` : ""}
      </div>
      ${!admin && o.status === "new" ? `<button class="link" data-action="cancel-order" data-id="${o.id}">Захиалга цуцлах</button>` : ""}
    </div>`).join("") : `<p class="empty">Захиалга алга байна.</p>`;
}

// ---------- Нэвтрэх ----------
function openAuth(mode) {
  const reg = mode === "register";
  showModal(`
    <form class="mbody form narrow" id="authForm" data-mode="${mode}">
      <h2>${reg ? "Бүртгүүлэх" : "Нэвтрэх"}</h2>
      <label>Хэрэглэгчийн нэр<input name="username" required minlength="3" maxlength="30" autocomplete="username"></label>
      <label>Нууц үг<input name="password" type="password" required ${reg ? 'minlength="8"' : ""}
        autocomplete="${reg ? "new-password" : "current-password"}"></label>
      ${reg ? `<small class="muted">Нууц үг дор хаяж 8 тэмдэгт байна.</small>` : ""}
      <p class="error" hidden></p>
      <button class="btn block">${reg ? "Бүртгүүлэх" : "Нэвтрэх"}</button>
      <p class="muted">${reg
        ? `Бүртгэлтэй юу? <button type="button" class="link" data-action="login">Нэвтрэх</button>`
        : `Бүртгэлгүй юу? <button type="button" class="link" data-action="register">Бүртгүүлэх</button>`}</p>
    </form>`);
  $("#authForm input").focus();
}

// ---------- Админ: бараа ----------
function openProductForm(p) {
  const v = (k, d = "") => esc(p?.[k] ?? d);
  const cats = [...new Set(state.products.map((x) => x.category))];
  showModal(`
    <form class="mbody form" id="productForm" data-id="${p?.id ?? ""}">
      <h2>${p ? "Бараа засах" : "Шинэ бараа нэмэх"}</h2>
      <label>Барааны нэр *<input name="name" required maxlength="150" value="${v("name")}"></label>
      <div class="cols">
        <label>Ангилал *<input name="category" required list="catList" maxlength="50" value="${v("category")}"></label>
        <label>Үнэ (₮) *<input name="price" type="number" min="0" step="1" required value="${v("price")}"></label>
        <label>Хямдралын өмнөх үнэ<input name="old_price" type="number" min="0" step="1" value="${v("old_price")}" placeholder="Хямдралгүй бол хоосон"></label>
        <label>Үлдэгдэл (ш) *<input name="stock" type="number" min="0" step="1" required value="${v("stock", 0)}"></label>
      </div>
      <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <label>Тайлбар<textarea name="description" maxlength="3000">${v("description")}</textarea></label>
      <div class="image-field">
        <div class="pimg" id="imgPreview"></div>
        <div class="image-controls">
          <b>Барааны зураг</b>
          <label class="btn ghost file-btn">📁 Зураг сонгох
            <input type="file" id="imageFile" accept="image/jpeg,image/png,image/webp" hidden></label>
          <small class="muted" id="imageStatus">JPG, PNG, WEBP. Дөрвөлжин зураг хамгийн гоё харагдана.</small>
          <input type="hidden" name="image" id="imageUrl" value="${v("image")}">
          <button type="button" class="link" id="imageClear">Зураг арилгах</button>
          <div class="cols" style="width:100%">
            <label>Зураггүй үед эможи<input name="emoji" maxlength="8" value="${v("emoji", "🛍️")}"></label>
            <label>Дэвсгэр өнгө<input name="color" type="color" value="${v("color", "#e5e7eb")}"></label>
          </div>
        </div>
      </div>
      <p class="error" hidden></p>
      <button class="btn block">${p ? "Хадгалах" : "Нэмэх"}</button>
    </form>`);
  updateImagePreview();
}

function updateImagePreview() {
  const f = $("#productForm");
  if (!f) return;
  const box = $("#imgPreview");
  const image = f.image.value;
  box.style.backgroundImage = image ? `url('${image}')` : "";
  box.style.backgroundColor = f.color.value;
  box.textContent = image ? "" : f.emoji.value;
}

// Том зургийг 1000px болгож багасгаад JPG болгоно (утасны зураг 5-10MB байдаг)
async function shrinkImage(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // тунгалаг PNG-ийн ард цагаан дэвсгэр
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

async function uploadImage(file) {
  const status = $("#imageStatus");
  const submit = $("#productForm button.btn.block");
  status.textContent = "Зураг илгээж байна...";
  submit.disabled = true;
  try {
    let blob;
    try { blob = await shrinkImage(file); } catch { throw new Error("Энэ зургийг уншиж чадсангүй. JPG эсвэл PNG сонгоно уу."); }
    const res = await fetch("/api/images", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Зураг оруулж чадсангүй.");
    $("#imageUrl").value = data.url;
    status.textContent = "✓ Зураг орлоо. Доорх товчийг дарж хадгална уу.";
    updateImagePreview();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

// ---------- Үйлдлүүд ----------
async function reloadProducts() {
  state.products = await api(state.user?.isAdmin ? "/api/products?all=1" : "/api/products");
  saveCart();
}

const actions = {
  "go-shop": () => setView("shop"),
  login: () => openAuth("login"),
  register: () => openAuth("register"),
  async logout() {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    await reloadProducts();
    renderAccount();
    setView("shop");
    renderShop();
    toast("Гарлаа.");
  },
  "open-cart": openCart,
  "close-cart": closeCart,
  checkout: openCheckout,
  "my-orders": () => { closeModal(); setView("orders"); },
  "admin-orders": () => setView("admin-orders"),
  "add-qty": (id) => {
    addToCart(id, Number($("#pqty span").textContent));
    closeModal();
  },
  "add-product": () => openProductForm(null),
  "edit-product": (id) => openProductForm(byId(id)),
  async "toggle-product"(id) {
    const p = byId(id);
    if (p.active) await api(`/api/products/${id}`, { method: "DELETE" });
    else await api(`/api/products/${id}`, { method: "PUT", body: { ...p, active: true } });
    await reloadProducts();
    renderShop();
    openProduct(id);
    toast(p.active ? "Бараа нуугдлаа." : "Бараа дахин харагдана.");
  },
  async "cancel-order"(id) {
    showModal(`<div class="mbody form narrow">
      <h2>Захиалга #${id}-г цуцлах уу?</h2>
      <div class="row">
        <button class="btn danger" data-action="confirm-cancel" data-id="${id}">Тийм, цуцлах</button>
        <button class="btn ghost" data-close>Үгүй</button>
      </div></div>`);
  },
  async "confirm-cancel"(id) {
    await api(`/api/orders/${id}/cancel`, { method: "POST" });
    closeModal();
    await reloadProducts();
    renderOrders();
    toast("Захиалга цуцлагдлаа.");
  },
};

document.addEventListener("click", async (e) => {
  try {
    const act = e.target.closest("[data-action]");
    if (act) { e.preventDefault(); e.stopPropagation(); return await actions[act.dataset.action](+act.dataset.id); }
    const add = e.target.closest("[data-add]");
    if (add) { e.stopPropagation(); return addToCart(+add.dataset.add, 1); }
    const cart = e.target.closest("[data-cart]");
    if (cart) return setCartQty(+cart.dataset.cart, +cart.dataset.qty);
    const step = e.target.closest("[data-step]");
    if (step) {
      const box = step.closest(".qty"), span = box.querySelector("span");
      span.textContent = Math.max(1, Math.min(+box.dataset.max, +span.textContent + +step.dataset.step));
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) return openProduct(+open.dataset.open);
    const chip = e.target.closest("[data-category]");
    if (chip) { state.category = chip.dataset.category; renderShop(); return; }
    if (e.target.id === "imageClear") { $("#imageUrl").value = ""; $("#imageFile").value = ""; return updateImagePreview(); }
    if (e.target.id === "logo" || e.target.closest("#logo")) { e.preventDefault(); return setView("shop"); }
    if (e.target.id === "modal" || e.target.closest("[data-close]")) closeModal();
    if (e.target.id === "cart") closeCart();
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "imageFile" && e.target.files[0]) return uploadImage(e.target.files[0]);
  if (e.target.id === "statusFilter") { state.statusFilter = e.target.value; return renderOrders(); }
  if (e.target.dataset.status) {
    try {
      await api(`/api/admin/orders/${e.target.dataset.status}`, { method: "PUT", body: { status: e.target.value } });
      toast("Төлөв өөрчлөгдлөө.");
      if (e.target.value === "cancelled") await reloadProducts();
      renderOrders();
    } catch (err) {
      toast(err.message);
      renderOrders();
    }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.form?.id === "productForm" && ["emoji", "color"].includes(e.target.name)) updateImagePreview();
});

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button.btn.block");
  btn.disabled = true;
  try {
    if (form.id === "authForm") {
      const { user } = await api(`/api/${form.dataset.mode}`, { method: "POST", body: formData(form) });
      state.user = user;
      await reloadProducts();
      closeModal();
      renderAccount();
      renderShop();
      toast(`Тавтай морил, ${user.username}!${user.isAdmin ? " Та админ эрхтэй." : ""}`);
      const next = state.afterLogin;
      state.afterLogin = null;
      if (next) next();
    } else if (form.id === "checkoutForm") {
      const items = cartLines().map(({ p, qty }) => ({ id: p.id, qty }));
      const order = await api("/api/orders", { method: "POST", body: { ...formData(form), items } });
      state.cart.clear();
      saveCart();
      await reloadProducts();
      renderShop();
      showOrderSuccess(order);
    } else if (form.id === "productForm") {
      const id = form.dataset.id;
      const p = id ? byId(+id) : null;
      const saved = await api(id ? `/api/products/${id}` : "/api/products",
        { method: id ? "PUT" : "POST", body: { ...formData(form), active: p ? !!p.active : true } });
      await reloadProducts();
      renderShop();
      openProduct(saved.id);
      toast(id ? "Хадгаллаа." : "Бараа нэмэгдлээ.");
    }
  } catch (err) {
    const box = form.querySelector(".error");
    if (box) { box.textContent = err.message; box.hidden = false; } else toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#modal").hidden) closeModal();
  else if (!$("#cart").hidden) closeCart();
});
$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  if (state.view !== "shop") setView("shop");
  renderGrid();
});
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });

(async function init() {
  try {
    const [{ user }, config] = await Promise.all([api("/api/me"), api("/api/config")]);
    state.user = user;
    state.config = config;
    await reloadProducts();
  } catch {
    return toast("Сервертэй холбогдож чадсангүй.");
  }
  const s = state.config.shop;
  document.title = s.name;
  $("#shopName").textContent = s.name;
  $("#footName").textContent = s.name;
  $("#footPhone").textContent = s.phone ? `📞 ${s.phone}` : "";
  $("#deliveryInfo").textContent = `${money(s.freeDeliveryFrom)}-өөс дээш захиалгад хүргэлт үнэгүй.`;
  renderAccount();
  renderShop();
})();
