/* fnmusic-ext WebUI — 原生 JS，无框架无外部资产。 */
"use strict";

// 飞牛桌面用 HTTPS 打开管理窗，页面必须挂在同源路径 /app/fnmusic-ext 下。
// WebUI 自己也会剥掉这个前缀。管理接口只认飞牛网关注入的管理员头。
const APP_BASE = "/app/fnmusic-ext";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const PROVIDER_LABEL = { musicdl: "musicdl 聚合音源", musicbox: "网易云音乐盒子", neteasefree: "网易云·免扫码", lxmusic: "洛雪自定义源", none: "未配置" };
// 分类歌单默认分类（与后端 proxy/recommend.py DEFAULT_CATEGORIES 保持一致）
const DEFAULT_CATEGORIES = "华语,流行,摇滚,民谣,电子,古风,说唱,轻音乐,爵士";
// 内置大模型默认（Kilo AI Gateway，免配置；与后端 proxy/recommend.py KILO_* 一致）
const LLM_BUILTIN = { provider: "kilo", base: "", key: "", model: "kilo-auto/free" };
const PROC_LABEL = { musicdl: "musicdl", musicbox: "musicbox", neteasefree: "neteasefree", lxmusic: "lxmusic", webui: "WebUI" };

let configValues = {};   // GET /api/config 的 values
let platforms = { enabled: [], registered: [] };
let dirty = false;
let qrTimer = null;
let lxVerifiedUrl = null; // 已通过测试的 lx URL（保存时免二次校验提示用）

async function api(path, options) {
  const resp = await fetch(APP_BASE + path, options);
  let body = {};
  try { body = await resp.json(); } catch (_) { /* 非 JSON */ }
  if (!resp.ok) throw new Error(body.error || body.detail || `HTTP ${resp.status}`);
  return body;
}

function toast(message, kind) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast " + (kind || "");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3800);
}

function markDirty(note) {
  dirty = true;
  const bar = $("#save-bar");
  if (bar) bar.classList.add("show");
  const noteEl = $("#save-note");
  if (noteEl) noteEl.textContent = note || "有未保存的修改";
}

function clearDirty() {
  dirty = false;
  const bar = $("#save-bar");
  if (bar) bar.classList.remove("show");
  const noteEl = $("#save-note");
  if (noteEl) noteEl.textContent = "";
}

/* -------------------------------------------------------------- 导航 */
function switchPage(page) {
  $$(".page").forEach((el) => el.classList.toggle("active", el.id === "page-" + page));
  $$("[data-page]").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
}
$$("[data-page]").forEach((btn) => btn.addEventListener("click", () => switchPage(btn.dataset.page)));

/* -------------------------------------------------------------- 概览 */
async function loadStatus() {
  try {
    const st = await api("/api/status");
    $("#brand-version").textContent = `v${st.version}`;
    $("#sidebar-foot").textContent = `${PROVIDER_LABEL[st.current_provider] || st.current_provider}`;
    $("#ov-provider-body").innerHTML =
      `<span class="state-line"><span class="dot ok"></span>${PROVIDER_LABEL[st.current_provider] || st.current_provider}</span>`;
    $("#ov-processes").innerHTML = Object.entries(st.processes).map(([name, p]) => {
      const ok = p.state === "RUNNING";
      const cls = ok ? "ok" : p.state === "FATAL" ? "err" : "";
      return `<span class="chip"><span class="dot ${cls}"></span>${PROC_LABEL[name] || name} · ${p.state}</span>`;
    }).join("");
    $("#ov-services").innerHTML = Object.entries(st.services).map(([name, s]) => {
      if (!s.reachable && s.note) return `<span class="state-line"><span class="dot"></span>${PROC_LABEL[name]}：${s.note}</span>`;
      return `<span class="state-line"><span class="dot ${s.reachable ? "ok" : "err"}"></span>${PROC_LABEL[name]}：${s.reachable ? "正常" : "不可达"}</span>`;
    }).join("");
    const lxCard = $("#ov-lx-card");
    if (st.current_provider === "lxmusic" && st.lx_source) {
      lxCard.hidden = false;
      const s = st.lx_source.source;
      const rows = [];
      rows.push(`<div class="kv"><b>状态</b>${st.lx_source.initialized ? "已加载" : "未加载"}</div>`);
      if (s) {
        rows.push(`<div class="kv"><b>源名称</b>${s.name || "-"} ${s.version ? "v" + s.version : ""}</div>`);
        rows.push(`<div class="kv"><b>平台</b>${Object.keys(s.platforms || {}).join("、") || "-"}</div>`);
        rows.push(`<div class="kv"><b>运行</b>${s.running ? "是" : "否"}</div>`);
      }
      if (st.lx_source.last_error) rows.push(`<div class="kv"><b>错误</b>${st.lx_source.last_error}</div>`);
      $("#ov-lx").innerHTML = rows.join("");
    } else {
      lxCard.hidden = true;
    }
  } catch (exc) {
    $("#ov-provider-body").textContent = "状态加载失败：" + exc.message;
  }
}

