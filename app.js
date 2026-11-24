// Poker Night - phone app (PWA). UI and storage; all calculations live in logic.js.
import {
  DEFAULT_CHIP_VALUES, DEFAULT_ROUND_MINUTES, PokerError, Session, amountText, formatClock, formatMinutes,
  nowStr, parseMoney, sessionIdFromCreated, validateChipValues,
} from "./logic.js";

// ================================================================ storage
// Every change is written to the phone's storage straight away. The previous
// version of each session is kept as a backup in case the latest copy is damaged.
const PREFIX = "pokerNight.";
const LOG_LIMIT = 3000;

const store = {
  key: (kind, id) => `${PREFIX}${kind}.${id}`,

  index() {
    try { return JSON.parse(localStorage.getItem(PREFIX + "index") || "{}"); } catch { return {}; }
  },

  exists(id) { return localStorage.getItem(this.key("session", id)) !== null; },

  load(id) {
    for (const kind of ["session", "backup"]) {
      try {
        const text = localStorage.getItem(this.key(kind, id));
        if (text) return Session.validateData(JSON.parse(text));
      } catch { /* try the backup */ }
    }
    return null;
  },

  save(session) {
    const key = this.key("session", session.id);
    const previous = localStorage.getItem(key);
    if (previous) localStorage.setItem(this.key("backup", session.id), previous);
    localStorage.setItem(key, JSON.stringify(session.data));
    const index = this.index();
    index[session.id] = nowStr();
    localStorage.setItem(PREFIX + "index", JSON.stringify(index));
  },

  log(id, line) {
    try {
      const key = this.key("log", id);
      const lines = (localStorage.getItem(key) || "").split("\n").filter(Boolean);
      lines.push(line);
      localStorage.setItem(key, lines.slice(-LOG_LIMIT).join("\n"));
    } catch { /* the log is a convenience; the session data is what matters */ }
  },

  readLog(id) { return localStorage.getItem(this.key("log", id)) || ""; },

  remove(id) {
    for (const kind of ["session", "backup", "log"]) localStorage.removeItem(this.key(kind, id));
    const index = this.index();
    delete index[id];
    localStorage.setItem(PREFIX + "index", JSON.stringify(index));
    if (this.last() === id) localStorage.removeItem(PREFIX + "last");
  },

  /** Saved sessions, most recently changed first. */
  list() {
    return Object.entries(this.index())
      .map(([id, updated]) => ({ id, updated, data: this.load(id) }))
      .filter((s) => s.data)
      .sort((a, b) => (a.updated < b.updated ? 1 : -1));
  },

  last() { return localStorage.getItem(PREFIX + "last"); },
  setLast(id) { localStorage.setItem(PREFIX + "last", id); },

  uniqueId(id) {
    if (!this.exists(id)) return id;
    let n = 2;
    while (this.exists(`${id}_${n}`)) n++;
    return `${id}_${n}`;
  },
};

const hooks = {
  save: (s) => store.save(s),
  log: (s, line) => store.log(s.id, line),
};

// ================================================================== state
let session = null;
let currentTab = "round";
const openRounds = new Set();
let wakeLock = null;
let wakeWanted = localStorage.getItem(PREFIX + "wake") !== "0";
let audio = null;

// ================================================================ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const sum = (values) => values.reduce((a, b) => a + b, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const resultClass = (cents) => (cents > 0 ? "win" : cents < 0 ? "loss" : "");

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/** Run a session action, show problems nicely, then redraw. Returns true on success. */
function run(action, success) {
  try {
    action();
  } catch (err) {
    if (err instanceof PokerError) {
      alert(err.message);
    } else if (err && err.name === "QuotaExceededError") {
      alert("Saving failed: the phone's storage for this app is full.\nExport and delete old sessions in Settings.");
    } else {
      alert(`Something went wrong: ${err?.message || err}\n\nEverything up to the last action is saved.`);
      console.error(err);
    }
    render();
    return false;
  }
  if (success) toast(success);
  render();
  return true;
}

const CHIP_COLOURS = {
  white: "#f2f2f2", red: "#c62828", green: "#2e7d32", blue: "#1f57b5", black: "#111111",
  yellow: "#f9d71c", orange: "#ef7d00", purple: "#6a1b9a", pink: "#e91e8c", grey: "#8c8c8c",
  gray: "#8c8c8c", brown: "#6d4c41", gold: "#e3b94f", silver: "#c0c0c0",
};

function chipIcon(colour) {
  const fill = CHIP_COLOURS[String(colour).trim().toLowerCase()] || "#e3b94f";
  const dash = fill === "#f2f2f2" ? "border-color:#9e9e9e;" : "";
  return `<span class="chip-icon" style="--chip-colour:${fill};${dash}"></span>`;
}

const suitsHtml = () => '<span class="suit">♠</span><span class="suit red">♥</span>' +
  '<span class="suit red">♦</span><span class="suit">♣</span>';

function timeInputHtml(minutes) {
  return `<div class="time-input">
    <input type="number" inputmode="numeric" min="0" max="23" data-hours value="${Math.floor(minutes / 60)}"> h
    <input type="number" inputmode="numeric" min="0" max="59" step="5" data-minutes value="${String(minutes % 60).padStart(2, "0")}"> min
  </div>`;
}

