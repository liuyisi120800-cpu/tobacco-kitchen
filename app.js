(() => {
  "use strict";

  const products = window.TOBACCO_CATALOG ?? [];
  const byId = new Map(products.map(product => [product.id, product]));
  const pageSize = 12;
  const storageKey = "tobacco-kitchen-list-v1";
  const byBrand = new Map();
  const number = new Intl.NumberFormat("zh-CN");
  const collator = new Intl.Collator("zh-CN");
  const state = { brand: "", query: "", tar: "all", nicotine: "all", type: "all", sort: "default", page: 1 };

  const get = id => document.getElementById(id);
  const brands = get("brand-options");
  const brandSelect = get("brand-select");
  const search = get("search");
  const sort = get("sort");
  const reset = get("reset");
  const grid = get("products");
  const pages = get("pagination");
  const detail = get("detail-dialog");
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

  for (const product of products) {
    byBrand.set(product.brand, (byBrand.get(product.brand) ?? 0) + 1);
    product.searchText = normalized([product.name, product.brand, englishBrands[product.brand], product.type, product.alias].filter(Boolean).join(" "));
  }
  const brandNames = [...byBrand.keys()].sort((a, b) => {
    if (a === "品牌待核对") return 1;
    if (b === "品牌待核对") return -1;
    return byBrand.get(b) - byBrand.get(a) || collator.compare(a, b);
  });
  const brandOptions = ["", ...brandNames].map(name => ({
    name,
    label: name || "全部品牌",
    count: name ? byBrand.get(name) : products.length
  }));
  brands.innerHTML = brandOptions.map(({ name, label, count }) =>
    `<button class="brand-option" type="button" data-brand="${esc(name)}" aria-pressed="false"><span>${esc(label)}</span><span>${count}</span></button>`
  ).join("");
  brandSelect.innerHTML = brandOptions.map(({ name, label }) => `<option value="${esc(name)}">${esc(label)}</option>`).join("");

  const types = [...new Set(products.flatMap(product => (product.type || "").split(" · ").filter(Boolean)))].sort(collator.compare);
  get("type").insertAdjacentHTML("beforeend", types.map(type => `<option value="${esc(type)}">${esc(type)}</option>`).join("") + '<option value="missing">未核实</option>');
  const namedBrandCount = byBrand.size - Number(byBrand.has("品牌待核对"));

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
    return `<article class="product-card">
      <button type="button" class="product-open" data-product="${product.id}" aria-label="查看 ${esc(product.name)} 详情">
        ${visual(product)}
        <span class="product-copy">
          <span class="product-brand">${esc(product.brand)}</span><span class="product-name">${esc(product.name)}</span>
          <span class="product-spec">${esc(specs.join(" · ") || product.type || "规格待核实")}</span>
        </span>
      </button>
      <div class="product-foot">${productPrice(product)}
        <button type="button" class="icon-button add-button" data-add="${product.id}" aria-label="将 ${esc(product.name)} 加入厨房清单" title="加入厨房清单">${icon("plus")}</button>
      </div>
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
    const results = products.filter(product =>
      (!state.brand || product.brand === state.brand) &&
      matchesSearch(product, tokens) &&
      matchesAmount(product.tar, state.tar, 5, 10) &&
      matchesAmount(product.nicotine, state.nicotine, 0.5, 1) &&
      matchesType(product)
    ).sort(orderResults);

    const pageCount = Math.ceil(results.length / pageSize);
    state.page = Math.min(state.page, pageCount || 1);
    const start = (state.page - 1) * pageSize;
    get("catalog-title").textContent = state.brand ? `${state.brand} · 香烟目录` : "香烟目录";
    get("catalog-meta").textContent = state.brand
      ? `该分类收录 ${byBrand.get(state.brand)} 款，可继续按规格筛选。`
      : `收录 ${namedBrandCount} 个已归类品牌、${products.length} 款香烟。`;
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
    return `「${product.name}」是附件中的第 ${product.id} 项。${grouping}${standard}`;
  }

  function sourceLink(url, label) {
    if (!/^https?:\/\//.test(url ?? "")) return "";
    return `<a class="detail-source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function openDetail(product) {
    const sources = [
      sourceLink(product.source, "查看资料来源"),
      product.specSource !== product.source ? sourceLink(product.specSource, "查看规格来源") : ""
    ].filter(Boolean);
    get("detail-content").innerHTML = `<article class="detail-layout">
      ${visual(product, "detail-visual")}
      <div class="detail-copy">
        <p class="detail-brand">${esc(product.brand)} · 原表 #${product.id}</p>
        <h2 id="detail-title">${esc(product.name)}</h2>
        <p class="detail-text">${esc(description(product))}</p>
        <dl class="specs">
          <div><dt>类型</dt><dd>${esc(product.type || "未核实")}</dd></div>
          <div><dt>焦油量</dt><dd>${measured(product.tar)}</dd></div>
          <div><dt>尼古丁量</dt><dd>${measured(product.nicotine)}</dd></div>
        </dl>
        ${sources.length ? `<p>${sources.join(" · ")}</p>` : ""}
        <div class="detail-actions">${productPrice(product)}
          <button class="button button-green" type="button" data-add="${product.id}">${icon("plus")}加入厨房清单</button>
        </div>
      </div>
    </article>`;
    detail.showModal();
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
      return new Map(saved.filter(row => Array.isArray(row) && byId.has(row[0]) &&
        Number.isSafeInteger(row[1]) && row[1] > 0));
    } catch {
      return new Map();
    }
  }

  const list = loadList();

  function listSnapshot() {
    const rows = [...list].map(([id, quantity]) => ({ product: byId.get(id), quantity }));
    return rows.reduce((snapshot, { product, quantity }) => {
      snapshot.quantity += quantity;
      if (product.price == null) snapshot.unpriced += quantity;
      else snapshot.total += product.price * quantity;
      return snapshot;
    }, { rows, quantity: 0, unpriced: 0, total: 0 });
  }

  function controls(product, quantity) {
    const step = (name, key, label) => `<button type="button" class="icon-button ${key === "remove" ? "remove-button" : ""}" data-step="${key}" data-id="${product.id}" aria-label="${label} ${esc(product.name)}" title="${label}">${icon(name)}</button>`;
    return `<div class="list-controls">${step("minus", "decrease", "减少")}
      <span class="quantity" aria-label="${quantity} 包">${quantity}</span>
      ${step("plus", "increase", "增加")}${step("trash", "remove", "移除")}
    </div>`;
  }

  function renderList() {
    const { rows, quantity, total, unpriced } = listSnapshot();
    get("list-count").textContent = quantity;
    get("list-count").setAttribute("aria-label", `${quantity} 包`);
    get("list-summary").textContent = `${rows.length} 款 · ${quantity} 包`;
    get("list-total").textContent = amount(total, true);
    get("list-note").textContent = unpriced
      ? `有 ${unpriced} 包未标价，未计入合计。`
      : "金额按附件中的单价计算。";
    generate.disabled = rows.length === 0;
    if (!rows.length) {
      listBody.innerHTML = empty("list", "清单还是空的", "在目录或款式详情中添加条目。");
      return;
    }
    listBody.innerHTML = rows.map(({ product, quantity: count }) => `<article class="list-row">
      ${visual(product, "list-thumb", true)}
      <div><h3>${esc(product.name)}</h3><p>${product.price == null ? "未标价" : `${amount(product.price)} / 包 · 小计 ${amount(product.price * count)}`}</p></div>
      ${controls(product, count)}
    </article>`).join("");
  }

  function setQuantity(id, quantity) {
    if (quantity > 0) list.set(id, quantity);
    else list.delete(id);
    try { localStorage.setItem(storageKey, JSON.stringify([...list])); } catch {
      // The list still works for this browsing session when storage is disabled.
    }
    renderList();
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
    const button = event.target.closest("[data-add]");
    if (!button) return;
    const product = byId.get(Number(button.dataset.add));
    if (!product) return;
    const quantity = list.get(product.id) ?? 0;
    setQuantity(product.id, quantity + 1);
    notify(`已加入清单 · ${product.name}`, button.closest("dialog"));
  });

  get("open-list").addEventListener("click", () => drawer.showModal());
  listBody.addEventListener("click", event => {
    const button = event.target.closest("[data-step]");
    if (!button) return;
    const { id: value, step } = button.dataset;
    const id = Number(value);
    const before = list.get(id);
    if (!before) return;
    const after = step === "remove" ? 0 : before + (step === "increase" ? 1 : -1);
    setQuantity(id, after);
    const equivalent = listBody.querySelector(`[data-id="${id}"][data-step="${step}"]:not(:disabled)`);
    const fallback = listBody.querySelector(`[data-id="${id}"]:not(:disabled)`) ?? listBody.querySelector("button");
    (equivalent ?? fallback ?? drawer.querySelector("[data-close]")).focus({ preventScroll: true });
  });

  for (const dialog of [detail, drawer, exportDialog]) {
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
      ? `有 ${snapshot.unpriced} 包未标价，未计入合计。价格来源于 2025-04-14 版附件。`
      : "价格来源于 2025-04-14 版附件，以每包计。";
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

  renderCatalog();
  renderList();
  updateNavigation();
})();
