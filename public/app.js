const els = {
  blocks: document.getElementById("blocks"),
  blockTemplate: document.getElementById("blockTemplate"),
  mediaInput: document.getElementById("mediaInput"),
  mediaPreview: document.getElementById("mediaPreview"),
  dropzone: document.getElementById("dropzone"),
  submitBtn: document.getElementById("submitBtn"),
  clearDraft: document.getElementById("clearDraft"),
  resultJson: document.getElementById("resultJson"),
  resultLinks: document.getElementById("resultLinks"),
  lensPreview: document.getElementById("lensPreview"),
  statusPill: document.getElementById("statusPill"),
  historyList: document.getElementById("historyList"),
  refreshHistory: document.getElementById("refreshHistory"),
  usersList: document.getElementById("usersList"),
  refreshUsers: document.getElementById("refreshUsers"),
  didStatus: document.getElementById("didStatus"),
  encStatus: document.getElementById("encStatus"),
  ipnsStatus: document.getElementById("ipnsStatus"),
  avatarChip: document.getElementById("avatarChip"),
  avatarInitials: document.getElementById("avatarInitials"),
  identityMenu: document.getElementById("identityMenu"),
  closeIdentityMenu: document.getElementById("closeIdentityMenu"),
  generateDid: document.getElementById("generateDid"),
  generateEncKeys: document.getElementById("generateEncKeys"),
  refreshKeys: document.getElementById("refreshKeys"),
  createKey: document.getElementById("createKey"),
  ipnsKeyOptions: document.getElementById("ipnsKeyOptions"),
  profileSelect: document.getElementById("profileSelect"),
  profileRole: document.getElementById("profileRole"),
  profileSummary: document.getElementById("profileSummary"),
  nodeNameInput: document.getElementById("nodeNameInput"),
  nodeNameStatus: document.getElementById("nodeNameStatus"),
  saveNodeName: document.getElementById("saveNodeName"),
  runSetup: document.getElementById("runSetup"),
  newProfile: document.getElementById("newProfile"),
  renameProfile: document.getElementById("renameProfile"),
  deleteProfile: document.getElementById("deleteProfile"),
  userDid: document.getElementById("userDid"),
  ipnsKey: document.getElementById("ipnsKey"),
  tags: document.getElementById("tags"),
  visibility: document.getElementById("visibility"),
  visibilityHint: document.getElementById("visibilityHint"),
  publish: document.getElementById("publish"),
  autoTag: document.getElementById("autoTag"),
  imagePadding: document.getElementById("imagePadding"),
  imageBorder: document.getElementById("imageBorder"),
  imageBg: document.getElementById("imageBg"),
  imageBorderColor: document.getElementById("imageBorderColor"),
  imageQuality: document.getElementById("imageQuality"),
  previewStartSec: document.getElementById("previewStartSec"),
  previewDurationSec: document.getElementById("previewDurationSec"),
  hlsSegmentSec: document.getElementById("hlsSegmentSec"),
  frameEnabled: document.getElementById("frameEnabled"),
  frameLabelText: document.getElementById("frameLabelText"),
  cardColor: document.getElementById("cardColor"),
  textColor: document.getElementById("textColor"),
  accentColor: document.getElementById("accentColor"),
  fontFamily: document.getElementById("fontFamily"),
  baseFontSize: document.getElementById("baseFontSize"),
  cardRadius: document.getElementById("cardRadius"),
  livePostCard: document.getElementById("livePostCard"),
  addLinkFormat: document.getElementById("addLinkFormat")
};

const state = {
  blocks: [],
  files: [],
  saveTimer: null,
  isSubmitting: false,
  ipnsKeys: [],
  profiles: [],
  activeProfileId: null,
  activeEditable: null,
  selectedBlockId: null,
  globalFrameDefaults: {
    imageBorder: 3,
    imageBg: "#faf7f2"
  },
  nodeName: "",
  nodeNameAvailable: null,
  nodeNameCheckTimer: null
};

boot();

function boot() {
  initializeGlobalFrameDefaults();
  loadProfiles();
  bindControls();
  styleFontPicker();
  hydrateDraft();
  applyActiveProfileToForm();
  if (state.blocks.length === 0) addBlock("text");
  renderBlocks();
  renderMedia();
  syncFrameControlsToSelection();
  renderLivePreview();
  loadSetup();
  loadNodeIdentity();
  autoUpgradeProfilesSilently();
  loadHistory();
  loadUsers();
  scheduleSetupPrompt();
  setInterval(loadUsers, 30000);
}

function initializeGlobalFrameDefaults() {
  state.globalFrameDefaults.imageBorder = toFiniteNumber(els.imageBorder.value, 3);
  state.globalFrameDefaults.imageBg = els.imageBg.value || "#faf7f2";
}

function bindControls() {
  document.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => addBlock(btn.dataset.add));
  });
  document.querySelectorAll("[data-format]").forEach((btn) => {
    btn.addEventListener("click", () => applyFormat(btn.dataset.format));
  });
  els.addLinkFormat.addEventListener("click", () => {
    const link = prompt("Enter link URL");
    if (!link) return;
    document.execCommand("createLink", false, link);
    scheduleSave();
    renderLivePreview();
  });

  els.mediaInput.addEventListener("change", (e) => {
    queueFiles(Array.from(e.target.files || []));
    e.target.value = "";
  });

  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragging");
  });
  els.dropzone.addEventListener("dragleave", () => {
    els.dropzone.classList.remove("dragging");
  });
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragging");
    queueFiles(Array.from(e.dataTransfer?.files || []));
  });

  els.submitBtn.addEventListener("click", submitPost);
  els.clearDraft.addEventListener("click", clearDraft);
  els.refreshHistory.addEventListener("click", loadHistory);
  if (els.refreshUsers) {
    els.refreshUsers.addEventListener("click", loadUsers);
  }
  els.refreshKeys.addEventListener("click", fetchIpnsKeys);
  els.generateDid.addEventListener("click", generateDid);
  els.generateEncKeys.addEventListener("click", generateEncryptionKeysOnly);
  els.createKey.addEventListener("click", createIpnsKey);
  els.avatarChip.addEventListener("click", toggleIdentityMenu);
  els.closeIdentityMenu.addEventListener("click", closeIdentityMenu);
  els.profileSelect.addEventListener("change", onProfileSelectChange);
  els.profileRole.addEventListener("change", onProfileRoleChange);
  els.newProfile.addEventListener("click", createProfile);
  els.renameProfile.addEventListener("click", renameProfile);
  els.deleteProfile.addEventListener("click", deleteProfile);
  if (els.saveNodeName) {
    els.saveNodeName.addEventListener("click", saveNodeName);
  }
  if (els.runSetup) {
    els.runSetup.addEventListener("click", runFirstTimeSetup);
  }
  if (els.nodeNameInput) {
    els.nodeNameInput.addEventListener("input", onNodeNameInput);
  }

  [
    els.userDid,
    els.ipnsKey,
    els.tags,
    els.visibility,
    els.publish,
    els.autoTag,
    els.imagePadding,
    els.imageBorderColor,
    els.imageQuality,
    els.previewStartSec,
    els.previewDurationSec,
    els.hlsSegmentSec,
    els.frameEnabled,
    els.frameLabelText,
    els.cardColor,
    els.textColor,
    els.accentColor,
    els.fontFamily,
    els.baseFontSize,
    els.cardRadius
  ].forEach((input) => {
    input.addEventListener("input", scheduleSave);
    input.addEventListener("change", scheduleSave);
    input.addEventListener("input", renderLivePreview);
    input.addEventListener("change", renderLivePreview);
  });

  [els.imageBorder, els.imageBg].forEach((input) => {
    input.addEventListener("input", onScopedFrameControlChange);
    input.addEventListener("change", onScopedFrameControlChange);
  });

  els.fontFamily.addEventListener("input", styleFontPicker);
  els.fontFamily.addEventListener("change", styleFontPicker);

  els.userDid.addEventListener("input", () => {
    const profile = getActiveProfile();
    if (!profile) return;
    profile.userDid = els.userDid.value.trim();
    persistProfiles();
    renderProfileSummary();
    renderIdentityIndicators();
    announceNodeProfile();
  });
  els.ipnsKey.addEventListener("input", () => {
    const profile = getActiveProfile();
    if (!profile) return;
    profile.ipnsKey = els.ipnsKey.value.trim() || "self";
    persistProfiles();
    renderProfileSummary();
    renderIdentityIndicators();
    announceNodeProfile();
  });

  document.addEventListener("click", (event) => {
    if (els.identityMenu.classList.contains("hidden")) return;
    const target = event.target;
    if (els.identityMenu.contains(target) || els.avatarChip.contains(target)) return;
    closeIdentityMenu();
  });
}