function readTimeInput(root) {
  const hours = Number($("[data-hours]", root).value || 0);
  const minutes = Number($("[data-minutes]", root).value || 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) throw new PokerError("Hours and minutes must be whole numbers");
  if (hours < 0 || minutes < 0 || minutes > 59) throw new PokerError("Use 0 or more hours and 0-59 minutes");
  return hours * 60 + minutes;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

async function shareText(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  await copyText(text);
  toast("Copied to the clipboard");
}

// ================================================================= sheets
// Pop-up panels that slide up from the bottom. The phone's back button closes the top one.
const sheetStack = [];
let ignorePops = 0;
let queuedPushes = 0;

function openSheet(title, body, foot = "") {
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="btn small ghost" data-close aria-label="Close">✕</button></div>
      <div class="sheet-body">${body}</div>
      ${foot ? `<div class="sheet-foot">${foot}</div>` : ""}
    </div>`;
  $("#sheets").appendChild(backdrop);
  sheetStack.push(backdrop);
  if (ignorePops > 0) queuedPushes++;
  else history.pushState({ sheet: true }, "");
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest("[data-close]")) closeSheet(backdrop);
  });
  return backdrop.querySelector(".sheet");
}

function closeSheet(backdrop = sheetStack[sheetStack.length - 1]) {
  const index = sheetStack.indexOf(backdrop);
  if (index === -1) return;
  sheetStack.splice(index, 1);
  backdrop.remove();
  ignorePops++;
  history.back();
}

window.addEventListener("popstate", () => {
  if (ignorePops > 0) {
    ignorePops--;
    for (; queuedPushes > 0; queuedPushes--) history.pushState({ sheet: true }, "");
    return;
  }
  const top = sheetStack.pop();
  if (top) top.remove();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheetStack.length) closeSheet();
});

// ================================================================= render
function render() {
  const tabbar = $("#tabbar");
  if (!session) {
    tabbar.classList.add("hidden");
    $("#hdr-info").textContent = "";
    $("#view").innerHTML = viewWelcome();
    updateClock();
    return;
  }
  tabbar.classList.remove("hidden");
  $$("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === currentTab));
  const rnd = session.activeRound;
  const state = rnd ? `Round ${rnd.number} in progress` : `${plural(session.rounds.length, "round")} played`;
  $("#hdr-info").textContent = `Buy-in ${session.money(session.buyIn)} · ${plural(session.players.length, "player")} · ${state}`;
  const views = { round: viewRound, history: viewHistory, settle: viewSettle, settings: viewSettings };
  $("#view").innerHTML = views[currentTab]();
  if (currentTab === "settings") wireSettings();
  updateClock();
  updateWakeLock();
}

function switchTab(tab) {
  currentTab = tab;
  render();
  $("#view").scrollTop = 0;
}

function setSession(s) {
  session = s;
  if (s) store.setLast(s.id);
  openRounds.clear();
}

// ------------------------------------------------------------- welcome
function viewWelcome() {
  const saved = store.list();
  return `<div class="empty-round">
    <div class="suits">${suitsHtml()}</div>
    <h1>Welcome to Poker Night</h1>
    <p class="hint">Keeps track of buy-ins, chip counts and who owes who.<br>Everything is saved on this phone after every tap.</p>
    <div class="btn-row" style="flex-direction:column;margin-top:18px">
      <button class="btn red big wide" data-action="new-session">New session</button>
      ${saved.length ? `<button class="btn big wide" data-action="sessions">📂 Continue a saved session</button>` : ""}
      <button class="btn wide" data-action="import">Import session file</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- round
function viewRound() {
  const s = session;
  const rnd = s.activeRound;
  if (!rnd) {
    return `<div class="empty-round">
      <div class="suits">${suitsHtml()}</div>
      <h1>No round in progress</h1>
      <p>Everyone buys in <b>${esc(s.money(s.buyIn))}</b> at the start of the round.</p>
      <p class="hint">Round length ${formatMinutes(s.roundMinutes)}</p>
      <p style="margin-top:18px"><button class="btn red big" data-action="start-round" ${s.players.length < 2 ? "disabled" : ""}>▶ Start round ${s.rounds.length + 1}</button></p>
      ${s.players.length < 2 ? `<p class="hint">Add at least 2 players in Settings first.</p>` : ""}
    </div>`;
  }
  const paused = Session.clockPaused(rnd);
  const seats = Object.entries(rnd.buyins).map(([player, count], i) => `
    <div class="seat">
      <div class="seat-name">${esc(player)}</div>
      <div class="seat-info"><b>${count}</b> buy-in${count === 1 ? "" : "s"} · ${esc(s.money(count * rnd.buy_in_cents))}</div>
      <div class="seat-buttons">
        <button class="btn small ghost" data-action="undo-buyin" data-i="${i}" ${count <= 1 ? "disabled" : ""}>Undo</button>
        <button class="btn blue" data-action="buyin" data-i="${i}">+ Buy-in</button>
      </div>
    </div>`).join("");
  return `
    <section class="card clock-card">
      <div class="round-title">Round ${rnd.number} · started ${rnd.started.slice(11, 16)} · buy-in ${esc(s.money(rnd.buy_in_cents))}</div>
      <div class="clock" id="clock"></div>
      <div class="clock-sub" id="clock-sub"></div>
      <div class="btn-row">
        <button class="btn small" data-action="toggle-pause">${paused ? "▶ Resume" : "⏸ Pause"}</button>
        <button class="btn small" data-action="clock-adjust" data-min="-5">−5 min</button>
        <button class="btn small" data-action="clock-adjust" data-min="5">+5 min</button>
        <button class="btn small" data-action="set-time">✎ Set</button>
        <button class="btn small" data-action="reset-clock">⟲ Reset</button>
      </div>
      ${"wakeLock" in navigator ? `<label class="check" style="justify-content:center"><input type="checkbox" id="wake" ${wakeWanted ? "checked" : ""}> Keep screen on during the round</label>` : ""}
      <p class="hint">Round length ${formatMinutes(Session.roundLength(rnd))}</p>
    </section>
    <p class="hint center">Tap <b>+ Buy-in</b> when someone loses all their chips and buys in again.</p>
    <section class="seats">${seats}</section>
    <div class="total-line">Total money in play: ${esc(s.money(Session.roundTotalIn(rnd)))}</div>
    <button class="btn red big wide" data-action="end-round">🏁 End round &amp; count chips</button>
    <div class="btn-row spread">
      <button class="btn" data-action="add-to-round">Add player</button>
      <button class="btn" data-action="cancel-round">Cancel round</button>
    </div>`;
}

const roundPlayer = (el) => Object.keys(session.activeRound.buyins)[Number(el.dataset.i)];

function startRoundSheet() {
  const s = session;
  const sheet = openSheet(`Start round ${s.rounds.length + 1}`,
    `<p>Who is playing this round?</p>
     ${s.players.map((p, i) => `<label class="check"><input type="checkbox" data-i="${i}" checked> ${esc(p)}</label>`).join("")}
     <p class="hint">Everyone starts with ${esc(s.money(s.buyIn))}. Round length ${formatMinutes(s.roundMinutes)}.</p>`,
    `<button class="btn red big wide" data-go>▶ Start round</button>`);
  $("[data-go]", sheet).onclick = () => {
    const chosen = $$("input[data-i]", sheet).filter((c) => c.checked).map((c) => s.players[Number(c.dataset.i)]);
    if (chosen.length < 2) return alert("Please choose at least 2 players.");
    if (run(() => s.startRound(chosen), `Round ${s.rounds.length + 1} started`)) closeSheet();
  };
}

function addToRoundSheet() {
  const s = session;
  const rnd = s.activeRound;
  const outside = s.players.filter((p) => !(p in rnd.buyins));
  const sheet = openSheet("Add player to round",
    `${outside.length ? `<p>Who joins this round? (1 buy-in each)</p>
      ${outside.map((p) => `<label class="check"><input type="checkbox" data-name="${esc(p)}"> ${esc(p)}</label>`).join("")}`
      : `<p class="hint">All players are already in this round.</p>`}
     <label class="field"><span>…or a new player</span><input type="text" data-new placeholder="Name" autocomplete="off"></label>`,
    `<button class="btn red big wide" data-go>Add to round</button>`);
  $("[data-go]", sheet).onclick = () => {
    const chosen = $$("input[data-name]", sheet).filter((c) => c.checked).map((c) => c.dataset.name);
    const newName = $("[data-new]", sheet).value.trim();
    if (!chosen.length && !newName) return alert("Choose a player or type a new name.");
    const ok = run(() => {
      if (newName) s.addPlayer(newName, true);
      for (const p of chosen) s.addToRound(p);
    }, "Player added to the round");
    if (ok) closeSheet(sheet.parentElement);
  };
}

function setTimeSheet() {
  const s = session;
  const rnd = s.activeRound;
  const left = Math.max(0, Math.ceil(Session.remainingSeconds(rnd) / 60));
  const quick = [...new Set([15, 30, 60, Session.roundLength(rnd)])].sort((a, b) => a - b);
  const sheet = openSheet("Change the round clock",
    `<p>How much time is left of this round?</p>
     ${timeInputHtml(left)}
     <p class="hint">Quick pick:</p>
     <div class="btn-row">${quick.map((m) => `<button class="btn small" data-quick="${m}">${formatMinutes(m)}</button>`).join("")}</div>
     <p class="hint">The countdown restarts from the time you set.</p>`,
    `<button class="btn red big wide" data-go>Set clock</button>`);
  $$("[data-quick]", sheet).forEach((b) => {
    b.onclick = () => {
      const m = Number(b.dataset.quick);
      $("[data-hours]", sheet).value = Math.floor(m / 60);
      $("[data-minutes]", sheet).value = String(m % 60).padStart(2, "0");
    };
  });
  $("[data-go]", sheet).onclick = () => {
    let minutes;
    try { minutes = readTimeInput(sheet); } catch (err) { return alert(err.message); }
    if (run(() => s.setTimeLeft(minutes), `Clock set to ${formatMinutes(minutes)} left`)) closeSheet(sheet.parentElement);
  };
}

// ----------------------------------------------------------- counting chips
function countSheet(rnd, editing) {
  const s = session;
  const players = Object.keys(rnd.buyins);
  const breakdowns = new Map(Object.entries(rnd.chip_counts || {})
    .filter(([p]) => p in rnd.buyins)
    .map(([p, b]) => [p, b.map((item) => ({ ...item }))]));
  const rows = players.map((p, i) => {
    const prefill = p in (rnd.chips || {}) ? amountText(rnd.chips[p]) : "";
    return `<div class="count-row" data-i="${i}">
      <div class="name">${esc(p)}</div>
      <div class="result" data-result></div>
      <div class="buyin-stepper"><span>Buy-ins</span>
        <div class="stepper">
          <button class="btn" data-step="-1" aria-label="One buy-in less">−</button>
          <input type="number" inputmode="numeric" min="1" data-buyins value="${rnd.buyins[p]}">
          <button class="btn" data-step="1" aria-label="One buy-in more">+</button>
        </div>
      </div>
      <div class="chips-line">
        <input type="text" inputmode="decimal" autocomplete="off" data-chips value="${esc(prefill)}"
               enterkeyhint="${i < players.length - 1 ? "next" : "done"}" placeholder="Chips value (${esc(s.symbol)})">
        <button class="btn small" data-colour>🪙 By colour</button>
      </div>
    </div>`;
  }).join("");
  const title = editing ? `Correct round ${rnd.number}` : `End round ${rnd.number} – count chips`;
  const sheet = openSheet(title,
    `<p class="hint">${editing ? "Correct the numbers for this finished round." : "Everybody counts their chips. Enter the VALUE of each player's chips,"}
      or tap <b>By colour</b> to enter how many chips of each colour they have.</p>
     ${rows}
     <div class="summary-box" data-summary></div>`,
    `<button class="btn red big wide" data-finish>${editing ? "Save changes" : "Finish round"}</button>`);

  const rowEl = (p) => $(`.count-row[data-i="${players.indexOf(p)}"]`, sheet);
  const chipInputs = $$("[data-chips]", sheet);

  function read() {
    const buyins = {};
    const chips = {};
    const problems = [];
    players.forEach((p) => {
      const row = rowEl(p);
      const b = Number($("[data-buyins]", row).value);
      if (!Number.isInteger(b) || b < 1) problems.push(`${p}: buy-ins must be a whole number of at least 1`);
      else buyins[p] = b;
      const text = $("[data-chips]", row).value.trim();
      if (!text) problems.push(`${p}: chips not entered`);
      else {
        try { chips[p] = parseMoney(text); } catch (err) { problems.push(`${p}: ${err.message}`); }
      }
    });
    return { buyins, chips, problems };
  }

  function update() {
    const { buyins, chips, problems } = read();
    const unit = rnd.buy_in_cents;
    players.forEach((p) => {
      const result = $("[data-result]", rowEl(p));
      if (p in buyins && p in chips) {
        const net = chips[p] - buyins[p] * unit;
        result.textContent = s.money(net, true);
        result.className = `result ${resultClass(net)}`;
      } else {
        result.textContent = "";
      }
      $("[data-colour]", rowEl(p)).textContent = breakdowns.has(p) ? "🪙 By colour ✓" : "🪙 By colour";
    });
    const totalIn = sum(Object.values(buyins)) * unit;
    const totalChips = sum(Object.values(chips));
    const diff = totalChips - totalIn;
    let status;
    let cls;
    if (problems.length) {
      status = "Fill in all chip counts…";
      cls = "";
    } else if (diff === 0) {
      status = "✔ Totals match!";
      cls = "win";
    } else {
      status = `✘ Difference: ${s.money(Math.abs(diff))} ${diff > 0 ? "too much" : "missing"} – please recount`;
      cls = "loss";
    }
    const box = $("[data-summary]", sheet);
    box.innerHTML = `Money bought in: ${esc(s.money(totalIn))}<br>Chips counted: ${esc(s.money(totalChips))}<br><span class="${cls}">${esc(status)}</span>`;
    $("[data-finish]", sheet).disabled = Boolean(problems.length) || diff !== 0;
  }

  sheet.addEventListener("input", (e) => {
    if (e.target.matches("[data-chips]")) {
      // Typing a different amount by hand makes the colour count out of date.
      const p = players[Number(e.target.closest(".count-row").dataset.i)];
      if (breakdowns.has(p)) {
        let typed = null;
        try { typed = parseMoney(e.target.value); } catch { /* not a number yet */ }
        if (typed !== Session.breakdownTotal(breakdowns.get(p))) breakdowns.delete(p);
      }
    }
    update();
  });
  sheet.addEventListener("keydown", (e) => {
    if (!e.target.matches("[data-chips]")) return;
    const index = chipInputs.indexOf(e.target);
    let target = null;
    if (e.key === "Enter" || e.key === "ArrowDown") target = chipInputs[index + 1];
    else if (e.key === "ArrowUp") target = chipInputs[index - 1];
    else return;
    e.preventDefault();
    if (target) {
      target.focus();
      target.select();
    } else if (e.key === "Enter") {
      e.target.blur();
    }
  });
  sheet.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (step) {
      const input = $("[data-buyins]", step.closest(".stepper"));
      input.value = Math.max(1, (Number(input.value) || 1) + Number(step.dataset.step));
      update();
      return;
    }
    const colourBtn = e.target.closest("[data-colour]");
    if (colourBtn) {
      const p = players[Number(colourBtn.closest(".count-row").dataset.i)];
      chipCountSheet(p, breakdowns.get(p), (breakdown) => {
        breakdowns.set(p, breakdown);
        $("[data-chips]", rowEl(p)).value = amountText(Session.breakdownTotal(breakdown));
        update();
      });
    }
  });
  $("[data-finish]", sheet).onclick = () => {
    const { buyins, chips, problems } = read();
    if (problems.length) return alert(problems.join("\n"));
    const chipCounts = Object.fromEntries([...breakdowns]
      .filter(([p, b]) => p in chips && Session.breakdownTotal(b) === chips[p]));
    const ok = editing
      ? run(() => s.editRound(rnd.number, chips, buyins, chipCounts), `Round ${rnd.number} corrected and saved`)
      : run(() => s.finishRound(chips, buyins, chipCounts), `Round ${rnd.number} finished and saved`);
    if (ok) {
      closeSheet(sheet.parentElement);
      if (!editing) roundResultsSheet(rnd);
    }
  };
  update();
}

