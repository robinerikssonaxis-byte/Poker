// Core logic for Poker Night (no UI code here).
// A JavaScript port of poker_logic.py. Session data uses exactly the same JSON
// format as the desktop program, so session files can be moved between them.
// All money is stored as integer cents.

export const DATA_VERSION = 1;
export const DEFAULT_ROUND_MINUTES = 90;
export const DEFAULT_CHIP_VALUES = [["White", 100], ["Red", 200], ["Green", 500], ["Blue", 1000], ["Black", 1000]];

export class PokerError extends Error {}

// ------------------------------------------------------------------- time
const pad = (n) => String(n).padStart(2, "0");

export function formatTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function parseTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || "");
  if (!m) throw new PokerError(`Invalid time '${text}'`);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

let nowProvider = () => new Date();
/** Tests can replace the clock. */
export function setNowProvider(fn) { nowProvider = fn; }
export const now = () => nowProvider();
export const nowStr = () => formatTime(now());

/** Seconds as H:MM:SS (negative values are shown without the sign). */
export function formatClock(seconds) {
  const s = Math.trunc(Math.abs(seconds));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 90 -> '1 h 30 min', 120 -> '2 h', 45 -> '45 min'. */
export function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours && mins) return `${hours} h ${mins} min`;
  return hours ? `${hours} h` : `${mins} min`;
}

// ------------------------------------------------------------------ money
/** Parse '100', '12.50', '1,000 $', '$1,000' or '50 kr' into cents. */
export function parseMoney(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") throw new PokerError("Please enter an amount");
  const cleaned = raw.replace(/[, ]/g, "").replace(/^[^\d.-]+|[^\d.]+$/g, "");
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m || (m[2] === "" && !m[3])) throw new PokerError(`'${text}' is not a valid amount`);
  const fraction = (m[3] || "").replace(/0+$/, "");
  const cents = Number(m[2] || "0") * 100 + Number(fraction.padEnd(2, "0") || "0");
  if (m[1] && cents > 0) throw new PokerError("Amount cannot be negative");
  if (fraction.length > 2) throw new PokerError(`'${text}' has more than 2 decimals`);
  return cents;
}

const withThousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The number only, e.g. '1,250' or '12.50' (no sign, no currency symbol). */
export function amountText(cents) {
  const value = Math.abs(cents);
  if (value % 100 === 0) return withThousands(value / 100);
  return `${withThousands(Math.floor(value / 100))}.${pad(value % 100)}`;
}

/** '100 $', '-12.50 $' or (signed) '+100 $'. */
export function fmt(cents, symbol = "$", signed = false) {
  const sign = cents < 0 ? "-" : signed && cents > 0 ? "+" : "";
  return `${sign}${amountText(cents)} ${symbol}`;
}

/** Plain-text table, columns as wide as their longest value (first column left-aligned). */
export function textTable(headers, rows, footer = null, indent = "", gap = 4) {
  const body = rows.map((r) => r.map(String));
  const foot = footer ? footer.map(String) : null;
  const all = [headers, ...body, ...(foot ? [foot] : [])];
  const widths = headers.map((_, i) => Math.max(...all.filter((r) => i < r.length).map((r) => r[i].length)));
  const line = (cells) => (indent + [cells[0].padEnd(widths[0]),
    ...cells.slice(1).map((c, i) => c.padStart(widths[i + 1]))].join(" ".repeat(gap))).trimEnd();
  const rule = indent + "-".repeat(widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1));
  const out = [line(headers), rule, ...body.map(line)];
  if (foot) out.push(rule, line(foot));
  return out;
}

export function validateChipValues(values) {
  const cleaned = [];
  for (const [rawColour, rawCents] of values) {
    const colour = String(rawColour).split(/\s+/).filter(Boolean).join(" ");
    const cents = Math.trunc(Number(rawCents));
    if (!colour) throw new PokerError("Every chip colour needs a name");
    if (!(cents > 0)) throw new PokerError(`The value of ${colour} chips must be more than 0`);
    if (cleaned.some(([c]) => c.toLowerCase() === colour.toLowerCase())) {
      throw new PokerError(`The chip colour '${colour}' is listed twice`);
    }
    cleaned.push([colour, cents]);
  }
  if (!cleaned.length) throw new PokerError("Add at least one chip colour");
  return cleaned;
}

/** Session id like the desktop folder name: session_2026-11-24_134642. */
export function sessionIdFromCreated(created) {
  return "session_" + String(created).slice(0, 19).replace(" ", "_").replace(/:/g, "");
}

