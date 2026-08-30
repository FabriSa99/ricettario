// ---------- Storage (local cache) ----------
const STORAGE_KEY = "ricettario:recipes";

function loadRecipes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveRecipes(recipes) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
}

// ---------- Sync (GitHub Gist as shared "folder of .txt files") ----------
const SYNC_TOKEN_KEY = "ricettario:gh-token";
const SYNC_GISTID_KEY = "ricettario:gh-gistid";
const GIST_INFO_FILENAME = "_ricettario-info.txt";

function getSyncConfig() {
  return {
    token: localStorage.getItem(SYNC_TOKEN_KEY) || "",
    gistId: localStorage.getItem(SYNC_GISTID_KEY) || "",
  };
}

function isSyncConfigured() {
  const { token, gistId } = getSyncConfig();
  return !!(token && gistId);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

function setSyncStatus(state, message) {
  const btn = document.getElementById("open-sync-btn");
  const line = document.getElementById("sync-status-line");
  btn.classList.remove("syncing", "ok", "error");
  if (state) btn.classList.add(state);
  line.textContent = message || "";
}

// Pulls all recipes from the Gist and replaces the local cache.
async function pullFromGist({ silent } = {}) {
  const { token, gistId } = getSyncConfig();
  if (!token || !gistId) return { ok: false, reason: "not-configured" };
  if (!silent) setSyncStatus("syncing", "Sincronizzazione in corso…");
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) {
      const msg = res.status === 401 ? "Token non valido." : res.status === 404 ? "Gist non trovato." : `Errore GitHub (${res.status}).`;
      setSyncStatus("error", msg);
      return { ok: false, reason: msg };
    }
    const data = await res.json();
    const files = data.files || {};
    const pulled = [];
    for (const filename of Object.keys(files)) {
      if (!filename.startsWith("recipe-") || !filename.endsWith(".txt")) continue;
      const file = files[filename];
      let content = file.content;
      // Gist truncates very large files; fetch raw_url if needed
      if (file.truncated && file.raw_url) {
        const raw = await fetch(file.raw_url);
        content = await raw.text();
      }
      try {
        const recipe = JSON.parse(content);
        pulled.push(recipe);
      } catch (e) { /* skip unparsable file */ }
    }
    pulled.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    recipes = pulled;
    saveRecipes(recipes);
    setSyncStatus("ok", `Sincronizzato — ${new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`);
    return { ok: true };
  } catch (e) {
    setSyncStatus("error", "Sincronizzazione fallita: controlla la connessione.");
    return { ok: false, reason: "network" };
  }
}

