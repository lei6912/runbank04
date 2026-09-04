// ── Firebase ──────────────────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, set, update, remove, onValue
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyA6gHbHb4Gp0y5bmDOp_JJVhuxPQARWpJM",
  authDomain: "runbank03.firebaseapp.com",
  databaseURL: "https://runbank03-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "runbank03",
  storageBucket: "runbank03.firebasestorage.app",
  messagingSenderId: "973280333324",
  appId: "1:973280333324:web:0426d89a943f5732a26829"
};
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ── 設定 ──────────────────────────────────────────────────────────────
const REP_PATH = "event04/reports";            // 里程回報
const SET_PATH = "event04/settings/straights"; // 順子分配設定
const DAYS = ["9/5", "9/6"];
const STRAIGHT_LEN = 5;
const MAX_GROUPS   = 6;

const ALL_MEMBERS = [
  "佳宜*雞蛋花", "志隆", "臣賢", "鄭伯", "鄭宏洋",
  "高聖智", "阿耀（＾∇＾）", "陳弘明", "雷皇正", "蔡若瑋"
];

// 安排表（v12）：每人每天一個目標 K
const PLAN = [
  { group: "A", day: "9/5", cards: [["志隆", 3], ["雷皇正", 4], ["臣賢", 5], ["鄭伯", 6], ["蔡若瑋", 7]] },
  { group: "B", day: "9/5", cards: [["陳弘明", 4], ["佳宜*雞蛋花", 5], ["鄭宏洋", 6], ["阿耀（＾∇＾）", 7], ["高聖智", 8]] },
  { group: "C", day: "9/6", cards: [["臣賢", 5], ["志隆", 6], ["鄭伯", 7], ["雷皇正", 8], ["高聖智", 9]] },
  { group: "D", day: "9/6", cards: [["阿耀（＾∇＾）", 6], ["陳弘明", 7], ["鄭宏洋", 8], ["蔡若瑋", 9], ["佳宜*雞蛋花", 10]] },
];
// 查表：planOf(name, day) → { k, group }
const PLAN_MAP = {};
PLAN.forEach(g => g.cards.forEach(([name, k]) => { PLAN_MAP[name + "|" + g.day] = { k, group: g.group }; }));
const planOf = (name, day) => PLAN_MAP[name + "|" + day];

// ── State ─────────────────────────────────────────────────────────────
let reports    = [];
let settings   = { mode: "auto", assignments: {} };
let currentTab = "plan";
let reportDay  = "";
let editing    = null;
let isSubmitting = false;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── 規則 ──────────────────────────────────────────────────────────────
// 5421 跑銀進位：小數 > 0.11 進位
function roundK(km) {
  const whole = Math.floor(km);
  const dec   = parseFloat((km - whole).toFixed(10));
  return dec > 0.11 ? whole + 1 : whole;
}
function pointsFor(n) { return n === 0 ? 0 : 2 + (n - 1); }

// 卡片：{ id, name, day, k, raw }
function cardsFromReports() {
  return reports.map(r => ({ id: r.id, name: r.name, day: r.day, k: r.k, raw: r.actualKm }));
}

// 自動湊順子：由最小 K 起貪婪；同一起始值只允許一組（相同順子不重複計分）
function computeStraights(cards) {
  const pool = cards.filter(c => c.k >= 1).sort((a, b) => a.k - b.k);
  const straights = [];
  while (pool.length) {
    const first = pool[0];
    const v = first.k;
    const picks = [first];
    let ok = true;
    for (let w = v + 1; w < v + STRAIGHT_LEN; w++) {
      const c = pool.find(x => x.k === w);
      if (!c) { ok = false; break; }
      picks.push(c);
    }
    if (ok) {
      straights.push(picks);
      picks.forEach(p => pool.splice(pool.indexOf(p), 1));
    }
    // 不論成功與否，其餘同值 v 的卡都不可能再當起點 → 移除
    for (let i = pool.length - 1; i >= 0; i--) if (pool[i].k === v) pool.splice(i, 1);
  }
  const usedIds = new Set(straights.flat().map(c => c.id));
  return { straights, unused: cards.filter(c => !usedIds.has(c.id)) };
}