/* -------------------------------------------------------------- 配置读写 */
async function loadConfig() {
  const cfg = await api("/api/config");
  configValues = cfg.values;
  applyConfigToForm();
  await loadCharts();
  clearDirty();
}

function applyConfigToForm() {
  const v = configValues;
  const provider = v.FNMUSIC_NETEASE_ENABLED === "true" ? "musicbox"
    : v.FNMUSIC_NETEASEFREE_ENABLED === "true" ? "neteasefree"
    : v.FNMUSIC_MUSICDL_ENABLED === "true" ? "musicdl"
    : v.FNMUSIC_LX_ENABLED === "true" ? "lxmusic" : "";
  $$("input[name=provider]").forEach((el) => { el.checked = el.value === provider; });
  syncProviderPanels(provider);
  if (provider === "musicbox") syncNeteaseAccount();
  if (provider === "neteasefree") syncNeteaseFreeState();
  const quality = v.FNMUSIC_QUALITY_MODE || "high";
  $$("input[name=quality]").forEach((el) => { el.checked = el.value === quality; });
  $("#recommend-daily").checked = v.FNMUSIC_RECOMMEND_DAILY === "true";
  const categories = v.FNMUSIC_RECOMMEND_CATEGORIES || "";
  $("#recommend-categories-enabled").checked = categories.trim() !== "";
  $("#recommend-categories").value = categories;
  $("#recommend-category-size").value = v.FNMUSIC_RECOMMEND_CATEGORY_SIZE || "200";
  $("#recommend-size").value = v.FNMUSIC_RECOMMEND_SIZE || "200";
  syncCategoriesPanel();
  $("#tee-enabled").checked = v.FNMUSIC_TEE_SAVE_ENABLED === "true";
  $("#auto-cover").checked = v.FNMUSIC_AUTO_COVER !== "false";
  $("#lyric-auto-dl").checked = v.FNMUSIC_LYRIC_AUTO_DL === "true";
  $("#fav-autobind").checked = v.FNMUSIC_FAV_AUTO_BIND === "true";
  $("#tee-dir").value = v.FNMUSIC_TEE_SAVE_DIR || "";
  $("#tee-max").value = v.FNMUSIC_TEE_CACHE_MAX || "2";
  $("#bind-timeout").value = v.FNMUSIC_OFFICIAL_BIND_TIMEOUT_S || "120";
  $("#handoff-max").value = v.FNMUSIC_TEE_HANDOFF_MAX != null ? v.FNMUSIC_TEE_HANDOFF_MAX : "3";
  $("#scan-path").value = v.FNMUSIC_LIBRARY_SCAN_PATH || "";
  updateTeeCountLabel();
  updateBindTimeoutLabel();
  $("#llm-provider").value = v.FNMUSIC_LLM_PROVIDER || "kilo";
  $("#llm-base").value = v.FNMUSIC_LLM_BASE_URL || "";
  $("#llm-key").value = v.FNMUSIC_LLM_API_KEY || "";
  $("#llm-model").value = v.FNMUSIC_LLM_MODEL || "";
  updateLlmFields();
  $("#search-timeout").value = v.FNMUSIC_SEARCH_TIMEOUT || "15";
  $("#search-probe").checked = v.FNMUSIC_SEARCH_PROBE === "true";
  $("#netease-my-playlists").checked = v.FNMUSIC_NETEASE_MY_PLAYLISTS === "true";
  $("#lx-url").value = v.LX_SOURCE_URL || "";
  lxVerifiedUrl = v.LX_SOURCE_URL || null;
  renderPlatformChips();
}

