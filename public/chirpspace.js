const els = {
  refreshChirpSpace: document.getElementById("refreshChirpSpace"),
  chirpspaceIdentity: document.getElementById("chirpspaceIdentity"),
  chirpspaceFeed: document.getElementById("chirpspaceFeed"),
  viewerProfile: document.getElementById("viewerProfile"),
  authorProfile: document.getElementById("authorProfile"),
  postTemplate: document.getElementById("postTemplate"),
  desktopRuntime: document.getElementById("desktopRuntime"),
  onboardingCard: document.getElementById("onboardingCard"),
  nicknameInput: document.getElementById("nicknameInput"),
  interestsInput: document.getElementById("interestsInput"),
  saveOnboarding: document.getElementById("saveOnboarding"),
  onboardingStatus: document.getElementById("onboardingStatus"),
  refreshRadar: document.getElementById("refreshRadar"),
  radarList: document.getElementById("radarList"),
  walkthroughGate: document.getElementById("walkthroughGate"),
  walkthroughChecklist: document.getElementById("walkthroughChecklist"),
  refreshWalkthrough: document.getElementById("refreshWalkthrough"),
  dismissWalkthrough: document.getElementById("dismissWalkthrough"),
  tagActionMenu: document.getElementById("tagActionMenu")
};

const state = {
  profiles: [],
  viewerProfileId: "",
  authorProfileId: "",
  posts: [],
  desktopProfile: null,
  desktopStatus: null,
  radarCandidates: [],
  selectedChirperId: "",
  selectedTag: "",
  viewerPublicTags: [],
  feedScope: "default",
  hiddenTopicsAll: [],
  hiddenUserTopics: {},
  tagMenuContext: null
};

boot();

async function boot() {
  loadProfiles();
  loadTopicFilters();
  bindControls();
  renderProfileSelectors();
  await hydrateDesktopContext();
  await refreshWalkthroughGate();
  await loadChirpSpace();
  await loadRadar();
}

function loadProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem("chirpyPublisherProfiles") || "[]");
    state.profiles = Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    state.profiles = [];
  }
  const activeId = localStorage.getItem("chirpyActiveProfileId") || "";
  if (!state.profiles.length) return;
  state.viewerProfileId = activeId && state.profiles.some((p) => p.id === activeId) ? activeId : state.profiles[0].id;
  state.authorProfileId = state.viewerProfileId;
}

function bindControls() {
  els.refreshChirpSpace.addEventListener("click", async () => {
    await loadChirpSpace();
    await loadRadar();
  });
  els.viewerProfile.addEventListener("change", async () => {
    state.viewerProfileId = els.viewerProfile.value;
    updateIdentityText();
    await loadChirpSpace();
    await loadRadar();
  });
  els.authorProfile.addEventListener("change", async () => {
    state.authorProfileId = els.authorProfile.value;
    await loadChirpSpace();
    await loadRadar();
  });
  if (els.saveOnboarding) {
    els.saveOnboarding.addEventListener("click", saveDesktopOnboarding);
  }
  if (els.refreshRadar) {
    els.refreshRadar.addEventListener("click", loadRadar);
  }
  if (els.refreshWalkthrough) {
    els.refreshWalkthrough.addEventListener("click", refreshWalkthroughGate);
  }
  if (els.dismissWalkthrough) {
    els.dismissWalkthrough.addEventListener("click", () => {
      try {
        sessionStorage.setItem("chirpyWalkthroughDismissed", "1");
      } catch (_error) {
        // ignore
      }
      if (els.walkthroughGate) els.walkthroughGate.classList.add("hidden");
    });
  }
  document.addEventListener("click", (event) => {
    const menu = els.tagActionMenu;
    if (!menu || menu.classList.contains("hidden")) return;
    const target = event.target;
    if (target instanceof Node && menu.contains(target)) return;
    closeTagMenu();
  });
}

function renderProfileSelectors() {
  els.viewerProfile.innerHTML = "";
  els.authorProfile.innerHTML = "";
  for (const profile of state.profiles) {
    const label = `${profile.name} (${profile.role === "child" ? "child" : "adult"})`;
    const a = document.createElement("option");
    a.value = profile.id;
    a.textContent = label;
    const b = document.createElement("option");
    b.value = profile.id;
    b.textContent = label;
    els.viewerProfile.appendChild(a);
    els.authorProfile.appendChild(b);
  }
  if (state.viewerProfileId) els.viewerProfile.value = state.viewerProfileId;
  if (state.authorProfileId) els.authorProfile.value = state.authorProfileId;
  updateIdentityText();
}