function chipCountSheet(player, initial, onDone) {
  const s = session;
  const start = Object.fromEntries((initial || []).map((i) => [i.colour, i.count]));
  const values = s.chipValues;
  const sheet = openSheet(`${player}'s chips by colour`,
    values.map(([colour, cents], i) => `<div class="chip-row" data-i="${i}">
        ${chipIcon(colour)}
        <div class="label"><b>${esc(colour)}</b><small>× ${esc(s.money(cents))}</small></div>
        <div class="stepper">
          <button class="btn" data-step="-1" aria-label="One less">−</button>
          <input type="number" inputmode="numeric" min="0" data-count value="${start[colour] ?? 0}"
                 enterkeyhint="${i < values.length - 1 ? "next" : "done"}">
          <button class="btn" data-step="1" aria-label="One more">+</button>
        </div>
        <div class="sub" data-sub></div>
      </div>`).join(""),
    `<div class="inline" style="justify-content:space-between;margin-bottom:8px"><h2 data-total style="margin:0"></h2></div>
     <button class="btn red big wide" data-go>Use this total</button>`);
  const inputs = $$("[data-count]", sheet);

  function read() {
    const breakdown = [];
    const problems = [];
    values.forEach(([colour, cents], i) => {
      const text = inputs[i].value.trim() || "0";
      const count = Number(text);
      if (!Number.isInteger(count) || count < 0) problems.push(`${colour}: enter a whole number of chips`);
      else breakdown.push({ colour, count, cents });
    });
    return { breakdown, problems };
  }

  function update() {
    const { breakdown, problems } = read();
    values.forEach(([colour], i) => {
      const item = breakdown.find((b) => b.colour === colour);
      $(`.chip-row[data-i="${i}"] [data-sub]`, sheet).textContent = item ? s.money(item.count * item.cents) : "?";
    });
    $("[data-total]", sheet).textContent = `Total: ${s.money(Session.breakdownTotal(breakdown))}` +
      (problems.length ? " (check the counts)" : "");
  }

  sheet.addEventListener("input", update);
  sheet.addEventListener("focusin", (e) => { if (e.target.matches("[data-count]")) e.target.select(); });
  sheet.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (!step) return;
    const input = $("[data-count]", step.closest(".stepper"));
    input.value = Math.max(0, (Number(input.value) || 0) + Number(step.dataset.step));
    update();
  });
  sheet.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("[data-count]")) return;
    e.preventDefault();
    const next = inputs[inputs.indexOf(e.target) + 1];
    if (next) next.focus();
    else $("[data-go]", sheet).click();
  });
  $("[data-go]", sheet).onclick = () => {
    const { breakdown, problems } = read();
    if (problems.length) return alert(problems.join("\n"));
    closeSheet(sheet.parentElement);
    onDone(breakdown.filter((i) => i.count > 0));
  };
  update();
}

