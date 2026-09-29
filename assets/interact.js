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

  function init() {
    document.querySelectorAll("quiz-block").forEach(buildQuiz);
    document.querySelectorAll("chain-block").forEach(buildChain);
    document.querySelectorAll("preq-block").forEach(buildPreq);
    document.querySelectorAll("recall-block").forEach(buildRecall);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.Macro = { quiz: buildQuiz, preq: buildPreq, recall: buildRecall, chain: buildChain, init: init };
})();
