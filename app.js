// ── Firebase ──────────────────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, update, remove, onValue
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
const REG_PATH = "event05/registrations"; // 報名（認領格子）
const REP_PATH = "event05/reports";       // 里程回報
const DAYS = ["11/7", "11/8"];
const REPORT_OPEN_DATE = new Date("2026-11-07T00:00:00+08:00");
const REMIND_MSG = "請確認當週已經達成跑銀5421紀錄";

const ALL_MEMBERS = [
  "佳宜*雞蛋花", "志隆", "臣賢", "鄭伯", "鄭宏洋",
  "高聖智", "陳弘明", "雷皇正", "蔡若瑋"
];
const inRoster = r => ALL_MEMBERS.includes(r.name); // 不在名單的資料保留在資料庫，但不顯示、不計分

// 九宮格（依海報排列）：上排 5K 6K 7K／中排 尾數1 尾數2 尾數3／下排 9K 10K 8K
const CELLS = [
  { id: "k5",  label: "5K",   k: 5,  color: "pink"   },
  { id: "k6",  label: "6K",   k: 6,  color: "blue"   },
  { id: "k7",  label: "7K",   k: 7,  color: "green"  },
  { id: "t1",  label: "尾數1", tail: 1, color: "purple" },
  { id: "t2",  label: "尾數2", tail: 2, color: "blue"   },
  { id: "t3",  label: "尾數3", tail: 3, color: "green"  },
  { id: "k9",  label: "9K",   k: 9,  color: "yellow" },
  { id: "k10", label: "10K",  k: 10, color: "pink"   },
  { id: "k8",  label: "8K",   k: 8,  color: "purple" },
];
const CELL = Object.fromEntries(CELLS.map((c, i) => [c.id, { ...c, idx: i }]));

const LINES = [
  { name: "上排",   cells: [0, 1, 2] },
  { name: "中排",   cells: [3, 4, 5] },
  { name: "下排",   cells: [6, 7, 8] },
  { name: "左直排", cells: [0, 3, 6] },
  { name: "中直排", cells: [1, 4, 7] },
  { name: "右直排", cells: [2, 5, 8] },
  { name: "斜線 ↘", cells: [0, 4, 8] },
  { name: "斜線 ↙", cells: [2, 4, 6] },
];

// ── State ─────────────────────────────────────────────────────────────
let registrations = [];
let reports       = [];
let currentTab    = "register";
let pickCell      = "";
let reportDay     = "";
let editing       = null; // { id, day }
let isSubmitting  = false;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isReportOpen = () => new Date() >= REPORT_OPEN_DATE;

// ── 規則 ──────────────────────────────────────────────────────────────
// 5421 跑銀進位：小數 > 0.11 進位，否則捨去
function roundK(km) {
  const whole = Math.floor(km);
  const dec   = parseFloat((km - whole).toFixed(10));
  return dec > 0.11 ? whole + 1 : whole;
}
// K 數 → 對應格子（5~10K 為整數格；尾數 1/2/3 例如 1、11、21K）
function cellOfK(k) {
  if (k >= 5 && k <= 10) return "k" + k;
  const d = k % 10;
  if (k >= 1 && d >= 1 && d <= 3) return "t" + d;
  return null;
}
const needsRemind = k => k >= 1 && k <= 3;
const regOf = name => registrations.find(r => r.name === name);
const repOf = name => reports.find(r => r.name === name);

// 依名單算出每格有哪些人 → 連線、點亮、積分
function evaluate(entries) {
  const byCell = CELLS.map(() => []);
  entries.forEach(e => { const c = CELL[e.cell]; if (c) byCell[c.idx].push(e); });
  const lit = byCell.map(list => list.length > 0);
  const done = LINES.filter(l => l.cells.every(i => lit[i]));
  const litCount = lit.filter(Boolean).length;
  const points = (done.length ? 2 : 0) + (litCount === 9 ? 2 : 0);
  return { byCell, lit, done, litCount, points };
}

