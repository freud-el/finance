import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart, BarChart, Bar
} from "recharts";
import {
  Plus, Wallet, PiggyBank, Landmark, Upload, Download, X, Trash2, Pencil,
  TrendingUp, TrendingDown, ChevronRight, ArrowLeft, FileSpreadsheet, Lock, Eye, Sparkles, Coins, Settings, Flag
} from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

const STORAGE_KEY = "comptes:accounts-v1";
const RIGID_CATEGORIES_KEY = "comptes:rigid-categories-v1";
const RECURRING_OVERRIDES_KEY = "comptes:recurring-overrides-v1";
const BLOCK_ORDER_KEY = "comptes:overview-block-order-v1";
const GOALS_KEY = "comptes:goals-v1";
const DEFAULT_RIGID_CATEGORIES = ["Logement", "Assurance", "Abonnements", "Impôts & Taxes", "Frais bancaires", "Enfants"];
const DEFAULT_BLOCK_ORDER = ["kpis", "performance", "goals", "provisionDetail", "categories", "chart", "dettes", "accounts"];
const BLOCK_LABELS = {
  kpis: "Épargne / Rigidité / Résilience",
  performance: "Performance",
  goals: "Tirelires / Objectifs",
  provisionDetail: "Détail de l'épargne disponible",
  categories: "Répartition des dépenses",
  chart: "Graphique",
  dettes: "Dettes",
  accounts: "Comptes par palier",
};
// Which tab each reorderable block lives on — "Vue d'ensemble" stays
// focused on what you have (paliers, dettes); "Analyse" groups the
// budget/performance tools; "Objectifs" is the tirelires/provisions.
const BLOCK_PAGE = {
  kpis: "analyse",
  performance: "analyse",
  categories: "analyse",
  chart: "analyse",
  goals: "objectifs",
  provisionDetail: "overview",
  dettes: "overview",
  accounts: "overview",
};
const MAIN_TABS = [
  { key: "overview", label: "Vue d'ensemble" },
  { key: "analyse", label: "Analyse" },
  { key: "objectifs", label: "Objectifs" },
];

// A transaction's own rigid/discretionary flag (set individually, see
// AccountDetail's Mouvements list) takes priority over its category's
// default when present.
function isRigidTransaction(t, fixedCategoriesSet) {
  if (t.rigid === true) return true;
  if (t.rigid === false) return false;
  return fixedCategoriesSet.has(t.category);
}

const CRYPTO_LIQUID_THRESHOLD = 0.85;

// A crypto position far below its all-time high isn't really "available"
// money in the same sense as cash — selling into a big drawdown is a real
// loss, so it behaves more like locked-away savings. Blends every holding
// that has both a lastPrice and an ath into one ratio (current value ÷
// value-at-ATH) and compares it to the threshold. Holdings missing either
// figure are ignored; if none qualify, defaults to "semi" (disponible) —
// the same as before this feature existed.
function cryptoLiquidityTier(account) {
  const holdings = account?.crypto?.holdings || [];
  let valueNow = 0;
  let valueAtAth = 0;
  holdings.forEach((h) => {
    if (h.ath > 0 && h.lastPrice > 0) {
      valueNow += h.lastPrice * h.quantity;
      valueAtAth += h.ath * h.quantity;
    }
  });
  if (valueAtAth <= 0) return "semi";
  return valueNow / valueAtAth >= CRYPTO_LIQUID_THRESHOLD ? "semi" : "illiquide";
}

// Sums a calendar month's courant-account movements into four buckets:
// - revenus: sum of credits (positive amounts), excluding "Virement
//   interne" (money moving between the user's own accounts isn't income)
//   and "Intérêts" (tracked separately, not spending money in/out).
// - fixed / flexible: sum of debits (contraint vs discrétionnaire, via
//   isRigidTransaction).
// - savings: sum of movements categorized "Épargne" (either direction —
//   a transfer out to a savings account is what "saving money" looks
//   like from a compte courant).
// Shared by the snapshot KPI cards and the monthly trend chart so the two
// can never disagree with each other.
// Sums a single account's movements over a calendar month into four
// buckets:
// - revenus: sum of credits (positive amounts), excluding "Virement
//   interne" (money moving between the user's own accounts isn't income)
//   and "Intérêts" (tracked separately, not spending money in/out).
// - fixed / flexible: sum of debits (contraint vs discrétionnaire, via
//   isRigidTransaction).
// - savings: sum of movements categorized "Épargne" (either direction —
//   a transfer out to a savings account is what "saving money" looks
//   like from a compte courant).
// Deliberately scoped to one account at a time (not every courant account
// combined) — mixing e.g. a personal and a joint account together would
// blur what each one is actually doing. Shared by the snapshot KPI cards
// and the monthly trend chart so the two can never disagree.
function sumMonthBuckets(account, start, end, fixedCategoriesSet) {
  let income = 0, fixed = 0, flexible = 0, savings = 0;
  if (account) {
    (account.transactions || []).forEach((t) => {
      if (t.date < start || t.date > end) return;
      if (t.category === "Épargne") {
        savings += Math.abs(t.amount);
        return;
      }
      if (t.category === "Virement interne" || t.category === "Intérêts") return;
      if (t.amount > 0) {
        income += t.amount;
      } else {
        const amt = Math.abs(t.amount);
        if (isRigidTransaction(t, fixedCategoriesSet)) fixed += amt;
        else flexible += amt;
      }
    });
  }
  return { income, fixed, flexible, savings };
}

const TYPE_META = {
  courant: { label: "Compte courant", icon: Wallet, color: "#15803D" },
  epargne: { label: "Épargne / Placement", icon: PiggyBank, color: "#C99A3D" },
  credit: { label: "Crédit", icon: Landmark, color: "#C2410C" },
  crypto: { label: "Crypto", icon: Coins, color: "#F7931A" },
};

// Colored monogram badges per établissement — not their official logo
// artwork (I have no way to reproduce/fetch that here), but colors picked
// to match the actual app icons the user shared: Green-Got's lime green,
// Deblock's blue, Crédit Mutuel's red.
const INSTITUTION_META = {
  "Green Got": { color: "#E3F0B0", textColor: "#3B4A1F", initials: "GG" },
  "Crédit Mutuel": { color: "#F2B9BD", textColor: "#7A2226", initials: "CM" },
  "Deblock": { color: "#C3D4F5", textColor: "#243B7A", initials: "DB" },
  "Bricks.co": { color: "#F5D5A8", textColor: "#7A4A16", initials: "BR" },
};
function institutionMeta(name) {
  return INSTITUTION_META[name] || null;
}

const fmtEUR = (n) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n || 0);

const fmtEURPrecise = (n) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n || 0);

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });

const todayISO = () => new Date().toISOString().slice(0, 10);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// Reads a File as a data: URL (base64-encoded), used to save an original
// imported file so it can be reopened later from the import history.
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}

// Common crypto tickers offered as suggestions in the holdings editor.
// Live price lookups aren't wired up yet — prices are entered manually
// instead (see AccountDetail's crypto section). This used to be a hard
// sandbox restriction (Claude.ai artifacts could only load scripts from
// cdnjs.cloudflare.com); now that the app runs as a normal website, a
// live price API could be added here as a future improvement.
const CRYPTO_SYMBOL_MAP = {
  BTC: "bitcoin", ETH: "ethereum", USDT: "tether", USDC: "usd-coin",
  SOL: "solana", XRP: "ripple", ADA: "cardano", DOGE: "dogecoin",
  MATIC: "matic-network", DOT: "polkadot", LTC: "litecoin", BNB: "binancecoin",
  AVAX: "avalanche-2", LINK: "chainlink", TRX: "tron", ATOM: "cosmos",
  XLM: "stellar", ETC: "ethereum-classic", BCH: "bitcoin-cash", NEAR: "near",
};

function sortedEntries(account) {
  return [...(account.entries || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Index (within the sorted entries) of the entry to treat as "as of today" —
// the last one dated on or before today. Entries with dates after today
// happen for credit accounts seeded from a full amortization schedule
// (projected balances all the way to payoff), so we must not just grab the
// chronologically last entry — that would be the near-zero balance at the
// end of the loan, not the balance right now.
function asOfTodayIndex(sorted) {
  const today = todayISO();
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].date <= today) idx = i;
    else break;
  }
  return idx; // -1 if every entry is in the future
}

function currentBalance(account) {
  const e = sortedEntries(account);
  if (!e.length) return 0;
  const idx = asOfTodayIndex(e);
  if (idx < 0) return e[0].balance;

  if (account.type === "credit") {
    // Each entry is "capital dû avant l'échéance" of its date. Once that
    // due date is strictly in the past (not today — the debit may not
    // have processed yet on the day itself), that payment has already
    // been taken, so the real balance now is the next entry's value.
    const today = todayISO();
    if (e[idx].date < today && idx + 1 < e.length) return e[idx + 1].balance;
  }
  return e[idx].balance;
}

// Sum of provisions on an account — money that's physically there (still
// counts in the balance, still liquid) but set aside and not meant to be
// spent day-to-day. Two sources, added together:
// - transactions flagged provision:true (see setTransactionProvision) —
//   e.g. a tax refund you're keeping in reserve, tied to when it arrived.
// - standalone manual entries in account.provisions[] — for setting money
//   aside without there being a specific movement to point at (e.g. "I'm
//   keeping 1000€ of this Livret in reserve for taxes").
function computeProvisions(account) {
  const fromTransactions = (account.transactions || [])
    .filter((t) => t.provision === true)
    .reduce((s, t) => s + t.amount, 0);
  const manual = (account.provisions || []).reduce((s, p) => s + p.amount, 0);
  return fromTransactions + manual;
}

// The current "épargne disponible" total, computed the same way the
// Overview's hero card does: balance of every épargne (non-bloquée) and
// semi-liquid crypto account, minus what's already really provisioned on
// those accounts (not the goal reserve — a goal tracking this total
// shouldn't subtract its own reservation from itself).
function computeSemiDisponibleTotal(accounts) {
  const semiAccounts = accounts.filter(
    (a) => (a.type === "epargne" && a.liquidity !== "bloque") || (a.type === "crypto" && cryptoLiquidityTier(a) === "semi")
  );
  const balance = semiAccounts.reduce((s, a) => s + currentBalance(a), 0);
  const provisions = semiAccounts.reduce((s, a) => s + Math.max(0, computeProvisions(a)), 0);
  return balance - provisions;
}

// How much is currently set aside toward a given goal. Two kinds:
// - basedOnTotal goals track the overall "épargne disponible" pool
//   directly (e.g. "always keep 5000€ available") — not tied to any
//   named provision.
// - ordinary goals are matched by name against every provision's reason
//   (transaction-flagged or manual), the same "reason" text used
//   throughout the provisions feature. Goals are app-wide, not tied to
//   one account, so this sums across every account: a goal named
//   "Impôts" can be fed by provisions on any of them.
function computeGoalProgress(accounts, goal) {
  if (typeof goal === "string") goal = { name: goal };
  if (goal.basedOnTotal) return computeSemiDisponibleTotal(accounts);
  const goalName = goal.name;
  return accounts.reduce((total, account) => {
    const fromTransactions = (account.transactions || [])
      .filter((t) => t.provision === true && t.provisionReason === goalName)
      .reduce((s, t) => s + t.amount, 0);
    const manual = (account.provisions || [])
      .filter((p) => p.reason === goalName)
      .reduce((s, p) => s + p.amount, 0);
    return total + fromTransactions + manual;
  }, 0);
}

// The app-wide amount to treat as reserved on top of real provisions: for
// every goal flagged "important", the shortfall between its target and
// what's currently set aside toward it across all accounts — as if that
// shortfall were already provisioned (a tirelire objectif "important"
// reserves its full target from day one). Non-important goals are purely
// informational and don't affect this total. A basedOnTotal goal already
// measures itself against the whole "disponible" pool, so it can never
// be short — it never contributes a reserve.
function computeGoalReserve(accounts, goals) {
  return (goals || []).reduce((s, g) => {
    if (!g.important || g.basedOnTotal) return s;
    const current = computeGoalProgress(accounts, g);
    return s + Math.max(0, g.targetAmount - current);
  }, 0);
}

// "As of a date" variants of the above, for building historical trends
// (see the "Épargne & provisions" chart and each goal's sparkline). Only
// counts a provision/transaction if its own date is on or before the
// given date — this reconstructs how the CURRENTLY active set of
// provisions built up over time, not a true point-in-time snapshot of
// provisions that have since been deleted (there's no record of those).
function computeProvisionsAsOf(account, dateIso) {
  const fromTransactions = (account.transactions || [])
    .filter((t) => t.provision === true && t.date <= dateIso)
    .reduce((s, t) => s + t.amount, 0);
  const manual = (account.provisions || [])
    .filter((p) => p.date && p.date <= dateIso)
    .reduce((s, p) => s + p.amount, 0);
  return fromTransactions + manual;
}
function computeSemiDisponibleTotalAsOf(accounts, dateIso) {
  const semiAccounts = accounts.filter(
    (a) => (a.type === "epargne" && a.liquidity !== "bloque") || (a.type === "crypto" && cryptoLiquidityTier(a) === "semi")
  );
  const balance = semiAccounts.reduce((s, a) => {
    const b = balanceAsOf(a, dateIso);
    return s + (b ?? 0);
  }, 0);
  const provisions = semiAccounts.reduce((s, a) => s + Math.max(0, computeProvisionsAsOf(a, dateIso)), 0);
  return balance - provisions;
}
function computeGoalProgressAsOf(accounts, goal, dateIso) {
  if (typeof goal === "string") goal = { name: goal };
  if (goal.basedOnTotal) return computeSemiDisponibleTotalAsOf(accounts, dateIso);
  const goalName = goal.name;
  return accounts.reduce((total, account) => {
    const fromTransactions = (account.transactions || [])
      .filter((t) => t.provision === true && t.provisionReason === goalName && t.date <= dateIso)
      .reduce((s, t) => s + t.amount, 0);
    const manual = (account.provisions || [])
      .filter((p) => p.reason === goalName && p.date && p.date <= dateIso)
      .reduce((s, p) => s + p.amount, 0);
    return total + fromTransactions + manual;
  }, 0);
}

// - crypto: unrealized + realized gain — current holdings value (via each
//   holding's lastPrice) minus net cost basis from Achat/Vente trades
//   (see recordCryptoTrade) — as a % of that cost basis.
// - anything else (Livret, assurance vie, Bricks...): sum of movements
//   categorized "Intérêts" (interest/dividends/revenus actually earned,
//   as opposed to money the person deposited or withdrew themselves) as a
//   % of the average balance held over the tracked period.
// Returns null when there isn't enough data to say anything meaningful.
function computeAccountPerformance(account) {
  const entries = sortedEntries(account);
  if (!entries.length) return null;

  if (account.type === "crypto") {
    const holdings = account.crypto?.holdings || [];
    if (!holdings.some((h) => h.lastPrice > 0)) return null;
    const currentValue = holdings.reduce((s, h) => s + (h.lastPrice || 0) * h.quantity, 0);
    const costBasis = (account.transactions || [])
      .filter((t) => /^Achat |^Vente /.test(t.label || ""))
      .reduce((s, t) => s - t.amount, 0); // achat: amount<0 -> adds to cost; vente: amount>0 -> reduces it
    if (costBasis <= 0) return null;
    const gain = Math.round((currentValue - costBasis) * 100) / 100;
    return { gain, pct: (gain / costBasis) * 100, label: "Plus/moins-value" };
  }

  const interestSum = (account.transactions || [])
    .filter((t) => t.category === "Intérêts")
    .reduce((s, t) => s + t.amount, 0);
  if (interestSum === 0) return null;
  const avgBalance = entries.reduce((s, e) => s + e.balance, 0) / entries.length;
  if (avgBalance <= 0) return { gain: Math.round(interestSum * 100) / 100, pct: null, label: "Intérêts perçus" };
  return { gain: Math.round(interestSum * 100) / 100, pct: (interestSum / avgBalance) * 100, label: "Intérêts perçus" };
}

function trend(account) {
  const e = sortedEntries(account);
  if (e.length < 2) return 0;
  const idx = asOfTodayIndex(e);
  const i = idx >= 0 ? idx : 0;
  if (i < 1) return 0;
  return e[i].balance - e[i - 1].balance;
}

// The last known balance on or before a given date — null if the account
// has no data that early (e.g. it didn't exist yet / wasn't imported back
// that far), so callers can skip it rather than treating it as zero.
function balanceAsOf(account, dateIso) {
  const e = sortedEntries(account);
  let val = null;
  for (const entry of e) {
    if (entry.date <= dateIso) val = entry.balance;
    else break;
  }
  return val;
}