function activeViewer() {
  return state.profiles.find((x) => x.id === state.viewerProfileId) || null;
}

function activeAuthor() {
  return state.profiles.find((x) => x.id === state.authorProfileId) || null;
}

function updateIdentityText() {
  const viewer = activeViewer();
  const author = activeAuthor();
  if (!viewer) {
    els.chirpspaceIdentity.textContent = "No identity profiles found. Create them in Publisher first.";
    return;
  }
  const chirper = selectedChirper();
  const topic = state.selectedTag ? ` | Topic: #${state.selectedTag}` : "";
  const feedLabel = state.feedScope === "all" && state.selectedTag
    ? "All Chirpers"
    : chirper
      ? `Chirper ${chirper.name}`
      : `Feed: ${author?.name || "unknown"}`;
  els.chirpspaceIdentity.textContent = `Viewing as ${viewer.name} (${viewer.role || "adult"}) | ${feedLabel}${topic}`;
}

async function hydrateDesktopContext() {
  if (!window.chirpyDesktop) {
    if (els.desktopRuntime) els.desktopRuntime.textContent = "Browser mode: desktop sidecars unavailable.";
    hideOnboardingCard();
    return;
  }

  let profileLoaded = false;
  try {
    const profileResp = await window.chirpyDesktop.getProfile();
    state.desktopProfile = profileResp?.ok ? profileResp.profile : null;
    profileLoaded = true;
  } catch (_error) {
    state.desktopProfile = null;
  }

  try {
    const statusResp = await window.chirpyDesktop.getStatus();
    state.desktopStatus = statusResp?.ok ? statusResp : null;
  } catch (_error) {
    state.desktopStatus = null;
  }

  renderDesktopRuntime();
  if (state.desktopProfile?.nickname && Array.isArray(state.desktopProfile?.interests)) {
    hideOnboardingCard();
    prefillDesktopProfile();
    return;
  }
  if (!profileLoaded && els.desktopRuntime) {
    els.desktopRuntime.textContent = "Desktop profile unavailable right now.";
  }
  showOnboardingCard();
}

function renderDesktopRuntime() {
  if (!els.desktopRuntime) return;
  if (!state.desktopStatus) {
    els.desktopRuntime.textContent = "Desktop runtime status unavailable.";
    return;
  }
  const ipfs = state.desktopStatus.sidecars?.ipfs;
  const ollama = state.desktopStatus.sidecars?.ollama;
  const ipfsLabel = ipfs?.running ? `IPFS:${ipfs.source}` : "IPFS:offline";
  const ollamaLabel = ollama?.running ? `Ollama:${ollama.source}` : "Ollama:offline";
  const modelLabel = ollama?.modelReady ? "model:ready" : "model:loading";
  els.desktopRuntime.textContent = `${ipfsLabel} | ${ollamaLabel} | ${modelLabel}`;
}

function prefillDesktopProfile() {
  if (!state.desktopProfile) return;
  if (els.nicknameInput) els.nicknameInput.value = state.desktopProfile.nickname || "";
  if (els.interestsInput) els.interestsInput.value = (state.desktopProfile.interests || []).join(", ");
}

function showOnboardingCard() {
  if (!els.onboardingCard) return;
  els.onboardingCard.classList.remove("hidden");
}

function hideOnboardingCard() {
  if (!els.onboardingCard) return;
  els.onboardingCard.classList.add("hidden");
}