function collectConfig() {
  const provider = ($$("input[name=provider]").find((el) => el.checked) || {}).value || "";
  const values = {
    FNMUSIC_MUSICDL_ENABLED: provider === "musicdl",
    FNMUSIC_NETEASE_ENABLED: provider === "musicbox",
    FNMUSIC_NETEASEFREE_ENABLED: provider === "neteasefree",
    FNMUSIC_LX_ENABLED: provider === "lxmusic",
    FNMUSIC_QUALITY_MODE: ($$("input[name=quality]").find((el) => el.checked) || {}).value || "high",
    FNMUSIC_RECOMMEND_DAILY: $("#recommend-daily").checked,
    FNMUSIC_RECOMMEND_CATEGORIES: $("#recommend-categories-enabled").checked
      ? ($("#recommend-categories").value.trim() || DEFAULT_CATEGORIES)
      : "",
    FNMUSIC_RECOMMEND_CATEGORY_SIZE: parseInt($("#recommend-category-size").value || "200", 10) || 200,
    FNMUSIC_RECOMMEND_SIZE: parseInt($("#recommend-size").value || "200", 10) || 200,
    FNMUSIC_TEE_SAVE_ENABLED: $("#tee-enabled").checked,
    FNMUSIC_AUTO_COVER: $("#auto-cover").checked,
    FNMUSIC_LYRIC_AUTO_DL: $("#lyric-auto-dl").checked,
    FNMUSIC_FAV_AUTO_BIND: $("#fav-autobind").checked,
    FNMUSIC_TEE_SAVE_DIR: $("#tee-dir").value.trim(),
    FNMUSIC_TEE_CACHE_MAX: parseInt($("#tee-max").value || "2", 10),
    FNMUSIC_OFFICIAL_BIND_TIMEOUT_S: parseInt($("#bind-timeout").value || "120", 10) || 120,
    FNMUSIC_TEE_HANDOFF_MAX: parseInt($("#handoff-max").value || "3", 10) || 0,
    FNMUSIC_LIBRARY_SCAN_PATH: $("#scan-path").value.trim(),
    FNMUSIC_LLM_PROVIDER: $("#llm-provider").value,
    FNMUSIC_LLM_BASE_URL: $("#llm-base").value.trim(),
    FNMUSIC_LLM_API_KEY: $("#llm-key").value.trim(),
    FNMUSIC_LLM_MODEL: $("#llm-model").value.trim(),
    FNMUSIC_SEARCH_TIMEOUT: parseInt($("#search-timeout").value || "15", 10) || 15,
    FNMUSIC_SEARCH_PROBE: $("#search-probe").checked,
    FNMUSIC_NETEASE_MY_PLAYLISTS: $("#netease-my-playlists").checked,
  };
  const chartInputs = $$("#kg-charts-grid input, #wy-charts-grid input");
  if ($("#charts-master-switch") && chartInputs.length > 0) {
    values.FNMUSIC_RECOMMEND_CHARTS = $("#charts-master-switch").checked;
    const checkedInputs = chartInputs.filter((el) => el.checked);
    if (checkedInputs.length === chartInputs.length) {
      values.FNMUSIC_ENABLED_CHARTS = ""; // 全部启用 = 空白名单
    } else if (checkedInputs.length === 0) {
      values.FNMUSIC_ENABLED_CHARTS = "none"; // 全部关闭（哨兵值，不匹配任何榜单 id）
    } else {
      values.FNMUSIC_ENABLED_CHARTS = checkedInputs
        .map((el) => el.closest(".chart-item").dataset.id)
        .join(",");
    }
  }
  if (provider === "musicdl") {
    values.FNMUSIC_ONLINE_SOURCES = platforms.enabled.join(",");
    values.MUSICDL_SOURCES = platforms.enabled.join(",");
  }
  if (provider === "lxmusic") {
    const url = $("#lx-url").value.trim();
    if (!url) throw new Error("洛雪源需要填写脚本 URL");
    values.LX_SOURCE_URL = url;
  }
  return values;
}

