// Small progressive enhancements; every action also works without JS.
(function () {
  "use strict";

  // Confirm destructive or important actions.
  document.addEventListener("submit", function (ev) {
    var btn = ev.submitter || ev.target.querySelector("[data-confirm]");
    var msg = btn && btn.getAttribute && btn.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) { ev.preventDefault(); return; }
    // Prevent double submission: disable buttons after the first submit.
    var form = ev.target;
    if (form.dataset.submitted === "1") { ev.preventDefault(); return; }
    form.dataset.submitted = "1";
    dirty = false;
    Array.prototype.forEach.call(form.querySelectorAll("button[type=submit]"), function (b) {
      b.disabled = true;
      if (b.getAttribute("data-busy")) { b.textContent = b.getAttribute("data-busy"); }
    });
  }, true);

  // Warn before leaving with unsaved edits.
  var dirty = false;
  Array.prototype.forEach.call(document.querySelectorAll("form[data-dirty-guard]"), function (form) {
    form.addEventListener("input", function () { dirty = true; markDirty(true); });
    form.addEventListener("change", function () { dirty = true; markDirty(true); });
  });
  function markDirty(on) {
    var t = document.title.replace(/^● /, "");
    document.title = on ? "● " + t : t;
  }
  window.addEventListener("beforeunload", function (ev) {
    if (dirty) { ev.preventDefault(); ev.returnValue = ""; }
  });
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest("a[href]");
    if (!a || !dirty || a.target === "_blank" || a.getAttribute("href").charAt(0) === "#") { return; }
    if (!window.confirm("保存していない変更があります。移動しますか？")) { ev.preventDefault(); }
  });

  // Tabs in the editor side pane (iPhone and Mac).
  var tabs = document.querySelectorAll(".tabs [data-tab]");
  function showTab(name) {
    var wide = window.matchMedia("(min-width: 1101px)").matches;
    if (name === "preview" && wide) { name = "edit"; }  // the preview is always visible on wide screens
    document.body.dataset.tab = name;
    Array.prototype.forEach.call(tabs, function (t) { t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false"); });
    Array.prototype.forEach.call(document.querySelectorAll(".tab-panel"), function (p) {
      p.hidden = p.dataset.panel !== name;
    });
    if (name === "preview") { window.scrollTo(0, 0); }
    try { sessionStorage.setItem("editor-tab", name); } catch (e) { /* ignore */ }
  }
  if (tabs.length) {
    Array.prototype.forEach.call(tabs, function (t) { t.addEventListener("click", function () { showTab(t.dataset.tab); }); });
    var saved = null;
    try { saved = sessionStorage.getItem("editor-tab"); } catch (e) { /* ignore */ }
    showTab(saved || "edit");
  } else {
    Array.prototype.forEach.call(document.querySelectorAll(".tab-panel[hidden]"), function (p) { p.hidden = false; });
  }

  // Mac / iPhone preview width.
  Array.prototype.forEach.call(document.querySelectorAll("[data-device]"), function (b) {
    b.addEventListener("click", function () {
      var wrap = document.querySelector("[data-frame]");
      if (!wrap) { return; }
      wrap.classList.toggle("iphone", b.dataset.device === "iphone");
      Array.prototype.forEach.call(document.querySelectorAll("[data-device]"), function (x) {
        x.setAttribute("aria-pressed", x === b ? "true" : "false");
      });
    });
  });

  // Bulk approval: pre-fill nothing; show how many are selected.
  var batch = document.querySelector("form[data-batch]");
  if (batch) {
    var count = batch.querySelector("[data-batch-count]");
    var update = function () {
      var n = batch.querySelectorAll("input[name=item]:checked").length;
      count.placeholder = "選択中: " + n + "件";
    };
    batch.addEventListener("change", update);
    update();
  }
})();