// 手動分組：檢查每組是否為 5 張連號，且起始值不與前面有效組重複
function manualStraights(cards) {
  const groups = {}, unused = [];
  cards.forEach(c => {
    const g = settings.assignments?.[c.id];
    if (g) (groups[g] = groups[g] || []).push(c); else unused.push(c);
  });
  const seenStart = new Set();
  const list = Object.keys(groups).map(Number).sort((a, b) => a - b).map(g => {
    const cs = groups[g].sort((a, b) => a.k - b.k);
    const ks = cs.map(c => c.k);
    const consecutive = cs.length === STRAIGHT_LEN && ks[0] >= 1 && ks.every((k, i) => i === 0 || k === ks[i - 1] + 1);
    const dup = consecutive && seenStart.has(ks[0]);
    if (consecutive && !dup) seenStart.add(ks[0]);
    return { group: g, cards: cs, valid: consecutive && !dup, dup };
  });
  return { groups: list, unused };
}

// 差一張就能再湊一組（且起始值尚未使用）的提示
function nearMisses(unused, usedStarts) {
  const have = new Set(unused.filter(c => c.k >= 1).map(c => c.k));
  if (!have.size) return [];
  const maxK = Math.max(...have);
  const out = new Set();
  for (let v = 1; v <= maxK; v++) {
    if (usedStarts.has(v)) continue;
    const missing = [];
    for (let w = v; w < v + STRAIGHT_LEN; w++) if (!have.has(w)) missing.push(w);
    if (missing.length === 1) out.add(missing[0]);
  }
  return [...out].sort((a, b) => a - b);
}

// ── Firebase 監聽 ─────────────────────────────────────────────────────
function startListeners() {
  render();

  onValue(ref(db, ".info/connected"), snap => {
    if (snap.val() === true) console.log("✅ 已連上 Realtime Database:", firebaseConfig.databaseURL);
    else showToast("⚠️ 尚未連上資料庫，請確認 databaseURL");
  });

  const toList = snap => Object.entries(snap.val() || {})
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  onValue(ref(db, REP_PATH),
    snap => { reports = toList(snap); render(); },
    err  => { console.error(err); showToast("⚠️ Firebase 連線失敗，請確認 Realtime Database 規則"); }
  );
  onValue(ref(db, SET_PATH),
    snap => { settings = { mode: "auto", assignments: {}, ...(snap.val() || {}) }; if (!settings.assignments) settings.assignments = {}; render(); },
    err  => console.error(err)
  );
}

function setBtn(id, loading, label) {
  const b = $(id); if (!b) return;
  b.disabled = loading;
  b.textContent = loading ? "送出中..." : label;
}

// ── Render ────────────────────────────────────────────────────────────
function render() {
  renderProgress();
  renderReportForm();
  renderMemberList();
}

function pcardHTML(c, i, extraClass = "") {
  const color = i % 2 === 0 ? "" : "p";
  const dayCls = c.day === "9/6" ? "d2" : "";
  const title = c.raw != null ? `${c.name} ${c.day} ${c.raw}K → ${c.k}K` : `${c.name} ${c.day} 目標 ${c.k}K`;
  return `
    <div class="pcard ${color} ${extraClass}" title="${esc(title)}">
      <span class="corner">${c.k}</span>
      <span class="k">${c.k}K</span>
      <span class="who">${esc(c.name)}</span>
      <span class="day ${dayCls}">${esc(c.day)}</span>
      <span class="corner br">${c.k}</span>
    </div>`;
}