function toggleIdentityMenu() {
  els.identityMenu.classList.toggle("hidden");
}

function closeIdentityMenu() {
  els.identityMenu.classList.add("hidden");
}

function applyFormat(command) {
  if (!state.activeEditable) return;
  state.activeEditable.focus();
  document.execCommand(command, false, null);
  scheduleSave();
  renderLivePreview();
}

async function loadSetup() {
  try {
    const resp = await fetch("/api/setup");
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "setup load failed");
    state.ipnsKeys = Array.isArray(data.ipfs?.keys) ? data.ipfs.keys : [];
    renderIpnsKeyOptions();
    const profile = getActiveProfile();
    if (profile && (!profile.ipnsKey || profile.ipnsKey === "self") && state.ipnsKeys.length > 0) {
      profile.ipnsKey = state.ipnsKeys[0].name;
      applyActiveProfileToForm();
      persistProfiles();
    }
    renderIdentityIndicators();
  } catch (error) {
    renderIdentityIndicators();
  }
}

async function loadNodeIdentity() {
  if (!els.nodeNameInput) return;
  try {
    const resp = await fetch("/api/network-node");
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "node identity load failed");
    state.nodeName = String(data.nodeName || "").trim();
    els.nodeNameInput.value = state.nodeName;
    els.nodeNameStatus.textContent = state.nodeName
      ? `Current node name: ${state.nodeName}`
      : "Set how this node appears on the network.";
    state.nodeNameAvailable = null;
    scheduleSetupPrompt();
  } catch (_error) {
    els.nodeNameStatus.textContent = "Could not load node name right now.";
  }
}

function onNodeNameInput() {
  if (!els.nodeNameInput || !els.nodeNameStatus) return;
  const value = normalizeNodeNameLocal(els.nodeNameInput.value);
  if (!value) {
    state.nodeNameAvailable = false;
    els.nodeNameStatus.textContent = "Use 3-40 chars: letters, numbers, spaces, . _ -";
    return;
  }
  els.nodeNameStatus.textContent = "Checking availability...";
  if (state.nodeNameCheckTimer) clearTimeout(state.nodeNameCheckTimer);
  state.nodeNameCheckTimer = setTimeout(() => {
    checkNodeNameAvailability(value);
  }, 250);
}