async function saveConfig() {
  let values;
  try { values = collectConfig(); } catch (exc) { toast(exc.message, "fail"); return; }
  const btn = $("#save-btn");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const result = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    const failed = (result.actions || []).filter((a) => !a.ok);
    const parts = [];
    if (result.changed && result.changed.length) parts.push(`已保存 ${result.changed.length} 项`);
    (result.actions || []).forEach((a) => {
      if (a.kind === "process") parts.push(`进程 ${a.program} ${a.op} ${a.ok ? "成功" : "失败"}`);
      if (a.kind === "lx_activate") parts.push(`洛雪源激活${a.ok ? "成功" : "失败"}`);
    });
    if (failed.length) {
      toast((parts.join("；") || "") + ` —— ${failed.map((f) => f.error).join("；")}`, "fail");
    } else {
      toast(parts.join("；") || "配置无变化", "ok");
    }
    clearDirty();
    await loadConfig();
    await loadStatus();
  } catch (exc) {
    toast("保存失败：" + exc.message, "fail");
  } finally {
    btn.disabled = false;
    btn.textContent = "保存并生效";
  }
}
$("#save-btn").addEventListener("click", saveConfig);

/* -------------------------------------------------------------- 音源选择 */
function savedProvider() {
  const v = configValues;
  return v.FNMUSIC_NETEASE_ENABLED === "true" ? "musicbox"
    : v.FNMUSIC_NETEASEFREE_ENABLED === "true" ? "neteasefree"
    : v.FNMUSIC_MUSICDL_ENABLED === "true" ? "musicdl"
    : v.FNMUSIC_LX_ENABLED === "true" ? "lxmusic" : "";
}

// 点选未启用的音源：临时拉起其进程供预览（不写配置；5 分钟内未保存自动停止）
async function startPreview(provider) {
  try {
    const r = await api("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    if (r.preview) toast(`已临时启动 ${PROVIDER_LABEL[provider]}（预览）：5 分钟内未保存将自动停止`);
    return true;
  } catch (exc) {
    toast(`临时启动 ${PROVIDER_LABEL[provider]} 失败：${exc.message}`, "fail");
    return false;
  }
}

function syncProviderPanels(provider) {
  $$(".provider-card").forEach((el) => el.classList.toggle("selected", el.dataset.provider === provider));
  $("#panel-musicbox").hidden = provider !== "musicbox";
  $("#panel-neteasefree").hidden = provider !== "neteasefree";
  $("#panel-musicdl").hidden = provider !== "musicdl";
  $("#panel-lxmusic").hidden = provider !== "lxmusic";
}
$$("input[name=provider]").forEach((el) =>
  el.addEventListener("change", async () => {
    syncProviderPanels(el.value);
    if (el.value === "musicbox") syncNeteaseAccount();
    if (el.value === "neteasefree") syncNeteaseFreeState();
    markDirty("音源切换需保存后生效");
    if (el.value && el.value !== savedProvider() && await startPreview(el.value)) {
      if (el.value === "musicdl") await loadPlatforms(false);
      if (el.value === "neteasefree") syncNeteaseFreeState();
    }
  }));

/* -------------------------------------------------------------- musicdl 平台 */
function setPlatformFallback() {
  platforms = { enabled: (configValues.FNMUSIC_ONLINE_SOURCES || "").split(",").filter(Boolean), registered: [] };
  $("#platform-note").textContent = "musicdl 进程未运行，暂无法获取平台列表（点选 musicdl 音源可临时启动预览）";
  renderPlatformChips();
}

async function fetchPlatforms() {
  const data = await api("/api/platforms");
  platforms = { enabled: data.enabled || [], registered: data.registered || [] };
  $("#platform-note").textContent = `共 ${platforms.registered.length} 个注册平台，已启用 ${platforms.enabled.length} 个`;
  renderPlatformChips();
}

async function loadPlatforms(autoPreview = true) {
  try {
    await fetchPlatforms();
  } catch (_) {
    // 进程未运行：autoPreview（用户点选/刷新触发）时临时拉起后重试；页面加载不自动拉起
    if (!autoPreview) { setPlatformFallback(); return; }
    try {
      if (await startPreview("musicdl")) await fetchPlatforms();
      else setPlatformFallback();
    } catch (_) {
      setPlatformFallback();
    }
  }
}

function renderPlatformChips() {
  const keyword = $("#platform-search").value.trim().toLowerCase();
  const container = $("#platform-list");
  const enabledSet = new Set(platforms.enabled);
  const items = platforms.registered.filter((p) => !keyword || p.toLowerCase().includes(keyword));
  container.innerHTML = items.length
    ? items.map((p) => `<span class="chip ${enabledSet.has(p) ? "on" : ""}" data-platform="${p}">${p}</span>`).join("")
    : `<span class="muted">无匹配平台</span>`;
  container.querySelectorAll(".chip[data-platform]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const p = chip.dataset.platform;
      const set = new Set(platforms.enabled);
      if (set.has(p)) { set.delete(p); chip.classList.remove("on"); }
      else { set.add(p); chip.classList.add("on"); }
      platforms.enabled = Array.from(set);
      markDirty("musicdl 平台已修改");
    }));
}
$("#platform-search").addEventListener("input", renderPlatformChips);
$("#platform-reload").addEventListener("click", loadPlatforms);

