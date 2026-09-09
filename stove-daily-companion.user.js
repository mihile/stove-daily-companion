// ==UserScript==
// @name         Stove Daily Companion
// @namespace    stove-daily-companion
// @version      1.0.5
// @updateURL    https://raw.githubusercontent.com/mihile/stove-daily-companion/main/stove-daily-companion.user.js
// @downloadURL  https://raw.githubusercontent.com/mihile/stove-daily-companion/main/stove-daily-companion.user.js
// @supportURL   https://github.com/mihile/stove-daily-companion/issues
// @description  스토브 일일 보상 확인·수령과 현재 탭 캡슐 뽑기 및 결과 기록
// @match        https://reward.onstove.com/ko*
// @match        https://lostark.game.onstove.com/News/Notice/*
// @match        https://event.onstove.com/ko/dailyshop/RIICHICITY_IND/*
// @match        https://event.onstove.com/ko/dailyshop/STOVEINDIE/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

// Stove Daily Companion — standalone implementation
(function dailyRewards() {
  "use strict";
  const PREFIX = "stove_daily_v2:",
    LOCK = PREFIX + "lock";
  const MISSIONS = [
    "다양한 게임 보러가기",
    "MY홈 방문하기",
    "스토브 메인 방문하기",
    "스토브 앱 로그인하기",
    "게임 플레이하기",
  ];
  const TASKS = [
    { id: "riichi", name: "마작일번가 출석", game: "RIICHICITY_IND" },
    { id: "indie", name: "스토어 출석", game: "STOVEINDIE" },
    ...MISSIONS.map((name, i) => ({
      id: "mission" + i,
      name,
      mission: true,
      visit: i < 3,
    })),
    { id: "draw", name: "캡슐 뽑기", draw: true },
  ];
  const token = new URLSearchParams(location.hash.slice(1)).get("stoveDaily");
  const rows = new Map();
  const activeJobs = new Set();
  let running = false,
    stopped = false,
    output,
    summary,
    modeSelect,
    leaseId = null;
  const HISTORY = PREFIX + "draw-history";
  let currentRun = null,
    historyBox,
    modeButtons = [];
  const text = (el) =>
    (el?.textContent || "").replace(/[\s\uE000-\uF8FF]/g, "");
  const visible = (el) =>
    !!el &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const enabled = (el) =>
    visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const buttons = (root = document) =>
    [...root.querySelectorAll("button")].filter(
      (b) => visible(b) && !b.closest("#stove-daily-extension"),
    );
  const done = (b) => /^(받기완료|완료|수령완료|참여완료|받음)$/.test(text(b));
  const result = (state, detail = "") => ({ state, detail });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function dateParts() {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(new Date())
        .map((p) => [p.type, p.value]),
    );
  }
  function today() {
    const p = dateParts();
    return p.year + p.month + p.day;
  }
  function month() {
    return today().slice(0, 6);
  }
  function jobRead() {
    return token ? GM_getValue(PREFIX + token, null) : null;
  }
  function check() {
    if (stopped) throw new Error("중단됨");
    if (token) {
      const job = jobRead(),
        lock = GM_getValue(LOCK, null);
      if (
        !job ||
        job.cancelled ||
        job.date !== today() ||
        !lock ||
        lock.id !== job.owner ||
        Date.now() - lock.time > 15000
      )
        throw new Error("실행 요청 만료 또는 중단됨");
    }
  }
  async function waitFor(fn, ms = 20000, interval = 100) {
    const end = Date.now() + ms;
    do {
      check();
      const value = fn();
      if (value) return value;
      await sleep(interval);
    } while (Date.now() < end);
    return null;
  }
  function publish(progress) {
    check();
    const job = jobRead();
    if (job) GM_setValue(PREFIX + token, { ...job, progress });
    else status("draw", progress);
  }
  function log(message) {
    if (output) {
      output.textContent += message + "\n";
      output.scrollTop = output.scrollHeight;
    }
    console.log("[일일 보상]", message);
  }
  function status(id, value) {
    const row = rows.get(id);
    if (!row) return;
    row.value = value;
    const retryable = value.state === "확인 필요";
    row.badge.textContent = retryable
      ? "재시도"
      : { "스캔 중": "확인 중", 중단됨: "중단", "갱신 대기": "갱신 중" }[
          value.state
        ] || value.state;
    row.badge.disabled = !retryable || running;
    row.badge.title = retryable ? value.detail : "";
    row.detail.textContent = value.detail;
    row.badge.style.color =
      value.state === "완료됨" ? "#79dfa7" : retryable ? "#ffb884" : "#afd2ff";
    row.badge.style.background = retryable ? "#55351f" : "transparent";
    row.badge.style.border = retryable ? "1px solid #d98b4b" : "0";
    row.badge.style.borderRadius = retryable ? "4px" : "0";
    row.badge.style.padding = retryable ? "1px 5px" : "0";
    row.badge.style.cursor = retryable && !running ? "pointer" : "default";
    summary.textContent = `완료 ${[...rows.values()].filter((r) => r.value?.state === "완료됨").length}/${TASKS.length} · 확인·처리 중`;
  }
  function refreshRetryButtons() {
    for (const row of rows.values()) {
      const retryable = row.value?.state === "확인 필요";
      row.badge.disabled = !retryable || running;
      row.badge.style.cursor = retryable && !running ? "pointer" : "default";
    }
  }
  function missionButton(name) {
    const labels = [...document.querySelectorAll("p")].filter(
      (el) => visible(el) && text(el) === name.replace(/\s/g, ""),
    );
    if (labels.length !== 1) return null;
    for (
      let el = labels[0].parentElement;
      el && el !== document.body;
      el = el.parentElement
    ) {
      const found = buttons(el);
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    return null;
  }
  function shopButton() {
    const p = dateParts(),
      day = `${Number(p.month)}.${Number(p.day)}`;
    const candidates = [...document.querySelectorAll(".module-card-item")]
      .filter(visible)
      .filter((card) =>
        [...card.querySelectorAll("span")].some((el) => text(el) === day),
      )
      .flatMap((card) => buttons(card));
    return candidates.length === 1 ? candidates[0] : null;
  }
  function drawCount() {
    const boxes = [...document.querySelectorAll(".stds-box")]
      .filter((el) => visible(el) && text(el).includes("오늘뽑기"))
      .sort((a, b) => text(a).length - text(b).length);
    for (const box of boxes) {
      const m = text(box).match(/오늘뽑기(\d+)\/(\d+)회/);
      if (m) {
        const used = Number(m[1]),
          total = Number(m[2]);
        if (total === 30 && used >= 0 && used <= 30) return { used, total };
      }
    }
    return null;
  }
  function dialogs() {
    return [
      ...document.querySelectorAll('[role="dialog"],.stds-dialog-panel'),
    ].filter(visible);
  }
  async function closeOfferwall() {
    const modal = [
      ...document.querySelectorAll(".mission-offerwall-modal"),
    ].find(visible);
    if (!modal) return true;
    const close = modal.querySelector('button[aria-label="close"]');
    if (!enabled(close)) return false;
    check();
    close.click();
    return !!(await waitFor(() => !visible(modal), 5000));
  }
  function inspectModal() {
    const modal = dialogs()[0];
    if (!modal) return null;
    const message = (modal.innerText || modal.textContent || "").trim(),
      norm = text(modal);
    const success =
      /이미.*(받았|수령|지급|참여)|지급되었습니다|받았습니다|획득했습니다|수령이완료|지급이완료/.test(
        norm,
      ) && !/오류|실패|로그인|연동|불가|조건|않았|않습니다/.test(norm);
    return { modal, message, success };
  }
  async function claim(read) {
    const b = read();
    if (done(b)) return result("완료됨", "사이트의 완료 버튼 확인 · 건너뜀");
    if (!enabled(b)) return result("조건 미충족", "수령 버튼 비활성");
    if (dialogs().length)
      return result("확인 필요", "열린 안내 팝업을 확인하세요.");
    check();
    b.click();
    return (
      (await waitFor(() => {
        const info = inspectModal();
        if (info) {
          if (info.success) {
            const close = buttons(info.modal).find((el) =>
              /^(확인|닫기)$/.test(text(el)),
            );
            if (close) {
              check();
              close.click();
            }
            return result("완료됨", info.message.slice(0, 140));
          }
          return result("확인 필요", info.message.slice(0, 180));
        }
        return done(read())
          ? result("완료됨", "클릭 후 사이트의 완료 상태 확인")
          : null;
      }, 15000)) ||
      result(
        "확인 필요",
        "클릭했으나 완료 응답 미확인. 상태 스캔으로 확인하세요.",
      )
    );
  }
  async function visit(b, read = () => null) {
    if (!(await closeOfferwall())) throw new Error("게임 목록 팝업 닫기 실패");
    const page = unsafeWindow,
      original = page.open,
      opened = [];
    // 실제 미션 URL로 관리 가능한 탭을 열어 창 핸들 손실과 팝업 차단을 피함.
    const hook = function (url, target, features) {
      try {
        const u = new URL(String(url), location.href);
        if (
          u.protocol === "https:" &&
          (u.hostname === "onstove.com" || u.hostname.endsWith(".onstove.com"))
        ) {
          opened.push(
            GM_openInTab(u.href, {
              active: false,
              insert: true,
              setParent: true,
            }),
          );
          return null;
        }
      } catch (_) {}
      return original.call(page, url, target, features);
    };
    page.open = hook;
    try {
      check();
      b.click();
      await waitFor(
        () =>
          text(read()) === "받기" ||
          done(read()) ||
          opened.length ||
          [...document.querySelectorAll(".mission-offerwall-modal")].some(
            visible,
          ),
        8000,
      );
      // 전환이 보이면 즉시 진행. 화면이 갱신되지 않는 사이트 경로만 짧게 기다림.
      await waitFor(() => text(read()) === "받기" || done(read()), 750);
      if (!(await closeOfferwall()))
        throw new Error("게임 목록 팝업 닫기 실패");
    } finally {
      if (page.open === hook) page.open = original;
      for (const tab of opened) {
        try {
          tab.close();
        } catch (_) {}
      }
    }
  }
  async function runMission(task, job) {
    if (!(await closeOfferwall()))
      return result("확인 필요", "게임 목록 팝업 닫기 실패");
    const read = () => missionButton(task.name),
      b = await waitFor(read);
    if (!b)
      return result(
        "확인 필요",
        "미션을 찾지 못했습니다. 로그인/페이지 구조 확인",
      );
    if (done(b)) return result("완료됨", "받기 완료 확인 · 건너뜀");
    if (job.scan)
      return result(
        text(b) === "받기" ? "수령 가능" : "미완료",
        "사이트 상태: " + text(b),
      );
    if (text(b) === "받기") return await claim(read);
    if (task.visit && text(b) === "미션하기" && enabled(b) && !job.visited) {
      publish(result("방문 중", "방문 후 최신 상태를 다시 읽습니다."));
      await visit(b, read);
      check();
      if (job.bundle) {
        const latest = read();
        if (done(latest)) return result("완료됨", "방문 후 완료 상태 확인");
        if (text(latest) === "받기") return await claim(read);
        return result("갱신 대기", "방문 완료 · 묶음 처리 후 한 번 새로고침");
      }
      GM_setValue(PREFIX + token, { ...jobRead(), visited: true });
      location.reload();
      return null;
    }
    return result(
      task.visit ? "확인 필요" : "조건 미충족",
      task.visit
        ? "방문 후 새로고침했지만 받기로 바뀌지 않았습니다."
        : "앱 로그인/게임 플레이 후 다시 실행하세요.",
    );
  }
  async function runShop(job, reload = () => location.reload()) {
    const b = await waitFor(shopButton);
    if (!b)
      return result("확인 필요", "오늘 날짜 출석 카드를 찾지 못했습니다.");
    if (done(b)) return result("완료됨", "오늘 날짜 카드의 완료 확인 · 건너뜀");
    if (job.shopRecheck)
      return result(
        "확인 필요",
        "오류 후 다시 확인했지만 출석 완료가 확인되지 않았습니다. 나중에 다시 실행하세요.",
      );
    if (job.scan)
      return result(
        enabled(b) ? "수령 가능" : "조건 미충족",
        "오늘 날짜 카드: " + text(b),
      );
    if (text(b) !== "오늘의아이템받기")
      return result("확인 필요", "알 수 없는 출석 버튼: " + text(b));
    const value = await claim(shopButton);
    if (
      token &&
      value.state === "확인 필요" &&
      /일시적인?\s*오류/.test(value.detail)
    ) {
      check();
      GM_setValue(PREFIX + token, { ...jobRead(), shopRecheck: true });
      publish(result("확인 중", "일시 오류 · 출석 상태 다시 확인"));
      reload();
      return null;
    }
    return value;
  }
  async function runMissionBatch(
    job,
    perform = runMission,
    reload = () => location.reload(),
  ) {
    const missions = TASKS.filter((t) => t.mission);
    const items = { ...(job.items || {}) };
    const visited = { ...(job.visitedItems || {}) };
    await waitFor(() => missions.every((t) => missionButton(t.name)), 20000);
    const save = () => {
      check();
      GM_setValue(PREFIX + token, {
        ...jobRead(),
        items,
        visitedItems: visited,
      });
    };
    for (const task of missions) {
      check();
      if (items[task.id] && items[task.id].state !== "갱신 대기") continue;
      items[task.id] = result("스캔 중", "미션 탭에서 순서대로 확인");
      save();
      const value = await perform(task, {
        ...job,
        bundle: true,
        visited: !!visited[task.id],
      });
      if (value.state === "갱신 대기") visited[task.id] = true;
      items[task.id] = value;
      save();
      if (dialogs().length) {
        for (const remaining of missions)
          if (!items[remaining.id] || items[remaining.id].state === "갱신 대기")
            items[remaining.id] = result(
              "확인 필요",
              "안내 팝업을 확인한 뒤 다시 실행하세요.",
            );
        save();
        break;
      }
    }
    if (
      !job.refreshed &&
      Object.values(items).some((v) => v.state === "갱신 대기")
    ) {
      save();
      GM_setValue(PREFIX + token, { ...jobRead(), refreshed: true });
      reload();
      return null;
    }
    return result(
      Object.values(items).some((v) => v.state === "확인 필요")
        ? "확인 필요"
        : "처리 종료",
      "미션 5개 확인 종료",
    );
  }
  async function runDraw(job) {
    let count = await waitFor(drawCount);
    if (!count) return result("확인 필요", "오늘 뽑기 횟수를 찾지 못했습니다.");
    if (count.used === 30) return result("완료됨", "오늘 30/30회 · 건너뜀");
    if (job.scan)
      return result(
        "미완료",
        `오늘 ${count.used}/30회 · ${30 - count.used}회 남음`,
      );
    if (!["100", "1000"].includes(job.mode))
      return result("건너뜀", `뽑기 안 함 · 오늘 ${count.used}/30회`);
    const mainLabel = job.mode + "뽑기",
      norm = (b) => text(b).replace(/,/g, ""),
      initial = count.used;
    currentRun = {
      id: crypto.randomUUID(),
      date: today(),
      started: new Date().toISOString(),
      mode: job.mode,
      records: [],
    };
    saveRun();
    for (let n = initial; n < 30; n++) {
      if (today() !== currentRun.date)
        return result("확인 필요", "날짜가 바뀌어 뽑기를 중단했습니다.");
      check();
      count = drawCount();
      if (!count) return result("확인 필요", "뽑기 횟수 표시가 사라졌습니다.");
      if (count.used === 30) return result("완료됨", "오늘 30/30회");
      const previous = count.used;
      publish(result("뽑는 중", `${job.mode} 플레이크 · ${previous}/30회`));
      // 같은 금액의 '한번 더' 버튼을 우선 사용하여 결과 팝업을 유지한다.
      const old = rewardView();
      const moreLabel = mainLabel + "한번더!";
      const hasMore =
        old && buttons(old.panel).some((b) => norm(b) === moreLabel);
      if (old && !hasMore) {
        const close = buttons(old.panel).find((b) => text(b) === "닫기");
        if (!close)
          return result(
            "확인 필요",
            "이전 뽑기 결과의 닫기 버튼을 찾지 못했습니다.",
          );
        check();
        close.click();
        if (!(await waitFor(() => !rewardView(), 5000)))
          return result("확인 필요", "이전 결과 창이 닫히지 않았습니다.");
      }
      const ready = await waitFor(() => {
        const popup = rewardView();
        if (popup) {
          const more = buttons(popup.panel).filter(
            (b) => norm(b) === moreLabel && enabled(b),
          );
          return more.length === 1 ? more[0] : null;
        }
        if (dialogs().length) return null;
        const main = buttons().filter(
          (b) => norm(b) === mainLabel && enabled(b),
        );
        return main.length === 1 ? main[0] : null;
      }, 15000);
      if (!ready) return result("확인 필요", "뽑기 버튼 비활성/팝업 확인 필요");
      check();
      const entry = {
        index: previous + 1,
        time: new Date().toISOString(),
        cost: null,
        reward: null,
        flakes: null,
        state: "요청 중",
      };
      currentRun.records.push(entry);
      saveRun();
      ready.click();
      // 클릭 횟수가 아닌 서버에서 반영한 오늘 횟수 증가를 확인한 뒤에만 다음 클릭.
      const advanced = await waitFor(() => {
        const next = drawCount();
        return next && next.used > previous ? next : null;
      }, 20000);
      if (!advanced) {
        entry.state = "횟수 미확인";
        saveRun();
        return result(
          "확인 필요",
          `클릭 후 횟수 증가 미확인 (${previous}/30). 추가 클릭 중지`,
        );
      }
      if (advanced.used !== previous + 1) {
        entry.state = "동시 참여 감지";
        saveRun();
        return result(
          "확인 필요",
          "다른 곳에서 뽑기가 진행된 것으로 보입니다. 기록 혼선을 막기 위해 중단합니다.",
        );
      }
      entry.cost = Number(job.mode);
      entry.state = "결과 확인 중";
      saveRun();
      // 회차 증가 직후 UI 렌더링이 안정될 때까지 두 번 같은 결과를 읽는다.
      // 결과 문자열이 이전 회차와 같아도 새 회차의 정상 당첨으로 기록한다.
      let candidate = null;
      let stableSince = 0;
      const readSettledReward = () => {
        const view = rewardView();
        if (!view) {
          candidate = null;
          stableSince = 0;
          return null;
        }
        if (
          !candidate ||
          candidate.panel !== view.panel ||
          candidate.label !== view.label
        ) {
          candidate = view;
          stableSince = Date.now();
          return null;
        }
        return Date.now() - stableSince >= 250 ? view : null;
      };
      const settledDrawResult = await waitFor(readSettledReward, 15000, 50);
      if (!settledDrawResult) {
        entry.state = "보상 미확인";
        saveRun();
        return result(
          "확인 필요",
          "횟수와 사용량은 확인했으나 당첨 결과를 읽지 못해 중단했습니다.",
        );
      }
      entry.reward = settledDrawResult.label;
      entry.flakes = parseFlakes(settledDrawResult.label);
      entry.state = "확인됨";
      saveRun();
      log(
        `${previous + 1}/30회 · 사용 ${job.mode} · 당첨 ${settledDrawResult.label}`,
      );
      count = advanced;
      // 결과 기록을 마쳤으면 다음 회차로 이동.
      // 다음 반복에서도 활성 버튼과 서버 회차 증가를 확인한다.
    }
    count = drawCount();
    if (count?.used === 30)
      return result(
        "완료됨",
        `오늘 30/30회 · 이번 실행 ${30 - initial}회 (${job.mode} 플레이크)`,
      );
    return result("확인 필요", "최종 30/30회 확인 실패");
  }
  function rewardView() {
    for (const panel of dialogs()) {
      const field = panel.querySelector(
        ".l1l2-flakehub-popup-common-received_reward",
      );
      if (field && visible(field)) {
        const label = (field.textContent || "").trim();
        if (label) return { panel, label };
      }
    }
    return null;
  }
  function parseFlakes(label) {
    const match = label
      .replace(/,/g, "")
      .trim()
      .match(/^(\d+)\s*플레이크$/);
    return match ? Number(match[1]) : null;
  }
  function history() {
    const value = GM_getValue(HISTORY, []);
    return Array.isArray(value) ? value : [];
  }
  function saveRun() {
    if (!currentRun) return;
    const all = history(),
      index = all.findIndex((run) => run.id === currentRun.id);
    if (index < 0) all.push(currentRun);
    else all[index] = currentRun;
    GM_setValue(HISTORY, all.slice(-100));
    renderHistory();
  }
  function totals(run) {
    const records = run?.records || [];
    return {
      spent: records.reduce((sum, r) => sum + (r.cost || 0), 0),
      gained: records.reduce((sum, r) => sum + (r.flakes || 0), 0),
      unknown: records.filter((r) => r.state !== "확인됨").length,
      items: records
        .filter((r) => r.state === "확인됨" && r.flakes === null)
        .map((r) => r.reward),
    };
  }
  function runTime(run) {
    return new Date(run.started).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
    });
  }
  function renderHistory() {
    if (!historyBox) return;
    historyBox.replaceChildren();
    const all = history(),
      run = currentRun || all.at(-1);
    const title = document.createElement("strong");
    title.textContent = run ? "뽑기 기록 · " + runTime(run) : "뽑기 기록";
    historyBox.append(title);
    if (!run) {
      const p = document.createElement("div");
      p.textContent = "이 버전으로 실행한 뽑기부터 기록됩니다.";
      historyBox.append(p);
      return;
    }
    const sum = totals(run),
      numbers = document.createElement("div");
    numbers.style.cssText = "padding:8px 0;color:#c9edff;font-size:14px";
    numbers.textContent = `사용 ${sum.spent.toLocaleString()} · 획득 ${sum.gained.toLocaleString()} · ${sum.unknown ? "확인된 순이득" : "순이득"} ${(sum.gained - sum.spent).toLocaleString()} 플레이크`;
    historyBox.append(numbers);
    const items = document.createElement("div");
    items.textContent =
      "상품·쿠폰 등: " +
      (sum.items.length ? sum.items.join(", ") : "기록 없음");
    historyBox.append(items);
    if (sum.unknown) {
      const warning = document.createElement("div");
      warning.textContent = `미확인 ${sum.unknown}회 — 미확인 사용량·보상은 합계에서 제외`;
      historyBox.append(warning);
    }
    const detail = document.createElement("details"),
      caption = document.createElement("summary");
    caption.textContent = `회차별 결과 ${run.records.length}건`;
    detail.append(caption);
    for (const entry of run.records) {
      const line = document.createElement("div");
      line.textContent = `${entry.index}회 · 사용 ${entry.cost ?? "?"} · ${entry.reward || entry.state}`;
      detail.append(line);
    }
    historyBox.append(detail);
    const archive = document.createElement("details"),
      head = document.createElement("summary");
    head.textContent = `이전 실행 기록 (${all.length}개)`;
    archive.append(head);
    for (const saved of [...all].reverse()) {
      const b = document.createElement("button");
      b.textContent = runTime(saved);
      b.style.cssText =
        "display:block;background:#384557;color:white;padding:5px;border:1px solid #65748c;margin:3px";
      b.onclick = () => {
        if (!running) {
          currentRun = saved;
          renderHistory();
        }
      };
      archive.append(b);
    }
    historyBox.append(archive);
  }
  function exportHistory() {
    const blob = new Blob([JSON.stringify(history(), null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "stove-draw-history-" + today() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function worker() {
    const job = jobRead();
    if (
      !job ||
      job.path !== location.pathname ||
      job.host !== location.hostname
    )
      return;
    try {
      check();
      publish(result("스캔 중", "사이트 상태 확인 중"));
      const task =
        job.task === "missions"
          ? { bundle: true }
          : TASKS.find((t) => t.id === job.task);
      if (!task) throw new Error("알 수 없는 항목");
      const value = task.bundle
        ? await runMissionBatch(job)
        : task.game
          ? await runShop(job)
          : task.mission
            ? await runMission(task, job)
            : await runDraw(job);
      if (value) {
        check();
        GM_setValue(PREFIX + token, { ...jobRead(), result: value });
      }
    } catch (e) {
      const latest = jobRead();
      if (latest && !latest.cancelled)
        GM_setValue(PREFIX + token, {
          ...latest,
          result: result("확인 필요", e.message),
        });
    }
  }
  async function executeTask(task, scan, mode) {
    if (task.draw) {
      const value = await runDraw({ scan, mode });
      status(task.id, value);
      log(`${task.name}: ${value.state} — ${value.detail}`);
      return;
    }
    const id = crypto.randomUUID(),
      key = PREFIX + id,
      host = task.game ? "event.onstove.com" : "reward.onstove.com",
      path = task.game
        ? `/ko/dailyshop/${task.game}/${month()}`
        : task.draw
          ? "/ko/event"
          : "/ko";
    activeJobs.add(key);
    GM_setValue(key, {
      owner: leaseId,
      task: task.id,
      host,
      path,
      date: today(),
      scan,
      mode,
    });
    status(task.id, result("스캔 중", "최신 페이지를 여는 중"));
    let value, tab;
    try {
      tab = GM_openInTab(`https://${host}${path}#stoveDaily=${id}`, {
        active: false,
        insert: true,
        setParent: true,
      });
      const end = Date.now() + (task.id === "missions" ? 120000 : 75000);
      while (Date.now() < end) {
        check();
        const current = GM_getValue(key, null);
        if (current?.items)
          for (const [id, item] of Object.entries(current.items))
            status(id, item);
        if (current?.progress) status(task.id, current.progress);
        if (current?.result) {
          value = current.result;
          break;
        }
        if (tab?.closed) {
          value = result("확인 필요", "작업 탭이 닫혔습니다.");
          break;
        }
        await sleep(300);
      }
      value =
        value ||
        result("확인 필요", "응답 시간 초과 · 로그인/스크립트 실행 상태 확인");
      status(task.id, value);
      if (task.id === "missions" && value.state === "확인 필요") {
        const items = GM_getValue(key, null)?.items || {};
        for (const mission of TASKS.filter((t) => t.mission))
          if (
            !items[mission.id] ||
            ["스캔 중", "갱신 대기"].includes(items[mission.id].state)
          )
            status(mission.id, value);
      }
      log(`${task.name}: ${value.state} — ${value.detail}`);
    } finally {
      const current = GM_getValue(key, null);
      if (current) GM_setValue(key, { ...current, cancelled: true });
      if (value && value.state !== "확인 필요") {
        try {
          tab?.close();
        } catch (_) {}
      }
      GM_deleteValue(key);
      activeJobs.delete(key);
    }
  }
  async function runPlan(scan, mode, date, execute = executeTask) {
    check();
    if (today() !== date)
      throw new Error("날짜가 바뀌었습니다. 다시 실행하세요.");
    const shopTasks = TASKS.filter((task) => task.game);
    const shops = (async () => {
      for (const task of shopTasks) {
        check();
        await execute(task, scan, mode);
      }
    })();
    const results = await Promise.allSettled([
      shops,
      execute({ id: "missions", name: "미션 묶음" }, scan, mode),
      execute(
        TASKS.find((task) => task.draw),
        scan,
        mode,
      ),
    ]);
    check();
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
    if (today() !== date)
      throw new Error("날짜가 바뀌었습니다. 다시 실행하세요.");
  }
  async function start(scan = false) {
    if (running) return;
    if (location.hostname === "lostark.game.onstove.com") {
      const existing = GM_getValue(LOCK, null);
      if (existing && Date.now() - existing.time < 15000) {
        summary.textContent = "이미 다른 탭에서 일일 보상을 처리 중입니다.";
        log("다른 창에서 일일 보상 실행 중입니다. 새 탭을 열지 않았습니다.");
        return;
      }
      const id = crypto.randomUUID();
      const key = PREFIX + "launch:" + id;
      GM_setValue(key, { scan, mode: modeSelect.value, time: Date.now() });
      running = true;
      try {
        GM_openInTab("https://reward.onstove.com/ko/event#stoveLaunch=" + id, {
          active: true,
          insert: true,
          setParent: true,
        });
        summary.textContent = "새 탭에서 일괄 처리를 이어갑니다.";
        log(
          "선택한 금액과 실행 요청을 새 뽑기 탭으로 전달했습니다. 진행·결과는 새 탭에서 확인하세요.",
        );
      } catch (e) {
        GM_deleteValue(key);
        log("새 탭을 열지 못했습니다: " + e.message);
      } finally {
        setTimeout(() => {
          running = false;
        }, 2000);
        setTimeout(() => GM_deleteValue(key), 120000);
      }
      return;
    }
    if (
      location.hostname !== "reward.onstove.com" ||
      location.pathname !== "/ko/event"
    ) {
      if (location.hostname === "reward.onstove.com") {
        sessionStorage.setItem(
          PREFIX + "continue",
          JSON.stringify({ scan, mode: modeSelect.value, time: Date.now() }),
        );
        location.assign("https://reward.onstove.com/ko/event");
      } else
        log(
          "캡슐 뽑기 페이지에서 실행하세요: https://reward.onstove.com/ko/event",
        );
      return;
    }
    if (running) return;
    const existing = GM_getValue(LOCK, null);
    if (existing && Date.now() - existing.time < 15000) {
      summary.textContent = "이미 다른 탭에서 일일 보상을 처리 중입니다.";
      log("다른 창에서 일일 보상 실행 중입니다.");
      return;
    }
    running = true;
    leaseId = crypto.randomUUID();
    GM_setValue(LOCK, { id: leaseId, time: Date.now() });
    await sleep(300);
    if (GM_getValue(LOCK, null)?.id !== leaseId) {
      running = false;
      log("다른 창에서 실행을 시작했습니다.");
      return;
    }
    running = true;
    stopped = false;
    output.textContent = "";
    const mode = modeSelect.value;
    for (const b of modeButtons) b.disabled = true;
    const startDate = today();
    const heartbeat = setInterval(() => {
      if (GM_getValue(LOCK, null)?.id === leaseId)
        GM_setValue(LOCK, { id: leaseId, time: Date.now() });
    }, 1000);
    for (const task of TASKS) status(task.id, result("대기"));
    try {
      await runPlan(scan, mode, startDate);
    } catch (e) {
      log(e.message);
      for (const [id, row] of rows)
        if (["대기", "스캔 중", "뽑는 중", "방문 중"].includes(row.value.state))
          status(id, result("중단됨"));
    } finally {
      clearInterval(heartbeat);
      if (GM_getValue(LOCK, null)?.id === leaseId) GM_deleteValue(LOCK);
      running = false;
      for (const b of modeButtons) b.disabled = false;
      refreshRetryButtons();
      const count = [...rows.values()].filter(
        (r) => r.value.state === "완료됨",
      ).length;
      summary.textContent =
        count === TASKS.length
          ? "전체 완료됨"
          : `${scan ? "스캔" : "처리"} 종료 · 완료 ${count}/${TASKS.length}`;
    }
  }
  async function retryTask(id, execute = executeTask) {
    if (running) return;
    const task = TASKS.find((item) => item.id === id),
      row = rows.get(id);
    if (!task || row?.value?.state !== "확인 필요") return;
    if (
      location.hostname !== "reward.onstove.com" ||
      location.pathname !== "/ko/event"
    ) {
      log("재시도는 캡슐 뽑기 페이지의 결과 패널에서 실행하세요.");
      return;
    }
    const existing = GM_getValue(LOCK, null);
    if (existing && Date.now() - existing.time < 15000) {
      log("다른 창에서 일일 보상 실행 중입니다.");
      return;
    }
    running = true;
    stopped = false;
    leaseId = crypto.randomUUID();
    GM_setValue(LOCK, { id: leaseId, time: Date.now() });
    await sleep(300);
    if (GM_getValue(LOCK, null)?.id !== leaseId) {
      running = false;
      refreshRetryButtons();
      log("다른 창에서 실행을 시작했습니다.");
      return;
    }
    for (const b of modeButtons) b.disabled = true;
    refreshRetryButtons();
    const heartbeat = setInterval(() => {
      if (GM_getValue(LOCK, null)?.id === leaseId)
        GM_setValue(LOCK, { id: leaseId, time: Date.now() });
    }, 1000);
    status(id, result("재시도 중", "해당 항목만 다시 확인합니다."));
    try {
      const value = await execute(task, false, modeSelect.value);
      if (value) status(id, value);
    } catch (e) {
      status(id, result("확인 필요", e.message));
      log(`${task.name} 재시도 실패: ${e.message}`);
    } finally {
      clearInterval(heartbeat);
      if (GM_getValue(LOCK, null)?.id === leaseId) GM_deleteValue(LOCK);
      running = false;
      for (const b of modeButtons) b.disabled = false;
      refreshRetryButtons();
      const completed = [...rows.values()].filter(
        (item) => item.value?.state === "완료됨",
      ).length;
      summary.textContent =
        rows.get(id)?.value?.state === "완료됨"
          ? `${task.name} 재시도 완료 · 전체 ${completed}/${TASKS.length}`
          : `${task.name} 재시도 실패 · 버튼을 눌러 다시 시도할 수 있습니다.`;
    }
  }
  function stop() {
    stopped = true;
    for (const key of activeJobs) {
      const job = GM_getValue(key, null);
      if (job) GM_setValue(key, { ...job, cancelled: true });
    }
    log("중단 요청됨 · 이미 전송된 수령/뽑기 1회는 취소되지 않습니다.");
  }
  function init() {
    if (token) {
      worker();
      return;
    }
    if (document.getElementById("stove-daily-extension")) return;
    const panel = document.createElement("section");
    panel.id = "stove-daily-extension";
    panel.style.cssText =
      "position:fixed;left:16px;bottom:16px;box-sizing:border-box;width:350px;max-width:calc(100vw - 32px);max-height:85vh;overflow:auto;padding:12px;background:#20242c;color:white;z-index:999998;border-radius:10px;font:13px/1.5 sans-serif;box-shadow:0 2px 12px #0006";
    const title = document.createElement("strong");
    title.textContent = "Stove Daily Companion · 1.0.5";
    panel.append(title);
    summary = document.createElement("div");
    summary.textContent =
      location.hostname === "lostark.game.onstove.com"
        ? "시작하면 새 뽑기 탭에서 일괄 처리를 진행합니다."
        : "출석·미션 수령과 현재 탭 뽑기를 동시에 진행합니다.";
    summary.style.margin = "6px 0";
    panel.append(summary);
    modeSelect = { value: "100" };
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "뽑기 금액 선택");
    group.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin:8px 0";
    const updateChoice = (value) => {
      modeSelect.value = value;
      for (const b of modeButtons) {
        const chosen = b.dataset.value === value;
        b.setAttribute("aria-pressed", String(chosen));
        b.textContent = (chosen ? "✓ " : "") + b.dataset.label;
        b.style.cssText =
          "all:unset;box-sizing:border-box;display:block;font:700 13px/1.5 sans-serif;padding:9px 10px;border-radius:7px;border:2px solid " +
          (chosen ? "#86caff" : "#667489") +
          ";background:" +
          (chosen ? "#d9edff" : "#303d50") +
          ";color:" +
          (chosen ? "#09223e" : "#ffffff") +
          ";cursor:pointer";
      }
    };
    for (const [value, name] of [
      ["100", "100 플레이크"],
      ["1000", "1,000 플레이크"],
      ["none", "뽑기 안 함"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.value = value;
      b.dataset.label = name;
      b.onclick = () => {
        if (!running) {
          GM_setValue(PREFIX + "drawMode", value);
          updateChoice(value);
        }
      };
      modeButtons.push(b);
      group.append(b);
    }
    const savedMode = GM_getValue(PREFIX + "drawMode", "100");
    updateChoice(
      ["100", "1000", "none"].includes(savedMode) ? savedMode : "100",
    );
    panel.append(group);
    const hint = document.createElement("div");
    hint.textContent = "하루 30회 · 오늘 남은 횟수만 뽑기";
    hint.style.cssText = "font-size:11px;color:#bbc4d2;margin:5px 0";
    panel.append(hint);
    const statusGrid = document.createElement("div");
    statusGrid.id = "stove-daily-status-grid";
    statusGrid.style.cssText =
      "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:8px";
    for (const task of TASKS) {
      const row = document.createElement("div");
      row.style.cssText =
        "box-sizing:border-box;min-width:0;padding:7px;border:1px solid #ffffff20;border-radius:7px;background:#29303b";
      const heading = document.createElement("div");
      heading.style.cssText =
        "display:flex;align-items:flex-start;justify-content:space-between;gap:4px;min-width:0;font-size:12px";
      const name = document.createElement("span");
      name.textContent =
        {
          riichi: "마작 출석",
          indie: "스토어 출석",
          mission0: "게임 구경",
          mission1: "MY홈 방문",
          mission2: "메인 방문",
          mission3: "앱 로그인",
          mission4: "게임 플레이",
          draw: "캡슐 뽑기",
        }[task.id] || task.name;
      name.title = task.name;
      name.style.cssText = "min-width:0;overflow-wrap:anywhere";
      const badge = document.createElement("button");
      badge.type = "button";
      badge.disabled = true;
      badge.onclick = () => retryTask(task.id);
      badge.style.cssText =
        "all:unset;flex:0 0 auto;color:#afd2ff;white-space:nowrap;text-align:right;font-weight:700";
      badge.textContent = "미확인";
      const detail = document.createElement("div");
      detail.style.cssText =
        "font-size:11px;color:#bbc4d2;margin-top:3px;overflow-wrap:anywhere";
      heading.append(name, badge);
      row.append(heading, detail);
      statusGrid.append(row);
      rows.set(task.id, { badge, detail, value: result("미확인") });
    }
    panel.append(statusGrid);
    const controls = document.createElement("div");
    controls.style.cssText =
      "display:flex;flex-wrap:wrap;gap:6px;margin-top:10px";
    for (const [name, handler] of [
      ["일일 보상 한 번에 받기", () => start(false)],
      ["상태만 스캔", () => start(true)],
      ["중단", stop],
    ]) {
      const b = document.createElement("button");
      b.textContent = name;
      b.onclick = handler;
      b.style.cssText =
        "background:#176bc0;color:white;border:0;border-radius:5px;padding:7px;cursor:pointer";
      controls.append(b);
    }
    panel.append(controls);
    historyBox = document.createElement("div");
    historyBox.style.cssText =
      "margin-top:12px;border-top:1px solid #ffffff40;padding-top:10px";
    panel.append(historyBox);
    const exportButton = document.createElement("button");
    exportButton.textContent = "기록 JSON 저장";
    exportButton.style.cssText =
      "background:#384557;color:white;padding:6px;border:1px solid #65748c;margin:6px 0";
    exportButton.onclick = exportHistory;
    panel.append(exportButton);
    const details = document.createElement("details"),
      caption = document.createElement("summary");
    caption.textContent = "상세 로그";
    details.append(caption);
    output = document.createElement("pre");
    output.style.cssText =
      "white-space:pre-wrap;max-height:120px;overflow:auto;font:11px/1.4 sans-serif";
    details.append(output);
    panel.append(details);
    const expandedContent = document.createElement("div");
    expandedContent.id = "stove-daily-expanded-content";
    expandedContent.append(...panel.childNodes);
    const compactBar = document.createElement("div");
    compactBar.style.cssText =
      "display:flex;align-items:center;justify-content:flex-end;gap:6px";
    const foldButton = document.createElement("button");
    foldButton.type = "button";
    foldButton.setAttribute("aria-controls", expandedContent.id);
    foldButton.style.cssText =
      "all:unset;cursor:pointer;color:#c4ddfa;font:12px/1.5 sans-serif;padding:4px 6px;white-space:nowrap";
    const runButton = controls.querySelector("button");
    let collapsed = !!GM_getValue(PREFIX + "collapsed", false);
    const updateFold = () => {
      expandedContent.hidden = collapsed;
      expandedContent.style.display = collapsed ? "none" : "block";
      panel.style.width = collapsed ? "max-content" : "350px";
      panel.style.padding = collapsed ? "7px" : "12px";
      foldButton.textContent = collapsed ? "펼치기" : "접기";
      foldButton.setAttribute("aria-expanded", String(!collapsed));
      if (collapsed) compactBar.prepend(runButton);
      else controls.prepend(runButton);
    };
    foldButton.onclick = () => {
      collapsed = !collapsed;
      GM_setValue(PREFIX + "collapsed", collapsed);
      updateFold();
    };
    compactBar.append(foldButton);
    panel.append(compactBar, expandedContent);
    updateFold();
    document.body.append(panel);
    renderHistory();
    window.addEventListener("pagehide", () => {
      if (running) stop();
    });
    if (
      location.hostname === "reward.onstove.com" &&
      location.pathname === "/ko/event"
    ) {
      const launchId = new URLSearchParams(location.hash.slice(1)).get(
        "stoveLaunch",
      );
      if (launchId) {
        const key = PREFIX + "launch:" + launchId;
        const launch = GM_getValue(key, null);
        GM_deleteValue(key);
        if (
          launch &&
          Date.now() - launch.time >= 0 &&
          Date.now() - launch.time < 120000 &&
          ["100", "1000", "none"].includes(launch.mode) &&
          typeof launch.scan === "boolean"
        ) {
          updateChoice(launch.mode);
          start(launch.scan);
        } else
          log(
            "실행 요청이 만료되었거나 이미 사용되었습니다. 실행 버튼을 다시 누르세요.",
          );
        return;
      }
      const pending = sessionStorage.getItem(PREFIX + "continue");
      sessionStorage.removeItem(PREFIX + "continue");
      if (pending) {
        try {
          const p = JSON.parse(pending);
          if (
            Date.now() - p.time < 60000 &&
            ["100", "1000", "none"].includes(p.mode)
          ) {
            updateChoice(p.mode);
            start(!!p.scan);
          }
        } catch (_) {}
      }
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