async function checkNodeNameAvailability(name) {
  try {
    const resp = await fetch(`/api/network-node/check-name?name=${encodeURIComponent(name)}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.reason || data.error || "name check failed");
    state.nodeNameAvailable = Boolean(data.available);
    els.nodeNameStatus.textContent = data.available ? "Name is available." : "Name is taken by an active node.";
  } catch (error) {
    state.nodeNameAvailable = null;
    els.nodeNameStatus.textContent = `Could not verify name: ${error.message}`;
  }
}

async function saveNodeName() {
  if (!els.nodeNameInput) return false;
  const candidate = normalizeNodeNameLocal(els.nodeNameInput.value);
  if (!candidate) {
    els.nodeNameStatus.textContent = "Use 3-40 chars: letters, numbers, spaces, . _ -";
    return false;
  }
  try {
    const resp = await fetch("/api/network-node", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: candidate })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.reason || data.error || "save failed");
    state.nodeName = data.nodeName;
    els.nodeNameInput.value = state.nodeName;
    state.nodeNameAvailable = true;
    els.nodeNameStatus.textContent = `Saved. You appear as "${state.nodeName}" on the network.`;
    return true;
  } catch (error) {
    els.nodeNameStatus.textContent = `Could not save name: ${error.message}`;
    return false;
  }
}

function scheduleSetupPrompt() {
  const complete = isSetupComplete();
  syncSetupGate(complete);
  if (complete) return;
  if (els.identityMenu?.classList.contains("hidden")) {
    els.identityMenu.classList.remove("hidden");
  }
  if (els.nodeNameStatus) {
    els.nodeNameStatus.textContent = "First run detected. Complete setup to join Chirpy discovery.";
  }
}

async function runFirstTimeSetup() {
  try {
    if (!(await ensureNodeNameStep())) return;
    if (!(await ensureProfileStep())) return;
    if (!(await ensureDidStep())) return;
    if (!(await ensureIpnsStep())) return;
    if (!(await ensureEncryptionStep())) return;
    if (els.nodeNameStatus) {
      els.nodeNameStatus.textContent = "Setup complete.";
    }
    await announceNodeProfile();
    await loadUsers();
    scheduleSetupPrompt();
    alert("Setup complete: node name, profile, DID, IPNS key, and encryption keys are ready.");
  } catch (error) {
    alert(`Setup halted: ${error.message}`);
  }
}

function isSetupComplete() {
  const profile = getActiveProfile();
  const nodeNameSet = Boolean(state.nodeName && normalizeNodeNameLocal(state.nodeName));
  if (!profile) return false;
  return Boolean(
    nodeNameSet &&
    profile.name &&
    profile.userDid &&
    profile.ipnsKey &&
    profile.ipnsKey !== "self" &&
    profile.encryptionPublicJwk &&
    profile.encryptionPrivateJwk
  );
}

async function ensureNodeNameStep() {
  const existing = normalizeNodeNameLocal(els.nodeNameInput?.value || state.nodeName);
  if (existing) {
    const ok = await saveNodeName();
    return ok;
  }
  const suggestion = state.nodeName && state.nodeName.startsWith("node-") ? state.nodeName : `node-${safeUuid().slice(0, 8)}`;
  const name = prompt("Node name (must be unique on active network nodes)", suggestion);
  if (!name) return false;
  els.nodeNameInput.value = name;
  return saveNodeName();
}

async function ensureProfileStep() {
  let profile = getActiveProfile();
  if (profile && profile.name) return true;
  const base = `Profile ${state.profiles.length + 1}`;
  const name = prompt("Profile name (unique only on this node)", base);
  if (!name) return false;
  const valid = normalizeProfileName(name);
  if (!valid) {
    alert("Profile name cannot be empty.");
    return false;
  }
  if (hasProfileNameConflict(valid)) {
    alert("That profile name already exists on this node.");
    return false;
  }
  const record = newProfileRecord(valid);
  record.role = "adult";
  state.profiles.push(record);
  state.activeProfileId = record.id;
  renderProfileSelect();
  applyActiveProfileToForm();
  persistProfiles();
  scheduleSave();
  return true;
}

async function ensureDidStep() {
  const profile = getActiveProfile();
  if (!profile) return false;
  if (profile.userDid) return true;
  await generateDid();
  return Boolean(getActiveProfile()?.userDid);
}

async function ensureIpnsStep() {
  const profile = getActiveProfile();
  if (!profile) return false;
  if (profile.ipnsKey && profile.ipnsKey !== "self") return true;
  await fetchIpnsKeys();
  const refreshed = getActiveProfile();
  if (refreshed?.ipnsKey && refreshed.ipnsKey !== "self") return true;
  const autoName = `chirpy-${normalizeNodeNameLocal(state.nodeName || "node").replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
  const created = await createIpnsKey(autoName);
  return Boolean(created);
}

async function ensureEncryptionStep() {
  const profile = getActiveProfile();
  if (!profile) return false;
  if (profile.encryptionPublicJwk && profile.encryptionPrivateJwk) return true;
  await generateEncryptionKeysOnly();
  const refreshed = getActiveProfile();
  return Boolean(refreshed?.encryptionPublicJwk && refreshed?.encryptionPrivateJwk);
}

async function fetchIpnsKeys() {
  try {
    const resp = await fetch("/api/ipfs/keys");
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "ipfs key list failed");
    state.ipnsKeys = data.keys || [];
    renderIpnsKeyOptions();
    const profile = getActiveProfile();
    if (profile && (!profile.ipnsKey || profile.ipnsKey === "self") && state.ipnsKeys.length > 0) {
      profile.ipnsKey = state.ipnsKeys[0].name;
      applyActiveProfileToForm();
      persistProfiles();
    }
    renderIdentityIndicators();
  } catch (error) {
    renderIdentityIndicators();
  }
}

async function createIpnsKey(preferredName) {
  const name = preferredName || prompt("New IPNS key name", `chirpy-main-${new Date().toISOString().slice(0, 10)}`);
  if (!name) return null;
  try {
    const resp = await fetch("/api/ipfs/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "ipfs key create failed");
    state.ipnsKeys = data.keys || [];
    const profile = getActiveProfile();
    if (profile) {
      profile.ipnsKey = data.generatedName;
      applyActiveProfileToForm();
      persistProfiles();
    } else {
      els.ipnsKey.value = data.generatedName;
    }
    renderIpnsKeyOptions();
    renderIdentityIndicators();
    return data.generatedName;
  } catch (error) {
    renderIdentityIndicators();
    alert(`Could not create key: ${error.message}`);
    return null;
  }
}

async function generateDid() {
  try {
    const resp = await fetch("/api/identity/create", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "did generation failed");
    const profile = getActiveProfile();
    if (profile) {
      profile.userDid = data.identity.did;
      profile.encryptionPublicJwk = data.identity.encryptionPublicJwk || null;
      profile.encryptionPrivateJwk = data.identity.encryptionPrivateJwk || null;
      applyActiveProfileToForm();
      persistProfiles();
    } else {
      els.userDid.value = data.identity.did;
    }
    scheduleSave();
    renderIdentityIndicators();
  } catch (error) {
    renderIdentityIndicators();
    alert(`Could not generate DID: ${error.message}`);
  }
}

async function generateEncryptionKeysOnly() {
  try {
    const profile = getActiveProfile();
    if (!profile) throw new Error("no active profile");
    if (!profile.userDid) throw new Error("profile needs a DID first");
    const resp = await fetch("/api/identity/encryption-keys", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "encryption key generation failed");
    profile.encryptionPublicJwk = data.keys.encryptionPublicJwk || null;
    profile.encryptionPrivateJwk = data.keys.encryptionPrivateJwk || null;
    persistProfiles();
    renderProfileSummary();
    scheduleSave();
    renderIdentityIndicators();
  } catch (error) {
    renderIdentityIndicators();
    alert(`Could not add encryption keys: ${error.message}`);
  }
}

async function upgradeAllProfiles({ silent }) {
  const candidates = state.profiles.filter(
    (profile) => profile.userDid && !profile.encryptionPublicJwk
  );
  if (!candidates.length) return;

  let successCount = 0;
  for (const profile of candidates) {
    try {
      const resp = await fetch("/api/identity/encryption-keys", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "upgrade failed");
      profile.encryptionPublicJwk = data.keys.encryptionPublicJwk || null;
      profile.encryptionPrivateJwk = data.keys.encryptionPrivateJwk || null;
      successCount += 1;
    } catch (_error) {
      // keep going for remaining profiles
    }
  }

  persistProfiles();
  renderProfileSummary();
  renderIdentityIndicators();
  scheduleSave();
  if (!silent && successCount === 0) {
    alert("Could not upgrade profiles.");
  }
}

function autoUpgradeProfilesSilently() {
  try {
    if (sessionStorage.getItem("chirpyAutoUpgradeRan") === "1") return;
    sessionStorage.setItem("chirpyAutoUpgradeRan", "1");
  } catch (_error) {
    // ignore
  }
  upgradeAllProfiles({ silent: true });
}

function renderIpnsKeyOptions() {
  els.ipnsKeyOptions.innerHTML = "";
  state.ipnsKeys.forEach((key) => {
    const option = document.createElement("option");
    option.value = key.name;
    option.label = `${key.name} (${key.id})`;
    els.ipnsKeyOptions.appendChild(option);
  });
}

function renderIdentityIndicators() {
  const profile = getActiveProfile();
  if (!profile) return;

  const didLoaded = Boolean(profile.userDid);
  const encLoaded = Boolean(profile.encryptionPublicJwk && profile.encryptionPrivateJwk);
  const ipnsLoaded = Boolean(profile.ipnsKey && profile.ipnsKey.trim());

  els.didStatus.textContent = didLoaded ? "DID LOADED" : "DID MISSING";
  els.didStatus.className = `status ${didLoaded ? "working" : "error"}`;
  els.generateDid.hidden = didLoaded;

  els.encStatus.textContent = encLoaded ? "KEYS LOADED" : "KEYS MISSING";
  els.encStatus.className = `status ${encLoaded ? "working" : "error"}`;
  els.generateEncKeys.hidden = !didLoaded || encLoaded;

  els.ipnsStatus.textContent = ipnsLoaded ? "KEY LOADED" : "KEY MISSING";
  els.ipnsStatus.className = `status ${ipnsLoaded ? "working" : "error"}`;
  els.createKey.hidden = ipnsLoaded;
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem("chirpyPublisherProfiles");
    const parsed = raw ? JSON.parse(raw) : [];
    state.profiles = Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    state.profiles = [];
  }

  try {
    state.activeProfileId = localStorage.getItem("chirpyActiveProfileId");
  } catch (_error) {
    state.activeProfileId = null;
  }

  if (state.profiles.length === 0) {
    state.profiles.push(newProfileRecord("Home Space"));
  }
  state.profiles = state.profiles.map((profile) => ({
    ...profile,
    role: profile.role === "child" ? "child" : "adult",
    encryptionPublicJwk: profile.encryptionPublicJwk || null,
    encryptionPrivateJwk: profile.encryptionPrivateJwk || null
  }));
  if (!state.profiles.some((profile) => profile.id === state.activeProfileId)) {
    state.activeProfileId = state.profiles[0].id;
  }
  renderProfileSelect();
  persistProfiles();
}

function newProfileRecord(name) {
  return {
    id: safeUuid(),
    name,
    userDid: "",
    ipnsKey: "self",
    role: "adult",
    encryptionPublicJwk: null,
    encryptionPrivateJwk: null,
    createdAt: new Date().toISOString()
  };
}

function renderProfileSelect() {
  els.profileSelect.innerHTML = "";
  state.profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    els.profileSelect.appendChild(option);
  });
  els.profileSelect.value = state.activeProfileId || "";
  renderProfileSummary();
}