// ── Firebase 監聽 ─────────────────────────────────────────────────────
function startListeners() {
  render();

  onValue(ref(db, ".info/connected"), snap => {
    if (snap.val() === true) console.log("✅ 已連上 Realtime Database:", firebaseConfig.databaseURL);
  });

  const toList = snap => Object.entries(snap.val() || {})
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  onValue(ref(db, REG_PATH),
    snap => { registrations = toList(snap).filter(inRoster); render(); },
    err  => { console.error(err); showToast("⚠️ Firebase 連線失敗，請確認 Realtime Database 規則已開放 event05"); }
  );
  onValue(ref(db, REP_PATH),
    snap => { reports = toList(snap).filter(inRoster); render(); },
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
  renderBoard();
  renderRegisterForm();
  renderReportForm();
  renderMemberList();
}

function boardEntries() {
  return currentTab === "report"
    ? reports.filter(r => r.cell).map(r => ({ name: r.name, cell: r.cell, k: r.k }))
    : registrations.map(r => ({ name: r.name, cell: r.cell, k: r.plannedK }));
}

function renderBoard() {
  const isReport = currentTab === "report";
  const ev = evaluate(boardEntries());
  const inLine = new Set(ev.done.flatMap(l => l.cells));

  $("progressSublabel").textContent = isReport ? "實際連線" : "預計連線";
  $("lineCount").textContent  = ev.done.length;
  $("litCount").textContent   = ev.litCount;
  $("pointCount").textContent = ev.points;

  $("bingoBoard").innerHTML = CELLS.map((c, i) => {
    const people = ev.byCell[i];
    const names = people.map(p => {
      const kTag = c.tail ? `<em>${p.k}K</em>` : "";
      return `<span class="who">${esc(p.name)}${kTag}</span>`;
    }).join("");
    return `
      <div class="cell ${c.color} ${ev.lit[i] ? "lit" : ""} ${inLine.has(i) ? "in-line" : ""}" data-idx="${i}">
        <span class="cell-label">${c.tail ? `<small>尾數</small>${c.tail}` : c.label}</span>
        <div class="cell-names">${names || `<span class="empty">${isReport ? "待點亮" : "待認領"}</span>`}</div>
        ${ev.lit[i] ? `<span class="stamp">${isReport ? "✔" : "📋"}</span>` : ""}
      </div>`;
  }).join("") + `<svg class="line-layer" id="lineLayer"></svg>`;

  requestAnimationFrame(() => drawLines(ev.done));

  // 連線標籤
  const tags = ev.done.map(l => `<span class="line-tag">✔ ${l.name}</span>`);
  if (ev.litCount === 9) tags.unshift(`<span class="line-tag slam">🎉 大滿貫！</span>`);
  $("lineTags").innerHTML = tags.join("");

  // 提示：差一格就連線 / 大滿貫還差幾格
  const hint = $("hintBox");
  const missingLabel = i => `<b>${CELLS[i].label}</b>`;
  const near = new Map();
  LINES.forEach(l => {
    const miss = l.cells.filter(i => !ev.lit[i]);
    if (miss.length === 1) {
      const i = miss[0];
      if (!near.has(i)) near.set(i, []);
      near.get(i).push(l.name);
    }
  });
  const parts = [];
  if (!ev.done.length && near.size) {
    parts.push("💡 只差一格就連線！" + [...near].map(([i, ls]) => `補上 ${missingLabel(i)}（${ls.join("、")}）`).join("；"));
  }
  const missAll = CELLS.map((_, i) => i).filter(i => !ev.lit[i]);
  if (ev.done.length && missAll.length && missAll.length <= 4) {
    parts.push(`🏆 再點亮 ${missAll.map(missingLabel).join("、")} 就是大滿貫，再加 2 分！`);
  }
  if (!isReport && !registrations.length) parts.push("還沒有人認領格子，快來報名 💪");
  hint.style.display = parts.length ? "block" : "none";
  hint.innerHTML = parts.join("<br>");
}

function drawLines(done) {
  const svg = $("lineLayer"), board = $("bingoBoard");
  if (!svg || !board) return;
  const br = board.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${br.width} ${br.height}`);
  const center = i => {
    const r = board.querySelector(`.cell[data-idx="${i}"]`).getBoundingClientRect();
    return [r.left - br.left + r.width / 2, r.top - br.top + r.height / 2];
  };
  svg.innerHTML = done.map((l, n) => {
    const [x1, y1] = center(l.cells[0]), [x2, y2] = center(l.cells[2]);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="animation-delay:${n * 120}ms" />`;
  }).join("");
}