// ---------------------------------------------------------------- session
export class Session {
  /**
   * @param {object} data   session data (same format as the desktop's session_data.json)
   * @param {string} id     storage id / name of the session
   * @param {object} hooks  {save(session), log(session, line)}
   */
  constructor(data, id, hooks = {}) {
    this.data = data;
    this.id = id;
    this.hooks = hooks;
  }

  static create(id, buyInCents, players, symbol = "$", roundMinutes = DEFAULT_ROUND_MINUTES,
    chipValues = null, hooks = {}) {
    if (!(buyInCents > 0)) throw new PokerError("Buy-in must be more than 0");
    if (!(roundMinutes >= 1)) throw new PokerError("Round length must be at least 1 minute");
    const chips = validateChipValues(chipValues || DEFAULT_CHIP_VALUES);
    const data = {
      version: DATA_VERSION,
      created: nowStr(),
      buy_in_cents: buyInCents,
      symbol,
      round_minutes: roundMinutes,
      chip_values: chips.map(([colour, cents]) => ({ colour, cents })),
      players: [],
      rounds: [],
    };
    const session = new Session(data, id ?? sessionIdFromCreated(data.created), hooks);
    for (const name of players) session._addPlayerName(name);
    session.log(`New session created. Buy-in ${session.money(buyInCents)}. ` +
      `Round length ${formatMinutes(roundMinutes)}. Chip values: ${session.chipValuesText()}. ` +
      `Players: ${session.players.join(", ") || "(none)"}`);
    session.save();
    return session;
  }