function onProfileSelectChange() {
  state.activeProfileId = els.profileSelect.value;
  applyActiveProfileToForm();
  persistProfiles();
  scheduleSave();
}

function onProfileRoleChange() {
  const profile = getActiveProfile();
  if (!profile) return;
  profile.role = els.profileRole.value === "child" ? "child" : "adult";
  persistProfiles();
  renderProfileSummary();
  enforceVisibilityPolicy();
  scheduleSave();
}

function getActiveProfile() {
  return state.profiles.find((profile) => profile.id === state.activeProfileId) || null;
}

function applyActiveProfileToForm() {
  const profile = getActiveProfile();
  if (!profile) return;
  els.userDid.value = profile.userDid || "";
  els.ipnsKey.value = profile.ipnsKey || "self";
  els.profileRole.value = profile.role === "child" ? "child" : "adult";
  enforceVisibilityPolicy();
  renderProfileSummary();
  renderIdentityIndicators();
  announceNodeProfile();
}

function renderProfileSummary() {
  const profile = getActiveProfile();
  if (!profile) {
    els.profileSummary.textContent = "No profile selected.";
    els.avatarInitials.textContent = "ID";
    return;
  }
  const did = profile.userDid ? abbreviate(profile.userDid, 14, 8) : "missing DID";
  const ipns = profile.ipnsKey ? profile.ipnsKey : "self";
  const roleLabel = profile.role === "child" ? "child" : "adult";
  const encState = profile.encryptionPublicJwk ? "enc-key:ready" : "enc-key:missing";
  els.profileSummary.textContent = `${profile.name} (${roleLabel}): ${did} | key ${ipns} | ${encState}`;
  els.avatarInitials.textContent = initialsFromName(profile.name);
}

function enforceVisibilityPolicy() {
  const profile = getActiveProfile();
  if (!profile) return;
  const childMode = profile.role === "child";
  if (childMode) {
    els.visibility.value = "family";
    els.visibility.disabled = true;
    els.visibilityHint.textContent = "Child safety mode: posts are family-only. Guardians can later make selected posts public.";
  } else {
    els.visibility.disabled = false;
    if (!["public", "family"].includes(els.visibility.value)) {
      els.visibility.value = "public";
    }
    els.visibilityHint.textContent = "Public posts can be viewed broadly; family posts are private to approved DIDs.";
  }
}

function createProfile() {
  const name = prompt("Profile name", `Profile ${state.profiles.length + 1}`);
  if (!name) return;
  const normalized = normalizeProfileName(name);
  if (!normalized) {
    alert("Profile name cannot be empty.");
    return;
  }
  if (hasProfileNameConflict(normalized)) {
    alert("That profile name already exists on this node.");
    return;
  }
  const record = newProfileRecord(normalized);
  const childMode = confirm("Is this a child profile (family-only posting)?");
  record.role = childMode ? "child" : "adult";
  state.profiles.push(record);
  state.activeProfileId = record.id;
  renderProfileSelect();
  applyActiveProfileToForm();
  persistProfiles();
  scheduleSave();
}

function renameProfile() {
  const profile = getActiveProfile();
  if (!profile) return;
  const name = prompt("Rename profile", profile.name);
  if (!name) return;
  const normalized = normalizeProfileName(name);
  if (!normalized) {
    alert("Profile name cannot be empty.");
    return;
  }
  if (hasProfileNameConflict(normalized, profile.id)) {
    alert("That profile name already exists on this node.");
    return;
  }
  profile.name = normalized;
  renderProfileSelect();
  persistProfiles();
  scheduleSave();
}

function deleteProfile() {
  if (state.profiles.length <= 1) {
    alert("At least one profile is required.");
    return;
  }
  const profile = getActiveProfile();
  if (!profile) return;
  const confirmed = confirm(`Delete profile "${profile.name}"?`);
  if (!confirmed) return;
  state.profiles = state.profiles.filter((x) => x.id !== profile.id);
  state.activeProfileId = state.profiles[0].id;
  renderProfileSelect();
  applyActiveProfileToForm();
  persistProfiles();
  scheduleSave();
}

function persistProfiles() {
  localStorage.setItem("chirpyPublisherProfiles", JSON.stringify(state.profiles));
  localStorage.setItem("chirpyActiveProfileId", state.activeProfileId || "");
}

function addBlock(type) {
  const block = {
    id: safeUuid(),
    type,
    html: "",
    url: "",
    preview: null,
    mediaIndex: -1
  };
  if (type === "title") block.html = "Optional title";
  state.blocks.push(block);
  state.selectedBlockId = block.id;
  renderBlocks();
  syncFrameControlsToSelection();
  renderLivePreview();
  scheduleSave();
}