function roundResultsSheet(rnd) {
  const s = session;
  const net = Object.entries(Session.roundNet(rnd)).sort((a, b) => b[1] - a[1]);
  const sheet = openSheet(`Round ${rnd.number} results`,
    `${net.map(([p, n]) => `<div class="payment"><span class="who">${esc(p)}</span><span class="amount ${resultClass(n)}">${esc(s.money(n, true))}</span></div>`).join("")}
     <p class="hint">Everyone now resets to the starting chips for the next round.</p>`,
    `<button class="btn red big wide" data-close>OK</button>`);
  return sheet;
}

// ------------------------------------------------------------- time's up
function playBeeps() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const start = audio.currentTime;
    [0, 0.45, 0.9].forEach((offset) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.36);
    });
  } catch { /* sound is optional */ }
}

function timesUp() {
  navigator.vibrate?.([500, 200, 500, 200, 500]);
  playBeeps();
  if ($(".times-up")) return;
  const sheet = openSheet("Time's up!",
    `<div class="times-up">
       <div class="big-text">⏰ Time's up!</div>
       <p>Finish the hand, then everybody counts their chips.</p>
     </div>`,
    `<div class="btn-row spread">
       <button class="btn" data-more>+15 min</button>
       <button class="btn red" data-end>🏁 Count chips</button>
     </div>`);
  $("[data-more]", sheet).onclick = () => {
    closeSheet(sheet.parentElement);
    run(() => session.adjustClock(15), "15 minutes added");
  };
  $("[data-end]", sheet).onclick = () => {
    closeSheet(sheet.parentElement);
    if (session.activeRound) countSheet(session.activeRound, false);
  };
}