async function saveDesktopOnboarding() {
  if (!window.chirpyDesktop) {
    els.onboardingStatus.textContent = "Desktop profile is available only in Electron mode.";
    return;
  }
  const nickname = String(els.nicknameInput?.value || "").trim();
  const interests = String(els.interestsInput?.value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (interests.length < 3) {
    els.onboardingStatus.textContent = "Choose at least 3 interests.";
    return;
  }

  els.onboardingStatus.textContent = "Saving...";
  const result = await window.chirpyDesktop.saveProfile({ nickname, interests });
  if (!result?.ok) {
    els.onboardingStatus.textContent = result?.error || "Could not save profile.";
    return;
  }
  state.desktopProfile = result.profile;
  hideOnboardingCard();
  els.onboardingStatus.textContent = "";
  await refreshWalkthroughGate();
  await loadRadar();
}

async function loadChirpSpace() {
  const viewer = activeViewer();
  const author = activeAuthor();
  try {
    closeTagMenu();
    if (state.feedScope === "all" && state.selectedTag) {
      const loaded = await loadAllPublicPosts();
      const filtered = applyVisibilityFilters(applyTagFilter(loaded, state.selectedTag));
      state.posts = filtered;
      updateIdentityText();
      await renderPosts(state.posts);
      return;
    }
    const chirper = selectedChirper();
    let resp;
    let data;
    if (chirper && chirper.httpBase && chirper.source !== "self") {
      const params = new URLSearchParams({ limit: "100", base: chirper.httpBase });
      if (chirper.did) params.set("authorDid", chirper.did);
      resp = await fetch(`/api/chirpspace/remote?${params.toString()}`);
      data = await resp.json();
      if ((!resp.ok || !data.ok) && chirper.did) {
        throw new Error(data.error || "ChirpSpace load failed");
      }
      let loaded = Array.isArray(data?.posts) ? data.posts : [];
      if (chirper.did && loaded.length === 0) {
        const retry = new URLSearchParams({ limit: "100", base: chirper.httpBase });
        const retryResp = await fetch(`/api/chirpspace/remote?${retry.toString()}`);
        const retryData = await retryResp.json();
        if (retryResp.ok && retryData?.ok) {
          loaded = Array.isArray(retryData.posts) ? retryData.posts : [];
        }
      }
      state.posts = applyVisibilityFilters(applyTagFilter(loaded, state.selectedTag));
      updateIdentityText();
      await renderPosts(state.posts);
      return;
    } else {
      const params = new URLSearchParams({ limit: "100" });
      const authorDid = chirper?.did || author?.userDid || "";
      if (authorDid) params.set("authorDid", authorDid);
      if (viewer?.userDid) params.set("viewerDid", viewer.userDid);
      params.set("viewerRole", viewer?.role === "child" ? "child" : "adult");
      resp = await fetch(`/api/chirpspace?${params.toString()}`);
      data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "ChirpSpace load failed");
      const loaded = Array.isArray(data.posts) ? data.posts : [];
      state.posts = applyVisibilityFilters(applyTagFilter(loaded, state.selectedTag));
      updateIdentityText();
      await renderPosts(state.posts);
      return;
    }
  } catch (error) {
    state.posts = [];
    els.chirpspaceFeed.innerHTML = `<div class="empty-state">Failed to load ChirpSpace: ${escapeHtml(error.message)}</div>`;
  }
}

async function loadRadar() {
  if (!els.radarList) return;
  try {
    const [usersResp, postsResp] = await Promise.all([
      fetch("/api/users"),
      fetch("/api/chirpspace?limit=200")
    ]);
    const usersData = await usersResp.json();
    const postsData = await postsResp.json();
    if (!usersResp.ok || !usersData.ok) throw new Error(usersData.error || "users load failed");
    if (!postsResp.ok || !postsData.ok) throw new Error(postsData.error || "posts load failed");
    const users = Array.isArray(usersData.users) ? usersData.users : [];
    const tagsByDid = aggregateTagsByDid(Array.isArray(postsData.posts) ? postsData.posts : []);
    const localDids = state.profiles
      .map((p) => String(p?.userDid || "").trim())
      .filter(Boolean);
    const viewer = activeViewer();
    if (viewer?.userDid && !localDids.includes(String(viewer.userDid).trim())) {
      localDids.push(String(viewer.userDid).trim());
    }
    const localPostTags = [];
    for (const did of localDids) {
      localPostTags.push(...(tagsByDid.get(did) || []));
    }
    const localPresenceTags = users
      .filter((u) => localDids.includes(String(u.profileDid || "").trim()))
      .flatMap((u) => (Array.isArray(u.tags) ? u.tags : []));
    state.viewerPublicTags = normalizeTagList([...localPostTags, ...localPresenceTags]).slice(0, 48);
    const candidates = users.map((user) => {
      const announcedTags = Array.isArray(user.tags) ? user.tags : [];
      const fromLocalHistory = tagsByDid.get(user.profileDid) || [];
      const rawTags = user.source === "self"
        ? (fromLocalHistory.length ? fromLocalHistory : announcedTags)
        : (announcedTags.length ? announcedTags : fromLocalHistory);
      const visibleTags = filterVisibleTags(rawTags, user.profileDid || user.id || "");
      const tags = prioritizeTagsByAffinity(visibleTags, state.viewerPublicTags);
      return {
        id: user.id,
        name: user.name || "unnamed",
        did: user.profileDid || "",
        httpBase: user.httpBase || "",
        source: user.source || "",
        key: String(user.profileDid || user.id || "").trim(),
        tags,
        active: Boolean(user.active),
        lastActivity: user.lastActivity || ""
      };
    });
    state.radarCandidates = candidates;
    if (state.selectedChirperId && !state.radarCandidates.some((x) => x.id === state.selectedChirperId)) {
      state.selectedChirperId = "";
      state.selectedTag = "";
      updateIdentityText();
    }
    const matchById = await computeMatches(candidates);
    renderRadar(candidates, matchById);
  } catch (error) {
    els.radarList.innerHTML = `<div class="empty-state">Failed to load radar: ${escapeHtml(error.message)}</div>`;
  }
}

