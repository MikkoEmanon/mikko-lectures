const SUPABASE_URL = "https://ogcvbjazozbiuyixywks.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nY3ZiamF6b3piaXV5aXh5d2tzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxMDM4MDcsImV4cCI6MjA4MjY3OTgwN30.WLTckFDka2FxrSCXRizgAKUO51cUDMXEpdVw_K5R8cE";
const COURSE_DIR = "courses"; // course content lives in courses/<course-id>.json

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ------------------------------------------------------------------ *
 * STATE + DOM
 * ------------------------------------------------------------------ */
let courses = [];              // [{id, title, description}]
const unlocked = new Set();    // course ids this session can open
let loaded = null;             // {id, title, sections}
let pendingCourse = null;      // course shown in the passcode modal
let routeSeq = 0;              // guards against out-of-order async routes

const courseListEl = document.getElementById("course-list");
const courseViewer = document.getElementById("course-viewer");
const courseSelection = document.getElementById("course-selection");
const backBtn = document.getElementById("back-btn");
const contentArea = document.getElementById("content-area");
const accordion = document.getElementById("accordion");
const courseTitleEl = document.getElementById("course-title");

const modal = document.getElementById("passcode-modal");
const modalTitle = document.getElementById("modal-course-title");
const passcodeInput = document.getElementById("passcode-input");
const submitBtn = document.getElementById("submit-passcode");
const cancelBtn = document.getElementById("cancel-btn");
const errorMsg = document.getElementById("error-msg");

const IMG_FALLBACK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">' +
      '<rect width="100%" height="100%" fill="#ddd"/>' +
      '<text x="50%" y="50%" font-size="18" text-anchor="middle" dy=".3em" fill="#888">Image not available</text>' +
      "</svg>"
  );

function makeClickable(el, fn) {
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.addEventListener("click", fn);
  el.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn(e);
    }
  });
}

/* ------------------------------------------------------------------ *
 * THEME HANDLING
 * ------------------------------------------------------------------ */
const THEME_KEY = "mikko-theme"; // "light" | "dark" | null (follow OS)

function applyTheme(theme) {
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  updateThemeToggleIcon();
}

function getEffectiveTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeToggleIcon() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const icon = btn.querySelector("i");
  const dark = getEffectiveTheme() === "dark";
  if (icon) icon.className = dark ? "fas fa-sun" : "fas fa-moon";
  btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  btn.title = btn.getAttribute("aria-label");
}

function readSavedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function initTheme() {
  applyTheme(readSavedTheme()); // null → follow OS
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!readSavedTheme()) applyTheme(null);
  });
}

function toggleTheme() {
  const next = getEffectiveTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  applyTheme(next);
}

function injectThemeToggle() {
  const footerInner = document.querySelector(".footer-inner");
  if (!footerInner) return;

  const sep = document.createElement("span");
  sep.className = "footer-separator";
  sep.textContent = "•";

  const wrap = document.createElement("span");
  wrap.className = "footer-item";

  const btn = document.createElement("button");
  btn.id = "theme-toggle";
  btn.type = "button";
  btn.className = "theme-toggle-btn";
  btn.innerHTML = '<i class="fas fa-moon"></i>';
  btn.onclick = toggleTheme;

  wrap.appendChild(btn);
  footerInner.appendChild(sep);
  footerInner.appendChild(wrap);
  updateThemeToggleIcon();
}

/* ------------------------------------------------------------------ *
 * SUPABASE: SESSION + COURSE LIST
 * ------------------------------------------------------------------ */
function assertConfigured() {
  if (/YOUR-/.test(SUPABASE_URL) || /YOUR-/.test(SUPABASE_ANON_KEY)) {
    throw new Error("Supabase URL / anon key are still placeholders in script.js");
  }
}