function alertedKeys() {
  try { return JSON.parse(localStorage.getItem(PREFIX + "alerted") || "[]"); } catch { return []; }
}

function updateClock() {
  const header = $("#hdr-clock");
  const rnd = session?.activeRound;
  if (!rnd) {
    header.textContent = "";
    return;
  }
  const left = Session.remainingSeconds(rnd);
  const paused = Session.clockPaused(rnd);
  const cls = paused ? "paused" : left <= 0 ? "up" : left <= 600 ? "warn" : "ok";
  const text = left > 0 ? `${formatClock(left)} left` : `TIME'S UP +${formatClock(left)}`;
  header.textContent = `⏱ ${text}${paused ? " (paused)" : ""}`;
  header.className = cls;
  const clock = $("#clock");
  if (clock) {
    clock.textContent = left > 0 ? formatClock(left) : "TIME'S UP";
    clock.className = `clock ${cls}`;
    $("#clock-sub").textContent = paused ? "paused" : left > 0 ? "left of the round" : `over time by ${formatClock(left)}`;
  }
  // Alert once per countdown (a new alert after the clock is changed and runs out again).
  const key = `${session.id}#${rnd.number}#${rnd.clock.started}#${rnd.clock.length_seconds}`;
  if (left <= 0 && !paused) {
    const done = alertedKeys();
    if (!done.includes(key)) {
      localStorage.setItem(PREFIX + "alerted", JSON.stringify([...done, key].slice(-30)));
      timesUp();
    }
  }
}