function prioritizeTagsByAffinity(tags, affinityTags) {
  const list = normalizeTagList(tags || []);
  const affinity = new Set(normalizeTagList(affinityTags || []));
  if (!list.length) return list;
  const overlap = [];
  const rest = [];
  for (const tag of list) {
    if (tag === "general") continue;
    if (affinity.size && affinity.has(tag)) overlap.push(tag);
    else rest.push(tag);
  }
  const out = [...overlap, ...rest];
  if (list.includes("general")) out.push("general");
  return out;
}

function normalizeTagList(values) {
  const raw = Array.isArray(values) ? values : String(values || "").split(",");
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

async function refreshWalkthroughGate() {
  if (!els.walkthroughGate || !els.walkthroughChecklist) return;
  const checklist = await computeWalkthroughChecklist();
  els.walkthroughChecklist.innerHTML = "";
  checklist.forEach((item) => {
    const row = document.createElement("div");
    row.className = `walkthrough-item${item.ok ? " ok" : ""}`;
    if (item.optional) row.classList.add("optional");
    const status = item.ok ? "DONE" : "TODO";
    row.innerHTML = `
      <strong>${status}: ${escapeHtml(item.label)}${item.optional ? " (optional)" : ""}</strong>
      <div class="sub small">${escapeHtml(item.description || "")}</div>
    `;
    els.walkthroughChecklist.appendChild(row);
  });
  const allDone = checklist.every((x) => x.ok || x.optional);
  const dismissed = getWalkthroughDismissed();
  if (allDone) {
    clearWalkthroughDismissed();
    els.walkthroughGate.classList.add("hidden");
    return;
  }
  els.walkthroughGate.classList.toggle("hidden", dismissed);
}

async function computeWalkthroughChecklist() {
  const items = [];
  const profile = activeViewer();
  const desktopProfileReady = !window.chirpyDesktop || Boolean(state.desktopProfile?.nickname && (state.desktopProfile?.interests || []).length >= 3);
  items.push({
    label: "Set Chirper nickname and interests",
    description: "Improves Chirper matching so your feed highlights relevant people and posts.",
    ok: desktopProfileReady
  });

  let nodeName = "";
  let ipfsAvailable = false;
  try {
    const [nodeResp, setupResp] = await Promise.all([fetch("/api/network-node"), fetch("/api/setup")]);
    const nodeData = await nodeResp.json();
    const setupData = await setupResp.json();
    if (nodeResp.ok && nodeData?.ok) nodeName = String(nodeData.nodeName || "").trim();
    if (setupResp.ok && setupData?.ok) ipfsAvailable = Boolean(setupData?.ipfs?.available);
  } catch (_error) {
    // keep defaults
  }
  const desktopIpfsRunning = Boolean(state.desktopStatus?.sidecars?.ipfs?.running);
  if (desktopIpfsRunning) ipfsAvailable = true;

  items.push({
    label: "Save a node label",
    description: "Optional device label for your own instance; public identity is based on profile DID.",
    ok: Boolean(nodeName && nodeName.length >= 3),
    optional: true
  });
  items.push({
    label: "Create or select an identity profile",
    description: "Profiles represent people on your node and control posting role/visibility.",
    ok: Boolean(profile?.name)
  });
  items.push({
    label: "Generate DID for selected profile",
    description: "DID identifies the profile for discovery and recipient-level privacy controls.",
    ok: Boolean(profile?.userDid)
  });
  items.push({
    label: "Create/select IPNS key for selected profile",
    description: "IPNS key gives your profile a stable publish address for updates over time.",
    ok: Boolean(profile?.ipnsKey && profile.ipnsKey !== "self")
  });
  items.push({
    label: "Generate encryption keys for selected profile",
    description: "Needed for family/private posts and decrypting content intended for this profile.",
    ok: Boolean(profile?.encryptionPublicJwk && profile?.encryptionPrivateJwk)
  });
  items.push({
    label: "IPFS engine is running",
    description: "Enables publishing, pubsub presence, and cross-node discovery.",
    ok: ipfsAvailable
  });

  return items;
}

function getWalkthroughDismissed() {
  try {
    return sessionStorage.getItem("chirpyWalkthroughDismissed") === "1";
  } catch (_error) {
    return false;
  }
}

function clearWalkthroughDismissed() {
  try {
    sessionStorage.removeItem("chirpyWalkthroughDismissed");
  } catch (_error) {
    // ignore
  }
}

function aggregateTagsByDid(posts) {
  const map = new Map();
  for (const post of posts || []) {
    const did = String(post?.userDid || "").trim();
    if (!did) continue;
    const tags = Array.isArray(post?.tags) ? post.tags : [];
    const existing = map.get(did) || new Set();
    for (const tag of tags) {
      const clean = String(tag || "").trim().toLowerCase();
      if (clean) existing.add(clean);
    }
    map.set(did, existing);
  }
  const out = new Map();
  for (const [did, set] of map.entries()) {
    out.set(did, Array.from(set).slice(0, 8));
  }
  return out;
}

async function computeMatches(candidates) {
  const map = new Map();
  const interests = Array.isArray(state.desktopProfile?.interests) ? state.desktopProfile.interests : [];
  if (!interests.length) return map;

  if (window.chirpyDesktop?.semanticMatch) {
    try {
      const result = await window.chirpyDesktop.semanticMatch({
        interests,
        candidates: candidates.map((x) => ({ id: x.id, name: x.name, tags: x.tags }))
      });
      const matches = Array.isArray(result?.matches) ? result.matches : [];
      matches.forEach((item) => {
        map.set(String(item.id), { score: Number(item.score) || 0, reason: item.reason || "semantic" });
      });
      return map;
    } catch (_error) {
      // fallback below
    }
  }

  candidates.forEach((candidate) => {
    const tags = candidate.tags || [];
    const overlap = tags.filter((x) => interests.includes(x)).length;
    if (overlap > 0) {
      map.set(candidate.id, { score: overlap / interests.length, reason: "keyword" });
    }
  });
  return map;
}

function renderRadar(candidates, matchById) {
  els.radarList.innerHTML = "";
  if (!candidates.length) {
    els.radarList.innerHTML = '<div class="empty-state">No active users discovered yet.</div>';
    return;
  }

  candidates
    .sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")))
    .forEach((candidate) => {
      const item = document.createElement("article");
      const match = matchById.get(candidate.id);
      item.className = `radar-item${match ? " match" : ""}${state.selectedChirperId === candidate.id ? " selected" : ""}`;
      const status = candidate.active ? "active" : "idle";
      const tagsHtml = (candidate.tags || [])
        .slice(0, 6)
        .map((tag) => `<button class="pill-mini pill-action" type="button" data-chirper-id="${escapeHtml(candidate.id)}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`)
        .join("");
      const score = match ? ` | match ${Math.round((match.score || 0) * 100)}% (${match.reason})` : "";
      item.innerHTML = `
        <strong><button class="chirper-link" type="button" data-chirper-id="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</button></strong>
        <div class="sub small">${status}${score}</div>
        <div class="sub small">${escapeHtml(candidate.did || "no DID announced")}</div>
        <div>${tagsHtml || '<span class="sub small">no public tags yet</span>'}</div>
      `;
      const nameBtn = item.querySelector(".chirper-link");
      nameBtn?.addEventListener("click", async () => {
        const same = state.selectedChirperId === candidate.id;
        state.selectedChirperId = same ? "" : candidate.id;
        state.selectedTag = "";
        state.feedScope = "default";
        updateIdentityText();
        renderRadar(candidates, matchById);
        await loadChirpSpace();
      });
      item.querySelectorAll(".pill-action").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const nextTag = String(button.getAttribute("data-tag") || "").trim().toLowerCase();
          openTagMenu(event, candidate, nextTag);
        });
      });
      els.radarList.appendChild(item);
    });
}

