// Runs before first paint (a classic script, so it blocks rendering briefly).
// Decides how the startup screen behaves: "first" plays the short introduction
// (the first visit in this browser session, or an explicit ?intro), "return"
// shows nothing unless startup takes noticeably long.
(function () {
  var entry = "first";
  try {
    if (sessionStorage.getItem("tend.entered") && !/[?&]intro\b/.test(location.search)) entry = "return";
  } catch (e) { /* storage blocked: treat as a first entry */ }
  document.documentElement.setAttribute("data-entry", entry);
})();