async function updateWakeLock() {
  const want = wakeWanted && Boolean(session?.activeRound) && document.visibilityState === "visible";
  try {
    if (want && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed right now (e.g. battery saver) */ }
}

// --------------------------------------------------------------- history
function roundTableHtml(rnd) {
  const s = session;
  const net = Session.roundNet(rnd);
  const rows = Object.entries(rnd.buyins).map(([p, n]) => `<tr>
      <td>${esc(p)}</td><td>${n}</td><td>${esc(s.money(n * rnd.buy_in_cents))}</td>
      <td>${p in rnd.chips ? esc(s.money(rnd.chips[p])) : "-"}</td>
      <td class="${p in net ? resultClass(net[p]) : ""}">${p in net ? esc(s.money(net[p], true)) : "-"}</td>
    </tr>`).join("");
  const chipValues = Object.values(rnd.chips || {});
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>Player</th><th>Buy-ins</th><th>Paid in</th><th>Chips</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>Total</td><td>${sum(Object.values(rnd.buyins))}</td><td>${esc(s.money(Session.roundTotalIn(rnd)))}</td>
      <td>${chipValues.length ? esc(s.money(sum(chipValues))) : "-"}</td><td></td></tr></tfoot>
  </table></div>`;
}

function chipCountsHtml(rnd) {
  const counts = rnd.chip_counts || {};
  if (!Object.keys(counts).length) return "";
  const s = session;
  const columns = [];
  for (const breakdown of Object.values(counts)) {
    for (const item of breakdown) {
      if (!columns.some(([c, v]) => c === item.colour && v === item.cents)) columns.push([item.colour, item.cents]);
    }
  }
  const rows = Object.entries(counts).map(([p, breakdown]) => `<tr><td>${esc(p)}</td>${columns.map(([c, v]) =>
    `<td>${breakdown.find((i) => i.colour === c && i.cents === v)?.count ?? ""}</td>`).join("")}
    <td>${esc(s.money(Session.breakdownTotal(breakdown)))}</td></tr>`).join("");
  return `<h3 style="margin-top:12px">Chips by colour</h3><div class="table-wrap"><table class="data">
    <thead><tr><th>Player</th>${columns.map(([c, v]) => `<th>${esc(c)}<br><small>${esc(s.money(v))}</small></th>`).join("")}<th>Total</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function viewHistory() {
  const s = session;
  if (!s.rounds.length) return `<div class="card center"><h2>No rounds yet</h2><p class="hint">Finished rounds show up here so you can double-check them.</p></div>`;
  const cards = [...s.rounds].reverse().map((rnd) => {
    const net = Session.roundNet(rnd);
    const best = Object.entries(net).sort((a, b) => b[1] - a[1])[0];
    const status = rnd.status === "active" ? `<span class="tag">in progress</span>`
      : rnd.edits?.length ? `<span class="tag">corrected</span>` : "";
    const timeline = (rnd.history || []).map((h) =>
      `<li>${esc(h.time.slice(11))} – ${esc(h.player)}: ${h.change > 0 ? "re-buy" : "UNDO re-buy"}</li>`).join("");
    return `<details class="card round-card" data-round="${rnd.number}" ${openRounds.has(rnd.number) ? "open" : ""}>
      <summary>
        <div class="title"><span>Round ${rnd.number}</span>${status}</div>
        <div class="meta">${esc(rnd.started.slice(0, 16))}${rnd.ended ? ` – ${esc(rnd.ended.slice(11, 16))}` : ""} ·
          ${plural(Object.keys(rnd.buyins).length, "player")} · ${esc(s.money(Session.roundTotalIn(rnd)))} in play</div>
        ${best ? `<div class="meta">Biggest winner: <b class="win">${esc(best[0])} (${esc(s.money(best[1], true))})</b></div>` : ""}
      </summary>
      <p class="hint">Buy-in ${esc(s.money(rnd.buy_in_cents))}${rnd.edits?.length ? ` · corrected at ${esc(rnd.edits.join(", "))}` : ""}</p>
      ${roundTableHtml(rnd)}
      ${chipCountsHtml(rnd)}
      ${timeline ? `<h3 style="margin-top:12px">Re-buy timeline</h3><ul class="hint">${timeline}</ul>` : ""}
      ${rnd.status === "finished" ? `<button class="btn wide" style="margin-top:12px" data-action="edit-round" data-round="${rnd.number}">✏ Correct this round</button>` : ""}
    </details>`;
  }).join("");
  return `${cards}<button class="btn wide" data-action="share-report">Share full report</button>`;
}

// ---------------------------------------------------------------- settle
function paymentLines() {
  const payments = session.settlement();
  if (!payments.length) return ["Nobody owes anybody anything (yet)."];
  return payments.map(([a, b, amount]) => `${a}  pays  ${b}   ${session.money(amount)}`);
}

function viewSettle() {
  const s = session;
  const totals = [...s.totals()].sort((a, b) => b[1].net - a[1].net);
  const rows = totals.map(([p, t]) => `<tr><td>${esc(p)}</td><td>${t.rounds}</td><td>${t.buyins}</td>
      <td>${esc(s.money(t.paid_in))}</td><td>${esc(s.money(t.cashed_out))}</td>
      <td class="${resultClass(t.net)}">${esc(s.money(t.net, true))}</td></tr>`).join("");
  const payments = s.settlement();
  const paymentHtml = payments.length
    ? payments.map(([a, b, amount]) => `<div class="payment">
        <span class="who">${esc(a)}<span class="arrow">→</span>${esc(b)}</span>
        <span class="amount">${esc(s.money(amount))}</span></div>`).join("")
    : `<p class="hint">Nobody owes anybody anything (yet).</p>`;
  return `
    <section>
      <h2>Totals over all finished rounds</h2>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Player</th><th>Rounds</th><th>Buy-ins</th><th>Paid in</th><th>Cashed</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>
    <section>
      <h2>Payments to settle up</h2>
      <p class="hint">The fewest payments possible. "A → B" means A pays B.</p>
      ${paymentHtml}
      ${s.activeRound ? `<p class="hint">Note: the round in progress is not included until it is finished.</p>` : ""}
    </section>
    <div class="btn-row spread">
      <button class="btn" data-action="copy-payments">Copy payments</button>
      <button class="btn" data-action="share-payments">Share payments</button>
    </div>
    <button class="btn wide" data-action="share-report">Share full report</button>`;
}

// -------------------------------------------------------------- settings
function chipEditorHtml(values) {
  const row = ([colour, cents]) => `<div class="chip-value-row">
      ${chipIcon(colour)}
      <input type="text" data-cv-name value="${esc(colour)}" placeholder="Colour" autocomplete="off">
      <input type="text" inputmode="decimal" data-cv-value value="${esc(cents === "" ? "" : amountText(cents))}" placeholder="Value">
      <button class="btn small ghost" data-cv-remove aria-label="Remove colour">✕</button>
    </div>`;
  return `<div data-chip-editor>${values.map(row).join("")}
    <template data-cv-template>${row(["", ""])}</template>
    <button class="btn small" data-cv-add>+ Add colour</button></div>`;
}

function wireChipEditor(root) {
  const editor = $("[data-chip-editor]", root);
  editor.addEventListener("click", (e) => {
    if (e.target.closest("[data-cv-remove]")) e.target.closest(".chip-value-row").remove();
    if (e.target.closest("[data-cv-add]")) {
      const fragment = $("[data-cv-template]", editor).content.cloneNode(true);
      editor.insertBefore(fragment, $("[data-cv-add]", editor));
    }
  });
  editor.addEventListener("input", (e) => {
    if (!e.target.matches("[data-cv-name]")) return;
    const icon = e.target.closest(".chip-value-row").querySelector(".chip-icon");
    icon.outerHTML = chipIcon(e.target.value);
  });
}

function readChipEditor(root) {
  const values = [];
  for (const row of $$(".chip-value-row", $("[data-chip-editor]", root))) {
    if (row.closest("template")) continue;
    const name = $("[data-cv-name]", row).value.trim();
    const value = $("[data-cv-value]", row).value.trim();
    if (!name && !value) continue;
    if (!name) throw new PokerError("Every chip value needs a colour name");
    let cents;
    try { cents = parseMoney(value); } catch (err) { throw new PokerError(`${name}: ${err.message}`); }
    values.push([name, cents]);
  }
  return validateChipValues(values);
}

function viewSettings() {
  const s = session;
  const finished = s.rounds.filter((r) => r.status === "finished").length;
  const log = store.readLog(s.id).split("\n").filter(Boolean).reverse().slice(0, 300).join("\n");
  return `
    <section class="card">
      <h2>Session</h2>
      <p>${esc(s.id)}</p>
      <p class="hint">Started ${esc(s.data.created)} · ${plural(finished, "finished round")}<br>Everything is saved on this phone after every tap.</p>
      <div class="btn-row spread">
        <button class="btn" data-action="sessions">📂 Sessions</button>
        <button class="btn red" data-action="new-session">New session</button>
      </div>
    </section>

    <section class="card">
      <h2>Players</h2>
      <ul class="player-list">${s.players.map((p) => `<li>${esc(p)}</li>`).join("") || `<li class="hint">No players yet</li>`}</ul>
      <div class="inline">
        <input type="text" id="new-player" placeholder="New player name" autocomplete="off" enterkeyhint="done">
        <button class="btn" data-action="add-player">Add</button>
      </div>
    </section>

    <section class="card">
      <h2>Settings</h2>
      <label class="field"><span>Buy-in amount per round (${esc(s.symbol)})</span>
        <div class="inline"><input type="text" inputmode="decimal" id="buy-in" value="${esc(amountText(s.buyIn))}">
        <button class="btn" data-action="save-buy-in">Save</button></div></label>
      <label class="field"><span>Round length</span>
        <div class="inline" id="round-length">${timeInputHtml(s.roundMinutes)}<button class="btn" data-action="save-round-length">Save</button></div></label>
      <p class="hint">New buy-in amount and round length apply from the next round.</p>
    </section>

    <section class="card" id="chip-values">
      <h2>Chip values</h2>
      <p class="hint">Used when counting a player's chips by colour.</p>
      ${chipEditorHtml(s.chipValues)}
      <button class="btn wide" style="margin-top:10px" data-action="save-chip-values">Save chip values</button>
    </section>

    <section class="card">
      <h2>Phone ⇄ computer</h2>
      <p class="hint">The session file works in the desktop program too
        (Session → Import session file). Use it to move a session or keep a backup.</p>
      <div class="btn-row spread">
        <button class="btn" data-action="export">⬇ Export file</button>
        <button class="btn" data-action="import">⬆ Import file</button>
      </div>
    </section>

    <section class="card">
      <details><summary><b>Activity log</b> <span class="hint">(every tap, newest first)</span></summary>
        <pre class="log">${esc(log) || "Nothing yet."}</pre>
      </details>
    </section>

    <section class="card">
      <h2>Delete</h2>
      <p class="hint">Removes this session from the phone. Export it first if you want to keep it.</p>
      <button class="btn wide" data-action="delete-session">🗑 Delete this session</button>
    </section>`;
}

function wireSettings() {
  wireChipEditor($("#chip-values"));
  $("#new-player").addEventListener("keydown", (e) => {
    if (e.key === "Enter") actions["add-player"]();
  });
}

function newSessionSheet() {
  const prev = session;
  const sheet = openSheet("New poker session",
    `<label class="field"><span>Buy-in amount per round</span>
       <input type="text" inputmode="decimal" data-buy-in value="${esc(prev ? amountText(prev.buyIn) : "100")}"></label>
     <label class="field"><span>Currency symbol</span>
       <input type="text" data-symbol value="${esc(prev ? prev.symbol : "$")}"></label>
     <label class="field"><span>Round length</span>${timeInputHtml(prev ? prev.roundMinutes : DEFAULT_ROUND_MINUTES)}</label>
     <label class="field"><span>Players (one name per line)</span>
       <textarea data-players autocomplete="off">${esc(prev ? prev.players.join("\n") : "")}</textarea></label>
     <p class="hint">You can also add players later.</p>
     <h3 style="margin-top:14px">Chip values</h3>
     ${chipEditorHtml(prev ? prev.chipValues : DEFAULT_CHIP_VALUES)}`,
    `<button class="btn red big wide" data-go>Create session</button>`);
  wireChipEditor(sheet);
  $("[data-go]", sheet).onclick = () => {
    try {
      const cents = parseMoney($("[data-buy-in]", sheet).value);
      if (cents <= 0) throw new PokerError("Buy-in must be more than 0");
      const minutes = readTimeInput(sheet);
      if (minutes < 1) throw new PokerError("The round must be at least 1 minute long");
      const chipValues = readChipEditor(sheet);
      const names = $("[data-players]", sheet).value.split("\n").map((n) => n.trim()).filter(Boolean);
      const lowered = names.map((n) => n.toLowerCase());
      if (new Set(lowered).size !== lowered.length) throw new PokerError("Two players have the same name.");
      const symbol = $("[data-symbol]", sheet).value.trim() || "$";
      const id = store.uniqueId(sessionIdFromCreated(nowStr()));
      const created = Session.create(id, cents, names, symbol, minutes, chipValues, hooks);
      setSession(created);
    } catch (err) {
      if (err instanceof PokerError) return alert(err.message);
      throw err;
    }
    closeSheet(sheet.parentElement);
    currentTab = session.players.length < 2 ? "settings" : "round";
    render();
    toast("New session created");
  };
}

function sessionsSheet() {
  const saved = store.list();
  const items = saved.map(({ id, updated, data }) => {
    const finished = data.rounds.filter((r) => r.status === "finished").length;
    const last = data.rounds[data.rounds.length - 1];
    const status = last?.status === "active" ? `Round ${last.number} in progress` : finished ? "Between rounds" : "Not started";
    return `<button class="btn ghost session-item ${session?.id === id ? "current" : ""}" data-id="${esc(id)}">
      <b>${esc(data.created.slice(0, 16))}</b>${session?.id === id ? " (open now)" : ""}<br>
      <span class="hint">${esc(status)} · ${plural(finished, "round")} · saved ${esc(updated.slice(0, 16))}<br>${esc(data.players.join(", "))}</span>
    </button>`;
  }).join("");
  const sheet = openSheet("Sessions",
    `${items || `<p class="hint">No saved sessions on this phone yet.</p>`}`,
    `<div class="btn-row spread">
      <button class="btn" data-import>⬆ Import file</button>
      <button class="btn red" data-new>New session</button>
     </div>`);
  $$("[data-id]", sheet).forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      const data = store.load(id);
      if (!data) return alert("This session could not be loaded.");
      setSession(new Session(data, id, hooks));
      closeSheet(sheet.parentElement);
      currentTab = "round";
      render();
      toast(`Continuing session from ${data.created.slice(0, 16)}`);
    };
  });
  $("[data-import]", sheet).onclick = () => { closeSheet(sheet.parentElement); $("#import-file").click(); };
  $("[data-new]", sheet).onclick = () => { closeSheet(sheet.parentElement); newSessionSheet(); };
}