// Net worth (liquid + savings, minus debt) as of a given date, summed
// across whichever accounts have data that far back.
function netWorthAsOf(accounts, dateIso) {
  let total = 0;
  accounts.forEach((a) => {
    const bal = balanceAsOf(a, dateIso);
    if (bal == null) return;
    total += a.type === "credit" ? -bal : bal;
  });
  return total;
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Best-effort payoff date for a credit account: if it was seeded from a
// full amortization schedule, use the last future-dated entry (near-zero
// balance = payoff). Otherwise, estimate linearly from the current balance
// and monthly payment.
function creditPayoffDate(account) {
  const e = sortedEntries(account);
  if (!e.length) return null;
  const today = todayISO();
  const future = e.filter((x) => x.date > today);
  if (future.length) return future[future.length - 1].date;

  const bal = currentBalance(account);
  const mp = account.credit?.monthlyPayment;
  if (!mp || mp <= 0) return null;
  const monthsLeft = Math.ceil(bal / mp);
  const d = new Date();
  d.setMonth(d.getMonth() + monthsLeft);
  return d.toISOString().slice(0, 10);
}

// Builds the step-down timeline of total monthly debt burden as each
// credit gets paid off, soonest first.
function computePayoffTimeline(creditAccounts) {
  const withDates = creditAccounts
    .map((a) => ({ account: a, payoffDate: creditPayoffDate(a), monthly: a.credit?.monthlyPayment || 0 }))
    .filter((x) => x.payoffDate)
    .sort((a, b) => (a.payoffDate < b.payoffDate ? -1 : a.payoffDate > b.payoffDate ? 1 : 0));

  let running = creditAccounts.reduce((s, a) => s + (a.credit?.monthlyPayment || 0), 0);
  let remaining = creditAccounts.length;
  const steps = [{ label: "Aujourd'hui", date: null, monthly: running, count: remaining }];
  withDates.forEach(({ account, payoffDate, monthly }) => {
    running = Math.max(0, Math.round((running - monthly) * 100) / 100);
    remaining -= 1;
    steps.push({ label: `${account.name} soldé`, date: payoffDate, monthly: running, count: remaining });
  });
  return steps;
}

// ---------- Divider ----------
function LedgerRule() {
  return (
    <div
      aria-hidden="true"
      style={{
        height: 2,
        borderRadius: 2,
        background: "linear-gradient(to right, #15803D 0%, #CFE0D3 40%, transparent 75%)",
      }}
    />
  );
}

// ---------- Sparkline ----------
function Sparkline({ data, color }) {
  if (!data || data.length < 2) {
    return <div className="h-10 flex items-center text-xs" style={{ color: "#6B8072" }}>—</div>;
  }
  return (
    <div className="h-10 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey="balance" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- Add / Edit Account Modal ----------
function AccountModal({ initial, onClose, onSave, onDelete }) {
  const [name, setName] = useState(initial?.name || "");
  const [formError, setFormError] = useState("");
  const [type, setType] = useState(initial?.type || "courant");
  const [institution, setInstitution] = useState(initial?.institution || "");
  const [iban, setIban] = useState(initial?.iban || "");
  const [bic, setBic] = useState(initial?.bic || "");
  const [contractNumber, setContractNumber] = useState(initial?.contractNumber || "");
  const [ribFile, setRibFile] = useState(null);
  const [ribFilename, setRibFilename] = useState(initial?.ribFilename || "");
  const ribFileRef = useRef(null);
  const accountIdRef = useRef(initial?.id || uid());
  const [rate, setRate] = useState(initial?.credit?.rate ?? "");
  const [monthly, setMonthly] = useState(initial?.credit?.monthlyPayment ?? "");
  const [currentBalanceInput, setCurrentBalanceInput] = useState(
    initial ? currentBalance(initial) : ""
  );

  // Épargne : taux moyen + versement récurrent
  const [avgRate, setAvgRate] = useState(initial?.savings?.rate ?? "");
  const [contribution, setContribution] = useState(initial?.savings?.contribution ?? "");
  const [contributionFreq, setContributionFreq] = useState(initial?.savings?.frequency || "mensuel");
  const [liquidity, setLiquidity] = useState(initial?.liquidity || "semi");
  const [holdings, setHoldings] = useState(initial?.crypto?.holdings?.length ? initial.crypto.holdings : [{ symbol: "", quantity: "" }]);

  // Mouvements passés (CSV) — courant / épargne
  const [movementEntries, setMovementEntries] = useState(null);
  const [movementTransactions, setMovementTransactions] = useState(null);
  const [movementRange, setMovementRange] = useState(null);
  const [movementFilename, setMovementFilename] = useState(null);
  const [movementError, setMovementError] = useState("");
  const movementFileRef = useRef(null);

  // Tableau d'amortissement (CSV ou PDF) — crédit
  const [scheduleEntries, setScheduleEntries] = useState(null);
  const [scheduleFilename, setScheduleFilename] = useState(null);
  const [scheduleError, setScheduleError] = useState("");
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const scheduleFileRef = useRef(null);

  const isCredit = type === "credit";
  const isEpargne = type === "epargne";
  const isCrypto = type === "crypto";

  function handleMovementFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setMovementError("");
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const fields = res.meta.fields || [];
        const txs = extractTransactionsFromRows(res.data, fields);
        if (!txs) {
          setMovementError("Colonnes attendues introuvables (ex. 'date' + 'montant', ou 'date' + 'débit'/'crédit').");
          return;
        }
        if (!txs.length) {
          setMovementError("Aucune opération valide trouvée dans le fichier.");
          return;
        }
        txs.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
        setMovementTransactions(txs);
        // Only reconstruct daily balances now if a current balance is
        // already provided — it's an optional anchor, not a prerequisite.
        // If it's missing, the transactions are still saved (see submit()),
        // just without a balance history until one is logged later.
        setMovementEntries(currentBalanceInput !== "" ? balancesFromTransactions(txs, Number(currentBalanceInput)) : null);
        setMovementRange({ start: txs[0].date, end: txs[txs.length - 1].date });
        setMovementFilename(file.name);
      },
      error: () => setMovementError("Impossible de lire ce fichier."),
    });
  }

  async function handleScheduleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setScheduleError("");
    setScheduleLoading(true);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const result = isPdf ? await parseAmortizationPdf(file) : await parseAmortizationCsv(file);
      if (!result || !result.entries.length) {
        setScheduleError("Aucune échéance reconnue dans ce fichier.");
        setScheduleLoading(false);
        return;
      }
      setScheduleEntries(result.entries);
      setScheduleFilename(file.name);
      if (result.rate != null && !isNaN(result.rate) && rate === "") setRate(String(result.rate));
      if (result.monthly != null && !isNaN(result.monthly) && monthly === "") setMonthly(String(result.monthly));
    } catch (err) {
      setScheduleError("Impossible de lire ce fichier" + (err?.message ? ` (${err.message})` : "") + ".");
    } finally {
      setScheduleLoading(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("Indique un nom de compte.");
      return;
    }
    setFormError("");

    const accountId = accountIdRef.current;

    const newEntries =
      scheduleEntries ||
      movementEntries ||
      (movementTransactions && currentBalanceInput !== ""
        ? balancesFromTransactions(movementTransactions, Number(currentBalanceInput))
        : currentBalanceInput !== ""
        ? [{ date: todayISO(), balance: Number(currentBalanceInput) }]
        : []);

    const savings =
      isEpargne && (avgRate !== "" || contribution !== "")
        ? { rate: Number(avgRate) || 0, contribution: Number(contribution) || 0, frequency: contributionFreq }
        : undefined;

    const credit = isCredit ? { rate: Number(rate) || 0, monthlyPayment: Number(monthly) || 0 } : undefined;

    let newImportLog = null;
    if (scheduleEntries) {
      newImportLog = {
        id: uid(),
        timestamp: new Date().toISOString(),
        filename: scheduleFilename,
        transactionIds: [],
        entryDates: scheduleEntries.map((e) => e.date),
        dateRange: { start: scheduleEntries[0].date, end: scheduleEntries[scheduleEntries.length - 1].date },
      };
    } else if (movementTransactions) {
      newImportLog = {
        id: uid(),
        timestamp: new Date().toISOString(),
        filename: movementFilename,
        transactionIds: movementTransactions.map((t) => txKey(t)),
        entryDates: (movementEntries || []).map((e) => e.date),
        dateRange: movementRange,
      };
    }

    const newRibFilename = ribFile ? ribFile.name : ribFilename;
    const cleanedHoldings = holdings
      .map((h) => {
        const symbol = h.symbol.trim().toUpperCase();
        const existingHolding = initial?.crypto?.holdings?.find((eh) => eh.symbol === symbol);
        const ath = Number(h.ath);
        return {
          symbol,
          quantity: Number(h.quantity),
          ath: !isNaN(ath) && ath > 0 ? ath : undefined,
          lastPrice: existingHolding?.lastPrice,
        };
      })
      .filter((h) => h.symbol && !isNaN(h.quantity) && h.quantity > 0);
    const crypto = isCrypto && cleanedHoldings.length ? { holdings: cleanedHoldings } : undefined;

    if (initial) {
      onSave({
        ...initial,
        name,
        type,
        institution,
        iban,
        bic,
        contractNumber,
        ribFilename: newRibFilename,
        liquidity: isEpargne ? liquidity : undefined,
        crypto,
        credit,
        savings,
        entries: isCredit ? mergeCreditEntries(initial.entries || [], newEntries) : mergeEntriesByDate(initial.entries || [], newEntries),
        transactions: movementTransactions ? mergeTransactions(initial.transactions || [], movementTransactions) : (initial.transactions || []),
        coverage: movementRange ? mergeDateRanges(initial.coverage || [], [movementRange]) : (initial.coverage || []),
        imports: newImportLog ? [...(initial.imports || []), newImportLog] : (initial.imports || []),
      });
    } else {
      onSave({
        id: accountId,
        name, type, institution, iban, bic, contractNumber,
        ribFilename: newRibFilename,
        liquidity: isEpargne ? liquidity : undefined,
        crypto,
        credit, savings,
        entries: newEntries,
        transactions: movementTransactions || [],
        coverage: movementRange ? [movementRange] : [],
        imports: newImportLog ? [newImportLog] : [],
      });
    }

    if (ribFile) {
      readFileAsDataURL(ribFile).then((dataUrl) => window.storage.set(`rib:${accountId}`, dataUrl, false)).catch(() => {});
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto" style={{ background: "rgba(33,38,31,0.45)" }}>
      <div className="w-full max-w-md rounded-xl shadow-xl my-8" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #CFE5D2" }}>
          <h3 className="text-lg" style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#0F2A1C" }}>
            {initial ? "Modifier le compte" : "Nouveau compte"}
          </h3>
          <button onClick={onClose} aria-label="Fermer" className="p-1 hover:opacity-60">
            <X size={18} color="#0F2A1C" />
          </button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Nom du compte</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex. Livret A, Crédit Mutuel Courant..."
              className="w-full px-3 py-2 rounded-xl outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'Inter', sans-serif" }}
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Type</label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(TYPE_META).map(([key, meta]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setType(key)}
                  className="flex flex-col items-center gap-1 py-2 rounded-xl text-xs"
                  style={{
                    border: type === key ? `1.5px solid ${meta.color}` : "1px solid #CFE5D2",
                    background: type === key ? `${meta.color}14` : "#FFFFFF",
                    color: type === key ? meta.color : "#4B5D52",
                  }}
                >
                  <meta.icon size={16} />
                  {meta.label.split(" ")[0]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Établissement (optionnel)</label>
            <select
              value={["Green Got", "Deblock", "Crédit Mutuel", "Bricks.co"].includes(institution) ? institution : institution ? "Autre" : ""}
              onChange={(e) => setInstitution(e.target.value === "Autre" ? (institution && !["Green Got", "Deblock", "Crédit Mutuel", "Bricks.co"].includes(institution) ? institution : " ") : e.target.value)}
              className="w-full px-3 py-2 rounded-xl outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'Inter', sans-serif" }}
            >
              <option value="">— Aucun —</option>
              <option value="Green Got">Green Got</option>
              <option value="Deblock">Deblock</option>
              <option value="Crédit Mutuel">Crédit Mutuel</option>
              <option value="Bricks.co">Bricks.co</option>
              <option value="Autre">Autre…</option>
            </select>
            {!["", "Green Got", "Deblock", "Crédit Mutuel"].includes(institution) && (
              <input
                value={institution.trim() === "" ? "" : institution}
                onChange={(e) => setInstitution(e.target.value)}
                placeholder="Nom de l'établissement"
                autoFocus
                className="w-full px-3 py-2 rounded-xl outline-none mt-2"
                style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'Inter', sans-serif" }}
              />
            )}
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>IBAN (optionnel)</label>
            <input
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              placeholder="Pour reconnaître ce compte automatiquement à l'import"
              className="w-full px-3 py-2 rounded-xl outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8rem" }}
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>BIC (optionnel)</label>
            <input
              value={bic}
              onChange={(e) => setBic(e.target.value)}
              placeholder="Ex. DBLKFR22XXX"
              className="w-full px-3 py-2 rounded-xl outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8rem" }}
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>N° de contrat (optionnel)</label>
            <input
              value={contractNumber}
              onChange={(e) => setContractNumber(e.target.value)}
              placeholder="Assurance vie, PER… pour la reconnaissance automatique"
              className="w-full px-3 py-2 rounded-xl outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8rem" }}
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>RIB officiel (PDF, optionnel)</label>
            {ribFile || ribFilename ? (
              <div className="flex items-center justify-between text-xs px-3 py-2 rounded-xl" style={{ background: "#15803D14", color: "#15803D" }}>
                <span className="truncate">{ribFile ? ribFile.name : ribFilename}</span>
                <button type="button" onClick={() => { setRibFile(null); setRibFilename(""); }} className="underline shrink-0 ml-2">retirer</button>
              </div>
            ) : (
              <>
                <input ref={ribFileRef} type="file" accept=".pdf" onChange={(e) => setRibFile(e.target.files[0] || null)} className="hidden" />
                <button
                  type="button"
                  onClick={() => ribFileRef.current.click()}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs"
                  style={{ border: "1.5px dashed #CFE0D3", color: "#4B5D52" }}
                >
                  <FileSpreadsheet size={14} /> Importer le PDF du RIB
                </button>
              </>
            )}
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>
              {isCredit ? "Capital restant dû actuel (optionnel)" : "Solde actuel (optionnel)"}
            </label>
            <input
              type="number"
              step="0.01"
              value={currentBalanceInput}
              onChange={(e) => setCurrentBalanceInput(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2 rounded-xl outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
            />
            {!isCredit && (
              <p className="text-[11px] mt-1" style={{ color: "#6B8072" }}>
                Pas obligatoire si tu importes un historique de mouvements ou un échéancier ci-dessous — tu pourras toujours ajouter un solde plus tard.
              </p>
            )}
          </div>

          {isCrypto && (
            <div className="space-y-2">
              <label className="block text-xs uppercase tracking-wide" style={{ color: "#4B5D52" }}>Positions</label>
              {holdings.map((h, i) => (
                <div key={i} className="space-y-1.5 p-2 rounded-xl" style={{ background: "#F3F8F2" }}>
                  <div className="flex gap-2">
                    <input
                      value={h.symbol}
                      onChange={(e) => {
                        const next = [...holdings];
                        next[i] = { ...next[i], symbol: e.target.value.toUpperCase() };
                        setHoldings(next);
                      }}
                      placeholder="BTC"
                      className="w-20 px-3 py-2 rounded-xl outline-none uppercase"
                      style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                    <input
                      type="number" step="any"
                      value={h.quantity}
                      onChange={(e) => {
                        const next = [...holdings];
                        next[i] = { ...next[i], quantity: e.target.value };
                        setHoldings(next);
                      }}
                      placeholder="Quantité"
                      className="flex-1 px-3 py-2 rounded-xl outline-none"
                      style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                    {holdings.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setHoldings(holdings.filter((_, j) => j !== i))}
                        className="px-2 rounded-xl"
                        style={{ border: "1px solid #CFE5D2", color: "#C2410C" }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <input
                    type="number" step="any"
                    value={h.ath || ""}
                    onChange={(e) => {
                      const next = [...holdings];
                      next[i] = { ...next[i], ath: e.target.value };
                      setHoldings(next);
                    }}
                    placeholder="Plus haut historique (ATH), prix unitaire €"
                    className="w-full px-3 py-2 rounded-xl outline-none text-xs"
                    style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() => setHoldings([...holdings, { symbol: "", quantity: "" }])}
                className="text-xs underline"
                style={{ color: "#4B5D52" }}
              >
                + Ajouter une position
              </button>
              <p className="text-[11px]" style={{ color: "#6B8072" }}>
                Symboles suggérés : {Object.keys(CRYPTO_SYMBOL_MAP).join(", ")}. Le prix se saisit à la main sur la fiche du compte (pas de cours en direct possible ici).
                Renseigne le plus haut historique (ATH) pour que le compte bascule automatiquement en "épargne bloquée" quand le cours retombe sous 85% de ce plus haut.
              </p>
            </div>
          )}

          {isCredit && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Taux (%)</label>
                <input
                  type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl outline-none"
                  style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Mensualité (€)</label>
                <input
                  type="number" step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl outline-none"
                  style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                />
              </div>
            </div>
          )}

          {isEpargne && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Niveau de liquidité</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setLiquidity("semi")}
                    className="py-2 rounded-xl text-xs text-left px-3"
                    style={{
                      border: liquidity === "semi" ? "1.5px solid #C99A3D" : "1px solid #CFE5D2",
                      background: liquidity === "semi" ? "#C99A3D14" : "#FFFFFF",
                      color: liquidity === "semi" ? "#C99A3D" : "#4B5D52",
                    }}
                  >
                    Épargne disponible
                    <div className="text-[10px] mt-0.5" style={{ color: "#6B8072" }}>Assurance vie, actions, terme…</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLiquidity("bloque")}
                    className="py-2 rounded-xl text-xs text-left px-3"
                    style={{
                      border: liquidity === "bloque" ? "1.5px solid #7C6F9E" : "1px solid #CFE5D2",
                      background: liquidity === "bloque" ? "#7C6F9E14" : "#FFFFFF",
                      color: liquidity === "bloque" ? "#7C6F9E" : "#4B5D52",
                    }}
                  >
                    Épargne bloquée
                    <div className="text-[10px] mt-0.5" style={{ color: "#6B8072" }}>PER, PEE bloqué…</div>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Taux moyen (%)</label>
                  <input
                    type="number" step="0.01" value={avgRate} onChange={(e) => setAvgRate(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-xl outline-none"
                    style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Versement récurrent (€)</label>
                  <input
                    type="number" step="0.01" value={contribution} onChange={(e) => setContribution(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-xl outline-none"
                    style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {["hebdomadaire", "mensuel"].map((freq) => (
                  <button
                    key={freq}
                    type="button"
                    onClick={() => setContributionFreq(freq)}
                    className="py-2 rounded-xl text-xs capitalize"
                    style={{
                      border: contributionFreq === freq ? "1.5px solid #C99A3D" : "1px solid #CFE5D2",
                      background: contributionFreq === freq ? "#C99A3D14" : "#FFFFFF",
                      color: contributionFreq === freq ? "#C99A3D" : "#4B5D52",
                    }}
                  >
                    {freq}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!isCredit && !isCrypto && (
            <div>
              <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Mouvements passés (optionnel)</label>
              {movementTransactions ? (
                <div className="flex items-center justify-between text-xs px-3 py-2 rounded-xl" style={{ background: "#15803D14", color: "#15803D" }}>
                  <span>
                    {movementTransactions.length} mouvement(s) importé(s)
                    {movementEntries ? ` · ${movementEntries.length} jours de solde` : " · pas encore de solde de référence"}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setMovementTransactions(null); setMovementEntries(null); setMovementRange(null); setMovementFilename(null); }}
                    className="underline shrink-0 ml-2"
                  >
                    retirer
                  </button>
                </div>
              ) : (
                <>
                  <input ref={movementFileRef} type="file" accept=".csv" onChange={handleMovementFile} className="hidden" />
                  <button
                    type="button"
                    onClick={() => movementFileRef.current.click()}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs"
                    style={{ border: "1.5px dashed #CFE0D3", color: "#4B5D52" }}
                  >
                    <FileSpreadsheet size={14} /> Importer un CSV de mouvements
                  </button>
                  <p className="text-[11px] mt-1" style={{ color: "#6B8072" }}>
                    Colonnes date + montant (ou débit/crédit). Si tu as rempli "Solde actuel" ci-dessus, l'historique des soldes est reconstitué automatiquement — sinon les mouvements sont quand même importés, tu pourras ajouter un solde plus tard.
                  </p>
                </>
              )}
              {movementError && <p className="text-xs mt-1" style={{ color: "#C2410C" }}>{movementError}</p>}
            </div>
          )}

          {isCredit && (
            <div>
              <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Tableau d'amortissement (optionnel)</label>
              {scheduleEntries ? (
                <div className="flex items-center justify-between text-xs px-3 py-2 rounded-xl" style={{ background: "#15803D14", color: "#15803D" }}>
                  <span>{scheduleEntries.length} échéances importées</span>
                  <button type="button" onClick={() => setScheduleEntries(null)} className="underline">retirer</button>
                </div>
              ) : (
                <>
                  <input ref={scheduleFileRef} type="file" accept=".csv,.pdf,.xlsx,.xls" onChange={handleScheduleFile} className="hidden" />
                  <button
                    type="button"
                    disabled={scheduleLoading}
                    onClick={() => scheduleFileRef.current.click()}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs disabled:opacity-60"
                    style={{ border: "1.5px dashed #CFE0D3", color: "#4B5D52" }}
                  >
                    <FileSpreadsheet size={14} /> {scheduleLoading ? "Lecture en cours…" : "Importer un échéancier (CSV ou PDF)"}
                  </button>
                  <p className="text-[11px] mt-1" style={{ color: "#6B8072" }}>
                    Format Crédit Mutuel et proches — le PDF est lu directement (expérimental) ; le taux et la mensualité sont pré-remplis si détectés. Vérifie les valeurs après import.
                  </p>
                </>
              )}
              {scheduleError && <p className="text-xs mt-1" style={{ color: "#C2410C" }}>{scheduleError}</p>}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            {initial ? (
              <button
                type="button"
                onClick={() => onDelete(initial.id)}
                className="flex items-center gap-1 text-xs px-3 py-2 rounded-xl"
                style={{ color: "#C2410C" }}
              >
                <Trash2 size={14} /> Supprimer
              </button>
            ) : <span />}
            <button
              type="button"
              onClick={submit}
              className="px-4 py-2 rounded-xl text-sm text-white"
              style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)", fontFamily: "'Inter', sans-serif" }}
            >
              {initial ? "Enregistrer" : "Créer le compte"}
            </button>
          </div>
          {formError && <p className="text-xs text-right" style={{ color: "#C2410C" }}>{formError}</p>}
        </form>
      </div>
    </div>
  );
}

// ---------- CSV parsing helpers ----------
function findCol(fields, candidates) {
  const lower = fields.map((f) => f.toLowerCase());
  for (const cand of candidates) {
    const idx = lower.findIndex((c) => c.includes(cand));
    if (idx !== -1) return fields[idx];
  }
  return null;
}

function toNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return NaN;
  let s = String(raw).replace(/[€\s]/g, "");
  // "2.026,00" style (period = thousands separator, comma = decimal) —
  // used by some bank exports (e.g. Crédit Mutuel account statements).
  // Only treat the period this way when a comma is also present, so a
  // plain "217.42" (no thousands grouping) is left alone.
  if (s.includes(".") && s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(",", ".");
  }
  return parseFloat(s);
}

// Turns raw CSV rows of bank transactions into daily balances, anchored on
// Maps a category string from an imported file onto the app's own category
// list, by keyword — handles both human-readable French labels and
// English/snake_case-style codes. Used as a fallback for sources without a
// confirmed exact mapping (see GREEN_GOT_CATEGORY_MAP below for Green Got's
// real codes), and to sub-categorize Green Got's generic "TRANSFER" rows
// from their Référence text. Anything that doesn't match a known pattern is
// kept as-is, so nothing is silently lost.
const CATEGORY_MAP_RULES = [
  [/aliment|grocer|super(marche)?|epicerie|food/, "Alimentation"],
  [/restaurant|resto|dining|bar\b|cafe|coffee/, "Restaurants"],
  [/transport|essence|fuel|carburant|parking|train|uber|taxi|peage|autoroute|dacia|jogger|voiture|\bauto\b/, "Transport"],
  [/logement|loyer|\brent\b|housing|immobilier|edf|electricite|gaz|energie/, "Logement"],
  [/sant[ée]|health|pharma|medical|docteur|medecin/, "Santé"],
  [/loisir|culture|cinema|\bsport\b|leisure|entertainment|jeux|streaming|disneyland/, "Loisirs & Culture"],
  [/shopping|achat|retail|vetement|clothing|mode/, "Shopping"],
  [/abonnement|subscription/, "Abonnements"],
  [/voyage|travel|hotel|vacances|avion|flight/, "Voyages"],
  [/[ée]pargne|saving|investissement|\binvest|tirelire/, "Épargne"],
  [/salaire|salary|payroll|revenu|\bincome\b/, "Salaire"],
  [/virement interne|internal transfer|transfer between/, "Virement interne"],
  [/int[ée]r[êe]t|interest|\byield\b|rendement/, "Intérêts"],
  [/^frais|\bfee\b|bank charge|commission/, "Frais bancaires"],
  [/imp[ôo]t|\btax(e)?s?\b/, "Impôts & Taxes"],
  [/assurance|insurance/, "Assurance"],
  [/enfant|\bchild(ren)?\b|kids|garderie|creche|cantine|formation/, "Enfants"],
  [/cadeau|\bdon\b|\bgift\b|charity|charite|association/, "Cadeaux & Dons"],
];

function normalizeImportedCategory(raw, fallbackToRaw = true) {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[_\-]+/g, " ").trim();
  for (const [re, cat] of CATEGORY_MAP_RULES) {
    if (re.test(s)) return cat;
  }
  return fallbackToRaw ? raw : null; // unrecognized — keep as-is, or leave for manual categorization
}

// Generic placeholder labels a bank/app puts on a transfer when there's no
// specific purpose to name (e.g. Deblock's default "Fait depuis Green-Got"
// for an app-initiated transfer with no note). Many unrelated, one-off
// transfers can share exactly this text, so grouping by it as if it were
// one recurring payment would be wrong — these never count as recurring,
// however often they occur.
const GENERIC_LABELS = new Set(["fait depuis green-got", "versement", "retrait", "virement", ""]);

// A grouping key for matching the "same" recurring bill across months even
// when its label embeds a month name, invoice number, or date that changes
// every time (e.g. "FACTURE CANTINE MAI26" vs "...JUIN26") — strips that
// noise so ILEK, Bouygues, etc. still group together despite the exact
// text differing. Returns null for generic placeholder labels, which are
// deliberately excluded from grouping (see GENERIC_LABELS above).
function labelGroupingKey(rawLabel) {
  const label = rawLabel?.trim();
  if (!label) return null;
  const lower = label.toLowerCase();
  if (GENERIC_LABELS.has(lower)) return null;
  const months = "janv|janvier|fev|fevr|fevrier|févr|février|mars|avr|avril|mai|juin|juil|juillet|aout|août|sept|septembre|oct|octobre|nov|novembre|dec|dece|décembre";
  return lower
    .replace(/["]/g, "")
    .replace(new RegExp(`\\b(${months})\\.?\\s?\\d{0,4}\\b`, "g"), " ")
    .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, " ") // dd/mm/yyyy
    .replace(/\b\d{5,}\b/g, " ") // long reference/invoice numbers
    .replace(/\s+/g, " ")
    .trim();
}

// Green Got's exact category codes, confirmed from a real export. TRANSFER
// is deliberately left unmapped here — it covers everything from rent to
// loan repayments to savings, so it's handled separately by reading the
// Référence column instead (see extractTransactionsFromRows).
const GREEN_GOT_CATEGORY_MAP = {
  FOOD_GROCERIES: "Alimentation",
  RESTAURANTS_BARS: "Restaurants",
  TRAVEL_TRANSPORTATION: "Transport",
  HOUSING: "Logement",
  HEALTH: "Santé",
  SPORT_ENTERTAINMENT: "Loisirs & Culture",
  CLOTHING_BEAUTY: "Shopping",
  COMMUNICATION_FINANCE: "Abonnements",
  INCOME: "Salaire",
  FEE: "Frais bancaires",
  BENEFIT: "Autre",
  OTHER: "Autre",
  WITHDRAWAL: "Autre",
};

// Extracts individual transactions (date, label, signed amount, category)
// from generic CSV rows. Handles both "signed montant" exports and
// "unsigned montant + Direction" exports (e.g. Green Got: Montant always
// positive, Direction = DEBIT/CREDIT). Captures a category column when the
// source file has one (e.g. Green Got's "Catégorie"), normalized onto the
// app's own category list, otherwise leaves it null for later manual
// categorization. De-duplicates on a transaction-ID column when present,
// so importing the same file twice never double-counts.
function extractTransactionsFromRows(rows, fields) {
  const dateCol = findCol(fields, ["date"]);
  const montantCol = findCol(fields, ["montant", "amount"]);
  const debitCol = findCol(fields, ["débit", "debit"]);
  const creditCol = findCol(fields, ["crédit", "credit"]);
  const directionCol = findCol(fields, ["direction", "sens"]);
  const statusCol = findCol(fields, ["statut", "status"]);
  const idCol = findCol(fields, ["n° transaction", "numero transaction", "id transaction", "transaction id", "identifiant"]);
  const labelCol = findCol(fields, ["intitulé", "intitule", "libellé", "libelle", "opération", "operation", "label", "description", "tiers"]);
  const categoryCol = findCol(fields, ["catégorie", "categorie", "category"]);
  const referenceCol = findCol(fields, ["référence", "reference"]);

  if (!dateCol || (!montantCol && !debitCol && !creditCol)) return null;

  const seenIds = new Set();
  const out = [];
  for (const row of rows) {
    if (statusCol) {
      const s = String(row[statusCol] || "").trim().toUpperCase();
      if (s && !["COMPLETE", "COMPLETED", "SETTLED", "OK", "SUCCESS"].includes(s)) continue;
    }
    const txId = idCol ? row[idCol] : null;
    if (txId) {
      if (seenIds.has(txId)) continue;
      seenIds.add(txId);
    }

    const d = new Date(row[dateCol]);
    if (isNaN(d.getTime())) continue;
    const iso = d.toISOString().slice(0, 10);

    let amount = 0;
    if (montantCol && directionCol) {
      const amt = Math.abs(toNumber(row[montantCol]));
      if (!isNaN(amt)) {
        const dir = String(row[directionCol] || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "") // strip accents: "Crédit" -> "Credit", "Entrée" -> "Entree"
          .toUpperCase();
        amount = dir.includes("CREDIT") || dir.includes("IN") || dir.includes("ENTR") ? amt : -amt;
      }
    } else if (montantCol) {
      amount = toNumber(row[montantCol]);
      if (isNaN(amount)) amount = 0;
    } else {
      const debit = toNumber(row[debitCol]);
      const credit = toNumber(row[creditCol]);
      amount = (isNaN(credit) ? 0 : credit) - (isNaN(debit) ? 0 : Math.abs(debit));
    }

    let label = labelCol ? String(row[labelCol] || "").trim() : "";
    let category = null;
    const rawCategory = categoryCol ? String(row[categoryCol] || "").trim() : "";
    const reference = referenceCol ? String(row[referenceCol] || "").trim() : "";

    if (rawCategory === "TRANSFER") {
      // Green Got's "TRANSFER" bucket covers rent, loan repayments, savings,
      // insurance… too broad to map to one category. Its Intitulé is just
      // the account holder's own name (a self-transfer), but Référence
      // carries the real purpose (e.g. "Loyer", "Assurances") — use that
      // instead, both as the label and to guess a specific category.
      if (reference) {
        label = reference;
        category = normalizeImportedCategory(reference, false);
      }
    } else if (rawCategory) {
      category = GREEN_GOT_CATEGORY_MAP[rawCategory] || normalizeImportedCategory(rawCategory);
    }

    out.push({
      id: txId || null,
      date: iso,
      label,
      amount: Math.round(amount * 100) / 100,
      category,
    });
  }
  return out;
}

// The stable identity of a transaction: its real id when the source gives
// one (e.g. Green Got's "N° transaction"), otherwise a content-based key.
// Never includes a random value or array index — those would make the same
// logical transaction look "new" on every re-import, defeating
// deduplication and leaving orphaned duplicates behind after a deletion.
function txKey(t) {
  return t.id || `${t.date}|${t.label}|${t.amount}`;
}

// Turns a transaction list into daily running balances, working backward
// from `endBalance` — the balance as of the LAST transaction's date in
// this set, not necessarily today (see call sites for how the anchor date
// is presented to the user). Assuming "today" regardless of how recent
// the data actually is was the bug: importing an older file and anchoring
// it to today's real balance silently ignores every transaction that
// happened between the file's end and today, producing wrong — sometimes
// negative — historical figures.
function balancesFromTransactions(transactions, endBalance) {
  if (!transactions.length) return [];
  const byDate = new Map();
  transactions.forEach((t) => byDate.set(t.date, (byDate.get(t.date) || 0) + t.amount));

  const days = Array.from(byDate.keys()).sort();
  const totalDelta = days.reduce((s, iso) => s + byDate.get(iso), 0);
  let running = endBalance - totalDelta;

  return days.map((iso) => {
    running += byDate.get(iso);
    return { date: iso, balance: Math.round(running * 100) / 100 };
  });
}

// Like balancesFromTransactions, but anchored on a specific known date
// (e.g. a statement's end-of-period balance) instead of today — used when
// reconstructing history from an old file, where "extend to today" would
// be wrong.
function balancesEndingAt(transactions, endDate, endBalance) {
  if (!transactions.length) return [{ date: endDate, balance: Math.round(endBalance * 100) / 100 }];
  const byDate = new Map();
  transactions.forEach((t) => byDate.set(t.date, (byDate.get(t.date) || 0) + t.amount));

  const days = Array.from(byDate.keys()).sort();
  const totalDelta = days.reduce((s, iso) => s + byDate.get(iso), 0);
  let running = endBalance - totalDelta;

  const dailyEntries = days.map((iso) => {
    running += byDate.get(iso);
    return { date: iso, balance: Math.round(running * 100) / 100 };
  });

  const lastDay = days[days.length - 1];
  if (lastDay < endDate) {
    dailyEntries.push({ date: endDate, balance: Math.round(endBalance * 100) / 100 });
  } else {
    dailyEntries[dailyEntries.length - 1].balance = Math.round(endBalance * 100) / 100;
  }
  return dailyEntries;
}

// When importing transactions that don't carry their own balance (e.g. a
// plain CSV of mouvements), the account itself may already have a known
// balance nearby that can serve as the anchor — no need to ask the person
// to type one in again. Finds the closest existing entry strictly AFTER
// the new data (preferred: reconstruct backward, ending there) or, if
// there's none, the closest one strictly BEFORE (reconstruct forward from
// there). This also covers filling a gap BETWEEN two already-known
// periods — e.g. importing 2024 while 2023 and 2026 are both already on
// the account — not just extending before everything or after everything.
// Returns null (falls back to asking for a balance) if the account has no
// usable entries on either side.
function autoAnchorEntries(account, transactions) {
  if (!transactions || !transactions.length) return null;
  const existing = sortedEntries(account);
  if (!existing.length) return null;
  const txStart = transactions[0].date;
  const txEnd = transactions[transactions.length - 1].date;

  const after = existing.filter((e) => e.date > txEnd);
  const nextEntry = after.length ? after[0] : null;
  const before = existing.filter((e) => e.date < txStart);
  const prevEntry = before.length ? before[before.length - 1] : null;

  if (nextEntry) {
    // nextEntry.balance already has that day's own transactions applied —
    // back them out first, so the anchor handed to balancesEndingAt is
    // the balance strictly BEFORE that date, not after. Missing this
    // silently double-counts that day's activity, corrupting every
    // earlier reconstructed day by exactly that day's net total.
    const sameDayTotal = (account.transactions || [])
      .filter((t) => t.date === nextEntry.date)
      .reduce((s, t) => s + t.amount, 0);
    const trueAnchorBalance = Math.round((nextEntry.balance - sameDayTotal) * 100) / 100;
    return balancesEndingAt(transactions, nextEntry.date, trueAnchorBalance).filter((e) => e.date < nextEntry.date);
  }
  if (prevEntry) {
    // Symmetric case extending forward — skip re-counting prevEntry's own
    // activity if the new data happens to include that exact day too
    // (it's already baked into prevEntry.balance).
    const byDate = new Map();
    transactions.forEach((t) => {
      if (t.date === prevEntry.date) return;
      byDate.set(t.date, (byDate.get(t.date) || 0) + t.amount);
    });
    const days = Array.from(byDate.keys()).sort();
    let running = prevEntry.balance;
    return days.map((d) => {
      running += byDate.get(d);
      return { date: d, balance: Math.round(running * 100) / 100 };
    });
  }
  return null;
}

// Kept for existing call sites (AccountModal's movement import): parses a
// CSV's rows straight into daily balances, anchored on today's balance.
function transactionsToBalances(rows, fields, currentBalance) {
  const txs = extractTransactionsFromRows(rows, fields);
  if (!txs) return null;
  return balancesFromTransactions(txs, currentBalance);
}

// Merge two entry lists keyed by date — the incoming list wins on overlap,
// so re-importing an unchanged file is a no-op and an updated export just
// refreshes the matching days. Never produces duplicate dates.
function mergeEntriesByDate(existing, incoming) {
  const map = new Map((existing || []).map((e) => [e.date, e.balance]));
  (incoming || []).forEach((e) => map.set(e.date, e.balance));
  return Array.from(map.entries()).map(([date, balance]) => ({ date, balance }));
}

// Credit accounts specifically: on a date conflict, keep the LOWER balance
// rather than whichever file was imported last — this makes re-importing
// an updated échéancier safe regardless of import order (an older schedule
// re-imported after a newer one can't push the balance back up; an early
// repayment reflected in a newer schedule always wins over a stale higher
// figure). Also drops any 0€ entry that isn't the chronologically last
// one — a stray zero anywhere else in the timeline can only be a parsing
// artifact, since a loan balance shouldn't hit zero and then rise again.
function mergeCreditEntries(existing, incoming) {
  const map = new Map((existing || []).map((e) => [e.date, e.balance]));
  (incoming || []).forEach((e) => {
    map.set(e.date, map.has(e.date) ? Math.min(map.get(e.date), e.balance) : e.balance);
  });
  const sorted = Array.from(map.entries())
    .map(([date, balance]) => ({ date, balance }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted.filter((e, i) => e.balance !== 0 || i === sorted.length - 1);
}

// Merge two transaction lists, de-duplicating on their stable key (see
// txKey) — so the same transaction seen across separate/overlapping
// imports collapses to one entry instead of accumulating duplicates.
function mergeTransactions(existing, incoming) {
  const map = new Map((existing || []).map((t) => [txKey(t), t]));
  (incoming || []).forEach((t) => map.set(txKey(t), t));
  return Array.from(map.values()).sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
}

// Merge date-range intervals (each {start, end}, ISO strings), collapsing
// overlapping or adjacent ranges into a minimal covering set.
function mergeDateRanges(existing, incoming) {
  const all = [...(existing || []), ...(incoming || [])].filter((r) => r && r.start && r.end);
  if (!all.length) return [];
  all.sort((a, b) => (a.start > b.start ? 1 : -1));
  const merged = [all[0]];
  for (let i = 1; i < all.length; i++) {
    const last = merged[merged.length - 1];
    const cur = all[i];
    // Adjacent (next day) or overlapping ranges get merged into one.
    const lastEndPlus1 = new Date(last.end);
    lastEndPlus1.setUTCDate(lastEndPlus1.getUTCDate() + 1);
    if (cur.start <= lastEndPlus1.toISOString().slice(0, 10)) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

// Coverage status for a given "YYYY-MM" month against a set of merged
// date ranges: "full" (every day covered), "partial" (some days covered),
// or "none".
function monthCoverageStatus(yearMonth, ranges) {
  if (!ranges || !ranges.length) return "none";
  const [y, m] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  let covered = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (ranges.some((r) => iso >= r.start && iso <= r.end)) covered++;
  }
  if (covered === 0) return "none";
  if (covered === daysInMonth) return "full";
  return "partial";
}

// Reads a "Date d'échéance" + "Capital dû avant l'échéance" style CSV
// (an amortization schedule exported from a bank), returning entries
// directly usable as account history — no anchoring needed, the balance
// is already given per date.
function parseAmortizationCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const fields = res.meta.fields || [];
        const dateCol = findCol(fields, ["date"]);
        const balCol = findCol(fields, [
          "capital dû avant l'échéance", "capital du avant", "capital restant", "encours", "capital dû", "capital du", "solde",
        ]);
        const paymentCol = findCol(fields, [
          "échéance assurance groupe comprise", "echeance assurance groupe comprise", "mensualité", "mensualite",
        ]);
        if (!dateCol || !balCol) {
          resolve({ entries: [], rate: null, monthly: null });
          return;
        }
        const entries = res.data
          .map((row) => {
            const d = new Date(row[dateCol]);
            const b = toNumber(row[balCol]);
            return isNaN(d.getTime()) || isNaN(b) ? null : { date: d.toISOString().slice(0, 10), balance: b };
          })
          .filter(Boolean)
          .sort((a, b) => (a.date > b.date ? 1 : -1));

        let monthly = null;
        if (paymentCol) {
          const values = res.data.map((row) => toNumber(row[paymentCol])).filter((v) => !isNaN(v));
          if (values.length > 1) monthly = values[1]; // skip a possibly prorated first row
        }
        resolve({ entries, rate: null, monthly });
      },
      error: (err) => reject(err),
    });
  });
}

// Lazily loads pdf.js from a CDN (no bundled PDF library is available in
// this environment) and caches the loaded module on window.
let pdfJsLoadPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfJsLoadPromise) return pdfJsLoadPromise;
  pdfJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error("lecteur PDF indisponible"));
    document.head.appendChild(script);
  });
  return pdfJsLoadPromise;
}

// Lazily loads jsPDF (a PDF *writer*, unlike pdf.js above which only
// reads) — used to generate the downloadable financial report entirely
// in the browser, with no server/API involved.
let jsPdfLoadPromise = null;
function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (jsPdfLoadPromise) return jsPdfLoadPromise;
  jsPdfLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    script.onload = () => {
      try {
        resolve(window.jspdf.jsPDF);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error("générateur PDF indisponible"));
    document.head.appendChild(script);
  });
  return jsPdfLoadPromise;
}

// Clusters a PDF's positioned text items into visual rows (grouping by
// y-position with a small tolerance), preserving each token's x-position —
// needed to tell apart columns (e.g. Débit vs Crédit) that text extraction
// alone would otherwise linearize into one ambiguous sequence.
async function extractPdfRows(pdf) {
  let fullText = "";
  const lines = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    const items = content.items
      .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str }))
      .sort((a, b) => b.y - a.y || a.x - b.x);

    let currentRow = [];
    let currentY = null;
    const rows = [];
    for (const it of items) {
      if (currentY === null || Math.abs(it.y - currentY) <= 2.5) {
        currentRow.push(it);
        currentY = currentY === null ? it.y : currentY;
      } else {
        rows.push(currentRow);
        currentRow = [it];
        currentY = it.y;
      }
    }
    if (currentRow.length) rows.push(currentRow);

    for (const row of rows) {
      const sorted = row.sort((a, b) => a.x - b.x);
      const text = sorted.map((t) => t.str).join(" ").replace(/\s+/g, " ").trim();
      if (text) {
        lines.push({ text, tokens: sorted, page: p });
        fullText += text + "\n";
      }
    }
  }
  return { lines, fullText };
}

// Extracts an amortization schedule from a PDF (Crédit Mutuel-style table:
// Date d'échéance | Capital dû avant l'échéance | Capital | Intérêts |
// Assurance | Échéance assurance groupe comprise) by reconstructing rows
// from the PDF's positioned text, then regex-matching each row. This is a
// best-effort client-side reader — always double-check the imported values.
async function parseAmortizationPdf(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const { lines, fullText } = await extractPdfRows(pdf);

  // Guard: only engage for a genuine échéancier, identified by markers
  // that survive text extraction intact. The column header itself doesn't
  // work as a signature here — "Capital dû" and "avant l'échéance" are on
  // two visual sub-lines, but *every* column's first sub-line is
  // extracted before *any* column's second sub-line (row-band by
  // row-band, not column by column), so those two phrases never end up
  // adjacent in the extracted text at all. "PRET ..." (the loan
  // reference, e.g. "PRET MULTIPROJETS") and "Total prévisionnel" (the
  // schedule's closing summary row) are single-line and reliable instead.
  if (!/\bPRET\s+[A-ZÉÈ]/i.test(fullText) && !/Total\s+pr[ée]visionnel/i.test(fullText)) {
    return { entries: [], rate: null, monthly: null, institutionGuess: null, nameGuess: null };
  }

  const entries = [];
  for (const line of lines) {
    const m = line.text.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.*)$/);
    if (!m) continue;
    const [dd, mm, yyyy] = m[1].split("/");
    const tokens = m[2].trim().split(/\s+/).filter((t) => /^[\d.,]+$/.test(t));
    if (tokens.length < 2) continue;
    const balance = toNumber(tokens[0]);
    const lastToken = toNumber(tokens[tokens.length - 1]);
    if (isNaN(balance)) continue;
    entries.push({ date: `${yyyy}-${mm}-${dd}`, balance, lastToken });
  }

  if (!entries.length) return { entries: [], rate: null, monthly: null };

  entries.sort((a, b) => (a.date > b.date ? 1 : -1));

  const rateMatch = fullText.match(/Taux fixe actuel[^:]*:\s*([\d.,]+)\s*%/i);
  const rate = rateMatch ? toNumber(rateMatch[1]) : null;

  const institutionMatch = fullText.match(/CR[ÉE]DIT\s+MUTUEL|BNP\s+PARIBAS|SOCI[ÉE]T[ÉE]\s+G[ÉE]N[ÉE]RALE|CAISSE\s+D['’]?[ÉE]PARGNE|LA\s+BANQUE\s+POSTALE|BOURSORAMA|CR[ÉE]DIT\s+AGRICOLE/i);
  const institutionGuess = institutionMatch ? institutionMatch[0].replace(/\s+/g, " ").trim() : null;

  const objectMatch = fullText.match(/Objet de financement\s*:?\s*([^\n]+)/i);
  let nameGuess = null;
  if (objectMatch) {
    const obj = objectMatch[1].toUpperCase();
    if (/VEHICULE|VÉHICULE|AUTO/.test(obj)) nameGuess = "Crédit voiture";
    else if (/MAISON|HABITATION|IMMO|APPART/.test(obj)) nameGuess = "Crédit immobilier";
    else if (/TRAVAUX/.test(obj)) nameGuess = "Crédit travaux";
    else nameGuess = "Crédit " + objectMatch[1].trim().toLowerCase();
  }

  // Most frequent "last column" value across rows = the recurring monthly
  // payment (the very first/last row is often a prorated partial period).
  const counts = new Map();
  entries.forEach((e) => {
    if (isNaN(e.lastToken)) return;
    counts.set(e.lastToken, (counts.get(e.lastToken) || 0) + 1);
  });
  let monthly = null;
  let best = 0;
  counts.forEach((c, v) => {
    if (c > best) { best = c; monthly = v; }
  });

  return { entries: entries.map(({ date, balance }) => ({ date, balance })), rate, monthly, institutionGuess, nameGuess };
}

const FRENCH_MONTHS = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
};

