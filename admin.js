(() => {
  "use strict";

  const get = id => document.getElementById(id);
  const loginPanel = get("login-panel");
  const loginForm = get("login-form");
  const loginError = get("login-error");
  const adminPanel = get("admin-panel");
  const productForm = get("product-form");
  const editorMessage = get("editor-message");
  const upload = get("upload-photo");
  const preview = get("image-preview");
  const resultList = get("admin-list");
  const search = get("admin-search");
  const regionFilter = get("admin-region-filter");
  const pageSize = 25;
  const regionLabels = { domestic: "国内", international: "国外", unknown: "待核对" };
  const editableText = ["brand", "name", "region", "type", "description", "image"];
  const editableNumbers = ["price", "tar", "nicotine"];
  const items = new Map();
  let csrfToken = "";
  let authenticated = false;
  let activeProduct = null;
  let page = 1;
  let saving = false;
  let previewObject;
  let syncRequestInFlight = false;

  function field(name) {
    return productForm.elements.namedItem(name);
  }

  function showAuthentication(isAuthenticated) {
    authenticated = isAuthenticated;
    if (!isAuthenticated) csrfToken = "";
    loginPanel.hidden = isAuthenticated;
    adminPanel.hidden = !isAuthenticated;
    get("admin-header-actions").hidden = !isAuthenticated;
  }

  async function request(path, body) {
    const options = { cache: "no-store", credentials: "same-origin" };
    if (body !== undefined) {
      options.method = "POST";
      options.headers = { "Content-Type": "application/json" };
      if (csrfToken) options.headers["X-CSRF-Token"] = csrfToken;
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`/api/admin/${path}`, options);
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== "login") showAuthentication(false);
      throw new Error(data.error || "操作失败，请重试。");
    }
    return data;
  }

  function renderSync(sync) {
    if (!sync) return;
    const labels = {
      idle: "公开站点已同步。",
      pending: "已写入数据库，等待发布。",
      publishing: "正在更新公开目录。",
      published: "公开站点已同步。",
      error: "已写入数据库，发布未完成。"
    };
    const status = get("sync-status");
    const message = labels[sync.state] ?? "正在读取发布状态。";
    status.textContent = sync.state === "error" && sync.message ? `${message} ${sync.message}` : message;
    status.dataset.tone = sync.state === "error" ? "error" : "";
    get("retry-sync").hidden = sync.state !== "error";
  }

  function normalized(value) {
    return String(value ?? "").normalize("NFKC").trim().toLowerCase();
  }

  function updateCounts() {
    const products = [...items.values()];
    const brands = [...new Set(products.map(product => product.brand))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const options = brands.map(brand => {
      const option = document.createElement("option");
      option.value = brand;
      return option;
    });
    get("known-brands").replaceChildren(...options);
    get("catalog-count").textContent = `${products.length} 款 · ${brands.length} 个品牌 · ${products.filter(product => product.outOfStock).length} 款缺货`;
  }

  function resultButton(product) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-row";
    button.dataset.id = product.id;
    button.setAttribute("aria-pressed", String(activeProduct?.id === product.id));
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = product.name;
    const meta = document.createElement("small");
    meta.textContent = `${product.brand} · ${regionLabels[product.region] ?? "待核对"} · #${product.id}`;
    text.append(name, meta);
    button.append(text);
    if (product.outOfStock) {
      const stock = document.createElement("span");
      stock.className = "stock-status";
      stock.textContent = "缺货";
      button.append(stock);
    }
    return button;
  }

  function renderResults() {
    const tokens = normalized(search.value).split(/\s+/).filter(Boolean);
    const region = regionFilter.value;
    const matches = [...items.values()].filter(item => {
      const fields = normalized(`${item.brand} ${item.name} #${item.id}`);
      return (!region || (item.region || "unknown") === region) && tokens.every(token => fields.includes(token));
    }).sort((a, b) => Number(b.revision ?? 0) - Number(a.revision ?? 0) || a.id - b.id);
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    page = Math.min(page, pages);
    const rows = matches.slice((page - 1) * pageSize, page * pageSize);
    resultList.replaceChildren(...rows.map(resultButton));
    get("admin-results-count").textContent = matches.length ? `共 ${matches.length} 款` : "没有符合条件的款式";
    get("admin-page-count").textContent = `${page} / ${pages}`;
    get("previous-page").disabled = page === 1;
    get("next-page").disabled = page === pages;
  }

  function setPreview() {
    if (previewObject) {
      URL.revokeObjectURL(previewObject);
      previewObject = null;
    }
    const path = field("image").value.trim();
    let src = /^assets\/products\/[a-z0-9-]+\.(webp|png|jpe?g)$/i.test(path) ? "/" + path : "";
    if (/^https:\/\//i.test(path)) src = path;
    if (upload.files[0]) {
      previewObject = URL.createObjectURL(upload.files[0]);
      src = previewObject;
    }
    preview.hidden = !src;
    if (src) preview.src = src;
    else preview.removeAttribute("src");
  }

  function setEditorMessage(message, error = false) {
    editorMessage.textContent = message;
    editorMessage.dataset.tone = error ? "error" : "";
  }

  function openEditor(product = null, focus = false) {
    activeProduct = product;
    productForm.reset();
    get("editor-title").textContent = product ? "编辑款式" : "新增款式";
    get("editor-id").textContent = product ? `款式 #${product.id}` : "";
    if (product) {
      for (const key of [...editableText, ...editableNumbers]) field(key).value = product[key] ?? "";
      field("region").value = product.region || "unknown";
      field("outOfStock").checked = Boolean(product.outOfStock);
    }
    setEditorMessage("");
    setPreview();
    renderResults();
    if (focus) field("brand").focus();
  }

  async function loadCatalog() {
    const { products, sync } = await request("catalog");
    items.clear();
    for (const product of products) items.set(product.id, product);
    updateCounts();
    renderResults();
    renderSync(sync);
  }

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = get("login-submit");
    submit.disabled = true;
    loginError.hidden = true;
    const values = new FormData(loginForm);
    try {
      const session = await request("login", { username: values.get("username"), password: values.get("password") });
      csrfToken = session.csrfToken;
      showAuthentication(session.authenticated);
      loginForm.reset();
      await loadCatalog();
    } catch (error) {
      if (authenticated) {
        get("sync-status").textContent = error.message;
      } else {
        loginError.textContent = error.message;
        loginError.hidden = false;
        loginForm.elements.namedItem("password").value = "";
      }
    } finally {
      submit.disabled = false;
    }
  });

  get("logout").addEventListener("click", async () => {
    try {
      await request("logout", {});
      showAuthentication(false);
      items.clear();
      productForm.reset();
      activeProduct = null;
    } catch (error) {
      get("sync-status").textContent = error.message;
    }
  });

  get("new-product").addEventListener("click", () => { if (!saving) openEditor(null, true); });
  resultList.addEventListener("click", event => {
    if (saving) return;
    const id = Number(event.target.closest("[data-id]")?.dataset.id);
    if (items.has(id)) openEditor(items.get(id), true);
  });
  search.addEventListener("input", () => { page = 1; renderResults(); });
  regionFilter.addEventListener("change", () => { page = 1; renderResults(); });
  get("previous-page").addEventListener("click", () => { page--; renderResults(); });
  get("next-page").addEventListener("click", () => { page++; renderResults(); });
  upload.addEventListener("change", setPreview);
  field("image").addEventListener("change", setPreview);
  preview.addEventListener("error", () => { preview.hidden = true; });

  async function encodeUpload(file) {
    if (!file) return undefined;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) {
      throw new Error("请选择 20 MB 以内的 JPEG、PNG 或 WebP 图片。");
    }
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 850 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法处理此图片。");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", 0.82);
    } finally {
      bitmap.close();
    }
  }

  productForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const product = { id: activeProduct?.id ?? null, revision: activeProduct?.revision ?? 0 };
    for (const key of editableText) product[key] = field(key).value.trim();
    for (const key of editableNumbers) product[key] = field(key).value === "" ? null : field(key).valueAsNumber;
    product.image ||= null;
    product.outOfStock = field("outOfStock").checked;
    const image = upload.files[0];
    const controls = Array.from(productForm.elements);
    controls.forEach(control => { control.disabled = true; });
    setEditorMessage("正在保存到数据库……");
    try {
      const imageUpload = await encodeUpload(image);
      const result = await request("products", { product, imageUpload });
      items.set(result.product.id, result.product);
      updateCounts();
      openEditor(result.product);
      renderSync(result.sync);
      setEditorMessage("已写入数据库。");
    } catch (error) {
      setEditorMessage(error.message, true);
    } finally {
      saving = false;
      controls.forEach(control => { control.disabled = false; });
    }
  });

  get("retry-sync").addEventListener("click", async () => {
    const retry = get("retry-sync");
    retry.disabled = true;
    try {
      const response = await request("sync", {});
      renderSync(response.sync ?? response);
    } catch (error) {
      get("sync-status").textContent = error.message;
    } finally {
      retry.disabled = false;
    }
  });

  async function checkSync() {
    if (!authenticated || document.hidden || syncRequestInFlight) return;
    syncRequestInFlight = true;
    try {
      const response = await request("sync");
      renderSync(response.sync ?? response);
    } catch (error) {
      if (authenticated) get("sync-status").textContent = error.message;
    } finally {
      syncRequestInFlight = false;
    }
  }

  async function initialize() {
    try {
      const session = await request("session");
      csrfToken = session.csrfToken ?? "";
      showAuthentication(session.authenticated);
      if (authenticated) await loadCatalog();
    } catch (error) {
      const message = authenticated ? get("sync-status") : loginError;
      message.textContent = error.message;
      message.hidden = false;
    }
  }

  initialize();
  setInterval(checkSync, 4000);
})();
