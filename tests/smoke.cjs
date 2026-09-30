const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
let code = fs.readFileSync(
  path.join(__dirname, "..", "stove-daily-companion.user.js"),
  "utf8",
);
const entry = code.lastIndexOf("if (document.readyState");
const matches = [...code.matchAll(/^\/\/ @match\s+(\S+)/gm)].map((m) => m[1]);
if (entry < 0) throw new Error("Initialization entry not found");
code =
  code.slice(0, entry) +
  "globalThis.h={init,start,stop,today,runPlan,runMissionBatch,month,runDraw,claim,runShop,runMilestones,runMission,trackVisitTabs,shopButton,missionButton,drawCount,closeOfferwall,parseFlakes,totals,history,executeTask,status,retryTask,discoverClickMissions,syncMissionCatalog,failedTasks};})();";
let passed = 0;
const missionID = (name) => "click:" + encodeURIComponent(name);
function missionHTML(names, button = "받기") {
  return (
    '<div id="mission-widget-349"><span>클릭하고 매일 보상받기!</span>' +
    names
      .map(
        (name) =>
          `<div class="stds-box"><p>${name}</p><p>방문 보상 안내</p><button>${button}</button></div>`,
      )
      .join("") +
    "</div>"
  );
}
function octoberMissions(button = "받기") {
  const names = [
    "오늘의 1등 참여하기",
    "스토어 온라인 게임관 방문하기",
    "스토브 메인 방문하기",
    "앱 미니게임 플레이하기",
    "스토브 앱 로그인하기",
    "경품 응모하기",
  ];
  return (
    '<div id="mission-widget-377"><span>데일리 미션 참여하고 매일 보상받기!</span>' +
    names
      .map(
        (name) =>
          `<div class="stds-box"><p>${name}</p><p>${name} 미션 조건</p><button>${button}</button></div>`,
      )
      .join("") +
    "</div>"
  );
}
function fixture(html = "", options = {}) {
  const dom = new JSDOM(html, {
      url: options.url || "https://reward.onstove.com/ko/event",
      runScripts: "outside-only",
    }),
    w = dom.window,
    store = options.store || new Map();
  let now = options.time ?? Date.UTC(2026, 8, 5, 10);
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  w.Date = Clock;
  w.setTimeout = (fn, ms) => {
    now += ms;
    queueMicrotask(fn);
  };
  w.GM_getValue = (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d);
  w.GM_setValue = (k, v) => store.set(k, structuredClone(v));
  w.GM_deleteValue = (k) => store.delete(k);
  w.HTMLElement.prototype.getClientRects = function () {
    return !this.isConnected || this.closest("[hidden]") ? [] : [{}];
  };
  w.console.log = () => {};
  w.eval(code);
  return { w, h: w.h, doc: w.document, store, close: () => w.close() };
}
async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS", name);
}
function drawFixture(
  initial,
  mode,
  rewards = ["100 플레이크"],
  advance = true,
) {
  const f = fixture(
    `<div class="stds-box">오늘 뽑기 <span id="count">${initial}</span>/30회</div><button id="draw">${mode === "1000" ? "1,000" : "100"} 뽑기</button>`,
  );
  let clicks = 0;
  f.doc.querySelector("#draw").onclick = () => {
    clicks++;
    if (!advance) return;
    f.doc.querySelector("#count").textContent = initial + clicks;
    const p = f.doc.createElement("div");
    p.className = "stds-dialog-panel";
    const r = f.doc.createElement("span");
    r.className = "l1l2-flakehub-popup-common-received_reward";
    r.textContent = rewards[(clicks - 1) % rewards.length];
    p.append(r);
    const close = f.doc.createElement("button");
    close.textContent = "닫기";
    close.onclick = () => p.remove();
    p.append(close);
    f.doc.body.append(p);
  };
  return Object.assign(f, { clicks: () => clicks });
}
(async () => {
  for (const mode of ["100", "1000"])
    await test(`팝업 유지 ${mode} 한번 더 / 동일 보상 5회 기록`, async () => {
      const label = mode === "1000" ? "1,000" : "100";
      const f = fixture(
        `<div class="stds-box">오늘 뽑기 <span id="count">25</span>/30회</div><button id="main">${label} 뽑기</button><div class="stds-dialog-panel"><span class="l1l2-flakehub-popup-common-received_reward">100 플레이크</span><button id="more">${label} 뽑기 한번 더!</button><button id="close">닫기</button></div>`,
      );
      let n = 0;
      const panel = f.doc.querySelector(".stds-dialog-panel");
      f.doc.querySelector("#main").onclick = () => {
        throw Error("메인 재클릭 금지");
      };
      f.doc.querySelector("#close").onclick = () => {
        throw Error("팝업 닫기 금지");
      };
      f.doc.querySelector("#more").onclick = () => {
        n++;
        f.doc.querySelector("#count").textContent = 25 + n;
      };
      assert.equal((await f.h.runDraw({ mode })).state, "완료됨");
      assert.equal(n, 5);
      assert.equal(f.doc.querySelector(".stds-dialog-panel"), panel);
      const run = f.h.history().at(-1);
      assert.equal(run.records.length, 5);
      assert.equal(f.h.totals(run).gained, 500);
      assert.equal(f.h.totals(run).spent, 5 * Number(mode));
      f.close();
    });
  await test("한번 더 요청 후 회차 미증가 시 재클릭 금지", async () => {
    const f = fixture(
      '<div class="stds-box">오늘 뽑기 10/30회</div><div class="stds-dialog-panel"><span class="l1l2-flakehub-popup-common-received_reward">100 플레이크</span><button>100 뽑기 한번 더!</button></div>',
    );
    let n = 0;
    f.doc.querySelector("button").onclick = () => n++;
    assert.equal((await f.h.runDraw({ mode: "100" })).state, "확인 필요");
    assert.equal(n, 1);
    assert.equal(f.h.totals(f.h.history().at(-1)).gained, 0);
    f.close();
  });
  await test("비활성 한번 더 버튼은 활성화 우회하지 않음", async () => {
    const f = fixture(
      '<div class="stds-box">오늘 뽑기 10/30회</div><button>100 뽑기</button><div class="stds-dialog-panel"><span class="l1l2-flakehub-popup-common-received_reward">100 플레이크</span><button disabled>100 뽑기 한번 더!</button></div>',
    );
    let n = 0;
    for (const b of f.doc.querySelectorAll("button")) b.onclick = () => n++;
    assert.equal((await f.h.runDraw({ mode: "100" })).state, "확인 필요");
    assert.equal(n, 0);
    f.close();
  });
  await test("방문 미션은 묶어서 1회 갱신 / 완료 항목 재처리 금지", async () => {
    const names = [
      "다양한 게임 보러가기",
      "MY홈 방문하기",
      "스토브 메인 방문하기",
      "스토브 앱 로그인하기",
      "게임 플레이하기",
    ];
    const f = fixture(missionHTML(names, "미션하기"), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const job = { owner: "owner", date: f.h.today(), task: "missions" };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    let reloads = 0;
    const calls = [];
    const perform = async (task, context) => {
      calls.push(task.id);
      return { state: !context.visited ? "갱신 대기" : "완료됨" };
    };
    assert.equal(
      await f.h.runMissionBatch(job, perform, () => reloads++),
      null,
    );
    await f.h.runMissionBatch(
      f.store.get("stove_daily_v2:batch"),
      perform,
      () => reloads++,
    );
    assert.equal(reloads, 1);
    assert.equal(calls.length, 10);
    assert.equal(calls.filter((id) => id === missionID(names[3])).length, 2);
    f.close();
  });
  await test("뽑기·미션·출석 동시 시작 / 모든 작업 완료까지 대기", async () => {
    const f = fixture(),
      started = [],
      releases = [];
    const pending = f.h.runPlan(false, "100", f.h.today(), (task) => {
      started.push(task.id);
      return new Promise((resolve) => releases.push(resolve));
    });
    let finished = false;
    pending.then(() => {
      finished = true;
    });
    assert.deepEqual(started, ["riichi", "missions", "draw"]);
    releases[0]();
    await new Promise(setImmediate);
    assert.deepEqual(started, ["riichi", "missions", "draw", "indie"]);
    releases[1]();
    releases[2]();
    await new Promise(setImmediate);
    assert.equal(finished, false);
    releases[3]();
    await pending;
    assert.equal(finished, true);
    f.close();
  });
  await test("병렬 처리 중 중단하면 후속 출석 시작 금지", async () => {
    const f = fixture(),
      started = [],
      releases = [];
    const pending = f.h.runPlan(false, "100", f.h.today(), (task) => {
      started.push(task.id);
      return new Promise((resolve) => releases.push(resolve));
    });
    f.h.stop();
    releases.forEach((resolve) => resolve());
    await assert.rejects(pending, /중단됨/);
    assert(started.includes("draw"));
    assert(!started.includes("indie"));
    f.close();
  });
  await test("뽑기 실패 시 다른 보상 작업이 끝날 때까지 대기", async () => {
    const f = fixture(),
      releases = [];
    let ended = false;
    const pending = f.h.runPlan(false, "100", f.h.today(), (task) => {
      if (task.draw) return Promise.reject(new Error("뽑기 오류"));
      return new Promise((resolve) => releases.push(resolve));
    });
    const checked = assert.rejects(pending, /뽑기 오류/).then(() => {
      ended = true;
    });
    await new Promise(setImmediate);
    assert.equal(ended, false);
    releases[0]();
    await new Promise(setImmediate);
    releases[1]();
    assert.equal(ended, false);
    releases[2]();
    await checked;
    f.close();
  });
  await test("한 미션 탭에서 5개 수령 직렬 처리 및 결과 전달", async () => {
    const names = [
      "다양한 게임 보러가기",
      "MY홈 방문하기",
      "스토브 메인 방문하기",
      "스토브 앱 로그인하기",
      "게임 플레이하기",
    ];
    const f = fixture(missionHTML(names), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const job = {
      owner: "owner",
      date: f.h.today(),
      task: "missions",
      items: {},
    };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    let active = 0,
      max = 0,
      clicks = 0;
    for (const b of f.doc.querySelectorAll("button"))
      b.onclick = () => {
        active++;
        max = Math.max(max, active);
        clicks++;
        queueMicrotask(() => {
          b.textContent = "받기 완료";
          active--;
        });
      };
    await f.h.runMissionBatch(job);
    assert.equal(clicks, 5);
    assert.equal(max, 1);
    assert.equal(
      Object.values(f.store.get("stove_daily_v2:batch").items).filter(
        (v) => v.state === "완료됨",
      ).length,
      5,
    );
    f.close();
  });
  await test("클릭 보상 자동 발견과 외부 영역 제외 / 현재 목록만 수령", async () => {
    const names = [
      "다양한 게임 보러가기",
      "MY홈 방문하기",
      "스토브 메인 방문하기",
      "오늘의 1등 미리보기",
      "이클립스 공식 홈페이지 방문하기",
    ];
    const html =
      '<div id="mission-widget-999"><span>클릭하고 매일 보상받기!</span>' +
      names
        .map(
          (name) =>
            `<div class="stds-box"><p>${name}</p><p>안내</p><button>받기</button></div>`,
        )
        .join("") +
      '</div><div><p>스토브 앱 로그인하기</p><button>받기</button></div><div class="stds-box"><p>경품 응모하기</p><button id="outside">미션하기</button></div>';
    const f = fixture(html, {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const job = { owner: "owner", date: f.h.today(), task: "missions" };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    let clicks = 0;
    for (const b of f.doc.querySelectorAll("button"))
      b.onclick = () => {
        assert.notEqual(b.id, "outside");
        clicks++;
        b.textContent = "받기 완료";
      };
    assert.equal(f.h.discoverClickMissions().length, 5);
    await f.h.runMissionBatch(job);
    const saved = f.store.get("stove_daily_v2:batch");
    assert.equal(saved.catalog.length, 5);
    assert.equal(Object.keys(saved.items).length, 5);
    assert.equal(saved.items.mission4, undefined);
    assert.equal(
      Object.values(saved.items).filter((x) => x.state === "완료됨").length,
      5,
    );
    assert.equal(clicks, 5);
    f.close();
  });
  await test("동적 클릭 목록은 개수·완료·남음·실패를 표시하고 누락은 실패와 구분", () => {
    const f = fixture();
    f.h.init();
    const catalog = [
      {
        id: "mission0",
        name: "다양한 게임 보러가기",
        mission: true,
        visit: true,
      },
      {
        id: "click:new",
        name: "새 방문 미션",
        mission: true,
        visit: true,
        dynamic: true,
      },
    ];
    f.h.syncMissionCatalog(catalog);
    f.h.status("mission0", { state: "완료됨" });
    f.h.status("click:new", { state: "확인 필요" });
    f.h.status("mission4", { state: "탐지 안 됨" });
    const report = f.doc.querySelector(
      "#stove-daily-click-summary",
    ).textContent;
    assert(report.includes("일일 미션 2개"));
    assert(report.includes("수령 완료 1"));
    assert(report.includes("남음 1"));
    assert(report.includes("재시도 1"));
    assert.equal(
      f.doc.querySelector("#stove-daily-click-grid").children.length,
      2,
    );
    assert.equal(f.h.failedTasks().length, 1);
    assert(
      [...f.doc.querySelectorAll("button")].some(
        (b) => b.textContent === "실패 항목 다시 받기",
      ),
    );
    f.close();
  });
  await test("메인 일괄 재시도는 실패 두 건만 실행 / 완료 뽑기와 탐지 안 됨 제외", async () => {
    const f = fixture();
    f.h.init();
    f.h.status("riichi", { state: "확인 필요" });
    f.h.status("indie", { state: "확인 필요" });
    f.h.status("draw", { state: "완료됨" });
    f.h.status("mission4", { state: "탐지 안 됨" });
    const calls = [];
    f.w.GM_openInTab = (url) => {
      const id = new URL(url).hash.split("=")[1];
      const key = "stove_daily_v2:" + id;
      const job = f.store.get(key);
      calls.push(job.task);
      f.store.set(key, {
        ...job,
        result: { state: "완료됨", detail: "완료 확인" },
      });
      return { close() {}, closed: false };
    };
    const main = [...f.doc.querySelectorAll("button")].find(
      (b) => b.textContent === "실패 항목 다시 받기",
    );
    await main.onclick();
    assert.deepEqual(calls, ["riichi", "indie"]);
    assert.equal(main.textContent, "일일 보상 한 번에 받기");
    assert.equal(f.h.failedTasks().length, 0);
    f.close();
  });
  await test("일괄 재시도 중 중단하면 다음 실패 항목은 실행하지 않음", async () => {
    const f = fixture();
    f.h.init();
    f.h.status("riichi", { state: "확인 필요" });
    f.h.status("indie", { state: "확인 필요" });
    const calls = [];
    await f.h.retryTask(["riichi", "indie"], async (task) => {
      calls.push(task.id);
      f.h.stop();
      return { state: "완료됨" };
    });
    assert.deepEqual(calls, ["riichi"]);
    assert.equal(f.h.failedTasks().length, 1);
    f.close();
  });
  await test("미션 수령 성공 안내만 있고 완료 표시가 없으면 재시도 필요", async () => {
    const f = fixture(
      "<div><p>스토브 앱 로그인하기</p><button>받기</button></div>",
    );
    f.doc.querySelector("button").onclick = () => {
      const modal = f.doc.createElement("div");
      modal.className = "stds-dialog-panel";
      modal.innerHTML = "지급되었습니다<button>확인</button>";
      modal.querySelector("button").onclick = () => modal.remove();
      f.doc.body.append(modal);
    };
    assert.equal(
      (await f.h.runMission({ name: "스토브 앱 로그인하기" }, {})).state,
      "확인 필요",
    );
    f.close();
  });
  await test("10월 통합 데일리 목록 6개만 탐지 / 위클리 제외", () => {
    const f = fixture(
      octoberMissions("미션하기") +
        '<div id="mission-widget-380"><span>위클리 미션 참여하고 보상받기!</span><div class="stds-box"><p>매일 스토브 앱 로그인하기</p><button>미션하기</button></div></div>',
    );
    const catalog = f.h.discoverClickMissions();
    assert.equal(catalog.length, 6);
    assert.deepEqual(
      Array.from(catalog, (t) => t.name),
      [
        "오늘의 1등 참여하기",
        "스토어 온라인 게임관 방문하기",
        "스토브 메인 방문하기",
        "앱 미니게임 플레이하기",
        "스토브 앱 로그인하기",
        "경품 응모하기",
      ],
    );
    f.close();
  });
  await test("새 목록 스캔은 현재 6개만 확인 / 사라진 미션을 추가하지 않음", async () => {
    const f = fixture(octoberMissions(), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const job = {
      owner: "owner",
      date: f.h.today(),
      task: "missions",
      scan: true,
    };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    const began = f.w.Date.now();
    await f.h.runMissionBatch(job);
    const saved = f.store.get("stove_daily_v2:batch");
    assert.equal(saved.catalog.length, 6);
    assert.equal(Object.keys(saved.items).length, 6);
    assert.equal(saved.items.mission0, undefined);
    assert.equal(saved.items.mission1, undefined);
    assert.equal(
      saved.items[missionID("스토브 메인 방문하기")].state,
      "수령 가능",
    );
    assert(f.w.Date.now() - began < 1000);
    f.close();
  });
  await test("개별 확인에서도 없는 미션은 로딩 완료 즉시 판정", async () => {
    const f = fixture(octoberMissions());
    const began = f.w.Date.now();
    assert.equal(
      (await f.h.runMission({ name: "다양한 게임 보러가기", visit: true }, {}))
        .state,
      "탐지 안 됨",
    );
    assert(f.w.Date.now() - began < 1000);
    f.close();
  });
  await test("묶음 재시도는 선택한 미션만 수령하고 다른 받기 버튼은 유지", async () => {
    const f = fixture(octoberMissions(), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const catalog = f.h.discoverClickMissions();
    const selectedTasks = catalog.filter((t) => t.name.includes("방문하기"));
    const job = {
      owner: "owner",
      date: f.h.today(),
      task: "missions",
      selectedTasks,
    };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    const clicks = [];
    for (const card of f.doc.querySelectorAll(".stds-box"))
      card.querySelector("button").onclick = (e) => {
        clicks.push(card.querySelector("p").textContent);
        e.target.textContent = "받기 완료";
      };
    await f.h.runMissionBatch(job);
    assert.deepEqual(clicks, [
      "스토어 온라인 게임관 방문하기",
      "스토브 메인 방문하기",
    ]);
    assert.equal(
      Object.keys(f.store.get("stove_daily_v2:batch").items).length,
      2,
    );
    assert.equal(f.h.missionButton("스토브 앱 로그인하기").textContent, "받기");
    f.close();
  });
  await test("일괄 미션 재시도는 작업 탭 한 개 / 완료 출석과 뽑기 제외", async () => {
    const f = fixture();
    f.h.init();
    f.h.syncMissionCatalog([
      { id: "mission0", name: "첫 미션", mission: true, dynamic: true },
      { id: "mission2", name: "둘째 미션", mission: true, dynamic: true },
    ]);
    f.h.status("mission0", { state: "확인 필요" });
    f.h.status("mission2", { state: "확인 필요" });
    f.h.status("draw", { state: "완료됨" });
    const opened = [];
    f.w.GM_openInTab = (url) => {
      const key = "stove_daily_v2:" + new URL(url).hash.split("=")[1];
      const job = f.store.get(key);
      opened.push(job);
      assert.equal(job.task, "missions");
      assert.deepEqual(
        job.selectedTasks.map((t) => t.id),
        ["mission0", "mission2"],
      );
      f.store.set(key, {
        ...job,
        items: {
          mission0: { state: "탐지 안 됨" },
          mission2: { state: "완료됨" },
        },
        result: { state: "처리 종료" },
      });
      return { closed: false, close() {} };
    };
    await f.h.retryTask(["mission0", "mission2"]);
    assert.equal(opened.length, 1);
    assert.equal(f.h.failedTasks().length, 0);
    f.close();
  });
  await test("묶음 재시도 방문 후 새로고침은 한 번 / 완료 항목 재방문 금지", async () => {
    const f = fixture(octoberMissions("미션하기"), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const selectedTasks = f.h
      .discoverClickMissions()
      .filter((t) => t.name.includes("방문하기"));
    const job = {
      owner: "owner",
      date: f.h.today(),
      task: "missions",
      selectedTasks,
    };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    let reloads = 0;
    const calls = [];
    const perform = async (task, context) => {
      calls.push(task.id);
      return { state: context.visited ? "완료됨" : "갱신 대기" };
    };
    assert.equal(
      await f.h.runMissionBatch(job, perform, () => reloads++),
      null,
    );
    await f.h.runMissionBatch(
      f.store.get("stove_daily_v2:batch"),
      perform,
      () => reloads++,
    );
    assert.equal(reloads, 1);
    assert.equal(calls.length, 4);
    assert.equal(
      Object.keys(f.store.get("stove_daily_v2:batch").items).length,
      2,
    );
    f.close();
  });
  await test("참여·앱 미션도 먼저 링크 방문 / 새로고침 후 수령 또는 조건 미충족", async () => {
    const names = ["오늘의 1등 참여하기", "앱 미니게임 플레이하기"];
    const f = fixture(missionHTML(names, "미션하기"), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const job = { owner: "owner", date: f.h.today(), task: "missions" };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    f.w.unsafeWindow = f.w;
    const original = f.w.open;
    let visits = 0,
      closed = 0,
      claims = 0,
      reloads = 0;
    f.w.GM_openInTab = () => {
      visits++;
      return {
        close() {
          closed++;
        },
      };
    };
    for (const b of f.doc.querySelectorAll("button"))
      b.onclick = () => {
        if (b.textContent === "미션하기")
          f.w.open("https://reward.onstove.com/ko/today", "_blank");
        else {
          claims++;
          b.textContent = "받기 완료";
        }
      };
    const reload = () => {
      reloads++;
      f.h.missionButton(names[0]).textContent = "받기";
    };
    assert.equal(await f.h.runMissionBatch(job, undefined, reload), null);
    let saved = f.store.get("stove_daily_v2:batch");
    assert(Object.values(saved.items).every((v) => v.state === "갱신 대기"));
    await f.h.runMissionBatch(saved, undefined, reload);
    saved = f.store.get("stove_daily_v2:batch");
    assert.equal(saved.items[missionID(names[0])].state, "완료됨");
    assert.equal(saved.items[missionID(names[1])].state, "조건 미충족");
    assert.equal(visits, 2);
    assert.equal(closed, 2);
    assert.equal(claims, 1);
    assert.equal(reloads, 1);
    assert.equal(f.w.open, original);
    f.close();
  });
  await test("미션 스캔에서는 참여 링크도 열지 않음", async () => {
    const f = fixture(octoberMissions("미션하기"), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const job = {
      owner: "owner",
      date: f.h.today(),
      task: "missions",
      scan: true,
    };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    for (const b of f.doc.querySelectorAll("button"))
      b.onclick = () => {
        throw Error("스캔 중 클릭 금지");
      };
    await f.h.runMissionBatch(job);
    assert(
      Object.values(f.store.get("stove_daily_v2:batch").items).every(
        (v) => v.state === "미완료",
      ),
    );
    f.close();
  });
  await test("목록 갱신 시 사라진 상태 칸·실패 항목 제거 / 기존 완료 상태 유지", () => {
    const f = fixture(octoberMissions());
    f.h.init();
    const catalog = f.h.discoverClickMissions();
    f.h.syncMissionCatalog(catalog);
    f.h.status(catalog[0].id, { state: "확인 필요" });
    f.h.status(catalog[1].id, { state: "완료됨" });
    f.h.syncMissionCatalog(catalog.slice(1));
    const grid = f.doc.querySelector("#stove-daily-click-grid");
    assert.equal(grid.children.length, 5);
    assert(!grid.textContent.includes(catalog[0].name));
    assert.equal(f.h.failedTasks().length, 0);
    assert(
      f.doc
        .querySelector("#stove-daily-click-summary")
        .textContent.includes("수령 완료 1"),
    );
    f.h.syncMissionCatalog([]);
    assert.equal(grid.children.length, 0);
    assert.equal(
      f.doc.querySelector("#stove-daily-status-grid").children.length,
      3,
    );
    f.close();
  });
  await test("재시도 중 사라진 미션은 목록과 결과에서 제외 / 이전 목록 부활 금지", async () => {
    const f = fixture(octoberMissions(), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const current = f.h.discoverClickMissions()[0];
    const old = {
      id: "click:old",
      name: "없어진 미션",
      mission: true,
      dynamic: true,
    };
    const job = {
      owner: "owner",
      date: f.h.today(),
      task: "missions",
      selectedTasks: [current, old],
      catalog: [old],
      items: { [old.id]: { state: "갱신 대기" } },
    };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    const calls = [];
    await f.h.runMissionBatch(job, async (task) => {
      calls.push(task.id);
      return { state: "완료됨" };
    });
    assert.deepEqual(calls, [current.id]);
    assert.deepEqual(Object.keys(f.store.get("stove_daily_v2:batch").items), [
      current.id,
    ]);
    f.close();
  });
  await test("목록 로딩 실패도 메인 재시도 가능 / 성공하면 오류 칸 제거", async () => {
    const f = fixture();
    f.h.init();
    f.h.status("riichi", { state: "확인 필요" });
    f.w.GM_openInTab = (url) => {
      const key = "stove_daily_v2:" + new URL(url).hash.split("=")[1];
      f.store.set(key, {
        ...f.store.get(key),
        result: { state: "확인 필요", detail: "미션 목록 로딩 실패" },
      });
      return { closed: false, close() {} };
    };
    await f.h.executeTask({ id: "missions", name: "미션 묶음" }, false, "100");
    assert(f.h.failedTasks().some((t) => t.id === "missions"));
    const task = {
      id: "click:new",
      name: "현재 미션",
      mission: true,
      dynamic: true,
    };
    f.w.GM_openInTab = (url) => {
      const key = "stove_daily_v2:" + new URL(url).hash.split("=")[1];
      f.store.set(key, {
        ...f.store.get(key),
        catalog: [task],
        items: { [task.id]: { state: "완료됨" } },
        result: { state: "처리 종료" },
      });
      return { closed: false, close() {} };
    };
    await f.h.retryTask("missions");
    assert.deepEqual(
      Array.from(f.h.failedTasks(), (t) => t.id),
      ["riichi"],
    );
    const grid = f.doc.querySelector("#stove-daily-click-grid");
    assert.equal(grid.children.length, 1);
    assert(grid.textContent.includes("현재 미션"));
    f.close();
  });
  await test("앱 안내 링크를 분리된 a.click으로 열어도 방문 후 탭 닫기", async () => {
    const f = fixture(missionHTML(["앱 미니게임 플레이하기"], "미션하기"));
    f.h.init();
    f.w.unsafeWindow = f.w;
    const originalOpen = f.w.open;
    const originalClick = f.w.HTMLAnchorElement.prototype.click;
    const opened = [];
    let closed = 0;
    f.w.GM_openInTab = (url) => {
      opened.push(url);
      return {
        close() {
          closed++;
        },
      };
    };
    const b = f.h.missionButton("앱 미니게임 플레이하기");
    b.onclick = () => {
      const a = f.doc.createElement("a");
      a.href = "https://store.onstove.com/ko/stoveApp";
      a.target = "_blank";
      a.click();
    };
    assert.equal(
      (
        await f.h.runMission(
          { name: "앱 미니게임 플레이하기" },
          { bundle: true },
        )
      ).state,
      "갱신 대기",
    );
    assert.deepEqual(opened, ["https://store.onstove.com/ko/stoveApp"]);
    assert.equal(closed, 1);
    assert.equal(f.w.open, originalOpen);
    assert.equal(f.w.HTMLAnchorElement.prototype.click, originalClick);
    f.close();
  });
  await test("빈 창 생성 후 주소를 바꾸는 미션도 원래 창 핸들을 닫음", async () => {
    const f = fixture(missionHTML(["앱 미니게임 플레이하기"], "미션하기"));
    f.h.init();
    f.w.unsafeWindow = f.w;
    let closed = 0;
    const handle = {
      location: { href: "about:blank" },
      close() {
        closed++;
      },
    };
    const original = () => handle;
    f.w.open = original;
    f.w.GM_openInTab = () => {
      throw Error("빈 창은 관리 탭 URL로 변환하면 안 됨");
    };
    f.h.missionButton("앱 미니게임 플레이하기").onclick = () => {
      const opened = f.w.open("", "_blank");
      opened.location.href = "https://store.onstove.com/ko/stoveApp";
    };
    assert.equal(
      (
        await f.h.runMission(
          { name: "앱 미니게임 플레이하기" },
          { bundle: true },
        )
      ).state,
      "갱신 대기",
    );
    assert.equal(handle.location.href, "https://store.onstove.com/ko/stoveApp");
    assert.equal(closed, 1);
    assert.equal(f.w.open, original);
    f.close();
  });
  await test("관리 탭 열기 실패 시 원래 새창으로 열고 해당 창도 정리", () => {
    const f = fixture();
    f.w.unsafeWindow = f.w;
    let closed = 0;
    f.w.open = () => ({
      close() {
        closed++;
      },
    });
    f.w.GM_openInTab = () => {
      throw Error("관리 탭 열기 실패");
    };
    const tracker = f.h.trackVisitTabs();
    f.w.open("https://store.onstove.com/ko/stoveApp", "_blank");
    tracker.dispose();
    assert.equal(closed, 1);
    f.close();
  });
  await test("현재·부모 탭은 닫기 대상에서 제외 / 기본 target 새창 링크 추적", () => {
    const f = fixture(
      '<base target="_blank"><a href="https://store.onstove.com/ko/stoveApp">앱 안내</a>',
    );
    f.w.unsafeWindow = f.w;
    let protectedClosed = 0,
      helperClosed = 0;
    f.w.open = () => ({
      close() {
        protectedClosed++;
      },
    });
    f.w.GM_openInTab = () => ({
      close() {
        helperClosed++;
      },
    });
    const tracker = f.h.trackVisitTabs();
    for (const target of ["_self", "_parent", "_top"])
      f.w.open("https://example.com/", target);
    const anchor = f.doc.querySelector("a");
    const event = new f.w.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    anchor.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    tracker.dispose();
    assert.equal(protectedClosed, 0);
    assert.equal(helperClosed, 1);
    f.close();
  });
  await test("늦게 열린 탭도 미션 묶음이 끝나면 정리 / 처리 오류에도 후킹 복원", async () => {
    const f = fixture(missionHTML(["첫 미션", "둘째 미션"], "미션하기"), {
      url: "https://reward.onstove.com/ko#stoveDaily=batch",
    });
    const job = { owner: "owner", date: f.h.today(), task: "missions" };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    f.w.unsafeWindow = f.w;
    const original = f.w.open;
    const originalClick = f.w.HTMLAnchorElement.prototype.click;
    let closed = 0;
    f.w.GM_openInTab = () => ({
      close() {
        closed++;
      },
    });
    f.h.missionButton("첫 미션").onclick = () =>
      f.w.open("https://store.onstove.com/ko/", "_blank");
    await assert.rejects(
      f.h.runMissionBatch(job, async (task, context) => {
        if (task.name === "첫 미션") return await f.h.runMission(task, context);
        // 前 방문 처리 이후에도 지연된 이동을 추적한다.
        f.w.open("https://store.onstove.com/ko/stoveApp", "_blank");
        throw Error("다음 미션 처리 오류");
      }),
      /다음 미션 처리 오류/,
    );
    assert.equal(closed, 2);
    assert.equal(f.w.open, original);
    assert.equal(f.w.HTMLAnchorElement.prototype.click, originalClick);
    f.close();
  });
  await test("탭 닫기 실패는 완료로 숨기지 않고 오류로 반환", () => {
    const f = fixture();
    f.w.unsafeWindow = f.w;
    const original = f.w.open;
    f.w.GM_openInTab = () => ({
      close() {
        throw Error("닫기 실패");
      },
    });
    const tracker = f.h.trackVisitTabs();
    f.w.open("https://store.onstove.com/ko/stoveApp", "_blank");
    assert.throws(() => tracker.dispose(), /미션 방문 탭을 닫지 못했습니다/);
    assert.equal(f.w.open, original);
    f.close();
  });
  await test("공지사항에서 선택 금액 전달 및 활성 새 탭", async () => {
    const f = fixture("", {
      url: "https://lostark.game.onstove.com/News/Notice/List",
    });
    f.w.setTimeout = () => {};
    let opened;
    f.w.GM_openInTab = (url, options) => {
      opened = { url, options };
    };
    f.h.init();
    f.doc.querySelector('[data-value="1000"]').click();
    await f.h.start(false);
    assert(
      opened.url.startsWith("https://reward.onstove.com/ko/event#stoveLaunch="),
    );
    assert.equal(opened.options.active, true);
    const key = "stove_daily_v2:launch:" + opened.url.split("=")[1];
    assert.equal(f.store.get(key).mode, "1000");
    assert.equal(f.store.get(key).scan, false);
    assert.equal(f.w.location.hostname, "lostark.game.onstove.com");
    f.close();
  });
  await test("로스트아크 점검 주소에서도 패널 표시와 선택 금액 전달", async () => {
    const url = "https://lostark.game.onstove.com/Inspection/Information";
    assert(
      matches.some((pattern) =>
        new RegExp(
          "^" +
            pattern
              .split("*")
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join(".*") +
            "$",
        ).test(url),
      ),
    );
    const f = fixture("<h3>서비스 점검 중 입니다.</h3>", {
      url,
      store: new Map([["stove_daily_v2:drawMode", "1000"]]),
    });
    f.w.setTimeout = () => {};
    let opened;
    f.w.GM_openInTab = (tabUrl, options) => {
      opened = { url: tabUrl, options };
    };
    f.h.init();
    assert(f.doc.querySelector("#stove-daily-extension"));
    assert(f.doc.body.textContent.includes("로스트아크 점검 중"));
    const button = [...f.doc.querySelectorAll("button")].find(
      (b) => b.textContent === "일일 보상 한 번에 받기",
    );
    await button.onclick();
    assert(
      opened.url.startsWith("https://reward.onstove.com/ko/event#stoveLaunch="),
    );
    assert.equal(opened.options.active, true);
    const request = f.store.get(
      "stove_daily_v2:launch:" + opened.url.split("=")[1],
    );
    assert.equal(request.mode, "1000");
    assert.equal(f.w.location.href, url);
    f.close();
  });
  await test("기존 실행 중에는 공지사항에서 중복 탭 생성 금지", async () => {
    const f = fixture("", {
      url: "https://lostark.game.onstove.com/News/Notice/List",
    });
    f.store.set("stove_daily_v2:lock", {
      id: "running",
      time: f.w.Date.now(),
    });
    f.w.GM_openInTab = () => {
      throw Error("중복 탭 생성 금지");
    };
    f.h.init();
    await f.h.start(false);
    assert(f.doc.body.textContent.includes("이미 다른 탭에서"));
    f.close();
  });
  await test("접힌 패널 실행 버튼 동작 / 펼치기 및 설정 복원", () => {
    const f = fixture("", {
      url: "https://lostark.game.onstove.com/News/Notice/List",
    });
    f.w.setTimeout = () => {};
    let opened;
    f.w.GM_openInTab = (url) => {
      opened = url;
    };
    f.store.set("stove_daily_v2:collapsed", true);
    f.h.init();
    const content = f.doc.querySelector("#stove-daily-expanded-content");
    const toggle = f.doc.querySelector(
      '[aria-controls="stove-daily-expanded-content"]',
    );
    const run = [...f.doc.querySelectorAll("button")].find(
      (b) => b.textContent === "일일 보상 한 번에 받기",
    );
    assert.equal(content.hidden, true);
    assert(!content.contains(run));
    run.click();
    assert(
      opened.startsWith("https://reward.onstove.com/ko/event#stoveLaunch="),
    );
    toggle.click();
    assert.equal(content.hidden, false);
    assert(content.contains(run));
    assert.equal(f.store.get("stove_daily_v2:collapsed"), false);
    toggle.click();
    assert.equal(content.hidden, true);
    assert.equal(f.store.get("stove_daily_v2:collapsed"), true);
    f.close();
  });
  await test("일회성 실행 요청 소비 및 선택 유지", () => {
    const f = fixture("", {
      url: "https://reward.onstove.com/ko/event#stoveLaunch=test",
    });
    f.store.set("stove_daily_v2:launch:test", {
      mode: "none",
      scan: true,
      time: f.w.Date.now(),
    });
    f.store.set("stove_daily_v2:lock", {
      id: "existing",
      time: f.w.Date.now(),
    });
    f.h.init();
    assert(!f.store.has("stove_daily_v2:launch:test"));
    assert.equal(
      f.doc.querySelector('[data-value="none"]').getAttribute("aria-pressed"),
      "true",
    );
    f.close();
  });
  await test("만료된 요청은 자동 실행하지 않음", () => {
    const f = fixture("", {
      url: "https://reward.onstove.com/ko/event#stoveLaunch=old",
    });
    f.store.set("stove_daily_v2:launch:old", {
      mode: "1000",
      scan: false,
      time: f.w.Date.now() - 121000,
    });
    f.h.init();
    assert(f.doc.body.textContent.includes("만료"));
    assert(!f.store.has("stove_daily_v2:lock"));
    f.close();
  });
  await test("한국 시간 월말·연말 URL 연월 전환", () => {
    for (const [time, expected] of [
      [Date.UTC(2026, 8, 30, 14, 59, 59), "202609"],
      [Date.UTC(2026, 8, 30, 15), "202610"],
      [Date.UTC(2026, 11, 31, 15), "202701"],
    ]) {
      const f = fixture("", { time });
      assert.equal(f.h.month(), expected);
      f.close();
    }
  });
  await test("기본 100 선택과 대비 색상 / 1000 선택 표시", () => {
    const f = fixture();
    f.h.init();
    const group = f.doc.querySelector('[aria-label="뽑기 금액 선택"]');
    const choices = group.querySelectorAll("button");
    assert.equal(choices[0].getAttribute("aria-pressed"), "true");
    assert(choices[0].textContent.includes("✓"));
    assert.notEqual(choices[0].style.color, choices[0].style.backgroundColor);
    choices[1].click();
    assert.equal(choices[0].getAttribute("aria-pressed"), "false");
    assert.equal(choices[1].getAttribute("aria-pressed"), "true");
    assert.equal(f.doc.querySelectorAll("select").length, 0);
    f.close();
  });
  await test("뽑기 선택은 다음 날 다른 페이지에서도 유지", () => {
    const first = fixture();
    first.h.init();
    first.doc.querySelector('[data-value="1000"]').click();
    const store = first.store;
    first.close();
    const next = fixture("", {
      store,
      time: Date.UTC(2026, 8, 6, 10),
      url: "https://lostark.game.onstove.com/News/Notice/List",
    });
    next.h.init();
    assert.equal(
      next.doc
        .querySelector('[data-value="1000"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    next.doc.querySelector('[data-value="100"]').click();
    next.close();
    const reopened = fixture("", { store });
    reopened.h.init();
    assert.equal(
      reopened.doc
        .querySelector('[data-value="100"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    reopened.close();
  });
  await test("유효하지 않은 저장 금액은 기본 100으로 표시", () => {
    const f = fixture("", {
      store: new Map([["stove_daily_v2:drawMode", "invalid"]]),
    });
    f.h.init();
    assert.equal(
      f.doc.querySelector('[data-value="100"]').getAttribute("aria-pressed"),
      "true",
    );
    f.close();
  });
  await test("상태 항목은 최대 너비에서 2열 카드로 표시", () => {
    const f = fixture();
    f.h.init();
    const panel = f.doc.querySelector("#stove-daily-extension");
    const grid = f.doc.querySelector("#stove-daily-status-grid");
    assert.equal(panel.style.width, "350px");
    assert.equal(grid.children.length, 3);
    assert.equal(
      f.doc.querySelector("#stove-daily-click-grid").children.length,
      0,
    );
    assert(grid.style.gridTemplateColumns.includes("repeat(2"));
    f.close();
  });
  await test("실패 항목만 재시도하고 결과에 따라 버튼 상태 변경", async () => {
    const f = fixture();
    f.h.init();
    const retry = f.doc.querySelector("#stove-daily-status-grid button");
    f.h.status("riichi", { state: "확인 필요", detail: "일시 오류" });
    assert.equal(retry.textContent, "재시도");
    assert.equal(retry.disabled, false);
    assert.equal(typeof retry.onclick, "function");
    const calls = [];
    await f.h.retryTask("riichi", async (task, scan, mode) => {
      calls.push({ id: task.id, scan, mode });
      return { state: "완료됨", detail: "재시도 성공" };
    });
    assert.deepEqual(calls, [{ id: "riichi", scan: false, mode: "100" }]);
    assert.equal(retry.textContent, "완료됨");
    assert.equal(retry.disabled, true);
    f.h.status("riichi", { state: "확인 필요", detail: "다시 실패" });
    await f.h.retryTask("riichi", async () => ({
      state: "확인 필요",
      detail: "다시 실패",
    }));
    assert.equal(retry.textContent, "재시도");
    assert.equal(retry.disabled, false);
    assert(retry.title.includes("다시 실패"));
    f.close();
  });
  for (const [initial, mode, n] of [
    [0, "100", 30],
    [10, "1000", 20],
    [30, "100", 0],
    [12, "none", 0],
  ])
    await test(`현재 탭 ${initial}/30 ${mode} => ${n}회 및 회계`, async () => {
      const f = drawFixture(initial, mode);
      f.w.GM_openInTab = () => {
        throw Error("뽑기에서 새 탭 생성 금지");
      };
      const r = await f.h.executeTask(
        { id: "draw", draw: true, name: "뽑기" },
        false,
        mode,
      );
      assert.equal(f.clicks(), n);
      if (n) {
        const saved = f.h.history().at(-1),
          t = f.h.totals(saved);
        assert.equal(saved.records.length, n);
        assert.equal(t.spent, n * Number(mode));
        assert.equal(t.gained, n * 100);
        assert.equal(t.unknown, 0);
      }
      f.close();
    });
  await test("동일 보상 연속 + 실물/쿠폰 이름 기록", async () => {
    const f = drawFixture(26, "100", [
      "1,000 플레이크",
      "1,000 플레이크",
      "맘스터치 싸이버거 세트",
      "스토어 1천원 할인쿠폰",
    ]);
    await f.h.runDraw({ mode: "100" });
    const saved = f.h.history().at(-1),
      t = f.h.totals(saved);
    assert.equal(t.spent, 400);
    assert.equal(t.gained, 2000);
    assert.equal(t.items.length, 2);
    assert.equal(saved.records.length, 4);
    assert(f.doc.querySelector(".stds-dialog-panel"), "마지막 결과 유지");
    f.close();
  });
  await test("서버 횟수 미증가: 추가 클릭/사용량 추측 금지", async () => {
    const f = drawFixture(0, "100", ["100 플레이크"], false);
    assert.equal((await f.h.runDraw({ mode: "100" })).state, "확인 필요");
    assert.equal(f.clicks(), 1);
    const t = f.h.totals(f.h.history().at(-1));
    assert.equal(t.spent, 0);
    assert.equal(t.unknown, 1);
    f.close();
  });
  await test("결과 미확인: 사용량만 저장하고 중단", async () => {
    const f = fixture(
      '<div class="stds-box">오늘 뽑기 <span id="count">0</span>/30회</div><button id="draw">100 뽑기</button>',
    );
    f.doc.querySelector("#draw").onclick = () => {
      f.doc.querySelector("#count").textContent = "1";
    };
    assert.equal((await f.h.runDraw({ mode: "100" })).state, "확인 필요");
    const t = f.h.totals(f.h.history().at(-1));
    assert.equal(t.spent, 100);
    assert.equal(t.gained, 0);
    assert.equal(t.unknown, 1);
    f.close();
  });
  await test("완료 항목 클릭 없이 넘김", async () => {
    const f = fixture('<button id="b" disabled>받기 완료</button>');
    let n = 0;
    f.doc.querySelector("#b").onclick = () => n++;
    assert.equal(
      (await f.h.claim(() => f.doc.querySelector("#b"))).state,
      "완료됨",
    );
    assert.equal(n, 0);
    f.close();
  });
  await test("출석 일시 오류 후 1회 갱신 확인 / 재클릭 금지", async () => {
    for (const completed of [true, false]) {
      const f = fixture(
        '<div class="module-card-item"><span>9.5</span><button>오늘의 아이템 받기</button></div><li id="cumulative-1"><button disabled>완료</button></li>',
        {
          url: "https://event.onstove.com/ko/dailyshop/STOVEINDIE/202609#stoveDaily=shop",
        },
      );
      const job = { owner: "owner", date: f.h.today(), task: "indie" };
      f.store.set("stove_daily_v2:shop", job);
      f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
      let clicks = 0,
        reloads = 0;
      const b = f.doc.querySelector("button");
      b.onclick = () => {
        clicks++;
        const modal = f.doc.createElement("div");
        modal.className = "stds-dialog-panel";
        modal.textContent = "일시적인 오류가 발생하였습니다.";
        f.doc.body.append(modal);
      };
      assert.equal(await f.h.runShop(job, () => reloads++), null);
      f.doc.querySelector(".stds-dialog-panel").remove();
      if (completed) b.textContent = "완료";
      const value = await f.h.runShop(
        f.store.get("stove_daily_v2:shop"),
        () => reloads++,
      );
      assert.equal(value.state, completed ? "완료됨" : "확인 필요");
      assert.equal(clicks, 1);
      assert.equal(reloads, 1);
      f.close();
    }
  });
  await test("오늘 출석 카드만 완료 판정", async () => {
    const f = fixture(
      '<div class="module-card-item"><span>9.4</span><button>오늘의 아이템 받기</button></div><div class="module-card-item"><span>9.5</span><button disabled>완료</button></div><li id="cumulative-1"><button disabled>완료</button></li>',
    );
    assert.equal((await f.h.runShop({})).state, "완료됨");
    f.close();
  });
  await test("오늘 출석 완료여도 누적 보상 수령 / 조건 미달과 응모 제외", async () => {
    const f = fixture(
      '<div class="module-card-item"><span>9.5</span><button disabled>완료</button></div><li id="cumulative-1">5일 누적 쿠폰<button>보상받기</button></li><li id="cumulative-2"><button disabled>보상받기</button></li><button id="raffle">응모하기</button>',
    );
    let clicks = 0;
    f.doc.querySelector("#cumulative-1 button").onclick = (e) => {
      clicks++;
      e.target.textContent = "완료";
      e.target.disabled = true;
    };
    f.doc.querySelector("#raffle").onclick = () => {
      throw Error("응모 클릭 금지");
    };
    const value = await f.h.runShop({});
    assert.equal(value.state, "완료됨");
    assert(value.detail.includes("누적 보상 1개 수령"));
    await f.h.runShop({});
    assert.equal(clicks, 1);
    f.close();
  });
  await test("누적 보상 스캔은 클릭 없이 수령 가능 표시", async () => {
    const f = fixture('<li id="cumulative-1"><button>보상받기</button></li>');
    f.doc.querySelector("button").onclick = () => {
      throw Error("스캔 클릭 금지");
    };
    assert.equal((await f.h.runMilestones("shop", true)).state, "수령 가능");
    f.close();
  });
  await test("누적 보상 오류는 재클릭 없이 확인 필요", async () => {
    const f = fixture('<li id="cumulative-1"><button>보상받기</button></li>');
    let clicks = 0;
    f.doc.querySelector("button").onclick = () => {
      clicks++;
      f.doc.body.insertAdjacentHTML(
        "beforeend",
        '<div class="stds-dialog-panel">일시적인 오류</div>',
      );
    };
    assert.equal((await f.h.runMilestones("shop")).state, "확인 필요");
    assert.equal(clicks, 1);
    f.close();
  });
  await test("캡슐 30회 완료 후 누적 보상 수령 / 결과 창 닫기 / 재수령 방지", async () => {
    const f = fixture(
      '<div class="stds-box">오늘 뽑기 30/30회</div><div><div><button id="bonus">5,000 플레이크 받기</button></div><p>30번<span class="l1l2-flakehub-common-draw_condition">x10</span> 이상 뽑기 시</p></div><div class="stds-dialog-panel"><span class="l1l2-flakehub-popup-common-received_reward">100 플레이크</span><button id="close">닫기</button></div>',
    );
    f.h.init();
    let clicks = 0;
    f.doc.querySelector("#close").onclick = () =>
      f.doc.querySelector(".stds-dialog-panel").remove();
    f.doc.querySelector("#bonus").onclick = (e) => {
      clicks++;
      e.target.textContent = "플레이크 받기 완료";
      e.target.disabled = true;
      const modal = f.doc.createElement("div");
      modal.className = "stds-dialog-panel";
      modal.innerHTML = "5,000 플레이크가 지급되었습니다!<button>확인</button>";
      modal.querySelector("button").onclick = () => modal.remove();
      f.doc.body.append(modal);
    };
    await f.h.executeTask(
      { id: "draw", name: "캡슐 뽑기", draw: true },
      false,
      "100",
    );
    assert.equal(clicks, 1);
    assert(!f.doc.querySelector(".stds-dialog-panel"));
    assert.equal((await f.h.runMilestones("draw")).state, "완료됨");
    assert.equal(clicks, 1);
    f.close();
  });
  await test("누적 영역 누락은 완료로 처리하지 않음", async () => {
    const f = fixture("<button>보상받기</button>");
    assert.equal((await f.h.runMilestones("shop")).state, "확인 필요");
    assert.equal((await f.h.runMilestones("draw")).state, "확인 필요");
    f.close();
  });
  await test("미션 스캔은 수령하지 않음", async () => {
    const f = fixture("<div><p>MY홈 방문하기</p><button>받기</button></div>");
    let n = 0;
    f.doc.querySelector("button").onclick = () => n++;
    assert.equal(
      (await f.h.runMission({ name: "MY홈 방문하기" }, { scan: true })).state,
      "수령 가능",
    );
    assert.equal(n, 0);
    f.close();
  });
  await test("myChips 전용 팝업 닫기", async () => {
    const f = fixture(
      '<div class="mission-offerwall-modal"><button aria-label="close">닫기</button></div>',
    );
    f.doc.querySelector("button").onclick = () =>
      f.doc.querySelector(".mission-offerwall-modal").remove();
    assert(await f.h.closeOfferwall());
    assert(!f.doc.querySelector(".mission-offerwall-modal"));
    f.close();
  });
  await test("플레이크 파싱: 쿠폰 금액은 합산하지 않음", () => {
    const f = fixture();
    assert.equal(f.h.parseFlakes("50,000 플레이크"), 50000);
    assert.equal(f.h.parseFlakes("스토어 1천원 할인쿠폰"), null);
    assert.equal(f.h.parseFlakes("100 플레이크 획득 가능"), null);
    f.close();
  });
  console.log(`${passed} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
