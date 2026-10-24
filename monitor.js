// Monitor de vacantes MEP (https://apps.mep.go.cr/formulario)
// Cada ejecución: recorre TODAS las regionales y todas las páginas, compara con vacantes.txt,
// envía un correo con las vacantes nuevas, agrega las nuevas y elimina las que ya no aparecen.
//
// Modos (variable MODE):
//   normal     -> escanea, envía correo si hay nuevas y actualiza vacantes.txt
//   dry-run    -> escanea y muestra las diferencias; NO envía correo ni modifica vacantes.txt
//   test-email -> escanea y envía un correo de prueba con lo encontrado; NO modifica vacantes.txt
//
// Seguridad: si el escaneo falla o queda incompleto, el proceso termina con error y
// vacantes.txt NO se toca (nunca se interpreta un fallo como "no hay vacantes").

import fs from "node:fs";
import puppeteer from "puppeteer";
import nodemailer from "nodemailer";
import { pathToFileURL, fileURLToPath } from "node:url";

const SITE_URL = "https://apps.mep.go.cr/formulario";
const STATE_FILE = process.env.STATE_FILE || "vacantes.txt";
const HISTORY_FILE = process.env.HISTORY_FILE || "historial.log";
const MAX_HISTORY_LINES = 5000; // el historial se recorta para que no crezca sin límite
const MODE = (process.env.MODE || "normal").trim().toLowerCase();
const SCAN_FIXTURE = process.env.SCAN_FIXTURE; // opcional: JSON con un escaneo simulado (para pruebas)
const TZ = "America/Costa_Rica";
const MAX_ATTEMPTS = 3;
const MAX_PAGES_PER_REGION = 50;

// Filtro del correo: solo se avisa de vacantes cuya Especialidad o Clase de puesto contenga
// alguna de estas palabras (sin importar mayúsculas ni tildes). vacantes.txt guarda TODAS las
// vacantes igual, así cambiar el filtro nunca rompe el historial.
// Se puede sobrescribir con la variable de entorno FILTER_KEYWORDS (separadas por coma);
// FILTER_KEYWORDS="*" desactiva el filtro y avisa de todo.
// Texto real visto en un comprobante del MEP: "Estudios Sociales/educación Cívica".
// Se usan raíces cortas a propósito para tolerar variaciones (Sociales/Social, Cívica/Civica/Cívico,
// abreviaturas como "Est. Sociales" o "Educ. Cívica", barras, puntos, mayúsculas o tildes).
const DEFAULT_KEYWORDS = ["SOCIAL", "CIVIC"];
const FILTER_KEYWORDS = (process.env.FILTER_KEYWORDS?.trim() ? process.env.FILTER_KEYWORDS.split(",") : DEFAULT_KEYWORDS)
  .map((k) => k.trim()).filter(Boolean);