// ── 報名表 ────────────────────────────────────────────────────────────
function renderRegisterForm() {
  const regNames = new Set(registrations.map(r => r.name));
  const sel = $("registerName");
  const prev = sel.value;
  const avail = ALL_MEMBERS.filter(n => !regNames.has(n));
  sel.innerHTML = '<option value="">請選取組員...</option>' +
    avail.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if (avail.includes(prev)) sel.value = prev;
  $("slotsLeft").textContent = `剩 ${avail.length} 位未報名`;

  const counts = {};
  registrations.forEach(r => counts[r.cell] = (counts[r.cell] || 0) + 1);
  $("cellPicker").innerHTML = CELLS.map(c => `
    <button class="pick ${c.color} ${pickCell === c.id ? "active" : ""}" data-cell="${c.id}">
      <span class="pick-label">${c.label}</span>
      <span class="pick-count">${counts[c.id] ? `${counts[c.id]} 人` : "尚無人"}</span>
    </button>`).join("");

  const c = CELL[pickCell];
  $("tailInputWrap").style.display = c && c.tail ? "block" : "none";
  if (c && c.tail) $("tailLabel").textContent = `預計里程 (K) *　尾數需為 ${c.tail}，例如 ${c.tail}、1${c.tail}、2${c.tail}K`;
  updateRegisterPreview();
}

// 回傳 { ok, k, msg }
function checkRegister() {
  const c = CELL[pickCell];
  if (!c) return { ok: false, msg: "" };
  if (!c.tail) return { ok: true, k: c.k, msg: `認領 <b>${c.label}</b> 格，活動當天請跑 ${c.k}K（${c.k - 1}.12～${c.k}.11K 皆算 ${c.k}K）` };
  const raw = $("registerKm").value;
  if (raw === "") return { ok: false, msg: `請填入尾數為 ${c.tail} 的 K 數` };
  const km = parseFloat(raw);
  if (!(km > 0)) return { ok: false, msg: "請輸入有效里程" };
  const k = roundK(km);
  const shown = k !== km ? `${km}K → 計為 <b>${k}K</b>` : `<b>${k}K</b>`;
  if (k % 10 !== c.tail) return { ok: false, warn: true, msg: `${shown}，尾數不是 ${c.tail} ✖ 請改填 ${c.tail}、1${c.tail}、2${c.tail}K…` };
  return { ok: true, k, msg: `${shown}，符合【${c.label}】✔` + (needsRemind(k) ? `<br>⚠️ ${REMIND_MSG}` : "") };
}

function updateRegisterPreview() {
  const el = $("registerPreview");
  const r = checkRegister();
  el.innerHTML = r.msg || "　";
  el.classList.toggle("warn", !!r.warn || (r.ok && needsRemind(r.k)));
}

async function submitRegister() {
  if (isSubmitting) return;
  const name = $("registerName").value;
  if (!name) return showToast("請選取組員");
  if (regOf(name)) return showToast("這位組員已報名，每人只能選一格");
  if (!pickCell) return showToast("請選擇要認領的格子");
  const chk = checkRegister();
  if (!chk.ok) return showToast(CELL[pickCell].tail ? `K 數需符合尾數 ${CELL[pickCell].tail}` : "請確認格子");
  if (needsRemind(chk.k) && !(await confirm5421(`${name} 報名 ${chk.k}K`))) return;

  isSubmitting = true;
  setBtn("submitRegister", true);
  const cell = pickCell;
  try {
    await push(ref(db, REG_PATH), { name, cell, plannedK: chk.k, createdAt: Date.now() });
    $("registerName").value = ""; $("registerKm").value = ""; pickCell = "";
    renderRegisterForm();
    showToast(`✅ ${name} 認領【${CELL[cell].label}】${CELL[cell].tail ? " " + chk.k + "K" : ""}！`);
  } catch (e) {
    console.error(e); showToast("送出失敗：" + (e?.code || e?.message || e));
  } finally {
    isSubmitting = false;
    setBtn("submitRegister", false, "確認送出報名");
  }
}