/* -------------------------------------------------------------- 网易扫码 */
async function syncNeteaseAccount(retries = 0) {
  // 把网易账号态同步到 #qr-check（已登录显示昵称；未登录/失败清空）
  for (let i = 0; ; i++) {
    try {
      const st = await api("/api/netease/auth/status");
      const d = st.data || st;
      if (d.logged_in) {
        $("#qr-check").textContent = `当前登录：${d.nickname || d.user_id || "已登录用户"}`;
        return;
      }
    } catch (_) { /* status 不可达视为未登录 */ }
    if (i >= retries) { $("#qr-check").textContent = ""; return; }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// 网易云·免扫码：只读展示后端服务端登录态（无用户扫码）
async function syncNeteaseFreeState() {
  const box = $("#neteasefree-state");
  if (!box) return;
  box.innerHTML = `<span class="state-line"><span class="dot"></span>读取中…</span>`;
  try {
    const st = await api("/api/neteasefree/status");
    const d = st.data || {};
    const ok = Boolean(d.logged_in);
    let html = `<span class="state-line"><span class="dot ${ok ? "ok" : "err"}"></span>后端登录态：${ok ? "可用（服务端账号）" : "不可用"}</span>`;
    if (d.nickname) html += `<span class="state-line"><span class="dot"></span>账号：${d.nickname}</span>`;
    if (d.api_base) html += `<span class="state-line"><span class="dot"></span>后端地址：${d.api_base}</span>`;
    box.innerHTML = html;
  } catch (exc) {
    box.innerHTML = `<span class="state-line"><span class="dot err"></span>后端不可达：${exc.message}</span>`;
  }
}

async function startQrLogin() {
  stopQrPolling();
  $("#qr-status").textContent = "正在生成二维码…";
  $("#qr-img").hidden = true;
  syncNeteaseAccount(); // 生成前同步当前账号态（非致命，不阻塞出码）
  const callLogin = () => api("/api/netease/auth/login", { method: "POST" });
  try {
    let data;
    try {
      data = await callLogin();
    } catch (exc) {
      // musicbox 进程未运行（未点选/预览过期）：临时拉起后重试一次
      if (!await startPreview("musicbox")) throw exc;
      data = await callLogin();
    }
    const unikey = data.unikey || data.codekey || (data.data && (data.data.unikey || data.data.codekey)) || "";
    if (!unikey) throw new Error("未获取到 unikey");
    $("#qr-img").src = `${APP_BASE}/api/netease/qr?unikey=${encodeURIComponent(unikey)}`;
    $("#qr-img").hidden = false;
    $("#qr-status").textContent = "请用手机网易云音乐 App 扫码";
    pollQr(unikey);
  } catch (exc) {
    $("#qr-status").textContent = "生成失败：" + exc.message;
  }
}

async function checkQrStatus(unikey) {
  const st = await api(`/api/netease/auth/login/check?unikey=${encodeURIComponent(unikey)}`);
  // musicbox CLI 返回 {ok, data:{code}} 信封结构；兼容扁平 {code}
  const code = st?.data?.code ?? st?.code;
  if (code === 803) {
    stopQrPolling();
    $("#qr-status").textContent = "登录成功 ✓";
    syncNeteaseAccount(2); // 803 后 cookie 落盘需要一点时间，带重试取昵称
    toast("网易账号登录成功", "ok");
  } else if (code === 802) {
    $("#qr-status").textContent = "已扫码，请在手机上确认";
  } else if (code === 800) {
    stopQrPolling();
    $("#qr-status").textContent = "二维码已过期，请重新生成";
  } else {
    $("#qr-status").textContent = "等待扫码…";
  }
}

function pollQr(unikey, intervalMs = 2000) {
  stopQrPolling();
  qrTimer = setInterval(() => { checkQrStatus(unikey).catch(() => {}); }, intervalMs);
}

function stopQrPolling() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
}
$("#qr-btn").addEventListener("click", startQrLogin);

/* -------------------------------------------------------------- lx 源测试 */
$("#lx-test").addEventListener("click", async () => {
  const url = $("#lx-url").value.trim();
  const box = $("#lx-report");
  if (!url) { toast("请先填写源 URL", "fail"); return; }
  box.hidden = false;
  box.className = "report";
  box.textContent = "测试中（下载脚本 → 沙箱初始化 → 多首抽样搜索/解析/探活）…";
  const callVerify = () => api("/api/lx/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: { url } }),
  });
  try {
    let r;
    try {
      r = await callVerify();
    } catch (exc) {
      // lxmusic 进程未运行（未点选/预览过期）：临时拉起后重试一次
      if (!await startPreview("lxmusic")) throw exc;
      r = await callVerify();
    }
    if (r.ok) {
      const d = r.data || {};
      const meta = d.meta || {};
      const probe = d.probe || {};
      lxVerifiedUrl = url;
      box.className = "report ok";
      box.innerHTML =
        `<div class="kv"><b>源名称</b>${meta.name || "-"} ${meta.version ? "v" + meta.version : ""}（${meta.author || "未知作者"}）</div>` +
        `<div class="kv"><b>可用平台</b>${(d.platforms || []).join("、")}</div>` +
        (probe.title ? `<div class="kv"><b>实测</b>${probe.title} - ${probe.artist} [${probe.platform}/${probe.quality}] ${probe.content_type || ""}</div>` : "") +
        `<div class="kv"><b>结论</b>可用 ✓（保存后激活）</div>`;
    } else {
      const d = r.data || {};
      box.className = "report fail";
      box.innerHTML = `<div class="kv"><b>不可用</b>${d.message || r.error || "校验失败"}</div>`;
    }
  } catch (exc) {
    box.className = "report fail";
    box.textContent = "测试失败：" + exc.message;
  }
});

