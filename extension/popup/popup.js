// popup.js
// Displays the current vibe profile and lets the user nudge filters.

const TEMPO_STEP   = 15;  // BPM shift per slower/faster click
// "pre1990" is a sentinel — scored as "any track before 1990", no specific decade required
const DECADES      = ["pre1990", 1990, 2000, 2010, 2020];

let currentProfile     = null;
let overrides          = { bpmOffset: 0, forcedDecade: null, forcedGenre: null, pinnedArtist: null };
let rendering          = false; // suppress change events fired by renderProfile()
let lastOverrideChange = 0;
const OVERRIDE_FLASH_MS = 3000;

// Elements
const enabledToggle    = document.getElementById("enabledToggle");
const bpmValue         = document.getElementById("bpmValue");
const genreValue       = document.getElementById("genreValue");
const eraValue         = document.getElementById("eraValue");
const slowerBtn        = document.getElementById("slowerBtn");
const fasterBtn        = document.getElementById("fasterBtn");
const resetTempoBtn    = document.getElementById("resetTempoBtn");
const tempoHint        = document.getElementById("tempoHint");
const eraBackBtn       = document.getElementById("eraBackBtn");
const eraForwardBtn    = document.getElementById("eraForwardBtn");
const eraDisplay       = document.getElementById("eraDisplay");
const eraAutoHint      = document.getElementById("eraAutoHint");
const eraHint          = document.getElementById("eraHint");
const genreSelect      = document.getElementById("genreSelect");
const genreAutoHint    = document.getElementById("genreAutoHint");
const seedHint         = document.getElementById("seedHint");
const nextUpSection    = document.getElementById("nextUpSection");
const upNextList       = document.getElementById("upNextList");
const debugToggle      = document.getElementById("debugToggle");

function renderProfile() {
  rendering = true;

  const effectiveBPM = currentProfile?.avgBPM
    ? currentProfile.avgBPM + overrides.bpmOffset
    : null;

  const anyOverride = overrides.forcedGenre || overrides.forcedDecade || overrides.bpmOffset !== 0;
  const vibeHint = document.getElementById("vibeHint");

  // Top stats — always show what's actually driving recommendations
  bpmValue.textContent   = effectiveBPM ? `${effectiveBPM}` : "—";
  genreValue.textContent = overrides.forcedGenre ?? currentProfile?.primaryGenre ?? "—";
  const detectedDecadeLabel = !currentProfile?.dominantDecade ? "—"
    : currentProfile.dominantDecade < 1990 ? "<1990s"
    : `${currentProfile.dominantDecade}s`;
  eraValue.textContent   = overrides.forcedDecade
    ? (overrides.forcedDecade === "pre1990" ? "<1990s" : `${overrides.forcedDecade}s`)
    : detectedDecadeLabel;
  // Briefly highlight changed overrides in red, then settle back to white.
  const flash = (Date.now() - lastOverrideChange) < OVERRIDE_FLASH_MS;
  bpmValue.style.color   = (overrides.bpmOffset !== 0  && flash) ? "#fa2d55" : "";
  genreValue.style.color = (overrides.forcedGenre      && flash) ? "#fa2d55" : "";
  eraValue.style.color   = (overrides.forcedDecade     && flash) ? "#fa2d55" : "";

  vibeHint.textContent = anyOverride
    ? "Your controls are active — these are your current settings."
    : currentProfile
      ? "Detected from your recent tracks. Change any control below to take over."
      : "Play a track to start detecting your vibe.";

  // Tempo hint
  if (overrides.bpmOffset !== 0) {
    const dir = overrides.bpmOffset > 0 ? "faster" : "slower";
    tempoHint.textContent = `${Math.abs(overrides.bpmOffset)} BPM ${dir} than detected`;
  } else {
    tempoHint.textContent = "";
  }

  // Era display — locked value in pink, detected value in dim (no "Auto")
  if (overrides.forcedDecade !== null) {
    eraDisplay.textContent = overrides.forcedDecade === "pre1990" ? "<1990s" : `${overrides.forcedDecade}s`;
    eraDisplay.classList.add("pinned");
    eraAutoHint.textContent = "";
    eraHint.textContent = "Double-click to unlock";
  } else {
    eraDisplay.textContent = detectedDecadeLabel;
    eraDisplay.classList.remove("pinned");
    eraAutoHint.textContent = "";
    eraHint.textContent = currentProfile?.dominantDecade ? "Detected — click ◀ ▶ to lock" : "";
  }

  // Genre select — locked value selected, otherwise show detected genre selected but dim
  genreSelect.value = overrides.forcedGenre ?? "";
  genreAutoHint.textContent = overrides.forcedGenre
    ? ""
    : currentProfile?.primaryGenre
      ? `Detected: ${currentProfile.primaryGenre} — change to lock`
      : "";

  rendering = false;
}

function pushOverrides() {
  lastOverrideChange = Date.now();
  chrome.storage.local.set({ overrides });
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "OVERRIDES_UPDATED", overrides });
    }
  });
  renderProfile();
  // Re-render after flash window expires to clear the red highlight
  setTimeout(() => renderProfile(), OVERRIDE_FLASH_MS + 50);
}

