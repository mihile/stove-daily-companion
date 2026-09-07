const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
let code = fs.readFileSync(
  path.join(__dirname, "..", "stove-daily-companion.user.js"),
  "utf8",
);
const entry = code.lastIndexOf("if (document.readyState");
if (entry < 0) throw new Error("Initialization entry not found");
code =
  code.slice(0, entry) +
  "globalThis.h={init,start,stop,today,runPlan,runMissionBatch,month,runDraw,claim,runShop,runMission,shopButton,missionButton,drawCount,closeOfferwall,parseFlakes,totals,history,executeTask,status,retryTask};})();";
let passed = 0;
function fixture(html = "", options = {}) {
  const dom = new JSDOM(html, {
      url: options.url || "https://reward.onstove.com/ko/event",
      runScripts: "outside-only",
    }),
    w = dom.window,
    store = new Map();
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
    const f = fixture(
      names
        .map((n) => `<div><p>${n}</p><button>미션하기</button></div>`)
        .join(""),
      { url: "https://reward.onstove.com/ko#stoveDaily=batch" },
    );
    const job = { owner: "owner", date: f.h.today(), task: "missions" };
    f.store.set("stove_daily_v2:batch", job);
    f.store.set("stove_daily_v2:lock", { id: "owner", time: f.w.Date.now() });
    let reloads = 0;
    const calls = [];
    const perform = async (task, context) => {
      calls.push(task.id);
      return { state: task.visit && !context.visited ? "갱신 대기" : "완료됨" };
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
    assert.equal(calls.length, 8);
    assert.equal(calls.filter((id) => id === "mission3").length, 1);
    f.close();
  });
  await test("출석 2개는 직렬 / 미션은 병렬 / 모두 끝난 뒤 뽑기", async () => {
    const f = fixture(),
      started = [],
      releases = [];
    const pending = f.h.runPlan(false, "100", f.h.today(), (task) => {
      started.push(task.id);
      return task.draw
        ? Promise.resolve()
        : new Promise((resolve) => releases.push(resolve));
    });
    assert.deepEqual(started, ["riichi", "missions"]);
    releases[0]();
    await new Promise(setImmediate);
    assert.deepEqual(started, ["riichi", "missions", "indie"]);
    assert(!started.includes("draw"));
    releases[1]();
    releases[2]();
    await pending;
    assert.equal(started.at(-1), "draw");
    f.close();
  });
  await test("병렬 처리 중 중단하면 뽑기 시작 금지", async () => {
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
    assert(!started.includes("draw"));
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
    const f = fixture(
      names.map((n) => `<div><p>${n}</p><button>받기</button></div>`).join(""),
      { url: "https://reward.onstove.com/ko#stoveDaily=batch" },
    );
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
  await test("상태 항목은 최대 너비에서 2열 카드로 표시", () => {
    const f = fixture();
    f.h.init();
    const panel = f.doc.querySelector("#stove-daily-extension");
    const grid = f.doc.querySelector("#stove-daily-status-grid");
    assert.equal(panel.style.width, "350px");
    assert.equal(grid.children.length, 8);
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
        '<div class="module-card-item"><span>9.5</span><button>오늘의 아이템 받기</button></div>',
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
      '<div class="module-card-item"><span>9.4</span><button>오늘의 아이템 받기</button></div><div class="module-card-item"><span>9.5</span><button disabled>완료</button></div>',
    );
    assert.equal((await f.h.runShop({})).state, "완료됨");
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