// ── 回報表 ────────────────────────────────────────────────────────────
function renderReportForm() {
  const locked = !isReportOpen();
  $("reportLockBanner").style.display = locked ? "flex" : "none";
  $("reportFormInner").style.display  = locked ? "none" : "block";

  const repNames = new Set(reports.map(r => r.name));
  const sel = $("reportName");
  const prev = sel.value;
  // 已報名的排前面
  const avail = ALL_MEMBERS.filter(n => !repNames.has(n))
    .sort((a, b) => (regOf(a) ? 0 : 1) - (regOf(b) ? 0 : 1));
  sel.innerHTML = '<option value="">請選取組員...</option>' +
    avail.map(n => {
      const r = regOf(n);
      const tag = r ? `　（認領 ${CELL[r.cell]?.label}${CELL[r.cell]?.tail ? " " + r.plannedK + "K" : ""}）` : "　（未報名）";
      return `<option value="${esc(n)}">${esc(n)}${tag}</option>`;
    }).join("");
  if (avail.includes(prev)) sel.value = prev;
  $("reportSlotsLeft").textContent = `剩 ${avail.length} 位未回報`;
  updateRegHint();
  updatePills("reportDayPills", reportDay);
}

function updateRegHint() {
  const name = $("reportName").value, el = $("regHint");
  if (!name) { el.innerHTML = "　"; return; }
  const r = regOf(name);
  el.innerHTML = r
    ? `📋 報名認領：<b>${CELL[r.cell]?.label}</b>${CELL[r.cell]?.tail ? `（預計 ${r.plannedK}K）` : ""}`
    : "📋 這位組員沒有報名，跑了也可以回報";
}

function updatePills(containerId, day) {
  document.querySelectorAll(`#${containerId} .day-pill`).forEach(p =>
    p.classList.toggle("active", p.dataset.day === day));
}

// 實跑預覽：進位後 K、點亮哪一格、是否與報名不同
function reportPreviewHTML(name, raw) {
  const km = parseFloat(raw);
  if (!(km > 0)) return { html: "　", warn: false };
  const k = roundK(km), cell = cellOfK(k);
  let html = `${km}K → 計為 <b>${k}K</b>，` + (cell ? `點亮【${CELL[cell].label}】` : `不在 BINGO 盤上`);
  let warn = false;
  if (!cell) { html += `<br>⚠️ 這個里程不會點亮任何格子，仍可回報`; warn = true; }
  const reg = name && regOf(name);
  if (reg && cell && reg.cell !== cell) {
    html += `<br>⚠️ 與報名的【${CELL[reg.cell]?.label}】不同，仍可回報，系統會依實跑點亮格子`; warn = true;
  } else if (reg && !cell) {
    html += `（報名為【${CELL[reg.cell]?.label}】）`;
  }
  if (needsRemind(k)) { html += `<br>⚠️ ${REMIND_MSG}`; warn = true; }
  return { html, warn };
}

function updateReportPreview() {
  const p = reportPreviewHTML($("reportName").value, $("reportKm").value);
  $("reportPreview").innerHTML = p.html;
  $("reportPreview").classList.toggle("warn", p.warn);
}