// Toggle extension on/off
enabledToggle.addEventListener("change", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type:    "TOGGLE_INTERCEPT",
        enabled: enabledToggle.checked,
      });
    }
  });
});

// Tempo controls
slowerBtn.addEventListener("click", () => { overrides.bpmOffset -= TEMPO_STEP; pushOverrides(); });
fasterBtn.addEventListener("click", () => { overrides.bpmOffset += TEMPO_STEP; pushOverrides(); });
resetTempoBtn.addEventListener("click", () => { overrides.bpmOffset = 0; pushOverrides(); });

// Era controls — find nearest decade in array to avoid indexOf returning -1
function nearestDecadeIdx(decade) {
  let best = 0;
  let bestDiff = Infinity;
  DECADES.forEach((d, i) => { const diff = Math.abs(d - decade); if (diff < bestDiff) { bestDiff = diff; best = i; } });
  return best;
}
eraBackBtn.addEventListener("click", () => {
  const current = overrides.forcedDecade ?? currentProfile?.dominantDecade ?? 2010;
  const idx = nearestDecadeIdx(current);
  overrides.forcedDecade = DECADES[Math.max(0, idx - 1)];
  pushOverrides();
});
eraForwardBtn.addEventListener("click", () => {
  const current = overrides.forcedDecade ?? currentProfile?.dominantDecade ?? 2010;
  const idx = nearestDecadeIdx(current);
  overrides.forcedDecade = DECADES[Math.min(DECADES.length - 1, idx + 1)];
  pushOverrides();
});
// Double-click era display to reset
eraDisplay.addEventListener("dblclick", () => {
  overrides.forcedDecade = null;
  pushOverrides();
});

// Genre lock
genreSelect.addEventListener("change", () => {
  if (rendering) return;
  overrides.forcedGenre = genreSelect.value || null;
  pushOverrides();
});


// Listen for updates from content script
chrome.runtime.onMessage.addListener(message => {
  if (message.type === "VIBE_PROFILE_UPDATED") {
    currentProfile = message.profile;
    if (message.upNext !== undefined) renderUpNext(message.upNext);
    renderProfile();
  }
  if (message.type === "NEXT_RECOMMENDATION") {
    if (message.profile && !currentProfile) {
      currentProfile = message.profile;
      renderProfile();
    }
    renderUpNext(message.upNext ?? []);
  }
});

renderUpNext([]); // show section immediately on open; polling will fill it in

function renderUpNext(tracks) {
  nextUpSection.style.display = "block";
  upNextList.innerHTML = tracks.length
    ? tracks.map(t =>
        `<li><span class="next-title">${t.title}</span><span class="next-artist">${t.artistName}</span></li>`
      ).join("")
    : `<li class="up-next-empty">Nothing queued yet</li>`;
}

// --- First-run disclosure gate ---

const disclosureScreen = document.getElementById("disclosureScreen");
const mainContent      = document.getElementById("mainContent");
const confirmBtn       = document.getElementById("disclosureConfirmBtn");

function showMain() {
  disclosureScreen.style.display = "none";
  mainContent.style.display      = "block";
}

chrome.storage.local.get("privacyAcknowledged", result => {
  if (result.privacyAcknowledged) {
    showMain();
  }
  // else: disclosure is already visible (default HTML state)
});

confirmBtn.addEventListener("click", () => {
  chrome.storage.local.set({ privacyAcknowledged: true });
  showMain();
});

// Debug toggle — stored separately so it persists across page navigations.
debugToggle.addEventListener("change", () => {
  chrome.storage.local.set({ debugMode: debugToggle.checked });
});

// Restore saved overrides + debug mode from storage (overrides are cleared by content script
// on page load; debugMode persists indefinitely since it's stored separately).
chrome.storage.local.get(["overrides", "vibeProfile", "debugMode"], result => {
  if (result.overrides)            overrides        = { ...overrides, ...result.overrides };
  if (result.vibeProfile)          currentProfile   = result.vibeProfile;
  if (result.debugMode !== undefined) debugToggle.checked = result.debugMode;
  renderProfile();
});

// Poll storage every second for fresh vibe profile and up-next list.
// chrome.runtime.sendMessage (content script → popup) is unreliable in Safari,
// so storage polling is the only path that works consistently.
let _pollVibeKey   = "";
let _pollUpNextKey = "";
setInterval(() => {
  chrome.storage.local.get(["vibeProfile", "upNextList"], result => {
    if (result.vibeProfile) {
      const p   = result.vibeProfile;
      const key = `${p.avgBPM}|${p.primaryGenre}|${p.dominantDecade}`;
      if (key !== _pollVibeKey) {
        _pollVibeKey  = key;
        currentProfile = p;
        renderProfile();
      }
    }
    const tracks = result.upNextList ?? [];
    const upKey  = tracks.map(t => t.id).join(",");
    if (upKey !== _pollUpNextKey) {
      _pollUpNextKey = upKey;
      renderUpNext(tracks);
    }
  });
}, 1000);

// Request current profile + queue from active tab
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  if (tabs[0]?.id) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "GET_PROFILE" }, response => {
      if (response?.profile) {
        currentProfile = response.profile;
        renderProfile();
      }
      if (response?.upNext) renderUpNext(response.upNext);
    });
  }
});