// Pushes a single recipe (create/update) to the Gist.
async function pushRecipeToGist(recipe) {
  const { token, gistId } = getSyncConfig();
  if (!token || !gistId) return;
  setSyncStatus("syncing", "Salvataggio sul Gist…");
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "PATCH",
      headers: ghHeaders(token),
      body: JSON.stringify({
        files: { [`recipe-${recipe.id}.txt`]: { content: JSON.stringify(recipe, null, 2) } },
      }),
    });
    if (!res.ok) {
      setSyncStatus("error", "Non sono riuscito a salvare sul Gist.");
      return;
    }
    setSyncStatus("ok", `Sincronizzato — ${new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (e) {
    setSyncStatus("error", "Salvataggio sul Gist fallito: controlla la connessione.");
  }
}

// Removes a recipe's file from the Gist.
async function deleteRecipeFromGist(id) {
  const { token, gistId } = getSyncConfig();
  if (!token || !gistId) return;
  try {
    await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "PATCH",
      headers: ghHeaders(token),
      body: JSON.stringify({ files: { [`recipe-${id}.txt`]: null } }),
    });
    setSyncStatus("ok", `Sincronizzato — ${new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (e) {
    setSyncStatus("error", "Eliminazione sul Gist fallita.");
  }
}

async function createNewGist(token) {
  const res = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({
      description: "Ricettario — dati sincronizzati (non modificare i nomi dei file)",
      public: false,
      files: {
        [GIST_INFO_FILENAME]: {
          content: "Questo Gist contiene le ricette del tuo Ricettario.\nOgni ricetta è un file recipe-<id>.txt in formato JSON.\nNon rinominare o modificare manualmente questo file.",
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Errore ${res.status}`);
  const data = await res.json();
  return data.id;
}

// ---------- State ----------
let recipes = loadRecipes();
let pantry = [];
let query = "";
let sortByMatch = false;
let currentView = { mode: "list" }; // list | form | detail
let editingId = null; // id of recipe being edited, or null for new

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalize(s) {
  return (s || "").toLowerCase().trim();
}

// ---------- Matching ----------
function matchScore(recipe, pantryList) {
  if (!pantryList.length || !recipe.ingredients.length) return null;
  const pantrySet = pantryList.map(normalize);
  const have = recipe.ingredients.filter((ing) =>
    pantrySet.some((p) => normalize(ing.name).includes(p) || p.includes(normalize(ing.name)))
  );
  const missing = recipe.ingredients.filter((ing) => !have.includes(ing));
  return {
    have: have.length,
    total: recipe.ingredients.length,
    pct: Math.round((have.length / recipe.ingredients.length) * 100),
    missing,
  };
}

function tiltFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ((h % 240) / 100 - 1.2).toFixed(2);
}

function matchRingSVG(pct) {
  const r = 15, c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  const color = pct === 100 ? "var(--sage)" : pct >= 50 ? "var(--mustard)" : "var(--rust)";
  return `
    <svg class="match-ring" width="38" height="38" viewBox="0 0 38 38">
      <circle cx="19" cy="19" r="${r}" fill="none" stroke="var(--line)" stroke-width="4" />
      <circle cx="19" cy="19" r="${r}" fill="none" stroke="${color}" stroke-width="4"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 19 19)" />
      <text x="19" y="23" text-anchor="middle" font-size="10" fill="var(--ink)">${pct}</text>
    </svg>`;
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------- Views ----------
const viewList = document.getElementById("view-list");
const viewForm = document.getElementById("view-form");
const viewDetail = document.getElementById("view-detail");
const viewSync = document.getElementById("view-sync");

function showView(mode) {
  currentView.mode = mode;
  viewList.classList.toggle("hidden", mode !== "list");
  viewForm.classList.toggle("hidden", mode !== "form");
  viewDetail.classList.toggle("hidden", mode !== "detail");
  viewSync.classList.toggle("hidden", mode !== "sync");
  window.scrollTo({ top: 0, behavior: "instant" });
}

// ---------- List rendering ----------
function getFilteredRecipes() {
  let list = recipes;
  const q = normalize(query);
  if (q) {
    list = list.filter(
      (r) =>
        normalize(r.title).includes(q) ||
        (r.tags || []).some((t) => normalize(t).includes(q)) ||
        r.ingredients.some((i) => normalize(i.name).includes(q))
    );
  }
  if (sortByMatch && pantry.length) {
    list = [...list].sort((a, b) => {
      const sa = matchScore(a, pantry)?.pct ?? -1;
      const sb = matchScore(b, pantry)?.pct ?? -1;
      return sb - sa;
    });
  }
  return list;
}

function renderList() {
  document.getElementById("recipe-count").textContent =
    `${recipes.length} ricett${recipes.length === 1 ? "a" : "e"} salvat${recipes.length === 1 ? "a" : "e"}`;

  const sortLabel = document.getElementById("pantry-sort-label");
  sortLabel.classList.toggle("hidden", pantry.length === 0);

  const container = document.getElementById("list-content");
  const filtered = getFilteredRecipes();

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>${recipes.length === 0 ? "Il tuo ricettario è vuoto" : "Nessuna ricetta trovata"}</h3>
        <p>${recipes.length === 0
          ? "Tocca il pulsante + per aggiungere la tua prima ricetta."
          : "Prova a modificare la ricerca o gli ingredienti in dispensa."}</p>
      </div>`;
    return;
  }

  const cards = filtered.map((r) => {
    const score = matchScore(r, pantry);
    const tilt = tiltFor(r.id);
    const preview = r.ingredients.slice(0, 3).map((i) => escapeHtml(i.name)).filter(Boolean).join(" · ");
    const missing = score && score.missing.length > 0
      ? `<div class="idx-missing">Mancano: ${score.missing.map((m) => escapeHtml(m.name)).join(", ")}</div>`
      : "";
    return `
      <button class="idx-card" style="transform: rotate(${tilt}deg)" data-open="${r.id}">
        <div class="idx-hole"></div>
        <div class="idx-perf"></div>
        <div class="idx-card-inner">
          <div class="idx-card-top">
            <span class="idx-cat">${escapeHtml(r.category)}</span>
            ${score ? matchRingSVG(score.pct) : ""}
          </div>
          <h3 class="idx-title">${escapeHtml(r.title) || "Senza titolo"}</h3>
          <div class="idx-meta">
            ${r.time ? `<span class="idx-meta-item">⏱ ${escapeHtml(r.time)}</span>` : ""}
            <span class="idx-meta-item">👤 ${r.servings}</span>
          </div>
          <div class="idx-ing-preview">${preview}${r.ingredients.length > 3 ? " ·…" : ""}</div>
          ${missing}
        </div>
      </button>`;
  }).join("");

  container.innerHTML = `
    <div class="grid-header"><h2>Le tue ricette</h2></div>
    <div class="recipe-grid">${cards}</div>`;

  container.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("mouseenter", () => (btn.style.transform = "rotate(0deg) translateY(-3px)"));
    btn.addEventListener("mouseleave", () => {
      const id = btn.getAttribute("data-open");
      btn.style.transform = `rotate(${tiltFor(id)}deg)`;
    });
    btn.addEventListener("click", () => openDetail(btn.getAttribute("data-open")));
  });
}

function renderPantryChips() {
  const container = document.getElementById("pantry-chips");
  container.innerHTML = pantry.map((p) => `
    <span class="pantry-chip">
      ${escapeHtml(p)}
      <button data-remove-pantry="${escapeHtml(p)}" aria-label="Rimuovi ${escapeHtml(p)}">✕</button>
    </span>`).join("");
  container.querySelectorAll("[data-remove-pantry]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pantry = pantry.filter((p) => p !== btn.getAttribute("data-remove-pantry"));
      renderPantryChips();
      renderList();
    });
  });
}