function selectedChirper() {
  return state.radarCandidates.find((x) => x.id === state.selectedChirperId) || null;
}

function openTagMenu(event, candidate, tag) {
  event.preventDefault();
  event.stopPropagation();
  const menu = els.tagActionMenu;
  if (!menu) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const safeTag = String(tag || "").trim().toLowerCase();
  if (!safeTag) return;
  const userKey = String(candidate?.did || candidate?.id || "").trim();
  state.tagMenuContext = { candidate, tag: safeTag, userKey };
  menu.innerHTML = `
    <div class="tag-menu-group">
      <div class="tag-menu-title">View</div>
      <button class="tag-menu-action" type="button" data-action="view-all">All posts on this topic</button>
      <button class="tag-menu-action" type="button" data-action="view-user">This user's posts on this topic</button>
    </div>
    <div class="tag-menu-group">
      <div class="tag-menu-title">Hide</div>
      <button class="tag-menu-action" type="button" data-action="hide-all">All posts on this topic</button>
      <button class="tag-menu-action" type="button" data-action="hide-user">This user's posts on this topic</button>
    </div>
  `;
  const rect = target.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.round(rect.left))}px`;
  menu.style.top = `${Math.round(rect.bottom + 8)}px`;
  menu.classList.remove("hidden");
  menu.setAttribute("aria-hidden", "false");
  menu.querySelectorAll(".tag-menu-action").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = String(btn.getAttribute("data-action") || "").trim();
      await handleTagMenuAction(action, state.tagMenuContext);
      closeTagMenu();
      await loadRadar();
      await loadChirpSpace();
    });
  });
}

function closeTagMenu() {
  const menu = els.tagActionMenu;
  if (!menu) return;
  menu.classList.add("hidden");
  menu.setAttribute("aria-hidden", "true");
  menu.innerHTML = "";
  state.tagMenuContext = null;
}

async function handleTagMenuAction(action, context) {
  const tag = String(context?.tag || "").trim().toLowerCase();
  const candidate = context?.candidate || null;
  const userKey = String(context?.userKey || "").trim();
  if (!tag) return;
  if (action === "view-all") {
    state.selectedChirperId = "";
    state.selectedTag = tag;
    state.feedScope = "all";
    updateIdentityText();
    return;
  }
  if (action === "view-user") {
    state.selectedChirperId = String(candidate?.id || "").trim();
    state.selectedTag = tag;
    state.feedScope = "default";
    updateIdentityText();
    return;
  }
  if (action === "hide-all") {
    const next = new Set(normalizeTagList(state.hiddenTopicsAll || []));
    next.add(tag);
    state.hiddenTopicsAll = Array.from(next);
    persistTopicFilters();
    if (state.selectedTag === tag) {
      state.selectedTag = "";
      state.feedScope = "default";
    }
    updateIdentityText();
    return;
  }
  if (action === "hide-user") {
    if (!userKey) return;
    const map = { ...(state.hiddenUserTopics || {}) };
    const existing = new Set(normalizeTagList(map[userKey] || []));
    existing.add(tag);
    map[userKey] = Array.from(existing);
    state.hiddenUserTopics = map;
    persistTopicFilters();
    updateIdentityText();
  }
}

function applyTagFilter(posts, selectedTag) {
  const tag = String(selectedTag || "").trim().toLowerCase();
  const list = Array.isArray(posts) ? posts : [];
  if (!tag) return list;
  return list.filter((post) => (Array.isArray(post?.tags) ? post.tags : []).some((t) => String(t || "").trim().toLowerCase() === tag));
}

function filterVisibleTags(tags, userKey) {
  const allHidden = new Set(normalizeTagList(state.hiddenTopicsAll || []));
  const perUser = new Set(normalizeTagList((state.hiddenUserTopics || {})[String(userKey || "").trim()] || []));
  return normalizeTagList(tags || []).filter((tag) => !allHidden.has(tag) && !perUser.has(tag));
}

function applyVisibilityFilters(posts) {
  const list = Array.isArray(posts) ? posts : [];
  const allHidden = new Set(normalizeTagList(state.hiddenTopicsAll || []));
  const perUserMap = state.hiddenUserTopics || {};
  return list.filter((post) => {
    const tags = normalizeTagList(Array.isArray(post?.tags) ? post.tags : []);
    if (tags.some((t) => allHidden.has(t))) return false;
    const userKey = String(post?.userDid || "").trim();
    if (!userKey) return true;
    const hiddenForUser = new Set(normalizeTagList(perUserMap[userKey] || []));
    if (!hiddenForUser.size) return true;
    return !tags.some((t) => hiddenForUser.has(t));
  });
}

async function loadAllPublicPosts() {
  const viewer = activeViewer();
  const localParams = new URLSearchParams({ limit: "250" });
  if (viewer?.userDid) localParams.set("viewerDid", viewer.userDid);
  localParams.set("viewerRole", viewer?.role === "child" ? "child" : "adult");
  const localResp = await fetch(`/api/chirpspace?${localParams.toString()}`);
  const localData = await localResp.json();
  if (!localResp.ok || !localData?.ok) {
    throw new Error(localData?.error || "local ChirpSpace load failed");
  }
  const merged = [];
  const localPosts = Array.isArray(localData.posts) ? localData.posts : [];
  merged.push(...localPosts);

  const bases = Array.from(new Set(
    state.radarCandidates
      .filter((x) => x.source !== "self")
      .map((x) => String(x.httpBase || "").trim())
      .filter(Boolean)
  ));
  const remoteResults = await Promise.all(
    bases.map(async (base) => {
      try {
        const params = new URLSearchParams({ base, limit: "160" });
        const resp = await fetch(`/api/chirpspace/remote?${params.toString()}`);
        const data = await resp.json();
        if (!resp.ok || !data?.ok) return [];
        return Array.isArray(data.posts) ? data.posts : [];
      } catch (_error) {
        return [];
      }
    })
  );
  remoteResults.forEach((rows) => merged.push(...rows));
  return merged.sort((a, b) => String(b?.createdAt || "").localeCompare(String(a?.createdAt || "")));
}

function loadTopicFilters() {
  try {
    const raw = localStorage.getItem("chirpyTopicFilters");
    const parsed = raw ? JSON.parse(raw) : {};
    state.hiddenTopicsAll = normalizeTagList(parsed?.hiddenTopicsAll || []);
    state.hiddenUserTopics = parsed?.hiddenUserTopics && typeof parsed.hiddenUserTopics === "object"
      ? Object.fromEntries(
          Object.entries(parsed.hiddenUserTopics).map(([key, value]) => [String(key), normalizeTagList(value || [])])
        )
      : {};
  } catch (_error) {
    state.hiddenTopicsAll = [];
    state.hiddenUserTopics = {};
  }
}

function persistTopicFilters() {
  try {
    localStorage.setItem("chirpyTopicFilters", JSON.stringify({
      hiddenTopicsAll: normalizeTagList(state.hiddenTopicsAll || []),
      hiddenUserTopics: state.hiddenUserTopics || {}
    }));
  } catch (_error) {
    // ignore
  }
}

async function renderPosts(posts) {
  const viewer = activeViewer();
  els.chirpspaceFeed.innerHTML = "";
  if (!posts.length) {
    els.chirpspaceFeed.innerHTML = '<div class="empty-state">No posts yet for this identity and role view.</div>';
    return;
  }

  for (const post of posts) {
    const node = els.postTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".post-date").textContent = toDate(post.createdAt);
    node.querySelector(".post-visibility").textContent = (post.visibility || "public").toUpperCase();
    node.querySelector(".post-tags").textContent = (post.tags || []).join(", ");
    const textNode = node.querySelector(".post-text");

    let decryptedPost = null;
    if (post.encryption?.enabled) {
      try {
        decryptedPost = await decryptPostBundle(post, viewer);
      } catch (error) {
        textNode.textContent = `Encrypted post (unable to decrypt: ${error.message})`;
      }
    }

    if (!textNode.textContent) {
      textNode.textContent = decryptedPost?.text || post.text || "";
    }
    if (decryptedPost?.tags?.length) {
      node.querySelector(".post-tags").textContent = decryptedPost.tags.join(", ");
    }

    const promoteBtn = node.querySelector(".promote-btn");
    const canPromote = viewer?.role !== "child" && post.visibility === "family" && post.authorRole === "child";
    if (canPromote) {
      promoteBtn.classList.remove("hidden");
      promoteBtn.addEventListener("click", () => makePublic(post.stageId, viewer));
    }

    const photosWrap = node.querySelector(".post-photos");
    const videosWrap = node.querySelector(".post-videos");
    const linksWrap = node.querySelector(".post-links");
    const root = `/staged/${post.stageId}`;

    for (const photo of post.assets?.photos || []) {
      const img = document.createElement("img");
      try {
        if (post.encryption?.enabled && decryptedPost?.files?.[photo.framed]) {
          img.src = decryptedPost.files[photo.framed];
        } else if (!post.encryption?.enabled) {
          img.src = `${root}/${photo.framed}`;
        }
      } catch (_error) {
        // ignore
      }
      if (img.src) photosWrap.appendChild(img);
    }

    for (const vid of post.assets?.videos || []) {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      if (post.encryption?.enabled) {
        if (decryptedPost?.files?.[vid.source]) {
          video.src = decryptedPost.files[vid.source];
        }
      } else {
        video.poster = `${root}/${vid.previewGif}`;
        video.src = `${root}/${vid.source}`;
      }
      if (video.src) videosWrap.appendChild(video);
    }

    const linkData = decryptedPost?.links || post.assets?.links || [];
    for (const link of linkData) {
      const card = document.createElement("article");
      card.className = "post-link-card";
      const title = escapeHtml(link.title || link.url || "link");
      const desc = escapeHtml(link.description || "");
      const href = escapeHtml(link.url || "#");
      card.innerHTML = `<a href="${href}" target="_blank" rel="noreferrer">${title}</a><div class="sub small">${desc}</div>`;
      linksWrap.appendChild(card);
    }

    els.chirpspaceFeed.appendChild(node);
  }
}

async function decryptPostBundle(post, viewer) {
  if (!viewer?.userDid || !viewer?.encryptionPrivateJwk) {
    throw new Error("missing viewer encryption key");
  }
  const recipients = post.encryption?.recipients || [];
  const target = recipients.find((x) => x.did === viewer.userDid);
  if (!target?.wrappedDek) {
    throw new Error("viewer not authorized");
  }

  const dek = await unwrapDek(target.wrappedDek, viewer.encryptionPrivateJwk);
  const files = {};
  const fileMap = post.encryption.files || {};
  const postJson = await decryptFile(post.stageId, "post.json", fileMap["post.json"], dek);
  const postObj = JSON.parse(new TextDecoder().decode(postJson));

  for (const photo of post.assets?.photos || []) {
    const info = fileMap[photo.framed];
    if (!info) continue;
    const bytes = await decryptFile(post.stageId, photo.framed, info, dek);
    files[photo.framed] = URL.createObjectURL(new Blob([bytes], { type: info.mime || "image/webp" }));
  }
  for (const video of post.assets?.videos || []) {
    const info = fileMap[video.source];
    if (!info) continue;
    const bytes = await decryptFile(post.stageId, video.source, info, dek);
    files[video.source] = URL.createObjectURL(new Blob([bytes], { type: info.mime || "video/mp4" }));
  }

  return {
    text: postObj.text || "",
    tags: postObj.tags || [],
    links: postObj.links || [],
    files
  };
}

async function unwrapDek(wrappedDekB64, privateJwk) {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"]
  );
  const wrapped = base64ToBytes(wrappedDekB64);
  const plain = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrapped);
  return new Uint8Array(plain);
}

async function decryptFile(stageId, relPath, info, dekBytes) {
  const resp = await fetch(`/staged/${stageId}/${info.encPath}`);
  if (!resp.ok) throw new Error(`encrypted asset missing: ${info.encPath}`);
  const ciphertext = new Uint8Array(await resp.arrayBuffer());
  const key = await crypto.subtle.importKey("raw", dekBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = base64ToBytes(info.iv);
  const tag = base64ToBytes(info.tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(info.aad || relPath), tagLength: 128 },
    key,
    combined
  );
  return new Uint8Array(plain);
}

async function makePublic(stageId, viewer) {
  try {
    const resp = await fetch(`/api/chirpspace/${encodeURIComponent(stageId)}/make-public`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        moderatorDid: viewer.userDid,
        moderatorRole: viewer.role
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "promotion failed");
    await loadChirpSpace();
    await loadRadar();
  } catch (error) {
    alert(`Could not make post public: ${error.message}`);
  }
}

function base64ToBytes(value) {
  const raw = atob(String(value || ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function toDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
