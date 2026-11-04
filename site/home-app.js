// A home-screen icon saved from the homepage opens the app, not the brochure.
//
// The homepage links the app manifest (start_url /pair), but some iOS releases
// launch a home-screen web app at the URL that was on screen when it was
// added. When this document runs as an installed app rather than in a browser
// tab, hand over to /pair before anything renders. A browser tab, and the
// in-app browser that shows out-of-scope pages, are not standalone and stay.
(function (global) {
  function installed() {
    if (global.navigator && global.navigator.standalone === true) return true;
    if (typeof global.matchMedia !== "function") return false;
    return ["standalone", "fullscreen", "minimal-ui"].some(function (mode) {
      return global.matchMedia("(display-mode: " + mode + ")").matches;
    });
  }

  if (installed()) global.location.replace("/pair");
})(window);