// ---------- Detail rendering ----------
function openDetail(id) {
  editingId = id;
  showView("detail");
  renderDetail(id);
}

function renderDetail(id) {
  const recipe = recipes.find((r) => r.id === id);
  if (!recipe) { showView("list"); return; }
  const score = matchScore(recipe, pantry);
  const pantrySet = pantry.map(normalize);

  const tagsHtml = (recipe.tags || []).length
    ? `<div class="tag-list" style="margin-top:10px">${recipe.tags.map((t) => `<span class="tag-chip static">${escapeHtml(t)}</span>`).join("")}</div>`
    : "";

  const ingredientsHtml = recipe.ingredients.map((ing) => {
    const inPantry = pantrySet.some((p) => normalize(ing.name).includes(p) || p.includes(normalize(ing.name)));
    return `
      <li data-ing-id="${ing.id}">
        <button class="checkbox ${inPantry ? "have" : ""}" data-toggle-check="${ing.id}"></button>
        <span class="ing-qty">${escapeHtml(ing.qty)}</span>
        <span>${escapeHtml(ing.name)}</span>
      </li>`;
  }).join("");

  const stepsHtml = recipe.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("");

  document.getElementById("detail-content").innerHTML = `
    <span class="idx-cat">${escapeHtml(recipe.category)}</span>
    <h1 class="detail-title">${escapeHtml(recipe.title)}</h1>
    <div class="idx-meta detail-meta">
      ${recipe.time ? `<span class="idx-meta-item">⏱ ${escapeHtml(recipe.time)}</span>` : ""}
      <span class="idx-meta-item">👤 ${recipe.servings} porzioni</span>
      ${score ? `<span class="idx-meta-item">🧺 ${score.have}/${score.total} in dispensa</span>` : ""}
    </div>
    ${tagsHtml}
    <div class="detail-columns">
      <div class="detail-col">
        <h4 class="detail-h4">Ingredienti</h4>
        <ul class="ing-checklist">${ingredientsHtml}</ul>
      </div>
      <div class="detail-col steps-col">
        <h4 class="detail-h4">Procedimento</h4>
        <ol class="step-list">${stepsHtml}</ol>
      </div>
    </div>`;

  document.querySelectorAll("[data-toggle-check]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("checked-off");
      const li = btn.closest("li");
      li.classList.toggle("done");
      btn.innerHTML = li.classList.contains("done")
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
        : "";
    });
  });
}