function renderProgress() {
  const isReport = currentTab === "report";
  const manual   = isReport && settings.mode === "manual";
  const area = $("straightsArea"), pool = $("poolArea"), hint = $("hintBox");
  hint.style.display = "none";

  $("modeRow").style.display = isReport ? "flex" : "none";
  $("modeAuto").classList.toggle("active", settings.mode !== "manual");
  $("modeManual").classList.toggle("active", settings.mode === "manual");
  $("progressSublabel").textContent = isReport ? "實際湊出" : "安排表目標";

  let count = 0;

  if (!isReport) {
    // 安排表：直接顯示 A~D 四組
    const seen = new Set();
    area.innerHTML = PLAN.map((g, gi) => {
      const cards = g.cards.map(([name, k]) => ({ id: name + "|" + g.day, name, day: g.day, k }));
      const start = cards[0].k, dup = seen.has(start); if (!dup) seen.add(start);
      if (!dup) count++;
      return `
        <div class="straight ${dup ? "dup" : ""}" style="animation-delay:${gi * 80}ms">
          <div class="straight-head">
            <span class="tag">${g.group}組 · ${g.day}</span>
            <span class="range">${cards[0].k}K → ${cards[4].k}K　<span class="grp">共 ${cards.reduce((s, c) => s + c.k, 0)}K</span></span>
          </div>
          <div class="hand">${cards.map((c, i) => pcardHTML(c, i)).join("")}</div>
        </div>`;
    }).join("");
    pool.innerHTML = "";
  } else {
    const cards = cardsFromReports();
    if (!cards.length) {
      area.innerHTML = `<p class="empty-state">還沒有人回報里程 🏃<br>跑完就來抽第一張 K 卡！</p>`;
      pool.innerHTML = "";
    } else if (manual) {
      const { groups, unused } = manualStraights(cards);
      count = groups.filter(g => g.valid).length;
      area.innerHTML = groups.map(g => `
        <div class="straight ${g.valid ? "" : g.dup ? "dup" : "invalid"}">
          <div class="straight-head">
            <span class="tag">${g.valid ? "✔ 順子" : g.dup ? "⚠ 重複不計分" : "✖ 未成立"} #${g.group}</span>
            <span class="range">${g.cards.map(c => c.k + "K").join(" · ")}</span>
          </div>
          <div class="hand">${g.cards.map((c, i) => pcardHTML(c, i)).join("")}</div>
        </div>`).join("") || `<p class="empty-state">請在下方為每張 K 卡指定組別</p>`;

      const all = [...cards].sort((a, b) => a.k - b.k);
      pool.innerHTML = `
        <div class="pool-title"><span>✋ 手動分配（每張卡只能用在一組）</span><span>${unused.length} 張未使用</span></div>
        <div class="assign-list">
          ${all.map((c, i) => `
            <div class="assign-row">
              <div class="mini ${i % 2 ? "p" : ""}">${c.k}K</div>
              <div class="info">
                <div class="nm">${esc(c.name)}</div>
                <div class="sub">${esc(c.day)} · ${c.raw}K</div>
              </div>
              <select data-assign="${c.id}">
                <option value="">— 不用</option>
                ${Array.from({ length: MAX_GROUPS }, (_, k) => k + 1).map(g =>
                  `<option value="${g}" ${settings.assignments?.[c.id] == g ? "selected" : ""}>第 ${g} 組</option>`).join("")}
              </select>
            </div>`).join("")}
        </div>`;
    } else {
      const { straights, unused } = computeStraights(cards);
      count = straights.length;
      area.innerHTML = straights.map((s, gi) => `
        <div class="straight" style="animation-delay:${gi * 80}ms">
          <div class="straight-head">
            <span class="tag">✔ 順子 #${gi + 1}</span>
            <span class="range">${s[0].k}K → ${s[4].k}K</span>
          </div>
          <div class="hand">${s.map((c, i) => pcardHTML(c, i)).join("")}</div>
        </div>`).join("") || `<p class="empty-state">還沒湊成順子，繼續集卡 💪</p>`;

      pool.innerHTML = unused.length ? `
        <div class="pool-title"><span>🃏 手上還有的卡</span><span>${unused.length} 張</span></div>
        <div class="pool">${[...unused].sort((a, b) => a.k - b.k).map((c, i) => pcardHTML(c, i)).join("")}</div>` : "";

      const miss = nearMisses(unused, new Set(straights.map(s => s[0].k)));
      if (miss.length) {
        hint.style.display = "block";
        hint.innerHTML = `💡 只差一張！再來一張 ${miss.map(k => `<b>${k}K</b>`).join(" 或 ")} 就能再多湊一組不同連號的順子。`;
      }
    }
  }

  $("straightCount").textContent = count;
  $("pointCount").textContent    = pointsFor(count);
}

