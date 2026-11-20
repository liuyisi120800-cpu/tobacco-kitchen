(() => {
  "use strict";

  const baseProducts = window.TOBACCO_CATALOG ?? [];
  let products = baseProducts;
  let catalogRevision = 0;
  const byId = new Map();
  const pageSize = 12;
  const storageKey = "tobacco-kitchen-list-v1";
  let quantityLimit;
  const number = new Intl.NumberFormat("zh-CN");
  const collator = new Intl.Collator("zh-CN");
  const state = { region: "", brand: "", query: "", tar: "all", nicotine: "all", type: "all", sort: "default", page: 1 };

  const get = id => document.getElementById(id);
  const brands = get("brand-options");
  const regionOptions = get("region-options");
  const brandSelect = get("brand-select");
  const search = get("search");
  const sort = get("sort");
  const reset = get("reset");
  const grid = get("products");
  const pages = get("pagination");
  const detail = get("detail-dialog");
  const contact = get("contact-dialog");
  const drawer = get("list-dialog");
  const exportDialog = get("export-dialog");
  const listBody = get("list-body");
  const generate = get("generate-list");
  const download = get("download-image");
  const filters = ["tar", "nicotine", "type"];
  const toast = get("toast");

  const englishBrands = {
    "百乐": "PEEL", "铁塔猫": "RAISON", "爱喜": "ESSE", "中华": "CHUNGHWA",
    "阿里山": "ALISHAN", "万宝路": "MARLBORO", "七星": "MEVIUS SEVEN STARS",
    "黄鹤楼": "HUANGHELOU", "卡比龙": "CAPILLON", "好彩": "LUCKY STRIKE",
    "骆驼": "CAMEL", "蓝星": "GALAXY GAXALY", "宝恒": "BOHEM 宝亨", "黑杰克": "BLACK JACK",
    "米兰": "MILANO", "船长": "ARK ROYAL",
    "大卫杜夫": "DAVIDOFF", "兰州": "LANZHOU", "凤凰": "PHOENIX", "寿百年": "SOBRANIE",
    "利群": "LIQUN", "南京": "NANJING", "牡丹": "MUDAN", "芙蓉王": "FURONGWANG",
  };

  function normalized(value) {
    return String(value ?? "").normalize("NFKC").trim().toLowerCase();
  }

  function esc(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value ?? "").replace(/[&<>"']/g, char => entities[char]);
  }

  function icon(name) {
    return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  function amount(value, decimals = false) {
    return `¥${decimals ? value.toFixed(2) : number.format(value)}`;
  }

  function measured(value) {
    return Number.isFinite(value) ? `${value} mg / 支` : "未核实";
  }

  function productPrice(product) {
    return product.price == null
      ? '<span class="price missing">未标价</span>'
      : `<span class="price">${amount(product.price)} <small>/ 包</small></span>`;
  }

  function visual(product, className = "", decorative = false) {
    const photo = product.image
      ? `<img src="${esc(product.image)}" alt="${decorative ? "" : esc(`${product.name} 实拍包装`)}" loading="${className === "detail-visual" ? "eager" : "lazy"}" decoding="async">`
      : "";
    return `<div class="product-visual ${className} ${photo ? "has-photo" : ""}">
      <div class="visual-placeholder"${decorative ? ' aria-hidden="true"' : ""}>${icon("pack")}<span>实拍图待核对</span></div>${photo}
    </div>`;
  }

  document.addEventListener("error", event => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.closest(".product-visual")) image.hidden = true;
  }, true);

  function indexProducts() {
    byId.clear();
    for (const product of products) {
      byId.set(product.id, product);
      product.searchText = normalized([product.name, product.brand, englishBrands[product.brand], product.type, product.alias].filter(Boolean).join(" "));
    }
    quantityLimit = Math.floor(Number.MAX_SAFE_INTEGER /
      Math.max(1, products.reduce((sum, product) => sum + Math.max(100, Math.round((product.price ?? 0) * 100)), 0)));
  }

  indexProducts();
  const byBrand = new Map();
  let regionProducts;

  function renderCatalogFilters() {
    byBrand.clear();
    regionProducts = state.region ? products.filter(product => product.region === state.region) : products;
    for (const product of regionProducts) byBrand.set(product.brand, (byBrand.get(product.brand) ?? 0) + 1);
    if (state.brand && !byBrand.has(state.brand)) state.brand = "";
    const brandNames = [...byBrand.keys()].sort((a, b) =>
      Number(a === "品牌待核对") - Number(b === "品牌待核对") ||
      byBrand.get(b) - byBrand.get(a) || collator.compare(a, b));
    const brandOptions = [{ name: "", label: "全部品牌", count: regionProducts.length }, ...brandNames.map(name =>
      ({ name, label: name, count: byBrand.get(name) }))];
    brands.innerHTML = brandOptions.map(({ name, label, count }) =>
      `<button class="brand-option" type="button" data-brand="${esc(name)}" aria-pressed="false"><span>${esc(label)}</span><span>${count}</span></button>`
    ).join("");
    brandSelect.innerHTML = brandOptions.map(({ name, label }) =>
      `<option value="${esc(name)}">${esc(label)}</option>`).join("");
    const types = [...new Set(regionProducts.flatMap(product => (product.type || "").split(" · ").filter(Boolean)))].sort(collator.compare);
    if (state.type !== "all" && state.type !== "missing" && !types.includes(state.type)) state.type = "all";
    get("type").innerHTML = '<option value="all">不限</option>' + types.map(type =>
      `<option value="${esc(type)}">${esc(type)}</option>`).join("") + '<option value="missing">未核实</option>';
    get("type").value = state.type;
    for (const button of regionOptions.querySelectorAll("[data-region]")) {
      button.setAttribute("aria-pressed", String(button.dataset.region === state.region));
    }
  }

  function matchesAmount(value, filter, low, high) {
    if (filter === "all") return true;
    if (filter === "missing") return !Number.isFinite(value);
    if (!Number.isFinite(value)) return false;
    if (filter === "light") return value <= low;
    if (filter === "medium") return value > low && value <= high;
    return value > high;
  }

  function matchesSearch(product, tokens) {
    return tokens.every(token => {
      if (/^#\d+$/.test(token)) return product.id === Number(token.slice(1));
      return (/^\d+$/.test(token) && product.id === Number(token)) || product.searchText.includes(token);
    });
  }

  function matchesType(product) {
    if (state.type === "all") return true;
    if (state.type === "missing") return !product.type;
    return (product.type || "").split(" · ").includes(state.type);
  }

  function orderResults(a, b) {
    if (state.sort === "default" && !state.brand && !state.query) {
      return Number(Boolean(b.image)) - Number(Boolean(a.image)) || a.id - b.id;
    }
    if (state.sort === "price-asc" || state.sort === "price-desc") {
      if (a.price == null || b.price == null) return Number(a.price == null) - Number(b.price == null) || a.id - b.id;
      const direction = state.sort === "price-asc" ? 1 : -1;
      return direction * (a.price - b.price) || a.id - b.id;
    }
    return a.id - b.id;
  }

  function productCard(product) {
    const specs = [];
    if (Number.isFinite(product.tar)) specs.push(`焦油 ${product.tar} mg`);
    if (Number.isFinite(product.nicotine)) specs.push(`尼古丁 ${product.nicotine} mg`);
    return `<article class="product-card${product.outOfStock ? " is-out-of-stock" : ""}">
      <button type="button" class="product-open" data-product="${product.id}" aria-label="查看 ${esc(product.name)} 详情">
        ${visual(product)}
        <span class="product-copy">
          <span class="product-brand">${esc(product.brand)}</span><span class="product-name">${esc(product.name)}</span>
          <span class="product-spec">${esc(specs.join(" · ") || product.type || "规格待核实")}</span>
        </span>
      </button>
      <div class="product-foot">${productPrice(product)}${product.outOfStock ? '<span class="stock-status">缺货</span>' : quantityControl(product)}</div>
    </article>`;
  }

  function empty(iconName, title, text) {
    return `<div class="empty">${icon(iconName)}<h3>${title}</h3><p>${text}</p></div>`;
  }

  function pageButton(label, page, { active = false, disabled = false } = {}) {
    return `<button type="button" class="page-button" data-page="${page}"${active ? ' aria-current="page"' : ""}${disabled ? " disabled" : ""}>${label}</button>`;
  }

  function renderPagination(total) {
    if (total < 2) {
      pages.replaceChildren();
      return;
    }
    const shown = [...new Set([1, state.page - 1, state.page, state.page + 1, total])].filter(page => page > 0 && page <= total);
    const buttons = [pageButton("上一页", state.page - 1, { disabled: state.page === 1 })];
    for (const [index, page] of shown.entries()) {
      if (index > 0 && page - shown[index - 1] > 1) buttons.push('<span class="page-ellipsis" aria-hidden="true">…</span>');
      buttons.push(pageButton(page, page, { active: page === state.page }));
    }
    buttons.push(pageButton("下一页", state.page + 1, { disabled: state.page === total }));
    pages.innerHTML = buttons.join("");
  }

  function renderCatalog() {
    const tokens = normalized(state.query).split(/\s+/).filter(Boolean);
    const results = regionProducts.filter(product =>
      (!state.brand || product.brand === state.brand) &&
      matchesSearch(product, tokens) &&
      matchesAmount(product.tar, state.tar, 5, 10) &&
      matchesAmount(product.nicotine, state.nicotine, 0.5, 1) &&
      matchesType(product)
    ).sort(orderResults);

    const pageCount = Math.ceil(results.length / pageSize);
    state.page = Math.min(state.page, pageCount || 1);
    const start = (state.page - 1) * pageSize;
    const title = { domestic: "国内烟目录", international: "国外烟目录" }[state.region] ?? "香烟目录";
    const namedBrandCount = byBrand.size - Number(byBrand.has("品牌待核对"));
    get("catalog-title").textContent = state.brand ? `${state.brand} · ${title}` : title;
    get("catalog-meta").textContent = state.brand
      ? `该分类收录 ${byBrand.get(state.brand)} 款，可继续按规格筛选。`
      : `收录 ${namedBrandCount} 个已归类品牌、${regionProducts.length} 款香烟。`;
    get("result-count").innerHTML = `共 <strong>${results.length}</strong> 款${results.length ? ` · 显示 ${start + 1}–${Math.min(start + pageSize, results.length)}` : ""}`;
    grid.innerHTML = results.length
      ? results.slice(start, start + pageSize).map(productCard).join("")
      : empty("search", "没有符合条件的款式", "试试更短的关键词，或重置筛选。");

    for (const button of brands.querySelectorAll("[data-brand]")) button.setAttribute("aria-pressed", String(button.dataset.brand === state.brand));
    brandSelect.value = state.brand;
    reset.hidden = !(state.brand || state.query || state.sort !== "default" || filters.some(key => state[key] !== "all"));
    renderPagination(pageCount);
  }

  function updateCatalog(fields) {
    Object.assign(state, fields, { page: 1 });
    renderCatalog();
  }

  function revealCatalog() {
    get("catalog").scrollIntoView({ block: "start", behavior: "instant" });
  }

  brands.addEventListener("click", event => {
    const button = event.target.closest("[data-brand]");
    if (!button) return;
    // A brand choice starts a fresh name search within that brand.
    search.value = "";
    updateCatalog({ brand: button.dataset.brand, query: "" });
    revealCatalog();
  });

  brandSelect.addEventListener("change", () => {
    search.value = "";
    updateCatalog({ brand: brandSelect.value, query: "" });
  });

  search.addEventListener("input", () => updateCatalog({ query: search.value }));
  for (const key of filters) {
    const select = get(key);
    select.addEventListener("change", () => updateCatalog({ [key]: select.value }));
  }
  sort.addEventListener("change", () => updateCatalog({ sort: sort.value }));
  regionOptions.addEventListener("click", event => {
    const button = event.target.closest("[data-region]");
    if (!button || button.dataset.region === state.region) return;
    state.region = button.dataset.region;
    state.brand = "";
    renderCatalogFilters();
    updateCatalog({});
  });
  reset.addEventListener("click", () => {
    search.value = "";
    sort.value = "default";
    for (const key of filters) get(key).value = "all";
    updateCatalog({ brand: "", query: "", sort: "default", tar: "all", nicotine: "all", type: "all" });
    search.focus({ preventScroll: true });
  });
  pages.addEventListener("click", event => {
    const button = event.target.closest("[data-page]");
    if (!button || button.disabled) return;
    state.page = Number(button.dataset.page);
    renderCatalog();
    revealCatalog();
    grid.querySelector(".product-open")?.focus({ preventScroll: true });
  });

  function description(product) {
    if (product.description) return product.description;
    const standard = product.type ? `原表或包装可识别的类型为${product.type}。` : "";
    const grouping = product.brand === "品牌待核对"
      ? "品牌归属有待核对。"
      : `该款归入「${product.brand}」。`;
    const name = product.id <= 231 ? `「${product.name}」是原始价表中的第 ${product.id} 项。` : `「${product.name}」为目录收录款式。`;
    return `${name}${grouping}${standard}`;
  }

  function openDetail(product) {
    get("detail-content").innerHTML = `<article class="detail-layout">
      ${visual(product, "detail-visual")}
      <div class="detail-copy">
        <p class="detail-brand">${esc(product.brand)} · ${product.id <= 231 ? "原表" : "目录"} #${product.id}</p>
        <h2 id="detail-title">${esc(product.name)}</h2>
        <p class="detail-text">${esc(description(product))}</p>
        <dl class="specs">
          <div><dt>类型</dt><dd>${esc(product.type || "未核实")}</dd></div>
          <div><dt>焦油量</dt><dd>${measured(product.tar)}</dd></div>
          <div><dt>尼古丁量</dt><dd>${measured(product.nicotine)}</dd></div>
        </dl>
        <div class="detail-actions">${productPrice(product)}
          ${product.outOfStock ? '<span class="stock-status">缺货</span>' : `<div class="detail-quantity"><span>清单数量（包）</span>${quantityControl(product)}</div>`}
        </div>
      </div>
    </article>`;
    detail.dataset.activeProduct = product.id;
    detail.classList.toggle("is-out-of-stock", Boolean(product.outOfStock));
    if (!detail.open) detail.showModal();
  }

  grid.addEventListener("click", event => {
    const button = event.target.closest("[data-product]");
    const product = byId.get(Number(button?.dataset.product));
    if (product) openDetail(product);
  });

  function loadList() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (!Array.isArray(saved)) return new Map();
      const loaded = new Map();
      for (const row of saved) {
        if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[1]) ||
            row[1] < 1 || row[1] > quantityLimit) continue;
        const product = byId.get(row[0]);
        if (product && !product.outOfStock) loaded.set(...row.slice(0, 2));
        else if (!product && row[0] >= 1000000) pendingList.set(...row.slice(0, 2));
      }
      return loaded;
    } catch {
      return new Map();
    }
  }

  const pendingList = new Map();
  const list = loadList();

  function listSnapshot() {
    const rows = [...list].map(([id, quantity]) => ({ product: byId.get(id), quantity }));
    const snapshot = rows.reduce((snapshot, { product, quantity }) => {
      snapshot.quantity += quantity;
      if (product.price == null) snapshot.unpriced += quantity;
      else snapshot.total += Math.round(product.price * 100) * quantity;
      return snapshot;
    }, { rows, quantity: 0, unpriced: 0, total: 0 });
    snapshot.total /= 100;
    return snapshot;
  }

  function quantityControl(product) {
    const quantity = list.get(product.id) ?? 0;
    const name = esc(product.name);
    return `<div class="quantity-control" data-quantity-for="${product.id}">
      <button type="button" data-step="-1" aria-label="减少 ${name}" title="减一包"${quantity === 0 ? " disabled" : ""}>${icon("minus")}</button>
      <input type="text" inputmode="numeric" autocomplete="off" aria-label="${name} 清单数量（包）" data-quantity="${product.id}" value="${quantity}">
      <button type="button" data-step="1" aria-label="增加 ${name}" title="加一包"${quantity === quantityLimit ? " disabled" : ""}>${icon("plus")}</button>
    </div>`;
  }

  function listLine(product, quantity) {
    return product.price == null ? "未标价" : `${amount(product.price)} / 包 · 小计 ${amount(product.price * quantity)}`;
  }

  function renderList() {
    const { rows, quantity, total, unpriced } = listSnapshot();
    get("list-count").textContent = quantity;
    get("list-count").setAttribute("aria-label", `${quantity} 包`);
    get("list-summary").textContent = `${rows.length} 款 · ${quantity} 包`;
    get("list-total").textContent = amount(total, true);
    get("list-note").textContent = unpriced
      ? `有 ${unpriced} 包未标价，未计入合计。`
      : "金额按目录标示的单价计算。";
    generate.disabled = rows.length === 0;
    if (!rows.length) {
      if (!listBody.querySelector(".empty")) {
        listBody.innerHTML = empty("list", "清单还是空的", "在目录或款式详情中添加条目。");
      }
      return;
    }
    listBody.querySelector(".empty")?.remove();
    const shown = new Map();
    for (const element of listBody.querySelectorAll("[data-list-row]")) {
      const id = Number(element.dataset.listRow);
      if (list.has(id)) shown.set(id, element);
      else element.remove();
    }
    for (const { product, quantity: count } of rows) {
      const line = listLine(product, count);
      const subtotal = shown.get(product.id)?.querySelector("[data-subtotal]");
      if (subtotal) {
        if (subtotal.textContent !== line) subtotal.textContent = line;
        continue;
      }
      listBody.insertAdjacentHTML("beforeend", `<article class="list-row" data-list-row="${product.id}">
        ${visual(product, "list-thumb", true)}
        <div class="list-product"><h3>${esc(product.name)}</h3><p data-subtotal>${line}</p></div>
        <div class="list-controls">${quantityControl(product)}
          <button type="button" class="icon-button remove-button" data-remove="${product.id}" aria-label="移除 ${esc(product.name)}" title="移除">${icon("trash")}</button>
        </div>
      </article>`);
    }
  }

  function setQuantity(id, quantity, editingInput = null) {
    const product = byId.get(id);
    if (!product || (product.outOfStock && quantity > 0) || (list.get(id) ?? 0) === quantity) return;
    if (quantity > 0) list.set(id, quantity);
    else list.delete(id);
    persistList();
    renderList();
    for (const control of document.querySelectorAll(`[data-quantity-for="${id}"]`)) {
      const input = control.querySelector("[data-quantity]");
      if (input !== editingInput) {
        input.value = quantity;
        input.removeAttribute("aria-invalid");
      }
      control.querySelector('[data-step="-1"]').disabled = quantity === 0;
      control.querySelector('[data-step="1"]').disabled = quantity === quantityLimit;
    }
  }

  function persistList() {
    try { localStorage.setItem(storageKey, JSON.stringify([...list, ...pendingList])); } catch {
      // The current browsing session can still use the list without storage.
    }
  }

  async function refreshPublicUpdates() {
    if (location.protocol === "file:" || document.hidden) return;
    try {
      const response = await fetch(`data/updates.json?t=${Math.floor(Date.now() / 30000)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return;
      const update = await response.json();
      if (!Number.isSafeInteger(update.revision) || update.revision <= catalogRevision || !Array.isArray(update.products)) return;
      const merged = new Map(baseProducts.map(product => [product.id, product]));
      for (const product of update.products) {
        if (Number.isSafeInteger(product.id) && product.name && product.brand) merged.set(product.id, product);
      }
      products = [...merged.values()];
      catalogRevision = update.revision;
      indexProducts();
      for (const [id, quantity] of pendingList) {
        const product = byId.get(id);
        if (product && !product.outOfStock && quantity <= quantityLimit) list.set(id, quantity);
      }
      pendingList.clear();
      const unavailable = [...list.keys()].filter(id => !byId.has(id) || byId.get(id).outOfStock);
      if (unavailable.length) {
        for (const id of unavailable) list.delete(id);
        persistList();
        notify(`${unavailable.length} 款已缺货，已从清单移除。`, drawer.open ? drawer : detail.open ? detail : null);
      }
      renderCatalogFilters();
      renderCatalog();
      listBody.replaceChildren();
      renderList();
      if (detail.open) {
        const item = byId.get(Number(detail.dataset.activeProduct));
        if (item) openDetail(item);
      }
    } catch {
      // The published baseline remains available while the update file is unreachable.
    }
  }

  let toastTimer;
  function notify(message, dialog = null) {
    (dialog ?? document.body).append(toast);
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-step], [data-remove]");
    if (!button) return;
    const control = button.closest("[data-quantity-for]");
    const id = Number(control?.dataset.quantityFor ?? button.dataset.remove);
    const quantity = control ? (list.get(id) ?? 0) + Number(button.dataset.step) : 0;
    setQuantity(id, quantity);
    if (!button.isConnected) {
      (listBody.querySelector("[data-quantity]") ?? drawer.querySelector("[data-close]")).focus({ preventScroll: true });
    } else if (button.disabled) {
      control.querySelector("[data-quantity]").focus({ preventScroll: true });
    }
  });

  get("open-list").addEventListener("click", () => drawer.showModal());
  for (const button of document.querySelectorAll("[data-contact]")) {
    button.addEventListener("click", () => contact.showModal());
  }

  function editQuantity(input, commit = false) {
    const id = Number(input.dataset.quantity);
    const text = normalized(input.value);
    const value = Number(text);
    const valid = /^\d+$/.test(text) && Number.isSafeInteger(value) && value <= quantityLimit;
    if (valid) {
      input.removeAttribute("aria-invalid");
      // Keep a drawer row in place while its quantity is being typed.
      if (commit || value !== 0 || !listBody.contains(input)) setQuantity(id, value, input);
    }
    if (commit) {
      input.value = list.get(id) ?? 0;
      input.removeAttribute("aria-invalid");
    } else if (!valid && text) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
  }

  document.addEventListener("input", event => {
    if (event.target.matches("[data-quantity]") && !event.isComposing) editQuantity(event.target);
  });
  document.addEventListener("focusout", event => {
    if (event.target.matches("[data-quantity]")) editQuantity(event.target, true);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || !event.target.matches("[data-quantity]")) return;
    event.preventDefault();
    editQuantity(event.target, true);
    if (!event.target.isConnected) {
      (listBody.querySelector("[data-quantity]") ?? drawer.querySelector("[data-close]")).focus({ preventScroll: true });
    }
  });

  for (const dialog of [detail, drawer, exportDialog, contact]) {
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    let onBackdrop = false;
    dialog.addEventListener("pointerdown", event => {
      const rect = dialog.getBoundingClientRect();
      onBackdrop = event.target === dialog && (event.clientX < rect.left ||
        event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    });
    dialog.addEventListener("click", event => {
      if (event.target === dialog && onBackdrop) dialog.close();
      onBackdrop = false;
    });
  }

  function updateNavigation() {
    const catalog = location.hash === "#catalog";
    const navigation = document.querySelector(".header-inner nav");
    for (const link of navigation.querySelectorAll("a")) link.removeAttribute("aria-current");
    navigation.querySelector(catalog ? '[href="#catalog"]' : '[href="#home"]').setAttribute("aria-current", "page");
  }
  window.addEventListener("hashchange", updateNavigation);

  function makeImage(snapshot) {
    const columns = Math.ceil(snapshot.rows.length / 58);
    const rowsPerColumn = Math.ceil(snapshot.rows.length / columns);
    const columnWidth = 820;
    const margin = 44;
    const gap = 24;
    const headerHeight = 142;
    const tableTop = headerHeight + 28;
    const rowHeight = 54;
    const tableHead = 45;
    const footerTop = tableTop + tableHead + rowsPerColumn * rowHeight + 26;
    const canvas = document.createElement("canvas");
    canvas.width = margin * 2 + columnWidth * columns + gap * (columns - 1);
    canvas.height = footerTop + 136;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable");

    const fonts = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    const { width, height } = canvas;
    function box(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    }
    function label(value, x, y, { size = 24, weight = 400, color = "#223329", align = "left", maxWidth = 0 } = {}) {
      ctx.font = `${weight} ${size}px ${fonts}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      if (maxWidth) ctx.fillText(value, x, y, maxWidth);
      else ctx.fillText(value, x, y);
    }
    function line(x, y, w) {
      box(x, y, w, 1, "#dedfd2");
    }

    const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "long" }).format(new Date());
    box(0, 0, width, height, "#f7f6ef");
    box(0, 0, width, headerHeight, "#192f25");
    box(0, headerHeight - 4, width, 4, "#c19e68");
    label("烟草厨房 · 厨房清单", margin, 55, { size: 40, weight: 700, color: "#fff9ea" });
    label(`${date}  ·  ${snapshot.rows.length} 款  ·  ${snapshot.quantity} 包`, margin, 106, { color: "#ead5ac" });

    for (let column = 0; column < columns; column++) {
      const left = margin + column * (columnWidth + gap);
      const nameX = left + 70;
      const priceX = left + 540;
      const quantityX = left + 633;
      const subtotalX = left + columnWidth - 18;
      box(left, tableTop, columnWidth, tableHead, "#e5eadf");
      const titleStyle = { weight: 700, color: "#2e4c3d", size: 21 };
      label("序号", left + 12, tableTop + tableHead / 2, titleStyle);
      label("名称", nameX, tableTop + tableHead / 2, titleStyle);
      label("单价", priceX, tableTop + tableHead / 2, { ...titleStyle, align: "right" });
      label("包数", quantityX, tableTop + tableHead / 2, { ...titleStyle, align: "right" });
      label("小计", subtotalX, tableTop + tableHead / 2, { ...titleStyle, align: "right" });

      snapshot.rows.slice(column * rowsPerColumn, (column + 1) * rowsPerColumn).forEach(({ product, quantity }, index) => {
        const y = tableTop + tableHead + index * rowHeight;
        const baseline = y + rowHeight / 2;
        if (index % 2) box(left, y, columnWidth, rowHeight, "#f0f0e7");
        line(left, y + rowHeight, columnWidth);
        label(String(product.id), left + 12, baseline, { size: 21, color: "#5e685c" });
        label(product.name, nameX, baseline, { size: 25, weight: 600, maxWidth: 350 });
        label(product.price == null ? "未标价" : amount(product.price), priceX, baseline, { size: 22, align: "right" });
        label(String(quantity), quantityX, baseline, { size: 22, align: "right" });
        label(product.price == null ? "—" : amount(product.price * quantity, true), subtotalX, baseline, { size: 23, weight: 700, align: "right" });
      });
    }

    line(margin, footerTop, width - margin * 2);
    label("已标价合计", margin, footerTop + 37, { size: 30, weight: 700 });
    label(amount(snapshot.total, true), width - margin, footerTop + 37, { size: 36, weight: 750, align: "right" });
    const footnote = snapshot.unpriced
      ? `有 ${snapshot.unpriced} 包未标价，未计入合计。价格以目录标示为准。`
      : "价格以目录标示为准，以每包计。";
    label(footnote, margin, footerTop + 82, { size: 21, color: "#5e685c" });
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png"));
  }

  let exportUrl;
  generate.addEventListener("click", async () => {
    generate.disabled = true;
    try {
      const blob = await makeImage(listSnapshot());
      if (!drawer.open) return;
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      exportUrl = URL.createObjectURL(blob);
      get("export-image").src = exportUrl;
      download.href = exportUrl;
      const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
      download.download = `烟草厨房-清单-${date}.png`;
      exportDialog.showModal();
    } catch {
      notify("图片生成失败，请重试。", drawer.open ? drawer : null);
    } finally {
      generate.disabled = !list.size;
    }
  });
  exportDialog.addEventListener("close", () => {
    if (!exportUrl) return;
    URL.revokeObjectURL(exportUrl);
    exportUrl = null;
    get("export-image").removeAttribute("src");
    download.removeAttribute("href");
  });

  renderCatalogFilters();
  renderCatalog();
  renderList();
  updateNavigation();
  refreshPublicUpdates();
  document.addEventListener("visibilitychange", refreshPublicUpdates);
  setInterval(refreshPublicUpdates, 30000);
})();