function deleteCurrentRecipe() {
  if (!editingId) return;
  if (!confirm("Eliminare questa ricetta? L'operazione non si può annullare.")) return;
  const idToDelete = editingId;
  recipes = recipes.filter((r) => r.id !== idToDelete);
  saveRecipes(recipes);
  showView("list");
  renderList();
  if (isSyncConfigured()) deleteRecipeFromGist(idToDelete);
}

// ---------- Form rendering ----------
const ingredientsListEl = document.getElementById("ingredients-list");
const stepsListEl = document.getElementById("steps-list");
const tagsListEl = document.getElementById("tags-list");
let formTags = [];

function createIngredientRow(qty = "", name = "") {
  const row = document.createElement("div");
  row.className = "ing-row";
  row.innerHTML = `
    <input class="input input-mono" placeholder="quantità" value="${escapeHtml(qty)}" data-field="qty" />
    <input class="input" placeholder="Ingrediente" value="${escapeHtml(name)}" data-field="name" />
    <button class="icon-btn subtle" type="button" aria-label="Rimuovi ingrediente">✕</button>
  `;
  row.querySelector("button").addEventListener("click", () => {
    row.remove();
    validateForm();
  });
  row.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", validateForm));
  return row;
}

function createStepRow(text = "", index) {
  const row = document.createElement("div");
  row.className = "step-row";
  row.innerHTML = `
    <span class="step-num">${index}</span>
    <textarea class="input textarea" rows="2" placeholder="Descrivi il passaggio…" data-field="step">${escapeHtml(text)}</textarea>
    <button class="icon-btn subtle" type="button" aria-label="Rimuovi passaggio">✕</button>
  `;
  row.querySelector("button").addEventListener("click", () => {
    row.remove();
    renumberSteps();
  });
  return row;
}

function renumberSteps() {
  stepsListEl.querySelectorAll(".step-row").forEach((row, i) => {
    row.querySelector(".step-num").textContent = i + 1;
  });
}

function createTagChip(text) {
  const chip = document.createElement("span");
  chip.className = "tag-chip";
  chip.innerHTML = `${escapeHtml(text)} <button type="button" aria-label="Rimuovi tag ${escapeHtml(text)}">✕</button>`;
  chip.querySelector("button").addEventListener("click", () => {
    formTags = formTags.filter((t) => t !== text);
    chip.remove();
  });
  return chip;
}

function validateForm() {
  const title = document.getElementById("form-title").value.trim();
  const hasIngredient = Array.from(ingredientsListEl.querySelectorAll('[data-field="name"]'))
    .some((inp) => inp.value.trim());
  document.getElementById("form-save-btn").disabled = !(title && hasIngredient);
}

function resetForm(recipe) {
  const isEdit = !!recipe;
  editingId = isEdit ? recipe.id : null;
  document.getElementById("form-title-label").textContent = isEdit ? "Modifica ricetta" : "Nuova ricetta";
  document.getElementById("form-title").value = isEdit ? recipe.title : "";
  document.getElementById("form-category").value = isEdit ? recipe.category : "Primo";
  document.getElementById("form-servings").value = isEdit ? recipe.servings : 4;
  document.getElementById("form-time").value = isEdit ? recipe.time : "";

  ingredientsListEl.innerHTML = "";
  const ings = isEdit && recipe.ingredients.length ? recipe.ingredients : [{ qty: "", name: "" }];
  ings.forEach((ing) => ingredientsListEl.appendChild(createIngredientRow(ing.qty, ing.name)));

  stepsListEl.innerHTML = "";
  const steps = isEdit && recipe.steps.length ? recipe.steps : [""];
  steps.forEach((s, i) => stepsListEl.appendChild(createStepRow(s, i + 1)));

  formTags = isEdit ? [...(recipe.tags || [])] : [];
  tagsListEl.innerHTML = "";
  formTags.forEach((t) => tagsListEl.appendChild(createTagChip(t)));

  document.getElementById("tag-input").value = "";
  validateForm();
}

