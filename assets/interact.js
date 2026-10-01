/* macro 课程共享交互组件 · 唯一权威版
   用法：在课页放 <quiz-block> / <chain-block> / <preq-block> / <recall-block>，内嵌
   <script type="application/json"> {"q":"…","why":"…","options":[{"t":"…","ok":true,"why":"…"}]} </script>
   （recall-block 用 {"q":"…","a":"参考答案"}；preq-block 可加 "revisit":"课末回望提示"）
   组件自动渲染。导出到 window.Macro（kbar 铁律：新组件必须导出+可探针）。

   —— Learner OS 底座（2026-10 票 13：无云端/无服务器/无账号，纯本地 localStorage）——
   · Macro.passport  学习护照：作答记录/里程碑与课级点亮/快照/主题，键名 macro-passport-v1
   · Macro.srs       简化间隔复习：错题入池，间隔 [1,3,7,14] 天，答对升档答错归 1，四连对毕业
   · 判分卡          训练场尾自动挂 div.judge-card（本次 X/Y、昨日错题、今日待练、隔天重练门、重做本场）
   · 顶栏            每个引入本文件的页面自动注入 div.topbar（上一课/课名/下一课/里程碑灯/搜索/主题）
   · <blindtest-block> 盲测标点组件；<recalc-block> 窗口复算组件（数据由后续接线任务喂数）
   · Macro.hover     术语悬停（词典 assets/terms.js 由 tools/build-terms.py 生成，精确匹配，每页每词首次）
   纯函数部分（shuffle/passport/SRS）在 node 下可 require（tools/test-learner-os.js 自测）。 */