// Reads a Deblock-style statement PDF: rows shaped like
// "1 juillet 1 juillet Rendements "4% Yield" 0,01" (Date, Valeur, Opération,
// Débit/Crédit — the day/month repeated twice, no year on the row itself).
// The year is recovered from the statement's period header ("Transactions
// du compte du 1 juillet 2026 au 1 août 2026"). Débit vs Crédit is told
// apart using each amount token's x-position relative to the header row's
// "Débit"/"Crédit" column positions. Explicit balance lines ("Solde
// onchain au 1 août 2026  161,83 €") are captured as anchors, so no manual
// "solde actuel" is needed when one is found. Best-effort — verify results.
async function parseDeblockPdf(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const { lines, fullText } = await extractPdfRows(pdf);

  if (!/deblock/i.test(fullText)) return null; // not a Deblock export

  // Recover the year from the statement period header.
  const periodMatch = fullText.match(
    /du\s+\d{1,2}\s+[a-zéû]+\s+(\d{4})\s+au\s+\d{1,2}\s+[a-zéû]+\s+(\d{4})/i
  );
  const defaultYear = periodMatch ? Number(periodMatch[2]) : new Date().getFullYear();
  const yearForMonth = (month, isEndOfPeriodGuess) => {
    // If the statement spans a year boundary, an early-year date (e.g.
    // "janvier") near the end of the file likely belongs to the later year.
    if (periodMatch && Number(periodMatch[1]) !== Number(periodMatch[2])) {
      return month <= 6 ? Number(periodMatch[2]) : Number(periodMatch[1]);
    }
    return defaultYear;
  };

  // Track the most recent "Débit"/"Crédit" header x-positions seen, per page
  // (used only as a fallback signal for external rows' débit/crédit side).
  let debitX = null;
  let creditX = null;

  const rawRows = [];
  // Row shape as plain text: "<d> <month> <d> <month> <label...> <amount>".
  // Matching against the whole joined line (rather than iterating discrete
  // PDF text tokens) is far more robust — pdf.js can split a line into
  // tokens in ways that don't line up with "one word per token", which
  // silently breaks a token-by-token parser without any error to show.
  const rowRe = /^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s*(.*?)\s*(\d{1,3}(?:[\s.]\d{3})*,\d{2}|\d+,\d{2})$/;

  for (const line of lines) {
    const headerHasCols = /\bDébit\b/i.test(line.text) && /\bCrédit\b/i.test(line.text);
    if (headerHasCols) {
      const debitTok = line.tokens.find((t) => /^Débit$/i.test(t.str));
      const creditTok = line.tokens.find((t) => /^Crédit$/i.test(t.str));
      if (debitTok) debitX = debitTok.x;
      if (creditTok) creditX = creditTok.x;
      continue;
    }

    const m = line.text.match(rowRe);
    if (!m) continue;
    const [, d1, mon1, , mon2, rawLabel, amountStr] = m;
    if (!FRENCH_MONTHS[mon1.toLowerCase()] || !FRENCH_MONTHS[mon2.toLowerCase()]) continue;

    const label = rawLabel.replace(/["]/g, "").trim();
    const amountVal = toNumber(amountStr);
    if (isNaN(amountVal)) continue;

    const isPoolTransfer = /compte rendement fixe/i.test(label);
    let signed = amountVal;
    if (isPoolTransfer) {
      // "Dépôt"/"Retrait" say the direction plainly — more reliable here
      // than the débit/crédit column position for this specific row type.
      signed = /^d[ée]p[oô]t/i.test(label) ? Math.abs(amountVal) : -Math.abs(amountVal);
    } else {
      const amountTok = line.tokens.find((t) => t.str === amountStr || t.str.replace(/\s+/g, "") === amountStr.replace(/\s+/g, ""));
      if (amountTok && debitX != null && creditX != null) {
        const mid = (debitX + creditX) / 2;
        signed = amountTok.x < mid ? -Math.abs(amountVal) : Math.abs(amountVal);
      } else {
        // Fallback heuristic: card payments / direct debits are expenses,
        // transfers-in/yield/cashback are income.
        const lower = label.toLowerCase();
        signed = /paiement carte|prélèvement|prelevement|retrait/.test(lower) ? -Math.abs(amountVal) : Math.abs(amountVal);
      }
    }

    const month = FRENCH_MONTHS[mon1.toLowerCase()];
    const year = yearForMonth(month);
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d1).padStart(2, "0")}`;

    rawRows.push({ date: iso, label, amount: Math.round(signed * 100) / 100, isPoolTransfer });
  }

  // Track the real money: when Deblock's interest-bearing pocket feature is
  // in use, every external event (a transfer in, a card payment, daily
  // interest) is auto-swept into it via "Dépôt/Retrait compte rendement
  // fixe" lines, which is what actually moves money — so those become the
  // ledger, each labeled with its real-world cause (borrowed from the
  // matching same-day external row) so daily interest stays identifiable.
  // If no such rows exist in this export (feature unused, or only a
  // summary page was provided), fall back to the external transactions
  // directly, anchored on an explicit "Solde ... au [date]" line.
  const poolRows = rawRows.filter((r) => r.isPoolTransfer);
  const otherRows = rawRows.filter((r) => !r.isPoolTransfer);

  let transactions;
  let balanceEntries = [];

  if (poolRows.length > 0) {
    // "Solde onchain au [date]" is this pocket's exact balance (Deblock's
    // fixed-yield product) — reconstruct the daily trajectory from the
    // pool transfers, ending exactly on that figure.
    const onchainRe = /Solde onchain au\s+(\d{1,2})\s+([a-zéûA-ZÉÛ]+)\s+(\d{4})\s+([\d\s.,]+)\s*€/gi;
    let om;
    let onchainAnchor = null;
    while ((om = onchainRe.exec(fullText))) {
      const month = FRENCH_MONTHS[om[2].toLowerCase()];
      if (!month) continue;
      const iso = `${om[3]}-${String(month).padStart(2, "0")}-${String(om[1]).padStart(2, "0")}`;
      const val = toNumber(om[4]);
      if (!isNaN(val)) onchainAnchor = { date: iso, balance: val };
    }
    if (onchainAnchor) {
      balanceEntries = balancesEndingAt(poolRows, onchainAnchor.date, onchainAnchor.balance);
    }

    // Displayed/categorizable mouvements: every row on its own, exactly as
    // the statement lists them — external events (Rendements, Virement,
    // Paiement Carte…) and pool transfers alike — not merged into one
    // another, so nothing is hidden from view (same flat style as a Green
    // Got CSV import).
    transactions = rawRows.map((r, i) => ({
      id: `deblock-${r.date}-${r.label}-${r.amount}-${i}`,
      date: r.date,
      label: r.label,
      amount: r.amount,
      category: /rendements/i.test(r.label) ? "Intérêts" : null,
    }));
  } else {
    transactions = otherRows.map((r) => ({
      id: `deblock-${r.date}-${r.label}-${r.amount}`,
      date: r.date,
      label: r.label,
      amount: r.amount,
      category: /rendements/i.test(r.label) ? "Intérêts" : null,
    }));

    // Explicit balance anchors: "Solde onchain au 1 août 2026  161,83 €",
    // "Solde créditeur au 1 août 2026  0,00 €", "Solde total consolidé — ...".
    // These labels can refer to different scopes within the same PDF, so
    // only the label matching an actual account balance ("créditeur"/
    // "débiteur") is used when more than one distinct reading is present.
    // Matching is accent/case insensitive so encoding quirks in the
    // extracted PDF text can't slip a mismatched reading past the filter.
    const stripAccents = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const balanceMatches = [];
    const balanceRe = /(Solde[^\n€]*?)au\s+(\d{1,2})\s+([a-zéûA-ZÉÛ]+)\s+(\d{4})\s+([\d\s.,]+)\s*€/gi;
    let bm;
    while ((bm = balanceRe.exec(fullText))) {
      const month = FRENCH_MONTHS[bm[3].toLowerCase()];
      if (!month) continue;
      const iso = `${bm[4]}-${String(month).padStart(2, "0")}-${String(bm[2]).padStart(2, "0")}`;
      const val = toNumber(bm[5]);
      if (!isNaN(val)) balanceMatches.push({ label: stripAccents(bm[1].trim().toLowerCase()), date: iso, balance: val });
    }
    const labelPriority = (l) => (l.includes("crediteur") || l.includes("debiteur") ? 0 : l.includes("onchain") ? 1 : 2);
    if (balanceMatches.length) {
      const best = Math.min(...balanceMatches.map((m) => labelPriority(m.label)));
      const chosen = balanceMatches.filter((m) => labelPriority(m.label) === best);
      const byDate = new Map();
      chosen.forEach((m) => byDate.set(m.date, m.balance));
      balanceEntries = Array.from(byDate.entries()).map(([date, balance]) => ({ date, balance }));
    }
  }

  transactions.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
  const dateRange = transactions.length
    ? { start: transactions[0].date, end: transactions[transactions.length - 1].date }
    : null;

  const ibanMatch = fullText.match(/IBAN\s+([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,4}){3,8})/i);
  const ibanGuess = ibanMatch ? ibanMatch[1].replace(/\s+/g, "") : null;
  const bicMatch = fullText.match(/BIC\s+([A-Z0-9]{8,11})/i);
  const bicGuess = bicMatch ? bicMatch[1] : null;
  const nameGuess = /COMPTE DE PARTICULIER/i.test(fullText) ? "Compte Deblock EUR" : "Deblock";

  return { transactions, balanceEntries, dateRange, institutionGuess: "Deblock", ibanGuess, bicGuess, nameGuess };
}

// Reads a Generali-style assurance-vie statement ("Relevé de situation" or
// "Situation au 31/12/AAAA"): explicit balance snapshots ("Epargne atteinte
// au JJ/MM/AAAA : X €"), plus operations described in plain text
// ("Versement libre programmé de 100,00 € du JJ/MM/AAAA", "Frais de
// gestion de X € du JJ/MM/AAAA"). Arbitrages (internal fund reallocations)
// don't change the total contract value, so they're not logged as
// transactions. Best-effort — verify results after import.
async function parseGeneraliPdf(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const { fullText } = await extractPdfRows(pdf);

  const looksGenerali = /GENERALI/i.test(fullText) || /Epargne atteinte|EPARGNE ATTEINTE DE VOTRE CONTRAT/i.test(fullText);
  if (!looksGenerali) return null;

  const contractMatch =
    fullText.match(/Contrat\s*N°\s*:?\s*(\d+)/i) ||
    fullText.match(/N°\s*du\s*contrat\s*:?\s*(\d+)/i);
  const contractGuess = contractMatch ? contractMatch[1] : null;

  const productMatch =
    fullText.match(/Nom du produit\s*:?\s*([^\n]+)/i) ||
    fullText.match(/Votre Contrat\s*:?\s*\n?\s*([^\n]+)/i);
  const nameGuess = productMatch ? productMatch[1].trim() : "Assurance vie Generali";

  const balanceEntries = [];
  const anchorRe = /(?:Epargne atteinte au|EPARGNE ATTEINTE DE VOTRE CONTRAT AU)\s+(\d{2})\/(\d{2})\/(\d{4})\s*:?\s*([\d\s.,]+)\s*€/gi;
  let m;
  while ((m = anchorRe.exec(fullText))) {
    const val = toNumber(m[4]);
    if (!isNaN(val)) balanceEntries.push({ date: `${m[3]}-${m[2]}-${m[1]}`, balance: val });
  }

  const transactions = [];
  const versementRe = /Versement (libre programmé|exceptionnel) de\s+([\d\s.,]+)\s*€\s+du\s+(\d{2})\/(\d{2})\/(\d{4})/gi;
  while ((m = versementRe.exec(fullText))) {
    const val = toNumber(m[2]);
    if (isNaN(val)) continue;
    const iso = `${m[5]}-${m[4]}-${m[3]}`;
    transactions.push({ id: `generali-vers-${iso}-${val}`, date: iso, label: `Versement ${m[1]}`, amount: val, category: "Épargne" });
  }
  const fraisRe = /Frais de gestion de\s+([\d\s.,]+)\s*€\s+du\s+(\d{2})\/(\d{2})\/(\d{4})/gi;
  while ((m = fraisRe.exec(fullText))) {
    const val = toNumber(m[1]);
    if (isNaN(val)) continue;
    const iso = `${m[4]}-${m[3]}-${m[2]}`;
    transactions.push({ id: `generali-frais-${iso}-${val}`, date: iso, label: "Frais de gestion", amount: -val, category: "Frais" });
  }

  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  balanceEntries.sort((a, b) => (a.date < b.date ? -1 : 1));

  if (!balanceEntries.length && !transactions.length) return null;

  const dates = [...transactions.map((t) => t.date), ...balanceEntries.map((e) => e.date)];
  const dateRange = dates.length
    ? { start: dates.reduce((mn, d) => (d < mn ? d : mn)), end: dates.reduce((mx, d) => (d > mx ? d : mx)) }
    : null;

  return {
    transactions,
    balanceEntries,
    dateRange,
    institutionGuess: "Generali",
    ibanGuess: null,
    bicGuess: null,
    contractGuess,
    nameGuess,
  };
}

// Reads a Crédit Mutuel checking-account statement ("RELEVE ET
// INFORMATIONS BANCAIRES" — distinct from the loan amortization schedule
// handled above). Transaction rows are "DD/MM/YYYY DD/MM/YYYY <libellé>
// <montant>", with the montant landing in either a Débit or Crédit column
// disambiguated by its x-position relative to those column headers.
// Explicit "SOLDE CREDITEUR/DEBITEUR AU [date]" lines are used as exact
// balance anchors. Best-effort — verify results after import.
async function parseCreditMutuelStatementPdf(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const { lines, fullText } = await extractPdfRows(pdf);

  if (!/CR[ÉE]DIT\s+MUTUEL/i.test(fullText) || !/RELEVE ET INFORMATIONS BANCAIRES|COMPTE COURANT N°/i.test(fullText)) {
    return null;
  }

  const ibanMatch = fullText.match(/IBAN\s*:?\s*([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,4}){3,8})/i);
  const ibanGuess = ibanMatch ? ibanMatch[1].replace(/\s+/g, "") : null;
  const bicMatch = fullText.match(/BIC\s*:?\s*([A-Z0-9]{8,11})/);
  const bicGuess = bicMatch ? bicMatch[1] : null;

  let debitX = null;
  let creditX = null;
  for (const line of lines) {
    if (/D[ée]bit/i.test(line.text) && /Cr[ée]dit/i.test(line.text)) {
      const dTok = line.tokens.find((t) => /D[ée]bit/i.test(t.str));
      const cTok = line.tokens.find((t) => /Cr[ée]dit/i.test(t.str));
      if (dTok) debitX = dTok.x;
      if (cTok) creditX = cTok.x;
    }
  }

  const rowRe = /^(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+(.*?)\s+([\d.]+,\d{2})$/;
  const transactions = [];
  for (const line of lines) {
    const m = line.text.match(rowRe);
    if (!m) continue;
    const [, dd, mm, yyyy, rawLabel, amountStr] = m;
    if (/^SOLDE\s/i.test(rawLabel)) continue; // handled separately below
    const amountVal = toNumber(amountStr);
    if (isNaN(amountVal)) continue;
    const label = rawLabel.trim();
    const iso = `${yyyy}-${mm}-${dd}`;

    let signed = amountVal;
    const amountTok = line.tokens.find((t) => t.str === amountStr);
    if (amountTok && debitX != null && creditX != null) {
      const mid = (debitX + creditX) / 2;
      signed = amountTok.x < mid ? -Math.abs(amountVal) : Math.abs(amountVal);
    } else {
      const lower = label.toLowerCase();
      signed = /frais|prlv|pr[ée]l[èe]vement|ch[èe]que|ech pret|habitation/.test(lower) ? -Math.abs(amountVal) : Math.abs(amountVal);
    }

    transactions.push({
      id: `cm-${iso}-${label}-${signed}`,
      date: iso,
      label,
      amount: Math.round(signed * 100) / 100,
      category: /ech pret/i.test(label) ? "Logement" : /frais/i.test(label) ? "Frais bancaires" : null,
    });
  }

  const balanceMatches = [];
  const balanceRe = /SOLDE (CR[ÉE]DITEUR|D[ÉE]BITEUR) AU\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+,\d{2})/gi;
  let bm;
  while ((bm = balanceRe.exec(fullText))) {
    const sign = /D[ÉE]BITEUR/i.test(bm[1]) ? -1 : 1;
    const iso = `${bm[4]}-${bm[3]}-${bm[2]}`;
    const val = toNumber(bm[5]);
    if (!isNaN(val)) balanceMatches.push({ date: iso, balance: val * sign });
  }
  const byDate = new Map();
  balanceMatches.forEach((e) => byDate.set(e.date, e.balance));
  const balanceEntries = Array.from(byDate.entries()).map(([date, balance]) => ({ date, balance }));

  transactions.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
  const allDates = [...transactions.map((t) => t.date), ...balanceEntries.map((e) => e.date)];
  const dateRange = allDates.length
    ? { start: allDates.reduce((m, d) => (d < m ? d : m)), end: allDates.reduce((m, d) => (d > m ? d : m)) }
    : null;

  if (!transactions.length && !balanceEntries.length) return null;

  return {
    transactions,
    balanceEntries,
    dateRange,
    institutionGuess: "Crédit Mutuel",
    ibanGuess,
    bicGuess,
    nameGuess: "Compte courant",
  };
}

// Reads Crédit Mutuel's Excel export ("Vos comptes" summary sheet + one
// "Cpt <caisse> <numéro>" detail sheet per exported account). Structured
// spreadsheet data is far more reliable to parse than the PDF equivalent —
// no text-extraction guesswork needed. Only the FIRST detail sheet found
// is parsed; if the export covers several accounts at once, re-import for
// each one, or ask for the export to be regenerated per account.
async function parseCreditMutuelXlsx(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });

  const detailSheetName = wb.SheetNames.find((name) => /^Cpt\s+\d/.test(name));
  if (!detailSheetName) return null;

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[detailSheetName], { header: 1, raw: true, defval: null });
  if (!rows.length) return null;

  const titleMatch = String(rows[0]?.[0] || "").match(/Situation de votre compte\s+(.+?)\s*\(EUR\)\s*au/i);
  const nameGuess = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : detailSheetName;
  const ribRow = rows.find((r) => typeof r[0] === "string" && /^R\.I\.B\.\s*:/i.test(r[0]));
  const ribMatch = ribRow ? String(ribRow[0]).match(/R\.I\.B\.\s*:\s*(.+)/i) : null;
  const contractGuess = ribMatch ? ribMatch[1].trim() : null;

  const headerIdx = rows.findIndex((r) => r[0] === "Date" && r[2] === "Libellé");
  if (headerIdx === -1) return null;

  // Locate Débit/Crédit by their actual header label rather than assuming
  // fixed column positions — a differently-laid-out export (extra column,
  // swapped order) would otherwise silently flip every transaction's sign,
  // producing a systematically wrong balance history. Falls back to the
  // positions confirmed on the original test export (3, 4) only if the
  // header text itself can't be found.
  const headerRow = rows[headerIdx] || [];
  const debitCol = headerRow.findIndex((c) => typeof c === "string" && /d[ée]bit/i.test(c));
  const creditCol = headerRow.findIndex((c) => typeof c === "string" && /cr[ée]dit/i.test(c));
  const debitIdx = debitCol !== -1 ? debitCol : 3;
  const creditIdx = creditCol !== -1 ? creditCol : 4;

  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !(r[0] instanceof Date)) continue; // blank/non-transaction row = end of the list
    const iso = r[0].toISOString().slice(0, 10);
    const label = String(r[2] || "").trim();
    const debit = typeof r[debitIdx] === "number" ? r[debitIdx] : null;
    const credit = typeof r[creditIdx] === "number" ? r[creditIdx] : null;
    const amount = credit != null ? credit : debit != null ? -debit : null;
    if (amount == null) continue;
    transactions.push({
      id: `cm-xlsx-${detailSheetName}-${iso}-${label}-${amount}`,
      date: iso,
      label,
      amount: Math.round(amount * 100) / 100,
      category: /^INTERETS\b/i.test(label) ? "Intérêts" : null,
    });
  }
  transactions.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));

  // "Solde au DD/MM/YYYY :" gives an exact closing balance anchor.
  const balanceEntries = [];
  const closingRow = rows.find((r) => r.some((c) => typeof c === "string" && /^Solde au\s+\d{2}\/\d{2}\/\d{4}\s*:/i.test(c)));
  if (closingRow) {
    const labelCell = closingRow.find((c) => typeof c === "string" && /^Solde au/i.test(c));
    const dateMatch = labelCell.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const balanceCell = closingRow.find((c) => typeof c === "number");
    if (dateMatch && typeof balanceCell === "number") {
      balanceEntries.push({ date: `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`, balance: balanceCell });
    }
  }

  const dateRange = transactions.length
    ? { start: transactions[0].date, end: transactions[transactions.length - 1].date }
    : balanceEntries.length
    ? { start: balanceEntries[0].date, end: balanceEntries[0].date }
    : null;

  if (!transactions.length && !balanceEntries.length) return null;

  const typeGuess = /LIVRET|EPARGNE|ÉPARGNE/i.test(nameGuess) ? "epargne" : "courant";

  return {
    transactions,
    balanceEntries,
    dateRange,
    institutionGuess: "Crédit Mutuel",
    ibanGuess: null,
    bicGuess: null,
    contractGuess,
    nameGuess,
    typeGuess,
  };
}

// Bricks.co category codes -> app categories, for the wallet (liquide)
// view. "Achat de bricks" and "Remboursement de capital" are money moving
// between this wallet and the separate "Investissements" account (see
// below) — tagged "Virement interne" like any other transfer between the
// user's own accounts.
const BRICKS_CATEGORY_MAP = {
  "Achat de bricks": "Virement interne",
  "Remboursement de capital": "Virement interne",
  "Revenus reversés": "Intérêts",
  "Prélèvement à la source": "Impôts & Taxes",
};
const BRICKS_INTERNAL_TYPES = new Set(["Achat de bricks", "Remboursement de capital"]);

// Reads Bricks.co's "transactions wallet" export (real estate crowdfunding
// platform) into one of two views, since a single account can't sensibly
// represent both cash-you-can-withdraw and money-locked-in-a-property:
//   - mode "wallet" (liquide): every movement, balance = actual wallet
//     cash (achats reduce it, remboursements/revenus/dépôts increase it).
//   - mode "invested" (épargne bloquée): only achats/remboursements,
//     balance = capital currently tied up in properties (an achat adds to
//     the position, a remboursement reduces it — signs flipped from the
//     source file, since from the wallet's perspective an achat is an
//     outflow but from the investment's perspective it's an inflow).
// Only "Validée" (settled) rows are used either way.
async function parseBricksXlsx(file, mode = "wallet") {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = wb.SheetNames.find((n) => /transactions wallet/i.test(n));
  if (!sheetName) return null;

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
  if (!rows.length || !("montant (€)" in rows[0]) || !("statut" in rows[0])) return null;

  function toIso(d) {
    const m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  let parsedRows = rows
    .filter((r) => r["statut"] === "Validée")
    .map((r) => ({
      iso: toIso(r["date"]),
      type: r["type"],
      propriete: r["propriété"],
      montant: Number(r["montant (€)"]),
    }))
    .filter((r) => r.iso && !isNaN(r.montant))
    .sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));

  if (mode === "invested") {
    parsedRows = parsedRows.filter((r) => BRICKS_INTERNAL_TYPES.has(r.type));
  }
  if (!parsedRows.length) return null;

  let running = 0;
  const balanceByDate = new Map();
  const transactions = parsedRows.map((r, i) => {
    const amount = mode === "invested" ? -r.montant : r.montant;
    running = Math.round((running + amount) * 100) / 100;
    balanceByDate.set(r.iso, running);
    return {
      id: `bricks-${mode}-${r.iso}-${i}-${amount}`,
      date: r.iso,
      label: r.propriete ? `${r.type} — ${r.propriete}` : r.type,
      amount: Math.round(amount * 100) / 100,
      category: mode === "invested" ? "Épargne" : BRICKS_CATEGORY_MAP[r.type] ?? null,
    };
  });
  const balanceEntries = Array.from(balanceByDate.entries()).map(([date, balance]) => ({ date, balance }));
  if (!balanceEntries.length) return null;

  return {
    transactions,
    balanceEntries,
    dateRange: { start: transactions[0].date, end: transactions[transactions.length - 1].date },
    institutionGuess: "Bricks.co",
    ibanGuess: null,
    nameGuess: mode === "invested" ? "Bricks.co — Investissements" : "Bricks.co — Wallet",
    typeGuess: "epargne",
    liquidityGuess: mode === "invested" ? "bloque" : "semi",
    rateGuess: null,
    monthlyGuess: null,
  };
}

// Generic structured-row parser shared by the CSV and XLSX (non-Crédit
// Mutuel) paths: first tries individual transactions (Green Got-style or
// any date+montant/débit-crédit table), then falls back to a
// balance-snapshot/amortization-schedule style table (date + solde
// already computed, no individual transactions). Returns null if neither
// shape is recognized.
function parseGenericRows(rows, fields) {
  const lower = fields.map((f) => f.toLowerCase());
  const isGreenGot =
    lower.some((f) => f.includes("direction")) &&
    lower.some((f) => f.includes("statut")) &&
    lower.some((f) => f.includes("transaction"));
  const ibanCol = findCol(fields, ["iban du compte", "iban"]);
  const ibanGuess = ibanCol ? (rows.find((r) => r[ibanCol])?.[ibanCol] || null) : null;

  const transactions = extractTransactionsFromRows(rows, fields);
  if (transactions && transactions.length) {
    transactions.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
    return {
      transactions,
      balanceEntries: [],
      dateRange: { start: transactions[0].date, end: transactions[transactions.length - 1].date },
      institutionGuess: isGreenGot ? "Green Got" : null,
      ibanGuess,
      nameGuess: null,
      typeGuess: "courant",
      rateGuess: null,
      monthlyGuess: null,
    };
  }

  const dateCol = findCol(fields, ["date"]);
  const balCol = findCol(fields, [
    "solde", "balance", "capital dû avant l'échéance", "capital du avant", "capital restant", "encours", "capital dû", "capital du",
  ]);
  if (!dateCol || !balCol) return null;
  const balanceEntries = rows
    .map((row) => {
      const d = new Date(row[dateCol]);
      const b = toNumber(row[balCol]);
      return isNaN(d.getTime()) || isNaN(b) ? null : { date: d.toISOString().slice(0, 10), balance: b };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date > b.date ? 1 : -1));
  if (!balanceEntries.length) return null;
  const isSchedule = /capital dû|capital restant|encours/.test(String(balCol).toLowerCase());
  return {
    transactions: [],
    balanceEntries,
    dateRange: { start: balanceEntries[0].date, end: balanceEntries[balanceEntries.length - 1].date },
    institutionGuess: null,
    ibanGuess: null,
    nameGuess: null,
    typeGuess: isSchedule ? "credit" : null,
    rateGuess: null,
    monthlyGuess: null,
  };
}

// Unified statement import: auto-detects Deblock PDF, an amortization
// schedule PDF, or a generic CSV (Green Got-style with categories, plain
// date+montant/débit-crédit, or a balance-snapshot/schedule CSV). Returns
// transactions + any explicit balance anchors + the covered date range,
// plus best-effort guesses (institution, IBAN, account name, account type)
// used to suggest which existing account a file belongs to. Returns null
// if the file's format isn't recognized at all.
async function parseStatementFile(file) {
  const isXlsx = /\.xlsx?$/i.test(file.name) || /spreadsheet|ms-excel/.test(file.type || "");
  if (isXlsx) {
    const cm = await parseCreditMutuelXlsx(file);
    if (cm) {
      return {
        transactions: cm.transactions,
        balanceEntries: cm.balanceEntries,
        dateRange: cm.dateRange,
        institutionGuess: cm.institutionGuess,
        ibanGuess: cm.ibanGuess,
        bicGuess: cm.bicGuess,
        contractGuess: cm.contractGuess,
        nameGuess: cm.nameGuess,
        typeGuess: cm.typeGuess,
        rateGuess: null,
        monthlyGuess: null,
      };
    }
    const bricks = await parseBricksXlsx(file);
    if (bricks) {
      return {
        transactions: bricks.transactions,
        balanceEntries: bricks.balanceEntries,
        dateRange: bricks.dateRange,
        institutionGuess: bricks.institutionGuess,
        ibanGuess: bricks.ibanGuess,
        nameGuess: bricks.nameGuess,
        typeGuess: bricks.typeGuess,
        rateGuess: null,
        monthlyGuess: null,
      };
    }
    // Not a Crédit Mutuel or Bricks.co export — try every sheet as a
    // generic structured table (same logic used for Green Got-style CSVs:
    // a header row plus data rows), since others can export .xlsx too.
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      for (const sheetName of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
        if (!rows.length) continue;
        const fields = Object.keys(rows[0]);
        // Dates come through as JS Date objects (cellDates:true) — the
        // generic parser expects strings it can hand to `new Date(...)`,
        // which also accepts a Date object directly, so no conversion
        // needed here.
        const generic = parseGenericRows(rows, fields);
        if (generic) return generic;
      }
      return { transactions: [], balanceEntries: [], dateRange: null, rawTextPreview: `Feuilles trouvées : ${wb.SheetNames.join(", ")}` };
    } catch (err) {
      return { transactions: [], balanceEntries: [], dateRange: null, rawTextPreview: null };
    }
  }

  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const deblock = await parseDeblockPdf(file);
    if (deblock) {
      return {
        transactions: deblock.transactions,
        balanceEntries: deblock.balanceEntries,
        dateRange: deblock.dateRange,
        institutionGuess: deblock.institutionGuess,
        ibanGuess: deblock.ibanGuess,
        bicGuess: deblock.bicGuess,
        nameGuess: deblock.nameGuess,
        typeGuess: "courant",
        rateGuess: null,
        monthlyGuess: null,
      };
    }
    const generali = await parseGeneraliPdf(file);
    if (generali) {
      return {
        transactions: generali.transactions,
        balanceEntries: generali.balanceEntries,
        dateRange: generali.dateRange,
        institutionGuess: generali.institutionGuess,
        ibanGuess: null,
        bicGuess: null,
        contractGuess: generali.contractGuess,
        nameGuess: generali.nameGuess,
        typeGuess: "epargne",
        rateGuess: null,
        monthlyGuess: null,
      };
    }
    const creditMutuel = await parseCreditMutuelStatementPdf(file);
    if (creditMutuel) {
      return {
        transactions: creditMutuel.transactions,
        balanceEntries: creditMutuel.balanceEntries,
        dateRange: creditMutuel.dateRange,
        institutionGuess: creditMutuel.institutionGuess,
        ibanGuess: creditMutuel.ibanGuess,
        bicGuess: creditMutuel.bicGuess,
        nameGuess: creditMutuel.nameGuess,
        typeGuess: "courant",
        rateGuess: null,
        monthlyGuess: null,
      };
    }
    const schedule = await parseAmortizationPdf(file);
    if (schedule && schedule.entries.length) {
      return {
        transactions: [],
        balanceEntries: schedule.entries,
        dateRange: { start: schedule.entries[0].date, end: schedule.entries[schedule.entries.length - 1].date },
        institutionGuess: schedule.institutionGuess,
        ibanGuess: null,
        nameGuess: schedule.nameGuess,
        typeGuess: "credit",
        rateGuess: schedule.rate,
        monthlyGuess: schedule.monthly,
      };
    }

    // Nothing recognized this PDF — extract the raw text anyway so the
    // caller can show it as a diagnostic (the user can share it back to
    // pin down exactly what a new/changed format looks like, instead of
    // guessing blindly again).
    try {
      const pdfjsLib = await loadPdfJs();
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const { fullText } = await extractPdfRows(pdf);
      return { transactions: [], balanceEntries: [], dateRange: null, rawTextPreview: fullText.slice(0, 4000) };
    } catch (err) {
      return { transactions: [], balanceEntries: [], dateRange: null, rawTextPreview: null };
    }
  }

  return new Promise((resolve) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => resolve(parseGenericRows(res.data, res.meta.fields || [])),
      error: () => resolve(null),
    });
  });
}

// Suggests an existing account for a parsed statement: first by exact IBAN
// or contract-number match, then by a unique institution-name match.
// Returns null if nothing matches confidently (ambiguous or no signal).
function matchAccountForImport(accounts, parsed) {
  if (parsed.ibanGuess) {
    const iban = parsed.ibanGuess.replace(/\s+/g, "").toUpperCase();
    const byIban = accounts.find((a) => a.iban && a.iban.replace(/\s+/g, "").toUpperCase() === iban);
    if (byIban) return byIban;
  }
  if (parsed.contractGuess) {
    const byContract = accounts.find((a) => a.contractNumber && a.contractNumber === parsed.contractGuess);
    if (byContract) return byContract;
  }
  if (parsed.institutionGuess) {
    const needle = parsed.institutionGuess.toLowerCase();
    const matches = accounts.filter((a) => a.institution && a.institution.toLowerCase().includes(needle));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

// Checks a parsed file against one specific target account, for batch
// imports where the account is already chosen (not auto-matched). Only
// flags doubt when the file's detected identity actively conflicts with
// what's stored on the account — a file with no identifying signal at all
// is let through, since there's nothing to contradict.
function fileMatchesAccount(parsed, account) {
  if (parsed.ibanGuess && account.iban) {
    const a = parsed.ibanGuess.replace(/\s+/g, "").toUpperCase();
    const b = account.iban.replace(/\s+/g, "").toUpperCase();
    if (a !== b) return { ok: false, reason: `IBAN différent (${parsed.ibanGuess})` };
  }
  if (parsed.contractGuess && account.contractNumber) {
    if (parsed.contractGuess !== account.contractNumber) {
      return { ok: false, reason: `N° de contrat différent (${parsed.contractGuess})` };
    }
  }
  if (parsed.institutionGuess && account.institution) {
    const a = parsed.institutionGuess.toLowerCase();
    const b = account.institution.toLowerCase();
    if (!a.includes(b) && !b.includes(a)) {
      return { ok: false, reason: `Établissement différent (${parsed.institutionGuess})` };
    }
  }
  return { ok: true };
}

// ---------- Smart Import (auto-detect account) ----------
function SmartImportModal({ accounts, onClose, onImportToAccount, onCreateAccountFromImport }) {
  const [step, setStep] = useState("pick"); // pick | parsing | confirm | choose | needBalance | createForm | error
  const [parsed, setParsed] = useState(null);
  const [filename, setFilename] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [targetAccountId, setTargetAccountId] = useState(null);
  const [balanceInput, setBalanceInput] = useState("");
  const [error, setError] = useState("");
  const [rawTextDiagnostic, setRawTextDiagnostic] = useState(null);
  const fileRef = useRef(null);

  // Create-form fields (only used when creating a brand new account)
  const [draftName, setDraftName] = useState("");
  const [draftInstitution, setDraftInstitution] = useState("");
  const [draftType, setDraftType] = useState("courant");
  const [draftBalance, setDraftBalance] = useState("");
  const [draftRate, setDraftRate] = useState("");
  const [draftMonthly, setDraftMonthly] = useState("");

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setStep("parsing");
    setError("");
    setRawTextDiagnostic(null);
    try {
      // Bricks.co needs an explicit choice (wallet cash vs. locked-away
      // invested capital — a single account can't represent both), asked
      // before the normal parse/match flow rather than guessed.
      if (/\.xlsx?$/i.test(file.name)) {
        const probe = await parseBricksXlsx(file, "wallet");
        if (probe) {
          setSelectedFile(file);
          setFilename(file.name);
          setStep("bricksMode");
          return;
        }
      }
      const result = await parseStatementFile(file);
      if (!result || (!result.transactions.length && !result.balanceEntries.length)) {
        setError("Format non reconnu, ou aucune donnée exploitable dans ce fichier.");
        setRawTextDiagnostic(result?.rawTextPreview || null);
        setStep("error");
        return;
      }
      setParsed(result);
      setFilename(file.name);
      setSelectedFile(file);
      const match = matchAccountForImport(accounts, result);
      if (match) {
        setCandidate(match);
        setStep("confirm");
      } else {
        setStep("choose");
      }
    } catch (err) {
      setError("Impossible de lire ce fichier" + (err?.message ? ` (${err.message})` : "") + ".");
      setStep("error");
    }
  }

  async function chooseBricksMode(mode) {
    setStep("parsing");
    try {
      const bricks = await parseBricksXlsx(selectedFile, mode);
      if (!bricks) {
        setError("Format non reconnu, ou aucune donnée exploitable dans ce fichier.");
        setStep("error");
        return;
      }
      const result = {
        transactions: bricks.transactions,
        balanceEntries: bricks.balanceEntries,
        dateRange: bricks.dateRange,
        institutionGuess: bricks.institutionGuess,
        ibanGuess: null,
        nameGuess: bricks.nameGuess,
        typeGuess: bricks.typeGuess,
        liquidityGuess: bricks.liquidityGuess,
        rateGuess: null,
        monthlyGuess: null,
      };
      setParsed(result);
      const match = matchAccountForImport(accounts, result);
      if (match) {
        setCandidate(match);
        setStep("confirm");
      } else {
        setStep("choose");
      }
    } catch (err) {
      setError("Impossible de lire ce fichier" + (err?.message ? ` (${err.message})` : "") + ".");
      setStep("error");
    }
  }

  const [autoAnchorPreview, setAutoAnchorPreview] = useState(null);

  function proceedWithAccount(accountId) {
    setTargetAccountId(accountId);
    if (parsed.transactions.length > 0 && parsed.balanceEntries.length === 0) {
      const targetAccount = accounts.find((a) => a.id === accountId);
      const auto = targetAccount ? autoAnchorEntries(targetAccount, parsed.transactions) : null;
      if (auto && auto.length) {
        const balances = auto.map((e) => e.balance);
        setAutoAnchorPreview({
          accountId,
          entries: auto,
          min: Math.min(...balances),
          max: Math.max(...balances),
          start: auto[0].date,
          end: auto[auto.length - 1].date,
          hasNegative: balances.some((b) => b < 0),
          accountType: targetAccount?.type,
        });
        setStep("confirmAutoAnchor");
        return;
      }
      setStep("needBalance");
    } else {
      const importId = uid();
      onImportToAccount(accountId, parsed, null, filename, importId);
      if (selectedFile) {
        readFileAsDataURL(selectedFile).then((dataUrl) => window.storage.set(`file:${importId}`, dataUrl, false)).catch(() => {});
      }
      onClose();
    }
  }

  function confirmAutoAnchor() {
    if (!autoAnchorPreview) return;
    const enriched = { ...parsed, balanceEntries: autoAnchorPreview.entries };
    const importId = uid();
    onImportToAccount(autoAnchorPreview.accountId, enriched, null, filename, importId);
    if (selectedFile) {
      readFileAsDataURL(selectedFile).then((dataUrl) => window.storage.set(`file:${importId}`, dataUrl, false)).catch(() => {});
    }
    onClose();
  }

  function rejectAutoAnchor() {
    setAutoAnchorPreview(null);
    setStep("needBalance");
  }

  function confirmBalance() {
    if (balanceInput === "") {
      setError("Indique le solde actuel pour ancrer l'historique.");
      return;
    }
    const importId = uid();
    onImportToAccount(targetAccountId, parsed, Number(balanceInput), filename, importId);
    if (selectedFile) {
      readFileAsDataURL(selectedFile).then((dataUrl) => window.storage.set(`file:${importId}`, dataUrl, false)).catch(() => {});
    }
    onClose();
  }

  function openCreateForm() {
    setDraftName(parsed.nameGuess || "");
    setDraftInstitution(parsed.institutionGuess || "");
    setDraftType(parsed.typeGuess || "courant");
    setDraftRate(parsed.rateGuess != null ? String(parsed.rateGuess) : "");
    setDraftMonthly(parsed.monthlyGuess != null ? String(parsed.monthlyGuess) : "");
    if (parsed.balanceEntries.length) {
      setDraftBalance(String(parsed.balanceEntries[parsed.balanceEntries.length - 1].balance));
    } else {
      setDraftBalance("");
    }
    setStep("createForm");
  }

  function submitCreateForm(e) {
    e.preventDefault();
    if (!draftName.trim()) {
      setError("Indique un nom de compte.");
      return;
    }
    const needsManualBalance = parsed.transactions.length > 0 && parsed.balanceEntries.length === 0;
    if (needsManualBalance && draftBalance === "") {
      setError("Indique le solde actuel pour ancrer l'historique.");
      return;
    }
    try {
      const entries = parsed.balanceEntries.length
        ? parsed.balanceEntries
        : balancesFromTransactions(parsed.transactions, Number(draftBalance));
      const importId = uid();
      const account = {
        id: uid(),
        name: draftName.trim(),
        type: draftType,
        institution: draftInstitution,
        iban: parsed.ibanGuess || "",
        bic: parsed.bicGuess || "",
        contractNumber: parsed.contractGuess || "",
        credit: draftType === "credit" ? { rate: Number(draftRate) || 0, monthlyPayment: Number(draftMonthly) || 0 } : undefined,
        liquidity: draftType === "epargne" ? (parsed.liquidityGuess || "semi") : undefined,
        savings: undefined,
        entries,
        transactions: parsed.transactions,
        coverage: parsed.dateRange ? [parsed.dateRange] : [],
        imports: [{
          id: importId,
          timestamp: new Date().toISOString(),
          filename: filename || null,
          transactionIds: (parsed.transactions || []).map((t) => txKey(t)),
          entryDates: entries.map((e) => e.date),
          dateRange: parsed.dateRange || null,
        }],
      };
      onCreateAccountFromImport(account);
      if (selectedFile) {
        readFileAsDataURL(selectedFile).then((dataUrl) => window.storage.set(`file:${importId}`, dataUrl, false)).catch(() => {});
      }
      onClose();
    } catch (err) {
      setError("Impossible de créer le compte" + (err?.message ? ` (${err.message})` : "") + ".");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto" style={{ background: "rgba(33,38,31,0.45)" }}>
      <div className="w-full max-w-md rounded-xl shadow-xl my-8" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #CFE5D2" }}>
          <h3 className="text-lg" style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#0F2A1C" }}>Importer un fichier</h3>
          <button onClick={onClose} aria-label="Fermer" className="p-1 hover:opacity-60">
            <X size={18} color="#0F2A1C" />
          </button>
        </div>

        {step === "pick" && (
          <div className="px-6 py-5 space-y-3">
            <p className="text-xs" style={{ color: "#4B5D52" }}>
              CSV ou PDF — l'appli essaie de reconnaître automatiquement le compte concerné (établissement, IBAN) et propose une correspondance à valider.
            </p>
            <input ref={fileRef} type="file" accept=".csv,.pdf,.xlsx,.xls" onChange={handleFile} className="hidden" />
            <button
              onClick={() => fileRef.current.click()}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm"
              style={{ border: "1.5px dashed #CFE0D3", color: "#0F2A1C" }}
            >
              <FileSpreadsheet size={16} /> Choisir un fichier
            </button>
          </div>
        )}

        {step === "parsing" && (
          <div className="px-6 py-10 text-center text-sm" style={{ color: "#6B8072" }}>Lecture du fichier…</div>
        )}

        {step === "bricksMode" && (
          <div className="px-6 py-5 space-y-3">
            <p className="text-xs" style={{ color: "#4B5D52" }}>
              Ce fichier Bricks.co peut alimenter deux comptes différents — choisis lequel tu importes maintenant (tu pourras réimporter le même fichier pour l'autre ensuite).
            </p>
            <button
              onClick={() => chooseBricksMode("wallet")}
              className="w-full text-left p-3 rounded-xl"
              style={{ border: "1px solid #CFE0D3" }}
            >
              <div className="text-sm" style={{ color: "#0F2A1C" }}>Wallet (liquide)</div>
              <div className="text-[11px] mt-0.5" style={{ color: "#6B8072" }}>Le cash disponible sur la plateforme, retirable.</div>
            </button>
            <button
              onClick={() => chooseBricksMode("invested")}
              className="w-full text-left p-3 rounded-xl"
              style={{ border: "1px solid #CFE0D3" }}
            >
              <div className="text-sm" style={{ color: "#0F2A1C" }}>Investissements (bloquée)</div>
              <div className="text-[11px] mt-0.5" style={{ color: "#6B8072" }}>Le capital actuellement investi dans des biens, non disponible immédiatement.</div>
            </button>
          </div>
        )}

        {step === "error" && (
          <div className="px-6 py-5 space-y-3">
            <p className="text-xs" style={{ color: "#C2410C" }}>{error}</p>
            {rawTextDiagnostic && (
              <div>
                <p className="text-xs mb-1" style={{ color: "#4B5D52" }}>
                  Format inconnu — copie ce texte et partage-le pour qu'un lecteur dédié soit ajouté :
                </p>
                <textarea
                  readOnly
                  value={rawTextDiagnostic}
                  className="w-full text-[10px] p-2 rounded-xl outline-none"
                  style={{ border: "1px solid #CFE0D3", background: "#F3F8F2", color: "#4B5D52", height: 140, fontFamily: "'IBM Plex Mono', monospace" }}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(rawTextDiagnostic);
                    } catch (err) {
                      // clipboard API unavailable — the textarea above can still be selected/copied manually
                    }
                  }}
                  className="text-xs px-3 py-1.5 rounded-xl mt-2"
                  style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}
                >
                  Copier le texte
                </button>
              </div>
            )}
            <button onClick={() => setStep("pick")} className="w-full py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}>
              Réessayer avec un autre fichier
            </button>
          </div>
        )}

        {step === "confirm" && candidate && (
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm" style={{ color: "#0F2A1C" }}>
              Ce fichier semble correspondre à <strong>{candidate.name}</strong>
              {candidate.institution ? ` (${candidate.institution})` : ""}. C'est le bon compte ?
            </p>
            <div className="flex gap-2">
              <button onClick={() => setStep("choose")} className="flex-1 py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}>
                Non, autre chose
              </button>
              <button onClick={() => proceedWithAccount(candidate.id)} className="flex-1 py-2 rounded-xl text-sm text-white" style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}>
                Oui, importer ici
              </button>
            </div>
          </div>
        )}

        {step === "choose" && (
          <div className="px-6 py-5 space-y-3">
            <p className="text-xs" style={{ color: "#4B5D52" }}>Choisis le compte concerné, ou crée-en un nouveau.</p>
            <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => proceedWithAccount(a.id)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left"
                  style={{ background: "#FFFFFF" }}
                >
                  <span className="text-sm" style={{ color: "#0F2A1C" }}>{a.name}</span>
                  <span className="text-xs" style={{ color: TYPE_META[a.type]?.color }}>{a.institution || TYPE_META[a.type]?.label}</span>
                </button>
              ))}
            </div>
            <button
              onClick={openCreateForm}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm"
              style={{ border: "1.5px dashed #CFE0D3", color: "#0F2A1C" }}
            >
              <Plus size={14} /> Créer un nouveau compte
            </button>
          </div>
        )}

        {step === "confirmAutoAnchor" && autoAnchorPreview && (
          <div className="px-6 py-5 space-y-4">
            <p className="text-xs" style={{ color: "#4B5D52" }}>
              Ce compte a déjà un historique — les {autoAnchorPreview.entries.length} jour(s) du {fmtDate(autoAnchorPreview.start)} au {fmtDate(autoAnchorPreview.end)} ont été reconstitués automatiquement à partir de ce point de repère, sans solde à saisir.
            </p>
            <div className="text-xs px-3 py-2 rounded-xl" style={{ background: "#F3F8F2", color: "#4B5D52" }}>
              Solde reconstitué : de {fmtEURPrecise(autoAnchorPreview.min)} à {fmtEURPrecise(autoAnchorPreview.max)}
            </div>
            {autoAnchorPreview.hasNegative && autoAnchorPreview.accountType !== "credit" && (
              <div className="text-xs px-3 py-2.5 rounded-xl" style={{ background: "#C2410C14", color: "#C2410C", border: "1px solid #C2410C44" }}>
                ⚠️ Le solde reconstitué passe en négatif à certains moments, ce qui est suspect pour ce type de compte. Cela peut vouloir dire que le fichier importé ne couvre pas tous les mouvements réels de la période, ou qu'il manque des données entre les deux. Vérifie avant de valider — ou saisis le solde toi-même si tu le connais.
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={rejectAutoAnchor} className="flex-1 py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}>
                Saisir le solde moi-même
              </button>
              <button onClick={confirmAutoAnchor} className="flex-1 py-2 rounded-xl text-sm text-white" style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}>
                Importer quand même
              </button>
            </div>
          </div>
        )}

        {step === "needBalance" && (
          <div className="px-6 py-5 space-y-4">
            <p className="text-xs" style={{ color: "#4B5D52" }}>
              {parsed.transactions.length} opération(s) trouvée(s). Indique le solde au {parsed.dateRange?.end ? fmtDate(parsed.dateRange.end) : "dernier jour du fichier"} pour reconstituer l'historique.
            </p>
            <div>
              <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>
                Solde au {parsed.dateRange?.end ? fmtDate(parsed.dateRange.end) : "dernier jour du fichier"}
              </label>
              <input
                type="number" step="0.01" value={balanceInput} autoFocus
                onChange={(e) => setBalanceInput(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-xl outline-none"
                style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
              />
            </div>
            {error && <p className="text-xs" style={{ color: "#C2410C" }}>{error}</p>}
            <button onClick={confirmBalance} className="w-full py-2 rounded-xl text-sm text-white" style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}>
              Importer
            </button>
          </div>
        )}

        {step === "createForm" && (
          <form onSubmit={submitCreateForm} className="flex flex-col" style={{ maxHeight: "70vh" }}>
            <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
              <p className="text-xs" style={{ color: "#4B5D52" }}>
                Pas de compte existant reconnu — vérifie/complète les infos ci-dessous pour en créer un.
              </p>
              <div>
                <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Nom du compte</label>
                <input
                  autoFocus value={draftName} onChange={(e) => setDraftName(e.target.value)}
                  placeholder="Ex. Livret A, Compte courant..."
                  className="w-full px-3 py-2 rounded-xl outline-none"
                  style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Type</label>
                <div className="grid grid-cols-4 gap-2">
                  {Object.entries(TYPE_META).map(([key, meta]) => (
                    <button
                      type="button" key={key} onClick={() => setDraftType(key)}
                      className="flex flex-col items-center gap-1 py-2 rounded-xl text-xs"
                      style={{
                        border: draftType === key ? `1.5px solid ${meta.color}` : "1px solid #CFE5D2",
                        background: draftType === key ? `${meta.color}14` : "#FFFFFF",
                        color: draftType === key ? meta.color : "#4B5D52",
                      }}
                    >
                      <meta.icon size={16} />
                      {meta.label.split(" ")[0]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Établissement</label>
                <select
                  value={["Green Got", "Deblock", "Crédit Mutuel", "Bricks.co"].includes(draftInstitution) ? draftInstitution : draftInstitution ? "Autre" : ""}
                  onChange={(e) => setDraftInstitution(e.target.value === "Autre" ? (draftInstitution && !["Green Got", "Deblock", "Crédit Mutuel", "Bricks.co"].includes(draftInstitution) ? draftInstitution : " ") : e.target.value)}
                  className="w-full px-3 py-2 rounded-xl outline-none"
                  style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
                >
                  <option value="">— Aucun —</option>
                  <option value="Green Got">Green Got</option>
                  <option value="Deblock">Deblock</option>
                  <option value="Crédit Mutuel">Crédit Mutuel</option>
                <option value="Bricks.co">Bricks.co</option>
                  <option value="Autre">Autre…</option>
                </select>
                {!["", "Green Got", "Deblock", "Crédit Mutuel"].includes(draftInstitution) && (
                  <input
                    value={draftInstitution.trim() === "" ? "" : draftInstitution}
                    onChange={(e) => setDraftInstitution(e.target.value)}
                    placeholder="Nom de l'établissement"
                    autoFocus
                    className="w-full px-3 py-2 rounded-xl outline-none mt-2"
                    style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
                  />
                )}
              </div>
              {parsed.balanceEntries.length === 0 && (
                <div>
                  <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>
                    Solde au {parsed.dateRange?.end ? fmtDate(parsed.dateRange.end) : "dernier jour du fichier"}
                  </label>
                  <input
                    type="number" step="0.01" value={draftBalance} onChange={(e) => setDraftBalance(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-xl outline-none"
                    style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                </div>
              )}
              {draftType === "credit" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Taux (%)</label>
                    <input
                      type="number" step="0.01" value={draftRate} onChange={(e) => setDraftRate(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl outline-none"
                      style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Mensualité (€)</label>
                    <input
                      type="number" step="0.01" value={draftMonthly} onChange={(e) => setDraftMonthly(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl outline-none"
                      style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 pb-5 pt-3 shrink-0" style={{ borderTop: "1px solid #CFE5D2" }}>
              {error && <p className="text-xs mb-2" style={{ color: "#C2410C" }}>{error}</p>}
              <button type="button" onClick={submitCreateForm} className="w-full py-2 rounded-xl text-sm text-white" style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}>
                Créer le compte et importer
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------- Add Entry / Import Modal ----------
function EntryModal({ account, onClose, onAddEntry, onImportStatement, onImportStatements }) {
  const [date, setDate] = useState(todayISO());
  const [balance, setBalance] = useState("");
  const [mode, setMode] = useState("import");
  const [currentBalanceInput, setCurrentBalanceInput] = useState("");
  const fileRef = useRef(null);
  const [importError, setImportError] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  // Batch results: [{ file, parsed, excluded, reason }]
  const [batch, setBatch] = useState(null);
  const [confirmChecked, setConfirmChecked] = useState(false);

  function submitManual(e) {
    e.preventDefault();
    if (balance === "") return;
    onAddEntry(account.id, { date, balance: Number(balance) });
    onClose();
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setImportError("");
    setImportLoading(true);
    const results = [];
    for (const file of files) {
      try {
        const parsed = await parseStatementFile(file);
        if (!parsed || (!parsed.transactions.length && !parsed.balanceEntries.length)) {
          results.push({
            file, parsed: null, excluded: true,
            reason: "Format non reconnu ou aucune donnée exploitable",
            rawTextPreview: parsed?.rawTextPreview || null,
          });
          continue;
        }
        const match = fileMatchesAccount(parsed, account);
        if (!match.ok) {
          results.push({ file, parsed, excluded: true, reason: match.reason });
        } else {
          results.push({ file, parsed, excluded: false, autoAnchored: null });
        }
      } catch (err) {
        results.push({ file, parsed: null, excluded: true, reason: "Erreur de lecture" + (err?.message ? ` (${err.message})` : "") });
      }
    }

    // Resolve missing balances by chaining through the batch in
    // chronological order, off a "virtual" account state that starts as
    // the real account's own history and accumulates each file's
    // (resolved) entries/transactions as it goes — so e.g. importing
    // 2022+2023+2024 together in one go, with only 2026 already saved,
    // correctly anchors 2024 off 2023 (also in this batch), 2023 off 2022,
    // instead of every file independently anchoring straight off 2026 and
    // silently skipping over its batch-mates.
    const mergeFn = account.type === "credit" ? mergeCreditEntries : mergeEntriesByDate;
    const ordered = results
      .filter((r) => !r.excluded)
      .sort((a, b) => {
        const da = a.parsed.dateRange?.start || "";
        const db = b.parsed.dateRange?.start || "";
        return da < db ? -1 : da > db ? 1 : 0;
      });
    let virtualEntries = [...(account.entries || [])];
    let virtualTransactions = [...(account.transactions || [])];
    for (const r of ordered) {
      if (r.parsed.transactions.length > 0 && r.parsed.balanceEntries.length === 0) {
        const auto = autoAnchorEntries({ entries: virtualEntries, transactions: virtualTransactions }, r.parsed.transactions);
        if (auto && auto.length) {
          r.parsed = { ...r.parsed, balanceEntries: auto };
          const balances = auto.map((e) => e.balance);
          r.autoAnchored = { min: Math.min(...balances), max: Math.max(...balances), hasNegative: balances.some((b) => b < 0) };
        }
      }
      virtualEntries = mergeFn(virtualEntries, r.parsed.balanceEntries || []);
      virtualTransactions = mergeTransactions(virtualTransactions, r.parsed.transactions || []);
    }
    setImportLoading(false);
    setConfirmChecked(false);
    setBatch(results);
  }

  const includedFiles = (batch || []).filter((r) => !r.excluded);
  const excludedFiles = (batch || []).filter((r) => r.excluded);
  const needsBalance = includedFiles.some((r) => r.parsed.transactions.length > 0 && r.parsed.balanceEntries.length === 0);
  const balanceAnchorDate = includedFiles
    .filter((r) => r.parsed.transactions.length > 0 && r.parsed.balanceEntries.length === 0)
    .flatMap((r) => r.parsed.transactions.map((t) => t.date))
    .sort()
    .pop() || null;

  function confirmBatch() {
    if (!confirmChecked) {
      setImportError("Confirme que le(s) fichier(s) correspondent bien à ce compte avant d'importer.");
      return;
    }
    if (needsBalance && currentBalanceInput === "") {
      setImportError("Indique le solde actuel pour ancrer l'historique.");
      return;
    }
    if (!includedFiles.length) return;
    // Merge oldest-period first, so an overlapping boundary date resolves
    // to the more recent file's value (it has that day's own transactions
    // applied) instead of an arbitrary pick based on selection order.
    const orderedFiles = [...includedFiles].sort((a, b) => {
      const da = a.parsed.dateRange?.start || "";
      const db = b.parsed.dateRange?.start || "";
      return da < db ? -1 : da > db ? 1 : 0;
    });
    const items = orderedFiles.map((r) => ({
      result: r.parsed,
      filename: r.file.name,
      importId: uid(),
      currentBalanceInput:
        r.parsed.transactions.length > 0 && r.parsed.balanceEntries.length === 0 ? Number(currentBalanceInput) : null,
    }));
    if (items.length === 1 && !needsBalance) {
      onImportStatement(account.id, items[0].result, null, items[0].filename, items[0].importId);
    } else {
      onImportStatements(account.id, items);
    }
    // Best-effort: save each original file so it can be reopened later from
    // the import history. Never blocks the import itself if it fails.
    orderedFiles.forEach((r, i) => {
      readFileAsDataURL(r.file)
        .then((dataUrl) => window.storage.set(`file:${items[i].importId}`, dataUrl, false))
        .catch(() => {});
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto" style={{ background: "rgba(33,38,31,0.45)" }}>
      <div className="w-full max-w-md rounded-xl shadow-xl my-8" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #CFE5D2" }}>
          <h3 className="text-lg" style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#0F2A1C" }}>
            {batch ? "Fichiers analysés" : "Ajouter un solde"}
          </h3>
          <button onClick={onClose} aria-label="Fermer" className="p-1 hover:opacity-60">
            <X size={18} color="#0F2A1C" />
          </button>
        </div>

        {batch ? (
          <div className="px-6 py-5 space-y-4 max-h-[65vh] overflow-y-auto">
            {includedFiles.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "#15803D" }}>
                  {includedFiles.length} fichier(s) prêt(s) à importer
                </div>
                <div className="space-y-2">
                  {includedFiles.map((r, i) => {
                    const p = r.parsed;
                    const detected = [
                      p.institutionGuess,
                      p.contractGuess ? `Contrat ${p.contractGuess}` : null,
                      p.ibanGuess,
                      p.dateRange ? `${fmtDate(p.dateRange.start)} → ${fmtDate(p.dateRange.end)}` : null,
                    ].filter(Boolean).join(" · ");
                    return (
                      <div key={i} className="text-xs" style={{ color: "#0F2A1C" }}>
                        <div className="truncate">✓ {r.file.name}</div>
                        <div className="pl-4" style={{ color: "#6B8072" }}>{detected || "Aucun identifiant détecté dans ce fichier"}</div>
                        {r.autoAnchored && (
                          <div className="pl-4 mt-0.5" style={{ color: "#6B8072" }}>
                            Solde reconstitué depuis l'historique existant : de {fmtEURPrecise(r.autoAnchored.min)} à {fmtEURPrecise(r.autoAnchored.max)}
                          </div>
                        )}
                        {r.autoAnchored?.hasNegative && account.type !== "credit" && (
                          <div className="pl-4 mt-0.5" style={{ color: "#C2410C" }}>
                            ⚠️ Passe en négatif à certains moments — vérifie que ce fichier couvre bien tous les mouvements de la période avant de valider.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {excludedFiles.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "#C2410C" }}>
                  {excludedFiles.length} fichier(s) exclu(s)
                </div>
                <div className="space-y-1">
                  {excludedFiles.map((r, i) => (
                    <div key={i} className="text-xs" style={{ color: "#4B5D52" }}>
                      <span style={{ color: "#C2410C" }}>✗</span> {r.file.name} — {r.reason}
                      {r.parsed && (
                        <button
                          type="button"
                          onClick={() => setBatch(batch.map((b) => (b.file === r.file ? { ...b, excluded: false } : b)))}
                          className="ml-2 underline"
                          style={{ color: "#0F2A1C" }}
                        >
                          Forcer l'import quand même
                        </button>
                      )}
                      {r.rawTextPreview && (
                        <details className="mt-1">
                          <summary className="cursor-pointer" style={{ color: "#6B8072" }}>Voir le texte extrait</summary>
                          <textarea
                            readOnly
                            value={r.rawTextPreview}
                            className="w-full text-[10px] p-2 rounded-xl outline-none mt-1"
                            style={{ border: "1px solid #CFE0D3", background: "#F3F8F2", color: "#4B5D52", height: 120, fontFamily: "'IBM Plex Mono', monospace" }}
                            onFocus={(e) => e.target.select()}
                          />
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {includedFiles.length > 0 && (
              <label className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl" style={{ background: "#F3F8F2", color: "#0F2A1C" }}>
                <input
                  type="checkbox"
                  checked={confirmChecked}
                  onChange={(e) => setConfirmChecked(e.target.checked)}
                  className="mt-0.5"
                />
                Je confirme que ce(s) fichier(s) correspondent bien à <strong>&nbsp;{account.name}</strong>
              </label>
            )}
            {needsBalance && (
              <div>
                <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>
                  Solde au {balanceAnchorDate ? fmtDate(balanceAnchorDate) : "dernier jour du fichier"}
                </label>
                <input
                  type="number" step="0.01" value={currentBalanceInput} autoFocus
                  onChange={(e) => setCurrentBalanceInput(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 rounded-xl outline-none"
                  style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                />
                <p className="text-[11px] mt-1" style={{ color: "#6B8072" }}>
                  Le solde à cette date précise, pas forcément le solde d'aujourd'hui — c'est le dernier jour couvert par ce fichier.
                </p>
              </div>
            )}
            {importError && <p className="text-xs" style={{ color: "#C2410C" }}>{importError}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setBatch(null)} className="flex-1 py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}>
                Retour
              </button>
              <button
                type="button"
                onClick={confirmBatch}
                disabled={!includedFiles.length || !confirmChecked}
                className="flex-1 py-2 rounded-xl text-sm text-white disabled:opacity-50"
                style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}
              >
                Importer {includedFiles.length > 0 ? `(${includedFiles.length})` : ""}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex px-6 pt-4 gap-2">
              <button
                onClick={() => setMode("manual")}
                className="flex-1 py-2 text-xs rounded-xl"
                style={{ background: mode === "manual" ? "#0F2A1C" : "#F3F8F2", color: mode === "manual" ? "#fff" : "#0F2A1C" }}
              >
                Saisie manuelle
              </button>
              <button
                onClick={() => setMode("import")}
                className="flex-1 py-2 text-xs rounded-xl"
                style={{ background: mode === "import" ? "#0F2A1C" : "#F3F8F2", color: mode === "import" ? "#fff" : "#0F2A1C" }}
              >
                Importer un relevé
              </button>
            </div>

            {mode === "manual" ? (
              <form onSubmit={submitManual} className="px-6 py-5 space-y-4">
                <div>
                  <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Date</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl outline-none"
                    style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }} />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Solde</label>
                  <input type="number" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)}
                    placeholder="0.00" autoFocus
                    className="w-full px-3 py-2 rounded-xl outline-none"
                    style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }} />
                </div>
                <button type="button" onClick={submitManual} className="w-full py-2 rounded-xl text-sm text-white" style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}>
                  Ajouter
                </button>
              </form>
            ) : (
              <div className="px-6 py-5 space-y-3">
                <p className="text-xs" style={{ color: "#4B5D52" }}>
                  Un ou plusieurs fichiers (CSV, ou PDF Deblock/Generali/échéancier). Chaque fichier est vérifié contre ce
                  compte (établissement, IBAN, n° de contrat) — tout fichier douteux est exclu et listé avant l'import.
                </p>
                <input ref={fileRef} type="file" accept=".csv,.pdf,.xlsx,.xls" multiple onChange={handleFiles} className="hidden" />
                <button
                  onClick={() => fileRef.current.click()}
                  disabled={importLoading}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm disabled:opacity-60"
                  style={{ border: "1.5px dashed #CFE0D3", color: "#0F2A1C" }}
                >
                  <FileSpreadsheet size={16} /> {importLoading ? "Lecture en cours…" : "Choisir un ou plusieurs fichiers"}
                </button>
                {importError && <p className="text-xs" style={{ color: "#C2410C" }}>{importError}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Overview ----------
const LIQUIDITY_TIERS = [
  { key: "immediate", label: "Liquidités", sublabel: "Comptes courants", icon: Wallet, color: "#15803D" },
  { key: "semi", label: "Épargne disponible", sublabel: "Assurance vie, actions, crypto, terme…", icon: PiggyBank, color: "#C99A3D" },
  { key: "illiquide", label: "Épargne bloquée", sublabel: "PER, PEE bloqué…", icon: Lock, color: "#7C6F9E" },
];

function Overview({ accounts, onOpenAccount, onAddAccount, onOpenUncategorized, onSmartImport, onOpenReport, rigidCategories, onSaveRigidCategories, blockOrder, onSaveBlockOrder, showBlockControls, goals, onAddGoal, onRemoveGoal, onToggleGoalImportant, onAddManualProvision, onRemoveManualProvision, onSetProvision }) {
  const [mainTab, setMainTab] = useState("overview");
  function moveBlock(id, dir) {
    // Only reorder among blocks on the same tab — swapping across tabs
    // wouldn't be visible anyway, and would be confusing.
    const pageBlocks = blockOrder.filter((bid) => BLOCK_PAGE[bid] === BLOCK_PAGE[id]);
    const idx = pageBlocks.indexOf(id);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= pageBlocks.length) return;
    const otherId = pageBlocks[swapIdx];
    const fullIdx1 = blockOrder.indexOf(id);
    const fullIdx2 = blockOrder.indexOf(otherId);
    const next = [...blockOrder];
    [next[fullIdx1], next[fullIdx2]] = [next[fullIdx2], next[fullIdx1]];
    onSaveBlockOrder(next);
  }
  function BlockControls({ id }) {
    if (!showBlockControls) return null;
    const pageBlocks = blockOrder.filter((bid) => BLOCK_PAGE[bid] === BLOCK_PAGE[id]);
    const idx = pageBlocks.indexOf(id);
    return (
      <div className="flex items-center gap-1 justify-end mb-1.5">
        <span className="text-[10px] mr-1" style={{ color: "#A9B5AB" }}>Déplacer</span>
        <button
          onClick={() => moveBlock(id, -1)}
          disabled={idx <= 0}
          aria-label={`Monter ${BLOCK_LABELS[id]}`}
          className="p-1 rounded-lg disabled:opacity-25"
          style={{ border: "1px solid #CFE5D2" }}
        >
          <ChevronRight size={11} color="#4B5D52" style={{ transform: "rotate(-90deg)" }} />
        </button>
        <button
          onClick={() => moveBlock(id, 1)}
          disabled={idx >= pageBlocks.length - 1}
          aria-label={`Descendre ${BLOCK_LABELS[id]}`}
          className="p-1 rounded-lg disabled:opacity-25"
          style={{ border: "1px solid #CFE5D2" }}
        >
          <ChevronRight size={11} color="#4B5D52" style={{ transform: "rotate(90deg)" }} />
        </button>
      </div>
    );
  }
  const [bankFilter, setBankFilter] = useState(null);
  const knownBanks = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.institution).filter(Boolean))),
    [accounts]
  );
  const filteredAccounts = useMemo(
    () => (bankFilter ? accounts.filter((a) => a.institution === bankFilter) : accounts),
    [accounts, bankFilter]
  );

  const buckets = useMemo(() => {
    const immediate = filteredAccounts.filter((a) => a.type === "courant");
    const semi = filteredAccounts.filter(
      (a) => (a.type === "epargne" && a.liquidity !== "bloque") || (a.type === "crypto" && cryptoLiquidityTier(a) === "semi")
    );
    const illiquide = filteredAccounts.filter(
      (a) => (a.type === "epargne" && a.liquidity === "bloque") || (a.type === "crypto" && cryptoLiquidityTier(a) === "illiquide")
    );
    const dettes = filteredAccounts.filter((a) => a.type === "credit");
    return { immediate, semi, illiquide, dettes };
  }, [filteredAccounts]);

  const totals = useMemo(() => {
    const sum = (arr) => arr.reduce((s, a) => s + currentBalance(a), 0);
    const immediate = sum(buckets.immediate);
    const semi = sum(buckets.semi);
    const illiquide = sum(buckets.illiquide);
    const detteVie = sum(buckets.dettes);
    const detteMois = buckets.dettes.reduce((s, a) => s + (a.credit?.monthlyPayment || 0), 0);
    // Provisioned money within "disponible" — still liquid, still counted
    // in semi, but earmarked (e.g. a tax refund) rather than truly free.
    // Real provisions respect the bank filter like everything else here;
    // the goal reserve (important tirelires) is always computed against
    // every account, since a goal isn't tied to one bank or account.
    const realProvisions = buckets.semi.reduce((s, a) => s + Math.max(0, computeProvisions(a)), 0);
    const goalReserve = computeGoalReserve(accounts, goals);
    const provisions = realProvisions + goalReserve;
    return {
      immediate, semi, illiquide, detteVie, detteMois, provisions,
      semiDisponible: semi - provisions,
      net: immediate + semi + illiquide - detteVie,
      epargneTotal: semi + illiquide,
    };
  }, [buckets, accounts, goals]);

  const provisionBreakdown = useMemo(() => {
    const byReason = {}; // reason -> array of individual items
    const unlabeled = [];
    buckets.semi.forEach((a) => {
      (a.transactions || []).filter((t) => t.provision === true).forEach((t) => {
        const item = { accountId: a.id, accountName: a.name, kind: "tx", itemKey: txKey(t), amount: t.amount };
        if (t.provisionReason) {
          (byReason[t.provisionReason] = byReason[t.provisionReason] || []).push(item);
        } else {
          unlabeled.push(item);
        }
      });
      (a.provisions || []).forEach((p) => {
        const item = { accountId: a.id, accountName: a.name, kind: "manual", itemKey: p.id, amount: p.amount };
        if (p.reason) {
          (byReason[p.reason] = byReason[p.reason] || []).push(item);
        } else {
          unlabeled.push(item);
        }
      });
    });
    const rows = Object.entries(byReason).map(([reason, items]) => {
      const goal = goals.find((g) => g.name === reason);
      const amount = items.reduce((s, it) => s + it.amount, 0);
      return { reason, amount, target: goal ? goal.targetAmount : null, important: goal?.important || false, key: reason, items };
    });
    // Provisions with no reason can't be tied to a goal and can't be
    // meaningfully merged together either (several unrelated "Sans
    // raison" amounts on different accounts would otherwise collapse
    // into one line, making it impossible to tell which one to manage) —
    // so each gets its own row, labeled by account.
    unlabeled.forEach((u) => {
      rows.push({ reason: `Sans raison (${u.accountName})`, amount: u.amount, target: null, important: false, key: `${u.kind}-${u.accountId}-${u.itemKey}`, items: [u] });
    });
    // An "important" goal still reserves its target even before any money
    // has actually been set aside toward it — show it too, at 0.
    goals.forEach((g) => {
      if (g.important && !g.basedOnTotal && !(g.name in byReason)) {
        rows.push({ reason: g.name, amount: 0, target: g.targetAmount, important: true, key: g.id, items: [] });
      }
    });
    return rows.sort((a, b) => b.amount - a.amount);
  }, [buckets.semi, goals]);

  const uncategorizedCount = useMemo(
    () => accounts.reduce((s, a) => s + (a.transactions || []).filter((t) => !t.category).length, 0),
    [accounts]
  );

  // Fixed/contractual spending categories, used for the "rigidité
  // budgétaire" metric — everything else is treated as discretionary.
  // Configurable by the user (see the "Modifier" link on the category
  // breakdown card below), persisted separately from the accounts data.
  const FIXED_CATEGORIES = new Set(rigidCategories);
  // Not real spending — internal moves, so excluded from expense totals.
  // "Salaire" is deliberately NOT here: income is now any positive amount
  // not in this set, so a Salaire-tagged transaction must still count.
  const NON_EXPENSE_CATEGORIES = new Set(["Virement interne", "Épargne", "Intérêts"]);

  const [comparisonRange, setComparisonRange] = useState("Max");
  const [trendMode, setTrendMode] = useState("taux"); // "taux" | "montants"
  const [trendMonths, setTrendMonths] = useState(12); // 3 | 6 | 9 | 12
  const [selectedTrendMonthIdx, setSelectedTrendMonthIdx] = useState(null);
  const [chartMode, setChartMode] = useState("rates"); // "rates" | "accounts" | "tiers"
  const [categoryRangeMonths, setCategoryRangeMonths] = useState(3); // 1 | 3 | 6 | 9 | 12
  const courantAccountsList = useMemo(() => filteredAccounts.filter((a) => a.type === "courant"), [filteredAccounts]);
  const knownGoalReasons = useMemo(
    () =>
      Array.from(
        new Set([
          ...accounts.flatMap((a) => [
            ...(a.transactions || []).map((t) => t.provisionReason).filter(Boolean),
            ...(a.provisions || []).map((p) => p.reason).filter(Boolean),
          ]),
          ...goals.map((g) => g.name),
        ])
      ),
    [accounts, goals]
  );
  const [kpiAccountId, setKpiAccountId] = useState(null);
  const kpiAccount = courantAccountsList.find((a) => a.id === kpiAccountId) || courantAccountsList[0] || null;

  const kpis = useMemo(() => {
    const now = new Date();
    const totalTx = (kpiAccount?.transactions || []).length;
    const totalCategorized = (kpiAccount?.transactions || []).filter((t) => t.category).length;

    // Always the previous complete calendar month (m-1) — never the
    // current, still-partial one.
    const refDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = refDate.getFullYear();
    const m = refDate.getMonth() + 1;
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;

    // Three sums, nothing else: dépenses contraintes, dépenses
    // discrétionnaires, et mouvements catégorisés "Épargne" (any
    // direction — a transfer out to a savings account is what "saving
    // money" looks like on a compte courant), plus revenus (somme des
    // crédits). All scoped to kpiAccount alone — one account at a time,
    // not every courant account mixed together.
    const { income, fixed, flexible, savings } = sumMonthBuckets(kpiAccount, monthStart, monthEnd, FIXED_CATEGORIES);

    const savingsRate = income >= 50 ? (savings / income) * 100 : null;
    const totalControlled = fixed + flexible;
    const rigidity = totalControlled > 0 ? (fixed / totalControlled) * 100 : null;

    // Résilience: liquidités totales contre la moyenne des dépenses
    // (contraint + discrétionnaire) sur TOUS les comptes courants, pas
    // seulement celui sélectionné dans "Compte analysé" — cet indicateur
    // ne doit jamais varier selon le compte choisi pour Épargne/Rigidité.
    let last3Total = 0;
    let last3Count = 0;
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const yy = d.getFullYear();
      const mm = d.getMonth() + 1;
      const start = `${yy}-${String(mm).padStart(2, "0")}-01`;
      const lastDay = new Date(yy, mm, 0).getDate();
      const end = `${yy}-${String(mm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const monthExpenses = courantAccountsList.reduce((s, a) => {
        const b = sumMonthBuckets(a, start, end, FIXED_CATEGORIES);
        return s + b.fixed + b.flexible;
      }, 0);
      if (monthExpenses > 0) {
        last3Total += monthExpenses;
        last3Count += 1;
      }
    }
    const avgMonthlyExpenses = last3Count > 0 ? last3Total / last3Count : null;
    // Liquidités + épargne disponible (agrégées, tous comptes) — pas
    // seulement le solde du compte analysé, qui ne représente qu'une
    // partie de ce qui est mobilisable en cas de besoin.
    const resilienceLiquidity = totals.immediate + totals.semi;
    const runwayMonths = avgMonthlyExpenses > 0 ? resilienceLiquidity / avgMonthlyExpenses : null;

    return {
      income, fixed, flexible, savings, savingsRate, rigidity, runwayMonths,
      monthLabel: `${MONTH_LABELS[m - 1]} ${y}`,
      isCurrentMonth: false,
      dayOfMonth: new Date(y, m, 0).getDate(),
      diagnostic: {
        hasAccount: !!kpiAccount,
        totalTx,
        totalCategorized,
        hasMonthData: income + fixed + flexible + savings > 0,
        noExpensesCategorized: totalControlled === 0,
      },
    };
  }, [accounts, kpiAccount, totals]);

  const categoryData = useMemo(() => {
    const since = daysAgoIso(categoryRangeMonths * 30);
    const byCategory = {};
    (kpiAccount?.transactions || []).forEach((t) => {
      if (t.date >= since && t.amount < 0 && !NON_EXPENSE_CATEGORIES.has(t.category)) {
        const amt = Math.abs(t.amount);
        const cat = t.category || "Non catégorisé";
        byCategory[cat] = (byCategory[cat] || 0) + amt;
      }
    });
    const breakdown = Object.entries(byCategory).map(([cat, amt]) => ({ cat, amt })).sort((a, b) => b.amt - a.amt);
    const total = breakdown.reduce((s, c) => s + c.amt, 0);
    return { breakdown, total };
  }, [kpiAccount, categoryRangeMonths]);

  const monthlyMetrics = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const end = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      months.push({ label: `${MONTH_LABELS[m - 1]} ${String(y).slice(2)}`, start, end });
    }

    return months.map(({ label, start, end }) => {
      const { income, fixed, flexible, savings } = sumMonthBuckets(kpiAccount, start, end, FIXED_CATEGORIES);
      const savingsRate = income >= 50 ? (savings / income) * 100 : null;
      const totalControlled = fixed + flexible;
      const rigidity = totalControlled > 0 ? (fixed / totalControlled) * 100 : null;
      return { label, savingsRate, rigidity, income, savings, netSavings: income - fixed - flexible, fixedAmount: fixed };
    });
  }, [kpiAccount]);

  const payoffTimeline = useMemo(() => computePayoffTimeline(buckets.dettes), [buckets.dettes]);

  const comparableAccounts = useMemo(
    () => [...buckets.immediate, ...buckets.semi, ...buckets.illiquide].filter((a) => (a.entries || []).length > 1),
    [buckets]
  );
  const comparisonData = useMemo(() => {
    if (!comparableAccounts.length) return { rows: [], accounts: [] };
    const rangeDays = { "3M": 90, "6M": 182, "1A": 365, Max: null }[comparisonRange];
    const cutoff = rangeDays ? daysAgoIso(rangeDays) : null;

    const dateSet = new Set();
    comparableAccounts.forEach((a) =>
      sortedEntries(a).forEach((e) => {
        if (!cutoff || e.date >= cutoff) dateSet.add(e.date);
      })
    );
    if (cutoff) dateSet.add(todayISO());
    const dates = Array.from(dateSet).sort();

    const rows = dates.map((date) => {
      const row = { date };
      comparableAccounts.forEach((a) => {
        row[a.id] = balanceAsOf(a, date);
      });
      return row;
    });
    return { rows, accounts: comparableAccounts };
  }, [comparableAccounts, comparisonRange]);

  const liquidityTierGroups = useMemo(
    () => [
      { key: "immediate", label: "Disponible", color: "#15803D", accounts: buckets.immediate },
      { key: "semi", label: "Peu disponible", color: "#C99A3D", accounts: buckets.semi },
      { key: "illiquide", label: "Pas disponible", color: "#7C6F9E", accounts: buckets.illiquide },
    ],
    [buckets]
  );
  const tierComparisonData = useMemo(() => {
    const activeTiers = liquidityTierGroups.filter((t) => t.accounts.some((a) => (a.entries || []).length > 0));
    if (!activeTiers.length) return { rows: [], tiers: [] };
    const rangeDays = { "3M": 90, "6M": 182, "1A": 365, Max: null }[comparisonRange];
    const cutoff = rangeDays ? daysAgoIso(rangeDays) : null;

    const dateSet = new Set();
    activeTiers.forEach((t) =>
      t.accounts.forEach((a) =>
        sortedEntries(a).forEach((e) => {
          if (!cutoff || e.date >= cutoff) dateSet.add(e.date);
        })
      )
    );
    if (cutoff) dateSet.add(todayISO());
    const dates = Array.from(dateSet).sort();

    const rows = dates.map((date) => {
      const row = { date };
      activeTiers.forEach((t) => {
        let sum = 0;
        let any = false;
        t.accounts.forEach((a) => {
          const v = balanceAsOf(a, date);
          if (v != null) { sum += v; any = true; }
        });
        row[t.key] = any ? sum : null;
      });
      return row;
    });
    return { rows, tiers: activeTiers };
  }, [liquidityTierGroups, comparisonRange]);

  // Disponible vs provisionné, over time — reconstructed from the balance
  // history of "épargne disponible" accounts plus the dated provisions
  // active on them today (see computeProvisionsAsOf: a provision since
  // deleted leaves no trace, so this tracks how the CURRENT set of
  // provisions built up, not a true historical snapshot).
  const provisionsHistoryData = useMemo(() => {
    const semiAccounts = buckets.semi;
    if (!semiAccounts.length) return { rows: [] };
    const rangeDays = { "3M": 90, "6M": 182, "1A": 365, Max: null }[comparisonRange];
    const cutoff = rangeDays ? daysAgoIso(rangeDays) : null;

    const dateSet = new Set();
    semiAccounts.forEach((a) => {
      sortedEntries(a).forEach((e) => { if (!cutoff || e.date >= cutoff) dateSet.add(e.date); });
      (a.transactions || []).filter((t) => t.provision === true).forEach((t) => { if (!cutoff || t.date >= cutoff) dateSet.add(t.date); });
      (a.provisions || []).forEach((p) => { if (p.date && (!cutoff || p.date >= cutoff)) dateSet.add(p.date); });
    });
    if (cutoff) dateSet.add(todayISO());
    const dates = Array.from(dateSet).sort();
    if (dates.length < 2) return { rows: [] };

    const rows = dates.map((date) => {
      let rawBalance = 0;
      let hasAny = false;
      semiAccounts.forEach((a) => {
        const v = balanceAsOf(a, date);
        if (v != null) { rawBalance += v; hasAny = true; }
      });
      const provisionsAsOf = semiAccounts.reduce((s, a) => s + Math.max(0, computeProvisionsAsOf(a, date)), 0);
      return { date, disponible: hasAny ? rawBalance - provisionsAsOf : null, provisionne: hasAny ? provisionsAsOf : null };
    });
    return { rows };
  }, [buckets.semi, comparisonRange]);

  const bucketsByTier = { immediate: buckets.immediate, semi: buckets.semi, illiquide: buckets.illiquide };
  const comparisonPalette = ["#15803D", "#C99A3D", "#7C6F9E", "#2563EB", "#C2410C", "#0891B2", "#DB2777", "#65A30D"];

  useEffect(() => {
    const hasRatesData = monthlyMetrics.some((m) => m.savingsRate != null || m.rigidity != null);
    if (hasRatesData) return;
    if (comparisonData.accounts.length > 1) setChartMode("accounts");
    else if (tierComparisonData.tiers.length > 1) setChartMode("tiers");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-10">
      <div className="space-y-10">
      <div
        className="rounded-xl p-6 sm:p-7 shadow-lg relative overflow-hidden"
        style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}
      >
        <div
          className="absolute pointer-events-none"
          style={{
            top: -80, right: -80, width: 300, height: 300, borderRadius: "50%",
            background: "radial-gradient(circle, #C6F13555 0%, transparent 70%)",
          }}
        />
        <div
          className="absolute pointer-events-none"
          style={{
            bottom: -100, left: -60, width: 240, height: 240, borderRadius: "50%",
            background: "radial-gradient(circle, #4CAF6E33 0%, transparent 70%)",
          }}
        />
        <div className="text-xs uppercase tracking-[0.15em] mb-2 relative" style={{ color: "#9FCBA8" }}>🌿 Total épargne</div>
        <div className="flex items-baseline gap-3 relative">
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "3rem", fontWeight: 600, color: "#F3F8F2" }}>
            {fmtEUR(totals.epargneTotal)}
          </span>
        </div>
        <div className="h-px my-5" style={{ background: "linear-gradient(to right, #C6F135 0%, #2E5C40 40%, transparent 80%)" }} />
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "#9FCBA8" }}>
                <Wallet size={13} /> Liquidité
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.05rem", color: "#F3F8F2" }}>
                {fmtEUR(totals.immediate)}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "#9FCBA8" }}>
                <PiggyBank size={13} /> Disponible
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.05rem", color: "#F3F8F2" }}>
                {fmtEUR(totals.semiDisponible)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "#9FCBA8" }}>
                <Flag size={13} /> Provisionné
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.05rem", color: "#E3C878" }}>
                {fmtEUR(totals.provisions)}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: "#9FCBA8" }}>
                <Lock size={13} /> Épargne bloquée
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.05rem", color: "#F3F8F2" }}>
                {fmtEUR(totals.illiquide)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {knownBanks.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setBankFilter(null)}
            className="text-xs px-3 py-1.5 rounded-full shrink-0"
            style={{ background: !bankFilter ? "#C6F135" : "#FFFFFF", color: !bankFilter ? "#0F2A1C" : "#4B5D52", border: "1px solid #CFE5D2" }}
          >
            Toutes les banques
          </button>
          {knownBanks.map((bank) => {
            const meta = institutionMeta(bank);
            const active = bankFilter === bank;
            if (meta) {
              return (
                <button
                  key={bank}
                  onClick={() => setBankFilter(active ? null : bank)}
                  title={bank}
                  aria-label={bank}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0"
                  style={{
                    background: meta.color,
                    color: meta.textColor,
                    border: active ? "2px solid #0F2A1C" : "2px solid transparent",
                  }}
                >
                  {meta.initials}
                </button>
              );
            }
            return (
              <button
                key={bank}
                onClick={() => setBankFilter(active ? null : bank)}
                className="text-xs px-3 py-1.5 rounded-full shrink-0"
                style={{
                  background: active ? "#C6F135" : "#FFFFFF",
                  color: active ? "#0F2A1C" : "#4B5D52",
                  border: `1px solid ${active ? "transparent" : "#CFE5D2"}`,
                }}
              >
                {bank}
              </button>
            );
          })}
        </div>
      )}
      </div>

      <div className="flex gap-1.5">
        {MAIN_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setMainTab(tab.key)}
            className="text-sm px-4 py-2 rounded-full"
            style={{
              background: mainTab === tab.key ? "#0F2A1C" : "#FFFFFF",
              color: mainTab === tab.key ? "#F3F8F2" : "#4B5D52",
              border: `1px solid ${mainTab === tab.key ? "transparent" : "#CFE5D2"}`,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col" style={{ gap: "2.5rem" }}>
      {mainTab === "analyse" && (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("kpis") }}>
      <BlockControls id="kpis" />
      {courantAccountsList.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wide shrink-0" style={{ color: "#6B8072" }}>Compte analysé</span>
          <select
            value={kpiAccount?.id || ""}
            onChange={(e) => setKpiAccountId(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-lg outline-none min-w-0"
            style={{ border: "1px solid #CFE5D2", background: "#FFFFFF", color: "#0F2A1C", maxWidth: "60%", textOverflow: "ellipsis" }}
          >
            {courantAccountsList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}

      {(!kpis.diagnostic.hasAccount || !kpis.diagnostic.hasMonthData || (kpis.savingsRate == null && kpis.rigidity == null)) && (
        <div className="rounded-xl p-4 text-xs space-y-1" style={{ background: "#C99A3D14", color: "#8A6A20", border: "1px solid #C99A3D44" }}>
          {!kpis.diagnostic.hasAccount ? (
            <p>Aucun compte de type "Compte courant" configuré — ces indicateurs n'analysent que ce type de compte.</p>
          ) : kpis.diagnostic.totalTx === 0 ? (
            <p>Ce compte n'a aucun mouvement importé (un solde seul ne suffit pas, il faut l'historique des mouvements).</p>
          ) : !kpis.diagnostic.hasMonthData ? (
            <p>{kpis.diagnostic.totalTx} mouvement(s) au total sur ce compte, dont {kpis.diagnostic.totalCategorized} catégorisé(s), mais aucun ne tombe sur {kpis.monthLabel} — le dernier mois complet.</p>
          ) : (
            <>
              <p>{kpis.monthLabel} : {fmtEUR(kpis.income)} de revenu, {fmtEUR(kpis.fixed + kpis.flexible)} de dépenses, {fmtEUR(kpis.savings)} d'épargne.</p>
              {kpis.diagnostic.noExpensesCategorized && (
                <p>Aucune dépense catégorisée ce mois-ci sur ce compte — la rigidité a besoin d'au moins quelques mouvements catégorisés (contraint ou discrétionnaire) pour se calculer.</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl p-4 shadow-md" style={{ background: "#FFFFFF", borderTop: "3px solid #15803D", borderLeft: "1px solid #CFE5D2", borderRight: "1px solid #CFE5D2", borderBottom: "1px solid #CFE5D2" }}>
          <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Épargne</div>
          <div className="flex items-center gap-1.5" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.95rem", color: kpis.savingsRate == null ? "#0F2A1C" : kpis.savingsRate >= 0 ? "#15803D" : "#C2410C" }}>
            {kpis.savingsRate != null ? `${kpis.savingsRate >= 0 ? "+" : ""}${kpis.savingsRate.toFixed(0)} %` : "—"}
            {kpis.savingsRate != null && kpis.savingsRate >= 20 && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full"
                style={{ background: "#C6F135", color: "#0F2A1C", fontFamily: "'Inter', sans-serif", animation: "pulseBadge 1.8s ease-in-out infinite" }}
              >
                🌱 top mois
              </span>
            )}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: "#A9B5AB" }}>{kpis.monthLabel}</div>
        </div>
        <div className="rounded-xl p-4 shadow-md" style={{ background: "#FFFFFF", borderTop: "3px solid #C2410C", borderLeft: "1px solid #CFE5D2", borderRight: "1px solid #CFE5D2", borderBottom: "1px solid #CFE5D2" }}>
          <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Rigidité budgétaire</div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.95rem", color: "#0F2A1C" }}>
            {kpis.rigidity != null ? `${kpis.rigidity.toFixed(0)} %` : "—"}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: "#A9B5AB" }}>{kpis.monthLabel}</div>
        </div>
        <div className="rounded-xl p-4 shadow-md" style={{ background: "#FFFFFF", borderTop: "3px solid #C99A3D", borderLeft: "1px solid #CFE5D2", borderRight: "1px solid #CFE5D2", borderBottom: "1px solid #CFE5D2" }}>
          <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Résilience</div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.95rem", color: "#0F2A1C" }}>
            {kpis.runwayMonths != null ? `${kpis.runwayMonths.toFixed(1)} mois` : "—"}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: "#A9B5AB" }}>liquidités + épargne / 3 mois</div>
        </div>
      </div>
      </div>
      )}

      {mainTab === "analyse" && (() => {
        const perfAccounts = accounts
          .filter((a) => a.type === "epargne" || a.type === "crypto")
          .map((a) => ({ account: a, perf: computeAccountPerformance(a) }))
          .filter((row) => row.perf);
        if (!perfAccounts.length) return null;
        return (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("performance") }}>
      <BlockControls id="performance" />
          <div className="rounded-xl p-5 shadow-sm" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
            <h2 className="text-xs uppercase tracking-[0.14em] font-semibold mb-3" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Performance</h2>
            <div className="space-y-3">
              {perfAccounts.map(({ account: a, perf }) => (
                <div key={a.id} className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm truncate" style={{ color: "#0F2A1C" }}>{a.name}</div>
                    <div className="text-[11px]" style={{ color: "#6B8072" }}>{perf.label}</div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.9rem", color: perf.gain >= 0 ? "#15803D" : "#C2410C" }}>
                      {perf.gain >= 0 ? "+" : ""}{fmtEURPrecise(perf.gain)}
                    </div>
                    {perf.pct != null && (
                      <div className="text-[11px]" style={{ color: perf.gain >= 0 ? "#15803D" : "#C2410C" }}>
                        {perf.pct >= 0 ? "+" : ""}{perf.pct.toFixed(1)}%
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] mt-3 pt-3" style={{ color: "#A9B5AB", borderTop: "1px solid #CFE5D2" }}>
              Épargne classique : intérêts perçus / solde moyen. Crypto : plus/moins-value / montant investi (achats-ventes).
            </p>
          </div>
      </div>
        );
      })()}

      {mainTab === "objectifs" && (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("goals") }}>
      <BlockControls id="goals" />
        <div className="rounded-xl p-5 shadow-sm" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
          <h2 className="text-xs uppercase tracking-[0.14em] font-semibold mb-1" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Tirelires / Objectifs</h2>
          <p className="text-[11px] mb-3" style={{ color: "#6B8072" }}>
            Un objectif "important" réserve automatiquement ce qui manque pour l'atteindre, comme une provision — même si tu n'as pas encore tout mis de côté, et même s'il n'est pas rattaché à un compte précis. Un objectif non important reste juste indicatif.
          </p>
          {goals.length === 0 ? (
            <p className="text-xs mb-3" style={{ color: "#A9B5AB" }}>Aucun objectif pour l'instant.</p>
          ) : (
            <div className="space-y-2 mb-3">
              {goals.map((g) => {
                const current = computeGoalProgress(accounts, g);
                const pct = g.targetAmount > 0 ? Math.min(100, (current / g.targetAmount) * 100) : 0;
                const past = computeGoalProgressAsOf(accounts, g, daysAgoIso(30));
                const delta = Math.round((current - past) * 100) / 100;
                return (
                  <div key={g.id} className="p-2.5 rounded-lg" style={{ background: "#F3F8F2" }}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span style={{ color: "#0F2A1C" }}>
                        {g.name}
                        {g.basedOnTotal && (
                          <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: "#7C6F9E14", color: "#7C6F9E" }}>
                            épargne disponible totale
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        {!g.basedOnTotal && (
                          <button
                            onClick={() => onToggleGoalImportant(g.id)}
                            className="text-[10px] px-1.5 py-0.5 rounded-full"
                            style={{
                              background: g.important ? "#C2410C14" : "#FFFFFF",
                              color: g.important ? "#C2410C" : "#6B8072",
                            }}
                            title={g.important ? "Important — réserve automatiquement le manque (clique pour désactiver)" : "Non important — juste indicatif (clique pour activer)"}
                          >
                            {g.important ? "Important" : "Indicatif"}
                          </button>
                        )}
                        <button onClick={() => onRemoveGoal(g.id)} style={{ color: "#C2410C" }} aria-label="Retirer cet objectif">
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden mb-1" style={{ background: "#E9F3EA" }}>
                      <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: g.important ? "#C2410C" : "#C99A3D" }} />
                    </div>
                    <div className="flex items-center justify-between text-[11px]" style={{ color: "#6B8072" }}>
                      <span>{fmtEURPrecise(current)} / {fmtEURPrecise(g.targetAmount)}</span>
                      {g.targetDate && <span>Cible : {fmtDate(g.targetDate)}</span>}
                    </div>
                    {delta !== 0 && (
                      <div className="text-[10px] mt-0.5" style={{ color: delta > 0 ? "#15803D" : "#C2410C" }}>
                        {delta > 0 ? "+" : ""}{fmtEURPrecise(delta)} sur 30 jours
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {provisionBreakdown.some((r) => r.items.length > 0) && (
            <div className="pt-3 space-y-1.5" style={{ borderTop: "1px solid #CFE5D2" }}>
              <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Provisions actives</div>
              {provisionBreakdown.flatMap((row) => row.items).map((it) => (
                <div key={`${it.accountId}-${it.kind}-${it.itemKey}`} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg" style={{ background: "#F3F8F2" }}>
                  <div className="min-w-0">
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#0F2A1C" }}>{fmtEURPrecise(it.amount)}</span>
                    <span className="ml-2" style={{ color: "#6B8072" }}>{it.accountName}</span>
                  </div>
                  <button
                    onClick={() =>
                      it.kind === "manual"
                        ? onRemoveManualProvision(it.accountId, it.itemKey)
                        : onSetProvision(it.accountId, it.itemKey, false)
                    }
                    className="shrink-0 ml-2"
                    style={{ color: "#C2410C" }}
                    aria-label="Retirer cette provision"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="pt-3 space-y-2" style={{ borderTop: "1px solid #CFE5D2" }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: "#6B8072" }}>Mettre de côté une somme</div>
            <GlobalProvisionForm accounts={accounts} goals={goals} knownReasons={knownGoalReasons} onAdd={onAddManualProvision} />
          </div>
          <div className="pt-3 mt-3 space-y-2" style={{ borderTop: "1px solid #CFE5D2" }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: "#6B8072" }}>Nouvel objectif</div>
            <GoalForm knownReasons={knownGoalReasons} onAdd={onAddGoal} />
          </div>
        </div>
      </div>
      )}

      {mainTab === "overview" && totals.provisions > 0 && (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("provisionDetail") }}>
      <BlockControls id="provisionDetail" />
        <div className="rounded-xl p-5 shadow-sm" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
          <h2 className="text-xs uppercase tracking-[0.14em] font-semibold mb-1" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Détail de l'épargne disponible</h2>
          <div className="flex items-center justify-between text-sm mb-4 mt-2">
            <span style={{ color: "#4B5D52" }}>Disponible</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#15803D" }}>{fmtEUR(totals.semiDisponible)}</span>
          </div>
          <div className="flex items-center justify-between text-sm mb-3">
            <span style={{ color: "#4B5D52" }}>Provisionné</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#C99A3D" }}>{fmtEUR(totals.provisions)}</span>
          </div>
          {(() => {
            const past30 = buckets.semi.reduce((s, a) => s + Math.max(0, computeProvisionsAsOf(a, daysAgoIso(30))), 0);
            const delta = Math.round((totals.provisions - past30) * 100) / 100;
            if (delta === 0) return null;
            return (
              <div className="text-[11px] mb-3 -mt-2" style={{ color: delta > 0 ? "#C99A3D" : "#15803D" }}>
                {delta > 0 ? "+" : ""}{fmtEUR(delta)} de provisions sur 30 jours
              </div>
            );
          })()}
          <div className="space-y-2">
            {provisionBreakdown.map((row) => {
              const pct = row.target ? Math.min(100, (row.amount / row.target) * 100) : null;
              return (
                <div key={row.key} className="p-2.5 rounded-lg" style={{ background: "#F3F8F2" }}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span style={{ color: "#0F2A1C" }}>
                      {row.reason}
                      {row.important && <span style={{ color: "#C2410C" }}> ★ important</span>}
                    </span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B8072" }}>
                      {fmtEUR(row.amount)}{row.target != null ? ` / ${fmtEUR(row.target)}` : ""}
                    </span>
                  </div>
                  {pct != null && (
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "#E9F3EA" }}>
                      <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: row.important ? "#C2410C" : "#C99A3D" }} />
                    </div>
                  )}
                  {row.items.length > 1 && (
                    <div className="mt-1.5 space-y-0.5">
                      {row.items.map((it) => (
                        <div key={`${it.accountId}-${it.kind}-${it.itemKey}`} className="text-[11px]" style={{ color: "#6B8072" }}>
                          {it.accountName} — {fmtEURPrecise(it.amount)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] mt-3 pt-3" style={{ color: "#A9B5AB", borderTop: "1px solid #CFE5D2" }}>
            ★ = objectif important : le manque par rapport à la cible est réservé automatiquement, même si l'argent n'est pas encore physiquement mis de côté.
          </p>
        </div>
      </div>
      )}

      {mainTab === "analyse" && categoryData.breakdown.length > 0 && (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("categories") }}>
      <BlockControls id="categories" />
        <div className="rounded-xl p-5 shadow-sm" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Répartition des dépenses</h2>
            <span className="text-xs" style={{ color: "#6B8072" }}>{fmtEUR(categoryData.total)}</span>
          </div>
          <div className="flex gap-1 mb-3">
            {[1, 3, 6, 9, 12].map((n) => (
              <button
                key={n}
                onClick={() => setCategoryRangeMonths(n)}
                className="text-[11px] px-2 py-1 rounded-lg"
                style={{ background: categoryRangeMonths === n ? "#C6F135" : "#F3F8F2", color: categoryRangeMonths === n ? "#0F2A1C" : "#4B5D52" }}
              >
                {n}M
              </button>
            ))}
          </div>
          <p className="text-[11px] mb-3" style={{ color: "#6B8072" }}>
            Clique sur une catégorie pour basculer entre contraint et discrétionnaire.
          </p>
          <div className="space-y-2.5">
            {categoryData.breakdown.slice(0, 8).map(({ cat, amt }) => {
              const pct = categoryData.total > 0 ? (amt / categoryData.total) * 100 : 0;
              const isFixed = FIXED_CATEGORIES.has(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    const next = isFixed ? rigidCategories.filter((c) => c !== cat) : [...rigidCategories, cat];
                    onSaveRigidCategories(next);
                  }}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="flex items-center gap-1.5" style={{ color: "#0F2A1C" }}>
                      {cat}
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-md"
                        style={{ background: isFixed ? "#C2410C14" : "#15803D14", color: isFixed ? "#C2410C" : "#15803D" }}
                      >
                        {isFixed ? "Contraint" : "Discrétionnaire"}
                      </span>
                    </span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#4B5D52" }}>
                      {fmtEUR(amt)} <span style={{ color: "#A9B5AB" }}>· {pct.toFixed(0)}%</span>
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "#E9F3EA" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(pct, 3)}%`,
                        background: isFixed
                          ? "linear-gradient(90deg, #C2410C 0%, #E86A3B 100%)"
                          : "linear-gradient(90deg, #15803D 0%, #4CAF6E 100%)",
                      }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      )}

      {mainTab === "analyse" && (monthlyMetrics.some((m) => m.savingsRate != null || m.rigidity != null) || comparisonData.accounts.length > 1 || tierComparisonData.tiers.length > 1 || provisionsHistoryData.rows.length > 0) && (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("chart") }}>
      <BlockControls id="chart" />
        <div className="rounded-xl p-5 shadow-sm" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>
              {chartMode === "rates" ? "Épargne & rigidité" : chartMode === "accounts" ? "Suivi comparé des comptes" : chartMode === "tiers" ? "Paliers de liquidité" : "Épargne & provisions"}
            </h2>
            <div className="flex gap-1">
              {[
                { key: "rates", label: "Épargne & rigidité" },
                { key: "accounts", label: "Comptes" },
                { key: "tiers", label: "Paliers" },
                { key: "provisions", label: "Épargne & provisions" },
              ].map((m) => (
                <button
                  key={m.key}
                  onClick={() => setChartMode(m.key)}
                  className="text-[11px] px-2 py-1 rounded-lg"
                  style={{ background: chartMode === m.key ? "#C6F135" : "#F3F8F2", color: chartMode === m.key ? "#0F2A1C" : "#4B5D52" }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {chartMode === "rates" ? (
            <>
              <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
                <div className="flex gap-1">
                  {["taux", "montants"].map((m) => (
                    <button
                      key={m}
                      onClick={() => setTrendMode(m)}
                      className="text-[11px] px-2 py-1 rounded-lg capitalize"
                      style={{ background: trendMode === m ? "#C6F135" : "#F3F8F2", color: trendMode === m ? "#0F2A1C" : "#4B5D52" }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {[3, 6, 9, 12].map((n) => (
                    <button
                      key={n}
                      onClick={() => setTrendMonths(n)}
                      className="text-[11px] px-2 py-1 rounded-lg"
                      style={{ background: trendMonths === n ? "#C6F135" : "#F3F8F2", color: trendMonths === n ? "#0F2A1C" : "#4B5D52" }}
                    >
                      {n}M
                    </button>
                  ))}
                </div>
              </div>
              {(() => {
                const visibleMonths = monthlyMetrics.slice(-trendMonths);
                const withData = visibleMonths.filter((m) => m.savingsRate != null || m.rigidity != null).length;
                if (withData === 0) {
                  return (
                    <p className="text-[11px] mb-2" style={{ color: "#A9B5AB" }}>
                      Rien à afficher sur cette période : le taux d'épargne demande des mouvements catégorisés, la rigidité demande des dépenses catégorisées sur ce compte.
                    </p>
                  );
                }
                const v1Key = trendMode === "taux" ? "savingsRate" : "netSavings";
                const v2Key = trendMode === "taux" ? "rigidity" : "fixedAmount";
                const maxVal = trendMode === "taux"
                  ? 100
                  : Math.max(1, ...visibleMonths.flatMap((m) => [Math.abs(m[v1Key] || 0), Math.abs(m[v2Key] || 0)]));
                const fmtVal = (v) => (trendMode === "taux" ? `${v.toFixed(0)}%` : fmtEUR(v));

                return (
                  <div>
                    <div className="h-48 flex items-end gap-1.5 px-1" style={{ borderBottom: "1px solid #CFE5D2" }}>
                      {visibleMonths.map((mo, i) => {
                        const v1 = mo[v1Key];
                        const v2 = mo[v2Key];
                        const h1 = v1 != null ? Math.max(3, (Math.min(Math.abs(v1), maxVal) / maxVal) * 100) : 0;
                        const h2 = v2 != null ? Math.max(3, (Math.min(Math.abs(v2), maxVal) / maxVal) * 100) : 0;
                        const isSelected = selectedTrendMonthIdx === i;
                        return (
                          <button
                            key={mo.label}
                            onClick={() => setSelectedTrendMonthIdx(isSelected ? null : i)}
                            className="flex-1 h-full flex flex-col items-center justify-end gap-0.5 min-w-0"
                            style={{ background: isSelected ? "#F3F8F2" : "transparent", borderRadius: 6 }}
                          >
                            <div className="w-full flex items-end justify-center gap-[3px]" style={{ height: "100%" }}>
                              <div style={{ height: `${h1}%`, width: 7, background: v1 != null ? "#15803D" : "#E1EDE2", borderRadius: 2 }} />
                              <div style={{ height: `${h2}%`, width: 7, background: v2 != null ? "#C2410C" : "#E1EDE2", borderRadius: 2 }} />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex gap-1.5 px-1 mt-1">
                      {visibleMonths.map((mo, i) => (
                        <div key={mo.label} className="flex-1 text-center text-[9px] min-w-0 truncate" style={{ color: selectedTrendMonthIdx === i ? "#0F2A1C" : "#A9B5AB" }}>
                          {mo.label}
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 text-xs px-1" style={{ color: "#4B5D52" }}>
                      {selectedTrendMonthIdx != null && visibleMonths[selectedTrendMonthIdx] ? (
                        <>
                          <strong style={{ color: "#0F2A1C" }}>{visibleMonths[selectedTrendMonthIdx].label}</strong> —{" "}
                          {trendMode === "taux" ? "Épargne" : "Épargne nette"}: {visibleMonths[selectedTrendMonthIdx][v1Key] != null ? fmtVal(visibleMonths[selectedTrendMonthIdx][v1Key]) : "—"}
                          {" · "}
                          {trendMode === "taux" ? "Rigidité" : "Contraint"}: {visibleMonths[selectedTrendMonthIdx][v2Key] != null ? fmtVal(visibleMonths[selectedTrendMonthIdx][v2Key]) : "—"}
                        </>
                      ) : (
                        "Touche une colonne pour voir le détail du mois."
                      )}
                    </div>
                  </div>
                );
              })()}
              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4B5D52" }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: "#15803D" }} />
                  {trendMode === "taux" ? "Épargne" : "Épargne nette (€)"}
                </div>
                <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4B5D52" }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: "#C2410C" }} />
                  {trendMode === "taux" ? "Rigidité budgétaire" : "Dépenses contraintes (€)"}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-1 mb-3">
                {["3M", "6M", "1A", "Max"].map((r) => (
                  <button
                    key={r}
                    onClick={() => setComparisonRange(r)}
                    className="text-[11px] px-2 py-1 rounded-lg"
                    style={{ background: comparisonRange === r ? "#C6F135" : "#F3F8F2", color: comparisonRange === r ? "#0F2A1C" : "#4B5D52" }}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {chartMode === "accounts" ? (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={comparisonData.rows}>
                      <CartesianGrid stroke="#CFE5D2" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#A9B5AB" }} axisLine={{ stroke: "#CFE5D2" }} tickLine={false} tickFormatter={(d) => fmtDate(d)} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10, fill: "#A9B5AB" }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => fmtEUR(v)} />
                      <Tooltip
                        formatter={(v, name) => [fmtEURPrecise(v), comparisonData.accounts.find((a) => a.id === name)?.name || name]}
                        labelFormatter={(d) => fmtDate(d)}
                        contentStyle={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)", border: "none", borderRadius: 6, fontSize: 12 }}
                        labelStyle={{ color: "#EFEEE6" }}
                      />
                      {comparisonData.accounts.map((a, i) => (
                        <Line key={a.id} dataKey={a.id} name={a.id} stroke={comparisonPalette[i % comparisonPalette.length]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : chartMode === "tiers" ? (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={tierComparisonData.rows}>
                      <CartesianGrid stroke="#CFE5D2" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#A9B5AB" }} axisLine={{ stroke: "#CFE5D2" }} tickLine={false} tickFormatter={(d) => fmtDate(d)} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10, fill: "#A9B5AB" }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => fmtEUR(v)} />
                      <Tooltip
                        formatter={(v, name) => [fmtEURPrecise(v), tierComparisonData.tiers.find((t) => t.key === name)?.label || name]}
                        labelFormatter={(d) => fmtDate(d)}
                        contentStyle={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)", border: "none", borderRadius: 6, fontSize: 12 }}
                        labelStyle={{ color: "#EFEEE6" }}
                      />
                      {tierComparisonData.tiers.map((t) => (
                        <Line key={t.key} dataKey={t.key} name={t.key} stroke={t.color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : provisionsHistoryData.rows.length > 0 ? (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={provisionsHistoryData.rows}>
                      <CartesianGrid stroke="#CFE5D2" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#A9B5AB" }} axisLine={{ stroke: "#CFE5D2" }} tickLine={false} tickFormatter={(d) => fmtDate(d)} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10, fill: "#A9B5AB" }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => fmtEUR(v)} />
                      <Tooltip
                        formatter={(v, name) => [fmtEURPrecise(v), name === "disponible" ? "Disponible" : "Provisionné"]}
                        labelFormatter={(d) => fmtDate(d)}
                        contentStyle={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)", border: "none", borderRadius: 6, fontSize: 12 }}
                        labelStyle={{ color: "#EFEEE6" }}
                      />
                      <Line dataKey="disponible" name="disponible" stroke="#15803D" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                      <Line dataKey="provisionne" name="provisionne" stroke="#C99A3D" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-[11px] py-8 text-center" style={{ color: "#A9B5AB" }}>
                  Pas assez de données pour tracer l'évolution disponible/provisionné.
                </p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {chartMode === "provisions"
                  ? [
                      { key: "disponible", label: "Disponible", color: "#15803D" },
                      { key: "provisionne", label: "Provisionné", color: "#C99A3D" },
                    ].map((item) => (
                      <div key={item.key} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4B5D52" }}>
                        <span className="w-2 h-2 rounded-full" style={{ background: item.color }} />
                        {item.label}
                      </div>
                    ))
                  : (chartMode === "accounts" ? comparisonData.accounts : tierComparisonData.tiers).map((item, i) => (
                      <div key={item.id || item.key} className="flex items-center gap-1.5 text-[11px]" style={{ color: "#4B5D52" }}>
                        <span className="w-2 h-2 rounded-full" style={{ background: item.color || comparisonPalette[i % comparisonPalette.length] }} />
                        {item.name || item.label}
                      </div>
                    ))}
              </div>
            </>
          )}
        </div>
      </div>
      )}

      {mainTab === "overview" && buckets.dettes.length > 0 && (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("dettes") }}>
      <BlockControls id="dettes" />
        <div className="rounded-xl p-5 shadow-sm" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
          <div className="flex items-center gap-2 mb-3">
            <Landmark size={15} color="#C2410C" />
            <h2 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Dettes</h2>
          </div>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="text-xs mb-1" style={{ color: "#4B5D52" }}>Échéances du mois</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.05rem", color: "#C2410C" }}>{fmtEUR(totals.detteMois)}</div>
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: "#4B5D52" }}>Restant dû (à vie)</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.05rem", color: "#C2410C" }}>{fmtEUR(totals.detteVie)}</div>
            </div>
          </div>

          {payoffTimeline.length > 1 && (
            <>
              <div className="h-px my-4" style={{ background: "#CFE5D2" }} />
              <div className="text-xs uppercase tracking-wide mb-3" style={{ color: "#4B5D52" }}>Fins de crédit à venir</div>
              <div className="space-y-3">
                {payoffTimeline.map((step, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: i === 0 ? "#C2410C" : step.monthly > 0 ? "#C99A3D" : "#15803D" }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs" style={{ color: "#0F2A1C" }}>
                        {step.date ? `${fmtDate(step.date)} — ${step.label}` : step.label}
                      </div>
                    </div>
                    <div className="text-xs shrink-0" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#4B5D52" }}>
                      {fmtEUR(step.monthly)}/mois
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      )}

      {mainTab === "overview" && (
      <div className="space-y-10" style={{ order: blockOrder.indexOf("accounts") }}>
      <BlockControls id="accounts" />
      {LIQUIDITY_TIERS.map((tier) => (
        <div key={tier.key}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <tier.icon size={15} color={tier.color} />
              <div>
                <h2 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>
                  {tier.label}
                </h2>
              </div>
            </div>
          </div>
          {bucketsByTier[tier.key].length === 0 ? (
            <p className="text-sm py-3" style={{ color: "#6B8072" }}>Aucun compte dans cette catégorie pour l'instant.</p>
          ) : (
            <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
              {bucketsByTier[tier.key].map((a) => {
                const bal = currentBalance(a);
                const tr = trend(a);
                const spark = sortedEntries(a).slice(-12);
                return (
                  <button
                    key={a.id}
                    onClick={() => onOpenAccount(a.id)}
                    className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:brightness-[0.98] transition"
                    style={{ background: "#FFFFFF" }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
                        style={{ background: institutionMeta(a.institution)?.color || TYPE_META[a.type].color }}
                      >
                        {institutionMeta(a.institution) ? (
                          <span className="text-xs font-semibold" style={{ color: institutionMeta(a.institution).textColor, fontFamily: "'Space Grotesk', sans-serif" }}>
                            {institutionMeta(a.institution).initials}
                          </span>
                        ) : (
                          React.createElement(TYPE_META[a.type].icon, { size: 16, color: "#FFFFFF" })
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm" style={{ color: "#0F2A1C", fontFamily: "'Inter', sans-serif" }}>{a.name}</div>
                        {a.institution && <div className="text-xs mt-0.5" style={{ color: "#6B8072" }}>{a.institution}</div>}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <Sparkline data={spark} color={tier.color} />
                      <div className="text-right">
                        <div style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#0F2A1C" }}>{fmtEURPrecise(bal)}</div>
                        {tr !== 0 && (
                          <div className="flex items-center justify-end gap-0.5 text-xs" style={{ color: tr > 0 ? "#15803D" : "#C2410C" }}>
                            {tr > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                            {fmtEURPrecise(Math.abs(tr))}
                          </div>
                        )}
                      </div>
                      <ChevronRight size={16} color="#6B8072" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}

      <div>
        <div className="flex items-center gap-2 mb-3">
          <Landmark size={15} color="#C2410C" />
          <h2 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Dettes</h2>
        </div>
        {buckets.dettes.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "#6B8072" }}>Aucune dette enregistrée.</p>
        ) : (
          <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
            {buckets.dettes.map((a) => {
              const bal = currentBalance(a);
              const spark = sortedEntries(a).slice(-12);
              return (
                <button
                  key={a.id}
                  onClick={() => onOpenAccount(a.id)}
                  className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:brightness-[0.98] transition"
                  style={{ background: "#FFFFFF" }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: institutionMeta(a.institution)?.color || "#C2410C" }}>
                      {institutionMeta(a.institution) ? (
                        <span className="text-xs font-semibold" style={{ color: institutionMeta(a.institution).textColor, fontFamily: "'Space Grotesk', sans-serif" }}>
                          {institutionMeta(a.institution).initials}
                        </span>
                      ) : (
                        <Landmark size={16} color="#FFFFFF" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm" style={{ color: "#0F2A1C", fontFamily: "'Inter', sans-serif" }}>{a.name}</div>
                      {a.institution && <div className="text-xs mt-0.5" style={{ color: "#6B8072" }}>{a.institution}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <Sparkline data={spark} color="#C2410C" />
                    <div className="text-right">
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#0F2A1C" }}>{fmtEURPrecise(bal)}</div>
                      {a.credit?.monthlyPayment ? (
                        <div className="text-xs" style={{ color: "#6B8072" }}>{fmtEUR(a.credit.monthlyPayment)}/mois</div>
                      ) : null}
                    </div>
                    <ChevronRight size={16} color="#6B8072" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      </div>
      )}
      </div>

      <button
        onClick={onOpenReport}
        className="w-full flex items-center justify-between px-4 py-3.5 rounded-xl shadow-sm"
        style={{ background: "linear-gradient(135deg, #0F2A1C 0%, #2E5C40 100%)" }}
      >
        <span className="flex items-center gap-2 text-sm" style={{ color: "#F3F8F2" }}>
          <Sparkles size={15} color="#C6F135" /> Générer le rapport PDF
        </span>
        <ChevronRight size={16} color="#C6F135" />
      </button>

      {uncategorizedCount > 0 && (
        <button
          onClick={onOpenUncategorized}
          className="w-full flex items-center justify-between px-4 py-3 rounded-xl shadow-sm"
          style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}
        >
          <span className="text-sm" style={{ color: "#0F2A1C" }}>Mouvements non catégorisés</span>
          <span
            className="text-xs px-2 py-1 rounded-xl"
            style={{ background: "#C6F13540", color: "#0F2A1C", fontFamily: "'IBM Plex Mono', monospace" }}
          >
            {uncategorizedCount}
          </span>
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={onAddAccount}
          className="flex items-center gap-2 text-sm px-4 py-3 rounded-xl justify-center"
          style={{ border: "1.5px dashed #CFE0D3", color: "#0F2A1C" }}
        >
          <Plus size={16} /> Ajouter un compte
        </button>
        <button
          onClick={onSmartImport}
          className="flex items-center gap-2 text-sm px-4 py-3 rounded-xl justify-center"
          style={{ border: "1.5px dashed #CFE0D3", color: "#0F2A1C" }}
        >
          <FileSpreadsheet size={16} /> Importer un fichier
        </button>
      </div>
    </div>
  );
}

// ---------- Uncategorized Transactions ----------
function UncategorizedView({ accounts, onBack, onCategorize }) {
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const all = [];
    accounts.forEach((a) => {
      (a.transactions || []).forEach((t) => {
        if (!t.category) all.push({ ...t, accountId: a.id, accountName: a.name, accountColor: TYPE_META[a.type]?.color });
      });
    });
    return all
      .filter((t) => !query.trim() || t.label.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [accounts, query]);

  const knownCategories = useMemo(() => {
    const set = new Set();
    accounts.forEach((a) => (a.transactions || []).forEach((t) => t.category && set.add(t.category)));
    return Array.from(set).sort();
  }, [accounts]);

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs mb-6" style={{ color: "#4B5D52" }}>
        <ArrowLeft size={14} /> Retour à la vue d'ensemble
      </button>

      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "1.4rem", color: "#0F2A1C" }} className="mb-1">
        Mouvements non catégorisés
      </h2>
      <p className="text-sm mb-4" style={{ color: "#4B5D52" }}>{items.length} mouvement(s) sur l'ensemble des comptes</p>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Rechercher un libellé…"
        className="w-full px-3 py-2 rounded-xl outline-none mb-4"
        style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
      />

      {items.length === 0 ? (
        <p className="text-sm py-10 text-center" style={{ color: "#6B8072" }}>Tout est catégorisé.</p>
      ) : (
        <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
          {items.map((t) => (
            <div key={`${t.accountId}-${txKey(t)}`} className="flex items-center justify-between gap-3 px-4 py-3" style={{ background: "#FFFFFF" }}>
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate" style={{ color: "#0F2A1C" }}>{t.label || "(sans libellé)"}</div>
                <div className="flex items-center gap-2 text-xs mt-0.5" style={{ color: "#6B8072" }}>
                  <span style={{ color: t.accountColor }}>{t.accountName}</span>
                  <span>·</span>
                  <span>{fmtDate(t.date)}</span>
                </div>
              </div>
              <div
                className="shrink-0 text-sm"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: t.amount >= 0 ? "#15803D" : "#C2410C" }}
              >
                {t.amount >= 0 ? "+" : ""}{fmtEURPrecise(t.amount)}
              </div>
              <CategorySelect
                value={t.category}
                knownCategories={knownCategories}
                onChange={(cat) => onCategorize(t.accountId, txKey(t), cat)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CATEGORIES = [
  "Alimentation", "Restaurants", "Transport", "Logement", "Santé",
  "Loisirs & Culture", "Shopping", "Abonnements", "Voyages",
  "Épargne", "Salaire", "Virement interne", "Intérêts",
  "Frais bancaires", "Impôts & Taxes", "Assurance", "Enfants", "Cadeaux & Dons", "Autre",
];

// Dropdown categorizer: the curated list above, plus whatever custom
// categories already exist elsewhere in the data (e.g. from an imported
// file) so nothing already in use ever disappears from the picker.
// Choosing "Autre" reveals a free-text field for anything not listed.
function CategorySelect({ value, knownCategories, onChange }) {
  const [customMode, setCustomMode] = useState(false);
  const options = Array.from(new Set([...CATEGORIES.slice(0, -1), ...(knownCategories || [])])).sort();

  if (customMode) {
    return (
      <input
        autoFocus
        placeholder="Catégorie…"
        defaultValue={value && !options.includes(value) ? value : ""}
        className="shrink-0 w-28 text-xs px-2 py-1.5 rounded-xl outline-none"
        style={{ border: "1px solid #CFE0D3", background: "#F3F8F2" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.currentTarget.value.trim()) onChange(e.currentTarget.value.trim());
        }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim()) onChange(e.currentTarget.value.trim());
          else setCustomMode(false);
        }}
      />
    );
  }

  return (
    <select
      value={options.includes(value) ? value : ""}
      onChange={(e) => {
        if (e.target.value === "__autre__") setCustomMode(true);
        else onChange(e.target.value);
      }}
      className="shrink-0 w-28 text-xs px-2 py-1.5 rounded-xl outline-none"
      style={{ border: "1px solid #CFE0D3", background: "#F3F8F2", color: value ? "#0F2A1C" : "#6B8072" }}
    >
      <option value="" disabled>Catégoriser…</option>
      {options.map((c) => <option key={c} value={c}>{c}</option>)}
      <option value="__autre__">Autre…</option>
    </select>
  );
}

// Same dropdown-with-"Autre..."-fallback pattern as CategorySelect, for
// the provision's "raison" — each new reason typed in gets remembered
// (via knownReasons, collected from every account's transactions) so it
// shows up as a pickable option the next time, rather than retyping it.
function ProvisionReasonSelect({ value, knownReasons, onChange }) {
  const options = Array.from(new Set(knownReasons || [])).sort();
  const [userForcedCustom, setUserForcedCustom] = useState(false);
  const customMode = userForcedCustom || !options.length;

  if (customMode) {
    return (
      <input
        autoFocus={!!value}
        placeholder="Raison de la provision…"
        defaultValue={value || ""}
        className="w-full text-xs px-2 py-1.5 rounded-lg outline-none"
        style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.currentTarget.value.trim()) onChange(e.currentTarget.value.trim());
        }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim()) onChange(e.currentTarget.value.trim());
        }}
      />
    );
  }

  return (
    <select
      value={options.includes(value) ? value : ""}
      onChange={(e) => {
        if (e.target.value === "__autre__") setUserForcedCustom(true);
        else onChange(e.target.value);
      }}
      className="w-full text-xs px-2 py-1.5 rounded-lg outline-none"
      style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", color: value ? "#0F2A1C" : "#6B8072" }}
    >
      <option value="" disabled>Raison…</option>
      {options.map((r) => <option key={r} value={r}>{r}</option>)}
      <option value="__autre__">Autre…</option>
    </select>
  );
}

const MONTH_LABELS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

function CoverageGrid({ coverage, color, filter, onSelectYear, onSelectMonth }) {
  const years = useMemo(() => {
    const set = new Set();
    (coverage || []).forEach((r) => {
      const startYear = Number(r.start.slice(0, 4));
      const endYear = Number(r.end.slice(0, 4));
      for (let y = startYear; y <= endYear; y++) set.add(y);
    });
    set.add(new Date().getFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [coverage]);
  const year = years.includes(filter.year) ? filter.year : years[0];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Couverture des relevés</h3>
        <select
          value={year}
          onChange={(e) => onSelectYear(Number(e.target.value))}
          className="text-xs px-2 py-1 rounded-xl outline-none"
          style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", color: "#4B5D52" }}
        >
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
        {MONTH_LABELS.map((label, i) => {
          const ym = `${year}-${String(i + 1).padStart(2, "0")}`;
          const status = monthCoverageStatus(ym, coverage);
          const bg = status === "full" ? color : status === "partial" ? `${color}55` : "#EFF3EE";
          const textColor = status === "full" ? "#FFFFFF" : status === "partial" ? "#0F2A1C" : "#A9B5AB";
          const isActive = filter.mode === "month" && filter.year === year && filter.month === i + 1;
          return (
            <button
              key={label}
              type="button"
              onClick={() => onSelectMonth(year, i + 1)}
              title={(status === "full" ? "Couvert" : status === "partial" ? "Partiellement couvert" : "Non couvert") + " — clique pour filtrer le graphique sur ce mois"}
              className="rounded-lg py-2 text-center text-[10px] font-medium"
              style={{ background: bg, color: textColor, outline: isActive ? "2px solid #0F2A1C" : "none", outlineOffset: 1 }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Account Detail ----------
function TransactionDetailModal({ transaction, index, total, hasPrev, hasNext, onPrev, onNext, account, meta, knownCategories, onCategorize, onSetRigid, onSetProvision, knownProvisionReasons, isRecurringNow, recurringOverride, onSetRecurring, onClose }) {
  const t = transaction;
  const key = txKey(t);
  const originImport = (account.imports || []).find((imp) => (imp.transactionIds || []).includes(key)) || null;

  useEffect(() => {
    function onKey(e) {
      if (e.key === "ArrowUp" && hasPrev) onPrev();
      if (e.key === "ArrowDown" && hasNext) onNext();
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(33,38,31,0.45)" }}>
      <div className="w-full max-w-sm rounded-xl shadow-xl" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #CFE5D2" }}>
          <h3 className="text-base" style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#0F2A1C" }}>Détail du mouvement</h3>
          <div className="flex items-center gap-1">
            {total > 1 && (
              <span className="text-xs mr-1" style={{ color: "#A9B5AB" }}>{index + 1}/{total}</span>
            )}
            <button
              onClick={onPrev}
              disabled={!hasPrev}
              aria-label="Mouvement précédent (plus récent)"
              className="p-1.5 rounded-lg disabled:opacity-30"
              style={{ border: "1px solid #CFE5D2" }}
            >
              <ChevronRight size={14} color="#0F2A1C" style={{ transform: "rotate(-90deg)" }} />
            </button>
            <button
              onClick={onNext}
              disabled={!hasNext}
              aria-label="Mouvement suivant (plus ancien)"
              className="p-1.5 rounded-lg disabled:opacity-30"
              style={{ border: "1px solid #CFE5D2" }}
            >
              <ChevronRight size={14} color="#0F2A1C" style={{ transform: "rotate(90deg)" }} />
            </button>
            <button onClick={onClose} aria-label="Fermer" className="p-1 ml-1 hover:opacity-60">
              <X size={18} color="#0F2A1C" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <div className="text-2xl" style={{ fontFamily: "'IBM Plex Mono', monospace", color: t.amount >= 0 ? "#15803D" : "#C2410C" }}>
              {t.amount >= 0 ? "+" : ""}{fmtEURPrecise(t.amount)}
            </div>
            <p className="text-sm mt-1" style={{ color: "#0F2A1C" }}>{t.label || "(sans libellé)"}</p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Date</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#0F2A1C" }}>{fmtDate(t.date)}</div>
            </div>
            <div>
              <div className="uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Compte</div>
              <div style={{ color: "#0F2A1C" }}>{account.name}</div>
            </div>
          </div>

          {account.type === "courant" && (
          <div>
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Catégorie</div>
            {t.category ? (
              <button
                onClick={() => onCategorize(account.id, key, "")}
                className="text-xs px-2 py-1 rounded-xl"
                style={{ background: `${meta.color}14`, color: meta.color }}
                title="Retirer la catégorie"
              >
                {t.category} ✕
              </button>
            ) : (
              <CategorySelect value={t.category} knownCategories={knownCategories} onChange={(cat) => onCategorize(account.id, key, cat)} />
            )}
          </div>
          )}

          {account.type === "courant" && (
          <div>
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Contraint / discrétionnaire</div>
            <div className="flex gap-2">
              {[
                { v: true, label: "Contraint", color: "#C2410C" },
                { v: false, label: "Discrétionnaire", color: "#15803D" },
                { v: null, label: "Suit la catégorie", color: "#6B8072" },
              ].map((opt) => (
                <button
                  key={String(opt.v)}
                  onClick={() => onSetRigid(account.id, key, opt.v)}
                  className="text-xs px-2 py-1.5 rounded-xl"
                  style={{
                    border: `1px solid ${(t.rigid ?? null) === opt.v ? opt.color : "#CFE5D2"}`,
                    background: (t.rigid ?? null) === opt.v ? `${opt.color}14` : "transparent",
                    color: (t.rigid ?? null) === opt.v ? opt.color : "#4B5D52",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Provision</div>
            <label className="flex items-center gap-2 text-xs mb-2" style={{ color: "#0F2A1C" }}>
              <input
                type="checkbox"
                checked={!!t.provision}
                onChange={(e) => onSetProvision(account.id, key, e.target.checked, e.target.checked ? t.provisionReason : undefined)}
              />
              Ce mouvement est provisionné
            </label>
            {t.provision && (
              <ProvisionReasonSelect
                value={t.provisionReason}
                knownReasons={knownProvisionReasons}
                onChange={(reason) => onSetProvision(account.id, key, true, reason)}
              />
            )}
            <p className="text-[11px] mt-1" style={{ color: "#6B8072" }}>
              Reste disponible et compte dans le solde, mais signalé comme "à ne pas dépenser" — utile pour un trop-perçu ou une somme réservée.
            </p>
          </div>

          {account.type === "courant" && (
          <div>
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Récurrence</div>
            {labelGroupingKey(t.label) ? (
              <>
                <div className="flex gap-2">
                  {[
                    { v: true, label: "Récurrent", color: "#15803D" },
                    { v: false, label: "Non récurrent", color: "#C2410C" },
                    { v: null, label: "Auto (détection)", color: "#6B8072" },
                  ].map((opt) => (
                    <button
                      key={String(opt.v)}
                      onClick={() => onSetRecurring(opt.v)}
                      className="text-xs px-2 py-1.5 rounded-xl"
                      style={{
                        border: `1px solid ${(recurringOverride ?? null) === opt.v ? opt.color : "#CFE5D2"}`,
                        background: (recurringOverride ?? null) === opt.v ? `${opt.color}14` : "transparent",
                        color: (recurringOverride ?? null) === opt.v ? opt.color : "#4B5D52",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] mt-1" style={{ color: "#6B8072" }}>
                  Actuellement : {isRecurringNow ? "récurrent" : "non récurrent"}. S'applique à ce libellé partout (mois passés et imports à venir).
                </p>
              </>
            ) : (
              <p className="text-xs" style={{ color: "#A9B5AB" }}>
                Libellé trop générique pour être suivi comme récurrent.
              </p>
            )}
          </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "#6B8072" }}>Origine</div>
            <p className="text-xs" style={{ color: "#4B5D52" }}>
              {originImport
                ? `Importé le ${new Date(originImport.timestamp).toLocaleDateString("fr-FR")} depuis ${originImport.filename || "un fichier"}`
                : "Saisi manuellement ou import non tracé"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ManualProvisionForm({ accountId, knownReasons, onAdd }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  function submit(e) {
    e.preventDefault();
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Indique un montant valide.");
      return;
    }
    setError("");
    onAdd(accountId, { amount: Math.round(value * 100) / 100, reason: reason || null, date: todayISO() });
    setAmount("");
    setReason("");
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <input
          type="number" step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Montant €"
          className="w-24 px-2 py-1.5 rounded-lg text-xs outline-none"
          style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
        />
        <div className="flex-1">
          <ProvisionReasonSelect value={reason} knownReasons={knownReasons} onChange={setReason} />
        </div>
      </div>
      {error && <p className="text-xs" style={{ color: "#C2410C" }}>{error}</p>}
      <button
        type="button"
        onClick={submit}
        className="text-xs px-3 py-1.5 rounded-lg text-white"
        style={{ background: "#C99A3D" }}
      >
        Ajouter la provision
      </button>
    </form>
  );
}

// Same as ManualProvisionForm, but usable from anywhere (e.g. the
// Overview) since it lets you pick which account the money is actually
// sitting in as part of the same form — no need to navigate into a
// specific account first.
function GlobalProvisionForm({ accounts, goals, knownReasons, onAdd }) {
  const eligible = accounts.filter((a) => a.type === "epargne" || a.type === "courant");
  const [accountId, setAccountId] = useState(eligible[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const selectedAccount = eligible.find((a) => a.id === accountId);
  // What's free to provision on this account: its own balance minus what's
  // already provisioned there, further capped by how much of the overall
  // pool (across every account) important goals have already claimed —
  // an important objectif reserves its shortfall even before any money is
  // literally set aside, so that reserve has to come out of "disponible"
  // too, not just real provisions.
  const accountAvailable = selectedAccount ? currentBalance(selectedAccount) - computeProvisions(selectedAccount) : null;
  const goalReserve = computeGoalReserve(accounts, goals || []);
  const totalRealProvisions = eligible.reduce((s, a) => s + Math.max(0, computeProvisions(a)), 0);
  const totalBalance = eligible.reduce((s, a) => s + currentBalance(a), 0);
  const globalAvailable = totalBalance - totalRealProvisions - goalReserve;
  const available = accountAvailable == null ? null : Math.min(accountAvailable, globalAvailable);

  function submit(e) {
    e.preventDefault();
    if (!accountId) {
      setError("Choisis un compte.");
      return;
    }
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("Indique un montant valide.");
      return;
    }
    if (available != null && value > available + 0.001) {
      if (accountAvailable <= globalAvailable + 0.001) {
        setError(`Seulement ${fmtEURPrecise(Math.max(accountAvailable, 0))} disponible sur ce compte (le reste est déjà provisionné ou bloqué).`);
      } else {
        setError(`Seulement ${fmtEURPrecise(Math.max(globalAvailable, 0))} réellement disponible au total — le reste est déjà réservé par un objectif important.`);
      }
      return;
    }
    setError("");
    onAdd(accountId, { amount: Math.round(value * 100) / 100, reason: reason || null, date: todayISO() });
    setAmount("");
    setReason("");
  }

  if (!eligible.length) return null;

  return (
    <form onSubmit={submit} className="space-y-2">
      <select
        value={accountId}
        onChange={(e) => { setAccountId(e.target.value); setError(""); }}
        className="w-full px-2 py-1.5 rounded-lg text-xs outline-none"
        style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", color: "#0F2A1C" }}
      >
        {eligible.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {available != null && (
        <p className="text-[11px]" style={{ color: "#6B8072" }}>
          Disponible sur ce compte : {fmtEURPrecise(Math.max(available, 0))}
        </p>
      )}
      <div className="flex gap-2">
        <input
          type="number" step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Montant €"
          className="w-24 px-2 py-1.5 rounded-lg text-xs outline-none"
          style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
        />
        <div className="flex-1">
          <ProvisionReasonSelect value={reason} knownReasons={knownReasons} onChange={setReason} />
        </div>
      </div>
      {error && <p className="text-xs" style={{ color: "#C2410C" }}>{error}</p>}
      <button
        type="button"
        onClick={submit}
        className="text-xs px-3 py-1.5 rounded-lg text-white"
        style={{ background: "#C99A3D" }}
      >
        Ajouter la provision
      </button>
    </form>
  );
}

function GoalForm({ knownReasons, onAdd }) {
  const [basedOnTotal, setBasedOnTotal] = useState(false);
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState("");

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError(basedOnTotal ? "Donne un nom à cet objectif (ex. Coussin de sécurité)." : "Donne un nom à cet objectif (ex. Impôts, Vacances...).");
      return;
    }
    const value = Number(targetAmount);
    if (!value || value <= 0) {
      setError("Indique un montant cible valide.");
      return;
    }
    setError("");
    onAdd({ name: name.trim(), targetAmount: Math.round(value * 100) / 100, targetDate: targetDate || null, basedOnTotal });
    setName("");
    setTargetAmount("");
    setTargetDate("");
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        {[
          { v: false, label: "Provisions nommées" },
          { v: true, label: "Épargne disponible totale" },
        ].map((opt) => (
          <button
            key={String(opt.v)}
            type="button"
            onClick={() => { setBasedOnTotal(opt.v); setName(""); }}
            className="flex-1 py-1.5 rounded-lg text-[11px]"
            style={{
              border: basedOnTotal === opt.v ? "1.5px solid #C2410C" : "1px solid #CFE0D3",
              background: basedOnTotal === opt.v ? "#C2410C14" : "#FFFFFF",
              color: basedOnTotal === opt.v ? "#C2410C" : "#4B5D52",
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-[11px]" style={{ color: "#6B8072" }}>
        {basedOnTotal
          ? "Progression suivie sur le total actuel de l'épargne disponible (tous comptes), pas sur une provision précise."
          : "Progression suivie via les provisions portant ce nom (voir \"Mettre de côté une somme\")."}
      </p>
      {basedOnTotal ? (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom de l'objectif (ex. Coussin de sécurité)"
          className="w-full text-xs px-2 py-1.5 rounded-lg outline-none"
          style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
        />
      ) : (
        <ProvisionReasonSelect value={name} knownReasons={knownReasons} onChange={setName} />
      )}
      <div className="flex gap-2">
        <input
          type="number" step="0.01"
          value={targetAmount}
          onChange={(e) => setTargetAmount(e.target.value)}
          placeholder="Montant cible €"
          className="flex-1 px-2 py-1.5 rounded-lg text-xs outline-none"
          style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
        />
        <input
          type="date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          className="px-2 py-1.5 rounded-lg text-xs outline-none"
          style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
        />
      </div>
      {error && <p className="text-xs" style={{ color: "#C2410C" }}>{error}</p>}
      <button
        type="button"
        onClick={submit}
        className="text-xs px-3 py-1.5 rounded-lg text-white"
        style={{ background: "#C2410C" }}
      >
        Ajouter l'objectif
      </button>
    </form>
  );
}

function AccountDetail({ account, onBack, onEdit, onAddEntry, onLogBalance, onCategorize, onSetRigid, onSetProvision, onDeleteImport, recurringOverrides, onSetRecurringOverride, onRecordTrade, onLogCryptoValuation }) {
  const meta = TYPE_META[account.type];
  const entries = sortedEntries(account);
  const bal = currentBalance(account);
  const provisions = computeProvisions(account);
  // Defaults to showing just the latest year with data — a multi-year
  // account history is unreadable as one giant chart. "Couverture des
  // relevés" (below) drives this same filter: pick a year, or a specific
  // month for an even tighter view, or switch to "Toutes les années".
  // Credit accounts are the exception: the whole point of their chart is
  // the declining balance over the full loan term, so they default to
  // "all" rather than a single zoomed-in year.
  const latestYear = entries.length ? Number(entries[entries.length - 1].date.slice(0, 4)) : new Date().getFullYear();
  const [chartFilter, setChartFilter] = useState(
    account.type === "credit" ? { mode: "all", year: null, month: null } : { mode: "year", year: latestYear, month: null }
  );
  const chartEntries = entries.filter((e) => {
    if (chartFilter.mode === "all") return true;
    if (chartFilter.mode === "year") return e.date.slice(0, 4) === String(chartFilter.year);
    if (chartFilter.mode === "month") return e.date.slice(0, 7) === `${chartFilter.year}-${String(chartFilter.month).padStart(2, "0")}`;
    return true;
  });
  const chartData = chartEntries.map((e) => ({ date: fmtDate(e.date), balance: e.balance, raw: e.date }));
  const [confirmDeleteImport, setConfirmDeleteImport] = useState(null);
  const [previewLoadingId, setPreviewLoadingId] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [cryptoPriceInputs, setCryptoPriceInputs] = useState({});
  const [cryptoValuationDate, setCryptoValuationDate] = useState(todayISO());
  const [tradeType, setTradeType] = useState("achat");
  const [tradeSymbol, setTradeSymbol] = useState("");
  const [tradeQuantity, setTradeQuantity] = useState("");
  const [tradePrice, setTradePrice] = useState("");
  const [tradeDate, setTradeDate] = useState(todayISO());
  const [selectedIndex, setSelectedIndex] = useState(null);
  const accountKnownCategories = useMemo(
    () => Array.from(new Set((account.transactions || []).map((t) => t.category).filter(Boolean))),
    [account.transactions]
  );
  const knownProvisionReasons = useMemo(
    () =>
      Array.from(
        new Set([
          ...(account.transactions || []).map((t) => t.provisionReason).filter(Boolean),
          ...(account.provisions || []).map((p) => p.reason).filter(Boolean),
        ])
      ),
    [account.transactions, account.provisions]
  );

  // Months that actually have movements, oldest first — navigation moves
  // between these rather than through every calendar month, so "next" /
  // "previous" never lands on a blank page.
  const availableMonths = useMemo(
    () => Array.from(new Set((account.transactions || []).map((t) => t.date.slice(0, 7)))).sort(),
    [account.transactions]
  );
  const [selectedMonth, setSelectedMonth] = useState(null);
  const effectiveMonth = selectedMonth && availableMonths.includes(selectedMonth)
    ? selectedMonth
    : availableMonths[availableMonths.length - 1] || todayISO().slice(0, 7);
  const monthIdx = availableMonths.indexOf(effectiveMonth);

  // A label counts as "récurrent" if it shows up in most months of its
  // own active window (from its first to its last occurrence) — not
  // based on amount consistency, since bills like energy or telecom
  // vary a lot from one month to the next but still land reliably every
  // month. Two unrelated purchases at the same shop, months apart with
  // gaps in between, have low density and stay non-recurring. Matching
  // uses labelGroupingKey, not the raw label, so "FACTURE CANTINE MAI26"
  // and "...JUIN26" are recognized as the same recurring bill despite the
  // embedded month, and generic placeholders (see GENERIC_LABELS) never
  // get grouped at all.
  const recurringLabels = useMemo(() => {
    const keyMonths = {};
    (account.transactions || []).forEach((t) => {
      const key = labelGroupingKey(t.label);
      if (!key) return;
      (keyMonths[key] ||= new Set()).add(t.date.slice(0, 7));
    });
    const result = new Set();
    Object.entries(keyMonths).forEach(([key, months]) => {
      if (months.size < 2) return;
      const sorted = Array.from(months).sort();
      const [y1, m1] = sorted[0].split("-").map(Number);
      const [y2, m2] = sorted[sorted.length - 1].split("-").map(Number);
      const span = (y2 - y1) * 12 + (m2 - m1) + 1;
      const density = months.size / span;
      if (density >= 0.6) result.add(key);
    });
    return result;
  }, [account.transactions]);

  const monthTransactions = (account.transactions || []).filter((t) => t.date.slice(0, 7) === effectiveMonth);
  const monthTransactionsSorted = [...monthTransactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const isRecurring = (t) => {
    const key = labelGroupingKey(t.label);
    if (!key) return false;
    if (recurringOverrides[key] !== undefined) return recurringOverrides[key];
    return recurringLabels.has(key);
  };
  const monthIncome = monthTransactions.filter((t) => t.amount >= 0);
  const monthExpenses = monthTransactions.filter((t) => t.amount < 0);
  const incomeRecurring = monthIncome.filter(isRecurring);
  const incomeNonRecurring = monthIncome.filter((t) => !isRecurring(t));
  const expenseRecurring = monthExpenses.filter(isRecurring);
  const expenseNonRecurring = monthExpenses.filter((t) => !isRecurring(t));

  function renderTxRow(t) {
    const openDetail = () => setSelectedIndex(monthTransactionsSorted.indexOf(t));
    return (
      <div key={txKey(t)} className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ background: "#FFFFFF" }}>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={openDetail}>
          <div className="text-sm truncate" style={{ color: "#0F2A1C" }}>{t.label || "(sans libellé)"}</div>
          <div className="text-xs mt-0.5" style={{ color: "#6B8072" }}>{fmtDate(t.date)}</div>
        </div>
        <div
          className="shrink-0 text-sm cursor-pointer"
          style={{ fontFamily: "'IBM Plex Mono', monospace", color: t.amount >= 0 ? "#15803D" : "#C2410C" }}
          onClick={openDetail}
        >
          {t.amount >= 0 ? "+" : ""}{fmtEURPrecise(t.amount)}
        </div>
        {t.provision && (
          <span className="shrink-0" title={`Provisionné${t.provisionReason ? " — " + t.provisionReason : ""}`}>
            <Flag size={13} color="#C99A3D" />
          </span>
        )}
        {account.type === "courant" && (
          <>
            <button
              onClick={() => {
                const next = t.rigid === undefined || t.rigid === null ? true : t.rigid === true ? false : null;
                onSetRigid(account.id, txKey(t), next);
              }}
              className="shrink-0 p-1.5 rounded-xl"
              style={{
                border: `1px solid ${t.rigid === true ? "#C2410C" : t.rigid === false ? "#15803D" : "#CFE5D2"}`,
                background: t.rigid === true ? "#C2410C14" : t.rigid === false ? "#15803D14" : "transparent",
              }}
              title={
                t.rigid === true
                  ? "Marqué contraint (clique pour passer en discrétionnaire)"
                  : t.rigid === false
                  ? "Marqué discrétionnaire (clique pour revenir à la catégorie)"
                  : "Suit la catégorie (clique pour marquer contraint)"
              }
            >
              <Lock size={12} color={t.rigid === true ? "#C2410C" : t.rigid === false ? "#15803D" : "#A9B5AB"} />
            </button>
            {t.category ? (
              <button
                onClick={() => onCategorize(account.id, txKey(t), "")}
                className="shrink-0 text-xs px-2 py-1 rounded-xl"
                style={{ background: `${meta.color}14`, color: meta.color }}
                title="Retirer la catégorie"
              >
                {t.category}
              </button>
            ) : (
              <CategorySelect
                value={t.category}
                knownCategories={accountKnownCategories}
                onChange={(cat) => onCategorize(account.id, txKey(t), cat)}
              />
            )}
          </>
        )}
      </div>
    );
  }

  function saveCryptoValuation(date) {
    if (!account.crypto?.holdings?.length) return;
    const total = account.crypto.holdings.reduce((s, h) => {
      const price = Number(cryptoPriceInputs[h.symbol]);
      return s + (isNaN(price) ? 0 : price * h.quantity);
    }, 0);
    if (total > 0) {
      const priceMap = {};
      account.crypto.holdings.forEach((h) => {
        const price = Number(cryptoPriceInputs[h.symbol]);
        if (!isNaN(price) && price > 0) priceMap[h.symbol] = price;
      });
      onLogCryptoValuation(account.id, { date: date || todayISO(), balance: Math.round(total * 100) / 100 }, priceMap);
    }
  }

  const [tradeError, setTradeError] = useState("");
  function submitTrade(e) {
    e.preventDefault();
    const symbol = tradeSymbol.trim().toUpperCase();
    const quantity = Number(tradeQuantity);
    const price = Number(tradePrice);
    if (!symbol) return setTradeError("Indique le symbole (ex. BTC).");
    if (!quantity || quantity <= 0) return setTradeError("Indique une quantité valide.");
    if (!price || price <= 0) return setTradeError("Indique un prix unitaire valide.");
    const existing = account.crypto?.holdings?.find((h) => h.symbol === symbol);
    if (tradeType === "vente" && (!existing || existing.quantity < quantity)) {
      return setTradeError(`Tu ne détiens que ${existing?.quantity ?? 0} ${symbol} sur ce compte.`);
    }
    setTradeError("");
    onRecordTrade(account.id, { type: tradeType, symbol, quantity, price, date: tradeDate });
    setTradeQuantity("");
    setTradePrice("");
  }

  async function viewImportFile(importId) {
    setPreviewError(null);
    setPreviewLoadingId(importId);
    try {
      const res = await window.storage.get(`file:${importId}`, false);
      if (res?.value) {
        window.open(res.value, "_blank");
      } else {
        setPreviewError(importId);
      }
    } catch (err) {
      setPreviewError(importId);
    } finally {
      setPreviewLoadingId(null);
    }
  }

  const [ribError, setRibError] = useState("");

  async function viewRibFile() {
    setRibError("");
    try {
      const res = await window.storage.get(`rib:${account.id}`, false);
      if (res?.value) window.open(res.value, "_blank");
      else setRibError("Fichier introuvable dans le stockage.");
    } catch (err) {
      setRibError(
        "Impossible de récupérer le RIB" + (err?.message ? ` (${err.message})` : "") +
        ". Le stockage persistant ne fonctionne que sur un artefact publié — s'il ne l'est pas encore, réimporte le RIB une fois la publication faite."
      );
    }
  }

  async function downloadRibFile() {
    setRibError("");
    try {
      const res = await window.storage.get(`rib:${account.id}`, false);
      if (!res?.value) {
        setRibError("Fichier introuvable dans le stockage.");
        return;
      }
      const a = document.createElement("a");
      a.href = res.value;
      a.download = account.ribFilename || `RIB-${account.name}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      setRibError(
        "Impossible de récupérer le RIB" + (err?.message ? ` (${err.message})` : "") +
        ". Le stockage persistant ne fonctionne que sur un artefact publié — s'il ne l'est pas encore, réimporte le RIB une fois la publication faite."
      );
    }
  }


  const isCredit = account.type === "credit";
  let monthsLeft = null;
  if (isCredit && account.credit?.monthlyPayment && entries.length) {
    monthsLeft = Math.ceil(bal / account.credit.monthlyPayment);
  }
  const payoffDate = isCredit ? creditPayoffDate(account) : null;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs mb-6" style={{ color: "#4B5D52" }}>
        <ArrowLeft size={14} /> Retour à la vue d'ensemble
      </button>

      <div className="flex items-start justify-between mb-1">
        <div>
          <div className="flex items-center gap-2 text-xs mb-1" style={{ color: meta.color }}>
            <meta.icon size={13} /> {meta.label}
          </div>
          <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "1.8rem", color: "#0F2A1C" }}>{account.name}</h2>
          {account.institution && <div className="text-sm mt-0.5" style={{ color: "#6B8072" }}>{account.institution}</div>}
          {(account.iban || account.bic || account.contractNumber) && (
            <div className="text-xs mt-1" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B8072" }}>
              {[account.iban, account.bic, account.contractNumber ? `Contrat ${account.contractNumber}` : null].filter(Boolean).join(" · ")}
            </div>
          )}
          {account.ribFilename && (
            <div className="flex items-center gap-3 mt-1.5">
              <button onClick={viewRibFile} className="flex items-center gap-1 text-xs" style={{ color: "#15803D" }}>
                <Eye size={12} /> Voir le RIB
              </button>
              <button onClick={downloadRibFile} className="flex items-center gap-1 text-xs" style={{ color: "#15803D" }}>
                <Download size={12} /> Télécharger
              </button>
            </div>
          )}
          {ribError && <p className="text-xs mt-1" style={{ color: "#C2410C" }}>{ribError}</p>}
        </div>
        <button onClick={() => onEdit(account)} className="p-2 rounded-xl" style={{ border: "1px solid #CFE5D2" }}>
          <Pencil size={14} color="#0F2A1C" />
        </button>
      </div>

      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "2rem", color: entries.length ? "#0F2A1C" : "#A9B5AB" }} className="mt-4">
        {entries.length ? fmtEURPrecise(bal) : "— aucune donnée"}
      </div>
      {!entries.length && (
        <p className="text-xs mt-1" style={{ color: "#6B8072" }}>
          Ce compte n'a plus d'historique — importe un relevé ou saisis un solde pour le reconstituer.
        </p>
      )}
      {provisions !== 0 && (
        <div className="flex items-center gap-4 mt-2 text-xs">
          <span className="flex items-center gap-1" style={{ color: "#C99A3D" }}>
            <Flag size={11} /> Provisions : {fmtEURPrecise(provisions)}
          </span>
          <span style={{ color: "#6B8072" }}>
            Disponible réel : <strong style={{ color: "#0F2A1C" }}>{fmtEURPrecise(bal - provisions)}</strong>
          </span>
        </div>
      )}

      {(account.type === "epargne" || account.type === "courant") && (
        <div className="mt-4 rounded-xl p-4" style={{ background: "#F3F8F2" }}>
          <h3 className="text-xs uppercase tracking-wide mb-2" style={{ color: "#4B5D52" }}>Provisions</h3>
          <p className="text-[11px] mb-3" style={{ color: "#6B8072" }}>
            Argent disponible mais mis de côté sur ce compte. Gestion (ajout, suppression) depuis l'onglet Objectifs de la vue d'ensemble.
          </p>
          {(() => {
            const txProvisions = (account.transactions || []).filter((t) => t.provision === true);
            const hasAny = txProvisions.length > 0 || (account.provisions || []).length > 0;
            if (!hasAny) {
              return <p className="text-xs" style={{ color: "#A9B5AB" }}>Aucune provision pour l'instant.</p>;
            }
            return (
              <div className="space-y-1.5">
                {txProvisions.map((t) => (
                  <div key={txKey(t)} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg" style={{ background: "#FFFFFF" }}>
                    <div className="min-w-0">
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#0F2A1C" }}>{fmtEURPrecise(t.amount)}</span>
                      {t.provisionReason && <span className="ml-2" style={{ color: "#6B8072" }}>{t.provisionReason}</span>}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "#CFE5D2", color: "#4B5D52" }}>mouvement · {fmtDate(t.date)}</span>
                    </div>
                  </div>
                ))}
                {(account.provisions || []).map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg" style={{ background: "#FFFFFF" }}>
                    <div className="min-w-0">
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#0F2A1C" }}>{fmtEURPrecise(p.amount)}</span>
                      {p.reason && <span className="ml-2" style={{ color: "#6B8072" }}>{p.reason}</span>}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "#F5E4C1", color: "#7A4A16" }}>manuelle{p.date ? " · " + fmtDate(p.date) : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {isCredit && (
        <div className="grid grid-cols-3 gap-6 mt-4 text-sm">
          <div>
            <div className="text-xs mb-1" style={{ color: "#4B5D52" }}>Taux</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{account.credit?.rate ?? "—"}%</div>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "#4B5D52" }}>Mensualité</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtEUR(account.credit?.monthlyPayment)}</div>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "#4B5D52" }}>Solde estimé</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
              {monthsLeft ? `~${monthsLeft} mois` : "—"}{payoffDate ? ` (${fmtDate(payoffDate)})` : ""}
            </div>
          </div>
        </div>
      )}

      {account.type === "epargne" && account.savings && (
        <div className="grid grid-cols-2 gap-6 mt-4 text-sm">
          <div>
            <div className="text-xs mb-1" style={{ color: "#4B5D52" }}>Taux moyen</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{account.savings.rate ?? "—"}%</div>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "#4B5D52" }}>Versement</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
              {account.savings.contribution ? `${fmtEUR(account.savings.contribution)} / ${account.savings.frequency === "hebdomadaire" ? "sem." : "mois"}` : "—"}
            </div>
          </div>
        </div>
      )}

      {account.crypto?.holdings?.length > 0 && (
        <div className="mt-5 rounded-xl p-4" style={{ background: "#F3F8F2" }}>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs uppercase tracking-wide" style={{ color: "#0F2A1C" }}>Positions crypto</h3>
            <span
              className="text-[10px] px-2 py-0.5 rounded-full"
              style={{
                background: cryptoLiquidityTier(account) === "semi" ? "#C99A3D14" : "#7C6F9E14",
                color: cryptoLiquidityTier(account) === "semi" ? "#C99A3D" : "#7C6F9E",
              }}
            >
              {cryptoLiquidityTier(account) === "semi" ? "Épargne disponible" : "Épargne bloquée"}
            </span>
          </div>
          <p className="text-[11px] mb-3" style={{ color: "#6B8072" }}>
            Pas de cours en direct possible ici (restriction technique de l'environnement) — renseigne le prix unitaire actuel de chaque position à la main.
          </p>
          <div className="space-y-2">
            {account.crypto.holdings.map((h, i) => {
              const price = cryptoPriceInputs[h.symbol] ?? "";
              const value = price !== "" && !isNaN(Number(price)) ? Number(price) * h.quantity : null;
              const refPrice = price !== "" && !isNaN(Number(price)) ? Number(price) : h.lastPrice;
              const athRatio = h.ath > 0 && refPrice > 0 ? (refPrice / h.ath) * 100 : null;
              return (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm w-24 shrink-0" style={{ color: "#0F2A1C" }}>
                      {h.quantity} <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{h.symbol}</span>
                    </span>
                    <input
                      type="number" step="any"
                      value={price}
                      onChange={(e) => setCryptoPriceInputs({ ...cryptoPriceInputs, [h.symbol]: e.target.value })}
                      placeholder="Prix unitaire €"
                      className="flex-1 px-2 py-1.5 rounded-lg text-xs outline-none"
                      style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                    <span className="text-xs w-20 text-right shrink-0" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#4B5D52" }}>
                      {value != null ? fmtEURPrecise(value) : "—"}
                    </span>
                  </div>
                  <div className="text-[10px] mt-0.5 pl-1" style={{ color: "#A9B5AB" }}>
                    {h.ath > 0 ? (
                      <>ATH {fmtEURPrecise(h.ath)}{athRatio != null ? ` · ${athRatio.toFixed(0)}% de l'ATH` : ""}</>
                    ) : (
                      "Pas d'ATH renseigné (modifier le compte pour l'ajouter)"
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3">
            <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Date de cette valorisation</label>
            <input
              type="date"
              value={cryptoValuationDate}
              max={todayISO()}
              onChange={(e) => setCryptoValuationDate(e.target.value)}
              className="px-2 py-1.5 rounded-lg text-xs outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
            />
          </div>
          <button
            onClick={() => saveCryptoValuation(cryptoValuationDate)}
            className="mt-3 text-xs px-3 py-1.5 rounded-xl text-white"
            style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}
          >
            {cryptoValuationDate === todayISO() ? "Enregistrer la valorisation du jour" : `Enregistrer la valorisation du ${fmtDate(cryptoValuationDate)}`}
          </button>

          <form onSubmit={submitTrade} className="mt-5 pt-4 space-y-2" style={{ borderTop: "1px solid #CFE5D2" }}>
            <h4 className="text-xs uppercase tracking-wide mb-1" style={{ color: "#0F2A1C" }}>Achat / vente</h4>
            <div className="flex gap-2">
              {[{ v: "achat", label: "Achat" }, { v: "vente", label: "Vente" }].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setTradeType(opt.v)}
                  className="flex-1 py-1.5 rounded-lg text-xs"
                  style={{
                    border: tradeType === opt.v ? "1.5px solid #0F2A1C" : "1px solid #CFE0D3",
                    background: tradeType === opt.v ? "#0F2A1C14" : "#FFFFFF",
                    color: tradeType === opt.v ? "#0F2A1C" : "#4B5D52",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={tradeSymbol}
                onChange={(e) => setTradeSymbol(e.target.value.toUpperCase())}
                placeholder="BTC"
                className="w-20 px-2 py-1.5 rounded-lg text-xs outline-none uppercase"
                style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
              />
              <input
                type="number" step="any"
                value={tradeQuantity}
                onChange={(e) => setTradeQuantity(e.target.value)}
                placeholder="Quantité"
                className="flex-1 px-2 py-1.5 rounded-lg text-xs outline-none"
                style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
              />
              <input
                type="number" step="any"
                value={tradePrice}
                onChange={(e) => setTradePrice(e.target.value)}
                placeholder="Prix unitaire €"
                className="flex-1 px-2 py-1.5 rounded-lg text-xs outline-none"
                style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
              />
            </div>
            <input
              type="date"
              value={tradeDate}
              max={todayISO()}
              onChange={(e) => setTradeDate(e.target.value)}
              className="px-2 py-1.5 rounded-lg text-xs outline-none"
              style={{ border: "1px solid #CFE0D3", background: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}
            />
            {tradeQuantity && tradePrice && !isNaN(Number(tradeQuantity)) && !isNaN(Number(tradePrice)) && (
              <p className="text-[11px]" style={{ color: "#6B8072" }}>
                {tradeType === "achat" ? "Sortie de" : "Entrée de"} {fmtEURPrecise(Number(tradeQuantity) * Number(tradePrice))}
              </p>
            )}
            {tradeError && <p className="text-xs" style={{ color: "#C2410C" }}>{tradeError}</p>}
            <button
              type="button"
              onClick={submitTrade}
              className="w-full py-1.5 rounded-lg text-xs text-white"
              style={{ background: tradeType === "achat" ? "#15803D" : "#C2410C" }}
            >
              Enregistrer {tradeType === "achat" ? "l'achat" : "la vente"}
            </button>
          </form>
        </div>
      )}

      {account.type !== "credit" && (
        <div className="mt-6">
          <CoverageGrid
            coverage={account.coverage || []}
            color={meta.color}
            filter={chartFilter}
            onSelectYear={(y) => setChartFilter({ mode: "year", year: y, month: null })}
            onSelectMonth={(y, m) =>
              setChartFilter((prev) =>
                prev.mode === "month" && prev.year === y && prev.month === m
                  ? { mode: "year", year: y, month: null } // clicking the active month again zooms back out to the year
                  : { mode: "month", year: y, month: m }
              )
            }
          />
        </div>
      )}

      <LedgerRule />

      <div className="flex items-center justify-between mt-6 mb-1">
        <span className="text-xs" style={{ color: "#6B8072" }}>
          {chartFilter.mode === "all"
            ? "Tout l'historique"
            : chartFilter.mode === "month"
            ? `${MONTH_LABELS[chartFilter.month - 1]} ${chartFilter.year}`
            : `Année ${chartFilter.year}`}
        </span>
        {chartFilter.mode !== "all" && (
          <button
            onClick={() => setChartFilter({ mode: "all", year: null, month: null })}
            className="text-xs px-2 py-1 rounded-lg"
            style={{ border: "1px solid #CFE5D2", color: "#4B5D52" }}
          >
            Toutes les années
          </button>
        )}
      </div>
      <div className="h-56">
        {chartData.length >= 2 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="fillArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={meta.color} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={meta.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#CFE5D2" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6B8072" }} axisLine={{ stroke: "#CFE5D2" }} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#6B8072" }} axisLine={false} tickLine={false} width={70}
                tickFormatter={(v) => fmtEUR(v)} />
              <Tooltip
                formatter={(v) => fmtEURPrecise(v)}
                contentStyle={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)", border: "none", borderRadius: 2, fontSize: 12 }}
                labelStyle={{ color: "#F3F8F2" }}
                itemStyle={{ color: "#F3F8F2" }}
              />
              <Area type="monotone" dataKey="balance" stroke={meta.color} strokeWidth={2} fill="url(#fillArea)" />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: "#6B8072" }}>
            {entries.length >= 2
              ? "Pas assez de données sur cette période — essaie \"Toutes les années\"."
              : "Ajoute au moins deux soldes pour voir l'évolution."}
          </div>
        )}
      </div>

      <div className="flex justify-end mt-4">
        <button
          onClick={() => onAddEntry(account)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl text-white"
          style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}
        >
          <Plus size={13} /> Ajouter un solde
        </button>
      </div>

      {(account.transactions || []).length > 0 && (
        <>
          <div className="flex items-center justify-between mt-8 mb-1">
            <h3 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Mouvements</h3>
          </div>
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setSelectedMonth(availableMonths[monthIdx - 1])}
              disabled={monthIdx <= 0}
              className="p-1.5 rounded-xl disabled:opacity-30"
              style={{ border: "1px solid #CFE5D2" }}
              aria-label="Mois précédent"
            >
              <ArrowLeft size={14} color="#0F2A1C" />
            </button>
            <span className="text-sm" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#0F2A1C" }}>
              {(() => {
                const [y, m] = effectiveMonth.split("-");
                return `${MONTH_LABELS[Number(m) - 1]} ${y}`;
              })()}
            </span>
            <button
              onClick={() => setSelectedMonth(availableMonths[monthIdx + 1])}
              disabled={monthIdx < 0 || monthIdx >= availableMonths.length - 1}
              className="p-1.5 rounded-xl disabled:opacity-30"
              style={{ border: "1px solid #CFE5D2" }}
              aria-label="Mois suivant"
            >
              <ChevronRight size={14} color="#0F2A1C" />
            </button>
          </div>
          <p className="text-[11px] mb-3" style={{ color: "#6B8072" }}>
            <Lock size={10} className="inline align-baseline mr-1" /> clique pour forcer contraint/discrétionnaire sur ce mouvement précis, indépendamment de sa catégorie.
          </p>

          {monthTransactions.length === 0 ? (
            <p className="text-sm text-center py-8" style={{ color: "#6B8072" }}>Aucun mouvement ce mois-ci.</p>
          ) : (
            <>
              {monthIncome.length > 0 && (
                <div className="mb-5">
                  <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "#15803D" }}>
                    Entrées ({monthIncome.length}) · {fmtEUR(monthIncome.reduce((s, t) => s + t.amount, 0))}
                  </div>
                  {incomeRecurring.length > 0 && (
                    <div className="mb-2">
                      <div className="text-[11px] mb-1.5" style={{ color: "#6B8072" }}>Récurrentes ({incomeRecurring.length})</div>
                      <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
                        {[...incomeRecurring].reverse().map(renderTxRow)}
                      </div>
                    </div>
                  )}
                  {incomeNonRecurring.length > 0 && (
                    <div>
                      <div className="text-[11px] mb-1.5" style={{ color: "#6B8072" }}>Non récurrentes ({incomeNonRecurring.length})</div>
                      <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
                        {[...incomeNonRecurring].reverse().map(renderTxRow)}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {monthExpenses.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "#C2410C" }}>
                    Sorties ({monthExpenses.length}) · {fmtEUR(monthExpenses.reduce((s, t) => s + t.amount, 0))}
                  </div>
                  {expenseRecurring.length > 0 && (
                    <div className="mb-2">
                      <div className="text-[11px] mb-1.5" style={{ color: "#6B8072" }}>Récurrentes ({expenseRecurring.length})</div>
                      <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
                        {[...expenseRecurring].reverse().map(renderTxRow)}
                      </div>
                    </div>
                  )}
                  {expenseNonRecurring.length > 0 && (
                    <div>
                      <div className="text-[11px] mb-1.5" style={{ color: "#6B8072" }}>Non récurrentes ({expenseNonRecurring.length})</div>
                      <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
                        {[...expenseNonRecurring].reverse().map(renderTxRow)}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {(account.imports || []).length > 0 && (
        <>
          <div className="flex items-center justify-between mt-8 mb-3">
            <h3 className="text-xs uppercase tracking-[0.14em] font-semibold" style={{ color: "#15803D", fontFamily: "'Space Grotesk', sans-serif" }}>Historique des imports</h3>
          </div>
          <div className="space-y-px rounded-xl overflow-hidden shadow-sm" style={{ background: "#CFE5D2" }}>
            {[...account.imports].reverse().map((imp) => (
              <div key={imp.id} className="flex items-center justify-between gap-3 px-4 py-3" style={{ background: "#FFFFFF" }}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate" style={{ color: "#0F2A1C" }}>{imp.filename || "Import"}</div>
                  <div className="text-xs mt-0.5" style={{ color: "#6B8072" }}>
                    {new Date(imp.timestamp).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {imp.dateRange ? ` · ${fmtDate(imp.dateRange.start)} → ${fmtDate(imp.dateRange.end)}` : ""}
                    {imp.transactionIds?.length ? ` · ${imp.transactionIds.length} mouvement(s)` : ""}
                  </div>
                  {previewError === imp.id && (
                    <div className="text-xs mt-0.5" style={{ color: "#C2410C" }}>Aperçu indisponible pour cet import.</div>
                  )}
                </div>
                <button
                  onClick={() => viewImportFile(imp.id)}
                  disabled={previewLoadingId === imp.id}
                  className="shrink-0 p-2 rounded-xl disabled:opacity-50"
                  style={{ border: "1px solid #CFE5D2" }}
                  aria-label="Voir le fichier importé"
                  title="Voir le fichier importé"
                >
                  <Eye size={14} color="#0F2A1C" />
                </button>
                {confirmDeleteImport === imp.id ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => { onDeleteImport(account.id, imp.id); setConfirmDeleteImport(null); }}
                      className="text-xs px-2.5 py-1.5 rounded-xl text-white"
                      style={{ background: "#C2410C" }}
                    >
                      Supprimer
                    </button>
                    <button
                      onClick={() => setConfirmDeleteImport(null)}
                      className="text-xs px-2.5 py-1.5 rounded-xl"
                      style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}
                    >
                      Annuler
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteImport(imp.id)}
                    className="shrink-0 p-2 rounded-xl"
                    style={{ border: "1px solid #CFE5D2" }}
                    aria-label="Supprimer cet import"
                  >
                    <Trash2 size={14} color="#C2410C" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {selectedIndex != null && monthTransactionsSorted[selectedIndex] && (
        <TransactionDetailModal
          transaction={monthTransactionsSorted[selectedIndex]}
          index={selectedIndex}
          total={monthTransactionsSorted.length}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex < monthTransactionsSorted.length - 1}
          onPrev={() => setSelectedIndex((i) => i - 1)}
          onNext={() => setSelectedIndex((i) => i + 1)}
          account={account}
          meta={meta}
          knownCategories={accountKnownCategories}
          onCategorize={onCategorize}
          onSetRigid={onSetRigid}
          onSetProvision={onSetProvision}
          knownProvisionReasons={knownProvisionReasons}
          isRecurringNow={isRecurring(monthTransactionsSorted[selectedIndex])}
          recurringOverride={recurringOverrides[labelGroupingKey(monthTransactionsSorted[selectedIndex].label)]}
          onSetRecurring={(value) => onSetRecurringOverride(labelGroupingKey(monthTransactionsSorted[selectedIndex].label), value)}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </div>
  );
}

// ---------- Lock screen & security settings ----------
function LockScreen({ expectedPin, onUnlock }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function submit(e) {
    e.preventDefault();
    if (value === expectedPin) {
      onUnlock();
    } else {
      setError("Code incorrect.");
      setValue("");
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center" style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}>
      <form onSubmit={submit} className="w-full max-w-xs px-6 text-center">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4"
          style={{ background: "#163A26" }}
        >
          <Lock size={20} color="#C6F135" />
        </div>
        <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#F3F8F2", fontSize: "1.2rem" }} className="mb-4">
          Suivi des comptes verrouillé
        </h1>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(""); }}
          placeholder="Code"
          className="w-full px-3 py-3 rounded-xl outline-none text-center text-lg"
          style={{ background: "#163A26", color: "#F3F8F2", border: "1px solid #2E5C40", fontFamily: "'IBM Plex Mono', monospace" }}
        />
        {error && <p className="text-xs mt-2" style={{ color: "#FCA5A5" }}>{error}</p>}
        <button type="button" onClick={submit} className="w-full mt-4 py-2.5 rounded-xl text-sm" style={{ background: "#C6F135", color: "#0F2A1C" }}>
          Déverrouiller
        </button>
      </form>
    </div>
  );
}

function SecuritySettingsModal({ hasPin, onSetPin, onRemovePin, onClose }) {
  const [step, setStep] = useState(hasPin ? "menu" : "set");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");

  function submitSet(e) {
    e.preventDefault();
    if (newPin.length < 4) {
      setError("Le code doit faire au moins 4 caractères.");
      return;
    }
    if (newPin !== confirmPin) {
      setError("Les deux codes ne correspondent pas.");
      return;
    }
    onSetPin(newPin);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(33,38,31,0.45)" }}>
      <div className="w-full max-w-xs rounded-xl shadow-xl" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #CFE5D2" }}>
          <h3 className="text-lg" style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#0F2A1C" }}>Sécurité</h3>
          <button onClick={onClose} aria-label="Fermer" className="p-1 hover:opacity-60">
            <X size={18} color="#0F2A1C" />
          </button>
        </div>

        {step === "menu" ? (
          <div className="px-6 py-5 space-y-3">
            <p className="text-xs" style={{ color: "#4B5D52" }}>Un code de verrouillage est déjà actif pour cette appli.</p>
            <button onClick={() => setStep("set")} className="w-full py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#0F2A1C" }}>
              Changer le code
            </button>
            <button onClick={() => { onRemovePin(); onClose(); }} className="w-full py-2 rounded-xl text-sm" style={{ color: "#C2410C" }}>
              Désactiver le verrouillage
            </button>
          </div>
        ) : (
          <form onSubmit={submitSet} className="px-6 py-5 space-y-4">
            <p className="text-xs" style={{ color: "#4B5D52" }}>
              Ce code protège l'accès à l'appli sur cet appareil. Ce n'est pas un vrai mot de passe serveur — garde-le simple mais pas évident.
            </p>
            <div>
              <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Nouveau code</label>
              <input
                type="password" inputMode="numeric" autoFocus value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                className="w-full px-3 py-2 rounded-xl outline-none"
                style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide mb-1" style={{ color: "#4B5D52" }}>Confirmer le code</label>
              <input
                type="password" inputMode="numeric" value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
                className="w-full px-3 py-2 rounded-xl outline-none"
                style={{ border: "1px solid #CFE0D3", background: "#FFFFFF" }}
              />
            </div>
            {error && <p className="text-xs" style={{ color: "#C2410C" }}>{error}</p>}
            <button type="button" onClick={submitSet} className="w-full py-2 rounded-xl text-sm text-white" style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}>
              Activer
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------- Situation report & AI advice ----------

// Builds a compact JSON summary of the current financial situation — this
// feeds both the on-screen "Vue d'ensemble" of the report and the PDF
// export, and is kept free of any single transaction's raw label text
// beyond category aggregates for brevity.
function buildFinancialSummary(accounts, goals) {
  const byTier = { immediate: [], semi: [], illiquide: [], dettes: [] };
  accounts.forEach((a) => {
    if (a.type === "courant") byTier.immediate.push(a);
    else if (a.type === "crypto") (cryptoLiquidityTier(a) === "semi" ? byTier.semi : byTier.illiquide).push(a);
    else if (a.type === "epargne") (a.liquidity === "bloque" ? byTier.illiquide : byTier.semi).push(a);
    else if (a.type === "credit") byTier.dettes.push(a);
  });
  const sum = (arr) => Math.round(arr.reduce((s, a) => s + currentBalance(a), 0) * 100) / 100;
  const realProvisions = Math.round(byTier.semi.reduce((s, a) => s + Math.max(0, computeProvisions(a)), 0) * 100) / 100;
  const goalReserve = Math.round(computeGoalReserve(accounts, goals || []) * 100) / 100;
  const d30 = daysAgoIso(30);
  const realProvisions30 = Math.round(byTier.semi.reduce((s, a) => s + Math.max(0, computeProvisionsAsOf(a, d30)), 0) * 100) / 100;
  const epargneDisponible30 = Math.round(
    byTier.semi.reduce((s, a) => {
      const b = balanceAsOf(a, d30);
      return s + (b ?? 0);
    }, 0) * 100
  ) / 100;

  const totals = {
    liquidites: sum(byTier.immediate),
    epargne_disponible_totale: sum(byTier.semi),
    epargne_disponible_totale_il_y_a_30_jours: epargneDisponible30,
    epargne_disponible_provisionnee: realProvisions + goalReserve,
    epargne_disponible_provisionnee_il_y_a_30_jours: realProvisions30,
    epargne_disponible_reelle: Math.round((sum(byTier.semi) - realProvisions - goalReserve) * 100) / 100,
    epargne_bloquee: sum(byTier.illiquide),
    dettes_restant_du_total: sum(byTier.dettes),
    dettes_mensualites_totales: Math.round(byTier.dettes.reduce((s, a) => s + (a.credit?.monthlyPayment || 0), 0) * 100) / 100,
  };

  const comptes = accounts.map((a) => ({
    nom: a.name,
    type: a.type,
    etablissement: a.institution || undefined,
    liquidite: a.type === "epargne" ? (a.liquidity === "bloque" ? "bloquée" : "disponible") : undefined,
    solde: Math.round(currentBalance(a) * 100) / 100,
    taux_credit_pct: a.type === "credit" ? a.credit?.rate : undefined,
    mensualite_credit: a.type === "credit" ? a.credit?.monthlyPayment : undefined,
    taux_moyen_epargne_pct: a.type === "epargne" ? a.savings?.rate : undefined,
    versement_recurrent_epargne: a.type === "epargne" ? a.savings?.contribution : undefined,
    frequence_versement: a.type === "epargne" ? a.savings?.frequency : undefined,
    positions_crypto: a.type === "crypto" ? a.crypto?.holdings : undefined,
    performance: (() => {
      const perf = computeAccountPerformance(a);
      return perf ? { label: perf.label, gain: perf.gain, pct: perf.pct != null ? Math.round(perf.pct * 10) / 10 : null } : undefined;
    })(),
  }));

  const provisionsDetail = [];
  accounts.forEach((a) => {
    (a.transactions || []).filter((t) => t.provision === true).forEach((t) => {
      provisionsDetail.push({ compte: a.name, montant: t.amount, raison: t.provisionReason || null, source: "mouvement" });
    });
    (a.provisions || []).forEach((p) => {
      provisionsDetail.push({ compte: a.name, montant: p.amount, raison: p.reason || null, source: "manuelle" });
    });
  });

  const goalsDetail = (goals || []).map((g) => ({
    nom: g.name,
    cible: g.targetAmount,
    date_cible: g.targetDate || null,
    important: g.important,
    base: g.basedOnTotal ? "épargne disponible totale" : "provisions nommées",
    progression: Math.round(computeGoalProgress(accounts, g) * 100) / 100,
    progression_il_y_a_30_jours: Math.round(computeGoalProgressAsOf(accounts, g, daysAgoIso(30)) * 100) / 100,
  }));

  const timelineDettes = computePayoffTimeline(byTier.dettes).map((s) => ({
    etape: s.label,
    date: s.date,
    charge_mensuelle_apres: s.monthly,
  }));

  const uncategorized = accounts.reduce((s, a) => s + (a.transactions || []).filter((t) => !t.category).length, 0);

  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceIso = since.toISOString().slice(0, 10);
  const categorySpend = {};
  accounts.forEach((a) =>
    (a.transactions || []).forEach((t) => {
      if (t.amount < 0 && t.date >= sinceIso) {
        const cat = t.category || "Non catégorisé";
        categorySpend[cat] = Math.round(((categorySpend[cat] || 0) + Math.abs(t.amount)) * 100) / 100;
      }
    })
  );

  return {
    totaux: totals,
    comptes,
    provisions: provisionsDetail,
    objectifs: goalsDetail,
    calendrier_extinction_dettes: timelineDettes,
    mouvements_non_categorises: uncategorized,
    depenses_90_derniers_jours_par_categorie: categorySpend,
    date_du_jour: todayISO(),
  };
}

// Builds a downloadable PDF entirely in the browser (via jsPDF, loaded
// from cdnjs — see loadJsPdf) laying out the same financial summary that
// used to be sent to an AI API. No network call, no API key: the person
// downloads the PDF and hands it to whichever AI assistant they prefer
// (Claude, ChatGPT...) to get advice, instead of this app calling one
// directly — which would need a server to keep an API key safe.
async function generatePdfReport(summary) {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 48;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  function ensureSpace(h) {
    if (y + h > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  }
  function addTitle(text) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    ensureSpace(28);
    doc.text(text, margin, y);
    y += 26;
  }
  function addHeading(text) {
    y += 6;
    ensureSpace(22);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12.5);
    doc.text(text, margin, y);
    y += 6;
    doc.setDrawColor(210);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;
  }
  function addLine(text, opts = {}) {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.size || 10.5);
    const indent = opts.indent || 0;
    const lines = doc.splitTextToSize(text, maxWidth - indent);
    lines.forEach((line) => {
      ensureSpace(14);
      doc.text(line, margin + indent, y);
      y += 14;
    });
  }
  const fmt = (n) =>
    n == null ? "—" : `${Number(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

  addTitle("Rapport financier");
  addLine(`Généré le ${fmtDate(summary.date_du_jour)}`, { size: 9 });
  y += 8;

  addHeading("Vue d'ensemble");
  addLine(`Liquidités : ${fmt(summary.totaux.liquidites)}`, { bold: true });
  addLine(`Épargne disponible (total) : ${fmt(summary.totaux.epargne_disponible_totale)}`, { bold: true });
  {
    const deltaEpargne = Math.round((summary.totaux.epargne_disponible_totale - summary.totaux.epargne_disponible_totale_il_y_a_30_jours) * 100) / 100;
    if (deltaEpargne !== 0) addLine(`${deltaEpargne > 0 ? "+" : ""}${fmt(deltaEpargne)} sur 30 jours`, { indent: 14, size: 9.5 });
  }
  addLine(`dont provisionnée : ${fmt(summary.totaux.epargne_disponible_provisionnee)}`, { indent: 14 });
  {
    const deltaProv = Math.round((summary.totaux.epargne_disponible_provisionnee - summary.totaux.epargne_disponible_provisionnee_il_y_a_30_jours) * 100) / 100;
    if (deltaProv !== 0) addLine(`${deltaProv > 0 ? "+" : ""}${fmt(deltaProv)} sur 30 jours`, { indent: 28, size: 9.5 });
  }
  addLine(`dont réellement libre : ${fmt(summary.totaux.epargne_disponible_reelle)}`, { indent: 14 });
  addLine(`Épargne bloquée : ${fmt(summary.totaux.epargne_bloquee)}`, { bold: true });
  addLine(`Dettes — restant dû total : ${fmt(summary.totaux.dettes_restant_du_total)}`, { bold: true });
  addLine(`Dettes — mensualités totales : ${fmt(summary.totaux.dettes_mensualites_totales)}`);

  addHeading("Comptes");
  summary.comptes.forEach((c) => {
    addLine(`${c.nom}${c.etablissement ? " — " + c.etablissement : ""} (${c.type}) : ${fmt(c.solde)}`, { bold: true });
    if (c.liquidite) addLine(`Liquidité : ${c.liquidite}`, { indent: 14, size: 9.5 });
    if (c.taux_moyen_epargne_pct != null) addLine(`Taux moyen : ${c.taux_moyen_epargne_pct}%`, { indent: 14, size: 9.5 });
    if (c.versement_recurrent_epargne) {
      addLine(`Versement : ${fmt(c.versement_recurrent_epargne)} / ${c.frequence_versement === "hebdomadaire" ? "semaine" : "mois"}`, { indent: 14, size: 9.5 });
    }
    if (c.taux_credit_pct != null) addLine(`Taux ${c.taux_credit_pct}% — mensualité ${fmt(c.mensualite_credit)}`, { indent: 14, size: 9.5 });
    if (c.performance) {
      addLine(`${c.performance.label} : ${fmt(c.performance.gain)}${c.performance.pct != null ? ` (${c.performance.pct}%)` : ""}`, { indent: 14, size: 9.5 });
    }
    (c.positions_crypto || []).forEach((h) => addLine(`${h.symbol} : ${h.quantity}`, { indent: 14, size: 9.5 }));
  });

  if (summary.provisions.length) {
    addHeading("Provisions");
    summary.provisions.forEach((p) => {
      addLine(`${p.compte} — ${fmt(p.montant)}${p.raison ? " — " + p.raison : ""} (${p.source})`);
    });
  }

  if (summary.objectifs.length) {
    addHeading("Tirelires / Objectifs");
    summary.objectifs.forEach((g) => {
      addLine(
        `${g.nom}${g.important ? " ★ important" : ""} : ${fmt(g.progression)} / ${fmt(g.cible)}${g.date_cible ? ` (cible ${fmtDate(g.date_cible)})` : ""}`,
        { bold: true }
      );
      addLine(`Suivi via : ${g.base}`, { indent: 14, size: 9.5 });
      const deltaGoal = Math.round((g.progression - g.progression_il_y_a_30_jours) * 100) / 100;
      if (deltaGoal !== 0) addLine(`${deltaGoal > 0 ? "+" : ""}${fmt(deltaGoal)} sur 30 jours`, { indent: 14, size: 9.5 });
    });
  }

  if (summary.calendrier_extinction_dettes.length) {
    addHeading("Calendrier d'extinction des dettes");
    summary.calendrier_extinction_dettes.forEach((s) => {
      addLine(`${s.etape} — ${fmtDate(s.date)} — mensualité restante après : ${fmt(s.charge_mensuelle_apres)}`);
    });
  }

  addHeading("Dépenses des 90 derniers jours par catégorie");
  const cats = Object.entries(summary.depenses_90_derniers_jours_par_categorie).sort((a, b) => b[1] - a[1]);
  if (!cats.length) addLine("Aucune dépense catégorisée sur la période.");
  cats.forEach(([cat, amount]) => addLine(`${cat} : ${fmt(amount)}`));

  if (summary.mouvements_non_categorises > 0) {
    addHeading("À noter");
    addLine(`${summary.mouvements_non_categorises} mouvement(s) non catégorisé(s) — non reflété(s) dans la répartition ci-dessus.`);
  }

  addHeading("Comment utiliser ce document");
  addLine(
    "Envoie ce PDF à l'assistant IA de ton choix (Claude, ChatGPT...) et demande-lui d'analyser la situation et de proposer des conseils concrets et personnalisés."
  );

  return doc;
}

function ReportModal({ accounts, goals, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const s = buildFinancialSummary(accounts, goals);
      const doc = await generatePdfReport(s);
      setSummary(s);
      setPdfDoc(doc);
    } catch (err) {
      setError(
        "Impossible de générer le PDF" + (err?.message ? ` (${err.message})` : "") +
        ". Vérifie ta connexion internet — le générateur de PDF doit être chargé depuis un serveur externe."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function download() {
    if (!pdfDoc) return;
    pdfDoc.save(`rapport-financier-${todayISO()}.pdf`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto" style={{ background: "rgba(33,38,31,0.45)" }}>
      <div className="w-full max-w-md rounded-xl shadow-xl my-8" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #CFE5D2" }}>
          <div className="flex items-center gap-2">
            <Sparkles size={16} color="#C99A3D" />
            <h3 className="text-lg" style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#0F2A1C" }}>Rapport financier</h3>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="p-1 hover:opacity-60">
            <X size={18} color="#0F2A1C" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {loading && (
            <div className="text-sm text-center py-10" style={{ color: "#6B8072" }}>Préparation du rapport…</div>
          )}
          {error && !loading && (
            <div className="space-y-3">
              <p className="text-xs" style={{ color: "#C2410C" }}>{error}</p>
              <button onClick={run} className="w-full py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}>
                Réessayer
              </button>
            </div>
          )}
          {summary && !loading && (
            <>
              <div>
                <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "#4B5D52" }}>Aperçu</div>
                <div className="space-y-1.5 text-sm" style={{ color: "#0F2A1C" }}>
                  <div className="flex items-center justify-between">
                    <span style={{ color: "#6B8072" }}>Liquidités</span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtEUR(summary.totaux.liquidites)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span style={{ color: "#6B8072" }}>Épargne disponible</span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtEUR(summary.totaux.epargne_disponible_totale)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span style={{ color: "#6B8072" }}>Épargne bloquée</span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtEUR(summary.totaux.epargne_bloquee)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span style={{ color: "#6B8072" }}>Dettes (restant dû)</span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtEUR(summary.totaux.dettes_restant_du_total)}</span>
                  </div>
                </div>
              </div>

              <button
                onClick={download}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm text-white"
                style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}
              >
                <Download size={16} /> Télécharger le PDF
              </button>

              <p className="text-xs leading-relaxed" style={{ color: "#4B5D52" }}>
                Ce PDF réunit tes comptes, provisions, objectifs, dettes et dépenses par catégorie. Envoie-le à l'assistant IA de ton choix (Claude, ChatGPT...) et demande-lui une analyse ou des conseils — l'appli elle-même n'appelle aucune IA.
              </p>

              <button onClick={run} className="w-full py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}>
                Régénérer avec les données actuelles
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Root App ----------
export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("overview"); // 'overview' | accountId
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [entryModalAccount, setEntryModalAccount] = useState(null);
  const [showSmartImport, setShowSmartImport] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [securityLoaded, setSecurityLoaded] = useState(false);
  const [pin, setPin] = useState(null);
  const [locked, setLocked] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [pendingImportData, setPendingImportData] = useState(null);
  const [importDataError, setImportDataError] = useState("");
  const importDataFileRef = useRef(null);
  const [rigidCategories, setRigidCategoriesState] = useState(DEFAULT_RIGID_CATEGORIES);
  const [recurringOverrides, setRecurringOverridesState] = useState({});
  const [blockOrder, setBlockOrderState] = useState(DEFAULT_BLOCK_ORDER);
  const [goals, setGoalsState] = useState([]);
  const [showBlockControls, setShowBlockControls] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("security:pin", false);
        if (res?.value) {
          setPin(res.value);
          setLocked(true);
        }
      } catch (e) {
        // no PIN set
      } finally {
        setSecurityLoaded(true);
      }
    })();
  }, []);

  async function setSecurityPin(newPin) {
    try {
      await window.storage.set("security:pin", newPin, false);
      setPin(newPin);
    } catch (e) {
      // best-effort — if it fails, the app just stays unlocked
    }
  }

  async function removeSecurityPin() {
    try {
      await window.storage.delete("security:pin", false);
    } catch (e) {}
    setPin(null);
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res?.value) setAccounts(JSON.parse(res.value));
      } catch (e) {
        // no data yet
      } finally {
        setLoading(false);
      }
      try {
        const res = await window.storage.get(RIGID_CATEGORIES_KEY, false);
        if (res?.value) setRigidCategoriesState(JSON.parse(res.value));
      } catch (e) {
        // keep defaults
      }
      try {
        const res = await window.storage.get(RECURRING_OVERRIDES_KEY, false);
        if (res?.value) setRecurringOverridesState(JSON.parse(res.value));
      } catch (e) {
        // keep defaults
      }
      try {
        const res = await window.storage.get(BLOCK_ORDER_KEY, false);
        if (res?.value) {
          const stored = JSON.parse(res.value);
          // Merge with the current default set so a newly added block type
          // still shows up even if it wasn't in a previously saved order.
          const merged = [...stored.filter((id) => DEFAULT_BLOCK_ORDER.includes(id))];
          DEFAULT_BLOCK_ORDER.forEach((id) => { if (!merged.includes(id)) merged.push(id); });
          setBlockOrderState(merged);
        }
      } catch (e) {
        // keep defaults
      }
      try {
        const res = await window.storage.get(GOALS_KEY, false);
        if (res?.value) setGoalsState(JSON.parse(res.value));
      } catch (e) {
        // keep defaults
      }
    })();
  }, []);

  async function setRigidCategories(next) {
    setRigidCategoriesState(next);
    try {
      await window.storage.set(RIGID_CATEGORIES_KEY, JSON.stringify(next), false);
    } catch (e) {
      // best-effort
    }
  }

  async function setBlockOrder(next) {
    setBlockOrderState(next);
    try {
      await window.storage.set(BLOCK_ORDER_KEY, JSON.stringify(next), false);
    } catch (e) {
      // best-effort
    }
  }

  // Persisted by normalized label (see labelGroupingKey), not by
  // transaction — so a manual "récurrent"/"non récurrent" choice also
  // applies to that same bill's future imports, not just what's already
  // in the app.
  async function setRecurringOverride(labelKey, value) {
    const next = { ...recurringOverrides };
    if (value === null) delete next[labelKey];
    else next[labelKey] = value;
    setRecurringOverridesState(next);
    try {
      await window.storage.set(RECURRING_OVERRIDES_KEY, JSON.stringify(next), false);
    } catch (e) {
      // best-effort
    }
  }

  async function persist(next) {
    setAccounts(next);
    try {
      const res = await window.storage.set(STORAGE_KEY, JSON.stringify(next), false);
      if (!res) setSaveError("Échec de la sauvegarde. Réessaie.");
      else setSaveError("");
    } catch (e) {
      setSaveError("Échec de la sauvegarde. Réessaie.");
    }
  }

  // Full backup as a downloadable JSON file — independent of window.storage,
  // so data survives even if the app's internal persistence resets (e.g.
  // between artifact preview versions) or fails for any other reason.
  function exportData() {
    const payload = { exportedAt: new Date().toISOString(), accounts };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suivi-comptes-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleImportDataFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportDataError("");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const accountsData = Array.isArray(parsed) ? parsed : parsed.accounts;
      if (!Array.isArray(accountsData)) throw new Error("Format inattendu");
      setPendingImportData(accountsData);
    } catch (err) {
      setImportDataError("Fichier de sauvegarde illisible ou invalide.");
    }
    e.target.value = "";
  }

  function confirmImportData() {
    if (pendingImportData) {
      persist(pendingImportData);
      setPendingImportData(null);
    }
  }

  function saveAccount(account) {
    const exists = accounts.some((a) => a.id === account.id);
    const next = exists ? accounts.map((a) => (a.id === account.id ? account : a)) : [...accounts, account];
    persist(next);
    setShowAccountModal(false);
    setEditingAccount(null);
  }

  function createAccountFromImport(account) {
    persist([...accounts, account]);
  }

  function deleteAccount(id) {
    const target = accounts.find((a) => a.id === id);
    persist(accounts.filter((a) => a.id !== id));
    setShowAccountModal(false);
    setEditingAccount(null);
    setView("overview");
    window.storage.delete(`rib:${id}`, false).catch(() => {});
    (target?.imports || []).forEach((imp) => {
      window.storage.delete(`file:${imp.id}`, false).catch(() => {});
    });
  }

  function addEntry(accountId, entry) {
    const next = accounts.map((a) =>
      a.id === accountId
        ? { ...a, entries: [...(a.entries || []).filter((e) => e.date !== entry.date), entry] }
        : a
    );
    persist(next);
  }

  // Combines addEntry + a crypto holdings' lastPrice update into one
  // persist() pass — calling them as two separate persisting functions
  // back to back (each reading the same pre-update `accounts` closure)
  // meant the second call silently discarded the first's change: the
  // price stuck, but the new balance entry vanished.
  function logCryptoValuation(accountId, entry, priceMap) {
    const next = accounts.map((a) => {
      if (a.id !== accountId) return a;
      const updated = { ...a, entries: [...(a.entries || []).filter((e) => e.date !== entry.date), entry] };
      if (a.crypto?.holdings) {
        updated.crypto = {
          ...a.crypto,
          holdings: a.crypto.holdings.map((h) => (priceMap[h.symbol] > 0 ? { ...h, lastPrice: priceMap[h.symbol] } : h)),
        };
      }
      return updated;
    });
    persist(next);
  }

  // Merges a parsed statement (transactions + any explicit balance anchors +
  // covered date range) into an account: transactions are de-duplicated,
  // the balance chart is refreshed (anchored on the given current balance
  // when the statement itself has no explicit balance line), and the
  // covered date range is added to the account's coverage.
  // Pure merge step shared by single- and batch-file imports: folds one
  // parsed statement into an account, returning the updated account plus
  // the import-log entry that was appended.
  function applyImportToAccount(account, result, currentBalanceInput, filename, importId) {
    const mergedTransactions = mergeTransactions(account.transactions || [], result.transactions || []);

    let addedEntries = [];
    let mergedEntries = account.entries || [];
    const mergeFn = account.type === "credit" ? mergeCreditEntries : mergeEntriesByDate;
    if (result.balanceEntries && result.balanceEntries.length) {
      addedEntries = result.balanceEntries;
      mergedEntries = mergeFn(mergedEntries, result.balanceEntries);
    } else if (result.transactions && result.transactions.length && currentBalanceInput != null) {
      const computed = balancesFromTransactions(result.transactions, currentBalanceInput);
      addedEntries = computed;
      mergedEntries = mergeFn(mergedEntries, computed);
    }

    let range = result.dateRange;
    if (!range) {
      const dates = [
        ...(result.transactions || []).map((t) => t.date),
        ...(result.balanceEntries || []).map((e) => e.date),
      ];
      if (dates.length) range = { start: dates.reduce((m, d) => (d < m ? d : m)), end: dates.reduce((m, d) => (d > m ? d : m)) };
    }
    const mergedCoverage = range ? mergeDateRanges(account.coverage || [], [range]) : account.coverage || [];

    // A schedule reflecting the CURRENT state of the loan (e.g. freshly
    // generated after an early repayment) always starts close to today —
    // it lists upcoming payments from generation time forward. A
    // historical/backfilled schedule starts long before today. This is a
    // more reliable signal than comparing end dates: an early repayment
    // shortens the remaining term, so the new schedule can easily end
    // EARLIER than an old one while still being the one that should win.
    const startsRecently = !range || Math.abs(new Date(range.start) - new Date(todayISO())) <= 1000 * 60 * 60 * 24 * 90;

    const updatedCredit =
      account.type === "credit" && startsRecently && (result.rateGuess != null || result.monthlyGuess != null)
        ? {
            rate: result.rateGuess != null ? result.rateGuess : account.credit?.rate,
            monthlyPayment: result.monthlyGuess != null ? result.monthlyGuess : account.credit?.monthlyPayment,
          }
        : account.credit;

    const importLog = {
      id: importId || uid(),
      timestamp: new Date().toISOString(),
      filename: filename || null,
      transactionIds: (result.transactions || []).map((t) => txKey(t)),
      entryDates: addedEntries.map((e) => e.date),
      dateRange: range || null,
    };

    return {
      ...account,
      institution: account.institution || result.institutionGuess || account.institution,
      iban: account.iban || result.ibanGuess || account.iban,
      bic: account.bic || result.bicGuess || account.bic,
      contractNumber: account.contractNumber || result.contractGuess || account.contractNumber,
      credit: updatedCredit,
      transactions: mergedTransactions,
      entries: mergedEntries,
      coverage: mergedCoverage,
      imports: [...(account.imports || []), importLog],
    };
  }

  function importStatement(accountId, result, currentBalanceInput, filename, importId) {
    const next = accounts.map((a) => (a.id === accountId ? applyImportToAccount(a, result, currentBalanceInput, filename, importId) : a));
    persist(next);
  }

  // Imports several files into the same account in one atomic update —
  // needed because folding them in one at a time would each read a stale
  // copy of `accounts` (state updates don't land synchronously between
  // calls), silently dropping all but the last import.
  function importStatements(accountId, items) {
    const next = accounts.map((a) => {
      if (a.id !== accountId) return a;
      return items.reduce(
        (acc, { result, filename, currentBalanceInput, importId }) => applyImportToAccount(acc, result, currentBalanceInput, filename, importId),
        a
      );
    });
    persist(next);
  }

  // Reverses one logged import: removes the transactions it added (by id),
  // removes the balance entries it added at dates no other remaining import
  // also covers (so shared/reconfirmed data survives), and recomputes
  // coverage from what's left.
  function deleteImport(accountId, importId) {
    const next = accounts.map((a) => {
      if (a.id !== accountId) return a;
      const imports = a.imports || [];
      const target = imports.find((i) => i.id === importId);
      if (!target) return a;
      const remaining = imports.filter((i) => i.id !== importId);

      const removeTxIds = new Set(target.transactionIds || []);
      const transactions = (a.transactions || []).filter((t) => !removeTxIds.has(txKey(t)));

      const otherDates = new Set(remaining.flatMap((i) => i.entryDates || []));
      const removeDates = new Set((target.entryDates || []).filter((d) => !otherDates.has(d)));
      const entries = (a.entries || []).filter((e) => !removeDates.has(e.date));

      const coverage = remaining.reduce((acc, i) => (i.dateRange ? mergeDateRanges(acc, [i.dateRange]) : acc), []);

      return { ...a, transactions, entries, coverage, imports: remaining };
    });
    persist(next);
    window.storage.delete(`file:${importId}`, false).catch(() => {});
  }

  // Finds a transaction by its stable key within a specific account —
  // used to look up its label before propagating a category/rigid change.
  function findTransaction(accountId, txKeyValue) {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return null;
    return (account.transactions || []).find((t) => txKey(t) === txKeyValue) || null;
  }

  function categorizeTransaction(accountId, txKeyValue, category) {
    const target = findTransaction(accountId, txKeyValue);
    const key = labelGroupingKey(target?.label);
    const next = accounts.map((a) => ({
      ...a,
      transactions: (a.transactions || []).map((t) => {
        const isTarget = a.id === accountId && txKey(t) === txKeyValue;
        // Same recurring expense in another month (or another account) —
        // matched by normalized label, e.g. "Loyer" categorized in août
        // also updates juillet, juin, mai... A generic placeholder label
        // (see GENERIC_LABELS) or an empty one never matches, to avoid
        // lumping unrelated movements together.
        const isSameRecurring = !isTarget && key && labelGroupingKey(t.label) === key;
        if (isTarget || isSameRecurring) return { ...t, category: category || null };
        return t;
      }),
    }));
    persist(next);
  }

  // Cycles a transaction's rigid/discretionary flag: unset (suit la
  // catégorie) → contraint → discrétionnaire → unset. This overrides the
  // category-based default for that one movement — and, like
  // categorizeTransaction above, propagates to every other transaction
  // with the same normalized label (all months, all accounts).
  function setTransactionRigid(accountId, txKeyValue, rigid) {
    const target = findTransaction(accountId, txKeyValue);
    const key = labelGroupingKey(target?.label);
    const next = accounts.map((a) => ({
      ...a,
      transactions: (a.transactions || []).map((t) => {
        const isTarget = a.id === accountId && txKey(t) === txKeyValue;
        const isSameRecurring = !isTarget && key && labelGroupingKey(t.label) === key;
        if (isTarget || isSameRecurring) return { ...t, rigid };
        return t;
      }),
    }));
    persist(next);
  }

  // Toggles a transaction's "provision" flag — money that's still in the
  // account (still counts in the balance, still liquid) but earmarked for
  // something specific and not meant to be spent (e.g. a tax refund
  // that's actually owed elsewhere). Deliberately doesn't propagate to
  // other same-label transactions like categorizeTransaction/
  // setTransactionRigid do — a provision is a one-off decision about this
  // specific movement, not a recurring pattern.
  function setTransactionProvision(accountId, txKeyValue, provision, reason) {
    const next = accounts.map((a) => {
      if (a.id !== accountId) return a;
      return {
        ...a,
        transactions: (a.transactions || []).map((t) =>
          txKey(t) === txKeyValue ? { ...t, provision, provisionReason: provision ? reason : undefined } : t
        ),
      };
    });
    persist(next);
  }

  function addManualProvision(accountId, provision) {
    const next = accounts.map((a) =>
      a.id === accountId
        ? { ...a, provisions: [...(a.provisions || []), { id: uid(), ...provision }] }
        : a
    );
    persist(next);
  }

  function removeManualProvision(accountId, provisionId) {
    const next = accounts.map((a) =>
      a.id === accountId
        ? { ...a, provisions: (a.provisions || []).filter((p) => p.id !== provisionId) }
        : a
    );
    persist(next);
  }

  async function addGoal(goal) {
    const next = [...goals, { id: uid(), important: false, ...goal }];
    setGoalsState(next);
    try {
      await window.storage.set(GOALS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // best-effort
    }
  }

  async function removeGoal(goalId) {
    const next = goals.filter((g) => g.id !== goalId);
    setGoalsState(next);
    try {
      await window.storage.set(GOALS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // best-effort
    }
  }

  async function toggleGoalImportant(goalId) {
    const next = goals.map((g) => (g.id === goalId ? { ...g, important: !g.important } : g));
    setGoalsState(next);
    try {
      await window.storage.set(GOALS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // best-effort
    }
  }

  // Records a crypto buy/sell: adjusts the position's quantity (a sell
  // never drops below 0) and logs the trade as a real movement on the
  // account, same as any other transaction — money out for an achat,
  // money in for a vente.
  function recordCryptoTrade(accountId, trade) {
    const next = accounts.map((a) => {
      if (a.id !== accountId) return a;
      const holdings = [...(a.crypto?.holdings || [])];
      const idx = holdings.findIndex((h) => h.symbol === trade.symbol);
      const delta = trade.type === "achat" ? trade.quantity : -trade.quantity;
      if (idx >= 0) {
        const nextQty = Math.max(0, Math.round((holdings[idx].quantity + delta) * 1e8) / 1e8);
        holdings[idx] = { ...holdings[idx], quantity: nextQty };
      } else if (trade.type === "achat") {
        holdings.push({ symbol: trade.symbol, quantity: trade.quantity });
      }
      const amount = trade.type === "achat" ? -(trade.quantity * trade.price) : trade.quantity * trade.price;
      const transaction = {
        id: `crypto-trade-${trade.date}-${trade.symbol}-${trade.type}-${uid()}`,
        date: trade.date,
        label: `${trade.type === "achat" ? "Achat" : "Vente"} ${trade.quantity} ${trade.symbol}`,
        amount: Math.round(amount * 100) / 100,
        category: null,
      };
      return {
        ...a,
        crypto: { ...a.crypto, holdings },
        transactions: [...(a.transactions || []), transaction],
      };
    });
    persist(next);
  }

  const activeAccount = view !== "overview" ? accounts.find((a) => a.id === view) : null;

  if (!securityLoaded) {
    return <div className="min-h-screen w-full flex items-center justify-center" style={{ background: "#E9F3EA" }} />;
  }
  if (locked && pin) {
    return <LockScreen expectedPin={pin} onUnlock={() => setLocked(false)} />;
  }

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: "#E9F3EA", fontFamily: "'Inter', sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible { outline: 2px solid #15803D; outline-offset: 2px; }
        button { transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease; }
        button:active { transform: scale(0.96); }
        .rounded-xl, .rounded-lg { transition: box-shadow 0.15s ease, transform 0.15s ease; }
        @keyframes pulseBadge { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      `}</style>

      <div className="max-w-2xl mx-auto px-5 py-10 sm:px-8">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}
              aria-hidden="true"
            >
              <PiggyBank size={18} color="#C6F135" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.2em]" style={{ color: "#6B8072" }}>Tableau de bord</div>
              <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: "1.4rem", color: "#0F2A1C" }}>Suivi des comptes</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportData}
              className="p-2 rounded-xl"
              style={{ border: "1px solid #CFE5D2" }}
              aria-label="Exporter les données"
              title="Exporter les données (sauvegarde JSON)"
            >
              <Download size={16} color="#0F2A1C" />
            </button>
            <input ref={importDataFileRef} type="file" accept=".json" onChange={handleImportDataFile} className="hidden" />
            <button
              onClick={() => importDataFileRef.current.click()}
              className="p-2 rounded-xl"
              style={{ border: "1px solid #CFE5D2" }}
              aria-label="Importer une sauvegarde"
              title="Importer une sauvegarde JSON"
            >
              <Upload size={16} color="#0F2A1C" />
            </button>
            {view === "overview" && (
              <button
                onClick={() => setShowBlockControls((v) => !v)}
                className="p-2 rounded-xl"
                style={{
                  border: "1px solid #CFE5D2",
                  background: showBlockControls ? "#0F2A1C" : "transparent",
                }}
                aria-label="Réorganiser les sections"
                title="Réorganiser les sections de la vue d'ensemble"
              >
                <Settings size={16} color={showBlockControls ? "#C6F135" : "#0F2A1C"} />
              </button>
            )}
            <button
              onClick={() => setShowSecurity(true)}
              className="p-2 rounded-xl"
              style={{ border: "1px solid #CFE5D2" }}
              aria-label="Sécurité"
              title="Sécurité"
            >
              <Lock size={16} color="#0F2A1C" />
            </button>
          </div>
        </header>
        {saveError && (
          <div className="text-xs px-3 py-2 mb-4 rounded-xl" style={{ color: "#C2410C", border: "1px solid #C2410C44" }}>
            {saveError}
          </div>
        )}
        {importDataError && (
          <p className="text-xs mb-4" style={{ color: "#C2410C" }}>{importDataError}</p>
        )}

        {loading ? (
          <div className="text-sm py-16 text-center" style={{ color: "#6B8072" }}>Chargement…</div>
        ) : accounts.length === 0 && view === "overview" ? (
          <div className="text-center py-16">
            <p className="text-sm mb-4" style={{ color: "#4B5D52" }}>
              Aucun compte pour l'instant. Ajoute ton premier compte courant, livret ou crédit.
            </p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setShowAccountModal(true)}
                className="inline-flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl text-white"
                style={{ background: "linear-gradient(155deg, #0F2A1C 0%, #163A26 65%, #1B4B31 100%)" }}
              >
                <Plus size={16} /> Ajouter un compte
              </button>
              <button
                onClick={() => setShowSmartImport(true)}
                className="inline-flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl"
                style={{ border: "1px solid #CFE0D3", color: "#0F2A1C" }}
              >
                <FileSpreadsheet size={16} /> Importer un fichier
              </button>
            </div>
          </div>
        ) : view === "overview" ? (
          <Overview
            accounts={accounts}
            onOpenAccount={(id) => setView(id)}
            onAddAccount={() => setShowAccountModal(true)}
            onOpenUncategorized={() => setView("uncategorized")}
            onSmartImport={() => setShowSmartImport(true)}
            onOpenReport={() => setShowReport(true)}
            rigidCategories={rigidCategories}
            onSaveRigidCategories={setRigidCategories}
            blockOrder={blockOrder}
            onSaveBlockOrder={setBlockOrder}
            showBlockControls={showBlockControls}
            goals={goals}
            onAddGoal={addGoal}
            onRemoveGoal={removeGoal}
            onToggleGoalImportant={toggleGoalImportant}
            onAddManualProvision={addManualProvision}
            onRemoveManualProvision={removeManualProvision}
            onSetProvision={setTransactionProvision}
          />
        ) : view === "uncategorized" ? (
          <UncategorizedView
            accounts={accounts}
            onBack={() => setView("overview")}
            onCategorize={categorizeTransaction}
          />
        ) : activeAccount ? (
          <AccountDetail
            account={activeAccount}
            onBack={() => setView("overview")}
            onEdit={(a) => { setEditingAccount(a); setShowAccountModal(true); }}
            onAddEntry={(a) => setEntryModalAccount(a)}
            onLogBalance={addEntry}
            onLogCryptoValuation={logCryptoValuation}
            onSetRigid={setTransactionRigid}
            onSetProvision={setTransactionProvision}
            onRecordTrade={recordCryptoTrade}
            onCategorize={categorizeTransaction}
            onDeleteImport={deleteImport}
            recurringOverrides={recurringOverrides}
            onSetRecurringOverride={setRecurringOverride}
          />
        ) : (
          <div className="text-sm py-16 text-center" style={{ color: "#6B8072" }}>Compte introuvable.</div>
        )}
      </div>

      {showAccountModal && (
        <AccountModal
          initial={editingAccount}
          onClose={() => { setShowAccountModal(false); setEditingAccount(null); }}
          onSave={saveAccount}
          onDelete={deleteAccount}
        />
      )}
      {entryModalAccount && (
        <EntryModal
          account={entryModalAccount}
          onClose={() => setEntryModalAccount(null)}
          onAddEntry={addEntry}
          onImportStatement={importStatement}
          onImportStatements={importStatements}
        />
      )}
      {showSmartImport && (
        <SmartImportModal
          accounts={accounts}
          onClose={() => setShowSmartImport(false)}
          onImportToAccount={importStatement}
          onCreateAccountFromImport={createAccountFromImport}
        />
      )}
      {showSecurity && (
        <SecuritySettingsModal
          hasPin={!!pin}
          onSetPin={setSecurityPin}
          onRemovePin={removeSecurityPin}
          onClose={() => setShowSecurity(false)}
        />
      )}
      {showReport && <ReportModal accounts={accounts} goals={goals} onClose={() => setShowReport(false)} />}
      {pendingImportData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(33,38,31,0.45)" }}>
          <div className="w-full max-w-xs rounded-xl shadow-xl p-6" style={{ background: "#FFFFFF", border: "1px solid #CFE5D2" }}>
            <h3 className="text-base mb-2" style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#0F2A1C" }}>Restaurer cette sauvegarde ?</h3>
            <p className="text-xs mb-4" style={{ color: "#4B5D52" }}>
              {pendingImportData.length} compte(s) dans ce fichier. Ça remplace entièrement les données actuelles de l'appli — impossible à annuler.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPendingImportData(null)} className="flex-1 py-2 rounded-xl text-sm" style={{ border: "1px solid #CFE0D3", color: "#4B5D52" }}>
                Annuler
              </button>
              <button onClick={confirmImportData} className="flex-1 py-2 rounded-xl text-sm text-white" style={{ background: "#C2410C" }}>
                Remplacer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
