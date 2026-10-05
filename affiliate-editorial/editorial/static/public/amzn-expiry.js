// Hide Amazon-supplied data (image URLs, star ratings) once its 24-hour
// validity has passed, in case a page is served longer than intended.
// Nothing is stored or cached in the browser by this script.
(function () {
  "use strict";
  function sweep() {
    var now = Date.now();
    var nodes = document.querySelectorAll("[data-amzn-expires]");
    for (var i = 0; i < nodes.length; i++) {
      var t = Date.parse(nodes[i].getAttribute("data-amzn-expires"));
      if (!isNaN(t) && t <= now) {
        nodes[i].parentNode.removeChild(nodes[i]);
      }
    }
  }
  sweep();
  setInterval(sweep, 60 * 1000);
})();