const FIELDS = ["vacante", "regional", "clasePuesto", "especialidad", "institucion", "lecciones", "rige", "vence"];
const HEADER = "# " + [...FIELDS, "detectada"].join("\t");

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const nowCR = () =>
  new Intl.DateTimeFormat("es-CR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date());

// La clave identifica una vacante. Se usa el número de vacante + los datos visibles, porque el
// mismo número puede aparecer en más de una fila (p. ej. con distinta institución o fechas).
const norm = (s) =>
  clean(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
export const matchesFilter = (v, keywords = FILTER_KEYWORDS) =>
  keywords.includes("*") || keywords.length === 0 ||
  keywords.map(norm).some((k) => norm(v.especialidad).includes(k) || norm(v.clasePuesto).includes(k));

const keyOf = (v) => FIELDS.map((f) => clean(v[f]).toUpperCase()).join("|");

// ---------------------------------------------------------------- almacenamiento (txt)

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null; // primera ejecución
  const map = new Map();
  for (const line of fs.readFileSync(STATE_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split("\t");
    const v = {};
    FIELDS.forEach((f, i) => (v[f] = parts[i] ?? ""));
    v.detectada = parts[FIELDS.length] ?? "";
    map.set(keyOf(v), v);
  }
  return map;
}

function saveState(map) {
  const rows = [...map.values()].sort(
    (a, b) => a.regional.localeCompare(b.regional) || a.vacante.localeCompare(b.vacante),
  );
  const body = rows.map((v) => [...FIELDS, "detectada"].map((f) => clean(v[f])).join("\t"));
  fs.writeFileSync(STATE_FILE, [HEADER, ...body].join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------- scraping

// "Regional Educación San Jose - Central" y "Direc. Regional Educacion San Jose - Central"
// -> "SAN JOSE - CENTRAL"
const regionKey = (s) => {
  const n = clean(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const i = n.lastIndexOf("EDUCACION");
  return (i >= 0 ? n.slice(i + "EDUCACION".length) : n).trim();
};

// Se ejecuta dentro del navegador: lee la tabla visible usando las cabeceras.
function readTableInPage() {
  const norm = (s) =>
    (s || "").replace(/ /g, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
  const loading = !!document.querySelector(".mud-table-loading-row");
  const headers = [...document.querySelectorAll("table thead th")].map((th) => norm(th.textContent));
  const rows = [...document.querySelectorAll("table tbody tr")]
    .map((tr) => {
      const cells = [...tr.querySelectorAll("td")];
      const o = {};
      headers.forEach((h, i) => h && (o[h] = (cells[i]?.textContent || "").replace(/\s+/g, " ").trim()));
      return o;
    })
    .filter((o) => /^\d+$/.test(o.VACANTE || ""));
  return { loading, headers, rows };
}

async function waitForRegionTable(page, rKey, previousFirstId = null, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const t = await page.evaluate(readTableInPage);
    if (!t.loading && t.rows.length > 0) {
      const allMatch = t.rows.every((r) => regionKey(r["DIRECCION REGIONAL"]) === rKey);
      const changed = previousFirstId === null || t.rows[0].VACANTE !== previousFirstId;
      if (allMatch && changed) {
        await sleep(400); // margen para que termine de pintar
        return page.evaluate(readTableInPage);
      }
    }
    await sleep(300);
  }
  throw new Error(`La tabla de la regional "${rKey}" no cargó a tiempo`);
}

async function scrapeOnce() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    // El MEP muestra "Estamos realizando tareas de mantenimiento" cuando el sitio está caído a propósito.
    if (/tareas de mantenimiento/i.test(await page.evaluate(() => document.body?.innerText || ""))) {
      throw Object.assign(new Error("Sitio del MEP en mantenimiento"), { maintenance: true });
    }
    await page.waitForSelector("select");
    await page.waitForFunction(() => document.querySelector("select")?.options.length > 1, { timeout: 30000 });

    const regions = await page.evaluate(() =>
      [...document.querySelector("select").options]
        .filter((o) => o.value && o.value !== "0")
        .map((o) => ({ value: o.value, text: o.textContent.trim() })),
    );
    if (regions.length === 0) throw new Error("El selector no tiene regionales (posible cambio en el sitio)");
    log(`Regionales encontradas: ${regions.length}`);

    const all = [];
    for (const region of regions) {
      const rKey = regionKey(region.text);
      let table = null;
      // Blazor puede tardar en conectar: si el primer "change" no surte efecto, se reintenta una vez.
      for (let tryNo = 1; tryNo <= 2 && !table; tryNo++) {
        await page.evaluate((val) => {
          const s = document.querySelector("select");
          s.value = val;
          s.dispatchEvent(new Event("change", { bubbles: true }));
        }, region.value);
        try {
          table = await waitForRegionTable(page, rKey);
        } catch (e) {
          if (tryNo === 2) throw e;
          log(`Reintentando regional ${region.text}...`);
        }
      }
      if (!table.headers.includes("VACANTE") || !table.headers.includes("CLASE DE PUESTO")) {
        throw new Error(`Cambió la estructura de la tabla. Cabeceras: ${table.headers.join(", ")}`);
      }

      let pageNo = 1;
      let regionRows = [...table.rows];
      while (pageNo < MAX_PAGES_PER_REGION) {
        const next = await page.$('button[aria-label="Next page"]:not([disabled])');
        if (!next) break;
        const firstId = table.rows[0].VACANTE;
        await next.click();
        pageNo++;
        table = await waitForRegionTable(page, rKey, firstId);
        regionRows.push(...table.rows);
      }
      log(`${region.text}: ${regionRows.length} vacantes en ${pageNo} página(s)`);

      for (const r of regionRows) {
        all.push({
          vacante: r.VACANTE,
          regional: r["DIRECCION REGIONAL"],
          clasePuesto: r["CLASE DE PUESTO"],
          especialidad: r.ESPECIALIDAD,
          institucion: r.INSTITUCION,
          lecciones: r.LECCIONES,
          rige: r.RIGE,
          vence: r.VENCE,
        });
      }
    }
    return all;
  } finally {
    await browser.close();
  }
}

async function scrapeWithRetries() {
  if (SCAN_FIXTURE) {
    log(`Usando escaneo simulado: ${SCAN_FIXTURE}`);
    return JSON.parse(fs.readFileSync(SCAN_FIXTURE, "utf8"));
  }
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await scrapeOnce();
    } catch (e) {
      if (e.maintenance) throw e; // no tiene sentido reintentar en segundos
      lastErr = e;
      log(`Intento ${attempt}/${MAX_ATTEMPTS} falló: ${e.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(30000 * attempt); // 30 s, 60 s
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- historial

const HISTORY_HEADER = "# Historial de OtterAlerts (más reciente arriba, hora de Costa Rica)";
const historyStamp = () => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const describe = (v) => [v.vacante, shortRegion(v.regional), clean(v.especialidad), clean(v.institucion)].join(" · ");

// Agrega un bloque arriba del historial. Solo se usa en modo normal.
function appendHistory(lines) {
  if (MODE !== "normal") return;
  const old = fs.existsSync(HISTORY_FILE)
    ? fs.readFileSync(HISTORY_FILE, "utf8").split(/\r?\n/).filter((l) => l && l !== HISTORY_HEADER)
    : [];
  const all = [...lines, ...old].slice(0, MAX_HISTORY_LINES);
  fs.writeFileSync(HISTORY_FILE, [HISTORY_HEADER, ...all].join("\n") + "\n", "utf8");
}

// Resumen visible en la página de cada ejecución en GitHub Actions.
function jobSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, md + "\n");
}

// ---------------------------------------------------------------- correo

const esc = (s) => clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Frases de bienvenida (se elige una al azar en cada correo)
export const OTTER_PHRASES = [
  "Esta entrega no viene en camión: viene a nado.",
  "Nadamos contra la corriente para que no se te escape ninguna plaza.",
  "Entregado con patitas mojadas y mucho cariño.",
  "Recogimos estas plazas como piedritas brillantes, solo para vos.",
  "Nutria Express: entregas río abajo, sin escalas ni atrasos.",
  "Flotamos panza arriba, pero con un ojo siempre abierto.",
  "Del río directo a tu bandeja, una entrega nutria-tiva.",
  "Buceamos hasta el fondo del río y salimos con esto para vos.",
];

const pickPhrase = () => OTTER_PHRASES[Math.floor(Math.random() * OTTER_PHRASES.length)];
const shortRegion = (s) => clean(s).replace(/^Direc\.?\s*Regional\s*(de\s*)?Educaci[oó]n\s*/i, "") || clean(s);

// Paleta: río (cian pastel), nutria (café pastel) y piedras (gris)
const C = {
  page: "#EEF8F9", river: "#CFEFF2", riverDark: "#2E7C86", otter: "#7A5641", otterSoft: "#F4E9DF",
  rock: "#E9ECEE", rockLine: "#D3D8DB", text: "#3E4A4D", muted: "#7D8A8D", white: "#FFFFFF",
};
const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const ICON_CID = "otter@otterlydelivered";
const ICON_FILE = fileURLToPath(new URL("./otter.png", import.meta.url));

const COLS = [
  ["vacante", "Vacante"], ["regional", "Región"], ["clasePuesto", "Clase de puesto"], ["especialidad", "Especialidad"],
  ["institucion", "Institución"], ["lecciones", "Lecciones"], ["rige", "Rige"], ["vence", "Vence"],
];

export function buildEmail(list, title, phrase = pickPhrase(), iconSrc = `cid:${ICON_CID}`) {
  const regions = [...new Set(list.map((v) => shortRegion(v.regional)))];
  const summary = `${list.length} ${list.length === 1 ? "plaza" : "plazas"} · ${regions.join(", ")}`;
  const detected = list.find((v) => v.detectada)?.detectada;
  const cell = `padding:8px 10px;border-bottom:1px solid ${C.rockLine};vertical-align:top`;
  const head = COLS.map(([, h]) => `<th align="left" style="padding:8px 10px;background:${C.otterSoft};color:${C.otter};font-size:13px;font-weight:bold;border-bottom:2px solid ${C.rockLine};white-space:nowrap">${h}</th>`).join("");
  const rows = list
    .map((v, i) => `<tr style="background:${i % 2 ? C.rock : C.white}">` +
      COLS.map(([k]) => `<td style="${cell}${k === "vacante" ? ";font-weight:bold;color:" + C.riverDark : ""}">${esc(k === "regional" ? shortRegion(v[k]) : v[k])}</td>`).join("") +
      "</tr>")
    .join("");

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(summary)} — ${esc(phrase)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:760px;font-family:${FONT};color:${C.text}">
  <tr><td style="background:${C.river};border-radius:16px 16px 0 0;padding:18px 20px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:14px;vertical-align:middle"><img src="${iconSrc}" width="64" height="64" alt="Otterly Delivered" style="display:block;border:0"></td>
      <td style="vertical-align:middle">
        <div style="font-size:20px;line-height:26px;font-weight:bold;color:${C.otter}">${esc(title)}</div>
        <div style="font-size:14px;line-height:20px;color:${C.riverDark};font-style:italic;margin-top:4px">${esc(phrase)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${C.white};padding:0;border:1px solid ${C.rockLine};border-top:0">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;line-height:19px">
      <thead><tr>${head}</tr></thead><tbody>${rows}</tbody>
    </table>
  </td></tr>
  <tr><td style="background:${C.white};border:1px solid ${C.rockLine};border-top:0;border-radius:0 0 16px 16px;padding:14px 20px;font-size:14px;line-height:21px">
    ${detected ? `Detectado: ${esc(detected)} (hora de Costa Rica)<br>` : ""}Ver y aplicar: <a href="${SITE_URL}" style="color:${C.riverDark};font-weight:bold">apps.mep.go.cr/formulario</a>
  </td></tr>
  <tr><td align="center" style="padding:12px 10px 0 10px;font-size:11px;color:${C.muted}">Otterly Delivered · aviso automático, no oficial del MEP.</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text =
    `${title}\n${summary}\n"${phrase}"\n\n` +
    list.map((v) => COLS.map(([k, h]) => `${h}: ${clean(k === "regional" ? shortRegion(v[k]) : v[k])}`).join("\n")).join("\n\n") +
    (detected ? `\n\nDetectado: ${detected} (hora de Costa Rica)` : "") +
    `\nVer y aplicar: ${SITE_URL}\n\nOtterly Delivered · aviso automático, no oficial del MEP.\n`;
  return { html, text };
}

async function sendEmail(subject, list, title) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const to = process.env.MAIL_TO || GMAIL_USER;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error("Faltan los secretos GMAIL_USER / GMAIL_APP_PASSWORD");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s+/g, "") },
  });
  const { html, text } = buildEmail(list, title);
  const attachments = fs.existsSync(ICON_FILE)
    ? [{ filename: "otter.png", path: ICON_FILE, cid: ICON_CID, contentDisposition: "inline" }]
    : [];
  await transporter.sendMail({ from: `Otterly Delivered <${GMAIL_USER}>`, to, subject, html, text, attachments });
  log(`Correo enviado (${to.split(",").length} destinatario(s)): "${subject}"`);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- flujo principal

async function main() {
  log(`Modo: ${MODE}`);
  if (!["normal", "dry-run", "test-email"].includes(MODE)) throw new Error(`MODE inválido: ${MODE}`);

  const scanned = await scrapeWithRetries();
  if (!Array.isArray(scanned) || scanned.length === 0) {
    throw new Error("El escaneo no devolvió vacantes; no se modifica nada");
  }

  // Quitar duplicados exactos dentro del mismo escaneo
  const current = new Map();
  for (const v of scanned) current.set(keyOf(v), v);
  log(`Escaneo completo: ${current.size} vacantes`);

  const stored = loadState();
  const firstRun = stored === null;
  const previous = stored ?? new Map();
  const stamp = nowCR();

  const added = [...current].filter(([k]) => !previous.has(k)).map(([, v]) => ({ ...v, detectada: stamp }));
  const removed = [...previous].filter(([k]) => !current.has(k)).map(([, v]) => v);

  log(`Nuevas: ${added.length} | Eliminadas: ${removed.length} | Sin cambios: ${current.size - added.length}`);
  added.forEach((v) => log(`  + ${v.vacante} ${v.regional} | ${v.clasePuesto} | ${v.especialidad} | ${v.institucion}`));
  removed.forEach((v) => log(`  - ${v.vacante} ${v.regional} | ${v.clasePuesto} | ${v.especialidad} | ${v.institucion}`));

  if (MODE === "dry-run") {
    log("dry-run: no se envía correo ni se modifica el archivo.");
    jobSummary(`### dry-run\n${current.size} vacantes · ${added.length} nuevas · ${removed.length} eliminadas (no se guardó nada)`);
    return;
  }

  const relevant = (list) => list.filter((v) => matchesFilter(v));
  const addedRelevant = relevant(added);
  log(`Filtro [${FILTER_KEYWORDS.join(", ")}]: ${relevant([...current.values()]).length} de ${current.size} vacantes coinciden; ${addedRelevant.length} nuevas coinciden.`);

  if (MODE === "test-email") {
    const all = [...current.values()].map((v) => ({ ...v, detectada: stamp }));
    const matching = relevant(all);
    // Si ahora no hay ninguna que coincida, se envían todas para poder ver el correo igual.
    const list = matching.length ? matching : all;
    const note = matching.length ? "que coinciden con el filtro" : "(ninguna coincide con el filtro ahora; se muestran todas)";
    await sendEmail(`[PRUEBA] MEP Alert: ${plural(list.length, "plaza disponible", "plazas disponibles")}`, list,
      `Correo de prueba: ${plural(list.length, "plaza", "plazas")} ${note}`);
    log("test-email: no se modifica el archivo.");
    jobSummary(`### test-email\nCorreo de prueba enviado con ${plural(list.length, "plaza", "plazas")}.`);
    return;
  }

  // Correo ANTES de guardar: si el envío falla, el proceso termina con error, el archivo no cambia
  // y la siguiente ejecución vuelve a intentar avisar de las mismas vacantes.
  if (addedRelevant.length === 0) {
    if (added.length) log("Hay vacantes nuevas, pero ninguna coincide con el filtro: no se envía correo.");
  } else if (firstRun) {
    await sendEmail(`MEP Alert: monitoreo iniciado (${plural(addedRelevant.length, "plaza disponible", "plazas disponibles")})`,
      addedRelevant, `Monitoreo iniciado. Estas son las ${plural(addedRelevant.length, "plaza disponible", "plazas disponibles")} hoy. Desde ahora solo recibirás las nuevas.`);
  } else {
    await sendEmail(`MEP Alert: ${plural(addedRelevant.length, "nueva plaza disponible", "nuevas plazas disponibles")}`,
      addedRelevant, `${plural(addedRelevant.length, "nueva plaza disponible", "nuevas plazas disponibles")}`);
  }

  if (added.length || removed.length || firstRun) {
    const next = new Map();
    for (const [k] of current) next.set(k, previous.get(k) ?? added.find((v) => keyOf(v) === k));
    saveState(next);
    log(`${STATE_FILE} actualizado (${next.size} vacantes).`);
  } else {
    log("Sin cambios.");
  }

  // Historial + resumen de la ejecución
  const ts = historyStamp();
  const emailed = new Set(addedRelevant.map(keyOf));
  let headline;
  if (firstRun) headline = `inicio: ${current.size} vacantes guardadas`;
  else if (!added.length && !removed.length) headline = "sin cambios";
  else headline = `${plural(added.length, "nueva", "nuevas")}, ${plural(removed.length, "eliminada", "eliminadas")}`;
  const mailNote = addedRelevant.length ? ` | correo enviado: ${plural(addedRelevant.length, "plaza", "plazas")}` : "";
  const detail = [
    ...(firstRun ? [] : added.map((v) => `    + agregada  ${describe(v)}${emailed.has(keyOf(v)) ? "  [CORREO]" : "  (no coincide con el filtro)"}`)),
    ...removed.map((v) => `    - eliminada ${describe(v)}`),
  ];
  appendHistory([`${ts} | ${headline} | ${current.size} vacantes${mailNote}`, ...detail]);
  jobSummary(`### ${headline}\n${current.size} vacantes en el sitio${mailNote}\n\n` +
    (detail.length ? "```\n" + detail.map((l) => l.trim()).join("\n") + "\n```" : ""));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    if (e.maintenance) {
      // No es una falla nuestra: se anota y la siguiente revisión lo intenta de nuevo (sin correo de error de GitHub).
      log("El sitio del MEP está en mantenimiento; no se modifica nada.");
      appendHistory([`${historyStamp()} | MANTENIMIENTO | sitio del MEP en mantenimiento, se reintenta en la próxima revisión`]);
      jobSummary("### 🛠️ MEP en mantenimiento\nNo se modificó nada; se reintenta en la próxima revisión.");
      process.exit(0);
    }
    console.error(new Date().toISOString(), "ERROR:", e.stack || e.message);
    try {
      appendHistory([`${historyStamp()} | ERROR | ${clean(e.message)}`]);
      jobSummary(`### ❌ Error\n${clean(e.message)}`);
    } catch {}
    process.exit(1);
  });
}