(function () {
  "use strict";

  var HAS_DOM = typeof document !== "undefined";
  var DAY = 86400000;

  /* ================================================================ 工具 */
  function readData(el) {
    var s = el.querySelector('script[type="application/json"]');
    if (!s) return null;
    try { return JSON.parse(s.textContent); } catch (e) { console.error("interact.js JSON 解析失败", e); return null; }
  }

  function hashStr(s) {
    var h = 5381;
    s = String(s);
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function dayStr(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
  }

  function normDay(x) {
    if (typeof x === "number") return dayStr(x);
    if (x && typeof x.getTime === "function") return dayStr(x.getTime());
    x = String(x || "");
    return x.length > 10 ? x.slice(0, 10) : x;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function courseOf() {
    if (!HAS_DOM) return "site";
    var file = (location.pathname.split("/").pop() || "").replace(/\.html?$/, "");
    var m = file.match(/(\d{4})/);
    if (!m) return file || "site";
    return (location.pathname.indexOf("/reference/") >= 0 ? "ref" : "") + m[1];
  }

  /* ================================================================ 真乱序（P0 修复）
     旧实现 (i*2654435761)%97 排序在 n≤9 时恒等返回原序（node 实测证实）——已废除。
     Fisher-Yates：优先 crypto.getRandomValues，兜底 Math.random；返回新数组不改入参。
     randHook：测试假随机注入点（Macro.randInject(fn|null)，tools/test-learner-os.js 用）——
     注入后 randInt 完全走假随机，可确定性复现/区分不同洗牌序。 */
  var randHook = null;

  function randInt(n) {
    if (randHook) {
      var r = +randHook(n);
      if (isFinite(r)) return Math.max(0, Math.min(n - 1, Math.floor(r)));
    }
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      try {
        var buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] % n;
      } catch (e) { /* fallthrough */ }
    }
    return Math.floor(Math.random() * n);
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ================================================================ 事件（浏览器态广播） */
  function emit(type, detail) {
    if (!HAS_DOM || !document.dispatchEvent) return;
    try { document.dispatchEvent(new CustomEvent("macro:passport", { detail: { type: type, detail: detail } })); } catch (e) {}
  }
  function emitSession() {
    if (!HAS_DOM || !document.dispatchEvent) return;
    try { document.dispatchEvent(new CustomEvent("macro:session")); } catch (e) {}
  }

  /* ================================================================ 学习护照（localStorage 核，离线+隐私）
     数据结构 {answers:[{course,qid,ok,ts}], milestones:{ID:{lit,ts}}, courses:{课号:{lit,ts}},
               snapshots:[{n,date,regime}], notes:{key:{text,ts}}, theme:'auto'|'light'|'dark'}
     可注入 storage/now（tools/test-learner-os.js 假时钟用例）。 */
  var SRS_INTERVALS = [1, 3, 7, 14];

  function memStore() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }

  function defaultStore() {
    try {
      if (typeof localStorage !== "undefined") {
        var k = "macro-passport-probe";
        localStorage.setItem(k, "1");
        localStorage.removeItem(k);
        return localStorage;
      }
    } catch (e) { /* file:// 隐私模式等：降级内存（本次会话内仍可用） */ }
    return memStore();
  }

  function blankPassport() {
    return { answers: [], milestones: {}, courses: {}, snapshots: [], notes: {}, theme: "auto" };
  }

  function createPassport(opts) {
    opts = opts || {};
    var KEY = "macro-passport-v1";
    var store = opts.storage || defaultStore();
    var now = opts.now || function () { return Date.now(); };

    function load() {
      var d = blankPassport(), raw = null;
      try { raw = store.getItem(KEY); } catch (e) {}
      if (raw) {
        try {
          var p = JSON.parse(raw);
          if (p && typeof p === "object") {
            if (Array.isArray(p.answers)) d.answers = p.answers;
            if (p.milestones && typeof p.milestones === "object") d.milestones = p.milestones;
            if (p.courses && typeof p.courses === "object") d.courses = p.courses;
            if (Array.isArray(p.snapshots)) d.snapshots = p.snapshots;
            if (p.notes && typeof p.notes === "object") d.notes = p.notes;
            if (p.theme) d.theme = p.theme;
          }
        } catch (e) { /* 损坏则重建 */ }
      }
      return d;
    }
    function save(d) {
      try { store.setItem(KEY, JSON.stringify(d)); } catch (e) { /* 空间满/隐私模式：静默 */ }
    }

    var pub = {
      KEY: KEY,
      intervals: SRS_INTERVALS,
      data: load,
      _now: now,
      _storage: store,
      _create: createPassport,

      record: function (course, qid, ok) {
        var d = load();
        d.answers.push({ course: String(course), qid: String(qid), ok: !!ok, ts: now() });
        save(d);
        emit("record", { course: course, qid: qid, ok: !!ok });
        return d.answers.length;
      },

      wrongPool: function (course) {
        return poolFromAnswers(load().answers).filter(function (p) {
          return !course || p.course === course;
        });
      },

      dueReview: function (today) {
        var t = normDay(today === undefined ? now() : today);
        return poolFromAnswers(load().answers).filter(function (p) { return p.dueDate <= t; });
      },

      lightMilestone: function (id) {
        var d = load();
        d.milestones[id] = { lit: true, ts: now() };
        save(d); emit("milestone", { id: id });
      },
      lightCourse: function (course) {
        var d = load();
        d.courses[course] = { lit: true, ts: now() };
        save(d); emit("course", { course: course });
      },
      lit: function (id, course) {
        var d = load();
        return !!(id && d.milestones[id] && d.milestones[id].lit) || !!(course && d.courses[course] && d.courses[course].lit);
      },

      snapshot: function (n, regime) {
        var d = load();
        d.snapshots.push({ n: n, date: dayStr(now()), regime: regime || "" });
        if (d.snapshots.length > 50) d.snapshots = d.snapshots.slice(-50);
        save(d); emit("snapshot", {});
      },

      /* 自由备注（如 6004 毕业考回炉复述框）：只存原文+时间戳，课程不评判内容——诚实条款。 */
      note: function (key, text) {
        var d = load();
        if (!d.notes || typeof d.notes !== "object") d.notes = {};
        d.notes[String(key)] = { text: String(text == null ? "" : text), ts: now() };
        save(d); emit("note", { key: String(key) });
        return d.notes[String(key)];
      },
      noteGet: function (key) {
        var n = load().notes;
        return (n && n[String(key)]) ? n[String(key)] : null;
      },

      theme: function (mode) {
        var d = load();
        if (mode === undefined) return d.theme || "auto";
        d.theme = (mode === "dark" || mode === "light") ? mode : "auto";
        save(d); emit("theme", { theme: d.theme });
        return d.theme;
      },

      exportJSON: function () { return JSON.stringify(load(), null, 2); },

      exportHTML: function () {
        var d = load();
        var due = pub.dueReview(dayStr(now()));
        var pool = poolFromAnswers(d.answers);
        function li(s) { return "<li>" + esc(s) + "</li>"; }
        var ms = Object.keys(d.milestones).sort().map(function (k) { return li(k + " · 点亮于 " + dayStr(d.milestones[k].ts)); }).join("") || li("（尚未点亮）");
        var cs = Object.keys(d.courses).sort().map(function (k) { return li("课 " + k + " · 隔天重练全对点亮于 " + dayStr(d.courses[k].ts)); }).join("") || li("（尚未点亮）");
        var rows = d.answers.slice(-40).reverse().map(function (a) {
          return "<tr><td>" + esc(a.course) + "</td><td>" + esc(a.qid) + "</td><td>" + (a.ok ? "对" : "错") + "</td><td>" + dayStr(a.ts) + "</td></tr>";
        }).join("");
        var sn = d.snapshots.map(function (s) { return li("#" + s.n + " · " + s.date + " · " + s.regime); }).join("") || li("（暂无）");
        return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><title>学习护照 · 宏观训练营</title><style>" +
          "body{font-family:'Songti SC','Noto Serif SC',Georgia,serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1c1c1a}" +
          "h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.6rem}table{border-collapse:collapse;width:100%;font-size:.88rem}" +
          "td,th{border:1px solid #ccc;padding:.3rem .5rem;text-align:left}ul{padding-left:1.2rem}@media print{body{margin:0}}" +
          "</style></head><body><h1>学习护照（本地导出）</h1><p>生成于 " + dayStr(now()) + " · 键名 macro-passport-v1 · 纯本地数据</p>" +
          "<h2>已点亮里程碑</h2><ul>" + ms + "</ul><h2>隔天重练点亮的课</h2><ul>" + cs + "</ul>" +
          "<h2>复习（今日待练 " + due.length + " 题 / 错题池共 " + pool.length + " 题）</h2>" +
          "<h2>当期快照</h2><ul>" + sn + "</ul><h2>最近作答（最新 40 条）</h2>" +
          "<table><tr><th>课</th><th>题</th><th>对错</th><th>日期</th></tr>" + rows + "</table></body></html>";
      },

      export: function (fmt) {
        var isJSON = fmt === "json";
        var text = isJSON ? pub.exportJSON() : pub.exportHTML();
        if (HAS_DOM) {
          try {
            var blob = new Blob([text], { type: isJSON ? "application/json" : "text/html" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "macro-passport-" + dayStr(now()) + (isJSON ? ".json" : ".html");
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
          } catch (e) { /* 下载失败时调用方仍拿到字符串 */ }
        }
        return text;
      },

      clear: function () {
        try { store.removeItem(KEY); } catch (e) {}
        emit("clear", {});
      }
    };
    return pub;
  }

  /* ================================================================ SRS 简化调度（纯函数）
     规则：record ok=false → 入池 stage0，下次复习 due=当日+1 天；
           池内答对 → 升档，下一间隔取 [1,3,7,14] 的下一档（stage1=+3 天、stage2=+7 天、stage3=+14 天）；
           池内答错 → 归 1（stage0，+1 天）；走完 14 天档再答对 → 毕业（出池）。
           全部由 answers 历史推导，无冗余状态。 */
  function poolFromAnswers(answers) {
    var groups = {};
    (answers || []).forEach(function (a) {
      var k = a.course + "|" + a.qid;
      (groups[k] = groups[k] || []).push(a);
    });
    var pool = [];
    Object.keys(groups).forEach(function (k) {
      var list = groups[k].slice().sort(function (x, y) { return x.ts - y.ts; });
      var inPool = false, stage = 0, dueTs = 0;
      list.forEach(function (a) {
        if (!a.ok) { inPool = true; stage = 0; dueTs = a.ts + SRS_INTERVALS[0] * DAY; }
        else if (inPool) {
          stage++;
          if (stage >= SRS_INTERVALS.length) inPool = false; // 走完 1/3/7/14 全档，毕业出池
          else dueTs = a.ts + SRS_INTERVALS[stage] * DAY;
        }
      });
      if (inPool) pool.push({ course: list[0].course, qid: list[0].qid, stage: stage, dueTs: dueTs, dueDate: dayStr(dueTs) });
    });
    return pool;
  }

  var Passport = createPassport();

  /* ================================================================ 主题（auto→light→dark 循环，存 passport.theme） */
  var Theme = {
    order: ["auto", "light", "dark"],
    label: { auto: "自动", light: "浅色", dark: "深色" },
    get: function () { return Passport.theme(); },
    apply: function (mode) {
      if (!HAS_DOM) return;
      var h = document.documentElement;
      if (mode === "dark") h.setAttribute("data-theme", "dark");
      else if (mode === "light") h.setAttribute("data-theme", "light");
      else h.removeAttribute("data-theme");
    },
    set: function (mode) {
      Passport.theme(mode);
      this.apply(this.get());
      emit("theme", { theme: this.get() });
    },
    cycle: function () {
      var cur = this.get();
      var next = this.order[(this.order.indexOf(cur) + 1) % this.order.length];
      this.set(next);
      return next;
    }
  };

  /* ================================================================ 组件渲染（DOM 态） */
  function wipeRender(el, keepTags) {
    var keep = keepTags || ["SCRIPT"];
    Array.prototype.slice.call(el.childNodes).forEach(function (n) {
      var tag = n.tagName || "";
      if (n.nodeType === 1 && keep.indexOf(tag) !== -1) return;
      el.removeChild(n);
    });
  }

  // 选择题共用渲染：quiz 与 prequestion（课前先猜）同一机制，仅提示语不同。
  // why 文本常驻 DOM（屏幕态未作答 display:none，作答后展开；@media print 强制显示——打印/降级友好）。
  // 呈现层洗牌（P0，2026-10 C8）：全站 312/350 题正确项固化在 B 位——数据 JSON 一字不动，
  // 渲染时对选项做 Fisher-Yates 洗牌（DOM 顺序随机；打印不重渲、保持已洗顺序；重做本场再洗一次）。
  // meta.noScore（preq 课前先猜）：作答不进 Passport.record——不入错题池、不参与当日全对判定（先猜零风险契约）。
  function buildChoice(el, data, meta) {
    if (!data || !data.options) return;
    wipeRender(el);
    var frag = document.createDocumentFragment();
    var qid = "q-" + hashStr(String(data.q || ""));
    el.dataset.qid = qid;
    delete el.dataset.answered; delete el.dataset.ok;

    if (meta && meta.note) {
      var m = document.createElement("div");
      m.className = "quiz-meta";
      m.textContent = meta.note;
      frag.appendChild(m);
    }
    var q = document.createElement("div");
    q.className = "q";
    q.textContent = data.q;
    frag.appendChild(q);
    if (data.hint) {
      var h = document.createElement("div");
      h.className = "why-hint";
      h.textContent = data.hint;
      frag.appendChild(h);
    }
    var fb = document.createElement("div");
    fb.className = "feedback";

    var view = data.options.length > 1 ? shuffle(data.options) : data.options; // 呈现序（洗牌不动原数组）
    view.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.textContent = o.t;
      frag.appendChild(b);
      var w = null;
      if (o.why) {
        w = document.createElement("div");
        w.className = "why";
        w.textContent = o.why; // 常驻 DOM：未作答仅 CSS 隐藏，打印时强制可见
        frag.appendChild(w);
      }
      o._btn = b; o._why = w;
      b.addEventListener("click", function () {
        if (el.dataset.answered) return;
        el.dataset.answered = "1";
        el.dataset.ok = o.ok ? "1" : "0";
        view.forEach(function (x) {
          x._btn.disabled = true;
          if (x.ok) {
            x._btn.classList.add("correct");
            if (!o.ok && x._why) x._why.classList.add("show", "good"); // 错选时同时给出正确项解析
          }
        });
        if (o.ok) {
          b.classList.add("correct");
          if (o._why) o._why.classList.add("show", "good");
        } else {
          b.classList.add("wrong"); // 错→标红
          if (o._why) o._why.classList.add("show", "bad");
        }
        if (meta && meta.after) {
          fb.textContent = meta.after;
          fb.classList.add("show");
        }
        if (!(meta && meta.noScore)) {
          try { Passport.record(courseOf(), qid, !!o.ok); } catch (e) {} // 错题自动入池（SRS）；preq 先猜不入账
        }
        emitSession();
      });
    });
    frag.appendChild(fb);
    el.appendChild(frag);
  }

  function buildQuiz(el) { buildChoice(el, readData(el)); }

  function buildPreq(el) {
    var d = readData(el);
    if (!d) return;
    buildChoice(el, d, {
      note: "课前先猜 · 不计分 · 猜错有好处：错误猜测会加深随后对正确答案的编码",
      after: d.revisit || "记住你的直觉，课末自测会回到它。",
      noScore: true // 先猜零风险：不入错题池、不进当日全对判定
    });
  }

  function buildRecall(el) {
    var data = readData(el);
    if (!data || !data.a) return;
    wipeRender(el);
    var q = document.createElement("div");
    q.className = "q";
    q.textContent = data.q;
    el.appendChild(q);
    if (data.hint) {
      var h = document.createElement("div");
      h.className = "why-hint";
      h.textContent = data.hint;
      el.appendChild(h);
    }
    var ta = document.createElement("textarea");
    ta.className = "recall-input";
    ta.rows = 5;
    ta.placeholder = "先凭记忆写，写完再展开对照——写不出来也是一次有效检索。";
    el.appendChild(ta);
    var fb = document.createElement("div");
    fb.className = "feedback";
    var check = document.createElement("button");
    check.type = "button";
    check.className = "recall-check";
    check.textContent = "展开参考答案";
    check.addEventListener("click", function () {
      fb.textContent = data.a;
      fb.classList.add("show", "good");
      check.disabled = true;
    });
    el.appendChild(check);
    el.appendChild(fb);
  }

  function buildChain(el) {
    var data = readData(el);
    if (!data || !data.steps || data.steps.length < 3) return;
    wipeRender(el);
    var correct = data.steps.slice(); // 数组顺序即正确因果顺序
    var q = document.createElement("div");
    q.className = "q";
    q.textContent = data.q;
    el.appendChild(q);
    if (data.hint) {
      var h = document.createElement("div");
      h.className = "why-hint";
      h.textContent = data.hint;
      el.appendChild(h);
    }
    var arena = document.createElement("div");
    arena.className = "chain-arena";
    el.appendChild(arena);
    var picked = [];
    var checked = false;
    // 展示序=真乱序（Fisher-Yates，见 shuffle；修复旧实现 n≤9 恒等 bug）
    var shuffled = shuffle(correct.map(function (s, i) { return { s: s, i: i }; }));
    var check = document.createElement("button");
    check.type = "button";
    check.className = "chain-check";
    check.disabled = true;
    check.textContent = "检验顺序";
    shuffled.forEach(function (item) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chain-step";
      b.textContent = item.s;
      b.addEventListener("click", function () {
        if (b.classList.contains("picked") || checked) return;
        picked.push(item.i);
        b.classList.add("picked");
        b.dataset.pos = picked.length;
        check.disabled = picked.length !== correct.length;
      });
      arena.appendChild(b);
    });
    check.addEventListener("click", function () {
      if (checked) return;
      checked = true;
      var allRight = true;
      Array.prototype.forEach.call(arena.children, function (btn, idx) {
        var item = shuffled[idx];
        var pos = picked.indexOf(item.i);
        btn.disabled = true;
        if (pos === item.i) btn.classList.add("right");
        else { btn.classList.add("misplaced"); allRight = false; }
      });
      el.dataset.answered = "1";
      el.dataset.ok = allRight ? "1" : "0";
      check.textContent = allRight ? "全部正确" : "有错位，红色为放错位置的环节";
      if (data.why) why.classList.add("show");
      emitSession();
    });
    el.appendChild(check);
    var why = null;
    if (data.why) {
      why = document.createElement("div");
      why.className = "why";
      why.textContent = data.why; // 常驻 DOM，打印可见
      el.appendChild(why);
    }
  }

  // 视频卡：懒加载嵌入（点击才挂 iframe，卡面=打印友好信息卡；只嵌官方源）
  function buildVideo(el) {
    var d = readData(el);
    if (!d || !d.youtube) return;
    wipeRender(el);
    var head = document.createElement("div");
    head.className = "vc-head";
    var t = document.createElement("span");
    t.className = "vc-title";
    t.textContent = d.title || "外部视频";
    var m = document.createElement("span");
    m.className = "vc-meta";
    m.textContent = [d.duration, d.source].filter(Boolean).join(" · ");
    head.appendChild(t); head.appendChild(m);
    el.appendChild(head);
    if (d.note) {
      var n = document.createElement("div");
      n.className = "vc-links";
      n.textContent = d.note;
      el.appendChild(n);
    }
    var play = document.createElement("button");
    play.type = "button";
    play.className = "vc-play";
    play.textContent = "▶ 在页面内播放";
    play.addEventListener("click", function () {
      var frame = document.createElement("div");
      frame.className = "vc-frame show";
      var ifr = document.createElement("iframe");
      ifr.src = "https://www.youtube-nocookie.com/embed/" + d.youtube + "?rel=0&autoplay=1";
      ifr.title = d.title || "视频";
      ifr.allow = "accelerometer; autoplay; encrypted-media; picture-in-picture";
      ifr.allowFullscreen = true;
      frame.appendChild(ifr);
      el.insertBefore(frame, play);
      play.remove();
    });
    el.appendChild(play);
    var links = document.createElement("div");
    links.className = "vc-links";
    links.innerHTML = "播放器不可用时：<a href=\"" + (d.fallback || "https://www.economicprinciples.org/") + "\">官网直链</a>" + (d.search ? "｜" + d.search : "");
    el.appendChild(links);
  }

  /* ================================================================ 盲测组件（blindtest-block）
     结构一（内嵌）：块内放课内 SVG + JSON {q, instruction?, answers:[{x,y,label}]}。
     结构二（引用）：块内只有 JSON {imgSelector:"svg#id 或唯一 aria-label", q, instruction?, answers}——
     组件克隆页面上该 SVG 进块内（答案坐标=原图 viewBox 坐标，标记不污染原图）。
     点击图面落标记（可撤销/清空），「揭晓」显示预埋答案点并按 ±40（viewBox 单位）判中；
     无 SVG 或无 answers 数据时空态容错（不判分）。分数进判分卡。 */
  function buildBlindtest(el) {
    var d = readData(el) || {};
    var svg = el.querySelector("svg");
    if (!svg && d.imgSelector) { // 引用式：克隆课内已有事件图（只加 id 属性，不动原图形）
      try {
        var src = document.querySelector(d.imgSelector);
        if (src && /^(svg|SVG)$/.test(src.tagName)) {
          svg = src.cloneNode(true);
          svg.removeAttribute("id");
          svg.querySelectorAll("[id]").forEach(function (n) { n.setAttribute("id", n.getAttribute("id") + "-bt"); }); // 防重复 id
        }
      } catch (e) { /* 非法选择器等 */ }
    }
    wipeRender(el, ["SCRIPT", "svg", "SVG"]);
    delete el.dataset.btHit; delete el.dataset.btTotal;
    if (!svg) {
      var empty = document.createElement("div");
      empty.className = "bt-empty";
      empty.textContent = "盲测组件待配置：" + (d.imgSelector ? "imgSelector 未命中页内 SVG（" + d.imgSelector + "）" : "本块需内嵌一张课内 SVG 或给 imgSelector") + "。";
      el.appendChild(empty);
      return;
    }
    var answers = Array.isArray(d.answers) ? d.answers : null;
    var q = document.createElement("div");
    q.className = "q";
    q.textContent = d.q || "盲测：先标点，再揭晓";
    el.appendChild(q);
    var instr = document.createElement("div");
    instr.className = "bt-instr";
    instr.textContent = d.instruction || "先在图上点击标出你认为的信号点，再点「揭晓」对照答案——±40 坐标内算中。";
    el.appendChild(instr);

    var stage = document.createElement("div");
    stage.className = "bt-stage";
    el.appendChild(stage);
    stage.appendChild(svg);
    svg.querySelectorAll(".bt-layer").forEach(function (old) { old.remove(); }); // 重做本场：清上一轮标记/答案层
    var marks = [];
    var revealed = false;
    var overlay = svgEl("g", { "class": "bt-layer" });
    svg.appendChild(overlay);

    function viewBox() {
      try {
        var b = svg.viewBox && svg.viewBox.baseVal;
        if (b && b.width) return { x: b.x, y: b.y, w: b.width, h: b.height };
      } catch (e) {}
      var m = /([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)/.exec(svg.getAttribute("viewBox") || "");
      return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
    }
    function viewPoint(cx, cy) {
      try {
        var r = svg.getBoundingClientRect();
        var vb = viewBox();
        if (!r.width || !vb || !vb.w) return null;
        return {
          x: vb.x + (cx - r.left) / r.width * vb.w,
          y: vb.y + (cy - r.top) / r.height * vb.h
        };
      } catch (e) { return null; }
    }
    stage.addEventListener("click", function (ev) {
      if (revealed || marks.length >= 12) return;
      var p = viewPoint(ev.clientX, ev.clientY);
      if (!p) return;
      marks.push(p);
      overlay.appendChild(svgEl("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 5, "class": "bt-mark" }));
    });

    var bar = document.createElement("div");
    bar.className = "bt-bar";
    el.appendChild(bar);
    function btn(label, fn) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "bt-btn";
      b.textContent = label;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    }
    btn("撤销上一点", function () {
      if (revealed) return;
      marks.pop();
      var cs = overlay.querySelectorAll(".bt-mark");
      if (cs.length) cs[cs.length - 1].remove();
    });
    btn("清空标记", function () {
      if (revealed) return;
      marks = [];
      overlay.querySelectorAll(".bt-mark").forEach(function (c) { c.remove(); });
    });
    var reveal = btn("揭晓答案", function () {
      if (revealed) return;
      revealed = true;
      Array.prototype.forEach.call(bar.children, function (b) { b.disabled = true; });
      var out = document.createElement("div");
      out.className = "bt-result";
      el.appendChild(out);
      if (!answers || !answers.length) {
        out.textContent = "答案点待配置（answers 未接线）：标记功能可用，判分待后续接线任务补数据。";
        return;
      }
      var hits = 0;
      var rows = [];
      answers.forEach(function (a) {
        var best = null;
        marks.forEach(function (m) {
          var dist = Math.sqrt(Math.pow(m.x - a.x, 2) + Math.pow(m.y - a.y, 2));
          if (best === null || dist < best) best = dist;
        });
        var hit = best !== null && best <= 40;
        if (hit) hits++;
        overlay.appendChild(svgEl("circle", { cx: a.x, cy: a.y, r: 7, "class": "bt-ans" }));
        if (a.label) {
          var tx = svgEl("text", { x: a.x + 10, y: a.y - 8, "font-size": 11, "class": "bt-ans-label" });
          tx.textContent = a.label;
          overlay.appendChild(tx);
        }
        rows.push("<div class=\"bt-row " + (hit ? "hit" : "miss") + "\">" + (hit ? "✓" : "✗") + " " + esc(a.label || "信号点") +
          (best === null ? "（未标记）" : "（最近标记 " + Math.round(best) + "）") + "</div>");
      });
      out.innerHTML = "<div class=\"bt-score\">盲测 " + hits + " / " + answers.length + "</div>" + rows.join("");
      el.dataset.btHit = hits;
      el.dataset.btTotal = answers.length;
      try { Passport.record(courseOf(), "bt-" + hashStr(String(d.q || q.textContent)), hits === answers.length); } catch (e) {}
      emitSession();
    });
    var note = document.createElement("div");
    note.className = "sim-note";
    note.textContent = answers ? "自评规则：答案点 ±40（viewBox 坐标）内有你的标记即算中；每点独立判。" : "答案数据未接线：本块暂不判分。";
    el.appendChild(note);
  }

  /* ================================================================ 窗口复算组件（recalc-block）
     JSON {q?, windows:[{label, head?, rows?[[…]] , series?[[label,v]…], note?}], table?{title?,head,rows}}
     渲染窗口按钮组 + 表格重绘（3005 象限回报等后续接线任务喂数据）；空态容错。 */
  function buildRecalc(el) {
    var d = readData(el);
    wipeRender(el);
    var emptyNote = function (msg) {
      var n = document.createElement("div");
      n.className = "bt-empty";
      n.textContent = msg;
      el.appendChild(n);
    };
    if (!d) { emptyNote("复算组件待配置：缺 JSON 数据块。"); return; }
    if (d.q) {
      var q = document.createElement("div");
      q.className = "q";
      q.textContent = d.q;
      el.appendChild(q);
    }
    if (!d.windows || !d.windows.length) { emptyNote("复算组件待配置：windows 数据未接线。"); return; }

    var btns = document.createElement("div");
    btns.className = "sim-btns";
    el.appendChild(btns);
    var host = document.createElement("div");
    el.appendChild(host);

    function buildTable(head, rows) {
      var t = document.createElement("table");
      var thead = document.createElement("thead");
      var tr = document.createElement("tr");
      head.forEach(function (h) {
        var th = document.createElement("th");
        th.textContent = h;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      t.appendChild(thead);
      var tbody = document.createElement("tbody");
      rows.forEach(function (r) {
        var tr2 = document.createElement("tr");
        (Array.isArray(r) ? r : [r]).forEach(function (c, ci) {
          var td = document.createElement("td");
          if (typeof c === "number") { td.className = "num"; td.textContent = String(c); }
          else td.textContent = String(c);
          tr2.appendChild(td);
        });
        tbody.appendChild(tr2);
      });
      t.appendChild(tbody);
      return t;
    }

    function select(i) {
      Array.prototype.forEach.call(btns.children, function (b, bi) { b.classList.toggle("active", bi === i); });
      host.textContent = "";
      var w = d.windows[i];
      var head = w.head || (d.table && d.table.head) || ["指标", "读数"];
      var rows = w.rows || (w.series || []).map(function (p) { return [p[0], p[1]]; });
      if (!rows.length) {
        emptyNote2(host, "本窗口数据未接线（series/rows 为空）。");
        return;
      }
      host.appendChild(buildTable(head, rows));
      if (w.note) {
        var n = document.createElement("div");
        n.className = "sim-note";
        n.textContent = w.note;
        host.appendChild(n);
      }
    }
    function emptyNote2(h, msg) {
      var n = document.createElement("div");
      n.className = "bt-empty";
      n.textContent = msg;
      h.appendChild(n);
    }

    d.windows.forEach(function (w, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = w.label || ("窗口 " + (i + 1));
      b.addEventListener("click", function () { select(i); });
      btns.appendChild(b);
    });
    if (d.table && Array.isArray(d.table.rows)) {
      el.appendChild(buildTable(d.table.head || ["指标", "读数"], d.table.rows));
    }
    select(0);
  }

  /* ================================================================ 判分卡（div.judge-card，训练场尾自动挂载）
     双栏：左=本次 X/Y + 距结业标准（≥80%）+ 盲测；右=昨日错题（本课）+ 今日待练（全站）。
     全对 → 隔天重练门：此前有全对日 → lightCourse；否则提示「明天见」。 */
  var resetFns = [];
  function registerReset(fn) { resetFns.push(fn); }
  function resetPage() {
    resetFns.forEach(function (fn) { try { fn(); } catch (e) {} });
    emitSession();
  }

  function priorPerfectDay(course, today, total) {
    var byDay = {};
    Passport.data().answers.forEach(function (a) {
      if (a.course !== course) return;
      var d = dayStr(a.ts);
      if (!byDay[d]) byDay[d] = { q: {}, allOk: true };
      byDay[d].q[a.qid] = true;
      if (!a.ok) byDay[d].allOk = false;
    });
    return Object.keys(byDay).some(function (d) {
      return d < today && byDay[d].allOk && Object.keys(byDay[d].q).length >= total;
    });
  }

  function renderJudge(card) {
    var course = courseOf();
    var qs = card._quizzes;
    var total = qs.length, answered = 0, ok = 0;
    qs.forEach(function (q) {
      if (q.dataset.answered) { answered++; if (q.dataset.ok === "1") ok++; }
    });
    var pct = total ? Math.round(ok / total * 100) : 0;
    var need = Math.ceil(total * 0.8);
    var left = Math.max(0, total - answered);
    var statusLine;
    if (!total) statusLine = "（本场无计分题）";
    else if (answered < total) {
      if (ok + left < need) statusLine = "已答 " + answered + "/" + total + " · 本场已无法过线（点「重做本场」再战）";
      else statusLine = "已答 " + answered + "/" + total + " · 距结业标准（≥80%）还差 " + Math.max(0, need - ok) + " 题全对（剩 " + left + " 题）";
    }
    else statusLine = (pct >= 80 ? "已过线" : "未过线") + " · 结业标准 ≥80%（" + need + "/" + total + " 题）";

    var btHit = 0, btTot = 0;
    card._blind.forEach(function (b) {
      if (b.dataset.btTotal) { btTot += +b.dataset.btTotal; btHit += +b.dataset.btHit; }
    });
    var btLine = btTot ? "<div class=\"jc-row\">盲测 " + btHit + " / " + btTot + "</div>" : "";

    var nowMs = Date.now();
    var today = dayStr(nowMs), yest = dayStr(nowMs - DAY);
    var yWrongs = Passport.data().answers.filter(function (a) {
      return a.course === course && !a.ok && dayStr(a.ts) === yest;
    }).length;
    var due = Passport.dueReview(today).length;

    var badge = "";
    if (total && answered === total && ok === total) {
      if (priorPerfectDay(course, today, total)) {
        if (!Passport.lit(null, course)) Passport.lightCourse(course);
        badge = "<div class=\"jc-badge lit\">隔天通过——本课已点亮（课级点亮，与里程碑点亮并存）</div>";
      } else {
        badge = "<div class=\"jc-badge\">隔天徽章：明天回来重练本场仍全对才算过——明天见</div>";
      }
    }

    card.innerHTML =
      "<div class=\"jc-title\">训练场判分卡</div>" +
      "<div class=\"jc-cols\">" +
      "<div class=\"jc-col\"><div class=\"jc-big\">" + ok + " <span class=\"jc-sep\">/</span> " + total + "<span class=\"jc-pct" + (total && pct >= 80 ? " pass" : "") + "\">（" + pct + "%）</span></div>" +
      "<div class=\"jc-row\">" + statusLine + "</div>" + btLine + "</div>" +
      "<div class=\"jc-col\"><div class=\"jc-row\">昨日错题：<b>" + yWrongs + "</b> 题（本课）</div>" +
      "<div class=\"jc-row\">今日待练：<b>" + due + "</b> 题（全站到期）</div>" +
      "<div class=\"jc-row jc-hint\">错题已入本地复习池（间隔 1/3/7/14 天）</div></div>" +
      "</div>" + badge +
      "<div class=\"jc-bar\"><button type=\"button\" class=\"jc-redo\">重做本场</button></div>";
    card.querySelector(".jc-redo").addEventListener("click", resetPage);
  }

  function mountJudgeCards() {
    if (!HAS_DOM) return;
    var cards = [];
    var heads = Array.prototype.slice.call(document.querySelectorAll("h2"));
    heads.filter(function (h) { return /训练场|毕业考/.test(h.textContent || ""); }).forEach(function (h) {
      var quizzes = [], blind = [], node = h.nextElementSibling;
      while (node) {
        if (node.tagName === "H2") break;
        if (node.tagName === "QUIZ-BLOCK") quizzes.push(node);
        if (node.tagName === "BLINDTEST-BLOCK") blind.push(node);
        node = node.nextElementSibling;
      }
      if (!quizzes.length) return;
      var card = document.createElement("div");
      card.className = "judge-card";
      card._quizzes = quizzes;
      card._blind = blind;
      quizzes[quizzes.length - 1].after(card);
      cards.push(card);
    });
    if (!cards.length) {
      var all = document.querySelectorAll("quiz-block");
      if (all.length) {
        var card = document.createElement("div");
        card.className = "judge-card";
        card._quizzes = Array.prototype.slice.call(all);
        card._blind = [];
        all[all.length - 1].after(card);
        cards.push(card);
      }
    }
    // 盲测块放在图后随文（不在训练场/毕业考段内）也计入最后一张判分卡：盲测分统一入卡
    if (cards.length) {
      var counted = [];
      cards.forEach(function (c) { counted = counted.concat(c._blind); });
      document.querySelectorAll("blindtest-block").forEach(function (b) {
        if (counted.indexOf(b) < 0) cards[cards.length - 1]._blind.push(b);
      });
    }
    cards.forEach(renderJudge);
    document.addEventListener("macro:session", function () { cards.forEach(renderJudge); });
    document.addEventListener("macro:passport", function () { cards.forEach(renderJudge); });
  }

  /* ================================================================ sticky 顶栏（自动注入，新页引用本文件即获得） */
  function searchHref() {
    var p = location.pathname;
    if (p.indexOf("/lessons/") >= 0) return "../reference/search.html";
    if (p.indexOf("/reference/") >= 0) return "search.html";
    return "reference/search.html";
  }

  function mountTopbar() {
    if (!HAS_DOM) return;
    if (document.querySelector(".topbar")) return;
    var kicker = document.querySelector("header .kicker") || document.querySelector(".kicker");
    if (!kicker) return; // 非课程形态页面不注入

    var num = kicker.querySelector(".num");
    var numText = num ? num.textContent.trim() : "";
    var h1 = document.querySelector("h1");
    var title = h1 ? h1.textContent.trim() : (document.title || "");

    var prev = null, next = null;
    document.querySelectorAll("footer .nav a").forEach(function (a) {
      var t = (a.textContent || "").trim();
      if (t.indexOf("下一课") >= 0) next = a;
      else if (t.indexOf("←") === 0 && !prev) prev = a;
    });

    // 里程碑灯来源优先级：<meta name="milestone" content="M?.?">（课头显式声明）→ kicker 文本兜底
    var mid = null;
    var metaMs = document.querySelector('meta[name="milestone"]');
    if (metaMs) {
      var mv = /^M\d+\.\d+$/.exec((metaMs.getAttribute("content") || "").trim());
      if (mv) mid = mv;
    }
    if (!mid) mid = (kicker.textContent || "").match(/M\d+\.\d+/);

    var bar = document.createElement("div");
    bar.className = "topbar";
    if (prev) {
      var p = document.createElement("a");
      p.className = "tb-nav tb-prev";
      p.href = prev.getAttribute("href");
      p.textContent = prev.textContent.indexOf("主页") >= 0 ? "← 主页" : "← 上一课";
      bar.appendChild(p);
    } else {
      bar.appendChild(document.createElement("span")).className = "tb-nav tb-blank";
    }
    var main = document.createElement("div");
    main.className = "tb-main";
    if (numText) {
      var s1 = document.createElement("span");
      s1.className = "tb-num";
      s1.textContent = numText;
      main.appendChild(s1);
    }
    var s2 = document.createElement("span");
    s2.className = "tb-title";
    s2.textContent = title;
    main.appendChild(s2);
    bar.appendChild(main);
    if (next) {
      var n = document.createElement("a");
      n.className = "tb-nav tb-next";
      n.href = next.getAttribute("href");
      n.textContent = "下一课 →";
      bar.appendChild(n);
    }
    if (mid) {
      var dot = document.createElement("span");
      dot.className = "tb-dot";
      dot.dataset.ms = mid[0];
      bar.appendChild(dot);
      var updateDot = function () {
        var lit = Passport.lit(dot.dataset.ms, courseOf());
        dot.classList.toggle("lit", lit);
        dot.title = "里程碑 " + dot.dataset.ms + (lit ? " · 已点亮" : " · 未点亮");
      };
      updateDot();
      document.addEventListener("macro:passport", updateDot);
    }
    var si = document.createElement("a");
    si.className = "tb-icon tb-search";
    si.href = searchHref();
    si.title = "全站搜索";
    si.textContent = "⌕";
    bar.appendChild(si);
    var th = document.createElement("button");
    th.type = "button";
    th.className = "tb-icon tb-theme";
    var paint = function () { th.textContent = "主题·" + Theme.label[Theme.get()]; th.title = "切换深浅色（自动→浅色→深色）"; };
    th.addEventListener("click", function () { Theme.cycle(); paint(); });
    paint();
    bar.appendChild(th);

    document.body.insertBefore(bar, document.body.firstChild);
  }

  /* ================================================================ 数据截至 chip（正文/citations 第一个「截至 YYYY-MM(-DD)?」） */
  function mountAsofChip() {
    if (!HAS_DOM) return;
    var kicker = document.querySelector("header .kicker");
    if (!kicker || kicker.querySelector(".asof-chip")) return;
    var sel = ".page p, .page .stat, .page .note, .page .callout, .page td, .page li, .page figcaption, .page .citations";
    var nodes = document.querySelectorAll(sel);
    var re = /截至\s*(\d{4}-\d{2}(?:-\d{2})?)/;
    for (var i = 0; i < nodes.length; i++) {
      var m = re.exec(nodes[i].textContent || "");
      if (m) {
        var chip = document.createElement("span");
        chip.className = "asof-chip";
        chip.textContent = "数据截至 " + m[1];
        chip.title = "本课当期读数的统一截至日期（数据诚实条款）";
        kicker.appendChild(chip);
        return;
      }
    }
  }

  /* ================================================================ 术语悬停（词典 terms.js 由 tools/build-terms.py 生成） */
  function findSelfSrc() {
    var ss = document.querySelectorAll('script[src*="interact.js"]');
    return ss.length ? ss[ss.length - 1].getAttribute("src") : null;
  }

  var Hover = {
    _tried: false,
    prepare: function (terms) {
      var seen = {}, list = [];
      (terms || []).forEach(function (t) {
        var zh = String(t.zh || "").trim();
        if (zh.length < 3) return; // ≥3 字才参与匹配（避免「货币」「信用」类高频短词满页下划线）
        if (seen[zh]) return;
        seen[zh] = true;
        list.push({ zh: zh, tip: (t.en ? t.en + " — " : "") + (t.def || "") + (t.first ? "（首现 " + t.first + "）" : "") });
      });
      list.sort(function (a, b) { return b.zh.length - a.zh.length; });
      return list;
    },
    findMatch: function (text, list, used) {
      var best = null;
      for (var i = 0; i < list.length; i++) {
        if (used[list[i].zh]) continue;
        var idx = text.indexOf(list[i].zh);
        if (idx < 0) continue;
        if (!best || idx < best.start) best = { start: idx, end: idx + list[i].zh.length, term: list[i] };
      }
      return best;
    },
    scan: function (root) {
      if (!HAS_DOM) return 0;
      root = root || document;
      var terms = typeof window !== "undefined" ? window.MacroTerms : null;
      if (!terms || !terms.length) return 0;
      var list = this.prepare(terms);
      var used = {}, wrapped = 0, CAP = 200;
      var els = Array.prototype.slice.call(root.querySelectorAll("p, td"));
      for (var ei = 0; ei < els.length && wrapped < CAP; ei++) {
        var el = els[ei];
        if (el.closest && el.closest("pre, code, dfn, .no-hover")) continue;
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        var texts = [], n;
        while ((n = walker.nextNode())) {
          var par = n.parentElement, skip = false;
          while (par && par !== el) {
            if (/^(A|CODE|PRE|STRONG|DFN)$/.test(par.tagName)) { skip = true; break; }
            par = par.parentElement;
          }
          if (!skip && n.nodeValue.trim()) texts.push(n);
        }
        for (var ti = 0; ti < texts.length && wrapped < CAP; ti++) {
          var tn = texts[ti];
          var m = this.findMatch(tn.nodeValue, list, used);
          while (m && wrapped < CAP) {
            var rest = tn.splitText(m.start);
            var hit = rest.splitText(m.end - m.start); // rest=命中文本, hit=剩余
            var dfn = document.createElement("dfn");
            dfn.className = "term";
            dfn.setAttribute("data-term", m.term.zh);
            dfn.setAttribute("data-tip", m.term.tip);
            dfn.setAttribute("tabindex", "0");
            rest.parentNode.replaceChild(dfn, rest);
            dfn.appendChild(rest);
            used[m.term.zh] = true; // 每页每词仅首次
            wrapped++;
            tn = hit;
            m = this.findMatch(tn.nodeValue, list, used);
          }
        }
      }
      return wrapped;
    },
    load: function () {
      if (!HAS_DOM || this._tried) return;
      this._tried = true;
      var self = this;
      if (typeof window !== "undefined" && window.MacroTerms) { this.scan(document); return; }
      var src = findSelfSrc();
      if (!src) return;
      var s = document.createElement("script");
      s.src = src.replace(/interact\.js(\?.*)?$/, "terms.js");
      s.onload = function () { try { self.scan(document); } catch (e) {} };
      s.onerror = function () { /* 无词典（生成物缺失）即静默不启用 */ };
      (document.head || document.documentElement).appendChild(s);
    }
  };

  /* ================================================================ 模拟器（原有组件，保持不动） */
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // 债务周期模拟器（教学模型：信用流→收入→债务/GDP 三联动；参数示意非实证校准）
  var DebtSim = {
    render: function (host, d) {
      var q = document.createElement("div");
      q.className = "q";
      q.textContent = d.q;
      host.appendChild(q);

      var ctl = document.createElement("div");
      ctl.className = "sim-controls";
      function slider(label, min, max, step, val, fmt) {
        var lab = document.createElement("label");
        lab.textContent = label + " ";
        var inp = document.createElement("input");
        inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
        var out = document.createElement("output");
        out.textContent = fmt(val);
        inp.addEventListener("input", function () { out.textContent = fmt(+inp.value); redraw(); });
        lab.appendChild(inp); lab.appendChild(out);
        ctl.appendChild(lab);
        return inp;
      }
      var rate = slider("政策利率", 0, 8, 0.25, 2, function (v) { return v.toFixed(2) + "%"; });
      var mood = slider("信贷情绪", -2, 2, 0.5, 1, function (v) { return v < -0.5 ? "审慎" : v > 0.5 ? "亢奋" : "中性"; });
      var autoLab = document.createElement("label");
      var auto = document.createElement("input");
      auto.type = "checkbox";
      autoLab.appendChild(auto);
      autoLab.appendChild(document.createTextNode(" 央行自动反应（看周期自己滚出来）"));
      ctl.appendChild(autoLab);
      host.appendChild(ctl);

      var chart = svgEl("svg", { viewBox: "0 0 660 250", style: "width:100%;height:auto", role: "img", "aria-label": "模拟输出：收入指数与债务/GDP" });
      host.appendChild(chart);
      var read = document.createElement("div");
      read.className = "sim-read";
      host.appendChild(read);
      var verdict = document.createElement("div");
      verdict.className = "sim-verdict";
      host.appendChild(verdict);
      var note = document.createElement("div");
      note.className = "sim-note";
      note.textContent = "教学模型：参数为示意（非实证校准），结构与 0002 课「信用→收入→债务底座」一致。";
      host.appendChild(note);

      function panel(y0, title) {
        chart.appendChild(svgEl("line", { x1: 10, y1: y0 + 96, x2: 640, y2: y0 + 96, style: "stroke:var(--line,#e4e2d9)" })); // 深色模式走 CSS 变量（C8）
        var t = svgEl("text", { x: 12, y: y0 + 12, "font-size": 10.5, "font-weight": 700, style: "fill:var(--ink,#1c1c1a)" });
        t.textContent = title;
        chart.appendChild(t);
      }
      var p1 = 8, p2 = 132;
      panel(p1, "收入指数（起点 100）");
      panel(p2, "债务 / GDP（起点 50%）");

      function series(y0, vals, lo, hi, color) {
        var pts = vals.map(function (v, i) {
          var x = 12 + i * (628 / (vals.length - 1));
          var y = y0 + 90 - (v - lo) / (hi - lo) * 80;
          return x.toFixed(1) + "," + y.toFixed(1);
        }).join(" ");
        var old = chart.querySelector("polyline[data-c='" + color + y0 + "']");
        if (old) old.remove();
        chart.appendChild(svgEl("polyline", { points: pts, fill: "none", style: "stroke:" + color, "stroke-width": 1.8, "data-c": color + y0 }));
      }

      function redraw() {
        var r = +rate.value, s = +mood.value, autoOn = auto.checked;
        var D = 50, Y = 100, m = s, g = 2;
        var Ys = [Y], Ds = [D];
        for (var i = 0; i < 40; i++) {
          m = Math.max(-2.5, Math.min(3, m * 0.85 + (s - 0.35 * r) * 0.3));
          var c = 2.2 + 1.1 * m - 0.45 * r;
          g = 1.6 + 0.6 * c;
          D = D * (1 + (c * 1.15 - g) / 100);
          Y = Y * (1 + g / 100);
          if (autoOn) {
            var rT = Math.max(0, Math.min(8, 2.2 + (g - 2.8)));
            r = r * 0.65 + 0.35 * rT;
            rate.value = r.toFixed(2);
            rate.dispatchEvent && null;
          }
          Ys.push(Y); Ds.push(D);
        }
        series(p1, Ys, 60, 260, "var(--ink,#1c1c1a)");
        series(p2, Ds, 30, 110, "var(--up,#d33a2c)");
        var cNow = 2.2 + 1.1 * m - 0.45 * r;
        var burden = D * (0.6 * r + 1.0) / 100;
        read.textContent = "期末读数：政策利率 " + r.toFixed(2) + "% ｜ 信用流 " + cNow.toFixed(1) + "% ｜ 收入增速 " + g.toFixed(1) + "% ｜ 债务/GDP " + D.toFixed(0) + "% ｜ 利息负担 " + burden.toFixed(1) + "%";
        var v;
        if (r <= 0.05 && cNow <= 0) {
          v = "利率已贴零而信用流仍为负——这就是 0002 课的「推绳子」：零利率下限处，单靠利率这根传动轴推不动了。";
        } else if (cNow >= 3) {
          v = "过热：信用流 " + cNow.toFixed(1) + "% 跑在生产率前面，债务/GDP 在加速垫高。勾上「央行自动反应」看加息怎么把周期压回去。";
        } else if (cNow > 1) {
          v = "扩张：收入增长 " + g.toFixed(1) + "%，但注意右图——每一轮扩张的燃料都是新债务，底座只升不降。";
        } else if (cNow > 0) {
          v = "降温：信用流跌向零，收入增速回落向生产率底线（约 1.6%）。";
        } else {
          v = "收缩：信用流为负，「支出=他人收入」循环逆转——这正是衰退的自我强化机制。";
        }
        verdict.textContent = v;
      }
      rate.addEventListener("input", function () { if (auto.checked) { auto.checked = false; } redraw(); });
      auto.addEventListener("change", redraw);
      redraw();
    }
  };

  // 三市场联动演示（示意曲线：同一事件日三种预期差情形，三市场同步翻页）
  var MarketSim = {
    mk: function (base, move) {
      var pts = [];
      for (var i = 0; i <= 20; i++) {
        var x = i / 20;
        var y = x < 0.5 ? base : base + move * (1 - Math.exp(-(x - 0.5) * 6));
        pts.push(y);
      }
      return pts;
    },
    render: function (host, d) {
      var q = document.createElement("div");
      q.className = "q";
      q.textContent = d.q;
      host.appendChild(q);
      var btns = document.createElement("div");
      btns.className = "sim-btns";
      host.appendChild(btns);
      var chart = svgEl("svg", { viewBox: "0 0 660 320", style: "width:100%;height:auto", role: "img", "aria-label": "三市场联动示意" });
      host.appendChild(chart);
      var verdict = document.createElement("div");
      verdict.className = "sim-verdict";
      host.appendChild(verdict);
      var note = document.createElement("div");
      note.className = "sim-note";
      note.textContent = "示意曲线（非真实数据）：红色虚线=事件日；主线=该情形的路径示意（墨色，随主题变色），浅灰=其他情形。";
      host.appendChild(note);

      var panels = [
        { title: "美债 10Y 名义收益率", y0: 10 },
        { title: "美债 10Y 实际收益率", y0: 118 },
        { title: "美元指数", y0: 226 }
      ];
      var scen = [
        { name: "鹰派意外", moves: [1, 1.2, 1], v: "通胀与增长路径被上修：名义收益率上行，且拆开看以实际利率为主（盈亏平衡升幅小甚至回落）；美元走强（利差角）；长久期资产贴现承压。对应 2022-09 的真实读数结构。" },
        { name: "鸽派意外", moves: [-1, -1.1, -1], v: "政策路径被下修：名义收益率下行、实际利率领跌；美元走弱；长久期资产受益。方向与鹰派意外完全对称。" },
        { name: "已被定价的鹰派", moves: [0.08, 0.05, -0.3], v: "意外≈0：三市场基本不动，美元甚至小幅回落——「卖事实」。方向由预期差决定，不由事件类型决定：这是 P1「市场即预期」的第一课。" }
      ];
      var groups = [];
      panels.forEach(function (p, pi) {
        chart.appendChild(svgEl("line", { x1: 12, y1: p.y0 + 92, x2: 640, y2: p.y0 + 92, style: "stroke:var(--line,#e4e2d9)" }));
        var t = svgEl("text", { x: 14, y: p.y0 + 12, "font-size": 10.5, "font-weight": 700, style: "fill:var(--ink,#1c1c1a)" });
        t.textContent = p.title;
        chart.appendChild(t);
        chart.appendChild(svgEl("line", { x1: 326, y1: p.y0 + 4, x2: 326, y2: p.y0 + 92, style: "stroke:var(--up,#d33a2c)", "stroke-width": 1.2, "stroke-dasharray": "4 3" }));
        var gArr = [];
        scen.forEach(function (s, si) {
          var pts = MarketSim.mk(46, 30 * s.moves[pi]).map(function (y, i) {
            return (12 + i * (628 / 20)).toFixed(1) + "," + (p.y0 + 88 - y * 0.72).toFixed(1);
          }).join(" ");
          var g = svgEl("g", { opacity: si === 0 ? 1 : 0.12 });
          g.appendChild(svgEl("polyline", { points: pts, fill: "none", style: "stroke:var(--ink,#1c1c1a)", "stroke-width": 1.8 }));
          g.style.transition = "opacity .4s";
          chart.appendChild(g);
          gArr.push(g);
        });
        groups.push(gArr);
      });
      var evtLabel = svgEl("text", { x: 320, y: 316, "font-size": 10, style: "fill:var(--up,#d33a2c)", "text-anchor": "end" });
      evtLabel.textContent = "事件日（FOMC 决议公布）";
      chart.appendChild(evtLabel);

      function select(i) {
        Array.prototype.forEach.call(btns.children, function (b, bi) { b.classList.toggle("active", bi === i); });
        groups.forEach(function (gArr) { gArr.forEach(function (g, gi) { g.setAttribute("opacity", gi === i ? 1 : 0.12); }); });
        verdict.textContent = "【" + scen[i].name + "】" + scen[i].v;
      }
      scen.forEach(function (s, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = s.name;
        b.addEventListener("click", function () { select(i); });
        btns.appendChild(b);
      });
      select(0);
    }
  };

  function buildSim(el) {
    var d = readData(el);
    if (!d || !d.sim) return;
    if (d.sim === "debt-cycle") DebtSim.render(el, d);
    else if (d.sim === "three-market") MarketSim.render(el, d);
  }

  /* ================================================================ Macro.chart 数据图表组件（C4-2a，2026-10）
     <chart-block> + 内嵌 <script type="application/json"> 数据：
     {type:"line"|"duo"|"panel2"|"panel3"|"scatter"|"bar", width:720,
      series:[{name,color,dash,axis,redRise,data:[[date,v],…]}],
      events:[{date,label,side}], breaks:[{date,label}], bands:[{from,to}]（衰退带）,
      annotations:[{date,v,label,noDot}]（自动放置：与折线/事件线/已放注记/面板边界求交找空白，
      全部失败则降级图外注记行——杜绝注记双数据与压线）,
      yDomain:[lo,hi], yScale:"linear"|"log", ticks:[5 个值], fmt:"pct",
      panels:[{title,yDomain,ticks,fmt}]（panel2/3 每格）, window:[t0,t1],
      scatter:{xDomain,yDomain,recentFrom,pathFrom,quadrants,markers},
      bar:{orient:"v"|"h",…}, asOf:"2026-09-30", source:"FRED T10Y2Y", aria:"…"}
     渲染规则集中强制（课页不可覆写）：
     ① 网格恒 5 条+label；② 注记字号 11、灰阶下限 #6e6c64（浅灰一律收拢）；③ 红涨绿跌（redRise）
     仅用于涨跌语义序列，机制/对照序列用 ink；④ 图尾右下「截至 {asOf}·{source}」戳；
     ⑤ 生成 <figure>+svg[aria-label]，打印矢量原样；⑥ Macro.chart.scan() 渐进增强。
     纯函数核心 node 可 require（tools/test-chart.js：8 用例+全批几何断言）。
     算法移植自 .scratch 历史制图工具（mkchart/mkduoline/mk2panel/mkpanel3/mkscatter/
     annsearch/verifycharts：空值清洗、降采样、衰退带、注记求交、压线终检）。 */
  var ChartCore = (function () {
    var X0 = 52, X1 = 704;                       // 绘图区横向（历史工具同款）
    var INK = "#1c1c1a", MUTED = "#6e6c64", GRAYFLOOR = "#6e6c64";
    var LINE = "#e4e2d9", LINEBOLD = "#9a978e";
    var UP = "#d33a2c", DOWN = "#1a7f37", RED = "#d33a2c", BAND = "rgba(28,28,26,.09)";
    // NBER 衰退区间（月，起止）——集中一份；bands 断言与迁移清单都指向这里
    var RECESSIONS = [
      ["1957-08", "1958-04"], ["1960-04", "1961-02"], ["1969-12", "1970-11"],
      ["1973-11", "1975-03"], ["1980-01", "1980-07"], ["1981-07", "1982-11"],
      ["1990-07", "1991-03"], ["2001-03", "2001-11"], ["2007-12", "2009-06"],
      ["2020-02", "2020-04"]
    ];

    function isNum(v) { return typeof v === "number" && isFinite(v); }
    function R1(n) { return Math.round(n * 10) / 10; }
    function tms(d) {
      d = String(d);
      if (/^\d{4}$/.test(d)) d += "-01";
      if (/^\d{4}-\d{2}$/.test(d)) d += "-01";
      var t = Date.parse(d);
      return isNaN(t) ? NaN : t;
    }
    function isDateX(x) { return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(x)); }
    function fmtNum(v) {
      if (!isNum(v)) return String(v);
      if (Math.abs(v) >= 10000) return v.toLocaleString("en-US");
      return String(Math.round(v * 100) / 100);
    }
    function fmtTick(v, fmt) {
      var s2 = fmtNum(v);
      if (fmt === "pct") s2 += "%";
      if (fmt === "wan") s2 += "万";
      return s2;
    }

    /* —— 空值清洗（mkchart/clean.py 同款）：去 "."/NA/空/非数值行，保留给定顺序 —— */
    function cleanRows(data) {
      return (data || []).filter(function (r) {
        return r && r.length >= 2 && r[0] != null && r[1] != null &&
          r[1] !== "." && r[1] !== "NA" && r[1] !== "" && isNum(+r[1]);
      }).map(function (r) { return [String(r[0]), +r[1]]; });
    }

    /* —— 降采样到 ≤cap 点（mkchart 同款：等距取样+保留末点）—— */
    function downsample(rows, cap) {
      cap = cap || 300;
      if (rows.length <= cap) return rows;
      var step = Math.max(1, Math.round(rows.length / cap)), out = [];
      for (var i = 0; i < rows.length; i += step) out.push(rows[i]);
      if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
      return out;
    }

    /* —— 网格恒 5 条：lo..hi 均分（含端点）—— */
    function gridTicks(lo, hi) {
      var t = [];
      for (var i = 0; i < 5; i++) t.push(lo + (hi - lo) * i / 4);
      return t;
    }

    /* —— 红涨绿跌映射（仅涨跌语义序列；机制图用 ink）—— */
    function riseFallColor(prev, cur) {
      if (!isNum(prev) || !isNum(cur) || cur === prev) return null;
      return cur > prev ? UP : DOWN;
    }

    function catOrTime(seriesArr) {
      for (var i = 0; i < seriesArr.length; i++) {
        var d = (seriesArr[i].data || [])[0];
        if (d && !isDateX(d[0])) return "cat";
      }
      return "time";
    }

    function timeExtent(seriesArr, win) {
      if (win) return [tms(win[0]), tms(win[1])];
      var t0 = Infinity, t1 = -Infinity;
      seriesArr.forEach(function (sr) {
        (sr.data || []).forEach(function (r) {
          var t = tms(r[0]);
          if (isNaN(t)) return;
          if (t < t0) t0 = t;
          if (t > t1) t1 = t;
        });
      });
      return [t0, t1];
    }

    /* ============ 注记放置（annsearch.py 移植）：候选 (anchor,dx,dy) 求无冲突者 ============ */
    function textW(t) { // 字号 11：CJK 全宽、ASCII 约 0.55 倍
      var w = 0;
      String(t).split("").forEach(function (c) { w += c.charCodeAt(0) > 0x2e80 ? 11 : 6; });
      return w;
    }
    function labelRect(tx, ty, t, anchor) {
      var lines = String(t).split("\n");
      var w = 0;
      lines.forEach(function (ln) { w = Math.max(w, textW(ln)); });
      var x0 = anchor === "end" ? tx - w : (anchor === "middle" ? tx - w / 2 : tx);
      return { x0: x0, y0: ty - 9.5, x1: x0 + w, y1: ty + 2 + (lines.length - 1) * 12 }; // 多行注记占位同高
    }
    function segHitsRect(p1, p2, r) {
      if (Math.max(p1[0], p2[0]) < r.x0 - 2 || Math.min(p1[0], p2[0]) > r.x1 + 2) return false;
      for (var k = 0; k <= 20; k++) {
        var tt = k / 20;
        var px = p1[0] + (p2[0] - p1[0]) * tt, py = p1[1] + (p2[1] - p1[1]) * tt;
        if (r.x0 - 2 <= px && px <= r.x1 + 2 && r.y0 - 1 <= py && py <= r.y1 + 1) return true;
      }
      return false;
    }
    function placeText(label, ax, ay, ctx) {
      var best = null;
      for (var ai = 0; ai < 3; ai++) {
        var anchor = ["end", "start", "middle"][ai];
        for (var dx = -260; dx <= 260; dx += 12) {
          for (var dy = -72; dy <= 72; dy += 6) {
            var r = labelRect(ax + dx, ay + dy, label, anchor);
            if (r.y0 < ctx.top + 2 || r.y1 > ctx.bot - 2) continue;
            if (r.x0 < X0 + 2 || r.x1 > X1 - 4) continue;
            var bad = false;
            for (var e = 0; e < ctx.evX.length; e++) {
              if (r.x0 - 3 <= ctx.evX[e] && ctx.evX[e] <= r.x1 + 3) { bad = true; break; }
            }
            if (bad) continue;
            var pts = ctx.pts;
            for (var i = 0; i < pts.length - 1 && !bad; i++) {
              if (segHitsRect(pts[i], pts[i + 1], r)) bad = true;
            }
            if (bad) continue;
            for (var p = 0; p < ctx.placed.length; p++) {
              var q = ctx.placed[p];
              if (!(r.x1 + 2 < q.x0 || q.x1 + 2 < r.x0 || r.y1 + 1 < q.y0 || q.y1 + 1 < r.y0)) { bad = true; break; }
            }
            if (bad) continue;
            var score = Math.abs(dx) + Math.abs(dy);
            if (!best || score < best.score) best = { score: score, anchor: anchor, x: ax + dx, y: ay + dy, rect: r };
          }
        }
      }
      return best;
    }

    /* ============ 渲染主入口（纯函数，node/浏览器同路径） ============ */
    function render(spec) {
      var warn = [];
      if (!spec || !spec.type) return { svg: "", warnings: ["spec 缺 type"] };
      if (spec.type !== "bar" && !Array.isArray(spec.series)) return { svg: "", warnings: ["spec 缺 series"] };
      if (spec.type === "bar" && !Array.isArray(spec.series)) spec.series = spec.series || [];
      var W = spec.width || 720;
      var type = spec.type;
      var s = [];   // svg 内部标记（拼接顺序= z 序）
      var H = 300;
      var outsideAnns = [];

      function el(tag, attrs, text) {
        var a = "";
        for (var k in attrs) if (attrs[k] != null) a += " " + k + '="' + attrs[k] + '"';
        return "<" + tag + a + (text != null ? ">" + esc(text) + "</" + tag + ">" : "/>");
      }

      /* —— x 比例尺（时间或类目）—— */
      var mode = catOrTime(spec.series);
      var cats = [], xsOf = null, t01 = null;
      if (mode === "cat") {
        spec.series.forEach(function (sr) {
          (sr.data || []).forEach(function (r) { if (cats.indexOf(r[0]) < 0) cats.push(r[0]); });
        });
        xsOf = function (c) {
          var i = cats.indexOf(c);
          if (i < 0) return NaN;
          return cats.length === 1 ? X0 : X0 + i * (X1 - X0) / (cats.length - 1);
        };
      } else {
        t01 = timeExtent(spec.series, spec.window);
        if (!isFinite(t01[0]) || !isFinite(t01[1])) {
          if (type === "bar") t01 = [0, 1]; // bar 数据在 bar.groups/bars，不走时间轴
          else return { svg: "", warnings: ["时间轴无法确立（x 非日期）"] };
        }
        xsOf = function (d) { var t = tms(d); return isNaN(t) ? NaN : X0 + (t - t01[0]) / (t01[1] - t01[0]) * (X1 - X0); };
      }

      /* —— y 比例尺（显式 top/bot，支持 log；越域裁剪+告警）—— */
      function yMapper(lo, hi, scale, top, bot) {
        var llo = scale === "log" ? Math.log(lo) : lo, lhi = scale === "log" ? Math.log(hi) : hi;
        return function (v) {
          var vv = scale === "log" ? Math.log(Math.max(v, lo)) : v;
          var y = bot - (vv - llo) / (lhi - llo) * (bot - top);
          if (y < top - 0.05 || y > bot + 0.05) {
            warn.push("y 域裁剪：" + fmtNum(v) + " 超出 [" + fmtNum(lo) + "," + fmtNum(hi) + "]");
            y = Math.max(top, Math.min(bot, y));
          }
          return y;
        };
      }

      function polyEl(pts, color, width, dash) {
        return el("polyline", {
          points: pts.map(function (p) { return R1(p[0]) + "," + R1(p[1]); }).join(" "),
          fill: "none", stroke: color, "stroke-width": width,
          "stroke-dasharray": dash || null
        });
      }

      /* 序列预处理：清洗→降采样→像素点（绘图与注记求交共用一套点，防双数据） */
      function prepare(sr, yfn) {
        var rows = downsample(cleanRows(sr.data));
        return { sr: sr, rows: rows, pts: rows.map(function (r) { return [xsOf(r[0]), yfn(r[1])]; }) };
      }

      /* 红涨绿跌：按段方向拆色（仅 sr.redRise；同色段合并） */
      function drawSeries(pre, width) {
        var sr = pre.sr;
        s.push('<g clip-path="url(#mc-plot-clip)">');   // 折线裁剪：数据越出绘图区时干净截断
        if (sr.redRise) {
          var runs = [], cur = [pre.pts[0]], curColor = null;
          for (var i = 1; i < pre.rows.length; i++) {
            var c = riseFallColor(pre.rows[i - 1][1], pre.rows[i][1]) || curColor || UP;
            if (curColor === null) curColor = c;
            if (c === curColor) cur.push(pre.pts[i]);
            else { runs.push({ pts: cur, color: curColor }); cur = [cur[cur.length - 1], pre.pts[i]]; curColor = c; }
          }
          if (cur && cur.length > 1) runs.push({ pts: cur, color: curColor });
          runs.forEach(function (run) { s.push(polyEl(run.pts, run.color, width)); });
        } else {
          s.push(polyEl(pre.pts, sr.color || INK, width, sr.dash));
        }
        s.push("</g>");
      }

      /* —— 网格（恒 5 条；零线加粗）—— */
      function drawGrid(yfn, ticks, fmt, ylo, yhi) {
        ticks.forEach(function (tv) {
          var y = R1(yfn(tv));
          var bold = Math.abs(tv) < 1e-9 && ylo < 0 && yhi > 0;
          s.push(el("line", { x1: X0, y1: y, x2: X1, y2: y, stroke: bold ? LINEBOLD : LINE, "stroke-width": bold ? 1.4 : 1 }));
          s.push('<text x="' + (X0 - 6) + '" y="' + R1(y + 3.5) + '" text-anchor="end" font-size="10" fill="' + MUTED + '">' + esc(fmtTick(tv, fmt)) + "</text>");
        });
      }

      function drawXTicks(xEnd) {
        var ticks = spec.xTicks;
        if (!ticks) {
          if (mode === "cat") {
            ticks = cats.map(function (c) { return { x: c, label: c }; });
          } else {
            ticks = [];
            var y0d = new Date(t01[0]).getFullYear(), y1d = new Date(t01[1]).getFullYear();
            var span = y1d - y0d, step = span <= 3 ? 1 : span <= 8 ? 2 : span <= 20 ? 5 : 10;
            for (var yy = Math.ceil(y0d / step) * step; yy <= y1d; yy += step) ticks.push({ date: yy + "-01-01", label: String(yy) });
          }
        }
        ticks.forEach(function (tk) {
          var px = R1(xsOf(tk.date != null ? tk.date : tk.x));
          if (!(px >= X0 - 1 && px <= X1 + 1)) return;
          s.push(el("line", { x1: px, y1: xEnd, x2: px, y2: xEnd + 4, stroke: MUTED }));
          s.push('<text x="' + px + '" y="' + (xEnd + 16) + '" text-anchor="middle" font-size="10" fill="' + MUTED + '">' + esc(tk.label != null ? tk.label : String(tk.date || tk.x)) + "</text>");
        });
      }

      /* —— 衰退带（裁剪到图窗；带数可断言）—— */
      function drawBands(top, bot) {
        if (mode === "cat") return;
        (spec.bands || []).forEach(function (b) {
          var xa = xsOf(b.from), xb = xsOf(b.to);
          if (!isNum(xa) || !isNum(xb) || xb < X0 || xa > X1) return;
          var w = Math.min(xb, X1) - Math.max(xa, X0);
          if (w < 0.5) return;
          s.push(el("rect", { x: R1(Math.max(xa, X0)), y: R1(top), width: R1(w), height: R1(bot - top), fill: BAND }));
        });
      }

      /* —— 事件线（红虚线，跨面板）与断点线（灰虚线，口径断点）；
             标签放置与折线求交避让（同 annsearch 思路，垂直找空位）—— */
      function labelHitsPts(r, pts) {
        for (var i = 0; i < pts.length; i++) {
          var p = pts[i];
          if (r.x0 - 3 <= p[0] && p[0] <= r.x1 + 3 && r.y0 - 2 <= p[1] && p[1] <= r.y1 + 2) return true;
        }
        return false;
      }
      function placeEventLabel(tx, ty, label, anchor, color, pts) {
        var dys = [0, 13, 26, 39, -9];
        for (var i = 0; i < dys.length; i++) {
          var r = labelRect(tx, ty + dys[i], label, anchor);
          if (r.y1 > bot - 2 || r.y0 < top + 1) continue; // 事件标签留在本面板内
          if (!pts || !labelHitsPts(r, pts)) {
            s.push('<text x="' + R1(tx) + '" y="' + R1(ty + dys[i]) + '" text-anchor="' + anchor + '" font-size="10" fill="' + color + '">' + esc(label) + "</text>");
            return;
          }
        }
        s.push('<text x="' + R1(tx) + '" y="' + R1(ty) + '" text-anchor="' + anchor + '" font-size="10" fill="' + color + '">' + esc(label) + "</text>"); // 兜底原位
      }
      function drawEvents(top, bot, pts) {
        var evX = [];
        (spec.events || []).forEach(function (ev) {
          var px = xsOf(ev.date);
          if (!isNum(px) || px < X0 || px > X1) return;
          evX.push(px);
          s.push(el("line", { x1: R1(px), y1: top, x2: R1(px), y2: bot, stroke: RED, "stroke-width": 1.2, "stroke-dasharray": "4 3" }));
          var anchor = ev.side === "right" ? "start" : "end";
          var tx = ev.side === "right" ? px + 5 : px - 5;
          placeEventLabel(tx, top + 13, ev.label, anchor, RED, pts);
        });
        (spec.breaks || []).forEach(function (bk) {
          var px = xsOf(bk.date);
          if (!isNum(px) || px < X0 || px > X1) return;
          s.push(el("line", { x1: R1(px), y1: top, x2: R1(px), y2: bot, stroke: MUTED, "stroke-width": 1.2, "stroke-dasharray": "2 3" }));
          if (bk.label) placeEventLabel(px + 5, top + 13, bk.label, "start", MUTED, pts);
        });
        return evX;
      }

      /* —— 注记：circle+text 自动放置（11 号；与折线/事件线/已放注记/面板边界求交）；
             失败→图外注记行。v 缺省时从面板首序列取最近值（防注记双数据）—— */
      function drawAnnotations(panelIdx, yfn, pres, top, bot) {
        var ctx = { top: top, bot: bot, evX: [], pts: [], placed: [] };
        (spec.events || []).forEach(function (e) { var px = xsOf(e.date); if (isNum(px) && px >= X0 && px <= X1) ctx.evX.push(px); });
        pres.forEach(function (pre) { ctx.pts = ctx.pts.concat(pre.pts); });
        (spec.annotations || []).forEach(function (a) {
          if ((a.axis == null ? 0 : a.axis) !== panelIdx) return;
          var ax = xsOf(a.date);
          if (!isNum(ax) || ax < X0 || ax > X1) { warn.push("注记日期越窗：" + a.date); return; }
          var v = a.v, nearest = null;
          if (v == null && pres.length) {
            pres[0].rows.forEach(function (r) {
              if (String(r[0]) <= String(a.date) && (!nearest || r[0] > nearest[0])) nearest = r;
            });
            v = nearest ? nearest[1] : null;
          }
          if (v == null) { warn.push("注记缺数值且查不到序列值：" + a.label); return; }
          var ay = yfn(v);
          if (!a.noDot) s.push(el("circle", { cx: R1(ax), cy: R1(ay), r: 3, fill: a.color || INK }));
          var p = placeText(a.label, ax, ay, ctx);
          if (p) {
            ctx.placed.push(p.rect);
            String(a.label).split("\n").forEach(function (ln, li) {
              s.push('<text x="' + R1(p.x) + '" y="' + R1(p.y + li * 12) + '" text-anchor="' + p.anchor + '" font-size="11" fill="' + (a.color || INK) + '">' + esc(ln) + "</text>");
            });
          } else {
            outsideAnns.push(String(a.label).replace(/\n/g, " "));
            warn.push("注记无空白位（降级图外）：" + a.label);
          }
        });
      }

      /* —— 顶部图例（多序列单面板）/说明行 —— */
      function drawHead() {
        var multi = spec.series.length > 1 && type !== "panel2" && type !== "panel3" && type !== "bar";
        var ly = 12;
        if (multi) {
          var x = X0;
          spec.series.forEach(function (sr) {
            s.push(el("line", { x1: x, y1: ly, x2: x + 20, y2: ly, stroke: sr.color || INK, "stroke-width": 2, "stroke-dasharray": sr.dash || null }));
            var name = sr.name || "";
            s.push('<text x="' + (x + 24) + '" y="' + (ly + 3.5) + '" font-size="10.5" fill="' + INK + '">' + esc(name) + "</text>");
            x += 24 + textW(name) + 18;
          });
        }
        if (spec.note) s.push('<text x="' + X0 + '" y="' + (multi ? 23 : 16) + '" font-size="10.5" fill="' + MUTED + '">' + esc(spec.note) + "</text>");
        return multi && spec.note ? 12 : 0; // 图例与说明并存时多留一行
      }

      /* —— 图尾戳：截至 {asOf} · {source}（右下）+ 图外注记行（左下） —— */
      function drawStamp(Ht) {
        if (spec.asOf || spec.source) {
          var stamp = "截至 " + (spec.asOf || "") + (spec.source ? " · " + spec.source : "");
          s.push('<text x="' + X1 + '" y="' + (Ht - 5) + '" text-anchor="end" font-size="9.5" fill="' + MUTED + '">' + esc(stamp) + "</text>");
        }
        if (outsideAnns.length) {
          s.push('<text x="' + X0 + '" y="' + (Ht - 5) + '" font-size="9.5" fill="' + MUTED + '">图外注记：' + esc(outsideAnns.join("；")) + "</text>");
        }
      }

      function domainOf(list, fallbackPad) {
        var lo = Infinity, hi = -Infinity;
        list.forEach(function (sr) { cleanRows(sr.data).forEach(function (r) { if (r[1] < lo) lo = r[1]; if (r[1] > hi) hi = r[1]; }); });
        if (!isFinite(lo)) return [0, 1];
        var pad = (hi - lo) * (fallbackPad || 0.05) || 1;
        return [lo - pad, hi + pad];
      }

      /* ================= 类型分派 ================= */
      if (type === "line" || type === "duo") {
        var extraTop = drawHead();
        var top = 24 + extraTop, bot = 272;
        var yd = spec.yDomain || domainOf(spec.series);
        var yfn = yMapper(yd[0], yd[1], spec.yScale, top, bot);
        var ticks = (spec.ticks && spec.ticks.length === 5) ? spec.ticks : gridTicks(yd[0], yd[1]);
        drawBands(top, bot);
        drawGrid(yfn, ticks, spec.fmt, yd[0], yd[1]);
        var pres = spec.series.map(function (sr) { return prepare(sr, yfn); });
        pres.forEach(function (pre) { drawSeries(pre, spec.series.length > 1 ? 1.6 : 1.8); });
        var ptsAll = [];
        pres.forEach(function (pre) { ptsAll = ptsAll.concat(pre.pts); });
        drawEvents(top, bot, ptsAll);
        drawAnnotations(0, yfn, pres, top, bot);
        drawXTicks(bot);
        H = bot + 26 + 16;
      } else if (type === "panel2" || type === "panel3") {
        var nP = type === "panel3" ? 3 : 2;
        var panels = spec.panels || [];
        while (panels.length < nP) panels.push({});
        var pH = 92, gap = 16, top0 = 30;
        if (spec.note) s.push('<text x="' + X0 + '" y="16" font-size="10.5" fill="' + MUTED + '">' + esc(spec.note) + "</text>");
        panels.forEach(function (p, i) {
          var py0 = top0 + i * (pH + gap + 14), py1 = py0 + pH;
          var sers = spec.series.filter(function (sr) { return (sr.axis == null ? 0 : sr.axis) === i; });
          var yd = p.yDomain || domainOf(sers);
          var yfn = yMapper(yd[0], yd[1], p.yScale, py0, py1);
          var ticks = (p.ticks && p.ticks.length === 5) ? p.ticks : gridTicks(yd[0], yd[1]);
          drawBands(py0, py1);
          drawGrid(yfn, ticks, p.fmt, yd[0], yd[1]);
          if (p.title) s.push('<text x="' + (X0 + 2) + '" y="' + (py0 - 5) + '" font-size="10.5" font-weight="700" fill="' + INK + '">' + esc(p.title) + "</text>");
          var pres = sers.map(function (sr) { return prepare(sr, yfn); });
          pres.forEach(function (pre) { drawSeries(pre, 1.5); });
          var ptsP = [];
          pres.forEach(function (pre) { ptsP = ptsP.concat(pre.pts); });
          drawEvents(py0, py1, ptsP);
          drawAnnotations(i, yfn, pres, py0, py1);
        });
        var xEnd = top0 + (nP - 1) * (pH + gap + 14) + pH;
        drawXTicks(xEnd);
        H = xEnd + 26 + 16;
      } else if (type === "scatter") {
        var sc = spec.scatter || {};
        var pts3 = (spec.series[0] && spec.series[0].data) || [];
        var top = 24, bot = 268;
        function rngOf(idx, given) {
          if (given) return given;
          var lo = Infinity, hi = -Infinity;
          pts3.forEach(function (r) { if (r[idx] < lo) lo = r[idx]; if (r[idx] > hi) hi = r[idx]; });
          var pad = (hi - lo) * 0.08 || 1; return [lo - pad, hi + pad];
        }
        var xd = rngOf(1, sc.xDomain), yd2 = rngOf(2, sc.yDomain);
        var X0s = 56, X1s = 700;
        function sx(v) { return X0s + (v - xd[0]) / (xd[1] - xd[0]) * (X1s - X0s); }
        var yfnS = yMapper(yd2[0], yd2[1], null, top, bot);
        function sy(v) { return yfnS(v); }
        gridTicks(yd2[0], yd2[1]).forEach(function (tv) {
          var bold = Math.abs(tv) < 1e-9;
          s.push(el("line", { x1: X0s, y1: R1(sy(tv)), x2: X1s, y2: R1(sy(tv)), stroke: bold ? LINEBOLD : LINE, "stroke-width": bold ? 1.4 : 1 }));
          s.push('<text x="' + (X0s - 6) + '" y="' + R1(sy(tv) + 3.5) + '" text-anchor="end" font-size="10" fill="' + MUTED + '">' + esc(fmtTick(tv, sc.yFmt)) + "</text>");
        });
        gridTicks(xd[0], xd[1]).forEach(function (tv) {
          var bold = Math.abs(tv) < 1e-9;
          var px = R1(sx(tv));
          s.push(el("line", { x1: px, y1: top, x2: px, y2: bot, stroke: bold ? LINEBOLD : LINE, "stroke-width": bold ? 1.4 : 1 }));
          s.push('<text x="' + px + '" y="' + (bot + 16) + '" text-anchor="middle" font-size="10" fill="' + MUTED + '">' + esc(fmtTick(tv, sc.xFmt)) + "</text>");
        });
        (sc.quadrants || []).forEach(function (q) {
          s.push('<text x="' + q.x + '" y="' + q.y + '" text-anchor="middle" font-size="11" fill="' + GRAYFLOOR + '" font-weight="700">' + esc(q.t) + "</text>");
        });
        var recent = sc.recentFrom;
        pts3.forEach(function (r) {
          var isR = recent ? String(r[0]) >= recent : false;
          s.push(el("circle", { cx: R1(sx(r[1])), cy: R1(sy(r[2])), r: isR ? 2.8 : 2.4, fill: isR ? "rgba(28,28,26,.55)" : "rgba(28,28,26,.22)" }));
        });
        if (sc.pathFrom) {
          var path = pts3.filter(function (r) { return String(r[0]) >= sc.pathFrom; });
          s.push(polyEl(path.map(function (r) { return [sx(r[1]), sy(r[2])]; }), RED, 1.6));
        }
        (sc.markers || []).forEach(function (m) {
          var hit = null;
          pts3.forEach(function (r) { if (String(r[0]) === String(m.d)) hit = r; });
          if (!hit) return;
          s.push(el("circle", { cx: R1(sx(hit[1])), cy: R1(sy(hit[2])), r: 4, fill: RED }));
          s.push('<text x="' + R1(sx(hit[1]) + 6) + '" y="' + R1(sy(hit[2]) - 6) + '" font-size="11" fill="' + RED + '" font-weight="700">' + esc(m.t) + "</text>");
        });
        if (sc.xlabel) s.push('<text x="' + X0s + '" y="14" font-size="10.5" fill="' + MUTED + '">' + esc(sc.xlabel) + "</text>");
        if (spec.note) s.push('<text x="' + X0 + '" y="' + (sc.xlabel ? 27 : 16) + '" font-size="10.5" fill="' + MUTED + '">' + esc(spec.note) + "</text>");
        H = bot + 26 + 16;
      } else if (type === "bar") {
        var bar = spec.bar || {};
        if (bar.orient === "h") {
          var rowsb = bar.bars || [];
          var x0b = bar.x0 || 150, x1b = X1;
          var maxv = 0;
          rowsb.forEach(function (r) { if (Math.abs(r.value) > maxv) maxv = Math.abs(r.value); });
          var xd2 = bar.xDomain || [0, maxv * 1.15];
          function sx2(v) { return x0b + (v - xd2[0]) / (xd2[1] - xd2[0]) * (x1b - x0b); }
          var gridTop = 24, gridBot = 24 + rowsb.length * 27;
          gridTicks(xd2[0], xd2[1]).forEach(function (tv) {
            var px = R1(sx2(tv));
            s.push(el("line", { x1: px, y1: gridTop, x2: px, y2: gridBot, stroke: LINE, "stroke-width": 1 }));
            s.push('<text x="' + px + '" y="' + (gridBot + 14) + '" text-anchor="middle" font-size="10" fill="' + MUTED + '">' + esc(fmtTick(tv, bar.fmt)) + "</text>");
          });
          if (bar.ref) {
            var rx = R1(sx2(bar.ref.v));
            s.push(el("line", { x1: rx, y1: gridTop, x2: rx, y2: gridBot, stroke: RED, "stroke-width": 1.2, "stroke-dasharray": "4 3" }));
            s.push('<text x="' + rx + '" y="18" text-anchor="middle" font-size="9.5" fill="' + RED + '">' + esc(bar.ref.label) + "</text>");
          }
          rowsb.forEach(function (r, i) {
            var yc = 34 + i * 27;
            s.push('<text x="' + (x0b - 8) + '" y="' + R1(yc + 3.5) + '" text-anchor="end" font-size="10.5" fill="' + INK + '">' + esc(r.label) + "</text>");
            var bw = Math.max(1, sx2(r.value) - x0b);
            s.push(el("rect", { x: x0b, y: R1(yc - 8), width: R1(bw), height: 16, fill: r.color || INK }));
            var vt = r.display || fmtTick(r.value, bar.fmt);
            if (bw > textW(vt) * 0.8 + 10) {
              s.push('<text x="' + R1(x0b + bw - 5) + '" y="' + R1(yc + 3.5) + '" text-anchor="end" font-size="10" fill="#fff" font-weight="700">' + esc(vt) + "</text>");
            } else {
              s.push('<text x="' + R1(x0b + bw + 5) + '" y="' + R1(yc + 3.5) + '" font-size="10" fill="' + INK + '" font-weight="700">' + esc(vt) + "</text>");
            }
            if (r.date) s.push('<text x="' + x1b + '" y="' + R1(yc + 3.5) + '" text-anchor="end" font-size="9.5" fill="' + MUTED + '">' + esc(r.date) + "</text>");
          });
          H = gridBot + 30;
        } else {
          var groups = bar.groups || [];
          var all = [];
          groups.forEach(function (g) { (g.bars || []).forEach(function (b) { all.push(b.value); }); });
          var mn = Math.min(0, all.length ? Math.min.apply(null, all) : 0);
          var mx = Math.max(0, all.length ? Math.max.apply(null, all) : 1);
          var yd3 = bar.yDomain || [mn - (mx - mn) * 0.08, mx + (mx - mn) * 0.12];
          var top = 30, bot = 244;
          var yfn3 = yMapper(yd3[0], yd3[1], null, top, bot);
          drawGrid(yfn3, (bar.ticks && bar.ticks.length === 5) ? bar.ticks : gridTicks(yd3[0], yd3[1]), bar.fmt, yd3[0], yd3[1]);
          var gw = (X1 - X0) / Math.max(1, groups.length);
          groups.forEach(function (g, gi) {
            var cxg = X0 + (gi + 0.5) * gw;
            var nb = (g.bars || []).length;
            var bw = Math.min(56, gw * 0.32);
            (g.bars || []).forEach(function (b, bi) {
              var bx = cxg - (nb * bw + (nb - 1) * 8) / 2 + bi * (bw + 8);
              var yTop = yfn3(Math.max(0, b.value)), yBot = yfn3(Math.min(0, b.value));
              var color = b.color || (g.redRise ? (b.value >= 0 ? UP : DOWN) : INK);
              s.push(el("rect", { x: R1(bx), y: R1(Math.min(yTop, yBot)), width: R1(bw), height: R1(Math.abs(yBot - yTop) || 1), fill: color }));
              var vt = b.display || fmtTick(b.value, bar.fmt);
              var above = b.value >= 0;
              s.push('<text x="' + R1(bx + bw / 2) + '" y="' + R1(above ? Math.min(yTop, yBot) - 6 : Math.max(yTop, yBot) + 14) + '" text-anchor="middle" font-size="11" fill="' + (b.color || INK) + '" font-weight="700">' + esc(vt) + "</text>");
            });
            s.push('<text x="' + R1(cxg - 4) + '" y="' + (bot + 24) + '" text-anchor="middle" font-size="11" fill="' + INK + '" font-weight="700">' + esc(g.label) + "</text>");
            if (g.sub) s.push('<text x="' + R1(cxg - 4) + '" y="' + (bot + 40) + '" text-anchor="middle" font-size="9.5" fill="' + MUTED + '">' + esc(g.sub) + "</text>");
          });
          if (bar.legend) {
            var lx = X0;
            bar.legend.forEach(function (l) {
              s.push(el("line", { x1: lx, y1: 14, x2: lx + 22, y2: 14, stroke: l[1], "stroke-width": 8 }));
              s.push('<text x="' + (lx + 27) + '" y="17.5" font-size="10" fill="' + INK + '">' + esc(l[0]) + "</text>");
              lx += 27 + textW(l[0]) * 0.95 + 22;
            });
          }
          H = bot + 58;
        }
      } else {
        return { svg: "", warnings: ["未知 type=" + type] };
      }

      H = spec.height || Math.round(H);
      drawStamp(H);
      var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(spec.aria || "") + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:#fff">'
        + '<defs><clipPath id="mc-plot-clip"><rect x="' + X0 + '" y="8" width="' + (X1 - X0) + '" height="' + (H - 16 - 8) + '"/></clipPath></defs>'
        + s.join("") + "</svg>";
      return { svg: svg, warnings: warn, height: H };
    }

    /* ============ 几何终检（verifycharts 思路）：折线/矩形/文字必须在 viewBox 内 ============ */
    function checkGeometry(svg) {
      var vb = /viewBox="([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)"/.exec(svg);
      if (!vb) return ["无 viewBox"];
      var vx = +vb[1], vy = +vb[2], vw = +vb[3], vh = +vb[4];
      var bad = [];
      var pm = /<polyline points="([^"]+)"/g, m;
      while ((m = pm.exec(svg))) {
        var pts = m[1].trim().split(/\s+/);
        for (var i = 0; i < pts.length; i++) {
          var xy = pts[i].split(",");
          var px = +xy[0], py = +xy[1];
          if (!(px >= vx - 0.5 && px <= vx + vw + 0.5 && py >= vy - 0.5 && py <= vy + vh + 0.5)) {
            bad.push("polyline 点越界 " + pts[i]); break;
          }
        }
      }
      var rm = /<rect\b([^>]*)>/g;
      while ((m = rm.exec(svg))) {
        var at = m[1];
        var rx = parseFloat(/x="([\d.eE+-]+)"/.exec(at)[1]);
        var ry = parseFloat(/y="([\d.eE+-]+)"/.exec(at)[1]);
        var rw = parseFloat((/width="([\d.eE+-]+)"/.exec(at) || [0, 0])[1]);
        var rh = parseFloat((/height="([\d.eE+-]+)"/.exec(at) || [0, 0])[1]);
        if (ry < vy - 0.5 || ry + rh > vy + vh + 0.5 || rx < vx - 0.5 || rx + rw > vx + vw + 0.5) bad.push("rect 越界 y=" + ry + " h=" + rh);
      }
      var tm2 = /<text\b[^>]*x="([\d.eE+-]+)" y="([\d.eE+-]+)"/g;
      while ((m = tm2.exec(svg))) {
        if (+m[2] < vy - 0.5 || +m[2] > vy + vh + 0.5 || +m[1] < vx - 0.5 || +m[1] > vx + vw + 0.5) bad.push("text 越界 (" + m[1] + "," + m[2] + ")");
      }
      return bad;
    }

    /* ============ 压线终检：11 号注记 vs 折线段/互压（verifycharts 移植） ============ */
    function checkOverlaps(svg) {
      var polys = [];
      var pm = /<polyline points="([^"]+)"/g, m;
      while ((m = pm.exec(svg))) {
        polys.push(m[1].trim().split(/\s+/).map(function (p) { var xy = p.split(","); return [+xy[0], +xy[1]]; }));
      }
      var labels = [];
      var tm3 = /<text x="([\d.-]+)" y="([\d.-]+)"([^>]*)>([^<]+)<\/text>/g;
      while ((m = tm3.exec(svg))) {
        var x = +m[1], y = +m[2], attr = m[3], t = m[4];
        var isAnn = attr.indexOf('font-size="11"') >= 0;
        var isEvt = attr.indexOf('font-size="10"') >= 0 && /#d33a2c|#6e6c64/.test(attr);
        if (!isAnn && !isEvt) continue; // 注记（11 号）+ 事件/断点标签（10 号红灰）都检，刻度/图例除外
        var w = textW(t);
        var left, right;
        if (attr.indexOf('text-anchor="end"') >= 0) { left = x - w; right = x; }
        else if (attr.indexOf('text-anchor="middle"') >= 0) { left = x - w / 2; right = x + w / 2; }
        else { left = x; right = x + w; }
        labels.push({ text: t, left: left, top: y - 9, right: right, bottom: y + 2 });
      }
      var bad = [];
      labels.forEach(function (L) {
        polys.forEach(function (poly) {
          for (var i = 0; i < poly.length - 1; i++) {
            if (poly[i][0] > L.right + 30 || poly[i + 1][0] < L.left - 30) continue;
            for (var k = 0; k <= 20; k++) {
              var tt = k / 20;
              var px = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * tt;
              var py = poly[i][1] + (poly[i + 1][1] - poly[i][1]) * tt;
              if (L.left - 2 <= px && px <= L.right + 2 && L.top - 1 <= py && py <= L.bottom + 1) {
                bad.push("注记压线 [" + L.text.slice(0, 18) + "]");
                return;
              }
            }
          }
        });
      });
      for (var a = 0; a < labels.length; a++) {
        for (var b = a + 1; b < labels.length; b++) {
          var A = labels[a], B = labels[b];
          if (!(A.right < B.left || B.right < A.left || A.bottom < B.top || B.bottom < A.top)) bad.push("注记互压 [" + A.text.slice(0, 12) + "]×[" + B.text.slice(0, 12) + "]");
        }
      }
      return bad;
    }

    return {
      X0: X0, X1: X1, INK: INK, MUTED: MUTED, UP: UP, DOWN: DOWN, BAND: BAND,
      RECESSIONS: RECESSIONS,
      cleanRows: cleanRows, downsample: downsample, gridTicks: gridTicks,
      riseFallColor: riseFallColor, placeText: placeText, textW: textW, fmtNum: fmtNum,
      render: render, checkGeometry: checkGeometry, checkOverlaps: checkOverlaps
    };
  })();

  function buildChart(el) {
    var d = readData(el);
    if (!d || !d.type) return;
    var cap = el.querySelector("figcaption"); // 保留课页手写 figcaption（含来源链接与口径注）
    var out = ChartCore.render(d);
    if (!out.svg) return;
    wipeRender(el, ["SCRIPT"]);
    var fig = document.createElement("figure");
    var holder = document.createElement("div");
    holder.innerHTML = out.svg;
    fig.appendChild(holder.firstChild);
    if (cap) fig.appendChild(cap);
    el.appendChild(fig);
    el.dataset.chartRendered = "1";
  }

  function scanCharts(root) {
    if (!HAS_DOM) return 0;
    var els = (root || document).querySelectorAll("chart-block");
    els.forEach(buildChart);
    return els.length;
  }

  /* ================================================================ init */
  function init() {
    if (!HAS_DOM) return;
    document.querySelectorAll("quiz-block").forEach(function (el) {
      registerReset(function () { buildQuiz(el); });
      buildQuiz(el);
    });
    document.querySelectorAll("preq-block").forEach(function (el) {
      registerReset(function () { buildPreq(el); });
      buildPreq(el);
    });
    document.querySelectorAll("chain-block").forEach(function (el) {
      registerReset(function () { buildChain(el); });
      buildChain(el);
    });
    document.querySelectorAll("video-card").forEach(buildVideo);
    document.querySelectorAll("sim-block").forEach(buildSim);
    document.querySelectorAll("blindtest-block").forEach(function (el) {
      registerReset(function () { buildBlindtest(el); });
      buildBlindtest(el);
    });
    document.querySelectorAll("recalc-block").forEach(buildRecalc);
    scanCharts();
    mountTopbar();
    mountAsofChip();
    mountJudgeCards();
    Hover.load();
  }

  var api = {
    // 原有组件（kbar 可探针）
    quiz: buildQuiz, preq: buildPreq, recall: buildRecall, chain: buildChain,
    video: buildVideo, sim: buildSim, init: init,
    // Learner OS
    shuffle: shuffle,
    randInject: function (fn) { randHook = typeof fn === "function" ? fn : null; }, // 测试假随机注入（null 还原真随机）
    hashStr: hashStr,
    dayStr: dayStr,
    passport: Passport,
    srs: {
      intervals: SRS_INTERVALS,
      compute: poolFromAnswers,
      dueList: function (date) { return Passport.dueReview(date); },
      pool: function (course) { return Passport.wrongPool(course); }
    },
    theme: Theme,
    hover: Hover,
    judge: { mount: mountJudgeCards, reset: resetPage },
    topbar: { mount: mountTopbar },
    blindtest: buildBlindtest,
    recalc: buildRecalc,
    asofChip: mountAsofChip,
    chart: { scan: scanCharts, build: buildChart, core: ChartCore }
  };

  if (HAS_DOM) {
    Theme.apply(Theme.get()); // 尽早应用，避免暗色闪烁
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
    window.Macro = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node 自测路径
})();