/* -------------------------------------------------- lx 源：文件上传 / NAS 选择 */
async function lxUploadScript(filename, script) {
  // 先确保 lxmusic 进程可用（预览拉起），再转发落盘
  const callUpload = () => api("/api/lx/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, script }),
  });
  try {
    return await callUpload();
  } catch (exc) {
    if (!await startPreview("lxmusic")) throw exc;
    return await callUpload();
  }
}

async function lxAfterUpload(r) {
  const d = r.data || {};
  $("#lx-url").value = d.url || "";
  lxVerifiedUrl = null; // 上传地址仍需走一次"测试"
  $("#lx-upload-note").textContent = d.meta && d.meta.name ? `已上传：${d.meta.name}` : "已上传";
  markDirty("洛雪源已更新为上传脚本，测试后保存生效");
  toast("脚本已上传，请点「测试」验证后保存", "ok");
}

$("#lx-upload").addEventListener("click", () => $("#lx-file").click());
$("#lx-file").addEventListener("change", async () => {
  const file = $("#lx-file").files && $("#lx-file").files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".js")) { toast("只支持 .js 后缀文件", "fail"); return; }
  if (file.size > 9_000_000) { toast("脚本超过 9MB 上限", "fail"); return; }
  $("#lx-upload-note").textContent = "读取并上传中…";
  try {
    const script = await file.text();
    const r = await lxUploadScript(file.name, script);
    await lxAfterUpload(r);
  } catch (exc) {
    $("#lx-upload-note").textContent = "";
    toast("上传失败：" + exc.message, "fail");
  } finally {
    $("#lx-file").value = ""; // 允许重复选择同一文件
  }
});

/* NAS 文件选择：仅桌面环境（统一网关 /app/fnmusic-ext 内）可用。
   选中的主机路径经 /api/host-file 代读（webui_gateway 本地处理），再走上传落盘。 */
let lxTrimSdk = null;
async function lxLoadTrimSdk() {
  if (lxTrimSdk !== null) return lxTrimSdk;
  try {
    const mod = await import("/app/fnmusic-ext/static/vendor/trim-web-app.js");
    lxTrimSdk = new mod.TrimApp();
  } catch (_) {
    lxTrimSdk = false;
  }
  return lxTrimSdk;
}