async function ensureSession() {
  assertConfigured();
  const { data: { session } } = await sb.auth.getSession();
  if (session) return session;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

function setListStatus(msg) {
  courseListEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "status";
  p.textContent = msg;
  courseListEl.appendChild(p);
}

async function loadCourses() {
  setListStatus("Loading courses…");
  try {
    await ensureSession();
    const [coursesRes, accessRes] = await Promise.all([
      sb.from("lms_courses")
        .select("id,title,description")
        .eq("published", true)
        .order("sort_order")
        .order("title"),
      sb.from("lms_course_access").select("course_id")
    ]);
    if (coursesRes.error) throw coursesRes.error;
    if (accessRes.error) throw accessRes.error;

    courses = coursesRes.data || [];
    unlocked.clear();
    (accessRes.data || []).forEach(r => unlocked.add(r.course_id));

    courseListEl.innerHTML = "";
    if (!courses.length) return setListStatus("No courses available yet.");
    courses.forEach(renderCourseCard);
  } catch (err) {
    console.error(err);
    setListStatus("Could not load courses: " + (err && err.message ? err.message : err));
  }
}

function showNotice(msg) {
  courseSelection.querySelectorAll(".notice").forEach(n => n.remove());
  const p = document.createElement("p");
  p.className = "status notice";
  p.setAttribute("role", "alert");
  p.textContent = msg;
  courseSelection.insertBefore(p, courseListEl);
  setTimeout(() => p.remove(), 8000);
}

function renderCourseCard(course) {
  const card = document.createElement("div");
  card.className = "course-card";

  const h = document.createElement("h3");
  h.textContent = course.title;
  const p = document.createElement("p");
  p.textContent = course.description || "";
  card.append(h, p);

  makeClickable(card, () => {
    if (unlocked.has(course.id)) navigate(course.id, 0, 0);
    else showPasscodeModal(course);
  });
  courseListEl.appendChild(card);
}

/* ------------------------------------------------------------------ *
 * PASSCODE MODAL
 * ------------------------------------------------------------------ */
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
}

function showPasscodeModal(course) {
  pendingCourse = course;
  modalTitle.textContent = course.title;
  passcodeInput.value = "";
  errorMsg.classList.add("hidden");
  modal.classList.remove("hidden");
  setTimeout(() => passcodeInput.focus(), 100);
}

function closeModal() {
  modal.classList.add("hidden");
  pendingCourse = null;
  if (location.hash) clearHash(); // e.g. a deep link to a locked course
}

passcodeInput.addEventListener("keyup", e => e.key === "Enter" && submitBtn.click());
cancelBtn.onclick = closeModal;
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
});

submitBtn.onclick = async () => {
  const course = pendingCourse;
  const code = passcodeInput.value.trim();
  if (!course || !code) return;

  submitBtn.disabled = true;
  errorMsg.classList.add("hidden");
  try {
    await ensureSession();
    const { data, error } = await sb.rpc("lms_unlock", {
      p_course: course.id,
      p_passcode: code
    });
    if (error) throw error;

    if (data === true) {
      unlocked.add(course.id);
      modal.classList.add("hidden");
      pendingCourse = null;
      navigate(course.id, 0, 0);
    } else {
      showError("Incorrect passcode");
      passcodeInput.select();
    }
  } catch (err) {
    console.error(err);
    showError("Something went wrong. Please try again.");
  } finally {
    submitBtn.disabled = false;
  }
};

/* ------------------------------------------------------------------ *
 * ROUTING  (#courseId/sectionIndex/lectureIndex)
 * ------------------------------------------------------------------ */
function navigate(courseId, sec, lec) {
  location.hash = `#${encodeURIComponent(courseId)}/${sec}/${lec}`;
}

function clearHash() {
  history.pushState(null, "", location.pathname + location.search);
  route();
}

function parseHash() {
  const [id = "", s = "0", l = "0"] = location.hash.slice(1).split("/");
  return {
    id: decodeURIComponent(id),
    sec: Math.max(0, parseInt(s, 10) || 0),
    lec: Math.max(0, parseInt(l, 10) || 0)
  };
}

function showCourseList() {
  courseViewer.classList.add("hidden");
  courseSelection.classList.remove("hidden");
  document.title = "Mikko's Lectures";
}