async function submitReport() {
  if (!isReportOpen()) return showToast("⛔ 請於 11/7 再開始回報里程");
  if (isSubmitting) return;
  const name = $("reportName").value;
  const km   = parseFloat($("reportKm").value);
  if (!name) return showToast("請選取組員");
  if (repOf(name)) return showToast("已回報過囉，請用下方 ✏️ 修改");
  if (!reportDay) return showToast("請選擇跑步日期");
  if (!(km > 0)) return showToast("請輸入有效里程");

  const k = roundK(km), cell = cellOfK(k), day = reportDay;
  if (needsRemind(k) && !(await confirm5421(`${name} 回報 ${k}K`))) return;

  isSubmitting = true;
  setBtn("submitReport", true);
  try {
    await push(ref(db, REP_PATH), { name, day, actualKm: km, k, cell: cell || "", createdAt: Date.now() });
    $("reportKm").value = ""; $("reportName").value = ""; reportDay = "";
    $("reportPreview").innerHTML = "　"; $("reportPreview").classList.remove("warn");
    updatePills("reportDayPills", "");
    showToast(cell ? `🎯 ${name} 點亮【${CELL[cell].label}】！` : `✅ ${name} 已回報 ${k}K`);
  } catch (e) {
    console.error(e); showToast("送出失敗：" + (e?.code || e?.message || e));
  } finally {
    isSubmitting = false;
    setBtn("submitReport", false, "確認送出里程");
  }
}

// ── 組員列表 ──────────────────────────────────────────────────────────
function renderMemberList() {
  const list = $("membersList");
  list.innerHTML = ALL_MEMBERS.map(name => {
    const reg = regOf(name), rep = repOf(name);
    const regCell = reg && CELL[reg.cell];
    const repCell = rep && rep.cell && CELL[rep.cell];
    const avatarCell = repCell || regCell;
    const avatar = avatarCell
      ? `<div class="avatar ${avatarCell.color} ${rep ? "" : "dim"}">${avatarCell.tail ? `<small>尾</small>${avatarCell.tail}` : avatarCell.label}</div>`
      : `<div class="avatar blank">?</div>`;

    const regRow = reg
      ? `<div class="row"><span class="chip">報名</span><span class="row-text">認領 <b>${regCell?.label}</b>${regCell?.tail ? ` · ${reg.plannedK}K` : ""}</span>
           <button class="icon-btn" data-action="delReg" data-id="${reg.id}" title="取消報名">🗑️</button></div>`
      : `<div class="row"><span class="chip wait">報名</span><span class="row-text muted">尚未報名</span></div>`;

    const diff = rep && reg && rep.cell !== reg.cell;
    const repRow = rep
      ? `<div class="row"><span class="chip done">${esc(rep.day)}</span>
           <span class="row-text ${diff || !rep.cell ? "diff" : ""}">${diff || !rep.cell ? "⚠️ " : ""}${rep.actualKm}K → ${rep.k}K · ${repCell ? `點亮 <b>${repCell.label}</b>` : "未點亮格子"}</span>
           <button class="icon-btn" data-action="edit" data-id="${rep.id}" title="修改">✏️</button>
           <button class="icon-btn" data-action="delRep" data-id="${rep.id}" title="刪除回報">🗑️</button></div>`
      : `<div class="row"><span class="chip wait">實跑</span><span class="row-text muted">未回報</span></div>`;

    const status = rep ? `<span class="member-status ok">✔ 已回報</span>`
                 : reg ? `<span class="member-status">已報名</span>`
                 : `<span class="member-status">—</span>`;
    return `
      <div class="member-card">
        ${avatar}
        <div class="member-info">
          <div class="member-head"><div class="member-name">${esc(name)}</div>${status}</div>
          ${regRow}${repRow}
        </div>
      </div>`;
  }).join("");
}

// ── 編輯 / 刪除 ───────────────────────────────────────────────────────
function openEdit(id) {
  const src = reports.find(r => r.id === id);
  if (!src) return;
  editing = { id, day: src.day };
  $("editName").textContent = src.name;
  $("editKm").value = src.actualKm;
  updatePills("editDayPills", editing.day);
  updateEditPreview();
  $("editModal").style.display = "flex";
}
function closeModal() { $("editModal").style.display = "none"; editing = null; }
function updateEditPreview() {
  if (!editing) return;
  const src = reports.find(r => r.id === editing.id);
  const p = reportPreviewHTML(src?.name, $("editKm").value);
  $("editPreview").innerHTML = p.html;
  $("editPreview").classList.toggle("warn", p.warn);
}

