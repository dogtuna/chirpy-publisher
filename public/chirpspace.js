const els = {
  refreshChirpSpace: document.getElementById("refreshChirpSpace"),
  chirpspaceIdentity: document.getElementById("chirpspaceIdentity"),
  chirpspaceFeed: document.getElementById("chirpspaceFeed"),
  viewerProfile: document.getElementById("viewerProfile"),
  authorProfile: document.getElementById("authorProfile"),
  postTemplate: document.getElementById("postTemplate")
};

const state = {
  profiles: [],
  viewerProfileId: "",
  authorProfileId: ""
};

boot();

function boot() {
  loadProfiles();
  bindControls();
  renderProfileSelectors();
  loadChirpSpace();
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
  els.refreshChirpSpace.addEventListener("click", loadChirpSpace);
  els.viewerProfile.addEventListener("change", () => {
    state.viewerProfileId = els.viewerProfile.value;
    updateIdentityText();
    loadChirpSpace();
  });
  els.authorProfile.addEventListener("change", () => {
    state.authorProfileId = els.authorProfile.value;
    loadChirpSpace();
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
  els.chirpspaceIdentity.textContent = `Viewing as ${viewer.name} (${viewer.role || "adult"}) | Feed: ${author?.name || "unknown"}`;
}

async function loadChirpSpace() {
  const viewer = activeViewer();
  const author = activeAuthor();
  try {
    const params = new URLSearchParams({ limit: "100" });
    if (author?.userDid) params.set("authorDid", author.userDid);
    if (viewer?.userDid) params.set("viewerDid", viewer.userDid);
    params.set("viewerRole", viewer?.role === "child" ? "child" : "adult");
    const resp = await fetch(`/api/chirpspace?${params.toString()}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "ChirpSpace load failed");
    await renderPosts(data.posts || []);
  } catch (error) {
    els.chirpspaceFeed.innerHTML = `<div class="empty-state">Failed to load ChirpSpace: ${escapeHtml(error.message)}</div>`;
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
    loadChirpSpace();
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
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