function renderBlocks() {
  els.blocks.innerHTML = "";
  state.blocks.forEach((block, index) => {
    const node = els.blockTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = block.id;
    if (block.id === state.selectedBlockId) {
      node.classList.add("selected");
    }
    node.querySelector(".block-title").textContent = `${index + 1}. ${block.type.toUpperCase()}`;
    const body = node.querySelector(".block-body");
    node.addEventListener("click", (event) => {
      if (isInteractiveSelectionTarget(event.target)) return;
      selectBlock(block.id);
    });

    if (block.type === "link") {
      const input = document.createElement("input");
      input.type = "url";
      input.placeholder = "https://...";
      input.value = block.url || "";
      input.addEventListener("change", async () => {
        block.url = input.value;
        block.preview = await fetchLinkPreview(block.url);
        renderLivePreview();
        scheduleSave();
      });
      body.appendChild(input);
      const hint = document.createElement("div");
      hint.className = "sub small";
      hint.textContent = block.preview?.title || "Paste a URL to load a rich preview.";
      body.appendChild(hint);
    } else if (block.type === "image" || block.type === "video") {
      const select = document.createElement("select");
      const matches = state.files
        .map((file, fileIndex) => ({ file, fileIndex }))
        .filter((entry) => (block.type === "image" ? entry.file.type.startsWith("image/") : entry.file.type.startsWith("video/")));
      const defaultOpt = document.createElement("option");
      defaultOpt.value = "-1";
      defaultOpt.textContent = `Select ${block.type}`;
      select.appendChild(defaultOpt);
      matches.forEach((entry) => {
        const opt = document.createElement("option");
        opt.value = String(entry.fileIndex);
        opt.textContent = `${entry.file.name.slice(0, 26)}`;
        if (entry.fileIndex === block.mediaIndex) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => {
        block.mediaIndex = Number(select.value);
        renderLivePreview();
        scheduleSave();
      });
      body.appendChild(select);
    } else {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.innerHTML = block.html || "";
      editor.dataset.block = block.id;
      editor.addEventListener("focus", () => {
        state.activeEditable = editor;
      });
      editor.addEventListener("input", () => {
        block.html = editor.innerHTML;
        renderLivePreview();
        scheduleSave();
      });
      body.appendChild(editor);
    }

    node.querySelector(".remove").addEventListener("click", () => {
      if (state.selectedBlockId === block.id) {
        state.selectedBlockId = null;
      }
      state.blocks = state.blocks.filter((x) => x.id !== block.id);
      if (state.blocks.length === 0) addBlock("text");
      renderBlocks();
      syncFrameControlsToSelection();
      renderLivePreview();
      scheduleSave();
    });
    node.querySelector(".up").addEventListener("click", () => moveBlock(index, -1));
    node.querySelector(".down").addEventListener("click", () => moveBlock(index, 1));
    els.blocks.appendChild(node);
  });
}

function moveBlock(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.blocks.length) return;
  const [moved] = state.blocks.splice(index, 1);
  state.blocks.splice(target, 0, moved);
  renderBlocks();
  renderLivePreview();
  scheduleSave();
}

function selectBlock(blockId) {
  state.selectedBlockId = state.selectedBlockId === blockId ? null : blockId;
  renderBlocks();
  syncFrameControlsToSelection();
}

function getSelectedBlock() {
  if (!state.selectedBlockId) return null;
  return state.blocks.find((block) => block.id === state.selectedBlockId) || null;
}

function blockCanOverrideFrame(block) {
  return Boolean(block) && ["image", "video", "link"].includes(block.type);
}

function normalizeBlockFrameOverrides(block) {
  if (!block || !block.frameOverrides) return;
  const normalized = {};
  if (Number.isFinite(block.frameOverrides.imageBorder)) {
    const border = clamp(toFiniteNumber(block.frameOverrides.imageBorder, state.globalFrameDefaults.imageBorder), 0, 60);
    if (border !== state.globalFrameDefaults.imageBorder) {
      normalized.imageBorder = border;
    }
  }
  if (typeof block.frameOverrides.imageBg === "string" && block.frameOverrides.imageBg && block.frameOverrides.imageBg !== state.globalFrameDefaults.imageBg) {
    normalized.imageBg = block.frameOverrides.imageBg;
  }
  block.frameOverrides = Object.keys(normalized).length > 0 ? normalized : null;
}

function onScopedFrameControlChange() {
  const selected = getSelectedBlock();
  if (blockCanOverrideFrame(selected)) {
    selected.frameOverrides = selected.frameOverrides || {};
    selected.frameOverrides.imageBorder = clamp(toFiniteNumber(els.imageBorder.value, state.globalFrameDefaults.imageBorder), 0, 60);
    selected.frameOverrides.imageBg = els.imageBg.value || state.globalFrameDefaults.imageBg;
    normalizeBlockFrameOverrides(selected);
  } else {
    state.globalFrameDefaults.imageBorder = clamp(toFiniteNumber(els.imageBorder.value, 3), 0, 60);
    state.globalFrameDefaults.imageBg = els.imageBg.value || "#faf7f2";
    state.blocks.forEach((block) => normalizeBlockFrameOverrides(block));
  }
  scheduleSave();
  renderLivePreview();
}

function syncFrameControlsToSelection() {
  const selected = getSelectedBlock();
  if (blockCanOverrideFrame(selected)) {
    const imageBorder = Number.isFinite(selected.frameOverrides?.imageBorder)
      ? selected.frameOverrides.imageBorder
      : state.globalFrameDefaults.imageBorder;
    const imageBg = selected.frameOverrides?.imageBg || state.globalFrameDefaults.imageBg;
    els.imageBorder.value = String(imageBorder);
    els.imageBg.value = imageBg;
    return;
  }
  els.imageBorder.value = String(state.globalFrameDefaults.imageBorder);
  els.imageBg.value = state.globalFrameDefaults.imageBg;
}

function resolveFrameBorder(block) {
  if (!blockCanOverrideFrame(block)) return state.globalFrameDefaults.imageBorder;
  return Number.isFinite(block.frameOverrides?.imageBorder) ? block.frameOverrides.imageBorder : state.globalFrameDefaults.imageBorder;
}

function resolveFrameBg(block) {
  if (!blockCanOverrideFrame(block)) return state.globalFrameDefaults.imageBg;
  return block.frameOverrides?.imageBg || state.globalFrameDefaults.imageBg;
}

function queueFiles(nextFiles) {
  const allowed = nextFiles.filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
  state.files.push(...allowed);
  renderMedia();
  renderBlocks();
  renderLivePreview();
  scheduleSave();
}