async function saveEdit() {
  if (!editing) return;
  const km = parseFloat($("editKm").value);
  if (!(km > 0)) return showToast("請輸入有效里程");
  const k = roundK(km), cell = cellOfK(k);
  const src = reports.find(r => r.id === editing.id);
  const { id, day } = editing;
  if (needsRemind(k) && !(await confirm5421(`${src?.name || ""} 回報 ${k}K`))) return;
  try {
    await update(ref(db, `${REP_PATH}/${id}`), { actualKm: km, k, cell: cell || "", day });
    closeModal(); showToast("✅ 已更新里程");
  } catch (e) { console.error(e); showToast("更新失敗：" + (e?.code || e?.message || e)); }
}

async function deleteReport(id) {
  if (!confirm("確定要刪除這筆里程紀錄嗎？")) return;
  try { await remove(ref(db, `${REP_PATH}/${id}`)); showToast("已刪除里程紀錄"); }
  catch (e) { showToast("刪除失敗：" + (e?.code || e?.message || e)); }
}
async function deleteRegistration(id) {
  if (!confirm("確定要取消這筆報名嗎？取消後可重新認領其他格子。")) return;
  try { await remove(ref(db, `${REG_PATH}/${id}`)); showToast("已取消報名"); }
  catch (e) { showToast("刪除失敗：" + (e?.code || e?.message || e)); }
}

// ── 5421 提醒視窗 ─────────────────────────────────────────────────────
function confirm5421(who) {
  return new Promise(resolve => {
    $("remindText").innerHTML = `${esc(who)}<br><b>${REMIND_MSG}</b>`;
    $("remindModal").style.display = "flex";
    const done = ok => {
      $("remindModal").style.display = "none";
      $("remindOk").onclick = $("remindCancel").onclick = null;
      resolve(ok);
    };
    $("remindOk").onclick = () => done(true);
    $("remindCancel").onclick = () => done(false);
  });
}

// ── Tab / Toast ──────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  $("formRegister").style.display = tab === "register" ? "block" : "none";
  $("formReport").style.display   = tab === "report"   ? "block" : "none";
  $("tabRegister").classList.toggle("active", tab === "register");
  $("tabReport").classList.toggle("active",   tab === "report");
  renderBoard();
  renderReportForm();
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove("show"), 2800);
}

// ── 事件綁定 ──────────────────────────────────────────────────────────
$("tabRegister").addEventListener("click", () => switchTab("register"));
$("tabReport").addEventListener("click",   () => switchTab("report"));
$("submitRegister").addEventListener("click", submitRegister);
$("submitReport").addEventListener("click", submitReport);
$("cancelEdit").addEventListener("click", closeModal);
$("saveEdit").addEventListener("click", saveEdit);
$("editModal").addEventListener("click", e => { if (e.target === $("editModal")) closeModal(); });

$("cellPicker").addEventListener("click", e => {
  const b = e.target.closest(".pick");
  if (!b) return;
  pickCell = b.dataset.cell;
  renderRegisterForm();
  if (CELL[pickCell].tail) $("registerKm").focus();
});
$("registerKm").addEventListener("input", updateRegisterPreview);

$("reportName").addEventListener("change", () => { updateRegHint(); updateReportPreview(); });
$("reportKm").addEventListener("input", updateReportPreview);
$("editKm").addEventListener("input", updateEditPreview);

$("reportDayPills").addEventListener("click", e => {
  const p = e.target.closest(".day-pill"); if (!p) return;
  reportDay = p.dataset.day; updatePills("reportDayPills", reportDay);
});
$("editDayPills").addEventListener("click", e => {
  const p = e.target.closest(".day-pill"); if (!p || !editing) return;
  editing.day = p.dataset.day; updatePills("editDayPills", editing.day);
});

$("membersList").addEventListener("click", e => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const { action, id } = b.dataset;
  if (action === "edit") {
    if (!isReportOpen()) return showToast("⛔ 請於 11/7 再開始回報里程");
    openEdit(id);
  }
  if (action === "delRep") deleteReport(id);
  if (action === "delReg") deleteRegistration(id);
});

window.addEventListener("resize", () => renderBoard());

// ── 初始化 ────────────────────────────────────────────────────────────
startListeners();
