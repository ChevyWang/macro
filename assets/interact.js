/* macro 课程共享交互组件 · 唯一权威版
   用法：在课页放 <quiz-block> / <chain-block> / <preq-block> / <recall-block>，内嵌
   <script type="application/json"> {"q":"…","why":"…","options":[{"t":"…","ok":true,"why":"…"}]} </script>
   （recall-block 用 {"q":"…","a":"参考答案"}；preq-block 可加 "revisit":"课末回望提示"）
   组件自动渲染。导出到 window.Macro（kbar 铁律：新组件必须导出+可探针）。 */
(function () {
  "use strict";

  function readData(el) {
    var s = el.querySelector('script[type="application/json"]');
    if (!s) return null;
    try { return JSON.parse(s.textContent); } catch (e) { console.error("interact.js JSON 解析失败", e); return null; }
  }

  // 选择题共用渲染：quiz 与 prequestion（课前先猜）同一机制，仅提示语不同
  function buildChoice(el, data, meta) {
    if (!data || !data.options) return;
    var frag = document.createDocumentFragment();
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
    var answered = false;
    var opts = data.options.slice();
    data.options.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.textContent = o.t;
      b.addEventListener("click", function () {
        if (answered) return;
        answered = true;
        opts.forEach(function (x) {
          var btn = x._btn;
          btn.disabled = true;
          if (x.ok) btn.classList.add("correct");
        });
        if (o.ok) {
          b.classList.add("correct");
          fb.className = "feedback show good";
        } else {
          b.classList.add("wrong");
          fb.className = "feedback show bad";
        }
        fb.textContent = o.why || "";
        if (meta && meta.after) fb.textContent += (fb.textContent ? " " : "") + meta.after;
      });
      o._btn = b;
      frag.appendChild(b);
    });
    frag.appendChild(fb);
    el.appendChild(frag);
  }

  function buildQuiz(el) {
    buildChoice(el, readData(el));
  }

  function buildPreq(el) {
    var d = readData(el);
    if (!d) return;
    buildChoice(el, d, {
      note: "课前先猜 · 不计分 · 猜错有好处：错误猜测会加深随后对正确答案的编码",
      after: d.revisit || "记住你的直觉，课末自测会回到它。"
    });
  }

  function buildRecall(el) {
    var data = readData(el);
    if (!data || !data.a) return;
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
    // 展示序=打乱序，保证与因果序不同
    var shuffled = correct
      .map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) { return ((a.i * 2654435761) % 97) - ((b.i * 2654435761) % 97); });
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
    var checked = false;
    var check = document.createElement("button");
    check.type = "button";
    check.className = "chain-check";
    check.disabled = true;
    check.textContent = "检验顺序";
    check.addEventListener("click", function () {
      if (checked) return;
      checked = true;
      var allRight = true;
      Array.prototype.forEach.call(arena.children, function (btn, idx) {
        var item = shuffled[idx];
        var pos = picked.indexOf(item.i);
        btn.disabled = true;
        if (pos === item.i) { btn.classList.add("right"); }
        else { btn.classList.add("misplaced"); allRight = false; }
      });
      check.textContent = allRight ? "全部正确" : "有错位，红色为放错位置的环节";
    });
    el.appendChild(check);
    if (data.why) {
      var fb = document.createElement("div");
      fb.className = "feedback";
      fb.textContent = data.why;
      check.addEventListener("click", function () { fb.classList.add("show"); });
      el.appendChild(fb);
    }
  }

  // 视频卡：懒加载嵌入（点击才挂 iframe，卡面=打印友好信息卡；只嵌官方源）
  function buildVideo(el) {
    var d = readData(el);
    if (!d || !d.youtube) return;
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
        chart.appendChild(svgEl("line", { x1: 10, y1: y0 + 96, x2: 640, y2: y0 + 96, stroke: "#e4e2d9" }));
        var t = svgEl("text", { x: 12, y: y0 + 12, "font-size": 10.5, "font-weight": 700, fill: "#1c1c1a" });
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
        chart.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke: color, "stroke-width": 1.8, "data-c": color + y0 }));
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
        series(p1, Ys, 60, 260, "#1c1c1a");
        series(p2, Ds, 30, 110, "#d33a2c");
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
    // 每组：三个情形的路径点（0..1 归一 x，y 为示意值）
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
      note.textContent = "示意曲线（非真实数据）：红色虚线=事件日；黑线=该情形的路径示意，浅灰=其他情形。";
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
        chart.appendChild(svgEl("line", { x1: 12, y1: p.y0 + 92, x2: 640, y2: p.y0 + 92, stroke: "#e4e2d9" }));
        var t = svgEl("text", { x: 14, y: p.y0 + 12, "font-size": 10.5, "font-weight": 700, fill: "#1c1c1a" });
        t.textContent = p.title;
        chart.appendChild(t);
        chart.appendChild(svgEl("line", { x1: 326, y1: p.y0 + 4, x2: 326, y2: p.y0 + 92, stroke: "#d33a2c", "stroke-width": 1.2, "stroke-dasharray": "4 3" }));
        var gArr = [];
        scen.forEach(function (s, si) {
          var pts = MarketSim.mk(46, 30 * s.moves[pi]).map(function (y, i) {
            return (12 + i * (628 / 20)).toFixed(1) + "," + (p.y0 + 88 - y * 0.72).toFixed(1);
          }).join(" ");
          var g = svgEl("g", { opacity: si === 0 ? 1 : 0.12 });
          g.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke: "#1c1c1a", "stroke-width": 1.8 }));
          g.style.transition = "opacity .4s";
          chart.appendChild(g);
          gArr.push(g);
        });
        groups.push(gArr);
      });
      var evtLabel = svgEl("text", { x: 320, y: 316, "font-size": 10, fill: "#d33a2c", "text-anchor": "end" });
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

  function init() {
    document.querySelectorAll("quiz-block").forEach(buildQuiz);
    document.querySelectorAll("chain-block").forEach(buildChain);
    document.querySelectorAll("preq-block").forEach(buildPreq);
    document.querySelectorAll("recall-block").forEach(buildRecall);
    document.querySelectorAll("video-card").forEach(buildVideo);
    document.querySelectorAll("sim-block").forEach(buildSim);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.Macro = { quiz: buildQuiz, preq: buildPreq, recall: buildRecall, chain: buildChain, video: buildVideo, sim: buildSim, init: init };
})();