function renderMedia() {
  els.mediaPreview.innerHTML = "";
  state.files.forEach((file, index) => {
    const item = document.createElement("article");
    item.className = "media-item";
    const media = file.type.startsWith("video/") ? document.createElement("video") : document.createElement("img");
    media.className = "media-thumb";
    media.src = URL.createObjectURL(file);
    if (media.tagName === "VIDEO") media.muted = true;
    const meta = document.createElement("div");
    meta.className = "media-meta";
    meta.textContent = `${file.name.slice(0, 22)} (${Math.round(file.size / 1024)} KB)`;
    const remove = document.createElement("button");
    remove.className = "btn ghost small";
    remove.textContent = "Remove";
    remove.style.width = "100%";
    remove.addEventListener("click", () => {
      state.files.splice(index, 1);
      renderMedia();
      renderBlocks();
      renderLivePreview();
      scheduleSave();
    });
    item.append(media, meta, remove);
    els.mediaPreview.appendChild(item);
  });
}

async function fetchLinkPreview(url) {
  if (!url) return null;
  try {
    const resp = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) return null;
    return data.preview;
  } catch (_error) {
    return null;
  }
}

function renderLivePreview() {
  const card = els.livePostCard;
  if (!card) return;
  card.innerHTML = "";
  card.style.background = els.cardColor.value;
  card.style.color = els.textColor.value;
  card.style.borderRadius = `${Number(els.cardRadius.value)}px`;
  card.style.fontFamily = els.fontFamily.value;
  card.style.fontSize = `${Number(els.baseFontSize.value)}px`;

  for (const block of state.blocks) {
    const wrap = document.createElement("section");
    wrap.className = "preview-block";
    if (block.type === "title") {
      const h = document.createElement("h3");
      h.className = "preview-title";
      h.innerHTML = block.html || "";
      wrap.appendChild(h);
      card.appendChild(wrap);
      continue;
    }
    if (block.type === "text") {
      const p = document.createElement("div");
      p.className = "preview-text";
      p.innerHTML = block.html || "";
      wrap.appendChild(p);
      card.appendChild(wrap);
      continue;
    }
    if (block.type === "image" || block.type === "video") {
      const file = state.files[block.mediaIndex];
      if (!file) continue;
      const frame = makePreviewFrame(block);
      const media = block.type === "video" ? document.createElement("video") : document.createElement("img");
      media.className = "preview-media";
      media.src = URL.createObjectURL(file);
      if (block.type === "video") media.controls = true;
      frame.appendChild(media);
      wrap.appendChild(frame);
      card.appendChild(wrap);
      continue;
    }
    if (block.type === "link") {
      const frame = makePreviewFrame(block);
      const link = document.createElement("div");
      link.className = "preview-link";
      link.innerHTML = `<strong>${escapeHtml(block.preview?.title || block.url || "Link")}</strong><div class="sub small">${escapeHtml(block.preview?.description || "")}</div>`;
      frame.appendChild(link);
      wrap.appendChild(frame);
      card.appendChild(wrap);
    }
  }
}

function makePreviewFrame(block) {
  const frame = document.createElement("div");
  frame.className = "preview-frame";
  if (els.frameEnabled.checked) {
    frame.style.padding = `${Number(els.imagePadding.value)}px`;
    frame.style.borderWidth = `${resolveFrameBorder(block)}px`;
    frame.style.borderColor = els.imageBorderColor.value;
    frame.style.background = resolveFrameBg(block);
  } else {
    frame.style.padding = "0";
    frame.style.borderWidth = "0";
  }
  if (els.frameLabelText.value.trim()) {
    const label = document.createElement("div");
    label.className = "preview-frame-label";
    label.style.color = els.accentColor.value;
    label.textContent = els.frameLabelText.value.trim();
    frame.appendChild(label);
  }
  return frame;
}

async function submitPost() {
  if (!isSetupComplete()) {
    scheduleSetupPrompt();
    setStatus("error", "Setup Required");
    els.resultJson.textContent = JSON.stringify(
      {
        ok: false,
        error:
          "First-time setup is required before staging posts. Open Identity and run First-Time Setup."
      },
      null,
      2
    );
    return;
  }

  state.isSubmitting = true;
  syncSetupGate(true);
  setStatus("working", "Staging");
  els.submitBtn.disabled = true;

  try {
    const profile = getActiveProfile();
    const userDid = (profile?.userDid || "").trim();
    const ipnsKey = (profile?.ipnsKey || "self").trim() || "self";
    const authorRole = profile?.role === "child" ? "child" : "adult";
    const visibility = authorRole === "child" ? "family" : els.visibility.value;
    const familyMembers = state.profiles
      .map((x) => String(x.userDid || "").trim())
      .filter(Boolean);
    const familyProfiles = state.profiles
      .filter((x) => x.userDid && x.encryptionPublicJwk)
      .map((x) => ({
        did: x.userDid,
        role: x.role === "child" ? "child" : "adult",
        encryptionPublicJwk: x.encryptionPublicJwk
      }));
    if (!userDid) {
      throw new Error("Active profile is missing a DID. Click Generate DID once.");
    }
    if (visibility === "family" && !profile?.encryptionPrivateJwk) {
      throw new Error("Active profile is missing encryption keys. Click Generate DID to refresh profile keys.");
    }

    const form = new FormData();
    const blocks = state.blocks.map((block) => ({
      type: block.type,
      content: stripHtml(block.html || ""),
      html: block.html || "",
      url: (block.url || "").trim(),
      preview: block.preview || null,
      mediaIndex: Number.isFinite(block.mediaIndex) ? block.mediaIndex : -1,
      frameOverrides: block.frameOverrides || null
    }));
    const urls = blocks
      .filter((b) => b.type === "link" && b.url)
      .map((b) => b.url)
      .join(",");

    form.append("blocks", JSON.stringify(blocks));
    form.append("text", buildTextFromBlocks(blocks));
    form.append("url", urls);
    form.append("tags", els.tags.value.trim());
    form.append("userDid", userDid);
    form.append("ipnsKey", ipnsKey);
    form.append("authorRole", authorRole);
    form.append("visibility", visibility);
    form.append("familyMembers", familyMembers.join(","));
    form.append("familyProfiles", JSON.stringify(familyProfiles));
    form.append("publish", els.publish.checked ? "true" : "false");
    form.append("autoTag", els.autoTag.checked ? "true" : "false");
    form.append(
      "mediaOptions",
      JSON.stringify({
        frameEnabled: els.frameEnabled.checked,
        imagePadding: Number(els.imagePadding.value),
        imageBorder: state.globalFrameDefaults.imageBorder,
        imageBg: state.globalFrameDefaults.imageBg,
        imageBorderColor: els.imageBorderColor.value,
        imageFrameText: els.frameLabelText.value.trim(),
        imageQuality: Number(els.imageQuality.value),
        previewStartSec: Number(els.previewStartSec.value),
        previewDurationSec: Number(els.previewDurationSec.value),
        hlsSegmentSec: Number(els.hlsSegmentSec.value)
      })
    );
    form.append(
      "postStyle",
      JSON.stringify({
        cardColor: els.cardColor.value,
        textColor: els.textColor.value,
        accentColor: els.accentColor.value,
        fontFamily: els.fontFamily.value,
        baseFontSize: Number(els.baseFontSize.value),
        cardRadius: Number(els.cardRadius.value)
      })
    );

    state.files.forEach((file) => form.append("media", file));

    const resp = await fetch("/stage", { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || "stage failed");
    }

    els.resultJson.textContent = JSON.stringify(data, null, 2);
    renderResultLinks(data.stageId);
    renderLensPreview(data.manifest, data.stageId);
    setStatus("idle", "Done");
    await loadHistory();
  } catch (error) {
    setStatus("error", "Error");
    els.resultJson.textContent = JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2);
  } finally {
    state.isSubmitting = false;
    syncSetupGate();
  }
}