async function lxPickFromNas() {
  const sdk = await lxLoadTrimSdk();
  if (!sdk) { toast("当前环境不支持 NAS 文件选择（直连 8774 时请用上传或 URL）", "fail"); return; }
  try {
    const result = await sdk.pickUserFile({
      directory: false,
      accept: [".js"],
      title: "选择洛雪源脚本",
      okText: "选择",
      sidebarGroup: ["myFiles", "otherShare", "favorites"],
    });
    const paths = (result && result.data) || [];
    if (!paths.length) return;
    const hostPath = paths[0];
    $("#lx-upload-note").textContent = "读取 NAS 文件中…";
    const resp = await fetch(APP_BASE + "/api/host-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: hostPath }),
    });
    let body = {};
    try { body = await resp.json(); } catch (_) { /* 非 JSON */ }
    if (!resp.ok) throw new Error(body.error || body.detail || `HTTP ${resp.status}`);
    const filename = hostPath.split("/").pop() || "source.js";
    const r = await lxUploadScript(filename, body.script || "");
    await lxAfterUpload(r);
  } catch (exc) {
    $("#lx-upload-note").textContent = "";
    toast("NAS 选择失败：" + exc.message, "fail");
  }
}
$("#lx-pick").addEventListener("click", lxPickFromNas);

(async function detectNasPicker() {
  // 桌面网关路径下才尝试加载 SDK；探测失败（直连 8774）保持隐藏
  const pathname = (typeof window !== "undefined" && window.location && window.location.pathname) || "";
  if (pathname.startsWith("/app/")) {
    const sdk = await lxLoadTrimSdk();
    if (sdk) $("#lx-pick").hidden = false;
  }
})();

/* -------------------------------------------------------------- 表单脏标记 */
["#tee-dir", "#tee-max", "#llm-base", "#llm-key", "#llm-model", "#lx-url", "#search-timeout", "#bind-timeout", "#handoff-max", "#scan-path"].forEach((sel) =>
  $(sel).addEventListener("input", () => markDirty()));
$$("input[name=quality]").forEach((el) => el.addEventListener("change", () => markDirty("音质偏好需保存后生效")));
["#recommend-daily", "#search-probe", "#tee-enabled", "#fav-autobind", "#auto-cover", "#lyric-auto-dl", "#netease-my-playlists"].forEach((sel) =>
  $(sel).addEventListener("change", () => markDirty()));
["#recommend-categories", "#recommend-category-size"].forEach((sel) =>
  $(sel).addEventListener("input", () => markDirty()));
$("#recommend-categories-enabled").addEventListener("change", () => { syncCategoriesPanel(); markDirty(); });

function syncCategoriesPanel() {
  // 取消勾选即关闭分类歌单：输入框置灰但仍保留内容，便于再次开启
  const on = $("#recommend-categories-enabled").checked;
  $("#recommend-categories").disabled = !on;
  $("#recommend-category-size").disabled = !on;
}

function updateTeeCountLabel() {
  const n = $("#tee-max").value || configValues.FNMUSIC_TEE_CACHE_MAX || "2";
  $("#tee-count-label").textContent = `（缓存数 ${n} 首）`;
}
$("#tee-max").addEventListener("input", updateTeeCountLabel);

function updateBindTimeoutLabel() {
  const n = $("#bind-timeout").value || configValues.FNMUSIC_OFFICIAL_BIND_TIMEOUT_S || "120";
  $("#bind-timeout-label").textContent = `（${n} 秒）`;
}
$("#bind-timeout").addEventListener("input", updateBindTimeoutLabel);

window.addEventListener("beforeunload", (ev) => {
  if (dirty) ev.preventDefault();
});

/* -------------------------------------------------------------- 榜单管理 */
let chartsData = { charts_enabled: true, kg: [], wy: [], total: 0 };
// 榜单封面加载失败时的本地占位图（内联 SVG，无外部资产、无网络请求）
const CHART_FALLBACK_COVER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">' +
    '<rect width="120" height="120" fill="#e3e8ee"/>' +
    '<text x="60" y="72" font-size="40" text-anchor="middle" fill="#68788a">♪</text></svg>'
  );

async function loadCharts() {
  try {
    chartsData = await api("/api/charts");
  } catch (exc) {
    console.warn("加载榜单列表失败:", exc);
    // 接口不可达时至少让总开关跟随已保存配置，避免整页报错
    chartsData = {
      charts_enabled: configValues.FNMUSIC_RECOMMEND_CHARTS !== "false",
      kg: [], wy: [], total: 0,
    };
  }
  renderCharts();
}

