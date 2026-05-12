/* ============================================================
   One Life Transportation · VA Trip Invoicing
   Vanilla JS app. No build step. GitHub Pages compatible.
   ============================================================ */

(function () {
  "use strict";

  /* ---------- Config ---------- */
  const CITIES = {
    sandiego: {
      key: "sandiego",
      name: "San Diego",
      reportTitle: "San Diego VA",
      accent: "#1d3557",
      facility: "VA San Diego Healthcare System",
      address: "3350 La Jolla Village Drive, San Diego, CA 92161",
      payers: ["7114", "7115", "7115C"],
      // SDVA: two invoice sheets toggleable
      coverModes: ["bariatric", "wheelchair"],
      defaultCover: "bariatric",
    },
    longbeach: {
      key: "longbeach",
      name: "Long Beach",
      reportTitle: "Long Beach VA",
      accent: "#1d3557",
      facility: "VA Long Beach Healthcare System",
      address: "5901 E 7th St, Long Beach, CA 90822",
      payers: ["7117", "7118"],
      // LBVA: single combined invoice sheet (rates same as SDVA bariatric)
      coverModes: ["bariatric"],
      defaultCover: "bariatric",
    },
  };

  const RATES = {
    // Stretcher / Bariatric (gurney)
    gurneyCompleted: 195,
    bariCompleted: 390,
    gurneyNoShow: 175,
    bariNoShow: 175,
    waitStretcher: 30, // per 15-min billable unit after 15-min grace
    milesGurney: 5, // per mile after 30-mile grace
    milesBari: 10,
    stairChair: 100,
    afterHoursStretcher: 75,
    // Wheelchair / Ambulatory
    wcCompleted: 80,
    ambCompleted: 75,
    wcCompanionCompleted: 150,
    ambCompanionCompleted: 150,
    wcNoShow: 73,
    ambNoShow: 73,
    wcCompanionNoShow: 110,
    ambCompanionNoShow: 110,
    waitWcAmb: 15,
    milesWcAmb: 3.5,
    afterHoursWcAmb: 26,
  };

  // Bill-to (constant)
  const BILL_TO = {
    company: "One Life Transportation LLC",
    address: "2525 Ramona Dr, Vista, CA 92084",
    contract: "36C26226P0039",
    poNumber: "664C60088",
    terms: "1% 15 / Net 30",
  };

  const WAIT_GRACE_MIN = 15;
  const MILES_GRACE = 30;

  /* ---------- State ---------- */
  const state = {
    view: { kind: "index" }, // or { kind: "city", city: "sandiego" }
    tab: "data", // "data" | "cover" | "internal"
    coverType: "bariatric",
    allTrips: [],
    fileName: "",
    error: "",
    priceOverrides: Object.create(null), // orderId -> number
    // Per-(city|tab) filter scopes. Keys: "sandiego|data", "sandiego|internal",
    // "longbeach|data", "longbeach|internal". Each holds its own filter set.
    filtersByScope: {},
    // Edited field tracker — for each orderId, a map { field: originalValue }
    // so we can restore on Reset and show "edited" badges in the UI.
    tripEdits: Object.create(null),
    theme: localStorage.getItem("olt-theme") || "light",
    coverNames: loadCoverNames(),
  };

  const EMPTY_FILTERS = { from: "", to: "", statuses: [], modes: [], payers: [] };

  function filtersScopeKey() {
    const cityKey =
      state.view.kind === "city" ? state.view.city : "_index";
    return `${cityKey}|${state.tab}`;
  }
  function getFilters() {
    return state.filtersByScope[filtersScopeKey()] || EMPTY_FILTERS;
  }
  function patchFilters(patch) {
    const k = filtersScopeKey();
    const cur = state.filtersByScope[k] || EMPTY_FILTERS;
    setState({
      filtersByScope: {
        ...state.filtersByScope,
        [k]: { ...cur, ...patch },
      },
    });
  }
  function resetFilters() {
    const k = filtersScopeKey();
    const next = { ...state.filtersByScope };
    delete next[k];
    setState({ filtersByScope: next });
  }

  function loadCoverNames() {
    try {
      return JSON.parse(localStorage.getItem("olt-cover-names")) || {};
    } catch (e) {
      return {};
    }
  }
  function saveCoverNames(map) {
    localStorage.setItem("olt-cover-names", JSON.stringify(map));
  }
  function coverLabel(cityKey, coverType) {
    const def = coverType === "wheelchair"
      ? "Wheelchair / Ambulatory"
      : "Stretcher / Bariatric";
    return (state.coverNames[cityKey] && state.coverNames[cityKey][coverType]) || def;
  }
  function setCoverLabel(cityKey, coverType, value) {
    const next = { ...state.coverNames };
    next[cityKey] = { ...(next[cityKey] || {}) };
    if (value && value.trim()) next[cityKey][coverType] = value.trim();
    else delete next[cityKey][coverType];
    saveCoverNames(next);
    setState({ coverNames: next });
  }

  /* ---------- Mobility (composite of mode + bariatric + multiLoaded) ---------- */
  const MOBILITY_OPTIONS = [
    "Gurney",
    "Bariatric",
    "Wheelchair",
    "Wheelchair Companion",
    "Ambulatory",
    "Ambulatory Companion",
  ];
  function getMobility(t) {
    if (t.mode === "Stretcher") return t.bariatric ? "Bariatric" : "Gurney";
    if (t.mode === "Wheelchair")
      return t.multiLoaded ? "Wheelchair Companion" : "Wheelchair";
    if (t.mode === "Ambulatory")
      return t.multiLoaded ? "Ambulatory Companion" : "Ambulatory";
    return t.mode || "";
  }
  function setMobility(t, value) {
    let patch;
    switch (value) {
      case "Gurney":
        patch = { mode: "Stretcher", bariatric: false, multiLoaded: false }; break;
      case "Bariatric":
        patch = { mode: "Stretcher", bariatric: true, multiLoaded: false }; break;
      case "Wheelchair":
        patch = { mode: "Wheelchair", bariatric: false, multiLoaded: false }; break;
      case "Wheelchair Companion":
        patch = { mode: "Wheelchair", bariatric: false, multiLoaded: true }; break;
      case "Ambulatory":
        patch = { mode: "Ambulatory", bariatric: false, multiLoaded: false }; break;
      case "Ambulatory Companion":
        patch = { mode: "Ambulatory", bariatric: false, multiLoaded: true }; break;
    }
    if (patch) setFieldsBatch(t, patch);
  }

  function setFieldsBatch(t, patch) {
    const oid = t.orderId;
    if (!state.tripEdits[oid]) state.tripEdits[oid] = Object.create(null);
    let any = false;
    for (const key in patch) {
      if (t[key] === patch[key]) continue;
      if (!(key in state.tripEdits[oid])) {
        state.tripEdits[oid][key] = t[key];
      }
      t[key] = patch[key];
      any = true;
    }
    if (any) render();
  }

  const STATUS_OPTIONS = ["Completed", "No show", "Canceled", "Will Call"];

  // Internal-report print size. Letter landscape (11 × 8.5 in) — matches the
  // density of the 20-column layout so there's no big blank space.
  // Using explicit dimensions (not the "landscape" keyword) because some
  // Chromium browsers (incl. Brave) ignore the orientation modifier.
  const IR_PRINT_PAGE = "11in 8.5in";
  const IR_PRINT_MARGIN = "0.3in";
  // Cover sheet: letter portrait.
  const COVER_PRINT_PAGE = "8.5in 11in";
  const COVER_PRINT_MARGIN = "0.4in";

  // Per-column relative widths for the Internal Report (19 cols, sum = 100).
  // Calibrated so wide columns (NAME, DRIVER, STATUS) get more room.
  const IR_COL_WIDTHS = [
    3,   // 0: Account
    4,   // 1: Trip No
    5,   // 2: DATE
    4,   // 3: P/U TIME
    10,  // 4: NAME
    4,   // 5: ON-SITE
    4,   // 6: LOAD TIME
    4,   // 7: Arrvd Dst
    4,   // 8: COMPLETE
    7,   // 9: STATUS
    4,   // 10: Wait Time Minutes
    4,   // 11: Billable Time
    4,   // 12: Billable Units
    5,   // 13: MILEAGE
    5,   // 14: Billable Miles
    5,   // 15: VEH #
    10,  // 16: DRIVER
    7,   // 17: RG PRICE
    7,   // 18: TOTAL PRICE
  ];
  // Screen-only Data tab adds a 20th "Mobility" column at the end (~7%).
  const IR_SCREEN_WIDTHS_PCT = IR_COL_WIDTHS.concat([7]);

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  /* ---------- Helpers ---------- */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "style" && typeof v === "object")
          Object.assign(e.style, v);
        else if (k === "html") e.innerHTML = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on") && typeof v === "function")
          e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "data" && typeof v === "object") {
          for (const dk in v) e.dataset[dk] = v[dk];
        } else if (v === true) e.setAttribute(k, "");
        else e.setAttribute(k, v);
      }
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null || c === false) continue;
        if (typeof c === "string" || typeof c === "number")
          e.appendChild(document.createTextNode(String(c)));
        else e.appendChild(c);
      }
    }
    return e;
  }

  function fmtMoney(n) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number(n) || 0);
  }
  // Currency display that shows "$ -" for zero (matches the reference PDF).
  function fmtMoneyDash(n) {
    const x = Number(n) || 0;
    return x === 0 ? "$ -" : fmtMoney(x);
  }
  // Plain number (no $ symbol) — used for the RG PRICE column.
  function formatNum(n) {
    const x = Number(n) || 0;
    // Trim trailing zeros but keep at most 2 decimals.
    const s = x.toFixed(2);
    return s.replace(/\.?0+$/, "");
  }

  function parseDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return v;
    if (typeof v === "number") {
      // Excel serial date -> JS Date
      return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    }
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }

  function fmtDate(v) {
    const d = parseDate(v);
    return d ? d.toLocaleDateString("en-US") : "";
  }

  function fmtTime(v) {
    const d = parseDate(v);
    return d
      ? d.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "";
  }

  function fmtWait(min) {
    const m = Math.max(0, Math.round(min || 0));
    const h = Math.floor(m / 60);
    const r = m % 60;
    return `${String(h).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  // Billable wait units (each unit = 15 min). Matches the reference Excel:
  //   units = floor(wait / 15) when wait > 15-min grace, else 0.
  //   billable_time = (units + 1) * 15 = next 15-min increment above wait.
  // Edge case: at exact 15-min boundaries (wait = 30, 45, 60 …) the reference
  // still rolls up to the NEXT increment, so wait=60 → 4 units / 75 min.
  function billableUnits(waitMin) {
    const w = waitMin || 0;
    return w > WAIT_GRACE_MIN ? Math.floor(w / 15) : 0;
  }
  function billableTimeDisplay(waitMin) {
    const w = waitMin || 0;
    return w > WAIT_GRACE_MIN ? (Math.floor(w / 15) + 1) * 15 : 0;
  }
  function billableMiles(miles) {
    return Math.max(0, (miles || 0) - MILES_GRACE);
  }

  function isCompleted(t) {
    return t.status === "Completed";
  }
  function isNoShow(t) {
    return t.status === "No show";
  }

  /* ---------- XLSX parser ---------- */
  function parseWorkbook(workbook) {
    const sheetName =
      workbook.SheetNames.find((n) => n.toLowerCase() === "report") ||
      workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      dateNF: "yyyy-mm-dd",
    });
    return parseTrips(aoa);
  }

  function parseTrips(aoa) {
    if (!aoa || aoa.length === 0) return [];
    // Find header row (first row containing "Order ID")
    let headerIdx = 0;
    for (let i = 0; i < Math.min(5, aoa.length); i++) {
      if (
        aoa[i] &&
        aoa[i].some((c) => String(c || "").includes("Order ID"))
      ) {
        headerIdx = i;
        break;
      }
    }
    const header = aoa[headerIdx].map((c) => String(c || "").trim());
    const col = (name) => header.findIndex((h) => h === name);
    const idx = {
      employeeId: col("Employee id"),
      payerId: col("Payer ID"),
      orderId: col("Order ID"),
      date: col("Date Of Service"),
      lastName: col("Passenger's Last Name"),
      firstName: col("Passenger's First Name"),
      pickup: col("Pick Up Address"),
      dropoff: col("Order Drop Off Address"),
      status: col("Order Status"),
      miles: col("Mapped mileage"),
      vehicle: col("Vehicle ID"),
      pickupTime: col("Pick Up Time"),
      apptTime: col("Appointment Time"),
      pickupRadius: col("Vehicle In Pick Up radius Time"),
      loadTime: col("Load Time"),
      dropoffRadius: col("Vehicle In Drop Off radius Time"),
      completedTime: col("Completed Time"),
      cancelTime: col("Cancel/No Show Time"),
      waitTime: col("Wait Time"),
      driverLast: col("Driver's Last Name"),
      driverFirst: col("Driver's First Name"),
      mode: col("Order Mode"),
      equipment: col("Item: Equipment"),
      afterHours: col("Item: After Hours"),
      stairChair: col("Item: Stair Chair Service"),
      finalPrice: col("Final Price"),
      payerTripId: col("Extra: Payer Trip ID"),
      multiLoaded: col("Multi Loaded (Y/N)"),
    };
    const yes = (v) => String(v || "").trim().toUpperCase() === "Y";
    const trips = [];
    for (let r = headerIdx + 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (!row || !row[idx.orderId]) continue;
      const orderId = String(row[idx.orderId]).trim();
      if (!orderId) continue;
      trips.push({
        employeeId: row[idx.employeeId] || "",
        payerId: String(row[idx.payerId] || "").trim(),
        orderId,
        date: row[idx.date] || "",
        passenger: `${String(row[idx.firstName] || "").trim()} ${String(
          row[idx.lastName] || ""
        ).trim()}`.trim(),
        pickup: row[idx.pickup] || "",
        dropoff: row[idx.dropoff] || "",
        status: String(row[idx.status] || "").trim(),
        miles: Number(row[idx.miles] || 0),
        vehicle: row[idx.vehicle] || "",
        pickupTime: row[idx.pickupTime] || "",
        apptTime: row[idx.apptTime] || "",
        pickupRadius: row[idx.pickupRadius] || "",
        loadTime: row[idx.loadTime] || "",
        dropoffRadius: row[idx.dropoffRadius] || "",
        completedTime: row[idx.completedTime] || "",
        cancelTime: row[idx.cancelTime] || "",
        wait: Number(row[idx.waitTime] || 0),
        driver: `${String(row[idx.driverFirst] || "").trim()} ${String(
          row[idx.driverLast] || ""
        ).trim()}`.trim(),
        mode: String(row[idx.mode] || "").trim(),
        bariatric: yes(row[idx.equipment]),
        afterHours: yes(row[idx.afterHours]),
        stairChair: yes(row[idx.stairChair]),
        multiLoaded: idx.multiLoaded >= 0 ? yes(row[idx.multiLoaded]) : false,
        finalPrice: Number(row[idx.finalPrice] || 0),
        payerTripId: row[idx.payerTripId] || "",
      });
    }
    return trips;
  }

  /* ---------- Pricing ---------- */
  // A "companion" trip (multi-loaded) bills at the companion rate INSTEAD OF the
  // regular rate. So multiLoaded WC Completed = $150 (not $80), etc.
  function autoPrice(t) {
    if (t.status === "Canceled") return 0;
    const stretcher = t.mode === "Stretcher";
    const wc = t.mode === "Wheelchair";
    const amb = t.mode === "Ambulatory";
    const companion = t.multiLoaded && (wc || amb);
    const completed = isCompleted(t);
    let base = 0;
    if (completed) {
      if (stretcher) base = t.bariatric ? RATES.bariCompleted : RATES.gurneyCompleted;
      else if (wc) base = companion ? RATES.wcCompanionCompleted : RATES.wcCompleted;
      else base = companion ? RATES.ambCompanionCompleted : RATES.ambCompleted;
    } else if (isNoShow(t)) {
      if (stretcher) base = t.bariatric ? RATES.bariNoShow : RATES.gurneyNoShow;
      else if (wc) base = companion ? RATES.wcCompanionNoShow : RATES.wcNoShow;
      else base = companion ? RATES.ambCompanionNoShow : RATES.ambNoShow;
    }
    const milesAdd =
      completed && stretcher
        ? billableMiles(t.miles) * (t.bariatric ? RATES.milesBari : RATES.milesGurney)
        : completed
        ? billableMiles(t.miles) * RATES.milesWcAmb
        : 0;
    const waitAdd =
      completed
        ? billableUnits(t.wait) *
          (stretcher ? RATES.waitStretcher : RATES.waitWcAmb)
        : 0;
    const stairAdd =
      completed && stretcher && t.stairChair ? RATES.stairChair : 0;
    const ahAdd =
      completed && t.afterHours
        ? stretcher
          ? RATES.afterHoursStretcher
          : RATES.afterHoursWcAmb
        : 0;
    return Math.round((base + milesAdd + waitAdd + stairAdd + ahAdd) * 100) / 100;
  }

  function effectivePrice(t) {
    const o = state.priceOverrides[t.orderId];
    if (typeof o === "number" && !isNaN(o)) return o;
    return autoPrice(t);
  }


  /* ---------- Cover sheet computation ----------
     Each line is one of two kinds:
       - "count": one row per trip-category (e.g. GURNEY COMPLETED). Each trip
                  in the group contributes `rate` to the total — OR its manual
                  override if the user set one.
       - "addon": aggregated extras (WAITING TIME, MILES, AFTER HOURS, STAIR).
                  These sum billable-units * rate but exclude trips that have a
                  manual override (the override absorbs the whole trip's price,
                  so we don't double-count its add-ons here).
     Invariant: sum(line totals) === sum(effectivePrice(trip)) for trips in
     scope, so the cover sheet's Total Due always equals what gets invoiced.
  */
  function isOverridden(t) {
    return typeof state.priceOverrides[t.orderId] === "number";
  }

  function coverLines(trips, coverType) {
    const stretcherTrips = trips.filter((t) => t.mode === "Stretcher");
    const wcAmbTrips = trips.filter(
      (t) => t.mode === "Wheelchair" || t.mode === "Ambulatory"
    );
    const gurney = stretcherTrips.filter((t) => !t.bariatric);
    const bari = stretcherTrips.filter((t) => t.bariatric);
    // Regular WC/AMB lines exclude companion (multi-loaded) trips, which bill
    // at the companion rate INSTEAD OF the regular rate. Companion lines contain
    // ONLY multi-loaded trips. This keeps the cover sheet total = Σ trip prices.
    const wcAll = wcAmbTrips.filter((t) => t.mode === "Wheelchair");
    const ambAll = wcAmbTrips.filter((t) => t.mode === "Ambulatory");
    const wc = wcAll.filter((t) => !t.multiLoaded);
    const amb = ambAll.filter((t) => !t.multiLoaded);
    const wcCo = wcAll.filter((t) => t.multiLoaded);
    const ambCo = ambAll.filter((t) => t.multiLoaded);

    const notOver = (t) => !isOverridden(t);
    const wait = (arr) =>
      arr
        .filter(notOver)
        .reduce(
          (s, t) => s + (isCompleted(t) ? billableUnits(t.wait) : 0),
          0
        );
    const miles = (arr) =>
      Math.round(
        arr
          .filter(notOver)
          .reduce(
            (s, t) => s + (isCompleted(t) ? billableMiles(t.miles) : 0),
            0
          ) * 100
      ) / 100;
    const ah = (arr) =>
      arr.filter(notOver).filter((t) => isCompleted(t) && t.afterHours).length;
    const stair = (arr) =>
      arr
        .filter(notOver)
        .filter((t) => isCompleted(t) && t.stairChair).length;

    const cnt = (label, group, rate) => ({
      kind: "count",
      label,
      rate,
      units: group.length,
      trips: group,
    });
    const add = (label, units, rate) => ({
      kind: "addon",
      label,
      rate,
      units,
      trips: [],
    });

    if (coverType === "wheelchair") {
      return [
        cnt("WHEELCHAIR COMPLETED", wc.filter(isCompleted), RATES.wcCompleted),
        cnt("AMBULATORY COMPLETED", amb.filter(isCompleted), RATES.ambCompleted),
        cnt(
          "WHEELCHAIR COMPANION COMPLETED",
          wcCo.filter(isCompleted),
          RATES.wcCompanionCompleted
        ),
        cnt(
          "AMBULATORY COMPANION COMPLETED",
          ambCo.filter(isCompleted),
          RATES.ambCompanionCompleted
        ),
        cnt("WHEELCHAIR NO SHOW", wc.filter(isNoShow), RATES.wcNoShow),
        cnt("AMBULATORY NO SHOW", amb.filter(isNoShow), RATES.ambNoShow),
        cnt(
          "WHEELCHAIR COMPANION NO SHOW",
          wcCo.filter(isNoShow),
          RATES.wcCompanionNoShow
        ),
        cnt(
          "AMBULATORY COMPANION NO SHOW",
          ambCo.filter(isNoShow),
          RATES.ambCompanionNoShow
        ),
        add("WAITING TIME", wait(wcAmbTrips), RATES.waitWcAmb),
        add("ADDITIONAL MILES", miles(wcAmbTrips), RATES.milesWcAmb),
        add("AFTER HOURS FEE", ah(wcAmbTrips), RATES.afterHoursWcAmb),
      ];
    }
    // bariatric / stretcher cover
    return [
      cnt("GURNEY COMPLETED", gurney.filter(isCompleted), RATES.gurneyCompleted),
      cnt("BARIATRIC COMPLETED", bari.filter(isCompleted), RATES.bariCompleted),
      cnt("GURNEY NO SHOW", gurney.filter(isNoShow), RATES.gurneyNoShow),
      cnt("BARIATRIC NO SHOW", bari.filter(isNoShow), RATES.bariNoShow),
      add("WAITING TIME", wait(stretcherTrips), RATES.waitStretcher),
      add("ADDITIONAL MILES GURNEY", miles(gurney), RATES.milesGurney),
      add("ADDITIONAL MILES BARIATRIC", miles(bari), RATES.milesBari),
      add("STAIR CHAIR FEE", stair(stretcherTrips), RATES.stairChair),
      add("AFTER HOURS FEE", ah(stretcherTrips), RATES.afterHoursStretcher),
    ];
  }

  function lineTotal(line) {
    if (line.kind === "count") {
      // count lines: each trip contributes rate (or its override)
      const sum = line.trips.reduce((s, t) => {
        const o = state.priceOverrides[t.orderId];
        if (typeof o === "number" && !isNaN(o)) return s + o;
        return s + line.rate;
      }, 0);
      return Math.round(sum * 100) / 100;
    }
    // addon lines: units already exclude overridden trips
    return Math.round(line.units * line.rate * 100) / 100;
  }

  function coverTotal(lines) {
    return (
      Math.round(lines.reduce((s, l) => s + lineTotal(l), 0) * 100) / 100
    );
  }

  /* ---------- Internal report row generation (19 cols, matches reference PDF) ---------- */
  const IR_COLS = [
    "Account",          // 0
    "Trip No",          // 1
    "DATE",             // 2
    "P/U TIME",         // 3
    "NAME",             // 4
    "ON-SITE",          // 5
    "LOAD TIME",        // 6
    "Arrvd Dst",        // 7
    "COMPLETE",         // 8
    "STATUS",           // 9
    "Wait Time Minutes",// 10
    "Billable Time",    // 11
    "Billable Units",   // 12
    "MILEAGE",          // 13
    "Billable Miles",   // 14
    "VEH #",            // 15
    "DRIVER",           // 16
    "RG PRICE",         // 17
    "TOTAL PRICE",      // 18
  ];

  // Build a row, hiding zero/empty cells the way the reference PDF does
  // (no "0:00" wait on no-shows, no "0.00" billable miles when under grace).
  function irRow(t) {
    const w = t.wait || 0;
    const miles = Number(t.miles || 0);
    const bMiles = billableMiles(miles);
    const bTime = billableTimeDisplay(w);
    const bUnits = billableUnits(w);
    return [
      t.payerId,                                          // 0 Account
      t.orderId,                                          // 1 Trip No
      fmtDate(t.date),                                    // 2 DATE
      fmtTime(t.pickupTime),                              // 3 P/U TIME
      t.passenger,                                        // 4 NAME
      fmtTime(t.pickupRadius),                            // 5 ON-SITE
      fmtTime(t.loadTime),                                // 6 LOAD TIME
      fmtTime(t.dropoffRadius),                           // 7 Arrvd Dst
      fmtTime(t.completedTime || t.cancelTime),           // 8 COMPLETE
      t.status,                                           // 9 STATUS
      w > 0 ? fmtWait(w) : "",                            // 10 Wait Time Minutes (HH:MM)
      bTime > 0 ? bTime : "",                             // 11 Billable Time
      bUnits > 0 ? bUnits : "",                           // 12 Billable Units
      miles > 0 ? miles.toFixed(2) : "",                  // 13 MILEAGE
      bMiles > 0 ? bMiles.toFixed(2) : "",                // 14 Billable Miles
      t.vehicle,                                          // 15 VEH #
      t.driver,                                           // 16 DRIVER
      Number(t.finalPrice || 0),                          // 17 RG PRICE (from xlsx Final Price)
      effectivePrice(t),                                  // 18 TOTAL PRICE (override or auto)
    ];
  }

  /* ---------- Filters ---------- */
  function applyFilters(trips, f) {
    return trips.filter((t) => {
      const d = parseDate(t.date);
      if (f.from && d) {
        const from = new Date(f.from);
        if (d < from) return false;
      }
      if (f.to && d) {
        const to = new Date(f.to);
        to.setHours(23, 59, 59, 999);
        if (d > to) return false;
      }
      if (f.statuses.length > 0 && !f.statuses.includes(t.status)) return false;
      if (f.modes.length > 0) {
        let ok = false;
        for (const m of f.modes) {
          if (m === "Stretcher" && t.mode === "Stretcher") {
            ok = true;
            break;
          }
          if (
            m === "WC_AMB" &&
            (t.mode === "Wheelchair" || t.mode === "Ambulatory")
          ) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }
      if (f.payers.length > 0 && !f.payers.includes(t.payerId)) return false;
      return true;
    });
  }

  function dateRangeFromTrips(trips) {
    const dates = trips.map((t) => parseDate(t.date)).filter(Boolean);
    if (dates.length === 0) return { from: "—", to: "—" };
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    return {
      from: min.toLocaleDateString("en-US"),
      to: max.toLocaleDateString("en-US"),
    };
  }

  /* ---------- Theme ---------- */
  function applyTheme() {
    if (state.theme === "dark")
      document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("olt-theme", state.theme);
    applyTheme();
  }

  /* ---------- Print orientation swap ---------- */
  function setPrintOrientation(tab) {
    let s = document.getElementById("printOrientation");
    if (!s) {
      s = document.createElement("style");
      s.id = "printOrientation";
      document.head.appendChild(s);
    }
    s.textContent =
      tab === "internal"
        ? `@page { size: ${IR_PRINT_PAGE}; margin: ${IR_PRINT_MARGIN}; }`
        : `@page { size: ${COVER_PRINT_PAGE}; margin: ${COVER_PRINT_MARGIN}; }`;
  }

  /* ---------- File upload ---------- */
  async function loadFile(file) {
    if (!file) return;
    setState({ error: "" });
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const trips = parseWorkbook(wb);
      if (trips.length === 0) {
        setState({ error: "No trip rows found in this file." });
        return;
      }
      setState({
        allTrips: trips,
        fileName: file.name,
        priceOverrides: Object.create(null),
        filters: { from: "", to: "", statuses: [], modes: [], payers: [] },
      });
    } catch (err) {
      setState({ error: `Could not read file: ${err.message || err}` });
    }
  }

  function clearAll() {
    setState({
      allTrips: [],
      fileName: "",
      error: "",
      priceOverrides: Object.create(null),
      filters: { from: "", to: "", statuses: [], modes: [], payers: [] },
    });
  }

  /* ---------- Render: top bar ---------- */
  function renderTopbar() {
    const isCity = state.view.kind === "city";
    const city = isCity ? CITIES[state.view.city] : null;
    const trips = isCity
      ? state.allTrips.filter((t) => city.payers.includes(t.payerId))
      : state.allTrips;

    const left = [
      el(
        "a",
        {
          class: "brand",
          href: "#",
          onclick: (e) => {
            e.preventDefault();
            setState({ view: { kind: "index" } });
          },
        },
        [
          el("div", { class: "brand-mark" }, "OL"),
          el("div", null, [
            el("div", { class: "brand-text-1" }, "One Life Transportation"),
            el(
              "div",
              { class: "brand-text-2" },
              "VA Trip Invoicing"
            ),
          ]),
        ]
      ),
    ];

    if (isCity) {
      left.push(
        el("div", { class: "city-pill" }, [
          el("span", { class: "city-pill-name" }, city.name),
          el("span", { class: "city-pill-sub" }, city.facility),
        ])
      );
    }

    const right = [];
    if (state.allTrips.length > 0) {
      right.push(
        el("div", { class: "file-pill" }, [
          el("span", { class: "dot" }),
          el("span", { class: "filename", title: state.fileName }, state.fileName),
          el(
            "span",
            { class: "count" },
            `· ${isCity ? trips.length + "/" : ""}${state.allTrips.length} trips`
          ),
        ])
      );
      right.push(
        el(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            onclick: () => {
              if (confirm("Replace the loaded file? This clears all data and edits.")) {
                clearAll();
                openFilePicker();
              }
            },
          },
          [icon("upload"), " Replace"]
        )
      );
    }

    const inner = el("div", { class: "topbar-inner row" }, [
      ...left,
      el("div", { class: "grow" }),
      ...right,
    ]);
    return el(
      "header",
      { class: "topbar no-print" },
      el("div", { class: "container" }, inner)
    );
  }

  /* ---------- Render: index page ---------- */
  function renderIndex() {
    const hasFile = state.allTrips.length > 0;
    const main = el("main", { class: "container" }, [
      el("section", { class: "index-hero" }, [
        el("div", { class: "index-eyebrow" }, "VA Invoicing Console"),
        el(
          "h1",
          { class: "index-title" },
          hasFile ? "Choose a facility" : "Upload a Master Trip Export"
        ),
        el(
          "p",
          { class: "index-sub" },
          hasFile
            ? "Master trip export loaded. Pick a facility to generate invoice sheets or the internal report."
            : "Drop the Master Trip Export workbook to generate invoice sheets and the internal report for either facility."
        ),
      ]),
      hasFile
        ? renderFileBanner()
        : renderDropZone({ onPick: () => openFilePicker() }),
      state.error ? renderError() : null,
      hasFile ? renderCityGrid() : null,
    ]);

    return el("div", { class: "app fade-in" }, [renderTopbar(), main]);
  }

  function renderFileBanner() {
    const total = state.allTrips.length;
    const dr = dateRangeFromTrips(state.allTrips);
    return el("div", { class: "file-banner" }, [
      el("div", { class: "file-banner-info" }, [
        el("div", { class: "file-banner-icon" }, icon("file")),
        el("div", null, [
          el("div", { class: "file-banner-name" }, state.fileName),
          el(
            "div",
            { class: "file-banner-meta" },
            `${total} trips · ${dr.from} – ${dr.to}`
          ),
        ]),
      ]),
      el("div", { class: "row gap-2" }, [
        el(
          "button",
          {
            class: "btn btn-ghost",
            onclick: () => {
              if (confirm("Replace the loaded file? This clears all data and edits.")) {
                clearAll();
                openFilePicker();
              }
            },
          },
          [icon("upload"), " Replace File"]
        ),
        el(
          "button",
          {
            class: "btn btn-danger",
            onclick: () => {
              if (confirm("Clear loaded file and all price edits?")) clearAll();
            },
          },
          [icon("trash"), " Clear"]
        ),
      ]),
    ]);
  }

  function renderCityGrid() {
    return el(
      "section",
      { class: "city-grid" },
      Object.values(CITIES).map((c) => {
        const trips = state.allTrips.filter((t) => c.payers.includes(t.payerId));
        return el(
          "button",
          {
            class: "city-card",
            onclick: () => setState({ view: { kind: "city", city: c.key }, tab: "data", coverType: c.defaultCover }),
          },
          [
            el(
              "div",
              { class: "city-card-contract" },
              `Contract ${BILL_TO.contract}`
            ),
            el("h2", { class: "city-card-name" }, c.name),
            el("div", { class: "city-card-facility" }, c.facility),
            el("div", { class: "city-card-address" }, c.address),
            el("div", { class: "city-card-footer" }, [
              el(
                "span",
                { class: "city-card-payer" },
                `Payers: ${c.payers.join(" / ")}`
              ),
              el("span", { class: "city-card-cta" }, [
                trips.length > 0
                  ? `${trips.length} trips`
                  : "Open",
                icon("arrow-right", 14),
              ]),
            ]),
          ]
        );
      })
    );
  }

  function renderDropZone({ onPick }) {
    let dragCount = 0;
    const dz = el(
      "div",
      {
        class: "dropzone",
        role: "button",
        tabindex: "0",
        onclick: onPick,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPick();
          }
        },
        ondragenter: (e) => {
          e.preventDefault();
          dragCount++;
          dz.classList.add("dragover");
        },
        ondragover: (e) => e.preventDefault(),
        ondragleave: () => {
          dragCount--;
          if (dragCount <= 0) dz.classList.remove("dragover");
        },
        ondrop: (e) => {
          e.preventDefault();
          dz.classList.remove("dragover");
          dragCount = 0;
          const f = e.dataTransfer.files && e.dataTransfer.files[0];
          if (f) loadFile(f);
        },
      },
      [
        el("div", { class: "dropzone-icon" }, icon("upload", 28)),
        el("div", { class: "dropzone-title" }, "Drop Master Trip Export"),
        el(
          "div",
          { class: "dropzone-sub" },
          "or click to select · .xlsx · .xls"
        ),
      ]
    );
    return dz;
  }

  function renderError() {
    return el("div", { class: "alert alert-danger" }, [
      icon("alert", 16),
      el("span", null, state.error),
    ]);
  }

  /* ---------- Render: city view ---------- */
  function renderCity() {
    const city = CITIES[state.view.city];
    const trips = state.allTrips.filter((t) => city.payers.includes(t.payerId));

    const tabs = el("nav", { class: "tabs no-print" }, [
      tabBtn("data", "Data"),
      tabBtn("cover", "Invoice Sheet"),
      tabBtn("internal", "Internal Report"),
    ]);

    const main = el("main", { class: "container" }, [
      el("div", { style: { padding: "1.25rem 0" } }, [
        trips.length === 0
          ? renderEmpty(city)
          : state.tab === "data"
          ? renderDataTab(trips, city)
          : state.tab === "cover"
          ? renderCoverTab(trips, city)
          : renderInternalTab(trips, city),
      ]),
    ]);

    return el("div", { class: "app fade-in" }, [
      renderTopbar(),
      tabs,
      main,
    ]);
  }

  function tabBtn(key, label) {
    return el(
      "button",
      {
        class: state.tab === key ? "tab active" : "tab",
        onclick: () => setState({ tab: key }),
      },
      label
    );
  }

  function renderEmpty(city) {
    if (state.allTrips.length === 0) {
      // No file at all — show drop zone
      return el("div", null, [
        state.error ? renderError() : null,
        renderDropZone({ onPick: () => openFilePicker() }),
      ]);
    }
    return el("div", { class: "empty" }, [
      el(
        "div",
        { class: "empty-title" },
        `No trips matched ${city.name} (payers: ${city.payers.join(", ")})`
      ),
      el("p", null, "The loaded file does not contain rows for this facility."),
      el(
        "button",
        {
          class: "btn btn-ghost mt-4",
          onclick: () => setState({ view: { kind: "index" } }),
        },
        "Back to index"
      ),
    ]);
  }

  /* ---------- Data tab (editable source of truth) ---------- */
  function renderDataTab(trips, city) {
    const filtered = applyFilters(trips, state.filters);
    const overrideCount = Object.keys(state.priceOverrides).length;

    const overrideClearBtn = overrideCount > 0
      ? el(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            onclick: () => {
              if (confirm("Clear all manual price overrides?"))
                setState({ priceOverrides: Object.create(null) });
            },
            title: `${overrideCount} manual price override${
              overrideCount === 1 ? "" : "s"
            } active`,
          },
          [icon("trash", 13), ` Clear overrides (${overrideCount})`]
        )
      : null;

    const toolbar = renderFiltersBar(trips, city, {
      rightSection: overrideClearBtn,
    });

    const helper = el(
      "div",
      {
        class: "ink-soft",
        style: {
          fontSize: "0.82rem",
          margin: "0 0 0.75rem",
          lineHeight: 1.5,
        },
      },
      [
        "Click any cell to edit. Edits to ",
        el("strong", { style: { color: "var(--ink)" } }, "Status"),
        ", ",
        el("strong", { style: { color: "var(--ink)" } }, "Mobility"),
        ", ",
        el("strong", { style: { color: "var(--ink)" } }, "Wait"),
        ", or ",
        el("strong", { style: { color: "var(--ink)" } }, "Mileage"),
        " auto-recompute the price. Manual ",
        el("strong", { style: { color: "var(--ink)" } }, "Total Price"),
        " edits override the auto value (yellow dot). Filters narrow the view; the invoice sheet still totals all trips for the facility.",
      ]
    );

    return el("div", { class: "fade-in" }, [
      toolbar,
      helper,
      el("div", { class: "ir-wrap" }, renderEditableTable(filtered)),
    ]);
  }

  function renderEditableTable(trips) {
    const cg = el(
      "colgroup",
      null,
      IR_SCREEN_WIDTHS_PCT.map((w) =>
        el("col", { style: { width: `${w}%` } })
      )
    );
    const headerCells = IR_COLS.map((c) => el("th", null, c));
    headerCells.push(el("th", null, "Mobility"));
    const head = el("thead", null, el("tr", null, headerCells));
    const body = el(
      "tbody",
      null,
      trips.map((t) => renderTripRow(t))
    );
    // Footer TOTAL row for Data tab too
    const totalSum = trips.reduce((s, t) => s + effectivePrice(t), 0);
    const totalRow = el("tr", { class: "ir-total-row" }, [
      el(
        "td",
        { colspan: String(IR_COLS.length - 1) },
        el("strong", null, "TOTAL")
      ),
      el(
        "td",
        { class: "col-right" },
        el("strong", null, fmtMoneyDash(totalSum))
      ),
      el("td", { class: "no-print" }, ""),
    ]);
    const foot = el("tfoot", null, totalRow);
    return el("table", { class: "ir-table" }, [cg, head, body, foot]);
  }

  function statusPillClass(status) {
    if (status === "Completed") return "pill pill-success";
    if (status === "No show") return "pill pill-warning";
    if (status === "Canceled") return "pill pill-danger";
    return "pill pill-neutral";
  }

  /* ---------- Cover sheet tab ---------- */
  function renderCoverTab(trips, city) {
    const lines = coverLines(trips, state.coverType);
    const dr = dateRangeFromTrips(trips);
    const tot = coverTotal(lines);
    const currentLabel = coverLabel(city.key, state.coverType);

    const segments = el(
      "div",
      { class: "segment" },
      city.coverModes.map((m) =>
        el(
          "button",
          {
            class: state.coverType === m ? "segment-btn active" : "segment-btn",
            onclick: () => setState({ coverType: m }),
          },
          coverLabel(city.key, m)
        )
      )
    );

    const toolbar = el("div", { class: "toolbar no-print" }, [
      el("div", { class: "toolbar-section" }, [
        el("div", { class: "label" }, "Invoice Sheet"),
        city.coverModes.length > 1 ? segments : null,
      ]),
      el("div", { class: "grow" }),
      el(
        "button",
        {
          class: "btn btn-primary",
          onclick: () => window.print(),
        },
        [icon("printer"), " Print / Save PDF"]
      ),
    ]);

    const sheet = el("div", { class: "cover-sheet" }, [
      el("div", { class: "cover-header" }, [
        el("div", null, [
          el("div", { class: "cover-company" }, BILL_TO.company),
          el(
            "div",
            { class: "ink-soft", style: { fontSize: "0.85rem", marginTop: "0.2rem" } },
            BILL_TO.address
          ),
          el("div", { class: "cover-bill" }, [
            el("div", { class: "cover-bill-label" }, "Bill To"),
            el(
              "div",
              { style: { fontWeight: 600 } },
              "Department of Veterans Affairs"
            ),
            el("div", null, city.facility),
            el("div", { class: "ink-soft", style: { fontSize: "0.85rem" } }, city.address),
          ]),
        ]),
        el("div", { class: "cover-summary-block" }, [
          el(
            "div",
            { class: "label", style: { letterSpacing: "0.15em" } },
            "Summary"
          ),
          el(
            "div",
            { class: "cover-summary-title" },
            editCell({
              display: currentLabel,
              value: currentLabel,
              onSave: (v) =>
                setCoverLabel(city.key, state.coverType, v),
              className: "cover-title-edit no-print-edit",
              title: "Click to rename this invoice sheet",
            })
          ),
          el("div", { class: "cover-meta" }, [
            el("span", { class: "cover-meta-label" }, "Date Range:"),
            el("span", { class: "cover-meta-val mono" }, `${dr.from} – ${dr.to}`),
            el("span", { class: "cover-meta-label" }, "PO #:"),
            el("span", { class: "cover-meta-val mono" }, BILL_TO.poNumber),
            el("span", { class: "cover-meta-label" }, "Contract #:"),
            el("span", { class: "cover-meta-val mono" }, BILL_TO.contract),
            el("span", { class: "cover-meta-label" }, "Terms:"),
            el("span", { class: "cover-meta-val" }, BILL_TO.terms),
          ]),
        ]),
      ]),

      el("table", { class: "cover-table" }, [
        el(
          "thead",
          null,
          el("tr", null, [
            el("th", { style: { width: "55%" } }, "Type of Service"),
            el("th", { class: "num", style: { textAlign: "right" } }, "Units"),
            el("th", { class: "num", style: { textAlign: "right" } }, "Rate"),
            el("th", { class: "num", style: { textAlign: "right" } }, "Total"),
          ])
        ),
        el(
          "tbody",
          null,
          lines.map((l) => {
            const total = lineTotal(l);
            return el("tr", { class: l.units === 0 ? "zero" : "" }, [
              el("td", null, l.label),
              el("td", { class: "num" }, String(l.units)),
              el("td", { class: "num" }, fmtMoney(l.rate)),
              el("td", { class: "num" }, fmtMoney(total)),
            ]);
          })
        ),
        el(
          "tfoot",
          null,
          el("tr", { class: "cover-total-row" }, [
            el("td", { colspan: "3", class: "label", style: { textAlign: "right" } }, "Total Due"),
            el("td", { class: "amount num" }, fmtMoney(tot)),
          ])
        ),
      ]),

      el("div", { class: "cover-signature" }, [
        el("div", null, [
          el("div", { class: "cover-signature-line" }),
          el("div", { class: "cover-signature-label" }, "Authorizing VA Official"),
        ]),
        el("div", null, [
          el("div", { class: "cover-signature-line" }),
          el("div", { class: "cover-signature-label" }, "Date"),
        ]),
      ]),
    ]);

    return el("div", null, [toolbar, el("div", { class: "printable fade-in" }, sheet)]);
  }

  /* ---------- Filters bar (shared by Data + Internal Report tabs) ---------- */
  function renderFiltersBar(trips, city, opts) {
    opts = opts || {};
    const filtered = applyFilters(trips, state.filters);
    const statuses = Array.from(new Set(trips.map((t) => t.status)))
      .filter(Boolean)
      .sort();
    const modes = [];
    if (trips.some((t) => t.mode === "Stretcher"))
      modes.push({ value: "Stretcher", label: "Stretcher" });
    if (trips.some((t) => t.mode === "Wheelchair" || t.mode === "Ambulatory"))
      modes.push({ value: "WC_AMB", label: "Wheelchair / Ambulatory" });
    const payers = city.payers;

    const rightSection = opts.rightSection || null;

    return el("div", { class: "toolbar no-print" }, [
      el("div", { class: "toolbar-section" }, [
        el("div", null, [
          el("label", { class: "field-label" }, "From"),
          el("input", {
            type: "date",
            class: "field",
            value: state.filters.from,
            oninput: (e) =>
              setState({
                filters: { ...state.filters, from: e.target.value },
              }),
            style: { minWidth: "150px" },
          }),
        ]),
        el("div", null, [
          el("label", { class: "field-label" }, "To"),
          el("input", {
            type: "date",
            class: "field",
            value: state.filters.to,
            oninput: (e) =>
              setState({
                filters: { ...state.filters, to: e.target.value },
              }),
            style: { minWidth: "150px" },
          }),
        ]),
        el("div", { style: { minWidth: "180px" } }, [
          el("label", { class: "field-label" }, "Statuses"),
          checkMenu({
            options: statuses.map((s) => ({ value: s, label: s })),
            selected: state.filters.statuses,
            placeholder: "All statuses",
            onChange: (sel) =>
              setState({ filters: { ...state.filters, statuses: sel } }),
          }),
        ]),
        el("div", { style: { minWidth: "200px" } }, [
          el("label", { class: "field-label" }, "Modes"),
          checkMenu({
            options: modes,
            selected: state.filters.modes,
            placeholder: "All modes",
            onChange: (sel) =>
              setState({ filters: { ...state.filters, modes: sel } }),
          }),
        ]),
        el("div", { style: { minWidth: "180px" } }, [
          el("label", { class: "field-label" }, "Payer IDs"),
          checkMenu({
            options: payers.map((p) => ({ value: p, label: p })),
            selected: state.filters.payers,
            placeholder: "All payers",
            onChange: (sel) =>
              setState({ filters: { ...state.filters, payers: sel } }),
          }),
        ]),
        el(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            onclick: () =>
              setState({
                filters: {
                  from: "",
                  to: "",
                  statuses: [],
                  modes: [],
                  payers: [],
                },
              }),
          },
          "Reset"
        ),
      ]),
      el("div", { class: "grow" }),
      el(
        "div",
        { class: "row gap-2" },
        [
          el(
            "span",
            { class: "ink-soft", style: { fontSize: "0.82rem" } },
            `${filtered.length} of ${trips.length}`
          ),
          rightSection,
        ].filter(Boolean)
      ),
    ]);
  }

  /* ---------- Internal report tab ---------- */
  function renderInternalTab(trips, city) {
    const filtered = applyFilters(trips, state.filters);
    const dr = dateRangeFromTrips(filtered);

    const exportButtons = el("div", { class: "row gap-2" }, [
      el(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          disabled: filtered.length === 0,
          onclick: () => exportCSV(filtered, city),
        },
        [icon("download", 14), " CSV"]
      ),
      el(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          disabled: filtered.length === 0,
          onclick: () => exportXLSX(filtered, city),
        },
        [icon("download", 14), " Excel"]
      ),
      el(
        "button",
        {
          class: "btn btn-primary btn-sm",
          disabled: filtered.length === 0,
          onclick: () => window.print(),
          title: "Saves as Letter landscape PDF (11 × 8.5 in)",
        },
        [icon("printer", 14), " Print / PDF"]
      ),
    ]);

    const toolbar = renderFiltersBar(trips, city, {
      rightSection: exportButtons,
    });

    const overrideCount = Object.keys(state.priceOverrides).length;
    const helper =
      overrideCount > 0
        ? el(
            "div",
            {
              class: "ink-soft no-print",
              style: { fontSize: "0.78rem", margin: "0.25rem 0 0.75rem" },
            },
            [
              el(
                "span",
                { style: { color: "var(--warning)" } },
                `${overrideCount} manual price override${overrideCount === 1 ? "" : "s"} active.`
              ),
              " Edit on the ",
              el("strong", { style: { color: "var(--ink)" } }, "Data"),
              " tab.",
            ]
          )
        : null;

    const report = el("div", { class: "ir-wrap" }, [
      el("div", { class: "ir-header" }, [
        el("div", null, [
          el("div", { class: "ir-title-label" }, "Internal Report"),
          el("div", { class: "ir-title-fac" }, city.reportTitle || city.name),
        ]),
        el("div", { class: "ir-meta" }, [
          el(
            "div",
            null,
            `Generated ${new Date().toLocaleDateString("en-US")}`
          ),
          el(
            "div",
            { class: "mono", style: { marginTop: "2px" } },
            `${filtered.length} trips`
          ),
          el(
            "div",
            { class: "mono", style: { marginTop: "2px" } },
            `${dr.from} – ${dr.to}`
          ),
        ]),
      ]),
      renderInternalTable(filtered),
    ]);

    return el("div", null, [
      toolbar,
      helper,
      el("div", { class: "printable fade-in" }, report),
    ]);
  }

  function renderInternalTable(trips) {
    // Read-only 20-column layout. This is the report sent for approval — no
    // editing here, no Mobility column. All edits happen on the Data tab and
    // flow through to here via the trip data + price overrides.
    const cg = el(
      "colgroup",
      null,
      IR_COL_WIDTHS.map((w) => el("col", { style: { width: `${w}%` } }))
    );
    const head = el(
      "thead",
      null,
      el(
        "tr",
        null,
        IR_COLS.map((c) => el("th", null, c))
      )
    );
    const body = el(
      "tbody",
      null,
      trips.map((t) => {
        const row = irRow(t);
        return el(
          "tr",
          null,
          row.map((cell, idx) => {
            // 9 = STATUS — pill on screen, plain text on print
            if (idx === 9) {
              return el("td", { class: "ir-status" }, [
                el(
                  "span",
                  { class: statusPillClass(t.status) + " no-print" },
                  String(cell)
                ),
                el(
                  "span",
                  { class: "print-only", "aria-hidden": "true" },
                  String(cell)
                ),
              ]);
            }
            // 17 = RG PRICE — plain number, dim if zero (matches reference PDF)
            if (idx === 17) {
              const n = Number(cell) || 0;
              return el(
                "td",
                { class: n > 0 ? "col-right" : "col-right dim" },
                n > 0 ? formatNum(n) : ""
              );
            }
            // 18 = TOTAL PRICE — currency, override gets yellow dot
            if (idx === 18) {
              const n = Number(cell) || 0;
              return el(
                "td",
                {
                  class:
                    "col-right " +
                    (typeof state.priceOverrides[t.orderId] === "number"
                      ? "ir-override"
                      : n === 0
                      ? "dim"
                      : ""),
                },
                fmtMoneyDash(n)
              );
            }
            const cellStr = cell == null ? "" : String(cell);
            // numeric/time cols right-align? Reference uses left for most.
            // Mileage (13), Billable Miles (14), times all stay left.
            return el(
              "td",
              { class: cellStr === "" ? "dim" : "" },
              cellStr
            );
          })
        );
      })
    );
    // Footer TOTAL row — sums Total Price column
    const totalSum = trips.reduce((s, t) => s + effectivePrice(t), 0);
    const totalRow = el(
      "tr",
      { class: "ir-total-row" },
      [
        el(
          "td",
          { colspan: String(IR_COLS.length - 1) },
          el("strong", null, "TOTAL")
        ),
        el(
          "td",
          { class: "col-right" },
          el("strong", null, fmtMoneyDash(totalSum))
        ),
      ]
    );
    const foot = el("tfoot", null, totalRow);
    return el("table", { class: "ir-table" }, [cg, head, body, foot]);
  }

  function renderTripRow(t) {
    const w = t.wait || 0;
    const bTime = billableTimeDisplay(w);
    const bUnits = billableUnits(w);
    const bMiles = billableMiles(t.miles);

    const tds = [
      // 0 Account
      el(
        "td",
        null,
        editCell({
          display: t.payerId,
          value: t.payerId,
          onSave: (v) => setField(t, "payerId", v.trim()),
          edited: isFieldEdited(t, "payerId"),
        })
      ),
      // 1 Trip No
      el(
        "td",
        null,
        editCell({
          display: t.orderId,
          value: t.orderId,
          onSave: (v) => {
            const next = String(v).trim();
            if (!next || next === t.orderId) {
              render();
              return;
            }
            if (state.priceOverrides[t.orderId] != null) {
              const map = { ...state.priceOverrides };
              map[next] = map[t.orderId];
              delete map[t.orderId];
              state.priceOverrides = map;
            }
            t.orderId = next;
            render();
          },
        })
      ),
      // 2 DATE
      el(
        "td",
        null,
        editCell({
          display: fmtDate(t.date),
          value: toDateInputValue(t.date),
          type: "date",
          onSave: (v) => setField(t, "date", v),
        })
      ),
      // 3 P/U TIME
      el(
        "td",
        null,
        editCell({
          display: fmtTime(t.pickupTime),
          value: fmtTime(t.pickupTime),
          onSave: (v) => setField(t, "pickupTime", v.trim()),
        })
      ),
      // 4 NAME
      el(
        "td",
        null,
        editCell({
          display: t.passenger,
          value: t.passenger,
          onSave: (v) => setField(t, "passenger", v),
        })
      ),
      // 5 ON-SITE
      el(
        "td",
        null,
        editCell({
          display: fmtTime(t.pickupRadius),
          value: fmtTime(t.pickupRadius),
          onSave: (v) => setField(t, "pickupRadius", v.trim()),
        })
      ),
      // 6 LOAD TIME
      el(
        "td",
        null,
        editCell({
          display: fmtTime(t.loadTime),
          value: fmtTime(t.loadTime),
          onSave: (v) => setField(t, "loadTime", v.trim()),
        })
      ),
      // 7 Arrvd Dst
      el(
        "td",
        null,
        editCell({
          display: fmtTime(t.dropoffRadius),
          value: fmtTime(t.dropoffRadius),
          onSave: (v) => setField(t, "dropoffRadius", v.trim()),
        })
      ),
      // 8 COMPLETE
      el(
        "td",
        null,
        editCell({
          display: fmtTime(t.completedTime || t.cancelTime),
          value: fmtTime(t.completedTime || t.cancelTime),
          onSave: (v) => {
            const target =
              t.status === "Canceled" || t.status === "No show"
                ? "cancelTime"
                : "completedTime";
            setField(t, target, v.trim());
          },
        })
      ),
      // 9 STATUS — select (recomputes auto price)
      el("td", { class: "ir-status" }, [
        el(
          "span",
          { class: "no-print" },
          editCell({
            display: t.status,
            value: t.status,
            type: "select",
            options: STATUS_OPTIONS,
            onSave: (v) => setField(t, "status", v),
            className: statusPillClass(t.status),
            title: "Click to change status",
          })
        ),
        el(
          "span",
          { class: "print-only", "aria-hidden": "true" },
          String(t.status || "")
        ),
      ]),
      // 10 Wait Time Minutes (HH:MM, blank if 0)
      el(
        "td",
        { class: w > 0 ? "" : "dim" },
        editCell({
          display: w > 0 ? fmtWait(w) : "",
          value: String(w),
          type: "number",
          onSave: (v) => setField(t, "wait", Math.max(0, Number(v) || 0)),
          title: "Edit wait minutes",
        })
      ),
      // 11 Billable Time (derived)
      el(
        "td",
        { class: bTime > 0 ? "dim" : "dim" },
        bTime > 0 ? String(bTime) : ""
      ),
      // 12 Billable Units (derived)
      el(
        "td",
        { class: "dim" },
        bUnits > 0 ? String(bUnits) : ""
      ),
      // 13 MILEAGE (editable)
      el(
        "td",
        null,
        editCell({
          display: (t.miles || 0) > 0 ? Number(t.miles).toFixed(2) : "",
          value: String(t.miles || 0),
          type: "number",
          onSave: (v) => setField(t, "miles", Math.max(0, Number(v) || 0)),
        })
      ),
      // 14 Billable Miles (derived)
      el(
        "td",
        { class: "dim" },
        bMiles > 0 ? bMiles.toFixed(2) : ""
      ),
      // 15 VEH #
      el(
        "td",
        null,
        editCell({
          display: t.vehicle,
          value: t.vehicle,
          onSave: (v) => setField(t, "vehicle", v.trim()),
        })
      ),
      // 16 DRIVER
      el(
        "td",
        null,
        editCell({
          display: t.driver,
          value: t.driver,
          onSave: (v) => setField(t, "driver", v.trim()),
        })
      ),
      // 17 RG PRICE (from xlsx Final Price, plain number, read-only)
      el(
        "td",
        { class: "col-right dim" },
        Number(t.finalPrice || 0) > 0 ? formatNum(t.finalPrice) : ""
      ),
      // 18 TOTAL PRICE (manual override)
      el("td", { class: "col-right" }, renderPriceCell(t)),
      // 19 Mobility (screen-only) — select
      el(
        "td",
        { class: "no-print" },
        editCell({
          display: getMobility(t),
          value: getMobility(t),
          type: "select",
          options: MOBILITY_OPTIONS,
          onSave: (v) => {
            setMobility(t, v);
            render();
          },
          title: "Click to change mobility (affects price)",
        })
      ),
    ];
    return el("tr", null, tds);
  }

  function toDateInputValue(v) {
    const d = parseDate(v);
    if (!d || isNaN(d)) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /* ---------- Generic inline editor ----------
     Renders a span showing `display`. Click swaps to an input/select. On commit
     (Enter / change / blur), calls onSave(value). On Escape, cancels.
  */
  function editCell({ display, value, type, options, onSave, className, title, edited }) {
    const cls = "edit-cell" + (edited ? " edit-cell-dirty" : "") + (className ? " " + className : "");
    const span = el(
      "span",
      {
        class: cls,
        title: title || (edited ? "Edited — click to edit again" : "Click to edit"),
        tabindex: "0",
        onclick: (e) => {
          e.stopPropagation();
          openEditor(span, { value, type, options, onSave });
        },
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openEditor(span, { value, type, options, onSave });
          }
        },
      },
      [
        display == null || display === ""
          ? "—"
          : String(display),
      ]
    );
    return span;
  }

  function openEditor(target, { value, type, options, onSave }) {
    let input;
    if (type === "select") {
      input = el(
        "select",
        { class: "edit-input edit-input-select" },
        (options || []).map((o) => {
          const optEl = el(
            "option",
            { value: typeof o === "string" ? o : o.value },
            typeof o === "string" ? o : o.label
          );
          if ((typeof o === "string" ? o : o.value) === value)
            optEl.selected = true;
          return optEl;
        })
      );
      input.addEventListener("change", () => commit(input.value));
      input.addEventListener("blur", () => commit(input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") cancel();
      });
    } else {
      input = el("input", {
        type: type || "text",
        class: "edit-input",
        value: value == null ? "" : String(value),
        onkeydown: (e) => {
          if (e.key === "Enter") commit(e.target.value);
          else if (e.key === "Escape") cancel();
        },
        onblur: (e) => commit(e.target.value),
      });
    }
    target.replaceWith(input);
    input.focus();
    if (input.select) input.select();
    let done = false;
    function commit(v) {
      if (done) return;
      done = true;
      onSave(v);
    }
    function cancel() {
      if (done) return;
      done = true;
      render();
    }
  }

  function setField(t, key, value) {
    if (t[key] === value) {
      render();
      return;
    }
    // Snapshot the ORIGINAL value the first time a field is edited, so Reset
    // can restore it. Editing the same field again keeps the original snapshot.
    const oid = t.orderId;
    if (!state.tripEdits[oid]) state.tripEdits[oid] = Object.create(null);
    if (!(key in state.tripEdits[oid])) {
      state.tripEdits[oid][key] = t[key];
    }
    t[key] = value;
    render();
  }

  function isFieldEdited(t, key) {
    const e = state.tripEdits[t.orderId];
    return !!(e && key in e);
  }

  function isTripEdited(t) {
    return (
      !!state.tripEdits[t.orderId] ||
      typeof state.priceOverrides[t.orderId] === "number"
    );
  }

  // Restore all edited fields + clear price overrides for the trips belonging
  // to the given city. Used by the "Reset edits" button on the Data tab.
  function resetCityEdits(city) {
    const cityTripIds = new Set(
      state.allTrips
        .filter((t) => city.payers.includes(t.payerId))
        .map((t) => t.orderId)
    );
    const nextEdits = Object.create(null);
    Object.keys(state.tripEdits).forEach((oid) => {
      if (!cityTripIds.has(oid)) nextEdits[oid] = state.tripEdits[oid];
    });
    // Restore each city trip's fields from the snapshot.
    state.allTrips.forEach((t) => {
      if (!cityTripIds.has(t.orderId)) return;
      const e = state.tripEdits[t.orderId];
      if (!e) return;
      for (const k in e) t[k] = e[k];
    });
    const nextOverrides = { ...state.priceOverrides };
    cityTripIds.forEach((oid) => delete nextOverrides[oid]);
    state.tripEdits = nextEdits;
    setState({ priceOverrides: nextOverrides });
  }

  function renderPriceCell(t) {
    const override = state.priceOverrides[t.orderId];
    const hasOverride = typeof override === "number" && !isNaN(override);
    const price = effectivePrice(t);
    const span = el(
      "span",
      {
        class: hasOverride ? "price-cell is-override" : "price-cell",
        title: hasOverride
          ? `Manually set. Auto: ${fmtMoney(autoPrice(t))}. Click to edit.`
          : "Click to edit price",
        onclick: (e) => {
          e.stopPropagation();
          openPriceEditor(span, t);
        },
      },
      fmtMoney(price)
    );
    return span;
  }

  function openPriceEditor(targetSpan, t) {
    const current = effectivePrice(t);
    const input = el("input", {
      type: "number",
      step: "0.01",
      min: "0",
      class: "price-input",
      value: String(current),
      onkeydown: (e) => {
        if (e.key === "Enter") {
          commit(e.target.value);
        } else if (e.key === "Escape") {
          cancel();
        }
      },
      onblur: (e) => commit(e.target.value),
    });
    const wrap = targetSpan.parentNode;
    targetSpan.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    function commit(val) {
      if (committed) return;
      committed = true;
      const num = Number(val);
      const next = { ...state.priceOverrides };
      if (val === "" || isNaN(num)) {
        delete next[t.orderId];
      } else {
        next[t.orderId] = Math.round(num * 100) / 100;
      }
      setState({ priceOverrides: next });
    }
    function cancel() {
      if (committed) return;
      committed = true;
      // re-render row by re-render full state (cheap)
      render();
    }
  }

  /* ---------- Checkbox-menu component ---------- */
  function checkMenu({ options, selected, placeholder, onChange }) {
    let open = false;
    const sel = new Set(selected);
    const summary = el("span", { class: "checkmenu-summary" });
    function refreshSummary() {
      summary.innerHTML = "";
      if (sel.size === 0) {
        summary.appendChild(
          el("span", { class: "ink-soft" }, placeholder || "All")
        );
      } else if (sel.size === 1) {
        const v = [...sel][0];
        const o = options.find((x) => x.value === v);
        summary.appendChild(document.createTextNode(o ? o.label : v));
      } else {
        summary.appendChild(document.createTextNode(`${sel.size} selected`));
        summary.appendChild(el("span", { class: "checkmenu-count" }, String(sel.size)));
      }
    }
    refreshSummary();

    const panel = el("div", { class: "checkmenu-panel" });
    options.forEach((opt) => {
      const cb = el("input", {
        type: "checkbox",
        checked: sel.has(opt.value),
      });
      cb.addEventListener("change", () => {
        if (cb.checked) sel.add(opt.value);
        else sel.delete(opt.value);
        refreshSummary();
        onChange(Array.from(sel));
      });
      panel.appendChild(
        el("label", { class: "checkmenu-item" }, [
          cb,
          el("span", null, opt.label),
        ])
      );
    });

    const trigger = el(
      "button",
      {
        type: "button",
        class: "checkmenu-trigger",
        "aria-expanded": "false",
        onclick: (e) => {
          e.stopPropagation();
          open = !open;
          panel.classList.toggle("open", open);
          trigger.setAttribute("aria-expanded", open ? "true" : "false");
        },
      },
      [summary, el("span", { class: "checkmenu-caret" }, icon("chevron-down", 14))]
    );

    const wrap = el("div", { class: "checkmenu" }, [trigger, panel]);

    document.addEventListener(
      "click",
      (e) => {
        if (!wrap.contains(e.target)) {
          open = false;
          panel.classList.remove("open");
          trigger.setAttribute("aria-expanded", "false");
        }
      },
      { capture: true }
    );

    return wrap;
  }

  /* ---------- Exports ---------- */
  function exportCSV(trips, city) {
    const rows = [IR_COLS, ...trips.map(irRow)];
    const csv = rows
      .map((r) =>
        r
          .map((c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");
    downloadBlob(
      new Blob([csv], { type: "text/csv" }),
      `internal-report-${city.key}.csv`
    );
  }

  function exportXLSX(trips, city) {
    const wb = XLSX.utils.book_new();
    const data = [IR_COLS, ...trips.map(irRow)];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [
      { wch: 9 },  // Account
      { wch: 10 }, // Trip No
      { wch: 11 }, // DATE
      { wch: 9 },  // P/U TIME
      { wch: 24 }, // NAME
      { wch: 9 },  // ON-SITE
      { wch: 9 },  // LOAD TIME
      { wch: 9 },  // Arrvd Dst
      { wch: 9 },  // COMPLETE
      { wch: 11 }, // STATUS
      { wch: 12 }, // Wait Time Minutes
      { wch: 12 }, // Billable Time
      { wch: 12 }, // Billable Units
      { wch: 9 },  // MILEAGE
      { wch: 12 }, // Billable Miles
      { wch: 12 }, // VEH #
      { wch: 22 }, // DRIVER
      { wch: 10 }, // RG PRICE
      { wch: 12 }, // TOTAL PRICE
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Internal Report");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    downloadBlob(
      new Blob([out], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      `internal-report-${city.key}.xlsx`
    );
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ---------- File picker ---------- */
  let _filePicker = null;
  function openFilePicker() {
    if (!_filePicker) {
      _filePicker = document.createElement("input");
      _filePicker.type = "file";
      _filePicker.accept = ".xlsx,.xls";
      _filePicker.style.display = "none";
      _filePicker.addEventListener("change", () => {
        const f = _filePicker.files && _filePicker.files[0];
        if (f) loadFile(f);
        _filePicker.value = "";
      });
      document.body.appendChild(_filePicker);
    }
    _filePicker.click();
  }

  /* ---------- Icons (inline SVG) ---------- */
  function icon(name, size) {
    const s = size || 16;
    const paths = {
      upload:
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
      download:
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
      printer:
        '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
      "arrow-right":
        '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
      "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
      trash:
        '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
      alert:
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
      file:
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(s));
    svg.setAttribute("height", String(s));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = paths[name] || "";
    return svg;
  }

  /* ---------- Top-level render ---------- */
  function render() {
    setPrintOrientation(state.tab);
    const root = document.getElementById("root");
    if (!root) return;
    root.innerHTML = "";
    const tree = state.view.kind === "city" ? renderCity() : renderIndex();
    root.appendChild(tree);
  }

  /* ---------- Init ---------- */
  function init() {
    applyTheme();
    const btn = document.getElementById("themeToggle");
    if (btn) btn.addEventListener("click", toggleTheme);
    window.addEventListener("beforeprint", () =>
      setPrintOrientation(state.tab)
    );
    render();
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