function renderReportForm() {
  const repKey = new Set(reports.map(r => r.name + "|" + r.day));
  const sel = $("reportName");
  const prev = sel.value;
  sel.innerHTML = '<option value="">請選取組員...</option>' +
    ALL_MEMBERS.map(n => {
      const done = DAYS.filter(d => repKey.has(n + "|" + d));
      const tag = done.length === 2 ? "　✔ 兩天都已回報" : done.length === 1 ? `　✔ ${done[0]} 已回報` : "";
      return `<option value="${esc(n)}">${esc(n)}${tag}</option>`;
    }).join("");
  if (ALL_MEMBERS.includes(prev)) sel.value = prev;
  const pending = ALL_MEMBERS.length * 2 - reports.length;
  $("reportSlotsLeft").textContent = `剩 ${Math.max(pending, 0)} 筆未回報`;
  updateDayPills();
}

function updateDayPills() {
  const name = $("reportName").value;
  document.querySelectorAll("#reportDayPills .day-pill").forEach(p => {
    const taken = name && reports.some(r => r.name === name && r.day === p.dataset.day);
    p.disabled = !!taken;
    if (taken && reportDay === p.dataset.day) reportDay = "";
    p.classList.toggle("active", reportDay === p.dataset.day);
  });
  const hint = $("planHint");
  if (name && reportDay) {
    const plan = planOf(name, reportDay);
    hint.innerHTML = plan ? `📋 安排表：${esc(name)} ${reportDay} 目標 <b>${plan.k}K</b>（${plan.group}組）` : `📋 安排表沒有排這天，跑了也可以回報`;
  } else if (name) {
    hint.innerHTML = DAYS.map(d => { const p = planOf(name, d); return p ? `${d} 目標 <b>${p.k}K</b>` : ""; }).filter(Boolean).join("　·　");
  } else hint.innerHTML = "　";
}

function renderMemberList() {
  const list = $("membersList");
  const repMap = new Map(reports.map(r => [r.name + "|" + r.day, r]));

  list.innerHTML = ALL_MEMBERS.map(name => {
    const doneDays = DAYS.filter(d => repMap.has(name + "|" + d)).length;
    const rows = DAYS.map(d => {
      const plan = planOf(name, d), rep = repMap.get(name + "|" + d);
      const dayCls = d === "9/6" ? "d2" : "";
      const target = plan ? `目標 <b>${plan.k}K</b> · ${plan.group}組` : `未排`;
      const actual = rep
        ? `<div class="actual">${rep.k}K <small>(${rep.actualKm}K)</small></div>
           <div class="member-actions">
             <button class="icon-btn" data-action="edit" data-id="${rep.id}">✏️</button>
             <button class="icon-btn" data-action="del" data-id="${rep.id}">🗑️</button>
           </div>`
        : `<div class="actual none">未回報</div>`;
      return `<div class="day-row"><span class="chip ${dayCls}">${d}</span><div class="target">${target}</div>${actual}</div>`;
    }).join("");
    const status = doneDays === 0 ? `<span class="member-status">尚未完成</span>`
                 : `<span class="member-status ok">✔ 已完成 ${doneDays} 天</span>`;
    return `
      <div class="member-card">
        <div class="member-head"><div class="member-name">${esc(name)}</div>${status}</div>
        ${rows}
      </div>`;
  }).join("");
}

// ── 送出里程 ──────────────────────────────────────────────────────────
async function submitReport() {
  if (isSubmitting) return;
  const name = $("reportName").value;
  const km   = parseFloat($("reportKm").value);
  if (!name) return showToast("請選取組員");
  if (!reportDay) return showToast("請選擇跑步日期");
  if (!km || km <= 0) return showToast("請輸入有效里程");
  if (reports.some(r => r.name === name && r.day === reportDay)) return showToast("這天已經回報過囉，請用下方 ✏️ 修改");

  const k = roundK(km), day = reportDay;
  isSubmitting = true;
  setBtn("submitReport", true);
  try {
    await push(ref(db, REP_PATH), { name, day, actualKm: km, k, createdAt: Date.now() });
    $("reportKm").value = ""; $("reportName").value = ""; reportDay = "";
    $("reportPreview").textContent = "　";
    updateDayPills();
    showToast(`🃏 ${name} ${day} 抽到 ${k}K 卡！`);
  } catch (e) {
    console.error(e); showToast("送出失敗：" + (e?.code || e?.message || e));
  } finally {
    isSubmitting = false;
    setBtn("submitReport", false, "確認送出里程");
  }
}