async function route() {
  const seq = ++routeSeq;
  const { id, sec, lec } = parseHash();

  if (!id) return showCourseList();

  const course = courses.find(c => c.id === id);
  if (!course) return showCourseList();

  if (!unlocked.has(id)) {
    showCourseList();
    if (modal.classList.contains("hidden")) showPasscodeModal(course);
    return;
  }

  if (!loaded || loaded.id !== id) {
    let content;
    try {
      const res = await fetch(`${COURSE_DIR}/${encodeURIComponent(id)}.json`, {
        cache: "no-cache" // always revalidate so weekly updates show up
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await res.json();
    } catch (err) {
      console.error("Could not load course file:", err);
      if (seq !== routeSeq) return;
      showCourseList();
      showNotice("This course's content could not be loaded. Please try again later.");
      return;
    }
    if (seq !== routeSeq) return; // a newer navigation took over

    const sections = content.sessions || content.sections || [];
    const title = content.title || course.title;
    loaded = { id, title, sections };
    courseTitleEl.textContent = title;
    renderAccordion();
  }

  if (!loaded.sections.length) return showCourseList();

  // Clamp indices so a stale/bad link still lands somewhere sensible
  const s = Math.min(sec, loaded.sections.length - 1);
  const lectures = loaded.sections[s].lectures || [];
  const l = Math.min(lec, Math.max(0, lectures.length - 1));

  courseSelection.classList.add("hidden");
  courseViewer.classList.remove("hidden");
  document.title = `${loaded.title} – Mikko's Lectures`;
  showLecture(s, l);
}

window.addEventListener("hashchange", route);

backBtn.onclick = () => {
  history.pushState(null, "", location.pathname + location.search);
  route();
  window.scrollTo({ top: 0 });
};

/* ------------------------------------------------------------------ *
 * ACCORDION
 * ------------------------------------------------------------------ */
function setOpenSection(secIdx) {
  accordion.querySelectorAll(".accordion-item").forEach((item, i) => {
    const content = item.querySelector(".accordion-content");
    const header = item.querySelector(".accordion-header");
    const icon = header.querySelector("i");
    const open = i === secIdx;
    content.classList.toggle("active", open);
    header.setAttribute("aria-expanded", String(open));
    icon.style.transform = open ? "rotate(180deg)" : "";
  });
}

function setActiveLecture(secIdx, lecIdx) {
  accordion.querySelectorAll(".lecture-item").forEach(el => {
    el.classList.toggle(
      "active",
      Number(el.dataset.sec) === secIdx && Number(el.dataset.lec) === lecIdx
    );
  });
}

function renderAccordion() {
  accordion.innerHTML = "";

  loaded.sections.forEach((section, secIdx) => {
    const item = document.createElement("div");
    item.className = "accordion-item";

    const header = document.createElement("div");
    header.className = "accordion-header";
    const label = document.createElement("span");
    label.textContent = section.title;
    const chevron = document.createElement("i");
    chevron.className = "fas fa-chevron-down";
    header.append(label, chevron);
    header.setAttribute("aria-expanded", "false");

    const content = document.createElement("div");
    content.className = "accordion-content";

    (section.lectures || []).forEach((lec, lecIdx) => {
      const lecItem = document.createElement("div");
      lecItem.className = "lecture-item";
      lecItem.textContent = lec.title;
      lecItem.dataset.sec = secIdx;
      lecItem.dataset.lec = lecIdx;
      makeClickable(lecItem, ev => {
        ev.stopPropagation();
        navigate(loaded.id, secIdx, lecIdx);
      });
      content.appendChild(lecItem);
    });

    makeClickable(header, () => {
      const wasOpen = content.classList.contains("active");
      setOpenSection(wasOpen ? -1 : secIdx);
    });

    item.append(header, content);
    accordion.appendChild(item);
  });
}

/* ------------------------------------------------------------------ *
 * LECTURE RENDERING
 * ------------------------------------------------------------------ */
function showLecture(secIdx, lecIdx) {
  const lecture = loaded.sections[secIdx].lectures[lecIdx];
  contentArea.innerHTML = "";
  if (!lecture) return;

  (lecture.content || []).forEach(block => {
    const div = document.createElement("div");
    div.className = "content-item";

    if (block.type === "heading") {
      const h = document.createElement("h4");
      h.textContent = block.text;
      div.appendChild(h);

    } else if (block.type === "text") {
      const p = document.createElement("p");
      String(block.text ?? "").split("\n").forEach((line, i) => {
        if (i) p.appendChild(document.createElement("br"));
        p.appendChild(document.createTextNode(line));
      });
      div.appendChild(p);

    } else if (block.type === "image") {
      const img = document.createElement("img");
      img.alt = block.alt || "";
      img.loading = "lazy";
      img.onerror = () => { img.onerror = null; img.src = IMG_FALLBACK; };
      img.src = block.src;
      div.appendChild(img);

    } else if (block.type === "pdf") {
      const iframe = document.createElement("iframe");
      iframe.className = "pdf-embed";
      iframe.title = block.alt || "PDF document";
      iframe.src = block.src;
      div.appendChild(iframe);

    } else if (block.type === "link") {
      if (/^https?:\/\//i.test(block.href || "")) {
        const a = document.createElement("a");
        a.href = block.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = block.text || block.href;
        div.appendChild(a);
      }
    }

    contentArea.appendChild(div);
  });

  setOpenSection(secIdx);
  setActiveLecture(secIdx, lecIdx);
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ *
 * BOOT
 * ------------------------------------------------------------------ */
(async function boot() {
  initTheme();
  injectThemeToggle();
  await loadCourses();
  route(); // handles deep links like #intro2nlp/2/0
})();
