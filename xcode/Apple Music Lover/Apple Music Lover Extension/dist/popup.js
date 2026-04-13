(() => {
  // popup/popup.js
  var TEMPO_STEP = 15;
  var DECADES = [1960, 1970, 1980, 1990, 2e3, 2010, 2020];
  var currentProfile = null;
  var overrides = { bpmOffset: 0, forcedDecade: null };
  var enabledToggle = document.getElementById("enabledToggle");
  var bpmValue = document.getElementById("bpmValue");
  var genreValue = document.getElementById("genreValue");
  var eraValue = document.getElementById("eraValue");
  var slowerBtn = document.getElementById("slowerBtn");
  var fasterBtn = document.getElementById("fasterBtn");
  var resetTempoBtn = document.getElementById("resetTempoBtn");
  var tempoHint = document.getElementById("tempoHint");
  var eraBackBtn = document.getElementById("eraBackBtn");
  var eraForwardBtn = document.getElementById("eraForwardBtn");
  var eraDisplay = document.getElementById("eraDisplay");
  var nextUpSection = document.getElementById("nextUpSection");
  var nextTitle = document.getElementById("nextTitle");
  var nextArtist = document.getElementById("nextArtist");
  function renderProfile() {
    if (!currentProfile)
      return;
    const effectiveBPM = currentProfile.avgBPM ? currentProfile.avgBPM + overrides.bpmOffset : null;
    bpmValue.textContent = effectiveBPM ? `${effectiveBPM}` : "\u2014";
    genreValue.textContent = currentProfile.primaryGenre ?? "\u2014";
    eraValue.textContent = currentProfile.dominantDecade ? `${currentProfile.dominantDecade}s` : "\u2014";
    if (overrides.bpmOffset !== 0) {
      const dir = overrides.bpmOffset > 0 ? "faster" : "slower";
      tempoHint.textContent = `${Math.abs(overrides.bpmOffset)} BPM ${dir} than current vibe`;
    } else {
      tempoHint.textContent = "";
    }
    if (overrides.forcedDecade !== null) {
      eraDisplay.textContent = `${overrides.forcedDecade}s`;
      eraDisplay.style.color = "#fa2d55";
    } else {
      eraDisplay.textContent = "Auto";
      eraDisplay.style.color = "#fff";
    }
  }
  function pushOverrides() {
    chrome.storage.local.set({ overrides });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "OVERRIDES_UPDATED", overrides });
      }
    });
    renderProfile();
  }
  enabledToggle.addEventListener("change", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "TOGGLE_INTERCEPT",
          enabled: enabledToggle.checked
        });
      }
    });
  });
  slowerBtn.addEventListener("click", () => {
    overrides.bpmOffset -= TEMPO_STEP;
    pushOverrides();
  });
  fasterBtn.addEventListener("click", () => {
    overrides.bpmOffset += TEMPO_STEP;
    pushOverrides();
  });
  resetTempoBtn.addEventListener("click", () => {
    overrides.bpmOffset = 0;
    pushOverrides();
  });
  eraBackBtn.addEventListener("click", () => {
    const current = overrides.forcedDecade ?? currentProfile?.dominantDecade ?? 2010;
    const idx = DECADES.indexOf(current);
    overrides.forcedDecade = DECADES[Math.max(0, idx - 1)];
    pushOverrides();
  });
  eraForwardBtn.addEventListener("click", () => {
    const current = overrides.forcedDecade ?? currentProfile?.dominantDecade ?? 2010;
    const idx = DECADES.indexOf(current);
    overrides.forcedDecade = DECADES[Math.min(DECADES.length - 1, idx + 1)];
    pushOverrides();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "VIBE_PROFILE_UPDATED") {
      currentProfile = message.profile;
      renderProfile();
    }
    if (message.type === "NEXT_RECOMMENDATION") {
      nextUpSection.style.display = "block";
      nextTitle.textContent = message.track.title;
      nextArtist.textContent = message.track.artistName;
    }
  });
  chrome.storage.local.get(["overrides"], (data) => {
    if (data.overrides)
      overrides = data.overrides;
    renderProfile();
  });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_PROFILE" }, (response) => {
        if (response?.profile) {
          currentProfile = response.profile;
          renderProfile();
        }
      });
    }
  });
})();