// ── 編輯 / 刪除 ───────────────────────────────────────────────────────
function openEdit(id) {
  const src = reports.find(r => r.id === id);
  if (!src) return;
  editing = { id };
  $("editTitle").textContent = "編輯實際里程";
  $("editLabel").textContent = "實際完成里程 (K)";
  $("editName").textContent  = `${src.name} · ${src.day}`;
  $("editKm").value = src.actualKm;
  updatePreview("editKm", "editPreview");
  $("editModal").style.display = "flex";
}
function closeModal() { $("editModal").style.display = "none"; editing = null; }

async function saveEdit() {
  if (!editing) return;
  const km = parseFloat($("editKm").value);
  if (!km || km <= 0) return showToast("請輸入有效里程");
  try {
    await update(ref(db, `${REP_PATH}/${editing.id}`), { actualKm: km, k: roundK(km) });
    closeModal(); showToast("✅ 已更新里程");
  } catch (e) { console.error(e); showToast("更新失敗：" + (e?.code || e?.message || e)); }
}

async function deleteReport(id) {
  if (!confirm("確定要刪除這筆里程紀錄嗎？")) return;
  try { await remove(ref(db, `${REP_PATH}/${id}`)); showToast("已刪除里程紀錄"); }
  catch (e) { showToast("刪除失敗：" + (e?.code || e?.message || e)); }
}

// ── 順子分配模式 ──────────────────────────────────────────────────────
async function setMode(mode) {
  const next = { mode, assignments: { ...(settings.assignments || {}) } };
  if (mode === "manual" && !Object.keys(next.assignments).length) {
    const { straights } = computeStraights(cardsFromReports());
    straights.forEach((s, gi) => s.forEach(c => next.assignments[c.id] = gi + 1));
  }
  settings = next; render();
  try { await set(ref(db, SET_PATH), next); }
  catch (e) { console.error(e); showToast("模式儲存失敗"); }
}
async function setAssignment(id, group) {
  const assignments = { ...(settings.assignments || {}) };
  if (group) assignments[id] = Number(group); else delete assignments[id];
  settings = { ...settings, assignments }; render();
  try { await set(ref(db, SET_PATH), settings); }
  catch (e) { console.error(e); showToast("分配儲存失敗"); }
}

// ── Tab / 預覽 / Toast ───────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  $("formPlan").style.display   = tab === "plan"   ? "block" : "none";
  $("formReport").style.display = tab === "report" ? "block" : "none";
  $("tabPlan").classList.toggle("active",   tab === "plan");
  $("tabReport").classList.toggle("active", tab === "report");
  renderProgress();
}

function updatePreview(inputId, previewId) {
  const km = parseFloat($(inputId).value);
  const el = $(previewId);
  if (!km || km <= 0) { el.innerHTML = "　"; return; }
  el.innerHTML = `${km}K → 進位後為 <b>${roundK(km)}K</b> 卡`;
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove("show"), 2800);
}

// ── 事件綁定 ──────────────────────────────────────────────────────────
$("tabPlan").addEventListener("click",   () => switchTab("plan"));
$("tabReport").addEventListener("click", () => switchTab("report"));
$("submitReport").addEventListener("click", submitReport);
$("cancelEdit").addEventListener("click", closeModal);
$("saveEdit").addEventListener("click", saveEdit);
$("editModal").addEventListener("click", e => { if (e.target === $("editModal")) closeModal(); });
$("reportName").addEventListener("change", updateDayPills);
$("reportKm").addEventListener("input", () => updatePreview("reportKm", "reportPreview"));
$("editKm").addEventListener("input",   () => updatePreview("editKm", "editPreview"));
$("modeAuto").addEventListener("click",   () => setMode("auto"));
$("modeManual").addEventListener("click", () => setMode("manual"));

$("reportDayPills").addEventListener("click", e => {
  const p = e.target.closest(".day-pill");
  if (!p || p.disabled) return;
  reportDay = p.dataset.day;
  updateDayPills();
});

$("membersList").addEventListener("click", e => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  if (b.dataset.action === "edit") openEdit(b.dataset.id);
  if (b.dataset.action === "del")  deleteReport(b.dataset.id);
});

$("poolArea").addEventListener("change", e => {
  const s = e.target.closest("select[data-assign]");
  if (s) setAssignment(s.dataset.assign, s.value);
});

// ── 初始化 ────────────────────────────────────────────────────────────
startListeners();