  /** Check that parsed JSON looks like a session file. */
  static validateData(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.players) || !Array.isArray(data.rounds)) {
      throw new PokerError("This is not a poker session file (players or rounds are missing)");
    }
    if (!(data.buy_in_cents > 0)) throw new PokerError("This session file has no valid buy-in");
    return data;
  }

  save() { this.hooks.save?.(this); }

  log(message) { this.hooks.log?.(this, `[${nowStr()}] ${message}`); }

  // --------------------------------------------------------------- helpers
  get symbol() { return this.data.symbol ?? "$"; }
  get buyIn() { return this.data.buy_in_cents; }
  get players() { return this.data.players; }
  get rounds() { return this.data.rounds; }
  money(cents, signed = false) { return fmt(cents, this.symbol, signed); }

  get activeRound() {
    const last = this.rounds[this.rounds.length - 1];
    return last && last.status === "active" ? last : null;
  }

  getRound(number) {
    const rnd = this.rounds.find((r) => r.number === number);
    if (!rnd) throw new PokerError(`Round ${number} not found`);
    return rnd;
  }

  // --------------------------------------------------------------- players
  _addPlayerName(name) {
    name = String(name).split(/\s+/).filter(Boolean).join(" ");
    if (!name) throw new PokerError("Player name cannot be empty");
    if (this.players.some((p) => p.toLowerCase() === name.toLowerCase())) {
      throw new PokerError(`There is already a player called '${name}'`);
    }
    this.players.push(name);
    return name;
  }

  addPlayer(name, joinActiveRound = false) {
    name = this._addPlayerName(name);
    this.log(`Player added: ${name}`);
    const rnd = this.activeRound;
    if (joinActiveRound && rnd) {
      rnd.buyins[name] = 1;
      this.log(`Round ${rnd.number}: ${name} joined with 1 buy-in`);
    }
    this.save();
    return name;
  }

  setBuyIn(cents) {
    if (!(cents > 0)) throw new PokerError("Buy-in must be more than 0");
    if (this.activeRound) throw new PokerError("Finish the current round before changing the buy-in amount");
    const old = this.buyIn;
    this.data.buy_in_cents = cents;
    this.log(`Buy-in changed from ${this.money(old)} to ${this.money(cents)} (applies to new rounds)`);
    this.save();
  }

  get roundMinutes() { return this.data.round_minutes ?? DEFAULT_ROUND_MINUTES; }

  setRoundMinutes(minutes) {
    if (!(minutes >= 1)) throw new PokerError("Round length must be at least 1 minute");
    const old = this.roundMinutes;
    this.data.round_minutes = minutes;
    this.log(`Round length changed from ${formatMinutes(old)} to ${formatMinutes(minutes)} (applies to new rounds)`);
    this.save();
  }

  // ----------------------------------------------------------- chip values
  /** [[colour, cents], ...] in display order. */
  get chipValues() {
    const stored = this.data.chip_values;
    if (!stored || !stored.length) return DEFAULT_CHIP_VALUES.map((v) => [...v]);
    return stored.map((c) => [c.colour, c.cents]);
  }

  chipValuesText() { return this.chipValues.map(([c, v]) => `${c} ${this.money(v)}`).join(", "); }

  setChipValues(values) {
    values = validateChipValues(values);
    const old = this.chipValuesText();
    this.data.chip_values = values.map(([colour, cents]) => ({ colour, cents }));
    this.log(`Chip values changed from [${old}] to [${this.chipValuesText()}]`);
    this.save();
  }

  /** Total value of a per-colour count: [{colour, count, cents}, ...]. */
  static breakdownTotal(breakdown) {
    return breakdown.reduce((sum, item) => sum + item.count * item.cents, 0);
  }

  _applyChipCounts(rnd, chips, chipCounts) {
    const counts = {};
    for (const [player, raw] of Object.entries(chipCounts || {})) {
      if (!(player in chips)) throw new PokerError(`${player} is not in this round`);
      const breakdown = raw
        .map((i) => ({ colour: i.colour, count: Math.trunc(Number(i.count)), cents: Math.trunc(Number(i.cents)) }))
        .filter((i) => i.count > 0);
      if (breakdown.some((i) => !(i.cents > 0))) throw new PokerError(`Invalid chip count for ${player}`);
      if (Session.breakdownTotal(breakdown) !== chips[player]) {
        throw new PokerError(`${player}'s chips by colour (${this.money(Session.breakdownTotal(breakdown))}) ` +
          `do not match the amount entered (${this.money(chips[player])})`);
      }
      counts[player] = breakdown;
    }
    if (Object.keys(counts).length) rnd.chip_counts = counts;
    else delete rnd.chip_counts;
  }

  chipCountTable(rnd, indent = "") {
    const counts = rnd.chip_counts || {};
    if (!Object.keys(counts).length) return [];
    const columns = [];
    for (const breakdown of Object.values(counts)) {
      for (const item of breakdown) {
        if (!columns.some(([c, v]) => c === item.colour && v === item.cents)) columns.push([item.colour, item.cents]);
      }
    }
    const rows = Object.entries(counts).map(([player, breakdown]) => [
      player,
      ...columns.map(([c, v]) => breakdown.find((i) => i.colour === c && i.cents === v)?.count ?? ""),
      this.money(Session.breakdownTotal(breakdown)),
    ]);
    const headers = ["Chips by colour", ...columns.map(([c, v]) => `${c} (${this.money(v)})`), "Total"];
    return textTable(headers, rows, null, indent);
  }

  // ----------------------------------------------------------------- clock
  // rnd.duration_minutes is the length the round was started with (used by "reset").
  // rnd.clock is the running countdown: it started at clock.started with clock.length_seconds
  // on it; paused time is added back via clock.paused_seconds.
  static clock(rnd) {
    const clock = rnd.clock ?? (rnd.clock = {});
    clock.started ??= rnd.started;
    clock.length_seconds ??= (rnd.duration_minutes ?? DEFAULT_ROUND_MINUTES) * 60;
    clock.paused_seconds ??= 0;
    clock.paused_at ??= null;
    return clock;
  }

  /** Seconds left on the round clock; negative once time is up. Paused time doesn't count. */
  static remainingSeconds(rnd, at = null) {
    const clock = Session.clock(rnd);
    const current = clock.paused_at ? parseTime(clock.paused_at) : (at ?? now());
    const elapsed = (current - parseTime(clock.started)) / 1000;
    return clock.length_seconds + clock.paused_seconds - elapsed;
  }

  static roundLength(rnd) { return rnd.duration_minutes ?? DEFAULT_ROUND_MINUTES; }

  static clockPaused(rnd) { return Boolean(Session.clock(rnd).paused_at); }

  pauseClock() {
    const rnd = this._requireActive();
    const clock = Session.clock(rnd);
    if (clock.paused_at) return;
    clock.paused_at = nowStr();
    this.log(`Round ${rnd.number}: clock paused with ${formatClock(Session.remainingSeconds(rnd))} left`);
    this.save();
  }

  resumeClock() {
    const rnd = this._requireActive();
    const clock = Session.clock(rnd);
    if (!clock.paused_at) return;
    const pausedFor = (now() - parseTime(clock.paused_at)) / 1000;
    clock.paused_seconds += Math.trunc(pausedFor);
    clock.paused_at = null;
    this.log(`Round ${rnd.number}: clock resumed after a ${formatClock(pausedFor)} pause`);
    this.save();
  }

  adjustClock(minutes) {
    const rnd = this._requireActive();
    Session.clock(rnd).length_seconds += minutes * 60;
    this.log(`Round ${rnd.number}: ${minutes > 0 ? "+" : ""}${minutes} minutes on the clock, ` +
      `now ${formatClock(Session.remainingSeconds(rnd))} left`);
    this.save();
  }

  /** Restart the countdown with exactly this many minutes left (keeps it paused if it was). */
  setTimeLeft(minutes) {
    if (minutes < 0) throw new PokerError("Time left cannot be negative");
    const rnd = this._requireActive();
    const paused = Session.clockPaused(rnd);
    const stamp = nowStr();
    rnd.clock = { started: stamp, length_seconds: minutes * 60, paused_seconds: 0, paused_at: paused ? stamp : null };
    this.log(`Round ${rnd.number}: clock set to ${formatMinutes(minutes)} left`);
    this.save();
  }

  /** Start the countdown over from the round's full length. */
  resetClock() {
    this.setTimeLeft(Session.roundLength(this._requireActive()));
  }

  // ---------------------------------------------------------------- rounds
  startRound(participants) {
    if (this.activeRound) throw new PokerError("A round is already in progress");
    if (participants.length < 2) throw new PokerError("At least 2 players are needed to start a round");
    for (const p of participants) {
      if (!this.players.includes(p)) throw new PokerError(`Unknown player '${p}'`);
    }
    const rnd = {
      number: this.rounds.length + 1,
      started: nowStr(),
      ended: null,
      status: "active",
      buy_in_cents: this.buyIn,
      duration_minutes: this.roundMinutes,
      buyins: Object.fromEntries(participants.map((p) => [p, 1])),
      chips: {},
      history: [],
    };
    Session.clock(rnd);
    this.rounds.push(rnd);
    this.log(`Round ${rnd.number} started. Buy-in ${this.money(this.buyIn)}. ` +
      `Length ${formatMinutes(this.roundMinutes)}. Players: ${participants.join(", ")}`);
    this.save();
    return rnd;
  }

  addToRound(player) {
    const rnd = this._requireActive();
    if (!this.players.includes(player)) throw new PokerError(`Unknown player '${player}'`);
    if (player in rnd.buyins) throw new PokerError(`${player} is already in this round`);
    rnd.buyins[player] = 1;
    this.log(`Round ${rnd.number}: ${player} joined with 1 buy-in`);
    this.save();
  }

  addBuyin(player) {
    const rnd = this._requireActive();
    if (!(player in rnd.buyins)) throw new PokerError(`${player} is not in this round`);
    rnd.buyins[player] += 1;
    rnd.history.push({ time: nowStr(), player, change: +1 });
    this.log(`Round ${rnd.number}: ${player} re-bought (now ${rnd.buyins[player]} buy-ins)`);
    this.save();
    return rnd.buyins[player];
  }

  undoBuyin(player) {
    const rnd = this._requireActive();
    if (!(player in rnd.buyins)) throw new PokerError(`${player} is not in this round`);
    if (rnd.buyins[player] <= 1) throw new PokerError(`${player} only has the starting buy-in`);
    rnd.buyins[player] -= 1;
    rnd.history.push({ time: nowStr(), player, change: -1 });
    this.log(`Round ${rnd.number}: UNDO buy-in for ${player} (now ${rnd.buyins[player]} buy-ins)`);
    this.save();
    return rnd.buyins[player];
  }

  cancelRound() {
    const rnd = this._requireActive();
    this.rounds.pop();
    this.log(`Round ${rnd.number} CANCELLED (buy-ins were ${JSON.stringify(rnd.buyins)})`);
    this.save();
  }

  _requireActive() {
    const rnd = this.activeRound;
    if (!rnd) throw new PokerError("No round is in progress");
    return rnd;
  }

  static roundTotalIn(rnd) {
    return Object.values(rnd.buyins).reduce((a, b) => a + b, 0) * rnd.buy_in_cents;
  }

  validateCounts(rnd, buyins, chips) {
    const a = Object.keys(buyins).sort().join("\n");
    const b = Object.keys(chips).sort().join("\n");
    if (a !== b) throw new PokerError("Every player in the round needs a chip count");
    if (Object.values(buyins).some((n) => !(n >= 1))) throw new PokerError("Every player must have at least 1 buy-in");
    const totalIn = Object.values(buyins).reduce((x, y) => x + y, 0) * rnd.buy_in_cents;
    const totalChips = Object.values(chips).reduce((x, y) => x + y, 0);
    if (totalIn !== totalChips) {
      throw new PokerError(`Chips counted (${this.money(totalChips)}) do not match money bought in ` +
        `(${this.money(totalIn)}).\nDifference: ${this.money(totalChips - totalIn, true)}. Please recount.`);
    }
  }

  finishRound(chips, buyins = null, chipCounts = null) {
    const rnd = this._requireActive();
    buyins = buyins ? { ...buyins } : { ...rnd.buyins };
    this.validateCounts(rnd, buyins, chips);
    this._applyChipCounts(rnd, chips, chipCounts);
    if (JSON.stringify(buyins) !== JSON.stringify(rnd.buyins)) {
      this.log(`Round ${rnd.number}: buy-ins corrected at end from ${JSON.stringify(rnd.buyins)} to ${JSON.stringify(buyins)}`);
    }
    rnd.buyins = buyins;
    rnd.chips = { ...chips };
    rnd.status = "finished";
    rnd.ended = nowStr();
    const results = Object.entries(Session.roundNet(rnd)).map(([p, n]) => `${p} ${this.money(n, true)}`).join(", ");
    this.log(`Round ${rnd.number} finished. Chips: ` +
      Object.entries(chips).map(([p, c]) => `${p} ${this.money(c)}`).join(", ") + `. Results: ${results}`);
    this.save();
    return rnd;
  }

  editRound(number, chips, buyins, chipCounts = null) {
    const rnd = this.getRound(number);
    if (rnd.status !== "finished") throw new PokerError("Only finished rounds can be edited");
    this.validateCounts(rnd, buyins, chips);
    this._applyChipCounts(rnd, chips, chipCounts);
    this.log(`Round ${number} EDITED. Before: buy-ins ${JSON.stringify(rnd.buyins)}, chips ${JSON.stringify(rnd.chips)}. ` +
      `After: buy-ins ${JSON.stringify(buyins)}, chips ${JSON.stringify(chips)}`);
    rnd.buyins = { ...buyins };
    rnd.chips = { ...chips };
    (rnd.edits ??= []).push(nowStr());
    this.save();
  }

  // -------------------------------------------------------------- results
  static roundNet(rnd) {
    if (rnd.status !== "finished") return {};
    return Object.fromEntries(Object.entries(rnd.buyins).map(([p, n]) => [p, rnd.chips[p] - n * rnd.buy_in_cents]));
  }

  /** Per player summary over all finished rounds, as a Map (keeps player order). */
  totals() {
    const blank = () => ({ rounds: 0, buyins: 0, paid_in: 0, cashed_out: 0, net: 0 });
    const out = new Map(this.players.map((p) => [p, blank()]));
    for (const rnd of this.rounds) {
      if (rnd.status !== "finished") continue;
      for (const [p, n] of Object.entries(rnd.buyins)) {
        if (!out.has(p)) out.set(p, blank());
        const t = out.get(p);
        t.rounds += 1;
        t.buyins += n;
        t.paid_in += n * rnd.buy_in_cents;
        t.cashed_out += rnd.chips[p];
        t.net = t.cashed_out - t.paid_in;
      }
    }
    return out;
  }

  settlement() {
    return settle([...this.totals()].map(([p, t]) => [p, t.net]));
  }

  // --------------------------------------------------------------- report
  roundTable(rnd, indent = "") {
    const unit = rnd.buy_in_cents;
    const net = Session.roundNet(rnd);
    const rows = Object.entries(rnd.buyins).map(([p, n]) => [
      p, n, this.money(n * unit),
      p in rnd.chips ? this.money(rnd.chips[p]) : "-",
      p in net ? this.money(net[p], true) : "-",
    ]);
    const chipValues = Object.values(rnd.chips);
    const totalChips = chipValues.length ? this.money(chipValues.reduce((a, b) => a + b, 0)) : "-";
    const footer = ["Total", Object.values(rnd.buyins).reduce((a, b) => a + b, 0),
      this.money(Session.roundTotalIn(rnd)), totalChips, ""];
    return textTable(["Player", "Buy-ins", "Paid in", "Chips", "Result"], rows, footer, indent);
  }

  reportText() {
    const lines = [
      "POKER SESSION REPORT",
      `Session      : ${this.id}`,
      `Created      : ${this.data.created}`,
      `Last saved   : ${nowStr()}`,
      `Players      : ${this.players.join(", ")}`,
      `Chip values  : ${this.chipValuesText()}`,
      "",
    ];
    for (const rnd of this.rounds) {
      lines.push("=".repeat(60));
      const status = rnd.status === "active" ? "IN PROGRESS" : "finished";
      lines.push(`ROUND ${rnd.number}  (${status})  buy-in ${this.money(rnd.buy_in_cents)}`);
      lines.push(`Started: ${rnd.started}   Ended: ${rnd.ended || "-"}`);
      if (rnd.edits?.length) lines.push(`Edited afterwards: ${rnd.edits.join(", ")}`);
      lines.push("");
      lines.push(...this.roundTable(rnd));
      if (rnd.chip_counts && Object.keys(rnd.chip_counts).length) {
        lines.push("");
        lines.push(...this.chipCountTable(rnd));
      }
      lines.push("");
    }
    lines.push("=".repeat(60));
    lines.push("TOTALS (finished rounds)");
    lines.push("");
    lines.push(...textTable(
      ["Player", "Rounds", "Buy-ins", "Paid in", "Chips cashed", "Result"],
      [...this.totals()].map(([p, t]) => [p, t.rounds, t.buyins, this.money(t.paid_in),
        this.money(t.cashed_out), this.money(t.net, true)]),
      null, "  "));
    lines.push("");
    lines.push("PAYMENTS TO SETTLE UP");
    const payments = this.settlement();
    if (!payments.length) lines.push("  Nobody owes anything.");
    for (const [debtor, creditor, amount] of payments) lines.push(`  ${debtor} pays ${creditor} ${this.money(amount)}`);
    return lines.join("\n") + "\n";
  }
}