function openForm(recipe) {
  resetForm(recipe);
  showView("form");
}

function collectFormData() {
  const ingredients = Array.from(ingredientsListEl.querySelectorAll(".ing-row")).map((row) => ({
    id: row.dataset.id || uid(),
    qty: row.querySelector('[data-field="qty"]').value.trim(),
    name: row.querySelector('[data-field="name"]').value.trim(),
  })).filter((i) => i.name);

  const steps = Array.from(stepsListEl.querySelectorAll('[data-field="step"]'))
    .map((t) => t.value.trim())
    .filter(Boolean);

  return {
    id: editingId || uid(),
    title: document.getElementById("form-title").value.trim(),
    category: document.getElementById("form-category").value,
    servings: parseInt(document.getElementById("form-servings").value) || 1,
    time: document.getElementById("form-time").value.trim(),
    tags: [...formTags],
    ingredients,
    steps,
    createdAt: Date.now(),
  };
}

function saveForm() {
  const data = collectFormData();
  const exists = recipes.some((r) => r.id === data.id);
  recipes = exists ? recipes.map((r) => (r.id === data.id ? data : r)) : [data, ...recipes];
  saveRecipes(recipes);
  editingId = data.id;
  showView("detail");
  renderDetail(data.id);
  renderList();
  if (isSyncConfigured()) pushRecipeToGist(data);
}

// ---------- Event wiring ----------
document.getElementById("search-input").addEventListener("input", (e) => {
  query = e.target.value;
  renderList();
});

document.getElementById("pantry-add-btn").addEventListener("click", addPantryItem);
document.getElementById("pantry-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addPantryItem(); }
});
function addPantryItem() {
  const input = document.getElementById("pantry-input");
  const v = input.value.trim();
  if (v && !pantry.some((p) => normalize(p) === normalize(v))) pantry.push(v);
  input.value = "";
  renderPantryChips();
  renderList();
}

document.getElementById("pantry-sort-toggle").addEventListener("change", (e) => {
  sortByMatch = e.target.checked;
  renderList();
});

document.getElementById("fab-new").addEventListener("click", () => openForm(null));
document.getElementById("form-back-btn").addEventListener("click", () => showView(editingId ? "detail" : "list"));
document.getElementById("form-cancel-btn").addEventListener("click", () => {
  if (editingId && recipes.some(r => r.id === editingId)) {
    showView("detail");
    renderDetail(editingId);
  } else {
    showView("list");
  }
});
document.getElementById("form-save-btn").addEventListener("click", saveForm);
document.getElementById("form-title").addEventListener("input", validateForm);

document.getElementById("add-ingredient-btn").addEventListener("click", () => {
  ingredientsListEl.appendChild(createIngredientRow());
  validateForm();
});
document.getElementById("add-step-btn").addEventListener("click", () => {
  stepsListEl.appendChild(createStepRow("", stepsListEl.children.length + 1));
});
document.getElementById("add-tag-btn").addEventListener("click", addTagFromInput);
document.getElementById("tag-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addTagFromInput(); }
});
function addTagFromInput() {
  const input = document.getElementById("tag-input");
  const v = normalize(input.value);
  if (v && !formTags.includes(v)) {
    formTags.push(v);
    tagsListEl.appendChild(createTagChip(v));
  }
  input.value = "";
}

document.getElementById("detail-back-btn").addEventListener("click", () => { showView("list"); renderList(); });
document.getElementById("detail-edit-btn").addEventListener("click", () => {
  const recipe = recipes.find((r) => r.id === editingId);
  if (recipe) openForm(recipe);
});
document.getElementById("detail-delete-btn").addEventListener("click", deleteCurrentRecipe);

// ---------- Sync panel wiring ----------
function openSyncPanel() {
  const { token, gistId } = getSyncConfig();
  document.getElementById("sync-token").value = token;
  document.getElementById("sync-gistid").value = gistId;
  document.getElementById("sync-feedback").textContent = "";
  document.getElementById("sync-feedback").className = "sync-feedback";
  showView("sync");
}