function renderChartGrid(items) {
  if (!items.length) return `<span class="muted">暂无榜单数据</span>`;
  return items.map((c) => `
    <label class="chart-item ${c.enabled ? "on" : ""}" data-id="${c.id}">
      <img src="${c.cover || CHART_FALLBACK_COVER}" alt="${c.name}" loading="lazy">
      <span class="chart-name">${c.name}</span>
      <input type="checkbox" ${c.enabled ? "checked" : ""}>
    </label>`).join("");
}

function renderCharts() {
  const kgGrid = $("#kg-charts-grid");
  const wyGrid = $("#wy-charts-grid");
  const masterSwitch = $("#charts-master-switch");
  if (!kgGrid || !wyGrid || !masterSwitch) return;
  masterSwitch.checked = chartsData.charts_enabled !== false;
  $("#kg-charts-count").textContent = (chartsData.kg || []).length;
  $("#wy-charts-count").textContent = (chartsData.wy || []).length;
  kgGrid.innerHTML = renderChartGrid(chartsData.kg || []);
  wyGrid.innerHTML = renderChartGrid(chartsData.wy || []);
  // 封面兜底 + 勾选联动（label 包裹 checkbox，点整卡即切换）
  [kgGrid, wyGrid].forEach((grid) => {
    grid.querySelectorAll("img").forEach((img) =>
      img.addEventListener("error", () => {
        if (img.dataset.fallback) return;
        img.dataset.fallback = "1";
        img.src = CHART_FALLBACK_COVER;
      }));
    grid.querySelectorAll("input").forEach((input) =>
      input.addEventListener("change", () => {
        const item = input.closest(".chart-item");
        if (item) item.classList.toggle("on", input.checked);
        updateChartSelection();
        markDirty("榜单勾选已修改");
      }));
  });
  updateChartSelection();
}

function updateChartSelection() {
  const inputs = $$("#kg-charts-grid input, #wy-charts-grid input");
  const selected = inputs.filter((el) => el.checked).length;
  const counter = $("#charts-selected-count");
  if (counter) counter.textContent = `已选 ${selected} / ${inputs.length}`;
}

function setChartInputs(selector, checked, note) {
  $$(selector).forEach((el) => {
    el.checked = checked;
    const item = el.closest(".chart-item");
    if (item) item.classList.toggle("on", checked);
  });
  updateChartSelection();
  markDirty(note);
}

$("#charts-master-switch").addEventListener("change", () => markDirty("排行榜歌单总开关已修改"));
$("#btn-charts-select-all").addEventListener("click", () =>
  setChartInputs("#kg-charts-grid input, #wy-charts-grid input", true, "榜单已全部启用"));
$("#btn-charts-deselect-all").addEventListener("click", () =>
  setChartInputs("#kg-charts-grid input, #wy-charts-grid input", false, "榜单已全部关闭"));
$("#btn-charts-select-kg").addEventListener("click", () =>
  setChartInputs("#kg-charts-grid input", true, "已全选酷狗榜单"));
$("#btn-charts-select-wy").addEventListener("click", () =>
  setChartInputs("#wy-charts-grid input", true, "已全选网易云榜单"));

/* -------------------------------------------------------------- 大模型 */
// 切换接入方时灰化不适用的输入项：内置 Kilo 免配置、自定义需 Base URL + Key
function updateLlmFields() {
  const provider = $("#llm-provider").value;
  const custom = provider === "custom";
  const off = provider === "none";
  $("#llm-base").disabled = !custom;
  $("#llm-key").disabled = !custom;
  $("#llm-model").disabled = off;
  $("#btn-llm-reset").disabled = provider === "kilo";
}

$("#llm-provider").addEventListener("change", () => {
  updateLlmFields();
  markDirty("大模型接入方已修改");
});
$("#btn-llm-reset").addEventListener("click", () => {
  $("#llm-provider").value = LLM_BUILTIN.provider;
  $("#llm-base").value = LLM_BUILTIN.base;
  $("#llm-key").value = LLM_BUILTIN.key;
  $("#llm-model").value = LLM_BUILTIN.model;
  updateLlmFields();
  markDirty("大模型已恢复内置 Kilo 默认");
});

/* -------------------------------------------------------------- 启动 */
(async function boot() {
  await loadConfig();
  await loadStatus();
  await loadPlatforms(false);  // 页面加载不自动拉起预览进程，等用户点选音源
  setInterval(loadStatus, 15000);
})();