// ------------------------------------------------------------- settlement
function greedy(balances) {
  const debtors = balances.filter(([, b]) => b < 0).map(([p, b]) => [p, -b]).sort((x, y) => y[1] - x[1]);
  const creditors = balances.filter(([, b]) => b > 0).map(([p, b]) => [p, b]).sort((x, y) => y[1] - x[1]);
  const payments = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i][1], creditors[j][1]);
    payments.push([debtors[i][0], creditors[j][0], amount]);
    debtors[i][1] -= amount;
    creditors[j][1] -= amount;
    if (debtors[i][1] === 0) i += 1;
    if (creditors[j][1] === 0) j += 1;
  }
  return payments;
}

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Fewest payments that settle all balances: [[payer, receiver, cents], ...].
 * Splits players into as many zero-sum groups as possible; a group of k players needs k-1 payments.
 * @param {Array<[string, number]>} balances
 */
export function settle(balances) {
  const nonzero = balances.filter(([, b]) => b !== 0);
  if (nonzero.reduce((a, [, b]) => a + b, 0) !== 0) throw new PokerError("Balances do not add up to zero");
  const n = nonzero.length;
  if (n === 0) return [];
  if (n > 16) return greedy(nonzero);

  const names = nonzero.map(([p]) => p);
  const values = nonzero.map(([, b]) => b);
  const full = (1 << n) - 1;
  const bitIndex = (bit) => 31 - Math.clz32(bit);
  const sums = new Array(full + 1).fill(0);
  for (let mask = 1; mask <= full; mask++) {
    sums[mask] = sums[mask & (mask - 1)] + values[bitIndex(mask & -mask)];
  }
  // best[mask] = max number of zero-sum groups the players in mask can form
  const best = new Array(full + 1).fill(0);
  const choice = new Array(full + 1).fill(0);
  for (let mask = 1; mask <= full; mask++) {
    let top = -1;
    for (let m = mask; m; m &= m - 1) {
      const bit = m & -m;
      if (best[mask ^ bit] > top) {
        top = best[mask ^ bit];
        choice[mask] = bit;
      }
    }
    best[mask] = top + (sums[mask] === 0 ? 1 : 0);
  }

  const groups = [];
  let current = [];
  let mask = full;
  while (mask) {
    const bit = choice[mask];
    current.push(bitIndex(bit));
    mask ^= bit;
    if (sums[mask] === 0) {
      groups.push(current);
      current = [];
    }
  }
  const payments = [];
  for (const group of groups) payments.push(...greedy(group.map((i) => [names[i], values[i]])));
  payments.sort((x, y) => compareStrings(x[0], y[0]) || compareStrings(x[1], y[1]));
  return payments;
}