document.getElementById("open-sync-btn").addEventListener("click", openSyncPanel);
document.getElementById("sync-back-btn").addEventListener("click", () => { showView("list"); renderList(); });

document.getElementById("sync-save-btn").addEventListener("click", async () => {
  const token = document.getElementById("sync-token").value.trim();
  const gistId = document.getElementById("sync-gistid").value.trim();
  const feedback = document.getElementById("sync-feedback");
  if (!token || !gistId) {
    feedback.textContent = "Inserisci sia il token che l'ID del Gist, oppure crea un nuovo Gist qui sotto.";
    feedback.className = "sync-feedback error";
    return;
  }
  localStorage.setItem(SYNC_TOKEN_KEY, token);
  localStorage.setItem(SYNC_GISTID_KEY, gistId);
  feedback.textContent = "Connessione in corso…";
  feedback.className = "sync-feedback";
  const result = await pullFromGist();
  if (result.ok) {
    feedback.textContent = "Connesso e sincronizzato! Inserisci lo stesso token e ID su ogni dispositivo.";
    feedback.className = "sync-feedback ok";
    renderList();
  } else {
    feedback.textContent = "Non sono riuscito a connettermi: " + (result.reason || "controlla i dati inseriti.");
    feedback.className = "sync-feedback error";
  }
});

document.getElementById("sync-create-btn").addEventListener("click", async () => {
  const token = document.getElementById("sync-token").value.trim();
  const feedback = document.getElementById("sync-feedback");
  if (!token) {
    feedback.textContent = "Inserisci prima il token GitHub, poi crea il Gist.";
    feedback.className = "sync-feedback error";
    return;
  }
  feedback.textContent = "Creazione del Gist in corso…";
  feedback.className = "sync-feedback";
  try {
    const gistId = await createNewGist(token);
    document.getElementById("sync-gistid").value = gistId;
    localStorage.setItem(SYNC_TOKEN_KEY, token);
    localStorage.setItem(SYNC_GISTID_KEY, gistId);
    feedback.textContent = `Gist creato! ID: ${gistId} — copialo anche sugli altri dispositivi.`;
    feedback.className = "sync-feedback ok";
    // Push any existing local recipes into the freshly created gist
    for (const r of recipes) await pushRecipeToGist(r);
  } catch (e) {
    feedback.textContent = "Creazione fallita: verifica che il token abbia il permesso \"gist\".";
    feedback.className = "sync-feedback error";
  }
});

document.getElementById("sync-disconnect-btn").addEventListener("click", () => {
  if (!confirm("Disconnettere questo dispositivo? Le ricette resteranno salvate qui, ma non si sincronizzeranno più finché non reinserisci token e Gist.")) return;
  localStorage.removeItem(SYNC_TOKEN_KEY);
  localStorage.removeItem(SYNC_GISTID_KEY);
  document.getElementById("sync-token").value = "";
  document.getElementById("sync-gistid").value = "";
  setSyncStatus(null, "");
  const feedback = document.getElementById("sync-feedback");
  feedback.textContent = "Dispositivo disconnesso.";
  feedback.className = "sync-feedback";
});

// ---------- Init ----------
renderList();
renderPantryChips();
showView("list");

function refreshCurrentView() {
  if (currentView.mode === "list") {
    renderList();
  } else if (currentView.mode === "detail") {
    if (recipes.some((r) => r.id === editingId)) {
      renderDetail(editingId);
    } else {
      // recipe was deleted from another device
      showView("list");
      renderList();
    }
  }
  // never touch the form while the user is actively editing
}

function autoPullIfSafe() {
  if (!isSyncConfigured()) return;
  if (currentView.mode === "form" || currentView.mode === "sync") return;
  pullFromGist({ silent: true }).then(refreshCurrentView);
}

if (isSyncConfigured()) {
  pullFromGist().then(() => renderList());
}

// Re-sync whenever the app regains focus or comes back to the foreground
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") autoPullIfSafe();
});
window.addEventListener("focus", autoPullIfSafe);

// Poll periodically while the app stays open, in case another device
// makes a change without this device ever losing focus
setInterval(autoPullIfSafe, 45000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