function renderResultLinks(stageId) {
  els.resultLinks.innerHTML = "";
  const links = [
    { href: `/staged/${stageId}/manifest.json`, label: "Manifest" },
    { href: `/staged/${stageId}/post.json`, label: "Post JSON" }
  ];
  links.forEach((link) => {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = link.label;
    els.resultLinks.appendChild(a);
  });
}

async function loadHistory() {
  try {
    const resp = await fetch("/api/stages");
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "history load failed");

    els.historyList.innerHTML = "";
    data.stages.forEach((stage) => {
      const card = document.createElement("article");
      card.className = "history-item";
      card.innerHTML = `
        <strong>${stage.stageId}</strong>
        <div class="history-main">${stage.createdAt || "unknown time"}</div>
        <div class="history-main">${escapeHtml(stage.text || "(no text)")}</div>
        <div class="history-main">P:${stage.counts.photos} V:${stage.counts.videos} L:${stage.counts.links}</div>
      `;
      card.addEventListener("click", () => openStage(stage.stageId));
      els.historyList.appendChild(card);
    });
  } catch (error) {
    els.historyList.innerHTML = `<div class="history-main">Failed to load history: ${escapeHtml(error.message)}</div>`;
  }
}

async function openStage(stageId) {
  try {
    const resp = await fetch(`/api/stages/${encodeURIComponent(stageId)}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "stage load failed");
    els.resultJson.textContent = JSON.stringify(data, null, 2);
    renderResultLinks(stageId);
    renderLensPreview(data.manifest, stageId);
  } catch (error) {
    els.resultJson.textContent = JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2);
  }
}

async function loadUsers() {
  if (!els.usersList) return;
  try {
    const resp = await fetch("/api/users");
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "user list load failed");
    const users = Array.isArray(data.users) ? data.users : [];
    els.usersList.innerHTML = "";
    if (!users.length) {
      els.usersList.innerHTML = `<div class="history-main">No users discovered yet.</div>`;
      return;
    }
    users.forEach((user) => {
      const item = document.createElement("article");
      item.className = "history-item";
      const name = escapeHtml(user.name || "Unnamed node");
      const peerId = escapeHtml(user.peerId || user.id || "");
      const did = escapeHtml(user.profileDid || "");
      const ipns = escapeHtml(user.profileIpnsKey || "");
      const last = formatActivity(user.lastActivity);
      const stateText = user.active ? "active" : "idle";
      item.innerHTML = `
        <strong>${name}</strong>
        <div class="history-main">${peerId}</div>
        <div class="history-main">${did ? `did ${did}` : "did unknown"}</div>
        <div class="history-main">${ipns ? `ipns ${ipns}` : "ipns unknown"}</div>
        <div class="history-main">${stateText} • ${escapeHtml(last)}</div>
      `;
      els.usersList.appendChild(item);
    });
  } catch (error) {
    els.usersList.innerHTML = `<div class="history-main">Failed to load users: ${escapeHtml(error.message)}</div>`;
  }
}

function renderLensPreview(manifest, stageId) {
  if (!manifest || !manifest.assets || !manifest.post) {
    els.lensPreview.textContent = "No preview data available.";
    return;
  }

  const root = `/staged/${stageId}`;
  const parts = [];
  const text = escapeHtml(manifest.post.text || "");
  if (text) parts.push(`<p class="lens-post-text">${text}</p>`);

  if (manifest.assets.photos.length > 0) {
    const photoHtml = manifest.assets.photos
      .map((photo) => `<img src="${root}/${photo.framed}" alt="photo" loading="lazy" />`)
      .join("");
    parts.push(`<div class="lens-grid">${photoHtml}</div>`);
  }

  if (manifest.assets.videos.length > 0) {
    const videoHtml = manifest.assets.videos
      .map(
        (video) => `
          <video controls preload="metadata" poster="${root}/${video.previewGif}">
            <source src="${root}/${video.hls}" type="application/x-mpegURL" />
            <source src="${root}/${video.source}" />
          </video>
        `
      )
      .join("");
    parts.push(`<div class="lens-grid">${videoHtml}</div>`);
  }

  if (manifest.assets.links.length > 0) {
    const linkHtml = manifest.assets.links
      .map((link) => {
        const title = escapeHtml(link.title || link.url || "link");
        const desc = escapeHtml(link.description || "");
        const href = escapeHtml(link.url || "#");
        return `<article class="lens-link"><a href="${href}" target="_blank" rel="noreferrer">${title}</a><div class="history-main">${desc}</div></article>`;
      })
      .join("");
    parts.push(linkHtml);
  }

  els.lensPreview.innerHTML = parts.join("") || "No content in this stage.";
}

function buildTextFromBlocks(blocks) {
  return blocks
    .map((block) => {
      if (block.type === "link") return block.url;
      return stripHtml(block.html || block.content || "");
    })
    .filter(Boolean)
    .join("\n\n");
}

function setStatus(mode, text) {
  els.statusPill.className = `status ${mode}`;
  els.statusPill.textContent = text;
}

function scheduleSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDraft, 250);
}

function saveDraft() {
  const draft = {
    activeProfileId: state.activeProfileId,
    tags: els.tags.value,
    visibility: els.visibility.value,
    publish: els.publish.checked,
    autoTag: els.autoTag.checked,
    mediaOptions: {
      frameEnabled: els.frameEnabled.checked,
      imagePadding: els.imagePadding.value,
      imageBorder: String(state.globalFrameDefaults.imageBorder),
      imageBg: state.globalFrameDefaults.imageBg,
      imageBorderColor: els.imageBorderColor.value,
      frameLabelText: els.frameLabelText.value,
      imageQuality: els.imageQuality.value,
      previewStartSec: els.previewStartSec.value,
      previewDurationSec: els.previewDurationSec.value,
      hlsSegmentSec: els.hlsSegmentSec.value
    },
    postStyle: {
      cardColor: els.cardColor.value,
      textColor: els.textColor.value,
      accentColor: els.accentColor.value,
      fontFamily: els.fontFamily.value,
      baseFontSize: els.baseFontSize.value,
      cardRadius: els.cardRadius.value
    },
    blocks: state.blocks.map((block) => ({ ...block }))
  };
  localStorage.setItem("chirpyPublisherDraft", JSON.stringify(draft));
}

function hydrateDraft() {
  try {
    const raw = localStorage.getItem("chirpyPublisherDraft");
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.activeProfileId && state.profiles.some((p) => p.id === draft.activeProfileId)) {
      state.activeProfileId = draft.activeProfileId;
      renderProfileSelect();
      applyActiveProfileToForm();
    }
    if (draft.userDid || draft.ipnsKey) {
      const profile = getActiveProfile();
      if (profile) {
        if (draft.userDid) profile.userDid = draft.userDid;
        if (draft.ipnsKey) profile.ipnsKey = draft.ipnsKey;
        persistProfiles();
      }
    }
    els.tags.value = draft.tags || "";
    els.visibility.value = draft.visibility || "public";
    els.publish.checked = draft.publish !== false;
    els.autoTag.checked = draft.autoTag !== false;
    els.frameEnabled.checked = draft.mediaOptions?.frameEnabled !== false;
    els.imagePadding.value = draft.mediaOptions?.imagePadding || "24";
    els.imageBorder.value = draft.mediaOptions?.imageBorder || "3";
    els.imageBg.value = draft.mediaOptions?.imageBg || "#faf7f2";
    els.imageBorderColor.value = draft.mediaOptions?.imageBorderColor || "#1d1d1d";
    els.frameLabelText.value = draft.mediaOptions?.frameLabelText || "";
    els.imageQuality.value = draft.mediaOptions?.imageQuality || "86";
    els.previewStartSec.value = draft.mediaOptions?.previewStartSec || "0";
    els.previewDurationSec.value = draft.mediaOptions?.previewDurationSec || "5";
    els.hlsSegmentSec.value = draft.mediaOptions?.hlsSegmentSec || "4";
    els.cardColor.value = draft.postStyle?.cardColor || "#ffffff";
    els.textColor.value = draft.postStyle?.textColor || "#1a1b1a";
    els.accentColor.value = draft.postStyle?.accentColor || "#0e7a6c";
    els.fontFamily.value = draft.postStyle?.fontFamily || "'IBM Plex Sans', sans-serif";
    els.baseFontSize.value = draft.postStyle?.baseFontSize || "17";
    els.cardRadius.value = draft.postStyle?.cardRadius || "18";
    state.globalFrameDefaults.imageBorder = clamp(toFiniteNumber(draft.mediaOptions?.imageBorder, 3), 0, 60);
    state.globalFrameDefaults.imageBg = draft.mediaOptions?.imageBg || "#faf7f2";
    state.blocks = Array.isArray(draft.blocks)
      ? draft.blocks.map((block) => {
          const nextBlock = { ...block };
          if (nextBlock.frameOverrides) {
            nextBlock.frameOverrides = { ...nextBlock.frameOverrides };
            normalizeBlockFrameOverrides(nextBlock);
          }
          return nextBlock;
        })
      : [];
    state.selectedBlockId = null;
    syncFrameControlsToSelection();
    styleFontPicker();
  } catch (_error) {
    state.blocks = [];
    state.selectedBlockId = null;
    styleFontPicker();
  }
}

function clearDraft() {
  localStorage.removeItem("chirpyPublisherDraft");
  state.blocks = [];
  state.files = [];
  applyActiveProfileToForm();
  els.tags.value = "";
  els.visibility.value = "public";
  els.publish.checked = true;
  els.autoTag.checked = true;
  els.frameEnabled.checked = true;
  els.imagePadding.value = "24";
  els.imageBorder.value = "3";
  els.imageBg.value = "#faf7f2";
  els.imageBorderColor.value = "#1d1d1d";
  els.frameLabelText.value = "";
  els.imageQuality.value = "86";
  els.previewStartSec.value = "0";
  els.previewDurationSec.value = "5";
  els.hlsSegmentSec.value = "4";
  els.cardColor.value = "#ffffff";
  els.textColor.value = "#1a1b1a";
  els.accentColor.value = "#0e7a6c";
  els.fontFamily.value = "'IBM Plex Sans', sans-serif";
  els.baseFontSize.value = "17";
  els.cardRadius.value = "18";
  state.selectedBlockId = null;
  state.globalFrameDefaults.imageBorder = 3;
  state.globalFrameDefaults.imageBg = "#faf7f2";
  styleFontPicker();
  enforceVisibilityPolicy();
  addBlock("text");
  renderBlocks();
  renderMedia();
  syncFrameControlsToSelection();
  renderLivePreview();
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isInteractiveSelectionTarget(target) {
  const node = target instanceof Element ? target : null;
  if (!node) return false;
  return Boolean(
    node.closest(
      "select, option, input, textarea, button, a, summary, label, [contenteditable='true']"
    )
  );
}

function styleFontPicker() {
  if (!els.fontFamily) return;
  Array.from(els.fontFamily.options).forEach((option) => {
    option.style.fontFamily = option.value;
  });
  els.fontFamily.style.fontFamily = els.fontFamily.value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatActivity(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString();
}

function syncSetupGate(knownComplete) {
  const complete = typeof knownComplete === "boolean" ? knownComplete : isSetupComplete();
  if (els.runSetup) {
    els.runSetup.textContent = complete ? "Setup Complete" : "Run First-Time Setup";
  }
  if (els.submitBtn) {
    const blocked = !complete;
    const disabled = state.isSubmitting || blocked;
    els.submitBtn.disabled = disabled;
    els.submitBtn.title = blocked ? "Complete first-time setup in Identity before staging posts." : "";
  }
}

async function announceNodeProfile() {
  const profile = getActiveProfile();
  if (!profile) return;
  try {
    await fetch("/api/network-node/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        did: String(profile.userDid || "").trim(),
        ipnsKey: String(profile.ipnsKey || "").trim()
      })
    });
  } catch (_error) {
    // ignore network announce failures in UI flow
  }
}

function normalizeNodeNameLocal(value) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (raw.length < 3 || raw.length > 40) return "";
  if (!/^[a-zA-Z0-9._ -]+$/.test(raw)) return "";
  return raw;
}

function normalizeProfileName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function hasProfileNameConflict(name, excludeId) {
  const candidate = normalizeProfileName(name).toLowerCase();
  if (!candidate) return false;
  return state.profiles.some((profile) => {
    if (excludeId && profile.id === excludeId) return false;
    return normalizeProfileName(profile.name).toLowerCase() === candidate;
  });
}

function stripHtml(value) {
  const div = document.createElement("div");
  div.innerHTML = String(value || "");
  return (div.textContent || div.innerText || "").trim();
}

function abbreviate(value, head, tail) {
  const text = String(value || "");
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function initialsFromName(name) {
  const cleaned = String(name || "").trim();
  if (!cleaned) return "ID";
  const tokens = cleaned.split(/\s+/).filter(Boolean).slice(0, 2);
  return tokens.map((x) => x[0].toUpperCase()).join("");
}

function safeUuid() {
  const webCrypto = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `fallback-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