function exportSession() {
  const s = session;
  const blob = new Blob([JSON.stringify(s.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${s.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  s.log(`Session exported to ${s.id}.json`);
  toast(`Saved ${s.id}.json to Downloads`);
}

async function importSession(file) {
  let data;
  try {
    data = Session.validateData(JSON.parse(await file.text()));
  } catch (err) {
    alert(`Could not import ${file.name}:\n${err instanceof PokerError ? err.message : "the file is not valid JSON"}`);
    return;
  }
  let id = sessionIdFromCreated(data.created || nowStr());
  if (store.exists(id)) {
    const replace = confirm(`This phone already has the session from ${data.created || id}.\n\n` +
      "OK = replace it with the imported file (the current version is kept as a backup)\n" +
      "Cancel = keep both (import as a copy)");
    if (!replace) id = store.uniqueId(id);
  }
  const imported = new Session(data, id, hooks);
  try {
    imported.save();
  } catch (err) {
    alert(`Saving the imported session failed: ${err.message}`);
    return;
  }
  imported.log(`Imported from file ${file.name}`);
  setSession(imported);
  currentTab = "round";
  render();
  toast("Session imported");
}

// ================================================================ actions
const actions = {
  "new-session": () => newSessionSheet(),
  sessions: () => sessionsSheet(),
  import: () => $("#import-file").click(),
  export: () => exportSession(),
  "start-round": () => startRoundSheet(),
  buyin: (el) => {
    const p = roundPlayer(el);
    navigator.vibrate?.(30);
    run(() => session.addBuyin(p), `${p} bought in again`);
  },
  "undo-buyin": (el) => {
    const p = roundPlayer(el);
    if (confirm(`Remove one buy-in from ${p}?`)) run(() => session.undoBuyin(p), `Removed a buy-in from ${p}`);
  },
  "toggle-pause": () => {
    if (Session.clockPaused(session.activeRound)) run(() => session.resumeClock(), "Clock resumed");
    else run(() => session.pauseClock(), "Clock paused");
  },
  "clock-adjust": (el) => {
    const m = Number(el.dataset.min);
    run(() => session.adjustClock(m), `${Math.abs(m)} minutes ${m > 0 ? "added" : "removed"}`);
  },
  "set-time": () => setTimeSheet(),
  "reset-clock": () => {
    const rnd = session.activeRound;
    if (confirm(`Start the clock over from ${formatMinutes(Session.roundLength(rnd))}?`)) {
      run(() => session.resetClock(), `Clock reset to ${formatMinutes(Session.roundLength(rnd))}`);
    }
  },
  "end-round": () => countSheet(session.activeRound, false),
  "add-to-round": () => addToRoundSheet(),
  "cancel-round": () => {
    const rnd = session.activeRound;
    if (confirm(`Really cancel round ${rnd.number}?\nAll buy-ins for this round will be removed (it is still written in the activity log).`)) {
      run(() => session.cancelRound(), `Round ${rnd.number} cancelled`);
    }
  },
  "edit-round": (el) => countSheet(session.getRound(Number(el.dataset.round)), true),
  "copy-payments": async () => {
    await copyText(`Poker settle-up:\n${paymentLines().join("\n")}`);
    toast("Payments copied");
  },
  "share-payments": () => shareText("Poker settle-up", `Poker settle-up:\n${paymentLines().join("\n")}`),
  "share-report": () => shareText("Poker session report", session.reportText()),
  "add-player": () => {
    const input = $("#new-player");
    const name = input.value.trim();
    if (!name) return;
    const join = session.activeRound ? confirm(`Should ${name} join the current round now (with 1 buy-in)?`) : false;
    run(() => session.addPlayer(name, join), `Player ${name} added`);
  },
  "save-buy-in": () => {
    let cents;
    try { cents = parseMoney($("#buy-in").value); } catch (err) { return alert(err.message); }
    if (cents !== session.buyIn) run(() => session.setBuyIn(cents), `Buy-in changed to ${session.money(cents)}`);
  },
  "save-round-length": () => {
    let minutes;
    try { minutes = readTimeInput($("#round-length")); } catch (err) { return alert(err.message); }
    if (minutes !== session.roundMinutes) {
      run(() => session.setRoundMinutes(minutes), `Round length changed to ${formatMinutes(minutes)} (from the next round)`);
    }
  },
  "save-chip-values": () => {
    let values;
    try { values = readChipEditor($("#chip-values")); } catch (err) { return alert(err.message); }
    run(() => session.setChipValues(values), "Chip values saved");
  },
  "delete-session": () => {
    if (!confirm(`Delete the session from ${session.data.created} from this phone?\nThis cannot be undone.`)) return;
    store.remove(session.id);
    setSession(null);
    const next = store.list()[0];
    if (next) setSession(new Session(next.data, next.id, hooks));
    currentTab = "round";
    render();
    toast("Session deleted");
  },
};

// ================================================================== start
document.addEventListener("click", (e) => {
  const tabButton = e.target.closest("#tabbar [data-tab]");
  if (tabButton) return switchTab(tabButton.dataset.tab);
  const el = e.target.closest("#view [data-action]");
  if (el && !el.disabled) actions[el.dataset.action]?.(el, e);
});

document.addEventListener("change", (e) => {
  if (e.target.id === "wake") {
    wakeWanted = e.target.checked;
    localStorage.setItem(PREFIX + "wake", wakeWanted ? "1" : "0");
    updateWakeLock();
  }
});

// Track which rounds are expanded in the history so a redraw keeps them open.
document.addEventListener("toggle", (e) => {
  const card = e.target.closest?.(".round-card");
  if (!card) return;
  const n = Number(card.dataset.round);
  if (card.open) openRounds.add(n);
  else openRounds.delete(n);
}, true);

// Browsers only allow sound after the user has touched the page.
document.addEventListener("pointerdown", () => {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* sound is optional */ }
}, { once: true });

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await importSession(file);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") updateClock();
  updateWakeLock();
});

function start() {
  const last = store.last();
  const data = last ? store.load(last) : null;
  if (data) setSession(new Session(data, last, hooks));
  render();
  setInterval(updateClock, 1000);
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

start();
