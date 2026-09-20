(function () {
  "use strict";

  var data = window.CSA_DATA;
  if (!data || !window.maplibregl) {
    document.body.innerHTML = '<p class="load-error">Não foi possível carregar o painel.</p>';
    throw new Error("CSA_DATA ou MapLibre GL não está disponível");
  }

  var STATUS = {
    "pronta-para-colheita": { label: "Pronta para colheita", color: "#22c55e" },
    frutificando: { label: "Frutificando", color: "#eab308" },
    "colhida-recentemente": { label: "Colhida recentemente", color: "#38bdf8" },
    "nao-produzindo": { label: "Não produzindo", color: "#94a3b8" },
    outro: { label: "Outro estado", color: "#f97316" }
  };
  var HEALTH_ALERTS = ["praga-ou-doenca", "estresse-hidrico"];
  var SNAP_ORDER = ["peek", "half", "full"];
  var DESKTOP_QUERY = "(min-width: 900px)";
  var FARM_TIME_ZONE = "America/Sao_Paulo";
  var CALENDAR_KIND_PRIORITY = ["harvest", "planting", "soil", "monitoring"];
  var CALENDAR_KIND_LABELS = {
    harvest: "colheita",
    planting: "plantio",
    soil: "solo",
    monitoring: "monitoramento"
  };

  var map;
  var activePlotName = null;
  var activePopup = null;
  var activeSpecies = null;
  var currentItems = data.species.slice();
  var speciesById = Object.create(null);
  var pulseFrame = null;
  var viewportTimer = null;
  var liveTimer = null;
  var suppressHeaderClick = false;
  var viewTransitionSerial = 0;
  var primaryView = "map";
  var sheetMode = "map";
  var calendarIndex = null;

  var root = document.documentElement;
  var mapRegion = document.getElementById("map-view");
  var calendarView = document.getElementById("calendar-view");
  var viewToggle = document.getElementById("view-toggle");
  var viewToggleCalendar = viewToggle.querySelector(".view-toggle-calendar");
  var viewToggleMap = viewToggle.querySelector(".view-toggle-map");
  var farmSheet = document.getElementById("farm-sheet");
  var sheetToggle = document.getElementById("sheet-toggle");
  var sheetTitle = document.getElementById("sheet-title");
  var sheetScroll = document.getElementById("sheet-scroll");
  var sheetSummary = document.getElementById("sheet-summary");
  var sheetLive = document.getElementById("sheet-live");
  var speciesDetail = document.getElementById("species-detail");
  var filtersForm = document.getElementById("filters");
  var searchToggle = document.getElementById("search-toggle");
  var searchField = document.getElementById("search-field");
  var searchInput = document.getElementById("search-filter");
  var talhaoSelect = document.getElementById("talhao-filter");
  var filterCount = document.getElementById("filter-count");
  var clearFiltersButton = document.getElementById("clear-filters");
  var board = document.getElementById("harvest-board");
  var resultCount = document.getElementById("result-count");
  var soilPanel = document.getElementById("soil-panel");
  var soilTitle = document.getElementById("soil-title");
  var soilContent = document.getElementById("soil-content");
  var mapSheetContent = document.getElementById("map-sheet-content");
  var calendarSheetContent = document.getElementById("calendar-sheet-content");
  var calendarDayDetail = document.getElementById("calendar-day-detail");
  var calendarTitle = document.getElementById("calendar-title");
  var calendarMonthLabel = document.getElementById("calendar-month-label");
  var calendarDays = document.getElementById("calendar-days");
  var calendarHarvestTotal = document.getElementById("calendar-harvest-total");
  var calendarObservationTotal = document.getElementById("calendar-observation-total");
  var desktopMedia = window.matchMedia(DESKTOP_QUERY);
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var sheetState = {
    snap: "peek",
    context: "none",
    metrics: null,
    currentY: 0,
    returnSnap: "peek",
    focusBeforeFull: null,
    drag: null,
    pendingY: null,
    frame: null
  };

  var sheetModeState = {
    map: { snap: "peek", scrollTop: 0 },
    calendar: { snap: "peek", scrollTop: 0 }
  };

  var calendarState = {
    visibleYear: null,
    visibleMonth: null,
    selectedDate: null,
    focusedDate: null
  };

  function text(value, fallback) {
    if (value === null || value === undefined || String(value).trim() === "") {
      return fallback || "—";
    }
    return String(value).trim();
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function statusKey(value) {
    return Object.prototype.hasOwnProperty.call(STATUS, value) ? value : "outro";
  }

  function humanize(value) {
    return text(value, "Não informado")
      .replace(/-/g, " ")
      .replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function farmDateParts(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: FARM_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    var result = {};
    parts.forEach(function (part) {
      if (part.type !== "literal") result[part.type] = part.value;
    });
    return result.year && result.month && result.day ? result : null;
  }

  function farmDateKey(value) {
    var parts = farmDateParts(value);
    return parts ? parts.year + "-" + parts.month + "-" + parts.day : null;
  }

  function farmTodayKey() {
    return farmDateKey(new Date());
  }

  function dateKeyFromUtc(date) {
    return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(date.getUTCDate()).padStart(2, "0");
  }

  function utcDateFromKey(dateKey) {
    var values = String(dateKey).split("-").map(Number);
    return new Date(Date.UTC(values[0], values[1] - 1, values[2]));
  }

  function calendarCategoryLabel(categoryId) {
    var known = {
      solo: "Amostra de solo",
      "management-feature": "Registro de manejo",
      fungo: "Observação de fungo",
      fungi: "Observação de fungo",
      tree: "Observação de árvore",
      "fruit-tree": "Observação de árvore",
      palm: "Observação de árvore",
      "body-of-water": "Corpo d’água",
      animal: "Observação de animal",
      consorcio: "Consórcio",
      "fishing-site": "Local de pesca",
      "herb-spice-medicinal": "Erva, tempero ou medicinal",
      "plot-consortium": "Consórcio do talhão",
      "shelter-building": "Abrigo ou construção",
      tuberculo: "Tubérculo",
      vine: "Trepadeira"
    };
    return known[categoryId] || humanize(categoryId || "registro de campo");
  }

  function classifyCalendarEvent(observation, species) {
    var notes = normalize((observation && observation.notes) || (species && species.notes));
    if (species && (
      species.managementStatus === "colhida" ||
      species.productionStatus === "colhida-recentemente" ||
      /\b(colhendo|colheita)\b/.test(notes)
    )) return "harvest";
    if ((species && species.managementStatus === "recem-plantada") || /\b(plantio|plantada|plantado)\b/.test(notes)) {
      return "planting";
    }
    if (observation.categoryId === "solo") return "soil";
    return "monitoring";
  }

  function buildCalendarIndex() {
    var eventsByDay = Object.create(null);
    var summaryByMonth = Object.create(null);
    var validCount = 0;
    var invalidCount = 0;

    data.species.forEach(function (item) { speciesById[item.docId] = item; });
    data.observations.forEach(function (observation) {
      var dateKey = farmDateKey(observation.createdAt);
      if (!dateKey) {
        invalidCount += 1;
        return;
      }
      validCount += 1;
      var species = speciesById[observation.docId] || null;
      var categoryLabel = calendarCategoryLabel(observation.categoryId);
      var event = {
        docId: observation.docId,
        createdAt: observation.createdAt,
        dateKey: dateKey,
        categoryId: observation.categoryId || "",
        kind: classifyCalendarEvent(observation, species),
        categoryLabel: categoryLabel,
        displayName: species ? species.name : categoryLabel,
        notes: text(observation.notes || (species && species.notes), ""),
        talhao: species ? text(species.talhao, "") : "",
        photo: species ? species.photo : null,
        species: species
      };
      if (!eventsByDay[dateKey]) eventsByDay[dateKey] = [];
      eventsByDay[dateKey].push(event);

      var monthKey = dateKey.slice(0, 7);
      if (!summaryByMonth[monthKey]) {
        summaryByMonth[monthKey] = { observations: 0, harvests: 0, kilograms: 0, hasKilograms: false, ambiguous: false };
      }
      var summary = summaryByMonth[monthKey];
      summary.observations += 1;
      if (event.kind === "harvest") {
        summary.harvests += 1;
        if (species && species.quantityUnit === "kg" && Number.isFinite(Number(species.quantityKg))) {
          summary.kilograms += Number(species.quantityKg);
          summary.hasKilograms = true;
          if (species.quantityAmbiguous) summary.ambiguous = true;
        }
      }
    });

    Object.keys(eventsByDay).forEach(function (dateKey) {
      eventsByDay[dateKey].sort(function (a, b) {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    });
    if (invalidCount) console.warn(invalidCount + " observações com data inválida foram ignoradas no diário.");
    calendarIndex = {
      eventsByDay: eventsByDay,
      summaryByMonth: summaryByMonth,
      dateKeys: Object.keys(eventsByDay).sort(),
      validCount: validCount,
      invalidCount: invalidCount
    };
    window.CSA_CALENDAR_INDEX = calendarIndex;
    return calendarIndex;
  }

  function formatDate(value, includeTime) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Data não informada";
    return new Intl.DateTimeFormat("pt-BR", includeTime ? {
      dateStyle: "short",
      timeStyle: "short"
    } : {
      day: "2-digit",
      month: "short",
      year: "numeric"
    }).format(date);
  }

  function formatNumber(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return new Intl.NumberFormat("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(Number(value));
  }

  function plural(count, singular, pluralForm) {
    return count + " " + (count === 1 ? singular : pluralForm);
  }

  function formatQuantity(item) {
    if (item.quantityUnit === "kg" && Number.isFinite(Number(item.quantityKg))) {
      var kilograms = formatNumber(item.quantityKg, 1) + " kg";
      if (item.quantityParts > 1) {
        kilograms += " · " + plural(item.quantityParts, "canteiro", "canteiros");
      }
      return kilograms + (item.quantityAmbiguous ? " (?)" : "");
    }
    if (item.quantityUnit === "unidades") {
      var units = Number(String(item.quantity).trim().replace(",", "."));
      if (Number.isFinite(units)) {
        return formatNumber(units, 0) + " " + (units === 1 ? "unidade" : "unidades");
      }
    }
    return "—";
  }

  function rawQuantityLine(item, formatted) {
    var raw = text(item.quantity, "");
    if (!raw || formatted === "—" || raw.toLowerCase().replace(/\s/g, "") === formatted.toLowerCase().replace(/\s/g, "")) {
      return "";
    }
    return '<br><small>Registrado: ' + escapeHtml(raw) + "</small>";
  }

  function formatCalendarDate(dateKey, options) {
    return new Intl.DateTimeFormat("pt-BR", Object.assign({ timeZone: "UTC" }, options || {}))
      .format(utcDateFromKey(dateKey));
  }

  function calendarTimeLabel(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: FARM_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function calendarCounts(events) {
    var counts = { harvest: 0, planting: 0, soil: 0, monitoring: 0 };
    events.forEach(function (event) { counts[event.kind] += 1; });
    return counts;
  }

  function dominantCalendarKind(counts) {
    var dominant = null;
    CALENDAR_KIND_PRIORITY.forEach(function (kind) {
      if (counts[kind] > 0 && (!dominant || counts[kind] > counts[dominant])) dominant = kind;
    });
    return dominant;
  }

  function calendarDayAriaLabel(dateKey, events, dominant) {
    var label = formatCalendarDate(dateKey, { day: "numeric", month: "long", year: "numeric" });
    if (dateKey === farmTodayKey()) label += ", hoje";
    if (!events.length) return label + ", sem atividade registrada";
    var counts = calendarCounts(events);
    label += ", " + plural(events.length, "registro", "registros");
    label += ", " + plural(counts.harvest, "colheita", "colheitas");
    label += ", categoria dominante " + CALENDAR_KIND_LABELS[dominant];
    return label;
  }

  function renderCalendarDayCell(year, month, day) {
    var dateKey = dateKeyFromUtc(new Date(Date.UTC(year, month, day)));
    var events = calendarIndex.eventsByDay[dateKey] || [];
    var counts = calendarCounts(events);
    var dominant = dominantCalendarKind(counts);
    var selected = dateKey === calendarState.selectedDate;
    var today = dateKey === farmTodayKey();
    var future = dateKey > farmTodayKey();
    var classes = ["calendar-day"];
    if (selected) classes.push("is-selected");
    if (today) classes.push("is-today");
    if (future) classes.push("is-future");
    if (counts.harvest) classes.push("has-harvest");
    var indicator = dominant ? '<span class="calendar-day-indicator kind-' + dominant + '" style="--kind-color: var(--calendar-' + dominant + ')" aria-hidden="true"></span>' : "";
    var badge = counts.harvest ? '<span class="calendar-harvest-badge" aria-hidden="true">' + counts.harvest + "</span>" : "";
    return '<td role="gridcell"><button class="' + classes.join(" ") + '" type="button" data-date="' + dateKey +
      '" tabindex="' + (dateKey === calendarState.focusedDate ? "0" : "-1") + '" aria-selected="' + (selected ? "true" : "false") +
      '" aria-label="' + escapeHtml(calendarDayAriaLabel(dateKey, events, dominant)) + '">' +
      '<span class="calendar-day-number" aria-hidden="true">' + day + "</span>" + badge + indicator + "</button></td>";
  }

  function updateMonthSummary() {
    var monthKey = calendarState.visibleYear + "-" + String(calendarState.visibleMonth + 1).padStart(2, "0");
    var summary = calendarIndex.summaryByMonth[monthKey] || {
      observations: 0,
      harvests: 0,
      kilograms: 0,
      hasKilograms: false,
      ambiguous: false
    };
    var harvestText;
    if (!summary.harvests) harvestText = "Sem colheitas registradas";
    else if (!summary.hasKilograms) harvestText = "Peso não registrado";
    else harvestText = formatNumber(summary.kilograms, 1) + " kg" + (summary.ambiguous ? " (?)" : "") + " colhidos";
    calendarHarvestTotal.textContent = harvestText;
    calendarHarvestTotal.removeAttribute("title");
    calendarHarvestTotal.removeAttribute("aria-label");
    if (summary.ambiguous) {
      calendarHarvestTotal.title = "Inclui quantidades convertidas de registros ambíguos";
      calendarHarvestTotal.setAttribute("aria-label", harvestText + ", inclui quantidades convertidas de registros ambíguos");
    }
    calendarObservationTotal.textContent = plural(summary.observations, "registro", "registros");
  }

  function renderCalendarMonth() {
    var year = calendarState.visibleYear;
    var month = calendarState.visibleMonth;
    var firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    var daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    var cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    var html = "";
    for (var cell = 0; cell < cellCount; cell += 1) {
      if (cell % 7 === 0) html += '<tr role="row">';
      var day = cell - firstWeekday + 1;
      if (day < 1 || day > daysInMonth) {
        html += '<td class="calendar-grid-cell-empty" role="gridcell" aria-hidden="true"></td>';
      } else {
        html += renderCalendarDayCell(year, month, day);
      }
      if (cell % 7 === 6) html += "</tr>";
    }
    calendarMonthLabel.textContent = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "UTC",
      month: "long",
      year: "numeric"
    }).format(new Date(Date.UTC(year, month, 1)));
    calendarDays.classList.remove("is-changing");
    calendarDays.innerHTML = html;
    window.requestAnimationFrame(function () { calendarDays.classList.add("is-changing"); });
    updateMonthSummary();
  }

  function setCalendarMonth(year, month, options) {
    options = options || {};
    var normalized = new Date(Date.UTC(year, month, 1));
    calendarState.visibleYear = normalized.getUTCFullYear();
    calendarState.visibleMonth = normalized.getUTCMonth();
    if (options.focusedDate) calendarState.focusedDate = options.focusedDate;
    renderCalendarMonth();
    if (options.focus) {
      window.requestAnimationFrame(function () {
        var target = calendarDays.querySelector('[data-date="' + calendarState.focusedDate + '"]');
        if (target) target.focus({ preventScroll: true });
      });
    }
  }

  function updateCalendarSheetHeader(dateKey) {
    var events = calendarIndex.eventsByDay[dateKey] || [];
    var harvests = calendarCounts(events).harvest;
    sheetTitle.textContent = formatCalendarDate(dateKey, { day: "numeric", month: "long" });
    sheetSummary.textContent = plural(events.length, "registro", "registros") + " · " + plural(harvests, "colheita", "colheitas");
  }

  function calendarEventIcon(event) {
    var symbols = { harvest: "↓", planting: "↟", soil: "◒", monitoring: "◎" };
    return '<span class="calendar-event-icon" aria-hidden="true">' + symbols[event.kind] + "</span>";
  }

  function calendarEventHtml(event) {
    var species = event.species;
    var photo = event.photo ? '<img class="calendar-event-media" src="' + escapeHtml(event.photo) + '" alt="Foto de ' +
      escapeHtml(event.displayName) + '" loading="lazy" width="' + (event.kind === "harvest" ? "56" : "40") + '" height="' +
      (event.kind === "harvest" ? "56" : "40") + '">' : calendarEventIcon(event);
    var location = event.talhao ? "<span>" + escapeHtml(event.talhao) + "</span>" : "";
    var quantity = species ? formatQuantity(species) : "—";
    var quantityHtml = quantity !== "—" ? '<p class="calendar-event-quantity">' + escapeHtml(quantity) + "</p>" : "";
    var notesHtml = event.notes ? '<p class="calendar-event-notes">' + escapeHtml(event.notes) + "</p>" : "";
    return '<li class="calendar-event calendar-event-' + event.kind + '">' +
      '<span class="sr-only">' + escapeHtml(CALENDAR_KIND_LABELS[event.kind]) + ". </span>" + photo +
      '<div class="calendar-event-copy"><div class="calendar-event-meta"><time datetime="' + escapeHtml(event.createdAt) + '">' +
      escapeHtml(calendarTimeLabel(event.createdAt)) + "</time><span>" + escapeHtml(event.categoryLabel) + "</span>" + location + "</div>" +
      "<h3>" + escapeHtml(event.displayName) + "</h3>" + quantityHtml + notesHtml + "</div></li>";
  }

  function renderDayDetail(dateKey) {
    var events = calendarIndex.eventsByDay[dateKey] || [];
    updateCalendarSheetHeader(dateKey);
    if (!events.length) {
      calendarDayDetail.innerHTML = '<div class="calendar-empty-day"><strong>Nenhuma atividade registrada neste dia.</strong>' +
        "<p>O diário mostra somente registros feitos no campo.</p></div>";
      return;
    }
    calendarDayDetail.innerHTML = '<header class="calendar-day-detail-header"><h2>Linha do tempo</h2><p>' +
      escapeHtml(plural(events.length, "atividade em ordem cronológica", "atividades em ordem cronológica")) + "</p></header>" +
      '<ol class="calendar-timeline">' + events.map(calendarEventHtml).join("") + "</ol>";
  }

  function selectCalendarDay(dateKey, options) {
    options = options || {};
    var date = utcDateFromKey(dateKey);
    calendarState.selectedDate = dateKey;
    calendarState.focusedDate = dateKey;
    if (date.getUTCFullYear() !== calendarState.visibleYear || date.getUTCMonth() !== calendarState.visibleMonth) {
      setCalendarMonth(date.getUTCFullYear(), date.getUTCMonth(), { focusedDate: dateKey, focus: options.focus });
    } else {
      renderCalendarMonth();
      if (options.focus) restoreCalendarDayFocus();
    }
    renderDayDetail(dateKey);
    if (!isDesktop() && options.open !== false) setSheetSnap("half", { focus: false });
    if (options.announce !== false) {
      announce(formatCalendarDate(dateKey, { day: "numeric", month: "long" }) + ", " + sheetSummary.textContent);
    }
  }

  function restoreCalendarDayFocus() {
    window.requestAnimationFrame(function () {
      var target = calendarDays.querySelector('[data-date="' + calendarState.selectedDate + '"]');
      if (target) target.focus({ preventScroll: true });
    });
  }

  function moveCalendarFocus(targetDate) {
    var dateKey = dateKeyFromUtc(targetDate);
    calendarState.focusedDate = dateKey;
    setCalendarMonth(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), { focusedDate: dateKey, focus: true });
  }

  function handleCalendarGridKeydown(event) {
    var button = event.target.closest("[data-date]");
    if (!button) return;
    var current = utcDateFromKey(button.dataset.date);
    var target = new Date(current.getTime());
    var handled = true;
    if (event.key === "ArrowLeft") target.setUTCDate(target.getUTCDate() - 1);
    else if (event.key === "ArrowRight") target.setUTCDate(target.getUTCDate() + 1);
    else if (event.key === "ArrowUp") target.setUTCDate(target.getUTCDate() - 7);
    else if (event.key === "ArrowDown") target.setUTCDate(target.getUTCDate() + 7);
    else if (event.key === "Home") target.setUTCDate(target.getUTCDate() - target.getUTCDay());
    else if (event.key === "End") target.setUTCDate(target.getUTCDate() + (6 - target.getUTCDay()));
    else if (event.key === "PageUp" || event.key === "PageDown") {
      var direction = event.key === "PageUp" ? -1 : 1;
      var desiredDay = target.getUTCDate();
      var monthStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + direction, 1));
      var maxDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
      target = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(desiredDay, maxDay)));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectCalendarDay(button.dataset.date, { focus: true });
      return;
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      moveCalendarFocus(target);
    }
  }

  function initializeCalendar() {
    var initialKey = calendarIndex.dateKeys.length ? calendarIndex.dateKeys[calendarIndex.dateKeys.length - 1] : farmTodayKey();
    var initialDate = utcDateFromKey(initialKey);
    calendarState.selectedDate = initialKey;
    calendarState.focusedDate = initialKey;
    calendarState.visibleYear = initialDate.getUTCFullYear();
    calendarState.visibleMonth = initialDate.getUTCMonth();
    renderCalendarMonth();
    renderDayDetail(initialKey);

    document.getElementById("calendar-prev").addEventListener("click", function () {
      var target = new Date(Date.UTC(calendarState.visibleYear, calendarState.visibleMonth - 1, 1));
      var focusDay = Math.min(utcDateFromKey(calendarState.focusedDate).getUTCDate(), new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate());
      moveCalendarFocus(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), focusDay)));
    });
    document.getElementById("calendar-next").addEventListener("click", function () {
      var target = new Date(Date.UTC(calendarState.visibleYear, calendarState.visibleMonth + 1, 1));
      var focusDay = Math.min(utcDateFromKey(calendarState.focusedDate).getUTCDate(), new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate());
      moveCalendarFocus(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), focusDay)));
    });
    document.getElementById("calendar-today").addEventListener("click", function () {
      selectCalendarDay(farmTodayKey(), { focus: true });
    });
    calendarDays.addEventListener("click", function (event) {
      var button = event.target.closest("[data-date]");
      if (button) selectCalendarDay(button.dataset.date, { focus: false });
    });
    calendarDays.addEventListener("keydown", handleCalendarGridKeydown);
    calendarView.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !isDesktop() && sheetMode === "calendar" && sheetState.snap !== "peek") {
        event.preventDefault();
        setSheetSnap("peek", { restoreFocus: false });
        restoreCalendarDayFocus();
      }
    });
  }

  function saveSheetModeState() {
    sheetModeState[sheetMode].snap = sheetState.snap;
    sheetModeState[sheetMode].scrollTop = sheetScroll.scrollTop;
  }

  function restoreSheetModeState(mode, options) {
    options = options || {};
    var saved = sheetModeState[mode];
    sheetState.snap = saved.snap;
    computeSheetMetrics();
    setSheetSnap(saved.snap, { immediate: true, silent: true });
    window.requestAnimationFrame(function () { sheetScroll.scrollTop = saved.scrollTop; });
  }

  function activePrimaryView() {
    return primaryView === "calendar" ? calendarView : mapRegion;
  }

  function setViewVisibility(nextView) {
    var transitionSerial = ++viewTransitionSerial;
    var nextElement = nextView === "calendar" ? calendarView : mapRegion;
    var previousElement = nextView === "calendar" ? mapRegion : calendarView;
    nextElement.hidden = false;
    nextElement.removeAttribute("inert");
    nextElement.setAttribute("aria-hidden", "false");
    previousElement.setAttribute("inert", "");
    previousElement.setAttribute("aria-hidden", "true");
    nextElement.classList.remove("is-leaving");
    nextElement.classList.add("is-entering");
    previousElement.classList.remove("is-entering");
    previousElement.classList.add("is-leaving");
    var duration = reducedMotion.matches ? 0 : 180;
    window.setTimeout(function () {
      if (transitionSerial !== viewTransitionSerial) return;
      previousElement.hidden = true;
      previousElement.classList.remove("is-leaving");
      nextElement.classList.remove("is-entering");
    }, duration);
  }

  function setPrimaryView(view, options) {
    options = options || {};
    if (["map", "calendar"].indexOf(view) === -1 || view === primaryView) return;
    saveSheetModeState();
    primaryView = view;
    sheetMode = view;
    document.querySelector(".dashboard-shell").dataset.view = view;
    farmSheet.dataset.mode = view;
    mapSheetContent.hidden = view !== "map";
    calendarSheetContent.hidden = view !== "calendar";
    if (view === "calendar") {
      mapSheetContent.setAttribute("inert", "");
      calendarSheetContent.removeAttribute("inert");
      if (!calendarState.hasOpened) {
        sheetModeState.calendar.snap = "peek";
        sheetModeState.calendar.scrollTop = 0;
        calendarState.hasOpened = true;
      }
      renderCalendarMonth();
      renderDayDetail(calendarState.selectedDate);
      viewToggle.setAttribute("aria-label", "Voltar ao mapa");
      viewToggleCalendar.hidden = true;
      viewToggleMap.hidden = false;
      document.getElementById("sheet-description").textContent = "Atividades registradas no dia selecionado do Diário do campo.";
    } else {
      calendarSheetContent.setAttribute("inert", "");
      mapSheetContent.removeAttribute("inert");
      sheetTitle.textContent = "Quadro de colheita";
      updatePeekSummary(currentItems);
      viewToggle.setAttribute("aria-label", "Abrir Diário do campo");
      viewToggleCalendar.hidden = false;
      viewToggleMap.hidden = true;
      document.getElementById("sheet-description").textContent = "Quadro de colheita relacionado ao mapa do sítio.";
    }
    setViewVisibility(view);
    restoreSheetModeState(view);
    syncSheetAccessibility();
    if (view === "calendar") {
      calendarTitle.focus({ preventScroll: true });
      announce("Diário do campo aberto");
    } else {
      window.requestAnimationFrame(function () { if (map) map.resize(); });
      if (options.focus !== false) viewToggle.focus({ preventScroll: true });
      announce("Mapa aberto");
    }
  }

  function initializeViewSwitcher() {
    viewToggle.addEventListener("click", function () {
      setPrimaryView(primaryView === "map" ? "calendar" : "map");
    });
  }

  function isDesktop() {
    return desktopMedia.matches;
  }

  function announce(message) {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(function () {
      sheetLive.textContent = "";
      window.requestAnimationFrame(function () { sheetLive.textContent = message; });
    }, 80);
  }

  function toFeatureCollection(features) {
    return { type: "FeatureCollection", features: features };
  }

  function speciesFeatures() {
    return toFeatureCollection(data.species.map(function (item) {
      var key = statusKey(item.productionStatus);
      speciesById[item.docId] = item;
      return {
        type: "Feature",
        properties: {
          docId: item.docId,
          name: item.name,
          talhao: item.talhao || "",
          productionStatus: item.productionStatus || "",
          statusKey: key,
          healthStatus: item.healthStatus || "",
          searchText: normalize(item.name + " " + (item.notes || ""))
        },
        geometry: { type: "Point", coordinates: [item.lon, item.lat] }
      };
    }));
  }

  function observationFeatures() {
    return toFeatureCollection(data.observations.map(function (item) {
      return {
        type: "Feature",
        properties: {
          docId: item.docId,
          categoryId: item.categoryId || "",
          notes: item.notes || ""
        },
        geometry: { type: "Point", coordinates: [item.lon, item.lat] }
      };
    }));
  }

  function talhaoFeatures() {
    return toFeatureCollection(data.talhoes.map(function (plot) {
      return {
        type: "Feature",
        properties: {
          name: plot.name,
          areaHa: plot.areaHa,
          areaLabel: plot.areaHa === null ? "Área não informada" : formatNumber(plot.areaHa, 2) + " ha"
        },
        geometry: plot.geometry
      };
    }));
  }

  function ringCentroid(ring) {
    var twiceArea = 0;
    var x = 0;
    var y = 0;
    for (var index = 0; index < ring.length - 1; index += 1) {
      var current = ring[index];
      var next = ring[index + 1];
      var cross = current[0] * next[1] - next[0] * current[1];
      twiceArea += cross;
      x += (current[0] + next[0]) * cross;
      y += (current[1] + next[1]) * cross;
    }
    if (Math.abs(twiceArea) < 1e-12) {
      return ring.slice(0, -1).reduce(function (sum, point) {
        return [sum[0] + point[0] / (ring.length - 1), sum[1] + point[1] / (ring.length - 1)];
      }, [0, 0]);
    }
    return [x / (3 * twiceArea), y / (3 * twiceArea)];
  }

  function talhaoLabelFeatures() {
    return toFeatureCollection(data.talhoes.map(function (plot) {
      var polygon = plot.geometry.type === "MultiPolygon" ? plot.geometry.coordinates[0] : plot.geometry.coordinates;
      return {
        type: "Feature",
        properties: {
          name: plot.name,
          areaLabel: plot.areaHa === null ? "Área não informada" : formatNumber(plot.areaHa, 2) + " ha"
        },
        geometry: { type: "Point", coordinates: ringCentroid(polygon[0]) }
      };
    }));
  }

  function visitCoordinates(value, bounds) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      bounds.extend([value[0], value[1]]);
      return;
    }
    value.forEach(function (child) { visitCoordinates(child, bounds); });
  }

  function dataBounds() {
    var bounds = new maplibregl.LngLatBounds();
    data.talhoes.forEach(function (plot) { visitCoordinates(plot.geometry.coordinates, bounds); });
    if (data.boundary && data.boundary.geometry) {
      visitCoordinates(data.boundary.geometry.coordinates, bounds);
    }
    data.observations.forEach(function (item) { bounds.extend([item.lon, item.lat]); });
    return bounds;
  }

  function activeFilterCount() {
    var count = 0;
    var checked = selectedStatuses().length;
    if (searchInput.value.trim()) count += 1;
    if (talhaoSelect.value) count += 1;
    if (checked !== Object.keys(STATUS).length) count += 1;
    return count;
  }

  function selectedStatuses() {
    return Array.from(filtersForm.querySelectorAll('input[name="status"]:checked')).map(function (input) {
      return input.value;
    });
  }

  function currentPredicate(item) {
    var statuses = selectedStatuses();
    var query = normalize(searchInput.value);
    return statuses.indexOf(statusKey(item.productionStatus)) !== -1 &&
      (!talhaoSelect.value || item.talhao === talhaoSelect.value) &&
      (!query || normalize(item.name + " " + (item.notes || "")).indexOf(query) !== -1);
  }

  function mapFilterExpression() {
    var statuses = selectedStatuses();
    var query = normalize(searchInput.value);
    var parts = ["all", ["in", ["get", "statusKey"], ["literal", statuses]]];
    if (talhaoSelect.value) parts.push(["==", ["get", "talhao"], talhaoSelect.value]);
    if (query) parts.push([">=", ["index-of", query, ["get", "searchText"]], 0]);
    return parts;
  }

  function pulseFilterExpression(docId) {
    var parts = ["all", mapFilterExpression(), ["==", ["get", "statusKey"], "pronta-para-colheita"]];
    if (docId) parts.push(["==", ["get", "docId"], docId]);
    return parts;
  }

  function updatePeekSummary(items) {
    var readyCount = items.filter(function (item) {
      return item.productionStatus === "pronta-para-colheita";
    }).length;
    var filters = activeFilterCount();
    var summary = readyCount + " " + (readyCount === 1 ? "pronto" : "prontos") + " p/ colheita";
    if (filters) summary += " · " + filters + " " + (filters === 1 ? "filtro ativo" : "filtros ativos");
    if (sheetMode === "map") sheetSummary.textContent = summary;
    return readyCount;
  }

  function updateFilterPresentation(items) {
    var count = activeFilterCount();
    farmSheet.dataset.filtersActive = String(count);
    filterCount.textContent = count ? plural(count, "filtro ativo", "filtros ativos") : "Nenhum filtro ativo";
    clearFiltersButton.hidden = count === 0;
    searchToggle.classList.toggle("is-active", Boolean(searchInput.value.trim()));
    filtersForm.querySelectorAll('input[name="status"]').forEach(function (checkbox) {
      checkbox.closest("label").dataset.selected = checkbox.checked ? "true" : "false";
    });
    updatePeekSummary(items);
  }

  function clearFilters() {
    searchInput.value = "";
    talhaoSelect.value = "";
    filtersForm.querySelectorAll('input[name="status"]').forEach(function (checkbox) {
      checkbox.checked = true;
    });
    searchField.hidden = true;
    searchToggle.setAttribute("aria-expanded", "false");
    applyFilters();
  }

  function initializeHeaderAndFilters() {
    document.getElementById("generated-at").textContent = "Atualizado em " + formatDate(data.generatedAt, true);
    data.talhoes.forEach(function (plot) {
      var option = document.createElement("option");
      option.value = plot.name;
      option.textContent = "Talhão: " + plot.name;
      talhaoSelect.appendChild(option);
    });

    filtersForm.addEventListener("input", applyFilters);
    filtersForm.addEventListener("change", applyFilters);
    clearFiltersButton.addEventListener("click", clearFilters);
    searchToggle.addEventListener("click", function () {
      var opening = searchField.hidden;
      if (!opening && searchInput.value.trim()) {
        searchInput.focus();
        return;
      }
      searchField.hidden = !opening;
      searchToggle.setAttribute("aria-expanded", String(opening));
      if (opening) {
        if (!isDesktop()) setSheetSnap("full", { focus: false });
        window.setTimeout(function () { searchInput.focus(); }, reducedMotion.matches ? 0 : 180);
      }
    });
    searchInput.addEventListener("focus", function () {
      if (!isDesktop()) setSheetSnap("full", { focus: false });
    });
    document.getElementById("close-soil").addEventListener("click", closeContext);
  }

  function applyFilters() {
    var previousReady = currentItems.filter(function (item) {
      return item.productionStatus === "pronta-para-colheita";
    }).length;
    currentItems = data.species.filter(currentPredicate);
    renderBoard(currentItems);
    updateFilterPresentation(currentItems);
    if (map && map.getLayer("species")) {
      map.setFilter("species", mapFilterExpression());
      map.setFilter("species-ready-pulse", pulseFilterExpression());
      var nextReady = currentItems.filter(function (item) {
        return item.productionStatus === "pronta-para-colheita";
      }).length;
      if (nextReady > 0 && (previousReady === 0 || nextReady > previousReady)) animateReadyPulse();
    }
    announce(plural(currentItems.length, "cultivo encontrado", "cultivos encontrados"));
  }

  function boardGroups() {
    return [
      {
        id: "now",
        title: "Colher agora",
        matches: function (item) { return item.productionStatus === "pronta-para-colheita"; }
      },
      {
        id: "soon",
        title: "Em breve",
        matches: function (item) {
          return ["frutificando", "nao-produzindo", "muda"].indexOf(item.productionStatus) !== -1 ||
            item.developmentStatus === "muda";
        }
      },
      {
        id: "harvested",
        title: "Colhida",
        matches: function (item) { return item.productionStatus === "colhida-recentemente"; }
      },
      {
        id: "attention",
        title: "Atenção",
        matches: function (item) { return HEALTH_ALERTS.indexOf(item.healthStatus) !== -1; }
      }
    ];
  }

  function renderBoard(items) {
    resultCount.textContent = plural(items.length, "cultivo", "cultivos");
    if (!items.length) {
      board.innerHTML = '<div class="board-empty"><span>Nenhum cultivo com estes filtros.</span>' +
        '<button type="button" data-clear-filters>Limpar filtros</button></div>';
      board.querySelector("[data-clear-filters]").addEventListener("click", clearFilters);
      return;
    }

    board.innerHTML = boardGroups().map(function (group) {
      var members = items.filter(group.matches).sort(function (a, b) {
        return a.name.localeCompare(b.name, "pt-BR");
      });
      var cards = members.length ? members.map(renderCard).join("") :
        '<p class="group-empty">Nenhum cultivo neste grupo.</p>';
      var headingId = "group-" + group.id;
      return '<section class="harvest-group harvest-group-' + group.id + '" aria-labelledby="' + headingId + '">' +
        '<div class="harvest-group-header"><h3 id="' + headingId + '">' + escapeHtml(group.title) +
        " — " + members.length + "</h3></div>" + cards + "</section>";
    }).join("");

    board.querySelectorAll("[data-doc-id]").forEach(function (card) {
      card.addEventListener("click", function () {
        focusSpecies(speciesById[card.getAttribute("data-doc-id")]);
      });
    });
  }

  function renderCard(item) {
    var photo = item.photo ?
      '<img src="' + escapeHtml(item.photo) + '" alt="Foto de ' + escapeHtml(item.name) + '" loading="lazy" width="48" height="48">' :
      '<span class="photo-placeholder" aria-hidden="true">•</span>';
    var selected = activeSpecies && activeSpecies.docId === item.docId;
    return '<button class="harvest-card" type="button" data-doc-id="' + escapeHtml(item.docId) + '" ' +
      'aria-label="Ver ' + escapeHtml(item.name) + ' no mapa" aria-current="' + (selected ? "true" : "false") + '" ' +
      'style="--card-status: ' + STATUS[statusKey(item.productionStatus)].color + '">' + photo +
      '<span class="harvest-card-copy"><strong>' + escapeHtml(item.name) + "</strong>" +
      "<small>" + escapeHtml(text(item.talhao, "Talhão não informado")) + "</small></span>" +
      '<span class="harvest-quantity">' + escapeHtml(formatQuantity(item)) + "</span></button>";
  }

  function detailBadges(item) {
    return [item.productionStatus, item.developmentStatus, item.healthStatus, item.managementStatus]
      .filter(Boolean)
      .map(function (value) { return '<span class="popup-badge">' + escapeHtml(humanize(value)) + "</span>"; })
      .join("");
  }

  function detailFieldsHtml(item) {
    var accuracy = item.accuracy === null ? "Não informada" : "± " + formatNumber(item.accuracy, 0) + " m";
    var quantity = formatQuantity(item);
    return "<dl><dt>Quantidade</dt><dd>" + escapeHtml(quantity) + rawQuantityLine(item, quantity) + "</dd>" +
      (item.talhaoOriginal ? "<dt>Canteiro</dt><dd>" + escapeHtml(item.talhaoOriginal) + "</dd>" : "") +
      "<dt>Uso principal</dt><dd>" + escapeHtml(humanize(item.mainUse)) + "</dd>" +
      "<dt>Precisão</dt><dd>" + escapeHtml(accuracy) + "</dd>" +
      "<dt>Registro</dt><dd>" + escapeHtml(formatDate(item.createdAt, true)) + "</dd></dl>";
  }

  function speciesDetailHtml(item, variant) {
    var photo = item.photo ? '<img src="' + escapeHtml(item.photo) + '" alt="Foto de ' + escapeHtml(item.name) + '">' : "";
    var location = escapeHtml(text(item.talhao, "Talhão não informado"));
    var badges = detailBadges(item);
    if (variant === "popup") {
      return '<article class="species-popup">' + photo + '<div class="popup-body">' +
        "<h3>" + escapeHtml(item.name) + "</h3>" +
        '<p class="popup-location">' + location + "</p>" +
        '<div class="popup-badges">' + badges + "</div>" + detailFieldsHtml(item) +
        (item.notes ? '<p class="popup-notes">' + escapeHtml(item.notes) + "</p>" : "") +
        "</div></article>";
    }

    var mobilePhoto = photo || '<span class="detail-photo-placeholder" aria-hidden="true">•</span>';
    return '<article class="species-detail-card">' + mobilePhoto + '<div class="detail-main">' +
      "<h3>" + escapeHtml(item.name) + "</h3>" +
      '<p class="detail-location">' + location + "</p>" +
      '<p class="detail-quantity">' + escapeHtml(formatQuantity(item)) + "</p>" +
      '<div class="detail-badges">' + badges + "</div></div>" +
      '<button class="icon-button detail-close" type="button" aria-label="Fechar detalhes de ' + escapeHtml(item.name) + '">×</button>' +
      '<details class="detail-more"><summary>Mais detalhes</summary>' + detailFieldsHtml(item) +
      (item.notes ? '<p class="detail-notes">' + escapeHtml(item.notes) + "</p>" : "") +
      "</details></article>";
  }

  function popupHtml(item) {
    return speciesDetailHtml(item, "popup");
  }

  function renderSpeciesDetail(item) {
    if (!item) return;
    if (sheetState.context === "none") sheetState.returnSnap = sheetState.snap;
    activeSpecies = item;
    sheetState.context = "species";
    farmSheet.dataset.context = "species";
    soilPanel.hidden = true;
    speciesDetail.innerHTML = speciesDetailHtml(item, "card");
    speciesDetail.hidden = false;
    speciesDetail.querySelector(".detail-close").addEventListener("click", closeContext);
    renderBoard(currentItems);
    if (sheetState.snap === "peek") setSheetSnap("half");
    announce("Detalhes de " + item.name + " abertos");
  }

  function openSpeciesPopup(item) {
    if (!item || !map) return;
    if (isDesktop()) {
      if (activePopup) activePopup.remove();
      activeSpecies = item;
      speciesDetail.hidden = true;
      soilPanel.hidden = true;
      sheetState.context = "species";
      farmSheet.dataset.context = "species";
      activePopup = new maplibregl.Popup({ offset: 13, maxWidth: "280px" })
        .setLngLat([item.lon, item.lat])
        .setHTML(popupHtml(item))
        .addTo(map);
      activePopup.on("close", function () {
        activePopup = null;
        if (isDesktop() && sheetState.context === "species") {
          activeSpecies = null;
          sheetState.context = "none";
          farmSheet.dataset.context = "none";
          renderBoard(currentItems);
        }
      });
      renderBoard(currentItems);
      return;
    }
    activeSpecies = item;
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
    renderSpeciesDetail(item);
  }

  function currentMapPadding(snap) {
    if (isDesktop() || !sheetState.metrics) return { top: 48, right: 48, bottom: 48, left: 48 };
    var visible = sheetState.metrics.fullHeight - sheetState.metrics[snap || sheetState.snap];
    return { top: 72, right: 28, bottom: Math.round(visible + 28), left: 28 };
  }

  function focusSpecies(item) {
    if (!item || !map) return;
    var targetSnap = !isDesktop() && sheetState.snap === "peek" ? "half" : sheetState.snap;
    map.flyTo({
      center: [item.lon, item.lat],
      zoom: Math.max(map.getZoom(), 18),
      padding: currentMapPadding(targetSnap),
      duration: reducedMotion.matches ? 0 : 650
    });
    openSpeciesPopup(item);
    if (item.productionStatus === "pronta-para-colheita") animateReadyPulse(item.docId);
  }

  function closeContext() {
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
    activeSpecies = null;
    speciesDetail.hidden = true;
    speciesDetail.innerHTML = "";
    soilPanel.hidden = true;
    sheetState.context = "none";
    farmSheet.dataset.context = "none";
    renderBoard(currentItems);
    if (!isDesktop() && sheetState.snap !== sheetState.returnSnap) {
      setSheetSnap(sheetState.returnSnap, { restoreFocus: true });
    }
    if (map) {
      map.easeTo({ padding: { top: 0, right: 0, bottom: 0, left: 0 }, duration: reducedMotion.matches ? 0 : 250 });
    }
  }

  function renderSoil(plotName) {
    var soil = data.soil.find(function (item) { return item.talhao === plotName; });
    if (sheetState.context === "none") sheetState.returnSnap = sheetState.snap;
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
    activeSpecies = null;
    speciesDetail.hidden = true;
    speciesDetail.innerHTML = "";
    sheetState.context = "soil";
    farmSheet.dataset.context = "soil";
    soilTitle.textContent = "Solo — " + plotName;
    soilPanel.hidden = false;
    renderBoard(currentItems);
    if (!soil || (!soil.n && soil.phAvg === null && soil.tempAvg === null && soil.moistAvg === null && !soil.moistMode)) {
      soilContent.innerHTML = '<p class="soil-note">Ainda não há observações dentro deste talhão.</p>';
    } else {
      var moisture = soil.moistMode || (soil.moistAvg === null ? "—" : formatNumber(soil.moistAvg, 1) + "%");
      soilContent.innerHTML = '<div class="soil-readings">' +
        soilReading("pH", formatNumber(soil.phAvg, 1)) +
        soilReading("Temperatura", soil.tempAvg === null ? "—" : formatNumber(soil.tempAvg, 1) + " °C") +
        soilReading("Umidade", moisture) +
        "</div><p class=\"soil-note\">" + plural(soil.n, "observação localizada", "observações localizadas") + " neste talhão.</p>";
    }
    if (!isDesktop() && sheetState.snap === "peek") setSheetSnap("half");
    announce("Leituras de solo de " + plotName + " abertas");
  }

  function soilReading(label, value) {
    return '<div class="soil-reading"><strong>' + escapeHtml(value) + "</strong><span>" + escapeHtml(label) + "</span></div>";
  }

  function computeSheetMetrics() {
    if (isDesktop()) {
      sheetState.metrics = { fullHeight: farmSheet.getBoundingClientRect().height, full: 0, half: 0, peek: 0 };
      return sheetState.metrics;
    }
    var viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    var fullHeight = farmSheet.getBoundingClientRect().height;
    var peekVisible = sheetToggle.getBoundingClientRect().height;
    var halfVisible = Math.min(520, Math.max(300, viewportHeight * 0.45));
    halfVisible = Math.min(halfVisible, fullHeight);
    sheetState.metrics = {
      fullHeight: fullHeight,
      full: 0,
      half: Math.max(0, fullHeight - halfVisible),
      peek: Math.max(0, fullHeight - peekVisible)
    };
    return sheetState.metrics;
  }

  function writeSheetY(value) {
    sheetState.currentY = value;
    root.style.setProperty("--sheet-y", Math.round(value * 100) / 100 + "px");
  }

  function queueSheetY(value) {
    sheetState.pendingY = value;
    if (sheetState.frame !== null) return;
    sheetState.frame = window.requestAnimationFrame(function () {
      writeSheetY(sheetState.pendingY);
      sheetState.frame = null;
    });
  }

  function snapLabel(snap) {
    return snap === "peek" ? "recolhido" : snap === "half" ? "meia altura" : "tela cheia";
  }

  function setSheetSnap(nextSnap, options) {
    options = options || {};
    if (SNAP_ORDER.indexOf(nextSnap) === -1) return;
    if (isDesktop()) {
      sheetState.snap = nextSnap;
      sheetModeState[sheetMode].snap = nextSnap;
      farmSheet.dataset.snap = nextSnap;
      syncSheetAccessibility();
      return;
    }
    var metrics = sheetState.metrics || computeSheetMetrics();
    var oldSnap = sheetState.snap;
    var targetY = metrics[nextSnap];
    var distance = Math.abs(targetY - sheetState.currentY);
    var duration = reducedMotion.matches || options.immediate ? 0 : Math.min(420, Math.max(220, 220 + distance * 0.45));
    if (oldSnap !== "full" && nextSnap === "full") {
      sheetState.focusBeforeFull = document.activeElement;
    }
    farmSheet.dataset.dragging = "false";
    farmSheet.style.setProperty("--sheet-duration", duration + "ms");
    root.style.setProperty("--sheet-duration", duration + "ms");
    sheetState.snap = nextSnap;
    sheetModeState[sheetMode].snap = nextSnap;
    farmSheet.dataset.snap = nextSnap;
    writeSheetY(targetY);
    syncSheetAccessibility(options);
    if (!options.silent) {
      window.setTimeout(function () { announce("Quadro em " + snapLabel(nextSnap)); }, duration);
    }
  }

  function syncSheetAccessibility(options) {
    options = options || {};
    var desktop = isDesktop();
    var full = !desktop && sheetState.snap === "full";
    var peek = !desktop && sheetState.snap === "peek";
    farmSheet.setAttribute("aria-modal", full ? "true" : "false");
    sheetToggle.disabled = desktop;
    sheetToggle.setAttribute("aria-expanded", String(desktop || !peek));
    var contentName = sheetMode === "calendar" ? "detalhe do dia" : "quadro de colheita";
    sheetToggle.setAttribute("aria-label", peek ? "Abrir " + contentName : full ? "Recolher " + contentName + " para meia altura" : "Expandir " + contentName);
    if (peek) {
      sheetScroll.setAttribute("inert", "");
      sheetScroll.setAttribute("aria-hidden", "true");
    } else {
      sheetScroll.removeAttribute("inert");
      sheetScroll.removeAttribute("aria-hidden");
    }
    if (full) {
      activePrimaryView().setAttribute("inert", "");
      if (options.focus) {
        var activeContent = sheetMode === "calendar" ? calendarSheetContent : mapSheetContent;
        var target = Array.from(activeContent.querySelectorAll("button:not([hidden]), input:not([hidden]), select:not([hidden]), [tabindex]:not([tabindex=\"-1\"])")).find(function (element) {
          return element.offsetParent !== null;
        });
        if (target) {
          window.setTimeout(function () { target.focus({ preventScroll: true }); }, 0);
        }
      }
    } else {
      activePrimaryView().removeAttribute("inert");
      if (options.restoreFocus && sheetState.focusBeforeFull && typeof sheetState.focusBeforeFull.focus === "function") {
        sheetState.focusBeforeFull.focus({ preventScroll: true });
      }
    }
  }

  function nextTapSnap() {
    if (sheetState.snap === "peek") return "half";
    if (sheetState.snap === "half") return "full";
    return "half";
  }

  function beginSheetDrag(event, fromContent) {
    if (isDesktop() || event.pointerType === "mouse" && event.button !== 0) return;
    if (fromContent && event.target.closest("button, input, select, label, summary, a, .status-chip-row")) return;
    var metrics = sheetState.metrics || computeSheetMetrics();
    sheetState.drag = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      startClientY: event.clientY,
      startSheetY: sheetState.currentY || metrics[sheetState.snap],
      startSnap: sheetState.snap,
      fromContent: Boolean(fromContent),
      active: false,
      samples: [{ y: event.clientY, time: performance.now() }]
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* Pointer capture is best effort. */ }
  }

  function resistedY(value, metrics) {
    var min = metrics.full;
    var max = metrics.peek;
    if (value < min) return min - Math.min(12, (min - value) * 0.15);
    if (value > max) return max + Math.min(12, (value - max) * 0.15);
    return value;
  }

  function updateSheetDrag(event) {
    var drag = sheetState.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    var delta = event.clientY - drag.startClientY;
    if (!drag.active) {
      var threshold = drag.fromContent ? 8 : 6;
      if (Math.abs(delta) < threshold) return;
      if (drag.fromContent && (delta < 0 || sheetScroll.scrollTop > 0)) {
        sheetState.drag = null;
        return;
      }
      drag.active = true;
      farmSheet.dataset.dragging = "true";
      cancelReadyPulse();
    }
    event.preventDefault();
    var now = performance.now();
    drag.samples.push({ y: event.clientY, time: now });
    drag.samples = drag.samples.filter(function (sample) { return now - sample.time <= 110; });
    queueSheetY(resistedY(drag.startSheetY + delta, sheetState.metrics));
  }

  function nearestSnap(projectedY) {
    return SNAP_ORDER.reduce(function (best, snap) {
      return Math.abs(sheetState.metrics[snap] - projectedY) < Math.abs(sheetState.metrics[best] - projectedY) ? snap : best;
    }, "peek");
  }

  function advanceSnap(startSnap, direction, veryFast) {
    var index = SNAP_ORDER.indexOf(startSnap);
    if (direction < 0) return SNAP_ORDER[Math.min(SNAP_ORDER.length - 1, index + (veryFast ? 2 : 1))];
    return SNAP_ORDER[Math.max(0, index - 1)];
  }

  function endSheetDrag(event) {
    var drag = sheetState.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    try { drag.captureTarget.releasePointerCapture(event.pointerId); } catch (error) { /* Capture may already be released. */ }
    sheetState.drag = null;
    if (!drag.active) return;
    suppressHeaderClick = !drag.fromContent;
    var samples = drag.samples;
    var first = samples[0];
    var last = samples[samples.length - 1];
    var elapsed = Math.max(1, last.time - first.time);
    var velocity = (last.y - first.y) / elapsed;
    var travel = last.y - drag.startClientY;
    var viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    var next;
    if (velocity >= 0.75 || travel >= viewportHeight * 0.2) {
      next = "peek";
    } else if (velocity <= -1) {
      next = "full";
    } else if (velocity <= -0.55) {
      next = advanceSnap(drag.startSnap, -1, false);
    } else {
      next = nearestSnap(sheetState.currentY + velocity * 160);
    }
    setSheetSnap(next);
  }

  function cancelSheetDrag(event) {
    if (!sheetState.drag || event.pointerId !== sheetState.drag.pointerId) return;
    sheetState.drag = null;
    farmSheet.dataset.dragging = "false";
    setSheetSnap(sheetState.snap, { silent: true });
  }

  function trapSheetFocus(event) {
    if (event.key === "Escape") {
      if (sheetMode === "calendar" && sheetState.snap !== "peek") {
        event.preventDefault();
        setSheetSnap("peek", { restoreFocus: false });
        restoreCalendarDayFocus();
      } else if (sheetState.snap === "full") {
        event.preventDefault();
        setSheetSnap("half", { restoreFocus: true });
      } else if (sheetState.context !== "none") {
        event.preventDefault();
        closeContext();
      }
      return;
    }
    if (event.key !== "Tab" || isDesktop() || sheetState.snap !== "full") return;
    var activeContent = sheetMode === "calendar" ? calendarSheetContent : mapSheetContent;
    var focusable = [sheetToggle].concat(Array.from(activeContent.querySelectorAll('button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), select:not(:disabled):not([hidden]), summary, [tabindex]:not([tabindex="-1"])'))).filter(function (element) {
      return element.offsetParent !== null && !element.closest("[inert]");
    });
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleViewportChange() {
    window.clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(function () {
      if (sheetState.drag) return;
      computeSheetMetrics();
      if (!isDesktop()) setSheetSnap(sheetState.snap, { immediate: true, silent: true });
      if (map && primaryView === "map") map.resize();
    }, 120);
  }

  function handleBreakpointChange() {
    if (sheetState.drag) sheetState.drag = null;
    farmSheet.dataset.dragging = "false";
    computeSheetMetrics();
    if (isDesktop()) {
      root.style.setProperty("--sheet-y", "0px");
      if (primaryView === "map" && activeSpecies) openSpeciesPopup(activeSpecies);
    } else {
      if (activePopup) {
        activePopup.remove();
        activePopup = null;
      }
      setSheetSnap(sheetState.snap, { immediate: true, silent: true });
      if (primaryView === "map" && activeSpecies) renderSpeciesDetail(activeSpecies);
    }
    syncSheetAccessibility();
    window.requestAnimationFrame(function () { if (map && primaryView === "map") map.resize(); });
  }

  function initializeSheet() {
    computeSheetMetrics();
    writeSheetY(sheetState.metrics.peek);
    syncSheetAccessibility();

    sheetToggle.addEventListener("pointerdown", function (event) { beginSheetDrag(event, false); });
    sheetToggle.addEventListener("pointermove", updateSheetDrag, { passive: false });
    sheetToggle.addEventListener("pointerup", endSheetDrag);
    sheetToggle.addEventListener("pointercancel", cancelSheetDrag);
    sheetToggle.addEventListener("click", function (event) {
      if (suppressHeaderClick) {
        suppressHeaderClick = false;
        event.preventDefault();
        return;
      }
      if (!isDesktop()) setSheetSnap(nextTapSnap(), { focus: nextTapSnap() === "full" });
    });

    sheetScroll.addEventListener("pointerdown", function (event) {
      if (sheetScroll.scrollTop <= 0) beginSheetDrag(event, true);
    });
    sheetScroll.addEventListener("pointermove", updateSheetDrag, { passive: false });
    sheetScroll.addEventListener("pointerup", endSheetDrag);
    sheetScroll.addEventListener("pointercancel", cancelSheetDrag);
    farmSheet.addEventListener("keydown", trapSheetFocus);

    if (desktopMedia.addEventListener) desktopMedia.addEventListener("change", handleBreakpointChange);
    else desktopMedia.addListener(handleBreakpointChange);
    window.addEventListener("resize", handleViewportChange, { passive: true });
    window.addEventListener("orientationchange", handleViewportChange, { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", handleViewportChange, { passive: true });
  }

  function cancelReadyPulse() {
    if (pulseFrame !== null) {
      window.cancelAnimationFrame(pulseFrame);
      pulseFrame = null;
    }
    if (map && map.getLayer("species-ready-pulse")) {
      map.setPaintProperty("species-ready-pulse", "circle-opacity", 0);
      map.setFilter("species-ready-pulse", pulseFilterExpression());
    }
  }

  function animateReadyPulse(docId) {
    cancelReadyPulse();
    if (!map || !map.getLayer("species-ready-pulse") || reducedMotion.matches || document.hidden || map.isMoving() || farmSheet.dataset.dragging === "true") return;
    map.setFilter("species-ready-pulse", pulseFilterExpression(docId));
    var started = performance.now();
    function frame(now) {
      if (document.hidden || map.isMoving() || farmSheet.dataset.dragging === "true") {
        cancelReadyPulse();
        return;
      }
      var elapsed = now - started;
      if (elapsed >= 2400) {
        cancelReadyPulse();
        return;
      }
      var progress = (elapsed % 1200) / 1200;
      map.setPaintProperty("species-ready-pulse", "circle-radius", 9 + progress * 13);
      map.setPaintProperty("species-ready-pulse", "circle-opacity", 0.38 * (1 - progress));
      pulseFrame = window.requestAnimationFrame(frame);
    }
    pulseFrame = window.requestAnimationFrame(frame);
  }

  function addPointSourcesAndLayers() {
    map.addSource("boundary", { type: "geojson", data: data.boundary });
    map.addSource("observations", { type: "geojson", data: observationFeatures() });
    map.addSource("species", { type: "geojson", data: speciesFeatures() });

    map.addLayer({
      id: "boundary-line",
      type: "line",
      source: "boundary",
      paint: { "line-color": "#eef2d8", "line-width": 2.4, "line-opacity": 0.9, "line-dasharray": [2, 1.5] }
    });
    map.addLayer({
      id: "observations",
      type: "circle",
      source: "observations",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 2, 19, 3.5],
        "circle-color": "#cbd5d1",
        "circle-opacity": 0.58,
        "circle-stroke-color": "#26352d",
        "circle-stroke-width": 0.7
      }
    });
    map.addLayer({
      id: "species-ready-pulse",
      type: "circle",
      source: "species",
      filter: pulseFilterExpression(),
      paint: {
        "circle-radius": 9,
        "circle-color": "#22c55e",
        "circle-opacity": 0,
        "circle-stroke-width": 0
      }
    });
    map.addLayer({
      id: "species",
      type: "circle",
      source: "species",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 5, 19, 8],
        "circle-color": ["match", ["get", "statusKey"],
          "pronta-para-colheita", "#22c55e",
          "frutificando", "#eab308",
          "colhida-recentemente", "#38bdf8",
          "nao-produzindo", "#94a3b8",
          "#f97316"
        ],
        "circle-stroke-color": ["case", ["in", ["get", "healthStatus"], ["literal", HEALTH_ALERTS]], "#ef4444", "#f8fafc"],
        "circle-stroke-width": ["case", ["in", ["get", "healthStatus"], ["literal", HEALTH_ALERTS]], 3, 1.2],
        "circle-opacity": 0.95
      }
    });
  }

  function addPlotSourceAndLayers() {
    map.addSource("plots", { type: "geojson", data: talhaoFeatures() });
    map.addSource("plot-labels", { type: "geojson", data: talhaoLabelFeatures() });
    map.addLayer({
      id: "talhoes-fill",
      type: "fill",
      source: "plots",
      paint: { "fill-color": "#4f765a", "fill-opacity": 0.21 }
    }, "boundary-line");
    map.addLayer({
      id: "talhoes-hover",
      type: "fill",
      source: "plots",
      filter: ["==", ["get", "name"], ""],
      paint: { "fill-color": "#b8d99e", "fill-opacity": 0.3 }
    }, "boundary-line");
    map.addLayer({
      id: "talhoes-line",
      type: "line",
      source: "plots",
      paint: { "line-color": "#a8c593", "line-width": 1.35, "line-opacity": 0.8 }
    }, "boundary-line");
    map.addLayer({
      id: "talhoes-labels",
      type: "symbol",
      source: "plot-labels",
      layout: {
        "text-field": ["concat", ["get", "name"], "\n", ["get", "areaLabel"]],
        "text-font": ["Open Sans Semibold"],
        "text-size": 11,
        "text-anchor": "center",
        "text-allow-overlap": false
      },
      paint: {
        "text-color": "#f1f5e8",
        "text-halo-color": "#173023",
        "text-halo-width": 1.5
      }
    }, "species-ready-pulse");
  }

  function wireMapInteractions() {
    map.on("mouseenter", "species", function () { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "species", function () { map.getCanvas().style.cursor = ""; });
    map.on("click", "species", function (event) {
      var docId = event.features && event.features[0] && event.features[0].properties.docId;
      openSpeciesPopup(speciesById[docId]);
    });

    map.on("mousemove", "talhoes-fill", function (event) {
      if (!event.features || !event.features.length) return;
      map.getCanvas().style.cursor = "pointer";
      var plotName = event.features[0].properties.name;
      if (activePlotName !== plotName) {
        activePlotName = plotName;
        map.setFilter("talhoes-hover", ["==", ["get", "name"], activePlotName]);
      }
    });
    map.on("mouseleave", "talhoes-fill", function () {
      map.getCanvas().style.cursor = "";
      activePlotName = null;
      map.setFilter("talhoes-hover", ["==", ["get", "name"], ""]);
    });
    map.on("click", "talhoes-fill", function (event) {
      if (!event.features || !event.features.length) return;
      if (map.queryRenderedFeatures(event.point, { layers: ["species"] }).length) return;
      var feature = event.features[0];
      var bounds = new maplibregl.LngLatBounds();
      visitCoordinates(feature.geometry.coordinates, bounds);
      renderSoil(feature.properties.name);
      map.fitBounds(bounds, {
        padding: currentMapPadding(isDesktop() ? "full" : "half"),
        maxZoom: 18.5,
        duration: reducedMotion.matches ? 0 : 700
      });
    });

    map.on("movestart", cancelReadyPulse);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) cancelReadyPulse();
    });
  }

  function initializeMap() {
    var extent = dataBounds();
    var hasExtent = !extent.isEmpty();
    var initialCenter = hasExtent ? extent.getCenter() : [0, 0];
    var mapOptions = {
      container: "map",
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors"
          }
        },
        layers: [{ id: "osm", type: "raster", source: "osm", minzoom: 0, maxzoom: 19 }]
      },
      center: initialCenter,
      zoom: hasExtent ? 16.5 : 2,
      pitch: 40,
      bearing: 0,
      attributionControl: false
    };
    if (hasExtent) {
      var sw = extent.getSouthWest();
      var ne = extent.getNorthEast();
      mapOptions.maxBounds = [[sw.lng - 0.02, sw.lat - 0.02], [ne.lng + 0.02, ne.lat + 0.02]];
    }
    map = new maplibregl.Map(mapOptions);
    if (hasExtent) {
      map.fitBounds(extent, {
        padding: 48,
        maxZoom: 16.5,
        pitch: 40,
        duration: 0
      });
    }
    window.CSA_MAP = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", function () {
      map.getCanvas().setAttribute("aria-label", "Mapa interativo do Sítio Ecológico");
      addPointSourcesAndLayers();
      addPlotSourceAndLayers();
      wireMapInteractions();
      applyFilters();
      window.setTimeout(animateReadyPulse, 350);
    });
  }

  buildCalendarIndex();
  initializeSheet();
  initializeHeaderAndFilters();
  initializeViewSwitcher();
  initializeCalendar();
  applyFilters();
  initializeMap();
}());
